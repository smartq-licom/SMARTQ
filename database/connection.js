'use strict';
require('dotenv').config();

// SmartQ runs on Philippine time wherever it is hosted. Cloud servers (Render,
// Aiven) default to UTC, which put every ticket 8 hours early: peak hours came
// out empty and "today" rolled over at 8 AM. APP_TZ / DB_TZ can override.
process.env.TZ = process.env.APP_TZ || 'Asia/Manila';
const DB_TZ = process.env.DB_TZ || '+08:00';

const mysql = require('mysql2/promise');
const fs    = require('fs');

// Cloud MySQL (Aiven, TiDB Cloud) only accepts encrypted connections.
// DB_SSL=true turns it on; DB_SSL_CA may hold the provider's CA certificate
// (a path to the .pem file, the full PEM text, or that text with \n in place
// of line breaks). Without a CA the system's trusted certificates are used,
// which is enough for TiDB Cloud.
function readCa() {
  const v = (process.env.DB_SSL_CA || '').trim();
  if (v && !v.includes('BEGIN') && fs.existsSync(v)) return fs.readFileSync(v, 'utf8');
  return normalisePem(v.replace(/\\n/g, '\n'));
}

// A certificate pasted into a one-line box (such as a hosting dashboard) loses
// its line breaks. Rebuild the standard PEM layout so it still loads.
// A copy that left out the BEGIN/END lines (only the base64 body) is wrapped.
function normalisePem(text) {
  if (/^[A-Za-z0-9+/=\s]{200,}$/.test(text))
    text = '-----BEGIN CERTIFICATE-----\n' + text + '\n-----END CERTIFICATE-----';
  const blocks = text.match(/-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g);
  if (!blocks) return text;
  return blocks.map(b => {
    const body = b.replace(/-----(BEGIN|END) CERTIFICATE-----/g, '').replace(/\s+/g, '');
    return '-----BEGIN CERTIFICATE-----\n' + body.match(/.{1,64}/g).join('\n') + '\n-----END CERTIFICATE-----';
  }).join('\n') + '\n';
}

function sslOptions() {
  if (String(process.env.DB_SSL).toLowerCase() !== 'true') return undefined;
  const ca = readCa();
  return ca ? { ca, rejectUnauthorized: true } : { rejectUnauthorized: true, minVersion: 'TLSv1.2' };
}

const pool = mysql.createPool({
  ssl:                sslOptions(),
  host:               process.env.DB_HOST     || 'localhost',
  port:               parseInt(process.env.DB_PORT || '3306', 10),
  user:               process.env.DB_USER     || 'root',
  password:           process.env.DB_PASSWORD || '',
  database:           process.env.DB_NAME     || 'smartq_db',
  waitForConnections: true,
  connectionLimit:    10,
  queueLimit:         0,
  dateStrings:        ['DATE'],
  charset:            'utf8mb4',
  timezone:           DB_TZ,
});

// Every new connection reads and writes times in Philippine time, so NOW(),
// CURDATE() and HOUR() agree with the app. Stored TIMESTAMPs convert on read.
pool.pool.on('connection', c => c.query(`SET time_zone = '${DB_TZ.replace(/'/g, '')}'`));

pool.getConnection()
  .then(c => { console.log('  MySQL connected -> ' + (process.env.DB_NAME || 'smartq_db')); c.release(); })
  .catch(e => { console.error('  MySQL error:', e.message); });

module.exports = pool;
