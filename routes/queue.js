'use strict';
/**
 * The students' side of SmartQ, with no registration and no login.
 *
 * A QR code on the wall opens /queue. The page shows how many are waiting at
 * each office and the expected wait, then asks what the student needs today.
 * The ticket lives behind a secret link (/queue/t/<token>) that is remembered
 * in a cookie on the phone, so reopening /queue shows it again. A six-letter
 * booking code plus the student number finds it again on any other phone.
 */
const crypto  = require('crypto');
const express = require('express');
const router  = express.Router();
const db      = require('../data/db');
const predict = require('../data/prediction');
const engine  = require('../data/engine');
const push    = require('../data/push');
const { proofToMemory } = require('../data/uploads');

// ── tickets remembered on this phone ─────────────────────────────────────────
const COOKIE = 'smartq.tix';
const KEEP   = 8;                                   // newest tickets kept
const TOKEN  = /^[a-f0-9]{32}$/;

function savedTokens(req) {
  const raw = String(req.headers.cookie || '').split(/;\s*/)
    .find(c => c.startsWith(COOKIE + '='));
  if (!raw) return [];
  return decodeURIComponent(raw.slice(COOKIE.length + 1)).split('.').filter(t => TOKEN.test(t));
}
function writeTokens(res, list) {
  res.cookie(COOKIE, list.slice(0, KEEP).join('.'), {
    httpOnly: true, sameSite: 'lax', secure: process.env.NODE_ENV === 'production',
    maxAge: 1000 * 60 * 60 * 24 * 60,               // 60 days: covers the furthest booking
    path: '/',
  });
}
function remember(req, res, token) {
  writeTokens(res, [token, ...savedTokens(req).filter(t => t !== token)]);
}

const ACTIVE = t => !['completed', 'cancelled'].includes(t.overallStatus);

/** Tickets saved on this phone, newest first. */
async function myTickets(req) {
  const list = [];
  for (const tok of savedTokens(req)) {
    const t = await db.getTransactionByToken(tok);
    if (t) list.push(t);
  }
  return list;
}

/** True when ticket a is ahead of ticket b in line (id breaks second ties). */
function aheadOf(a, b) {
  const ta = new Date(a.queueAt).getTime(), tb = new Date(b.queueAt).getTime();
  return ta === tb ? a.id < b.id : ta < tb;
}

function sameDayStatus(s) {
  if (!s.allowSameDay) return { open: false, why: 'Same-day requests are closed at the moment, so please pick a date.' };
  if (!s.openDays.includes(new Date().getDay() || 7)) return { open: false, why: 'The offices are closed today, so please pick a working day.' };
  if (db.isPastClosing(s)) return { open: false, why: 'Office hours are over for today (closed at ' + db.clock12(s.closeTime) + '), so please pick a date.' };
  if (db.isBeforeJoinOpens(s)) return { open: false, early: true, opensClock: db.clock12(db.joinOpensAt(s)),
    why: "Today's line opens at " + db.clock12(db.joinOpensAt(s)) + ', so for now please book a time.' };
  return { open: true, why: '' };
}
const officeHours = s => db.clock12(s.openTime) + ' – ' + db.clock12(s.closeTime);

/** "Available from" times: every 15 minutes, up to 2 hours ahead, before closing. */
function holdChoices(s) {
  const out = [], now = new Date();
  const close = new Date(`${db.today()}T${s.closeTime}:00`);
  const t = new Date(now);
  t.setSeconds(0, 0);
  t.setMinutes(Math.ceil((t.getMinutes() + 1) / 15) * 15);
  for (; t <= new Date(now.getTime() + 120 * 60000) && t < close; t.setMinutes(t.getMinutes() + 15)) {
    const hm = `${String(t.getHours()).padStart(2, '0')}:${String(t.getMinutes()).padStart(2, '0')}`;
    out.push({ value: hm, label: db.clock12(hm) });
  }
  return out;
}

/**
 * Per office: how many are waiting, today's ACTUAL average wait, and what the
 * decision engine predicts for someone joining now (and whether they would
 * still be served before closing).
 */
async function officeSnapshot(sameDayOpen) {
  const load = await db.getLoad();
  const out = {};
  for (const dept of ['Cashier', 'Registrar']) {
    const [windows, avg] = await Promise.all([db.getWindows(dept), db.todayAverageWait(dept)]);
    const openWindows = windows.filter(w => w.status === 'open').length;
    let join = null;
    if (sameDayOpen) {
      try { join = await engine.evaluateJoin(dept); } catch (e) { /* show counts only */ }
    }
    const s = await db.getSettings();
    const beforeOpen = new Date() < new Date(`${db.today()}T${s.openTime}:00`);
    out[dept] = {
      beforeOpen, openClock: db.clock12(s.openTime),
      waiting: load[dept].waiting, serving: load[dept].serving, served: load[dept].completed,
      nowServing: windows.filter(w => w.serving).map(w => ({ label: w.label, ticket: w.serving })),
      openWindows, avgWait: avg,
      minutes: join ? join.minutes : null, startClock: join ? join.startClock : null,
      fits: join ? join.fits : true, closed: !openWindows,
    };
  }
  return out;
}

