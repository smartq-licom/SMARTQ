'use strict';
/**
 * Smart Call Next: WHO is called next, and to WHICH window.
 *
 * Who: the Smart Priority Score (a weighted priority score with aging).
 * Inside each lane every client ready to be called gets
 *
 *   score = minutes already waited              (aging: first come stays the base)
 *         + 8 per time passed over              (aging speeds up for anyone skipped)
 *         + 15 if their booked time has come    (an appointment is honoured)
 *         + 20 if they may not be served before closing (the day simulation said so)
 *         + 1.5 x minutes shorter than the lane's average (2+ min), ONLY at a peak hour
 *           (when the line is long, a short task first cuts everyone's average wait)
 *
 * and the highest score is called. Urgency is measured, never typed by the
 * client: a due appointment, a closing-time risk, being passed over. Priority
 * clients (PWD, Senior Citizen, pregnant) keep their own lane, called 1:1.
 *
 * Peak hour: the history marks this weekday and hour as busy (data/peak.js),
 * or the line is long right now (PEAK_PER_WINDOW clients ready per open window).
 *
 * Where: the window rules below.
 * When a window presses Call Next, the dispatcher matches the client to that
 * window with three rules, and the day simulation (data/engine.js) uses the
 * very same rules, so the window a student is told in advance is the window
 * Call Next will really give them.
 *
 *   1. Window speed. Each window's staff member has a learned speed: the
 *      median of (actual minutes / expected minutes for those documents) over
 *      the last 60 days, blended toward 1 while samples are few. 1.3 = takes
 *      30% longer than usual; 0.8 = 20% faster.
 *
 *   2. Shortest task where it helps. A window that is clearly slower than
 *      another open window looks at the first LOOK_AHEAD clients of the lane
 *      and takes the shortest task, leaving long ones (an OTR) to the faster
 *      window. Only when it saves at least MIN_SAVING minutes.
 *
 *   3. Priority to the less busy window. When a priority client is due and
 *      another window is free right now and has done less work today, this
 *      window calls a regular client instead, so the priority client goes to
 *      the less busy one.
 *
 *   0. Best free window. When more windows are free than clients are ready,
 *      the client is saved for the best free window: clearly faster first,
 *      then the one that has done less work today, then whoever is next in
 *      turn. If that window does not call within RESERVE_SECONDS, any window
 *      may take the client, so nobody waits on an idle window.
 *
 *   Fairness (aging). Whoever is passed over gets skip_count + 1, and at
 *   MAX_SKIPS they are called next no matter what, so nobody is held back more
 *   than twice.
 */
const pool    = require('../database/connection');
const predict = require('./prediction');

const q = async (sql, p = []) => (await pool.query(sql, p))[0];

const LOOK_AHEAD  = 3;      // how deep into the lane a window may look
const MAX_SKIPS   = 2;      // nobody is passed over more than this
const SLOWER_BY   = 1.15;   // "clearly slower": 15% or more than the fastest open window
const MIN_SAVING  = 2;      // minutes a shorter task must save to be worth a skip
const SCORE = { WAIT: 1, PASSED: 8, BOOKED_DUE: 15, AT_RISK: 20, SHORT_AT_PEAK: 1.5 };
const PEAK_PER_WINDOW = 3;  // this many ready clients per open window = a rush right now
const PRIOR_N     = 10;     // blend weight while a staff member has few services
const RESERVE_SECONDS = 120; // how long a client is saved for the best free window

// ── 1. window speed ──────────────────────────────────────────────────────────
let speedCache = { at: 0, value: null };
async function staffSpeeds() {
  if (speedCache.value && Date.now() - speedCache.at < 60000) return speedCache.value;
  const rows = await q(
    `SELECT staff_id, actual_minutes / predicted_service AS r FROM transactions
     WHERE ticket_status='completed' AND staff_id IS NOT NULL AND actual_minutes BETWEEN 1 AND 240
       AND predicted_service > 0 AND service_date >= CURDATE() - INTERVAL 60 DAY
       AND completed_at >= ${predict.LEARN_SINCE}`);
  const by = {};
  rows.forEach(x => { (by[x.staff_id] = by[x.staff_id] || []).push(Number(x.r)); });
  const out = {};
  for (const id in by) {
    const n = by[id].length;
    const f = (n * predict.median(by[id]) + PRIOR_N * 1) / (n + PRIOR_N);
    out[id] = { speed: Math.min(1.8, Math.max(0.6, Math.round(f * 100) / 100)), samples: n };
  }
  speedCache = { at: Date.now(), value: out };
  return out;
}

