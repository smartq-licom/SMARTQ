'use strict';
/**
 * Waiting-time estimation for SmartQ.
 *
 * Two different questions need two different models:
 *
 *   1. "I am holding ticket R-014, when will I be called?"
 *      Position-based. We know exactly where the client stands, so counting
 *      the queue ahead of them beats any probabilistic model.
 *
 *   2. "Should I come to the office at all right now?"
 *      The client has no position yet, so we fall back to queueing theory —
 *      Erlang C on an M/M/c queue — to predict the wait for someone who
 *      arrives this minute.
 *
 * Service time uses the MEDIAN, not the mean. One 40-minute enrolment problem
 * would drag a mean upwards and make every later estimate too pessimistic.
 */
const pool = require('../database/connection');
const q = async (sql, p = []) => (await pool.execute(sql, p))[0];

// ── statistics helpers ───────────────────────────────────────────────────────
function median(values) {
  if (!values.length) return null;
  const a = values.slice().sort((x, y) => x - y);
  const mid = Math.floor(a.length / 2);
  return a.length % 2 ? a[mid] : (a[mid - 1] + a[mid]) / 2;
}

/**
 * Exponentially weighted moving average.
 * Recent transactions matter more, but one outlier cannot dominate.
 * alpha 0.2 means roughly the last 5 observations carry most of the weight.
 */
function ewma(values, alpha = 0.2) {
  if (!values.length) return null;
  return values.reduce((acc, v, i) => (i === 0 ? v : alpha * v + (1 - alpha) * acc), 0);
}

// ── service time per item, with a fallback ladder ────────────────────────────
/**
 * Ladder, most specific first:
 *   1. median of recent completions of THIS item
 *   2. median of recent completions in the same office
 *   3. the baseline minutes the admin configured for the item
 */
async function getDocumentStats(minSamples = 3, lookback = 30) {
  const rows = await q(
    `SELECT td.document_name AS name, t.department, t.actual_minutes AS mins
     FROM transactions t
     JOIN transaction_documents td ON td.transaction_id = t.id
     WHERE t.ticket_status='completed' AND t.actual_minutes IS NOT NULL
       AND t.actual_minutes BETWEEN 1 AND 240
     ORDER BY t.completed_at DESC`);

  const byItem = {}, byDept = {};
  rows.forEach(r => {
    (byItem[r.name] = byItem[r.name] || []).push(Number(r.mins));
    (byDept[r.department] = byDept[r.department] || []).push(Number(r.mins));
  });

  const documentStats = {};
  for (const name in byItem) {
    const recent = byItem[name].slice(0, lookback);
    documentStats[name] = {
      samples: recent.length,
      median: median(recent),
      ewma: ewma(recent.slice().reverse()),
      usable: recent.length >= minSamples,
    };
  }
  const deptStats = {};
  for (const d in byDept) {
    const recent = byDept[d].slice(0, lookback * 3);
    deptStats[d] = { samples: recent.length, median: median(recent), usable: recent.length >= minSamples };
  }
  return { documentStats, deptStats };
}

/**
 * Minutes to allow for one transaction covering these items.
 * Returns the figure plus which rung of the ladder produced it, so the
 * admin screen can show whether a number is learned or assumed.
 */
/**
 * Careful learning (shrinkage toward a prior). With only a few samples, a
 * learned time is blended with the configured default, and trusted more as
 * samples grow:  (n × median + K × default) ÷ (n + K).  Five 1-minute samples
 * give about 5.7 min, not 1; a hundred real samples are almost all data.
 */
const PRIOR_WEIGHT = 10;
function shrink(median, n, prior) {
  return (n * median + PRIOR_WEIGHT * prior) / (n + PRIOR_WEIGHT);
}

// ── historical patterns (weekday × hour) ─────────────────────────────────────
const PATTERN_DAYS = 120;           // how far back the patterns look
const patternCache = {};            // recomputed at most once a minute per office
const cached = async (key, fn) => {
  const c = patternCache[key];
  if (c && Date.now() - c.at < 60000) return c.value;
  const value = await fn();
  patternCache[key] = { at: Date.now(), value };
  return value;
};
const clampF = f => Math.min(1.8, Math.max(0.6, f));

