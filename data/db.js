'use strict';
const crypto = require('crypto');
const pool   = require('../database/connection');
const auth   = require('./auth');
const predict = require('./prediction');
const peak    = require('./peak');
const paging  = require('./paging');
const engine  = require('./engine');
const dispatch = require('./dispatch');
const push    = require('./push');

const q   = async (sql, p = []) => (await pool.execute(sql, p))[0];
const run = async (sql, p = []) => (await pool.execute(sql, p))[0];

// ── date helpers ─────────────────────────────────────────────────────────────
const pad = n => String(n).padStart(2, '0');
function ymd(d) { return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; }
function today()    { return ymd(new Date()); }
function tomorrow() { const d = new Date(); d.setDate(d.getDate() + 1); return ymd(d); }
function addDays(base, n) { const d = new Date(base + 'T00:00:00'); d.setDate(d.getDate() + n); return ymd(d); }
function hhmm(t)    { return t ? String(t).slice(0, 5) : null; }
function addMinutes(base, mins) {
  const d = new Date(base.getTime() + mins * 60000);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** First, middle and last name; a middle name of "N/A" (none) is left out. */
const fullName = r => [r.first_name, /^n\/a$/i.test(String(r.middle_name || '').trim()) ? '' : r.middle_name, r.last_name]
  .filter(Boolean).join(' ');

const PURPOSES = ['Transfer','Personal Reference','Job Purposes',
                  'Board Examination',"Graduation / Dean's List",'Others'];
const PRIORITY_TYPES = ['pwd','senior','pregnant'];
// An approved proof is remembered per student number: PWD and Senior Citizen
// do not change within a year; a pregnancy is temporary.
const PRIORITY_REMEMBER_DAYS = { pwd: 365, senior: 365, pregnant: 30 };
// Programs offered by Libon Community College. BSED (six majors) and BTVTEd
// (three majors) are listed one entry per major, so the student picks the exact
// program once instead of picking the degree and then a separate major.
const COURSES = [
  'BEED',
  'BECE',
  'BSED - English',
  'BSED - Filipino',
  'BSED - Mathematics',
  'BSED - Science',
  'BSED - Social Studies',
  'BSED - Values Education',
  'BSAB',
  'BTVTEd - Automotive Technology',
  'BTVTEd - Electrical Technology',
  'BTVTEd - Food Service Management'
];

/** True when the submitted course is one the college actually offers. */
function isCourse(v) {
  return COURSES.includes(String(v || '').trim());
}

// ── SETTINGS ─────────────────────────────────────────────────────────────────
async function getSettings() {
  const r = await q('SELECT * FROM settings WHERE id=1');
  const s = r[0];
  return {
    institutionName: s.institution_name, systemName: s.system_name,
    academicYear: s.academic_year,
    openTime: hhmm(s.open_time), closeTime: hhmm(s.close_time),
    breakStart: hhmm(s.break_start), breakEnd: hhmm(s.break_end),
    openDays: String(s.open_days).split(',').map(Number),
    cashierCapacity: s.cashier_capacity, registrarCapacity: s.registrar_capacity,
    capacityMode: s.capacity_mode, avgServiceMinutes: s.avg_service_minutes,
    minSamples: s.min_samples,
    cancelAfterMinutes: s.cancel_after_minutes,
    warnBeforeMinutes: s.warn_before_minutes,
    noShowAfterMinutes: s.no_show_after_minutes,
    expireWaitingMinutes: s.expire_waiting_minutes,
    scheduleMaxDays: s.schedule_max_days,
    allowSameDay: !!s.allow_same_day,
    dailySlotLimit: s.daily_slot_limit,
    maxCopies: s.max_copies,
    maxBatchDocuments: s.max_batch_documents, refreshRate: s.refresh_rate,
    announcement: s.announcement || '',
    learnFrom: s.learn_from || null,
  };
}

/** "Start learning fresh": services finished before now stop counting toward learned times. */
async function resetLearning() {
  await run('UPDATE settings SET learn_from = NOW() WHERE id=1');
}
/** How many finished services the estimates are learning from. */
async function learningStatus() {
  const [r] = await q(
    `SELECT (SELECT learn_from FROM settings WHERE id=1) AS since,
            (SELECT COUNT(*) FROM transactions WHERE ticket_status='completed' AND actual_minutes IS NOT NULL
               AND completed_at >= COALESCE((SELECT learn_from FROM settings WHERE id=1), '2000-01-01')) AS counted,
            (SELECT COUNT(*) FROM transactions WHERE ticket_status='completed' AND actual_minutes IS NOT NULL) AS total`);
  return { since: r.since, counted: Number(r.counted), total: Number(r.total) };
}

async function saveSettings(b) {
  await run(
    `UPDATE settings SET institution_name=?,system_name=?,academic_year=?,
      open_time=?,close_time=?,break_start=?,break_end=?,open_days=?,
      cashier_capacity=?,registrar_capacity=?,capacity_mode=?,avg_service_minutes=?,
      min_samples=?,cancel_after_minutes=?,warn_before_minutes=?,no_show_after_minutes=?,
      expire_waiting_minutes=?,schedule_max_days=?,allow_same_day=?,daily_slot_limit=?,
      max_copies=?,max_batch_documents=?,refresh_rate=?,announcement=? WHERE id=1`,
    [ b.institutionName || 'Libon Community College', b.systemName || 'SmartQ',
      b.academicYear || '2025-2026',
      b.openTime || '08:00', b.closeTime || '17:00',
      b.breakStart || '12:00', b.breakEnd || '13:00',
      Array.isArray(b.openDays) ? b.openDays.join(',') : (b.openDays || '1,2,3,4,5'),
      +b.cashierCapacity || 120, +b.registrarCapacity || 60,
      b.capacityMode === 'manual' ? 'manual' : 'auto',
      +b.avgServiceMinutes || 8, +b.minSamples || 3,
      +b.cancelAfterMinutes || 15, +b.warnBeforeMinutes || 5,
      +b.noShowAfterMinutes || 5, +b.expireWaitingMinutes || 60,
      Math.max(0, +b.scheduleMaxDays || 30),
      (b.allowSameDay === 'on' || b.allowSameDay === '1' || b.allowSameDay === true) ? 1 : 0,
      Math.max(0, +b.dailySlotLimit || 0), Math.max(1, +b.maxCopies || 10),
      +b.maxBatchDocuments || 4,
      +b.refreshRate || 8, b.announcement || '' ]
  );
  return getSettings();
}

// ── AUTH ─────────────────────────────────────────────────────────────────────
function mapUser(u) {
  if (!u) return null;
  return {
    id: u.id, email: u.email, username: u.username, role: u.role,
    firstName: u.first_name, middleName: u.middle_name || '', lastName: u.last_name,
    name: `${u.first_name} ${u.last_name}`,
    fullName: fullName(u),
    contactNo: u.contact_no || '', studentNo: u.student_no || '',
    course: u.course || '', yearLevel: u.year_level || null,
    academicYear: u.academic_year || '',
    windowId: u.window_id || null,
    status: u.status || 'active',
    isActive: (u.status || 'active') === 'active',
    emailVerified: !!u.email_verified,
    lockedUntil: u.locked_until || null,
    lastLogin: u.last_login || null,
    profilePicture: u.profile_picture || null,
    authProvider: u.auth_provider || 'local',
    hasPassword: !!u.password,
    googleId: u.google_id || null,
    priorityStatus: u.priority_status || 'none',
    priorityApprovedAt: u.priority_approved_at || null,
    mustChangePassword: !!u.must_change_password,
    createdAt: u.created_at || null,
    deleted: !!u.deleted_at,
  };
}

/**
 * Step 1 of signing in: check the credentials only.
 * A session is NOT created here — the caller must pass OTP verification first.
 * `identifier` may be a username or an email address.
 */
async function verifyCredentials(identifier, password) {
  const id = String(identifier || '').trim().toLowerCase();
  const rows = await q(
    `SELECT * FROM users WHERE LOWER(username) = ? OR LOWER(email) = ? LIMIT 1`, [id, id]);

  // Same message whether the account is missing or the password is wrong,
  // so the form cannot be used to discover which usernames exist.
  if (!rows.length) return { error: 'Invalid username or password.' };

  let user = mapUser(rows[0]);
  user = await auth.releaseExpiredLock(user);

  if (user.status === 'disabled')
    return { error: 'Your account has been disabled. Please contact the office.' };

  if (user.status === 'locked') {
    const mins = Math.max(1, Math.ceil((new Date(user.lockedUntil) - Date.now()) / 60000));
    return { error: `Too many failed attempts. Try again in ${mins} minute${mins === 1 ? '' : 's'}.` };
  }

  if (!rows[0].password) {
    return { error: 'That account signs in with Google. Use the "Continue with Google" button.' };
  }

  const ok = await auth.comparePassword(password, rows[0].password);
  if (!ok) {
    const res = await auth.registerFailedLogin(user.id);
    return { error: res.locked
      ? `Too many failed attempts. Your account is locked for ${res.minutes} minutes.`
      : 'Invalid username or password.' };
  }

  if (user.status === 'pending_verification' || !user.emailVerified)
    return { pending: true, user };

  return { ok: true, user };
}

async function emailTaken(email, exceptId = 0) {
  const r = await q('SELECT id FROM users WHERE email=? AND id<>? LIMIT 1', [email, exceptId]);
  return r.length > 0;
}

/**
 * Google sign-in. Links to an existing account with the same email when there
 * is one, otherwise creates a new student account.
 * Google has already confirmed the address, so the account is verified at once
 * and never has to enter an OTP.
 */
async function findOrCreateGoogleUser(profile) {
  const googleId = profile.id;
  const email    = (profile.emails && profile.emails[0] && profile.emails[0].value || '').toLowerCase();
  const given    = (profile.name && profile.name.givenName)  || profile.displayName || 'User';
  const family   = (profile.name && profile.name.familyName) || '';

  if (!email) return { error: 'Google did not share an email address with SmartQ.' };

  const blocked = row => {
    if (row.status === 'disabled') return 'Your account has been disabled. Please contact the office.';
    if (row.status === 'locked' && row.locked_until && new Date(row.locked_until) > Date.now())
      return 'Your account is temporarily locked. Please try again later.';
    return null;
  };

  // already linked
  let rows = await q('SELECT * FROM users WHERE google_id=? LIMIT 1', [googleId]);
  if (rows.length) {
    const b = blocked(rows[0]); if (b) return { error: b };
    return { user: mapUser(rows[0]), created: false };
  }

  // same email registered earlier with a password - link the two accounts
  rows = await q('SELECT * FROM users WHERE LOWER(email)=? LIMIT 1', [email]);
  if (rows.length) {
    const b = blocked(rows[0]); if (b) return { error: b };
    await run(
      `UPDATE users SET google_id=?, email_verified=1,
         auth_provider = CASE WHEN password IS NOT NULL THEN 'local_google' ELSE 'google' END,
         status = CASE WHEN status='pending_verification' THEN 'active' ELSE status END
       WHERE id=?`, [googleId, rows[0].id]);
    return { user: await getUser(rows[0].id), created: false, linked: true };
  }

  // brand new account
  const r = await run(
    `INSERT INTO users (email,password,role,first_name,last_name,
                        google_id,auth_provider,email_verified,status)
     VALUES (?,NULL,'student',?,?,?, 'google',1,'active')`,
    [email, given, family || given, googleId]);
  return { user: await getUser(r.insertId), created: true };
}

async function getUser(id) {
  const r = await q('SELECT * FROM users WHERE id=?', [id]);
  return mapUser(r[0]);
}

/** Account settings — students/guests edit their own profile. */
async function updateProfile(id, b) {
  const me = await getUser(id);
  if (!me) return { error: 'Account not found.' };
  if (!b.firstName || !b.lastName) return { error: 'First and last name are required.' };
  if (!b.email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(b.email))
    return { error: 'Please enter a valid email address.' };
  if (await emailTaken(b.email.trim().toLowerCase(), id))
    return { error: 'That email is already used by another account.' };
  if (b.course && !isCourse(b.course))
    return { error: 'Please choose one of the courses offered by the college.' };
  // Students must keep a valid, unique student number; guests have none.
  let studentNo = null;
  if (me.role === 'student') {
    const sn = await checkStudentNo(b.studentNo, id);
    if (sn.error) return { error: sn.error };
    studentNo = sn.no;
  }

  await run(
    `UPDATE users SET email=?,first_name=?,middle_name=?,last_name=?,contact_no=?,
       student_no=?,course=?,year_level=?,academic_year=? WHERE id=?`,
    [ b.email.trim().toLowerCase(), b.firstName.trim(),
      (b.middleName || '').trim() || null, b.lastName.trim(),
      (b.contactNo || '').trim() || null,
      studentNo,
      b.course || null, b.yearLevel ? +b.yearLevel : null,
      (b.academicYear || '').trim() || null, id ]
  );
  return getUser(id);
}

/** True when a student account still needs course, year level or a student number. */
function needsProfile(u) {
  return u && u.role === 'student' && (!u.course || !u.yearLevel || !STUDENT_NO_RE.test(u.studentNo || ''));
}

// LCC student numbers are exactly 9 digits, and one number belongs to one account.
const STUDENT_NO_RE = /^\d{9}$/;
async function checkStudentNo(raw, userId) {
  const no = String(raw || '').replace(/\s+/g, '');
  if (!no)                     return { error: 'Student number is required.' };
  if (!STUDENT_NO_RE.test(no)) return { error: 'Student number must be exactly 9 digits, numbers only.' };
  const taken = await q('SELECT id FROM users WHERE student_no=? AND id<>? LIMIT 1', [no, userId]);
  if (taken.length)            return { error: 'That student number is already used by another account. If it is yours, please contact the Registrar.' };
  return { no };
}

/** Finish the profile after signing in with Google for the first time. */
async function completeProfile(id, b) {
  const role = b.role === 'guest' ? 'guest' : 'student';
  if (!b.firstName || !b.lastName) return { error: 'First and last name are required.' };
  if (role === 'student' && (!b.course || !b.yearLevel))
    return { error: 'Course and year level are required for a student account.' };
  if (role === 'student' && !isCourse(b.course))
    return { error: 'Please choose one of the courses offered by the college.' };
  let studentNo = null;
  if (role === 'student') {
    const sn = await checkStudentNo(b.studentNo, id);
    if (sn.error) return { error: sn.error };
    studentNo = sn.no;
  }

  const s = await getSettings();
  await run(
    `UPDATE users SET role=?, first_name=?, middle_name=?, last_name=?, contact_no=?,
       student_no=?, course=?, year_level=?, academic_year=? WHERE id=?`,
    [ role, b.firstName.trim(), (b.middleName || '').trim() || null, b.lastName.trim(),
      (b.contactNo || '').trim() || null,
      studentNo,
      role === 'student' ? b.course : null,
      role === 'student' ? +b.yearLevel : null,
      role === 'student' ? (b.academicYear || s.academicYear) : null, id ]);
  return { ok: true, user: await getUser(id) };
}

/** Google accounts start with no password; this lets them set one. */
async function setInitialPassword(id, next, confirm) {
  const r = await q('SELECT password FROM users WHERE id=?', [id]);
  if (!r.length)                return { error: 'Account not found.' };
  if (r[0].password)            return { error: 'This account already has a password.' };
  if (!next || next.length < 6) return { error: 'Password must be at least 6 characters.' };
  if (next !== confirm)         return { error: 'Passwords do not match.' };
  await run('UPDATE users SET password=? WHERE id=?', [next, id]);
  return { ok: true };
}

/** Confirm the current password before allowing a change. */
async function checkCurrentPassword(id, plain) {
  const r = await q('SELECT password FROM users WHERE id=?', [id]);
  if (!r.length || !r[0].password) return false;
  return auth.comparePassword(plain, r[0].password);
}

async function changePassword(id, current, next, confirm) {
  const r = await q('SELECT password FROM users WHERE id=?', [id]);
  if (!r.length)                return { error: 'Account not found.' };
  if (r[0].password !== current) return { error: 'Your current password is incorrect.' };
  if (!next || next.length < 6)  return { error: 'New password must be at least 6 characters.' };
  if (next !== confirm)          return { error: 'New passwords do not match.' };
  await run('UPDATE users SET password=? WHERE id=?', [next, id]);
  return { ok: true };
}

async function getPermissions(role) {
  const r = await q('SELECT permission FROM role_permissions WHERE role=?', [role]);
  return r.map(x => x.permission);
}

// ── REQUIREMENTS ─────────────────────────────────────────────────────────────
/** What the office asks for, for one item. */
async function getDocumentRequirements(serviceId) {
  return (await q(
    `SELECT * FROM document_requirements WHERE document_id=? ORDER BY sort_order, id`,
    [serviceId])).map(r => ({
      id: r.id, serviceId: r.document_id, label: r.label,
      note: r.note || '', isRequired: !!r.is_required, sortOrder: r.sort_order,
    }));
}

/** Requirements for every active item, so the student sees them before requesting. */
async function getRequirementsByDocument() {
  const rows = await q(
    `SELECT r.*, s.name AS service_name FROM document_requirements r
     JOIN documents s ON s.id = r.document_id
     ORDER BY r.document_id, r.sort_order, r.id`);
  const by = {};
  rows.forEach(r => {
    (by[r.document_id] = by[r.document_id] || []).push({
      id: r.id, label: r.label, note: r.note || '', isRequired: !!r.is_required,
    });
  });
  return by;
}

async function addDocumentRequirement(b) {
  const sid = parseInt(b.serviceId, 10);
  if (!sid) return { error: 'Choose a document.' };
  if (!String(b.label || '').trim()) return { error: 'Describe the requirement.' };
  const pos = await q(
    `SELECT IFNULL(MAX(sort_order),0)+1 AS p FROM document_requirements WHERE document_id=?`, [sid]);
  await run(
    `INSERT INTO document_requirements (document_id,label,note,is_required,sort_order)
     VALUES (?,?,?,?,?)`,
    [sid, String(b.label).trim(), String(b.note || '').trim() || null,
     b.isRequired === false ? 0 : 1, Number(pos[0].p) || 1]);
  return { ok: true };
}

async function deleteDocumentRequirement(id) {
  await run('DELETE FROM document_requirements WHERE id=?', [id]);
  return { ok: true };
}

/** The snapshot attached to a transaction, which staff tick off. */
async function getTransactionRequirements(txId) {
  return (await q(
    `SELECT * FROM transaction_requirements WHERE transaction_id=? ORDER BY id`, [txId]))
    .map(r => ({
      id: r.id, label: r.label, isRequired: !!r.is_required,
      submitted: !!r.submitted, checkerName: r.checker_name || '', checkedAt: r.checked_at,
    }));
}

/**
 * For a Cashier ticket: the requirements the student will need later, when
 * they claim its documents at the Registrar (e.g. the OTR's ID and clearance).
 */
async function getRequirementsForClaim(txId) {
  return (await q(
    `SELECT DISTINCT dr.id, dr.label, dr.is_required, dr.sort_order
     FROM transaction_documents td
     JOIN documents d ON d.id = td.document_id AND d.needs_requirements = 1
     JOIN document_requirements dr ON dr.document_id = td.document_id
     WHERE td.transaction_id = ?
     ORDER BY dr.sort_order, dr.id`, [txId]))
    .map(r => ({ id: r.id, label: r.label, isRequired: !!r.is_required }));
}

/** Staff record which requirements were actually handed over. */
async function setTransactionRequirements(staff, txId, submittedIds) {
  const ids = (Array.isArray(submittedIds) ? submittedIds : submittedIds ? [submittedIds] : [])
    .map(Number).filter(Boolean);

  await run(`UPDATE transaction_requirements SET submitted=0, checked_by=NULL,
             checker_name=NULL, checked_at=NULL WHERE transaction_id=?`, [txId]);
  if (ids.length) {
    await run(
      `UPDATE transaction_requirements
       SET submitted=1, checked_by=?, checker_name=?, checked_at=NOW()
       WHERE transaction_id=? AND id IN (${ids.map(() => '?').join(',')})`,
      [staff.id, staff.fullName, txId, ...ids]);
  }
  const missing = await q(
    `SELECT COUNT(*) AS c FROM transaction_requirements
     WHERE transaction_id=? AND is_required=1 AND submitted=0`, [txId]);
  return { ok: true, missing: Number(missing[0].c) || 0 };
}


// ── BOOKING CALENDAR ─────────────────────────────────────────────────────────
/** Any per-day override for this office, keyed by date. */
async function getDayOverrides(department, from, to) {
  const rows = await q(
    `SELECT * FROM day_overrides WHERE department=? AND day BETWEEN ? AND ?`,
    [department, from, to]);
  const by = {};
  rows.forEach(r => {
    by[ymd(new Date(r.day))] = {
      isClosed: !!r.is_closed,
      slotLimit: r.slot_limit === null ? null : Number(r.slot_limit),
      note: r.note || '', setterName: r.setter_name || '',
    };
  });
  return by;
}

/**
 * One month of ticket counts for an office, or for 'Both' offices side by side.
 * Every ticket counts on its service date, whether it was booked ahead or taken
 * the same day - the same rule slotsUsed() applies when enforcing a day's cap.
 */
async function getCalendarMonth(department, year, month) {
  if (department === 'Both') return mergeCalendars(
    await getCalendarMonth('Cashier', year, month),
    await getCalendarMonth('Registrar', year, month));

  const first = new Date(Date.UTC(year, month - 1, 1));
  const last  = new Date(Date.UTC(year, month, 0));
  const from  = ymd(first), to = ymd(last);

  const rows = await q(
    `SELECT service_date AS d,
            COUNT(*) AS booked,
            SUM(is_scheduled=0) AS same_day,
            SUM(queue_category='priority') AS priority,
            SUM(overall_status='completed') AS done,
            SUM(overall_status='cancelled') AS cancelled
     FROM transactions
     WHERE department=? AND service_date BETWEEN ? AND ?
     GROUP BY service_date`, [department, from, to]);

  const counts = {};
  rows.forEach(r => {
    counts[ymd(new Date(r.d))] = {
      booked: Number(r.booked) || 0,
      sameDay: Number(r.same_day) || 0,
      priority: Number(r.priority) || 0,
      done: Number(r.done) || 0,
      cancelled: Number(r.cancelled) || 0,
    };
  });

  const s = await getSettings();
  const overrides = await getDayOverrides(department, from, to);
  const todayStr  = today();
  const maxStr    = addDays(todayStr, s.scheduleMaxDays);

  // pad to whole weeks, Monday first
  const startPad = ((first.getUTCDay() || 7) - 1);
  const days = [];
  for (let i = 0; i < startPad; i++) days.push(null);

  for (let d = 1; d <= last.getUTCDate(); d++) {
    const date = ymd(new Date(Date.UTC(year, month - 1, d)));
    const dow  = (new Date(date + 'T00:00:00').getDay()) || 7;
    const ov   = overrides[date] || {};
    const c    = counts[date] || { booked: 0, sameDay: 0, priority: 0, done: 0, cancelled: 0 };

    const cap       = ov.slotLimit != null ? ov.slotLimit : s.dailySlotLimit;  // 0 = no cap
    const active    = c.booked - c.cancelled;
    const officeDay = s.openDays.includes(dow);
    const closed    = !!ov.isClosed || !officeDay;

    let load = 'none';
    if (closed)             load = 'closed';
    else if (!active)       load = 'free';
    else if (cap > 0 && active >= cap)          load = 'full';
    else if (cap > 0 && active >= cap * 0.7)    load = 'busy';
    else                                         load = 'open';

    days.push({
      date, dayNum: d, dow,
      booked: active, sameDay: c.sameDay, priority: c.priority, done: c.done, cancelled: c.cancelled,
      cap, closed, closedByOffice: !officeDay, load,
      note: ov.note || '', setterName: ov.setterName || '',
      hasOverride: !!overrides[date],
      isToday: date === todayStr,
      isPast: date < todayStr,
      bookable: !closed && date >= todayStr && date <= maxStr,
    });
  }
  while (days.length % 7) days.push(null);

  const totals = days.filter(Boolean).reduce((t, d) => {
    t.booked += d.booked; t.priority += d.priority;
    if (d.closed && !d.closedByOffice) t.closedDays++;
    return t;
  }, { booked: 0, priority: 0, closedDays: 0 });

  return {
    department, year, month, from, to, days, totals,
    monthName: first.toLocaleDateString('en-PH', { month: 'long', year: 'numeric', timeZone: 'UTC' }),
    prev: month === 1 ? { y: year - 1, m: 12 } : { y: year, m: month - 1 },
    next: month === 12 ? { y: year + 1, m: 1 } : { y: year, m: month + 1 },
    defaultCap: s.dailySlotLimit, maxDate: maxStr,
  };
}

/**
 * Put the Cashier and Registrar months side by side. Each day keeps both
 * offices' figures (d.cashier, d.registrar); the top-level numbers are totals.
 * A day counts as closed only when both offices are closed, and takes the
 * busier office's load colour.
 */
function mergeCalendars(c, r) {
  const rank = { none: 0, free: 1, open: 2, busy: 3, full: 4, closed: -1 };
  const days = c.days.map((dc, i) => {
    const dr = r.days[i];
    if (!dc) return null;
    const closed = dc.closed && dr.closed;
    const load = closed ? 'closed'
      : [dc.load, dr.load].filter(l => l !== 'closed').sort((a, b) => rank[b] - rank[a])[0];
    return {
      date: dc.date, dayNum: dc.dayNum, dow: dc.dow,
      isToday: dc.isToday, isPast: dc.isPast,
      booked: dc.booked + dr.booked, sameDay: dc.sameDay + dr.sameDay,
      priority: dc.priority + dr.priority,
      closed, closedByOffice: dc.closedByOffice && dr.closedByOffice, load,
      hasOverride: dc.hasOverride || dr.hasOverride,
      cashier: dc, registrar: dr,
    };
  });
  return {
    ...c, department: 'Both', days,
    totals: {
      booked: c.totals.booked + r.totals.booked,
      priority: c.totals.priority + r.totals.priority,
      closedDays: c.totals.closedDays + r.totals.closedDays,
    },
  };
}

/** Everyone with a ticket on one date, at one office or at 'Both'. */
async function getDayBookings(department, date) {
  const offices = department === 'Both' ? ['Cashier', 'Registrar'] : [department];
  const rows = await q(
    `SELECT * FROM transactions
     WHERE department IN (${offices.map(() => '?').join(',')}) AND service_date=?
     ORDER BY FIELD(department,'Cashier','Registrar'),
              FIELD(queue_category,'priority','regular'), queue_at, id`,
    [...offices, date]);
  const list = rows.map(mapTx);
  await attachDocuments(list);
  return list;
}

/** Close a single date, or give it its own cap. */
async function setDayOverride(staff, department, date, b) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(date || ''))) return { error: 'That date is not valid.' };
  if (department !== 'Cashier' && department !== 'Registrar') return { error: 'Unknown office.' };

  const closed = b.isClosed === '1' || b.isClosed === 'on' || b.isClosed === true;
  let limit = String(b.slotLimit || '').trim() === '' ? null : parseInt(b.slotLimit, 10);
  if (limit !== null && (isNaN(limit) || limit < 0)) return { error: 'The cap must be zero or more.' };

  // nothing set: drop the row so the day follows the office defaults again
  if (!closed && limit === null && !String(b.note || '').trim()) {
    await run('DELETE FROM day_overrides WHERE department=? AND day=?', [department, date]);
    return { ok: true, cleared: true };
  }

  await run(
    `INSERT INTO day_overrides (department,day,is_closed,slot_limit,note,set_by,setter_name)
     VALUES (?,?,?,?,?,?,?)
     ON DUPLICATE KEY UPDATE is_closed=VALUES(is_closed), slot_limit=VALUES(slot_limit),
       note=VALUES(note), set_by=VALUES(set_by), setter_name=VALUES(setter_name)`,
    [department, date, closed ? 1 : 0, limit,
     String(b.note || '').trim() || null, staff.id, staff.fullName]);
  return { ok: true };
}