/**
 * The office's windows with their staff, speed, whether they are busy right now
 * and how many minutes of work they have done today.
 */
async function officeWindows(department) {
  const speeds = await staffSpeeds();
  const rows = await q(
    `SELECT w.id, w.label, w.status, w.rr_position, u.id AS staff_id, CONCAT(u.first_name, ' ', u.last_name) AS staff,
       (SELECT UNIX_TIMESTAMP(MAX(t.completed_at)) FROM transactions t WHERE t.window_id = w.id
          AND t.service_date = CURDATE()) AS free_since,
       (SELECT COUNT(*) FROM transactions t WHERE t.window_id = w.id AND t.service_date = CURDATE()
          AND t.ticket_status IN ('called','serving')) AS busy_now,
       (SELECT COALESCE(SUM(t.actual_minutes), 0) FROM transactions t WHERE t.window_id = w.id
          AND t.service_date = CURDATE() AND t.ticket_status = 'completed') AS work_today
     FROM windows w LEFT JOIN users u ON u.window_id = w.id AND u.status = 'active'
     WHERE w.department = ? ORDER BY w.label`, [department]);
  return rows.map(r => {
    const sp = r.staff_id && speeds[r.staff_id];
    return { id: r.id, label: r.label, status: r.status, staffId: r.staff_id, staff: r.staff,
             speed: sp ? sp.speed : 1, samples: sp ? sp.samples : 0,
             free: Number(r.busy_now) === 0, workToday: Number(r.work_today) || 0,
             rr: Number(r.rr_position) || 0, freeSince: r.free_since ? Number(r.free_since) * 1000 : 0 };
  });
}

// ── 2 + 3. the decision for one window ───────────────────────────────────────
/**
 * Pure decision, shared by Call Next and the day simulation.
 *   win      the window asking: { id, label, speed, workToday }
 *   lanes    { priority: [...], regular: [...] } ready clients in FCFS order,
 *            each { id, svc (expected minutes), skip (times passed over) }
 *   lastCat  the lane called last ('priority' | 'regular')
 *   others   the office's OTHER open windows: { label, speed, free, workToday }
 * Returns { pick, lane, skipped: [clients passed over], rule, reason } or null.
 */
/** Which of two windows should get a client first (negative = a). */
function compareWindows(a, b) {
  if (a.speed >= b.speed * SLOWER_BY) return 1;            // clearly slower
  if (b.speed >= a.speed * SLOWER_BY) return -1;
  if (Math.abs(a.workToday - b.workToday) >= MIN_SAVING) return a.workToday - b.workToday;
  return (a.rr || 0) - (b.rr || 0) || String(a.label).localeCompare(String(b.label));
}

/** Why `best` was preferred over `win`, in words. */
function whyBetter(best, win) {
  if (win.speed >= best.speed * SLOWER_BY)
    return `which is faster (${win.label} takes about ${Math.round((win.speed / best.speed - 1) * 100)}% longer)`;
  if (win.workToday - best.workToday >= MIN_SAVING)
    return `which has done less today (${Math.round(best.workToday)} vs ${Math.round(win.workToday)} min)`;
  return 'which is next in turn';
}

// "a 6-min" / "an 8-min" / "an 11-min"
const an = m => { const n = Math.round(m); return (/^(8|11|18)/.test(String(n)) ? 'an ' : 'a ') + n; };

