const express = require('express');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const pool = require('../config/db');
const { authenticate } = require('../middleware/auth');
const { HttpError, withTransaction, logAudit } = require('../services/dbHelpers');

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
function bad(res, message) {
  return res.status(400).json({ error: message });
}
function handleError(res, label, err) {
  if (err instanceof HttpError) {
    const body = { error: err.message };
    if (err.fields) body.fields = err.fields;
    return res.status(err.status).json(body);
  }
  if (err && err.code === 'ER_DUP_ENTRY') {
    const m = String(err.message);
    if (m.includes('uq_member_email')) {
      return res.status(409).json({ error: 'A member with this email already exists', fields: { email: 'Already registered' } });
    }
    if (m.includes('uq_member_phone')) {
      return res.status(409).json({ error: 'A member with this phone number already exists', fields: { phone: 'Already registered' } });
    }
    return res.status(409).json({ error: 'This record already exists' });
  }
  console.error(`${label}:`, err.message);
  return res.status(500).json({ error: 'Something went wrong. Please try again.' });
}

// Random 12-character temporary password with upper, lower, digit and symbol; no look-alike characters.
function tempPassword() {
  const U = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
  const L = 'abcdefghjkmnpqrstuvwxyz';
  const D = '23456789';
  const S = '@#$%';
  const pick = (set) => set[crypto.randomInt(set.length)];
  const chars = [pick(U), pick(L), pick(D), pick(S)];
  while (chars.length < 12) chars.push(pick(U + L + D));
  for (let i = chars.length - 1; i > 0; i--) {
    const j = crypto.randomInt(i + 1);
    [chars[i], chars[j]] = [chars[j], chars[i]];
  }
  return chars.join('');
}

function validateMember(body, partial) {
  const v = {};
  const errors = {};
  const has = (k) => Object.prototype.hasOwnProperty.call(body, k);

  if (has('full_name') || !partial) {
    const s = typeof body.full_name === 'string' ? body.full_name.trim().replace(/\s+/g, ' ') : '';
    if (!s) errors.full_name = 'Full name is required';
    else if (s.length < 2 || s.length > 100 || !/\p{L}/u.test(s)) {
      errors.full_name = 'Full name must be 2-100 characters and contain letters';
    } else v.full_name = s;
  }
  if (has('email') || !partial) {
    const s = typeof body.email === 'string' ? body.email.trim().toLowerCase() : '';
    if (!s) errors.email = 'Email is required';
    else if (s.length > 120 || !EMAIL_RE.test(s)) errors.email = 'Enter a valid email address';
    else v.email = s;
  }
  if (has('phone') || !partial) {
    const raw = typeof body.phone === 'string' ? body.phone.trim() : '';
    const s = raw.replace(/[\s\-().]/g, '');
    if (!raw) errors.phone = 'Phone number is required';
    else if (!/^\+?\d{7,15}$/.test(s)) errors.phone = 'Enter a valid phone number (7-15 digits, optional leading +)';
    else v.phone = s;
  }
  return { values: v, errors };
}

async function getMemberView(db, id) {
  const [rows] = await db.execute(
    `SELECT m.member_id, m.full_name, m.email, m.phone, m.home_branch_id, b.name AS branch_name,
            m.registered_on, m.is_active, vs.effective_status,
            EXISTS (SELECT 1 FROM member_accounts ma WHERE ma.member_id = m.member_id) AS has_login
       FROM members m
       JOIN branches b ON b.branch_id = m.home_branch_id
       JOIN v_member_status vs ON vs.member_id = m.member_id
      WHERE m.member_id = ?`,
    [id]
  );
  const m = rows[0];
  return m ? { ...m, is_active: !!m.is_active, has_login: !!m.has_login } : null;
}

// Loads and locks the member, then checks ownership against the database value.
async function loadMember(conn, req, id) {
  const [rows] = await conn.execute(
    'SELECT member_id, full_name, email, phone, home_branch_id, is_active FROM members WHERE member_id = ? FOR UPDATE',
    [id]
  );
  const m = rows[0];
  if (!m) throw new HttpError(404, 'Member not found');
  if (req.user.role === 'staff' && m.home_branch_id !== req.user.branch_id) {
    throw new HttpError(403, 'This member belongs to another branch');
  }
  return m;
}

async function ensureActiveBranch(conn, branchId) {
  const [rows] = await conn.execute('SELECT is_active FROM branches WHERE branch_id = ?', [branchId]);
  if (!rows[0]) throw new HttpError(404, 'Branch not found');
  if (!rows[0].is_active) throw new HttpError(409, 'This branch is inactive');
}