/**
 * When service runs slower or faster, from history: the median service time
 * per weekday and hour, as a factor of the office's usual time (1.3 = 30%
 * slower, e.g. Monday 9 AM). A thin weekday-hour cell is blended toward that
 * hour's factor, and the hour toward 1 (shrink), so a few odd days cannot
 * swing it. factor(weekday 0-6, hour 0-23) is used by the day simulation.
 */
async function servicePattern(department) {
  return cached('svc:' + department, async () => {
    const rows = await q(
      `SELECT DAYOFWEEK(service_date) - 1 AS dow, HOUR(COALESCE(started_at, called_at)) AS h, actual_minutes AS m
       FROM transactions
       WHERE department=? AND ticket_status='completed' AND actual_minutes BETWEEN 1 AND 240
         AND COALESCE(started_at, called_at) IS NOT NULL
         AND service_date >= CURDATE() - INTERVAL ${PATTERN_DAYS} DAY`, [department]);
    if (rows.length < 20) return { samples: rows.length, factor: () => 1, cells: {}, hours: {} };
    const all = median(rows.map(r => Number(r.m)));
    const byHour = {}, byCell = {};
    rows.forEach(r => {
      (byHour[r.h] = byHour[r.h] || []).push(Number(r.m));
      (byCell[r.dow + '-' + r.h] = byCell[r.dow + '-' + r.h] || []).push(Number(r.m));
    });
    const hours = {}, cells = {};
    for (const h in byHour) hours[h] = shrink(median(byHour[h]), byHour[h].length, all) / all;
    for (const k in byCell) {
      const h = k.split('-')[1], v = byCell[k];
      cells[k] = shrink(median(v), v.length, all * (hours[h] || 1)) / all;
    }
    return {
      samples: rows.length, overall: all, hours, cells,
      factor: (dow, h) => clampF(cells[dow + '-' + h] || hours[h] || 1),
    };
  });
}

/**
 * Priority clients who usually ARRIVE, from history: the average number per
 * weekday and hour (arrivals ÷ days that office was open on that weekday).
 * They cut in 1:1, so a regular client's wait includes the ones still to come.
 */
async function priorityArrivals(department) {
  return cached('pri:' + department, async () => {
    const days = await q(
      `SELECT DAYOFWEEK(service_date) - 1 AS dow, COUNT(DISTINCT service_date) AS n
       FROM transactions WHERE department=? AND service_date >= CURDATE() - INTERVAL ${PATTERN_DAYS} DAY
         AND service_date < CURDATE()
       GROUP BY dow`, [department]);
    const rows = await q(
      `SELECT DAYOFWEEK(service_date) - 1 AS dow, HOUR(COALESCE(queue_at, requested_at)) AS h, COUNT(*) AS n
       FROM transactions
       WHERE department=? AND queue_category='priority' AND slot_start IS NULL
         AND service_date >= CURDATE() - INTERVAL ${PATTERN_DAYS} DAY AND service_date < CURDATE()
       GROUP BY dow, h`, [department]);
    const open = {};
    days.forEach(d => { open[d.dow] = Number(d.n); });
    const rate = {};
    rows.forEach(r => { if (open[r.dow] >= 2) rate[r.dow + '-' + r.h] = Number(r.n) / open[r.dow]; });
    return { rate, perHour: (dow, h) => rate[dow + '-' + h] || 0 };
  });
}

async function estimateService(items, department, settings, stats) {
  const s = stats || await getDocumentStats(settings.minSamples);
  let total = 0;
  let source = 'baseline';

  for (const it of items) {
    const st = s.documentStats[it.name];
    const prior = it.baselineMinutes || settings.avgServiceMinutes;
    if (st && st.usable) {
      total += shrink(st.median, st.samples, prior);
      source = 'historical';
    } else if (s.deptStats[department] && s.deptStats[department].usable) {
      total += shrink(s.deptStats[department].median, s.deptStats[department].samples, prior);
      if (source !== 'historical') source = 'office';
    } else {
      total += prior;
    }
  }
  return { minutes: Math.max(1, Math.round(total)), source };
}

// ── model 1: position-based wait for a client who already has a ticket ───────
/**
 * Counts what is genuinely ahead of this ticket:
 *   - everyone in the same lane who arrived earlier
 *   - priority tickets that will jump ahead of a regular ticket
 *   - the clients currently being served
 * then divides by the number of windows actually open.
 */
