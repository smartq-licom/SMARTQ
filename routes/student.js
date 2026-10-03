'use strict';
const crypto  = require('crypto');
const express = require('express');
const router  = express.Router();
const path    = require('path');
const db      = require('../data/db');
const auth    = require('../data/auth');
const mailer  = require('../data/mailer');
const predict = require('../data/prediction');
const { proofUpload, DIR } = require('../data/uploads');

/** True when ticket a was created before ticket b. requested_at is only
 *  second-precision, so ties fall back to the auto-increment id. */
function aheadOf(a, b) {
  const ta = new Date(a.requestedAt).getTime();
  const tb = new Date(b.requestedAt).getTime();
  return ta === tb ? a.id < b.id : ta < tb;
}

router.get('/dashboard', async (req, res, next) => {
  try {
    const me = req.session.user;
    await db.processAutoCancel();
    const [all, load, settings] = await Promise.all([
      db.getUserTransactions(me.id), db.getLoad(), db.getSettings(),
    ]);
    const active = all.filter(t => !['completed','cancelled'].includes(t.overallStatus));
    // position in line for each active ticket
    for (const t of active) {
      t.eta = await predict.ticketEta(t);
      if (t.ticketStatus === 'waiting') {
        const q = await db.getQueue(t.department, { date: t.serviceDate });
        t.ahead = q.filter(x => x.ticketStatus === 'waiting' &&
                                x.queueCategory === t.queueCategory &&
                                aheadOf(x, t)).length;
      }
      if (['called','serving'].includes(t.ticketStatus)) t.timeLeft = await db.getTimeLeft(t.id);
    }
    res.render('pages/student/dashboard', {
      title: 'My Dashboard', active, recent: all.slice(0, 5), load, settings,
      officeHours: officeHours(settings),
    });
  } catch (e) { next(e); }
});

/**
 * Can a same-day ("Request now") ticket be taken at this moment? The server
 * checks this again in db.validateSchedule; this only shapes the form.
 */
function sameDayStatus(s) {
  if (!s.allowSameDay) return { open: false, why: 'Same-day requests are closed at the moment, so please pick a date.' };
  if (!s.openDays.includes(new Date().getDay() || 7)) return { open: false, why: 'The offices are closed today, so please pick a working day.' };
  if (db.isPastClosing(s)) return { open: false, why: 'Office hours are over for today (closed at ' + db.clock12(s.closeTime) + '), so please pick a date.' };
  return { open: true, why: '' };
}

/** "8:00 AM – 5:00 PM", shown next to a visit date (bookings are per day). */
function officeHours(s) {
  return db.clock12(s.openTime) + ' – ' + db.clock12(s.closeTime);
}

// ── Request wizard ───────────────────────────────────────────────────────────
/**
 * Quiet-hour advice for the request form. Read-only: it never changes the
 * ticket, the queue order or the estimate — it only tells the student which
 * hours are usually calmer, per office.
 *
 * All SEVEN weekdays are sent to the page, not just today's, because the student
 * may book up to a month ahead and a Friday visit should be advised with Friday
 * history. The page swaps the line client-side as the date changes, so no extra
 * request is needed. Both offices share one history read, so this costs two
 * queries, not fourteen.
 *
 * Entries are null for weekdays with too little history to advise on honestly.
 */
async function peakAdvice(settings) {
  const opts = db.peak.optsFromSettings(settings);
  const [Cashier, Registrar] = await Promise.all([
    db.peak.adviceByWeekday('Cashier',   opts),
    db.peak.adviceByWeekday('Registrar', opts),
  ]);
  return { Cashier, Registrar, dayNames: db.peak.DAY_NAMES };
}

router.get('/request', async (req, res, next) => {
  try {
    const me = req.session.user;
    // Accounts made before the student number became required finish their
    // profile first (it is checked again when the ticket is created).
    if (db.needsProfile(await db.getUser(me.id))) {
      req.session.flash = 'Please add your 9-digit student number before requesting a ticket.';
      return res.redirect('/complete-profile');
    }

    const [documents, settings, activeBy, requirements, claimable] = await Promise.all([
      db.getDocuments({ guestOnly: me.role === 'guest' }), db.getSettings(),
      db.getActiveByDepartment(me.id), db.getRequirementsByDocument(),
      db.getClaimableLines(me.id),
    ]);

    // both offices already have an open ticket: nothing left to request
    if (activeBy.Cashier && activeBy.Registrar) {
      return res.render('pages/student/request-blocked', {
        title: 'Request a Ticket', activeBy,
        etaCashier:   await predict.ticketEta(activeBy.Cashier),
        etaRegistrar: await predict.ticketEta(activeBy.Registrar),
      });
    }
    res.render('pages/student/request', {
      title: 'Request a Ticket', documents, settings,
      purposes: db.PURPOSES, priorityTypes: db.PRIORITY_TYPES, courses: db.COURSES,
      today: db.today(), maxDate: db.addDays(db.today(), settings.scheduleMaxDays),
      activeBy, requirements, claimable, sameDay: sameDayStatus(settings),
      firstBookable: db.addDays(db.today(), 1),
      peakAdvice: await peakAdvice(settings),
      submitToken: crypto.randomUUID(), form: {}, formError: null,
    });
  } catch (e) { next(e); }
});

