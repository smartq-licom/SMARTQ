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
