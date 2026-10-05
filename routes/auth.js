'use strict';
const express = require('express');
const router  = express.Router();
const db      = require('../data/db');
const auth    = require('../data/auth');
const mailer  = require('../data/mailer');

function home(role) {
  if (role === 'admin') return '/admin/dashboard';
  if (role === 'cashier' || role === 'registrar') return '/staff/dashboard';
  return '/queue';
}

/** Only follow ?next= to a page on this site, never to another domain. */
const safeNext = n => (typeof n === 'string' && /^\/(?![\/\\])/.test(n) ? n : '');

/**
 * Create the real session, after the password, Google or an OTP has checked out.
 * The session id is regenerated so a pre-login id cannot be replayed.
 */
function startSession(req, user, perms) {
  return new Promise((resolve, reject) => {
    const flash = req.session.flash;
    req.session.regenerate(err => {
      if (err) return reject(err);
      req.session.user  = user;
      req.session.perms = perms;
      if (flash) req.session.flash = flash;
      resolve(home(user.role));
    });
  });
}

/** Park the half-authenticated user until they pass the OTP step. */
function setPending(req, user, purpose, extra) {
  req.session.pending = Object.assign({
    userId: user.id, email: user.email, masked: auth.maskEmail(user.email),
    name: user.firstName, purpose,
  }, extra || {});
}

async function sendCode(user, purpose, opts) {
  opts = opts || {};
  const otp = await auth.issueOtp(user.id, opts.toEmail || user.email, purpose, opts);
  if (otp.error) return otp;
  try {
    await mailer.sendOtp(otp.email, user.firstName, otp.code, purpose, otp.minutes);
  } catch (e) {
    console.error('[MAIL] delivery failed');   // never log the code itself
    return { error: 'We could not send the verification email. Please try again shortly.' };
  }
  return otp;
}

// ── LOGIN (admin and staff only) ─────────────────────────────────────────────
// Students never log in: the site's front door is the queue page, and the
// staff sign-in lives at /login.
router.get('/', (req, res) =>
  res.redirect(req.session.user ? home(req.session.user.role) : '/queue'));

router.get('/login', (req, res) => {
  if (req.session.user) return res.redirect(home(req.session.user.role));
  res.render('pages/auth/login', { title: 'Staff Log In', next: req.query.next || '' });
});

router.post('/login', async (req, res, next) => {
  try {
    const identifier = req.body.identifier, password = req.body.password;
    if (!identifier || !password) {
      req.session.error = 'Please enter your username or Gmail and your password.';
      return res.redirect('/login');
    }
    const result = await db.verifyCredentials(identifier, password);
    if (result.error) { req.session.error = result.error; return res.redirect('/login'); }
    if (!['admin', 'cashier', 'registrar'].includes(result.user.role)) {
      req.session.error = 'Students no longer need an account. Scan the QR code or open the queue page to get a number.';
      return res.redirect('/login');
    }

    if (result.pending) {
      setPending(req, result.user, 'registration');
      await sendCode(result.user, 'registration', { force: true });
      req.session.error = 'Your account has not been verified. We sent a new code to your email.';
      return res.redirect('/verify');
    }

    // The email was proven with a code at registration, so a verified account
    // with the right password signs straight in.
    const user = result.user;
    await auth.clearFailedLogins(user.id);
    const to = await startSession(req, user, await db.getPermissions(user.role));
    res.redirect(safeNext(req.body.next) || to);
  } catch (e) { next(e); }
});

// ── OTP SCREEN ───────────────────────────────────────────────────────────────
router.get('/verify', async (req, res, next) => {
  try {
    const p = req.session.pending;
    if (!p) return res.redirect('/login');
    res.render('pages/auth/verify', {
      title: 'Verify your email', pending: p,
      secondsLeft: await auth.otpSecondsLeft(p.userId, p.purpose),
      cooldown: await auth.cooldownLeft(p.userId, p.purpose),
      devMode: !mailer.HAS_SMTP,
    });
  } catch (e) { next(e); }
});

