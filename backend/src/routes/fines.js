const express = require('express');
const pool = require('../config/db');
const { authenticate, requireRole } = require('../middleware/auth');
const { HttpError, withTransaction, logAudit } = require('../services/dbHelpers');

const router = express.Router();
const METHODS = ['upi', 'card', 'netbanking', 'cash', 'bank_transfer'];
const TXN_RE = /^[A-Za-z0-9._\/-]{4,60}$/;

// ---------- helpers ----------
function toPositiveInt(v) {
  if (typeof v === 'number' && Number.isInteger(v) && v > 0) return v;
  if (typeof v === 'string' && /^\d{1,9}$/.test(v) && Number(v) > 0) return Number(v);
  return NaN;
}
function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}
function bad(res, message, fields) {
  const body = { error: message };
  if (fields) body.fields = fields;
  return res.status(400).json(body);
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

// Money is handled in whole paise so there are no floating-point rounding errors.
function toPaise(v) {
  return Math.round(Number(v) * 100);
}
function fromPaise(p) {
  return (p / 100).toFixed(2);
}
function parseAmount(v) {
  let s;
  if (typeof v === 'number' && Number.isFinite(v)) s = String(v);
  else if (typeof v === 'string') s = v.trim();
  else return NaN;
  if (!/^\d{1,8}(\.\d{1,2})?$/.test(s)) return NaN;
  const paise = Math.round(Number(s) * 100);
  return paise > 0 ? paise : NaN;
}
function maskId(v) {
  if (!v) return null;
  const s = String(v);
  if (s.length <= 4) return '****';
  return `${'*'.repeat(Math.min(s.length - 4, 8))}${s.slice(-4)}`;
}
function cleanReason(v) {
  const s = typeof v === 'string' ? v.trim() : '';
  return s.length >= 3 && s.length <= 255 ? s : null;
}

// Total fine, amount paid and balance, kept separate. Works from the loan view.
async function getFineSummary(db, loanId) {
  const [rows] = await db.execute(
    `SELECT v.loan_id, v.branch_id, v.member_id, v.loan_status, v.fine_kind, v.overdue_days,
            v.fine_rate_snapshot AS fine_rate, v.fine_amount, v.fine_paid,
            lf.calculated_amount, COALESCE(lf.waived, 0) AS waived
       FROM v_loan_details v
       LEFT JOIN loan_fines lf ON lf.loan_id = v.loan_id
      WHERE v.loan_id = ?`,
    [loanId]
  );
  const r = rows[0];
  if (!r) return null;

  const finalized = r.fine_kind === 'finalized';
  const total = toPaise(r.fine_amount); // 0 when waived; a live estimate while the loan is open
  const paid = toPaise(r.fine_paid);
  const balance = Math.max(total - paid, 0);
  const calculated = finalized ? toPaise(r.calculated_amount) : total; // before any waiver

  let status;
  if (!finalized) status = 'estimate';
  else if (r.waived) status = 'waived';
  else if (calculated === 0) status = 'no_fine';
  else if (paid <= 0) status = 'unpaid';
  else if (paid < total) status = 'partial';
  else status = 'paid';

  return {
    loan_id: r.loan_id,
    branch_id: r.branch_id,
    member_id: r.member_id,
    loan_status: r.loan_status,
    fine_kind: r.fine_kind,
    overdue_days: r.overdue_days,
    fine_rate: r.fine_rate,
    calculated_fine: fromPaise(calculated),
    waived: !!r.waived,
    total_fine: fromPaise(total),
    amount_paid: fromPaise(paid),
    balance: fromPaise(balance),
    payment_status: status,
    can_accept_payment: finalized && !r.waived && balance > 0,
  };
}

async function listPayments(db, loanId) {
  const [rows] = await db.execute(
    `SELECT fp.fine_payment_id, fp.amount, fp.method, fp.transaction_ref, fp.status, fp.paid_at,
            u.full_name AS recorded_by_name
       FROM fine_payments fp
       JOIN users u ON u.user_id = fp.recorded_by
      WHERE fp.loan_id = ?
      ORDER BY fp.paid_at DESC, fp.fine_payment_id DESC`,
    [loanId]
  );
  return rows.map((r) => ({
    fine_payment_id: r.fine_payment_id,
    amount: r.amount,
    method: r.method,
    transaction_ref_masked: maskId(r.transaction_ref),
    status: r.status,
    paid_at: r.paid_at,
    recorded_by_name: r.recorded_by_name,
  }));
}

// ---------- GET /api/loans/:id/fine ----------
router.get('/loans/:id/fine', authenticate, async (req, res) => {
  const id = toPositiveInt(req.params.id);
  if (Number.isNaN(id)) return bad(res, 'Loan ID must be a positive whole number');
  try {
    const fine = await getFineSummary(pool, id);
    if (!fine) return res.status(404).json({ error: 'Loan not found' });
    if (req.user.role === 'staff' && fine.branch_id !== req.user.branch_id) {
      return res.status(403).json({ error: 'This loan belongs to another branch' });
    }
    res.json({ fine, payments: await listPayments(pool, id) });
  } catch (err) {
    handleError(res, 'Fine summary error', err);
  }
});

// ---------- POST /api/loans/:id/fine-payments ----------
// body: { amount, method, transaction_ref?, status?: 'successful' | 'failed' }
router.post('/loans/:id/fine-payments', authenticate, async (req, res) => {
  const id = toPositiveInt(req.params.id);
  if (Number.isNaN(id)) return bad(res, 'Loan ID must be a positive whole number');
  if (!isPlainObject(req.body)) return bad(res, 'Send the payment details as a JSON object');

  const errors = {};
  const amountPaise = parseAmount(req.body.amount);
  if (Number.isNaN(amountPaise)) errors.amount = 'Amount must be greater than 0, with at most 2 decimals';
  const method = req.body.method;
  if (!METHODS.includes(method)) errors.method = `Method must be one of: ${METHODS.join(', ')}`;
  const status = req.body.status === undefined ? 'successful' : req.body.status;
  if (status !== 'successful' && status !== 'failed') errors.status = 'Status must be "successful" or "failed"';

  let txn = null;
  const raw = req.body.transaction_ref;
  if (raw !== undefined && raw !== null && !(typeof raw === 'string' && raw.trim() === '')) {
    if (typeof raw !== 'string' || !TXN_RE.test(raw.trim())) {
      errors.transaction_ref = 'Reference must be 4-60 characters (letters, digits, . _ - /)';
    } else {
      txn = raw.trim();
    }
  }
  if (!errors.transaction_ref && METHODS.includes(method) && method !== 'cash' && status === 'successful' && !txn) {
    errors.transaction_ref = 'A transaction reference is required for non-cash payments';
  }
  if (Object.keys(errors).length) return bad(res, 'Please correct the highlighted fields', errors);

  try {
    const payment = await withTransaction(async (conn) => {
      // Locking the fine record serializes payments for this loan; READ COMMITTED makes the
      // paid-so-far total below include every payment committed up to this moment.
      const [rows] = await conn.execute(
        `SELECT lf.calculated_amount, lf.waived, l.branch_id
           FROM loan_fines lf
           JOIN loans l ON l.loan_id = lf.loan_id
          WHERE lf.loan_id = ? FOR UPDATE`,
        [id]
      );
      const f = rows[0];
      if (!f) {
        const [ln] = await conn.execute('SELECT branch_id FROM loans WHERE loan_id = ?', [id]);
        if (!ln[0]) throw new HttpError(404, 'Loan not found');
        if (req.user.role === 'staff' && ln[0].branch_id !== req.user.branch_id) {
          throw new HttpError(403, 'This loan belongs to another branch');
        }
        throw new HttpError(409, 'The fine is not final until the book is returned. Return the book first.');
      }
      if (req.user.role === 'staff' && f.branch_id !== req.user.branch_id) {
        throw new HttpError(403, 'This loan belongs to another branch');
      }
      if (f.waived) throw new HttpError(409, 'This fine was waived. No payment is needed.');
      const calculated = toPaise(f.calculated_amount);
      if (calculated === 0) throw new HttpError(409, 'There is no fine to pay on this loan.');

      if (status === 'successful') {
        const [[p]] = await conn.execute(
          "SELECT COALESCE(SUM(amount), 0) AS paid FROM fine_payments WHERE loan_id = ? AND status = 'successful'",
          [id]
        );
        const balance = calculated - toPaise(p.paid);
        if (balance <= 0) throw new HttpError(409, 'This fine is already fully paid.');
        if (amountPaise > balance) {
          throw new HttpError(409, `Overpayment refused: the remaining balance is ${fromPaise(balance)}.`);
        }
        if (txn) {
          const [dup] = await conn.execute(
            "SELECT fine_payment_id FROM fine_payments WHERE transaction_ref = ? AND status = 'successful' LIMIT 1",
            [txn]
          );
          if (dup[0]) throw new HttpError(409, 'This transaction reference is already used on another fine payment.');
        }
      }

      const amount = fromPaise(amountPaise);
      const [ins] = await conn.execute(
        `INSERT INTO fine_payments (loan_id, amount, method, transaction_ref, status, recorded_by)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [id, amount, method, txn, status, req.user.user_id]
      );
      await logAudit(conn, req.user.user_id, 'fine_payment_recorded', 'loan', id,
        `${status} ${amount} via ${method}; payment ${ins.insertId}`);
      return { fine_payment_id: ins.insertId, amount, method, status };
    }, { isolation: 'READ COMMITTED' });

    res.status(201).json({ payment, fine: await getFineSummary(pool, id) });
  } catch (err) {
    handleError(res, 'Record fine payment error', err);
  }
});

// ---------- PATCH /api/loans/:id/fine : waive or restore (admin only) ----------
// body: { waived: true, reason } or { waived: false, reason? }
router.patch('/loans/:id/fine', authenticate, requireRole('admin'), async (req, res) => {
  const id = toPositiveInt(req.params.id);
  if (Number.isNaN(id)) return bad(res, 'Loan ID must be a positive whole number');
  if (!isPlainObject(req.body) || typeof req.body.waived !== 'boolean') {
    return bad(res, 'waived must be true or false');
  }
  const waive = req.body.waived;
  const reason = cleanReason(req.body.reason);
  if (waive && !reason) return bad(res, 'Please correct the highlighted fields', { reason: 'Give a reason of 3-255 characters' });

  try {
    await withTransaction(async (conn) => {
      const [rows] = await conn.execute(
        'SELECT calculated_amount, waived FROM loan_fines WHERE loan_id = ? FOR UPDATE',
        [id]
      );
      const f = rows[0];
      if (!f) throw new HttpError(404, 'No finalized fine exists for this loan (the book may not be returned yet).');

      if (waive) {
        if (f.waived) throw new HttpError(409, 'This fine is already waived.');
        if (toPaise(f.calculated_amount) === 0) throw new HttpError(409, 'There is no fine to waive.');
        const [[p]] = await conn.execute(
          "SELECT COUNT(*) AS n FROM fine_payments WHERE loan_id = ? AND status = 'successful'",
          [id]
        );
        if (Number(p.n) > 0) {
          throw new HttpError(409, 'Refund the successful payments before waiving this fine.');
        }
        await conn.execute('UPDATE loan_fines SET waived = 1, waived_by = ? WHERE loan_id = ?', [req.user.user_id, id]);
        await logAudit(conn, req.user.user_id, 'fine_waived', 'loan', id, `reason: ${reason}`);
      } else {
        if (!f.waived) throw new HttpError(409, 'This fine is not waived.');
        await conn.execute('UPDATE loan_fines SET waived = 0, waived_by = NULL WHERE loan_id = ?', [id]);
        await logAudit(conn, req.user.user_id, 'fine_waiver_removed', 'loan', id, reason ? `reason: ${reason}` : null);
      }
    });
    res.json({ fine: await getFineSummary(pool, id) });
  } catch (err) {
    handleError(res, 'Fine waiver error', err);
  }
});

// ---------- POST /api/fine-payments/:id/refund (admin only) ----------
router.post('/fine-payments/:id/refund', authenticate, requireRole('admin'), async (req, res) => {
  const id = toPositiveInt(req.params.id);
  if (Number.isNaN(id)) return bad(res, 'Payment ID must be a positive whole number');
  const reason = cleanReason(isPlainObject(req.body) ? req.body.reason : undefined);
  if (!reason) return bad(res, 'Please correct the highlighted fields', { reason: 'Give a reason of 3-255 characters' });

  try {
    const loanId = await withTransaction(async (conn) => {
      const [rows] = await conn.execute(
        'SELECT fine_payment_id, loan_id, amount, status FROM fine_payments WHERE fine_payment_id = ? FOR UPDATE',
        [id]
      );
      const p = rows[0];
      if (!p) throw new HttpError(404, 'Fine payment not found');
      if (p.status !== 'successful') {
        throw new HttpError(409, `Only a successful payment can be refunded (this one is ${p.status}).`);
      }
      const [upd] = await conn.execute(
        "UPDATE fine_payments SET status = 'refunded' WHERE fine_payment_id = ? AND status = 'successful'",
        [id]
      );
      if (upd.affectedRows !== 1) throw new HttpError(409, 'This payment was already refunded.');
      await logAudit(conn, req.user.user_id, 'fine_payment_refunded', 'loan', p.loan_id,
        `payment ${id}, ${p.amount}; reason: ${reason}`);
      return p.loan_id;
    });
    res.json({ payment: { fine_payment_id: id, status: 'refunded' }, fine: await getFineSummary(pool, loanId) });
  } catch (err) {
    handleError(res, 'Fine refund error', err);
  }
});

module.exports = router;