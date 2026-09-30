#!/usr/bin/env node
'use strict';
/**
 * Loads database/schema.sql into the MySQL server named in .env, so a cloud
 * database (Aiven, TiDB Cloud) can be set up from your own computer without
 * installing MySQL Workbench:
 *
 *   node database/import-schema.js
 *
 * WARNING: schema.sql DROPS and recreates the database. Every ticket, account
 * and setting in it is deleted. You must type the database name to confirm.
 */
require('dotenv').config();
const fs       = require('fs');
const path     = require('path');
const readline = require('readline');
const mysql    = require('mysql2/promise');

const DB_NAME = process.env.DB_NAME || 'smartq_db';

function ssl() {
  if (String(process.env.DB_SSL).toLowerCase() !== 'true') return undefined;
  const ca = (process.env.DB_SSL_CA || '').replace(/\\n/g, '\n').trim();
  return ca ? { ca, rejectUnauthorized: true } : { rejectUnauthorized: true, minVersion: 'TLSv1.2' };
}

(async () => {
  const host = process.env.DB_HOST || 'localhost';
  console.log(`\n  This will ERASE and recreate the database "${DB_NAME}" on ${host}.`);
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
    console.log('  Next: node database/create-admin.js\n');
  } finally {
    await conn.end();
  }
})().catch(e => { console.error('\n  Import failed: ' + e.message + '\n'); process.exitCode = 1; });
