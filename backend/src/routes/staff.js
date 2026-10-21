const express = require('express');
const bcrypt = require('bcryptjs');
const pool = require('../config/db');
const { authenticate, requireRole } = require('../middleware/auth');
const { HttpError, withTransaction, logAudit } = require('../services/dbHelpers');
const { makeReport } = require('../services/reportEngine');
const { tempPassword } = require('../services/passwords');

const router = express.Router();
const USERNAME_RE = /^[A-Za-z0-9._-]{3,50}$/;

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
    return res.status(409).json({ error: 'This username is already taken', fields: { username: 'Already in use' } });
  }
  if (err && (err.code === 'ER_LOCK_DEADLOCK' || err.code === 'ER_LOCK_WAIT_TIMEOUT')) {
    return res.status(503).json({ error: 'The system is busy. Please try again.' });
  }
  console.error(`${label}:`, err.message);
  return res.status(500).json({ error: 'Something went wrong. Please try again.' });
}
function shapeStaff(r) {
  return { ...r, is_active: !!r.is_active, is_locked: !!r.is_locked, must_change_password: !!r.must_change_password };
}
// Password hashes are never selected.
async function getStaff(db, id) {
  const [rows] = await db.execute(
    `SELECT u.user_id, u.username, u.full_name, u.role, u.branch_id, b.name AS branch_name, u.is_active,
            (u.locked_until IS NOT NULL AND u.locked_until > NOW()) AS is_locked,
            u.must_change_password, u.last_login_at, u.created_at
       FROM users u LEFT JOIN branches b ON b.branch_id = u.branch_id
      WHERE u.user_id = ?`,
    [id]
  );
  return rows[0] ? shapeStaff(rows[0]) : null;
}
async function ensureActiveBranch(conn, branchId) {
  const [rows] = await conn.execute('SELECT is_active FROM branches WHERE branch_id = ?', [branchId]);
  if (!rows[0]) throw new HttpError(404, 'Branch not found');
  if (!rows[0].is_active) throw new HttpError(409, 'This branch is inactive');
}
// Locks the account row; only branch staff accounts can be changed through this API.
async function lockStaff(conn, id) {
  const [rows] = await conn.execute(
    'SELECT user_id, username, full_name, role, branch_id, is_active FROM users WHERE user_id = ? FOR UPDATE',
    [id]
  );
  const u = rows[0];
  if (!u) throw new HttpError(404, 'Account not found');
  if (u.role !== 'staff') throw new HttpError(409, 'Administrator accounts are managed outside the application.');
  return u;
}

// ---------- GET /api/staff (list, filters, paging, CSV) ----------
const listDef = {
  name: 'staff-accounts',
  fileName: 'staff-accounts',
  select: `u.user_id, u.username, u.full_name, u.role, u.branch_id, b.name AS branch_name, u.is_active,
           (u.locked_until IS NOT NULL AND u.locked_until > NOW()) AS is_locked,
           u.must_change_password, u.last_login_at, u.created_at`,
  from: 'FROM users u LEFT JOIN branches b ON b.branch_id = u.branch_id',
  scopeColumn: null,
  filters: [
    { name: 'role', type: 'enum', values: ['admin', 'staff'], sql: 'u.role = ?' },
    { name: 'status', type: 'enum', values: { active: 'u.is_active = 1', inactive: 'u.is_active = 0' } },
    { name: 'branch_id', type: 'int', sql: 'u.branch_id = ?' },
    { name: 'search', type: 'like', cols: ['u.username', 'u.full_name'] },
  ],
  sorts: {
    username: 'u.username', name: 'u.full_name', role: 'u.role', branch: 'b.name',
    last_login: 'u.last_login_at', created: 'u.created_at',
  },
  defaultOrder: 'u.role ASC, u.username ASC',
  tieBreaker: 'u.user_id ASC',
  totals: `COUNT(*) AS total,
           COALESCE(SUM(u.is_active = 1), 0) AS active,
           COALESCE(SUM(u.role = 'admin'), 0) AS admins,
           COALESCE(SUM(u.role = 'staff'), 0) AS staff`,
  shape: shapeStaff,
  csv: [
    { key: 'user_id', header: 'User ID' },
    { key: 'username', header: 'Username', text: true },
    { key: 'full_name', header: 'Full name', text: true },
    { key: 'role', header: 'Role' },
    { key: 'branch_name', header: 'Branch', text: true },
    { key: 'is_active', header: 'Active' },
    { key: 'is_locked', header: 'Locked' },
    { key: 'must_change_password', header: 'Must change password' },
    { key: 'last_login_at', header: 'Last login' },
    { key: 'created_at', header: 'Created' },
  ],
};
router.get('/', authenticate, requireRole('admin'), makeReport(listDef));

