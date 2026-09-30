'use strict';
require('dotenv').config();
const mysql = require('mysql2/promise');

const pool = mysql.createPool({
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