// ── landing page: "What are your transactions today?" ───────────────────────
router.get('/', async (req, res, next) => {
  try {
    await db.processAutoCancel();
    const settings = await db.getSettings();
    const [offices, mine] = await Promise.all([officeSnapshot(sameDayStatus(settings).open), myTickets(req)]);
    res.render('pages/queue/home', {
      title: 'Get a Queue Number', settings, offices,
      active: mine.filter(ACTIVE), past: mine.filter(t => !ACTIVE(t)).slice(0, 3),
      sameDay: sameDayStatus(settings), officeHours: officeHours(settings),
      breakEnds: db.isBreakTime(settings) ? db.clock12(settings.breakEnd) : null,
    });
  } catch (e) { next(e); }
});

// ── request wizard ───────────────────────────────────────────────────────────
async function peakAdvice(settings) {
  const opts = db.peak.optsFromSettings(settings);
  const [Cashier, Registrar] = await Promise.all([
    db.peak.adviceByWeekday('Cashier', opts), db.peak.adviceByWeekday('Registrar', opts),
  ]);
  return { Cashier, Registrar, dayNames: db.peak.DAY_NAMES };
}

async function renderForm(req, res, form, formError) {
  const [documents, settings, requirements, mine] = await Promise.all([
    db.getDocuments(), db.getSettings(), db.getRequirementsByDocument(), myTickets(req),
  ]);
  // an office where this phone already holds an open ticket
  const activeBy = { Cashier: null, Registrar: null };
  mine.filter(ACTIVE).forEach(t => { if (!activeBy[t.department]) activeBy[t.department] = t; });
  res.status(formError ? 400 : 200).render('pages/queue/new', {
    title: 'Get a Queue Number', documents, settings, requirements, activeBy,
    purposes: db.PURPOSES, priorityTypes: db.PRIORITY_TYPES, priorityLabels: db.PRIORITY_LABELS,
    courses: db.COURSES,
    today: db.today(), maxDate: db.addDays(db.today(), settings.scheduleMaxDays),
    firstBookable: db.addDays(db.today(), 1), sameDay: sameDayStatus(settings),
    peakAdvice: await peakAdvice(settings),
    submitToken: form.submitToken || crypto.randomUUID(),
    form, formError,
  });
}

router.get('/new', async (req, res, next) => {
  try {
    const form = {};
    if (['Cashier', 'Registrar'].includes(req.query.office)) form.office = req.query.office;
    await renderForm(req, res, form, null);
  } catch (e) { next(e); }
});

// 30-minute slots for a date, with how many places are left for THESE
// documents (the form asks again whenever the date or documents change).
router.get('/slots', async (req, res, next) => {
  try {
    res.set('Cache-Control', 'no-store');
    const office = ['Cashier', 'Registrar'].includes(req.query.office) ? req.query.office : null;
    const date = /^\d{4}-\d{2}-\d{2}$/.test(req.query.date || '') ? req.query.date : null;
    if (!office || !date) return res.status(400).json({ error: 'Choose an office and a date.' });
    const v = await db.validateSchedule('schedule', date, office);
    if (v.error) return res.json({ closed: v.error, slots: [] });
    const settings = await db.getSettings();
    const ids = String(req.query.docs || '').split(',').map(Number).filter(Boolean).slice(0, 10);
    const items = (await Promise.all(ids.map(id => db.getDocument(id)))).filter(Boolean);
    const svc = items.length ? (await predict.estimateService(items, office, settings)).minutes : null;
    res.json(await engine.slotPlan(office, date, svc, settings));
  } catch (e) { next(e); }
});

