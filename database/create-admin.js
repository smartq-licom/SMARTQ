#!/usr/bin/env node
'use strict';
/**
 * Creates the first admin account, or resets an existing admin's password.
 * schema.sql ships with no user accounts, so run this once after importing it:
 *
 *   node database/create-admin.js                    (database in .env)
 *   node database/create-admin.js --env .env.cloud   (online database)
 *
 * It asks for a username, name and password. The password must pass the same
 * rules as the rest of the system and is stored only as a bcrypt hash.
 * Cashier and registrar accounts are then created from Admin > Staff Accounts.
 */
// --env <file>: load that file before connection.js reads .env. dotenv never
// overwrites a value that is already set, so the file's values win.
const envArg = process.argv.indexOf('--env');
if (envArg > -1) {
  const file = process.argv[envArg + 1];
  if (!file || !require('fs').existsSync(file)) {
    console.error(`\n  Settings file not found: ${file || '(none given)'}\n`);
    process.exit(1);
  }
  require('dotenv').config({ path: file });
}

const readline = require('readline');
const db       = require('./connection');
const auth     = require('../data/auth');

// Read answers from a buffered line iterator so nothing is lost when input is
// pasted or piped faster than the questions are printed.
const rl    = readline.createInterface({ input: process.stdin });
const lines = rl[Symbol.asyncIterator]();
async function ask(q) {
  process.stdout.write(q);
  const { value, done } = await lines.next();
  if (done) throw new Error('Cancelled.');
  return value.trim();
}

(async () => {
  console.log('\n  SmartQ admin setup\n');
  const username = await ask('  Admin username: ');
  if (!/^[A-Za-z0-9._-]{3,60}$/.test(username)) throw new Error('Username must be 3-60 letters, numbers, dots, dashes or underscores.');

  const [existing] = await db.query('SELECT id, role FROM users WHERE username = ?', [username]);
  if (existing.length && existing[0].role !== 'admin') throw new Error(`"${username}" already belongs to a ${existing[0].role} account.`);

  let first = 'System', last = 'Administrator';
  if (!existing.length) {
    first = (await ask('  First name [System]: ')) || first;
    last  = (await ask('  Last name [Administrator]: ')) || last;
  }

  console.log('\n  ' + auth.PASSWORD_RULES.map(r => r.label).join(', ') + '.');
  const pw = await ask('  Password: ');
  const problem = auth.checkPassword(pw);
  if (problem) throw new Error(problem);
  if ((await ask('  Repeat password: ')) !== pw) throw new Error('Passwords do not match.');

  const hash = await auth.hashPassword(pw);
  if (existing.length) {
    await db.query(
      `UPDATE users SET password = ?, status = 'active', failed_logins = 0, locked_until = NULL,
         password_changed_at = NOW() WHERE id = ?`, [hash, existing[0].id]);
    console.log(`\n  Password updated for admin "${username}".\n`);
  } else {
    await db.query(
      `INSERT INTO users (first_name, last_name, username, password, role, auth_provider,
         email_verified, status, priority_status, password_changed_at)
       VALUES (?, ?, ?, ?, 'admin', 'local', 1, 'active', 'none', NOW())`,
      [first, last, username, hash]);
    console.log(`\n  Admin "${username}" created. Log in on the SmartQ home page.\n`);
  }
})()
  .catch(e => { console.error('\n  ' + e.message + '\n'); process.exitCode = 1; })
  .finally(() => { rl.close(); db.end(); });
