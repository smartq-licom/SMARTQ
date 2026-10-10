'use strict';
/**
 * SmartQ decision engine.
 *
 * Everything the system DECIDES on its own lives here:
 *
 *   1. Booking slots. The day is cut into 30-minute slots. A slot holds
 *        open windows × 30 minutes ÷ average service time
 *      clients, measured in MINUTES of work so a long document (an OTR) uses
 *      more of a slot than a short one. Only half of every slot can be booked
 *      ahead; the rest stays free for students who scan the QR code that day.
 *
 *   2. A day simulation (discrete-event). Starting from now, it plays the rest
 *      of the day forward window by window: who is at each window and when
 *      they finish, then the waiting line in first-come-first-served order
 *      (by the time they joined, or their booked slot's start), alternating
 *      priority and regular 1:1, skipping the lunch break. Every ticket gets a
 *      predicted start and end time.
 *
 *   3. The capacity decision. The simulation is run twice: with typical
 *      service times (for the estimates people see) and with slow, realistic
 *      ones (the 80th percentile) for warnings, so nobody is promised a turn
 *      on optimistic numbers. A ticket whose slow-case end is after closing
 *      time is warned, with the choice to keep its place, book the next day,
 *      or cancel. Each decision is written to the decision log with its numbers.
 *
 *   4. The watcher (every 30 s): re-runs the simulation as the day changes and
 *      sends phone alerts: "leave now" 15 minutes before a turn, and the
 *      "may not be served today" warning.
 */
const pool    = require('../database/connection');
const predict = require('./prediction');
const push    = require('./push');
const dispatch = require('./dispatch');

const q = async (sql, p = []) => (await pool.execute(sql, p))[0];

const SLOT_MINUTES   = 30;     // length of a booking slot
const BOOK_SHARE     = 0.5;    // share of a slot that can be booked ahead
const LEAVE_NOW_MIN  = 15;     // "leave now" alert, minutes before the turn
const SLOW_DEFAULT   = 1.25;   // slow-case factor until there is history

// ── time helpers (Philippine time; see database/connection.js) ───────────────
const pad   = n => String(n).padStart(2, '0');
const ymd   = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const mins  = hhmm => { const [h, m] = String(hhmm).split(':').map(Number); return h * 60 + (m || 0); };
const hhmm  = m => `${pad(Math.floor(m / 60))}:${pad(m % 60)}`;
const at    = (dateStr, hm) => new Date(`${dateStr}T${hm.length === 5 ? hm + ':00' : hm}`);
const addMin = (d, m) => new Date(d.getTime() + m * 60000);
function clock(d) {
  let h = d.getHours(); const ap = h >= 12 ? 'PM' : 'AM';
  return `${h % 12 || 12}:${pad(d.getMinutes())} ${ap}`;
}
const clock12 = hm => clock(at('2000-01-01', hm));

// ── service-time profile per office ──────────────────────────────────────────
/**
 * Typical (median) minutes per client, the slow-case factor (80th percentile ÷
 * median, from history), and today's live speed factor (how fast the windows
 * are actually finishing clients compared with history).
 */