router.post('/verify', async (req, res, next) => {
  try {
    const p = req.session.pending;
    if (!p) return res.redirect('/login');

    const check = await auth.verifyOtp(p.userId, p.purpose, req.body.code);
    if (check.error) { req.session.error = check.error; return res.redirect('/verify'); }

    if (p.purpose === 'password_reset' || p.purpose === 'account_recovery') {
      req.session.resetFor = { userId: p.userId, purpose: p.purpose };
      delete req.session.pending;
      return res.redirect('/reset-password');
    }


    if (p.purpose === 'registration') await db.activateAccount(p.userId);

    const user = await db.getUser(p.userId);
    await auth.clearFailedLogins(user.id);
    const nextUrl = p.next;
    delete req.session.pending;
    req.session.flash = 'Signed in.';
    const to = await startSession(req, user, await db.getPermissions(user.role));
    res.redirect(safeNext(nextUrl) || to);
  } catch (e) { next(e); }
});

router.post('/verify/resend', async (req, res, next) => {
  try {
    const p = req.session.pending;
    if (!p) return res.redirect('/login');
    const user = await db.getUser(p.userId);
    const otp  = await sendCode(user, p.purpose, { toEmail: p.toEmail || user.email });
    if (otp.error) req.session.error = otp.error;
    else req.session.flash = 'A new code is on its way.';
    res.redirect('/verify');
  } catch (e) { next(e); }
});

router.get('/verify/cancel', (req, res) => {
  delete req.session.pending;
  res.redirect('/login');
});

// ── FORGOT PASSWORD / ACCOUNT RECOVERY ───────────────────────────────────────
router.get('/forgot-password', (req, res) =>
  res.render('pages/auth/forgot-password', { title: 'Forgot Password', mode: 'password_reset' }));

router.get('/recover', (req, res) =>
  res.render('pages/auth/forgot-password', { title: 'Account Recovery', mode: 'account_recovery' }));

router.post('/forgot-password', async (req, res, next) => {
  try {
    const purpose = req.body.mode === 'account_recovery' ? 'account_recovery' : 'password_reset';
    const back    = purpose === 'account_recovery' ? '/recover' : '/forgot-password';
    const user    = await db.findByEmail(req.body.email);

    // Same answer either way, so the form cannot be used to discover accounts.
    const generic = 'If an account is associated with that email address, we have sent recovery instructions.';

    if (!user || user.status === 'disabled' || !['admin', 'cashier', 'registrar'].includes(user.role)) {
      req.session.flash = generic;
      return res.redirect(back);
    }
    setPending(req, user, purpose);
    const otp = await sendCode(user, purpose, { force: true });
    if (otp.error) { req.session.error = otp.error; return res.redirect(back); }
    req.session.flash = generic;
    res.redirect('/verify');
  } catch (e) { next(e); }
});

// ── RESET PASSWORD ───────────────────────────────────────────────────────────
router.get('/reset-password', (req, res) => {
  if (!req.session.resetFor) return res.redirect('/login');
  res.render('pages/auth/reset-password', {
    title: 'Reset Password', rules: auth.PASSWORD_RULES, formError: null,
  });
});

router.post('/reset-password', async (req, res, next) => {
  try {
    const r = req.session.resetFor;
    if (!r) return res.redirect('/login');
    if (req.body.newPassword !== req.body.confirmPassword) {
      return res.status(400).render('pages/auth/reset-password', {
        title: 'Reset Password', rules: auth.PASSWORD_RULES, formError: 'Passwords do not match.',
      });
    }
    const out = await db.setPassword(r.userId, req.body.newPassword);
    if (out.error) {
      return res.status(400).render('pages/auth/reset-password', {
        title: 'Reset Password', rules: auth.PASSWORD_RULES, formError: out.error,
      });
    }
    delete req.session.resetFor;
    req.session.flash = 'Your password has been successfully updated. Please log in.';
    res.redirect('/login');
  } catch (e) { next(e); }
});

router.get('/logout', (req, res) => req.session.destroy(() => res.redirect('/login')));

module.exports = router;
