// Tests the dashboard and Reports A and B against independent SQL, plus CSV exports.
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
  const text = await res.text();
  let parsed = null;
  if ((res.headers.get('content-type') || '').includes('application/json')) {
    try { parsed = JSON.parse(text); } catch (e) { /* not json */ }
  }
  return { status: res.status, json: parsed, text, headers: res.headers };
}

function istToday() {
  return new Date(Date.now() + 5.5 * 3600 * 1000).toISOString().slice(0, 10);
}
function daysBetween(fromStr, toStr) {
  return Math.round((new Date(`${toStr}T00:00:00Z`) - new Date(`${fromStr}T00:00:00Z`)) / 86400000);
}
const m2 = (x) => Number(x).toFixed(2);

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
const csvLines = (text) => text.replace(/^\uFEFF/, '').split('\r\n').filter((l) => l.length > 0);

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
  const n = async (sql, p = []) => {
    const [[row]] = await db.execute(sql, p);
    return Number(Object.values(row)[0]);
  };

  if ((await n('SELECT COUNT(*) FROM loans')) !== 22 || (await n('SELECT COUNT(*) FROM members')) !== 15) {
    console.log('Expected the clean demo data (22 loans, 15 members). Run the clean-up command first.');
    await db.end();
    process.exit(1);
  }

  const ESTIMATE = `LEAST(COALESCE(fine_cap_snapshot, 999999999),
      GREATEST(0, DATEDIFF(CURDATE(), due_date) - CAST(grace_days_snapshot AS SIGNED)) * fine_rate_snapshot)`;
  const dash = (token, qs = '') => api('GET', `/api/dashboard${qs}`, token);
  let r;

  console.log('--- dashboard: administrator, all branches (every figure checked against SQL)');
  r = await dash(admin);
  const s = r.json.stats;
  check('Book titles', s.book_titles, await n('SELECT COUNT(*) FROM books WHERE is_active = 1'));
  const copiesSql = await n('SELECT COALESCE(SUM(bi.total_copies), 0) FROM branch_inventory bi JOIN books b ON b.book_id = bi.book_id AND b.is_active = 1');
  check('Physical copies', s.physical_copies, copiesSql);
  check('Physical copies (seed data)', s.physical_copies, 71);
  check('Available copies', s.available_copies, await n(`SELECT COALESCE(SUM(GREATEST(bi.total_copies - (SELECT COUNT(*) FROM loans l WHERE l.branch_id = bi.branch_id AND l.book_id = bi.book_id AND l.return_date IS NULL), 0)), 0)
    FROM branch_inventory bi JOIN books b ON b.book_id = bi.book_id AND b.is_active = 1`));
  check('Ebook titles', s.ebook_titles, await n('SELECT COUNT(*) FROM ebooks WHERE is_active = 1'));
  check('Registered members', s.registered_members, await n('SELECT COUNT(*) FROM members'));
  check('Active memberships', s.active_memberships, await n(`SELECT COUNT(DISTINCT ms.member_id) FROM memberships ms JOIN members m ON m.member_id = ms.member_id
    WHERE m.is_active = 1 AND CURDATE() BETWEEN ms.start_date AND ms.expiry_date`));
  check('Active loans', s.active_loans, await n('SELECT COUNT(*) FROM loans WHERE return_date IS NULL'));
  check('Active loans (seed data)', s.active_loans, 14);
  const overdueSql = await n('SELECT COUNT(*) FROM loans WHERE return_date IS NULL AND due_date < CURDATE()');
  check('Overdue loans', s.overdue_loans, overdueSql);
  check('Pending payment requests', s.pending_payment_requests, await n("SELECT COUNT(*) FROM payment_requests WHERE status = 'pending'"));
  const finalizedSql = await n('SELECT COALESCE(SUM(calculated_amount), 0) FROM loan_fines WHERE waived = 0');
  const estimatedSql = await n(`SELECT COALESCE(SUM(${ESTIMATE}), 0) FROM loans WHERE return_date IS NULL`);
  const outFinal = await n(`SELECT COALESCE(SUM(GREATEST(CASE WHEN lf.waived = 1 THEN 0 ELSE lf.calculated_amount END
    - COALESCE((SELECT SUM(fp.amount) FROM fine_payments fp WHERE fp.loan_id = lf.loan_id AND fp.status = 'successful'), 0), 0)), 0) FROM loan_fines lf`);
  check('Finalized fines', s.fines.finalized_total, m2(finalizedSql));
  check('Finalized fines (seed data)', s.fines.finalized_total, '94.00');
  check('Estimated fines on open loans', s.fines.estimated_open_total, m2(estimatedSql));
  check('Total calculated fines', s.fines.total_calculated, m2(finalizedSql + estimatedSql));
  check('Outstanding fines', s.fines.outstanding, m2(outFinal + estimatedSql));
  check('Branch summary: 3 branches', r.json.branches.length, 3);
  check('Branch summary: members add up', r.json.branches.reduce((a, b) => a + b.members, 0), 15);
  check('Branch summary: active loans add up', r.json.branches.reduce((a, b) => a + b.active_loans, 0), 14);
  check('Newest loan first', r.json.recent_loans[0].loan_id, 15);
  check('Most overdue loan first in alerts', r.json.overdue_alerts[0].loan_id, 13);
  check('Alerts are capped at 5', r.json.overdue_alerts.length, Math.min(5, overdueSql));
  check('Newest member first', r.json.recent_members[0].member_id, 13);
  check('Newest payment request first', r.json.recent_payment_requests[0].request_id, 14);
  check('No contact details on the dashboard', r.json.recent_members[0].email === undefined && r.json.recent_members[0].phone === undefined, true);

  console.log('--- dashboard: branch scope and access');
  r = await dash(chn);
  const c = r.json.stats;
  check('Chennai staff: titles / copies / available / members / loans', `${c.book_titles}/${c.physical_copies}/${c.available_copies}/${c.registered_members}/${c.active_loans}`, '13/30/25/5/5');
  check('Chennai staff: overdue matches SQL', c.overdue_loans, await n('SELECT COUNT(*) FROM loans WHERE branch_id = 1 AND return_date IS NULL AND due_date < CURDATE()'));
  check('Scope label', r.json.scope.label, 'Central Branch - Chennai');
  check('No branch summary for staff', r.json.branches === undefined, true);
  check('All recent loans are Chennai loans', r.json.recent_loans.every((l) => l.branch_name === 'Central Branch - Chennai'), true);
  r = await dash(chn, '?branch_id=3');
  check('Chennai staff + branch_id=3 is ignored', r.json.stats.registered_members, 5);
  check('Chennai staff still sees Chennai', r.json.scope.label, 'Central Branch - Chennai');
  r = await dash(admin, '?branch_id=3');
  const c3 = r.json.stats;
  check('Admin branch 3: titles / copies / available / members / loans', `${c3.book_titles}/${c3.physical_copies}/${c3.available_copies}/${c3.registered_members}/${c3.active_loans}`, '12/19/14/5/5');
  check('No branch summary for a single branch', r.json.branches === undefined, true);
  check('Admin with a bad branch_id', (await dash(admin, '?branch_id=abc')).status, 400);
  check('Member token', (await dash(mem)).status, 403);
  check('No token', (await dash(null)).status, 401);

  console.log('--- Report A: overdue and unreturned loans');
  const repA = (token, qs = '') => api('GET', `/api/reports/overdue${qs}`, token);
  const aTotal = async (token, qs) => (await repA(token, qs)).json.total;
  r = await repA(admin);
  check('Total matches SQL', r.json.total, overdueSql);
  check('At most 10 rows per page', r.json.data.length, Math.min(10, overdueSql));
  check('Pages add up', r.json.total_pages, Math.ceil(overdueSql / 10));
  check('Every row is past its due date', r.json.data.every((x) => x.days_late > 0 && x.loan_status === 'overdue' && x.return_date === null), true);
  check('Most overdue first', r.json.data[0].loan_id, 13);
  check('Report shows a generation time', typeof r.json.generated_at === 'string' && r.json.generated_at.length > 0, true);
  check('Fine total equals all estimates', r.json.totals.fine_total, m2(estimatedSql));
  check('Borrower email not exposed', r.json.data[0].email === undefined, true);
  for (const [id, rate] of [[13, 2], [21, 4]]) {
    const one = (await repA(admin, `?loan_id=${id}`)).json.data[0];
    const days = daysBetween(one.due_date, today);
    check(`Loan ${id}: ${days} days x ${rate}.00`, `${one.days_late} days, ${one.fine_amount}, ${one.fine_payment_status}`, `${days} days, ${m2(days * rate)}, estimate`);
  }
  check('Member 4', await aTotal(admin, '?member_id=4'), 1);
  check('Member name harish', await aTotal(admin, '?member_name=harish'), await n("SELECT COUNT(*) FROM loans l JOIN members m ON m.member_id = l.member_id WHERE l.return_date IS NULL AND l.due_date < CURDATE() AND m.full_name LIKE '%harish%'"));
  check('Category Fiction', await aTotal(admin, '?category=Fiction'), await n("SELECT COUNT(*) FROM loans l JOIN books b ON b.book_id = l.book_id WHERE l.return_date IS NULL AND l.due_date < CURDATE() AND b.category = 'Fiction'"));
  check('Late 30 days or more', await aTotal(admin, '?min_days=30'), await n('SELECT COUNT(*) FROM loans WHERE return_date IS NULL AND DATEDIFF(CURDATE(), due_date) >= 30'));
  check('Fine at least 100', await aTotal(admin, '?min_fine=100'), await n(`SELECT COUNT(*) FROM loans WHERE return_date IS NULL AND due_date < CURDATE() AND ${ESTIMATE} >= 100`));
  check('Chennai staff', await aTotal(chn), await n('SELECT COUNT(*) FROM loans WHERE branch_id = 1 AND return_date IS NULL AND due_date < CURDATE()'));
  check('Chennai staff + branch_id=3 is ignored', await aTotal(chn, '?branch_id=3'), await n('SELECT COUNT(*) FROM loans WHERE branch_id = 1 AND return_date IS NULL AND due_date < CURDATE()'));
  check('Vellore staff', await aTotal(vel), await n('SELECT COUNT(*) FROM loans WHERE branch_id = 2 AND return_date IS NULL AND due_date < CURDATE()'));
  check('Admin branch 3', await aTotal(admin, '?branch_id=3'), await n('SELECT COUNT(*) FROM loans WHERE branch_id = 3 AND return_date IS NULL AND due_date < CURDATE()'));
  const byFine = (await repA(admin, '?sort=fine&dir=desc')).json.data;
  check('Sort by fine, highest first', byFine.length < 2 || Number(byFine[0].fine_amount) >= Number(byFine[1].fine_amount), true);
  check('Page beyond the end is empty', (await repA(admin, '?page=99')).json.data.length, 0);
  check('Bad member_id', (await repA(admin, '?member_id=abc')).status, 400);
  check('Bad min_days', (await repA(admin, '?min_days=abc')).status, 400);
  check('Bad date', (await repA(admin, '?due_from=2026-13-45')).status, 400);
  check('Bad sort', (await repA(admin, '?sort=zzz')).status, 400);
  check('Bad format', (await repA(admin, '?format=xml')).status, 400);
  check('Member token', (await repA(mem)).status, 403);
  check('No token', (await repA(null)).status, 401);
  const csvA = await repA(admin, '?format=csv');
  check('CSV status and type', `${csvA.status} ${(csvA.headers.get('content-type') || '').split(';')[0]}`, '200 text/csv');
  check('CSV file name', /attachment; filename="overdue-loans-\d{8}-\d{6}\.csv"/.test(csvA.headers.get('content-disposition') || ''), true);
  check('CSV generation time header', (csvA.headers.get('x-report-generated') || '').length > 0, true);
  check('CSV has a header plus every matching row', csvLines(csvA.text).length, overdueSql + 1);

  console.log('--- Report B: complete borrowing and return history');
  const repB = (token, qs = '') => api('GET', `/api/reports/loans${qs}`, token);
  const bTotal = async (token, qs) => (await repB(token, qs)).json.total;
  r = await repB(admin);
  check('All loans', r.json.total, 22);
  check('Pages', r.json.total_pages, 3);
  check('Newest issue date first', r.json.data[0].loan_id, 15);
  check('Status returned', await bTotal(admin, '?status=returned'), 8);
  check('Status open', await bTotal(admin, '?status=open'), 14);
  check('Active + overdue = open', (await bTotal(admin, '?status=active')) + (await bTotal(admin, '?status=overdue')), 14);
  check('Returned late', await bTotal(admin, '?status=returned_late'), 5);
  check('Returned on time', await bTotal(admin, '?status=returned_on_time'), 3);
  const late = (await repB(admin, '?status=returned_late')).json.data;
  check('Every late return is labelled late with a finalized fine', late.every((x) => x.return_timing === 'late' && x.fine_type === 'finalized'), true);
  const l5 = (await repB(admin, '?loan_id=5')).json.data[0];
  check('Loan 5: fine, paid, balance, status', `${l5.fine_amount} / ${l5.fine_paid} / ${l5.fine_balance} / ${l5.fine_payment_status}`, '25.00 / 10.00 / 15.00 / partial');
  const l4 = (await repB(admin, '?loan_id=4')).json.data[0];
  check('Loan 4: on time, no fine', `${l4.return_timing} / ${l4.fine_payment_status}`, 'on_time / no_fine');
  const l1 = (await repB(admin, '?loan_id=1')).json.data[0];
  check('Loan 1 (open): live estimate', `${l1.fine_type} / ${l1.fine_payment_status} / ${l1.return_timing}`, 'estimate / estimate / null');
  check('Member name harish', await bTotal(admin, '?member_name=harish'), 4);
  check('Book text python', await bTotal(admin, '?book=python'), 2);
  check('Category Biography', await bTotal(admin, '?category=Biography'), 3);
  check('Returned since 2020', await bTotal(admin, '?returned_from=2020-01-01'), 8);
  check('Issued before 2020', await bTotal(admin, '?issued_to=2020-01-01'), 0);
  check('Chennai staff', await bTotal(chn), 9);
  check('Chennai staff + branch_id=3 is ignored', await bTotal(chn, '?branch_id=3'), 9);
  check('Vellore staff', await bTotal(vel), 7);
  check('Admin branch 3', await bTotal(admin, '?branch_id=3'), 6);
  check('Sort by title', (await repB(admin, '?sort=title')).json.data[0].title, 'A Brief History of Time');
  check('Bad status', (await repB(admin, '?status=zzz')).status, 400);
  check('Bad sort', (await repB(admin, '?sort=zzz')).status, 400);
  check('Member token', (await repB(mem)).status, 403);
  check('No token', (await repB(null)).status, 401);

  console.log('--- CSV exports: all rows, branch scope, formula protection');
  const csvAdmin = await repB(admin, '?format=csv');
  check('Admin CSV: header plus all 22 loans', csvLines(csvAdmin.text).length, 23);
  check('Admin CSV header', csvLines(csvAdmin.text)[0].startsWith('Loan ID,Book ID,Book title'), true);
  check('Admin CSV includes a Vellore borrower', csvAdmin.text.includes('Faizan'), true);
  const csvChn = await repB(chn, '?format=csv');
  check('Chennai CSV: header plus 9 loans', csvLines(csvChn.text).length, 10);
  check('Chennai CSV has no Vellore borrower', csvChn.text.includes('Faizan'), false);
  const csvLate = await repB(admin, '?format=csv&status=returned_late');
  check('Filtered CSV: header plus 5 loans', csvLines(csvLate.text).length, 6);

  const tm = await api('POST', '/api/members', chn, { full_name: '=Formula Test', email: 'formula.test@example.com', phone: '+919840099888' });
  check('Setup: member whose name starts with =', tm.status, 201);
  const tmId = tm.json.member.member_id;
  const [ins] = await db.execute(
    `INSERT INTO loans (member_id, branch_id, book_id, issue_date, due_date, fine_rate_snapshot,
                        grace_days_snapshot, fine_cap_snapshot, issued_by)
     VALUES (?, 1, 10, DATE_ADD(CURDATE(), INTERVAL -5 DAY), DATE_ADD(CURDATE(), INTERVAL 9 DAY), 2.00, 0, NULL, 2)`,
    [tmId]
  );
  const csvInj = await repB(admin, '?format=csv&member_name=Formula');
  const injLines = csvLines(csvInj.text);
  check('Formula-looking name is neutralized in the CSV', injLines.length === 2 && injLines[1].includes(",'=Formula Test,") && !injLines[1].includes(',=Formula'), true);
  await db.execute('DELETE FROM loans WHERE loan_id = ?', [ins.insertId]);
  check('Cleanup: delete the test member', (await api('DELETE', `/api/members/${tmId}`, chn)).status, 200);

  console.log('--- audit trail');
  check('Exports were audited (no personal data)', (await n("SELECT COUNT(*) FROM audit_logs WHERE action = 'report_exported'")) >= 5, true);
  await db.end();

  console.log(failures === 0 ? `\nAll ${total} checks passed` : `\n${failures} of ${total} checks FAILED`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error('Test failed to run:', err.message);
  process.exit(1);
});