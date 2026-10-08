#!/usr/bin/env node
'use strict';
/**
 * Demo history for presentations: realistic past office days, so the
 * forecasts, peak hours, weekday-hour patterns and accuracy have data before
 * the real history has built up. EVERYTHING it makes is tagged and can be
 * removed in one command:
 *   tickets:  submit_token starts with "demo-"
 *   people:   username starts with "demo-"
 *   receipts: receipt_no starts with "DEMO-"
 *
 *   node database/demo-history.js create [--days 60]      (database in .env)
 *   node database/demo-history.js clear
 *   node database/demo-history.js status
 *   add  --env .env.cloud  for the online database
 *
 * The days are simulated, not random rows: arrivals follow a daily rhythm
 * (busy 9–10 AM, quiet at lunch, Monday rush, an enrollment-week spike), each
 * document has its own service time (an OTR takes longer), mornings and
 * Mondays run slower, about 10% are priority, a few are no-shows. The line is
 * then served first come, first served with priority and regular taking turns
 * at the office's real windows, so waits and service times hang together.
 * Days that already have real tickets for an office are skipped.
 */
const envArg = process.argv.indexOf('--env');
if (envArg > -1) {
  const file = process.argv[envArg + 1];
  if (!file || !require('fs').existsSync(file)) { console.error(`\n  Settings file not found: ${file}\n`); process.exit(1); }
  require('dotenv').config({ path: file });
} else {
  require('dotenv').config();
}
process.env.TZ = process.env.APP_TZ || 'Asia/Manila';
const crypto = require('crypto');
const pool = require('./connection');

const cmd  = process.argv[2] || 'status';
const daysArg = process.argv.indexOf('--days');
const DAYS = daysArg > -1 ? Math.max(5, Math.min(180, parseInt(process.argv[daysArg + 1], 10) || 60)) : 60;

// ── a repeatable random source (same demo each run) ──────────────────────────
let seed = 20261015;
const rnd = () => { seed = (seed * 1664525 + 1013904223) % 4294967296; return seed / 4294967296; };
const pick = (list, weights) => {
  let r = rnd() * weights.reduce((a, b) => a + b, 0);
  for (let i = 0; i < list.length; i++) { r -= weights[i]; if (r <= 0) return list[i]; }
  return list[list.length - 1];
};
// service times are skewed (a few long ones): log-normal around the mean
const lognormal = (mean, spread) => {
  const z = Math.sqrt(-2 * Math.log(rnd() || 1e-9)) * Math.cos(2 * Math.PI * rnd());
  return mean * Math.exp(spread * z - spread * spread / 2);
};
const pad = n => String(n).padStart(2, '0');
const ymd = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const at  = (date, mins) => new Date(`${date}T${pad(Math.floor(mins / 60))}:${pad(Math.floor(mins % 60))}:${pad(Math.floor((mins % 1) * 60))}`);
const hm  = t => { const [h, m] = String(t).split(':').map(Number); return h * 60 + (m || 0); };

// ── the office day model ─────────────────────────────────────────────────────
const VOLUME   = { Cashier: 38, Registrar: 24 };                       // clients on an ordinary day
const WEEKDAY  = { 1: 1.30, 2: 1.00, 3: 0.95, 4: 1.00, 5: 0.85, 6: 0.5, 0: 0.4 };   // Monday rush
const ARRIVALS = { 7: 0.2, 8: 0.9, 9: 1.6, 10: 1.5, 11: 1.0, 12: 0.3, 13: 0.9, 14: 1.1, 15: 0.8, 16: 0.4 };
const SLOWER_H = { 8: 1.10, 9: 1.25, 10: 1.20, 11: 1.0, 13: 0.95, 14: 0.9, 15: 0.9, 16: 0.9 };   // rush hours run slower
const SLOWER_D = { 1: 1.15, 5: 0.95 };                                  // Mondays slower, Fridays lighter
// minutes per document at the window (typical); others use the office default
const DOC_TIME = {
  'Official Transcript of Records': 7, 'Late Enrollment': 8, 'Honorable Dismissal': 5,
  'Claim Released Document': 6, 'Records Inquiry': 9,
};
const DOC_MIX = {
  Cashier: { 'Certificate of Grades': 25, 'Official Transcript of Records': 15, 'Good Moral': 12,
             'Certificate of Enrollment': 12, 'Authentication': 8, 'Photocopy of Certificate of Registration': 8,
             'Honorable Dismissal': 6, 'Certificate': 6, 'Completion Fee': 3, 'Late Enrollment': 3, 'GWA': 2 },
  Registrar: { 'Claim Released Document': 60, 'Records Inquiry': 40 },
};
const FIRST = ['Juan','Maria','Jose','Ana','Mark','Kristine','John Paul','Angelica','Christian','Jasmine','Carlo','Nicole',
               'Joshua','Mae','Kevin','Rhea','Paolo','Joy','Ramon','Liza','Adrian','Grace','Jerome','Princess'];