async function ensureUnique(conn, values, exceptId) {
  const fields = {};
  if (values.email) {
    const [r] = await conn.execute('SELECT member_id FROM members WHERE email = ? AND member_id <> ? LIMIT 1', [values.email, exceptId]);
    if (r.length) fields.email = 'Already registered';
  }
  if (values.phone) {
    const [r] = await conn.execute('SELECT member_id FROM members WHERE phone = ? AND member_id <> ? LIMIT 1', [values.phone, exceptId]);
    if (r.length) fields.phone = 'Already registered';
  }
  if (Object.keys(fields).length) {
    throw new HttpError(409, 'A member with this email or phone number already exists', fields);
  }
}

// ---------- POST /api/members : register ----------
router.post('/', authenticate, async (req, res) => {
  if (!isPlainObject(req.body)) return bad(res, 'Send the member details as a JSON object');
  const { values, errors } = validateMember(req.body, false);
  if (Object.keys(errors).length) {
    return res.status(400).json({ error: 'Please correct the highlighted fields', fields: errors });
  }

  let branchId;
  if (req.user.role === 'staff') {
    branchId = req.user.branch_id; // from the database, never from the request
    const sent = req.body.home_branch_id;
    if (sent !== undefined && sent !== null && toPositiveInt(sent) !== branchId) {
      return res.status(403).json({ error: 'You can only register members at your own branch' });
    }
  } else {
    branchId = toPositiveInt(req.body.home_branch_id);
    if (Number.isNaN(branchId)) return bad(res, 'home_branch_id is required for administrators');
  }

  try {
    const id = await withTransaction(async (conn) => {
      await ensureActiveBranch(conn, branchId);
      await ensureUnique(conn, values, 0);
      const [r] = await conn.execute(
        `INSERT INTO members (full_name, email, phone, home_branch_id, registered_on, is_active)
         VALUES (?, ?, ?, ?, CURDATE(), 1)`,
        [values.full_name, values.email, values.phone, branchId]
      );
      await logAudit(conn, req.user.user_id, 'member_created', 'member', r.insertId, `branch ${branchId}`);
      return r.insertId;
    });
    res.status(201).json({ member: await getMemberView(pool, id) });
  } catch (err) {
    handleError(res, 'Register member error', err);
  }
});

// ---------- PATCH /api/members/:id : edit (only fields you send change) ----------
router.patch('/:id', authenticate, async (req, res) => {
  const id = toPositiveInt(req.params.id);
  if (Number.isNaN(id)) return bad(res, 'Member ID must be a positive whole number');
  if (!isPlainObject(req.body)) return bad(res, 'Send the changes as a JSON object');

  const { values, errors } = validateMember(req.body, true);
  if (Object.keys(errors).length) {
    return res.status(400).json({ error: 'Please correct the highlighted fields', fields: errors });
  }

  let newBranch = null;
  if (Object.prototype.hasOwnProperty.call(req.body, 'home_branch_id')) {
    newBranch = toPositiveInt(req.body.home_branch_id);
    if (Number.isNaN(newBranch)) return bad(res, 'home_branch_id must be a positive whole number');
    if (req.user.role === 'staff' && newBranch !== req.user.branch_id) {
      return res.status(403).json({ error: 'Only an administrator can move a member to another branch' });
    }
  }
  if (Object.keys(values).length === 0 && newBranch === null) return bad(res, 'No changes supplied');

  try {
    const changed = await withTransaction(async (conn) => {
      const m = await loadMember(conn, req, id);
      await ensureUnique(conn, values, id);

      const sets = [];
      const sp = [];
      const parts = [];
      const changedFields = [];

      if (values.full_name !== undefined && values.full_name !== m.full_name) {
        sets.push('full_name = ?'); sp.push(values.full_name); changedFields.push('full_name');
      }
      if (values.email !== undefined && values.email !== String(m.email).toLowerCase()) {
        sets.push('email = ?'); sp.push(values.email); changedFields.push('email');
      }
      if (values.phone !== undefined && values.phone !== m.phone) {
        sets.push('phone = ?'); sp.push(values.phone); changedFields.push('phone');
      }
      if (changedFields.length) parts.push(`changed: ${changedFields.join(', ')}`);

      if (newBranch !== null && newBranch !== m.home_branch_id) {
        await ensureActiveBranch(conn, newBranch);
        sets.push('home_branch_id = ?'); sp.push(newBranch);
        parts.push(`home_branch_id: ${m.home_branch_id} -> ${newBranch}`);
      }

      if (sets.length) {
        await conn.execute(`UPDATE members SET ${sets.join(', ')} WHERE member_id = ?`, [...sp, id]);
        await logAudit(conn, req.user.user_id, 'member_updated', 'member', id, parts.join('; '));
      }
      return sets.length > 0;
    });
    res.json({ member: await getMemberView(pool, id), changed });
  } catch (err) {
    handleError(res, 'Update member error', err);
  }
});

