'use strict';
const crypto = require('crypto');
const pool   = require('../database/connection');
const auth   = require('./auth');
const predict = require('./prediction');
const peak    = require('./peak');

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

const PURPOSES = ['Transfer','Personal Reference','Job Purposes',
                  'Board Examination',"Graduation / Dean's List",'Others'];
const PRIORITY_TYPES = ['pwd','senior','pregnant'];
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
  };
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
    fullName: [u.first_name, u.middle_name, u.last_name].filter(Boolean).join(' '),
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

  await run(
    `UPDATE users SET email=?,first_name=?,middle_name=?,last_name=?,contact_no=?,
       student_no=?,course=?,year_level=?,academic_year=? WHERE id=?`,
    [ b.email.trim().toLowerCase(), b.firstName.trim(),
      (b.middleName || '').trim() || null, b.lastName.trim(),
      (b.contactNo || '').trim() || null,
      (b.studentNo || '').trim() || null,
      b.course || null, b.yearLevel ? +b.yearLevel : null,
      (b.academicYear || '').trim() || null, id ]
  );
  return getUser(id);
}

/** True when a student account still needs course / year level. */
function needsProfile(u) {
  return u && u.role === 'student' && (!u.course || !u.yearLevel);
}

/** Finish the profile after signing in with Google for the first time. */
async function completeProfile(id, b) {
  const role = b.role === 'guest' ? 'guest' : 'student';
  if (!b.firstName || !b.lastName) return { error: 'First and last name are required.' };
  if (role === 'student' && (!b.course || !b.yearLevel))
    return { error: 'Course and year level are required for a student account.' };
  if (role === 'student' && !isCourse(b.course))
    return { error: 'Please choose one of the courses offered by the college.' };

  const s = await getSettings();
  await run(
    `UPDATE users SET role=?, first_name=?, middle_name=?, last_name=?, contact_no=?,
       student_no=?, course=?, year_level=?, academic_year=? WHERE id=?`,
    [ role, b.firstName.trim(), (b.middleName || '').trim() || null, b.lastName.trim(),
      (b.contactNo || '').trim() || null,
      role === 'student' ? ((b.studentNo || '').trim() || null) : null,
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
              FIELD(queue_category,'priority','regular'), requested_at, id`,
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
    name: r.first_name ? [r.first_name, r.middle_name, r.last_name].filter(Boolean).join(' ') : '',
    email: r.email || '', role: r.role || '', studentNo: r.student_no || '',
    course: r.course || '', yearLevel: r.year_level || null,
  };
}

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

async function getPriorityRequests(status) {
  const rows = await q(
    `SELECT p.*, u.first_name, u.middle_name, u.last_name, u.email, u.role,
            u.student_no, u.course, u.year_level
     FROM priority_requests p JOIN users u ON u.id = p.user_id
     ${status ? 'WHERE p.status = ?' : ''}
     ORDER BY FIELD(p.status,'pending','approved','rejected'), p.created_at DESC`,
    status ? [status] : []);
  return rows.map(mapPriorityRequest);
}

async function getPriorityRequest(id) {
  const r = await q(
    `SELECT p.*, u.first_name, u.middle_name, u.last_name, u.email, u.role,
            u.student_no, u.course, u.year_level
     FROM priority_requests p JOIN users u ON u.id = p.user_id WHERE p.id=?`, [id]);
  return r.length ? mapPriorityRequest(r[0]) : null;
}

async function getUserPriorityRequests(userId) {
  return (await q(
    `SELECT * FROM priority_requests WHERE user_id=? ORDER BY created_at DESC`, [userId]))
    .map(mapPriorityRequest);
}

/** Admin decision. Approving stamps the category onto the user's profile. */
async function decidePriorityRequest(reviewer, id, approve, reason) {
  const pr = await getPriorityRequest(id);
  if (!pr)                       return { error: 'Request not found.' };
  if (pr.status !== 'pending')   return { error: 'This request has already been reviewed.' };
  if (!approve && !String(reason || '').trim())
    return { error: 'Give a reason so the student knows what to fix.' };

  await run(
    `UPDATE priority_requests SET status=?, reason=?, reviewed_by=?, reviewer_name=?, reviewed_at=NOW()
     WHERE id=?`,
    [approve ? 'approved' : 'rejected', approve ? null : String(reason).trim(),
     reviewer.id, reviewer.fullName, id]);

  if (approve) {
    await run(`UPDATE users SET priority_status=?, priority_approved_at=NOW() WHERE id=?`,
              [pr.category, pr.userId]);
  }
  return { ok: true, request: await getPriorityRequest(id) };
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
             failed_logins=0, locked_until=NULL,
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
    baselineMinutes: s.baseline_minutes, isActive: !!s.is_active,
  };
}
async function getDocuments({ activeOnly = true, guestOnly = false, office = null } = {}) {
  let sql = 'SELECT * FROM documents';
  const w = [], p = [];
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
async function saveDocument(id, b) {
  if (!b.name || !String(b.name).trim()) return { error: 'Document name is required.' };
  const price = Number(b.price);
  if (isNaN(price) || price < 0) return { error: 'Price must be zero or greater.' };
  const args = [ b.name.trim(), price, b.paymentRequired ? 1 : 0, b.requiresClaim ? 1 : 0,
                 b.guestAllowed ? 1 : 0, +b.baselineMinutes || 8, b.isActive ? 1 : 0 ];
  if (id) await run(`UPDATE documents SET name=?,price=?,payment_required=?,requires_claim=?,
                     guest_allowed=?,baseline_minutes=?,is_active=?,
                     office=IF(payment_required=1,'Cashier','Registrar') WHERE id=?`, [...args, id]);
  else    await run(`INSERT INTO documents (name,price,payment_required,requires_claim,
                     guest_allowed,baseline_minutes,is_active) VALUES (?,?,?,?,?,?,?)`, args);
    await run(`UPDATE documents SET office=IF(payment_required=1,'Cashier','Registrar') WHERE id=?`,
              [r.insertId]);
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
         baseline_minutes=?, is_active=? WHERE id=? AND office=?`,
      [name, b.requiresClaim ? 1 : 0, b.guestAllowed ? 1 : 0,
       Math.max(1, +b.baselineMinutes || 10), b.isActive ? 1 : 0, id, office]);
    return { ok: true, created: false };
  }

  // A new Cashier document needs a price, which staff cannot set, so it starts
  // at zero and inactive until an admin prices and publishes it.
  const payment = office === 'Cashier' ? 1 : 0;
  const r = await run(
    `INSERT INTO documents (name,price,payment_required,office,requires_claim,
                            guest_allowed,baseline_minutes,is_active)
     VALUES (?,?,?,?,?,?,?,?)`,
    [name, 0, payment, office, b.requiresClaim ? 1 : 0, b.guestAllowed ? 1 : 0,
     Math.max(1, +b.baselineMinutes || 10), office === 'Cashier' ? 0 : (b.isActive ? 1 : 0)]);
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
async function createRequest(user, b) {
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

  // ---- queue category -------------------------------------------------------
  // Priority can no longer be self-selected. It comes from the approved status
  // on the account, which an admin grants after reviewing uploaded proof.
  const approved = await q('SELECT priority_status FROM users WHERE id=?', [user.id]);
  const granted  = approved.length ? approved[0].priority_status : 'none';

  let category = 'regular';
  let pType    = 'none';

  if (b.queueCategory === 'priority') {
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

  // one unfinished ticket per office
  const open = await getBlockingTransaction(user.id, department);
  if (open) {
    return {
      error: `You already have an active ${department} transaction (${open.ticketNo}). ` +
             'Finish it before requesting another number for this office.',
      blockedBy: open,
    };
  }

  // ---- claiming a released document ------------------------------------------
  // Only documents already paid at the Cashier can be claimed, and each paid
  // document only once. The student ticks which ones this ticket collects.
  let claimLineIds = [];
  if (items.some(isClaimDocument)) {
    const available = await getClaimableLines(user.id);
    if (!available.length) {
      const cashierOpen = await getBlockingTransaction(user.id, 'Cashier');
      return { error: cashierOpen && cashierOpen.paymentStatus !== 'paid'
        ? `Finish your payment at the Cashier first (${cashierOpen.ticketNo}). ` +
          'You can queue at the Registrar to claim it right after.'
        : 'You have no paid documents waiting to be claimed. Pay for the document at the Cashier first.' };
    }
    let picked = b.claimLines;
    if (!Array.isArray(picked)) picked = picked ? [picked] : [];
    picked = [...new Set(picked.map(Number).filter(Boolean))];
    if (!picked.length) return { error: 'Tick which paid document(s) you are claiming.' };
    const ok = new Set(available.map(a => a.id));
    if (picked.some(id => !ok.has(id)))
      return { error: 'One of the documents you ticked is not paid for, or is already being claimed.' };
    claimLineIds = picked;
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

  // Predict the wait now and store it, so accuracy can be measured later.
  let forecast = { wait: null, service: null, source: null };
  try {
    const svc = await predict.estimateService(items, department, s);
    const pos = await predict.positionWait(department, { lane: category });
    forecast = { wait: pos.minutes, service: svc.minutes, source: svc.source };
  } catch (e) { /* a forecast must never block a ticket */ }

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
         predicted_wait,predicted_service,prediction_source)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'waiting',?,?,?,?,?,?,?,?,?,?)`,
      [ ticketNo, department, category, pType, user.id,
        user.role === 'guest' ? 'guest' : 'student',
        String(b.firstName).trim(), String(b.middleName || '').trim() || null,
        String(b.lastName).trim(), String(b.studentNo || '').trim() || null,
        b.course || null, b.yearLevel ? +b.yearLevel : null,
        b.academicYear || s.academicYear,
        rep.claimant, rep.name, rep.relationship, rep.contact, rep.authFile,
        purpose, otherPurpose,
        amount,
        department === 'Cashier' ? 'pending' : 'not_required',
        department === 'Cashier' ? 'pending' : 'waiting_registrar',
        sched.isScheduled, sched.isScheduled ? sched.serviceDate : null,
        sched.serviceDate, token, items.some(i => i.requiresClaim) ? 1 : 0,
        forecast.wait, forecast.service, forecast.source ]
    );
    const txId = ins.insertId;

    for (const it of items) {
      await conn.execute(
        `INSERT INTO transaction_documents (transaction_id,document_id,document_name,unit_price,copies,price)
         VALUES (?,?,?,?,?,?)`,
        [txId, it.id, it.name, it.price, it.copies, it.lineTotal]);

      // snapshot the requirements, for the documents that have any
      const reqs = it.needsRequirements ? await conn.execute(
        `SELECT id,label,is_required FROM document_requirements
         WHERE document_id=? ORDER BY sort_order, id`, [it.id]) : [[]];
      for (const rq of reqs[0]) {
        await conn.execute(
          `INSERT INTO transaction_requirements (transaction_id,requirement_id,label,is_required)
           VALUES (?,?,?,?)`, [txId, rq.id, rq.label, rq.is_required]);
      }
    }
    for (const lineId of claimLineIds) {
      await conn.execute('INSERT INTO claim_items (claim_tx_id,line_id) VALUES (?,?)', [txId, lineId]);
    }
    await conn.execute(
      `INSERT INTO queue_history (transaction_id,ticket_no,action,department,note)
       VALUES (?,?,?,?,?)`,
      [txId, ticketNo, sched.isScheduled ? 'scheduled' : 'requested', department,
       sched.isScheduled ? `Scheduled for ${sched.serviceDate}` : null]);

    await conn.commit();
    return await getTransaction(txId);
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
async function getBlockingTransaction(userId, department = null) {
  const rows = await q(
    `SELECT * FROM transactions
     WHERE user_id = ? AND overall_status NOT IN ('completed','cancelled')
       ${department ? 'AND department = ?' : ''}
     ORDER BY requested_at ASC LIMIT 1`,
    department ? [userId, department] : [userId]);
  if (!rows.length) return null;
  const t = mapTx(rows[0]);
  await attachDocuments([t]);
  return t;
}

// ── READ TRANSACTIONS ────────────────────────────────────────────────────────
function mapTx(t) {
  return {
    id: t.id, ticketNo: t.ticket_no, department: t.department,
    queueCategory: t.queue_category, priorityType: t.priority_type,
    userId: t.user_id, clientType: t.client_type,
    firstName: t.first_name, middleName: t.middle_name || '', lastName: t.last_name,
    fullName: [t.first_name, t.middle_name, t.last_name].filter(Boolean).join(' '),
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
  };
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
    `SELECT ci.claim_tx_id, td.document_name, td.copies, pt.ticket_no AS paid_ticket, r.receipt_no
     FROM claim_items ci
     JOIN transaction_documents td ON td.id = ci.line_id
     JOIN transactions pt ON pt.id = td.transaction_id
     LEFT JOIN receipts r ON r.transaction_id = pt.id
     WHERE ci.claim_tx_id IN (${ids.map(() => '?').join(',')})
     ORDER BY ci.id`, ids);
  const cl = {};
  claims.forEach(c => (cl[c.claim_tx_id] = cl[c.claim_tx_id] || []).push({
    name: c.document_name, copies: Number(c.copies) || 1,
    paidTicket: c.paid_ticket, receiptNo: c.receipt_no || '',
  }));
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
async function getClaimableLines(userId) {
  const rows = await q(
    `SELECT td.id, td.document_name, td.copies, t.ticket_no, r.receipt_no, p.paid_at
     FROM transaction_documents td
     JOIN transactions t ON t.id = td.transaction_id
     JOIN documents d    ON d.id = td.document_id
     LEFT JOIN payments p ON p.transaction_id = t.id AND p.status = 'paid'
     LEFT JOIN receipts r ON r.transaction_id = t.id
     WHERE t.user_id = ? AND t.department = 'Cashier' AND t.payment_status = 'paid'
       AND d.requires_claim = 1
       AND NOT EXISTS (
         SELECT 1 FROM claim_items ci JOIN transactions c ON c.id = ci.claim_tx_id
         WHERE ci.line_id = td.id AND c.ticket_status NOT IN ('cancelled','no-show'))
     ORDER BY p.paid_at DESC, td.id`, [userId]);
  return rows.map(r => ({
    id: r.id, name: r.document_name, copies: Number(r.copies) || 1,
    paidTicket: r.ticket_no, receiptNo: r.receipt_no || '',
    paidAt: r.paid_at ? ymd(new Date(r.paid_at)) : null,
  }));
}

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
     ORDER BY t.requested_at ASC, t.id ASC`, [department, d])).map(mapTx);
  return attachDocuments(list);
}

