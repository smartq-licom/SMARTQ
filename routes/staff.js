'use strict';
const express = require('express');
const router  = express.Router();
const db      = require('../data/db');

const deptOf = u => (u.role === 'cashier' ? 'Cashier' : 'Registrar');

router.get('/dashboard', async (req, res, next) => {
  try {
    const me   = req.session.user;
    const dept = deptOf(me);
    await db.processAutoCancel();
    const [queue, windows, load] = await Promise.all([
      db.getQueue(dept), db.getWindows(dept), db.getLoad(),
    ]);
    const mine = queue.find(t => t.staffId === me.id && ['called','serving'].includes(t.ticketStatus)) || null;
    const timeLeft = mine ? await db.getTimeLeft(mine.id) : null;
    const requirements = mine ? await db.getTransactionRequirements(mine.id) : [];

    // Today's busy-hour shape for this office, so staff can time breaks and
    // see a rush coming rather than discovering it at the window.
    const settings = await db.getSettings();
    const peakHours = await db.peak.hourlyProfile(dept, {
      ...db.peak.optsFromSettings(settings),
      weekday: new Date().getDay(),
    });

    res.render('pages/staff/dashboard', {
      title: dept + ' Counter', dept, queue, windows, load: load[dept],
      current: mine, timeLeft, requirements, peakHours,
      nowHour: new Date().getHours(),
      waitingPriority: queue.filter(t => t.ticketStatus === 'waiting' && t.queueCategory === 'priority'),
      waitingRegular:  queue.filter(t => t.ticketStatus === 'waiting' && t.queueCategory === 'regular'),
      completed:       queue.filter(t => t.ticketStatus === 'completed'),
      nextUp: await db.pickNextTicket(dept, me),   // who Call Next would give THIS window
    });
  } catch (e) { next(e); }
});

const back = (req, res, msg, err) => {
  if (msg) req.session.flash = msg;
  if (err) req.session.error = err;
  res.redirect('/staff/dashboard');
};

// Reports for this member's own office (routes/report-builder.js).
const reportBuilder = require('./report-builder');
router.get('/reports', async (req, res, next) => {
  try {
    const office = officeOf(req.session.user);
    res.render('pages/staff/reports', { title: office + ' Reports', ...(await reportBuilder.build(req.query, office)) });
  } catch (e) { next(e); }
});
router.get('/reports/print', async (req, res, next) => {
  try {
    res.render('pages/shared/report-print', { title: 'Report', rbase: '/staff/reports',
      ...(await reportBuilder.buildAll(req.query, officeOf(req.session.user))) });
  } catch (e) { next(e); }
});
router.get('/reports/export', async (req, res, next) => {
  try { await reportBuilder.sendCsv(req.query, officeOf(req.session.user), res); } catch (e) { next(e); }
});

// Queue History for this member's own office only (routes/history.js).
router.use('/history', require('./history')('/staff/history', { officeOf: u => officeOf(u) }));

// Staff can approve or reject priority-lane requests too (routes/priority.js).
router.use('/priority', require('./priority')('/staff/priority'));

router.post('/call-next', async (req, res, next) => {
  try {
    const r = await db.callNext(req.session.user, deptOf(req.session.user));
    if (r.error) return back(req, res, null, r.error);
    back(req, res, `Now calling ${r.ticketNo} at ${r.windowLabel}.`);
  } catch (e) { next(e); }
});

// Call the same client again without disturbing the queue or the timer
router.post('/recall/:id', async (req, res, next) => {
  try {
    const r = await db.recallTicket(req.session.user, req.params.id);
    if (r.error) return back(req, res, null, r.error);
    back(req, res, `${r.transaction.ticketNo} called again.`);
  } catch (e) { next(e); }
});

// A self-declared priority client without a valid ID goes to the end of the
// regular line with a new number (db.moveToRegular).
router.post('/move-regular/:id', async (req, res, next) => {
  try {
    const r = await db.moveToRegular(req.session.user, Number(req.params.id));
    if (r.error) return back(req, res, null, r.error);
    back(req, res, `${r.from} moved to the regular line as ${r.to}.`);
  } catch (e) { next(e); }
});

