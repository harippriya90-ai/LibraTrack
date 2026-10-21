const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const pool = require('../config/db');
const { SECRET } = require('../middleware/auth');

const router = express.Router();

const MAX_ATTEMPTS = 5;
const LOCK_MINUTES = 15;
const GENERIC_FAIL = { error: 'Invalid email or password' };
const DUMMY_HASH = bcrypt.hashSync('not-a-real-password', 12);
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

async function audit(memberId, action, details) {
  try {
    await pool.execute(
      'INSERT INTO audit_logs (user_id, action, entity_type, entity_id, details) VALUES (NULL, ?, ?, ?, ?)',
      [action, 'member', memberId === null ? null : String(memberId), details]
    );
  } catch (err) {
    console.error('Audit log failed:', err.message);
  }
}

router.post('/member-login', async (req, res) => {
  const { email, password } = req.body || {};
  if (typeof email !== 'string' || typeof password !== 'string' || !email.trim() || !password) {
    return res.status(400).json({ error: 'Email and password are required' });
  }
  const em = email.trim();
  if (em.length > 120 || password.length > 200 || !EMAIL_RE.test(em)) {
    return res.status(400).json({ error: 'Enter a valid email address and password' });
  }

  try {
    const [rows] = await pool.execute(
      `SELECT m.member_id, m.full_name, m.email, m.is_active AS member_active,
              ma.password_hash, ma.is_active AS account_active, ma.must_change_password,
              (ma.locked_until IS NOT NULL AND ma.locked_until > NOW()) AS is_locked
         FROM members m
         JOIN member_accounts ma ON ma.member_id = m.member_id
        WHERE m.email = ?`,
      [em]
    );
    const m = rows[0];

    if (!m) {
      await bcrypt.compare(password, DUMMY_HASH); // same timing as a real check
      await audit(null, 'member_login_failed', 'Unknown email or no account');
      return res.status(401).json(GENERIC_FAIL);
    }

    if (m.is_locked) {
      await audit(m.member_id, 'member_login_blocked_locked', 'Attempt while locked');
      return res.status(429).json({ error: 'Too many failed attempts. Try again in a few minutes.' });
    }

    const ok = await bcrypt.compare(password, m.password_hash);
    if (!ok) {
      await pool.execute(
        `UPDATE member_accounts
            SET locked_until = IF(failed_attempts + 1 >= ?, DATE_ADD(NOW(), INTERVAL ? MINUTE), locked_until),
                failed_attempts = IF(failed_attempts + 1 >= ?, 0, failed_attempts + 1)
          WHERE member_id = ?`,
        [MAX_ATTEMPTS, LOCK_MINUTES, MAX_ATTEMPTS, m.member_id]
      );
      await audit(m.member_id, 'member_login_failed', 'Wrong password');
      return res.status(401).json(GENERIC_FAIL);
    }

    if (!m.account_active || !m.member_active) {
      await audit(m.member_id, 'member_login_rejected_inactive', 'Inactive account');
      return res.status(403).json({ error: 'This account is inactive. Please contact the library.' });
    }

    await pool.execute(
      'UPDATE member_accounts SET failed_attempts = 0, locked_until = NULL, last_login_at = NOW() WHERE member_id = ?',
      [m.member_id]
    );

    const token = jwt.sign(
      { typ: 'member' },
      SECRET,
      { subject: String(m.member_id), expiresIn: process.env.JWT_EXPIRES_IN || '8h' }
    );

    await audit(m.member_id, 'member_login_success', 'Login OK');

    res.json({
      token,
      member: { member_id: m.member_id, full_name: m.full_name, email: m.email },
      must_change_password: !!m.must_change_password,
    });
  } catch (err) {
    console.error('Member login error:', err.message);
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
});

module.exports = router;