// ── PRIORITY LANE REQUESTS ───────────────────────────────────────────────────
const PRIORITY_LABELS = { pwd: 'PWD', senior: 'Senior Citizen', pregnant: 'Pregnant' };

function mapPriorityRequest(r) {
  return {
    id: r.id, userId: r.user_id, category: r.category,
    categoryLabel: PRIORITY_LABELS[r.category] || r.category,
    proofFile: r.proof_file, proofMime: r.proof_mime, proofName: r.proof_name,
    isImage: /^image\//.test(r.proof_mime || ''),
    status: r.status, reason: r.reason || '',
    reviewerName: r.reviewer_name || '', reviewedAt: r.reviewed_at,
    createdAt: r.created_at,
    name: r.first_name ? fullName(r) : '',
    email: r.email || '', role: r.role || '', studentNo: r.student_no || '',
    course: r.course || '', yearLevel: r.year_level || null,
    // the walk-in ticket waiting on this review, if any
    transactionId: r.transaction_id || null, ticketNo: r.ticket_no || '',
    department: r.department || '', ticketStatus: r.ticket_status || '',
    serviceDate: r.service_date ? ymd(new Date(r.service_date)) : null,
    // the proof is the representative's when someone else comes to the window
    forRep: r.claimant === 'representative',
    repName: r.rep_name || '', repRelationship: r.rep_relationship || '',
  };
}

// Never the proof itself (proof_data): lists stay light.
const PR_SELECT = `
  SELECT p.id, p.user_id, p.transaction_id, p.category, p.proof_file, p.proof_mime, p.proof_name,
         p.status, p.reason, p.reviewer_name, p.reviewed_at, p.created_at,
         u.first_name, u.middle_name, u.last_name, u.email, u.role,
         u.student_no, u.course, u.year_level,
         t.ticket_no, t.department, t.ticket_status, t.service_date,
         t.claimant, t.rep_name, t.rep_relationship
  FROM priority_requests p
  JOIN users u ON u.id = p.user_id
  LEFT JOIN transactions t ON t.id = p.transaction_id`;

async function createPriorityRequest(userId, category, file) {
  if (!['pwd','senior','pregnant'].includes(category))
    return { error: 'Choose a priority category.' };
  if (!file) return { error: 'Please attach a photo or PDF of your proof.' };

  const pending = await q(
    `SELECT id FROM priority_requests WHERE user_id=? AND status='pending' LIMIT 1`, [userId]);
  if (pending.length)
    return { error: 'You already have a request waiting for review.' };

  await run(
    `INSERT INTO priority_requests (user_id,category,proof_file,proof_mime,proof_name)
     VALUES (?,?,?,?,?)`,
    [userId, category, file.filename, file.mimetype, file.originalname.slice(0, 160)]);
  return { ok: true };
}

/**
 * A walk-in's proof, sent with the ticket. The file is kept in the database
 * (the server's own disk is wiped whenever the free host restarts).
 */
async function createTicketPriorityRequest(t, category, file) {
  await run(
    `INSERT INTO priority_requests (user_id,transaction_id,category,proof_file,proof_mime,proof_name,proof_data)
     VALUES (?,?,?,'',?,?,?)`,
    [t.userId, t.id, category, file.mimetype, String(file.originalname || 'proof').slice(0, 160), file.buffer]);
  await run(
    `INSERT INTO queue_history (transaction_id,ticket_no,action,department,note)
     VALUES (?,?,'priority_requested',?,?)`,
    [t.id, t.ticketNo, t.department, `Asked for the ${PRIORITY_LABELS[category]} priority lane; proof waiting for review`]);
}

/** The newest priority request for one ticket (shown on the student's ticket). */
async function getTicketPriorityRequest(txId) {
  const r = await q(`${PR_SELECT} WHERE p.transaction_id=? ORDER BY p.id DESC LIMIT 1`, [txId]);
  return r.length ? mapPriorityRequest(r[0]) : null;
}

/** For the red dot on the Priority Requests menu. */
async function countPendingPriority() {
  const r = await q(`SELECT COUNT(*) AS n FROM priority_requests WHERE status='pending'`);
  return Number(r[0].n) || 0;
}

/** The proof to show a reviewer: from the database, or the old upload folder. */
async function getPriorityProof(id) {
  const r = await q('SELECT proof_file, proof_mime, proof_data FROM priority_requests WHERE id=?', [id]);
  if (!r.length) return null;
  return { mime: r[0].proof_mime, data: r[0].proof_data || null, file: r[0].proof_file || null };
}

async function getPriorityRequests(status) {
  const rows = await q(
    `${PR_SELECT}
     ${status ? 'WHERE p.status = ?' : ''}
     ORDER BY FIELD(p.status,'pending','approved','rejected'), p.created_at DESC`,
    status ? [status] : []);
  return rows.map(mapPriorityRequest);
}

async function getPriorityRequest(id) {
  const r = await q(`${PR_SELECT} WHERE p.id=?`, [id]);
  return r.length ? mapPriorityRequest(r[0]) : null;
}

async function getUserPriorityRequests(userId) {
  return (await q(`${PR_SELECT} WHERE p.user_id=? ORDER BY p.created_at DESC`, [userId]))
    .map(mapPriorityRequest);
}

/**
 * Staff or admin decision. Approving stamps the category onto the person's
 * record and, for a walk-in ticket still waiting in the regular lane, moves it
 * to the priority lane with a priority number, keeping its original time.
 */
async function decidePriorityRequest(reviewer, id, approve, reason) {
  const pr = await getPriorityRequest(id);
  if (!pr)                       return { error: 'Request not found.' };
  if (pr.status !== 'pending')   return { error: 'This request has already been reviewed.' };
  if (!approve && !String(reason || '').trim())
    return { error: 'Give a reason so the student knows what was wrong.' };

  await run(
    `UPDATE priority_requests SET status=?, reason=?, reviewed_by=?, reviewer_name=?, reviewed_at=NOW()
     WHERE id=?`,
    [approve ? 'approved' : 'rejected', approve ? null : String(reason).trim(),
     reviewer.id, reviewer.fullName, id]);

  let moved = null;
  if (approve) {
    // a representative's ID says nothing about the student: only the ticket moves
    if (!pr.forRep && pr.role === 'student')
      await run(`UPDATE users SET priority_status=?, priority_approved_at=NOW() WHERE id=?`,
                [pr.category, pr.userId]);
    if (pr.transactionId) moved = await moveToPriority(reviewer, pr.transactionId, pr.category);
  }
  if (pr.transactionId) {
    const t = await getTransaction(pr.transactionId);
    if (t) push.sendToTicket(t.id, approve
      ? { title: `Priority approved: ${t.ticketNo}`,
          body: moved ? `You moved to the priority lane. Bring the same ID to the window.` : 'Bring the same ID to the window.',
          url: '/queue/t/' + t.accessToken }
      : { title: 'Priority not approved',
          body: `${String(reason).trim()} You stay in the regular line.`, url: '/queue/t/' + t.accessToken });
  }
  return { ok: true, moved, request: await getPriorityRequest(id) };
}

/** Approved proof: a waiting regular ticket becomes a priority ticket. */
async function moveToPriority(reviewer, txId, category) {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const [rows] = await conn.execute(
      `SELECT id, ticket_no, department, service_date FROM transactions
       WHERE id=? AND queue_category='regular' AND ticket_status='waiting' FOR UPDATE`, [txId]);
    if (!rows.length) { await conn.rollback(); return null; }     // already called, done or cancelled
    const t = rows[0];
    const newNo = await nextTicketNo(conn, t.department, ymd(new Date(t.service_date)), 'priority');
    await conn.execute(
      `UPDATE transactions SET ticket_no=?, queue_category='priority', priority_type=? WHERE id=?`,
      [newNo, category, t.id]);
    await conn.execute(
      `INSERT INTO queue_history (transaction_id,ticket_no,action,staff_id,staff_name,department,note)
       VALUES (?,?,'moved_to_priority',?,?,?,?)`,
      [t.id, newNo, reviewer.id, reviewer.fullName, t.department,
       `${PRIORITY_LABELS[category]} proof approved; ${t.ticket_no} became ${newNo}`]);
    await conn.commit();
    return { from: t.ticket_no, to: newNo };
  } catch (e) {
    await conn.rollback();
    throw e;
  } finally {
    conn.release();
  }
}

/** Remove an approved status (e.g. an ID expired). */
async function revokePriority(userId) {
  await run(`UPDATE users SET priority_status='none', priority_approved_at=NULL WHERE id=?`, [userId]);
  return { ok: true };
}

// ── ACCOUNT CREATION / LINKING ───────────────────────────────────────────────
async function usernameTaken(username, exceptId = 0) {
  const r = await q('SELECT id FROM users WHERE LOWER(username)=? AND id<>? LIMIT 1',
                    [String(username).trim().toLowerCase(), exceptId]);
  return r.length > 0;
}

/** Manual registration. The account starts as pending_verification. */
async function registerLocal(b) {
  const first = String(b.firstName || '').trim();
  const last  = String(b.lastName  || '').trim();
  const uname = String(b.username  || '').trim();
  const email = String(b.email     || '').trim().toLowerCase();

  if (!first)  return { error: 'First name is required.' };
  if (!last)   return { error: 'Last name is required.' };
  if (!uname)  return { error: 'Username is required.' };
  if (!/^[A-Za-z0-9._-]{3,60}$/.test(uname))
    return { error: 'Username may use letters, numbers, dot, dash and underscore only (3-60 characters).' };
  if (!email)  return { error: 'Email address is required.' };
  if (!auth.isEmail(email)) return { error: 'Please enter a valid email address.' };

  const pwError = auth.checkPassword(b.password);
  if (pwError) return { error: pwError };
  if (b.password !== b.confirmPassword) return { error: 'Passwords do not match.' };

  if (await usernameTaken(uname)) return { error: 'This username is already registered.' };
  if (await emailTaken(email))    return { error: 'This email address is already registered.' };

  const hash = await auth.hashPassword(b.password);
  const r = await run(
    `INSERT INTO users (first_name,middle_name,last_name,username,email,password,role,
                        contact_no,auth_provider,email_verified,status)
     VALUES (?,?,?,?,?,?,'student',?, 'local',0,'pending_verification')`,
    [first, String(b.middleName || '').trim() || null, last, uname, email, hash,
     String(b.contactNo || '').trim() || null]);
  return { ok: true, user: await getUser(r.insertId) };
}

/** Mark the email confirmed and open the account. */
async function activateAccount(userId) {
  await run(`UPDATE users SET email_verified=1, status='active' WHERE id=?`, [userId]);
  return getUser(userId);
}

async function findByEmail(email) {
  const r = await q('SELECT * FROM users WHERE LOWER(email)=? LIMIT 1',
                    [String(email || '').trim().toLowerCase()]);
  return r.length ? mapUser(r[0]) : null;
}

async function setPassword(userId, plain) {
  const pwError = auth.checkPassword(plain);
  if (pwError) return { error: pwError };
  const hash = await auth.hashPassword(plain);
  await run(`UPDATE users SET password=?, password_changed_at=NOW(),
             failed_logins=0, locked_until=NULL, must_change_password=0,
             auth_provider = CASE WHEN google_id IS NOT NULL THEN 'local_google' ELSE 'local' END
             WHERE id=?`, [hash, userId]);
  await auth.invalidateOtps(userId);
  return { ok: true };
}

async function updateEmail(userId, newEmail) {
  const email = String(newEmail || '').trim().toLowerCase();
  if (!auth.isEmail(email))            return { error: 'Please enter a valid email address.' };
  if (await emailTaken(email, userId)) return { error: 'This email address is already registered.' };
  await run('UPDATE users SET email=?, email_verified=1 WHERE id=?', [email, userId]);
  return { ok: true };
}

// ── SERVICES ─────────────────────────────────────────────────────────────────
function mapDocument(s) {
  return {
    id: s.id, name: s.name, price: Number(s.price),
    paymentRequired: !!s.payment_required,
    office: s.office || (s.payment_required ? 'Cashier' : 'Registrar'),
    needsPurpose: !!s.needs_purpose,
    needsRequirements: !!s.needs_requirements, requiresClaim: !!s.requires_claim,
    guestAllowed: !!s.guest_allowed,
    baselineMinutes: s.baseline_minutes,
    processingDays: Number(s.processing_days) || 0,
    // a deleted document can never be requested again, whatever is_active says
    isActive: !!s.is_active && !s.deleted_at, deleted: !!s.deleted_at,
  };
}

/**
 * Delete a document. One that old tickets already use is hidden for good but
 * kept, so their receipts and reports still show its name; an unused one is
 * removed completely (its requirements go with it). Staff may only delete
 * their own office's documents.
 */
async function deleteDocument(id, office = null) {
  const d = await getDocument(id);
  if (!d || d.deleted) return { error: 'Document not found.' };
  if (office && d.office !== office) return { error: `Only the ${d.office} can delete that document.` };
  const used = await q('SELECT COUNT(*) AS n FROM transaction_documents WHERE document_id=?', [id]);
  if (Number(used[0].n)) {
    await run('UPDATE documents SET deleted_at=NOW(), is_active=0 WHERE id=?', [id]);
  } else {
    await run('DELETE FROM documents WHERE id=?', [id]);
  }
  return { ok: true, name: d.name };
}
async function getDocuments({ activeOnly = true, guestOnly = false, office = null } = {}) {
  let sql = 'SELECT * FROM documents';
  const w = ['deleted_at IS NULL'], p = [];      // deleted documents never appear
  if (activeOnly) w.push('is_active=1');
  if (office === 'Cashier' || office === 'Registrar') { w.push('office=?'); p.push(office); }
  if (guestOnly)  w.push('guest_allowed=1');
  if (w.length) sql += ' WHERE ' + w.join(' AND ');
  return (await q(sql + ' ORDER BY payment_required DESC, price DESC, name', p)).map(mapDocument);
}
async function getDocument(id) {
  const r = await q('SELECT * FROM documents WHERE id=?', [id]);
  return r.length ? mapDocument(r[0]) : null;
}
/** Days a paid document takes before it can be released: 0 (same day) to 60. */
const processingDaysOf = b => Math.min(60, Math.max(0, parseInt(b.processingDays, 10) || 0));

async function saveDocument(id, b) {
  if (!b.name || !String(b.name).trim()) return { error: 'Document name is required.' };
  const price = Number(b.price);
  if (isNaN(price) || price < 0) return { error: 'Price must be zero or greater.' };
  const args = [ b.name.trim(), price, b.paymentRequired ? 1 : 0, b.requiresClaim ? 1 : 0,
                 b.guestAllowed ? 1 : 0, +b.baselineMinutes || 8, b.isActive ? 1 : 0,
                 processingDaysOf(b) ];
  if (id) {
    await run(`UPDATE documents SET name=?,price=?,payment_required=?,requires_claim=?,
               guest_allowed=?,baseline_minutes=?,is_active=?,processing_days=?,
               office=IF(payment_required=1,'Cashier','Registrar') WHERE id=? AND deleted_at IS NULL`, [...args, id]);
  } else {
    const r = await run(`INSERT INTO documents (name,price,payment_required,requires_claim,
                         guest_allowed,baseline_minutes,is_active,processing_days) VALUES (?,?,?,?,?,?,?,?)`, args);
    // a new document's office follows whether it needs payment
    await run(`UPDATE documents SET office=IF(payment_required=1,'Cashier','Registrar') WHERE id=?`,
              [r.insertId]);
  }
  return { ok: true };
}

// ── ESTIMATION (historical, per document) ────────────────────────────────────────
async function getServiceAverages() {
  const s = await getSettings();
  const rows = await q(
    `SELECT td.document_name AS name, COUNT(*) AS n, ROUND(AVG(t.actual_minutes)) AS avg_min
     FROM transactions t
     JOIN transaction_documents td ON td.transaction_id = t.id
     WHERE t.ticket_status='completed' AND t.actual_minutes IS NOT NULL
       AND t.completed_at >= COALESCE((SELECT learn_from FROM settings WHERE id=1), '2000-01-01')
     GROUP BY td.document_name`
  );
  const map = {};
  rows.forEach(r => {
    map[r.name] = { samples: Number(r.n), avg: Number(r.avg_min),
                    source: Number(r.n) >= s.minSamples ? 'historical' : 'baseline' };
  });
  return map;
}

