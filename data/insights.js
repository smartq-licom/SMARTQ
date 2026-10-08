'use strict';
/**
 * Phase 3: what the system KNOWS and DECIDES, for the "How SmartQ Decides"
 * page.
 *
 *   forecastDay       tomorrow's clients per hour, from the same weekday's past
 *   staffing          windows needed per hour so the wait stays under a target
 *                     (Erlang C, the M/M/c queue, worked backwards)
 *   unusualToday      today compared with a normal day of the same weekday
 *   balance           how evenly windows and staff share the work (utilization,
 *                     coefficient of variation -> a 0-100 balance score)
 *   accuracyTrend     prediction error week by week (the system learning)
 *   biasFactor        self-correction: if waits keep coming out longer (or
 *                     shorter) than predicted, every estimate is scaled by it
 *   decisions         the decision log, filtered and paged
 */
const pool    = require('../database/connection');
const predict = require('./prediction');
const paging  = require('./paging');

const q = async (sql, p = []) => (await pool.query(sql, p))[0];

const TARGET_WAIT = 10;      // minutes: the wait the staffing advice aims for
const MAX_WINDOWS = 6;
const pad = n => String(n).padStart(2, '0');
const ymd = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const hm  = t => { const [h, m] = String(t).split(':').map(Number); return h * 60 + (m || 0); };
const hourLabel = h => `${h % 12 || 12}${h < 12 ? ' AM' : ' PM'}`;
const median = predict.median;

// ── staffing: Erlang C backwards ─────────────────────────────────────────────
/**
 * The fewest windows that keep the average wait at or under the target, for
 * `lambda` clients per hour who each take `svcMin` minutes.
 *   mu = 60 / svcMin           clients one window serves per hour
 *   rho = lambda / (c * mu)    how busy the windows are (must stay below 1)
 *   Wq = C(c, a) / (c*mu - lambda)   average wait, Erlang C
 */
function staffing(lambda, svcMin, target = TARGET_WAIT) {
  if (!lambda || lambda <= 0) return { windows: 0, waitMin: 0, utilization: 0 };
  const mu = 60 / Math.max(0.5, svcMin);
  for (let c = 1; c <= MAX_WINDOWS; c++) {
    const rho = lambda / (c * mu);
    if (rho >= 1) continue;
    const wq = predict.erlangC(lambda, mu, c) / (c * mu - lambda) * 60;
    if (wq <= target) return { windows: c, waitMin: Math.round(wq * 10) / 10, utilization: Math.round(rho * 100) };
  }
  const rho = lambda / (MAX_WINDOWS * mu);
  return { windows: MAX_WINDOWS, waitMin: null, utilization: Math.round(rho * 100), over: true };
}