// ── Smart Priority Score ─────────────────────────────────────────────────────
/** One client's score, with the parts that made it (shown to staff as "why"). */
function scoreOf(x, { now, peak, avgSvc }) {
  const parts = [];
  const waited = Math.max(0, (now - (x.queuedAt || x.readyAt || now)) / 60000);
  let s = waited * SCORE.WAIT;
  parts.push(`waited ${Math.round(waited)} min`);
  if (x.skip) { s += x.skip * SCORE.PASSED; parts.push(`passed over ${x.skip}x +${x.skip * SCORE.PASSED}`); }
  if (x.slotStart && now >= x.slotStart) { s += SCORE.BOOKED_DUE; parts.push(`booked time has come +${SCORE.BOOKED_DUE}`); }
  if (x.atRisk) { s += SCORE.AT_RISK; parts.push(`may not be served before closing +${SCORE.AT_RISK}`); }
  if (peak && avgSvc && avgSvc - x.svc >= MIN_SAVING) {           // clearly shorter, not a rounding
    const b = Math.round((avgSvc - x.svc) * SCORE.SHORT_AT_PEAK);
    if (b > 0) { s += b; parts.push(`short task at a peak hour +${b}`); }
  }
  return { score: Math.round(s), parts };
}

/**
 * A lane in calling order: anyone already passed over MAX_SKIPS times first
 * (in arrival order), then the highest score, ties by arrival.
 */
function rankLane(list, ctx) {
  const avgSvc = list.length ? list.reduce((a, x) => a + x.svc, 0) / list.length : 0;
  list.forEach((x, i) => { x._fcfs = i; x._score = scoreOf(x, { ...ctx, avgSvc }); });
  const forced = x => x.skip >= MAX_SKIPS;
  return list.slice().sort((a, b) =>
    (forced(b) - forced(a)) ||
    (forced(a) && forced(b) ? a._fcfs - b._fcfs : (b._score.score - a._score.score) || (a._fcfs - b._fcfs)));
}

/** Hours that this weekday's history marks busy or peak (data/peak.js), for today. */
async function peakHours(department) {
  try {
    const db = require('./db'), peak = require('./peak');
    const prof = await peak.hourlyProfile(department, { ...peak.optsFromSettings(await db.getSettings()), weekday: new Date().getDay() });
    return new Set((prof.hours || []).filter(h => h.level === 'peak' || h.level === 'busy').map(h => h.hour));
  } catch (e) { return new Set(); }
}
const isPeak = (hours, hour, ready, windows) => hours.has(hour) || ready >= PEAK_PER_WINDOW * Math.max(1, windows);

/** The short "why" staff see on Call Next. */
const whyOf = x => x && x._score ? `Score ${x._score.score}: ${x._score.parts.join(' + ')}` : '';

function decide(win, lanes, lastCat, others, { now = Date.now(), reserve = true, peak = false } = {}) {
  const p = lanes.priority, r = lanes.regular;
  if (!p.length && !r.length) return null;
  let lane = p.length && r.length ? (lastCat === 'priority' ? 'regular' : 'priority') : (p.length ? 'priority' : 'regular');
  let skipped = [], rule = 'fcfs', reason = '';

  // 0. best free window: more free windows than clients, and this is not one
  //    of the windows that should get them
  const freeOthers = others.filter(o => o.free);
  if (reserve && freeOthers.length) {
    const order = [win, ...freeOthers].sort(compareWindows);
    if (order.indexOf(win) >= p.length + r.length) {
      const best = order[0], head = lanes[lane][0];
      const left = RESERVE_SECONDS - (now - Math.max(head.readyAt || 0, best.freeSince || 0)) / 1000;
      if (left > 0)
        return { pick: null, head, lane, skipped: [], rule: 'reserved', reserved: true,
                 forWindow: best.label, secondsLeft: Math.ceil(left),
                 reason: `${head.ticketNo} is saved for ${best.label}, ${whyBetter(best, win)}` };
    }
  }

  // 3. priority to the less busy window
  if (lane === 'priority' && r.length && p[0].skip < MAX_SKIPS) {
    const better = others.filter(o => o.free && o.workToday < win.workToday)
                         .sort((a, b) => a.workToday - b.workToday)[0];
    if (better) {
      skipped.push(p[0]);
      lane = 'regular';
      rule = 'priority-routed';
      reason = `priority client kept for ${better.label}, which is free and has done less today ` +
               `(${Math.round(better.workToday)} vs ${Math.round(win.workToday)} min)`;
    }
  }

  // the Smart Priority Score orders the lane; a different first client than
  // arrival order means the ones who came earlier were passed over once
  const fcfs = lanes[lane];
  const list = rankLane(fcfs, { now, peak });
  let pick = list[0];
  if (pick !== fcfs[0]) {
    skipped = skipped.concat(fcfs.slice(0, fcfs.indexOf(pick)));
    rule = rule === 'fcfs' ? 'smart-score' : rule + '+smart-score';
    reason = (reason ? reason + '; ' : '') +
      `${pick.ticketNo || 'a client'} scored ${pick._score.score} (${pick._score.parts.join(', ')}) ` +
      `over ${fcfs[0].ticketNo || 'a client'} with ${fcfs[0]._score.score} (${fcfs[0]._score.parts.join(', ')})`;
  }

  // 2. shortest task where it helps (only for a clearly slower window)
  const fastest = Math.min(...others.map(o => o.speed));
  if (pick.skip < MAX_SKIPS && others.length && win.speed >= fastest * SLOWER_BY) {
    const cands = list.slice(0, LOOK_AHEAD);
    const shortest = cands.reduce((a, b) => (b.svc < a.svc ? b : a));
    if (shortest !== pick && (pick.svc - shortest.svc) * win.speed >= MIN_SAVING) {
      const before = cands.slice(0, cands.indexOf(shortest)).filter(c => c.skip < MAX_SKIPS);
      if (before.length === cands.indexOf(shortest)) {          // nobody already at the limit is jumped
        skipped = skipped.concat(before.filter(b => !skipped.includes(b)));
        reason = (reason ? reason + '; ' : '') +
          `${win.label} is ${Math.round((win.speed / fastest - 1) * 100)}% slower than the fastest open window, ` +
          `so it took ${an(shortest.svc)}-min task and left ${an(pick.svc)}-min one for a faster window`;
        rule = rule === 'fcfs' ? 'shortest-task' : rule + '+shortest-task';
        pick = shortest;
      }
    }
  }
  return { pick, lane, skipped, rule, reason, why: whyOf(pick), peak };
}

