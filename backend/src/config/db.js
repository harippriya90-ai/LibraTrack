const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '..', '.env') });
const mysql = require('mysql2/promise');

const pool = mysql.createPool({
  host: process.env.DB_HOST || 'localhost',
  port: Number(process.env.DB_PORT || 3306),
  user: process.env.DB_USER || 'root',
  password: process.env.DB_PASSWORD || '',
  database: process.env.DB_NAME || 'libratrack',
  waitForConnections: true,
  connectionLimit: 10,
  dateStrings: true, // DATE/DATETIME come back as plain strings, so no timezone shifting
});

// Keep every connection on library time (India), so CURDATE() matches the library's day.
pool.pool.on('connection', (conn) => {
  conn.query("SET time_zone = '+05:30'");
});

module.exports = pool;