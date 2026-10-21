// Tests loan issuing rules. Needs the server running and the clean demo data.
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

// Library dates are India time.
function istToday() {
  return new Date(Date.now() + 5.5 * 3600 * 1000).toISOString().slice(0, 10);
}
function addDays(dateStr, n) {
  const d = new Date(`${dateStr}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

async function login(username, password) {
  const r = await api('POST', '/api/auth/login', null, { username, password });
  if (r.status !== 200) throw new Error(`Login failed for ${username} (${r.status})`);
  return r.json.token;
}
async function memberLogin(email, password) {
  const r = await api('POST', '/api/auth/member-login', null, { email, password });
  if (r.status !== 200) throw new Error(`Member login failed for ${email} (${r.status})`);
  return r.json.token;
}

async function main() {
  const admin = await login('admin', 'Admin@2026');
  const chn = await login('staff_chennai', 'Chennai@2026');
  const vel = await login('staff_vellore', 'Vellore@2026');
  const cbe = await login('staff_coimbatore', 'Coimbatore@2026');
  const mem = await memberLogin('ananya.krishnan@example.com', 'Ananya@2026');
  const today = istToday();
  const db = await mysql.createConnection({
    host: process.env.DB_HOST || 'localhost',
    port: Number(process.env.DB_PORT || 3306),
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASSWORD || '',
    database: process.env.DB_NAME || 'libratrack',
  });
  const stock = async (token, bookId) => (await api('GET', `/api/books?book_id=${bookId}`, token)).json.data[0].available_copies;
  let r;

  console.log('--- access and input rules');
  check('No token', (await issue(null, { member_id: 3, book_id: 1 })).status, 401);
  check('Member token', (await issue(mem, { member_id: 3, book_id: 1 })).status, 403);
  check('Missing member_id', (await issue(chn, { book_id: 1 })).status, 400);
  check('Missing book_id', (await issue(chn, { member_id: 3 })).status, 400);
  check('Non-numeric member_id', (await issue(chn, { member_id: 'abc', book_id: 1 })).status, 400);
  check('Staff naming another branch', (await issue(chn, { member_id: 3, book_id: 1, branch_id: 2 })).status, 403);
  check('Admin without branch_id', (await issue(admin, { member_id: 3, book_id: 1 })).status, 400);

  console.log('--- member eligibility');
  check('Unknown member', (await issue(chn, { member_id: 9999, book_id: 1 })).status, 404);
  r = await issue(vel, { member_id: 10, book_id: 10 });
  check('Restricted member refused', r.status === 409 && errText(r).includes('restricted'), true);
  r = await issue(vel, { member_id: 9, book_id: 10 });
  check('Suspended member refused', r.status === 409 && errText(r).includes('suspended until'), true);
  r = await issue(chn, { member_id: 4, book_id: 1 });
  check('Expired membership refused', r.status === 409 && errText(r).includes('expired'), true);
  r = await issue(cbe, { member_id: 13, book_id: 2 });
  check('Member with no membership refused', r.status === 409 && errText(r).includes('no membership'), true);
  const tm = await api('POST', '/api/members', chn, { full_name: 'Loan Test Member', email: 'loan.test@example.com', phone: '+919840099777' });
  check('Create test member', tm.status, 201);
  const tmId = tm.json.member.member_id;
  await api('PATCH', `/api/members/${tmId}/status`, chn, { is_active: false });
  r = await issue(chn, { member_id: tmId, book_id: 1 });
  check('Deactivated member refused', r.status === 409 && errText(r).includes('deactivated'), true);
  check('Delete test member', (await api('DELETE', `/api/members/${tmId}`, chn)).status, 200);

  console.log('--- book and stock rules');
  check('Unknown book', (await issue(chn, { member_id: 3, book_id: 99999 })).status, 404);
  r = await issue(chn, { member_id: 3, book_id: 7 });
  check('Book not stocked at this branch', r.status === 409 && errText(r).includes('does not stock'), true);
  r = await issue(cbe, { member_id: 5, book_id: 9 });
  check('No copy available (Coimbatore, book 9)', r.status === 409 && errText(r).includes('No copy'), true);
  const ab = await api('POST', '/api/books', admin, { title: 'Archive Test Book', author: 'Test Author', category: 'Testing', price: 10 });
  check('Create test book', ab.status, 201);
  const abId = ab.json.book.book_id;
  await api('PATCH', `/api/books/${abId}/status`, admin, { is_active: false });
  r = await issue(chn, { member_id: 3, book_id: abId });
  check('Archived book refused', r.status === 409 && errText(r).includes('archived'), true);
  check('Delete test book', (await api('DELETE', `/api/books/${abId}`, admin)).status, 200);

  console.log('--- issuing and snapshots');
  const before = await stock(chn, 3);
  const l1 = await issue(chn, { member_id: 5, book_id: 3 });
  check('Issue book 3 to member 5', l1.status, 201);
  const loan1 = l1.json.loan;
  check('Issue date is today', loan1.issue_date, today);
  check('Due date is 21 days later (Annual plan)', loan1.due_date, addDays(today, 21));
  check('Fine rate copied from the book', loan1.fine_rate, '5.00');
  check('Grace days copied', loan1.grace_days, 0);
  check('Fine cap copied (none)', loan1.fine_cap, null);
  check('Status is active', loan1.loan_status, 'active');
  check('Borrower email and phone not exposed', loan1.email === undefined && loan1.phone === undefined, true);
  check('Availability dropped by one', await stock(chn, 3), before - 1);
  r = await issue(chn, { member_id: 5, book_id: 3 });
  check('Same member, same book refused', r.status === 409 && errText(r).includes('already has this book'), true);
  check('Admin raises book 3 fine rate to 9', (await api('PATCH', '/api/books/3', admin, { fine_per_day: 9 })).status, 200);
  const again = await api('GET', `/api/loans/${loan1.loan_id}`, chn);
  check('Existing loan keeps its old rate', again.json.loan.fine_rate, '5.00');
  const l2 = await issue(chn, { member_id: 3, book_id: 3 });
  check('Issue book 3 to member 3', l2.status, 201);
  check('New loan uses the new rate', l2.json.loan.fine_rate, '9.00');
  check('Due date is 14 days later (Quarterly plan)', l2.json.loan.due_date, addDays(today, 14));
  check('Admin restores book 3 fine rate', (await api('PATCH', '/api/books/3', admin, { fine_per_day: 5 })).status, 200);
  const again2 = await api('GET', `/api/loans/${l2.json.loan.loan_id}`, chn);
  check('Second loan keeps its rate', again2.json.loan.fine_rate, '9.00');
  r = await issue(chn, { member_id: 1, book_id: 3 });
  check('Last copy gone: no copy available', r.status === 409 && errText(r).includes('No copy'), true);
  check('Availability is now zero', await stock(chn, 3), 0);

  console.log('--- borrowing limit (member 3 may hold 3)');
  check('Third open loan allowed', (await issue(chn, { member_id: 3, book_id: 1 })).status, 201);
  r = await issue(chn, { member_id: 3, book_id: 2 });
  check('Fourth refused', r.status === 409 && errText(r).includes('Borrowing limit'), true);

  console.log('--- cross-branch lending, admin, member view');
  const x = await issue(chn, { member_id: 8, book_id: 5 });
  check('Chennai lends to a Vellore member', x.status, 201);
  check('Loan is at the lending branch', x.json.loan.branch_id, 1);
  check('Borrower name shown to the lending branch', x.json.loan.member_name, 'Mohammed Faizan');
  const a = await issue(admin, { member_id: 7, book_id: 8, branch_id: 2 });
  check('Admin issues at Vellore', a.status, 201);
  check('Loan branch is Vellore', a.json.loan.branch_id, 2);
  const y = await issue(chn, { member_id: 1, book_id: 4 });
  check('Issue book 4 to Ananya', y.status, 201);
  const mine = await api('GET', '/api/me/loans', mem);
  check('Ananya sees it in her own loans', mine.json.data.some((l) => l.title === 'Operating System Concepts'), true);

  console.log('--- loan detail access');
  const id1 = loan1.loan_id;
  check('Own branch staff', (await api('GET', `/api/loans/${id1}`, chn)).status, 200);
  check('Admin', (await api('GET', `/api/loans/${id1}`, admin)).status, 200);
  check('Other branch staff', (await api('GET', `/api/loans/${id1}`, vel)).status, 403);
  check('Member token', (await api('GET', `/api/loans/${id1}`, mem)).status, 403);
  check('No token', (await api('GET', `/api/loans/${id1}`, null)).status, 401);
  check('Loan 9999', (await api('GET', '/api/loans/9999', admin)).status, 404);
  check('Loan abc', (await api('GET', '/api/loans/abc', admin)).status, 400);
  const seeded = await api('GET', '/api/loans/1', admin);
  check('Seeded overdue loan shows a live estimate', seeded.json.loan.loan_status === 'overdue' && seeded.json.loan.fine_kind === 'estimate', true);

  console.log('--- database checks');
  const [[neg]] = await db.execute('SELECT COUNT(*) AS n FROM v_branch_availability WHERE available_copies < 0');
  check('No branch has negative availability', Number(neg.n), 0);
  const [[aud]] = await db.execute("SELECT COUNT(*) AS n FROM audit_logs WHERE action = 'loan_issued'");
  check('Audit rows for issued loans', Number(aud.n) >= 6, true);
  await db.end();

  console.log(failures === 0 ? `\nAll ${total} checks passed` : `\n${failures} of ${total} checks FAILED`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error('Test failed to run:', err.message);
  process.exit(1);
});