router.post('/new', proofToMemory, async (req, res, next) => {
  try {
    const b = req.body;
    b.queueCategory = b.priorityType ? 'priority' : 'regular';

    // Priority needs proof. The ticket starts in the regular lane and moves up
    // once staff or the admin approve it (Priority Requests, red dot).
    if (b.priorityType) {
      if (req.uploadError) return renderForm(req, res, b, req.uploadError);
      if (!req.file) return renderForm(req, res, b,
        'Upload a photo of your PWD ID, Senior Citizen ID or proof of pregnancy to ask for the priority lane.');
    }

    // A visitor who already queued from this phone keeps the same record, so
    // what they paid for at the Cashier can be claimed at the Registrar.
    let guestId = null;
    if (b.clientType === 'guest') {
      const same = (x, y) => String(x || '').trim().toLowerCase() === String(y || '').trim().toLowerCase();
      const prev = (await myTickets(req)).find(t =>
        t.clientType === 'guest' && t.userId && same(t.firstName, b.firstName) && same(t.lastName, b.lastName));
      if (prev) guestId = prev.userId;
    }
    // Limit of requests: one open ticket per office, for visitors too. A
    // visitor has no student number, so this phone and their name count.
    if (b.clientType === 'guest') {
      const first = await db.getDocument(Number([].concat(b.documentIds || [])[0]) || 0);
      const office = first ? first.office : b.office;
      const here = (await myTickets(req)).find(t => ACTIVE(t) && t.department === office);
      const named = office ? await db.findActiveGuestTicket(b.firstName, b.lastName, office) : null;
      const open = here || named;
      if (open) {
        const msg = `You already have an open ${office} ticket (${open.ticketNo}). ` +
                    'Visitors can hold one ticket per office at a time.';
        await engine.logDecision(null, office, 'refused', `Visitor ${String(b.firstName || '').trim()} ${String(b.lastName || '').trim()}: ${msg}`);
        return renderForm(req, res, b, msg);
      }
    }

    const who = guestId
      ? { user: await db.getUser(guestId) }
      : await db.findOrCreateWalkIn(b);
    if (who.error) return renderForm(req, res, b, who.error);

    const r = await db.createRequest(who.user, b, { walkIn: true });
    if (r.error) {
      // refused requests are kept, so the admin can see the limits working
      await engine.logDecision(r.blockedBy ? r.blockedBy.id : null, r.blockedBy ? r.blockedBy.department : null,
        'refused', `${who.user.fullName || 'Client'}: ${r.error}`);
      // the open ticket may be from another phone: say how to get it back
      const msg = r.blockedBy
        ? `${r.error} If it is not on this phone, use "Find my ticket" with its booking code.`
        : r.error;
      return renderForm(req, res, b, msg);
    }
    // a repeated submit returns the same ticket: do not file the proof twice
    if (b.priorityType && !(await db.getTicketPriorityRequest(r.id)))
      await db.createTicketPriorityRequest(r, b.priorityType, req.file);
    remember(req, res, r.accessToken);
    // the capacity decision: still a number, but an honest heads-up
    if (r.decision && !r.decision.fits) {
      req.session.error = `Heads up: the line is long today. You may not be served before closing ` +
        `(${r.decision.closeClock}). You can keep your place, or book a time tomorrow from this page.`;
    }
    res.redirect('/queue/t/' + r.accessToken + '?new=1');   // the ticket "prints" once
  } catch (e) { next(e); }
});

// ── find a ticket on another phone ───────────────────────────────────────────
router.get('/find', (req, res) =>
  res.render('pages/queue/find', { title: 'Find My Ticket', form: {}, formError: null }));

router.post('/find', async (req, res, next) => {
  try {
    const token = await db.findTicketByCode(req.body.code, req.body.who);
    if (!token) {
      return res.status(400).render('pages/queue/find', {
        title: 'Find My Ticket', form: req.body,
        formError: 'No ticket matches that booking code and student number (or last name).',
      });
    }
    remember(req, res, token);
    res.redirect('/queue/t/' + token);
  } catch (e) { next(e); }
});

// ── one ticket, opened by its secret link ────────────────────────────────────
async function ticketOr404(req, res) {
  const t = await db.getTransactionByToken(req.params.token);
  if (!t) {
    res.status(404).render('pages/error', { title: 'Not found', code: 404,
      message: 'That ticket link is not valid. Open the queue page to see the tickets on this phone.' });
    return null;
  }
  return t;
}

