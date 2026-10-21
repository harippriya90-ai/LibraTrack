// Tests settings, branch management and the audit-log viewer. Restores everything it changes.
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
  const mem = await memberLogin('ananya.krishnan@example.com', 'Ananya@2026');

  const db = await mysql.createConnection({
    host: process.env.DB_HOST || 'localhost',
    port: Number(process.env.DB_PORT || 3306),
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASSWORD || '',
    database: process.env.DB_NAME || 'libratrack',
  });
  await db.query("SET time_zone = '+05:30'");
  const sv = async (sql, p = []) => {
    const [[row]] = await db.execute(sql, p);
    return Object.values(row)[0];
  };
  const n = async (sql, p = []) => Number(await sv(sql, p));
  const counts = async () => [
    await n('SELECT COUNT(*) FROM branches'), await n('SELECT COUNT(*) FROM users'), await n('SELECT COUNT(*) FROM loans'),
    await n('SELECT COUNT(*) FROM payment_requests'), await n('SELECT COUNT(*) FROM memberships'), await n('SELECT COUNT(*) FROM members'),
  ].join('/');

  if ((await counts()) !== '3/4/22/18/14/15') {
    console.log(`Expected the clean demo data (branches/users/loans/payments/memberships/members = 3/4/22/18/14/15) but found ${await counts()}. Run the restore commands first.`);
    await db.end();
    process.exit(1);
  }

  const KEYS = ['library_name', 'default_fine_per_day', 'grace_days', 'fine_cap', 'payment_expiry_days',
    'suspension_days_damage', 'default_loan_days', 'allow_self_verification'];
  const ORIGINAL = {};
  for (const k of KEYS) {
    const [rows] = await db.execute('SELECT setting_value FROM system_settings WHERE setting_key = ?', [k]);
    ORIGINAL[k] = rows[0] ? rows[0].setting_value : undefined;
  }
  const created = { payments: [], branch: null, staff: null, member: null };
  const settingChangesBefore = await n("SELECT COUNT(*) FROM audit_logs WHERE action = 'setting_changed'");
  const setVal = (k) => sv('SELECT setting_value FROM system_settings WHERE setting_key = ?', [k]);
  const patch = (token, body) => api('PATCH', '/api/settings', token, body);
  let r;

  async function runTests() {
    console.log('--- settings: reading');
    r = await api('GET', '/api/settings', admin);
    const by = Object.fromEntries(r.json.data.map((x) => [x.key, x]));
    check('Nine settings are listed', r.json.data.length, 9);
    check('Admin can edit eight of them', r.json.data.filter((x) => x.editable).length, 8);
    check('Timezone is read-only', by.timezone.editable, false);
    check('Values match the database', KEYS.slice(0, 7).every((k) => by[k].value === ORIGINAL[k]), true);
    check('Self-review switch is off by default', by.allow_self_verification.value, ORIGINAL.allow_self_verification === undefined ? '0' : ORIGINAL.allow_self_verification);
    check('Every setting explains its effect', r.json.data.every((x) => typeof x.note === 'string' && x.note.length > 0), true);
    r = await api('GET', '/api/settings', chn);
    check('Staff can read the settings', r.status, 200);
    check('Staff cannot edit any of them', r.json.data.some((x) => x.editable), false);
    check('Member token', (await api('GET', '/api/settings', mem)).status, 403);
    check('No token', (await api('GET', '/api/settings', null)).status, 401);

    console.log('--- settings: who may change them, and validation');
    check('Staff cannot change settings', (await patch(chn, { grace_days: 1 })).status, 403);
    check('No token', (await patch(null, { grace_days: 1 })).status, 401);
    check('Empty body', (await patch(admin, {})).status, 400);
    check('Unknown setting', (await patch(admin, { colour: 'red' })).status, 400);
    check('Prototype-style key', (await patch(admin, { constructor: 'x' })).status, 400);
    check('Timezone is read-only', (await patch(admin, { timezone: 'UTC' })).status, 409);
    check('grace_days 31', (await patch(admin, { grace_days: 31 })).status, 400);
    check('grace_days -1', (await patch(admin, { grace_days: -1 })).status, 400);
    check('grace_days text', (await patch(admin, { grace_days: 'abc' })).status, 400);
    check('fine_cap text', (await patch(admin, { fine_cap: 'abc' })).status, 400);
    check('fine_cap 0', (await patch(admin, { fine_cap: 0 })).status, 400);
    check('payment_expiry_days 0', (await patch(admin, { payment_expiry_days: 0 })).status, 400);
    check('payment_expiry_days 366', (await patch(admin, { payment_expiry_days: 366 })).status, 400);
    check('suspension_days_damage text', (await patch(admin, { suspension_days_damage: 'x' })).status, 400);
    check('default_loan_days 121', (await patch(admin, { default_loan_days: 121 })).status, 400);
    check('library_name too short', (await patch(admin, { library_name: 'x' })).status, 400);
    check('Rate with three decimals', (await patch(admin, { default_fine_per_day: '1.234' })).status, 400);
    check('Flag with a bad value', (await patch(admin, { allow_self_verification: 'maybe' })).status, 400);
    check('A bad value in a batch rejects the batch', (await patch(admin, { grace_days: 3, fine_cap: 'abc' })).status, 400);
    check('...and nothing in it was applied', await setVal('grace_days'), ORIGINAL.grace_days);

    console.log('--- settings: changing them');
    r = await patch(admin, { grace_days: 2, fine_cap: '30', library_name: 'LibraTrack Test Library' });
    check('Admin changes three settings at once', `${r.status} ${r.json.changed.length}`, '200 3');
    check('Stored values (cap kept to 2 decimals)', `${await setVal('grace_days')} / ${await setVal('fine_cap')} / ${await setVal('library_name')}`, '2 / 30.00 / LibraTrack Test Library');
    check('Who changed it is recorded', Number(await sv("SELECT updated_by FROM system_settings WHERE setting_key = 'grace_days'")), 1);
    r = await patch(admin, { grace_days: 2 });
    check('Sending an unchanged value changes nothing', `${r.status} ${r.json.changed.length}`, '200 0');

    console.log('--- settings take effect on new records only');
    const iss = await api('POST', '/api/loans', chn, { member_id: 5, book_id: 3 });
    check('New loan copies the grace days and the cap', `${iss.status} ${iss.json.loan.grace_days} ${iss.json.loan.fine_cap}`, '201 2 30.00');
    const old1 = await api('GET', '/api/loans/1', admin);
    check('An existing loan keeps its own values', `${old1.json.loan.grace_days} ${old1.json.loan.fine_cap}`, '0 null');
    check('Payment expiry set to 3 days', (await patch(admin, { payment_expiry_days: 3 })).status, 200);
    const pq = await api('POST', '/api/payments', chn, { member_id: 2, plan_id: 2, method: 'upi' });
    if (pq.status === 201) created.payments.push(pq.json.payment.request_id);
    const days = pq.status === 201
      ? Math.round((new Date(pq.json.payment.expires_at.replace(' ', 'T')) - new Date(pq.json.payment.requested_at.replace(' ', 'T'))) / 86400000) : -1;
    check('A new payment request expires after the new setting', `${pq.status} ${days}`, '201 3');
    check('Default fine rate set to 7.5', (await patch(admin, { default_fine_per_day: '7.5' })).status, 200);
    const nb = await api('POST', '/api/books', admin, { title: 'Setting Test Book', author: 'Test Author', category: 'Testing', price: 10 });
    check('A new book gets the new default fine rate', `${nb.status} ${nb.json.book.fine_per_day}`, '201 7.50');
    check('Delete the test book', (await api('DELETE', `/api/books/${nb.json.book.book_id}`, admin)).status, 200);

    console.log('--- settings: the self-review switch');
    const sr = await api('POST', '/api/payments', admin, { member_id: 15, plan_id: 1, method: 'cash' });
    const selfId = sr.json.payment.request_id;
    created.payments.push(selfId);
    const verify = () => api('POST', `/api/payments/${selfId}/verify`, admin, { verification_txn_id: 'SET-TEST-0001' });
    check('Off: an administrator cannot verify their own request', (await verify()).status, 403);
    check('Admin switches self-review on', (await patch(admin, { allow_self_verification: true })).status, 200);
    check('On: the same request can now be verified', (await verify()).status, 200);
    check('Admin switches it off again', (await patch(admin, { allow_self_verification: false })).status, 200);

    console.log('--- settings: restoring the originals');
    r = await patch(admin, {
      library_name: ORIGINAL.library_name, default_fine_per_day: ORIGINAL.default_fine_per_day, grace_days: ORIGINAL.grace_days,
      fine_cap: ORIGINAL.fine_cap, payment_expiry_days: ORIGINAL.payment_expiry_days,
      suspension_days_damage: ORIGINAL.suspension_days_damage, default_loan_days: ORIGINAL.default_loan_days,
    });
    check('Restore request accepted', r.status, 200);
    let same = true;
    for (const k of KEYS.slice(0, 7)) if ((await setVal(k)) !== ORIGINAL[k]) same = false;
    check('Every setting is back to its original value', same, true);
    check('Setting changes were audited', (await n("SELECT COUNT(*) FROM audit_logs WHERE action = 'setting_changed'")) - settingChangesBefore, 12);

    console.log('--- branches: reading');
    check('The list shows the three branches', (await api('GET', '/api/branches', admin)).json.data.length, 3);
    check('Staff cannot list branches', (await api('GET', '/api/branches', chn)).status, 403);
    r = await api('GET', '/api/branches/1', admin);
    const s = r.json.stats;
    check('Branch 1', `${r.json.branch.name} / ${r.json.branch.is_active}`, 'Central Branch - Chennai / true');
    check('Members / active members', `${s.members} / ${s.active_members}`, '5 / 5');
    check('Titles / copies / available', `${s.book_titles} / ${s.physical_copies} / ${s.available_copies}`, '13 / 30 / 24');
    check('Open and overdue loans match SQL', `${s.open_loans} / ${s.overdue_loans}`, `${await n('SELECT COUNT(*) FROM loans WHERE branch_id = 1 AND return_date IS NULL AND due_date < CURDATE()') >= 0 ? await n('SELECT COUNT(*) FROM loans WHERE branch_id = 1 AND return_date IS NULL') : 0} / ${await n('SELECT COUNT(*) FROM loans WHERE branch_id = 1 AND return_date IS NULL AND due_date < CURDATE()')}`);
    check('Payments successful / amount', `${s.payments_successful} / ${s.payments_successful_amount}`, '5 / 4200.00');
    check('Pending payments match SQL', s.payments_pending, await n("SELECT COUNT(*) FROM payment_requests WHERE branch_id = 1 AND status = 'pending'"));
    check('Assigned staff', r.json.staff.map((x) => x.username).join(','), 'staff_chennai');
    check('Vellore has one incident awaiting review', (await api('GET', '/api/branches/2', admin)).json.stats.incidents_awaiting_review, 1);
    check('Staff cannot open branch details', (await api('GET', '/api/branches/1', chn)).status, 403);
    check('Unknown branch', (await api('GET', '/api/branches/9999', admin)).status, 404);
    check('Branch abc', (await api('GET', '/api/branches/abc', admin)).status, 400);

    console.log('--- branches: create and edit');
    const bodyB = { name: 'Test Branch', address: '1 Test Street, Test City', phone: '+91 44 5555 1234', email: 'TEST.Branch@Example.com' };
    check('Staff cannot create a branch', (await api('POST', '/api/branches', chn, bodyB)).status, 403);
    check('Missing name', (await api('POST', '/api/branches', admin, { address: bodyB.address })).status, 400);
    check('Address too short', (await api('POST', '/api/branches', admin, { ...bodyB, address: 'x' })).status, 400);
    check('Bad phone', (await api('POST', '/api/branches', admin, { ...bodyB, phone: '123' })).status, 400);
    check('Bad email', (await api('POST', '/api/branches', admin, { ...bodyB, email: 'abc' })).status, 400);
    const cb = await api('POST', '/api/branches', admin, bodyB);
    check('Admin creates a branch', `${cb.status} ${cb.json.branch.is_active}`, '201 true');
    const tb = cb.json.branch.branch_id;
    created.branch = tb;
    check('Phone and email are normalized', `${cb.json.branch.phone} / ${cb.json.branch.email}`, '+914455551234 / test.branch@example.com');
    check('Duplicate name in any letter case', (await api('POST', '/api/branches', admin, { ...bodyB, name: 'test BRANCH' })).status, 409);
    r = await api('GET', `/api/branches/${tb}`, admin);
    check('A new branch is empty', `${r.json.stats.members}/${r.json.stats.physical_copies}/${r.json.stats.open_loans}/${r.json.staff.length}`, '0/0/0/0');
    check('The list now shows four branches', (await api('GET', '/api/branches', admin)).json.data.length, 4);
    r = await api('PATCH', `/api/branches/${tb}`, admin, { address: '2 Test Street, Test City', phone: null });
    check('Edit the address and clear the phone', `${r.status} ${r.json.branch.address} ${r.json.branch.phone}`, '200 2 Test Street, Test City null');
    check('Edit with no fields', (await api('PATCH', `/api/branches/${tb}`, admin, {})).status, 400);
    check('Rename to an existing branch name', (await api('PATCH', `/api/branches/${tb}`, admin, { name: 'Central Branch - Chennai' })).status, 409);
    check('Staff cannot edit a branch', (await api('PATCH', `/api/branches/${tb}`, chn, { address: 'Hacked address here' })).status, 403);
    check('Edit an unknown branch', (await api('PATCH', '/api/branches/9999', admin, { address: 'Somewhere else, Nowhere' })).status, 404);

    console.log('--- branches: deactivation safety rules');
    const st = await api('POST', '/api/staff', admin, { username: `test_staff_b${Date.now() % 100000}`, full_name: 'Test Branch Staff', branch_id: tb });
    created.staff = st.json.staff.user_id;
    const mm = await api('POST', '/api/members', admin, { full_name: 'Test Branch Member', email: 'test.branch.member@example.com', phone: '+919840099444', home_branch_id: tb });
    created.member = mm.json.member.member_id;
    const deact = () => api('PATCH', `/api/branches/${tb}/status`, admin, { is_active: false });
    r = await deact();
    check('Blocked by assigned staff and members', `${r.status} staff=${r.json.blockers.active_staff} members=${r.json.blockers.active_members}`, '409 staff=1 members=1');
    check('The branch is still active', (await api('GET', `/api/branches/${tb}`, admin)).json.branch.is_active, true);
    const pr1 = await api('POST', '/api/payments', admin, { member_id: created.member, plan_id: 1, method: 'cash' });
    r = await deact();
    check('Blocked by a pending payment request', r.json.blockers.pending_payments, 1);
    check('Reject that request', (await api('POST', `/api/payments/${pr1.json.payment.request_id}/reject`, admin, { reason: 'Test cleanup request' })).status, 200);
    check('Stock a book at the new branch', (await api('PUT', '/api/books/3/inventory', admin, { branch_id: tb, total_copies: 1 })).status, 200);
    const li = await api('POST', '/api/loans', admin, { member_id: 6, book_id: 3, branch_id: tb });
    check('Issue a loan at the new branch', li.status, 201);
    r = await deact();
    check('Blocked by an open loan', r.json.blockers.open_loans, 1);
    check('Return the loan', (await api('POST', `/api/loans/${li.json.loan.loan_id}/return`, admin)).status, 200);
    check('Remove the stock again', (await api('PUT', '/api/books/3/inventory', admin, { branch_id: tb, total_copies: 0 })).status, 200);
    check('Deactivate the staff account', (await api('PATCH', `/api/staff/${created.staff}/status`, admin, { is_active: false })).status, 200);
    r = await deact();
    check('Still blocked by the active member', `${r.status} staff=${r.json.blockers.active_staff} members=${r.json.blockers.active_members}`, '409 staff=0 members=1');
    check('Deactivate the member', (await api('PATCH', `/api/members/${created.member}/status`, admin, { is_active: false })).status, 200);
    r = await deact();
    check('Deactivated once nothing is open', `${r.status} ${r.json.branch.is_active}`, '200 false');
    check('No new staff in an inactive branch', (await api('POST', '/api/staff', admin, { username: `test_staff_c${Date.now() % 100000}`, full_name: 'Late Staff', branch_id: tb })).status, 409);
    check('No new members', (await api('POST', '/api/members', admin, { full_name: 'Late Member', email: 'late.member@example.com', phone: '+919840099445', home_branch_id: tb })).status, 409);
    check('No loans', (await api('POST', '/api/loans', admin, { member_id: 6, book_id: 3, branch_id: tb })).status, 409);
    check('No stock changes', (await api('PUT', '/api/books/3/inventory', admin, { branch_id: tb, total_copies: 1 })).status, 409);
    check('Staff cannot change the branch status', (await api('PATCH', `/api/branches/${tb}/status`, chn, { is_active: true })).status, 403);
    check('Bad status body', (await api('PATCH', `/api/branches/${tb}/status`, admin, { is_active: 'yes' })).status, 400);
    r = await api('PATCH', `/api/branches/${tb}/status`, admin, { is_active: true });
    check('Admin reactivates the branch', `${r.status} ${r.json.branch.is_active}`, '200 true');
    for (const [action, label] of [['branch_created', 'creation'], ['branch_updated', 'edit'], ['branch_deactivated', 'deactivation'], ['branch_activated', 'reactivation']]) {
      check(`Audit: ${label}`, await n('SELECT COUNT(*) FROM audit_logs WHERE entity_type = ? AND entity_id = ? AND action = ?', ['branch', String(tb), action]), 1);
    }

    console.log('--- audit-log viewer');
    const al = (token, qs = '') => api('GET', `/api/audit-logs${qs}`, token);
    const alTotal = async (token, qs) => (await al(token, qs)).json.total;
    const totalNow = await n('SELECT COUNT(*) FROM audit_logs');
    r = await al(admin);
    check('Total matches the table', r.json.total, totalNow);
    check('10 rows per page', r.json.data.length, 10);
    check('Newest entry first', r.json.data[0].audit_id, await n('SELECT MAX(audit_id) FROM audit_logs'));
    check('Action filter', await alTotal(admin, '?action=loan_issued'), await n("SELECT COUNT(*) FROM audit_logs WHERE action = 'loan_issued'"));
    check('Entity type filter', await alTotal(admin, '?entity_type=incident'), await n("SELECT COUNT(*) FROM audit_logs WHERE entity_type = 'incident'"));
    check('Entity filter (one setting)', await alTotal(admin, '?entity_type=setting&entity_id=grace_days'), await n("SELECT COUNT(*) FROM audit_logs WHERE entity_type = 'setting' AND entity_id = 'grace_days'"));
    check('User filter', await alTotal(admin, '?user_id=1'), await n('SELECT COUNT(*) FROM audit_logs WHERE user_id = 1'));
    check('Username search', await alTotal(admin, '?username=staff_vel'), await n("SELECT COUNT(*) FROM audit_logs a JOIN users u ON u.user_id = a.user_id WHERE u.username LIKE '%staff_vel%'"));
    check('Text search', await alTotal(admin, '?search=branch'), await n("SELECT COUNT(*) FROM audit_logs WHERE details LIKE '%branch%' OR action LIKE '%branch%'"));
    check('Since 2020', await alTotal(admin, '?from=2020-01-01'), totalNow);
    check('Before 2020', await alTotal(admin, '?to=2020-01-01'), 0);
    check('Combined filters', await alTotal(admin, '?action=setting_changed&from=2020-01-01'), await n("SELECT COUNT(*) FROM audit_logs WHERE action = 'setting_changed'"));
    check('Sort by action', (await al(admin, '?sort=action&dir=asc')).json.data[0].action, await sv('SELECT MIN(action) FROM audit_logs'));
    check('The action list matches the table', (await api('GET', '/api/audit-logs/actions', admin)).json.data.length, await n('SELECT COUNT(DISTINCT action) FROM audit_logs'));
    check('Staff cannot read the audit log', (await al(chn)).status, 403);
    check('Member token', (await al(mem)).status, 403);
    check('No token', (await al(null)).status, 401);
    check('Bad user_id', (await al(admin, '?user_id=abc')).status, 400);
    check('Bad date', (await al(admin, '?from=2026-13-45')).status, 400);
    check('Bad sort', (await al(admin, '?sort=zzz')).status, 400);
    check('Entries cannot be deleted', (await api('DELETE', '/api/audit-logs/1', admin)).status, 404);
    check('Entries cannot be edited', (await api('PATCH', '/api/audit-logs/1', admin, { details: 'x' })).status, 404);
    check('Entries cannot be added', (await api('POST', '/api/audit-logs', admin, { action: 'x' })).status, 404);
    check('No password hashes in the log', await n("SELECT COUNT(*) FROM audit_logs WHERE details LIKE '%$2a$%' OR details LIKE '%$2b$%'"), 0);
    check('No password hashes in the response', /password_hash|\$2[aby]\$/.test(JSON.stringify(r.json)), false);
    const exportsBefore = await n("SELECT COUNT(*) FROM audit_logs WHERE action = 'report_exported'");
    const csv = await al(admin, '?format=csv&action=setting_changed');
    check('CSV: header plus every matching entry', csvLines(csv.text).length, (await n("SELECT COUNT(*) FROM audit_logs WHERE action = 'setting_changed'")) + 1);
    check('The export itself was audited', (await n("SELECT COUNT(*) FROM audit_logs WHERE action = 'report_exported'")) - exportsBefore, 1);
  }

  async function cleanup() {
    const q = async (sql, p = []) => {
      try { await db.execute(sql, p); } catch (e) { console.log(`cleanup note: ${e.message}`); }
    };
    await q('DELETE FROM loan_fines WHERE loan_id > 22');
    await q('DELETE FROM fine_payments WHERE loan_id > 22');
    await q('DELETE FROM loans WHERE loan_id > 22');
    for (const id of created.payments) {
      await q('DELETE FROM memberships WHERE payment_request_id = ?', [id]);
      await q('DELETE FROM payment_requests WHERE request_id = ?', [id]);
    }
    if (created.branch) {
      const b = created.branch;
      await q('DELETE FROM branch_inventory WHERE branch_id = ?', [b]);
      await q('DELETE FROM payment_requests WHERE branch_id = ?', [b]);
      if (created.member) {
        await q('DELETE FROM member_accounts WHERE member_id = ?', [created.member]);
        await q('DELETE FROM members WHERE member_id = ?', [created.member]);
      }
      if (created.staff) {
        await q('DELETE FROM audit_logs WHERE user_id = ?', [created.staff]);
        await q('DELETE FROM users WHERE user_id = ?', [created.staff]);
      }
      await q('DELETE FROM branches WHERE branch_id = ?', [b]);
    }
    for (const [k, v] of Object.entries(ORIGINAL)) {
      if (v !== undefined) await q('UPDATE system_settings SET setting_value = ? WHERE setting_key = ?', [v, k]);
    }
    await q("UPDATE system_settings SET setting_value = '0' WHERE setting_key = 'allow_self_verification'");
  }

  let crashed = null;
  try {
    await runTests();
  } catch (err) {
    crashed = err;
  }
  await cleanup();
  check('Cleanup: data is back to the original (branches/users/loans/payments/memberships/members)', await counts(), '3/4/22/18/14/15');
  await db.end();

  if (crashed) {
    console.error('Test stopped early:', crashed.message);
    process.exit(1);
  }
  console.log(failures === 0 ? `\nAll ${total} checks passed` : `\n${failures} of ${total} checks FAILED`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error('Test failed to run:', err.message);
  process.exit(1);
});