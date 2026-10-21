// Tests payment-proof upload, download and removal rules. Needs the server running.
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const fs = require('fs');
const path = require('path');

const BASE = process.env.TEST_BASE_URL || `http://localhost:${process.env.PORT || 3000}`;
const PROOF_DIR = path.join(__dirname, '..', 'storage', 'proofs');

const PNG_BYTES = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64'
);
const PDF_BYTES = Buffer.from('%PDF-1.4\n1 0 obj\n<< /Type /Catalog >>\nendobj\ntrailer\n<< /Root 1 0 R >>\n%%EOF\n', 'latin1');
const JPG_BYTES = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0xff, 0xd9]);
const TEXT_AS_PDF = Buffer.from('this is just text, not a pdf');
const EXE_AS_PNG = Buffer.concat([Buffer.from('MZ'), Buffer.alloc(200, 0x90)]);
const BIG_PNG = Buffer.concat([PNG_BYTES.subarray(0, 8), Buffer.alloc(6 * 1024 * 1024)]);

let total = 0;
let failures = 0;
function check(label, actual, expected) {
  total += 1;
  const ok = actual === expected;
  if (!ok) failures += 1;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}: ${actual}${ok ? '' : `   (expected ${expected})`}`);
}

async function api(method, urlPath, token, opts = {}) {
  const headers = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  let body;
  if (opts.form) body = opts.form;
  else if (opts.json) {
    headers['Content-Type'] = 'application/json';
    body = JSON.stringify(opts.json);
  }
  const res = await fetch(BASE + urlPath, { method, headers, body });
  const buf = Buffer.from(await res.arrayBuffer());
  let json = null;
  if ((res.headers.get('content-type') || '').includes('application/json')) {
    try { json = JSON.parse(buf.toString('utf8')); } catch (e) { /* not json */ }
  }
  return { status: res.status, headers: res.headers, buf, json };
}

function formWith(field, buf, filename, type) {
  const fd = new FormData();
  fd.append(field, new Blob([buf], { type }), filename);
  return fd;
}

async function login(username, password) {
  const r = await api('POST', '/api/auth/login', null, { json: { username, password } });
  if (r.status !== 200) throw new Error(`Login failed for ${username} (${r.status})`);
  return r.json.token;
}
async function memberLogin(email, password) {
  const r = await api('POST', '/api/auth/member-login', null, { json: { email, password } });
  if (r.status !== 200) throw new Error(`Member login failed for ${email} (${r.status})`);
  return r.json.token;
}

async function main() {
  const admin = await login('admin', 'Admin@2026');
  const chn = await login('staff_chennai', 'Chennai@2026');
  const vel = await login('staff_vellore', 'Vellore@2026');
  const mem = await memberLogin('ananya.krishnan@example.com', 'Ananya@2026');

  const before = fs.readdirSync(PROOF_DIR);

  const created = await api('POST', '/api/payments', chn, { json: { member_id: 3, plan_id: 1, method: 'upi' } });
  check('Create pending request (member 3)', created.status, 201);
  if (created.status !== 201) {
    console.log('Cannot continue. Member 3 may already have a pending request. Details:', created.json);
    process.exit(1);
  }
  const id = created.json.payment.request_id;
  const url = `/api/payments/${id}/proof`;

  console.log('--- upload rules');
  check('No token', (await api('POST', url, null, { form: formWith('proof', PNG_BYTES, 'a.png', 'image/png') })).status, 401);
  check('Member token', (await api('POST', url, mem, { form: formWith('proof', PNG_BYTES, 'a.png', 'image/png') })).status, 403);
  check('Other branch staff', (await api('POST', url, vel, { form: formWith('proof', PNG_BYTES, 'a.png', 'image/png') })).status, 403);
  check('Wrong field name', (await api('POST', url, chn, { form: formWith('file', PNG_BYTES, 'a.png', 'image/png') })).status, 400);
  check('No file (JSON body)', (await api('POST', url, chn, { json: { x: 1 } })).status, 400);
  check('Text disguised as PDF', (await api('POST', url, chn, { form: formWith('proof', TEXT_AS_PDF, 'receipt.pdf', 'application/pdf') })).status, 415);
  check('Executable disguised as PNG', (await api('POST', url, chn, { form: formWith('proof', EXE_AS_PNG, 'photo.png', 'image/png') })).status, 415);
  check('6 MB file', (await api('POST', url, chn, { form: formWith('proof', BIG_PNG, 'big.png', 'image/png') })).status, 413);

  const up = await api('POST', url, chn, { form: formWith('proof', PNG_BYTES, '../../evil name!.png', 'image/png') });
  check('Valid PNG accepted', up.status, 201);
  check('Original name cleaned', up.json && up.json.proof && up.json.proof.original_name, 'evil name_.png');

  const detail = await api('GET', `/api/payments/${id}`, chn);
  check('Status still pending', detail.json.payment.status, 'pending');
  check('has_proof is true', detail.json.payment.has_proof, true);
  check('Stored file name not exposed', detail.json.payment.proof_stored_name === undefined, true);

  const added = fs.readdirSync(PROOF_DIR).filter((f) => !before.includes(f));
  check('Exactly one new file on disk', added.length, 1);
  check('Stored name is random hex + extension', /^[0-9a-f]{32}\.png$/.test(added[0] || ''), true);
  check('Second upload refused', (await api('POST', url, chn, { form: formWith('proof', PNG_BYTES, 'b.png', 'image/png') })).status, 409);

  console.log('--- download rules');
  const dl = await api('GET', url, chn);
  check('Own branch staff download', dl.status, 200);
  check('Content type', dl.headers.get('content-type'), 'image/png');
  check('Bytes identical to upload', Buffer.compare(dl.buf, PNG_BYTES) === 0, true);
  check('Shown inline', (dl.headers.get('content-disposition') || '').startsWith('inline'), true);
  const dl2 = await api('GET', `${url}?download=1`, chn);
  check('?download=1 forces attachment', (dl2.headers.get('content-disposition') || '').startsWith('attachment'), true);
  check('Admin download', (await api('GET', url, admin)).status, 200);
  check('Other branch staff download', (await api('GET', url, vel)).status, 403);
  check('Member download', (await api('GET', url, mem)).status, 403);
  check('No token download', (await api('GET', url, null)).status, 401);
  check('Seeded proof on payment 1', (await api('GET', '/api/payments/1/proof', chn)).status, 200);
  check('Payment 7 has no proof', (await api('GET', '/api/payments/7/proof', admin)).status, 404);

  console.log('--- removal and other file types');
  check('Other branch staff delete', (await api('DELETE', url, vel)).status, 403);
  check('Own branch staff delete', (await api('DELETE', url, chn)).status, 200);
  check('Download after delete', (await api('GET', url, chn)).status, 404);
  check('File removed from disk', fs.readdirSync(PROOF_DIR).length, before.length);

  const pdf = await api('POST', url, chn, { form: formWith('proof', PDF_BYTES, 'receipt.exe', 'application/pdf') });
  check('Valid PDF accepted', pdf.status, 201);
  check('Name forced to detected type', pdf.json && pdf.json.proof && pdf.json.proof.original_name, 'receipt.pdf');
  check('PDF served as application/pdf', (await api('GET', url, admin)).headers.get('content-type'), 'application/pdf');
  check('Admin delete', (await api('DELETE', url, admin)).status, 200);

  const jpg = await api('POST', url, chn, { form: formWith('proof', JPG_BYTES, 'scan.jpeg', 'image/jpeg') });
  check('Valid JPEG accepted', jpg.status, 201);
  check('JPEG mime recorded', jpg.json && jpg.json.proof && jpg.json.proof.mime, 'image/jpeg');
  check('Delete JPEG', (await api('DELETE', url, chn)).status, 200);

  console.log('--- locked states');
  check('Upload to successful payment (2)', (await api('POST', '/api/payments/2/proof', chn, { form: formWith('proof', PNG_BYTES, 'a.png', 'image/png') })).status, 409);
  check('Upload to expired payment (18)', (await api('POST', '/api/payments/18/proof', admin, { form: formWith('proof', PNG_BYTES, 'a.png', 'image/png') })).status, 409);
  check('Delete proof of successful payment (1)', (await api('DELETE', '/api/payments/1/proof', admin)).status, 409);
  check('Upload to payment 9999', (await api('POST', '/api/payments/9999/proof', admin, { form: formWith('proof', PNG_BYTES, 'a.png', 'image/png') })).status, 404);
  check('Upload to payment abc', (await api('POST', '/api/payments/abc/proof', admin, { form: formWith('proof', PNG_BYTES, 'a.png', 'image/png') })).status, 400);
  check('No leftover files on disk', fs.readdirSync(PROOF_DIR).length, before.length);

  console.log(failures === 0 ? `\nAll ${total} checks passed` : `\n${failures} of ${total} checks FAILED`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error('Test failed to run:', err.message);
  process.exit(1);
});