async function positionWait(department, { lane = 'regular', requestedAt = null, ticketId = null } = {}) {
  const settings = await require('./db').getSettings();
  const stats    = await getDocumentStats(settings.minSamples);

  const wins = await q(
    `SELECT COUNT(*) AS c FROM windows WHERE department=? AND status='open'`, [department]);
  const openWindows = Number(wins[0].c) || 0;
  if (!openWindows) return { minutes: null, aheadCount: 0, openWindows: 0, closed: true };

  // same lane, arrived earlier (id breaks whole-second timestamp ties)
  const sameLane = await q(
    `SELECT COUNT(*) AS c FROM transactions
     WHERE department=? AND service_date=CURDATE() AND ticket_status='waiting'
       AND queue_category=?
       AND queue_at <= NOW()
       ${requestedAt ? 'AND (queue_at < ? OR (queue_at = ? AND id < ?))' : ''}`,
    requestedAt ? [department, lane, requestedAt, requestedAt, ticketId || 0]
                : [department, lane]);
  const ahead = Number(sameLane[0].c) || 0;

  // A regular ticket also waits behind priority clients, because the queue
  // alternates priority then regular whenever both lanes have people.
  let jumpers = 0;
  if (lane === 'regular') {
    const p = await q(
      `SELECT COUNT(*) AS c FROM transactions
       WHERE department=? AND service_date=CURDATE() AND ticket_status='waiting'
         AND queue_category='priority'`, [department]);
    jumpers = Math.min(Number(p[0].c) || 0, ahead + 1);   // alternation: at most one per regular
  }

  // clients already at a window still have to finish
  const serving = await q(
    `SELECT COUNT(*) AS c FROM transactions
     WHERE department=? AND service_date=CURDATE() AND ticket_status IN ('called','serving')`,
    [department]);
  const inService = Number(serving[0].c) || 0;

  const perClient = (stats.deptStats[department] && stats.deptStats[department].usable)
    ? stats.deptStats[department].median
    : settings.avgServiceMinutes;

  const effectiveAhead = ahead + jumpers + inService * 0.5;   // half a service on average
  const minutes = Math.round((effectiveAhead / openWindows) * perClient);

  return {
    minutes: Math.max(0, minutes),
    aheadCount: ahead, jumpers, inService, openWindows,
    perClient: Math.round(perClient * 10) / 10,
    method: 'position',
    source: (stats.deptStats[department] && stats.deptStats[department].usable) ? 'historical' : 'baseline',
  };
}

// ── observed pace: how fast is this office ACTUALLY moving today? ────────────
/**
 * Measures the real interval between consecutive completions today.
 *
 *   C-004 completed 09:12
 *   C-005 completed 09:17   -> 5 min
 *   C-006 completed 09:21   -> 4 min
 *   C-007 completed 09:28   -> 7 min   => pace = median(5,4,7) = 5 min/client
 *
 * This beats an assumed service time because it silently includes everything
 * that really happens: slow mornings, a window closing, staff stepping away.
 *
 * Gaps longer than `maxGap` are dropped — they are breaks or lunch, not work.
 */
async function observedPace(department, { sample = 8, maxGap = 45, minGaps = 3 } = {}) {
  const rows = await q(
    `SELECT completed_at FROM transactions
     WHERE department=? AND service_date=CURDATE()
       AND ticket_status='completed' AND completed_at IS NOT NULL
     ORDER BY completed_at DESC LIMIT ?`, [department, sample + 1]);

  if (rows.length < 2) return { pace: null, gaps: 0, basis: 'none' };

  // rows are newest first; walk back to get the interval between each pair
  const gaps = [];
  for (let i = 0; i < rows.length - 1; i++) {
    const mins = (new Date(rows[i].completed_at) - new Date(rows[i + 1].completed_at)) / 60000;
    if (mins > 0 && mins <= maxGap) gaps.push(mins);
  }
  if (gaps.length < minGaps) return { pace: null, gaps: gaps.length, basis: 'none' };

  // Divide by the windows sharing the load: three windows completing one
  // client every 5 minutes each is a 5-minute pace per window, and the gaps
  // already reflect the combined output, so no extra division is needed.
  return {
    pace: Math.max(0.5, median(gaps)),
    gaps: gaps.length,
    sampleSize: rows.length,
    basis: 'observed',
  };
}

