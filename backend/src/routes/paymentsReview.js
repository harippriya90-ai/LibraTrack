const express = require('express');
const pool = require('../config/db');
const { authenticate, requireRole } = require('../middleware/auth');
const { HttpError, withTransaction, logAudit } = require('../services/dbHelpers');
const { expireStalePayments } = require('../services/paymentExpiry');

const router = express.Router();
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
    const body = { error: err.message };
    if (err.fields) body.fields = err.fields;
    return res.status(err.status).json(body);
  }
  if (err && err.code === 'ER_DUP_ENTRY') {
    // A second line of defence: the database itself refuses a duplicate.
    return res.status(409).json({ error: 'This payment was already processed or the transaction ID is already used.' });
  }
  console.error(`${label}:`, err.message);
  return res.status(500).json({ error: 'Something went wrong. Please try again.' });
}

// Off unless an administrator adds the setting allow_self_verification = '1'.
async function selfVerificationAllowed(conn) {
  const [rows] = await conn.execute(
    "SELECT setting_value FROM system_settings WHERE setting_key = 'allow_self_verification'"
  );
  return rows[0] ? rows[0].setting_value === '1' : false;
}

// Locks the request row so two reviewers cannot act on it at the same time.
async function lockRequest(conn, id) {
  const [rows] = await conn.execute(
    `SELECT request_id, member_id, plan_id, amount, status, created_by,
            (expires_at <= NOW()) AS past_expiry
       FROM payment_requests
      WHERE request_id = ? FOR UPDATE`,
    [id]
  );
  if (!rows[0]) throw new HttpError(404, 'Payment request not found');
  return rows[0];
}

function assertReviewable(pr) {
  if (pr.status === 'successful') {
    throw new HttpError(409, 'This payment request is already verified. No further action is possible.');
  }
  if (pr.status === 'rejected') {
    throw new HttpError(409, 'This payment request was already rejected.');
  }
  if (pr.status === 'expired' || pr.past_expiry) {
    throw new HttpError(409, 'This payment request has expired and can no longer be processed. Create a new payment request for the member.');
  }
}