// ── forecast for a day ───────────────────────────────────────────────────────
async function forecastDay(department, dateStr, settings) {
  const dow = new Date(dateStr + 'T00:00:00').getDay();
  const days = (await q(
    `SELECT DISTINCT service_date AS d FROM transactions
     WHERE department=? AND DAYOFWEEK(service_date)=? AND service_date < CURDATE()
     ORDER BY service_date DESC LIMIT 6`, [department, dow + 1])).map(r => ymd(new Date(r.d)));
  const [wins] = await pool.query('SELECT COUNT(*) AS c FROM windows WHERE department=?', [department]);
  const configured = Number(wins[0].c) || 0;
  const open = hm(settings.openTime), close = hm(settings.closeTime);
  const brS = hm(settings.breakStart), brE = hm(settings.breakEnd);
  const out = { department, date: dateStr, weekday: dow, basedOn: days.length, configured, hours: [], total: 0 };
  if (!days.length) return out;

  const arrivals = await q(
    `SELECT HOUR(COALESCE(queue_at, requested_at)) AS h, COUNT(*) AS n FROM transactions
     WHERE department=? AND service_date IN (?) GROUP BY h`, [department, days]);
  const booked = await q(
    `SELECT HOUR(slot_start) AS h, COUNT(*) AS n FROM transactions
     WHERE department=? AND service_date=? AND slot_start IS NOT NULL AND overall_status<>'cancelled'
     GROUP BY h`, [department, dateStr]);
  const avg = {}, book = {};
  arrivals.forEach(r => { avg[r.h] = Number(r.n) / days.length; });
  booked.forEach(r => { book[r.h] = Number(r.n); });

  const pattern = await predict.servicePattern(department);
  const stats = await predict.getDocumentStats(settings.minSamples);
  const d = stats.deptStats[department];
  const typical = d && d.usable ? predict.shrink(d.median, d.samples, settings.avgServiceMinutes) : settings.avgServiceMinutes;

  for (let h = Math.floor(open / 60); h * 60 < close; h++) {
    const isBreak = h * 60 >= brS && (h + 1) * 60 <= brE;
    // clients arriving before opening join the first hour's line
    let expect = avg[h] || 0;
    if (h === Math.floor(open / 60)) for (let e = 0; e < h; e++) expect += avg[e] || 0;
    expect = Math.max(expect, book[h] || 0);
    const svc = typical * pattern.factor(dow, h);
    const st = isBreak ? { windows: 0, waitMin: null, utilization: 0 } : staffing(expect, svc);
    out.hours.push({ hour: h, label: hourLabel(h), expected: Math.round(expect * 10) / 10,
                     booked: book[h] || 0, serviceMin: Math.round(svc * 10) / 10, isBreak, ...st,
                     short: !isBreak && st.windows > configured });
    out.total += expect;
  }
  out.total = Math.round(out.total);
  const peak = out.hours.reduce((a, b) => (b.expected > (a ? a.expected : -1) ? b : a), null);
  out.peak = peak && peak.expected > 0 ? peak : null;
  out.maxWindows = Math.max(0, ...out.hours.map(x => x.windows));
  return out;
}

// ── today against a normal day ───────────────────────────────────────────────
async function unusualToday(department, settings) {
  const now = new Date(), dow = now.getDay();
  const mins = now.getHours() * 60 + now.getMinutes();
  // judged only once the office has been open an hour (an early morning is not "quiet")
  if (settings && mins < hm(settings.openTime) + 60) return { known: false, early: true };
  const [[today]] = await pool.query(
    `SELECT COUNT(*) AS n FROM transactions WHERE department=? AND service_date=CURDATE()
       AND slot_start IS NULL AND TIME_TO_SEC(TIME(COALESCE(queue_at, requested_at))) / 60 <= ?`, [department, mins]);
  const past = await q(
    `SELECT service_date AS d, COUNT(*) AS n FROM transactions
     WHERE department=? AND DAYOFWEEK(service_date)=? AND service_date < CURDATE()
       AND service_date >= CURDATE() - INTERVAL 70 DAY AND slot_start IS NULL
       AND TIME_TO_SEC(TIME(COALESCE(queue_at, requested_at))) / 60 <= ?
     GROUP BY service_date`, [department, dow + 1, mins]);
  if (past.length < 3) return { known: false, today: Number(today.n) };
  const usual = median(past.map(r => Number(r.n)));
  const ratio = usual ? Number(today.n) / usual : null;
  const unusual = usual >= 5 && ratio != null && (ratio >= 1.3 || ratio <= 0.7);
  return { known: true, today: Number(today.n), usual: Math.round(usual), ratio, unusual,
           percent: ratio != null ? Math.round((ratio - 1) * 100) : null };
}

