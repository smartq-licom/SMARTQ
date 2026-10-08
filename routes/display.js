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
async function predictions(dept, req, queue, settings) {
  const out = { avgWait: await db.todayAverageWait(dept), nextUp: [], join: null, note: null };
  out.qr = await require('qrcode').toString(`${req.protocol}://${req.get('host')}/queue`,
    { type: 'svg', margin: 0, errorCorrectionLevel: 'M', color: { dark: '#14243a', light: '#ffffff' } });
  if (db.isPastClosing(settings)) { out.note = `Closed for today. Book a time for another day.`; return out; }
  if (db.isBeforeJoinOpens(settings)) { out.note = `Today's line opens at ${db.clock12(db.joinOpensAt(settings))}.`; }
  try {
    const sim = await engine.simulateDay(dept, { settings });
    out.nextUp = queue.filter(t => t.ticketStatus === 'waiting' && sim.result[t.id])
      .map(t => ({ ticketNo: t.ticketNo, lane: t.queueCategory, start: sim.result[t.id].start }))
      .sort((a, b) => a.start - b.start).slice(0, 3)
      .map(x => ({ ...x, at: engine.clock(x.start) }));
    if (!out.note) out.join = await engine.evaluateJoin(dept);
  } catch (e) { /* the board must always show */ }
  return out;
}

async function board(dept, req, res, next) {
  try {
    const [queue, windows, settings] = await Promise.all([
      db.getQueue(dept), db.getWindows(dept), db.getSettings(),
    ]);
    const announcement = await db.latestAnnouncement(dept);
    res.render('pages/display/board', {
      announcement, predict: await predictions(dept, req, queue, settings),
      title: dept + ' Queue', dept, settings, windows,
      serving:  queue.filter(t => ['called','serving'].includes(t.ticketStatus)),
      priority: queue.filter(t => t.ticketStatus === 'waiting' && t.queueCategory === 'priority').slice(0, 8),
      regular:  queue.filter(t => t.ticketStatus === 'waiting' && t.queueCategory === 'regular').slice(0, 8),
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
