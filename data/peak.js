'use strict';
/**
 * Peak Hour Detection for SmartQ.
 * ---------------------------------------------------------------------------
 * "When is the office busiest?" has three defensible answers, and they do not
 * always agree, so this module reports all three per hour:
 *
 *   arrivals  — how many clients request a number in that hour.
 *               This is DEMAND. It is what the office can plan staffing around.
 *
 *   crowding  — how many clients were waiting in the lobby AT THE SAME TIME
 *               during that hour. This is CONGESTION. An hour can take few
 *               arrivals and still be crowded, because the backlog from the
 *               previous hour has not drained yet.
 *
 *   wait      — the average minutes a client requesting in that hour waited
 *               before being called. This is the EXPERIENCE. It is the metric
 *               a student actually feels, but it is the noisiest of the three
 *               because a single slow transaction moves it a lot.
 *
 * Why split by weekday
 * --------------------
 * A college cashier does not have one daily rhythm. Monday carries the weekend
 * backlog, Friday carries the deadline rush. Averaging every day together
 * produces a flat profile that matches no real day. So the default profile is
 * built from the SAME WEEKDAY over the lookback window — the last four or five
 * Mondays for a Monday.
 *
 * That costs sample size: 30 days holds only ~4 Mondays. When a weekday has
 * fewer than MIN_DAYS days with any traffic, the profile silently falls back to
 * all weekdays combined and says so in `basis`, so the page can label the
 * figure as provisional instead of presenting thin data as fact.
 *
 * Everything here is READ-ONLY. Peak hours inform the staff and the student;
 * they never change queue order, booking limits or the wait estimate.
 */
const pool = require('../database/connection');
const q = async (sql, p = []) => (await pool.execute(sql, p))[0];

const LOOKBACK_DAYS = 30;   // how far back to read history
const MIN_DAYS      = 2;    // fewer same-weekday days than this → combine all days
const MIN_TICKETS   = 5;    // fewer tickets than this in total → no profile at all
const CACHE_MS      = 10 * 60 * 1000;   // 10 minutes

/**
 * Result cache.
 *
 * The staff dashboard reloads itself every 10 seconds, and this profile reads a
 * month of tickets. Recomputing it on every refresh would mean ~360 full-month
 * scans an hour per open counter screen, to produce a figure that barely moves
 * between one ticket and the next. A 10-minute cache keeps the page honest
 * while turning that back into six reads an hour.
 */
const cache = new Map();

function cacheGet(key) {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.value;
  if (hit) cache.delete(key);
  return null;
}

function cacheSet(key, value) {
  // Bounded so a long-running server cannot grow the map without limit.
  if (cache.size > 64) cache.clear();
  cache.set(key, { at: Date.now(), value });
  return value;
}

/** Drop cached profiles — call after bulk changes if a fresh figure matters. */
function clearCache() { cache.clear(); }

const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday',
                   'Thursday', 'Friday', 'Saturday'];

// ── small helpers ────────────────────────────────────────────────────────────

