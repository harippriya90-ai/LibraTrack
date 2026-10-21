const path = require('path');
const express = require('express');
const helmet = require('helmet');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const pool = require('./config/db');

const app = express();
app.disable('x-powered-by');

const posInt = (v, d) => {
  const n = Number(v);
  return Number.isInteger(n) && n > 0 ? n : d;
};

// ---------- security headers ----------
app.use(helmet({
  contentSecurityPolicy: {
    useDefaults: false,
    directives: {
      'default-src': ["'self'"],
      'script-src': ["'self'"],
      'style-src': ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
      'font-src': ["'self'", 'https://fonts.gstatic.com', 'data:'],
      'img-src': ["'self'", 'data:', 'blob:'],
      'connect-src': ["'self'"],
      'object-src': ["'none'"],
      'base-uri': ["'self'"],
      'form-action': ["'self'"],
      'frame-ancestors': ["'none'"],
    },
  },
  crossOriginResourcePolicy: { policy: 'same-site' },
  referrerPolicy: { policy: 'no-referrer' },
}));

// ---------- CORS: only listed origins may call the API from a browser ----------
const ALLOWED_ORIGINS = (process.env.CORS_ORIGINS ||
  'http://localhost:3000,http://127.0.0.1:3000,http://localhost:5500,http://127.0.0.1:5500')
  .split(',').map((s) => s.trim()).filter(Boolean);
app.use(cors({
  origin: (origin, cb) => cb(null, !origin || ALLOWED_ORIGINS.includes(origin)),
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'],
  allowedHeaders: ['Authorization', 'Content-Type'],
  exposedHeaders: ['Content-Disposition', 'X-Report-Generated', 'X-Report-Period', 'Retry-After'],
  maxAge: 600,
}));

// API responses are never cached unless a route says otherwise.
app.use('/api', (req, res, next) => {
  res.set('Cache-Control', 'no-store');
  next();
});

app.use(express.json({ limit: '100kb' }));

// ---------- rate limits ----------
function limiter({ windowMs, limit, message, skipSuccess, key, skip }) {
  return rateLimit({
    windowMs,
    limit,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    skipSuccessfulRequests: !!skipSuccess,
    skip,
    keyGenerator: key || ((req) => req.ip),
    handler: (req, res) => res.status(429).json({ error: message }),
  });
}
const loginKey = (req) => {
  const b = req.body || {};
  return `${req.ip}|${String(b.username || b.email || '').toLowerCase().slice(0, 100)}`;
};
const LOGIN_MSG = 'Too many failed attempts. Please wait and try again later.';
const loginFailLimit = posInt(process.env.LOGIN_FAIL_LIMIT, 12);

app.use('/api', limiter({
  windowMs: 60 * 1000,
  limit: posInt(process.env.GLOBAL_RATE_LIMIT, 1000),
  message: 'Too many requests. Please slow down.',
  skip: (req) => req.path === '/health',
}));
app.use('/api/auth/login', limiter({
  windowMs: 15 * 60 * 1000, limit: loginFailLimit, skipSuccess: true, key: loginKey, message: LOGIN_MSG,
}));
app.use('/api/auth/member-login', limiter({
  windowMs: 15 * 60 * 1000, limit: loginFailLimit, skipSuccess: true, key: loginKey, message: LOGIN_MSG,
}));
app.use(['/api/auth/change-password', '/api/auth/member-change-password'], limiter({
  windowMs: 15 * 60 * 1000, limit: 30, skipSuccess: true, message: LOGIN_MSG,
}));

// ---------- API ----------
app.get('/api/health', async (req, res) => {
  try {
    const [rows] = await pool.query('SELECT COUNT(*) AS branches FROM branches');
    res.json({
      status: 'ok',
      database: 'connected',
      branches: rows[0].branches,
      serverTime: new Date().toISOString(),
    });
  } catch (err) {
    console.error('Health check failed:', err.message);
    res.status(503).json({ status: 'error', database: 'unavailable' });
  }
});

app.use('/api/auth', require('./routes/auth'));
app.use('/api/auth', require('./routes/memberAuth'));
app.use('/api/auth', require('./routes/memberPassword'));
app.use('/api/auth', require('./routes/staffPassword'));
app.use('/api/auth', require('./routes/session'));
app.use('/api/staff', require('./routes/staff'));
app.use('/api/settings', require('./routes/settings'));
app.use('/api/audit-logs', require('./routes/auditLogs'));
app.use('/api/branches', require('./routes/branches'));
app.use('/api/branches', require('./routes/branchesAdmin'));
app.use('/api/members', require('./routes/members'));
app.use('/api/members', require('./routes/membersWrite'));
app.use('/api/books', require('./routes/books'));
app.use('/api/books', require('./routes/bookDetail'));
app.use('/api/plans', require('./routes/plans'));
app.use('/api/payments', require('./routes/payments'));
app.use('/api/payments', require('./routes/paymentsReview'));
app.use('/api/payments', require('./routes/paymentsProof'));
app.use('/api/payments', require('./routes/paymentsQr'));
app.use('/api/loans', require('./routes/loans'));
app.use('/api/loans', require('./routes/loansList'));
app.use('/api/loans', require('./routes/loansReturn'));
app.use('/api', require('./routes/fines'));
app.use('/api', require('./routes/incidents'));
app.use('/api/dashboard', require('./routes/dashboard'));
app.use('/api/reports', require('./routes/reportsLoans'));
app.use('/api/reports', require('./routes/reportsMore'));
app.use('/api/reports', require('./routes/reportsOps'));
app.use('/api/reports', require('./routes/reportsActivity'));
app.use('/api', require('./routes/memberHistory'));
app.use('/api/me', require('./routes/me'));
app.use('/api/me', require('./routes/meCatalogue'));
app.use('/api/me', require('./routes/meEbookFiles'));

// ---------- web pages: only the frontend folder is ever served ----------
app.use(express.static(path.join(__dirname, '..', '..', 'frontend'), {
  index: 'index.html',
  dotfiles: 'ignore',
}));

app.use((req, res) => {
  res.status(404).json({ error: 'Not found' });
});

// ---------- last-resort error handler: no stack traces, no internals ----------
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  if (res.headersSent) return next(err);
  if (err && err.type === 'entity.parse.failed') return res.status(400).json({ error: 'The request body is not valid JSON' });
  if (err && err.type === 'entity.too.large') return res.status(413).json({ error: 'The request body is too large' });
  if (err && typeof err.code === 'string' && err.code.startsWith('LIMIT_')) {
    return res.status(400).json({ error: 'The upload is too large or not allowed' });
  }
  console.error('Unhandled error:', err && err.message);
  return res.status(500).json({ error: 'Something went wrong. Please try again.' });
});

// ---------- background job: expire stale payment requests ----------
if (process.env.DISABLE_SCHEDULER !== '1') require('./services/scheduler').start();

module.exports = app;