async function serviceProfile(department, settings) {
  const stats = await predict.getDocumentStats(settings.minSamples);
  const dept  = stats.deptStats[department];
  // learned typical time, blended with the default while samples are few
  const median = dept && dept.usable
    ? predict.shrink(dept.median, dept.samples, settings.avgServiceMinutes)
    : settings.avgServiceMinutes;

  // slow case: 80th percentile of recent service times
  const rows = await q(
    `SELECT actual_minutes AS m FROM transactions
     WHERE department=? AND ticket_status='completed' AND actual_minutes BETWEEN 1 AND 240
       AND completed_at >= ${predict.LEARN_SINCE}
     ORDER BY completed_at DESC LIMIT 120`, [department]);
  let slow = SLOW_DEFAULT;
  if (rows.length >= 8) {
    const v = rows.map(r => Number(r.m)).sort((a, b) => a - b);
    const p80 = v[Math.min(v.length - 1, Math.floor(v.length * 0.8))];
    slow = Math.min(1.6, Math.max(1.1, p80 / Math.max(1, median)));
  }

  // live speed: today's measured pace against the typical time
  let live = 1, liveBasis = 'history';
  const pace = await predict.observedPace(department);
  if (pace.pace) {
    const open = await q(`SELECT COUNT(*) AS c FROM windows WHERE department=? AND status='open'`, [department]);
    const perWindow = pace.pace * Math.max(1, Number(open[0].c) || 1);
    live = Math.min(1.8, Math.max(0.6, perWindow / Math.max(1, median)));
    liveBasis = 'today';
  }

  // history: how service speed changes by weekday and hour, and how many
  // priority clients usually arrive (data/prediction.js)
  const pattern  = await predict.servicePattern(department);
  const arrivals = await predict.priorityArrivals(department);
  // self-correction: recent real waits against what was predicted (data/insights.js)
  const bias = await require('./insights').biasFactor(department);
  const now = new Date();
  return { stats, median, slow, live, liveBasis, pattern, arrivals, bias: bias.factor,
           patternNow: pattern.factor(now.getDay(), now.getHours()) };
}

/**
 * The weekday-hour factor for a moment, from history. When today's live pace
 * is known it already reflects "now", so only the change from now to then is
 * applied (e.g. the 9 AM rush easing by 11 AM).
 */
function patternAt(profile, at) {
  if (!profile.pattern) return 1;
  const f = profile.pattern.factor(at.getDay(), at.getHours());
  return profile.liveBasis === 'today' ? f / (profile.patternNow || 1) : f;
}

/** Minutes this ticket is expected to take at the window, if it starts at `at`. */
function serviceOf(t, profile, at) {
  const base = Number(t.predicted_service) || profile.median;
  return Math.max(1, base * profile.live * (profile.bias || 1) * patternAt(profile, at || new Date()));
}

// ── 1. booking slots ─────────────────────────────────────────────────────────
/** The day's 30-minute slots, skipping the lunch break. */
function daySlots(settings) {
  const out = [];
  const open = mins(settings.openTime), close = mins(settings.closeTime);
  const bs = mins(settings.breakStart), be = mins(settings.breakEnd);
  for (let s = open; s + SLOT_MINUTES <= close; s += SLOT_MINUTES) {
    const e = s + SLOT_MINUTES;
    if (s < be && e > bs) continue;                  // overlaps the break
    out.push({ start: hhmm(s), end: hhmm(e), label: `${clock12(hhmm(s))} – ${clock12(hhmm(e))}` });
  }
  return out;
}

/**
 * Every slot on a date with how much is left for booking. `serviceMin` is how
 * long the student's own documents usually take, so a slot is only offered
 * when that much bookable time is still free.
 */
async function slotPlan(department, dateStr, serviceMin, settings) {
  const s = settings || await require('./db').getSettings();
  const profile = await serviceProfile(department, s);
  const win = await q(`SELECT COUNT(*) AS c FROM windows WHERE department=?`, [department]);
  const windows = Math.max(1, Number(win[0].c) || 1);

  const capacityMin = windows * SLOT_MINUTES;                // minutes of work per slot
  const bookableMin = capacityMin * BOOK_SHARE;
  const capacity    = Math.floor(capacityMin / profile.median);   // clients per slot

  const rows = await q(
    `SELECT TIME_FORMAT(slot_start,'%H:%i') AS s, COUNT(*) AS n,
            SUM(COALESCE(predicted_service, ?)) AS m
     FROM transactions
     WHERE department=? AND service_date=? AND slot_start IS NOT NULL
       AND overall_status <> 'cancelled'
     GROUP BY slot_start`, [profile.median, department, dateStr]);
  const used = {};
  rows.forEach(r => { used[r.s] = { n: Number(r.n), m: Number(r.m) }; });

  const now = new Date(), isToday = dateStr === ymd(now);
  const need = Math.max(1, Number(serviceMin) || profile.median);
  const dow = new Date(dateStr + 'T00:00:00').getDay();
  const slots = daySlots(s).map(sl => {
    // that weekday and hour's usual speed (history): a slow hour fits fewer
    const f = profile.pattern ? profile.pattern.factor(dow, Number(sl.start.slice(0, 2))) : 1;
    const u = used[sl.start] || { n: 0, m: 0 };
    const leftMin = Math.max(0, bookableMin - u.m * f);
    const past = isToday && at(dateStr, sl.end) <= now;
    return {
      ...sl, booked: u.n, pace: Math.round(f * 100) / 100,
      capacity: Math.floor(capacityMin / (profile.median * f)),
      placesLeft: Math.floor(leftMin / (profile.median * f)),
      available: !past && leftMin >= need * f,
      past,
    };
  });
  return {
    date: dateStr, windows, capacity, bookable: Math.floor(bookableMin / profile.median),
    serviceMin: Math.round(need), avgService: Math.round(profile.median * 10) / 10, slots,
  };
}

