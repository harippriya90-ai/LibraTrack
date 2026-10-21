const express = require('express');
const pool = require('../config/db');
const { authenticate } = require('../middleware/auth');
const { HttpError, withTransaction, logAudit } = require('../services/dbHelpers');
const { getLoan, getStock } = require('../services/loanQueries');

const router = express.Router();

function toPositiveInt(v) {
  if (typeof v === 'number' && Number.isInteger(v) && v > 0) return v;
  if (typeof v === 'string' && /^\d{1,9}$/.test(v) && Number(v) > 0) return Number(v);
  return NaN;
}
function handleError(res, label, err) {
  if (err instanceof HttpError) {
    return res.status(err.status).json({ error: err.message });
  }
  if (err && (err.code === 'ER_LOCK_DEADLOCK' || err.code === 'ER_LOCK_WAIT_TIMEOUT')) {
    return res.status(503).json({ error: 'The system is busy. Please try again.' });
  }
  console.error(`${label}:`, err.message);
  return res.status(500).json({ error: 'Something went wrong. Please try again.' });
}

// Money is calculated in whole paise so there are no floating-point rounding errors.
function toPaise(v) {
  return Math.round(Number(v) * 100);
}
function fromPaise(p) {
  return (p / 100).toFixed(2);
}

// POST /api/loans/:id/return
router.post('/:id/return', authenticate, async (req, res) => {
  const id = toPositiveInt(req.params.id);
  if (Number.isNaN(id)) return res.status(400).json({ error: 'Loan ID must be a positive whole number' });

  try {
    const done = await withTransaction(async (conn) => {
      // Locking the loan row means a duplicate or simultaneous return waits, then sees it is already returned.
      const [rows] = await conn.execute(
        `SELECT loan_id, branch_id, book_id, return_date,
                DATEDIFF(CURDATE(), due_date) AS days_late,
                fine_rate_snapshot, grace_days_snapshot, fine_cap_snapshot
           FROM loans WHERE loan_id = ? FOR UPDATE`,
        [id]
      );
      const loan = rows[0];
      if (!loan) throw new HttpError(404, 'Loan not found');
      if (req.user.role === 'staff' && loan.branch_id !== req.user.branch_id) {
        throw new HttpError(403, 'This loan belongs to another branch');
      }
      if (loan.return_date) {
        throw new HttpError(409, `This loan was already returned on ${loan.return_date}.`);
      }

      // Overdue days = days past the due date, minus the grace days copied onto the loan, never below 0.
      const overdueDays = Math.max(0, Number(loan.days_late) - Number(loan.grace_days_snapshot));
      // Fine = overdue days x the loan's own rate, limited by the loan's own cap (if any).
      let paise = overdueDays * toPaise(loan.fine_rate_snapshot);
      if (loan.fine_cap_snapshot !== null) paise = Math.min(paise, toPaise(loan.fine_cap_snapshot));
      const amount = fromPaise(paise);

      const [upd] = await conn.execute(
        'UPDATE loans SET return_date = CURDATE(), returned_by = ? WHERE loan_id = ? AND return_date IS NULL',
        [req.user.user_id, id]
      );
      if (upd.affectedRows !== 1) throw new HttpError(409, 'This loan was already returned.');

      // The finalized fine is saved once and never recalculated.
      await conn.execute(
        'INSERT INTO loan_fines (loan_id, overdue_days, rate_applied, calculated_amount) VALUES (?, ?, ?, ?)',
        [id, overdueDays, loan.fine_rate_snapshot, amount]
      );
      await logAudit(conn, req.user.user_id, 'loan_returned', 'loan', id,
        `overdue ${overdueDays} day(s), fine ${amount}`);
      return { branchId: loan.branch_id, bookId: loan.book_id };
    });

    res.json({
      loan: await getLoan(pool, id),
      stock: await getStock(pool, done.branchId, done.bookId),
    });
  } catch (err) {
    handleError(res, 'Return loan error', err);
  }
});

module.exports = router;