/** Minutes to allow for a set of items — historical average when we have enough data. */
async function estimateMinutes(items) {
  const s    = await getSettings();
  const hist = await getServiceAverages();
  let total = 0;
  for (const it of items) {
    const h = hist[it.name];
    total += (h && h.source === 'historical') ? h.avg : (it.baselineMinutes || s.avgServiceMinutes);
  }
  return Math.max(total, 1);
}

async function getEstimationTable() {
  const s = await getSettings();
  const hist = await getServiceAverages();
  return (await getDocuments({ activeOnly: false })).map(sv => {
    const h = hist[sv.name];
    return {
      name: sv.name, price: sv.price, baseline: sv.baselineMinutes,
      samples: h ? h.samples : 0,
      historical: h ? h.avg : null,
      effective: (h && h.source === 'historical') ? h.avg : sv.baselineMinutes,
      source: (h && h.source === 'historical') ? 'historical' : 'baseline',
      minSamples: s.minSamples,
    };
  });
}

// ── WINDOWS ──────────────────────────────────────────────────────────────────
const mapWindow = w => ({
  id: w.id, label: w.label, department: w.department,
  status: w.status, rrPosition: w.rr_position,
  serving: w.serving || null, servingName: w.serving_name || null,
  staffId: w.staff_id || null,
  staffName: w.staff_first ? [w.staff_first, w.staff_last].filter(Boolean).join(' ') : null,
  servedToday: Number(w.served_today) || 0,
  waitingDept: Number(w.waiting_dept) || 0,
});

async function getWindows(department) {
  const rows = await q(
    `SELECT w.*,
            t.ticket_no AS serving,
            CONCAT(t.first_name,' ',t.last_name) AS serving_name,
            u.id AS staff_id, u.first_name AS staff_first, u.last_name AS staff_last,
            (SELECT COUNT(*) FROM transactions x
              WHERE x.window_id = w.id AND x.service_date = CURDATE()
                AND x.ticket_status = 'completed')          AS served_today,
            (SELECT COUNT(*) FROM transactions y
              WHERE y.department = w.department AND y.service_date = CURDATE()
                AND y.ticket_status = 'waiting')            AS waiting_dept
     FROM windows w
     LEFT JOIN transactions t
       ON t.window_id = w.id AND t.ticket_status IN ('called','serving')
      AND t.service_date = CURDATE()
     LEFT JOIN users u ON u.window_id = w.id AND u.status = 'active'
     ${department ? 'WHERE w.department = ?' : ''}
     ORDER BY w.department, w.rr_position`,
    department ? [department] : []
  );
  return rows.map(mapWindow);
}

/** Staff accounts that can be posted to a window in this department. */
async function getAssignableStaff(department) {
  const role = department === 'Cashier' ? 'cashier' : 'registrar';
  return (await q(
    `SELECT id, first_name, middle_name, last_name, window_id
     FROM users WHERE role=? AND status='active' ORDER BY last_name`, [role]
  )).map(u => ({
    id: u.id, window: u.window_id,
    name: [u.first_name, u.middle_name, u.last_name].filter(Boolean).join(' '),
  }));
}

/**
 * Staff maintain their own office's documents. Price is deliberately not
 * accepted here — only an admin may set it — and the office is passed in from
 * the session rather than the form.
 */
async function saveDocumentAsStaff(office, b) {
  if (office !== 'Cashier' && office !== 'Registrar') return { error: 'Unknown office.' };
  const name = String(b.name || '').trim();
  if (!name) return { error: 'Give the document a name.' };

  const id = parseInt(b.id, 10) || 0;
  if (id) {
    const cur = await q('SELECT * FROM documents WHERE id=?', [id]);
    if (!cur.length) return { error: 'Document not found.' };
    if (cur[0].office !== office)
      return { error: 'That document belongs to the other office.' };

    await run(
      `UPDATE documents SET name=?, requires_claim=?, guest_allowed=?,
         baseline_minutes=?, is_active=?, processing_days=? WHERE id=? AND office=?`,
      [name, b.requiresClaim ? 1 : 0, b.guestAllowed ? 1 : 0,
       Math.max(1, +b.baselineMinutes || 10), b.isActive ? 1 : 0, processingDaysOf(b), id, office]);
    return { ok: true, created: false };
  }

  // A new Cashier document needs a price, which staff cannot set, so it starts
  // at zero and inactive until an admin prices and publishes it.
  const payment = office === 'Cashier' ? 1 : 0;
  const r = await run(
    `INSERT INTO documents (name,price,payment_required,office,requires_claim,
                            guest_allowed,baseline_minutes,is_active,processing_days)
     VALUES (?,?,?,?,?,?,?,?,?)`,
    [name, 0, payment, office, b.requiresClaim ? 1 : 0, b.guestAllowed ? 1 : 0,
     Math.max(1, +b.baselineMinutes || 10), office === 'Cashier' ? 0 : (b.isActive ? 1 : 0), processingDaysOf(b)]);
  return { ok: true, created: true, id: r.insertId, needsPrice: office === 'Cashier' };
}

/** Admin adds a new service window to an office. */
async function createWindow(b) {
  const dept = b.department === 'Registrar' ? 'Registrar'
             : b.department === 'Cashier'   ? 'Cashier' : null;
  if (!dept) return { error: 'Choose Cashier or Registrar.' };

  let label = String(b.label || '').trim();
  if (!label) {
    // suggest the next number in that office
    const n = await q(`SELECT COUNT(*) AS c FROM windows WHERE department=?`, [dept]);
    label = `${dept} Window ${(Number(n[0].c) || 0) + 1}`;
  }
  if (label.length > 30) return { error: 'Window name is too long (30 characters maximum).' };

  const dupe = await q(
    `SELECT id FROM windows WHERE department=? AND LOWER(label)=? LIMIT 1`,
    [dept, label.toLowerCase()]);
  if (dupe.length) return { error: `"${label}" already exists in the ${dept} office.` };

  const pos = await q(`SELECT IFNULL(MAX(rr_position),0)+1 AS p FROM windows WHERE department=?`, [dept]);
  const r = await run(
    `INSERT INTO windows (label, department, status, rr_position) VALUES (?,?,?,?)`,
    [label, dept, ['open','closed','break'].includes(b.status) ? b.status : 'closed',
     Number(pos[0].p) || 1]);

  // optionally post a staff member straight away
  if (b.staffId) {
    const role = dept === 'Cashier' ? 'cashier' : 'registrar';
    const u = await q('SELECT id FROM users WHERE id=? AND role=?', [b.staffId, role]);
    if (u.length) {
      await run('UPDATE users SET window_id=NULL WHERE window_id=?', [r.insertId]);
      await run('UPDATE users SET window_id=? WHERE id=?', [r.insertId, b.staffId]);
    }
  }
  return { ok: true, id: r.insertId, label, department: dept };
}

/** Admin edits a window: rename it, open/close it, and post a staff member to it. */
async function updateWindow(id, b) {
  if (!['open','closed','break'].includes(b.status)) return { error: 'Invalid status.' };
  const win = await q('SELECT * FROM windows WHERE id=?', [id]);
  if (!win.length) return { error: 'Window not found.' };

  await run('UPDATE windows SET label=?,status=? WHERE id=?',
            [String(b.label || '').trim() || 'Window', b.status, id]);

  // reassign staff: clear whoever was here, then post the chosen account
  if (b.staffId !== undefined) {
    await run('UPDATE users SET window_id=NULL WHERE window_id=?', [id]);
    if (b.staffId) {
      const role = win[0].department === 'Cashier' ? 'cashier' : 'registrar';
      const u = await q('SELECT id FROM users WHERE id=? AND role=?', [b.staffId, role]);
      if (!u.length) return { error: 'That staff account cannot be posted to this window.' };
      await run('UPDATE users SET window_id=? WHERE id=?', [id, b.staffId]);
    }
  }
  return { ok: true };
}

/**
 * Delete a window. Old tickets keep the window's name (window_label), so it
 * can go completely; staff posted there are simply unassigned. Refused while
 * someone is being served at it, and for an office's last window.
 */
async function deleteWindow(id) {
  const win = await q('SELECT * FROM windows WHERE id=?', [id]);
  if (!win.length) return { error: 'Window not found.' };
  const busy = await q(
    `SELECT ticket_no FROM transactions WHERE window_id=? AND ticket_status IN ('called','serving') LIMIT 1`, [id]);
  if (busy.length) return { error: `${win[0].label} is serving ${busy[0].ticket_no} right now. Finish or cancel it first.` };
  const left = await q('SELECT COUNT(*) AS n FROM windows WHERE department=?', [win[0].department]);
  if (Number(left[0].n) <= 1) return { error: `The ${win[0].department} needs at least one window.` };
  await run('UPDATE users SET window_id=NULL WHERE window_id=?', [id]);
  await run('DELETE FROM windows WHERE id=?', [id]);
  return { ok: true, label: win[0].label };
}

// ── TICKET NUMBERING (daily reset, per office and lane) ──────────────────────
// Four counters, each starting at 1 every day: Cashier regular (C-001),
// Cashier priority (CP-001), Registrar regular (R-001), Registrar priority
// (RP-001). A counter created mid-day starts after the highest number that
// office and lane already issued that day, so it never repeats a ticket.
async function nextTicketNo(conn, department, serviceDate, category) {
  const lane = category === 'priority' ? 'priority' : 'regular';
  const key  = `ticket-${department === 'Cashier' ? 'cashier' : 'registrar'}-${lane}`;
  const [used] = await conn.execute(
    `SELECT COALESCE(MAX(CAST(SUBSTRING_INDEX(ticket_no,'-',-1) AS UNSIGNED)),0) AS n
     FROM transactions WHERE department=? AND queue_category=? AND service_date=?`,
    [department, lane, serviceDate]);
  await conn.execute(
    `INSERT INTO counters (name,ref_date,value) VALUES (?,?,?)
     ON DUPLICATE KEY UPDATE value = value + 1`, [key, serviceDate, Number(used[0].n) + 1]);
  const [r] = await conn.execute(
    'SELECT value FROM counters WHERE name=? AND ref_date=?', [key, serviceDate]);
  const prefix = (department === 'Cashier' ? 'C' : 'R') + (lane === 'priority' ? 'P' : '');
  return `${prefix}-${String(r[0].value).padStart(3, '0')}`;
}

/** Receipt numbers never reset — OR-YYYYMMDD-#### */
async function nextReceiptNo(conn) {
  await conn.execute(
    `INSERT INTO counters (name,ref_date,value) VALUES ('receipt','1970-01-01',1)
     ON DUPLICATE KEY UPDATE value = value + 1`);
  const [r] = await conn.execute(
    `SELECT value FROM counters WHERE name='receipt' AND ref_date='1970-01-01'`);
  const d = new Date();
  return `OR-${d.getFullYear()}${pad(d.getMonth()+1)}${pad(d.getDate())}-${String(r[0].value).padStart(4,'0')}`;
}

// ── SCHEDULING VALIDATION (backend, authoritative) ───────────────────────────
/**
 * Only the next calendar day may be scheduled.
 * Returns { ok, serviceDate, isScheduled } or { error }.
 */
async function validateSchedule(mode, dateStr, department = null) {
  const s = await getSettings();

  if (mode !== 'schedule') {
    if (!s.allowSameDay)
      return { error: 'Same-day requests are closed. Please schedule for a later date.' };
    const dow = (new Date().getDay()) || 7;
    if (!s.openDays.includes(dow))
      return { error: 'The offices are closed today. Please schedule for a working day.' };
    if (isPastClosing(s))
      return { error: `Office hours are over for today (closed at ${clock12(s.closeTime)}). Please schedule for a later date.` };
    if (isBeforeJoinOpens(s))
      return { error: `Today's line opens at ${clock12(joinOpensAt(s))}. You can book a time instead.` };
    return { ok: true, serviceDate: today(), isScheduled: 0 };
  }

  if (!dateStr) return { error: 'Please choose a date for your scheduled transaction.' };
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) return { error: 'That date is not valid.' };

  const pick = new Date(dateStr + 'T00:00:00');
  if (isNaN(pick.getTime())) return { error: 'That date is not valid.' };

  const start = new Date(today() + 'T00:00:00');
  const days  = Math.round((pick - start) / 86400000);

  if (days < 0)  return { error: 'That date has already passed.' };
  if (days === 0 && !s.allowSameDay)
    return { error: 'Same-day requests are closed. Please choose a later date.' };
  if (days === 0 && isPastClosing(s))
    return { error: `Office hours are over for today (closed at ${clock12(s.closeTime)}). Please choose a later date.` };
  if (days > s.scheduleMaxDays)
    return { error: `You can book up to ${s.scheduleMaxDays} days ahead. ` +
                    `The latest date available is ${addDays(today(), s.scheduleMaxDays)}.` };

  const dow = (pick.getDay()) || 7;
  if (!s.openDays.includes(dow))
    return { error: 'The offices are closed on that day. Please choose a working day.' };

  // a single date can be closed by staff from the booking calendar
  if (department) {
    const ov = await getDayOverrides(department, dateStr, dateStr);
    const day = ov[dateStr];
    if (day && day.isClosed) {
      return { error: day.note
        ? `${department} is closed on ${dateStr}: ${day.note}`
        : `The ${department} office is closed on ${dateStr}. Please choose another date.` };
    }
  }

  return { ok: true, serviceDate: dateStr, isScheduled: days === 0 ? 0 : 1 };
}

/** Slots already taken on a date, so a day can be capped. */
async function slotsUsed(department, dateStr) {
  const r = await q(
    `SELECT COUNT(*) AS c FROM transactions
     WHERE department=? AND service_date=? AND overall_status <> 'cancelled'`,
    [department, dateStr]);
  return Number(r[0].c) || 0;
}

// ── CREATE A REQUEST ─────────────────────────────────────────────────────────
/**
 * Creates one ticket. Cashier tickets may carry several items (batch).
 * Documents that need no payment are routed straight to the Registrar.
 * submitToken makes repeated submits idempotent.
 */
