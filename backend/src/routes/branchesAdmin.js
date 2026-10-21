const express = require('express');
const pool = require('../config/db');
const { authenticate, requireRole } = require('../middleware/auth');
const { HttpError, withTransaction, logAudit } = require('../services/dbHelpers');
const { expireStalePayments } = require('../services/paymentExpiry');

const router = express.Router();
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

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
    if (err.blockers) body.blockers = err.blockers;
    return res.status(err.status).json(body);
  }
  if (err && err.code === 'ER_DUP_ENTRY') {
    return res.status(409).json({ error: 'A branch with this name already exists', fields: { name: 'Already in use' } });
  }
  if (err && (err.code === 'ER_LOCK_DEADLOCK' || err.code === 'ER_LOCK_WAIT_TIMEOUT')) {
    return res.status(503).json({ error: 'The system is busy. Please try again.' });
  }
  console.error(`${label}:`, err.message);
  return res.status(500).json({ error: 'Something went wrong. Please try again.' });
}

function validateBranch(body, partial) {
  const v = {};
  const errors = {};
  const has = (k) => Object.prototype.hasOwnProperty.call(body, k);

  if (has('name') || !partial) {
    const s = typeof body.name === 'string' ? body.name.trim().replace(/\s+/g, ' ') : '';
    if (s.length < 2 || s.length > 100) errors.name = 'Name must be 2-100 characters';
    else v.name = s;
  }
  if (has('address') || !partial) {
    const s = typeof body.address === 'string' ? body.address.trim().replace(/\s+/g, ' ') : '';
    if (s.length < 5 || s.length > 255) errors.address = 'Address must be 5-255 characters';
    else v.address = s;
  }
  if (has('phone')) {
    const raw = body.phone;
    if (raw === null || (typeof raw === 'string' && raw.trim() === '')) v.phone = null;
    else {
      const s = (typeof raw === 'string' ? raw.trim() : '').replace(/[\s\-().]/g, '');
      if (!/^\+?\d{7,15}$/.test(s)) errors.phone = 'Enter a valid phone number (7-15 digits, optional leading +)';
      else v.phone = s;
    }
  }
  if (has('email')) {
    const raw = body.email;
    if (raw === null || (typeof raw === 'string' && raw.trim() === '')) v.email = null;
    else {
      const s = typeof raw === 'string' ? raw.trim().toLowerCase() : '';
      if (s.length > 120 || !EMAIL_RE.test(s)) errors.email = 'Enter a valid email address';
      else v.email = s;
    }
  }
  return { values: v, errors };
}

async function getBranch(db, id) {
  const [rows] = await db.execute(
    'SELECT branch_id, name, address, phone, email, is_active, created_at, updated_at FROM branches WHERE branch_id = ?',
    [id]
  );
  return rows[0] ? { ...rows[0], is_active: !!rows[0].is_active } : null;
}

// What must be resolved before a branch can be switched off.
async function countBlockers(db, id) {
  const [[a]] = await db.execute('SELECT COUNT(*) AS n FROM loans WHERE branch_id = ? AND return_date IS NULL', [id]);
  const [[b]] = await db.execute("SELECT COUNT(*) AS n FROM payment_requests WHERE branch_id = ? AND status = 'pending'", [id]);
  const [[c]] = await db.execute('SELECT COUNT(*) AS n FROM users WHERE branch_id = ? AND is_active = 1', [id]);
  const [[d]] = await db.execute('SELECT COUNT(*) AS n FROM members WHERE home_branch_id = ? AND is_active = 1', [id]);
  return {
    open_loans: Number(a.n),
    pending_payments: Number(b.n),
    active_staff: Number(c.n),
    active_members: Number(d.n),
  };
}

