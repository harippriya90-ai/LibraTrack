const express = require('express');
const pool = require('../config/db');
const { authenticate } = require('../middleware/auth');
const { branchScope, scopeCondition } = require('../middleware/branchScope');
const { logAudit } = require('../services/dbHelpers');
const { toCsv } = require('../services/csv');
const { expireStalePayments } = require('../services/paymentExpiry');

const router = express.Router();
const PAGE_SIZE = 10;
const MAX_SPAN_DAYS = 3660;

const present = (v) => v !== undefined && v !== '';
const num = (v) => Number(v || 0);
const money = (v) => Number(v || 0).toFixed(2);
function isValidDate(s) {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const [y, m, d] = s.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

// One row per branch. Period figures use the from/to dates (each pair appears 9 times below);
// "now" figures are a snapshot of today.
const SQL = `SELECT b.branch_id, b.name AS branch_name,
  (SELECT COUNT(*) FROM loans l WHERE l.branch_id = b.branch_id AND l.issue_date BETWEEN ? AND ?) AS loans_issued,
  (SELECT COUNT(*) FROM loans l WHERE l.branch_id = b.branch_id AND l.return_date BETWEEN ? AND ?) AS loans_returned,
  (SELECT COUNT(*) FROM loans l JOIN loan_fines lf ON lf.loan_id = l.loan_id
    WHERE l.branch_id = b.branch_id AND l.return_date BETWEEN ? AND ? AND lf.overdue_days > 0) AS returned_late,
  (SELECT COUNT(*) FROM loans l WHERE l.branch_id = b.branch_id AND l.return_date IS NULL AND l.due_date < CURDATE()) AS overdue_now,
  (SELECT COALESCE(SUM(lf.calculated_amount), 0) FROM loan_fines lf JOIN loans l ON l.loan_id = lf.loan_id
    WHERE l.branch_id = b.branch_id AND lf.waived = 0
      AND lf.finalized_at >= ? AND lf.finalized_at < DATE_ADD(?, INTERVAL 1 DAY)) AS fines_finalized,
  (SELECT COALESCE(SUM(fp.amount), 0) FROM fine_payments fp JOIN loans l ON l.loan_id = fp.loan_id
    WHERE l.branch_id = b.branch_id AND fp.status = 'successful'
      AND fp.paid_at >= ? AND fp.paid_at < DATE_ADD(?, INTERVAL 1 DAY)) AS fines_collected,
  (SELECT COUNT(*) FROM members m WHERE m.home_branch_id = b.branch_id AND m.registered_on BETWEEN ? AND ?) AS new_members,
  (SELECT COUNT(*) FROM payment_requests pr WHERE pr.branch_id = b.branch_id AND pr.status = 'successful'
    AND pr.verified_at >= ? AND pr.verified_at < DATE_ADD(?, INTERVAL 1 DAY)) AS payments_verified,
  (SELECT COALESCE(SUM(pr.amount), 0) FROM payment_requests pr WHERE pr.branch_id = b.branch_id AND pr.status = 'successful'
    AND pr.verified_at >= ? AND pr.verified_at < DATE_ADD(?, INTERVAL 1 DAY)) AS payments_verified_amount,
  (SELECT COUNT(*) FROM payment_requests pr WHERE pr.branch_id = b.branch_id AND pr.status = 'pending') AS payments_pending_now,
  (SELECT COUNT(*) FROM incidents i WHERE i.branch_id = b.branch_id
    AND i.reported_at >= ? AND i.reported_at < DATE_ADD(?, INTERVAL 1 DAY)) AS incidents_reported
FROM branches b
WHERE b.is_active = 1 AND`;

const COUNT_KEYS = ['loans_issued', 'loans_returned', 'returned_late', 'overdue_now', 'new_members', 'payments_verified', 'payments_pending_now', 'incidents_reported'];
const MONEY_KEYS = ['fines_finalized', 'fines_collected', 'payments_verified_amount'];

function shapeRow(r) {
  const out = { branch_id: r.branch_id, branch_name: r.branch_name };
  for (const k of COUNT_KEYS) out[k] = num(r[k]);
  for (const k of MONEY_KEYS) out[k] = money(r[k]);
  return out;
}
function sumTotals(rows) {
  const t = {};
  for (const k of COUNT_KEYS) t[k] = rows.reduce((a, r) => a + r[k], 0);
  for (const k of MONEY_KEYS) t[k] = (rows.reduce((a, r) => a + Math.round(Number(r[k]) * 100), 0) / 100).toFixed(2);
  return t;
}

const CSV_COLUMNS = [
  { key: 'branch_name', header: 'Branch', text: true },
  { key: 'loans_issued', header: 'Loans issued' },
  { key: 'loans_returned', header: 'Loans returned' },
  { key: 'returned_late', header: 'Returned late' },
  { key: 'overdue_now', header: 'Overdue now' },
  { key: 'fines_finalized', header: 'Fines finalized' },
  { key: 'fines_collected', header: 'Fines collected' },
  { key: 'new_members', header: 'New members' },
  { key: 'payments_verified', header: 'Payments verified' },
  { key: 'payments_verified_amount', header: 'Payments verified (amount)' },
  { key: 'payments_pending_now', header: 'Payments pending now' },
  { key: 'incidents_reported', header: 'Incidents reported' },
];

// GET /api/reports/branch-activity?from=&to=&page=&format=csv   (admin may add branch_id=)
router.get('/branch-activity', authenticate, branchScope, async (req, res) => {
  try {
    const q = req.query;
    const format = present(q.format) ? q.format : 'json';
    if (format !== 'json' && format !== 'csv') return res.status(400).json({ error: 'format must be json or csv' });

    const [[d]] = await pool.query(
      "SELECT DATE_FORMAT(DATE_ADD(CURDATE(), INTERVAL -29 DAY), '%Y-%m-%d') AS f, DATE_FORMAT(CURDATE(), '%Y-%m-%d') AS t"
    );
    const from = present(q.from) ? q.from : d.f;
    const to = present(q.to) ? q.to : d.t;
    if (!isValidDate(from)) return res.status(400).json({ error: 'from must be a valid date (YYYY-MM-DD)' });
    if (!isValidDate(to)) return res.status(400).json({ error: 'to must be a valid date (YYYY-MM-DD)' });
    if (from > to) return res.status(400).json({ error: 'from must not be after to' });
    const span = Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86400000);
    if (span > MAX_SPAN_DAYS) return res.status(400).json({ error: `The period can be at most ${MAX_SPAN_DAYS} days` });

    await expireStalePayments();
    const sc = scopeCondition(req, 'b.branch_id');
    const dates = [];
    for (let i = 0; i < 9; i += 1) dates.push(from, to);
    const [raw] = await pool.query(`${SQL} ${sc.sql} ORDER BY b.name`, [...dates, ...sc.params]);
    const rows = raw.map(shapeRow);
    const totals = sumTotals(rows);
    const [[now]] = await pool.query('SELECT NOW() AS now');

    if (format === 'csv') {
      await logAudit(pool, req.user.user_id, 'report_exported', 'report', null,
        `branch-activity; ${rows.length} rows; period ${from} to ${to}; branch scope ${req.scope.branchId === null ? 'all' : req.scope.branchId}`);
      res.set({
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': `attachment; filename="branch-activity-${from}-to-${to}.csv"`,
        'X-Report-Generated': now.now,
        'X-Report-Period': `${from} to ${to}`,
        'Cache-Control': 'private, no-store',
      });
      return res.send(toCsv(CSV_COLUMNS, [...rows, { ...totals, branch_name: 'All branches (total)' }]));
    }

    const page = Math.min(1000000, Math.max(1, parseInt(q.page, 10) || 1));
    res.json({
      report: 'branch-activity',
      generated_at: now.now,
      period: { from, to },
      data: rows.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE),
      page,
      page_size: PAGE_SIZE,
      total: rows.length,
      total_pages: Math.ceil(rows.length / PAGE_SIZE),
      totals,
      scope_branch_id: req.scope.branchId,
    });
  } catch (err) {
    console.error('Branch activity error:', err.message);
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
});

module.exports = router;