// ── 2. day simulation ────────────────────────────────────────────────────────
/**
 * Plays the rest of today forward for one office. Returns each ticket's
 * predicted start/end and whether it ends before closing.
 *
 *   extra: { lane, service } adds a hypothetical client joining now
 *          (what the QR page shows before someone takes a number).
 *   slow:  use the slow-case service times (for warnings).
 */
async function simulateDay(department, { extra = null, slow = false, settings = null, profile = null, expected = true } = {}) {
  const db = require('./db');
  const s  = settings || await db.getSettings();
  const pr = profile || await serviceProfile(department, s);
  const factor = slow ? pr.slow : 1;
  const now = new Date(), today = ymd(now);

  const openAt  = at(today, s.openTime),  close   = at(today, s.closeTime);
  const brStart = at(today, s.breakStart), brEnd  = at(today, s.breakEnd);
  const base = now > openAt ? now : openAt;

  // The office's real windows, each with its staff member's speed and today's
  // work (data/dispatch.js). Before opening (or with every window closed)
  // assume the windows will be staffed, so students still get an estimate.
  const all = await dispatch.officeWindows(department);
  const open = all.filter(w => w.status === 'open');
  const slots = (open.length ? open : all.length ? all : [{ id: null, label: department, speed: 1, workToday: 0 }])
    .map(w => ({ id: w.id, label: w.label, speed: w.speed || 1, work: w.workToday || 0, rr: w.rr || 0, free: base }));

  const rows = await q(
    `SELECT id, ticket_no, queue_category, ticket_status, queue_at, hold_until, called_at, started_at,
            predicted_service, skip_count, window_id
     FROM transactions
     WHERE department=? AND service_date=CURDATE() AND ticket_status IN ('waiting','called','serving')
     ORDER BY queue_at, id`, [department]);

  const result = {};
  rows.filter(r => r.ticket_status !== 'waiting').forEach(r => {
    let slot = slots.find(x => x.id === r.window_id);
    if (!slot) { slot = { id: r.window_id, label: 'a window', speed: 1, work: 0, free: base }; slots.push(slot); }
    const from = new Date(r.started_at || r.called_at || now);
    let end = addMin(from, serviceOf(r, pr, from) * slot.speed * factor);
    if (end < now) end = addMin(now, 1);            // running long: assume about to finish
    slot.free = end > slot.free ? end : slot.free;
    result[r.id] = { start: from, end, fits: end <= close, atWindow: true, window: slot.label };
  });
  const c = slots.length;

  const lane = { priority: [], regular: [] };
  rows.filter(r => r.ticket_status === 'waiting')
      .forEach(r => lane[r.queue_category === 'priority' ? 'priority' : 'regular'].push(r));
  if (extra) {
    lane[extra.lane === 'priority' ? 'priority' : 'regular'].push(
      { id: 'extra', queue_at: now, predicted_service: extra.service || null });
  }
  // Priority clients who have not arrived yet but usually do (history, per
  // weekday and hour): added at the times they are expected, every 5 minutes'
  // worth of the usual rate. They cut in 1:1, so regular waits include them.
  let expectedCount = 0;
  if (expected && pr.arrivals) {
    let acc = 0.5;                                   // rounds to the nearest person, not always down
    for (let t = new Date(base); t < close; t = addMin(t, 5)) {
      if (t >= brStart && t < brEnd) continue;
      acc += pr.arrivals.perHour(t.getDay(), t.getHours()) * 5 / 60;
      while (acc >= 1) {
        acc -= 1;
        lane.priority.push({ id: 'exp' + (++expectedCount), queue_at: new Date(t), expected: true });
      }
    }
    lane.priority.sort((a, b) => new Date(a.queue_at) - new Date(b.queue_at));
  }
  // Registrar: students expected today for ready OTRs (paid, due, not collected,
  // no claim booked), spread over the rest of the day as regular arrivals.
  let expectedClaims = 0;
  if (expected && department === 'Registrar') {
    try {
      const n = await db.expectedClaimsToday();
      const span = Math.max(1, (close - base) / 60000 - Math.max(0, (Math.min(close, brEnd) - Math.max(base, brStart)) / 60000));
      for (let i = 0; i < n; i++) {
        let t = addMin(base, (i + 0.5) * span / n);
        if (t >= brStart) t = addMin(t, Math.max(0, (brEnd - brStart) / 60000));
        if (t >= close) break;
        lane.regular.push({ id: 'claim' + i, queue_at: t, expected: true, claimExpected: true });
        expectedClaims++;
      }
      lane.regular.sort((a, b) => new Date(a.queue_at) - new Date(b.queue_at));
    } catch (e) { /* a forecast must never fail */ }
  }
  let expectedServed = 0, claimsServed = 0;

  const last = await q(
    `SELECT queue_category FROM transactions
     WHERE department=? AND service_date=CURDATE() AND called_at IS NOT NULL
     ORDER BY called_at DESC, id DESC LIMIT 1`, [department]);
  let lastCat = last.length ? last[0].queue_category : 'regular';

  // Each client gets the same fields Call Next uses (expected minutes, times passed over).
  [...lane.priority, ...lane.regular].forEach(x => {
    x.svc = Number(x.predicted_service) || pr.median;
    x.skip = Number(x.skip_count) || 0;
  });

  let guard = 0;
  const realLeft = () => lane.regular.some(x => !x.expected) || lane.priority.some(x => !x.expected);
  const readyAt = x => Math.max(new Date(x.queue_at).getTime(), x.hold_until ? new Date(x.hold_until).getTime() : 0);
  while (realLeft() && guard++ < 5000) {
    // the window that frees up first; when several are free together, the
    // best one (dispatch rule 0: faster, less work today, next in turn)
    const first = slots.reduce((a, b) => (b.free < a.free ? b : a));
    const at = Math.max(first.free.getTime(), now.getTime());
    const win = slots.filter(x => x.free.getTime() <= at)
      .sort((a, b) => dispatch.compareWindows({ ...a, workToday: a.work }, { ...b, workToday: b.work }))[0];
    let t0 = new Date(Math.max(win.free.getTime(), first.free.getTime()));
    if (t0 >= brStart && t0 < brEnd) t0 = brEnd;    // nobody is called over lunch

    // Who is ready by t0 (a booking waits for its slot start; "available from"
    // is skipped until then), then the window picks exactly as Call Next does.
    const ready = { priority: lane.priority.filter(x => readyAt(x) <= t0.getTime()),
                    regular:  lane.regular.filter(x => readyAt(x) <= t0.getTime()) };
    const others = slots.filter(o => o !== win).map(o => ({ label: o.label, speed: o.speed, free: o.free <= t0, workToday: o.work }));
    const d = dispatch.decide({ label: win.label, speed: win.speed, workToday: win.work }, ready, lastCat, others, { reserve: false });
    if (!d) {                                        // nobody ready yet: jump to the next one who is
      win.free = new Date(Math.min(...lane.priority.concat(lane.regular).map(readyAt)));
      continue;
    }
    d.skipped.forEach(x => { x.skip++; });
    const tk = d.pick;
    lane[d.lane].splice(lane[d.lane].indexOf(tk), 1);
    const mins = serviceOf(tk, pr, t0) * win.speed * factor;
    const start = t0, end = addMin(start, mins);
    if (tk.expected) { if (tk.claimExpected) claimsServed++; else expectedServed++; }
    else result[tk.id] = { start, end, fits: end <= close, expectedAhead: expectedServed, claimsAhead: claimsServed, window: win.label };
    win.free = end;
    win.work += mins;
    lastCat = d.lane;
  }
  return { result, close, windows: c, assumed: !open.length, profile: pr, factor, expectedCount, expectedClaims };
}