// ── one plan for the whole office ────────────────────────────────────────────
/**
 * Every free window gets its OWN client, all at once, so two windows never
 * show (or race for) the same student. Free windows are served best first
 * (faster, then less work today, then next in turn); a window that has sat
 * free for RESERVE_SECONDS while clients wait goes last, so nobody waits on an
 * idle window. Each window then picks with decide(), and its client is taken
 * off the list for the windows after it.
 *
 *   free     open, staffed windows with nobody at them
 *   open     every open, staffed window (for the window rules)
 * Returns a Map windowId -> decision ({ pick, lane, skipped, rule, reason, why }).
 */
function planOffice(free, open, lanes, lastCat, { now = Date.now(), peak = false, acting = null } = {}) {
  const all = lanes.priority.concat(lanes.regular);
  const oldest = all.length ? Math.min(...all.map(x => x.readyAt || now)) : now;
  // the window pressing Call Next right now is clearly not idle
  const idle = w => w.id !== acting && (now - Math.max(w.freeSince || 0, oldest)) / 1000 > RESERVE_SECONDS;
  const order = free.slice().sort((a, b) => (idle(a) - idle(b)) || compareWindows(a, b));
  const left = { priority: lanes.priority.slice(), regular: lanes.regular.slice() };
  const plan = new Map();
  for (const w of order) {
    if (!left.priority.length && !left.regular.length) break;
    // windows still waiting for their client count as free for the window rules
    const others = open.filter(o => o.id !== w.id).map(o => ({ ...o, free: o.free && !plan.has(o.id) }));
    const d = decide(w, left, lastCat, others, { reserve: false, now, peak });
    if (!d) break;
    plan.set(w.id, d);
    left[d.lane].splice(left[d.lane].indexOf(d.pick), 1);
    lastCat = d.lane;
  }
  // a client assigned to another window at the same time was not passed over
  const taken = new Set([...plan.values()].map(d => d.pick.id));
  plan.forEach(d => { d.skipped = d.skipped.filter(x => !taken.has(x.id)); });
  return plan;
}

module.exports = { LOOK_AHEAD, MAX_SKIPS, SLOWER_BY, MIN_SAVING, RESERVE_SECONDS, SCORE, PEAK_PER_WINDOW,
                   staffSpeeds, officeWindows, decide, compareWindows, whyBetter, scoreOf, rankLane, peakHours, isPeak, planOffice };
