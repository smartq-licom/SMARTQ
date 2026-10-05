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

/** True when ticket a was created before ticket b (id breaks second ties). */
function aheadOf(a, b) {
  const ta = new Date(a.requestedAt).getTime(), tb = new Date(b.requestedAt).getTime();
  return ta === tb ? a.id < b.id : ta < tb;
}

function sameDayStatus(s) {
  if (!s.allowSameDay) return { open: false, why: 'Same-day requests are closed at the moment, so please pick a date.' };
  if (!s.openDays.includes(new Date().getDay() || 7)) return { open: false, why: 'The offices are closed today, so please pick a working day.' };
  if (db.isPastClosing(s)) return { open: false, why: 'Office hours are over for today (closed at ' + db.clock12(s.closeTime) + '), so please pick a date.' };
  return { open: true, why: '' };
}
const officeHours = s => db.clock12(s.openTime) + ' – ' + db.clock12(s.closeTime);

/** Waiting counts and the wait a NEW regular ticket would have, per office. */
async function officeSnapshot() {
  const load = await db.getLoad();
  const out = {};
  for (const dept of ['Cashier', 'Registrar']) {
    const [pos, windows] = await Promise.all([
      predict.positionWait(dept, { lane: 'regular' }), db.getWindows(dept),
    ]);
    out[dept] = {
      waiting: load[dept].waiting, serving: load[dept].serving,
      nowServing: windows.filter(w => w.serving).map(w => ({ label: w.label, ticket: w.serving })),
      openWindows: windows.filter(w => w.status === 'open').length,
      minutes: pos.minutes, closed: !!pos.closed,
    };
  }
  return out;
}

// ── landing page: "What are your transactions today?" ───────────────────────
router.get('/', async (req, res, next) => {
  try {
    await db.processAutoCancel();
    const [settings, offices, mine] = await Promise.all([
      db.getSettings(), officeSnapshot(), myTickets(req),
    ]);
    res.render('pages/queue/home', {
      title: 'Get a Queue Number', settings, offices,
      active: mine.filter(ACTIVE), past: mine.filter(t => !ACTIVE(t)).slice(0, 3),
      sameDay: sameDayStatus(settings), officeHours: officeHours(settings),
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
    const who = guestId
      ? { user: await db.getUser(guestId) }
      : await db.findOrCreateWalkIn(b);
    if (who.error) return renderForm(req, res, b, who.error);

    const r = await db.createRequest(who.user, b, { walkIn: true });
    if (r.error) {
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
    res.redirect('/queue/t/' + r.accessToken);
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
