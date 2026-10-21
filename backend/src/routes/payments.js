const express = require('express');
const crypto = require('crypto');
const pool = require('../config/db');
const { authenticate } = require('../middleware/auth');
const { branchScope, scopeCondition } = require('../middleware/branchScope');
const { HttpError, withTransaction, logAudit } = require('../services/dbHelpers');
const { expireStalePayments } = require('../services/paymentExpiry');

const router = express.Router();
const PAGE_SIZE = 10;
const METHODS = ['upi', 'card', 'netbanking', 'cash', 'bank_transfer'];
const STATUSES = ['pending', 'successful', 'rejected', 'expired'];
const TXN_RE = /^[A-Za-z0-9._\/-]{4,60}$/;

// Whitelisted sort columns; user input never goes into SQL directly.
const SORTS = {
  requested: 'pr.requested_at',
  amount: 'pr.amount',
  status: 'pr.status',
  member: 'm.full_name',
};

const SELECT_COLS = `pr.request_id, pr.reference_no, pr.member_id, m.full_name AS member_name,
       pr.branch_id, b.name AS branch_name, pr.plan_id, p.name AS plan_name, pr.request_type,
       pr.amount, pr.method, pr.submitted_txn_id, pr.verification_txn_id, pr.status,
       (pr.proof_stored_name IS NOT NULL) AS has_proof,
       pr.requested_at, pr.expires_at, pr.verified_at, vu.full_name AS verified_by_name,
       pr.rejection_reason, cu.full_name AS created_by_name`;
const FROM_SQL = `FROM payment_requests pr
       JOIN members m ON m.member_id = pr.member_id
       JOIN branches b ON b.branch_id = pr.branch_id
       JOIN membership_plans p ON p.plan_id = pr.plan_id
       LEFT JOIN users vu ON vu.user_id = pr.verified_by
       JOIN users cu ON cu.user_id = pr.created_by`;

// ---------- helpers ----------
function escapeLike(s) {
  return s.replace(/[\\%_]/g, '\\$&');
}
function cleanText(v, max) {
  return typeof v === 'string' ? v.trim().slice(0, max) : '';
}
function getPage(req) {
  return Math.min(1000000, Math.max(1, parseInt(req.query.page, 10) || 1));
}
function toPositiveInt(v) {
  if (typeof v === 'number' && Number.isInteger(v) && v > 0) return v;
  if (typeof v === 'string' && /^\d{1,9}$/.test(v) && Number(v) > 0) return Number(v);
  return NaN;
}
function intParam(v) {
  return v === undefined || v === '' ? null : toPositiveInt(v);
}
function moneyParam(v) {
  if (v === undefined || v === '') return null;
  return typeof v === 'string' && /^\d{1,8}(\.\d{1,2})?$/.test(v) ? v : NaN;
}
function isValidDate(s) {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const [y, m, d] = s.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}
function dateParam(v) {
  if (v === undefined || v === '') return null;
  return isValidDate(v) ? v : NaN;
}
function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}
function bad(res, message) {
  return res.status(400).json({ error: message });
}
function shape(r) {
  return { ...r, has_proof: !!r.has_proof };
}
function handleError(res, label, err) {
  if (err instanceof HttpError) {
    const body = { error: err.message };
    if (err.fields) body.fields = err.fields;
    return res.status(err.status).json(body);
  }
  console.error(`${label}:`, err.message);
  return res.status(500).json({ error: 'Something went wrong. Please try again.' });
}

async function getExpiryDays(db) {
  const [rows] = await db.execute("SELECT setting_value FROM system_settings WHERE setting_key = 'payment_expiry_days'");
  const n = rows[0] ? Number(rows[0].setting_value) : NaN;
  return Number.isInteger(n) && n >= 1 && n <= 365 ? n : 5;
}

async function getPayment(db, id) {
  const [rows] = await db.execute(`SELECT ${SELECT_COLS} ${FROM_SQL} WHERE pr.request_id = ?`, [id]);
  return rows[0] ? shape(rows[0]) : null;
}

