const express = require('express');
const bcrypt = require('bcryptjs');
const pool = require('../config/db');
const { authenticateMember } = require('../middleware/auth');
const { logAudit } = require('../services/dbHelpers');

const router = express.Router();

// POST /api/auth/member-change-password
router.post('/member-change-password', authenticateMember, async (req, res) => {
  const { current_password, new_password } = req.body || {};
  if (typeof current_password !== 'string' || typeof new_password !== 'string' || !current_password) {
    return res.status(400).json({ error: 'Current password and new password are required' });
  }
  if (
    new_password.length < 8 ||
    Buffer.byteLength(new_password) > 72 ||
    !/[A-Za-z]/.test(new_password) ||
    !/\d/.test(new_password)
  ) {
    return res.status(400).json({ error: 'New password must be 8-72 characters and include at least one letter and one number' });
  }
  if (new_password === current_password) {
    return res.status(400).json({ error: 'New password must be different from the current password' });
  }

  const memberId = req.member.member_id;
  try {
    const [rows] = await pool.execute('SELECT password_hash FROM member_accounts WHERE member_id = ?', [memberId]);
    if (!rows[0] || !(await bcrypt.compare(current_password, rows[0].password_hash))) {
      return res.status(400).json({ error: 'Current password is incorrect' });
    }
    const hash = await bcrypt.hash(new_password, 12);
    await pool.execute(
      `UPDATE member_accounts
          SET password_hash = ?, must_change_password = 0, password_changed_at = NOW(),
              failed_attempts = 0, locked_until = NULL
        WHERE member_id = ?`,
      [hash, memberId]
    );
    await logAudit(pool, null, 'member_password_changed', 'member', memberId, null);
    res.json({ message: 'Password changed' });
  } catch (err) {
    console.error('Member change password error:', err.message);
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
});

module.exports = router;