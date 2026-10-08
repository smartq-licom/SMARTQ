'use strict';
const express = require('express');
const router  = express.Router();
const db      = require('../data/db');
const paging  = require('../data/paging');
const reportBuilder = require('./report-builder');

router.get('/dashboard', async (req, res, next) => {
  try {
    const [load, windows, reports, cashierQ, registrarQ] = await Promise.all([
      db.getLoad(), db.getWindows(), db.getReports(), db.getQueue('Cashier'), db.getQueue('Registrar'),
    ]);
    res.render('pages/admin/dashboard', {
      title: 'Admin Dashboard', load, windows, reports,
      recent: [...cashierQ, ...registrarQ]
        .sort((a, b) => new Date(b.requestedAt) - new Date(a.requestedAt)).slice(0, 10),
    });
  } catch (e) { next(e); }
});

router.get('/documents', async (req, res, next) => {
  try {
    res.render('pages/admin/documents', {
      title: 'Documents & Prices',
      documents: await db.getDocuments({ activeOnly: false }),
    });
  } catch (e) { next(e); }
});

// Delete: a document used by old tickets is hidden but kept; an unused one is removed.
router.post('/documents/:id/delete', async (req, res, next) => {
  try {
    const r = await db.deleteDocument(Number(req.params.id));
    if (r.error) req.session.error = r.error; else req.session.flash = `"${r.name}" was deleted.`;
    res.redirect('/admin/documents');
  } catch (e) { next(e); }
});

router.post('/documents/:id?', async (req, res, next) => {
  try {
    const b = { ...req.body,
      paymentRequired: req.body.paymentRequired === 'on' || req.body.paymentRequired === '1',
      requiresClaim:   req.body.requiresClaim === 'on' || req.body.requiresClaim === '1',
      guestAllowed:    req.body.guestAllowed === 'on' || req.body.guestAllowed === '1',
      isActive:        req.body.isActive === 'on' || req.body.isActive === '1' };
    const r = await db.saveDocument(req.params.id ? +req.params.id : null, b);
    if (r.error) req.session.error = r.error;
    else req.session.flash = 'Document saved.';
    res.redirect('/admin/documents');
  } catch (e) { next(e); }
});

// Staff and admin accounts
// Requirements per document
router.get('/requirements', async (req, res, next) => {
  try {
    const all = await db.getDocuments({ activeOnly: false });
    const documents = all.filter(function (d) { return d.needsRequirements; });
    const byDocument = await db.getRequirementsByDocument();
    res.render('pages/admin/requirements', {
      title: 'Document Requirements', documents, byDocument,
    });
  } catch (e) { next(e); }
});

router.post('/requirements', async (req, res, next) => {
  try {
    const r = await db.addDocumentRequirement({
      ...req.body,
      isRequired: req.body.isRequired === 'on' || req.body.isRequired === '1',
    });
    if (r.error) req.session.error = r.error;
    else req.session.flash = 'Requirement added.';
    res.redirect('/admin/requirements');
  } catch (e) { next(e); }
});

router.post('/requirements/:id/delete', async (req, res, next) => {
  try {
    await db.deleteDocumentRequirement(req.params.id);
    req.session.flash = 'Requirement removed.';
    res.redirect('/admin/requirements');
  } catch (e) { next(e); }
});

// ── Manage Staff Accounts: list (searchable, 20 per page), edit, reset password
router.get('/users', async (req, res, next) => {
  try {
    const filters = { search: String(req.query.q || '').trim(), role: req.query.role || '', status: req.query.status || '' };
    const { rows, pg } = await db.getStaffPage({ ...filters, page: paging.pageFrom(req.query) });
    const tempPassword = req.session.tempPassword || null;   // shown once after a reset
    delete req.session.tempPassword;
    res.render('pages/admin/users', {
      title: 'Manage Staff Accounts', users: rows, pg, filters, tempPassword,
      windows: await db.getWindows(),
    });
  } catch (e) { next(e); }
});

router.get('/users/:id/edit', async (req, res, next) => {
  try {
    const u = await db.getUser(Number(req.params.id));
    if (!u || u.deleted || !['cashier', 'registrar'].includes(u.role)) {
      req.session.error = 'Only cashier and registrar accounts can be edited here.';
      return res.redirect('/admin/users');
    }
    res.render('pages/admin/user-edit', { title: 'Edit Account', u, form: null, windows: await db.getWindows(), formError: null });
  } catch (e) { next(e); }
});

