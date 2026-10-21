// Fires issue requests at the same moment to prove stock and limits cannot be beaten by timing.
// Needs the server running and the clean demo data.
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const mysql = require('mysql2/promise');

const BASE = process.env.TEST_BASE_URL || `http://localhost:${process.env.PORT || 3000}`;

let total = 0;
let failures = 0;
function check(label, actual, expected) {
  total += 1;
  const ok = actual === expected;
  if (!ok) failures += 1;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}: ${actual}${ok ? '' : `   (expected ${expected})`}`);
}

async function api(method, urlPath, token, json) {
  const headers = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  let body;
  if (json) {
    headers['Content-Type'] = 'application/json';
    body = JSON.stringify(json);
  }
  const res = await fetch(BASE + urlPath, { method, headers, body });
  let parsed = null;
  try { parsed = await res.json(); } catch (e) { /* no body */ }
  return { status: res.status, json: parsed };
}
const issue = (token, body) => api('POST', '/api/loans', token, body);
const errText = (r) => (r.json && r.json.error) || '';

function tally(results) {
  const t = {};
  for (const r of results) t[r.status] = (t[r.status] || 0) + 1;
  return t;
}
function summary(t) {
  return Object.entries(t).map(([s, n]) => `${s} x${n}`).join(', ');
}

async function main() {
  const lr = await api('POST', '/api/auth/login', null, { username: 'staff_coimbatore', password: 'Coimbatore@2026' });
  if (lr.status !== 200) throw new Error(`Login failed (${lr.status})`);
  const cbe = lr.json.token;
  const db = await mysql.createConnection({
    host: process.env.DB_HOST || 'localhost',
    port: Number(process.env.DB_PORT || 3306),
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASSWORD || '',
    database: process.env.DB_NAME || 'libratrack',
  });

  console.log('--- six people compete for the last copy (Coimbatore, book 17)');
  const members1 = [1, 5, 6, 7, 8, 11];
  const res1 = await Promise.all(members1.map((m) => issue(cbe, { member_id: m, book_id: 17 })));
  const t1 = tally(res1);
  console.log(`     responses: ${summary(t1)}`);
  check('Exactly one succeeded', t1[201] || 0, 1);
  check('The rest were refused', t1[409] || 0, members1.length - 1);
  check('Every refusal says no copy', res1.filter((r) => r.status === 409).every((r) => errText(r).includes('No copy')), true);
  check('No other status codes', Object.keys(t1).filter((k) => k !== '201' && k !== '409').length, 0);
  const [[o1]] = await db.execute('SELECT COUNT(*) AS n FROM loans WHERE branch_id = 3 AND book_id = 17 AND return_date IS NULL');
  check('One open loan in the database', Number(o1.n), 1);

  console.log('--- one member asks for four books at once (member 12 may borrow only one more)');
  const books2 = [2, 16, 4, 19];
  const res2 = await Promise.all(books2.map((b) => issue(cbe, { member_id: 12, book_id: b })));
  const t2 = tally(res2);
  console.log(`     responses: ${summary(t2)}`);
  check('Exactly one succeeded', t2[201] || 0, 1);
  check('The rest were refused', t2[409] || 0, books2.length - 1);
  check('Every refusal cites the borrowing limit', res2.filter((r) => r.status === 409).every((r) => errText(r).includes('Borrowing limit')), true);
  const [[o2]] = await db.execute('SELECT COUNT(*) AS n FROM loans WHERE member_id = 12 AND return_date IS NULL');
  check('Member 12 holds exactly 2 books', Number(o2.n), 2);

  console.log('--- one member asks for the same book four times at once (member 11, book 15)');
  const res3 = await Promise.all([1, 2, 3, 4].map(() => issue(cbe, { member_id: 11, book_id: 15 })));
  const t3 = tally(res3);
  console.log(`     responses: ${summary(t3)}`);
  check('Exactly one succeeded', t3[201] || 0, 1);
  check('The rest were refused', t3[409] || 0, 3);
  check('Every refusal says already on loan', res3.filter((r) => r.status === 409).every((r) => errText(r).includes('already has this book')), true);
  const [[o3]] = await db.execute('SELECT COUNT(*) AS n FROM loans WHERE member_id = 11 AND book_id = 15 AND return_date IS NULL');
  check('One open loan in the database', Number(o3.n), 1);

  console.log('--- final database check');
  const [[neg]] = await db.execute('SELECT COUNT(*) AS n FROM v_branch_availability WHERE available_copies < 0');
  check('No branch has negative availability', Number(neg.n), 0);
  await db.end();

  console.log(failures === 0 ? `\nAll ${total} checks passed` : `\n${failures} of ${total} checks FAILED`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error('Test failed to run:', err.message);
  process.exit(1);
});