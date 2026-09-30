'use strict';
/**
 * Authentication core for SmartQ.
 *
 *  - Passwords are bcrypt hashes. Plain text is never stored or logged.
 *  - OTP codes are also bcrypt hashes. The code itself exists only in the
 *    email; it is never written to the database or the console.
 *  - Every OTP carries a `purpose`, so a code issued for a password reset
 *    cannot be replayed to complete a login.
 */
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const pool   = require('../database/connection');

const q   = async (sql, p = []) => (await pool.execute(sql, p))[0];
const run = async (sql, p = []) => (await pool.execute(sql, p))[0];

const ROUNDS             = 10;
const OTP_TTL_MINUTES    = 5;
const OTP_MAX_ATTEMPTS   = 5;
const OTP_COOLDOWN_SEC   = 60;
const OTP_MAX_PER_HOUR   = 6;
const LOGIN_MAX_FAILS    = 5;
const LOCKOUT_MINUTES    = 15;

const PURPOSES = ['registration','login','password_reset','account_recovery','email_change'];

// ── Passwords ────────────────────────────────────────────────────────────────
const hashPassword    = pw => bcrypt.hash(String(pw), ROUNDS);
const comparePassword = (pw, hash) => (hash ? bcrypt.compare(String(pw), hash) : Promise.resolve(false));

const PASSWORD_RULES = [
  { label: 'At least 8 characters',       test: p => p.length >= 8 },
  { label: 'At least one uppercase letter', test: p => /[A-Z]/.test(p) },
  { label: 'At least one lowercase letter', test: p => /[a-z]/.test(p) },
  { label: 'At least one number',           test: p => /[0-9]/.test(p) },
  { label: 'At least one special character', test: p => /[^A-Za-z0-9]/.test(p) },
];

/** Returns null when the password is fine, otherwise a readable message. */
function checkPassword(pw) {
  const p = String(pw || '');
  const failed = PASSWORD_RULES.filter(r => !r.test(p)).map(r => r.label.toLowerCase());
  if (!failed.length) return null;
  return 'Password must have ' + failed.join(', ') + '.';
}

// ── Email helpers ────────────────────────────────────────────────────────────
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const isEmail  = v => EMAIL_RE.test(String(v || '').trim());

/** p***@gmail.com — never show the whole address back to the browser. */
function maskEmail(email) {
  const e = String(email || '');
  const at = e.indexOf('@');
  if (at < 1) return e;
  const name = e.slice(0, at), domain = e.slice(at);
  if (name.length <= 1) return name + '***' + domain;
  return name[0] + '***' + domain;
}

// ── OTP ──────────────────────────────────────────────────────────────────────
/** Cryptographically secure 6-digit code. */
function generateOtp() {
  return String(crypto.randomInt(0, 1000000)).padStart(6, '0');
}

/** Seconds still to wait before another code may be sent. */
async function cooldownLeft(userId, purpose) {
  const r = await q(
    `SELECT TIMESTAMPDIFF(SECOND, created_at, NOW()) AS age
     FROM otp_verifications WHERE user_id=? AND purpose=?
     ORDER BY id DESC LIMIT 1`, [userId, purpose]);
  if (!r.length) return 0;
  return Math.max(0, OTP_COOLDOWN_SEC - Number(r[0].age));
}

async function sentLastHour(userId, purpose) {
  const r = await q(
    `SELECT COUNT(*) AS n FROM otp_verifications
     WHERE user_id=? AND purpose=? AND created_at > DATE_SUB(NOW(), INTERVAL 1 HOUR)`,
    [userId, purpose]);
  return Number(r[0].n) || 0;
}

/**
 * Issue a code. Any earlier unused code for the same user+purpose is retired,
 * so only the newest one can work.
 * Returns { code, expiresAt } — the caller emails the code and then forgets it.
 */
async function issueOtp(userId, email, purpose, { payload = null, force = false } = {}) {
  if (!PURPOSES.includes(purpose)) return { error: 'Invalid verification purpose.' };

  if (!force) {
    const wait = await cooldownLeft(userId, purpose);
    if (wait > 0)
      return { error: `Please wait ${wait} second${wait === 1 ? '' : 's'} before requesting another code.`, cooldown: wait };
    if (await sentLastHour(userId, purpose) >= OTP_MAX_PER_HOUR)
      return { error: 'Too many OTP requests. Please wait before requesting another code.' };
  }

  await run(
    `UPDATE otp_verifications SET verified_at=NOW()
     WHERE user_id=? AND purpose=? AND verified_at IS NULL`, [userId, purpose]);

  const code = generateOtp();
  const hash = await bcrypt.hash(code, ROUNDS);
  await run(
    `INSERT INTO otp_verifications (user_id,email,otp_hash,purpose,payload,expires_at)
     VALUES (?,?,?,?,?, DATE_ADD(NOW(), INTERVAL ? MINUTE))`,
    [userId, email, hash, purpose, payload, OTP_TTL_MINUTES]);

  return { ok: true, code, minutes: OTP_TTL_MINUTES, email, masked: maskEmail(email) };
}

