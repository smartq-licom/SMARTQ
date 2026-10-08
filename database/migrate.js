#!/usr/bin/env node
'use strict';
/**
 * Brings an existing database up to date with schema.sql WITHOUT erasing it.
 * Every step is safe to run more than once.
 *
 *   node database/migrate.js                  (database in .env)
 *   node database/migrate.js --env .env.cloud (online database)
 *
 * Add new steps to the end of STEPS when schema.sql gains a table or column.
 */
const envArg = process.argv.indexOf('--env');
if (envArg > -1) {
  const file = process.argv[envArg + 1];
  if (!file || !require('fs').existsSync(file)) {
    console.error(`\n  Settings file not found: ${file || '(none given)'}\n`);
    process.exit(1);
  }
  require('dotenv').config({ path: file });
}
const db = require('./connection');

const STEPS = [
  {
    name: 'claim_items table (claim tickets linked to paid documents)',
    sql: `CREATE TABLE IF NOT EXISTS claim_items (
      id           INT AUTO_INCREMENT PRIMARY KEY,
      claim_tx_id  INT NOT NULL,
      line_id      INT NOT NULL,
      UNIQUE KEY uq_claim_line (claim_tx_id, line_id),
      INDEX idx_line (line_id),
      CONSTRAINT fk_ci_tx   FOREIGN KEY (claim_tx_id) REFERENCES transactions(id)          ON DELETE CASCADE,
      CONSTRAINT fk_ci_line FOREIGN KEY (line_id)     REFERENCES transaction_documents(id) ON DELETE CASCADE
    ) ENGINE=InnoDB`,
  },
  {
    name: 'blank student numbers stored as NULL (so they do not clash)',
    sql: "UPDATE users SET student_no = NULL WHERE student_no = ''",
  },
  {
    name: 'one student number per account (unique index)',
    // Added only if missing. If two accounts share a number, MySQL refuses
    // and the duplicates must be fixed first (Admin > Student Accounts).
    check: `SELECT COUNT(*) AS has FROM information_schema.statistics
            WHERE table_schema = DATABASE() AND table_name = 'users' AND index_name = 'uq_student_no'`,
    add:   'ALTER TABLE users ADD UNIQUE KEY uq_student_no (student_no)',
  },
  {
    name: 'documents can be deleted but kept for old tickets (deleted_at)',
    check: `SELECT COUNT(*) AS has FROM information_schema.columns
            WHERE table_schema = DATABASE() AND table_name = 'documents' AND column_name = 'deleted_at'`,
    add:   'ALTER TABLE documents ADD COLUMN deleted_at TIMESTAMP NULL DEFAULT NULL',
  },
  {
    name: 'accounts can be deleted but kept for old tickets (deleted_at)',
    check: `SELECT COUNT(*) AS has FROM information_schema.columns
            WHERE table_schema = DATABASE() AND table_name = 'users' AND column_name = 'deleted_at'`,
    add:   'ALTER TABLE users ADD COLUMN deleted_at TIMESTAMP NULL DEFAULT NULL',
  },
  {
    name: 'staff must change a password the admin reset (must_change_password)',
    check: `SELECT COUNT(*) AS has FROM information_schema.columns
            WHERE table_schema = DATABASE() AND table_name = 'users' AND column_name = 'must_change_password'`,
    add:   'ALTER TABLE users ADD COLUMN must_change_password TINYINT(1) NOT NULL DEFAULT 0',
  },
  {
    name: 'fast filtering of history and reports by staff member (index)',
    check: `SELECT COUNT(*) AS has FROM information_schema.statistics
            WHERE table_schema = DATABASE() AND table_name = 'transactions' AND index_name = 'idx_staff'`,
    add:   'ALTER TABLE transactions ADD INDEX idx_staff (staff_id)',
  },
  {
    name: 'walk-in tickets open from the phone without a login (access_token)',
    check: `SELECT COUNT(*) AS has FROM information_schema.columns
            WHERE table_schema = DATABASE() AND table_name = 'transactions' AND column_name = 'access_token'`,
    add:   'ALTER TABLE transactions ADD COLUMN access_token CHAR(32) DEFAULT NULL, ADD UNIQUE KEY uq_access_token (access_token)',
  },
  {
    name: 'booking code to find a ticket again on another phone (booking_code)',
    check: `SELECT COUNT(*) AS has FROM information_schema.columns
            WHERE table_schema = DATABASE() AND table_name = 'transactions' AND column_name = 'booking_code'`,
    add:   'ALTER TABLE transactions ADD COLUMN booking_code CHAR(6) DEFAULT NULL',
  },
  {
    name: 'priority request linked to the ticket it is for (transaction_id)',
    check: `SELECT COUNT(*) AS has FROM information_schema.columns
            WHERE table_schema = DATABASE() AND table_name = 'priority_requests' AND column_name = 'transaction_id'`,
    add:   `ALTER TABLE priority_requests ADD COLUMN transaction_id INT DEFAULT NULL,
              ADD INDEX idx_tx (transaction_id),
              ADD CONSTRAINT fk_pr_tx FOREIGN KEY (transaction_id) REFERENCES transactions(id) ON DELETE CASCADE`,
  },
  {
    name: 'proof photos kept in the database, so a server restart cannot lose them (proof_data)',
    check: `SELECT COUNT(*) AS has FROM information_schema.columns
            WHERE table_schema = DATABASE() AND table_name = 'priority_requests' AND column_name = 'proof_data'`,
    add:   'ALTER TABLE priority_requests ADD COLUMN proof_data MEDIUMBLOB DEFAULT NULL',
  },
  {
    name: 'first come, first served by joining time or booked slot start (queue_at)',
    check: `SELECT COUNT(*) AS has FROM information_schema.columns
            WHERE table_schema = DATABASE() AND table_name = 'transactions' AND column_name = 'queue_at'`,
    add:   `ALTER TABLE transactions ADD COLUMN queue_at DATETIME DEFAULT NULL,
              ADD INDEX idx_queue (department, service_date, ticket_status, queue_at)`,
  },
  {
    name: 'older tickets get their place in line (queue_at from the request or the opening time)',
    sql: `UPDATE transactions t JOIN settings s ON s.id = 1
          SET t.queue_at = CASE WHEN t.is_scheduled = 1 THEN TIMESTAMP(t.service_date, s.open_time)
                                ELSE t.requested_at END
          WHERE t.queue_at IS NULL`,
  },
  {
    name: '30-minute booking slots (slot_start, slot_end)',
    check: `SELECT COUNT(*) AS has FROM information_schema.columns
            WHERE table_schema = DATABASE() AND table_name = 'transactions' AND column_name = 'slot_start'`,
    add:   'ALTER TABLE transactions ADD COLUMN slot_start TIME DEFAULT NULL, ADD COLUMN slot_end TIME DEFAULT NULL',
  },
  {
    name: 'warnings and phone alerts already given for a ticket (risk_at, alerts_sent)',
    check: `SELECT COUNT(*) AS has FROM information_schema.columns
            WHERE table_schema = DATABASE() AND table_name = 'transactions' AND column_name = 'alerts_sent'`,
    add:   `ALTER TABLE transactions ADD COLUMN risk_at DATETIME DEFAULT NULL,
              ADD COLUMN alerts_sent VARCHAR(80) NOT NULL DEFAULT ''`,
  },
  {
    name: '"available from": a place held while the student is busy (hold_until, hold_used)',
    check: `SELECT COUNT(*) AS has FROM information_schema.columns
            WHERE table_schema = DATABASE() AND table_name = 'transactions' AND column_name = 'hold_until'`,
    add:   `ALTER TABLE transactions ADD COLUMN hold_until DATETIME DEFAULT NULL,
              ADD COLUMN hold_used TINYINT(1) NOT NULL DEFAULT 0`,
  },
  {
    name: 'missed turns: back 5 places, cancelled on the second miss (missed_count)',
    check: `SELECT COUNT(*) AS has FROM information_schema.columns
            WHERE table_schema = DATABASE() AND table_name = 'transactions' AND column_name = 'missed_count'`,
    add:   'ALTER TABLE transactions ADD COLUMN missed_count TINYINT NOT NULL DEFAULT 0',
  },
  {
    name: 'smart Call Next: times a client was passed over (skip_count, max 2)',
    check: `SELECT COUNT(*) AS has FROM information_schema.columns
            WHERE table_schema = DATABASE() AND table_name = 'transactions' AND column_name = 'skip_count'`,
    add:   'ALTER TABLE transactions ADD COLUMN skip_count TINYINT NOT NULL DEFAULT 0',
  },
  {
    name: 'decision log: why the system accepted, warned or held a ticket',
    sql: `CREATE TABLE IF NOT EXISTS decision_log (
      id             INT AUTO_INCREMENT PRIMARY KEY,
      transaction_id INT DEFAULT NULL,
      department     VARCHAR(20) DEFAULT NULL,
      decision       VARCHAR(30) NOT NULL,
      reason         VARCHAR(255) NOT NULL,
      detail         TEXT DEFAULT NULL,
      created_at     TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_tx (transaction_id),
      INDEX idx_created (created_at)
    ) ENGINE=InnoDB`,
  },
  {
    name: 'phone notifications (Web Push) subscribed per ticket',
    sql: `CREATE TABLE IF NOT EXISTS push_subscriptions (
      id             INT AUTO_INCREMENT PRIMARY KEY,
      transaction_id INT NOT NULL,
      endpoint_hash  CHAR(64) NOT NULL,
      endpoint       TEXT NOT NULL,
      p256dh         VARCHAR(255) NOT NULL,
      auth           VARCHAR(255) NOT NULL,
      created_at     TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE KEY uq_tx_endpoint (transaction_id, endpoint_hash),
      CONSTRAINT fk_ps_tx FOREIGN KEY (transaction_id) REFERENCES transactions(id) ON DELETE CASCADE
    ) ENGINE=InnoDB`,
  },
];

(async () => {
  console.log(`\n  Updating "${process.env.DB_NAME || 'smartq_db'}" on ${process.env.DB_HOST || 'localhost'}`);
  for (const s of STEPS) {
    if (s.sql) await db.query(s.sql);
    if (s.check) {
      const [[r]] = await db.query(s.check);
      if (!Number(r.has)) await db.query(s.add);
    }
    console.log('  ok  ' + s.name);
  }
  console.log('  Done. No data was removed.\n');
})()
  .catch(e => { console.error('\n  Migration failed: ' + e.message + '\n'); process.exitCode = 1; })
  .finally(() => db.end());
