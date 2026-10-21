// Tests the hardening layer: headers, CORS, rate limits, error handling, static pages,
// the expiry scheduler, and the access rules of EVERY route. Restores what it changes.
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
process.env.DISABLE_SCHEDULER = '1'; // the test starts the scheduler itself
const http = require('http');
const mysql = require('mysql2/promise');

const BASE = process.env.TEST_BASE_URL || `http://localhost:${process.env.PORT || 3000}`;
const U = new URL(BASE);

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
// Low-level request: exact path (no normalization) and any headers, including Origin.
function raw(method, urlPath, headers = {}, body = null) {
  return new Promise((resolve, reject) => {
    const h = { ...headers };
    if (body) h['Content-Length'] = Buffer.byteLength(body);
    const req = http.request({ hostname: U.hostname, port: U.port || 80, path: urlPath, method, headers: h }, (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { text += c; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text }));
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
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
const b64u = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');

// ---------- list every route the app registers ----------
function mountPath(layer) {
  if (layer.regexp && layer.regexp.fast_slash) return '';
  const s = layer.regexp.source.replace('\\/?(?=\\/|$)', '').replace(/^\^/, '').replace(/\\\//g, '/');
  return /[()[\]*+?]/.test(s) ? null : s;
}
function collect(stack, prefix, out, skipped) {
  for (const layer of stack) {
    if (layer.route) {
      if (typeof layer.route.path !== 'string') { skipped.n += 1; continue; }
      for (const m of Object.keys(layer.route.methods)) {
        if (m === '_all') continue;
        out.add(`${m.toUpperCase()} ${(prefix + layer.route.path).replace(/\/+$/, '') || '/'}`);
      }
    } else if (layer.name === 'router' && layer.handle && layer.handle.stack) {
      const mp = mountPath(layer);
      if (mp === null) { skipped.n += 1; continue; }
      collect(layer.handle.stack, prefix + mp, out, skipped);
    }
  }
}

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
  if (Number(await sv('SELECT COUNT(*) FROM payment_requests')) !== 18 || Number(await sv('SELECT COUNT(*) FROM loans')) !== 22) {
    console.log('Expected the clean demo data (22 loans, 18 payment requests). Run the restore commands first.');
    await db.end();
    process.exit(1);
  }
  let r;
  let createdPayment = null;

  async function runTests() {
    console.log('--- security headers');
    r = await api('GET', '/api/health', null);
    const h = r.headers;
    check('X-Powered-By is gone', h.get('x-powered-by'), null);
    check('Content sniffing is blocked', h.get('x-content-type-options'), 'nosniff');
    check('A content security policy is set', (h.get('content-security-policy') || '').includes("default-src 'self'"), true);
    check('Framing is forbidden', (h.get('content-security-policy') || '').includes("frame-ancestors 'none'"), true);
    check('No referrer is sent', h.get('referrer-policy'), 'no-referrer');
    check('API responses are not cached', (h.get('cache-control') || '').includes('no-store'), true);
    r = await api('GET', '/api/branches', admin);
    check('A normal API call carries rate-limit information', h.get('ratelimit-policy') === null && r.headers.get('ratelimit-policy') !== null, true);
    r = await api('GET', '/api/members/4/history/print', admin);
    check('The printable page keeps its own strict policy', (r.headers.get('content-security-policy') || '').includes("default-src 'none'"), true);

    console.log('--- CORS');
    const ok = 'http://localhost:5500';
    r = await raw('GET', '/api/health', { Origin: ok });
    check('A listed origin is allowed', r.headers['access-control-allow-origin'], ok);
    r = await raw('GET', '/api/health', { Origin: 'http://evil.example' });
    check('An unlisted origin gets no permission', r.headers['access-control-allow-origin'], undefined);
    r = await raw('OPTIONS', '/api/staff', { Origin: ok, 'Access-Control-Request-Method': 'PATCH', 'Access-Control-Request-Headers': 'authorization,content-type' });
    check('Preflight from a listed origin', `${r.status} ${r.headers['access-control-allow-origin']}`, `204 ${ok}`);
    check('Preflight allows PATCH and the Authorization header', (r.headers['access-control-allow-methods'] || '').includes('PATCH') && /authorization/i.test(r.headers['access-control-allow-headers'] || ''), true);
    r = await raw('OPTIONS', '/api/staff', { Origin: 'http://evil.example', 'Access-Control-Request-Method': 'PATCH' });
    check('Preflight from an unlisted origin gets no permission', r.headers['access-control-allow-origin'], undefined);

    console.log('--- token safety');
    const noneToken = `${b64u({ alg: 'none', typ: 'JWT' })}.${b64u({ sub: 1, typ: 'user' })}.`;
    check('A token with alg "none" is rejected', (await api('GET', '/api/staff', noneToken)).status, 401);
    const parts = admin.split('.');
    parts[2] = `${parts[2].slice(0, 10)}${parts[2][10] === 'A' ? 'B' : 'A'}${parts[2].slice(11)}`;
    check('A token with a tampered signature is rejected', (await api('GET', '/api/staff', parts.join('.'))).status, 401);
    check('Garbage in the Authorization header', (await api('GET', '/api/staff', 'not.a.token')).status, 401);

    console.log('--- errors never leak internals');
    r = await raw('POST', '/api/auth/login', { 'Content-Type': 'application/json' }, '{bad json');
    check('Malformed JSON gives a clean 400', `${r.status} ${/SyntaxError|node_modules|\sat\s/.test(r.text)}`, '400 false');
    check('...with a JSON error message', typeof JSON.parse(r.text).error, 'string');
    const big = await api('POST', '/api/auth/login', null, { username: 'a', password: 'x'.repeat(200000) });
    check('A body over 100 KB is refused', big.status, 413);
    r = await api('GET', '/api/does-not-exist', null);
    check('Unknown API path is a JSON 404', `${r.status} ${r.json && r.json.error}`, '404 Not found');

    console.log('--- rate limits');
    const probe = `rlprobe${Date.now() % 1000000}`;
    const st = [];
    let last = null;
    for (let i = 0; i < 14; i += 1) {
      last = await api('POST', '/api/auth/login', null, { username: probe, password: 'Wrong@Pass1' });
      st.push(last.status);
    }
    check('Staff login: the first 12 failures are answered normally', st.slice(0, 12).every((s) => s === 401), true);
    check('Staff login: the 13th failure is blocked', st[12], 429);
    check('The block tells the client when to retry', last.headers.get('retry-after') !== null, true);
    check('The block message is clean JSON', typeof (last.json && last.json.error), 'string');
    check('A different username is not affected', (await api('POST', '/api/auth/login', null, { username: `${probe}b`, password: 'x' })).status, 401);
    check('The real administrator can still log in', (await api('POST', '/api/auth/login', null, { username: 'admin', password: 'Admin@2026' })).status, 200);
    const mprobe = `rlprobe${Date.now() % 1000000}@example.com`;
    const ms = [];
    for (let i = 0; i < 13; i += 1) ms.push((await api('POST', '/api/auth/member-login', null, { email: mprobe, password: 'Wrong@Pass1' })).status);
    check('Member login: the first 12 failures are answered normally', ms.slice(0, 12).every((s) => s === 401), true);
    check('Member login: the 13th failure is blocked', ms[12], 429);
    check('A real member can still log in', (await api('POST', '/api/auth/member-login', null, { email: 'ananya.krishnan@example.com', password: 'Ananya@2026' })).status, 200);

    console.log('--- web pages');
    r = await api('GET', '/', null);
    check('The home page is served', `${r.status} ${(r.headers.get('content-type') || '').split(';')[0]} ${r.text.includes('LibraTrack')}`, '200 text/html true');
    r = await api('GET', '/js/health.js', null);
    check('The page script is served', `${r.status} ${/javascript/.test(r.headers.get('content-type') || '')}`, '200 true');
    check('Pages carry the security headers too', (r.headers.get('x-content-type-options') || ''), 'nosniff');
    const leaks = [];
    for (const p of ['/.env', '/backend/.env', '/..%2fbackend%2f.env', '/%2e%2e/backend/.env', '/..%2f..%2fbackend%2fsrc%2fapp.js', '/js/..%2f..%2fbackend%2f.env']) {
      const x = await raw('GET', p);
      if (x.status === 200 || /JWT_SECRET|DB_PASSWORD|require\('express'\)/.test(x.text)) leaks.push(`${p} -> ${x.status}`);
    }
    check('Secrets and source files cannot be fetched (including path tricks)', leaks.length ? leaks.join('; ') : 'none', 'none');
    check('An unknown page is a 404', (await api('GET', '/nothing-here.html', null)).status, 404);

    console.log('--- scheduled expiry job (in this process)');
    const sched = require('../src/services/scheduler');
    check('Scheduler is idle before it is started', sched.isStarted(), false);
    const t1 = sched.start();
    const t2 = sched.start();
    check('It starts, and starting twice creates only one timer', `${sched.isStarted()} ${t1 === t2}`, 'true true');
    sched.stop();
    check('It stops cleanly', sched.isStarted(), false);
    const pq = await api('POST', '/api/payments', admin, { member_id: 15, plan_id: 1, method: 'cash' });
    check('Setup: create a payment request', pq.status, 201);
    if (pq.status === 201) {
      createdPayment = pq.json.payment.request_id;
      await db.execute('UPDATE payment_requests SET expires_at = DATE_SUB(NOW(), INTERVAL 1 DAY) WHERE request_id = ?', [createdPayment]);
      check('Before the job, the overdue request is still pending', await sv('SELECT status FROM payment_requests WHERE request_id = ?', [createdPayment]), 'pending');
      check('The job runs without error', await sched.runExpiryJob(), true);
      const after = await sv('SELECT status FROM payment_requests WHERE request_id = ?', [createdPayment]);
      check(`The overdue request is closed with no traffic at all (status now: ${after})`, after !== 'pending', true);
    }

    console.log('--- access rules of every route');
      const fs = require('fs');
    const pathMod = require('path');
    const appSrc = fs.readFileSync(pathMod.join(__dirname, '..', 'src', 'app.js'), 'utf8');
    const found = new Set();
    const skipped = { n: 0 };
    const re = /app\.use\(\s*'([^']+)'\s*,\s*require\('\.\/routes\/(\w+)'\)\s*\)/g;
    let mt;
    while ((mt = re.exec(appSrc)) !== null) {
      const router = require(`../src/routes/${mt[2]}`);
      if (router && router.stack) collect(router.stack, mt[1], found, skipped);
      else skipped.n += 1;
    }
    const routes = [...found].sort();
    console.log(`     ${routes.length} routes found (${skipped.n} skipped)`);
    check('The route list was read (60 or more routes)', routes.length >= 60, true);
    const PUBLIC = new Set(['POST /api/auth/login', 'POST /api/auth/member-login', 'GET /api/health']);
    const isMemberRoute = (p) => p === '/api/me' || p.startsWith('/api/me/') || p === '/api/auth/member-change-password';
    const fill = (p) => p.replace(/:[A-Za-z_]+\??/g, '99999');
    const bodyFor = (m) => (m === 'GET' ? null : {});

    const open = [];
    for (const rt of routes) {
      if (PUBLIC.has(rt)) continue;
      const [m, p] = rt.split(' ');
      const x = await api(m, fill(p), null, bodyFor(m));
      if (x.status !== 401) open.push(`${rt} -> ${x.status}`);
    }
    check('Every route except login and health refuses a request with no token', open.length ? open.join('; ') : 'none', 'none');

    const memberWrong = [];
    for (const rt of routes) {
      const [m, p] = rt.split(' ');
      if (PUBLIC.has(rt) || isMemberRoute(p)) continue;
      const x = await api(m, fill(p), mem, bodyFor(m));
      if (x.status !== 403) memberWrong.push(`${rt} -> ${x.status}`);
    }
    check('Every staff route refuses a member token', memberWrong.length ? memberWrong.join('; ') : 'none', 'none');

    const staffWrong = [];
    for (const rt of routes) {
      const [m, p] = rt.split(' ');
      if (!isMemberRoute(p)) continue;
      const x = await api(m, fill(p), chn, bodyFor(m));
      if (x.status !== 403) staffWrong.push(`${rt} -> ${x.status}`);
    }
    check('Every member route refuses a staff token', staffWrong.length ? staffWrong.join('; ') : 'none', 'none');

    const adminOnly = [
      ['GET', '/api/staff'], ['GET', '/api/staff/99999'], ['POST', '/api/staff'], ['PATCH', '/api/staff/99999'],
      ['PATCH', '/api/staff/99999/status'], ['POST', '/api/staff/99999/reset-password'], ['PATCH', '/api/settings'],
      ['GET', '/api/audit-logs'], ['GET', '/api/audit-logs/actions'], ['GET', '/api/branches'], ['GET', '/api/branches/99999'],
      ['POST', '/api/branches'], ['PATCH', '/api/branches/99999'], ['PATCH', '/api/branches/99999/status'],
    ];
    const staffOpen = [];
    for (const [m, p] of adminOnly) {
      const x = await api(m, p, chn, bodyFor(m));
      if (x.status !== 403) staffOpen.push(`${m} ${p} -> ${x.status}`);
    }
    check('Every administrator-only route refuses branch staff', staffOpen.length ? staffOpen.join('; ') : 'none', 'none');
    check('Settings can still be read by staff', (await api('GET', '/api/settings', chn)).status, 200);
  }

  async function cleanup() {
    if (createdPayment) {
      try { await db.execute('DELETE FROM payment_requests WHERE request_id = ?', [createdPayment]); } catch (e) { console.log(`cleanup note: ${e.message}`); }
    }
  }

  let crashed = null;
  try {
    await runTests();
  } catch (err) {
    crashed = err;
  }
  await cleanup();
  check('Cleanup: payment requests are back to 18', Number(await sv('SELECT COUNT(*) FROM payment_requests')), 18);
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