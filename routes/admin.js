'use strict';
const express = require('express');
const router  = express.Router();
const db      = require('../data/db');

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

router.get('/users', async (req, res, next) => {
  try {
    res.render('pages/admin/users', {
      title: 'Staff Accounts',
      users: await db.getStaffAccounts(), windows: await db.getWindows(),
    });
  } catch (e) { next(e); }
});

// Student and guest accounts (kept separate from staff)
router.get('/students', async (req, res, next) => {
  try {
    const search = req.query.search || '';
    const role   = req.query.role   || '';
    const list   = await db.getClientAccounts({ search, role });
    res.render('pages/admin/students', {
      title: 'Student Accounts', list, search, role,
      counts: {
        students: list.filter(u => u.role === 'student').length,
        guests:   list.filter(u => u.role === 'guest').length,
      },
    });
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

router.post('/windows/:id', async (req, res, next) => {
  try {
    const r = await db.updateWindow(req.params.id, req.body);
    if (r.error) req.session.error = r.error;
    else req.session.flash = 'Window updated.';
    res.redirect('/admin/windows');
  } catch (e) { next(e); }
});

// ── Priority lane review ─────────────────────────────────────────────────────
// Priority requests: shared with the Cashier and Registrar (routes/priority.js).
router.use('/priority', require('./priority')('/admin/priority', { canRevoke: true }));

router.get('/reports', async (req, res, next) => {
  try {
    const from = req.query.from || db.today();
    const to   = req.query.to   || db.today();

    // Peak hours read their own 30-day window and are deliberately NOT tied to
    // the report's from/to dates: a one-day report would give a peak profile
    // built from a single day, which is worse than no profile at all.
    const s  = await db.getSettings();
    const wd = req.query.weekday === 'all' ? 'all'
             : req.query.weekday !== undefined && req.query.weekday !== ''
               ? Number(req.query.weekday)
               : new Date().getDay();
    const peakOpts = db.peak.optsFromSettings(s);
    const peakHours = await db.peak.bothOffices({ ...peakOpts, weekday: wd });

    res.render('pages/admin/reports', {
      title: 'Reports', reports: await db.getReports(from, to),
      estimation: await db.getEstimationTable(), from, to,
      accuracy: await db.predict.getAccuracy(from, to),
      peakHours, peakWeekday: wd, dayNames: db.peak.DAY_NAMES,
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