/** Seconds left before the active code for this purpose expires. */
async function otpSecondsLeft(userId, purpose) {
  const r = await q(
    `SELECT TIMESTAMPDIFF(SECOND, NOW(), expires_at) AS s
     FROM otp_verifications WHERE user_id=? AND purpose=? AND verified_at IS NULL
     ORDER BY id DESC LIMIT 1`, [userId, purpose]);
  if (!r.length) return 0;
  return Math.max(0, Number(r[0].s));
}

/** Check a submitted code. Single use, attempt-limited, purpose-bound. */
async function verifyOtp(userId, purpose, code) {
  const clean = String(code || '').replace(/\s/g, '');
  if (!/^\d{6}$/.test(clean)) return { error: 'Invalid verification code.' };

  const r = await q(
    `SELECT * FROM otp_verifications
     WHERE user_id=? AND purpose=? AND verified_at IS NULL
     ORDER BY id DESC LIMIT 1`, [userId, purpose]);
  if (!r.length) return { error: 'No active verification code. Please request a new one.', needNew: true };

  const row = r[0];
  if (new Date(row.expires_at).getTime() < Date.now())
    return { error: 'Verification code has expired.', needNew: true };

  if (row.attempts >= OTP_MAX_ATTEMPTS)
    return { error: 'Too many attempts. Please request a new code.', needNew: true };

  const match = await bcrypt.compare(clean, row.otp_hash);
  if (!match) {
    await run('UPDATE otp_verifications SET attempts=attempts+1 WHERE id=?', [row.id]);
    const left = OTP_MAX_ATTEMPTS - (row.attempts + 1);
    return { error: left > 0
      ? `Invalid verification code. ${left} attempt${left === 1 ? '' : 's'} remaining.`
      : 'Too many attempts. Please request a new code.', needNew: left <= 0 };
  }

  await run('UPDATE otp_verifications SET verified_at=NOW() WHERE id=?', [row.id]);
  return { ok: true, payload: row.payload };
}

/** Throw away any outstanding codes, e.g. after a password change. */
async function invalidateOtps(userId, purpose = null) {
  if (purpose) {
    await run(`UPDATE otp_verifications SET verified_at=NOW()
               WHERE user_id=? AND purpose=? AND verified_at IS NULL`, [userId, purpose]);
  } else {
    await run(`UPDATE otp_verifications SET verified_at=NOW()
               WHERE user_id=? AND verified_at IS NULL`, [userId]);
  }
}

// ── Failed login lockout ─────────────────────────────────────────────────────
async function registerFailedLogin(userId) {
  await run('UPDATE users SET failed_logins = failed_logins + 1 WHERE id=?', [userId]);
  const r = await q('SELECT failed_logins FROM users WHERE id=?', [userId]);
  if (r.length && r[0].failed_logins >= LOGIN_MAX_FAILS) {
    await run(
      `UPDATE users SET status='locked', locked_until=DATE_ADD(NOW(), INTERVAL ? MINUTE)
       WHERE id=? AND status <> 'disabled'`, [LOCKOUT_MINUTES, userId]);
    return { locked: true, minutes: LOCKOUT_MINUTES };
  }
  return { locked: false };
}

async function clearFailedLogins(userId) {
  await run(`UPDATE users SET failed_logins=0, locked_until=NULL, last_login=NOW()
             WHERE id=?`, [userId]);
}

/** Unlock automatically once the lockout window has passed. */
async function releaseExpiredLock(user) {
  if (user.status !== 'locked') return user;
  if (user.lockedUntil && new Date(user.lockedUntil).getTime() > Date.now()) return user;
  await run(`UPDATE users SET status='active', failed_logins=0, locked_until=NULL WHERE id=?`, [user.id]);
  return { ...user, status: 'active' };
}

module.exports = {
  hashPassword, comparePassword, checkPassword, PASSWORD_RULES,
  isEmail, maskEmail,
  generateOtp, issueOtp, verifyOtp, invalidateOtps, cooldownLeft, otpSecondsLeft,
  registerFailedLogin, clearFailedLogins, releaseExpiredLock,
  OTP_TTL_MINUTES, OTP_COOLDOWN_SEC, LOGIN_MAX_FAILS, LOCKOUT_MINUTES, PURPOSES,
};