// ---------- GET /api/payments ----------
router.get('/', authenticate, branchScope, async (req, res) => {
  try {
    await expireStalePayments();
    const q = req.query;
    const conds = [];
    const params = [];

    const sc = scopeCondition(req, 'pr.branch_id');
    conds.push(sc.sql);
    params.push(...sc.params);

    for (const [key, col] of [['payment_id', 'pr.request_id'], ['member_id', 'pr.member_id']]) {
      const n = intParam(q[key]);
      if (Number.isNaN(n)) return bad(res, `${key} must be a positive whole number`);
      if (n) {
        conds.push(`${col} = ?`);
        params.push(n);
      }
    }

    const name = cleanText(q.member_name, 100);
    if (name) {
      conds.push('m.full_name LIKE ?');
      params.push(`%${escapeLike(name)}%`);
    }

    if (q.method !== undefined && q.method !== '') {
      if (!METHODS.includes(q.method)) return bad(res, `method must be one of: ${METHODS.join(', ')}`);
      conds.push('pr.method = ?');
      params.push(q.method);
    }
    if (q.status !== undefined && q.status !== '') {
      if (!STATUSES.includes(q.status)) return bad(res, `status must be one of: ${STATUSES.join(', ')}`);
      conds.push('pr.status = ?');
      params.push(q.status);
    }

    for (const [key, op] of [['min_amount', '>='], ['max_amount', '<=']]) {
      const m = moneyParam(q[key]);
      if (Number.isNaN(m)) return bad(res, `${key} must be a non-negative amount`);
      if (m !== null) {
        conds.push(`pr.amount ${op} ?`);
        params.push(m);
      }
    }

    const txn = cleanText(q.txn, 60);
    if (txn) {
      const like = `%${escapeLike(txn)}%`;
      conds.push('(pr.submitted_txn_id LIKE ? OR pr.verification_txn_id LIKE ?)');
      params.push(like, like);
    }

    if (q.proof !== undefined && q.proof !== '') {
      if (q.proof !== 'yes' && q.proof !== 'no') return bad(res, 'proof must be "yes" or "no"');
      conds.push(q.proof === 'yes' ? 'pr.proof_stored_name IS NOT NULL' : 'pr.proof_stored_name IS NULL');
    }

    for (const [key, col, upper] of [
      ['requested_from', 'pr.requested_at', false],
      ['requested_to', 'pr.requested_at', true],
      ['verified_from', 'pr.verified_at', false],
      ['verified_to', 'pr.verified_at', true],
    ]) {
      const d = dateParam(q[key]);
      if (Number.isNaN(d)) return bad(res, `${key} must be a valid date (YYYY-MM-DD)`);
      if (d) {
        conds.push(upper ? `${col} < DATE_ADD(?, INTERVAL 1 DAY)` : `${col} >= ?`);
        params.push(d);
      }
    }

    if (q.sort !== undefined && q.sort !== '' && !Object.prototype.hasOwnProperty.call(SORTS, q.sort)) {
      return bad(res, 'sort must be one of: requested, amount, status, member');
    }
    const dir = q.dir === 'asc' ? 'ASC' : 'DESC';
    const sortCol = q.sort ? SORTS[q.sort] : SORTS.requested;
    const orderBy = `${sortCol} ${dir}, pr.request_id DESC`;

    const where = `WHERE ${conds.join(' AND ')}`;
    const page = getPage(req);

    const [[{ total }]] = await pool.query(`SELECT COUNT(*) AS total ${FROM_SQL} ${where}`, params);
    const [rows] = await pool.query(
      `SELECT ${SELECT_COLS} ${FROM_SQL} ${where} ORDER BY ${orderBy} LIMIT ? OFFSET ?`,
      [...params, PAGE_SIZE, (page - 1) * PAGE_SIZE]
    );

    res.json({
      data: rows.map(shape),
      page,
      page_size: PAGE_SIZE,
      total,
      total_pages: Math.ceil(total / PAGE_SIZE),
    });
  } catch (err) {
    handleError(res, 'Payments list error', err);
  }
});

// ---------- GET /api/payments/:id ----------
router.get('/:id', authenticate, async (req, res) => {
  const id = toPositiveInt(req.params.id);
  if (Number.isNaN(id)) return bad(res, 'Payment ID must be a positive whole number');
  try {
    await expireStalePayments();
    const payment = await getPayment(pool, id);
    if (!payment) return res.status(404).json({ error: 'Payment request not found' });
    if (req.user.role === 'staff' && payment.branch_id !== req.user.branch_id) {
      return res.status(403).json({ error: 'This payment request belongs to another branch' });
    }
    res.json({ payment });
  } catch (err) {
    handleError(res, 'Payment detail error', err);
  }
});

