// Fires several verify calls at the same moment for ONE payment request.
// Exactly one should succeed; no duplicate membership may be created.
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const mysql = require('mysql2/promise');

const BASE = process.env.TEST_BASE_URL || `http://localhost:${process.env.PORT || 3000}`;
const ATTEMPTS = 8;

async function api(method, path, token, body) {
  const res = await fetch(BASE + path, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  let json = null;
  try { json = await res.json(); } catch (e) { /* no body */ }
  return { status: res.status, json };
}

async function login(username, password) {
  const r = await api('POST', '/api/auth/login', null, { username, password });
  if (r.status !== 200) throw new Error(`Login failed for ${username} (${r.status})`);
  return r.json.token;
}

async function main() {
  const staff = await login('staff_vellore', 'Vellore@2026');
  const admin = await login('admin', 'Admin@2026');

  const created = await api('POST', '/api/payments', staff, { member_id: 7, plan_id: 1, method: 'cash' });
  if (created.status !== 201) {
    console.log('Could not create the test request:', created.status, created.json);
    process.exit(1);
  }
  const id = created.json.payment.request_id;
  console.log(`Created request #${id} for member 7`);

  const results = await Promise.all(
    Array.from({ length: ATTEMPTS }, (_, i) =>
      api('POST', `/api/payments/${id}/verify`, admin, { verification_txn_id: `PAR-${id}-${i + 1}` })
    )
  );

  const tally = {};
  for (const r of results) tally[r.status] = (tally[r.status] || 0) + 1;
  console.log('Responses: ' + Object.entries(tally).map(([s, n]) => `${s} x${n}`).join(', '));

  const conn = await mysql.createConnection({
    host: process.env.DB_HOST || 'localhost',
    port: Number(process.env.DB_PORT || 3306),
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASSWORD || '',
    database: process.env.DB_NAME || 'libratrack',
  });
  const [[m]] = await conn.execute('SELECT COUNT(*) AS n FROM memberships WHERE payment_request_id = ?', [id]);
  const [[p]] = await conn.execute('SELECT status FROM payment_requests WHERE request_id = ?', [id]);
  await conn.end();

  console.log(`Memberships created for this request: ${m.n}`);
  console.log(`Request status: ${p.status}`);

  const ok = tally[200] === 1 && tally[409] === ATTEMPTS - 1 && Number(m.n) === 1 && p.status === 'successful';
  console.log(ok ? 'PASS: exactly one verification succeeded' : 'FAIL: see the numbers above');
  process.exit(ok ? 0 : 1);
}

main().catch((err) => {
  console.error('Test failed to run:', err.message);
  process.exit(1);
});