const LAST  = ['Dela Cruz','Santos','Reyes','Garcia','Bautista','Mendoza','Villanueva','Ramos','Aquino','Castillo',
               'Rivera','Flores','Navarro','Torres','Lopez','Gonzales','Morales','Salazar','Ocampo','Pascual'];
const COURSES = ['BEED','BSED - English','BSED - Mathematics','BSED - Science','BSAB','BTVTEd - Automotive Technology'];

async function status() {
  const [[t]] = await pool.query(`SELECT COUNT(*) n, MIN(service_date) a, MAX(service_date) b FROM transactions WHERE submit_token LIKE 'demo-%'`);
  const [[u]] = await pool.query(`SELECT COUNT(*) n FROM users WHERE username LIKE 'demo-%'`);
  console.log(t.n ? `  Demo history: ${t.n} tickets from ${ymd(new Date(t.a))} to ${ymd(new Date(t.b))}, ${u.n} demo people.`
                  : '  No demo history in this database.');
}

async function clear() {
  const where = `transaction_id IN (SELECT id FROM transactions WHERE submit_token LIKE 'demo-%')`;
  for (const tbl of ['receipts', 'payments', 'transaction_documents', 'transaction_requirements', 'queue_history',
                     'announcements', 'decision_log', 'push_subscriptions', 'priority_requests'])
    await pool.query(`DELETE FROM ${tbl} WHERE ${where}`);
  await pool.query(`DELETE FROM claim_items WHERE claim_tx_id IN (SELECT id FROM transactions WHERE submit_token LIKE 'demo-%')`);
  const [r] = await pool.query(`DELETE FROM transactions WHERE submit_token LIKE 'demo-%'`);
  const [u] = await pool.query(`DELETE FROM users WHERE username LIKE 'demo-%'`);
  console.log(`  Removed ${r.affectedRows} demo tickets and ${u.affectedRows} demo people. Real data was not touched.`);
}

