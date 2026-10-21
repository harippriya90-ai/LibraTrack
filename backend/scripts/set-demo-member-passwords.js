// Sets bcrypt-hashed DEMO passwords for member accounts. LOCAL DEMO ONLY.
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const bcrypt = require('bcryptjs');
const mysql = require('mysql2/promise');

const DEMO_MEMBERS = [
  { email: 'ananya.krishnan@example.com', password: 'Ananya@2026' },
  { email: 'karthik.s@example.com',       password: 'Karthik@2026' },
  { email: 'lakshmi.iyer@example.com',    password: 'Lakshmi@2026' },
  { email: 'harish.babu@example.com',     password: 'Harish@2026' },
];

async function main() {
  const conn = await mysql.createConnection({
    host: process.env.DB_HOST || 'localhost',
    port: Number(process.env.DB_PORT || 3306),
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASSWORD || '',
    database: process.env.DB_NAME || 'libratrack',
  });

  for (const m of DEMO_MEMBERS) {
    const hash = await bcrypt.hash(m.password, 12);
    const [res] = await conn.execute(
      `UPDATE member_accounts ma
         JOIN members mem ON mem.member_id = ma.member_id
          SET ma.password_hash = ?, ma.must_change_password = 0,
              ma.failed_attempts = 0, ma.locked_until = NULL
        WHERE mem.email = ?`,
      [hash, m.email]
    );
    console.log(`Password set for ${m.email} (rows updated: ${res.affectedRows})`);
  }
  await conn.end();
  console.log('Done.');
}

main().catch((err) => {
  console.error('Failed:', err.message);
  process.exit(1);
});