router.get('/t/:token', async (req, res, next) => {
  try {
    await db.processAutoCancel();
    const t = await ticketOr404(req, res);
    if (!t) return;
    remember(req, res, t.accessToken);          // opened from a shared link or code
    let ahead = 0;
    if (t.ticketStatus === 'waiting') {
      const q = await db.getQueue(t.department, { date: t.serviceDate });
      ahead = q.filter(x => x.ticketStatus === 'waiting' && x.queueCategory === t.queueCategory &&
                            aheadOf(x, t)).length;
    }
    res.render('pages/queue/ticket', {
      title: 'Ticket ' + t.ticketNo, t, ahead,
      timeLeft: ['called', 'serving'].includes(t.ticketStatus) ? await db.getTimeLeft(t.id) : null,
      eta: await predict.ticketEta(t),
      officeHours: officeHours(await db.getSettings()),
      isToday: t.serviceDate === db.today(),
      requirements: await db.getTransactionRequirements(t.id),
      claimRequirements: t.department === 'Cashier' ? await db.getRequirementsForClaim(t.id) : [],
      announcement: await db.latestAnnouncementFor(t.id),
      priorityRequest: await db.getTicketPriorityRequest(t.id),
      priorityLabels: db.PRIORITY_LABELS,
      pushKey: push.ENABLED ? push.PUBLIC_KEY : '',
      holdChoices: holdChoices(await db.getSettings()),
      base: '/queue/t/' + t.accessToken,
    });
  } catch (e) { next(e); }
});

// Polled every ~1.5 s by the ticket page (call alert, "5 ahead", "you are next").
router.get('/t/:token/pulse', async (req, res, next) => {
  try {
    res.set('Cache-Control', 'no-store');
    const t = await db.getTransactionByToken(req.params.token);
    res.json(t ? await db.announcementPulseFor(t.id, t.userId) : { id: null });
  } catch (e) { next(e); }
});

router.post('/t/:token/cancel', async (req, res, next) => {
  try {
    const t = await ticketOr404(req, res);
    if (!t) return;
    const r = await db.cancelByStudent({ id: t.userId }, t.id, req.body.reason);
    if (r.error) req.session.error = r.error;
    else req.session.flash = `Ticket ${r.ticketNo} was cancelled. You can get a new number any time.`;
    res.redirect('/queue/t/' + t.accessToken);
  } catch (e) { next(e); }
});

// "Turn on alerts": this phone's push address for this ticket.
router.post('/t/:token/push', express.json({ limit: '8kb' }), async (req, res, next) => {
  try {
    const t = await db.getTransactionByToken(req.params.token);
    if (!t) return res.status(404).json({ error: 'Ticket not found.' });
    const r = await push.subscribe(t.id, req.body);
    if (r.error) return res.status(400).json(r);
    // confirm once, when this phone is new for this ticket (never on every visit)
    if (r.created) await push.sendToTicket(t.id, {
      title: `Alerts are on: ${t.ticketNo}`,
      body: 'We will notify you when to leave, when you are called, and if the line runs late.',
      url: '/queue/t/' + t.accessToken,
    });
    res.json({ ok: true });
  } catch (e) { next(e); }
});

// "Available from": busy until a time (max 2 hours); the place is kept.
router.post('/t/:token/hold', async (req, res, next) => {
  try {
    const t = await ticketOr404(req, res);
    if (!t) return;
    const r = await db.setHold(t, req.body.until);
    if (r.error) req.session.error = r.error;
    else if (r.notNeeded) req.session.flash = r.message;
    else req.session.flash = `Got it. You keep your place and will not be called before ${r.untilClock}.`;
    res.redirect('/queue/t/' + t.accessToken);
  } catch (e) { next(e); }
});
router.post('/t/:token/hold/clear', async (req, res, next) => {
  try {
    const t = await ticketOr404(req, res);
    if (!t) return;
    await db.clearHold(t);
    req.session.flash = 'You are available again and will be called in your turn.';
    res.redirect('/queue/t/' + t.accessToken);
  } catch (e) { next(e); }
});

// "Book tomorrow" after a warning: the earliest open slot on the next open day.
router.post('/t/:token/rebook', async (req, res, next) => {
  try {
    const t = await ticketOr404(req, res);
    if (!t) return;
    const r = await db.rebookTicket(t.id);
    if (r.error) req.session.error = r.error;
    else req.session.flash = `Moved to ${db.longDate(r.date)}, ${r.slot.label}. ` +
      `Your new number is ${r.to}.`;
    res.redirect('/queue/t/' + t.accessToken);
  } catch (e) { next(e); }
});

// Take a ticket off this phone's list (it stays valid for its booking code).
router.post('/t/:token/forget', (req, res) => {
  writeTokens(res, savedTokens(req).filter(t => t !== req.params.token));
  res.redirect('/queue');
});

router.get('/t/:token/receipt', async (req, res, next) => {
  try {
    const t = await ticketOr404(req, res);
    if (!t) return;
    const r = await db.getReceipt(t.id);
    if (!r) return res.redirect('/queue/t/' + t.accessToken);
    res.render('pages/queue/receipt', {
      title: 'Receipt ' + r.receiptNo, r, settings: await db.getSettings(),
      back: '/queue/t/' + t.accessToken,
    });
  } catch (e) { next(e); }
});

module.exports = router;