async function create() {
  const [[have]] = await pool.query(`SELECT COUNT(*) n FROM transactions WHERE submit_token LIKE 'demo-%'`);
  if (have.n) { console.log('  Demo history is already there. Run "clear" first to make it again.'); return; }
  const [[s]] = await pool.query('SELECT * FROM settings WHERE id=1');
  // the office's real hours, unless they look like test values (e.g. midnight)
  let open = hm(s.open_time), close = hm(s.close_time), brS = hm(s.break_start), brE = hm(s.break_end);
  if (open < 6 * 60 || close - open < 6 * 60 || close > 20 * 60) { open = 8 * 60; close = 17 * 60; }
  if (!(brS >= open && brE <= close && brE > brS)) { brS = 12 * 60; brE = 13 * 60; }
  const openDays = String(s.open_days).split(',').map(Number);   // 1=Mon .. 7=Sun
  const [docs] = await pool.query('SELECT * FROM documents WHERE deleted_at IS NULL AND is_active=1');
  const docByName = {}; docs.forEach(d => { docByName[d.name] = d; });
  const [wins] = await pool.query('SELECT w.id, w.label, w.department, u.id AS staff_id, CONCAT(u.first_name," ",u.last_name) AS staff FROM windows w LEFT JOIN users u ON u.window_id=w.id AND u.status="active"');

  // people who come back over the weeks (students by number, a few visitors)
  const people = [];
  for (let i = 0; i < 320; i++) {
    const guest = i >= 290;
    const first = pick(FIRST, FIRST.map(() => 1)), last = pick(LAST, LAST.map(() => 1));
    const course = guest ? null : pick(COURSES, COURSES.map(() => 1)), year = guest ? null : 1 + Math.floor(rnd() * 4);
    const [r] = await pool.query(
      `INSERT INTO users (username, first_name, last_name, role, status, student_no, course, year_level)
       VALUES (?,?,?,?, 'active', ?, ?, ?)`,
      ['demo-' + pad(i).padStart(4, '0'), first, last, guest ? 'guest' : 'student',
       guest ? null : '7' + String(10000000 + i * 137).slice(0, 8), course, year]);
    people.push({ id: r.insertId, first, last, guest, course, year,
                  studentNo: guest ? null : '7' + String(10000000 + i * 137).slice(0, 8) });
  }

  let tickets = 0, days = 0, receiptNo = 0;
  const today = new Date(); today.setHours(0, 0, 0, 0);
  for (let back = DAYS; back >= 1; back--) {
    const day = new Date(today); day.setDate(day.getDate() - back);
    const dow = day.getDay(), date = ymd(day);
    if (!openDays.includes(dow || 7)) continue;
    // a two-week-old enrollment rush, so the analytics have an unusual week to find
    const spike = back >= 18 && back <= 24 ? 1.4 : 1;
    let madeDay = false;
    for (const dept of ['Cashier', 'Registrar']) {
      const [[real]] = await pool.query(
        `SELECT COUNT(*) n FROM transactions WHERE department=? AND service_date=? AND (submit_token IS NULL OR submit_token NOT LIKE 'demo-%')`, [dept, date]);
      if (real.n) continue;                              // never mix with a real day
      const myWins = wins.filter(w => w.department === dept);
      if (!myWins.length) continue;

      // 1. who arrives, when, for what
      const n = Math.round(VOLUME[dept] * (WEEKDAY[dow] || 1) * spike * (0.85 + rnd() * 0.3));
      const hours = Object.keys(ARRIVALS).map(Number).filter(h => h * 60 >= open - 60 && h * 60 < close - 15);
      const clients = [];
      for (let i = 0; i < n; i++) {
        const h = pick(hours, hours.map(x => ARRIVALS[x]));
        const arr = Math.max(open - 60, Math.min(close - 10, h * 60 + rnd() * 60));
        const who = pick(people, people.map(p => (dept === 'Registrar' || !p.guest) ? 1 : 0.4));
        const mix = DOC_MIX[dept];
        const names = Object.keys(mix).filter(x => docByName[x]);
        if (!names.length) continue;
        const items = [pick(names, names.map(x => mix[x]))];
        if (dept === 'Cashier' && rnd() < 0.18) {        // some bring two requests
          const two = pick(names, names.map(x => mix[x]));
          if (two !== items[0]) items.push(two);
        }
        const priority = rnd() < 0.10;
        const booked = rnd() < 0.15;
        const slot = booked ? Math.floor((arr - open) / 30) * 30 + open : null;
        clients.push({
          who, items, priority, booked,
          queueAt: booked ? Math.max(open, slot) : arr,
          type: priority ? pick(['pwd', 'senior', 'pregnant'], [5, 3, 2]) : 'none',
          noShow: rnd() < 0.04, leftEarly: rnd() < 0.03,
        });
      }
      clients.sort((a, b) => a.queueAt - b.queueAt);

      // 2. serve them: FCFS per lane, priority and regular alternate, real windows
      const free = myWins.map(() => open);
      const lanes = { priority: clients.filter(c => c.priority), regular: clients.filter(c => !c.priority) };
      let last = 'regular';
      while (lanes.priority.length || lanes.regular.length) {
        let w = 0; for (let i = 1; i < free.length; i++) if (free[i] < free[w]) w = i;
        let t = free[w];
        if (t >= brS && t < brE) t = brE;
        const ready = l => lanes[l].length && lanes[l][0].queueAt <= t;
        let lane = ready('priority') && ready('regular') ? (last === 'priority' ? 'regular' : 'priority')
                 : ready('priority') ? 'priority' : ready('regular') ? 'regular' : null;
        if (!lane) { free[w] = Math.min(...[lanes.priority[0], lanes.regular[0]].filter(Boolean).map(c => c.queueAt)); continue; }
        const c = lanes[lane].shift(); last = lane;
        if (c.leftEarly && t - c.queueAt > 20) { c.outcome = 'cancelled'; continue; }   // gave up waiting
        if (t >= close) { c.outcome = 'closed'; continue; }
        c.win = myWins[w]; c.called = t;
        if (c.noShow) { c.outcome = 'no-show'; free[w] = t + 2; continue; }
        const h = Math.floor(t / 60);
        const base = c.items.reduce((m, x) => m + (DOC_TIME[x] || (dept === 'Cashier' ? 4 : 7)), 0) - (c.items.length - 1) * 2;
        c.minutes = Math.max(1, Math.round(lognormal(base * (SLOWER_H[h] || 1) * (SLOWER_D[dow] || 1), 0.35)));
        c.outcome = 'completed';
        free[w] = t + c.minutes;
      }

      // 3. write the day
      const counter = { priority: 0, regular: 0 };
      for (const c of clients) {
        const lane = c.priority ? 'priority' : 'regular';
        const no = (dept === 'Cashier' ? 'C' : 'R') + (c.priority ? 'P' : '') + '-' + pad(++counter[lane]).padStart(3, '0');
        const items = c.items.map(x => docByName[x]);
        const amount = items.reduce((m, d) => m + Number(d.price), 0);
        const queueAt = at(date, c.queueAt);
        const requested = c.booked ? new Date(queueAt.getTime() - (1 + Math.floor(rnd() * 5)) * 86400000) : queueAt;
        const done = c.outcome === 'completed';
        const calledAt = c.called != null ? at(date, c.called) : null;
        const completedAt = done ? at(date, c.called + c.minutes) : (c.outcome === 'no-show' ? at(date, c.called + 20) : at(date, close));
        const waitMin = c.called != null ? Math.round(c.called - c.queueAt) : null;
        // the estimate made when the ticket was taken; more accurate in later weeks (the system learning)
        const err = 0.45 * (back / DAYS) + 0.12;
        const predictedWait = waitMin != null ? Math.max(0, Math.round(waitMin * (1 + (rnd() * 2 - 1) * err))) : null;
        const slotStart = c.booked ? `${pad(Math.floor(c.queueAt / 60))}:${pad(c.queueAt % 60)}:00` : null;
        const slotEnd = c.booked ? `${pad(Math.floor((c.queueAt + 30) / 60))}:${pad((c.queueAt + 30) % 60)}:00` : null;
        const status = done ? 'completed' : c.outcome === 'no-show' ? 'no-show' : 'cancelled';
        const [r] = await pool.query(
          `INSERT INTO transactions
            (ticket_no, department, queue_category, priority_type, user_id, client_type, first_name, last_name,
             student_no, course, year_level, amount_due, ticket_status, payment_status, overall_status,
             is_scheduled, scheduled_date, service_date, staff_id, staff_name, window_id, window_label,
             submit_token, access_token, booking_code, requested_at, queue_at, slot_start, slot_end,
             called_at, started_at, completed_at, actual_minutes, predicted_wait, predicted_service, prediction_source,
             cancel_reason)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
          [no, dept, lane, c.type, c.who.id, c.who.guest ? 'guest' : 'student', c.who.first, c.who.last,
           c.who.studentNo, c.who.course, c.who.year, amount, status,
           dept === 'Cashier' ? (done ? 'paid' : 'cancelled') : 'not_required',
           done ? 'completed' : 'cancelled',
           c.booked ? 1 : 0, c.booked ? date : null, date,
           c.win ? c.win.staff_id : null, c.win ? c.win.staff : null, c.win ? c.win.id : null, c.win ? c.win.label : null,
           'demo-' + crypto.randomBytes(15).toString('hex'), crypto.randomBytes(16).toString('hex'),
           crypto.randomBytes(3).toString('hex').toUpperCase(), requested, queueAt, slotStart, slotEnd,
           calledAt, calledAt, completedAt, done ? c.minutes : null, predictedWait,
           c.items.reduce((m, x) => m + (DOC_TIME[x] || (dept === 'Cashier' ? 4 : 7)), 0), 'historical',
           done ? null : c.outcome === 'no-show' ? 'No show at the window'
                : c.outcome === 'closed' ? 'Closed: office day ended' : 'Cancelled by the client']);
        const txId = r.insertId;
        for (const d of items)
          await pool.query(`INSERT INTO transaction_documents (transaction_id,document_id,document_name,unit_price,copies,price) VALUES (?,?,?,?,1,?)`,
                           [txId, d.id, d.name, d.price, d.price]);
        if (dept === 'Cashier' && done && amount > 0) {
          const [p] = await pool.query(
            `INSERT INTO payments (transaction_id,amount,status,paid_at,staff_id,staff_name,window_label) VALUES (?,?, 'paid', ?,?,?,?)`,
            [txId, amount, completedAt, c.win.staff_id, c.win.staff, c.win.label]);
          await pool.query(`INSERT INTO receipts (receipt_no,transaction_id,payment_id,amount_paid,issued_at) VALUES (?,?,?,?,?)`,
                           [`DEMO-${date.replace(/-/g, '')}-${pad(++receiptNo).padStart(4, '0')}`, txId, p.insertId, amount, completedAt]);
        }
        tickets++; madeDay = true;
      }
    }
    if (madeDay) days++;
  }
  console.log(`  Created ${tickets} demo tickets over ${days} office days (last ${DAYS} days). Remove with: clear`);
}

(async () => {
  console.log(`\n  Demo history on "${process.env.DB_NAME || 'smartq_db'}" at ${process.env.DB_HOST || 'localhost'}`);
  if (cmd === 'create') await create();
  else if (cmd === 'clear') await clear();
  else await status();
  await status();
  console.log('');
})()
  .catch(e => { console.error('\n  Failed: ' + e.message + '\n'); process.exitCode = 1; })
  .finally(() => pool.end());
