// Tests payment QR codes: access rules, QR contents, summary masking and reference lookup.
// Needs the server running.
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const { PNG } = require('pngjs');
const jsQR = require('jsqr');

const BASE = process.env.TEST_BASE_URL || `http://localhost:${process.env.PORT || 3000}`;
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

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
  const buf = Buffer.from(await res.arrayBuffer());
  let parsed = null;
  if ((res.headers.get('content-type') || '').includes('application/json')) {
    try { parsed = JSON.parse(buf.toString('utf8')); } catch (e) { /* not json */ }
  }
  return { status: res.status, headers: res.headers, buf, json: parsed };
}

// Reads a QR code out of a PNG image, exactly as a phone scanner would.
function decodeQr(buf) {
  const png = PNG.sync.read(buf);
  const result = jsQR(new Uint8ClampedArray(png.data), png.width, png.height);
  return result ? result.data : null;
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

  const created = await api('POST', '/api/payments', chn, { member_id: 3, plan_id: 1, method: 'upi', submitted_txn_id: 'UPI-QR-5821' });
  check('Create pending request (member 3)', created.status, 201);
  if (created.status !== 201) {
    console.log('Cannot continue. Member 3 may already have a pending request. Details:', created.json);
    process.exit(1);
  }
  const id = created.json.payment.request_id;
  const ref = created.json.payment.reference_no;
  check('Reference is 24 hex characters', /^[0-9A-F]{24}$/.test(ref), true);

  console.log('--- access rules');
  check('No token', (await api('GET', `/api/payments/${id}/qr`, null)).status, 401);
  check('Member token', (await api('GET', `/api/payments/${id}/qr`, mem)).status, 403);
  check('Other branch staff', (await api('GET', `/api/payments/${id}/qr`, vel)).status, 403);
  check('Payment 9999', (await api('GET', '/api/payments/9999/qr', admin)).status, 404);
  check('Payment abc', (await api('GET', '/api/payments/abc/qr', admin)).status, 400);
  check('Bad format', (await api('GET', `/api/payments/${id}/qr?format=gif`, chn)).status, 400);

  console.log('--- QR image');
  const qr = await api('GET', `/api/payments/${id}/qr`, chn);
  check('Own branch staff', qr.status, 200);
  check('Content type', qr.headers.get('content-type'), 'image/png');
  check('Valid PNG signature', qr.buf.subarray(0, 8).equals(PNG_SIGNATURE), true);
  const decoded = decodeQr(qr.buf);
  check('Scanned QR equals the request reference', decoded, ref);
  check('QR holds only 24 characters', decoded ? decoded.length : -1, 24);
  check('QR has no member name', decoded ? decoded.includes('Divya') : null, false);

  const p1 = await api('GET', '/api/payments/1', admin);
  const ref1 = p1.json.payment.reference_no;
  const qr1 = await api('GET', '/api/payments/1/qr', chn);
  check('Payment 1 QR equals its own reference', decodeQr(qr1.buf), ref1);
  check('Different requests have different QR codes', ref1 !== ref, true);

  const dl = await api('GET', `/api/payments/${id}/qr?download=1`, chn);
  check('Download header', (dl.headers.get('content-disposition') || '').includes(`attachment; filename="payment-${id}-qr.png"`), true);
  check('Admin can fetch Vellore payment 7', (await api('GET', '/api/payments/7/qr', admin)).status, 200);
  check('QR for expired payment 18', (await api('GET', '/api/payments/18/qr', admin)).status, 200);

  const svg = await api('GET', `/api/payments/${id}/qr?format=svg`, chn);
  check('SVG status', svg.status, 200);
  check('SVG content type', (svg.headers.get('content-type') || '').startsWith('image/svg+xml'), true);
  check('SVG body', svg.buf.toString('utf8').includes('<svg'), true);

  console.log('--- printable summary');
  const s = await api('GET', `/api/payments/${id}/summary`, chn);
  check('Own branch staff', s.status, 200);
  const sum = s.json && s.json.summary ? s.json.summary : {};
  check('Reference matches', sum.reference_no, ref);
  check('Status', sum.status, 'pending');
  check('Embedded QR is a PNG data URL', (sum.qr_data_url || '').startsWith('data:image/png;base64,'), true);
  const embedded = Buffer.from((sum.qr_data_url || '').split(',')[1] || '', 'base64');
  check('Embedded QR scans to the reference', decodeQr(embedded), ref);
  check('Submitted transaction ID is masked', sum.submitted_txn_masked, '*******5821');
  check('Raw transaction ID not in response', JSON.stringify(s.json).includes('UPI-QR-5821'), false);
  check('Note says it is not proof of payment', (sum.note || '').includes('not proof'), true);
  const s1 = await api('GET', '/api/payments/1/summary', chn);
  check('Verified payment status', s1.json.summary.status, 'successful');
  check('Verification transaction ID masked', s1.json.summary.verification_txn_masked, '***0001');
  check('Other branch staff', (await api('GET', `/api/payments/${id}/summary`, vel)).status, 403);
  check('Member token', (await api('GET', `/api/payments/${id}/summary`, mem)).status, 403);
  check('No token', (await api('GET', `/api/payments/${id}/summary`, null)).status, 401);

  console.log('--- lookup by reference');
  const lk = await api('GET', `/api/payments/lookup/${ref}`, chn);
  check('Own branch staff', lk.status, 200);
  check('Finds the right request', lk.json && lk.json.payment && lk.json.payment.request_id, id);
  const lkLower = await api('GET', `/api/payments/lookup/${ref.toLowerCase()}`, chn);
  check('Lowercase reference works', lkLower.json && lkLower.json.payment && lkLower.json.payment.request_id, id);
  check('Other branch staff', (await api('GET', `/api/payments/lookup/${ref}`, vel)).status, 403);
  check('Invalid reference format', (await api('GET', '/api/payments/lookup/xyz', admin)).status, 400);
  check('Unknown reference', (await api('GET', '/api/payments/lookup/000000000000000000000000', admin)).status, 404);
  check('Admin lookup', (await api('GET', `/api/payments/lookup/${ref}`, admin)).status, 200);
  check('Member token', (await api('GET', `/api/payments/lookup/${ref}`, mem)).status, 403);
  check('No token', (await api('GET', `/api/payments/lookup/${ref}`, null)).status, 401);
  const p7 = await api('GET', '/api/payments/7', admin);
  const lk7 = await api('GET', `/api/payments/lookup/${p7.json.payment.reference_no}`, vel);
  check("Vellore staff finds Vellore's payment 7", lk7.json && lk7.json.payment && lk7.json.payment.request_id, 7);

  console.log(failures === 0 ? `\nAll ${total} checks passed` : `\n${failures} of ${total} checks FAILED`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error('Test failed to run:', err.message);
  process.exit(1);
});