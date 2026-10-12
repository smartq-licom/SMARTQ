'use strict';
/**
 * Workload analytics, for monitoring and performance evaluation (the Workload
 * page: admin for both offices, staff for their own).
 *
 *   today       every window now: staff, status, served, busy minutes,
 *               utilization, idle, average service; the office's balance score
 *               and tips (insights.balance) and an "unusual day" check
 *   hourly      today hour by hour: clients arriving, served, still waiting
 *   staff       a period per staff member: served, average service, speed
 *               against what the documents were expected to take, utilization,
 *               missed turns and no-shows, collected, and served week by week
 *   staffing    today's expected demand per hour and the windows it needs
 *               (insights.forecastDay: Erlang C worked backwards)
 *
 * Everything is read from existing records; nothing is stored.
 */
const pool     = require('../database/connection');
const insights = require('./insights');
const dispatch = require('./dispatch');
const q = async (sql, p = []) => (await pool.query(sql, p))[0];

const pad = n => String(n).padStart(2, '0');
const ymd = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const hm  = t => { const [h, m] = String(t).split(':').map(Number); return h * 60 + (m || 0); };
const hourLabel = h => `${h % 12 || 12} ${h < 12 ? 'AM' : 'PM'}`;
const r1 = v => Math.round(v * 10) / 10;

/** Minutes an office is open on one day (lunch excluded), up to now if it is today. */
function openMinutes(settings, dateStr) {
  const open = hm(settings.openTime), close = hm(settings.closeTime);
  const brS = hm(settings.breakStart), brE = hm(settings.breakEnd);
  const now = new Date();
  const end = dateStr === ymd(now) ? Math.max(open, Math.min(close, now.getHours() * 60 + now.getMinutes())) : close;
  return Math.max(0, end - open - Math.max(0, Math.min(end, brE) - Math.max(open, brS)));
}

// ── 1. today, window by window ───────────────────────────────────────────────
async function today(department, settings, date = ymd(new Date())) {
  const isToday = date === ymd(new Date());
  const [bal, wins, svc, unusual] = await Promise.all([
    insights.balance(department, date, settings),
    dispatch.officeWindows(department),
    q(`SELECT window_id, ROUND(AVG(actual_minutes), 1) AS avg_min, ROUND(AVG(predicted_service), 1) AS exp_min,
              SUM(actual_minutes) AS act, SUM(predicted_service) AS pred
       FROM transactions WHERE department=? AND service_date=? AND ticket_status='completed'
         AND window_id IS NOT NULL AND actual_minutes BETWEEN 1 AND 240 GROUP BY window_id`, [department, date]),
    isToday ? insights.unusualToday(department, settings).catch(() => ({ known: false })) : { known: false },
  ]);
  const now = isToday ? await q(
    `SELECT window_id, ticket_no FROM transactions WHERE department=? AND service_date=CURDATE()
       AND ticket_status IN ('called','serving')`, [department]) : [];
  const byLabel = {};
  bal.windows.forEach(w => { byLabel[w.label] = w; });
  const cards = wins.map(w => {
    const b = byLabel[w.label] || { served: 0, busy: 0, utilization: 0, idle: bal.openMin, share: 0 };
    const s = svc.find(x => x.window_id === w.id) || {};
    const serving = now.find(x => x.window_id === w.id);
    return {
      label: w.label, status: w.status, staff: w.staff || null,
      serving: serving ? serving.ticket_no : null,
      served: b.served, busy: Math.round(b.busy), utilization: b.utilization, idle: Math.round(b.idle), share: b.share,
      avgMin: s.avg_min != null ? Number(s.avg_min) : null, expMin: s.exp_min != null ? Number(s.exp_min) : null,
      // today's pace against what the documents were expected to take: 0.9 = 10% faster
      pace: s.pred ? r1(Number(s.act) / Number(s.pred) * 100) / 100 : null,
    };
  });
  return { date, isToday, openMin: bal.openMin, total: bal.total, score: bal.score, cv: bal.cv, tips: bal.tips, cards, unusual };
}

// ── 2. today, hour by hour ───────────────────────────────────────────────────
async function hourly(department, settings, date = ymd(new Date())) {
  const rows = await q(
    `SELECT COALESCE(queue_at, requested_at) AS came, called_at, completed_at, ticket_status
     FROM transactions WHERE department=? AND service_date=?`, [department, date]);
  const open = Math.floor(hm(settings.openTime) / 60), close = Math.ceil(hm(settings.closeTime) / 60);
  const nowH = date === ymd(new Date()) ? new Date().getHours() : 99;   // a past day: every hour is over
  const brS = hm(settings.breakStart), brE = hm(settings.breakEnd);
  const out = [];
  for (let h = Math.min(open, ...rows.map(r => new Date(r.came).getHours()).filter(x => x < open)); h < close; h++) {
    const end = new Date(`${date}T00:00:00`); end.setHours(h + 1, 0, 0, 0);
    const start = new Date(end.getTime() - 3600000);
    const inHour = d => d && new Date(d) >= start && new Date(d) < end;
    out.push({
      hour: h, label: hourLabel(h), future: h > nowH, isBreak: h * 60 >= brS && (h + 1) * 60 <= brE,
      arrived: rows.filter(r => inHour(r.came)).length,
      served:  rows.filter(r => r.ticket_status === 'completed' && inHour(r.completed_at)).length,
      // still in line when the hour ended (came before, not called by then, not cancelled before)
      waiting: h > nowH ? null : rows.filter(r => new Date(r.came) < end && (!r.called_at || new Date(r.called_at) >= end)
                 && !(['cancelled', 'no-show'].includes(r.ticket_status) && r.completed_at && new Date(r.completed_at) < end)).length,
    });
  }
  const seen = out.filter(x => !x.future);
  const peak = seen.reduce((a, b) => (b.arrived > (a ? a.arrived : 0) ? b : a), null);
  return { hours: out, peak: peak && peak.arrived ? peak.hour : null,
           max: Math.max(1, ...out.map(x => Math.max(x.arrived, x.served, x.waiting || 0))) };
}