// Called but not at the window: back 5 places with a notice; cancelled on a
// second miss (db.missedTurn).
router.post('/missed/:id', async (req, res, next) => {
  try {
    const r = await db.missedTurn(req.session.user, Number(req.params.id));
    if (r.error) return back(req, res, null, r.error);
    back(req, res, r.cancelled
      ? `${r.ticketNo} missed the turn twice and was cancelled.`
      : `${r.ticketNo} moved back ${r.movedBack} place${r.movedBack === 1 ? '' : 's'}. The client was notified.`);
  } catch (e) { next(e); }
});

router.post('/accept/:id', async (req, res, next) => {
  try {
    const r = await db.acceptTicket(req.session.user, req.params.id);
    if (r.error) return back(req, res, null, r.error);
    back(req, res, `Serving ${r.ticketNo}.`);
  } catch (e) { next(e); }
});

router.post('/payment/:id', async (req, res, next) => {
  try {
    const r = await db.processPayment(req.session.user, req.params.id);
    if (r.error) return back(req, res, null, r.error);
    back(req, res, `Payment recorded. Receipt ${r.receiptNo} issued.`);
  } catch (e) { next(e); }
});

// Cashier: payment + receipt + finish, in one click.
router.post('/pay-complete/:id', async (req, res, next) => {
  try {
    const r = await db.payAndComplete(req.session.user, Number(req.params.id));
    if (r.error) return back(req, res, null, r.error);
    back(req, res, r.receiptNo
      ? `${r.ticketNo} paid and completed. Receipt ${r.receiptNo} issued.`
      : `${r.ticketNo} completed.`);
  } catch (e) { next(e); }
});

router.post('/complete/:id', async (req, res, next) => {
  try {
    const me = req.session.user;
    if (me.role === 'cashier') {
      const r = await db.completeCashier(me, req.params.id);
      if (r.error) return back(req, res, null, r.error);
      return back(req, res, `${r.transaction.ticketNo} completed.`);
    }
    const r = await db.completeRegistrar(me, req.params.id);
    if (r.error) return back(req, res, null, r.error);
    back(req, res, `${r.ticketNo} completed.`);
  } catch (e) { next(e); }
});

// Staff log a document that was submitted or released
// ── Documents for this member's own office ───────────────────────────────────
// The office comes from the session, never from the form, so a Cashier account
// cannot reach a Registrar document by posting a different id.
function officeOf(user) {
  return user.role === 'cashier' ? 'Cashier' : 'Registrar';
}