router.post('/users/:id/edit', async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const r = await db.updateStaffAccount(req.session.user, id, req.body);
    if (r.error) {
      return res.status(400).render('pages/admin/user-edit', {
        title: 'Edit Account', u: await db.getUser(id), form: req.body,
        windows: await db.getWindows(), formError: r.error,
      });
    }
    req.session.flash = `${r.user.fullName}'s account was updated. They will need to sign in again.`;
    res.redirect('/admin/users');
  } catch (e) { next(e); }
});

router.post('/users/:id/reset-password', async (req, res, next) => {
  try {
    const r = await db.resetStaffPassword(req.session.user, Number(req.params.id));
    if (r.error) req.session.error = r.error;
    else req.session.tempPassword = { name: r.name, username: r.username, temp: r.temp };
    res.redirect('/admin/users');
  } catch (e) { next(e); }
});

// Student and guest accounts (kept separate from staff)
router.get('/students', async (req, res, next) => {
  try {
    const search = req.query.search || '';
    const role   = req.query.role   || '';
    const { list, pg, counts } = await db.getClientAccounts({ search, role, page: paging.pageFrom(req.query) });
    res.render('pages/admin/students', { title: 'Student Accounts', list, pg, search, role, counts });
  } catch (e) { next(e); }
});

router.post('/students/:id/active', async (req, res, next) => {
  try {
    await db.setUserActive(req.params.id, req.body.active === '1');
    req.session.flash = 'Account updated.';
    res.redirect('/admin/students');
  } catch (e) { next(e); }
});

router.post('/users/staff', async (req, res, next) => {
  try {
    const r = await db.createStaff(req.body);
    if (r.error) req.session.error = r.error;
    else req.session.flash = 'Staff account created.';
    res.redirect('/admin/users');
  } catch (e) { next(e); }
});

// Delete a staff, student or guest account (never an admin or yourself).
router.post('/users/:id/delete', async (req, res, next) => {
  try {
    const r = await db.deleteAccount(req.session.user, Number(req.params.id));
    if (r.error) req.session.error = r.error;
    else req.session.flash = `${r.name}'s ${r.role} account was deleted.`;
    const back = req.get('referer') || '';
    res.redirect(back.includes('/admin/students') ? '/admin/students' : '/admin/users');
  } catch (e) { next(e); }
});

router.post('/users/:id/active', async (req, res, next) => {
  try {
    await db.setUserActive(req.params.id, req.body.active === '1');
    req.session.flash = 'Account updated.';
    res.redirect('/admin/users');
  } catch (e) { next(e); }
});

// Booking calendar, either office
router.get('/calendar', async (req, res, next) => {
  try {
    const office = ['Cashier', 'Registrar'].includes(req.query.office) ? req.query.office : 'Both';
    const now = new Date();
    const year  = parseInt(req.query.y, 10) || now.getFullYear();
    const month = parseInt(req.query.m, 10) || (now.getMonth() + 1);
    const cal = await db.getCalendarMonth(office, year, month);
    const pick = /^\d{4}-\d{2}-\d{2}$/.test(req.query.d || '') ? req.query.d : null;
    res.render('pages/shared/calendar', {
      title: 'Booking Calendar', office, cal, base: '/admin/calendar',
      canPickOffice: true,
      pickDate: pick,
      bookings: pick ? await db.getDayBookings(office, pick) : null,
      pickDay: pick ? cal.days.find(function (x) { return x && x.date === pick; }) : null,
      // Busy-hour profile for the weekday of the selected date, so whoever is
      // deciding whether to cap or close the day can see what that weekday
      // normally looks like before they set a limit.
      peakDay: pick && office !== 'Both'
        ? await db.peak.hourlyProfile(office, {
            ...db.peak.optsFromSettings(await db.getSettings()),
            weekday: new Date(pick + 'T00:00:00').getDay(),
          })
        : null,
    });
  } catch (e) { next(e); }
});

router.post('/calendar/day', async (req, res, next) => {
  try {
    const office = req.body.office === 'Registrar' ? 'Registrar' : 'Cashier';
    const r = await db.setDayOverride(req.session.user, office, req.body.date, req.body);
    if (r.error) req.session.error = r.error;
    else req.session.flash = r.cleared ? 'That day now follows the office defaults.' : 'Day updated.';
    const d = new Date(req.body.date + 'T00:00:00');
    res.redirect(`/admin/calendar?office=${office}&y=${d.getFullYear()}&m=${d.getMonth() + 1}&d=${req.body.date}`);
  } catch (e) { next(e); }
});

