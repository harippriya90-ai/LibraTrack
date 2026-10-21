const express = require('express');
const pool = require('../config/db');
const { authenticate, requireRole } = require('../middleware/auth');
const { HttpError, withTransaction, logAudit } = require('../services/dbHelpers');

const router = express.Router();
const STATUS_FILTERS = ['active', 'inactive', 'all'];
const PLAN_COLUMNS = ['name', 'duration_months', 'fee', 'max_loans', 'loan_days', 'is_active'];

// ---------- helpers ----------
function toPositiveInt(v) {
  if (typeof v === 'number' && Number.isInteger(v) && v > 0) return v;
  if (typeof v === 'string' && /^\d{1,9}$/.test(v) && Number(v) > 0) return Number(v);
  return NaN;
}
function intInRange(v, min, max) {
  let n = NaN;
  if (typeof v === 'number' && Number.isInteger(v)) n = v;
  else if (typeof v === 'string' && /^\d{1,4}$/.test(v)) n = Number(v);
  return n >= min && n <= max ? n : NaN;
}
function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}
function bad(res, message) {
  return res.status(400).json({ error: message });
}
function shape(p) {
  return { ...p, is_active: !!p.is_active, in_use: !!p.in_use };
}
function handleError(res, label, err) {
  if (err instanceof HttpError) {
    const body = { error: err.message };
    if (err.fields) body.fields = err.fields;
    return res.status(err.status).json(body);
  }
  if (err && err.code === 'ER_DUP_ENTRY') {
    return res.status(409).json({ error: 'A plan with this name already exists', fields: { name: 'Already in use' } });
  }
  console.error(`${label}:`, err.message);
  return res.status(500).json({ error: 'Something went wrong. Please try again.' });
}

function validatePlan(body, partial) {
  const v = {};
  const errors = {};
  const has = (k) => Object.prototype.hasOwnProperty.call(body, k);

  if (has('name') || !partial) {
    const s = typeof body.name === 'string' ? body.name.trim().replace(/\s+/g, ' ') : '';
    if (s.length < 2 || s.length > 60) errors.name = 'Name must be 2-60 characters';
    else v.name = s;
  }
  if (has('duration_months') || !partial) {
    const n = intInRange(body.duration_months, 1, 60);
    if (Number.isNaN(n)) errors.duration_months = 'Duration must be a whole number of months from 1 to 60';
    else v.duration_months = n;
  }
  if (has('fee') || !partial) {
    let s;
    if (typeof body.fee === 'number' && Number.isFinite(body.fee)) s = String(body.fee);
    else if (typeof body.fee === 'string') s = body.fee.trim();
    if (s === undefined || !/^\d{1,8}(\.\d{1,2})?$/.test(s)) {
      errors.fee = 'Fee must be a non-negative amount with at most 2 decimals';
    } else {
      v.fee = Number(s).toFixed(2);
    }
  }
  if (has('max_loans')) {
    const n = intInRange(body.max_loans, 1, 50);
    if (Number.isNaN(n)) errors.max_loans = 'Max loans must be a whole number from 1 to 50';
    else v.max_loans = n;
  }
  if (has('loan_days')) {
    const n = intInRange(body.loan_days, 1, 120);
    if (Number.isNaN(n)) errors.loan_days = 'Loan days must be a whole number from 1 to 120';
    else v.loan_days = n;
  }
  if (partial && has('is_active')) {
    if (typeof body.is_active !== 'boolean') errors.is_active = 'is_active must be true or false';
    else v.is_active = body.is_active ? 1 : 0;
  }
  return { values: v, errors };
}

const PLAN_SELECT = `SELECT p.plan_id, p.name, p.duration_months, p.fee, p.max_loans, p.loan_days, p.is_active,
       (EXISTS (SELECT 1 FROM memberships ms WHERE ms.plan_id = p.plan_id)
        OR EXISTS (SELECT 1 FROM payment_requests pr WHERE pr.plan_id = p.plan_id)) AS in_use
  FROM membership_plans p`;

async function getPlan(db, id) {
  const [rows] = await db.execute(`${PLAN_SELECT} WHERE p.plan_id = ?`, [id]);
  return rows[0] ? shape(rows[0]) : null;
}

async function ensureNameFree(conn, name, exceptId) {
  const [r] = await conn.execute(
    'SELECT plan_id FROM membership_plans WHERE name = ? AND plan_id <> ? LIMIT 1',
    [name, exceptId]
  );
  if (r.length) throw new HttpError(409, 'A plan with this name already exists', { name: 'Already in use' });
}