// ── 3. staff over a period ───────────────────────────────────────────────────
async function staff(department, from, to, settings) {
  const dep = department ? 'AND t.department=?' : '';
  const p = department ? [from, to, department] : [from, to];
  const rows = await q(
    `SELECT t.staff_id, MAX(t.staff_name) AS name, t.department,
            COUNT(*) AS handled, SUM(t.ticket_status='completed') AS served,
            ROUND(AVG(CASE WHEN t.ticket_status='completed' AND t.actual_minutes BETWEEN 1 AND 240 THEN t.actual_minutes END), 1) AS avg_min,
            SUM(CASE WHEN t.ticket_status='completed' AND t.actual_minutes BETWEEN 1 AND 240 THEN t.actual_minutes END) AS busy,
            SUM(CASE WHEN t.ticket_status='completed' AND t.actual_minutes BETWEEN 1 AND 240 AND t.predicted_service > 0 THEN t.actual_minutes END) AS act,
            SUM(CASE WHEN t.ticket_status='completed' AND t.actual_minutes BETWEEN 1 AND 240 AND t.predicted_service > 0 THEN t.predicted_service END) AS pred,
            SUM(t.ticket_status IN ('cancelled','no-show')) AS ended,
            COUNT(DISTINCT t.service_date) AS days,
            IFNULL(SUM(CASE WHEN t.payment_status='paid' AND t.department='Cashier' THEN t.amount_due END), 0) AS collected
     FROM transactions t
     WHERE t.staff_id IS NOT NULL AND t.service_date BETWEEN ? AND ? ${dep}
     GROUP BY t.staff_id, t.department ORDER BY served DESC`, p);
  const missed = await q(
    `SELECT h.staff_id, COUNT(*) AS n FROM queue_history h
     WHERE h.action IN ('missed_turn','no-show') AND h.staff_id IS NOT NULL AND DATE(h.created_at) BETWEEN ? AND ?
     GROUP BY h.staff_id`, [from, to]);
  const weeks = await q(
    `SELECT t.staff_id, YEARWEEK(t.service_date, 3) AS wk, MIN(t.service_date) AS wstart, COUNT(*) AS n
     FROM transactions t WHERE t.staff_id IS NOT NULL AND t.ticket_status='completed' AND t.service_date BETWEEN ? AND ? ${dep}
     GROUP BY t.staff_id, wk ORDER BY wk`, p);
  const dayOpen = openMinutes(settings, '1970-01-01');           // a whole office day
  const allWeeks = [...new Set(weeks.map(w => w.wk))].sort();
  return {
    weeks: allWeeks.map(wk => { const w = weeks.find(x => x.wk === wk); return ymd(new Date(w.wstart)); }),
    rows: rows.map(r => {
      const pace = Number(r.pred) ? Number(r.act) / Number(r.pred) : null;
      return {
        name: r.name || 'Staff #' + r.staff_id, department: r.department,
        handled: Number(r.handled), served: Number(r.served) || 0, days: Number(r.days) || 0,
        avgMin: r.avg_min != null ? Number(r.avg_min) : null,
        pace: pace ? r1(pace * 100) / 100 : null,
        paceText: pace ? (pace <= 1 ? `${Math.round((1 - pace) * 100)}% faster` : `${Math.round((pace - 1) * 100)}% slower`) + ' than expected' : null,
        utilization: r.days && dayOpen ? Math.min(100, Math.round((Number(r.busy) || 0) / (r.days * dayOpen) * 100)) : null,
        perDay: r.days ? r1((Number(r.served) || 0) / r.days) : 0,
        ended: Number(r.ended) || 0,
        missed: Number((missed.find(m => m.staff_id === r.staff_id) || {}).n) || 0,
        collected: Number(r.collected) || 0,
        trend: allWeeks.map(wk => Number((weeks.find(w => w.staff_id === r.staff_id && w.wk === wk) || {}).n) || 0),
      };
    }),
  };
}

// ── 4. staffing advice for today ─────────────────────────────────────────────
async function staffing(department, settings) {
  const f = await insights.forecastDay(department, ymd(new Date()), settings);
  // merge neighbouring hours that need the same number of windows: "9-11 AM: 2 windows"
  const blocks = [];
  for (const h of f.hours) {
    if (h.isBreak) continue;
    const last = blocks[blocks.length - 1];
    if (last && last.windows === h.windows && last.to === h.hour) { last.to = h.hour + 1; last.expected += h.expected; }
    else blocks.push({ from: h.hour, to: h.hour + 1, windows: h.windows, expected: h.expected, short: h.short });
  }
  blocks.forEach(b => {
    b.label = `${hourLabel(b.from)} – ${hourLabel(b.to)}`;
    b.expected = Math.round(b.expected);
    b.short = b.windows > f.configured;
  });
  return { ...f, blocks, target: insights.TARGET_WAIT };
}

async function page(department, { from, to, day, settings }) {
  // the day to look at: asked, else today, else the latest day with service
  const d = (await insights.balanceDay(department, day || null)).date;
  const [t, h, s, st] = await Promise.all([
    today(department, settings, d), hourly(department, settings, d),
    staff(department, from, to, settings), staffing(department, settings),
  ]);
  return { department, day: d, today: t, hourly: h, staff: s, staffing: st, from, to };
}

module.exports = { page, today, hourly, staff, staffing, openMinutes };