router.get('/windows', async (req, res, next) => {
  try {
    const [windows, cashierStaff, registrarStaff] = await Promise.all([
      db.getWindows(), db.getAssignableStaff('Cashier'), db.getAssignableStaff('Registrar'),
    ]);
    res.render('pages/admin/windows', {
      title: 'Service Windows', windows,
      staffBy: { Cashier: cashierStaff, Registrar: registrarStaff },
    });
  } catch (e) { next(e); }
});

router.post('/windows', async (req, res, next) => {
  try {
    const r = await db.createWindow(req.body);
    if (r.error) req.session.error = r.error;
    else req.session.flash = `${r.label} added to the ${r.department} office.`;
    res.redirect('/admin/windows');
  } catch (e) { next(e); }
});

router.post('/windows/:id/delete', async (req, res, next) => {
  try {
    const r = await db.deleteWindow(Number(req.params.id));
    if (r.error) req.session.error = r.error; else req.session.flash = `${r.label} was deleted.`;
    res.redirect('/admin/windows');
  } catch (e) { next(e); }
});

router.post('/windows/:id', async (req, res, next) => {
  try {
    const r = await db.updateWindow(req.params.id, req.body);
    if (r.error) req.session.error = r.error;
    else req.session.flash = 'Window updated.';
    res.redirect('/admin/windows');
  } catch (e) { next(e); }
});

// ── Priority lane review ─────────────────────────────────────────────────────
// Queue History: every client's tickets, all offices (routes/history.js).
router.use('/history', require('./history')('/admin/history'));

// Priority requests: shared with the Cashier and Registrar (routes/priority.js).
router.use('/priority', require('./priority')('/admin/priority', { canRevoke: true }));

// Report builder: print view (all matching rows) and CSV download.
router.get('/reports/print', async (req, res, next) => {
  try {
    res.render('pages/shared/report-print', { title: 'Report', rbase: '/admin/reports', ...(await reportBuilder.buildAll(req.query, null)) });
  } catch (e) { next(e); }
});
router.get('/reports/export', async (req, res, next) => {
  try { await reportBuilder.sendCsv(req.query, null, res); } catch (e) { next(e); }
});

router.get('/reports', async (req, res, next) => {
  try {
    const from = req.query.from || db.today();
    const to   = req.query.to   || db.today();

    // Peak hours have their own period (today / this week / this month / this
    // year / last 30 days / custom), separate from the report dates above, plus
    // an optional day-of-week filter. Default: this week, every day.
    const s  = await db.getSettings();
    const wdq = req.query.weekday;
    const wd = /^[0-6]$/.test(String(wdq)) ? Number(wdq) : 'all';
    const period = db.peak.periodRange(req.query.pperiod, req.query.pfrom, req.query.pto);
    const peakOpts = db.peak.optsFromSettings(s);
    const peakHours = await db.peak.bothOffices({ ...peakOpts, weekday: wd, period });

    res.render('pages/admin/reports', {
      title: 'Reports', reports: await db.getReports(from, to),
      estimation: await db.getEstimationTable(), from, to,
      accuracy: await db.predict.getAccuracy(from, to),
      peakHours, peakWeekday: wd, dayNames: db.peak.DAY_NAMES,
      peakPeriod: period, periods: db.peak.PERIODS,
      ...(await reportBuilder.build(req.query, null)),
    });
  } catch (e) { next(e); }
});

// Printable A4 poster with the QR code to the students' queue page. The link
// follows the address the site is opened at (the live site gives https).
router.get('/qr-poster', async (req, res, next) => {
  try {
    const url = `${req.protocol}://${req.get('host')}/queue`;
    const qr = await require('qrcode').toString(url, { type: 'svg', margin: 0, errorCorrectionLevel: 'H', color: { dark: '#14243a', light: '#ffffff' } });
    const s = await db.getSettings();
    res.render('pages/admin/qr-poster', {
      title: 'QR Poster', url, qr, settings: s,
      hours: `${db.clock12(s.openTime)} – ${db.clock12(s.closeTime)}`,
      lineOpens: db.clock12(db.joinOpensAt(s)),
    });
  } catch (e) { next(e); }
});

router.get('/settings', async (req, res, next) => {
  try {
    const [settings, load] = await Promise.all([db.getSettings(), db.getLoad()]);
    res.render('pages/admin/settings', { title: 'System Settings', settings, load });
  } catch (e) { next(e); }
});

router.post('/settings', async (req, res, next) => {
  try {
    const b = { ...req.body };
    b.openDays = Array.isArray(req.body.openDays) ? req.body.openDays
               : req.body.openDays ? [req.body.openDays] : [];
    await db.saveSettings(b);
    req.session.flash = 'Settings saved.';
    res.redirect('/admin/settings');
  } catch (e) { next(e); }
});

module.exports = router;