// ── Booking calendar for this member's own office ────────────────────────────
router.get('/calendar', async (req, res, next) => {
  try {
    const office = officeOf(req.session.user);
    const now = new Date();
    const year  = parseInt(req.query.y, 10) || now.getFullYear();
    const month = parseInt(req.query.m, 10) || (now.getMonth() + 1);
    const cal = await db.getCalendarMonth(office, year, month);
    const pick = /^\d{4}-\d{2}-\d{2}$/.test(req.query.d || '') ? req.query.d : null;
    res.render('pages/shared/calendar', {
      title: office + ' Calendar', office, cal, base: '/staff/calendar',
      canPickOffice: false,
      pickDate: pick,
      bookings: pick ? await db.getDayBookings(office, pick) : null,
      pickDay: pick ? cal.days.find(function (x) { return x && x.date === pick; }) : null,
      // Busy-hour profile for the weekday of the selected date, so whoever is
      // deciding whether to cap or close the day can see what that weekday
      // normally looks like before they set a limit.
      peakDay: pick
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
    const office = officeOf(req.session.user);
    const r = await db.setDayOverride(req.session.user, office, req.body.date, req.body);
    if (r.error) req.session.error = r.error;
    else req.session.flash = r.cleared
      ? 'That day now follows the office defaults.'
      : 'Day updated.';
    const d = new Date(req.body.date + 'T00:00:00');
    res.redirect(`/staff/calendar?y=${d.getFullYear()}&m=${d.getMonth() + 1}&d=${req.body.date}`);
  } catch (e) { next(e); }
});

router.get('/documents', async (req, res, next) => {
  try {
    const office = officeOf(req.session.user);
    res.render('pages/staff/documents', {
      title: office + ' Documents', office,
      documents: await db.getDocuments({ activeOnly: false, office }),
      byDocument: await db.getRequirementsByDocument(),
    });
  } catch (e) { next(e); }
});

router.post('/documents', async (req, res, next) => {
  try {
    const office = officeOf(req.session.user);
    // price is admin-only, so it is never taken from a staff submission
    const r = await db.saveDocumentAsStaff(office, req.body);
    if (r.error) req.session.error = r.error;
    else req.session.flash = r.created ? 'Document added.' : 'Document updated.';
    res.redirect('/staff/documents');
  } catch (e) { next(e); }
});

// Staff delete their own office's documents (same rule as the admin).
router.post('/documents/:id/delete', async (req, res, next) => {
  try {
    const r = await db.deleteDocument(Number(req.params.id), officeOf(req.session.user));
    if (r.error) req.session.error = r.error; else req.session.flash = `"${r.name}" was deleted.`;
    res.redirect('/staff/documents');
  } catch (e) { next(e); }
});

// ── My account: staff edit their own name, contact number and password ──────
async function renderAccount(req, res, extra) {
  const profile = await db.getUser(req.session.user.id);
  const win = profile.windowId ? (await db.getWindows()).find(w => w.id === profile.windowId) : null;
  profile.windowLabel = win ? win.label : '';
  res.render('pages/staff/account', {
    title: 'My Account', profile,
    profileError: null, passwordError: null, ...extra,
  });
}
router.get('/account', async (req, res, next) => {
  try { await renderAccount(req, res); } catch (e) { next(e); }
});
router.post('/account/profile', async (req, res, next) => {
  try {
    const r = await db.updateStaffProfile(req.session.user.id, req.body);
    if (r.error) return renderAccount(req, res, { profileError: r.error });
    req.session.user = r.user;
    req.session.flash = 'Your details were saved.';
    res.redirect('/staff/account');
  } catch (e) { next(e); }
});
router.post('/account/password', async (req, res, next) => {
  try {
    const me = req.session.user, b = req.body;
    if (!(await db.checkCurrentPassword(me.id, b.currentPassword)))
      return renderAccount(req, res, { passwordError: 'Your current password is incorrect.' });
    if (b.newPassword !== b.confirmPassword)
      return renderAccount(req, res, { passwordError: 'The new passwords do not match.' });
    if (b.newPassword === b.currentPassword)
      return renderAccount(req, res, { passwordError: 'Choose a password different from the current one.' });
    const r = await db.setPassword(me.id, b.newPassword);
    if (r.error) return renderAccount(req, res, { passwordError: r.error });
    req.session.user = await db.getUser(me.id);   // clears "must change password"
    req.session.flash = 'Your password was changed.';
    res.redirect('/staff/account');
  } catch (e) { next(e); }
});

router.post('/cancel/:id', async (req, res, next) => {
  try {
    const r = await db.cancelTicket(req.session.user, req.params.id, req.body.reason);
    if (r.error) return back(req, res, null, r.error);
    back(req, res, 'Ticket cancelled.');
  } catch (e) { next(e); }
});

router.get('/ticket/:id', async (req, res, next) => {
  try {
    const t = await db.getTransaction(req.params.id);
    if (!t) return res.status(404).render('pages/error', { title:'Not found', code:404, message:'Ticket not found.' });
    res.render('pages/staff/ticket', {
      title: 'Ticket ' + t.ticketNo, t, dept: deptOf(req.session.user),
      history: await db.getHistory(t.id),
      requirements: await db.getTransactionRequirements(t.id),
    });
  } catch (e) { next(e); }
});

module.exports = router;