router.post('/request', async (req, res, next) => {
  try {
    const me = req.session.user;
    const result = await db.createRequest(me, req.body);
    if (result.error) {
      const [documents, settings, activeBy, requirements, claimable] = await Promise.all([
        db.getDocuments({ guestOnly: me.role === 'guest' }), db.getSettings(),
        db.getActiveByDepartment(me.id), db.getRequirementsByDocument(),
        db.getClaimableLines(me.id),
      ]);
      return res.status(400).render('pages/student/request', {
        title: 'Request a Ticket', documents, settings,
        purposes: db.PURPOSES, priorityTypes: db.PRIORITY_TYPES, courses: db.COURSES,
        today: db.today(), maxDate: db.addDays(db.today(), settings.scheduleMaxDays),
        activeBy, requirements, claimable, sameDay: sameDayStatus(settings),
      firstBookable: db.addDays(db.today(), 1),
        peakAdvice: await peakAdvice(settings),
        submitToken: req.body.submitToken || crypto.randomUUID(),
        form: req.body, formError: result.error,
      });
    }
    res.redirect('/student/ticket/' + result.id);
  } catch (e) { next(e); }
});

// Polled every ~1.5 s by the ticket page: the newest call for this ticket.
router.get('/ticket/:id/pulse', async (req, res, next) => {
  try {
    res.set('Cache-Control', 'no-store');
    res.json(await db.announcementPulseFor(Number(req.params.id), req.session.user.id));
  } catch (e) { next(e); }
});

// The student cancels their own waiting, unpaid ticket (see db.cancelByStudent).
router.post('/ticket/:id/cancel', async (req, res, next) => {
  try {
    const r = await db.cancelByStudent(req.session.user, Number(req.params.id), req.body.reason);
    if (r.error) { req.session.error = r.error; return res.redirect('/student/ticket/' + req.params.id); }
    req.session.flash = `Ticket ${r.ticketNo} was cancelled. You can request a new ticket for this office any time.`;
    res.redirect('/student/dashboard');
  } catch (e) { next(e); }
});

router.get('/ticket/:id', async (req, res, next) => {
  try {
    await db.processAutoCancel();
    const t = await db.getTransaction(req.params.id);
    if (!t || t.userId !== req.session.user.id)
      return res.status(404).render('pages/error', { title:'Not found', code:404, message:'Ticket not found.' });
    let ahead = 0;
    if (t.ticketStatus === 'waiting') {
      const q = await db.getQueue(t.department, { date: t.serviceDate });
      ahead = q.filter(x => x.ticketStatus === 'waiting' && x.queueCategory === t.queueCategory &&
                            aheadOf(x, t)).length;
    }
    const timeLeft = ['called','serving'].includes(t.ticketStatus) ? await db.getTimeLeft(t.id) : null;
    const eta = await predict.ticketEta(t);
    res.render('pages/student/ticket', {
      title: 'Ticket ' + t.ticketNo, t, ahead, timeLeft, eta,
      officeHours: officeHours(await db.getSettings()),
      isToday: t.serviceDate === db.today(),
      requirements: await db.getTransactionRequirements(t.id),
      // Cashier tickets: what to bring later, when claiming at the Registrar
      claimRequirements: t.department === 'Cashier' ? await db.getRequirementsForClaim(t.id) : [],
      announcement: await db.latestAnnouncementFor(t.id),
    });
  } catch (e) { next(e); }
});

router.get('/priority', async (req, res, next) => {
  try {
    const me = req.session.user;
    res.render('pages/student/priority', {
      title: 'Priority Lane',
      profile: await db.getUser(me.id),
      requests: await db.getUserPriorityRequests(me.id),
      labels: db.PRIORITY_LABELS, formError: null,
    });
  } catch (e) { next(e); }
});

router.post('/priority', proofUpload, async (req, res, next) => {
  try {
    const me = req.session.user;
    const render = async msg => res.status(400).render('pages/student/priority', {
      title: 'Priority Lane',
      profile: await db.getUser(me.id),
      requests: await db.getUserPriorityRequests(me.id),
      labels: db.PRIORITY_LABELS, formError: msg,
    });
    if (req.uploadError) return render(req.uploadError);

    const r = await db.createPriorityRequest(me.id, req.body.category, req.file);
    if (r.error) return render(r.error);

    req.session.flash = 'Your proof was submitted. An administrator will review it shortly.';
    res.redirect('/student/priority');
  } catch (e) { next(e); }
});

