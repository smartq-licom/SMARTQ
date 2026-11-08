'use strict';
const express = require('express');
const router  = express.Router();
const db      = require('../data/db');
const engine  = require('../data/engine');

router.get('/', (req, res) => res.redirect('/display/cashier'));

/**
 * "SmartQ predicts" on the TV: the next numbers in the real call order (the
 * day simulation, with the 1:1 alternation), the wait for someone joining
 * now, today's actual average, and a QR code to join from the screen.
 */
// The QR code never changes for one address: drawn once, not on every load.
const qrCache = new Map();
function qrFor(url) {
  if (!qrCache.has(url)) {
    qrCache.set(url, require('qrcode').toString(url,
      { type: 'svg', margin: 0, errorCorrectionLevel: 'M', color: { dark: '#14243a', light: '#ffffff' } }));
    if (qrCache.size > 10) qrCache.delete(qrCache.keys().next().value);
  }
  return qrCache.get(url);
}

async function predictions(dept, req, queue, settings) {
  const out = { avgWait: await db.todayAverageWait(dept), nextUp: [], join: null, note: null };
  out.qr = await qrFor(`${req.protocol}://${req.get('host')}/queue`);
  // After closing with people still in line, the staff finish it: no new
  // numbers, but the board keeps the remaining order (the day simulated to
  // midnight, with no new arrivals). Once the line is empty: closed.
  let simOpts = null;                                   // null: the normal day, shared
  if (db.isPastClosing(settings)) {
    const left = queue.some(t => ['waiting', 'called', 'serving'].includes(t.ticketStatus));
    if (!left) { out.note = `Closed for today. Book a time for another day.`; return out; }
    out.finishing = true;
    out.note = `Closed for new numbers today. Book a time for another day.`;
    simOpts = { settings: { ...settings, closeTime: '23:59' }, expected: false };
  }
  if (!out.note && db.isBeforeJoinOpens(settings)) { out.note = `Today's line opens at ${db.clock12(db.joinOpensAt(settings))}.`; }
  try {
    // Every TV, ticket and staff screen shares one day simulation (8 s) and one
    // "if you join now" (20 s): a board reloading often no longer re-runs the
    // whole day each time, which froze the small online server.
    const [sim, join] = await Promise.all([
      simOpts ? engine.simulateDay(dept, simOpts) : engine.simulateDayCached(dept),
      out.note ? null : engine.evaluateJoinCached(dept),
    ]);
    out.nextUp = queue.filter(t => t.ticketStatus === 'waiting' && sim.result[t.id])
      .map(t => ({ ticketNo: t.ticketNo, lane: t.queueCategory, start: sim.result[t.id].start }))
      .sort((a, b) => a.start - b.start).slice(0, 3)
      .map(x => ({ ...x, at: engine.clock(x.start) }));
    out.join = join;
  } catch (e) { /* the board must always show */ }
  return out;
}

async function board(dept, req, res, next) {
  try {
    const [queue, windows, settings, announcement] = await Promise.all([
      db.getQueue(dept), db.getWindows(dept), db.getSettings(), db.latestAnnouncement(dept),
    ]);
    res.render('pages/display/board', {
      announcement, predict: await predictions(dept, req, queue, settings),
      title: dept + ' Queue', dept, settings, windows,
      serving:  queue.filter(t => ['called','serving'].includes(t.ticketStatus)),
      priority: queue.filter(t => t.ticketStatus === 'waiting' && t.queueCategory === 'priority').slice(0, 8),
      // walk-ins (C-/R-) and booked times (CB-/RB-, with their time) shown apart
      regular:  queue.filter(t => t.ticketStatus === 'waiting' && t.queueCategory === 'regular' && !t.slotStart).slice(0, 8),
      booked:   queue.filter(t => t.ticketStatus === 'waiting' && t.queueCategory === 'regular' && t.slotStart)
                     .sort((a, b) => a.slotStart.localeCompare(b.slotStart)).slice(0, 8),
      // the lanes show only the first few; the badges count everyone waiting
      waitingCount: {
        priority: queue.filter(t => t.ticketStatus === 'waiting' && t.queueCategory === 'priority').length,
        regular:  queue.filter(t => t.ticketStatus === 'waiting' && t.queueCategory === 'regular' && !t.slotStart).length,
        booked:   queue.filter(t => t.ticketStatus === 'waiting' && t.queueCategory === 'regular' && t.slotStart).length,
      },
      recent:   queue.filter(t => t.ticketStatus === 'completed')
                     .sort((a,b) => new Date(b.completedAt) - new Date(a.completedAt)).slice(0, 6),
    });
  } catch (e) { next(e); }
}
router.get('/cashier',   (req, res, next) => board('Cashier', req, res, next));
router.get('/registrar', (req, res, next) => board('Registrar', req, res, next));

// Polled every ~1.5 s by the board: the newest call's id, so the alert can
// sound as soon as staff press Call Next.
async function pulse(dept, res, next) {
  try {
    res.set('Cache-Control', 'no-store');
    res.json({ id: await db.announcementPulse(dept) });
  } catch (e) { next(e); }
}
router.get('/cashier/pulse',   (req, res, next) => pulse('Cashier', res, next));
router.get('/registrar/pulse', (req, res, next) => pulse('Registrar', res, next));

// Public "now serving" summary for the phone widgets (widgets/README.md).
// Ticket numbers only, never names: anyone with the link can read it.
// Flat keys (cashier_1, registrar_2, ...) keep KWGT's JSON paths short.
router.get('/widget.json', async (req, res, next) => {
  try {
    const windows = await db.getWindows();
    const out = { updated: new Date().toISOString() };
    for (const dept of ['Cashier', 'Registrar']) {
      const key  = dept.toLowerCase();
      const mine = windows.filter(w => w.department === dept);
      out[key] = {
        waiting: mine.length ? mine[0].waitingDept : 0,
        windows: mine.map(w => ({ label: w.label, status: w.status, serving: w.serving || '—' })),
      };
      out[key + '_waiting'] = out[key].waiting;
      mine.forEach((w, i) => { out[key + '_' + (i + 1)] = w.serving || '—'; });
    }
    res.set('Cache-Control', 'no-store');
    res.json(out);
  } catch (e) { next(e); }
});

module.exports = router;