// ── 3. decisions ─────────────────────────────────────────────────────────────
async function logDecision(txId, department, decision, reason, detail) {
  try {
    await q(`INSERT INTO decision_log (transaction_id,department,decision,reason,detail) VALUES (?,?,?,?,?)`,
            [txId || null, department || null, decision, String(reason).slice(0, 255),
             detail ? JSON.stringify(detail) : null]);
  } catch (e) { /* logging must never block a ticket */ }
}

/**
 * Before someone joins today's line: when would they start, and do they fit
 * before closing even if the windows run slow?
 */
async function evaluateJoin(department, { lane = 'regular', service = null } = {}) {
  const db = require('./db');
  const settings = await db.getSettings();
  const profile  = await serviceProfile(department, settings);
  const typ  = await simulateDay(department, { extra: { lane, service }, settings, profile });
  const slow = await simulateDay(department, { extra: { lane, service }, settings, profile, slow: true });
  const e = typ.result.extra, sl = slow.result.extra;
  const minutes = Math.max(0, Math.round((e.start - Date.now()) / 60000));
  const fits = sl.end <= slow.close;
  return {
    decision: fits ? 'accept' : 'accept_warned',
    fits, minutes, expectedAhead: e.expectedAhead || 0, claimsAhead: e.claimsAhead || 0,
    patternUsed: !!(profile.pattern && profile.pattern.samples >= 20),
    startClock: clock(e.start),
    slowEndClock: clock(sl.end),
    closeClock: clock(slow.close),
    windows: typ.windows, assumed: typ.assumed,
    reason: fits
      ? `Predicted start ${clock(e.start)}; even at a slow pace done by ${clock(sl.end)}, before closing ${clock(slow.close)}.`
      : `Predicted start ${clock(e.start)}; at a slow pace done by ${clock(sl.end)}, after closing ${clock(slow.close)}.`,
  };
}

