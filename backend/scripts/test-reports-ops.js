// Tests the payment, fine-payment, outstanding-fine and incident reports against independent SQL.
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

async function get(urlPath, token) {
  const headers = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(BASE + urlPath, { headers });
  const text = await res.text();
  let parsed = null;
  if ((res.headers.get('content-type') || '').includes('application/json')) {
    try { parsed = JSON.parse(text); } catch (e) { /* not json */ }
  }
  return { status: res.status, json: parsed, text, headers: res.headers };
}
async function post(urlPath, body) {
  const res = await fetch(BASE + urlPath, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  let json = null;
  try { json = await res.json(); } catch (e) { /* no body */ }
  return { status: res.status, json };
}
async function login(username, password) {
  const r = await post('/api/auth/login', { username, password });
  if (r.status !== 200) throw new Error(`Login failed for ${username} (${r.status})`);
  return r.json.token;
}
async function memberLogin(email, password) {
  const r = await post('/api/auth/member-login', { email, password });
  if (r.status !== 200) throw new Error(`Member login failed for ${email} (${r.status})`);
  return r.json.token;
}
const csvLines = (text) => text.replace(/^\uFEFF/, '').split('\r\n').filter((l) => l.length > 0);
const m2 = (x) => Number(x).toFixed(2);

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

  if ((await n('SELECT COUNT(*) FROM payment_requests')) !== 18 || (await n('SELECT COUNT(*) FROM fine_payments')) !== 4
      || (await n('SELECT COUNT(*) FROM loans')) !== 22 || (await n('SELECT COUNT(*) FROM incidents')) !== 3) {
    console.log('Expected the clean demo data (18 payments, 4 fine payments, 22 loans, 3 incidents). Run the restore commands first.');
    await db.end();
    process.exit(1);
  }
  const exportsBefore = await n("SELECT COUNT(*) FROM audit_logs WHERE action = 'report_exported'");
  const ESTIMATE = `LEAST(COALESCE(fine_cap_snapshot, 999999999),
      GREATEST(0, DATEDIFF(CURDATE(), due_date) - CAST(grace_days_snapshot AS SIGNED)) * fine_rate_snapshot)`;
  const FIN_BAL = `(CASE WHEN lf.waived = 1 THEN 0 ELSE lf.calculated_amount END
      - COALESCE((SELECT SUM(fp.amount) FROM fine_payments fp WHERE fp.loan_id = lf.loan_id AND fp.status = 'successful'), 0))`;
  let r;
  let csv;

  console.log('--- Membership payments');
  const pay = (token, qs = '') => get(`/api/reports/payments${qs}`, token);
  const payTotal = async (token, qs) => (await pay(token, qs)).json.total;
  r = await pay(admin);
  check('All requests match SQL', r.json.total, await n('SELECT COUNT(*) FROM payment_requests'));
  check('All requests (seed data)', r.json.total, 18);
  check('10 rows per page, 2 pages', `${r.json.data.length} / ${r.json.total_pages}`, '10 / 2');
  check('Successful', r.json.totals.successful, await n("SELECT COUNT(*) FROM payment_requests WHERE status = 'successful'"));
  check('Successful (seed data)', r.json.totals.successful, 14);
  check('Rejected', r.json.totals.rejected, 1);
  check('Pending + expired', r.json.totals.pending + r.json.totals.expired, 3);
  check('Successful amount matches SQL', r.json.totals.amount_successful, m2(await n("SELECT COALESCE(SUM(amount), 0) FROM payment_requests WHERE status = 'successful'")));
  check('Successful amount (seed data)', r.json.totals.amount_successful, '11800.00');
  check('Newest request first', r.json.data[0].request_id, 14);
  check('Has a generation time', typeof r.json.generated_at === 'string' && r.json.generated_at.length > 0, true);
  check('Status successful', await payTotal(admin, '?status=successful'), 14);
  check('Status rejected', await payTotal(admin, '?status=rejected'), 1);
  check('With proof / without proof', `${await payTotal(admin, '?proof=yes')} / ${await payTotal(admin, '?proof=no')}`, '2 / 16');
  check('Method cash / upi', `${await payTotal(admin, '?method=cash')} / ${await payTotal(admin, '?method=upi')}`, '3 / 10');
  check('Amount at least 1000', await payTotal(admin, '?min_amount=1000'), 6);
  check('Amount between 300 and 600', await payTotal(admin, '?min_amount=300&max_amount=600'), 6);
  check('Plan 3 (Annual)', await payTotal(admin, '?plan_id=3'), 6);
  check('Renewals / new', `${await payTotal(admin, '?request_type=renewal')} / ${await payTotal(admin, '?request_type=new')}`, '2 / 16');
  check('Member 14', await payTotal(admin, '?member_id=14'), 2);
  check('Member name karthik', await payTotal(admin, '?member_name=karthik'), 2);
  check('Payment ID 5', await payTotal(admin, '?payment_id=5'), 1);
  check('Transaction UPI-A1001', await payTotal(admin, '?txn=UPI-A1001'), 1);
  check('Requested since 2020', await payTotal(admin, '?requested_from=2020-01-01'), 18);
  check('Verified since 2020', await payTotal(admin, '?verified_from=2020-01-01'), 15);
  check('Verified before 2020', await payTotal(admin, '?verified_to=2020-01-01'), 0);
  check('Combined: successful UPI from 500', await payTotal(admin, '?status=successful&method=upi&min_amount=500'), 5);
  check('Sort by amount, highest first', (await pay(admin, '?sort=amount&dir=desc')).json.data[0].amount, '1500.00');
  const p1 = (await pay(admin, '?payment_id=1')).json.data[0];
  check('Payment 1: transactions are masked', `${p1.submitted_txn_masked} / ${p1.verification_txn_masked}`, '*****1001 / ***0001');
  check('Payment 1: proof flag and verifier', `${p1.has_proof} / ${p1.verified_by_name}`, 'true / Central Administrator');
  check('Raw transaction IDs and files are not in the report', /UPI-A1001|VT-0001|demo_proof|reference_no|proof_stored/.test(JSON.stringify(r.json) + JSON.stringify(p1)), false);
  check('Chennai staff', await payTotal(chn), 6);
  check('Chennai staff + branch_id=3 is ignored', await payTotal(chn, '?branch_id=3'), 6);
  check('Vellore staff', await payTotal(vel), 5);
  check('Admin branch 3', await payTotal(admin, '?branch_id=3'), 7);
  check('Bad status', (await pay(admin, '?status=zzz')).status, 400);
  check('Bad method', (await pay(admin, '?method=zzz')).status, 400);
  check('Bad proof', (await pay(admin, '?proof=maybe')).status, 400);
  check('Bad amount', (await pay(admin, '?min_amount=abc')).status, 400);
  check('Bad date', (await pay(admin, '?requested_from=2026-13-45')).status, 400);
  check('Bad sort', (await pay(admin, '?sort=zzz')).status, 400);
  check('Member token', (await pay(mem)).status, 403);
  check('No token', (await pay(null)).status, 401);
  csv = await pay(admin, '?format=csv');
  check('CSV: header plus 18 requests', csvLines(csv.text).length, 19);
  check('CSV has no raw transaction IDs', /UPI-A1001|VT-0001/.test(csv.text), false);
  csv = await pay(chn, '?format=csv');
  check('Chennai CSV: header plus 6 requests', csvLines(csv.text).length, 7);

  console.log('--- Fine payments (collection)');
  const fp = (token, qs = '') => get(`/api/reports/fine-payments${qs}`, token);
  const fpTotal = async (token, qs) => (await fp(token, qs)).json.total;
  r = await fp(admin);
  check('All fine payments', r.json.total, await n('SELECT COUNT(*) FROM fine_payments'));
  check('Collected matches SQL', r.json.totals.collected, m2(await n("SELECT COALESCE(SUM(amount), 0) FROM fine_payments WHERE status = 'successful'")));
  check('Collected / refunded (seed data)', `${r.json.totals.collected} / ${r.json.totals.refunded}`, '43.00 / 0.00');
  check('Successful / failed / refunded counts', `${r.json.totals.successful_count} / ${r.json.totals.failed_count} / ${r.json.totals.refunded_count}`, '3 / 1 / 0');
  check('Status failed', await fpTotal(admin, '?status=failed'), 1);
  check('Method cash / upi', `${await fpTotal(admin, '?method=cash')} / ${await fpTotal(admin, '?method=upi')}`, '2 / 2');
  check('Loan 5', await fpTotal(admin, '?loan_id=5'), 1);
  check('Amount at least 15', await fpTotal(admin, '?min_amount=15'), 2);
  check('Paid since 2020', await fpTotal(admin, '?paid_from=2020-01-01'), 4);
  check('Paid before 2020', await fpTotal(admin, '?paid_to=2020-01-01'), 0);
  const f2 = (await fp(admin, '?txn=UPI-FN-2001')).json.data[0];
  check('Reference is masked', `${f2.transaction_ref_masked} / ${f2.transaction_ref}`, '*******2001 / undefined');
  check('Raw reference is not in the report', JSON.stringify(r.json).includes('UPI-FN-2001'), false);
  check('Chennai staff', await fpTotal(chn), 2);
  check('Chennai staff + branch_id=2 is ignored', await fpTotal(chn, '?branch_id=2'), 2);
  check('Vellore staff', await fpTotal(vel), 2);
  check('Admin branch 3', await fpTotal(admin, '?branch_id=3'), 0);
  check('Bad status', (await fp(admin, '?status=zzz')).status, 400);
  check('Member token', (await fp(mem)).status, 403);
  check('No token', (await fp(null)).status, 401);
  csv = await fp(admin, '?format=csv');
  check('CSV: header plus 4 payments', csvLines(csv.text).length, 5);
  check('CSV has no raw reference', csv.text.includes('UPI-FN-2001'), false);
  csv = await fp(chn, '?format=csv');
  check('Chennai CSV: header plus 2 payments', csvLines(csv.text).length, 3);

  console.log('--- Outstanding fines');
  const fo = (token, qs = '') => get(`/api/reports/fines-outstanding${qs}`, token);
  const foTotal = async (token, qs) => (await fo(token, qs)).json.total;
  const finCount = (b) => n(`SELECT COUNT(*) FROM loan_fines lf JOIN loans l ON l.loan_id = lf.loan_id WHERE ${FIN_BAL} > 0 ${b ? `AND l.branch_id = ${b}` : ''}`);
  const estCount = (b) => n(`SELECT COUNT(*) FROM loans WHERE return_date IS NULL AND ${ESTIMATE} > 0 ${b ? `AND branch_id = ${b}` : ''}`);
  const finSum = await n(`SELECT COALESCE(SUM(${FIN_BAL}), 0) FROM loan_fines lf WHERE ${FIN_BAL} > 0`);
  const estSum = await n(`SELECT COALESCE(SUM(${ESTIMATE}), 0) FROM loans WHERE return_date IS NULL AND ${ESTIMATE} > 0`);
  r = await fo(admin);
  check('Rows = finalized unpaid + open estimates', r.json.total, (await finCount()) + (await estCount()));
  check('Finalized unpaid loans (seed data)', await finCount(), 3);
  check('Finalized balance (seed data)', r.json.totals.finalized_balance, '51.00');
  check('Finalized balance matches SQL', r.json.totals.finalized_balance, m2(finSum));
  check('Estimated balance matches SQL', r.json.totals.estimated_balance, m2(estSum));
  check('Total balance = finalized + estimated', r.json.totals.balance_total, m2(finSum + estSum));
  check('Kind finalized', await foTotal(admin, '?kind=finalized'), 3);
  check('Kind estimate', await foTotal(admin, '?kind=estimate'), await estCount());
  check('Member 4 (finalized loan 20 + open loan 21)', await foTotal(admin, '?member_id=4'), 2);
  check('Largest balance first (open loan 21)', r.json.data[0].loan_id, 21);
  check('Balance of 20 or more', await foTotal(admin, '?min_balance=20'), (await n(`SELECT COUNT(*) FROM loan_fines lf WHERE ${FIN_BAL} >= 20`)) + (await n(`SELECT COUNT(*) FROM loans WHERE return_date IS NULL AND ${ESTIMATE} >= 20`)));
  check('Chennai staff', await foTotal(chn), (await finCount(1)) + (await estCount(1)));
  check('Chennai staff + branch_id=3 is ignored', await foTotal(chn, '?branch_id=3'), (await finCount(1)) + (await estCount(1)));
  check('Admin branch 3', await foTotal(admin, '?branch_id=3'), (await finCount(3)) + (await estCount(3)));
  check('Every row has a positive balance', r.json.data.every((x) => Number(x.balance) > 0), true);
  check('Bad kind', (await fo(admin, '?kind=zzz')).status, 400);
  check('Bad balance', (await fo(admin, '?min_balance=abc')).status, 400);
  check('Member token', (await fo(mem)).status, 403);
  csv = await fo(admin, '?format=csv');
  check('CSV: header plus every row', csvLines(csv.text).length, r.json.total + 1);

  console.log('--- Incidents');
  const inc = (token, qs = '') => get(`/api/reports/incidents${qs}`, token);
  const incTotal = async (token, qs) => (await inc(token, qs)).json.total;
  const activeSql = await n(`SELECT COUNT(DISTINCT i.incident_id) FROM incidents i JOIN member_restrictions r ON r.incident_id = i.incident_id
    WHERE r.revoked_at IS NULL AND (r.kind = 'restriction' OR CURDATE() BETWEEN r.start_date AND r.end_date)`);
  r = await inc(admin);
  check('All incidents', r.json.total, 3);
  check('Damage / theft / awaiting review', `${r.json.totals.damage} / ${r.json.totals.theft_concealment} / ${r.json.totals.awaiting_review}`, '2 / 1 / 1');
  check('Active restrictions match SQL', r.json.totals.restriction_active, activeSql);
  check('Filter restriction=active matches SQL', await incTotal(admin, '?restriction=active'), activeSql);
  check('Filter restriction=none', await incTotal(admin, '?restriction=none'), 1);
  check('Filter restriction=lifted', await incTotal(admin, '?restriction=lifted'), 0);
  check('Type damage', await incTotal(admin, '?type=damage'), 2);
  check('Type theft_concealment', await incTotal(admin, '?type=theft_concealment'), 1);
  check('Status reported / decided / resolved', `${await incTotal(admin, '?status=reported')} / ${await incTotal(admin, '?status=decided')} / ${await incTotal(admin, '?status=resolved')}`, '1 / 1 / 1');
  check('Decision replace_and_suspend', await incTotal(admin, '?decision=replace_and_suspend'), 1);
  check('Decision permanent_restriction', await incTotal(admin, '?decision=permanent_restriction'), 1);
  check('Decision none (awaiting review)', await incTotal(admin, '?decision=none'), 1);
  check('Member 9', await incTotal(admin, '?member_id=9'), 1);
  check('Reported since 2020', await incTotal(admin, '?reported_from=2020-01-01'), 3);
  const i2 = (await inc(admin, '?type=theft_concealment')).json.data[0];
  check('Theft incident: reference, restriction', `${i2.incident_ref} / ${i2.restriction_kind} / ${i2.restriction_end} / ${i2.restriction_state}`, 'INC-2026-0002 / restriction / null / active');
  const i1 = (await inc(admin, '?member_id=9')).json.data[0];
  check('Damage incident: edition, ISBN, replacement', `${i1.book_edition} / ${i1.book_isbn} / ${i1.replacement_received}`, '1st / 978-81-90000-10-1 / false');
  check('Free-text descriptions and notes are not in the report', /Water damage|description|decision_notes|documented/.test(JSON.stringify(r.json)), false);
  check('Vellore staff sees all 3', await incTotal(vel), 3);
  check('Chennai staff sees none', await incTotal(chn), 0);
  check('Chennai staff + branch_id=2 is ignored', await incTotal(chn, '?branch_id=2'), 0);
  check('Bad type', (await inc(admin, '?type=zzz')).status, 400);
  check('Bad restriction', (await inc(admin, '?restriction=zzz')).status, 400);
  check('Bad sort', (await inc(admin, '?sort=zzz')).status, 400);
  check('Member token', (await inc(mem)).status, 403);
  check('No token', (await inc(null)).status, 401);
  csv = await inc(admin, '?format=csv');
  check('CSV: header plus 3 incidents', csvLines(csv.text).length, 4);
  check('CSV has no free-text notes', /Water damage|documented/.test(csv.text), false);
  csv = await inc(vel, '?format=csv');
  check('Vellore CSV: header plus 3 incidents', csvLines(csv.text).length, 4);

  console.log('--- audit trail');
  const exportsAfter = await n("SELECT COUNT(*) FROM audit_logs WHERE action = 'report_exported'");
  check('Seven CSV exports were audited', exportsAfter - exportsBefore, 7);
  await db.end();

  console.log(failures === 0 ? `\nAll ${total} checks passed` : `\n${failures} of ${total} checks FAILED`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error('Test failed to run:', err.message);
  process.exit(1);
});