// ── workload balance ─────────────────────────────────────────────────────────
async function balance(department, dateStr, settings) {
  const rows = await q(
    `SELECT window_id, window_label, staff_name, COUNT(*) AS served,
            SUM(actual_minutes) AS busy, MIN(called_at) AS first_call, MAX(completed_at) AS last_done
     FROM transactions
     WHERE department=? AND service_date=? AND ticket_status='completed' AND window_id IS NOT NULL
     GROUP BY window_id, window_label, staff_name ORDER BY window_label`, [department, dateStr]);
  const wins = await q('SELECT id, label FROM windows WHERE department=? ORDER BY label', [department]);

  // minutes the office was open that day (so far, if today), lunch excluded
  const open = hm(settings.openTime), close = hm(settings.closeTime);
  const brS = hm(settings.breakStart), brE = hm(settings.breakEnd);
  const now = new Date();
  const end = dateStr === ymd(now) ? Math.min(close, now.getHours() * 60 + now.getMinutes()) : close;
  const openMin = Math.max(0, end - open - Math.max(0, Math.min(end, brE) - Math.max(open, brS)));

  const byWin = {};
  rows.forEach(r => {
    const w = byWin[r.window_id] = byWin[r.window_id] || { label: r.window_label, staff: [], served: 0, busy: 0 };
    w.served += Number(r.served); w.busy += Number(r.busy) || 0;
    if (r.staff_name && !w.staff.includes(r.staff_name)) w.staff.push(r.staff_name);
  });
  // every window of the office counts, so an idle one shows the imbalance
  const list = wins.map(w => byWin[w.id] || { label: w.label, staff: [], served: 0, busy: 0 });
  const total = list.reduce((a, w) => a + w.served, 0);
  list.forEach(w => {
    w.share = total ? Math.round(w.served / total * 100) : 0;
    w.utilization = openMin ? Math.min(100, Math.round(w.busy / openMin * 100)) : 0;
    w.idle = Math.max(0, openMin - w.busy);
  });

  // coefficient of variation of clients served per window: 0 = perfectly even
  let cv = 0;
  if (list.length > 1 && total) {
    const mean = total / list.length;
    const sd = Math.sqrt(list.reduce((a, w) => a + (w.served - mean) ** 2, 0) / list.length);
    cv = sd / mean;
  }
  const score = list.length > 1 && total ? Math.max(0, Math.round(100 * (1 - Math.min(1, cv)))) : null;

  const tips = [];
  if (total) {
    const top = list.reduce((a, b) => (b.served > a.served ? b : a));
    const busy = list.filter(w => w.utilization >= 85), light = list.filter(w => w.utilization < 50);
    if (list.length > 1 && top.share >= 60) tips.push(`${top.label} handled ${top.share}% of the clients. Share the calls more evenly.`);
    if (busy.length && light.length) tips.push(`${busy.map(w => w.label).join(', ')} ran over 85% busy while ${light.map(w => w.label).join(', ')} stayed under 50%.`);
    if (busy.length === list.length) tips.push('Every window ran over 85% busy: consider opening another window at peak hours.');
    if (list.length === 1) tips.push('This office has one window, so there is nothing to balance; watch its utilization instead.');
  }
  return { department, date: dateStr, openMin, total, windows: list, cv: Math.round(cv * 100) / 100, score, tips };
}

// ── accuracy, week by week ───────────────────────────────────────────────────
async function accuracyTrend(department = null, weeks = 8) {
  const rows = await q(
    `SELECT YEARWEEK(service_date, 1) AS wk, MIN(service_date) AS start, COUNT(*) AS n,
            AVG(ABS(predicted_wait - TIMESTAMPDIFF(MINUTE, COALESCE(queue_at, requested_at), called_at))) AS mae,
            AVG(ABS(predicted_wait - TIMESTAMPDIFF(MINUTE, COALESCE(queue_at, requested_at), called_at)) <= 5) AS within5
     FROM transactions
     WHERE predicted_wait IS NOT NULL AND called_at IS NOT NULL
       AND service_date >= CURDATE() - INTERVAL ? DAY ${department ? 'AND department=?' : ''}
     GROUP BY wk ORDER BY wk`, department ? [weeks * 7, department] : [weeks * 7]);
  return rows.map(r => ({
    label: new Date(r.start).toLocaleDateString('en-PH', { month: 'short', day: 'numeric' }),
    n: Number(r.n), mae: Math.round(Number(r.mae) * 10) / 10, within5: Math.round(Number(r.within5) * 100),
  }));
}

// ── self-correction ──────────────────────────────────────────────────────────
/**
 * Over the last 14 days, did real waits come out longer or shorter than the
 * predictions made when each ticket was taken? total actual / total predicted,
 * kept between 0.8 and 1.25, and only once there are 30 tickets to judge by.
 * The day simulation multiplies service times by it.
 */