/** Today's estimate for one waiting ticket (typical and slow case). */
async function ticketForecast(t) {
  const db = require('./db');
  const settings = await db.getSettings();
  const profile  = await serviceProfile(t.department, settings);
  const typ  = await simulateDay(t.department, { settings, profile });
  const slow = await simulateDay(t.department, { settings, profile, slow: true });
  const a = typ.result[t.id], b = slow.result[t.id];
  if (!a) return null;
  return {
    start: a.start, startClock: clock(a.start),
    minutes: Math.max(0, Math.round((a.start - Date.now()) / 60000)),
    fits: b ? b.end <= slow.close : true,
    slowEndClock: b ? clock(b.end) : null,
    closeClock: clock(slow.close),
    live: profile.live, liveBasis: profile.liveBasis,
    expectedAhead: a.expectedAhead || 0, claimsAhead: a.claimsAhead || 0,
    patternUsed: !!(profile.pattern && profile.pattern.samples >= 20),
    window: a.window || null,
  };
}

// ── 4. watcher: re-decide as the day moves, and alert phones ─────────────────
/**
 * A processed document (the OTR, 14 days) reached its release date: tell the
 * phone that paid for it, once, during office hours. Not if already claimed.
 */
async function releaseAlerts(db, settings) {
  const [h, m] = String(settings.openTime || '08:00').split(':').map(Number);
  const now = new Date();
  if (now.getHours() * 60 + now.getMinutes() < h * 60 + (m || 0)) return;   // in the morning, once open
  const rows = await q(
    `SELECT td.id, td.document_name, d.processing_days, p.paid_at, t.id AS tx_id, t.ticket_no, t.access_token
     FROM transaction_documents td
     JOIN transactions t ON t.id = td.transaction_id
     JOIN documents d ON d.id = td.document_id
     JOIN payments p ON p.transaction_id = t.id AND p.status = 'paid'
     WHERE d.processing_days > 0 AND d.requires_claim = 1 AND td.ready_notified_at IS NULL
       AND t.department = 'Cashier' AND t.payment_status = 'paid'
       AND DATE(p.paid_at) + INTERVAL d.processing_days DAY <= CURDATE()
       AND DATE(p.paid_at) >= CURDATE() - INTERVAL 120 DAY
       AND NOT EXISTS (SELECT 1 FROM claim_items ci JOIN transactions c ON c.id = ci.claim_tx_id
                       WHERE ci.line_id = td.id AND c.ticket_status = 'completed')
     LIMIT 50`);
  for (const r of rows) {
    const readyOn = await db.releaseDate(db.ymd ? db.ymd(new Date(r.paid_at)) : new Date(r.paid_at).toISOString().slice(0, 10), Number(r.processing_days));
    if (readyOn > db.today()) continue;               // moved past a closed day: not yet
    await q('UPDATE transaction_documents SET ready_notified_at=NOW() WHERE id=?', [r.id]);
    await push.sendToTicket(r.tx_id, {
      title: `Your ${r.document_name} is ready`,
      body: 'It can now be released at the Registrar. Bring your receipt and a valid ID.',
      url: r.access_token ? '/queue/t/' + r.access_token : '/queue',
    });
  }
}