// ---------- POST /api/payments : submit a membership payment request ----------
// body: { member_id, plan_id, method, submitted_txn_id? }
router.post('/', authenticate, async (req, res) => {
  if (!isPlainObject(req.body)) return bad(res, 'Send the request details as a JSON object');

  const errors = {};
  const memberId = toPositiveInt(req.body.member_id);
  if (Number.isNaN(memberId)) errors.member_id = 'Member ID is required';
  const planId = toPositiveInt(req.body.plan_id);
  if (Number.isNaN(planId)) errors.plan_id = 'Plan is required';
  const method = req.body.method;
  if (!METHODS.includes(method)) errors.method = `Method must be one of: ${METHODS.join(', ')}`;

  let txn = null;
  const rawTxn = req.body.submitted_txn_id;
  if (rawTxn !== undefined && rawTxn !== null && !(typeof rawTxn === 'string' && rawTxn.trim() === '')) {
    if (typeof rawTxn !== 'string' || !TXN_RE.test(rawTxn.trim())) {
      errors.submitted_txn_id = 'Transaction ID must be 4-60 characters (letters, digits, . _ - /)';
    } else {
      txn = rawTxn.trim();
    }
  }
  if (Object.keys(errors).length) {
    return res.status(400).json({ error: 'Please correct the highlighted fields', fields: errors });
  }

  try {
    const id = await withTransaction(async (conn) => {
      await expireStalePayments(conn);

      // Locking the member row means two simultaneous requests cannot both pass the checks below.
      const [mrows] = await conn.execute(
        'SELECT member_id, home_branch_id, is_active FROM members WHERE member_id = ? FOR UPDATE',
        [memberId]
      );
      const m = mrows[0];
      if (!m) {
        throw new HttpError(404, 'Invalid member request. Register the member before submitting a payment request.');
      }
      if (req.user.role === 'staff' && m.home_branch_id !== req.user.branch_id) {
        throw new HttpError(403, 'This member belongs to another branch');
      }
      if (!m.is_active) {
        throw new HttpError(409, 'This member is deactivated. Reactivate the member before submitting a payment request.');
      }

      const [prows] = await conn.execute('SELECT fee, is_active FROM membership_plans WHERE plan_id = ?', [planId]);
      const plan = prows[0];
      if (!plan) throw new HttpError(404, 'Membership plan not found');
      if (!plan.is_active) throw new HttpError(409, 'This membership plan is not available');

      const [pend] = await conn.execute(
        "SELECT request_id FROM payment_requests WHERE member_id = ? AND status = 'pending' LIMIT 1",
        [memberId]
      );
      if (pend[0]) {
        throw new HttpError(409, `This member already has a pending payment request (#${pend[0].request_id}). Verify, reject or wait for it to expire first.`);
      }

      if (txn) {
        const [dup] = await conn.execute(
          "SELECT request_id FROM payment_requests WHERE submitted_txn_id = ? AND status IN ('pending', 'successful') LIMIT 1",
          [txn]
        );
        if (dup[0]) {
          throw new HttpError(409, 'This transaction ID is already used on another payment request', { submitted_txn_id: 'Already used' });
        }
      }

      // New or renewal is decided from the member's history, not from anything the client sent.
      const [[cnt]] = await conn.execute('SELECT COUNT(*) AS n FROM memberships WHERE member_id = ?', [memberId]);
      const requestType = Number(cnt.n) > 0 ? 'renewal' : 'new';

      const days = await getExpiryDays(conn);
      const reference = crypto.randomBytes(12).toString('hex').toUpperCase(); // 24 chars, opaque

      const [r] = await conn.execute(
        `INSERT INTO payment_requests
           (reference_no, member_id, branch_id, plan_id, request_type, amount, method,
            submitted_txn_id, status, expires_at, created_by)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', DATE_ADD(NOW(), INTERVAL ? DAY), ?)`,
        [reference, memberId, m.home_branch_id, planId, requestType, plan.fee, method, txn, days, req.user.user_id]
      );
      await logAudit(conn, req.user.user_id, 'payment_request_created', 'payment_request', r.insertId,
        `member ${memberId}, plan ${planId}, ${requestType}`);
      return r.insertId;
    });
    res.status(201).json({ payment: await getPayment(pool, id) });
  } catch (err) {
    handleError(res, 'Create payment request error', err);
  }
});

module.exports = router;