// Owner-only access to their own uploaded proof
router.get('/priority/proof/:id', async (req, res, next) => {
  try {
    const pr = await db.getPriorityRequest(req.params.id);
    if (!pr || pr.userId !== req.session.user.id)
      return res.status(404).render('pages/error', { title:'Not found', code:404, message:'File not found.' });
    res.type(pr.proofMime).sendFile(path.join(DIR, pr.proofFile));
  } catch (e) { next(e); }
});

router.get('/history', async (req, res, next) => {
  try {
    res.render('pages/student/history', {
      title: 'Transaction History',
      list: await db.getUserTransactions(req.session.user.id),
    });
  } catch (e) { next(e); }
});

router.get('/receipt/:id', async (req, res, next) => {
  try {
    const r = await db.getReceipt(req.params.id);
    if (!r || r.userId !== req.session.user.id)
      return res.status(404).render('pages/error', { title:'Not found', code:404, message:'Receipt not found.' });
    res.render('pages/student/receipt', {
      title: 'Receipt ' + r.receiptNo, r, settings: await db.getSettings(),
    });
  } catch (e) { next(e); }
});

// ── Account settings ─────────────────────────────────────────────────────────
router.get('/account', async (req, res, next) => {
  try {
    res.render('pages/student/account', {
      title: 'Account Settings',
      profile: await db.getUser(req.session.user.id),
      courses: db.COURSES, profileError: null, passwordError: null, emailError: null,
    });
  } catch (e) { next(e); }
});

router.post('/account/profile', async (req, res, next) => {
  try {
    const r = await db.updateProfile(req.session.user.id, req.body);
    if (r.error) {
      return res.status(400).render('pages/student/account', {
        title: 'Account Settings',
        profile: { ...(await db.getUser(req.session.user.id)), ...req.body },
        courses: db.COURSES, profileError: r.error, passwordError: null, emailError: null,
      });
    }
    req.session.user  = r;
    req.session.flash = 'Your profile has been updated.';
    res.redirect('/student/account');
  } catch (e) { next(e); }
});

// Change the email address: the NEW address must be confirmed by OTP before
// it replaces the old one.
router.post('/account/email', async (req, res, next) => {
  try {
    const me = await db.getUser(req.session.user.id);
    const newEmail = String(req.body.newEmail || '').trim().toLowerCase();
    const back = async msg => res.status(400).render('pages/student/account', {
      title: 'Account Settings', profile: me, courses: db.COURSES,
      profileError: null, passwordError: null, emailError: msg,
    });
    if (!auth.isEmail(newEmail))          return back('Please enter a valid email address.');
    if (newEmail === (me.email || ''))    return back('That is already your email address.');
    if (await db.emailTaken(newEmail, me.id)) return back('This email address is already registered.');

    const otp = await auth.issueOtp(me.id, newEmail, 'email_change', { payload: newEmail, force: true });
    if (otp.error) return back(otp.error);
    await mailer.sendOtp(newEmail, me.firstName, otp.code, 'email_change', otp.minutes);

    req.session.pending = {
      userId: me.id, email: newEmail, masked: auth.maskEmail(newEmail),
      name: me.firstName, purpose: 'email_change', toEmail: newEmail,
    };
    res.redirect('/verify');
  } catch (e) { next(e); }
});

router.post('/account/password', async (req, res, next) => {
  try {
    const { currentPassword, newPassword, confirmPassword } = req.body;
    const me = await db.getUser(req.session.user.id);
    let r;
    if (newPassword !== confirmPassword) {
      r = { error: 'Passwords do not match.' };
    } else if (me.hasPassword) {
      const ok = await db.checkCurrentPassword(me.id, currentPassword);
      r = ok ? await db.setPassword(me.id, newPassword)
             : { error: 'Your current password is incorrect.' };
    } else {
      // Google account setting a password for the first time
      r = await db.setPassword(me.id, newPassword);
    }
    if (r.error) {
      return res.status(400).render('pages/student/account', {
        title: 'Account Settings',
        profile: await db.getUser(req.session.user.id),
        courses: db.COURSES, profileError: null, passwordError: r.error, emailError: null,
      });
    }
    req.session.user  = await db.getUser(req.session.user.id);
    req.session.flash = me.hasPassword ? 'Your password has been changed.' : 'Password set. You can now log in with your email as well as Google.';
    res.redirect('/student/account');
  } catch (e) { next(e); }
});

module.exports = router;