/**
 * Estimated time until this ticket is called.
 * Returns both a duration and a clock time, plus the basis so the screen can
 * tell the client whether it is measured or merely assumed.
 */
const PAUSED_AFTER_MIN = 15;   // no call for this long = the line is paused
async function ticketEta(t) {
  const db       = require('./db');
  const settings = await db.getSettings();

  // already at the window, or finished
  if (['called', 'serving'].includes(t.ticketStatus))
    return { state: 'now', label: 'It is your turn', minutes: 0, seconds: 0 };
  if (['completed', 'cancelled', 'no-show'].includes(t.ticketStatus))
    return { state: 'done', label: null, minutes: null };

  // scheduled for a later day
  const today = db.today();
  if (t.serviceDate && t.serviceDate > today)
    return { state: 'scheduled', label: 'Scheduled for ' + db.longDate(t.serviceDate), minutes: null };

  // Office hours are over and this ticket was not reached: no estimate (a
  // prediction made from "now" would just slide later with the clock).
  if (t.serviceDate === today && db.isPastClosing(settings))
    return { state: 'ended', label: 'The office closed at ' + db.clock12(settings.closeTime) + ' before your turn', minutes: null };

  // before opening: the place is kept, the estimate starts with the day
  if (t.serviceDate === today && new Date() < new Date(`${today}T${settings.openTime}:00`))
    return { state: 'opens', label: 'The office opens at ' + db.clock12(settings.openTime), minutes: null };

  // a booking for later today: not in line until its slot starts
  if (t.slotStart && new Date(t.queueAt) > new Date())
    return { state: 'scheduled', label: 'Booked for ' + t.slotLabel + ' today', minutes: null };

  const wins = await q(
    `SELECT COUNT(*) AS c FROM windows WHERE department=? AND status='open'`, [t.department]);
  const openWindows = Number(wins[0].c) || 0;
  if (!openWindows)
    return { state: 'closed', label: 'No window is open right now', minutes: null, openWindows: 0 };

  // how many are genuinely ahead in this ticket's lane
  const same = await q(
    `SELECT COUNT(*) AS c FROM transactions
     WHERE department=? AND service_date=CURDATE() AND ticket_status='waiting'
       AND queue_category=?
       AND (queue_at < ? OR (queue_at = ? AND id < ?))`,
    [t.department, t.queueCategory, t.queueAt, t.queueAt, t.id]);
  let ahead = Number(same[0].c) || 0;

  // regular tickets also wait behind priority clients (the queue alternates)
  let jumpers = 0;
  if (t.queueCategory === 'regular') {
    const p = await q(
      `SELECT COUNT(*) AS c FROM transactions
       WHERE department=? AND service_date=CURDATE() AND ticket_status='waiting'
         AND queue_category='priority'`, [t.department]);
    jumpers = Math.min(Number(p[0].c) || 0, ahead + 1);
  }

  // anyone at a window still has to finish
  const busy = await q(
    `SELECT COUNT(*) AS c FROM transactions
     WHERE department=? AND service_date=CURDATE() AND ticket_status IN ('called','serving')`,
    [t.department]);
  const inService = Number(busy[0].c) || 0;

  // pace: measured today first, then item history, then the office default
  const obs = await observedPace(t.department);
  let pace = obs.pace, basis = obs.basis, basisLabel;

  if (!pace) {
    const stats = await getDocumentStats(settings.minSamples);
    const items = t.items || [];
    const itemStat = items.length ? stats.documentStats[items[0].name] : null;
    if (itemStat && itemStat.usable) {
      pace = itemStat.median / Math.max(1, openWindows);
      basis = 'history';
    } else if (stats.deptStats[t.department] && stats.deptStats[t.department].usable) {
      pace = stats.deptStats[t.department].median / Math.max(1, openWindows);
      basis = 'history';
    } else {
      pace = settings.avgServiceMinutes / Math.max(1, openWindows);
      basis = 'estimate';
    }
  }

  const effective = ahead + jumpers + inService * 0.5;
  let minutes     = Math.round(effective * pace);

  // Prefer the decision engine's day simulation (data/engine.js): it plays the
  // rest of the day forward window by window, with each ticket's own documents.
  let fits = true, slowEndClock = null, closeClock = null, expectedAhead = 0, claimsAhead = 0, patternUsed = false, window = null;
  try {
    const f = await require('./engine').ticketForecast(t);
    if (f) {
      minutes = f.minutes; fits = f.fits; slowEndClock = f.slowEndClock; closeClock = f.closeClock;
      expectedAhead = f.expectedAhead; claimsAhead = f.claimsAhead || 0; patternUsed = f.patternUsed; window = f.window;
      basis = 'simulated';
    }
  } catch (e) { /* fall back to the position estimate */ }

  basisLabel = basis === 'simulated'
      ? "simulated from the line ahead, each client's documents, today's pace" +
        (patternUsed ? ' and past ' + ['Sundays','Mondays','Tuesdays','Wednesdays','Thursdays','Fridays','Saturdays'][new Date().getDay()] : '') +
        (expectedAhead ? `, including about ${expectedAhead} priority client${expectedAhead === 1 ? '' : 's'} expected to arrive` : '') +
        (claimsAhead ? `, and about ${claimsAhead} student${claimsAhead === 1 ? '' : 's'} coming for an OTR due today` : '')
    : basis === 'observed'
      ? `based on the last ${obs.gaps + 1} clients served`
    : basis === 'history'
      ? 'based on how long this service usually takes'
      : 'estimate only, no data yet today';

  // Paused line: windows are open but nobody has been called for a while, so
  // every estimate moves later minute by minute. Say so instead of looking exact.
  const lastCall = await q(
    `SELECT TIMESTAMPDIFF(MINUTE, MAX(called_at), NOW()) AS idle,
            SUM(ticket_status IN ('called','serving')) AS busy
     FROM transactions WHERE department=? AND service_date=CURDATE()`, [t.department]);
  const idle = lastCall[0].idle == null ? null : Number(lastCall[0].idle);
  // Over the break nobody is called by design: that is not a paused line.
  const onBreak = db.isBreakTime(settings);
  const breakEnds = onBreak ? db.clock12(settings.breakEnd) : null;
  const paused = !onBreak && !Number(lastCall[0].busy) && (idle == null || idle >= PAUSED_AFTER_MIN);

  if (effective <= 0) {
    return {
      state: 'next', label: onBreak ? 'You are next after the break' : 'You are next',
      minutes: 0, seconds: 0, paused, idleMinutes: idle, onBreak, breakEnds,
      ahead: 0, jumpers, inService, pace: Math.round(pace * 10) / 10,
      basis, basisLabel, openWindows, fits, slowEndClock, closeClock, window,
    };
  }

  const at = new Date(Date.now() + minutes * 60000);
  const pad = n => String(n).padStart(2, '0');
  let h = at.getHours(); const ampm = h >= 12 ? 'PM' : 'AM';
  h = h % 12 || 12;

  return {
    state: 'waiting',
    paused, idleMinutes: idle, onBreak, breakEnds,
    minutes,
    seconds: minutes * 60,
    atClock: `${h}:${pad(at.getMinutes())} ${ampm}`,
    ahead, jumpers, inService,
    pace: Math.round(pace * 10) / 10,
    basis, basisLabel, openWindows,
    fits, slowEndClock, closeClock, window,
  };
}

