const express = require('express');
const { authenticate } = require('../middleware/auth');

const router = express.Router();

router.get('/me', authenticate, (req, res) => {
  const u = req.user;
  res.json({
    user: {
      user_id: u.user_id,
      username: u.username,
      full_name: u.full_name,
      role: u.role,
      branch_id: u.branch_id,
      branch_name: u.role === 'admin' ? 'Central Administrator' : u.branch_name,
      must_change_password: u.must_change_password,
    },
  });
});

module.exports = router;