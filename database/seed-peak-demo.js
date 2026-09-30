'use strict';
/**
 * Demo history generator — for showing Peak Hour Detection before the offices
 * have built up real records.
 *
 *   node database/seed-peak-demo.js          insert ~4 weeks of backdated tickets
 *   node database/seed-peak-demo.js --clear  remove them again
 *
 * Every row it writes carries a submit_token starting with 'demoseed-', which is
 * the only thing --clear deletes. Real tickets are never touched.
 *
 * The shape it builds on purpose:
 *   Cashier   busy 9-11 AM   (students pay before their first class)
 *   Registrar busy 2-4 PM    (requests land after classes)
 *   Monday heavier than the rest of the week
 *   a thin lunch hour
 *   longer waits inside the rush, so 'average wait' and 'arrivals' disagree
 *
 * THIS IS FAKE DATA. Clear it before the system goes into real use, or the
 * reports will mix invented tickets with genuine ones.
 */
const pool = require('./connection');

const WEEKS       = 4;      // how many weeks back to fill
const OPEN_HOUR   = 8;
const CLOSE_HOUR  = 17;
const BREAK_HOUR  = 12;

// Relative demand by hour, per office. 1.0 = an ordinary hour.
const SHAPE = {
  Cashier:   { 8: 1.0, 9: 3.5, 10: 3.2, 11: 1.6, 12: 0.3, 13: 1.0, 14: 1.2, 15: 1.0, 16: 0.7 },
  Registrar: { 8: 0.8, 9: 1.2, 10: 1.4, 11: 1.0, 12: 0.3, 13: 1.4, 14: 3.0, 15: 2.6, 16: 1.1 },
};
const BASE = { Cashier: 3, Registrar: 2 };           // tickets per ordinary hour
const WEEKDAY_WEIGHT = { 1: 1.4, 2: 1.0, 3: 1.0, 4: 1.0, 5: 1.2 };  // Mon..Fri

const pad = (n, w = 2) => String(n).padStart(w, '0');
const ymd = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const stamp = (d, h, m) => `${ymd(d)} ${pad(h)}:${pad(m)}:00`;

/** Deterministic pseudo-random so repeated runs give the same shape. */
let seed = 20260930;
function rnd() {
  seed = (seed * 1103515245 + 12345) & 0x7fffffff;
  return seed / 0x7fffffff;
}

async function clear() {
  const [r] = await pool.execute(
    "DELETE FROM transactions WHERE submit_token LIKE 'demoseed-%'");
  console.log(`  removed ${r.affectedRows} demo ticket(s)`);
}

async function seedData() {
  // Attach the tickets to a real student, because transactions.user_id is a
  // foreign key. Any student account will do.
  const [users] = await pool.execute(
    "SELECT id, first_name, middle_name, last_name, student_no, course, year_level, academic_year " +
    "FROM users WHERE role='student' ORDER BY id LIMIT 1");
  if (!users.length) {
    console.error('  No student account found. Import schema.sql first.');
    return;
  }
  const u = users[0];

  const [docs] = await pool.execute(
    'SELECT id, name, price, office FROM documents ORDER BY id');
  if (!docs.length) {
    console.error('  No documents found. Import schema.sql first.');
    return;
  }

  const rows = [];
  let n = 0;
  const today = new Date();

  for (let back = 1; back <= WEEKS * 7; back++) {
    const day = new Date(today);
    day.setDate(day.getDate() - back);
    const dow = day.getDay();
    if (!WEEKDAY_WEIGHT[dow]) continue;             // weekends closed

    for (const dept of ['Cashier', 'Registrar']) {
      let seq = 0;
      for (let h = OPEN_HOUR; h < CLOSE_HOUR; h++) {
        const want = BASE[dept] * (SHAPE[dept][h] || 1) * WEEKDAY_WEIGHT[dow];
        const count = Math.max(0, Math.round(want + (rnd() - 0.5)));

        for (let i = 0; i < count; i++) {
          seq++; n++;
          const minute    = Math.min(59, Math.floor(i * (55 / Math.max(count, 1)) + rnd() * 4));
          const requested = stamp(day, h, minute);

          // Waits are long inside the rush and short outside it. This is what
          // makes 'longest wait' land in a different hour from 'most arrivals'.
          const busy    = (SHAPE[dept][h] || 1) >= 2.5;
          const waitMin = busy ? 22 + Math.floor(rnd() * 25) : 3 + Math.floor(rnd() * 9);
          const svcMin  = 5 + Math.floor(rnd() * 9);

          const calledMin    = minute + waitMin;
          const startedMin   = calledMin + 1;
          const completedMin = startedMin + svcMin;

          const doc  = docs[Math.floor(rnd() * docs.length)];
          const tkNo = (dept === 'Cashier' ? 'C-' : 'R-') + pad(seq, 3);
          const token = ('demoseed-' + pad(n, 6) + '-' + ymd(day) + '-' + dept)
                          .slice(0, 36).padEnd(36, '0');

          rows.push([
            tkNo, dept, 'regular', 'none',
            u.id, 'student',
            u.first_name, u.middle_name, u.last_name,
            u.student_no, u.course, u.year_level, u.academic_year,
            'self',
            Number(doc.price) || 0,
            'completed',
            Number(doc.price) > 0 ? 'paid' : 'not_required',
            'completed',
            0, null, ymd(day),
            token,
            requested,
            stamp(day, h + Math.floor(calledMin / 60), calledMin % 60),
            stamp(day, h + Math.floor(startedMin / 60), startedMin % 60),
            stamp(day, h + Math.floor(completedMin / 60), completedMin % 60),
            svcMin,
          ]);
        }
      }
    }
  }

  const sql =
    `INSERT INTO transactions
       (ticket_no, department, queue_category, priority_type,
        user_id, client_type,
        first_name, middle_name, last_name,
        student_no, course, year_level, academic_year,
        claimant, amount_due,
        ticket_status, payment_status, overall_status,
        is_scheduled, scheduled_date, service_date,
        submit_token,
        requested_at, called_at, started_at, completed_at, actual_minutes)
     VALUES ?`;

  // One multi-row insert per 500 tickets keeps the packet size sane.
  const conn = await pool.getConnection();
  try {
    for (let i = 0; i < rows.length; i += 500) {
      await conn.query(sql, [rows.slice(i, i + 500)]);
    }
  } finally { conn.release(); }

  console.log(`  inserted ${rows.length} demo tickets across ${WEEKS} weeks`);
  console.log('  Cashier peaks 9-11 AM, Registrar peaks 2-4 PM, Mondays heaviest.');
  console.log('  Remove them with: node database/seed-peak-demo.js --clear');
}

(async () => {
  try {
    const clearing = process.argv.includes('--clear');
    await clear();                       // always start from a clean slate
    if (!clearing) await seedData();
  } catch (e) {
    console.error('  Failed:', e.message);
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
})();