// ---------- PATCH /api/members/:id/status : deactivate / reactivate (keeps all history) ----------
router.patch('/:id/status', authenticate, async (req, res) => {
  const id = toPositiveInt(req.params.id);
  if (Number.isNaN(id)) return bad(res, 'Member ID must be a positive whole number');
  if (!isPlainObject(req.body) || typeof req.body.is_active !== 'boolean') {
    return bad(res, 'is_active must be true or false');
  }
  const active = req.body.is_active;

  try {
    await withTransaction(async (conn) => {
      const m = await loadMember(conn, req, id);
      if (!!m.is_active !== active) {
        await conn.execute('UPDATE members SET is_active = ? WHERE member_id = ?', [active ? 1 : 0, id]);
        await logAudit(conn, req.user.user_id, active ? 'member_reactivated' : 'member_deactivated', 'member', id, null);
      }
    });
    res.json({ member: await getMemberView(pool, id) });
  } catch (err) {
    handleError(res, 'Member status error', err);
  }
});

// ---------- DELETE /api/members/:id : only a member with no history at all ----------
router.delete('/:id', authenticate, async (req, res) => {
  const id = toPositiveInt(req.params.id);
  if (Number.isNaN(id)) return bad(res, 'Member ID must be a positive whole number');

  try {
    await withTransaction(async (conn) => {
      await loadMember(conn, req, id);
      const [[h]] = await conn.execute(
        `SELECT (SELECT COUNT(*) FROM memberships WHERE member_id = ?)
              + (SELECT COUNT(*) FROM payment_requests WHERE member_id = ?)
              + (SELECT COUNT(*) FROM loans WHERE member_id = ?)
              + (SELECT COUNT(*) FROM incidents WHERE member_id = ?)
              + (SELECT COUNT(*) FROM member_restrictions WHERE member_id = ?)
              + (SELECT COUNT(*) FROM ebook_access WHERE member_id = ?) AS n`,
        [id, id, id, id, id, id]
      );
      if (Number(h.n) > 0) {
        throw new HttpError(409, 'This member has membership, payment, loan or activity history and cannot be deleted. Deactivate the member instead.');
      }
      await conn.execute('DELETE FROM member_accounts WHERE member_id = ?', [id]);
      await conn.execute('DELETE FROM members WHERE member_id = ?', [id]);
      await logAudit(conn, req.user.user_id, 'member_deleted', 'member', id, null);
    });
    res.json({ message: 'Member deleted' });
  } catch (err) {
    handleError(res, 'Delete member error', err);
  }
});

// ---------- POST /api/members/:id/account : create portal login, or reset its password ----------
router.post('/:id/account', authenticate, async (req, res) => {
  const id = toPositiveInt(req.params.id);
  if (Number.isNaN(id)) return bad(res, 'Member ID must be a positive whole number');

  try {
    const temp = tempPassword();
    const hash = await bcrypt.hash(temp, 12);

    const out = await withTransaction(async (conn) => {
      const m = await loadMember(conn, req, id);
      if (!m.is_active) throw new HttpError(409, 'This member is deactivated. Reactivate the member first.');

      const [acct] = await conn.execute('SELECT member_id FROM member_accounts WHERE member_id = ? FOR UPDATE', [id]);
      if (acct[0]) {
        await conn.execute(
          `UPDATE member_accounts
              SET password_hash = ?, must_change_password = 1, is_active = 1,
                  failed_attempts = 0, locked_until = NULL, password_changed_at = NULL
            WHERE member_id = ?`,
          [hash, id]
        );
        await logAudit(conn, req.user.user_id, 'member_password_reset', 'member', id, null);
        return { created: false, email: m.email };
      }
      await conn.execute(
        'INSERT INTO member_accounts (member_id, password_hash, must_change_password, created_by) VALUES (?, ?, 1, ?)',
        [id, hash, req.user.user_id]
      );
      await logAudit(conn, req.user.user_id, 'member_account_created', 'member', id, null);
      return { created: true, email: m.email };
    });

    // The temporary password is shown only here, once. It is never stored in readable form or logged.
    res.set('Cache-Control', 'no-store');
    res.status(out.created ? 201 : 200).json({
      member_id: id,
      login_email: out.email,
      temporary_password: temp,
      must_change_password: true,
      created: out.created,
    });
  } catch (err) {
    handleError(res, 'Member account error', err);
  }
});

module.exports = router;