async function createRequest(user, b, { walkIn = false } = {}) {
  const s = await getSettings();


  // ---- validate items -------------------------------------------------------
  let ids = b.documentIds;
  if (!Array.isArray(ids)) ids = ids ? [ids] : [];
  ids = ids.filter(Boolean).map(Number);
  if (!ids.length)                  return { error: 'Please select at least one requested document.' };
  if (ids.length > s.maxBatchDocuments) return { error: `You may request up to ${s.maxBatchDocuments} items at a time.` };
  if (new Set(ids).size !== ids.length) return { error: 'The same item was selected more than once.' };

  const copiesIn = Array.isArray(b.copies) ? b.copies : (b.copies ? [b.copies] : []);
  const items = [];
  for (let i = 0; i < ids.length; i++) {
    const sv = await getDocument(ids[i]);
    if (!sv || !sv.isActive) return { error: 'One of the selected documents is unavailable.' };
    if (user.role === 'guest' && !sv.guestAllowed)
      return { error: `"${sv.name}" is only available to enrolled students.` };

    let copies = parseInt(copiesIn[i], 10);
    if (isNaN(copies) || copies < 1) copies = 1;
    if (copies > s.maxCopies)
      return { error: `You may request up to ${s.maxCopies} copies of each document.` };

    items.push({ ...sv, copies, lineTotal: sv.price * copies });
  }

  // Payment-required and no-payment items can't share one ticket: they go to
  // different departments.
  const needPay = items.filter(i => i.paymentRequired);
  const freeOnly = items.filter(i => !i.paymentRequired);
  if (needPay.length && freeOnly.length)
    return { error: 'Paid items and no-payment items must be requested separately.' };

  // ---- purpose, only for documents that ask for one --------------------------
  const wantsPurpose = items.some(d => d.needsPurpose);
  let purpose = null, otherPurpose = null;
  if (wantsPurpose) {
    if (!PURPOSES.includes(b.purpose))
      return { error: 'Please select the purpose of your request.' };
    if (b.purpose === 'Others' && !String(b.otherPurpose || '').trim())
      return { error: 'Please specify your purpose.' };
    purpose = b.purpose;
    otherPurpose = b.purpose === 'Others' ? String(b.otherPurpose).trim() : null;
  }

  // ---- validate student info ------------------------------------------------
  if (!String(b.firstName || '').trim() || !String(b.lastName || '').trim())
    return { error: 'First name and last name are required.' };
  if (user.role === 'student' && (!b.course || !b.yearLevel))
    return { error: 'Course and year level are required.' };
  if (user.role === 'student' && !isCourse(b.course))
    return { error: 'Please choose one of the courses offered by the college.' };
  if (user.role === 'student' && !(+b.yearLevel >= 1 && +b.yearLevel <= 5))
    return { error: 'Please choose your year level.' };

  // ---- queue category -------------------------------------------------------
  // Priority can no longer be self-selected. It comes from the approved status
  // on the account, which an admin grants after reviewing uploaded proof.
  const approved = await q('SELECT priority_status, student_no FROM users WHERE id=?', [user.id]);
  const granted  = approved.length ? approved[0].priority_status : 'none';

  // The ticket carries the student number on the account (one per student),
  // never a number typed into the request form.
  const accountStudentNo = approved.length ? approved[0].student_no : null;
  if (user.role === 'student' && !STUDENT_NO_RE.test(accountStudentNo || ''))
    return { error: 'Add your 9-digit student number to your account before requesting a ticket.' };

  let category = 'regular';
  let pType    = 'none';

  if (walkIn) {
    // A walk-in asking for priority uploads proof with the request. The ticket
    // starts in the regular lane and moves up only when staff or the admin
    // approve the proof (decidePriorityRequest).
    if (b.queueCategory === 'priority' && !PRIORITY_TYPES.includes(b.priorityType))
      return { error: 'Choose which priority group you belong to (PWD, Senior Citizen or Pregnant).' };
    // approved before and still remembered: straight to the priority lane
    const known = b.queueCategory === 'priority' && user.role === 'student' ? await rememberedPriority(b) : null;
    if (known) { category = 'priority'; pType = known.type; }
  } else if (b.queueCategory === 'priority') {
    if (granted === 'none') {
      return { error: 'Your account is not approved for the priority lane. ' +
                      'Submit proof from your dashboard and wait for approval.' };
    }
    category = 'priority';
    pType    = granted;
  } else if (granted !== 'none') {
    // approved users always get the priority lane, even if the form was tampered with
    category = 'priority';
    pType    = granted;
  }

  // ---- who will claim it --------------------------------------------------
  const rep = { claimant: 'self', name: null, relationship: null, contact: null, authFile: null };
  if (b.claimant === 'representative') {
    if (!String(b.repName || '').trim())
      return { error: "Enter the representative's full name." };
    if (!String(b.repRelationship || '').trim())
      return { error: 'State how the representative is related to you.' };
    rep.claimant     = 'representative';
    rep.name         = String(b.repName).trim();
    rep.relationship = String(b.repRelationship).trim();
    rep.contact      = String(b.repContact || '').trim() || null;
    rep.authFile     = b.repAuthFile || null;
  }

  const department = needPay.length ? 'Cashier' : 'Registrar';

  // ---- schedule -------------------------------------------------------------
  // The office is needed first, because a single date can be closed for one
  // office while the other still takes bookings.
  const sched = await validateSchedule(b.mode, b.scheduledDate, department);
  if (sched.error) return { error: sched.error };

  // one unfinished ticket per office per day, and at most MAX_OPEN_PER_OFFICE
  // in all (a claim booked for next week does not block today)
  const open = await getBlockingTransaction(user.id, department, sched.serviceDate);
  if (open) {
    return {
      error: `You already have a ${department} ticket for ${open.serviceDate === today() ? 'today' : longDate(open.serviceDate)} (${open.ticketNo}). ` +
             'Finish it before requesting another number for this office on that day.',
      blockedBy: open,
    };
  }
  const [[openCount]] = await pool.query(
    `SELECT COUNT(*) AS n FROM transactions WHERE user_id=? AND department=? AND overall_status NOT IN ('completed','cancelled')`,
    [user.id, department]);
  if (Number(openCount.n) >= MAX_OPEN_PER_OFFICE)
    return { error: `You already have ${openCount.n} open ${department} tickets. Finish or cancel one before requesting another.` };

  // ---- claiming a released document ------------------------------------------
  // Only documents already paid at the Cashier can be claimed, and each paid
  // document only once. The student ticks which ones this ticket collects.
  let claimLineIds = [], notReady = [];
  if (items.some(isClaimDocument)) {
    let ticked = b.claimLines;
    if (!Array.isArray(ticked)) ticked = ticked ? [ticked] : [];
    ticked = [...new Set(ticked.map(Number).filter(Boolean))];
    const available = user.role === 'guest'
      ? await guestClaimableLines(ticked, b.lastName)
      : await getClaimableLines(user.id);
    if (!available.length && user.role === 'guest')
      return { error: 'Find what you paid for with the booking code of your Cashier ticket, then tick what to collect.' };
    if (!available.length) {
      const cashierOpen = await getBlockingTransaction(user.id, 'Cashier');
      return { error: cashierOpen && cashierOpen.paymentStatus !== 'paid'
        ? `Finish your payment at the Cashier first (${cashierOpen.ticketNo}). ` +
          'You can queue at the Registrar to claim it right after.'
        : 'You have no paid documents waiting to be claimed. Pay for the document at the Cashier first.' };
    }
    let picked = b.claimLines;
    if (!Array.isArray(picked)) picked = picked ? [picked] : [];
    // Walk-ins do not see a list to tick: they collect everything paid for
    // under their student number (staff check the ID before releasing).
    if (walkIn && !picked.length) picked = available.map(a => a.id);
    picked = [...new Set(picked.map(Number).filter(Boolean))];
    if (!picked.length) return { error: 'Tick which paid document(s) you are claiming.' };
    const ok = new Set(available.map(a => a.id));
    if (picked.some(id => !ok.has(id)))
      return { error: 'One of the documents you ticked is not paid for, or is already being claimed.' };
    claimLineIds = picked;
    // Processed documents (the OTR: 14 days) may be claimed early, but the
    // student is warned that it may not be ready yet; staff decide.
    notReady = available.filter(a => picked.includes(a.id) && a.readyOn && a.readyOn > sched.serviceDate)
      .map(a => ({ name: a.name, readyOn: a.readyOn, readyText: shortDate(a.readyOn) }));
  }

  const amount     = items.reduce((t, i) => t + i.lineTotal, 0);
  const rawToken = String(b.submitToken || '').trim();
  const token = /^[A-Za-z0-9_-]{8,36}$/.test(rawToken) ? rawToken : crypto.randomUUID();

  const dayOv = (await getDayOverrides(department, sched.serviceDate, sched.serviceDate))[sched.serviceDate];
  const dayCap = dayOv && dayOv.slotLimit != null ? dayOv.slotLimit : s.dailySlotLimit;
  if (dayCap > 0) {
    const used = await slotsUsed(department, sched.serviceDate);
    if (used >= dayCap) {
      return { error: `The ${department} office is fully booked on ${sched.serviceDate}. ` +
                      'Please choose another date.' };
    }
  }

  // Predict the service time now and store it, so accuracy can be measured later.
  let forecast = { wait: null, service: null, source: null };
  try {
    const svc = await predict.estimateService(items, department, s);
    forecast = { wait: null, service: svc.minutes, source: svc.source };
    // a claim takes longer the more documents it releases: the first one at
    // full time (ID check, records), each extra one at CLAIM_EXTRA_SHARE of it
    if (claimLineIds.length > 1 && forecast.service)
      forecast.service = Math.round(forecast.service * (1 + CLAIM_EXTRA_SHARE * (claimLineIds.length - 1)) * 10) / 10;
  } catch (e) { /* a forecast must never block a ticket */ }

  // ---- place in line: first come, first served (data/engine.js) -------------
  // "Join now" counts from this moment, even from a classroom. A booking counts
  // from its 30-minute slot's start, and only if the slot still has room for
  // these documents.
  let queueAt = new Date(), slot = null, decision = null;
  if (b.mode === 'schedule') {
    const plan = await engine.slotPlan(department, sched.serviceDate, forecast.service, s);
    slot = plan.slots.find(x => x.start === b.slot);
    if (!slot) return { error: 'Please choose a time for your visit.' };
    if (!slot.available) return { error: `The ${slot.label} slot is full. Please choose another time.` };
    queueAt = new Date(`${sched.serviceDate}T${slot.start}:00`);
  } else {
    // The capacity decision: does this person fit before closing, even if the
    // windows run slow? Either way they get the number; a tight day is warned.
    try {
      decision = await engine.evaluateJoin(department, { lane: category, service: forecast.service });
      forecast.wait = decision.minutes;
    } catch (e) { /* the decision must never block a ticket */ }
  }

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();

    // duplicate-submit guard
    const [dupe] = await conn.execute('SELECT id FROM transactions WHERE submit_token=?', [token]);
    if (dupe.length) {
      await conn.rollback();
      return await getTransaction(dupe[0].id);      // same ticket, not a new one
    }

    const ticketNo = await nextTicketNo(conn, department, sched.serviceDate, category);

    const [ins] = await conn.execute(
      `INSERT INTO transactions
        (ticket_no,department,queue_category,priority_type,user_id,client_type,
         first_name,middle_name,last_name,student_no,course,year_level,academic_year,
         claimant,rep_name,rep_relationship,rep_contact,rep_auth_file,
         purpose,other_purpose,amount_due,ticket_status,payment_status,overall_status,
         is_scheduled,scheduled_date,service_date,submit_token,requires_claim,
         predicted_wait,predicted_service,prediction_source,
         access_token,booking_code,queue_at,slot_start,slot_end)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'waiting',?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [ ticketNo, department, category, pType, user.id,
        user.role === 'guest' ? 'guest' : 'student',
        String(b.firstName).trim(), String(b.middleName || '').trim() || null,
        String(b.lastName).trim(), user.role === 'student' ? accountStudentNo : null,
        b.course || null, b.yearLevel ? +b.yearLevel : null,
        b.academicYear || s.academicYear,
        rep.claimant, rep.name, rep.relationship, rep.contact, rep.authFile,
        purpose, otherPurpose,
        amount,
        department === 'Cashier' ? 'pending' : 'not_required',
        department === 'Cashier' ? 'pending' : 'waiting_registrar',
        sched.isScheduled, sched.isScheduled ? sched.serviceDate : null,
        sched.serviceDate, token, items.some(i => i.requiresClaim) ? 1 : 0,
        forecast.wait, forecast.service, forecast.source,
        crypto.randomBytes(16).toString('hex'), bookingCode(),
        queueAt, slot ? slot.start : null, slot ? slot.end : null ]
    );
    const txId = ins.insertId;

    for (const it of items) {
      await conn.execute(
        `INSERT INTO transaction_documents (transaction_id,document_id,document_name,unit_price,copies,price)
         VALUES (?,?,?,?,?,?)`,
        [txId, it.id, it.name, it.price, it.copies, it.lineTotal]);
    }
    for (const lineId of claimLineIds) {
      await conn.execute('INSERT INTO claim_items (claim_tx_id,line_id) VALUES (?,?)', [txId, lineId]);
    }

    // Requirements (ID, request form, clearance...) are checked by the
    // Registrar, never the Cashier: a Registrar ticket gets the requirements of
    // its own documents and of the paid documents it is claiming (e.g. the OTR).
    if (department === 'Registrar') {
      const docIds = new Set(items.filter(i => i.needsRequirements).map(i => i.id));
      if (claimLineIds.length) {
        const [claimed] = await conn.query(
          `SELECT DISTINCT td.document_id FROM transaction_documents td
           JOIN documents d ON d.id = td.document_id
           WHERE td.id IN (?) AND d.needs_requirements = 1`, [claimLineIds]);
        claimed.forEach(c => docIds.add(c.document_id));
      }
      const seen = new Set();
      for (const docId of docIds) {
        const [reqs] = await conn.execute(
          `SELECT id,label,is_required FROM document_requirements
           WHERE document_id=? ORDER BY sort_order, id`, [docId]);
        for (const rq of reqs) {
          if (seen.has(rq.id)) continue;
          seen.add(rq.id);
          await conn.execute(
            `INSERT INTO transaction_requirements (transaction_id,requirement_id,label,is_required)
             VALUES (?,?,?,?)`, [txId, rq.id, rq.label, rq.is_required]);
        }
      }
    }
    await conn.execute(
      `INSERT INTO queue_history (transaction_id,ticket_no,action,department,note)
       VALUES (?,?,?,?,?)`,
      [txId, ticketNo, sched.isScheduled ? 'scheduled' : 'requested', department,
       slot ? `Booked ${sched.serviceDate}, ${slot.label}` : null]);

    await conn.commit();

    // why the system took this ticket, with its numbers (decision log)
    if (slot) {
      await engine.logDecision(txId, department, 'booked',
        `${ticketNo}: slot ${slot.label} on ${sched.serviceDate} had room for ${forecast.service} min of work.`,
        { slot: slot.label, placesLeftBefore: slot.placesLeft, serviceMin: forecast.service });
    } else if (decision) {
      await engine.logDecision(txId, department, decision.decision, `${ticketNo}: ${decision.reason}`, decision);
    }
    const created = await getTransaction(txId);
    created.decision = decision;
    created.notReady = notReady;
    return created;
  } catch (e) {
    await conn.rollback();
    if (e.code === 'ER_DUP_ENTRY') {
      const dup = await q('SELECT id FROM transactions WHERE submit_token=?', [token]);
      if (dup.length) return await getTransaction(dup[0].id);
    }
    throw e;
  } finally {
    conn.release();
  }
}

/**
 * A student may hold ONE unfinished transaction PER OFFICE — so a Cashier
 * ticket and a Registrar ticket at the same time, but never two of either.
 *
 * Unfinished means anything that is not completed or cancelled, including a
 * ticket scheduled for tomorrow and a payment that is waiting to be claimed.
 *
 * Tickets the SYSTEM creates are not affected: the Registrar ticket generated
 * after a cashier payment, and the claim ticket, are made directly rather than
 * through createRequest, so a student is never locked out of finishing what
 * they already started and paid for.
 */
async function getBlockingTransaction(userId, department = null, serviceDate = null) {
  // With a date: only a ticket for that same day blocks (or one already at a
  // window), so a claim booked for next week never stops a visit today.
  const rows = await q(
    `SELECT * FROM transactions
     WHERE user_id = ? AND overall_status NOT IN ('completed','cancelled')
       ${department ? 'AND department = ?' : ''}
       ${serviceDate ? "AND (service_date = ? OR ticket_status IN ('called','serving'))" : ''}
     ORDER BY requested_at ASC LIMIT 1`,
    [userId, ...(department ? [department] : []), ...(serviceDate ? [serviceDate] : [])]);
  if (!rows.length) return null;
  const t = mapTx(rows[0]);
  await attachDocuments([t]);
  return t;
}

// ── WALK-IN (QR) CLIENTS: no registration, no login ──────────────────────────
// Students scan the QR code and give their name and student number. Behind the
// scenes each student number still has one record in `users` (no email, no
// password, cannot log in), so claims, one-ticket-per-office, Queue History and
// reports keep working exactly as before. Visitors get a record per ticket.

/** "Dela Cruz" == "dela cruz" == "Dela  Cruz" == "Déla Cruz" */
const normName = s => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '')
  .toLowerCase().replace(/[^a-z]/g, '');
const cleanName = s => String(s || '').replace(/\s+/g, ' ').trim();

/**
 * A student approved earlier skips the photo: the same student number and last
 * name, the same priority type, approved within PRIORITY_REMEMBER_DAYS, and
 * coming to the window themselves. Staff still check the real ID there.
 */
async function rememberedPriority(b) {
  if (b.clientType === 'guest' || b.claimant === 'representative') return null;
  if (!PRIORITY_TYPES.includes(b.priorityType)) return null;
  const no = String(b.studentNo || '').trim();
  if (!STUDENT_NO_RE.test(no)) return null;
  const u = (await q(
    `SELECT last_name, priority_status, priority_approved_at FROM users
     WHERE student_no=? AND role='student' AND deleted_at IS NULL LIMIT 1`, [no]))[0];
  if (!u || u.priority_status !== b.priorityType || !u.priority_approved_at) return null;
  if (normName(u.last_name) !== normName(b.lastName)) return null;
  const until = new Date(new Date(u.priority_approved_at).getTime() + PRIORITY_REMEMBER_DAYS[b.priorityType] * 86400000);
  return until > new Date() ? { type: b.priorityType, approvedAt: u.priority_approved_at, until } : null;
}
async function noteRememberedPriority(t, type) {
  await run(
    `INSERT INTO queue_history (transaction_id,ticket_no,action,department,note) VALUES (?,?,'moved_to_priority',?,?)`,
    [t.id, t.ticketNo, t.department, `${PRIORITY_LABELS[type]} approved earlier for this student number; no new proof needed`]);
}

async function findOrCreateWalkIn(b) {
  const first = cleanName(b.firstName), middle = cleanName(b.middleName), last = cleanName(b.lastName);
  if (!first || !last) return { error: 'Enter your first name and last name.' };
  if ([first, middle, last].some(n => n.length > 60)) return { error: 'Each name can be up to 60 characters.' };

  if (b.clientType === 'guest') {
    const r = await run(
      `INSERT INTO users (first_name,middle_name,last_name,role,status) VALUES (?,?,?,'guest','active')`,
      [first, middle || null, last]);
    return { user: await getUser(r.insertId) };
  }

  const no = String(b.studentNo || '').trim();
  if (!STUDENT_NO_RE.test(no)) return { error: 'Enter your 9-digit student number (numbers only).' };
  // latest course and year, kept on the record for the admin's Students page
  const course = isCourse(b.course) ? b.course : null;
  const year   = +b.yearLevel >= 1 && +b.yearLevel <= 5 ? +b.yearLevel : null;
  // checked before a record is made, so a rejected form leaves nothing behind
  if (!course || !year) return { error: 'Course and year level are required.' };

  const existing = async () => (await q('SELECT * FROM users WHERE student_no=? LIMIT 1', [no]))[0];
  let u = await existing();
  if (!u) {
    try {
      const r = await run(
        `INSERT INTO users (first_name,middle_name,last_name,role,status,student_no,course,year_level)
         VALUES (?,?,?,'student','active',?,?,?)`, [first, middle || null, last, no, course, year]);
      return { user: await getUser(r.insertId) };
    } catch (e) {
      if (e.code !== 'ER_DUP_ENTRY') throw e;
      u = await existing();                 // two phones, same number, same instant
    }
  }
  if (u.role !== 'student') return { error: 'That student number cannot be used here. Please ask the Registrar.' };
  if (u.status === 'disabled') return { error: 'This student number is blocked. Please see the Registrar.' };
  // Someone typing another student's number would otherwise see and claim
  // that student's paid documents, so the last name must match the record.
  if (normName(u.last_name) !== normName(last))
    return { error: 'That student number is on record under a different last name. ' +
                    'Check what you typed, or ask the Registrar to correct the record.' };
  if (course && year && (u.course !== course || Number(u.year_level) !== year)) {
    await run('UPDATE users SET course=?, year_level=? WHERE id=?', [course, year, u.id]);
    return { user: await getUser(u.id) };
  }
  return { user: mapUser(u) };
}

/** Short code to find a ticket again on another phone (no 0/O or 1/I). */
function bookingCode() {
  const A = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let s = '';
  for (let i = 0; i < 6; i++) s += A[crypto.randomInt(A.length)];
  return s;
}

/** The ticket behind a phone's secret link, or null. */
/** A visitor's open ticket at an office, matched by name (one per office). */
async function findActiveGuestTicket(firstName, lastName, department) {
  const rows = await q(
    `SELECT * FROM transactions
     WHERE client_type='guest' AND department=? AND overall_status NOT IN ('completed','cancelled')
       AND service_date >= CURDATE()`, [department]);
  const hit = rows.find(r => normName(r.first_name) === normName(firstName) && normName(r.last_name) === normName(lastName));
  return hit ? mapTx(hit) : null;
}

async function getTransactionByToken(token) {
  if (!/^[a-f0-9]{32}$/.test(String(token || ''))) return null;
  const r = await q(`${TX_SELECT} WHERE t.access_token=?`, [token]);
  if (!r.length) return null;
  const t = mapTx(r[0]);
  await attachDocuments([t]);
  return t;
}

/**
 * Find a ticket by booking code plus the student number (or, for visitors,
 * the last name). Only tickets from the last 60 days are searched.
 */
async function findTicketByCode(code, who) {
  code = String(code || '').trim().toUpperCase();
  who  = String(who || '').trim();
  if (!/^[A-Z0-9]{6}$/.test(code) || !who) return null;
  const rows = await q(
    `SELECT id, student_no, last_name, access_token FROM transactions
     WHERE booking_code=? AND service_date >= DATE_SUB(CURDATE(), INTERVAL 60 DAY)
     ORDER BY id DESC`, [code]);
  const hit = rows.find(r => (r.student_no && r.student_no === who) ||
                             (!r.student_no && normName(r.last_name) === normName(who)));
  return hit && hit.access_token ? hit.access_token : null;
}

/**
 * A priority client whose ID at the window does not match the approved proof
 * goes to the END of the regular line with a new regular number. One click
 * for staff at the window.
 */
async function moveToRegular(staff, txId) {
  const t = await getTransaction(txId);
  const dept = staff.role === 'cashier' ? 'Cashier' : 'Registrar';
  if (!t || t.department !== dept)              return { error: 'Ticket not found.' };
  if (t.queueCategory !== 'priority')           return { error: `${t.ticketNo} is already in the regular lane.` };
  if (!['waiting','called','serving'].includes(t.ticketStatus))
    return { error: `${t.ticketNo} is no longer in the queue.` };
  if (t.paymentStatus === 'paid')               return { error: `${t.ticketNo} is already paid.` };

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const newNo = await nextTicketNo(conn, dept, t.serviceDate, 'regular');
    await conn.execute(
      `UPDATE transactions SET ticket_no=?, queue_category='regular', priority_type='none',
         ticket_status='waiting', staff_id=NULL, staff_name=NULL, window_id=NULL, window_label=NULL,
         called_at=NULL, started_at=NULL, warned_at=NULL, queue_at=NOW(),
         overall_status=CASE WHEN department='Cashier' THEN 'pending' ELSE 'waiting_registrar' END
       WHERE id=?`, [newNo, t.id]);
    await conn.execute(
      `INSERT INTO queue_history (transaction_id,ticket_no,action,staff_id,staff_name,department,note)
       VALUES (?,?,'moved_to_regular',?,?,?,?)`,
      [t.id, newNo, staff.id, staff.fullName, dept,
       `Priority (${PRIORITY_LABELS[t.priorityType] || t.priorityType}) not verified; ${t.ticketNo} became ${newNo}`]);
    await conn.commit();
    return { ok: true, from: t.ticketNo, to: newNo };
  } catch (e) {
    await conn.rollback();
    throw e;
  } finally {
    conn.release();
  }
}

// ── READ TRANSACTIONS ────────────────────────────────────────────────────────
function mapTx(t) {
  return {
    id: t.id, ticketNo: t.ticket_no, department: t.department,
    queueCategory: t.queue_category, priorityType: t.priority_type,
    userId: t.user_id, clientType: t.client_type,
    accessToken: t.access_token || null, bookingCode: t.booking_code || null,
    // place in line: when they joined, or their booked slot's start
    queueAt: t.queue_at || t.requested_at,
    slotStart: t.slot_start ? String(t.slot_start).slice(0, 5) : null,
    slotEnd:   t.slot_end   ? String(t.slot_end).slice(0, 5)   : null,
    slotLabel: t.slot_start ? `${clock12(String(t.slot_start).slice(0, 5))} – ${clock12(String(t.slot_end).slice(0, 5))}` : '',
    riskAt: t.risk_at || null,
    holdUntil: t.hold_until || null, holdUsed: !!t.hold_used, missedCount: Number(t.missed_count) || 0,
    alertsSent: t.alerts_sent || '',
    firstName: t.first_name, middleName: t.middle_name || '', lastName: t.last_name,
    fullName: fullName(t),
    name: `${t.first_name} ${t.last_name}`,
    studentNo: t.student_no || '', course: t.course || '', yearLevel: t.year_level,
    academicYear: t.academic_year || '',
    claimant: t.claimant || 'self',
    repName: t.rep_name || '', repRelationship: t.rep_relationship || '',
    repContact: t.rep_contact || '', repAuthFile: t.rep_auth_file || null,
    purpose: t.purpose, otherPurpose: t.other_purpose || '',
    // blank for documents that do not ask for a purpose
    purposeText: !t.purpose ? ''
      : (t.purpose === 'Others' ? (t.other_purpose || 'Others') : t.purpose),
    amountDue: Number(t.amount_due),
    ticketStatus: t.ticket_status, paymentStatus: t.payment_status,
    overallStatus: t.overall_status,
    isScheduled: !!t.is_scheduled,
    scheduledDate: t.scheduled_date ? ymd(new Date(t.scheduled_date)) : null,
    serviceDate: t.service_date ? ymd(new Date(t.service_date)) : null,
    staffId: t.staff_id, staffName: t.staff_name || '',
    windowId: t.window_id, windowLabel: t.window_label || '',
    requestedAt: t.requested_at, calledAt: t.called_at,
    startedAt: t.started_at, completedAt: t.completed_at,
    warnedAt: t.warned_at, actualMinutes: t.actual_minutes,
    predictedWait: t.predicted_wait, predictedService: t.predicted_service,
    predictionSource: t.prediction_source || null,
    cancelReason: t.cancel_reason || '',
    items: t.items || [],
    requiresClaim: t.requires_claim != null ? !!t.requires_claim : null,
    receiptNo: t.receipt_no || null,
    paidAmount: Number(t.amount_due),
    timeIn: t.requested_at ? `${pad(new Date(t.requested_at).getHours())}:${pad(new Date(t.requested_at).getMinutes())}` : '',
    // For people: the day to come (a booking is for the whole day, not a time
    // slot) and, separately, when the request was made.
    visitDateText: t.service_date ? visitDateText(ymd(new Date(t.service_date))) : '',
    requestedOnText: t.requested_at ? new Date(t.requested_at).toLocaleString('en-PH', {
      month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit', hour12: true }) : '',
  };
}

function visitDateText(dateStr) {
  if (dateStr === today()) return 'Today';
  if (dateStr === addDays(today(), 1)) return 'Tomorrow, ' + longDate(dateStr);
  return longDate(dateStr);
}
function longDate(dateStr) {
  return new Date(dateStr + 'T00:00:00').toLocaleDateString('en-PH',
    { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' });
}
/** True once today's closing time (Philippine time) has passed. */
/**
 * The same-day line opens 1 hour before office hours (7:00 AM for an 8:00 AM
 * opening), so nobody takes the first numbers in the middle of the night.
 * Booking a time is open at any hour.
 */
const JOIN_OPENS_BEFORE_MIN = 60;
function joinOpensAt(s) {
  const [h, m] = String(s.openTime || '08:00').split(':').map(Number);
  const t = Math.max(0, h * 60 + (m || 0) - JOIN_OPENS_BEFORE_MIN);
  return `${pad(Math.floor(t / 60))}:${pad(t % 60)}`;
}
function isBeforeJoinOpens(s) {
  const [h, m] = joinOpensAt(s).split(':').map(Number);
  const now = new Date();
  return now.getHours() * 60 + now.getMinutes() < h * 60 + m;
}

function isPastClosing(s) {
  const [h, m] = String(s.closeTime || '17:00').split(':').map(Number);
  const now = new Date();
  return now.getHours() * 60 + now.getMinutes() >= h * 60 + (m || 0);
}

/** True during the office break (Settings, e.g. 12:00-13:00). No break when start >= end. */
function isBreakTime(s) {
  const toMin = t => { const [h, m] = String(t || '').split(':').map(Number); return isNaN(h) ? null : h * 60 + (m || 0); };
  const a = toMin(s.breakStart), b = toMin(s.breakEnd);
  if (a == null || b == null || a >= b) return false;
  const now = new Date(), n = now.getHours() * 60 + now.getMinutes();
  return n >= a && n < b;
}

/** '08:00' -> '8:00 AM' */
function clock12(hhmmStr) {
  const [h, m] = String(hhmmStr || '').split(':').map(Number);
  if (isNaN(h)) return '';
  return `${h % 12 || 12}:${pad(m || 0)} ${h < 12 ? 'AM' : 'PM'}`;
}

const TX_SELECT = `
  SELECT t.*, r.receipt_no
  FROM transactions t
  LEFT JOIN receipts r ON r.transaction_id = t.id`;

async function attachDocuments(list) {
  if (!list.length) return list;
  const ids = list.map(t => t.id);
  const rows = await q(
    `SELECT transaction_id, document_name, unit_price, copies, price FROM transaction_documents
     WHERE transaction_id IN (${ids.map(() => '?').join(',')})`, ids);
  const by = {};
  rows.forEach(r => {
    (by[r.transaction_id] = by[r.transaction_id] || []).push({
      name: r.document_name,
      unitPrice: Number(r.unit_price),
      copies: Number(r.copies) || 1,
      price: Number(r.price),
      label: (Number(r.copies) || 1) > 1
        ? `${r.document_name} x${r.copies}` : r.document_name,
    });
  });
  list.forEach(t => { t.documents = by[t.id] || []; t.items = t.documents; });

  // Registrar claim tickets: which paid documents they collect. The claim
  // line's label names them, so every screen that lists documents shows it.
  const claims = await q(
    `SELECT ci.claim_tx_id, td.document_name, td.copies, pt.ticket_no AS paid_ticket, r.receipt_no,
            d.processing_days, p.paid_at
     FROM claim_items ci
     JOIN transaction_documents td ON td.id = ci.line_id
     JOIN transactions pt ON pt.id = td.transaction_id
     LEFT JOIN documents d ON d.id = td.document_id
     LEFT JOIN payments p ON p.transaction_id = pt.id AND p.status = 'paid'
     LEFT JOIN receipts r ON r.transaction_id = pt.id
     WHERE ci.claim_tx_id IN (${ids.map(() => '?').join(',')})
     ORDER BY ci.id`, ids);
  const cl = {};
  for (const c of claims) {
    const days = Number(c.processing_days) || 0;
    const readyOn = days && c.paid_at ? await releaseDate(ymd(new Date(c.paid_at)), days) : null;
    (cl[c.claim_tx_id] = cl[c.claim_tx_id] || []).push({
      name: c.document_name, copies: Number(c.copies) || 1,
      paidTicket: c.paid_ticket, receiptNo: c.receipt_no || '',
      readyOn, readyText: readyOn ? shortDate(readyOn) : null, early: !!(readyOn && readyOn > today()),
    });
  }
  list.forEach(t => {
    t.claimItems = cl[t.id] || [];
    if (!t.claimItems.length) return;
    const what = t.claimItems.map(c => c.copies > 1 ? `${c.name} x${c.copies}` : c.name).join(', ');
    t.documents.forEach(d => { d.label = `${d.name}: ${what}`; });
  });
  return list;
}

/**
 * Paid Cashier document lines this user can still claim at the Registrar:
 * the document is one you pick up, the Cashier recorded the payment, and no
 * claim ticket that is still valid (waiting, serving or completed) covers it.
 */
async function getClaimableLines(userId, { txIds = null } = {}) {
  // by person (students: one record per student number), or by the paid
  // Cashier ticket(s) themselves (visitors get a new record per ticket)
  // (prepared statements: one placeholder per id)
  const ids = txIds ? (txIds.length ? txIds : [0]) : null;
  const who = ids ? `t.id IN (${ids.map(() => '?').join(',')})` : 't.user_id = ?';
  const rows = await q(
    `SELECT td.id, td.document_name, td.copies, t.ticket_no, r.receipt_no, p.paid_at, d.processing_days
     FROM transaction_documents td
     JOIN transactions t ON t.id = td.transaction_id
     JOIN documents d    ON d.id = td.document_id
     LEFT JOIN payments p ON p.transaction_id = t.id AND p.status = 'paid'
     LEFT JOIN receipts r ON r.transaction_id = t.id
     WHERE ${who} AND t.department = 'Cashier' AND t.payment_status = 'paid'
       AND d.requires_claim = 1
       AND NOT EXISTS (
         SELECT 1 FROM claim_items ci JOIN transactions c ON c.id = ci.claim_tx_id
         WHERE ci.line_id = td.id AND c.ticket_status NOT IN ('cancelled','no-show'))
     ORDER BY p.paid_at DESC, td.id`, ids ? ids : [userId]);
  const out = [];
  for (const r of rows) {
    const paidAt = r.paid_at ? ymd(new Date(r.paid_at)) : null;
    const days = Number(r.processing_days) || 0;
    out.push({
      id: r.id, name: r.document_name, copies: Number(r.copies) || 1,
      paidTicket: r.ticket_no, receiptNo: r.receipt_no || '', paidAt,
      processingDays: days, readyOn: paidAt && days ? await releaseDate(paidAt, days) : paidAt,
    });
  }
  return out;
}

/**
 * When a paid document can be released: the payment date plus its processing
 * days (calendar days, e.g. the OTR's 14), moved to the next day the Registrar
 * is open if it lands on a closed day.
 */
async function releaseDate(paidYmd, days) {
  const s = await getSettings();
  let d = addDays(paidYmd, days);
  const ov = await getDayOverrides('Registrar', d, addDays(d, 30));
  for (let i = 0; i < 30; i++) {
    const dow = new Date(d + 'T00:00:00').getDay() || 7;
    if (s.openDays.includes(dow) && !(ov[d] && ov[d].isClosed)) break;
    d = addDays(d, 1);
  }
  return d;
}

/** "Thu, Oct 22" */
const shortDate = ymdStr => new Date(ymdStr + 'T00:00:00')
  .toLocaleDateString('en-PH', { weekday: 'short', month: 'short', day: 'numeric' });

/**
 * For a paid Cashier ticket: each document that takes days to process, with
 * its release date and whether it is ready (shown on the ticket and receipt).
 */
async function getReleaseInfo(txId) {
  const rows = await q(
    `SELECT td.id, td.document_name, d.processing_days, p.paid_at
     FROM transaction_documents td
     JOIN transactions t ON t.id = td.transaction_id
     JOIN documents d ON d.id = td.document_id
     LEFT JOIN payments p ON p.transaction_id = t.id AND p.status = 'paid'
     WHERE td.transaction_id = ? AND d.processing_days > 0 AND d.requires_claim = 1`, [txId]);
  const out = [];
  for (const r of rows) {
    const days = Number(r.processing_days);
    if (!r.paid_at) { out.push({ lineId: r.id, name: r.document_name, days, readyOn: null, ready: false }); continue; }
    const readyOn = await releaseDate(ymd(new Date(r.paid_at)), days);
    const left = Math.round((new Date(readyOn + 'T00:00:00') - new Date(today() + 'T00:00:00')) / 86400000);
    out.push({ lineId: r.id, name: r.document_name, days, readyOn, readyText: shortDate(readyOn),
               daysLeft: Math.max(0, left), ready: left <= 0, claim: await claimFor(r.id) });
  }
  return out;
}

/** The claim ticket that covers a paid line (waiting, at a window or done), if any. */
async function claimFor(lineId) {
  const c = await q(
    `SELECT c.id, c.ticket_no, c.access_token, c.service_date, c.slot_start, c.slot_end, c.ticket_status
     FROM claim_items ci JOIN transactions c ON c.id = ci.claim_tx_id
     WHERE ci.line_id = ? AND c.ticket_status NOT IN ('cancelled','no-show')
     ORDER BY c.id DESC LIMIT 1`, [lineId]);
  if (!c.length) return null;
  const x = c[0], date = ymd(new Date(x.service_date));
  return { id: x.id, ticketNo: x.ticket_no, accessToken: x.access_token, status: x.ticket_status,
           date, dateText: shortDate(date), done: x.ticket_status === 'completed',
           slotLabel: x.slot_start ? `${clock12(String(x.slot_start).slice(0, 5))} – ${clock12(String(x.slot_end).slice(0, 5))}` : '' };
}

/**
 * "Book my claim": reserve the earliest free 30-minute Registrar slot on or
 * after the release date, for the paid documents of this Cashier ticket.
 * The student does not pick a date, so nobody comes before it is ready.
 */
async function bookClaim(cashierTx) {
  const lines = (await getReleaseInfo(cashierTx.id)).filter(l => l.readyOn && !l.claim);
  if (!lines.length) return { error: 'There is nothing left to book a claim for on this ticket.' };
  const doc = (await getDocuments({ office: 'Registrar' })).find(d => d.requiresClaim && /claim/i.test(d.name))
           || (await getDocuments({ office: 'Registrar' })).find(d => d.requiresClaim);
  if (!doc) return { error: 'Claiming is not set up at the Registrar yet. Please ask at the office.' };
  const user = await getUser(cashierTx.userId);
  if (!user) return { error: 'Your student record was not found. Please ask at the Registrar.' };

  const s = await getSettings();
  const from = lines.map(l => l.readyOn).sort().pop();          // every line must be ready
  // Already booked a claim on or after that date? Release this one with it.
  const booked = await q(
    `SELECT id, ticket_no, access_token, service_date, slot_start, slot_end FROM transactions
     WHERE user_id=? AND department='Registrar' AND ticket_status='waiting' AND requires_claim=1
       AND service_date >= ? AND id IN (SELECT claim_tx_id FROM claim_items)
     ORDER BY service_date, slot_start LIMIT 1`, [cashierTx.userId, from]);
  if (booked.length) {
    const c = booked[0], date = ymd(new Date(c.service_date));
    for (const l of lines) await run('INSERT INTO claim_items (claim_tx_id, line_id) VALUES (?,?)', [c.id, l.lineId]);
    const slotLabel = c.slot_start ? `${clock12(String(c.slot_start).slice(0, 5))} – ${clock12(String(c.slot_end).slice(0, 5))}` : '';
    await engine.logDecision(c.id, 'Registrar', 'claim_booked',
      `${c.ticket_no}: ${lines.map(l => l.name).join(', ')} (${cashierTx.ticketNo}) added to the claim already booked for ${shortDate(date)}, ` +
      `ready by then (${shortDate(from)}), so one visit releases both.`, { joined: cashierTx.ticketNo, date });
    return { ok: true, joined: true, ticket: await getTransaction(c.id), dateText: shortDate(date), slotLabel };
  }
  const svc = (await predict.estimateService([doc], 'Registrar', s)).minutes;
  const last = addDays(today(), s.scheduleMaxDays);
  if (from > last) return { error: `Booking opens on ${shortDate(addDays(from, -s.scheduleMaxDays))}.` };
  for (let d = from < today() ? today() : from; d <= last; d = addDays(d, 1)) {
    const ok = await validateSchedule('schedule', d, 'Registrar');
    if (ok.error) continue;                                      // closed day: try the next
    const plan = await engine.slotPlan('Registrar', d, svc, s);
    const slot = plan.slots.find(x => x.available);
    if (!slot) continue;
    const r = await createRequest(user, {
      documentIds: [String(doc.id)], claimLines: lines.map(l => l.lineId),
      firstName: cashierTx.firstName, middleName: cashierTx.middleName, lastName: cashierTx.lastName,
      course: cashierTx.course || user.course, yearLevel: cashierTx.yearLevel || user.yearLevel,
      mode: 'schedule', scheduledDate: d, slot: slot.start, queueCategory: 'regular',
    }, { walkIn: true });
    if (r.error) return r;
    await engine.logDecision(r.id, 'Registrar', 'claim_booked',
      `${r.ticketNo}: claim booked for ${shortDate(d)}, ${slot.label}, the earliest free slot on or after the release date (${shortDate(from)}).`,
      { releaseDate: from, date: d, slot: slot.label });
    return { ok: true, ticket: r, dateText: shortDate(d), slotLabel: slot.label };
  }
  return { error: 'No free time was found in the next weeks. Please ask at the Registrar.' };
}

/** Each extra document on one claim adds this share of the claim's base time. */
const CLAIM_EXTRA_SHARE = 0.6;

/** A student may hold this many unfinished tickets per office (one per day). */
const MAX_OPEN_PER_OFFICE = 2;

/** Planning figures: share of students expected to come for a ready document
    on its release day, and on each later day while it is still uncollected
    (up to a week; after that it is not counted in the forecast). */
const CLAIM_SHOW_RATE = 0.6, CLAIM_LATE_RATE = 0.15, CLAIM_LATE_DAYS = 7;

/**
 * Processed documents (the OTR) that are paid and not yet collected, with
 * their release date and any booked claim: the Registrar's "Due for release"
 * list, oldest payment first (first come, first served).
 */
async function releasesDue(daysAhead = 7, daysBack = 14) {
  const rows = await q(
    `SELECT td.id AS line_id, td.document_name, td.copies, d.processing_days, p.paid_at,
            t.id AS tx_id, t.ticket_no, t.first_name, t.middle_name, t.last_name, t.student_no
     FROM transaction_documents td
     JOIN transactions t ON t.id = td.transaction_id
     JOIN documents d ON d.id = td.document_id
     JOIN payments p ON p.transaction_id = t.id AND p.status = 'paid'
     WHERE d.processing_days > 0 AND d.requires_claim = 1
       AND t.department = 'Cashier' AND t.payment_status = 'paid'
       AND DATE(p.paid_at) >= CURDATE() - INTERVAL 120 DAY
       AND NOT EXISTS (SELECT 1 FROM claim_items ci JOIN transactions c ON c.id = ci.claim_tx_id
                       WHERE ci.line_id = td.id AND c.ticket_status = 'completed')
     ORDER BY p.paid_at ASC, td.id ASC`);
  const until = addDays(today(), daysAhead), since = addDays(today(), -daysBack), out = [];
  for (const r of rows) {
    const readyOn = await releaseDate(ymd(new Date(r.paid_at)), Number(r.processing_days));
    if (readyOn > until || readyOn < since) continue;
    const left = Math.round((new Date(readyOn + 'T00:00:00') - new Date(today() + 'T00:00:00')) / 86400000);
    out.push({
      lineId: r.line_id, name: r.document_name, copies: Number(r.copies) || 1, paidTicket: r.ticket_no,
      student: fullName(r), studentNo: r.student_no || '',
      paidOn: ymd(new Date(r.paid_at)), paidText: shortDate(ymd(new Date(r.paid_at))),
      readyOn, readyText: shortDate(readyOn), daysLeft: left,
      status: left < 0 ? 'overdue' : left === 0 ? 'today' : 'soon',
      claim: await claimFor(r.line_id),
    });
  }
  return out;
}

/**
 * The next few open days: how many processed documents come due each day, and
 * how many students that means at the Registrar (due x show rate). A day well
 * above the usual Registrar load is flagged, so staff can plan the morning.
 */
async function releaseOutlook(days = 5) {
  const s = await getSettings();
  const due = await releasesDue(21);
  const out = [];
  for (let d = today(), n = 0; n < days && d <= addDays(today(), 30); d = addDays(d, 1)) {
    const dow = new Date(d + 'T00:00:00').getDay() || 7;
    if (!s.openDays.includes(dow)) continue;
    n++;
    const dueThat = due.filter(x => x.readyOn === d && !(x.claim && x.claim.date !== d));
    const booked = due.filter(x => x.claim && x.claim.date === d && !x.claim.done).length;
    const late = d === today() ? due.filter(x => x.readyOn < d && x.daysLeft >= -CLAIM_LATE_DAYS && !x.claim).length : 0;
    const expect = Math.round(booked + dueThat.filter(x => !x.claim).length * CLAIM_SHOW_RATE + late * CLAIM_LATE_RATE);
    out.push({ date: d, label: d === today() ? 'Today' : shortDate(d), due: dueThat.length, booked, late, expect });
  }
  // usual Registrar visitors per open day (last 30 days), to judge "busy"
  const [[u]] = await pool.query(
    `SELECT COUNT(*) / GREATEST(1, COUNT(DISTINCT service_date)) AS per_day FROM transactions
     WHERE department='Registrar' AND service_date >= CURDATE() - INTERVAL 30 DAY AND service_date < CURDATE()`);
  const usual = Math.max(5, Math.round(Number(u.per_day) || 0));
  out.forEach(o => { o.level = o.expect >= usual ? 'heavy' : o.expect >= usual * 0.5 ? 'busy' : 'normal'; });
  return { days: out, usual, showRate: CLAIM_SHOW_RATE, lateRate: CLAIM_LATE_RATE };
}

/** Students expected today for ready, uncollected documents without a booked
    claim (booked ones are already real tickets in the line). */
async function expectedClaimsToday() {
  const due = (await releasesDue(0, CLAIM_LATE_DAYS)).filter(x => !x.claim);
  const onDay = due.filter(x => x.readyOn === today()).length;
  const late  = due.filter(x => x.readyOn < today()).length;
  return Math.round(onDay * CLAIM_SHOW_RATE + late * CLAIM_LATE_RATE);
}

/**
 * "What can I pick up?": the paid documents waiting for a student, shown only
 * when the student number AND last name match the record (a student number
 * alone is not secret). Any mismatch gives the same empty answer, so nobody
 * can probe; the claim itself is checked again, and staff check the ID.
 */
async function findClaimables({ studentNo, lastName } = {}) {
  const no = String(studentNo || '').trim();
  if (!STUDENT_NO_RE.test(no) || !normName(lastName)) return null;
  const u = (await q(`SELECT * FROM users WHERE student_no=? AND role='student' AND status<>'disabled' AND deleted_at IS NULL LIMIT 1`, [no]))[0];
  if (!u || normName(lastName) !== normName(u.last_name)) return null;
  const lines = toPickup(await getClaimableLines(u.id));
  if (!lines.length) lines.fees = await recentFees('t.user_id = ?', [u.id]);
  return lines;
}

/**
 * Fees paid lately (Late Enrollment, Completion Fee: "To claim" is off), so
 * an empty pickup list can say why: a fee has nothing to collect.
 */
async function recentFees(who, params) {
  const rows = await q(
    `SELECT DISTINCT td.document_name AS name, t.ticket_no AS ticket FROM transaction_documents td
     JOIN transactions t ON t.id = td.transaction_id JOIN documents d ON d.id = td.document_id
     WHERE ${who} AND t.department='Cashier' AND t.payment_status='paid' AND d.requires_claim = 0
       AND t.service_date >= CURDATE() - INTERVAL 30 DAY
     ORDER BY t.ticket_no LIMIT 5`, params);
  return rows.map(r => ({ name: r.name, ticket: r.ticket }));
}

/**
 * Visitors have no student number: they find what they paid for with the
 * booking code of their Cashier ticket and their last name.
 */
async function findClaimablesByCode({ code, lastName } = {}) {
  code = String(code || '').trim().toUpperCase();
  if (!/^[A-Z0-9]{6}$/.test(code) || !normName(lastName)) return null;
  const t = (await q(
    `SELECT id, last_name FROM transactions WHERE booking_code=? AND department='Cashier' AND payment_status='paid'
       AND service_date >= CURDATE() - INTERVAL 120 DAY ORDER BY id DESC LIMIT 1`, [code]))[0];
  if (!t || normName(t.last_name) !== normName(lastName)) return null;
  const lines = toPickup(await getClaimableLines(null, { txIds: [t.id] }));
  if (!lines.length) lines.fees = await recentFees('t.id = ?', [t.id]);
  return lines;
}

/** Paid lines a visitor may claim: theirs only if the Cashier ticket carries the same last name. */
async function guestClaimableLines(lineIds, lastName) {
  if (!lineIds.length || !normName(lastName)) return [];
  const txs = await q(
    `SELECT DISTINCT t.id, t.last_name FROM transaction_documents td JOIN transactions t ON t.id = td.transaction_id
     WHERE td.id IN (${lineIds.map(() => '?').join(',')}) AND t.department='Cashier' AND t.payment_status='paid'`, lineIds);
  const mine = txs.filter(x => normName(x.last_name) === normName(lastName)).map(x => x.id);
  return mine.length ? getClaimableLines(null, { txIds: mine }) : [];
}

const toPickup = lines => lines.map(l => ({
  id: l.id, name: l.name, copies: l.copies, receiptNo: l.receiptNo, paidTicket: l.paidTicket,
  paidText: l.paidAt ? shortDate(l.paidAt) : '', readyOn: l.readyOn,
  readyText: l.readyOn ? shortDate(l.readyOn) : '', ready: !l.readyOn || l.readyOn <= today(),
}));

/** A Registrar document that collects something paid for at the Cashier. */
const isClaimDocument = d => d.office === 'Registrar' && d.requiresClaim;

/** Every unfinished transaction for this user, keyed by office. */
async function getActiveByDepartment(userId) {
  const rows = await q(
    `SELECT * FROM transactions
     WHERE user_id=? AND overall_status NOT IN ('completed','cancelled')
     ORDER BY requested_at ASC`, [userId]);
  const list = rows.map(mapTx);
  await attachDocuments(list);
  const out = { Cashier: null, Registrar: null };
  list.forEach(t => { if (!out[t.department]) out[t.department] = t; });
  return out;
}

async function getTransaction(id) {
  const r = await q(`${TX_SELECT} WHERE t.id=?`, [id]);
  if (!r.length) return null;
  const t = mapTx(r[0]);
  await attachDocuments([t]);
  return t;
}

async function getUserTransactions(userId, { activeOnly = false } = {}) {
  let sql = `${TX_SELECT} WHERE t.user_id=?`;
  if (activeOnly) sql += ` AND t.overall_status NOT IN ('completed','cancelled')`;
  sql += ' ORDER BY t.requested_at DESC, t.id DESC';
  const list = (await q(sql, [userId])).map(mapTx);
  return attachDocuments(list);
}

async function getQueue(department, { date = null } = {}) {
  const d = date || today();
  const list = (await q(
    `${TX_SELECT} WHERE t.department=? AND t.service_date=?
     ORDER BY t.queue_at ASC, t.id ASC`, [department, d])).map(mapTx);
  return attachDocuments(list);
}

// ── ALTERNATING QUEUE LOGIC ──────────────────────────────────────────────────
/**
 * Priority -> Regular -> Priority -> Regular, per department.
 * Falls through to whichever lane has tickets when one is empty.
 * Decides from what was actually called today, so it survives restarts.
 */
/** Clients ready to be called, per lane, first come first served (for data/dispatch.js). */
async function readyLanes(department, settings) {
  const rows = await q(
    `SELECT id, ticket_no, queue_category, predicted_service, skip_count, queue_at, hold_until FROM transactions
     WHERE department=? AND service_date=CURDATE() AND ticket_status='waiting' AND queue_at <= NOW()
       AND (hold_until IS NULL OR hold_until <= NOW())   -- "available from": skipped, place kept
     ORDER BY queue_at ASC, id ASC`, [department]);
  const lanes = { priority: [], regular: [] };
  rows.forEach(r => lanes[r.queue_category === 'priority' ? 'priority' : 'regular'].push({
    id: r.id, ticketNo: r.ticket_no, skip: Number(r.skip_count) || 0,
    svc: Number(r.predicted_service) || settings.avgServiceMinutes,
    readyAt: Math.max(new Date(r.queue_at).getTime(), r.hold_until ? new Date(r.hold_until).getTime() : 0),
  }));
  return lanes;
}

/** The lane called last today (ties by id: called_at is whole seconds). */
async function lastCalledLane(department) {
  const last = await q(
    `SELECT queue_category FROM transactions
     WHERE department=? AND service_date=CURDATE() AND called_at IS NOT NULL
     ORDER BY called_at DESC, id DESC LIMIT 1`, [department]);
  return last.length ? last[0].queue_category : 'regular';
}

/**
 * Who this window should call next: one fair line (FCFS, priority and regular
 * 1:1), matched to the window by data/dispatch.js (window speed, shortest task
 * for a clearly slower window, priority to a less busy free window, nobody
 * passed over more than twice). With no staff given, the plain line order.
 * The decision rides along as `_decision`.
 */
async function pickNextTicket(department, staff = null) {
  const settings = await getSettings();
  const lanes = await readyLanes(department, settings);
  const wins = await dispatch.officeWindows(department);
  const mine = staff && staff.windowId ? wins.find(w => w.id === staff.windowId) : null;
  const win = mine || { id: null, label: 'this window', speed: 1, workToday: 0 };
  const others = mine ? wins.filter(w => w.id !== win.id && w.status === 'open' && w.staffId) : [];
  const d = dispatch.decide(win, lanes, await lastCalledLane(department), others);
  if (!d) return null;
  // saved for a better free window: the row is the client, flagged as reserved
  const r = await q('SELECT * FROM transactions WHERE id=?', [(d.pick || d.head).id]);
  if (!r.length) return null;
  r[0]._decision = d;
  return r[0];
}

/**
 * Which window this staff member serves from.
 * Each cashier/registrar account owns a window (spec 12 & 21), so we use theirs.
 * Staff with no assigned window fall back to the least-loaded open one.
 */
async function pickWindow(department, staff) {
  if (staff && staff.windowId) {
    const own = await q(
      `SELECT w.*,
         (SELECT COUNT(*) FROM transactions t
           WHERE t.window_id=w.id AND t.ticket_status IN ('called','serving')
             AND t.service_date=CURDATE()) AS busy
       FROM windows w WHERE w.id=? AND w.department=?`, [staff.windowId, department]);
    if (!own.length)                    return { error: 'Your window is not set up for this department.' };
    if (own[0].status !== 'open')       return { error: `Your window is marked "${own[0].status}". Open it before calling clients.` };
    if (Number(own[0].busy) > 0)        return { error: 'You are still serving a client at your window.' };
    return mapWindow(own[0]);
  }

  const r = await q(
    `SELECT w.*,
       (SELECT COUNT(*) FROM transactions t
         WHERE t.window_id=w.id AND t.service_date=CURDATE()
           AND t.ticket_status IN ('completed','serving','called')) AS load_count,
       (SELECT COUNT(*) FROM transactions t2
         WHERE t2.window_id=w.id AND t2.ticket_status IN ('called','serving')
           AND t2.service_date=CURDATE()) AS busy
     FROM windows w
     WHERE w.department=? AND w.status='open'
     HAVING busy = 0
     ORDER BY load_count ASC, w.rr_position ASC
     LIMIT 1`, [department]);
  return r.length ? mapWindow(r[0]) : null;
}

async function callNext(staff, department) {
  const s = await getSettings();
  if (isBreakTime(s))
    return { error: `It is break time until ${clock12(s.breakEnd)}. Call Next works again after the break.` };
  const win = await pickWindow(department, staff);
  if (!win)       return { error: 'No window is open and free right now.' };
  if (win.error)  return { error: win.error };

  // Smart Call Next (data/dispatch.js) picks who this window calls. If another
  // window took the same client in the same instant, pick again.
  let t = null;
  for (let attempt = 0; attempt < 3 && !t; attempt++) {
    const cand = await pickNextTicket(department, { ...staff, windowId: win.id });
    if (!cand) return { error: 'There are no clients waiting in this queue.' };
    const cd = cand._decision;
    if (cd && cd.reserved)
      return { error: `${cd.reason}. If ${cd.forWindow} does not call within ` +
                      `${cd.secondsLeft >= 60 ? Math.ceil(cd.secondsLeft / 60) + ' min' : cd.secondsLeft + ' s'}, you can take them.` };
    // Calling a number also starts serving it: there is no separate Accept step.
    // A client who never comes is cleared by Cancel or the inactivity auto-cancel.
    const u = await run(
      `UPDATE transactions SET ticket_status='serving', called_at=NOW(), started_at=NOW(),
         staff_id=?, staff_name=?, window_id=?, window_label=?,
         overall_status=CASE WHEN department='Cashier' THEN 'cashier_processing'
                             ELSE 'registrar_processing' END
       WHERE id=? AND ticket_status='waiting'`,
      [staff.id, staff.fullName, win.id, win.label, cand.id]);
    if (u.affectedRows) t = cand;
  }
  if (!t) return { error: 'Another window just called that client. Press Call Next again.' };

  // whoever was passed over moves one step closer to "called next no matter what"
  const d = t._decision;
  if (d && d.skipped.length) {
    await run(`UPDATE transactions SET skip_count = skip_count + 1 WHERE id IN (${d.skipped.map(() => '?').join(',')})`,
              d.skipped.map(x => x.id));
    await engine.logDecision(t.id, department, 'assigned',
      `${t.ticket_no} to ${win.label}: ${d.reason}. Passed over once: ${d.skipped.map(x => x.ticketNo).join(', ')} ` +
      `(each at most ${dispatch.MAX_SKIPS} times).`,
      { window: win.label, rule: d.rule, skipped: d.skipped.map(x => x.ticketNo) });
  }
  await run(
    `INSERT INTO queue_history (transaction_id,ticket_no,action,staff_id,staff_name,department,window_label)
     VALUES (?,?,'called',?,?,?,?)`,
    [t.id, t.ticket_no, staff.id, staff.fullName, department, win.label]);
  await run('UPDATE windows SET rr_position=(SELECT mx FROM (SELECT MAX(rr_position)+1 AS mx FROM windows WHERE department=?) x) WHERE id=?',
    [department, win.id]);

  const called = await getTransaction(t.id);
  await announce(called);
  notifyCalled(called);          // fire and forget; email must never block the queue
  return called;
}

async function acceptTicket(staff, txId) {
  const t = await getTransaction(txId);
  if (!t) return { error: 'Ticket not found.' };
  await run(`UPDATE transactions SET ticket_status='serving', started_at=NOW() WHERE id=?`, [txId]);
  await run(`INSERT INTO queue_history (transaction_id,ticket_no,action,staff_id,staff_name,department,window_label)
             VALUES (?,?,'accepted',?,?,?,?)`,
            [txId, t.ticketNo, staff.id, staff.fullName, t.department, t.windowLabel]);
  return await getTransaction(txId);
}

// ── CASHIER: PAYMENT + RECEIPT ───────────────────────────────────────────────
async function processPayment(staff, txId) {
  const t = await getTransaction(txId);
  if (!t)                            return { error: 'Ticket not found.' };
  if (t.department !== 'Cashier')    return { error: 'Only cashier tickets take payments.' };
  if (t.paymentStatus === 'paid')    return { error: 'This transaction is already paid.' };

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const [pay] = await conn.execute(
      `INSERT INTO payments (transaction_id,amount,status,staff_id,staff_name,window_label)
       VALUES (?,?,'paid',?,?,?)`,
      [txId, t.amountDue, staff.id, staff.fullName, t.windowLabel]);

    const receiptNo = await nextReceiptNo(conn);
    await conn.execute(
      `INSERT INTO receipts (receipt_no,transaction_id,payment_id,amount_paid)
       VALUES (?,?,?,?)`, [receiptNo, txId, pay.insertId, t.amountDue]);

    await conn.execute(
      `UPDATE transactions SET payment_status='paid', overall_status='payment_completed'
       WHERE id=?`, [txId]);
    await conn.execute(
      `INSERT INTO queue_history (transaction_id,ticket_no,action,staff_id,staff_name,department,window_label,note)
       VALUES (?,?,'payment',?,?,?,?,?)`,
      [txId, t.ticketNo, staff.id, staff.fullName, 'Cashier', t.windowLabel,
       `Paid ₱${t.amountDue.toFixed(2)} — ${receiptNo}`]);

    await conn.commit();
    return await getTransaction(txId);
  } catch (e) { await conn.rollback(); throw e; }
  finally     { conn.release(); }
}

/**
 * The cashier finishes a transaction. Payment is the end of it.
 *
 * Cashier and Registrar are separate transactions. A client who also needs
 * something from the Registrar requests their own Registrar ticket; nothing
 * is generated on their behalf here.
 */
async function completeCashier(staff, txId) {
  const t = await getTransaction(txId);
  if (!t)                     return { error: 'Transaction not found.' };
  if (t.staffId !== staff.id) return { error: 'That ticket is not yours to complete.' };
  if (t.amountDue > 0 && t.paymentStatus !== 'paid')
    return { error: 'Record the payment before completing this transaction.' };

  const mins = t.startedAt
    ? Math.max(1, Math.round((Date.now() - new Date(t.startedAt).getTime()) / 60000))
    : null;

  await run(
    `UPDATE transactions
        SET ticket_status='completed', overall_status='completed',
            completed_at=NOW(), actual_minutes=?
      WHERE id=?`, [mins, txId]);

  await run(
    `INSERT INTO queue_history (transaction_id,ticket_no,action,staff_id,staff_name,department,note)
     VALUES (?,?,?,?,?,?,?)`,
    [txId, t.ticketNo, 'completed', staff.id, staff.fullName, t.department,
     'Transaction completed at the Cashier']);

  return { ok: true, transaction: await getTransaction(txId) };
}


/**
 * The Cashier's one button: record the payment, issue the receipt and finish
 * the ticket. Free items skip the payment. Uses the same steps as before
 * (processPayment, completeCashier), just in one click.
 */
async function payAndComplete(staff, txId) {
  const t = await getTransaction(txId);
  if (!t)                                   return { error: 'Ticket not found.' };
  if (t.department !== 'Cashier')           return { error: 'Only cashier tickets take payments.' };
  if (t.staffId !== staff.id)               return { error: 'That ticket is not at your window.' };
  if (!['called', 'serving'].includes(t.ticketStatus))
    return { error: `${t.ticketNo} is no longer at your window.` };

  let receiptNo = t.receiptNo;
  if (t.amountDue > 0 && t.paymentStatus !== 'paid') {
    const p = await processPayment(staff, txId);
    if (p.error) return p;
    receiptNo = p.receiptNo;
  }
  const c = await completeCashier(staff, txId);
  if (c.error) return c;
  return { ok: true, ticketNo: t.ticketNo, receiptNo, amount: t.amountDue };
}

// ── REGISTRAR: COMPLETE ──────────────────────────────────────────────────────
async function completeRegistrar(staff, txId) {
  const t = await getTransaction(txId);
  if (!t)                            return { error: 'Ticket not found.' };
  if (t.department !== 'Registrar')  return { error: 'That is not a registrar ticket.' };

  const mins = t.startedAt
    ? Math.max(1, Math.round((Date.now() - new Date(t.startedAt).getTime()) / 60000)) : null;

  await run(
    `UPDATE transactions SET ticket_status='completed', completed_at=NOW(),
       actual_minutes=?, overall_status='completed' WHERE id=?`, [mins, txId]);
  await run(
    `INSERT INTO queue_history (transaction_id,ticket_no,action,staff_id,staff_name,department,window_label)
     VALUES (?,?,'completed',?,?,'Registrar',?)`,
    [txId, t.ticketNo, staff.id, staff.fullName, t.windowLabel]);

  return await getTransaction(txId);
}

/**
 * A student cancels their own BOOKED ticket (scheduled for a date) while it is
 * still waiting and unpaid. Same-day "Request now" tickets are cancelled by
 * staff only. Once staff call it, or the Cashier records payment, only staff
 * can cancel. A cancelled claim ticket frees its paid documents again.
 */
async function cancelByStudent(user, txId, reason) {
  const t = await getTransaction(txId);
  if (!t || t.userId !== user.id)        return { error: 'Ticket not found.' };
  // booked tickets, and same-day tickets the system warned may not be served today
  const booked = t.isScheduled || !!t.slotStart;
  if (!booked && !t.riskAt)               return { error: 'Only booked tickets can be cancelled here. For a same-day ticket, please ask the office.' };
  if (t.paymentStatus === 'paid')         return { error: 'This ticket is already paid, so it cannot be cancelled here. Please ask the Cashier.' };
  if (t.ticketStatus !== 'waiting')       return { error: 'This ticket has already been called, so only the office can cancel it now.' };

  const why = String(reason || '').trim().slice(0, 90);
  // The WHERE repeats the checks, so a ticket called in the same instant is left alone.
  const r = await run(
    `UPDATE transactions SET ticket_status='cancelled', overall_status='cancelled',
       cancel_reason=?, completed_at=NOW()
     WHERE id=? AND user_id=? AND (is_scheduled=1 OR slot_start IS NOT NULL OR risk_at IS NOT NULL)
       AND ticket_status='waiting' AND payment_status<>'paid'`,
    ['Cancelled by student' + (why ? ': ' + why : ''), txId, user.id]);
  if (!r.affectedRows) return { error: 'This ticket can no longer be cancelled. Please ask the office.' };

  await run(
    `INSERT INTO queue_history (transaction_id,ticket_no,action,staff_id,staff_name,department,note)
     VALUES (?,?,'cancelled',NULL,?,?,?)`,
    [txId, t.ticketNo, t.fullName || 'Student', t.department,
     'Cancelled by the student' + (why ? ': ' + why : '')]);
  return { ok: true, ticketNo: t.ticketNo };
}

/**
 * "Book tomorrow" from a ticket the system warned about: move it to the
 * earliest open 30-minute slot on the next open day, with that day's number.
 */
async function rebookTicket(txId) {
  const t = await getTransaction(txId);
  if (!t || t.ticketStatus !== 'waiting' || t.paymentStatus === 'paid')
    return { error: 'This ticket can no longer be moved. Please ask the office.' };
  const s = await getSettings();
  for (let i = 1; i <= s.scheduleMaxDays; i++) {
    const date = addDays(today(), i);
    if ((await validateSchedule('schedule', date, t.department)).error) continue;   // closed day
    const dayOv = (await getDayOverrides(t.department, date, date))[date];
    const cap = dayOv && dayOv.slotLimit != null ? dayOv.slotLimit : s.dailySlotLimit;
    if (cap > 0 && await slotsUsed(t.department, date) >= cap) continue;
    const plan = await engine.slotPlan(t.department, date, t.predictedService, s);
    const slot = plan.slots.find(x => x.available);
    if (!slot) continue;

    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();
      const newNo = await nextTicketNo(conn, t.department, date, t.queueCategory);
      const [u] = await conn.execute(
        `UPDATE transactions SET ticket_no=?, service_date=?, scheduled_date=?, is_scheduled=1,
           slot_start=?, slot_end=?, queue_at=?, risk_at=NULL, alerts_sent=''
         WHERE id=? AND ticket_status='waiting'`,
        [newNo, date, date, slot.start, slot.end, `${date} ${slot.start}:00`, t.id]);
      if (!u.affectedRows) { await conn.rollback(); return { error: 'This ticket can no longer be moved.' }; }
      await conn.execute(
        `INSERT INTO queue_history (transaction_id,ticket_no,action,department,note) VALUES (?,?,'rebooked',?,?)`,
        [t.id, newNo, t.department, `Moved by the student from ${t.ticketNo} today to ${date}, ${slot.label}`]);
      await conn.commit();
      await engine.logDecision(t.id, t.department, 'rebooked',
        `${t.ticketNo} moved to ${date} ${slot.label} as ${newNo} (first open slot).`, { date, slot: slot.label });
      return { ok: true, from: t.ticketNo, to: newNo, date, slot };
    } catch (e) {
      await conn.rollback();
      throw e;
    } finally {
      conn.release();
    }
  }
  return { error: 'There is no open slot in the coming days. Please ask the office.' };
}

/**
 * "I'm busy until 2:00 PM": the student keeps their place but is not called
 * before then; others are called meanwhile, and once the time comes they are
 * next in their lane. Once per ticket, at most 2 hours, today only. If the
 * engine already predicts their turn after that time, nothing is held.
 */
const HOLD_MAX_MIN = 120;
async function setHold(t, untilHHMM) {
  if (!t || t.ticketStatus !== 'waiting' || t.paymentStatus === 'paid' || t.serviceDate !== today())
    return { error: "Only a ticket waiting in today's line can be held." };
  if (t.holdUsed) return { error: 'You can only set "available from" once per ticket.' };
  if (!/^\d{2}:\d{2}$/.test(String(untilHHMM || ''))) return { error: 'Choose a time.' };
  const s = await getSettings();
  const until = new Date(`${today()}T${untilHHMM}:00`), now = new Date();
  const max = new Date(now.getTime() + HOLD_MAX_MIN * 60000);
  const close = new Date(`${today()}T${s.closeTime}:00`);
  if (until <= now)   return { error: 'Choose a time later than now.' };
  if (until > max)    return { error: 'You can hold your place for up to 2 hours.' };
  if (until >= close) return { error: `The office closes at ${clock12(s.closeTime)}. Choose an earlier time.` };

  const f = await engine.ticketForecast(t).catch(() => null);
  if (f && f.start >= until) {
    return { notNeeded: true, startClock: f.startClock,
             message: `No need: your turn is predicted around ${f.startClock}, after ${clock12(untilHHMM)}. ` +
                      'We will alert you 15 minutes before.' };
  }
  const alerts = String(t.alertsSent || '').split(',').filter(a => a && a !== 'leave').join(',');
  await run(`UPDATE transactions SET hold_until=?, hold_used=1, alerts_sent=? WHERE id=? AND ticket_status='waiting'`,
            [until, alerts, t.id]);
  await run(`INSERT INTO queue_history (transaction_id,ticket_no,action,department,note) VALUES (?,?,'held',?,?)`,
            [t.id, t.ticketNo, t.department, `Available from ${clock12(untilHHMM)}; place kept`]);
  await engine.logDecision(t.id, t.department, 'held',
    `${t.ticketNo} available from ${clock12(untilHHMM)}` +
    (f ? `; predicted turn was ${f.startClock}, so others are called meanwhile and ${t.ticketNo} keeps its place.` : '.'),
    { until: untilHHMM, predictedStart: f && f.startClock });
  return { ok: true, untilClock: clock12(untilHHMM) };
}

/** "I'm available now": end the hold early. */
async function clearHold(t) {
  await run(`UPDATE transactions SET hold_until=NULL WHERE id=? AND ticket_status='waiting'`, [t.id]);
  return { ok: true };
}

/**
 * Called but not at the window. First miss: back to the line, 5 places behind
 * where they were (or at the end), with a notice saying why. Second miss: the
 * ticket is cancelled. Staff press one button; the window is freed.
 */
const MISS_PLACES = 5;
async function missedTurn(staff, txId) {
  const t = await getTransaction(txId);
  const dept = staff.role === 'cashier' ? 'Cashier' : 'Registrar';
  if (!t || t.department !== dept)                    return { error: 'Ticket not found.' };
  if (!['called', 'serving'].includes(t.ticketStatus)) return { error: `${t.ticketNo} is not at a window.` };
  if (t.paymentStatus === 'paid')                     return { error: `${t.ticketNo} is already paid.` };
  const url = t.accessToken ? '/queue/t/' + t.accessToken : '/queue';

  if (t.missedCount >= 1) {
    await run(
      `UPDATE transactions SET ticket_status='no-show', overall_status='cancelled', missed_count=missed_count+1,
         cancel_reason='Missed turn twice', completed_at=NOW() WHERE id=?`, [t.id]);
    await run(`INSERT INTO queue_history (transaction_id,ticket_no,action,staff_id,staff_name,department,window_label,note)
               VALUES (?,?,'no-show',?,?,?,?,?)`,
              [t.id, t.ticketNo, staff.id, staff.fullName, dept, t.windowLabel || null, 'Missed turn twice; cancelled']);
    await engine.logDecision(t.id, dept, 'cancelled', `${t.ticketNo} missed the turn a second time; cancelled.`);
    push.sendToTicket(t.id, { title: `${t.ticketNo} was cancelled`,
      body: 'You missed your turn twice. You can get a new number from the queue page.', url });
    return { ok: true, cancelled: true, ticketNo: t.ticketNo };
  }

  // the 5th client behind them in the same lane (only people already in line,
  // not bookings for later today); they go just after
  const behind = await q(
    `SELECT queue_at FROM transactions
     WHERE department=? AND service_date=? AND ticket_status='waiting' AND queue_category=? AND id<>?
       AND (queue_at > ? OR (queue_at = ? AND id > ?)) AND queue_at <= NOW()
     ORDER BY queue_at, id LIMIT ${MISS_PLACES}`,
    [dept, t.serviceDate, t.queueCategory, t.id, t.queueAt, t.queueAt, t.id]);
  // One second after that person (they are called first anyway). With nobody
  // behind, "now" in whole seconds: a time MySQL rounds UP would not be
  // callable until the next second.
  const newAt = behind.length
    ? new Date(new Date(behind[behind.length - 1].queue_at).getTime() + 1000)
    : new Date(Math.floor(Date.now() / 1000) * 1000);
  await run(
    `UPDATE transactions SET ticket_status='waiting', queue_at=?, missed_count=1, alerts_sent='',
       staff_id=NULL, staff_name=NULL, window_id=NULL, window_label=NULL,
       called_at=NULL, started_at=NULL, warned_at=NULL,
       overall_status=CASE WHEN department='Cashier' THEN 'pending' ELSE 'waiting_registrar' END
     WHERE id=?`, [newAt, t.id]);
  const moved = behind.length;
  const places = `${moved} place${moved === 1 ? '' : 's'}`;
  await run(`INSERT INTO queue_history (transaction_id,ticket_no,action,staff_id,staff_name,department,window_label,note)
             VALUES (?,?,'missed_turn',?,?,?,?,?)`,
            [t.id, t.ticketNo, staff.id, staff.fullName, dept, t.windowLabel || null,
             `Not at the window; moved back ${places}`]);
  await engine.logDecision(t.id, dept, 'missed',
    `${t.ticketNo} was not at the window; moved back ${places} (rule: ${MISS_PLACES}). A second miss cancels it.`);
  push.sendToTicket(t.id, { title: `You missed your turn: ${t.ticketNo}`,
    body: `You were called but were not at the window, so you moved back ${places}. ` +
          'If you miss it again, your ticket will be cancelled.', url });
  return { ok: true, ticketNo: t.ticketNo, movedBack: moved };
}

async function cancelTicket(staff, txId, reason) {
  const t = await getTransaction(txId);
  if (!t) return { error: 'Ticket not found.' };
  if (t.paymentStatus === 'paid')
    return { error: 'A paid transaction cannot be cancelled. Complete it through the Registrar instead.' };
  await run(
    `UPDATE transactions SET ticket_status='cancelled', overall_status='cancelled',
       cancel_reason=?, completed_at=NOW() WHERE id=?`,
    [reason || 'Cancelled by staff', txId]);
  await run(
    `INSERT INTO queue_history (transaction_id,ticket_no,action,staff_id,staff_name,department,note)
     VALUES (?,?,'cancelled',?,?,?,?)`,
    [txId, t.ticketNo, staff ? staff.id : null, staff ? staff.fullName : 'System',
     t.department, reason || null]);
  return { ok: true };
}

/** Tell the client by email that their number has been called. */
function notifyCalled(t) {
  if (!t || !t.userId) return;
  (async () => {
    try {
      const u = await getUser(t.userId);
      if (!u || !u.email) return;
      const mailer = require('./mailer');
      await mailer.sendCalled(u.email, u.firstName, t);
    } catch (e) {
      console.error('[MAIL] could not send call notice');
    }
  })();
}

// ── ANNOUNCEMENTS ────────────────────────────────────────────────────────────
/** Record that a ticket was called out, so the boards know to chime. */
async function announce(t, { isRecall = false } = {}) {
  const r = await run(
    `INSERT INTO announcements (transaction_id,ticket_no,department,window_label,client_name,is_recall)
     VALUES (?,?,?,?,?,?)`,
    [t.id, t.ticketNo, t.department, t.windowLabel || null,
     [t.firstName, t.lastName].filter(Boolean).join(' '), isRecall ? 1 : 0]);
  // the student's phone, even with the page closed (Web Push)
  push.sendToTicket(t.id, {
    title: `${isRecall ? 'Calling again' : 'Now calling'}: ${t.ticketNo}`,
    body: `Please go to ${t.windowLabel || 'the ' + t.department} now.`,
    url: t.accessToken ? '/queue/t/' + t.accessToken : '/queue',
  });
  return r.insertId;
}

/** The newest announcement for an office, for the display board to watch. */
async function latestAnnouncement(department) {
  const r = await q(
    `SELECT * FROM announcements WHERE department=? ORDER BY id DESC LIMIT 1`, [department]);
  if (!r.length) return null;
  const a = r[0];
  return {
    id: a.id, ticketNo: a.ticket_no, windowLabel: a.window_label || '',
    clientName: a.client_name || '', isRecall: !!a.is_recall, createdAt: a.created_at,
  };
}

/**
 * Cheap "has anything been called?" checks, polled every ~1.5 s by the boards
 * and the student's ticket page so the alert sounds right after Call Next
 * instead of waiting for the next full page refresh.
 */
async function announcementPulse(department) {
  const r = await q('SELECT MAX(id) AS id FROM announcements WHERE department=?', [department]);
  return r[0].id || null;
}
/**
 * The student's own ticket: newest call, status, and how many are ahead in the
 * same office and lane today (the same count the ticket page shows). Drives
 * the call alert and the "5 ahead" / "you are next" notices.
 */
async function announcementPulseFor(txId, userId) {
  const r = await q(
    `SELECT t.ticket_status, t.service_date,
            (SELECT MAX(a.id) FROM announcements a WHERE a.transaction_id = t.id) AS call_id,
            (SELECT COUNT(*) FROM transactions x
              WHERE x.department = t.department AND x.service_date = t.service_date
                AND x.queue_category = t.queue_category AND x.ticket_status = 'waiting'
                AND (x.queue_at < t.queue_at OR (x.queue_at = t.queue_at AND x.id < t.id))
            ) AS ahead
     FROM transactions t WHERE t.id=? AND t.user_id=?`, [txId, userId]);
  if (!r.length) return { id: null };
  const t = r[0];
  return {
    id: t.call_id || null,
    status: t.ticket_status,
    today: ymd(new Date(t.service_date)) === today(),
    ahead: t.ticket_status === 'waiting' ? Number(t.ahead) : null,
  };
}

/** The newest announcement for one ticket, for the student's own page. */
async function latestAnnouncementFor(txId) {
  const r = await q(
    `SELECT * FROM announcements WHERE transaction_id=? ORDER BY id DESC LIMIT 1`, [txId]);
  if (!r.length) return null;
  return { id: r[0].id, isRecall: !!r[0].is_recall, createdAt: r[0].created_at };
}

/**
 * Call the same client again without disturbing the queue.
 *
 * Deliberately does NOT touch called_at, so the no-show countdown keeps
 * running from the original call - a recall is a courtesy, not a reset.
 */
async function recallTicket(staff, txId) {
  const t = await getTransaction(txId);
  if (!t)                     return { error: 'Transaction not found.' };
  if (t.staffId !== staff.id) return { error: 'That ticket is not yours to call.' };
  if (!['called', 'serving'].includes(t.ticketStatus))
    return { error: 'Only a ticket at your window can be called again.' };

  await announce(t, { isRecall: true });
  await run(
    `INSERT INTO queue_history (transaction_id,ticket_no,action,staff_id,staff_name,department,window_label,note)
     VALUES (?,?,?,?,?,?,?,?)`,
    [t.id, t.ticketNo, 'recalled', staff.id, staff.fullName, t.department,
     t.windowLabel || null, 'Called again at the window']);

  return { ok: true, transaction: t };
}

// ── AUTO-CANCEL (never touches a paid transaction) ───────────────────────────
async function processAutoCancel() {
  const s = await getSettings();

  // 1. Warn a client who has been called but has not finished at the window.
  const warned = await run(
    `UPDATE transactions SET warned_at=NOW()
     WHERE ticket_status IN ('called','serving') AND payment_status <> 'paid'
       AND warned_at IS NULL AND called_at IS NOT NULL
       AND TIMESTAMPDIFF(MINUTE, called_at, NOW()) >= ?`,
    [Math.max(0, s.cancelAfterMinutes - s.warnBeforeMinutes)]);

  // 2. Called but never showed up at the window.
  const noShow = await run(
    `UPDATE transactions SET ticket_status='no-show', overall_status='cancelled',
       cancel_reason='No show at the window', completed_at=NOW()
     WHERE ticket_status='called' AND payment_status <> 'paid'
       AND called_at IS NOT NULL
       AND TIMESTAMPDIFF(MINUTE, called_at, NOW()) >= ?`,
    [s.noShowAfterMinutes + s.cancelAfterMinutes]);

  // 3. At the window but the transaction was never completed.
  const cancelled = await run(
    `UPDATE transactions SET ticket_status='cancelled', overall_status='cancelled',
       cancel_reason='Auto-cancelled: inactive', completed_at=NOW()
     WHERE ticket_status='serving' AND payment_status <> 'paid'
       AND started_at IS NOT NULL
       AND TIMESTAMPDIFF(MINUTE, started_at, NOW()) >= ?`,
    [s.cancelAfterMinutes]);

  // 4. (Removed) Waiting tickets are no longer cancelled after a fixed time.
  //    Students may join from a classroom and wait two hours, and a booking's
  //    clock starts at its slot, not when it was made. A client who is not
  //    there is caught when called (no-show), and step 5 closes the day.
  const expired = { affectedRows: 0 };

  // 5. Anything still open from an earlier day is closed out, so yesterday's
  //    numbers never linger on a dashboard.
  const stale = await run(
    `UPDATE transactions SET
       ticket_status = CASE WHEN ticket_status='waiting' THEN 'cancelled' ELSE ticket_status END,
       overall_status='cancelled',
       cancel_reason='Closed: office day ended', completed_at=NOW()
     WHERE service_date < CURDATE() AND payment_status <> 'paid'
       AND ticket_status IN ('waiting','called','serving')`);

  // Free any window still pointing at a ticket that is no longer active.
  await run(
    `UPDATE windows w
     LEFT JOIN transactions t
       ON t.window_id = w.id AND t.ticket_status IN ('called','serving')
      AND t.service_date = CURDATE()
     SET w.rr_position = w.rr_position
     WHERE t.id IS NULL`);

  return {
    warned: warned.affectedRows, noShow: noShow.affectedRows,
    cancelled: cancelled.affectedRows, expired: expired.affectedRows,
    stale: stale.affectedRows,
  };
}

async function getTimeLeft(txId) {
  const s = await getSettings();
  const r = await q(
    `SELECT TIMESTAMPDIFF(SECOND, COALESCE(started_at, called_at), NOW()) AS elapsed
     FROM transactions WHERE id=? AND ticket_status IN ('called','serving')`, [txId]);
  if (!r.length || r[0].elapsed == null) return null;
  return Math.max(0, s.cancelAfterMinutes * 60 - r[0].elapsed);
}

// ── LIVE QUEUE LOAD ──────────────────────────────────────────────────────────
/** Today's real average wait: from a client's place in line to being called. */
async function todayAverageWait(department) {
  const r = await q(
    `SELECT ROUND(AVG(TIMESTAMPDIFF(SECOND, queue_at, called_at)) / 60) AS m, COUNT(*) AS n
     FROM transactions
     WHERE department=? AND service_date=CURDATE() AND called_at IS NOT NULL AND queue_at IS NOT NULL
       AND called_at >= queue_at`, [department]);
  const n = Number(r[0].n) || 0;
  return n ? { minutes: Number(r[0].m) || 0, served: n } : null;
}

async function getLoad() {
  const s = await getSettings();
  const out = {};
  for (const dept of ['Cashier', 'Registrar']) {
    const r = await q(
      `SELECT
         SUM(ticket_status='waiting')                        AS waiting,
         SUM(ticket_status IN ('called','serving'))          AS serving,
         SUM(ticket_status='completed')                      AS completed,
         SUM(ticket_status IN ('cancelled','no-show'))       AS dropped,
         COUNT(*)                                            AS issued
       FROM transactions WHERE department=? AND service_date=CURDATE()`, [dept]);
    const row = r[0] || {};
    let capacity = dept === 'Cashier' ? s.cashierCapacity : s.registrarCapacity;
    if (s.capacityMode === 'auto') {
      const mins = (parseInt(s.closeTime) * 60 + parseInt(s.closeTime.slice(3)))
                 - (parseInt(s.openTime)  * 60 + parseInt(s.openTime.slice(3)))
                 - ((parseInt(s.breakEnd) * 60 + parseInt(s.breakEnd.slice(3)))
                 -  (parseInt(s.breakStart) * 60 + parseInt(s.breakStart.slice(3))));
      const openWins = await q(
        `SELECT COUNT(*) AS c FROM windows WHERE department=? AND status='open'`, [dept]);
      capacity = Math.floor(mins / s.avgServiceMinutes) * Math.max(1, openWins[0].c);
    }
    const issued  = Number(row.issued) || 0;
    const percent = capacity ? Math.min(100, Math.round((issued / capacity) * 100)) : 0;
    out[dept] = {
      waiting: Number(row.waiting) || 0, serving: Number(row.serving) || 0,
      completed: Number(row.completed) || 0, dropped: Number(row.dropped) || 0,
      issued, capacity, percent,
      remaining: Math.max(0, capacity - issued),
      level: percent >= 100 ? 'full' : percent >= 75 ? 'busy' : 'normal',
    };
  }
  return out;
}

// ── RECEIPTS ─────────────────────────────────────────────────────────────────
async function getReceipt(txId) {
  const r = await q(
    `SELECT r.*, p.staff_name, p.window_label, p.paid_at,
            t.ticket_no, t.first_name, t.middle_name, t.last_name, t.purpose,
            t.other_purpose, t.student_no, t.course, t.year_level, t.user_id
     FROM receipts r
     JOIN payments p     ON p.id = r.payment_id
     JOIN transactions t ON t.id = r.transaction_id
        WHERE r.transaction_id = ?`, [txId]);
  if (!r.length) return null;
  const x = r[0];
  const items = await q(
    'SELECT document_name, unit_price, copies, price FROM transaction_documents WHERE transaction_id=?', [txId]);
  return {
    receiptNo: x.receipt_no, ticketNo: x.ticket_no,
    name: [x.first_name, x.middle_name, x.last_name].filter(Boolean).join(' '),
    studentNo: x.student_no || '', course: x.course || '', yearLevel: x.year_level,
    purpose: x.purpose === 'Others' ? (x.other_purpose || 'Others') : x.purpose,
    amountPaid: Number(x.amount_paid), paidAt: x.paid_at,
    staffName: x.staff_name, windowLabel: x.window_label,
      userId: x.user_id,
      documents: items.map(i => ({
        name: i.document_name,
        unitPrice: Number(i.unit_price),
        copies: Number(i.copies) || 1,
        price: Number(i.price),
        label: (Number(i.copies) || 1) > 1
          ? `${i.document_name} x${i.copies}` : i.document_name,
      })),
  };
}

// ── ADMIN: USERS ─────────────────────────────────────────────────────────────
async function getUsers() {
  return (await q(`SELECT * FROM users WHERE deleted_at IS NULL
                   ORDER BY FIELD(role,'admin','cashier','registrar','student','guest'), last_name`))
    .map(mapUser);
}

/** Staff and admin accounts only. */
async function getStaffAccounts() {
  return (await q(
    `SELECT * FROM users WHERE role IN ('admin','cashier','registrar') AND deleted_at IS NULL
     ORDER BY FIELD(role,'admin','cashier','registrar'), last_name`)).map(mapUser);
}

/**
 * Admin deletes an account (staff, student or guest; never an admin or
 * themselves). An account with history (tickets, priority requests, or
 * tickets served as staff) is kept as a deleted, nameless-to-login record so
 * old receipts and reports stay whole: it can no longer sign in, and its
 * username, email, Google link and student number are released for reuse.
 * An account with no history is removed completely. Either way it is signed
 * out at once.
 */
async function deleteAccount(admin, id) {
  const r = await q('SELECT * FROM users WHERE id=? AND deleted_at IS NULL', [id]);
  if (!r.length)                 return { error: 'Account not found.' };
  const u = mapUser(r[0]);
  if (u.id === admin.id)         return { error: 'You cannot delete your own account.' };
  if (u.role === 'admin')        return { error: 'Admin accounts cannot be deleted here.' };

  const staff = u.role === 'cashier' || u.role === 'registrar';
  const busy = staff ? await q(
    `SELECT ticket_no FROM transactions WHERE staff_id=? AND ticket_status IN ('called','serving') LIMIT 1`, [id]) : [];
  if (busy.length) return { error: `${u.fullName} is serving ${busy[0].ticket_no} right now. Finish or cancel it first.` };

  const hist = await q(
    `SELECT (SELECT COUNT(*) FROM transactions WHERE user_id=? OR staff_id=?)
          + (SELECT COUNT(*) FROM priority_requests WHERE user_id=?)
          + (SELECT COUNT(*) FROM queue_history WHERE staff_id=?) AS n`, [id, id, id, id]);
  if (Number(hist[0].n)) {
    await run(
      `UPDATE users SET deleted_at=NOW(), status='disabled', username=NULL, email=NULL, password=NULL,
         google_id=NULL, student_no=NULL, window_id=NULL, priority_status='none' WHERE id=?`, [id]);
  } else {
    await run('DELETE FROM users WHERE id=?', [id]);
  }
  await signOutUser(id);
  return { ok: true, name: u.fullName, role: u.role };
}

/** End every saved login of one account (the session stores the user as JSON). */
async function signOutUser(id) {
  await run(`DELETE FROM sessions WHERE data LIKE ? OR data LIKE ?`,
            [`%"user":{"id":${Number(id)},%`, `%"userId":${Number(id)},%`]);
}

// ── QUEUE HISTORY (admin: everything; staff: their own office) ──────────────
// Built straight from the transaction records; nothing is copied or kept twice.
// Statuses are preserved as they are (completed, cancelled, no-show, pending).
const HISTORY_STATUS = {
  completed: "t.ticket_status='completed'",
  cancelled: "t.ticket_status='cancelled'",
  'no-show': "t.ticket_status='no-show'",
  pending:   "t.ticket_status IN ('waiting','called','serving')",
};

/** Columns the client list can be sorted by (click a header). D = the direction. */
const HISTORY_SORT = {
  name:      'u.last_name D, u.first_name D, u.id D',
  studentNo: 'u.student_no IS NULL, u.student_no D, u.last_name',
  completed: 'completed D, u.last_name, u.first_name',
  cancelled: 'cancelled D, u.last_name, u.first_name',
  pending:   'pending D, u.last_name, u.first_name',
  last:      'last_at D, u.id D',
};

/** Clean the filter values from a query string. office is forced for staff. */
function historyFilters(qs = {}, office = null) {
  const date = s => (/^\d{4}-\d{2}-\d{2}$/.test(s || '') ? s : '');
  const f = {
    q: String(qs.q || '').trim().slice(0, 80),
    from: date(qs.from), to: date(qs.to),
    documentId: /^\d+$/.test(qs.document || '') ? Number(qs.document) : null,
    status: HISTORY_STATUS[qs.status] ? qs.status : '',
    staffId: /^\d+$/.test(qs.staff || '') ? Number(qs.staff) : null,
    lane: qs.lane === 'priority' || qs.lane === 'regular' ? qs.lane : '',
    office: office || (qs.office === 'Cashier' || qs.office === 'Registrar' ? qs.office : ''),
    sort: HISTORY_SORT[qs.sort] ? qs.sort : 'name',
    dir: qs.dir === 'desc' ? 'desc' : 'asc',
  };
  if (f.from && f.to && f.from > f.to) [f.from, f.to] = [f.to, f.from];
  return f;
}

/** SQL conditions on transactions t for the given filters (not the search). */
function historyWhere(f) {
  const w = [], p = [];
  if (f.office)     { w.push('t.department=?'); p.push(f.office); }
  if (f.from)       { w.push('t.service_date>=?'); p.push(f.from); }
  if (f.to)         { w.push('t.service_date<=?'); p.push(f.to); }
  if (f.status)     w.push(HISTORY_STATUS[f.status]);
  if (f.lane)       { w.push('t.queue_category=?'); p.push(f.lane); }
  if (f.staffId)    { w.push('t.staff_id=?'); p.push(f.staffId); }
  if (f.documentId) { w.push('EXISTS (SELECT 1 FROM transaction_documents td WHERE td.transaction_id=t.id AND td.document_id=?)'); p.push(f.documentId); }
  return { w, p };
}

/**
 * Students/clients with their transaction counts, one page at a time.
 * The search finds people by name, student no., username, email, or any of
 * their queue numbers; the counts then cover all their tickets that match the
 * filters.
 */
async function getHistoryClients(f, page = 1) {
  const { w, p } = historyWhere(f);
  if (f.q) {
    const like = `%${f.q}%`;
    w.push(`(CONCAT_WS(' ', u.first_name, u.middle_name, u.last_name) LIKE ? OR u.student_no LIKE ?
             OR u.username LIKE ? OR u.email LIKE ?
             OR EXISTS (SELECT 1 FROM transactions x WHERE x.user_id=u.id AND x.ticket_no LIKE ?))`);
    p.push(like, like, like, like, like);
  }
  const where = w.length ? 'WHERE ' + w.join(' AND ') : '';
  const from = 'FROM transactions t JOIN users u ON u.id=t.user_id ' + where;
  const [c] = await q(`SELECT COUNT(DISTINCT t.user_id) AS n ${from}`, p);
  const pg = paging.paging(c.n, page);
  const rows = await q(
    `SELECT u.id, u.first_name, u.middle_name, u.last_name, u.student_no, u.username, u.email,
            u.role, u.course, u.deleted_at,
            SUM(t.ticket_status='completed') AS completed,
            SUM(t.ticket_status IN ('cancelled','no-show')) AS cancelled,
            SUM(t.ticket_status IN ('waiting','called','serving')) AS pending,
            COUNT(*) AS total, MAX(t.requested_at) AS last_at
     ${from}
     GROUP BY u.id
     ORDER BY ${HISTORY_SORT[f.sort || 'name'].replace(/\bD\b/g, f.dir === 'desc' ? 'DESC' : 'ASC')}
     LIMIT ${pg.perPage} OFFSET ${pg.offset}`, p);
  return {
    pg,
    rows: rows.map(r => ({
      id: r.id, role: r.role, deleted: !!r.deleted_at,
      fullName: fullName(r),
      studentNo: r.student_no || '', login: r.username || r.email || '', course: r.course || '',
      completed: Number(r.completed) || 0, cancelled: Number(r.cancelled) || 0,
      pending: Number(r.pending) || 0, total: Number(r.total) || 0, lastAt: r.last_at,
    })),
  };
}

/** One person's tickets (newest first) with the same filters, plus their totals. */
async function getHistoryForClient(userId, f, page = 1) {
  const u = await q('SELECT * FROM users WHERE id=?', [userId]);
  if (!u.length) return null;
  const { w, p } = historyWhere(f);
  w.unshift('t.user_id=?'); p.unshift(userId);
  const where = 'WHERE ' + w.join(' AND ');
  const [c] = await q(
    `SELECT COUNT(*) AS n, SUM(t.ticket_status='completed') AS completed,
            SUM(t.ticket_status IN ('cancelled','no-show')) AS cancelled,
            SUM(t.ticket_status IN ('waiting','called','serving')) AS pending,
            IFNULL(SUM(CASE WHEN t.payment_status='paid' THEN t.amount_due END),0) AS paid
     FROM transactions t ${where}`, p);
  const pg = paging.paging(c.n, page);
  const rows = (await q(
    `${TX_SELECT} ${where} ORDER BY t.requested_at DESC, t.id DESC LIMIT ${pg.perPage} OFFSET ${pg.offset}`, p)).map(mapTx);
  await attachDocuments(rows);
  return {
    user: mapUser(u[0]), pg, rows,
    totals: { all: Number(c.n) || 0, completed: Number(c.completed) || 0, cancelled: Number(c.cancelled) || 0,
              pending: Number(c.pending) || 0, paid: Number(c.paid) || 0 },
  };
}

// ── REPORT BUILDER ───────────────────────────────────────────────────────────
// The user picks a report type and filters; only matching records are read,
// filtered in SQL (historyWhere), one page at a time unless exporting.
const REPORT_TYPES = {
  transactions: 'Transactions',
  payments:     'Payments & receipts',
  documents:    'Summary by document',
  staff:        'Summary by staff',
};

/** Filters for the builder: the history filters plus a client search on the ticket. */
function reportWhere(f) {
  const { w, p } = historyWhere(f);
  if (f.q) {
    const like = `%${f.q}%`;
    w.push(`(CONCAT_WS(' ', t.first_name, t.middle_name, t.last_name) LIKE ? OR t.student_no LIKE ? OR t.ticket_no LIKE ?
             OR EXISTS (SELECT 1 FROM users ru WHERE ru.id=t.user_id AND (ru.username LIKE ? OR ru.email LIKE ?)))`);
    p.push(like, like, like, like, like);
  }
  return { where: w.length ? 'WHERE ' + w.join(' AND ') : '', p };
}

/**
 * Run one report. limit = { page } for the screen, or { all: true } for print
 * and CSV (capped at 5000 rows so a careless export cannot exhaust the server).
 */
async function runReport(type, f, { page = 1, all = false } = {}) {
  if (!REPORT_TYPES[type]) type = 'transactions';
  const { where, p } = reportWhere(f);
  const cap = 5000;

  if (type === 'transactions') {
    const [c] = await q(
      `SELECT COUNT(*) AS n, SUM(t.ticket_status='completed') AS completed,
              SUM(t.ticket_status IN ('cancelled','no-show')) AS cancelled,
              SUM(t.ticket_status IN ('waiting','called','serving')) AS pending,
              IFNULL(SUM(CASE WHEN t.payment_status='paid' THEN t.amount_due END),0) AS paid
       FROM transactions t ${where}`, p);
    const pg = paging.paging(c.n, all ? 1 : page, all ? Math.min(cap, Math.max(1, c.n)) : paging.PER_PAGE);
    const rows = (await q(`${TX_SELECT} ${where} ORDER BY t.requested_at DESC, t.id DESC
                           LIMIT ${pg.perPage} OFFSET ${pg.offset}`, p)).map(mapTx);
    await attachDocuments(rows);
    return { type, rows, pg, totals: { count: Number(c.n) || 0, completed: Number(c.completed) || 0,
             cancelled: Number(c.cancelled) || 0, pending: Number(c.pending) || 0, paid: Number(c.paid) || 0 } };
  }

  if (type === 'payments') {
    const pw = `${where ? where + ' AND' : 'WHERE'} pa.status='paid'`;
    const [c] = await q(
      `SELECT COUNT(*) AS n, IFNULL(SUM(pa.amount),0) AS amount
       FROM payments pa JOIN transactions t ON t.id=pa.transaction_id ${pw}`, p);
    const pg = paging.paging(c.n, all ? 1 : page, all ? Math.min(cap, Math.max(1, c.n)) : paging.PER_PAGE);
    const rows = await q(
      `SELECT pa.amount, pa.paid_at, pa.staff_name AS cashier, pa.window_label, r.receipt_no,
              t.id, t.ticket_no, t.first_name, t.middle_name, t.last_name, t.student_no,
              (SELECT GROUP_CONCAT(td.document_name ORDER BY td.id SEPARATOR ', ')
                 FROM transaction_documents td WHERE td.transaction_id=t.id) AS documents
       FROM payments pa JOIN transactions t ON t.id=pa.transaction_id
       LEFT JOIN receipts r ON r.payment_id=pa.id
       ${pw} ORDER BY pa.paid_at DESC, pa.id DESC LIMIT ${pg.perPage} OFFSET ${pg.offset}`, p);
    return { type, pg, totals: { count: Number(c.n) || 0, amount: Number(c.amount) || 0 },
      rows: rows.map(r => ({ receiptNo: r.receipt_no || '', paidAt: r.paid_at, amount: Number(r.amount),
        cashier: r.cashier || '', window: r.window_label || '', ticketNo: r.ticket_no, txId: r.id,
        client: [r.first_name, r.middle_name, r.last_name].filter(Boolean).join(' '),
        studentNo: r.student_no || '', documents: r.documents || '' })) };
  }

  if (type === 'documents') {
    const rows = await q(
      `SELECT td.document_name AS name, t.department,
              COUNT(*) AS requests, SUM(td.copies) AS copies,
              SUM(t.ticket_status='completed') AS completed,
              SUM(t.ticket_status IN ('cancelled','no-show')) AS cancelled,
              IFNULL(SUM(CASE WHEN t.payment_status='paid' THEN td.price END),0) AS collected
       FROM transaction_documents td JOIN transactions t ON t.id=td.transaction_id
       ${where} GROUP BY td.document_name, t.department ORDER BY requests DESC, name`, p);
    const list = rows.map(r => ({ name: r.name, department: r.department, requests: Number(r.requests),
      copies: Number(r.copies) || 0, completed: Number(r.completed) || 0, cancelled: Number(r.cancelled) || 0,
      collected: Number(r.collected) || 0 }));
    return { type, rows: list, pg: null, totals: {
      requests: list.reduce((s, r) => s + r.requests, 0), collected: list.reduce((s, r) => s + r.collected, 0) } };
  }

  // staff
  const sw = `${where ? where + ' AND' : 'WHERE'} t.staff_id IS NOT NULL`;
  const rows = await q(
    `SELECT t.staff_id, MAX(t.staff_name) AS name, t.department,
            COUNT(*) AS handled, SUM(t.ticket_status='completed') AS completed,
            SUM(t.ticket_status IN ('cancelled','no-show')) AS cancelled,
            ROUND(AVG(CASE WHEN t.ticket_status='completed' THEN t.actual_minutes END),1) AS avg_min,
            IFNULL(SUM(CASE WHEN t.payment_status='paid' THEN t.amount_due END),0) AS collected
     FROM transactions t ${sw} GROUP BY t.staff_id, t.department ORDER BY handled DESC, name`, p);
  const list = rows.map(r => ({ name: r.name || 'Staff #' + r.staff_id, department: r.department,
    handled: Number(r.handled), completed: Number(r.completed) || 0, cancelled: Number(r.cancelled) || 0,
    avgMin: r.avg_min === null ? null : Number(r.avg_min), collected: Number(r.collected) || 0 }));
  return { type, rows: list, pg: null, totals: {
    handled: list.reduce((s, r) => s + r.handled, 0), collected: list.reduce((s, r) => s + r.collected, 0) } };
}

/** Choices for the history/report filter menus (documents and staff seen in tickets). */
async function getHistoryChoices(office = null) {
  const docs = await q(
    `SELECT id, name, office, deleted_at FROM documents ${office ? 'WHERE office=?' : ''} ORDER BY office, name`,
    office ? [office] : []);
  const staff = await q(
    `SELECT DISTINCT t.staff_id AS id, t.staff_name AS name, t.department
     FROM transactions t WHERE t.staff_id IS NOT NULL ${office ? 'AND t.department=?' : ''}
     ORDER BY t.staff_name`, office ? [office] : []);
  return {
    documents: docs.map(d => ({ id: d.id, name: d.name + (d.deleted_at ? ' (deleted)' : ''), office: d.office })),
    staff: staff.map(s => ({ id: s.id, name: s.name || 'Staff #' + s.id, department: s.department })),
  };
}

// ── ADMIN: MANAGE STAFF ACCOUNTS ─────────────────────────────────────────────
/**
 * One page of staff accounts (admin, cashier, registrar), searchable by name,
 * username or contact, filterable by role and status. Passwords are never
 * returned: only whether one is set and whether a reset is pending.
 */
async function getStaffPage({ search = '', role = '', status = '', page = 1 } = {}) {
  const where = ["u.role IN ('admin','cashier','registrar')", 'u.deleted_at IS NULL'], p = [];
  if (['admin', 'cashier', 'registrar'].includes(role)) { where.push('u.role=?'); p.push(role); }
  if (status === 'active' || status === 'disabled') { where.push('u.status=?'); p.push(status); }
  if (search) {
    where.push(`(CONCAT_WS(' ', u.first_name, u.middle_name, u.last_name) LIKE ? OR u.username LIKE ? OR u.contact_no LIKE ?)`);
    const like = `%${search}%`; p.push(like, like, like);
  }
  const w = where.join(' AND ');
  const [{ n }] = await q(`SELECT COUNT(*) AS n FROM users u WHERE ${w}`, p);
  const pg = paging.paging(n, page);
  const rows = await q(
    `SELECT u.*, w.label AS window_label FROM users u LEFT JOIN windows w ON w.id = u.window_id
     WHERE ${w} ORDER BY FIELD(u.role,'admin','cashier','registrar'), u.last_name, u.first_name
     LIMIT ${pg.perPage} OFFSET ${pg.offset}`, p);
  return { rows: rows.map(r => ({ ...mapUser(r), windowLabel: r.window_label || '' })), pg };
}

/**
 * Admin edits a cashier/registrar account: name, username, role, window,
 * contact and status. The member is signed out so the change (a new role or
 * window especially) applies from their next login, everywhere.
 */
async function updateStaffAccount(admin, id, b) {
  const r = await q("SELECT * FROM users WHERE id=? AND role IN ('cashier','registrar') AND deleted_at IS NULL", [id]);
  if (!r.length) return { error: 'Staff account not found.' };
  const first = String(b.firstName || '').trim(), last = String(b.lastName || '').trim();
  const username = String(b.username || '').trim();
  if (!first || !last) return { error: 'First and last name are required.' };
  if (!/^[A-Za-z0-9._-]{3,60}$/.test(username))
    return { error: 'Username must be 3-60 letters, numbers, dots, dashes or underscores.' };
  if ((await q('SELECT id FROM users WHERE username=? AND id<>?', [username, id])).length)
    return { error: 'That username is already used by another account.' };
  const role = b.role === 'registrar' ? 'registrar' : b.role === 'cashier' ? 'cashier' : null;
  if (!role) return { error: 'Choose Cashier or Registrar.' };
  const status = b.status === 'disabled' ? 'disabled' : 'active';
  const contact = String(b.contactNo || '').trim();
  if (contact && !/^[0-9+\-\s]{7,20}$/.test(contact)) return { error: 'Enter a valid contact number.' };

  let windowId = b.windowId ? Number(b.windowId) : null;
  if (windowId) {
    const win = await q('SELECT department FROM windows WHERE id=?', [windowId]);
    if (!win.length) return { error: 'That window does not exist.' };
    if (win[0].department.toLowerCase() !== role)
      return { error: `A ${role} can only be posted to a ${role === 'cashier' ? 'Cashier' : 'Registrar'} window.` };
  }
  const busy = await q(`SELECT ticket_no FROM transactions WHERE staff_id=? AND ticket_status IN ('called','serving') LIMIT 1`, [id]);
  if (busy.length && (role !== r[0].role || status === 'disabled'))
    return { error: `They are serving ${busy[0].ticket_no} right now. Finish or cancel it first.` };

  if (windowId) await run('UPDATE users SET window_id=NULL WHERE window_id=? AND id<>?', [windowId, id]);
  await run(
    `UPDATE users SET first_name=?, middle_name=?, last_name=?, username=?, role=?, window_id=?,
       contact_no=?, status=?, failed_logins=IF(?='active',0,failed_logins), locked_until=IF(?='active',NULL,locked_until)
     WHERE id=?`,
    [first, String(b.middleName || '').trim() || null, last, username, role, windowId,
     contact || null, status, status, status, id]);
  await signOutUser(id);
  return { ok: true, user: await getUser(id) };
}

/** A random password that meets the password rules (upper, lower, digit, symbol). */
function temporaryPassword() {
  const sets = ['ABCDEFGHJKLMNPQRSTUVWXYZ', 'abcdefghijkmnpqrstuvwxyz', '23456789', '#@$%&*!?'];
  const pick = s => s[crypto.randomInt(s.length)];
  const chars = sets.map(pick);                       // one of each kind
  const all = sets.join('');
  while (chars.length < 10) chars.push(pick(all));
  for (let i = chars.length - 1; i > 0; i--) {        // shuffle
    const j = crypto.randomInt(i + 1); [chars[i], chars[j]] = [chars[j], chars[i]];
  }
  return chars.join('');
}

/**
 * Admin resets a cashier/registrar password: a temporary password is set
 * (stored only as a hash), returned once for the admin to hand over, and the
 * member must choose their own at the next login. Any lockout is cleared and
 * the member is signed out everywhere.
 */
async function resetStaffPassword(admin, id) {
  const r = await q("SELECT * FROM users WHERE id=? AND role IN ('cashier','registrar') AND deleted_at IS NULL", [id]);
  if (!r.length) return { error: 'Staff account not found.' };
  const temp = temporaryPassword();
  await run(
    `UPDATE users SET password=?, must_change_password=1, password_changed_at=NOW(),
       failed_logins=0, locked_until=NULL, status=IF(status='locked','active',status) WHERE id=?`,
    [await auth.hashPassword(temp), id]);
  await signOutUser(id);
  return { ok: true, temp, name: mapUser(r[0]).fullName, username: r[0].username };
}

/** Cashier/registrar edit their own name and contact number. */
async function updateStaffProfile(id, b) {
  const first = String(b.firstName || '').trim(), last = String(b.lastName || '').trim();
  if (!first || !last) return { error: 'First and last name are required.' };
  const contact = String(b.contactNo || '').trim();
  if (contact && !/^[0-9+\-\s]{7,20}$/.test(contact)) return { error: 'Enter a valid contact number.' };
  await run(`UPDATE users SET first_name=?, middle_name=?, last_name=?, contact_no=? WHERE id=?`,
            [first, String(b.middleName || '').trim() || null, last, contact || null, id]);
  return { ok: true, user: await getUser(id) };
}

async function setUserActive(id, active) {
  await run(`UPDATE users SET status=?, failed_logins=0, locked_until=NULL WHERE id=?`,
            [active ? 'active' : 'disabled', id]);
  return { ok: true };
}
async function createStaff(b) {
  if (!b.username || !b.password || !b.firstName || !b.lastName)
    return { error: 'Username, password, first name and last name are required.' };
  // Admin accounts are not created here; use database/create-admin.js.
  if (!['cashier','registrar'].includes(b.role)) return { error: 'Invalid role.' };
  const pwError = auth.checkPassword(b.password);
  if (pwError) return { error: pwError };
  const dupe = await q('SELECT id FROM users WHERE username=?', [b.username.trim()]);
  if (dupe.length) return { error: 'That username is already taken.' };
  // Staff have no email on file, so they are active and verified at once.
  await run(
    `INSERT INTO users (username,password,role,first_name,middle_name,last_name,contact_no,window_id,
                        auth_provider,email_verified,status)
     VALUES (?,?,?,?,?,?,?,?,'local',1,'active')`,
    [b.username.trim(), await auth.hashPassword(b.password), b.role, b.firstName.trim(),
     (b.middleName || '').trim() || null, b.lastName.trim(),
     (b.contactNo || '').trim() || null, b.windowId ? +b.windowId : null]);
  return { ok: true };
}

// ── ADMIN: REPORTS ───────────────────────────────────────────────────────────
async function getReports(from, to) {
  const f = from || today(), t = to || today();
  const range = [f, t];

  const [summary] = await q(
    `SELECT COUNT(*) AS total,
       SUM(department='Cashier')                 AS cashier,
       SUM(department='Registrar')               AS registrar,
       SUM(ticket_status='completed')            AS completed,
       SUM(ticket_status IN ('cancelled','no-show')) AS cancelled,
       SUM(queue_category='priority')            AS priority,
       SUM(queue_category='regular')             AS regular,
       SUM(client_type='guest')                  AS guests,
       SUM(is_scheduled=1)                       AS scheduled,
       ROUND(AVG(actual_minutes),1)              AS avg_service,
       ROUND(AVG(TIMESTAMPDIFF(MINUTE, COALESCE(queue_at, requested_at), called_at)),1) AS avg_wait
     FROM transactions WHERE service_date BETWEEN ? AND ?`, range);

  const [money] = await q(
    `SELECT COUNT(*) AS payments, IFNULL(SUM(p.amount),0) AS collected
     FROM payments p JOIN transactions t ON t.id=p.transaction_id
     WHERE p.status='paid' AND t.service_date BETWEEN ? AND ?`, range);

  const items = await q(
    `SELECT td.document_name AS name, COUNT(*) AS n, IFNULL(SUM(td.price),0) AS amount
     FROM transaction_documents td JOIN transactions t ON t.id=td.transaction_id
     WHERE t.service_date BETWEEN ? AND ?
     GROUP BY td.document_name ORDER BY n DESC`, range);

  const byStaff = await q(
    `SELECT staff_name AS name, department, COUNT(*) AS n,
            ROUND(AVG(actual_minutes),1) AS avg_min
     FROM transactions
     WHERE staff_name IS NOT NULL AND service_date BETWEEN ? AND ?
     GROUP BY staff_name, department ORDER BY n DESC`, range);

  const byWindow = await q(
    `SELECT window_label AS name, department, COUNT(*) AS n
     FROM transactions
     WHERE window_label IS NOT NULL AND service_date BETWEEN ? AND ?
     GROUP BY window_label, department ORDER BY n DESC`, range);

  const daily = await q(
    `SELECT service_date AS d, COUNT(*) AS n,
            SUM(department='Cashier')   AS cashier,
            SUM(department='Registrar') AS registrar
     FROM transactions WHERE service_date BETWEEN ? AND ?
     GROUP BY service_date ORDER BY service_date DESC LIMIT 14`, range);

  const num = v => Number(v) || 0;
  return {
    from: f, to: t,
    summary: {
      total: num(summary.total), cashier: num(summary.cashier),
      registrar: num(summary.registrar), completed: num(summary.completed),
      cancelled: num(summary.cancelled), priority: num(summary.priority),
      regular: num(summary.regular), guests: num(summary.guests),
      scheduled: num(summary.scheduled),
      avgService: num(summary.avg_service), avgWait: num(summary.avg_wait),
      payments: num(money.payments), collected: Number(money.collected) || 0,
    },
    items:   items.map(i => ({ name: i.name, count: num(i.n), amount: Number(i.amount) })),
    byStaff: byStaff.map(s => ({ name: s.name, department: s.department, count: num(s.n), avgMin: num(s.avg_min) })),
    byWindow: byWindow.map(w => ({ name: w.name, department: w.department, count: num(w.n) })),
    daily:   daily.map(d => ({ date: ymd(new Date(d.d)), count: num(d.n),
                               cashier: num(d.cashier), registrar: num(d.registrar) })),
  };
}

async function getHistory(txId) {
  return await q(
    `SELECT * FROM queue_history WHERE transaction_id=? ORDER BY created_at ASC`, [txId]);
}

module.exports = {
  today, tomorrow, addDays, ymd, addMinutes,
  slotsUsed,
  PURPOSES, PRIORITY_TYPES, COURSES, isCourse,
  getSettings, saveSettings,
  verifyCredentials, registerLocal, activateAccount, findByEmail,
  usernameTaken, emailTaken, setPassword, updateEmail, checkCurrentPassword, getUser, updateProfile, changePassword, getPermissions,
  findOrCreateGoogleUser, needsProfile, completeProfile, setInitialPassword,
  createPriorityRequest, getPriorityRequests, getPriorityRequest,
  getUserPriorityRequests, decidePriorityRequest, revokePriority, PRIORITY_LABELS,
  createTicketPriorityRequest, getTicketPriorityRequest, countPendingPriority, getPriorityProof,
  getDocuments, getDocument, saveDocument, saveDocumentAsStaff,
  getDocumentRequirements, getRequirementsByDocument,
  addDocumentRequirement, deleteDocumentRequirement,
  getTransactionRequirements, setTransactionRequirements, getRequirementsForClaim,
  getServiceAverages, estimateMinutes, getEstimationTable, resetLearning, learningStatus, rememberedPriority, noteRememberedPriority, PRIORITY_REMEMBER_DAYS,
  predict, peak,
  getWindows, createWindow, updateWindow,
  getCalendarMonth, getDayBookings, setDayOverride, getDayOverrides,
  validateSchedule, createRequest, longDate,
  getTransaction, getUserTransactions, getQueue, getBlockingTransaction,
  getActiveByDepartment,
  findOrCreateWalkIn, getTransactionByToken, findTicketByCode, moveToRegular, rebookTicket,
  setHold, clearHold, missedTurn, findActiveGuestTicket,
  pickNextTicket, callNext, acceptTicket,
  processPayment, completeCashier, completeRegistrar, cancelTicket,
  recallTicket, announce, latestAnnouncement, latestAnnouncementFor,
  processAutoCancel, getTimeLeft, getLoad, todayAverageWait, getClaimableLines, clock12, cancelByStudent, isPastClosing, isBreakTime, releaseDate, getReleaseInfo, findClaimables, findClaimablesByCode, bookClaim, releasesDue, releaseOutlook, expectedClaimsToday, CLAIM_SHOW_RATE, joinOpensAt, isBeforeJoinOpens,
  announcementPulse, announcementPulseFor, payAndComplete,
  deleteDocument, deleteWindow, deleteAccount, updateStaffProfile,
  signOutUser, getStaffPage, updateStaffAccount, resetStaffPassword,
  historyFilters, getHistoryClients, getHistoryForClient, getHistoryChoices, HISTORY_STATUS,
  REPORT_TYPES, runReport,
  getReceipt, getUsers, getStaffAccounts,
  getAssignableStaff, setUserActive, createStaff,
  getReports, getHistory,
};