// ── ALTERNATING QUEUE LOGIC ──────────────────────────────────────────────────
/**
 * Priority -> Regular -> Priority -> Regular, per department.
 * Falls through to whichever lane has tickets when one is empty.
 * Decides from what was actually called today, so it survives restarts.
 */
async function pickNextTicket(department) {
  const d = today();

  const head = async cat => {
    const r = await q(
      `SELECT * FROM transactions
       WHERE department=? AND service_date=? AND ticket_status='waiting'
         AND queue_category=?
       ORDER BY requested_at ASC, id ASC LIMIT 1`, [department, d, cat]);
    return r[0] || null;
  };

  const nextPriority = await head('priority');
  const nextRegular  = await head('regular');

  if (!nextPriority && !nextRegular) return null;
  if (!nextRegular)  return nextPriority;
  if (!nextPriority) return nextRegular;

  // both lanes have tickets — alternate based on the last one called.
  // called_at is whole-second precision, so ties are broken by id to keep the
  // alternation deterministic when several tickets are called in the same second.
  const last = await q(
    `SELECT queue_category FROM transactions
     WHERE department=? AND service_date=? AND called_at IS NOT NULL
     ORDER BY called_at DESC, id DESC LIMIT 1`, [department, d]);

  const lastCat = last.length ? last[0].queue_category : 'regular';
  return lastCat === 'priority' ? nextRegular : nextPriority;
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
  const win = await pickWindow(department, staff);
  if (!win)       return { error: 'No window is open and free right now.' };
  if (win.error)  return { error: win.error };

  const t = await pickNextTicket(department);
  if (!t) return { error: 'There are no clients waiting in this queue.' };

  await run(
    `UPDATE transactions SET ticket_status='called', called_at=NOW(),
       staff_id=?, staff_name=?, window_id=?, window_label=?,
       overall_status=CASE WHEN department='Cashier' THEN 'cashier_processing'
                           ELSE 'registrar_processing' END
     WHERE id=?`,
    [staff.id, staff.fullName, win.id, win.label, t.id]);
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
       `Paid PHP ${t.amountDue.toFixed(2)} — ${receiptNo}`]);

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

  // 4. Never called at all. A queue number the client took and abandoned would
  //    otherwise sit as "pending" forever, which is what students were seeing.
  //    Scheduled tickets are left alone until the day they are for.
  const expired = await run(
    `UPDATE transactions SET ticket_status='cancelled', overall_status='cancelled',
       cancel_reason='Expired: not attended', completed_at=NOW()
     WHERE ticket_status='waiting' AND payment_status <> 'paid'
       AND service_date <= CURDATE()
       AND TIMESTAMPDIFF(MINUTE, requested_at, NOW()) >= ?`,
    [s.expireWaitingMinutes]);

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
  return (await q(`SELECT * FROM users ORDER BY FIELD(role,'admin','cashier','registrar','student','guest'), last_name`))
    .map(mapUser);
}