// ---------- GET /api/staff/:id (detail plus recent account activity) ----------
router.get('/:id', authenticate, requireRole('admin'), async (req, res) => {
  const id = toPositiveInt(req.params.id);
  if (Number.isNaN(id)) return bad(res, 'Account ID must be a positive whole number');
  try {
    const staff = await getStaff(pool, id);
    if (!staff) return res.status(404).json({ error: 'Account not found' });
    const [activity] = await pool.execute(
      `SELECT action, entity_type, entity_id, details, created_at
         FROM audit_logs WHERE user_id = ?
        ORDER BY created_at DESC, audit_id DESC LIMIT 20`,
      [id]
    );
    res.json({ staff, activity });
  } catch (err) {
    handleError(res, 'Staff detail error', err);
  }
});

// ---------- POST /api/staff : create a branch staff account ----------
// body: { username, full_name, branch_id }   (a "role" in the body is ignored: always staff)
router.post('/', authenticate, requireRole('admin'), async (req, res) => {
  if (!isPlainObject(req.body)) return bad(res, 'Send the account details as a JSON object');
  const errors = {};
  const username = typeof req.body.username === 'string' ? req.body.username.trim() : '';
  if (!USERNAME_RE.test(username)) errors.username = 'Username must be 3-50 characters: letters, digits, . _ -';
  const fullName = typeof req.body.full_name === 'string' ? req.body.full_name.trim().replace(/\s+/g, ' ') : '';
  if (fullName.length < 2 || fullName.length > 100) errors.full_name = 'Full name must be 2-100 characters';
  const branchId = toPositiveInt(req.body.branch_id);
  if (Number.isNaN(branchId)) errors.branch_id = 'Branch is required';
  if (Object.keys(errors).length) return bad(res, 'Please correct the highlighted fields', errors);

  try {
    const temp = tempPassword();
    const hash = await bcrypt.hash(temp, 12);
    const id = await withTransaction(async (conn) => {
      await ensureActiveBranch(conn, branchId);
      const [dup] = await conn.execute('SELECT user_id FROM users WHERE username = ? LIMIT 1', [username]);
      if (dup[0]) throw new HttpError(409, 'This username is already taken', { username: 'Already in use' });
      const [r] = await conn.execute(
        `INSERT INTO users (username, password_hash, full_name, role, branch_id, must_change_password)
         VALUES (?, ?, ?, 'staff', ?, 1)`,
        [username, hash, fullName, branchId]
      );
      await logAudit(conn, req.user.user_id, 'staff_created', 'user', r.insertId, `${username}; branch ${branchId}`);
      return r.insertId;
    });
    // The temporary password is shown only here, once, and is never stored or logged in readable form.
    res.set('Cache-Control', 'no-store');
    res.status(201).json({ staff: await getStaff(pool, id), temporary_password: temp, must_change_password: true });
  } catch (err) {
    handleError(res, 'Create staff error', err);
  }
});

