// Tests the branch activity report and the member-wise history report (JSON, CSV, printable page, QR).
// Needs the server running, migration_002 applied, and the clean demo data.
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const mysql = require('mysql2/promise');
const { PNG } = require('pngjs');
const jsQR = require('jsqr');

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
const m2 = (x) => Number(x).toFixed(2);
function decodeQr(dataUrl) {
  const png = PNG.sync.read(Buffer.from(dataUrl.split(',')[1], 'base64'));
  const result = jsQR(new Uint8ClampedArray(png.data), png.width, png.height);
  return result ? result.data : null;
}

async function main() {
  const admin = await login('admin', 'Admin@2026');
  const chn = await login('staff_chennai', 'Chennai@2026');
  const vel = await login('staff_vellore', 'Vellore@2026');
  const cbe = await login('staff_coimbatore', 'Coimbatore@2026');
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
  const sv = async (sql, p = []) => {
    const [[row]] = await db.execute(sql, p);
    return Object.values(row)[0];
  };

  const [tbl] = await db.query("SHOW TABLES LIKE 'member_report_refs'");
  if (!tbl.length) {
    console.log('The member_report_refs table is missing. Run migration_002_report_refs.sql first.');
    await db.end();
    process.exit(1);
  }
  if ((await n('SELECT COUNT(*) FROM loans')) !== 22 || (await n('SELECT COUNT(*) FROM members')) !== 15
      || (await n('SELECT COUNT(*) FROM fine_payments')) !== 4 || (await n('SELECT COUNT(*) FROM incidents')) !== 3) {
    console.log('Expected the clean demo data (22 loans, 15 members, 4 fine payments, 3 incidents). Run the restore commands first.');
    await db.end();
    process.exit(1);
  }
  const today = await sv("SELECT DATE_FORMAT(CURDATE(), '%Y-%m-%d')");
  const exportsBefore = await n("SELECT COUNT(*) FROM audit_logs WHERE action = 'member_history_exported'");
  const ESTIMATE = `LEAST(COALESCE(fine_cap_snapshot, 999999999),
      GREATEST(0, DATEDIFF(CURDATE(), due_date) - CAST(grace_days_snapshot AS SIGNED)) * fine_rate_snapshot)`;
  const FIN_BAL = `(CASE WHEN lf.waived = 1 THEN 0 ELSE lf.calculated_amount END
      - COALESCE((SELECT SUM(fp.amount) FROM fine_payments fp WHERE fp.loan_id = lf.loan_id AND fp.status = 'successful'), 0))`;
  const outstandingSql = async (id) =>
    (await n(`SELECT COALESCE(SUM(${ESTIMATE}), 0) FROM loans WHERE member_id = ${id} AND return_date IS NULL`))
    + (await n(`SELECT COALESCE(SUM(GREATEST(${FIN_BAL}, 0)), 0) FROM loan_fines lf JOIN loans l ON l.loan_id = lf.loan_id WHERE l.member_id = ${id}`));
  let r;

  console.log('--- branch activity summary');
  const ba = (token, qs = '') => api('GET', `/api/reports/branch-activity${qs}`, token);
  const WIDE = `?from=2020-01-01&to=${today}`;
  r = await ba(admin, WIDE);
  const rows = r.json.data;
  const col = (k) => rows.map((x) => x[k]).join(' / ');
  check('Three branches in name order', rows.map((x) => x.branch_name).join(' | '), 'Central Branch - Chennai | North Branch - Vellore | South Branch - Coimbatore');
  check('Period is echoed back', `${r.json.period.from} to ${r.json.period.to}`, `2020-01-01 to ${today}`);
  check('Loans issued', col('loans_issued'), '9 / 7 / 6');
  check('Loans returned', col('loans_returned'), '4 / 3 / 1');
  check('Returned late', col('returned_late'), '3 / 2 / 0');
  check('Fines finalized', col('fines_finalized'), '67.00 / 27.00 / 0.00');
  check('Fines collected', col('fines_collected'), '28.00 / 15.00 / 0.00');
  check('New members', col('new_members'), '5 / 5 / 5');
  check('Payments verified', col('payments_verified'), '5 / 5 / 4');
  check('Payments verified (amount)', col('payments_verified_amount'), '4200.00 / 5200.00 / 2400.00');
  check('Incidents reported', col('incidents_reported'), '0 / 3 / 0');
  const perBranch = async (sql) => [1, 2, 3].map(async (b) => n(sql, [b]));
  check('Overdue now matches SQL', col('overdue_now'), (await Promise.all(await perBranch('SELECT COUNT(*) FROM loans WHERE branch_id = ? AND return_date IS NULL AND due_date < CURDATE()'))).join(' / '));
  check('Pending now matches SQL', col('payments_pending_now'), (await Promise.all(await perBranch("SELECT COUNT(*) FROM payment_requests WHERE branch_id = ? AND status = 'pending'"))).join(' / '));
  const t = r.json.totals;
  check('Totals: issued / returned / late', `${t.loans_issued} / ${t.loans_returned} / ${t.returned_late}`, '22 / 8 / 5');
  check('Totals: fines finalized / collected', `${t.fines_finalized} / ${t.fines_collected}`, '94.00 / 43.00');
  check('Totals: payments verified / amount / incidents', `${t.payments_verified} / ${t.payments_verified_amount} / ${t.incidents_reported}`, '14 / 11800.00 / 3');
  r = await ba(admin);
  check('Default period is the last 30 days', `${r.json.period.from} to ${r.json.period.to}`, `${await sv("SELECT DATE_FORMAT(DATE_ADD(CURDATE(), INTERVAL -29 DAY), '%Y-%m-%d')")} to ${today}`);
  check('Default-period loans issued matches SQL', r.json.totals.loans_issued, await n('SELECT COUNT(*) FROM loans WHERE issue_date BETWEEN DATE_ADD(CURDATE(), INTERVAL -29 DAY) AND CURDATE()'));
  r = await ba(admin, `?from=${today}&to=${today}`);
  const tt = r.json.totals;
  check('Today only: nothing issued, returned, registered, verified or reported', tt.loans_issued + tt.loans_returned + tt.new_members + tt.payments_verified + tt.incidents_reported, 0);
  check('Today only: no fines collected', tt.fines_collected, '0.00');
  r = await ba(chn);
  check('Chennai staff sees one branch', `${r.json.data.length} ${r.json.data[0].branch_name}`, '1 Central Branch - Chennai');
  check('Chennai staff + branch_id=3 is ignored', (await ba(chn, '?branch_id=3')).json.data[0].branch_name, 'Central Branch - Chennai');
  check('Vellore staff', (await ba(vel)).json.data[0].branch_name, 'North Branch - Vellore');
  r = await ba(admin, `${WIDE}&branch_id=3`);
  check('Admin branch 3', `${r.json.data.length} ${r.json.data[0].branch_name} ${r.json.data[0].loans_issued}`, '1 South Branch - Coimbatore 6');
  r = await ba(admin, `${WIDE}&page=2`);
  check('Page 2 is empty, total is 3', `${r.json.data.length} / ${r.json.total}`, '0 / 3');
  check('Bad from', (await ba(admin, '?from=abc')).status, 400);
  check('Bad to', (await ba(admin, '?to=2026-13-45')).status, 400);
  check('From after to', (await ba(admin, `?from=${today}&to=2020-01-01`)).status, 400);
  check('Period longer than 10 years', (await ba(admin, `?from=2000-01-01&to=${today}`)).status, 400);
  check('Bad format', (await ba(admin, '?format=xml')).status, 400);
  check('Member token', (await ba(mem)).status, 403);
  check('No token', (await ba(null)).status, 401);
  let csv = await ba(admin, `${WIDE}&format=csv`);
  check('CSV: header, 3 branches and a total row', csvLines(csv.text).length, 5);
  check('CSV has the total row', csv.text.includes('All branches (total)'), true);
  check('CSV file name carries the period', (csv.headers.get('content-disposition') || '').includes(`branch-activity-2020-01-01-to-${today}.csv`), true);
  csv = await ba(chn, `${WIDE}&format=csv`);
  check('Chennai CSV: header, 1 branch and a total row', csvLines(csv.text).length, 3);

  console.log('--- member history: contents and access');
  const hist = (token, id, qs = '') => api('GET', `/api/members/${id}/history${qs}`, token);
  r = await hist(cbe, 11);
  check('Coimbatore staff can open member 11', r.status, 200);
  check('Profile', `${r.json.member.full_name} / ${r.json.member.branch_name}`, 'Harish Babu / South Branch - Coimbatore');
  check('Status matches SQL', r.json.member.status, await sv('SELECT effective_status FROM v_member_status WHERE member_id = 11'));
  check('Section totals: payments / memberships / loans / restrictions', `${r.json.payments.total}/${r.json.memberships.total}/${r.json.loans.total}/${r.json.restrictions.total}`, '1/1/4/0');
  const p0 = r.json.payments.data[0];
  check('Transactions are masked', `${p0.submitted_txn_masked} / ${p0.verification_txn_masked}`, '*****2331 / ***0011');
  check('Raw transaction IDs and contact details are not present', /BT-902331|VT-0011|email|phone/.test(JSON.stringify(r.json)), false);
  check('Open overdue loan shows an estimate', r.json.loans.data.find((x) => x.loan_id === 14).fine_payment_status, 'estimate');
  check('Returned loan without a fine', r.json.loans.data.find((x) => x.loan_id === 18).fine_payment_status, 'no_fine');
  check('Summary: loans total / open', `${r.json.summary.loans_total} / ${r.json.summary.open_loans}`, '4 / 3');
  check('Summary: paid total', r.json.summary.payments_successful_total, '1500.00');
  check('Summary: outstanding fines match SQL', r.json.summary.fines_outstanding, m2(await outstandingSql(11)));
  check('Admin can open it too', (await hist(admin, 11)).status, 200);
  check('Chennai staff cannot', (await hist(chn, 11)).status, 403);
  check('Vellore staff cannot', (await hist(vel, 11)).status, 403);
  check('Member token', (await hist(mem, 11)).status, 403);
  check('No token', (await hist(null, 11)).status, 401);
  check('Member 9999', (await hist(admin, 9999)).status, 404);
  check('Member abc', (await hist(admin, 'abc')).status, 400);
  r = await hist(admin, 4);
  check('Member 4: payments / memberships / loans / restrictions', `${r.json.payments.total}/${r.json.memberships.total}/${r.json.loans.total}/${r.json.restrictions.total}`, '2/1/2/0');
  check('Member 4: outstanding fines match SQL', r.json.summary.fines_outstanding, m2(await outstandingSql(4)));
  check('Member 4: includes the successful payment', r.json.payments.data.some((x) => x.status === 'successful'), true);
  r = await hist(vel, 9);
  check('Member 9: suspension linked to its incident', `${r.json.restrictions.total} ${r.json.restrictions.data[0].kind} ${r.json.restrictions.data[0].incident_ref}`, '1 suspension INC-2026-0001');
  check('Member 9: active restrictions match SQL', r.json.summary.restrictions_active, await n("SELECT COUNT(*) FROM member_restrictions WHERE member_id = 9 AND revoked_at IS NULL AND (kind = 'restriction' OR CURDATE() BETWEEN start_date AND end_date)"));
  r = await hist(admin, 10);
  const rr = r.json.restrictions.data[0];
  check('Member 10: permanent restriction', `${rr.kind} / ${rr.end_date} / ${rr.state}`, 'restriction / null / active');
  check('Bad loans_page', (await hist(admin, 4, '?loans_page=abc')).status, 400);
  check('loans_page=0', (await hist(admin, 4, '?loans_page=0')).status, 400);
  r = await hist(admin, 4, '?loans_page=99');
  check('Page beyond the end is empty, total unchanged', `${r.json.loans.data.length} / ${r.json.loans.total} / ${r.json.loans.page}`, '0 / 2 / 99');
  check('Bad format', (await hist(admin, 4, '?format=xml')).status, 400);

  console.log('--- member history: CSV, printable page and QR');
  csv = await hist(chn, 4, '?format=csv');
  check('CSV status and type', `${csv.status} ${(csv.headers.get('content-type') || '').split(';')[0]}`, '200 text/csv');
  check('CSV file name', /attachment; filename="member-4-history-\d{8}-\d{6}\.csv"/.test(csv.headers.get('content-disposition') || ''), true);
  check('CSV has the member and all four sections', ['Member', 'Membership payments', 'Memberships and renewals', 'Borrowing history', 'Suspensions and restrictions'].every((s) => csv.text.includes(s)), true);
  check('CSV names the member', csv.text.includes('Karthik Subramanian'), true);
  check('CSV has no raw transaction IDs', /NB-77120|UPI-A1005/.test(csv.text), false);
  const csvRef = (csv.text.match(/Report reference,([0-9A-F]{24})/) || [])[1];
  check('CSV carries a report reference', typeof csvRef === 'string', true);
  const pr = await api('GET', '/api/members/4/history/print', chn);
  check('Printable page status and type', `${pr.status} ${(pr.headers.get('content-type') || '').split(';')[0]}`, '200 text/html');
  check('Content security policy is set', (pr.headers.get('content-security-policy') || '').includes("default-src 'none'"), true);
  check('Page shows the member and the sections', pr.text.includes('Karthik Subramanian') && pr.text.includes('Membership payments') && pr.text.includes('Borrowing history'), true);
  check('Page has no scripts', /<script/i.test(pr.text), false);
  const printRef = (pr.text.match(/Report reference:\s*<strong>([0-9A-F]{24})<\/strong>/) || [])[1];
  const qrUrl = (pr.text.match(/src="(data:image\/png;base64,[^"]+)"/) || [])[1];
  check('Page shows a report reference', typeof printRef === 'string', true);
  check('Every report gets its own reference', printRef !== csvRef, true);
  const scanned = qrUrl ? decodeQr(qrUrl) : null;
  check('Scanned QR equals the printed reference', scanned, printRef);
  check('QR holds only 24 characters and no member data', scanned ? scanned.length === 24 && !scanned.includes('Karthik') : false, true);
  check('Other branch staff cannot print', (await api('GET', '/api/members/4/history/print', vel)).status, 403);
  check('Member token cannot print', (await api('GET', '/api/members/4/history/print', mem)).status, 403);
  check('No token cannot print', (await api('GET', '/api/members/4/history/print', null)).status, 401);
  r = await api('GET', `/api/member-history/ref/${printRef}`, chn);
  check('Own branch staff resolves the reference', `${r.status} member ${r.json && r.json.reference.member_id}`, '200 member 4');
  check('Lowercase reference works', (await api('GET', `/api/member-history/ref/${printRef.toLowerCase()}`, admin)).status, 200);
  check('History path is returned', r.json.history_path, '/api/members/4/history');
  check('Other branch staff cannot resolve it', (await api('GET', `/api/member-history/ref/${printRef}`, vel)).status, 403);
  check('Member token cannot resolve it', (await api('GET', `/api/member-history/ref/${printRef}`, mem)).status, 403);
  check('No token cannot resolve it', (await api('GET', `/api/member-history/ref/${printRef}`, null)).status, 401);
  check('Invalid reference format', (await api('GET', '/api/member-history/ref/xyz', admin)).status, 400);
  check('Unknown reference', (await api('GET', '/api/member-history/ref/000000000000000000000000', admin)).status, 404);

  console.log('--- printable page escapes everything');
  const tm = await api('POST', '/api/members', chn, { full_name: '<b>Html Test</b>', email: 'html.test@example.com', phone: '+919840099777' });
  check('Setup: member whose name contains HTML', tm.status, 201);
  const tmId = tm.json.member.member_id;
  const hp = await api('GET', `/api/members/${tmId}/history/print`, chn);
  check('Name is escaped on the page', hp.text.includes('&lt;b&gt;Html Test&lt;/b&gt;') && !hp.text.includes('<b>Html Test</b>'), true);
  check('Cleanup: delete the test member (references cascade)', (await api('DELETE', `/api/members/${tmId}`, chn)).status, 200);
  check('No references left for the deleted member', await n('SELECT COUNT(*) FROM member_report_refs WHERE member_id = ?', [tmId]), 0);

  console.log('--- audit trail');
  check('Member 4 has at least two stored report references', (await n('SELECT COUNT(*) FROM member_report_refs WHERE member_id = 4')) >= 2, true);
  check('Three history exports were audited', (await n("SELECT COUNT(*) FROM audit_logs WHERE action = 'member_history_exported'")) - exportsBefore, 3);
  await db.end();

  console.log(failures === 0 ? `\nAll ${total} checks passed` : `\n${failures} of ${total} checks FAILED`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error('Test failed to run:', err.message);
  process.exit(1);
});