// ---------- GET /api/plans?status=active|inactive|all ----------
router.get('/', authenticate, async (req, res) => {
  const status = req.query.status === undefined || req.query.status === '' ? 'active' : req.query.status;
  if (!STATUS_FILTERS.includes(status)) return bad(res, 'status must be active, inactive or all');
  const where = status === 'active' ? 'WHERE p.is_active = 1' : status === 'inactive' ? 'WHERE p.is_active = 0' : '';
  try {
    const [rows] = await pool.query(`${PLAN_SELECT} ${where} ORDER BY p.duration_months, p.name`);
    res.json({ data: rows.map(shape) });
  } catch (err) {
    handleError(res, 'Plans list error', err);
  }
});

// ---------- POST /api/plans (admin) ----------
router.post('/', authenticate, requireRole('admin'), async (req, res) => {
  if (!isPlainObject(req.body)) return bad(res, 'Send the plan details as a JSON object');
  const { values, errors } = validatePlan(req.body, false);
  if (Object.keys(errors).length) {
    return res.status(400).json({ error: 'Please correct the highlighted fields', fields: errors });
  }
  try {
    const id = await withTransaction(async (conn) => {
      await ensureNameFree(conn, values.name, 0);
      const [r] = await conn.execute(
        'INSERT INTO membership_plans (name, duration_months, fee, max_loans, loan_days) VALUES (?, ?, ?, ?, ?)',
        [values.name, values.duration_months, values.fee, values.max_loans ?? 3, values.loan_days ?? 14]
      );
      await logAudit(conn, req.user.user_id, 'plan_created', 'plan', r.insertId,
        `${values.name}, ${values.duration_months} month(s), fee ${values.fee}`);
      return r.insertId;
    });
    res.status(201).json({ plan: await getPlan(pool, id) });
  } catch (err) {
    handleError(res, 'Create plan error', err);
  }
});

// ---------- PATCH /api/plans/:id (admin) ----------
// Existing memberships and payment requests keep their own copy of the terms and fee.
router.patch('/:id', authenticate, requireRole('admin'), async (req, res) => {
  const id = toPositiveInt(req.params.id);
  if (Number.isNaN(id)) return bad(res, 'Plan ID must be a positive whole number');
  if (!isPlainObject(req.body)) return bad(res, 'Send the changes as a JSON object');
  const { values, errors } = validatePlan(req.body, true);
  if (Object.keys(errors).length) {
    return res.status(400).json({ error: 'Please correct the highlighted fields', fields: errors });
  }
  if (Object.keys(values).length === 0) return bad(res, 'No changes supplied');

  try {
    const changed = await withTransaction(async (conn) => {
      const [rows] = await conn.execute('SELECT * FROM membership_plans WHERE plan_id = ? FOR UPDATE', [id]);
      const old = rows[0];
      if (!old) throw new HttpError(404, 'Plan not found');
      if (values.name) await ensureNameFree(conn, values.name, id);

      const sets = [];
      const sp = [];
      const notes = [];
      for (const key of Object.keys(values)) {
        if (!PLAN_COLUMNS.includes(key)) continue;
        if (String(old[key]) === String(values[key])) continue;
        sets.push(`${key} = ?`);
        sp.push(values[key]);
        notes.push(`${key}: ${old[key]} -> ${values[key]}`);
      }
      if (sets.length) {
        await conn.execute(`UPDATE membership_plans SET ${sets.join(', ')} WHERE plan_id = ?`, [...sp, id]);
        await logAudit(conn, req.user.user_id, 'plan_updated', 'plan', id, notes.join('; '));
      }
      return sets.length > 0;
    });
    res.json({ plan: await getPlan(pool, id), changed });
  } catch (err) {
    handleError(res, 'Update plan error', err);
  }
});

// ---------- DELETE /api/plans/:id (admin, only a plan nobody has used) ----------
router.delete('/:id', authenticate, requireRole('admin'), async (req, res) => {
  const id = toPositiveInt(req.params.id);
  if (Number.isNaN(id)) return bad(res, 'Plan ID must be a positive whole number');
  try {
    await withTransaction(async (conn) => {
      const [rows] = await conn.execute('SELECT name FROM membership_plans WHERE plan_id = ? FOR UPDATE', [id]);
      if (!rows[0]) throw new HttpError(404, 'Plan not found');
      const [[u]] = await conn.execute(
        `SELECT (SELECT COUNT(*) FROM memberships WHERE plan_id = ?)
              + (SELECT COUNT(*) FROM payment_requests WHERE plan_id = ?) AS n`,
        [id, id]
      );
      if (Number(u.n) > 0) {
        throw new HttpError(409, 'This plan is used by memberships or payment requests and cannot be deleted. Deactivate it instead.');
      }
      await conn.execute('DELETE FROM membership_plans WHERE plan_id = ?', [id]);
      await logAudit(conn, req.user.user_id, 'plan_deleted', 'plan', id, rows[0].name);
    });
    res.json({ message: 'Plan deleted' });
  } catch (err) {
    handleError(res, 'Delete plan error', err);
  }
});

module.exports = router;