// ---------- PATCH /api/staff/:id : edit name or branch ----------
router.patch('/:id', authenticate, requireRole('admin'), async (req, res) => {
  const id = toPositiveInt(req.params.id);
  if (Number.isNaN(id)) return bad(res, 'Account ID must be a positive whole number');
  if (!isPlainObject(req.body)) return bad(res, 'Send the changes as a JSON object');

  const has = (k) => Object.prototype.hasOwnProperty.call(req.body, k);
  const errors = {};
  let fullName = null;
  if (has('full_name')) {
    fullName = typeof req.body.full_name === 'string' ? req.body.full_name.trim().replace(/\s+/g, ' ') : '';
    if (fullName.length < 2 || fullName.length > 100) errors.full_name = 'Full name must be 2-100 characters';
  }
  let newBranch = null;
  if (has('branch_id')) {
    newBranch = toPositiveInt(req.body.branch_id);
    if (Number.isNaN(newBranch)) errors.branch_id = 'Branch must be a positive whole number';
  }
  if (Object.keys(errors).length) return bad(res, 'Please correct the highlighted fields', errors);
  if (fullName === null && newBranch === null) return bad(res, 'No changes supplied');

  try {
    await withTransaction(async (conn) => {
      const u = await lockStaff(conn, id);
      const sets = [];
      const sp = [];
      const nameChanged = fullName !== null && fullName !== u.full_name;
      const branchChanged = newBranch !== null && newBranch !== u.branch_id;
      if (nameChanged) { sets.push('full_name = ?'); sp.push(fullName); }
      if (branchChanged) {
        await ensureActiveBranch(conn, newBranch);
        sets.push('branch_id = ?');
        sp.push(newBranch);
      }
      if (!sets.length) return;
      await conn.execute(`UPDATE users SET ${sets.join(', ')} WHERE user_id = ?`, [...sp, id]);
      if (nameChanged) await logAudit(conn, req.user.user_id, 'staff_updated', 'user', id, 'changed: full_name');
      if (branchChanged) {
        await logAudit(conn, req.user.user_id, 'staff_branch_changed', 'user', id, `branch ${u.branch_id} -> ${newBranch}`);
      }
    });
    res.json({ staff: await getStaff(pool, id) });
  } catch (err) {
    handleError(res, 'Update staff error', err);
  }
});

// ---------- PATCH /api/staff/:id/status : deactivate / reactivate ----------
router.patch('/:id/status', authenticate, requireRole('admin'), async (req, res) => {
  const id = toPositiveInt(req.params.id);
  if (Number.isNaN(id)) return bad(res, 'Account ID must be a positive whole number');
  if (!isPlainObject(req.body) || typeof req.body.is_active !== 'boolean') return bad(res, 'is_active must be true or false');
  const active = req.body.is_active;
  try {
    await withTransaction(async (conn) => {
      const u = await lockStaff(conn, id);
      if (!!u.is_active === active) return;
      if (active) await ensureActiveBranch(conn, u.branch_id);
      await conn.execute('UPDATE users SET is_active = ? WHERE user_id = ?', [active ? 1 : 0, id]);
      await logAudit(conn, req.user.user_id, active ? 'staff_reactivated' : 'staff_deactivated', 'user', id, u.username);
    });
    res.json({ staff: await getStaff(pool, id) });
  } catch (err) {
    handleError(res, 'Staff status error', err);
  }
});

// ---------- POST /api/staff/:id/reset-password ----------
router.post('/:id/reset-password', authenticate, requireRole('admin'), async (req, res) => {
  const id = toPositiveInt(req.params.id);
  if (Number.isNaN(id)) return bad(res, 'Account ID must be a positive whole number');
  try {
    const temp = tempPassword();
    const hash = await bcrypt.hash(temp, 12);
    await withTransaction(async (conn) => {
      const u = await lockStaff(conn, id);
      await conn.execute(
        `UPDATE users
            SET password_hash = ?, must_change_password = 1, password_changed_at = NULL,
                failed_attempts = 0, locked_until = NULL
          WHERE user_id = ?`,
        [hash, id]
      );
      await logAudit(conn, req.user.user_id, 'staff_password_reset', 'user', id, u.username);
    });
    res.set('Cache-Control', 'no-store');
    res.json({ staff: await getStaff(pool, id), temporary_password: temp, must_change_password: true });
  } catch (err) {
    handleError(res, 'Staff password reset error', err);
  }
});

module.exports = router;