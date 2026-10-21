const express = require('express');
const pool = require('../config/db');
const { authenticateMember } = require('../middleware/auth');

const router = express.Router();
const PAGE_SIZE = 10;
const LOAN_STATUSES = ['active', 'overdue', 'returned'];

function getPage(req) {
  return Math.min(1000000, Math.max(1, parseInt(req.query.page, 10) || 1));
}

function serverError(res, label, err) {
  console.error(`${label}:`, err.message);
  res.status(500).json({ error: 'Something went wrong. Please try again.' });
}

// GET /api/me : the logged-in member's own profile. No ID is accepted from the client.
router.get('/', authenticateMember, async (req, res) => {
  const memberId = req.member.member_id;
  try {
    const [rows] = await pool.execute(
      `SELECT m.member_id, m.full_name, m.email, m.phone, b.name AS branch_name,
              m.registered_on, vs.effective_status AS status
         FROM members m
         JOIN branches b ON b.branch_id = m.home_branch_id
         JOIN v_member_status vs ON vs.member_id = m.member_id
        WHERE m.member_id = ?`,
      [memberId]
    );

    const [ms] = await pool.execute(
      `SELECT p.name AS plan_name, x.start_date, x.expiry_date, x.max_loans, x.loan_days
         FROM memberships x
         JOIN membership_plans p ON p.plan_id = x.plan_id
        WHERE x.member_id = ? AND CURDATE() BETWEEN x.start_date AND x.expiry_date
        ORDER BY x.expiry_date DESC
        LIMIT 1`,
      [memberId]
    );

    // Members see only when a suspension ends, not the incident details.
    const [sus] = await pool.execute(
      `SELECT MAX(end_date) AS ends
         FROM member_restrictions
        WHERE member_id = ? AND kind = 'suspension' AND revoked_at IS NULL
          AND CURDATE() BETWEEN start_date AND end_date`,
      [memberId]
    );

    res.json({
      member: rows[0],
      current_membership: ms[0] || null,
      suspension_ends: sus[0].ends || null,
    });
  } catch (err) {
    serverError(res, 'Me error', err);
  }
});

// GET /api/me/loans?page=1&status=overdue
router.get('/loans', authenticateMember, async (req, res) => {
  const memberId = req.member.member_id;
  try {
    const conds = ['v.member_id = ?'];
    const params = [memberId];

    const status = req.query.status;
    if (status !== undefined && status !== '') {
      if (!LOAN_STATUSES.includes(status)) {
        return res.status(400).json({ error: 'Invalid status filter' });
      }
      conds.push('v.loan_status = ?');
      params.push(status);
    }

    const page = getPage(req);
    const where = conds.join(' AND ');

    const [[{ total }]] = await pool.query(
      `SELECT COUNT(*) AS total FROM v_loan_details v WHERE ${where}`,
      params
    );

    const [rows] = await pool.query(
      `SELECT v.loan_id, bk.title, bk.author, bk.edition, br.name AS branch_name,
              v.issue_date, v.due_date, v.return_date, v.loan_status, v.overdue_days,
              v.fine_rate_snapshot AS fine_rate, v.fine_kind, v.fine_amount, v.fine_paid,
              GREATEST(v.fine_amount - v.fine_paid, 0) AS fine_balance
         FROM v_loan_details v
         JOIN books bk ON bk.book_id = v.book_id
         JOIN branches br ON br.branch_id = v.branch_id
        WHERE ${where}
        ORDER BY v.issue_date DESC, v.loan_id DESC
        LIMIT ? OFFSET ?`,
      [...params, PAGE_SIZE, (page - 1) * PAGE_SIZE]
    );

    // Summary covers all of this member's loans, not just the current page or filter.
    const [[s]] = await pool.execute(
      `SELECT COUNT(CASE WHEN loan_status IN ('active','overdue') THEN 1 END) AS open_loans,
              COUNT(CASE WHEN loan_status = 'overdue' THEN 1 END) AS overdue_loans,
              COALESCE(SUM(CASE WHEN fine_kind = 'finalized' THEN GREATEST(fine_amount - fine_paid, 0) END), 0) AS finalized_outstanding,
              COALESCE(SUM(CASE WHEN fine_kind = 'estimate'  THEN GREATEST(fine_amount - fine_paid, 0) END), 0) AS estimated_outstanding
         FROM v_loan_details
        WHERE member_id = ?`,
      [memberId]
    );

    res.json({
      data: rows,
      page,
      page_size: PAGE_SIZE,
      total,
      total_pages: Math.ceil(total / PAGE_SIZE),
      summary: {
        open_loans: Number(s.open_loans),
        overdue_loans: Number(s.overdue_loans),
        finalized_outstanding: Number(s.finalized_outstanding),
        estimated_outstanding: Number(s.estimated_outstanding),
      },
    });
  } catch (err) {
    serverError(res, 'Me loans error', err);
  }
});

// GET /api/me/memberships : own membership history, newest first
router.get('/memberships', authenticateMember, async (req, res) => {
  try {
    const [rows] = await pool.execute(
      `SELECT x.membership_id, p.name AS plan_name, x.start_date, x.expiry_date,
              x.duration_months, x.fee_paid, x.renewal_of_id,
              (CURDATE() BETWEEN x.start_date AND x.expiry_date) AS is_current
         FROM memberships x
         JOIN membership_plans p ON p.plan_id = x.plan_id
        WHERE x.member_id = ?
        ORDER BY x.start_date DESC`,
      [req.member.member_id]
    );
    res.json({ data: rows.map((r) => ({ ...r, is_current: !!r.is_current })) });
  } catch (err) {
    serverError(res, 'Me memberships error', err);
  }
});

// GET /api/me/payments?page=1 : own membership payment requests (no staff identities shown)
router.get('/payments', authenticateMember, async (req, res) => {
  const memberId = req.member.member_id;
  try {
    const page = getPage(req);

    const [[{ total }]] = await pool.execute(
      'SELECT COUNT(*) AS total FROM payment_requests WHERE member_id = ?',
      [memberId]
    );

    const [rows] = await pool.query(
      `SELECT pr.request_id, pr.request_type, p.name AS plan_name, pr.amount, pr.method,
              pr.status, pr.submitted_txn_id, pr.requested_at, pr.expires_at,
              pr.verified_at, pr.rejection_reason,
              (pr.proof_stored_name IS NOT NULL) AS has_proof
         FROM payment_requests pr
         JOIN membership_plans p ON p.plan_id = pr.plan_id
        WHERE pr.member_id = ?
        ORDER BY pr.requested_at DESC, pr.request_id DESC
        LIMIT ? OFFSET ?`,
      [memberId, PAGE_SIZE, (page - 1) * PAGE_SIZE]
    );

    res.json({
      data: rows.map((r) => ({ ...r, has_proof: !!r.has_proof })),
      page,
      page_size: PAGE_SIZE,
      total,
      total_pages: Math.ceil(total / PAGE_SIZE),
    });
  } catch (err) {
    serverError(res, 'Me payments error', err);
  }
});

module.exports = router;