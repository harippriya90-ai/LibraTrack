const express = require('express');
const pool = require('../config/db');
const { authenticate } = require('../middleware/auth');
const { branchScope, scopeCondition } = require('../middleware/branchScope');
const { expireStalePayments } = require('../services/paymentExpiry');

const router = express.Router();
const num = (v) => Number(v || 0);
const money = (v) => Number(v || 0).toFixed(2);

// GET /api/dashboard   (admin may add ?branch_id= to look at one branch)
router.get('/', authenticate, branchScope, async (req, res) => {
  try {
    await expireStalePayments();
    const scoped = req.scope.branchId !== null; // always true for staff
    const sc = (col) => scopeCondition(req, col);

    // Book titles
    let bookTitles;
    if (scoped) {
      const c = sc('bi.branch_id');
      const [[t]] = await pool.query(
        `SELECT COUNT(DISTINCT bi.book_id) AS n
           FROM branch_inventory bi JOIN books b ON b.book_id = bi.book_id AND b.is_active = 1
          WHERE ${c.sql}`,
        c.params
      );
      bookTitles = num(t.n);
    } else {
      const [[t]] = await pool.query('SELECT COUNT(*) AS n FROM books WHERE is_active = 1');
      bookTitles = num(t.n);
    }

    // Copies: stock, and stock minus open loans (derived, never stored)
    const cv = sc('va.branch_id');
    const [[copies]] = await pool.query(
      `SELECT COALESCE(SUM(va.total_copies), 0) AS total, COALESCE(SUM(GREATEST(va.available_copies, 0)), 0) AS available
         FROM v_branch_availability va JOIN books b ON b.book_id = va.book_id AND b.is_active = 1
        WHERE ${cv.sql}`,
      cv.params
    );

    const [[ebooks]] = await pool.query('SELECT COUNT(*) AS n FROM ebooks WHERE is_active = 1');

    const cm = sc('m.home_branch_id');
    const [[members]] = await pool.query(`SELECT COUNT(*) AS n FROM members m WHERE ${cm.sql}`, cm.params);
    const [[activeMs]] = await pool.query(
      `SELECT COUNT(DISTINCT ms.member_id) AS n
         FROM memberships ms JOIN members m ON m.member_id = ms.member_id
        WHERE m.is_active = 1 AND CURDATE() BETWEEN ms.start_date AND ms.expiry_date AND ${cm.sql}`,
      cm.params
    );

    // Loans and fines, from the loan view (branch = the branch that lent the book)
    const cl = sc('v.branch_id');
    const [[loans]] = await pool.query(
      `SELECT COUNT(CASE WHEN v.return_date IS NULL THEN 1 END) AS active_loans,
              COUNT(CASE WHEN v.loan_status = 'overdue' THEN 1 END) AS overdue_loans,
              COALESCE(SUM(CASE WHEN v.fine_kind = 'finalized' THEN v.fine_amount END), 0) AS finalized_total,
              COALESCE(SUM(CASE WHEN v.fine_kind = 'estimate' THEN v.fine_amount END), 0) AS estimated_total,
              COALESCE(SUM(GREATEST(v.fine_amount - v.fine_paid, 0)), 0) AS outstanding_total
         FROM v_loan_details v WHERE ${cl.sql}`,
      cl.params
    );

    const cp = sc('pr.branch_id');
    const [[pending]] = await pool.query(
      `SELECT COUNT(*) AS n FROM payment_requests pr WHERE pr.status = 'pending' AND ${cp.sql}`,
      cp.params
    );

    // Recent activity (names and IDs only, never contact details)
    const [recentLoans] = await pool.query(
      `SELECT v.loan_id, mem.full_name AS member_name, bk.title, br.name AS branch_name,
              v.issue_date, v.due_date, v.return_date, v.loan_status
         FROM v_loan_details v
         JOIN members mem ON mem.member_id = v.member_id
         JOIN books bk ON bk.book_id = v.book_id
         JOIN branches br ON br.branch_id = v.branch_id
        WHERE ${cl.sql}
        ORDER BY v.issue_date DESC, v.loan_id DESC LIMIT 5`,
      cl.params
    );
    const [alerts] = await pool.query(
      `SELECT v.loan_id, mem.full_name AS member_name, bk.title, br.name AS branch_name,
              v.due_date, v.overdue_days, v.fine_amount
         FROM v_loan_details v
         JOIN members mem ON mem.member_id = v.member_id
         JOIN books bk ON bk.book_id = v.book_id
         JOIN branches br ON br.branch_id = v.branch_id
        WHERE ${cl.sql} AND v.loan_status = 'overdue'
        ORDER BY v.due_date ASC, v.loan_id ASC LIMIT 5`,
      cl.params
    );
    const [recentMembers] = await pool.query(
      `SELECT m.member_id, m.full_name, b.name AS branch_name, m.registered_on
         FROM members m JOIN branches b ON b.branch_id = m.home_branch_id
        WHERE ${cm.sql}
        ORDER BY m.registered_on DESC, m.member_id DESC LIMIT 5`,
      cm.params
    );
    const [recentPayments] = await pool.query(
      `SELECT pr.request_id, m.full_name AS member_name, p.name AS plan_name, pr.amount, pr.status, pr.requested_at
         FROM payment_requests pr
         JOIN members m ON m.member_id = pr.member_id
         JOIN membership_plans p ON p.plan_id = pr.plan_id
        WHERE ${cp.sql}
        ORDER BY pr.requested_at DESC, pr.request_id DESC LIMIT 5`,
      cp.params
    );

    // Branch-by-branch summary: administrators looking at all branches only
    let branches;
    if (!scoped) {
      const [rows] = await pool.query(
        `SELECT b.branch_id, b.name,
                (SELECT COALESCE(SUM(va.total_copies), 0) FROM v_branch_availability va
                   JOIN books bk ON bk.book_id = va.book_id AND bk.is_active = 1 WHERE va.branch_id = b.branch_id) AS copies,
                (SELECT COALESCE(SUM(GREATEST(va.available_copies, 0)), 0) FROM v_branch_availability va
                   JOIN books bk ON bk.book_id = va.book_id AND bk.is_active = 1 WHERE va.branch_id = b.branch_id) AS available_copies,
                (SELECT COUNT(*) FROM members m WHERE m.home_branch_id = b.branch_id) AS members,
                (SELECT COUNT(*) FROM loans l WHERE l.branch_id = b.branch_id AND l.return_date IS NULL) AS active_loans,
                (SELECT COUNT(*) FROM loans l WHERE l.branch_id = b.branch_id AND l.return_date IS NULL AND l.due_date < CURDATE()) AS overdue_loans,
                (SELECT COUNT(*) FROM payment_requests pr WHERE pr.branch_id = b.branch_id AND pr.status = 'pending') AS pending_payments
           FROM branches b WHERE b.is_active = 1 ORDER BY b.name`
      );
      branches = rows.map((r) => ({
        branch_id: r.branch_id,
        name: r.name,
        copies: num(r.copies),
        available_copies: num(r.available_copies),
        members: num(r.members),
        active_loans: num(r.active_loans),
        overdue_loans: num(r.overdue_loans),
        pending_payments: num(r.pending_payments),
      }));
    }

    let label = 'All branches';
    if (scoped) {
      const [[b]] = await pool.query('SELECT name FROM branches WHERE branch_id = ?', [req.scope.branchId]);
      label = b ? b.name : `Branch ${req.scope.branchId}`;
    }
    const [[now]] = await pool.query('SELECT NOW() AS now');

    const finalized = num(loans.finalized_total);
    const estimated = num(loans.estimated_total);
    res.json({
      generated_at: now.now,
      scope: { branch_id: req.scope.branchId, label },
      stats: {
        book_titles: bookTitles,
        physical_copies: num(copies.total),
        available_copies: num(copies.available),
        ebook_titles: num(ebooks.n),
        registered_members: num(members.n),
        active_memberships: num(activeMs.n),
        active_loans: num(loans.active_loans),
        overdue_loans: num(loans.overdue_loans),
        pending_payment_requests: num(pending.n),
        fines: {
          finalized_total: money(finalized),
          estimated_open_total: money(estimated),
          total_calculated: money(finalized + estimated),
          outstanding: money(loans.outstanding_total),
        },
      },
      recent_loans: recentLoans,
      overdue_alerts: alerts,
      recent_members: recentMembers,
      recent_payment_requests: recentPayments,
      branches,
    });
  } catch (err) {
    console.error('Dashboard error:', err.message);
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
});

module.exports = router;