async function watch() {
  const db = require('./db');
  const settings = await db.getSettings();
  const now = new Date();
  if (db.isPastClosing(settings)) return;          // the day is over: nothing left to warn about
  try { await releaseAlerts(db, settings); } catch (e) { console.error('[RELEASE]', e.message); }
  for (const department of ['Cashier', 'Registrar']) {
    const waiting = await q(
      `SELECT id, ticket_no, access_token, queue_at, risk_at, alerts_sent FROM transactions
       WHERE department=? AND service_date=CURDATE() AND ticket_status='waiting'`, [department]);
    if (!waiting.length) continue;
    const profile = await serviceProfile(department, settings);
    const typ  = await simulateDay(department, { settings, profile });
    const slow = await simulateDay(department, { settings, profile, slow: true });

    for (const w of waiting) {
      const a = typ.result[w.id], b = slow.result[w.id];
      if (!a) continue;
      const sent = new Set(String(w.alerts_sent || '').split(',').filter(Boolean));
      const url  = w.access_token ? '/queue/t/' + w.access_token : '/queue';
      const add  = async tag => {
        sent.add(tag);
        await q('UPDATE transactions SET alerts_sent=? WHERE id=?', [[...sent].join(',').slice(0, 80), w.id]);
      };

      // may not be served today (slow case ends after closing)
      if (b && b.end > slow.close && !w.risk_at) {
        await q('UPDATE transactions SET risk_at=NOW() WHERE id=?', [w.id]);
        await logDecision(w.id, department, 'warned',
          `${w.ticket_no}: at a slow pace done by ${clock(b.end)}, after closing ${clock(slow.close)}.`,
          { predictedStart: clock(a.start), slowEnd: clock(b.end), close: clock(slow.close) });
        await push.sendToTicket(w.id, {
          title: `${w.ticket_no}: you may not be served today`,
          body: 'The line is slower than expected. Open your ticket to keep your place, book tomorrow, or cancel.',
          url,
        });
      }

      // leave now: about 15 minutes before the predicted turn
      const lead = (a.start - now) / 60000;
      if (lead <= LEAVE_NOW_MIN && new Date(w.queue_at) <= addMin(now, LEAVE_NOW_MIN) && !sent.has('leave')) {
        await add('leave');
        await push.sendToTicket(w.id, {
          title: `Leave now: ${w.ticket_no}`,
          body: `Your turn at the ${department} is in about ${Math.max(1, Math.round(lead))} minutes (around ${clock(a.start)})` +
                (a.window ? `, most likely at ${a.window}.` : '.'),
          url,
        });
      }
    }
  }
}

module.exports = {
  SLOT_MINUTES, BOOK_SHARE, LEAVE_NOW_MIN,
  daySlots, slotPlan, serviceProfile, simulateDay,
  evaluateJoin, ticketForecast, logDecision, watch, clock,
};
