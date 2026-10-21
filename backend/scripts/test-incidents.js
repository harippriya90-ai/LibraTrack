// Tests incident reporting, admin decisions, suspensions, restrictions and reversals.
// Needs the server running and the clean demo data (22 loans, 3 incidents, 2 restrictions).
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

  const [[c0]] = await db.execute('SELECT (SELECT COUNT(*) FROM loans) AS l, (SELECT COUNT(*) FROM incidents) AS i, (SELECT COUNT(*) FROM member_restrictions) AS r');
  if (Number(c0.l) !== 22 || Number(c0.i) !== 3 || Number(c0.r) !== 2) {
    console.log(`Expected the clean demo data (22 loans, 3 incidents, 2 restrictions) but found ${c0.l}, ${c0.i}, ${c0.r}. Run the clean-up command first.`);
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
  const get = (token, p) => api('GET', p, token);
  const incList = (token, qs = '') => api('GET', `/api/incidents${qs}`, token);
  const totalOf = async (token, qs) => (await incList(token, qs)).json.total;
  const report = (token, body) => api('POST', '/api/incidents', token, body);
  const decide = (token, id, body) => api('POST', `/api/incidents/${id}/decide`, token, body);
  const statusOf = async (memberId) => (await get(admin, `/api/members/${memberId}`)).json.member.effective_status;
  const borrow = (token, memberId, bookId) => api('POST', '/api/loans', token, { member_id: memberId, book_id: bookId });
  let r;

  console.log('--- seeded incidents (read only)');
  check('Admin sees 3', await totalOf(admin), 3);
  check('Status reported', await totalOf(admin, '?status=reported'), 1);
  check('Status decided', await totalOf(admin, '?status=decided'), 1);
  check('Status resolved', await totalOf(admin, '?status=resolved'), 1);
  check('Status dismissed', await totalOf(admin, '?status=dismissed'), 0);
  check('Type damage', await totalOf(admin, '?type=damage'), 2);
  check('Type theft_concealment', await totalOf(admin, '?type=theft_concealment'), 1);
  check('Vellore staff sees all 3', await totalOf(vel), 3);
  check('Chennai staff sees none', await totalOf(chn), 0);
  check('Chennai staff + branch_id=2 is ignored', await totalOf(chn, '?branch_id=2'), 0);
  const i1 = await get(vel, '/api/incidents/1');
  check('Incident 1 detail', `${i1.status} ${i1.json.incident.incident_ref} ${i1.json.incident.book_edition} ${i1.json.incident.status}`, '200 INC-2026-0001 1st decided');
  check('Chennai staff cannot read it', (await get(chn, '/api/incidents/1')).status, 403);
  check('Member token', (await incList(mem)).status, 403);
  check('No token', (await incList(null)).status, 401);
  check('Incident 9999', (await get(admin, '/api/incidents/9999')).status, 404);
  check('Incident abc', (await get(admin, '/api/incidents/abc')).status, 400);
  check('Bad status filter', (await incList(admin, '?status=zzz')).status, 400);
  check('Bad type filter', (await incList(admin, '?type=zzz')).status, 400);
  check('Bad date filter', (await incList(admin, '?reported_from=2026-13-45')).status, 400);
  const r9 = await get(vel, '/api/members/9/restrictions');
  check('Member 9: one suspension from incident 1', `${r9.json.data.length} ${r9.json.data[0].kind} ${r9.json.data[0].incident_ref}`, '1 suspension INC-2026-0001');
  const r10 = await get(admin, '/api/members/10/restrictions');
  check('Member 10: permanent restriction', `${r10.json.data[0].kind} end=${r10.json.data[0].end_date}`, 'restriction end=null');
  check('Chennai staff cannot read member 9 history', (await get(chn, '/api/members/9/restrictions')).status, 403);

  console.log('--- reporting damage (loan X: member 8, Vellore)');
  const X = await insertLoan({ member: 8, branch: 2, book: 10, dueOffset: -3, rate: '2.00', issuedBy: 3 });
  check('Setup: loan X returned', (await api('POST', `/api/loans/${X}/return`, vel)).status, 200);
  const damageBody = { loan_id: X, incident_type: 'damage', description: 'Water damage to inner pages and warped cover on return.' };
  check('No token', (await report(null, damageBody)).status, 401);
  check('Member token', (await report(mem, damageBody)).status, 403);
  check('Chennai staff, Vellore loan', (await report(chn, damageBody)).status, 403);
  check('Unknown loan', (await report(vel, { ...damageBody, loan_id: 99999 })).status, 404);
  check('Missing loan_id', (await report(vel, { incident_type: 'damage', description: damageBody.description })).status, 400);
  check('Bad type', (await report(vel, { ...damageBody, incident_type: 'fire' })).status, 400);
  check('Description too short', (await report(vel, { ...damageBody, description: 'torn' })).status, 400);
  check('Description too long', (await report(vel, { ...damageBody, description: 'x'.repeat(2001) })).status, 400);
  const rep = await report(vel, damageBody);
  check('Vellore staff reports damage', rep.status, 201);
  const D1 = rep.json.incident;
  check('Reference format', /^INC-\d{4}-\d{4}$/.test(D1.incident_ref), true);
  check('Starts as reported with no decision', `${D1.status} / ${D1.decision}`, 'reported / none');
  check('Edition and ISBN recorded', `${D1.book_edition} / ${D1.book_isbn}`, '1st / 978-81-90000-10-1');
  check('Member and branch taken from the loan', `${D1.member_id} / ${D1.branch_id}`, '8 / 2');
  check('Duplicate open report refused', (await report(vel, damageBody)).status, 409);
  r = await borrow(vel, 8, 20);
  check('No penalty before review: member can still borrow', r.status, 201);
  await api('POST', `/api/loans/${r.json.loan.loan_id}/return`, vel);

  console.log('--- admin decision on the damage');
  const okNotes = 'Replace with the same title, edition and cover. Two-week suspension.';
  check('Staff cannot decide', (await decide(vel, D1.incident_id, { decision: 'replace_and_suspend', notes: okNotes })).status, 403);
  check('No token', (await decide(null, D1.incident_id, { decision: 'replace_and_suspend', notes: okNotes })).status, 401);
  check('Decide without notes', (await decide(admin, D1.incident_id, { decision: 'replace_and_suspend' })).status, 400);
  check('Unknown decision', (await decide(admin, D1.incident_id, { decision: 'banish', notes: okNotes })).status, 400);
  check('Restriction not allowed for damage', (await decide(admin, D1.incident_id, { decision: 'permanent_restriction', notes: 'x'.repeat(30) })).status, 400);
  const dec = await decide(admin, D1.incident_id, { decision: 'replace_and_suspend', notes: okNotes });
  check('Admin decides', `${dec.status} ${dec.json.incident.status} ${dec.json.incident.decision}`, '200 decided replace_and_suspend');
  const susp = dec.json.restriction;
  check('Suspension is 14 days from today', `${susp.kind} ${susp.start_date} -> ${susp.end_date}`, `suspension ${today} -> ${addDays(today, 14)}`);
  check('Suspension links to the incident', susp.incident_ref, D1.incident_ref);
  check('Approved by the administrator', susp.approved_by_name, 'Central Administrator');
  check('Member 8 is now suspended', await statusOf(8), 'suspended');
  r = await borrow(vel, 8, 20);
  check('Borrowing blocked during the suspension', r.status === 409 && errText(r).includes('suspended until'), true);
  check('Deciding twice refused', (await decide(admin, D1.incident_id, { decision: 'no_action', notes: okNotes })).status, 409);

  console.log('--- replacement received, then lifting the suspension');
  const resolveUrl = `/api/incidents/${D1.incident_id}/resolve`;
  check('Staff cannot resolve', (await api('POST', resolveUrl, vel, { notes: 'Replacement received, same edition.' })).status, 403);
  check('Resolve without notes', (await api('POST', resolveUrl, admin, {})).status, 400);
  const res1 = await api('POST', resolveUrl, admin, { notes: 'Replacement received: same title, 1st edition, same cover.' });
  check('Replacement recorded', `${res1.status} ${res1.json.incident.status} ${res1.json.incident.replacement_received}`, '200 resolved true');
  check('Resolving twice refused', (await api('POST', resolveUrl, admin, { notes: 'Replacement received again.' })).status, 409);
  check('Suspension still runs after the replacement', await statusOf(8), 'suspended');
  const rUrl = `/api/restrictions/${susp.restriction_id}/revoke`;
  check('Staff cannot lift it', (await api('POST', rUrl, vel, { reason: 'Lifted early by the branch.' })).status, 403);
  check('Lift without a reason', (await api('POST', rUrl, admin, {})).status, 400);
  check('Unknown restriction', (await api('POST', '/api/restrictions/99999/revoke', admin, { reason: 'Does not exist.......' })).status, 404);
  const rv = await api('POST', rUrl, admin, { reason: 'Replacement accepted, suspension lifted early.' });
  check('Admin lifts the suspension', `${rv.status} ${rv.json.restriction.revoked_by_name}`, '200 Central Administrator');
  check('Member 8 is active again', await statusOf(8), 'active');
  r = await borrow(vel, 8, 20);
  check('Borrowing allowed again', r.status, 201);
  await api('POST', `/api/loans/${r.json.loan.loan_id}/return`, vel);
  check('Lifting twice refused', (await api('POST', rUrl, admin, { reason: 'Lifting it a second time.' })).status, 409);
  const hist8 = await get(vel, '/api/members/8/restrictions');
  check('History keeps the lifted suspension', `${hist8.json.data.length} active=${hist8.json.data[0].is_active_now}`, '1 active=false');

  console.log('--- theft or concealment (loan Y: member 6)');
  const Y = await insertLoan({ member: 6, branch: 2, book: 11, dueOffset: -30, rate: '2.00', issuedBy: 3 });
  const t1 = await report(vel, { loan_id: Y, incident_type: 'theft_concealment', description: 'Book not returned; repeated contact attempts documented.' });
  check('Staff reports suspected theft', t1.status, 201);
  const T1 = t1.json.incident;
  check('No automatic penalty: member 6 still active', await statusOf(6), 'active');
  check('Suspension not allowed for theft', (await decide(admin, T1.incident_id, { decision: 'replace_and_suspend', notes: 'x'.repeat(30) })).status, 400);
  check('Restriction needs 20+ characters of notes', (await decide(admin, T1.incident_id, { decision: 'permanent_restriction', notes: 'Too short.' })).status, 400);
  const d2 = await decide(admin, T1.incident_id, { decision: 'permanent_restriction', notes: 'Reviewed the documented contact attempts; deliberate non-return confirmed.' });
  check('Admin confirms the restriction', `${d2.status} ${d2.json.incident.status} ${d2.json.restriction.kind} end=${d2.json.restriction.end_date}`, '200 resolved restriction end=null');
  check('Member 6 is restricted', await statusOf(6), 'restricted');
  r = await borrow(vel, 6, 20);
  check('Borrowing blocked', r.status === 409 && errText(r).includes('permanently restricted'), true);
  const rv2 = await api('POST', `/api/restrictions/${d2.json.restriction.restriction_id}/revoke`, admin, { reason: 'Book recovered; administrator review completed.' });
  check('Admin reverses the restriction', rv2.status, 200);
  check('Member 6 is active again', await statusOf(6), 'active');

  console.log('--- dismissal and independent review');
  const t2 = await report(vel, { loan_id: Y, incident_type: 'damage', description: 'Cover torn when the book was found.' });
  check('A different type on the same loan is accepted', t2.status, 201);
  const d3 = await decide(admin, t2.json.incident.incident_id, { decision: 'no_action', notes: 'Wear and tear; no penalty applied.' });
  check('Admin dismisses it', `${d3.status} ${d3.json.incident.status} restriction=${d3.json.restriction === null ? 'none' : 'created'}`, '200 dismissed restriction=none');
  check('No new restriction for member 6', (await get(admin, '/api/members/6/restrictions')).json.data.length, 1);
  check('A dismissed incident cannot be decided again', (await decide(admin, t2.json.incident.incident_id, { decision: 'no_action', notes: 'Deciding it a second time.' })).status, 409);
  const t3 = await report(admin, { loan_id: Y, incident_type: 'theft_concealment', description: 'Reported by the administrator directly.' });
  check('Admin can report', t3.status, 201);
  r = await decide(admin, t3.json.incident.incident_id, { decision: 'no_action', notes: 'Closing my own report.' });
  check('Admin cannot decide their own report', r.status === 403 && errText(r).includes('reported yourself'), true);

  console.log('--- list filters after the workflow');
  check('Admin total is now 7', await totalOf(admin), 7);
  check('Reported (inc 3 + admin report)', await totalOf(admin, '?status=reported'), 2);
  check('Decided', await totalOf(admin, '?status=decided'), 1);
  check('Resolved (inc 2, D1, T1)', await totalOf(admin, '?status=resolved'), 3);
  check('Dismissed', await totalOf(admin, '?status=dismissed'), 1);
  check('Damage', await totalOf(admin, '?type=damage'), 4);
  check('Theft or concealment', await totalOf(admin, '?type=theft_concealment'), 3);
  check('Member 8', await totalOf(admin, '?member_id=8'), 1);
  check('Member 6', await totalOf(admin, '?member_id=6'), 3);
  check('Loan Y', await totalOf(admin, `?loan_id=${Y}`), 3);
  check('Reported today', await totalOf(admin, `?reported_from=${today}&reported_to=${today}`), 4);
  check('Vellore staff sees all 7', await totalOf(vel), 7);
  check('Chennai staff sees none', await totalOf(chn), 0);
  check('Newest first', (await incList(admin)).json.data[0].incident_id, t3.json.incident.incident_id);

  console.log('--- database checks');
  const [[bad1]] = await db.execute("SELECT COUNT(*) AS n FROM incidents WHERE status IN ('decided', 'resolved', 'dismissed') AND (decided_by IS NULL OR decided_at IS NULL)");
  check('Every decided incident names who decided and when', Number(bad1.n), 0);
  const [[bad2]] = await db.execute("SELECT COUNT(*) AS n FROM member_restrictions WHERE kind = 'suspension' AND end_date IS NULL");
  check('Every suspension has an end date', Number(bad2.n), 0);
  const [[len]] = await db.execute('SELECT DATEDIFF(end_date, start_date) AS d FROM member_restrictions WHERE incident_id = ?', [D1.incident_id]);
  check('Suspension length in the database', Number(len.d), 14);
  const [[a1]] = await db.execute("SELECT COUNT(*) AS n FROM audit_logs WHERE action = 'incident_reported'");
  const [[a2]] = await db.execute("SELECT COUNT(*) AS n FROM audit_logs WHERE action = 'incident_decided'");
  const [[a3]] = await db.execute("SELECT COUNT(*) AS n FROM audit_logs WHERE action IN ('incident_resolved', 'restriction_revoked')");
  check('Audit rows for reports', Number(a1.n) >= 4, true);
  check('Audit rows for decisions', Number(a2.n) >= 3, true);
  check('Audit rows for resolution and reversals', Number(a3.n) >= 3, true);
  await db.end();

  console.log(failures === 0 ? `\nAll ${total} checks passed` : `\n${failures} of ${total} checks FAILED`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error('Test failed to run:', err.message);
  process.exit(1);
});