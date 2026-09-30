'use strict';
require('dotenv').config();
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
  return v.replace(/\\n/g, '\n');
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
});

pool.getConnection()
  .then(c => { console.log('  MySQL connected -> ' + (process.env.DB_NAME || 'smartq_db')); c.release(); })
  .catch(e => { console.error('  MySQL error:', e.message); });

module.exports = pool;