// ---------- GET /api/branches/:id : details, statistics, staff, blockers ----------
router.get('/:id', authenticate, requireRole('admin'), async (req, res) => {
  const id = toPositiveInt(req.params.id);
  if (Number.isNaN(id)) return bad(res, 'Branch ID must be a positive whole number');
  try {
    await expireStalePayments();
    const branch = await getBranch(pool, id);
    if (!branch) return res.status(404).json({ error: 'Branch not found' });

    const [[mem]] = await pool.execute(
      'SELECT COUNT(*) AS members, COALESCE(SUM(is_active = 1), 0) AS active_members FROM members WHERE home_branch_id = ?',
      [id]
    );
    const [[stock]] = await pool.execute(
      `SELECT COUNT(DISTINCT va.book_id) AS titles, COALESCE(SUM(va.total_copies), 0) AS copies,
              COALESCE(SUM(GREATEST(va.available_copies, 0)), 0) AS available
         FROM v_branch_availability va JOIN books b ON b.book_id = va.book_id AND b.is_active = 1
        WHERE va.branch_id = ?`,
      [id]
    );
    const [[ln]] = await pool.execute(
      `SELECT COUNT(CASE WHEN return_date IS NULL THEN 1 END) AS open_loans,
              COUNT(CASE WHEN loan_status = 'overdue' THEN 1 END) AS overdue_loans,
              COALESCE(SUM(GREATEST(fine_amount - fine_paid, 0)), 0) AS fines_outstanding
         FROM v_loan_details WHERE branch_id = ?`,
      [id]
    );
    const [[pay]] = await pool.execute(
      `SELECT COALESCE(SUM(status = 'pending'), 0) AS pending, COALESCE(SUM(status = 'successful'), 0) AS successful,
              COALESCE(SUM(CASE WHEN status = 'successful' THEN amount END), 0) AS amount
         FROM payment_requests WHERE branch_id = ?`,
      [id]
    );
    const [[inc]] = await pool.execute("SELECT COUNT(*) AS n FROM incidents WHERE branch_id = ? AND status = 'reported'", [id]);
    const [staff] = await pool.execute(
      'SELECT user_id, username, full_name, is_active, last_login_at FROM users WHERE branch_id = ? ORDER BY username',
      [id]
    );

    res.json({
      branch,
      stats: {
        members: Number(mem.members),
        active_members: Number(mem.active_members),
        book_titles: Number(stock.titles),
        physical_copies: Number(stock.copies),
        available_copies: Number(stock.available),
        open_loans: Number(ln.open_loans),
        overdue_loans: Number(ln.overdue_loans),
        fines_outstanding: Number(ln.fines_outstanding).toFixed(2),
        payments_pending: Number(pay.pending),
        payments_successful: Number(pay.successful),
        payments_successful_amount: Number(pay.amount).toFixed(2),
        incidents_awaiting_review: Number(inc.n),
      },
      blockers: await countBlockers(pool, id),
      staff: staff.map((s) => ({ ...s, is_active: !!s.is_active })),
    });
  } catch (err) {
    handleError(res, 'Branch detail error', err);
  }
});

// ---------- POST /api/branches ----------
router.post('/', authenticate, requireRole('admin'), async (req, res) => {
  if (!isPlainObject(req.body)) return bad(res, 'Send the branch details as a JSON object');
  const { values, errors } = validateBranch(req.body, false);
  if (Object.keys(errors).length) return bad(res, 'Please correct the highlighted fields', errors);
  try {
    const id = await withTransaction(async (conn) => {
      const [dup] = await conn.execute('SELECT branch_id FROM branches WHERE name = ? LIMIT 1', [values.name]);
      if (dup[0]) throw new HttpError(409, 'A branch with this name already exists', { name: 'Already in use' });
      const [r] = await conn.execute(
        'INSERT INTO branches (name, address, phone, email) VALUES (?, ?, ?, ?)',
        [values.name, values.address, values.phone ?? null, values.email ?? null]
      );
      await logAudit(conn, req.user.user_id, 'branch_created', 'branch', r.insertId, values.name);
      return r.insertId;
    });
    res.status(201).json({ branch: await getBranch(pool, id) });
  } catch (err) {
    handleError(res, 'Create branch error', err);
  }
});

