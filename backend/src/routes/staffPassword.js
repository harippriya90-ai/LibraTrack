const express = require('express');
const bcrypt = require('bcryptjs');
const pool = require('../config/db');
const { authenticate } = require('../middleware/auth');
const { logAudit } = require('../services/dbHelpers');
const { checkNewPassword } = require('../services/passwords');

const router = express.Router();
const MAX_ATTEMPTS = 5;
const LOCK_MINUTES = 15;

// POST /api/auth/change-password   (staff and administrators; also works while a change is forced)
router.post('/change-password', authenticate, async (req, res) => {
  const { current_password: current, new_password: next } = req.body || {};
  if (typeof current !== 'string' || !current) {
    return res.status(400).json({ error: 'Current password and new password are required' });
  }
  const problem = checkNewPassword(next, current, req.user.username);
  if (problem) return res.status(400).json({ error: problem });

  const userId = req.user.user_id;
  try {
    const [rows] = await pool.execute(
      `SELECT password_hash, (locked_until IS NOT NULL AND locked_until > NOW()) AS is_locked
         FROM users WHERE user_id = ?`,
      [userId]
    );
    const u = rows[0];
    if (!u) return res.status(401).json({ error: 'Session expired or invalid. Please log in again.' });
    if (u.is_locked) {
      return res.status(429).json({ error: 'Too many failed attempts. Try again in a few minutes.' });
    }

    if (!(await bcrypt.compare(current, u.password_hash))) {
      // Wrong current passwords count toward the same lockout as login.
      await pool.execute(
        `UPDATE users
            SET locked_until = IF(failed_attempts + 1 >= ?, DATE_ADD(NOW(), INTERVAL ? MINUTE), locked_until),
                failed_attempts = IF(failed_attempts + 1 >= ?, 0, failed_attempts + 1)
          WHERE user_id = ?`,
        [MAX_ATTEMPTS, LOCK_MINUTES, MAX_ATTEMPTS, userId]
      );
      return res.status(400).json({ error: 'Current password is incorrect' });
    }

    const hash = await bcrypt.hash(next, 12);
    await pool.execute(
      `UPDATE users
          SET password_hash = ?, must_change_password = 0, password_changed_at = NOW(),
              failed_attempts = 0, locked_until = NULL
        WHERE user_id = ?`,
      [hash, userId]
    );
    await logAudit(pool, userId, 'password_changed', 'user', userId, null);
    res.json({ message: 'Password changed' });
  } catch (err) {
    console.error('Change password error:', err.message);
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
});

module.exports = router;