/** Staff and admin accounts only. */
async function getStaffAccounts() {
  return (await q(
    `SELECT * FROM users WHERE role IN ('admin','cashier','registrar')
     ORDER BY FIELD(role,'admin','cashier','registrar'), last_name`)).map(mapUser);
}

/** Student and guest accounts only, with how many transactions each has made. */
async function getClientAccounts({ search = '', role = '' } = {}) {
  const where = ["u.role IN ('student','guest')"];
  const params = [];
  if (role === 'student' || role === 'guest') { where.push('u.role = ?'); params.push(role); }
  if (search) {
    where.push(`(u.first_name LIKE ? OR u.last_name LIKE ? OR u.email LIKE ? OR u.student_no LIKE ?)`);
    const like = `%${search}%`;
    params.push(like, like, like, like);
  }
  const rows = await q(
    `SELECT u.*,
            (SELECT COUNT(*) FROM transactions t WHERE t.user_id = u.id) AS tx_count,
            (SELECT MAX(t.requested_at) FROM transactions t WHERE t.user_id = u.id) AS last_tx
     FROM users u WHERE ${where.join(' AND ')}
     ORDER BY u.last_name, u.first_name`, params);
  return rows.map(r => ({
    ...mapUser(r),
    txCount: Number(r.tx_count) || 0,
    lastTx: r.last_tx || null,
  }));
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
       ROUND(AVG(TIMESTAMPDIFF(MINUTE, requested_at, called_at)),1) AS avg_wait
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
  getDocuments, getDocument, saveDocument, saveDocumentAsStaff,
  getDocumentRequirements, getRequirementsByDocument,
  addDocumentRequirement, deleteDocumentRequirement,
  getTransactionRequirements, setTransactionRequirements,
  getServiceAverages, estimateMinutes, getEstimationTable,
  predict, peak,
  getWindows, createWindow, updateWindow,
  getCalendarMonth, getDayBookings, setDayOverride, getDayOverrides,
  validateSchedule, createRequest,
  getTransaction, getUserTransactions, getQueue, getBlockingTransaction,
  getActiveByDepartment,
  pickNextTicket, callNext, acceptTicket,
  processPayment, completeCashier, completeRegistrar, cancelTicket,
  recallTicket, announce, latestAnnouncement, latestAnnouncementFor,
  processAutoCancel, getTimeLeft, getLoad, getClaimableLines,
  getReceipt, getUsers, getStaffAccounts, getClientAccounts,
  getAssignableStaff, setUserActive, createStaff,
  getReports, getHistory,
};
