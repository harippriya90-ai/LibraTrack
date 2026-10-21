// Tests the inventory, ebook, expiring-membership and member-status reports against independent SQL.
// Read-only. Needs the server running and the clean demo data.
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

async function api(method, urlPath, token) {
  const headers = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(BASE + urlPath, { method, headers });
  const text = await res.text();
  let parsed = null;
  if ((res.headers.get('content-type') || '').includes('application/json')) {
    try { parsed = JSON.parse(text); } catch (e) { /* not json */ }
  }
  return { status: res.status, json: parsed, text, headers: res.headers };
}
const csvLines = (text) => text.replace(/^\uFEFF/, '').split('\r\n').filter((l) => l.length > 0);

async function login(username, password) {
  const r = await api2('/api/auth/login', { username, password });
  if (r.status !== 200) throw new Error(`Login failed for ${username} (${r.status})`);
  return r.json.token;
}
async function memberLogin(email, password) {
  const r = await api2('/api/auth/member-login', { email, password });
  if (r.status !== 200) throw new Error(`Member login failed for ${email} (${r.status})`);
  return r.json.token;
}
async function api2(urlPath, body) {
  const res = await fetch(BASE + urlPath, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  let json = null;
  try { json = await res.json(); } catch (e) { /* no body */ }
  return { status: res.status, json };
}

async function main() {
  const admin = await login('admin', 'Admin@2026');
  const chn = await login('staff_chennai', 'Chennai@2026');
  const vel = await login('staff_vellore', 'Vellore@2026');
  const mem = await memberLogin('ananya.krishnan@example.com', 'Ananya@2026');

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

  if ((await n('SELECT COUNT(*) FROM loans')) !== 22 || (await n('SELECT COUNT(*) FROM members')) !== 15
      || (await n('SELECT COUNT(*) FROM branch_inventory')) !== 37 || (await n('SELECT COUNT(*) FROM ebooks')) !== 4) {
    console.log('Expected the clean demo data (22 loans, 15 members, 37 stock rows, 4 ebooks). Run the restore command first.');
    await db.end();
    process.exit(1);
  }
  const exportsBefore = await n("SELECT COUNT(*) FROM audit_logs WHERE action = 'report_exported'");
  let r;

  console.log('--- Branch inventory');
  const inv = (token, qs = '') => api('GET', `/api/reports/inventory${qs}`, token);
  const invTotal = async (token, qs) => (await inv(token, qs)).json.total;
  const openAt = '(SELECT COUNT(*) FROM loans l WHERE l.branch_id = bi.branch_id AND l.book_id = bi.book_id AND l.return_date IS NULL)';
  r = await inv(admin);
  check('Rows match SQL', r.json.total, await n('SELECT COUNT(*) FROM branch_inventory bi JOIN books b ON b.book_id = bi.book_id AND b.is_active = 1'));
  check('Rows (seed data)', r.json.total, 37);
  check('10 rows per page', r.json.data.length, 10);
  check('4 pages', r.json.total_pages, 4);
  check('Total copies', r.json.totals.copies, 71);
  check('Copies on loan = open loans', r.json.totals.on_loan, await n('SELECT COUNT(*) FROM loans WHERE return_date IS NULL'));
  check('Available = copies - on loan', r.json.totals.available, r.json.totals.copies - r.json.totals.on_loan);
  check('Has a generation time', typeof r.json.generated_at === 'string' && r.json.generated_at.length > 0, true);
  check('Default order starts with the first branch', r.json.data[0].branch_name, 'Central Branch - Chennai');
  r = await inv(chn);
  check('Chennai staff: rows / copies / on loan / available', `${r.json.total} / ${r.json.totals.copies} / ${r.json.totals.on_loan} / ${r.json.totals.available}`, '13 / 30 / 5 / 25');
  check('Chennai staff + branch_id=3 is ignored', await invTotal(chn, '?branch_id=3'), 13);
  check('Admin branch 3', await invTotal(admin, '?branch_id=3'), 12);
  check('Title python', await invTotal(admin, '?title=python'), 4);
  check('Author narayan', await invTotal(admin, '?author=narayan'), 4);
  check('Category Fiction', await invTotal(admin, '?category=Fiction'), 5);
  check('ISBN 90000-05', await invTotal(admin, '?isbn=90000-05'), 2);
  check('Book ID 17', await invTotal(admin, '?book_id=17'), 2);
  const unavail = await invTotal(admin, '?availability=unavailable');
  check('Unavailable matches SQL', unavail, await n(`SELECT COUNT(*) FROM branch_inventory bi JOIN books b ON b.book_id = bi.book_id AND b.is_active = 1 WHERE bi.total_copies - ${openAt} <= 0`));
  check('Available + unavailable = all', (await invTotal(admin, '?availability=available')) + unavail, 37);
  check('Archived titles', await invTotal(admin, '?status=inactive'), 0);
  check('All statuses', await invTotal(admin, '?status=all'), 37);
  const byTotal = (await inv(admin, '?sort=total&dir=desc')).json.data;
  check('Sort by total copies, highest first', byTotal[0].total_copies >= byTotal[1].total_copies && byTotal[0].total_copies === 3, true);
  check('Bad availability', (await inv(admin, '?availability=zzz')).status, 400);
  check('Bad status', (await inv(admin, '?status=zzz')).status, 400);
  check('Bad sort', (await inv(admin, '?sort=zzz')).status, 400);
  check('Bad book_id', (await inv(admin, '?book_id=abc')).status, 400);
  check('Bad format', (await inv(admin, '?format=xml')).status, 400);
  check('Member token', (await inv(mem)).status, 403);
  check('No token', (await inv(null)).status, 401);
  let csv = await inv(admin, '?format=csv');
  check('CSV: header plus 37 rows', csvLines(csv.text).length, 38);
  check('CSV type and name', `${(csv.headers.get('content-type') || '').split(';')[0]} ${/filename="branch-inventory-\d{8}-\d{6}\.csv"/.test(csv.headers.get('content-disposition') || '')}`, 'text/csv true');
  csv = await inv(chn, '?format=csv');
  check('Chennai CSV: header plus 13 rows', csvLines(csv.text).length, 14);

  console.log('--- Ebook catalogue');
  const eb = (token, qs = '') => api('GET', `/api/reports/ebooks${qs}`, token);
  const ebTotal = async (token, qs) => (await eb(token, qs)).json.total;
  r = await eb(admin);
  check('Active ebooks', r.json.total, await n('SELECT COUNT(*) FROM ebooks WHERE is_active = 1'));
  check('Policies: read only / download / staff only', `${r.json.totals.read_only} / ${r.json.totals.download_allowed} / ${r.json.totals.staff_only}`, '2 / 1 / 1');
  check('Format pdf', await ebTotal(admin, '?file_format=pdf'), 4);
  check('Format epub', await ebTotal(admin, '?file_format=epub'), 0);
  check('Policy staff_only', await ebTotal(admin, '?policy=staff_only'), 1);
  check('Archived ebooks', await ebTotal(admin, '?status=inactive'), 0);
  for (const [word, id, expectStatus] of [['Pride', 2, 'read and download'], ['Think', 1, 'read online'], ['Handbook', 4, 'staff only']]) {
    const row = (await eb(admin, `?title=${word}`)).json.data[0];
    const granted = await n('SELECT COUNT(*) FROM ebook_access WHERE ebook_id = ? AND granted = 1', [id]);
    const denied = await n('SELECT COUNT(*) FROM ebook_access WHERE ebook_id = ? AND granted = 0', [id]);
    check(`Ebook ${id}: access status and access counts`, `${row.access_status} / ${row.granted_accesses} / ${row.denied_accesses}`, `${expectStatus} / ${granted} / ${denied}`);
  }
  check('File names and paths are never shown', JSON.stringify(r.json).includes('demo_ebook') || JSON.stringify(r.json).includes('stored_file_name'), false);
  check('Staff can view the catalogue', await ebTotal(chn), 4);
  check('Bad file_format filter', (await eb(admin, '?file_format=doc')).status, 400);
  check('Bad policy', (await eb(admin, '?policy=zzz')).status, 400);
  check('Member token', (await eb(mem)).status, 403);
  check('No token', (await eb(null)).status, 401);
  csv = await eb(admin, '?format=csv');
  check('CSV: header plus 4 ebooks', csvLines(csv.text).length, 5);
  check('CSV has no file names', csv.text.includes('demo_ebook'), false);

  console.log('--- Memberships expiring soon');
  const ex = (token, qs = '') => api('GET', `/api/reports/memberships-expiring${qs}`, token);
  const exTotal = async (token, qs) => (await ex(token, qs)).json.total;
  const expSql = (days, branch) => n(`SELECT COUNT(*) FROM memberships ms JOIN members m ON m.member_id = ms.member_id
    WHERE m.is_active = 1 AND CURDATE() BETWEEN ms.start_date AND ms.expiry_date
      AND ms.expiry_date <= DATE_ADD(CURDATE(), INTERVAL ${days} DAY)
      AND NOT EXISTS (SELECT 1 FROM memberships nx WHERE nx.member_id = ms.member_id AND nx.start_date > ms.expiry_date)
      ${branch ? `AND m.home_branch_id = ${branch}` : ''}`);
  r = await ex(admin);
  check('Default 30 days matches SQL', r.json.total, await expSql(30));
  check('7 days matches SQL', await exTotal(admin, '?days=7'), await expSql(7));
  check('365 days matches SQL', await exTotal(admin, '?days=365'), await expSql(365));
  check('Wider windows never shrink', (await exTotal(admin, '?days=365')) >= r.json.total && r.json.total >= (await exTotal(admin, '?days=7')), true);
  check('Every row is inside the window, soonest first', r.json.data.every((x, i, a) => x.days_left >= 0 && x.days_left <= 30 && (i === 0 || a[i - 1].expiry_date <= x.expiry_date)), true);
  check('Renewal flag is a yes/no value', r.json.data.every((x) => typeof x.renewal_request_pending === 'boolean'), true);
  check('Member 14 already renewed, so not listed', await exTotal(admin, '?member_id=14&days=365'), 0);
  check('Chennai staff matches SQL', await exTotal(chn, '?days=365'), await expSql(365, 1));
  check('Chennai staff + branch_id=3 is ignored', await exTotal(chn, '?days=365&branch_id=3'), await expSql(365, 1));
  check('Admin branch 3 matches SQL', await exTotal(admin, '?days=365&branch_id=3'), await expSql(365, 3));
  check('Days = abc', (await ex(admin, '?days=abc')).status, 400);
  check('Days = 0', (await ex(admin, '?days=0')).status, 400);
  check('Days = 366', (await ex(admin, '?days=366')).status, 400);
  check('Member token', (await ex(mem)).status, 403);
  csv = await ex(admin, '?days=365&format=csv');
  check('CSV: header plus every row', csvLines(csv.text).length, (await expSql(365)) + 1);

  console.log('--- Members by status');
  const mb = (token, qs = '') => api('GET', `/api/reports/members${qs}`, token);
  const mbTotal = async (token, qs) => (await mb(token, qs)).json.total;
  const [srows] = await db.query('SELECT effective_status AS s, COUNT(*) AS c FROM v_member_status GROUP BY effective_status');
  const sc = {};
  srows.forEach((x) => { sc[x.s] = Number(x.c); });
  const cnt = (k) => sc[k] || 0;
  r = await mb(admin);
  check('All members', r.json.total, 15);
  check('Status totals: active / inactive / suspended / restricted',
    `${r.json.totals.active} / ${r.json.totals.inactive} / ${r.json.totals.suspended} / ${r.json.totals.restricted}`,
    `${cnt('active')} / ${cnt('inactive')} / ${cnt('suspended')} / ${cnt('restricted')}`);
  check('Totals add up to all members', r.json.totals.active + r.json.totals.inactive + r.json.totals.suspended + r.json.totals.restricted, 15);
  for (const k of ['active', 'inactive', 'suspended', 'restricted']) {
    check(`Filter status=${k}`, await mbTotal(admin, `?status=${k}`), cnt(k));
  }
  check('Default order starts with A', r.json.data[0].member_name, 'Ananya Krishnan');
  check('Restricted member is Sanjay Kumar', (await mb(admin, '?status=restricted')).json.data[0].member_name, 'Sanjay Kumar');
  check('Latest payment successful', await mbTotal(admin, '?payment_status=successful'), 12);
  check('Latest payment pending + expired', (await mbTotal(admin, '?payment_status=pending')) + (await mbTotal(admin, '?payment_status=expired')), 3);
  check('Latest payment rejected', await mbTotal(admin, '?payment_status=rejected'), 0);
  check('Members with no payment requests', await mbTotal(admin, '?payment_status=none'), 0);
  check('Member 11 has 3 open loans', (await mb(admin, '?member_id=11')).json.data[0].open_loans, 3);
  check('Name harish', await mbTotal(admin, '?member_name=harish'), 1);
  check('Registered since 2020', await mbTotal(admin, '?registered_from=2020-01-01'), 15);
  check('Registered before 2020', await mbTotal(admin, '?registered_to=2020-01-01'), 0);
  check('Membership ended before 2020', await mbTotal(admin, '?expiry_to=2020-01-01'), 0);
  check('Membership ends after 2100', await mbTotal(admin, '?expiry_from=2100-01-01'), 0);
  check('Chennai staff', await mbTotal(chn), 5);
  check('Chennai staff + branch_id=3 is ignored', await mbTotal(chn, '?branch_id=3'), 5);
  check('Vellore staff', await mbTotal(vel), 5);
  check('Admin branch 3', await mbTotal(admin, '?branch_id=3'), 5);
  check('Contact details are not in the report', r.json.data[0].email === undefined && r.json.data[0].phone === undefined, true);
  check('Bad status', (await mb(admin, '?status=zzz')).status, 400);
  check('Bad payment_status', (await mb(admin, '?payment_status=zzz')).status, 400);
  check('Bad date', (await mb(admin, '?registered_from=2026-13-45')).status, 400);
  check('Bad sort', (await mb(admin, '?sort=zzz')).status, 400);
  check('Member token', (await mb(mem)).status, 403);
  check('No token', (await mb(null)).status, 401);
  csv = await mb(admin, '?format=csv');
  check('CSV: header plus 15 members', csvLines(csv.text).length, 16);
  check('CSV header has no contact columns', /email|phone/i.test(csvLines(csv.text)[0]), false);
  csv = await mb(chn, '?format=csv');
  check('Chennai CSV: header plus 5 members', csvLines(csv.text).length, 6);

  console.log('--- audit trail');
  const exportsAfter = await n("SELECT COUNT(*) FROM audit_logs WHERE action = 'report_exported'");
  check('Six CSV exports were audited', exportsAfter - exportsBefore, 6);
  await db.end();

  console.log(failures === 0 ? `\nAll ${total} checks passed` : `\n${failures} of ${total} checks FAILED`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error('Test failed to run:', err.message);
  process.exit(1);
});