// ── model 2: Erlang C, for someone deciding whether to come at all ───────────
/**
 * Erlang C: probability that an arriving client has to wait at all.
 *   a = offered load = lambda / mu
 *   c = number of servers
 * Computed iteratively to avoid factorial overflow.
 */
function erlangC(lambda, mu, c) {
  if (c <= 0 || mu <= 0) return 1;
  const a = lambda / mu;
  const rho = a / c;
  if (rho >= 1) return 1;              // arrivals outpace service: always a queue

  let sum = 0, term = 1;
  for (let k = 0; k < c; k++) {
    if (k > 0) term *= a / k;
    sum += term;
  }
  const last = term * (a / c);
  const numerator = last / (1 - rho);
  return numerator / (sum + numerator);
}

/** Arrivals per minute over the recent window. */
async function arrivalRate(department, minutes = 60) {
  const r = await q(
    `SELECT COUNT(*) AS c FROM transactions
     WHERE department=? AND requested_at > DATE_SUB(NOW(), INTERVAL ? MINUTE)`,
    [department, minutes]);
  return (Number(r[0].c) || 0) / minutes;
}

/**
 * Expected wait for someone arriving right now, from queueing theory.
 * Wq = C(c, a) / (c*mu - lambda)
 */
async function arrivalWait(department) {
  const settings = await require('./db').getSettings();
  const stats    = await getDocumentStats(settings.minSamples);

  const wins = await q(
    `SELECT COUNT(*) AS c FROM windows WHERE department=? AND status='open'`, [department]);
  const c = Number(wins[0].c) || 0;
  if (!c) return { minutes: null, closed: true, method: 'erlang-c' };

  const serviceMin = (stats.deptStats[department] && stats.deptStats[department].usable)
    ? stats.deptStats[department].median
    : settings.avgServiceMinutes;

  const mu     = 1 / serviceMin;              // clients served per minute, per window
  const lambda = await arrivalRate(department);
  const util   = lambda / (c * mu);

  if (lambda <= 0) return { minutes: 0, utilisation: 0, servers: c, method: 'erlang-c', serviceMin };

  if (util >= 1) {
    // Demand exceeds capacity; the theoretical wait is unbounded, so fall back
    // to draining the queue that actually exists.
    const backlog = await q(
      `SELECT COUNT(*) AS n FROM transactions
       WHERE department=? AND service_date=CURDATE() AND ticket_status='waiting'`, [department]);
    return {
      minutes: Math.round((Number(backlog[0].n) || 0) / c * serviceMin),
      utilisation: Math.round(util * 100) / 100, servers: c,
      overloaded: true, method: 'backlog', serviceMin,
    };
  }

  const pWait = erlangC(lambda, mu, c);
  const wq    = pWait / (c * mu - lambda);
  return {
    minutes: Math.max(0, Math.round(wq)),
    probabilityOfWaiting: Math.round(pWait * 100),
    utilisation: Math.round(util * 100) / 100,
    servers: c, arrivalsPerHour: Math.round(lambda * 60 * 10) / 10,
    serviceMin: Math.round(serviceMin * 10) / 10,
    method: 'erlang-c',
  };
}

