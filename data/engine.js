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

  const wins = await q(`SELECT status FROM windows WHERE department=?`, [department]);
  const openCount = wins.filter(w => w.status === 'open').length;
  // Before opening (or with every window on break) assume the office's
  // windows will be staffed, so students still get an estimate.
  let c = openCount || wins.length || 1;

  const rows = await q(
    `SELECT id, ticket_no, queue_category, ticket_status, queue_at, hold_until, called_at, started_at, predicted_service
     FROM transactions
     WHERE department=? AND service_date=CURDATE() AND ticket_status IN ('waiting','called','serving')
     ORDER BY queue_at, id`, [department]);

  const inService = rows.filter(r => r.ticket_status !== 'waiting');
  c = Math.max(c, inService.length);
  const free = Array(c).fill(base);
  const result = {};
  inService.forEach((r, i) => {
    const from = new Date(r.started_at || r.called_at || now);
    let end = addMin(from, serviceOf(r, pr, from) * factor);
    if (end < now) end = addMin(now, 1);            // running long: assume about to finish
    free[i] = end;
    result[r.id] = { start: from, end, fits: end <= close, atWindow: true };
  });

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
  let expectedServed = 0;

  const last = await q(
    `SELECT queue_category FROM transactions
     WHERE department=? AND service_date=CURDATE() AND called_at IS NOT NULL
     ORDER BY called_at DESC, id DESC LIMIT 1`, [department]);
  let lastCat = last.length ? last[0].queue_category : 'regular';

  let guard = 0;
  const realLeft = () => lane.regular.length || lane.priority.some(x => !x.expected);
  while (realLeft() && guard++ < 5000) {
    // the window that frees up first
    let w = 0;
    for (let i = 1; i < c; i++) if (free[i] < free[w]) w = i;
    let t0 = free[w];
    if (t0 >= brStart && t0 < brEnd) t0 = brEnd;    // nobody is called over lunch

    // First in each lane who may be called by t0: a booking waits for its slot
    // start, and a student who is "available from" later is skipped (keeping
    // their place) until then.
    const readyAt = x => Math.max(new Date(x.queue_at).getTime(), x.hold_until ? new Date(x.hold_until).getTime() : 0);
    const first = l => lane[l].findIndex(x => readyAt(x) <= t0.getTime());
    const pi = first('priority'), ri = first('regular');
    const p = pi >= 0 ? 'priority' : null, r = ri >= 0 ? 'regular' : null;
    let pick = p && r ? (lastCat === 'priority' ? 'regular' : 'priority') : (p || r);
    if (!pick) {                                     // nobody ready yet: jump to the next one who is
      const next = Math.min(...lane.priority.concat(lane.regular).map(readyAt));
      free[w] = new Date(next);
      continue;
    }
    const tk = lane[pick].splice(pick === 'priority' ? pi : ri, 1)[0];
    const start = t0, end = addMin(start, serviceOf(tk, pr, start) * factor);
    if (tk.expected) expectedServed++;
    else result[tk.id] = { start, end, fits: end <= close, expectedAhead: expectedServed };
    free[w] = end;
    lastCat = pick;
  }
  return { result, close, windows: c, assumed: !openCount, profile: pr, factor, expectedCount };
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
    fits, minutes, expectedAhead: e.expectedAhead || 0,
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
    expectedAhead: a.expectedAhead || 0,
    patternUsed: !!(profile.pattern && profile.pattern.samples >= 20),
  };
}

// ── 4. watcher: re-decide as the day moves, and alert phones ─────────────────
async function watch() {
  const db = require('./db');
  const settings = await db.getSettings();
  const now = new Date();
  if (db.isPastClosing(settings)) return;          // the day is over: nothing left to warn about
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
          body: `Your turn at the ${department} is in about ${Math.max(1, Math.round(lead))} minutes (around ${clock(a.start)}).`,
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
