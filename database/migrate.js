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
];

(async () => {
  console.log(`\n  Updating "${process.env.DB_NAME || 'smartq_db'}" on ${process.env.DB_HOST || 'localhost'}`);
  for (const s of STEPS) {
    await db.query(s.sql);
    console.log('  ok  ' + s.name);
  }
  console.log('  Done. No data was removed.\n');
})()
  .catch(e => { console.error('\n  Migration failed: ' + e.message + '\n'); process.exitCode = 1; })
  .finally(() => db.end());
