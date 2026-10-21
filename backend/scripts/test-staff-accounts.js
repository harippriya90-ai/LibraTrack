// Tests staff accounts, password change and the server-enforced forced password change.
// Needs the server running and migration_003 applied. Cleans up the accounts it creates.
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
const login = (username, password) => api('POST', '/api/auth/login', null, { username, password });
async function adminLogin(username, password) {
  const r = await login(username, password);
  if (r.status !== 200) throw new Error(`Login failed for ${username} (${r.status})`);
  return r.json.token;
}
async function memberToken(email, password) {
  const r = await api('POST', '/api/auth/member-login', null, { email, password });
  if (r.status !== 200) throw new Error(`Member login failed for ${email} (${r.status})`);
  return r.json.token;
}
const csvLines = (text) => text.replace(/^\uFEFF/, '').split('\r\n').filter((l) => l.length > 0);

async function main() {
  const admin = await adminLogin('admin', 'Admin@2026');
  const chn = await adminLogin('staff_chennai', 'Chennai@2026');
  const mem = await memberToken('ananya.krishnan@example.com', 'Ananya@2026');

  const db = await mysql.createConnection({
    host: process.env.DB_HOST || 'localhost',
    port: Number(process.env.DB_PORT || 3306),
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASSWORD || '',
    database: process.env.DB_NAME || 'libratrack',
  });
  const n = async (sql, p = []) => {
    const [[row]] = await db.execute(sql, p);
    return Number(Object.values(row)[0]);
  };

  const [cols] = await db.query("SHOW COLUMNS FROM users LIKE 'must_change_password'");
  if (!cols.length) {
    console.log('The users table has no must_change_password column. Run migration_003_staff_security.sql first.');
    await db.end();
    process.exit(1);
  }
  if ((await n("SELECT COUNT(*) FROM users WHERE username NOT LIKE 'test%'")) !== 4) {
    console.log('Expected the 4 demo accounts. Run the restore commands first.');
    await db.end();
    process.exit(1);
  }
  const total0 = await n('SELECT COUNT(*) FROM users');
  const uname = `test_staff_${Date.now() % 1000000}`;
  let r;
  let sid = null;

  console.log('--- listing, filters and access');
  r = await api('GET', '/api/staff', admin);
  check('Admin lists every account', r.json.total, total0);
  check('Admins / staff in the totals', `${r.json.totals.admins} / ${r.json.totals.staff}`, `${await n("SELECT COUNT(*) FROM users WHERE role = 'admin'")} / ${await n("SELECT COUNT(*) FROM users WHERE role = 'staff'")}`);
  check('Administrator is listed first', r.json.data[0].role, 'admin');
  check('Password hashes are never returned', /password_hash|\$2[aby]\$/.test(JSON.stringify(r.json)), false);
  const roleStaff = await api('GET', '/api/staff?role=staff', admin);
  check('Filter role=staff', roleStaff.json.total, await n("SELECT COUNT(*) FROM users WHERE role = 'staff'"));
  check('Filter status=active', (await api('GET', '/api/staff?status=active', admin)).json.total, await n('SELECT COUNT(*) FROM users WHERE is_active = 1'));
  check('Search chennai', (await api('GET', '/api/staff?search=chennai', admin)).json.total, await n("SELECT COUNT(*) FROM users WHERE username LIKE '%chennai%' OR full_name LIKE '%chennai%'"));
  check('Branch 2', (await api('GET', '/api/staff?branch_id=2', admin)).json.total, await n('SELECT COUNT(*) FROM users WHERE branch_id = 2'));
  check('Bad role filter', (await api('GET', '/api/staff?role=zzz', admin)).status, 400);
  check('Bad status filter', (await api('GET', '/api/staff?status=zzz', admin)).status, 400);
  check('Staff token on the list', (await api('GET', '/api/staff', chn)).status, 403);
  check('Member token on the list', (await api('GET', '/api/staff', mem)).status, 403);
  check('No token on the list', (await api('GET', '/api/staff', null)).status, 401);
  const csv = await api('GET', '/api/staff?format=csv', admin);
  check('CSV: header plus every account', csvLines(csv.text).length, total0 + 1);
  check('CSV has no password hashes', /\$2[aby]\$/.test(csv.text), false);

  console.log('--- creating a staff account');
  const bodyOk = { username: uname, full_name: 'Test Vellore Staff', branch_id: 2 };
  check('Staff cannot create accounts', (await api('POST', '/api/staff', chn, bodyOk)).status, 403);
  check('Username with a space', (await api('POST', '/api/staff', admin, { ...bodyOk, username: 'a b' })).status, 400);
  check('Username too short', (await api('POST', '/api/staff', admin, { ...bodyOk, username: 'ab' })).status, 400);
  check('Missing full name', (await api('POST', '/api/staff', admin, { username: `${uname}x`, branch_id: 2 })).status, 400);
  check('Missing branch', (await api('POST', '/api/staff', admin, { username: `${uname}x`, full_name: 'No Branch' })).status, 400);
  check('Unknown branch', (await api('POST', '/api/staff', admin, { ...bodyOk, username: `${uname}x`, branch_id: 99999 })).status, 404);
  check('Duplicate of a demo username', (await api('POST', '/api/staff', admin, { ...bodyOk, username: 'staff_chennai' })).status, 409);
  const cr = await api('POST', '/api/staff', admin, { ...bodyOk, role: 'admin' });
  check('Admin creates a staff account', cr.status, 201);
  sid = cr.json.staff.user_id;
  const temp = cr.json.temporary_password;
  check('A role in the request is ignored: created as staff', cr.json.staff.role, 'staff');
  check('Assigned to Vellore', `${cr.json.staff.branch_id} ${cr.json.staff.branch_name}`, '2 North Branch - Vellore');
  check('Temporary password is 12 characters', temp.length, 12);
  check('Must change password', cr.json.staff.must_change_password, true);
  check('Response is not cached', (cr.headers.get('cache-control') || '').includes('no-store'), true);
  check('Creating the same username again', (await api('POST', '/api/staff', admin, bodyOk)).status, 409);

  console.log('--- forced password change, enforced by the server');
  const lg = await login(uname, temp);
  check('Login with the temporary password works', lg.status, 200);
  const T = lg.json.token;
  r = await api('GET', '/api/auth/me', T);
  check('/me works and reports the flag', `${r.status} ${r.json.user.must_change_password}`, '200 true');
  r = await api('GET', '/api/members', T);
  check('Members blocked until the password is changed', `${r.status} ${r.json.code}`, '403 PASSWORD_CHANGE_REQUIRED');
  check('Dashboard blocked too', (await api('GET', '/api/dashboard', T)).status, 403);
  check('Payments blocked too', (await api('GET', '/api/payments', T)).status, 403);
  check('Wrong current password', (await api('POST', '/api/auth/change-password', T, { current_password: 'nope', new_password: 'Vellore2026x' })).status, 400);
  check('Weak new password', (await api('POST', '/api/auth/change-password', T, { current_password: temp, new_password: 'short1' })).status, 400);
  check('Same as the current password', (await api('POST', '/api/auth/change-password', T, { current_password: temp, new_password: temp })).status, 400);
  check('Same as the username', (await api('POST', '/api/auth/change-password', T, { current_password: temp, new_password: uname })).status, 400);
  check('Valid change', (await api('POST', '/api/auth/change-password', T, { current_password: temp, new_password: 'Vellore2026x' })).status, 200);
  r = await api('GET', '/api/members', T);
  check('Same token now works, Vellore members only', `${r.status} ${r.json.total} ${r.json.data.every((m) => m.home_branch_id === 2)}`, '200 5 true');
  check('Old temporary password no longer logs in', (await login(uname, temp)).status, 401);
  r = await login(uname, 'Vellore2026x');
  check('New password logs in', r.status, 200);
  check('Flag is cleared', (await api('GET', '/api/auth/me', r.json.token)).json.user.must_change_password, false);

  console.log('--- reassigning the branch and editing');
  r = await api('PATCH', `/api/staff/${sid}`, admin, { branch_id: 3 });
  check('Admin moves the account to Coimbatore', `${r.status} ${r.json.staff.branch_name}`, '200 South Branch - Coimbatore');
  r = await api('GET', '/api/members', T);
  check('The very next request is scoped to the new branch', `${r.json.total} ${r.json.data.every((m) => m.home_branch_id === 3)}`, '5 true');
  const moved = await db.execute("SELECT details FROM audit_logs WHERE action = 'staff_branch_changed' AND entity_id = ? ORDER BY audit_id DESC LIMIT 1", [String(sid)]);
  check('The move is audited as old -> new', moved[0][0] && moved[0][0].details, 'branch 2 -> 3');
  r = await api('PATCH', `/api/staff/${sid}`, admin, { full_name: 'Test Staff Renamed' });
  check('Rename', `${r.status} ${r.json.staff.full_name}`, '200 Test Staff Renamed');
  check('No changes supplied', (await api('PATCH', `/api/staff/${sid}`, admin, {})).status, 400);
  check('Bad full name', (await api('PATCH', `/api/staff/${sid}`, admin, { full_name: 'x' })).status, 400);
  check('Unknown branch', (await api('PATCH', `/api/staff/${sid}`, admin, { branch_id: 99999 })).status, 404);
  check('Staff cannot edit accounts', (await api('PATCH', `/api/staff/${sid}`, chn, { full_name: 'Hacked Name' })).status, 403);
  check('Administrator accounts cannot be edited here', (await api('PATCH', '/api/staff/1', admin, { full_name: 'Someone Else' })).status, 409);
  check('Unknown account', (await api('PATCH', '/api/staff/99999', admin, { full_name: 'Nobody Here' })).status, 404);

  console.log('--- deactivating and reactivating');
  check('Staff cannot deactivate', (await api('PATCH', `/api/staff/${sid}/status`, chn, { is_active: false })).status, 403);
  check('Bad status body', (await api('PATCH', `/api/staff/${sid}/status`, admin, { is_active: 'no' })).status, 400);
  r = await api('PATCH', `/api/staff/${sid}/status`, admin, { is_active: false });
  check('Admin deactivates', `${r.status} ${r.json.staff.is_active}`, '200 false');
  check('Existing token stops working at once', (await api('GET', '/api/members', T)).status, 401);
  check('Login is refused while deactivated', (await login(uname, 'Vellore2026x')).status, 403);
  r = await api('PATCH', `/api/staff/${sid}/status`, admin, { is_active: true });
  check('Admin reactivates', `${r.status} ${r.json.staff.is_active}`, '200 true');
  check('Login works again', (await login(uname, 'Vellore2026x')).status, 200);
  check('The administrator cannot be deactivated', (await api('PATCH', '/api/staff/1/status', admin, { is_active: false })).status, 409);

  console.log('--- lockout and password reset');
  for (let i = 0; i < 5; i += 1) await login(uname, 'Wrong@Pass1');
  check('Correct password is refused while locked', (await login(uname, 'Vellore2026x')).status, 429);
  check('Staff cannot reset passwords', (await api('POST', `/api/staff/${sid}/reset-password`, chn)).status, 403);
  check('Administrator accounts cannot be reset here', (await api('POST', '/api/staff/1/reset-password', admin)).status, 409);
  r = await api('POST', `/api/staff/${sid}/reset-password`, admin);
  const temp2 = r.json.temporary_password;
  check('Admin resets the password', `${r.status} ${temp2.length} ${temp2 !== temp} ${r.json.staff.must_change_password}`, '200 12 true true');
  check('Reset clears the lockout', r.json.staff.is_locked, false);
  check('Previous password no longer works', (await login(uname, 'Vellore2026x')).status, 401);
  const lg2 = await login(uname, temp2);
  check('Temporary password works', lg2.status, 200);
  r = await api('GET', '/api/members', lg2.json.token);
  check('Change is forced again', `${r.status} ${r.json.code}`, '403 PASSWORD_CHANGE_REQUIRED');

  console.log('--- account detail and activity');
  r = await api('GET', `/api/staff/${sid}`, admin);
  check('Detail', `${r.status} ${r.json.staff.username === uname}`, '200 true');
  check('Recent activity is listed', r.json.activity.length > 0 && typeof r.json.activity[0].action === 'string', true);
  check('Detail has no password hash', /password_hash|\$2[aby]\$/.test(JSON.stringify(r.json)), false);
  check('Staff token on the detail', (await api('GET', `/api/staff/${sid}`, chn)).status, 403);
  check('Unknown account', (await api('GET', '/api/staff/99999', admin)).status, 404);
  check('Bad account id', (await api('GET', '/api/staff/abc', admin)).status, 400);

  console.log('--- members with a temporary password are blocked too');
  const tm = await api('POST', '/api/members', chn, { full_name: 'Must Change Test', email: 'must.change@example.com', phone: '+919840099666' });
  check('Setup: register a member', tm.status, 201);
  const mid = tm.json.member.member_id;
  const acct = await api('POST', `/api/members/${mid}/account`, chn);
  const mtemp = acct.json.temporary_password;
  const mt = await memberToken('must.change@example.com', mtemp);
  r = await api('GET', '/api/me/loans', mt);
  check('Loans blocked until the password is changed', `${r.status} ${r.json.code}`, '403 PASSWORD_CHANGE_REQUIRED');
  check('Catalogue blocked too', (await api('GET', '/api/me/books', mt)).status, 403);
  check('Profile is still reachable', (await api('GET', '/api/me', mt)).status, 200);
  check('Member changes the password', (await api('POST', '/api/auth/member-change-password', mt, { current_password: mtemp, new_password: 'Member2026x' })).status, 200);
  check('Same token now works', (await api('GET', '/api/me/loans', mt)).status, 200);
  check('Cleanup: delete the test member', (await api('DELETE', `/api/members/${mid}`, chn)).status, 200);

  console.log('--- audit trail');
  for (const [action, label] of [['staff_created', 'creation'], ['staff_branch_changed', 'branch move'], ['staff_deactivated', 'deactivation'], ['staff_reactivated', 'reactivation'], ['staff_password_reset', 'password reset']]) {
    check(`Audit: ${label}`, await n('SELECT COUNT(*) FROM audit_logs WHERE entity_id = ? AND action = ?', [String(sid), action]), 1);
  }
  check('Audit: password change', await n("SELECT COUNT(*) FROM audit_logs WHERE entity_id = ? AND action = 'password_changed'", [String(sid)]), 1);
  check('Audit entries carry no password text', (await n("SELECT COUNT(*) FROM audit_logs WHERE entity_id = ? AND (details LIKE '%Vellore2026%' OR details LIKE '%$2b$%')", [String(sid)])), 0);

  // Remove the test account (its audit rows first, because they refer to it).
  await db.execute('DELETE FROM audit_logs WHERE user_id = ?', [sid]);
  await db.execute('DELETE FROM users WHERE user_id = ?', [sid]);
  check('Cleanup: accounts are back to the original count', await n('SELECT COUNT(*) FROM users'), total0);
  await db.end();

  console.log(failures === 0 ? `\nAll ${total} checks passed` : `\n${failures} of ${total} checks FAILED`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error('Test failed to run:', err.message);
  process.exit(1);
});