// ---------- POST /api/payments/:id/verify ----------
router.post('/:id/verify', authenticate, requireRole('admin'), async (req, res) => {
  const id = toPositiveInt(req.params.id);
  if (Number.isNaN(id)) return bad(res, 'Payment ID must be a positive whole number');
  if (!isPlainObject(req.body)) return bad(res, 'Send the verification details as a JSON object');

  const raw = req.body.verification_txn_id;
  const txn = typeof raw === 'string' ? raw.trim() : '';
  if (!TXN_RE.test(txn)) {
    return bad(res, 'Please correct the highlighted fields', {
      verification_txn_id: 'Enter the verified transaction reference (4-60 characters: letters, digits, . _ - /)',
    });
  }

  try {
    await expireStalePayments(); // committed on its own, before the transaction below

    const outcome = await withTransaction(async (conn) => {
      const pr = await lockRequest(conn, id);
      assertReviewable(pr);

      if (pr.created_by === req.user.user_id && !(await selfVerificationAllowed(conn))) {
        throw new HttpError(403, 'You cannot verify a payment request that you created yourself. Ask another administrator.');
      }

      const [dup] = await conn.execute(
        'SELECT request_id FROM payment_requests WHERE verification_txn_id = ? AND request_id <> ? LIMIT 1',
        [txn, id]
      );
      if (dup[0]) {
        throw new HttpError(409, 'This verification transaction ID is already linked to another payment', {
          verification_txn_id: 'Already used',
        });
      }

      // Locking the member row serializes membership changes for this member.
      const [mrows] = await conn.execute(
        'SELECT member_id, is_active FROM members WHERE member_id = ? FOR UPDATE',
        [pr.member_id]
      );
      if (!mrows[0]) throw new HttpError(404, 'Member not found');
      if (!mrows[0].is_active) {
        throw new HttpError(409, 'This member is deactivated. Reactivate the member before verifying the payment.');
      }

      const [plans] = await conn.execute(
        'SELECT duration_months, max_loans, loan_days FROM membership_plans WHERE plan_id = ?',
        [pr.plan_id]
      );
      if (!plans[0]) throw new HttpError(404, 'Membership plan not found');
      const plan = plans[0];

      // Start date rule: day after the latest membership ends if it is still valid, otherwise today.
      const [[t]] = await conn.execute('SELECT CURDATE() AS today');
      const [last] = await conn.execute(
        `SELECT membership_id, DATE_ADD(expiry_date, INTERVAL 1 DAY) AS next_day,
                (expiry_date >= CURDATE()) AS still_valid
           FROM memberships
          WHERE member_id = ?
          ORDER BY expiry_date DESC, membership_id DESC
          LIMIT 1`,
        [pr.member_id]
      );
      const prev = last[0];
      const start = prev && prev.still_valid ? prev.next_day : t.today;
      const renewalOf = prev ? prev.membership_id : null;

      const [ins] = await conn.execute(
        `INSERT INTO memberships
           (member_id, plan_id, payment_request_id, renewal_of_id, start_date, expiry_date,
            duration_months, fee_paid, max_loans, loan_days)
         VALUES (?, ?, ?, ?, CAST(? AS DATE), DATE_ADD(CAST(? AS DATE), INTERVAL ? MONTH), ?, ?, ?, ?)`,
        [pr.member_id, pr.plan_id, id, renewalOf, start, start, plan.duration_months,
         plan.duration_months, pr.amount, plan.max_loans, plan.loan_days]
      );

      const [upd] = await conn.execute(
        `UPDATE payment_requests
            SET status = 'successful', verification_txn_id = ?, verified_by = ?, verified_at = NOW(),
                rejection_reason = NULL
          WHERE request_id = ? AND status = 'pending'`,
        [txn, req.user.user_id, id]
      );
      if (upd.affectedRows !== 1) {
        throw new HttpError(409, 'This payment request was changed by someone else. Reload and try again.');
      }

      await logAudit(conn, req.user.user_id, 'payment_verified', 'payment_request', id,
        `txn ${txn}; membership ${ins.insertId}; renewal_of ${renewalOf === null ? 'none' : renewalOf}`);
      return { membershipId: ins.insertId };
    });

    const [[payment]] = await pool.execute(
      'SELECT request_id, status, verification_txn_id, verified_at FROM payment_requests WHERE request_id = ?',
      [id]
    );
    const [[membership]] = await pool.execute(
      `SELECT ms.membership_id, ms.member_id, p.name AS plan_name, ms.start_date, ms.expiry_date,
              ms.duration_months, ms.fee_paid, ms.renewal_of_id
         FROM memberships ms
         JOIN membership_plans p ON p.plan_id = ms.plan_id
        WHERE ms.membership_id = ?`,
      [outcome.membershipId]
    );
    res.json({ payment, membership });
  } catch (err) {
    handleError(res, 'Verify payment error', err);
  }
});

// ---------- POST /api/payments/:id/reject ----------
router.post('/:id/reject', authenticate, requireRole('admin'), async (req, res) => {
  const id = toPositiveInt(req.params.id);
  if (Number.isNaN(id)) return bad(res, 'Payment ID must be a positive whole number');
  if (!isPlainObject(req.body)) return bad(res, 'Send the rejection details as a JSON object');

  const reason = typeof req.body.reason === 'string' ? req.body.reason.trim() : '';
  if (reason.length < 3 || reason.length > 255) {
    return bad(res, 'Please correct the highlighted fields', { reason: 'Give a reason of 3-255 characters' });
  }

  try {
    await expireStalePayments();

    await withTransaction(async (conn) => {
      const pr = await lockRequest(conn, id);
      assertReviewable(pr);

      const [upd] = await conn.execute(
        `UPDATE payment_requests
            SET status = 'rejected', rejection_reason = ?, verified_by = ?, verified_at = NOW()
          WHERE request_id = ? AND status = 'pending'`,
        [reason, req.user.user_id, id]
      );
      if (upd.affectedRows !== 1) {
        throw new HttpError(409, 'This payment request was changed by someone else. Reload and try again.');
      }
      await logAudit(conn, req.user.user_id, 'payment_rejected', 'payment_request', id, null);
    });

    const [[payment]] = await pool.execute(
      'SELECT request_id, status, rejection_reason, verified_at FROM payment_requests WHERE request_id = ?',
      [id]
    );
    res.json({ payment });
  } catch (err) {
    handleError(res, 'Reject payment error', err);
  }
});

module.exports = router;