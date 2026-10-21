const express = require('express');
const pool = require('../config/db');
const { authenticate, requireRole } = require('../middleware/auth');

const router = express.Router();

router.get('/', authenticate, requireRole('admin'), async (req, res) => {
  try {
    const [rows] = await pool.query(
      'SELECT branch_id, name, address, phone, email, is_active FROM branches ORDER BY name'
    );
    res.json({ data: rows });
  } catch (err) {
    console.error('Branches error:', err.message);
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
});

module.exports = router;