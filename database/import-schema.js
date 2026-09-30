#!/usr/bin/env node
'use strict';
/**
 * Loads database/schema.sql into the MySQL server named in .env, so a cloud
 * database (Aiven, TiDB Cloud) can be set up from your own computer without
 * installing MySQL Workbench:
 *
 *   node database/import-schema.js --env .env.cloud
 *
 * --env loads the online database's settings from that file instead of .env,
 * so your local .env never has to be edited.
 *
 * WARNING: schema.sql DROPS and recreates the database. Every ticket, account
 * and setting in it is deleted. You must type the database name to confirm.
 */
loadEnvArg();
require('dotenv').config();
const fs       = require('fs');
const path     = require('path');
const readline = require('readline');
const mysql    = require('mysql2/promise');

const DB_NAME = process.env.DB_NAME || 'smartq_db';

/** --env <file>: load that file first. dotenv never overwrites a set value. */
function loadEnvArg() {
  const i = process.argv.indexOf('--env');
  if (i < 0) return;
  const file = process.argv[i + 1];
  if (!file || !require('fs').existsSync(file)) {
    console.error(`\n  Settings file not found: ${file || '(none given)'}\n`);
    process.exit(1);
  }
  require('dotenv').config({ path: file });
}

/** DB_SSL_CA may be a path to the .pem file or the certificate text itself. */
function readCa() {
  const v = (process.env.DB_SSL_CA || '').trim();
  if (v && !v.includes('BEGIN') && fs.existsSync(v)) return fs.readFileSync(v, 'utf8');
  return v.replace(/\\n/g, '\n');
}

function ssl() {
  if (String(process.env.DB_SSL).toLowerCase() !== 'true') return undefined;
  const ca = readCa();
  return ca ? { ca, rejectUnauthorized: true } : { rejectUnauthorized: true, minVersion: 'TLSv1.2' };
}

(async () => {
  const host = process.env.DB_HOST || 'localhost';
  console.log(`\n  This will ERASE and recreate the database "${DB_NAME}" on ${host}.`);
  if (/^(localhost|127\.0\.0\.1|::1)$/.test(host))
    console.log('  !! That is the database ON THIS COMPUTER. For the online one, add --env .env.cloud');
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const answer = await new Promise(res => rl.question(`  Type ${DB_NAME} to continue: `, a => res(a.trim())));
  rl.close();
  if (answer !== DB_NAME) { console.log('\n  Cancelled. Nothing was changed.\n'); return; }

  // schema.sql names smartq_db itself; point it at DB_NAME if that differs.
  let sql = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
  if (DB_NAME !== 'smartq_db') sql = sql.replace(/\bsmartq_db\b/g, DB_NAME);

  const conn = await mysql.createConnection({
    host,
    port: parseInt(process.env.DB_PORT || '3306', 10),
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASSWORD || '',
    ssl: ssl(),
    multipleStatements: true,
    charset: 'utf8mb4',
  });
  try {
    await conn.query(sql);
    const [t] = await conn.query(
      'SELECT COUNT(*) AS n FROM information_schema.tables WHERE table_schema = ?', [DB_NAME]);
    console.log(`\n  Done. "${DB_NAME}" now has ${t[0].n} tables.`);
    console.log('  Next: npm run ' + (process.argv.includes('--env') ? 'cloud:admin' : 'db:admin') + '\n');
  } finally {
    await conn.end();
  }
})().catch(e => { console.error('\n  Import failed: ' + e.message + '\n'); process.exitCode = 1; });
