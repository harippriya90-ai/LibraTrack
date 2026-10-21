const express = require('express');
const pool = require('../config/db');
const { authenticate } = require('../middleware/auth');
const { branchScope, scopeCondition } = require('../middleware/branchScope');

const router = express.Router();
const PAGE_SIZE = 10;
const STATUSES = ['active', 'inactive', 'suspended', 'restricted'];

function escapeLike(s) {
  return s.replace(/[\\%_]/g, '\\$&');
}

// GET /api/members?page=1&search=&status=&branch_id=   (branch_id only narrows for admin)
router.get('/', authenticate, branchScope, async (req, res) => {
  try {
    const conds = [];
    const params = [];

    const sc = scopeCondition(req, 'm.home_branch_id');
    conds.push(sc.sql);
    params.push(...sc.params);

    const search = typeof req.query.search === 'string' ? req.query.search.trim().slice(0, 100) : '';
    if (search) {
      const like = `%${escapeLike(search)}%`;
      conds.push('(m.full_name LIKE ? OR m.email LIKE ? OR m.phone LIKE ?)');
      params.push(like, like, like);
    }

    const status = req.query.status;
    if (status !== undefined && status !== '') {
      if (!STATUSES.includes(status)) {
        return res.status(400).json({ error: 'Invalid status filter' });
      }
      conds.push('vs.effective_status = ?');
      params.push(status);
    }

    const page = Math.min(1000000, Math.max(1, parseInt(req.query.page, 10) || 1));
    const where = conds.join(' AND ');

    const [[{ total }]] = await pool.query(
      `SELECT COUNT(*) AS total
         FROM members m
         JOIN v_member_status vs ON vs.member_id = m.member_id
        WHERE ${where}`,
      params
    );

    const [rows] = await pool.query(
      `SELECT m.member_id, m.full_name, m.email, m.phone, m.home_branch_id,
              b.name AS branch_name, m.registered_on, vs.effective_status,
              (SELECT MAX(ms.expiry_date) FROM memberships ms WHERE ms.member_id = m.member_id) AS membership_expiry,
              (SELECT pr.status FROM payment_requests pr
                WHERE pr.member_id = m.member_id
                ORDER BY pr.requested_at DESC, pr.request_id DESC LIMIT 1) AS payment_status
         FROM members m
         JOIN branches b ON b.branch_id = m.home_branch_id
         JOIN v_member_status vs ON vs.member_id = m.member_id
        WHERE ${where}
        ORDER BY m.full_name
        LIMIT ? OFFSET ?`,
      [...params, PAGE_SIZE, (page - 1) * PAGE_SIZE]
    );

    res.json({
      data: rows,
      page,
      page_size: PAGE_SIZE,
      total,
      total_pages: Math.ceil(total / PAGE_SIZE),
    });
  } catch (err) {
    console.error('Members list error:', err.message);
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
});

// GET /api/members/:id
router.get('/:id', authenticate, branchScope, async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id < 1) {
    return res.status(400).json({ error: 'Member ID must be a positive whole number' });
  }

  try {
    const [rows] = await pool.execute(
      `SELECT m.member_id, m.full_name, m.email, m.phone, m.home_branch_id,
              b.name AS branch_name, m.registered_on, m.is_active, vs.effective_status
         FROM members m
         JOIN branches b ON b.branch_id = m.home_branch_id
         JOIN v_member_status vs ON vs.member_id = m.member_id
        WHERE m.member_id = ?`,
      [id]
    );
    const member = rows[0];
    if (!member) {
      return res.status(404).json({ error: 'Member not found' });
    }

    // Ownership check against the database value, not anything the client sent.
    if (req.user.role === 'staff' && member.home_branch_id !== req.user.branch_id) {
      return res.status(403).json({ error: 'This member belongs to another branch' });
    }

    const [memberships] = await pool.execute(
      `SELECT ms.membership_id, p.name AS plan_name, ms.start_date, ms.expiry_date,
              ms.duration_months, ms.fee_paid, ms.renewal_of_id
         FROM memberships ms
         JOIN membership_plans p ON p.plan_id = ms.plan_id
        WHERE ms.member_id = ?
        ORDER BY ms.start_date DESC`,
      [id]
    );

    res.json({ member, memberships });
  } catch (err) {
    console.error('Member detail error:', err.message);
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
});

module.exports = router;