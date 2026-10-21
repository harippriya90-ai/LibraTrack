const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const pool = require('../config/db'); // loads .env as a side effect

const router = express.Router();

const MAX_ATTEMPTS = 5;
const LOCK_MINUTES = 15;
const GENERIC_FAIL = { error: 'Invalid username or password' };
// Used so unknown usernames take as long to reject as real ones.
const DUMMY_HASH = bcrypt.hashSync('not-a-real-password', 12);

function jwtSecret() {
  const s = process.env.JWT_SECRET;
  if (!s || s.length < 32 || s.startsWith('replace_with')) {
    throw new Error('JWT_SECRET is missing or too weak. Set a long random value in backend/.env');
  }
  return s;
}

async function audit(userId, action, entityId, details) {
  try {
    await pool.execute(
      'INSERT INTO audit_logs (user_id, action, entity_type, entity_id, details) VALUES (?, ?, ?, ?, ?)',
      [userId, action, 'user', entityId, details]
    );
  } catch (err) {
    console.error('Audit log failed:', err.message);
  }
}

router.post('/login', async (req, res) => {
  const { username, password } = req.body || {};
  if (
    typeof username !== 'string' || typeof password !== 'string' ||
    !username.trim() || !password || username.length > 50 || password.length > 200
  ) {
    return res.status(400).json({ error: 'Username and password are required' });
  }
  const uname = username.trim();

  try {
    const [rows] = await pool.execute(
      `SELECT u.user_id, u.username, u.password_hash, u.full_name, u.role, u.branch_id,
              u.is_active, (u.locked_until IS NOT NULL AND u.locked_until > NOW()) AS is_locked,
              b.name AS branch_name, b.is_active AS branch_active
         FROM users u
         LEFT JOIN branches b ON b.branch_id = u.branch_id
        WHERE u.username = ?`,
      [uname]
    );
    const user = rows[0];

    if (!user) {
      await bcrypt.compare(password, DUMMY_HASH);
      await audit(null, 'login_failed', null, `Unknown username: ${uname.slice(0, 50)}`);
      return res.status(401).json(GENERIC_FAIL);
    }

    if (user.is_locked) {
      await audit(user.user_id, 'login_blocked_locked', String(user.user_id), 'Attempt while locked');
      return res.status(429).json({ error: 'Too many failed attempts. Try again in a few minutes.' });
    }

    const passwordOk = await bcrypt.compare(password, user.password_hash);

    if (!passwordOk) {
      // locked_until is assigned first so it sees the old failed_attempts value.
      await pool.execute(
        `UPDATE users
            SET locked_until = IF(failed_attempts + 1 >= ?, DATE_ADD(NOW(), INTERVAL ? MINUTE), locked_until),
                failed_attempts = IF(failed_attempts + 1 >= ?, 0, failed_attempts + 1)
          WHERE user_id = ?`,
        [MAX_ATTEMPTS, LOCK_MINUTES, MAX_ATTEMPTS, user.user_id]
      );
      await audit(user.user_id, 'login_failed', String(user.user_id), 'Wrong password');
      return res.status(401).json(GENERIC_FAIL);
    }

    // Password is correct. Only now say anything about the account state.
    if (!user.is_active) {
      await audit(user.user_id, 'login_rejected_inactive', String(user.user_id), 'Inactive account');
      return res.status(403).json({ error: 'This account is inactive. Contact the administrator.' });
    }
    if (user.role === 'staff' && !user.branch_active) {
      await audit(user.user_id, 'login_rejected_branch', String(user.user_id), 'Branch inactive');
      return res.status(403).json({ error: 'Your branch is inactive. Contact the administrator.' });
    }

    await pool.execute(
      'UPDATE users SET failed_attempts = 0, locked_until = NULL, last_login_at = NOW() WHERE user_id = ?',
      [user.user_id]
    );

    const token = jwt.sign(
      { typ: 'user', role: user.role, branch_id: user.branch_id },
      jwtSecret(),
      { subject: String(user.user_id), expiresIn: process.env.JWT_EXPIRES_IN || '8h' }
    );

    await audit(user.user_id, 'login_success', String(user.user_id), 'Login OK');

    res.json({
      token,
      user: {
        user_id: user.user_id,
        username: user.username,
        full_name: user.full_name,
        role: user.role,
        branch_id: user.branch_id,
        branch_name: user.role === 'admin' ? 'Central Administrator' : user.branch_name,
      },
    });
  } catch (err) {
    console.error('Login error:', err.message);
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
});

module.exports = router;