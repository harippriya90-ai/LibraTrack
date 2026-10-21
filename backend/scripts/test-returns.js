// Tests returning books, fine calculation, duplicate-return protection and the loans list.
// Needs the server running and the clean demo data (22 loans).
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
const errText = (r) => (r.json && r.json.error) || '';

// Library dates are India time.
function istToday() {
  return new Date(Date.now() + 5.5 * 3600 * 1000).toISOString().slice(0, 10);
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
  const mem = await memberLogin('ananya.krishnan@example.com', 'Ananya@2026');
  const today = istToday();

  const db = await mysql.createConnection({
    host: process.env.DB_HOST || 'localhost',
    port: Number(process.env.DB_PORT || 3306),
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASSWORD || '',
    database: process.env.DB_NAME || 'libratrack',
  });
  await db.query("SET time_zone = '+05:30'");

  const [[cnt]] = await db.execute('SELECT COUNT(*) AS n FROM loans');
  if (Number(cnt.n) !== 22) {
    console.log(`Expected the clean demo data (22 loans) but found ${cnt.n}. Run the clean-up command first.`);
    await db.end();
    process.exit(1);
  }

  const list = (token, qs = '') => api('GET', `/api/loans${qs}`, token);
  const totalOf = async (token, qs) => (await list(token, qs)).json.total;
  let r;

  console.log('--- loans list: filters, scope, paging');
  r = await list(admin);
  check('Admin sees all loans', r.json.total, 22);
  check('10 rows on page 1', r.json.data.length, 10);
  check('3 pages', r.json.total_pages, 3);
  check('Newest issue date first', r.json.data[0].loan_id, 15);
  check('Borrower email and phone not exposed', r.json.data[0].email === undefined && r.json.data[0].phone === undefined, true);
  check('Page 3 has the last 2', (await list(admin, '?page=3')).json.data.length, 2);
  check('Page beyond the end is empty', (await list(admin, '?page=99')).json.data.length, 0);
  check('Sort by loan ID ascending', (await list(admin, '?sort=loan_id&dir=asc')).json.data[0].loan_id, 1);
  check('Loan ID 21', await totalOf(admin, '?loan_id=21'), 1);
  check('Member 3', await totalOf(admin, '?member_id=3'), 2);
  check('Member 11', await totalOf(admin, '?member_id=11'), 4);
  check('Member name harish', await totalOf(admin, '?member_name=harish'), 4);
  check('Book 1', await totalOf(admin, '?book_id=1'), 2);
  check('Book text python', await totalOf(admin, '?book=python'), 2);
  check('Book text narayan', await totalOf(admin, '?book=narayan'), 3);
  check('Status returned', await totalOf(admin, '?status=returned'), 8);
  check('Status open', await totalOf(admin, '?status=open'), 14);
  const act = await totalOf(admin, '?status=active');
  const ovd = await totalOf(admin, '?status=overdue');
  check('Active + overdue = open', act + ovd, 14);
  check('Issued since 2020', await totalOf(admin, '?issued_from=2020-01-01'), 22);
  check('Issued before 2020', await totalOf(admin, '?issued_to=2020-01-01'), 0);
  check('Returned since 2020', await totalOf(admin, '?returned_from=2020-01-01'), 8);
  check('Due after 2100', await totalOf(admin, '?due_from=2100-01-01'), 0);
  check('Chennai staff sees only Chennai', await totalOf(chn), 9);
  check('Chennai staff + branch_id=3 is ignored', await totalOf(chn, '?branch_id=3'), 9);
  check('Vellore staff', await totalOf(vel), 7);
  check('Admin branch 3', await totalOf(admin, '?branch_id=3'), 6);
  check('Admin branch 2', await totalOf(admin, '?branch_id=2'), 7);
  check('Admin: Chennai returned loans', await totalOf(admin, '?branch_id=1&status=returned'), 4);
  check('Bad status', (await list(admin, '?status=zzz')).status, 400);
  check('Bad sort', (await list(admin, '?sort=zzz')).status, 400);
  check('Bad date', (await list(admin, '?issued_from=2026-13-45')).status, 400);
  check('Bad loan_id', (await list(admin, '?loan_id=abc')).status, 400);
  check('Bad member_id', (await list(admin, '?member_id=abc')).status, 400);
  check('Bad min_fine', (await list(admin, '?min_fine=abc')).status, 400);
  check('Member token', (await list(mem)).status, 403);
  check('No token', (await list(null)).status, 401);

  console.log('--- issue then return through the API');
  const stockOf = async (token, bookId) => (await api('GET', `/api/books?book_id=${bookId}`, token)).json.data[0].available_copies;
  const a0 = await stockOf(chn, 17);
  const iss = await api('POST', '/api/loans', chn, { member_id: 6, book_id: 17 });
  check('Issue book 17 to member 6', iss.status, 201);
  check('Availability dropped', await stockOf(chn, 17), a0 - 1);
  const apiLoanId = iss.json.loan.loan_id;
  const ret = await api('POST', `/api/loans/${apiLoanId}/return`, chn);
  check('Return it', ret.status, 200);
  check('Status is returned', ret.json.loan.loan_status, 'returned');
  check('Returned today', ret.json.loan.return_date, today);
  check('No fine when returned on time', ret.json.loan.fine_amount, '0.00');
  check('Fine is finalized, not an estimate', ret.json.loan.fine_kind, 'finalized');
  check('Availability restored', await stockOf(chn, 17), a0);
  check('Stock info in the response', ret.json.stock.available_copies, a0);
  check('Returned-by is the staff member', ret.json.loan.returned_by_name, 'Chennai Branch Staff');

  console.log('--- fine calculation (loans inserted directly, returned through the API)');
  async function insertLoan({ member, branch, book, dueOffset, rate, grace = 0, cap = null, issuedBy }) {
    const [ins] = await db.execute(
      `INSERT INTO loans
         (member_id, branch_id, book_id, issue_date, due_date, fine_rate_snapshot,
          grace_days_snapshot, fine_cap_snapshot, issued_by)
       VALUES (?, ?, ?, DATE_ADD(CURDATE(), INTERVAL ? DAY), DATE_ADD(CURDATE(), INTERVAL ? DAY), ?, ?, ?, ?)`,
      [member, branch, book, dueOffset - 14, dueOffset, rate, grace, cap, issuedBy]
    );
    return ins.insertId;
  }
  const cases = [
    { label: 'Returned on the due date', book: 10, dueOffset: 0, rate: '5.00', expDays: 0, expFine: '0.00' },
    { label: 'One day late', book: 10, dueOffset: -1, rate: '5.00', expDays: 1, expFine: '5.00' },
    { label: 'Returned early', book: 8, dueOffset: 5, rate: '5.00', expDays: 0, expFine: '0.00' },
    { label: 'Four days late at 5 per day', book: 10, dueOffset: -4, rate: '5.00', expDays: 4, expFine: '20.00' },
    { label: 'Ten days late, 3 grace days', book: 19, dueOffset: -10, rate: '5.00', grace: 3, expDays: 7, expFine: '35.00' },
    { label: 'Ten days late, cap of 30', book: 19, dueOffset: -10, rate: '5.00', cap: '30.00', expDays: 10, expFine: '30.00' },
    { label: 'Three days late at 2.50 per day', book: 19, dueOffset: -3, rate: '2.50', expDays: 3, expFine: '7.50' },
  ];
  for (const c of cases) {
    c.id = await insertLoan({ member: 5, branch: 1, book: c.book, dueOffset: c.dueOffset, rate: c.rate, grace: c.grace || 0, cap: c.cap || null, issuedBy: 2 });
  }
  const returned = [];
  for (const c of cases) {
    const rr = await api('POST', `/api/loans/${c.id}/return`, chn);
    const loan = rr.json && rr.json.loan;
    check(c.label, `${rr.status}: ${loan ? loan.overdue_days : '?'} days, ${loan ? loan.fine_amount : '?'}`, `200: ${c.expDays} days, ${c.expFine}`);
    returned.push(loan);
  }
  check('All show returned, finalized, dated today', returned.every((l) => l && l.loan_status === 'returned' && l.fine_kind === 'finalized' && l.return_date === today), true);
  const [fines] = await db.query('SELECT loan_id, overdue_days, rate_applied, calculated_amount FROM loan_fines WHERE loan_id IN (?)', [cases.map((c) => c.id)]);
  check('A fine row was saved for each', fines.length, cases.length);
  check('Saved rows match the expected figures', cases.every((c) => {
    const f = fines.find((x) => x.loan_id === c.id);
    return f && f.overdue_days === c.expDays && f.calculated_amount === c.expFine && f.rate_applied === c.rate;
  }), true);

  console.log('--- expired membership can still return; the loan keeps its own rate');
  const expId = await insertLoan({ member: 4, branch: 1, book: 12, dueOffset: -20, rate: '4.00', issuedBy: 2 });
  const er = await api('POST', `/api/loans/${expId}/return`, chn);
  check('Return accepted', er.status, 200);
  check('Fine uses the loan rate (4.00), not the catalogue rate (2.00)', er.json.loan.fine_amount, '80.00');
  const mst = await api('GET', '/api/members/4', admin);
  check('Member is still inactive (expired)', mst.json.member.effective_status, 'inactive');

  console.log('--- access rules and duplicate returns');
  const accessId = await insertLoan({ member: 5, branch: 1, book: 2, dueOffset: 3, rate: '5.00', issuedBy: 2 });
  const vId = await insertLoan({ member: 7, branch: 2, book: 10, dueOffset: 3, rate: '2.00', issuedBy: 3 });
  const url = `/api/loans/${accessId}/return`;
  check('No token', (await api('POST', url, null)).status, 401);
  check('Member token', (await api('POST', url, mem)).status, 403);
  check('Other branch staff', (await api('POST', url, vel)).status, 403);
  check('Loan 9999', (await api('POST', '/api/loans/9999/return', admin)).status, 404);
  check('Loan abc', (await api('POST', '/api/loans/abc/return', admin)).status, 400);
  check('Chennai staff on a Vellore loan', (await api('POST', `/api/loans/${vId}/return`, chn)).status, 403);
  check('Seeded loan 4 is already returned', (await api('POST', '/api/loans/4/return', admin)).status, 409);
  check('Own branch staff returns', (await api('POST', url, chn)).status, 200);
  const dup = await api('POST', url, chn);
  check('Second return refused', dup.status === 409 && errText(dup).includes('already returned'), true);
  const [[fc]] = await db.execute('SELECT COUNT(*) AS n FROM loan_fines WHERE loan_id = ?', [accessId]);
  check('Still exactly one fine row', Number(fc.n), 1);
  check('Admin returns a Vellore loan', (await api('POST', `/api/loans/${vId}/return`, admin)).status, 200);
  const [[rb]] = await db.execute('SELECT returned_by FROM loans WHERE loan_id = ?', [vId]);
  check('Returned-by recorded as the admin (user 1)', Number(rb.returned_by), 1);

  console.log('--- six simultaneous returns of the same loan');
  const pId = await insertLoan({ member: 5, branch: 1, book: 2, dueOffset: -2, rate: '5.00', issuedBy: 2 });
  const results = await Promise.all([1, 2, 3, 4, 5, 6].map(() => api('POST', `/api/loans/${pId}/return`, chn)));
  const tally = {};
  for (const x of results) tally[x.status] = (tally[x.status] || 0) + 1;
  console.log(`     responses: ${Object.entries(tally).map(([s, n]) => `${s} x${n}`).join(', ')}`);
  check('Exactly one succeeded', tally[200] || 0, 1);
  check('The rest were refused', tally[409] || 0, 5);
  const winner = results.find((x) => x.status === 200);
  check('Winner shows 2 days and a fine of 10.00', winner ? `${winner.json.loan.overdue_days} days, ${winner.json.loan.fine_amount}` : null, '2 days, 10.00');
  const [[pc]] = await db.execute('SELECT COUNT(*) AS n FROM loan_fines WHERE loan_id = ?', [pId]);
  check('Exactly one fine row', Number(pc.n), 1);

  console.log('--- database checks');
  const [[neg]] = await db.execute('SELECT COUNT(*) AS n FROM v_branch_availability WHERE available_copies < 0');
  check('No branch has negative availability', Number(neg.n), 0);
  const [[nofine]] = await db.execute('SELECT COUNT(*) AS n FROM loans l LEFT JOIN loan_fines lf ON lf.loan_id = l.loan_id WHERE l.return_date IS NOT NULL AND lf.loan_id IS NULL');
  check('Every returned loan has a fine row', Number(nofine.n), 0);
  const [[aud]] = await db.execute("SELECT COUNT(*) AS n FROM audit_logs WHERE action = 'loan_returned'");
  check('Audit rows for returns', Number(aud.n) >= 12, true);
  await db.end();

  console.log(failures === 0 ? `\nAll ${total} checks passed` : `\n${failures} of ${total} checks FAILED`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error('Test failed to run:', err.message);
  process.exit(1);
});