async function biasFactor(department) {
  const [[r]] = await pool.query(
    `SELECT COUNT(*) AS n, SUM(predicted_wait) AS p,
            SUM(TIMESTAMPDIFF(MINUTE, COALESCE(queue_at, requested_at), called_at)) AS a
     FROM transactions
     WHERE department=? AND predicted_wait >= 3 AND called_at IS NOT NULL
       AND service_date >= CURDATE() - INTERVAL 14 DAY AND service_date < CURDATE()`, [department]);
  const n = Number(r.n) || 0;
  if (n < 30 || !Number(r.p)) return { factor: 1, samples: n, active: false };
  const raw = Number(r.a) / Number(r.p);
  return { factor: Math.min(1.25, Math.max(0.8, Math.round(raw * 100) / 100)), raw: Math.round(raw * 100) / 100,
           samples: n, active: true };
}

// ── decision log ─────────────────────────────────────────────────────────────
const DECISIONS = {
  accept: 'Accepted', accept_warned: 'Accepted, warned', warned: 'Warned late', booked: 'Booked a slot',
  held: 'Place held', assigned: 'Window match', claim_booked: 'Claim booked', missed: 'Missed turn', cancelled: 'Cancelled', rebooked: 'Moved to next day', refused: 'Refused',
};
async function decisions({ department = null, decision = null, from = null, to = null, page = 1 } = {}) {
  const w = [], p = [];
  if (department) { w.push('l.department = ?'); p.push(department); }
  if (decision && DECISIONS[decision]) { w.push('l.decision = ?'); p.push(decision); }
  if (from) { w.push('l.created_at >= ?'); p.push(from + ' 00:00:00'); }
  if (to)   { w.push('l.created_at <= ?'); p.push(to + ' 23:59:59'); }
  const where = w.length ? 'WHERE ' + w.join(' AND ') : '';
  const counts = await q(`SELECT l.decision, COUNT(*) AS n FROM decision_log l ${where} GROUP BY l.decision`, p);
  const total = counts.reduce((a, c) => a + Number(c.n), 0);
  const byKind = {}; counts.forEach(c => { byKind[c.decision] = Number(c.n); });
  // counts per type ignore the type filter, so the chips always show the mix
  const wNoType = w.filter(x => !x.startsWith('l.decision')), pNoType = p.filter((_, i) => !w[i].startsWith('l.decision'));
  const mix = await q(`SELECT l.decision, COUNT(*) AS n FROM decision_log l ${wNoType.length ? 'WHERE ' + wNoType.join(' AND ') : ''} GROUP BY l.decision`, pNoType);
  const pg = paging.paging(total, page);
  const rows = await q(
    `SELECT l.*, t.ticket_no FROM decision_log l LEFT JOIN transactions t ON t.id = l.transaction_id
     ${where} ORDER BY l.id DESC LIMIT ${pg.perPage} OFFSET ${pg.offset}`, p);
  return { pg, byKind, mix: Object.fromEntries(mix.map(m => [m.decision, Number(m.n)])), total,
           rows: rows.map(r => ({ at: r.created_at, decision: r.decision, label: DECISIONS[r.decision] || r.decision,
                                  department: r.department, ticketNo: r.ticket_no || '', reason: r.reason })) };
}

/** The day to show balance for: the asked date, else today, else the latest day with service. */
async function balanceDay(department, asked) {
  if (asked) return { date: asked, fallback: false };
  const today = ymd(new Date());
  const [[t]] = await pool.query(
    `SELECT COUNT(*) AS n FROM transactions WHERE department=? AND service_date=? AND ticket_status='completed'`, [department, today]);
  if (Number(t.n)) return { date: today, fallback: false };
  const [[l]] = await pool.query(
    `SELECT MAX(service_date) AS d FROM transactions WHERE department=? AND ticket_status='completed' AND service_date < ?`, [department, today]);
  return l.d ? { date: ymd(new Date(l.d)), fallback: true } : { date: today, fallback: false };
}

module.exports = { TARGET_WAIT, staffing, forecastDay, unusualToday, balance, balanceDay, accuracyTrend, biasFactor, decisions, DECISIONS };
