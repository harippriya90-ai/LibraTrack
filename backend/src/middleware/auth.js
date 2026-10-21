const jwt = require('jsonwebtoken');
const pool = require('../config/db'); // loads .env as a side effect

function loadSecret() {
  const s = process.env.JWT_SECRET;
  if (!s || s.length < 32 || s.startsWith('replace_with')) {
    throw new Error('JWT_SECRET is missing or too weak. Set a long random value in backend/.env');
  }
  return s;
}
const SECRET = loadSecret(); // fails at startup, not at the first request

// While an account must change its password, only these requests are accepted.
const USER_ALLOWED_WHEN_MUST_CHANGE = ['/api/auth/me', '/api/auth/change-password'];
const MEMBER_ALLOWED_WHEN_MUST_CHANGE = ['/api/auth/member-change-password', '/api/me'];
const MUST_CHANGE_BODY = {
  error: 'You must change your password before continuing.',
  code: 'PASSWORD_CHANGE_REQUIRED',
};
function pathOf(req) {
  return String(req.originalUrl || '').split('?')[0].replace(/\/+$/, '');
}

function readToken(req) {
  const [scheme, token] = (req.headers.authorization || '').split(' ');
  if (scheme !== 'Bearer' || !token) return { error: 'missing' };
  try {
    return { payload: jwt.verify(token, SECRET, { algorithms: ['HS256'] }) };
  } catch (err) {
    return { error: 'invalid' };
  }
}

function rejectToken(res, error) {
  if (error === 'missing') return res.status(401).json({ error: 'Authentication required' });
  return res.status(401).json({ error: 'Session expired or invalid. Please log in again.' });
}

// Staff / admin routes
async function authenticate(req, res, next) {
  const t = readToken(req);
  if (t.error) return rejectToken(res, t.error);

  // Member tokens must never work on staff routes.
  if (t.payload.typ !== 'user') {
    return res.status(403).json({ error: 'This area is for staff accounts only' });
  }

  const userId = Number(t.payload.sub);
  if (!Number.isInteger(userId)) return rejectToken(res, 'invalid');

  try {
    const [rows] = await pool.execute(
      `SELECT u.user_id, u.username, u.full_name, u.role, u.branch_id, u.is_active, u.must_change_password,
              b.name AS branch_name, b.is_active AS branch_active
         FROM users u
         LEFT JOIN branches b ON b.branch_id = u.branch_id
        WHERE u.user_id = ?`,
      [userId]
    );
    const u = rows[0];
    if (!u || !u.is_active || (u.role === 'staff' && !u.branch_active)) {
      return res.status(401).json({ error: 'This account is no longer active. Please log in again.' });
    }
    // A temporary password must be replaced before anything else works.
    if (u.must_change_password && !USER_ALLOWED_WHEN_MUST_CHANGE.includes(pathOf(req))) {
      return res.status(403).json(MUST_CHANGE_BODY);
    }
    // Role and branch come from the database, never from the token or the request.
    req.user = {
      user_id: u.user_id,
      username: u.username,
      full_name: u.full_name,
      role: u.role,
      branch_id: u.branch_id,
      branch_name: u.branch_name,
      must_change_password: !!u.must_change_password,
    };
    next();
  } catch (err) {
    console.error('Authenticate error:', err.message);
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
}

// Member routes (/api/me/...)
async function authenticateMember(req, res, next) {
  const t = readToken(req);
  if (t.error) return rejectToken(res, t.error);

  // Staff tokens must never work on member routes.
  if (t.payload.typ !== 'member') {
    return res.status(403).json({ error: 'This area is for member accounts only' });
  }

  const memberId = Number(t.payload.sub);
  if (!Number.isInteger(memberId)) return rejectToken(res, 'invalid');

  try {
    const [rows] = await pool.execute(
      `SELECT m.member_id, m.full_name, m.email, m.home_branch_id,
              m.is_active AS member_active, ma.is_active AS account_active, ma.must_change_password
         FROM members m
         JOIN member_accounts ma ON ma.member_id = m.member_id
        WHERE m.member_id = ?`,
      [memberId]
    );
    const m = rows[0];
    if (!m || !m.member_active || !m.account_active) {
      return res.status(401).json({ error: 'This account is no longer active. Please log in again.' });
    }
    if (m.must_change_password && !MEMBER_ALLOWED_WHEN_MUST_CHANGE.includes(pathOf(req))) {
      return res.status(403).json(MUST_CHANGE_BODY);
    }
    // The member ID used by every /api/me query comes from here and nowhere else.
    req.member = {
      member_id: m.member_id,
      full_name: m.full_name,
      email: m.email,
      home_branch_id: m.home_branch_id,
      must_change_password: !!m.must_change_password,
    };
    next();
  } catch (err) {
    console.error('Authenticate member error:', err.message);
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
}

function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.user || !roles.includes(req.user.role)) {
      return res.status(403).json({ error: 'You do not have permission to do this' });
    }
    next();
  };
}

module.exports = { authenticate, authenticateMember, requireRole, SECRET }; 