/** 'YYYY-MM-DD' for a Date, in local time (never toISOString — that is UTC). */
function ymd(d) {
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** "8 AM", "12 NN", "1 PM" — how a Philippine office writes an hour. */
function hourLabel(h) {
  if (h === 12) return '12 NN';
  if (h === 0)  return '12 MN';
  return `${h > 12 ? h - 12 : h} ${h < 12 ? 'AM' : 'PM'}`;
}

/** "10–11 AM" for the slot that starts at hour h. */
function slotLabel(h) {
  return `${hourLabel(h)}–${hourLabel((h + 1) % 24)}`.replace(/ [AP]M–/, '–');
}

function mean(a) {
  return a.length ? a.reduce((x, y) => x + y, 0) / a.length : null;
}

/** Minutes between two Date values, floored at 0. */
function minutesBetween(a, b) {
  return Math.max(0, Math.round((b - a) / 60000));
}

// ── history read ─────────────────────────────────────────────────────────────
/**
 * One read covers the whole lookback window for an office, and every weekday
 * profile is filtered out of it in JS. Reading once and slicing seven ways beats
 * seven near-identical queries, which matters on the student request form: it
 * needs advice for all seven weekdays so the page can switch as the student
 * changes the date, without a round trip per weekday.
 *
 * The overlap arithmetic behind 'crowding' is also far easier and cheaper in JS
 * than as a grouped query.
 */
async function loadHistory(department, lookback) {
  const key = 'rows|' + (department || 'all') + '|' + lookback + '|' + ymd(new Date());
  const hit = cacheGet(key);
  if (hit) return hit;

  const until = new Date();
  const since = new Date();
  since.setDate(since.getDate() - lookback);

  const params = [ymd(since), ymd(until)];
  let where = 'service_date BETWEEN ? AND ?';
  if (department) { where += ' AND department = ?'; params.push(department); }

  return cacheSet(key, await q(
    `SELECT service_date, department, ticket_status,
            requested_at, called_at, completed_at
       FROM transactions
      WHERE ${where}
      ORDER BY requested_at, id`, params));
}

// ── the profile ──────────────────────────────────────────────────────────────
/**
 * Build the hourly busyness profile for one office.
 *
 * @param {string|null} department  'Cashier' | 'Registrar' | null for both
 * @param {object} opts
 *   weekday  0=Sun..6=Sat, or null for "today". Pass 'all' to skip the split.
 *   lookback days of history to read (default 30)
 *   openHour / closeHour  clamp the profile to office hours
 *
 * @returns {{hours:Array, busiest:object|null, quietest:object|null,
 *            basis:string, sampleDays:number, totalTickets:number,
 *            weekday:number|null, weekdayName:string|null}}
 */
async function hourlyProfile(department = null, opts = {}) {
  const {
    lookback   = LOOKBACK_DAYS,
    openHour   = 8,
    closeHour  = 17,
    breakStart = 12,   // hours inside the break are shown but never recommended
    breakEnd   = 13,
  } = opts;

  let weekday = opts.weekday;
  if (weekday === undefined || weekday === null) weekday = new Date().getDay();

  const key = [department || 'all', weekday, lookback, openHour, closeHour,
               breakStart, breakEnd, ymd(new Date())].join('|');
  const cached = cacheGet(key);
  if (cached) return cached;

  const rows = await loadHistory(department, lookback);

  const empty = {
    hours: [], busiest: null, quietest: null, basis: 'none',
    sampleDays: 0, totalTickets: 0,
    weekday: weekday === 'all' ? null : weekday,
    weekdayName: weekday === 'all' ? null : DAY_NAMES[weekday],
    department: department || 'All offices',
    lookback,
  };
  if (!rows.length) return cacheSet(key, empty);

  // ---- pick the rows this profile is built from ------------------------------
  // Try the requested weekday first; fall back to every day when the same
  // weekday has too little history to say anything.
  const dayOf = r => new Date(`${ymd(new Date(r.service_date))}T00:00:00`).getDay();

  let basis = 'weekday';
  let used  = rows;

  if (weekday !== 'all') {
    const sameDay = rows.filter(r => dayOf(r) === weekday);
    const days    = new Set(sameDay.map(r => ymd(new Date(r.service_date)))).size;
    if (days >= MIN_DAYS && sameDay.length >= MIN_TICKETS) {
      used = sameDay;
    } else {
      basis = 'all-days';   // not enough same-weekday history yet
    }
  } else {
    basis = 'all-days';
  }

  if (used.length < MIN_TICKETS)
    return cacheSet(key, { ...empty, basis: 'insufficient' });

  const sampleDays = new Set(used.map(r => ymd(new Date(r.service_date)))).size || 1;

  // ---- bucket into hours ----------------------------------------------------
  const lo = Math.max(0, Math.min(23, openHour));
  const hi = Math.max(lo + 1, Math.min(24, closeHour));

  const buckets = {};
  for (let h = lo; h < hi; h++) {
    buckets[h] = { hour: h, arrivals: 0, overlaps: 0, waits: [] };
  }

  for (const r of used) {
    const requested = new Date(r.requested_at);
    const h = requested.getHours();

    // DEMAND — every request counts, including ones later cancelled or
    // no-showed. Someone who walked in and gave up is still demand the office
    // failed to absorb, and dropping them would flatter the busiest hours.
    if (buckets[h]) buckets[h].arrivals++;

    // EXPERIENCE — only tickets that were actually called have a real wait.
    if (r.called_at) {
      const wait = minutesBetween(requested, new Date(r.called_at));
      // Guard: a ticket left open overnight is a data artefact, not a 9-hour
      // wait. Anything beyond one working day is discarded.
      if (buckets[h] && wait <= 600) buckets[h].waits.push(wait);
    }

    // CONGESTION — the client occupies the lobby from requesting until called
    // (or until the ticket died). Credit every hour that interval touches, so
    // a backlog spilling out of 10 AM shows up in 11 AM too.
    const leftAt = r.called_at ? new Date(r.called_at)
                 : r.completed_at ? new Date(r.completed_at)
                 : null;
    if (leftAt && leftAt > requested) {
      for (let hh = requested.getHours(); hh <= leftAt.getHours() && hh < hi; hh++) {
        if (buckets[hh]) buckets[hh].overlaps++;
      }
    } else if (buckets[h]) {
      buckets[h].overlaps++;   // never called: counted in its own hour only
    }
  }

  // ---- per-day averages ----------------------------------------------------
  const hours = Object.values(buckets).map(b => ({
    hour:      b.hour,
    label:     slotLabel(b.hour),
    // The break hour is shown in the table — staff still want to see the few
    // tickets that land there — but it is never named as busiest or quietest,
    // because "come at lunch" is advice for a closed window.
    isBreak:   b.hour >= breakStart && b.hour < breakEnd,
    arrivals:  +(b.arrivals / sampleDays).toFixed(1),
    crowding:  +(b.overlaps / sampleDays).toFixed(1),
    avgWait:   b.waits.length ? Math.round(mean(b.waits)) : null,
    samples:   b.arrivals,
    waitSamples: b.waits.length,
  }));

  // ---- relative level, for colour-coding ----------------------------------
  // Graded against the busiest SERVING hour of THIS office rather than an
  // absolute ticket count, so the same scale reads correctly for a cashier
  // handling 90 clients a day and a registrar handling 20.
  const serving = hours.filter(h => !h.isBreak);
  const peakArrivals = Math.max(...serving.map(h => h.arrivals), 0);
  hours.forEach(h => {
    const ratio = peakArrivals > 0 ? h.arrivals / peakArrivals : 0;
    h.share = Math.min(100, Math.round(ratio * 100));
    h.level = h.isBreak      ? 'break'
            : ratio >= 0.85  ? 'peak'
            : ratio >= 0.60  ? 'busy'
            : ratio >= 0.30  ? 'moderate'
            : 'quiet';
  });

  const withTraffic = serving.filter(h => h.arrivals > 0);
  const busiest  = withTraffic.length
    ? withTraffic.reduce((a, b) => (b.arrivals > a.arrivals ? b : a)) : null;
  const quietest = withTraffic.length
    ? withTraffic.reduce((a, b) => (b.arrivals < a.arrivals ? b : a)) : null;
  const waited = serving.filter(h => h.avgWait !== null);
  const longestWait = waited.length
    ? waited.reduce((a, b) => (b.avgWait > a.avgWait ? b : a)) : null;
  const mostCrowded = withTraffic.length
    ? withTraffic.reduce((a, b) => (b.crowding > a.crowding ? b : a)) : null;

  return cacheSet(key, {
    hours, busiest, quietest, longestWait, mostCrowded,
    basis, sampleDays, totalTickets: used.length,
    weekday: weekday === 'all' ? null : weekday,
    weekdayName: weekday === 'all' ? null : DAY_NAMES[weekday],
    department: department || 'All offices',
    lookback,
  });
}

/**
 * Both offices at once, for the admin Reports page.
 * Returns { Cashier: profile, Registrar: profile }.
 */
async function bothOffices(opts = {}) {
  const [Cashier, Registrar] = await Promise.all([
    hourlyProfile('Cashier',   opts),
    hourlyProfile('Registrar', opts),
  ]);
  return { Cashier, Registrar };
}

/**
 * One-line advice for a student choosing when to come.
 * Returns null when there is not enough history to advise honestly — better to
 * say nothing than to send someone to an hour picked from three data points.
 */
async function advice(department, opts = {}) {
  const p = await hourlyProfile(department, opts);
  if (!p.busiest || p.basis === 'none' || p.basis === 'insufficient') return null;

  // Only recommend a quiet hour if it is meaningfully quieter than the peak.
  const quiet = p.hours
    .filter(h => !h.isBreak && h.arrivals > 0 && h.share <= 45)
    .sort((a, b) => a.arrivals - b.arrivals)[0] || null;

  return {
    department: p.department,
    weekdayName: p.weekdayName,
    busiest: p.busiest,
    quietest: quiet,
    provisional: p.basis === 'all-days',
    sampleDays: p.sampleDays,
  };
}

/**
 * Turn the admin's office-hour settings into profile options, so the chart
 * covers exactly the hours the office is open and greys out the real break —
 * not a hardcoded 8-to-5 with lunch at noon.
 */
function optsFromSettings(s = {}) {
  const hourOf = (v, fallback) => {
    const m = /^(\d{1,2})/.exec(String(v || ''));
    return m ? Math.max(0, Math.min(23, Number(m[1]))) : fallback;
  };
  const openHour  = hourOf(s.openTime  || s.open_time,  8);
  const closeHour = hourOf(s.closeTime || s.close_time, 17);
  return {
    openHour,
    // Round the closing hour up, so a 16:30 close still shows the 4–5 PM slot.
    closeHour: Math.max(openHour + 1, closeHour + (/:[1-9]/.test(String(s.closeTime || s.close_time || '')) ? 1 : 0)),
    breakStart: hourOf(s.breakStart || s.break_start, 12),
    breakEnd:   hourOf(s.breakEnd   || s.break_end,   13),
  };
}

/**
 * Advice for every weekday at once, so the request form can update the line it
 * shows the moment the student picks a different date — Sunday first, matching
 * JavaScript's getDay(). Entries are null where a weekday cannot be advised on.
 */
async function adviceByWeekday(department, opts = {}) {
  const out = [];
  for (let d = 0; d < 7; d++) out.push(await advice(department, { ...opts, weekday: d }));
  return out;
}

module.exports = {
  hourlyProfile, bothOffices, advice, adviceByWeekday,
  optsFromSettings, clearCache,
  hourLabel, slotLabel, DAY_NAMES,
  LOOKBACK_DAYS,
};
