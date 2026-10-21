// Tests fine payments, refunds, waivers and access rules.
// Needs the server running and the clean demo data (22 loans, 4 fine payments).
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

  const db = await mysql.createConnection({
    host: process.env.DB_HOST || 'localhost',
    port: Number(process.env.DB_PORT || 3306),
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASSWORD || '',
    database: process.env.DB_NAME || 'libratrack',
  });
  await db.query("SET time_zone = '+05:30'");

  const [[c0]] = await db.execute('SELECT (SELECT COUNT(*) FROM loans) AS loans, (SELECT COUNT(*) FROM fine_payments) AS fps');
  if (Number(c0.loans) !== 22 || Number(c0.fps) !== 4) {
    console.log(`Expected the clean demo data (22 loans, 4 fine payments) but found ${c0.loans} and ${c0.fps}. Run the clean-up command first.`);
    await db.end();
    process.exit(1);
  }

  async function insertLoan({ member, branch, book, dueOffset, rate, issuedBy }) {
    const [ins] = await db.execute(
      `INSERT INTO loans (member_id, branch_id, book_id, issue_date, due_date, fine_rate_snapshot,
                          grace_days_snapshot, fine_cap_snapshot, issued_by)
       VALUES (?, ?, ?, DATE_ADD(CURDATE(), INTERVAL ? DAY), DATE_ADD(CURDATE(), INTERVAL ? DAY), ?, 0, NULL, ?)`,
      [member, branch, book, dueOffset - 14, dueOffset, rate, issuedBy]
    );
    return ins.insertId;
  }
  const fineOf = async (token, id) => (await api('GET', `/api/loans/${id}/fine`, token)).json;
  const pay = (token, id, body) => api('POST', `/api/loans/${id}/fine-payments`, token, body);
  const line = (f) => `${f.total_fine} / ${f.amount_paid} / ${f.balance} / ${f.payment_status}`;
  let r;

  console.log('--- seeded fines (read only): total / paid / balance / status');
  check('Loan 5: partly paid', line((await fineOf(chn, 5)).fine), '25.00 / 10.00 / 15.00 / partial');
  check('Loan 6: fully paid', line((await fineOf(chn, 6)).fine), '18.00 / 18.00 / 0.00 / paid');
  const f10 = await fineOf(admin, 10);
  check('Loan 10: failed payment does not count', line(f10.fine), '12.00 / 0.00 / 12.00 / unpaid');
  check('Loan 10: the failed attempt is listed', f10.payments.some((p) => p.status === 'failed'), true);
  check('Loan 20: uses the loan rate (4.00 x 6)', line((await fineOf(chn, 20)).fine), '24.00 / 0.00 / 24.00 / unpaid');
  check('Loan 4: no fine', (await fineOf(chn, 4)).fine.payment_status, 'no_fine');
  const f1 = await fineOf(chn, 1);
  check('Loan 1 (still open): live estimate only', `${f1.fine.payment_status}, can_accept_payment=${f1.fine.can_accept_payment}`, 'estimate, can_accept_payment=false');
  r = await pay(chn, 1, { amount: 5, method: 'cash' });
  check('Payment on an open loan refused', r.status === 409 && errText(r).includes('not final'), true);
  check('Chennai staff cannot read a Vellore fine', (await api('GET', '/api/loans/10/fine', chn)).status, 403);

  console.log('--- partial payments, overpayment and failed attempts (loan A, fine 20.00)');
  const A = await insertLoan({ member: 1, branch: 1, book: 10, dueOffset: -4, rate: '5.00', issuedBy: 2 });
  r = await api('POST', `/api/loans/${A}/return`, chn);
  check('Setup: loan A returned with a fine of 20.00', `${r.status} ${r.json.loan.fine_amount}`, '200 20.00');
  check('No token', (await pay(null, A, { amount: 5, method: 'cash' })).status, 401);
  check('Member token', (await pay(mem, A, { amount: 5, method: 'cash' })).status, 403);
  check('Other branch staff', (await pay(vel, A, { amount: 5, method: 'cash' })).status, 403);
  check('Loan 9999', (await pay(admin, 9999, { amount: 5, method: 'cash' })).status, 404);
  check('Loan abc', (await pay(admin, 'abc', { amount: 5, method: 'cash' })).status, 400);
  check('Amount 0', (await pay(chn, A, { amount: 0, method: 'cash' })).status, 400);
  check('Negative amount', (await pay(chn, A, { amount: -5, method: 'cash' })).status, 400);
  check('Text amount', (await pay(chn, A, { amount: 'abc', method: 'cash' })).status, 400);
  check('Three decimals', (await pay(chn, A, { amount: '10.123', method: 'cash' })).status, 400);
  check('Unknown method', (await pay(chn, A, { amount: 5, method: 'bitcoin' })).status, 400);
  check('Cannot create a refunded record', (await pay(chn, A, { amount: 5, method: 'cash', status: 'refunded' })).status, 400);
  check('UPI without a reference', (await pay(chn, A, { amount: 5, method: 'upi' })).status, 400);
  check('Reference too short', (await pay(chn, A, { amount: 5, method: 'upi', transaction_ref: 'x' })).status, 400);
  r = await pay(chn, A, { amount: 25, method: 'cash' });
  check('Overpayment refused with the balance shown', r.status === 409 && errText(r).includes('Overpayment') && errText(r).includes('20.00'), true);
  r = await pay(chn, A, { amount: 5, method: 'cash' });
  check('Partial cash payment 5.00', `${r.status} ${line(r.json.fine)}`, '201 20.00 / 5.00 / 15.00 / partial');
  r = await pay(chn, A, { amount: '10.00', method: 'upi', transaction_ref: 'FINE-UPI-7788' });
  const upiPaymentId = r.json.payment.fine_payment_id;
  check('UPI payment 10.00', `${r.status} ${line(r.json.fine)}`, '201 20.00 / 15.00 / 5.00 / partial');
  r = await pay(chn, A, { amount: 1, method: 'upi', transaction_ref: 'FINE-UPI-7788' });
  check('Reused reference refused', r.status === 409 && errText(r).includes('already used'), true);
  r = await pay(chn, A, { amount: 5, method: 'cash' });
  check('Final 5.00 completes the payment', `${r.status} ${line(r.json.fine)}`, '201 20.00 / 20.00 / 0.00 / paid');
  r = await pay(chn, A, { amount: 1, method: 'cash' });
  check('Payment on a fully paid fine refused', r.status === 409 && errText(r).includes('fully paid'), true);
  r = await pay(chn, A, { amount: 5, method: 'upi', transaction_ref: 'FINE-UPI-0001', status: 'failed' });
  check('Failed attempt recorded, balance unchanged', `${r.status} ${line(r.json.fine)}`, '201 20.00 / 20.00 / 0.00 / paid');
  const hist = await fineOf(chn, A);
  check('History lists all 4 records', hist.payments.length, 4);
  check('Reference is masked', hist.payments.some((p) => p.transaction_ref_masked === '********7788'), true);
  check('Raw reference is never returned', JSON.stringify(hist).includes('FINE-UPI-7788'), false);

  console.log('--- refunds');
  const failedId = hist.payments.find((p) => p.status === 'failed').fine_payment_id;
  check('Staff cannot refund', (await api('POST', `/api/fine-payments/${upiPaymentId}/refund`, chn, { reason: 'Duplicate charge' })).status, 403);
  check('Refund without a reason', (await api('POST', `/api/fine-payments/${upiPaymentId}/refund`, admin, {})).status, 400);
  check('Unknown payment', (await api('POST', '/api/fine-payments/99999/refund', admin, { reason: 'Duplicate charge' })).status, 404);
  check('A failed payment cannot be refunded', (await api('POST', `/api/fine-payments/${failedId}/refund`, admin, { reason: 'Duplicate charge' })).status, 409);
  r = await api('POST', `/api/fine-payments/${upiPaymentId}/refund`, admin, { reason: 'Duplicate charge' });
  check('Admin refunds the UPI payment', `${r.status} ${line(r.json.fine)}`, '200 20.00 / 10.00 / 10.00 / partial');
  check('Refunding twice refused', (await api('POST', `/api/fine-payments/${upiPaymentId}/refund`, admin, { reason: 'Duplicate charge' })).status, 409);
  r = await pay(chn, A, { amount: 10, method: 'cash' });
  check('Remaining 10.00 paid after the refund', `${r.status} ${line(r.json.fine)}`, '201 20.00 / 20.00 / 0.00 / paid');

  console.log('--- waiving a fine (loan B, fine 15.00)');
  const B = await insertLoan({ member: 5, branch: 1, book: 10, dueOffset: -3, rate: '5.00', issuedBy: 2 });
  r = await api('POST', `/api/loans/${B}/return`, chn);
  check('Setup: loan B returned with a fine of 15.00', `${r.status} ${r.json.loan.fine_amount}`, '200 15.00');
  check('Staff cannot waive', (await api('PATCH', `/api/loans/${B}/fine`, chn, { waived: true, reason: 'Library error' })).status, 403);
  check('Waive without a reason', (await api('PATCH', `/api/loans/${B}/fine`, admin, { waived: true })).status, 400);
  check('Waive with a bad body', (await api('PATCH', `/api/loans/${B}/fine`, admin, {})).status, 400);
  r = await api('PATCH', `/api/loans/${B}/fine`, admin, { waived: true, reason: 'Library error' });
  check('Admin waives', `${r.status} ${line(r.json.fine)}`, '200 0.00 / 0.00 / 0.00 / waived');
  check('Original fine is preserved', r.json.fine.calculated_fine, '15.00');
  r = await pay(chn, B, { amount: 5, method: 'cash' });
  check('Payment on a waived fine refused', r.status === 409 && errText(r).includes('waived'), true);
  check('Waiving twice refused', (await api('PATCH', `/api/loans/${B}/fine`, admin, { waived: true, reason: 'Library error' })).status, 409);
  r = await api('PATCH', `/api/loans/${B}/fine`, admin, { waived: false, reason: 'Waived by mistake' });
  check('Admin restores the fine', `${r.status} ${line(r.json.fine)}`, '200 15.00 / 0.00 / 15.00 / unpaid');
  check('Cash 5.00 after restoring', (await pay(chn, B, { amount: 5, method: 'cash' })).status, 201);
  r = await api('PATCH', `/api/loans/${B}/fine`, admin, { waived: true, reason: 'Library error' });
  check('Cannot waive a part-paid fine', r.status === 409 && errText(r).includes('Refund'), true);

  console.log('--- loans with no fine to pay (loan C) and an open loan (loan D)');
  const C = await insertLoan({ member: 5, branch: 1, book: 8, dueOffset: 5, rate: '5.00', issuedBy: 2 });
  await api('POST', `/api/loans/${C}/return`, chn);
  r = await pay(chn, C, { amount: 5, method: 'cash' });
  check('Payment when the fine is 0 refused', r.status === 409 && errText(r).includes('no fine'), true);
  check('Waiving a 0 fine refused', (await api('PATCH', `/api/loans/${C}/fine`, admin, { waived: true, reason: 'Not needed' })).status, 409);
  const D = await insertLoan({ member: 5, branch: 1, book: 19, dueOffset: -2, rate: '5.00', issuedBy: 2 });
  check('Open overdue loan shows an estimate', (await fineOf(chn, D)).fine.payment_status, 'estimate');
  r = await pay(chn, D, { amount: 5, method: 'cash' });
  check('Payment on the open loan refused', r.status === 409 && errText(r).includes('not final'), true);
  check('Waiving an open loan refused', (await api('PATCH', `/api/loans/${D}/fine`, admin, { waived: true, reason: 'Not needed' })).status, 404);

  console.log('--- six simultaneous payments of 10.00 on a fine of 20.00 (loan E)');
  const E = await insertLoan({ member: 5, branch: 1, book: 10, dueOffset: -4, rate: '5.00', issuedBy: 2 });
  await api('POST', `/api/loans/${E}/return`, chn);
  const results = await Promise.all([1, 2, 3, 4, 5, 6].map(() => pay(chn, E, { amount: 10, method: 'cash' })));
  const tally = {};
  for (const x of results) tally[x.status] = (tally[x.status] || 0) + 1;
  console.log(`     responses: ${Object.entries(tally).map(([s, n]) => `${s} x${n}`).join(', ')}`);
  check('Exactly two payments accepted', tally[201] || 0, 2);
  check('The other four refused', tally[409] || 0, 4);
  check('Fine is exactly paid, never over', line((await fineOf(chn, E)).fine), '20.00 / 20.00 / 0.00 / paid');
  const [[sumE]] = await db.execute("SELECT SUM(amount) AS s FROM fine_payments WHERE loan_id = ? AND status = 'successful'", [E]);
  check('Database total for loan E', sumE.s, '20.00');

  console.log('--- cross-branch (loan V at Vellore, fine 4.00) and the member view');
  const V = await insertLoan({ member: 7, branch: 2, book: 10, dueOffset: -2, rate: '2.00', issuedBy: 3 });
  r = await api('POST', `/api/loans/${V}/return`, admin);
  check('Setup: Vellore loan returned with a fine of 4.00', `${r.status} ${r.json.loan.fine_amount}`, '200 4.00');
  check('Chennai staff cannot pay a Vellore fine', (await pay(chn, V, { amount: 2, method: 'cash' })).status, 403);
  check('Vellore staff records 2.00', (await pay(vel, V, { amount: 2, method: 'cash' })).status, 201);
  r = await pay(admin, V, { amount: 2, method: 'cash' });
  check('Admin records the remaining 2.00', `${r.status} ${line(r.json.fine)}`, '201 4.00 / 4.00 / 0.00 / paid');
  const who = (await fineOf(admin, V)).payments.map((p) => p.recorded_by_name).sort().join(' + ');
  check('Each payment shows who recorded it', who, 'Central Administrator + Vellore Branch Staff');
  const mine = await api('GET', '/api/me/loans?status=returned', mem);
  const row = mine.json.data.find((l) => l.loan_id === A);
  check('Ananya sees her paid fine on loan A', row ? `${row.fine_paid} / ${row.fine_balance}` : null, '20.00 / 0.00');

  console.log('--- database checks');
  const [[over]] = await db.execute('SELECT COUNT(*) AS n FROM v_loan_details WHERE fine_paid > fine_amount');
  check('No loan has been paid more than its fine', Number(over.n), 0);
  const [[a1]] = await db.execute("SELECT COUNT(*) AS n FROM audit_logs WHERE action = 'fine_payment_recorded'");
  check('Audit rows for recorded payments', Number(a1.n) >= 10, true);
  const [[a2]] = await db.execute("SELECT COUNT(*) AS n FROM audit_logs WHERE action IN ('fine_payment_refunded', 'fine_waived', 'fine_waiver_removed')");
  check('Audit rows for refund and waiver actions', Number(a2.n) >= 3, true);
  await db.end();

  console.log(failures === 0 ? `\nAll ${total} checks passed` : `\n${failures} of ${total} checks FAILED`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error('Test failed to run:', err.message);
  process.exit(1);
});