// ── accuracy: how good were the predictions? ─────────────────────────────────
/**
 * Mean Absolute Error between the wait predicted when the ticket was issued
 * and the wait the client actually experienced. This is the number to report
 * in the results chapter.
 */
async function getAccuracy(from = null, to = null) {
  const range = from && to ? 'AND t.service_date BETWEEN ? AND ?' : '';
  const args  = from && to ? [from, to] : [];

  const rows = await q(
    `SELECT t.predicted_wait AS predicted,
            TIMESTAMPDIFF(MINUTE, COALESCE(t.queue_at, t.requested_at), t.called_at) AS actual,
            t.department, t.queue_category
     FROM transactions t
     WHERE t.predicted_wait IS NOT NULL AND t.called_at IS NOT NULL ${range}`, args);

  if (!rows.length) {
    return { samples: 0, mae: null, rmse: null, within5: null, byDept: {}, baselineMae: null };
  }

  let absSum = 0, sqSum = 0, within5 = 0;
  const byDept = {};
  rows.forEach(r => {
    const err = Math.abs(Number(r.predicted) - Number(r.actual));
    absSum += err;
    sqSum  += err * err;
    if (err <= 5) within5++;
    const d = byDept[r.department] = byDept[r.department] || { n: 0, sum: 0 };
    d.n++; d.sum += err;
  });

  const n = rows.length;
  Object.keys(byDept).forEach(d => {
    byDept[d].mae = Math.round((byDept[d].sum / byDept[d].n) * 10) / 10;
  });

  return {
    samples: n,
    mae:   Math.round((absSum / n) * 10) / 10,
    rmse:  Math.round(Math.sqrt(sqSum / n) * 10) / 10,
    within5: Math.round((within5 / n) * 100),
    byDept,
  };
}

module.exports = {
  median, ewma, erlangC, shrink, servicePattern, priorityArrivals,
  getDocumentStats, estimateService,
  observedPace, ticketEta,
  positionWait, arrivalWait, arrivalRate,
  getAccuracy,
};