// ---------- PATCH /api/branches/:id ----------
router.patch('/:id', authenticate, requireRole('admin'), async (req, res) => {
  const id = toPositiveInt(req.params.id);
  if (Number.isNaN(id)) return bad(res, 'Branch ID must be a positive whole number');
  if (!isPlainObject(req.body)) return bad(res, 'Send the changes as a JSON object');
  const { values, errors } = validateBranch(req.body, true);
  if (Object.keys(errors).length) return bad(res, 'Please correct the highlighted fields', errors);
  if (Object.keys(values).length === 0) return bad(res, 'No changes supplied');

  try {
    await withTransaction(async (conn) => {
      const [rows] = await conn.execute('SELECT name, address, phone, email FROM branches WHERE branch_id = ? FOR UPDATE', [id]);
      const old = rows[0];
      if (!old) throw new HttpError(404, 'Branch not found');
      if (values.name !== undefined) {
        const [dup] = await conn.execute('SELECT branch_id FROM branches WHERE name = ? AND branch_id <> ? LIMIT 1', [values.name, id]);
        if (dup[0]) throw new HttpError(409, 'A branch with this name already exists', { name: 'Already in use' });
      }
      const sets = [];
      const sp = [];
      const changed = [];
      for (const key of ['name', 'address', 'phone', 'email']) {
        if (values[key] === undefined) continue;
        if ((old[key] ?? null) === values[key]) continue;
        sets.push(`${key} = ?`);
        sp.push(values[key]);
        changed.push(key);
      }
      if (!sets.length) return;
      await conn.execute(`UPDATE branches SET ${sets.join(', ')} WHERE branch_id = ?`, [...sp, id]);
      await logAudit(conn, req.user.user_id, 'branch_updated', 'branch', id, `changed: ${changed.join(', ')}`);
    });
    res.json({ branch: await getBranch(pool, id) });
  } catch (err) {
    handleError(res, 'Update branch error', err);
  }
});

// ---------- PATCH /api/branches/:id/status : deactivate (with safety rules) or reactivate ----------
router.patch('/:id/status', authenticate, requireRole('admin'), async (req, res) => {
  const id = toPositiveInt(req.params.id);
  if (Number.isNaN(id)) return bad(res, 'Branch ID must be a positive whole number');
  if (!isPlainObject(req.body) || typeof req.body.is_active !== 'boolean') return bad(res, 'is_active must be true or false');
  const active = req.body.is_active;

  try {
    if (!active) await expireStalePayments();
    await withTransaction(async (conn) => {
      const [rows] = await conn.execute('SELECT name, is_active FROM branches WHERE branch_id = ? FOR UPDATE', [id]);
      const b = rows[0];
      if (!b) throw new HttpError(404, 'Branch not found');
      if (!!b.is_active === active) return;

      if (!active) {
        const k = await countBlockers(conn, id);
        const parts = [];
        if (k.open_loans) parts.push(`${k.open_loans} open loan(s)`);
        if (k.pending_payments) parts.push(`${k.pending_payments} pending payment request(s)`);
        if (k.active_staff) parts.push(`${k.active_staff} active staff account(s)`);
        if (k.active_members) parts.push(`${k.active_members} active member(s)`);
        if (parts.length) {
          const err = new HttpError(409, `This branch cannot be deactivated yet: ${parts.join(', ')}. Resolve these first.`);
          err.blockers = k;
          throw err;
        }
      }
      await conn.execute('UPDATE branches SET is_active = ? WHERE branch_id = ?', [active ? 1 : 0, id]);
      await logAudit(conn, req.user.user_id, active ? 'branch_activated' : 'branch_deactivated', 'branch', id, b.name);
    });
    res.json({ branch: await getBranch(pool, id) });
  } catch (err) {
    handleError(res, 'Branch status error', err);
  }
});

module.exports = router;