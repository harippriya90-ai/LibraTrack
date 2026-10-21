const express = require('express');
const crypto = require('crypto');
const pool = require('../config/db');
const { authenticate, requireRole } = require('../middleware/auth');
const { branchScope, scopeCondition } = require('../middleware/branchScope');
const { HttpError, withTransaction, logAudit } = require('../services/dbHelpers');

const router = express.Router();
const PAGE_SIZE = 10;
const TYPES = ['damage', 'theft_concealment'];
const STATUSES = ['reported', 'decided', 'resolved', 'dismissed'];
const DECISIONS = ['replace_and_suspend', 'permanent_restriction', 'no_action'];
// Which decisions make sense for which kind of incident.
const ALLOWED = {
  damage: ['replace_and_suspend', 'no_action'],
  theft_concealment: ['permanent_restriction', 'no_action'],
};

// ---------- helpers ----------
function toPositiveInt(v) {
  if (typeof v === 'number' && Number.isInteger(v) && v > 0) return v;
  if (typeof v === 'string' && /^\d{1,9}$/.test(v) && Number(v) > 0) return Number(v);
  return NaN;
}
function intParam(v) {
  return v === undefined || v === '' ? null : toPositiveInt(v);
}
function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}
function cleanText(v, min, max) {
  const s = typeof v === 'string' ? v.trim() : '';
  return s.length >= min && s.length <= max ? s : null;
}
function getPage(req) {
  return Math.min(1000000, Math.max(1, parseInt(req.query.page, 10) || 1));
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

async function setting(conn, key) {
  const [rows] = await conn.execute('SELECT setting_value FROM system_settings WHERE setting_key = ?', [key]);
  return rows[0] ? rows[0].setting_value : null;
}
async function getSuspensionDays(conn) {
  const n = Number(await setting(conn, 'suspension_days_damage'));
  return Number.isInteger(n) && n >= 1 && n <= 365 ? n : 14;
}
// Off unless an administrator adds the setting allow_self_verification = '1'.
async function selfDecisionAllowed(conn) {
  return (await setting(conn, 'allow_self_verification')) === '1';
}

const INC_COLUMNS = `i.incident_id, i.incident_ref, i.incident_type, i.status, i.decision,
       i.loan_id, i.member_id, m.full_name AS member_name, i.branch_id, b.name AS branch_name,
       i.book_id, bk.title AS book_title, i.book_edition, i.book_isbn, i.description,
       i.reported_at, ru.full_name AS reported_by_name, i.decision_notes, i.decided_at,
       du.full_name AS decided_by_name, i.replacement_received, i.resolved_at`;
const INC_FROM = `FROM incidents i
       JOIN members m ON m.member_id = i.member_id
       JOIN branches b ON b.branch_id = i.branch_id
       JOIN books bk ON bk.book_id = i.book_id
       JOIN users ru ON ru.user_id = i.reported_by
       LEFT JOIN users du ON du.user_id = i.decided_by`;

function shapeIncident(r) {
  return { ...r, replacement_received: !!r.replacement_received };
}
async function getIncident(db, id) {
  const [rows] = await db.execute(`SELECT ${INC_COLUMNS} ${INC_FROM} WHERE i.incident_id = ?`, [id]);
  return rows[0] ? shapeIncident(rows[0]) : null;
}

const RESTRICTION_SELECT = `SELECT r.restriction_id, r.member_id, r.kind, r.start_date, r.end_date, r.reason,
       i.incident_ref, au.full_name AS approved_by_name, r.created_at,
       r.revoked_at, rv.full_name AS revoked_by_name, r.revoke_reason,
       (r.revoked_at IS NULL AND (r.kind = 'restriction' OR CURDATE() BETWEEN r.start_date AND r.end_date)) AS is_active_now
  FROM member_restrictions r
  LEFT JOIN incidents i ON i.incident_id = r.incident_id
  JOIN users au ON au.user_id = r.approved_by
  LEFT JOIN users rv ON rv.user_id = r.revoked_by`;
function shapeRestriction(r) {
  return { ...r, is_active_now: !!r.is_active_now };
}
async function getRestriction(db, id) {
  const [rows] = await db.execute(`${RESTRICTION_SELECT} WHERE r.restriction_id = ?`, [id]);
  return rows[0] ? shapeRestriction(rows[0]) : null;
}

// ---------- POST /api/incidents : report ----------
// body: { loan_id, incident_type: 'damage' | 'theft_concealment', description }
router.post('/incidents', authenticate, async (req, res) => {
  if (!isPlainObject(req.body)) return bad(res, 'Send the incident details as a JSON object');

  const errors = {};
  const loanId = toPositiveInt(req.body.loan_id);
  if (Number.isNaN(loanId)) errors.loan_id = 'Loan ID is required';
  const type = req.body.incident_type;
  if (!TYPES.includes(type)) errors.incident_type = `Type must be one of: ${TYPES.join(', ')}`;
  const description = cleanText(req.body.description, 10, 2000);
  if (!description) errors.description = 'Describe what happened (10-2000 characters)';
  if (Object.keys(errors).length) return bad(res, 'Please correct the highlighted fields', errors);

  try {
    const id = await withTransaction(async (conn) => {
      // Lock only the loan row, so two reports for the same loan are handled one after the other.
      const [lrows] = await conn.execute(
        `SELECT l.loan_id, l.member_id, l.branch_id, l.book_id, bk.edition, bk.isbn
           FROM loans l JOIN books bk ON bk.book_id = l.book_id
          WHERE l.loan_id = ? FOR UPDATE OF l`,
        [loanId]
      );
      const loan = lrows[0];
      if (!loan) throw new HttpError(404, 'Loan not found');
      if (req.user.role === 'staff' && loan.branch_id !== req.user.branch_id) {
        throw new HttpError(403, 'This loan belongs to another branch');
      }

      const [dup] = await conn.execute(
        "SELECT incident_ref FROM incidents WHERE loan_id = ? AND incident_type = ? AND status IN ('reported', 'decided') LIMIT 1",
        [loanId, type]
      );
      if (dup[0]) {
        throw new HttpError(409, `An open ${type} incident (${dup[0].incident_ref}) already exists for this loan.`);
      }

      // Edition and ISBN are recorded so a replacement can be matched exactly.
      const temp = `TMP-${crypto.randomBytes(7).toString('hex')}`;
      const [ins] = await conn.execute(
        `INSERT INTO incidents
           (incident_ref, incident_type, loan_id, member_id, branch_id, book_id,
            book_edition, book_isbn, description, reported_by)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [temp, type, loanId, loan.member_id, loan.branch_id, loan.book_id, loan.edition, loan.isbn, description, req.user.user_id]
      );
      const [[y]] = await conn.execute('SELECT YEAR(CURDATE()) AS y');
      const ref = `INC-${y.y}-${String(ins.insertId).padStart(4, '0')}`;
      await conn.execute('UPDATE incidents SET incident_ref = ? WHERE incident_id = ?', [ref, ins.insertId]);
      await logAudit(conn, req.user.user_id, 'incident_reported', 'incident', ins.insertId,
        `${ref}; ${type}; loan ${loanId}; member ${loan.member_id}`);
      return ins.insertId;
    });
    res.status(201).json({ incident: await getIncident(pool, id) });
  } catch (err) {
    handleError(res, 'Report incident error', err);
  }
});

// ---------- GET /api/incidents ----------
router.get('/incidents', authenticate, branchScope, async (req, res) => {
  try {
    const q = req.query;
    const conds = [];
    const params = [];

    const sc = scopeCondition(req, 'i.branch_id');
    conds.push(sc.sql);
    params.push(...sc.params);

    for (const [key, col] of [['incident_id', 'i.incident_id'], ['member_id', 'i.member_id'], ['loan_id', 'i.loan_id']]) {      const n = intParam(q[key]);
      if (Number.isNaN(n)) return bad(res, `${key} must be a positive whole number`);
      if (n) {
        conds.push(`${col} = ?`);
        params.push(n);
      }
    }
    if (q.type !== undefined && q.type !== '') {
      if (!TYPES.includes(q.type)) return bad(res, `type must be one of: ${TYPES.join(', ')}`);
      conds.push('i.incident_type = ?');
      params.push(q.type);
    }
    if (q.status !== undefined && q.status !== '') {
      if (!STATUSES.includes(q.status)) return bad(res, `status must be one of: ${STATUSES.join(', ')}`);
      conds.push('i.status = ?');
      params.push(q.status);
    }
    for (const [key, upper] of [['reported_from', false], ['reported_to', true]]) {
      const d = dateParam(q[key]);
      if (Number.isNaN(d)) return bad(res, `${key} must be a valid date (YYYY-MM-DD)`);
      if (d) {
        conds.push(upper ? 'i.reported_at < DATE_ADD(?, INTERVAL 1 DAY)' : 'i.reported_at >= ?');
        params.push(d);
      }
    }

    const where = `WHERE ${conds.join(' AND ')}`;
    const page = getPage(req);
    const [[{ total }]] = await pool.query(`SELECT COUNT(*) AS total ${INC_FROM} ${where}`, params);
    const [rows] = await pool.query(
      `SELECT ${INC_COLUMNS} ${INC_FROM} ${where} ORDER BY i.reported_at DESC, i.incident_id DESC LIMIT ? OFFSET ?`,
      [...params, PAGE_SIZE, (page - 1) * PAGE_SIZE]
    );
    res.json({
      data: rows.map(shapeIncident),
      page,
      page_size: PAGE_SIZE,
      total,
      total_pages: Math.ceil(total / PAGE_SIZE),
      scope_branch_id: req.scope.branchId,
    });
  } catch (err) {
    handleError(res, 'Incidents list error', err);
  }
});

// ---------- GET /api/incidents/:id ----------
router.get('/incidents/:id', authenticate, async (req, res) => {
  const id = toPositiveInt(req.params.id);
  if (Number.isNaN(id)) return bad(res, 'Incident ID must be a positive whole number');
  try {
    const incident = await getIncident(pool, id);
    if (!incident) return res.status(404).json({ error: 'Incident not found' });
    if (req.user.role === 'staff' && incident.branch_id !== req.user.branch_id) {
      return res.status(403).json({ error: 'This incident belongs to another branch' });
    }
    res.json({ incident });
  } catch (err) {
    handleError(res, 'Incident detail error', err);
  }
});

// ---------- POST /api/incidents/:id/decide (admin only) ----------
// body: { decision: 'replace_and_suspend' | 'permanent_restriction' | 'no_action', notes }
router.post('/incidents/:id/decide', authenticate, requireRole('admin'), async (req, res) => {
  const id = toPositiveInt(req.params.id);
  if (Number.isNaN(id)) return bad(res, 'Incident ID must be a positive whole number');
  if (!isPlainObject(req.body)) return bad(res, 'Send the decision as a JSON object');

  const decision = req.body.decision;
  const errors = {};
  if (!DECISIONS.includes(decision)) errors.decision = `Decision must be one of: ${DECISIONS.join(', ')}`;
  // A permanent restriction must be documented in more detail.
  const minNotes = decision === 'permanent_restriction' ? 20 : 10;
  const notes = cleanText(req.body.notes, minNotes, 2000);
  if (!notes) errors.notes = `Record the reasons for the decision (${minNotes}-2000 characters)`;
  if (Object.keys(errors).length) return bad(res, 'Please correct the highlighted fields', errors);

  try {
    const restrictionId = await withTransaction(async (conn) => {
      const [rows] = await conn.execute(
        `SELECT incident_id, incident_ref, incident_type, member_id, status, reported_by
           FROM incidents WHERE incident_id = ? FOR UPDATE`,
        [id]
      );
      const inc = rows[0];
      if (!inc) throw new HttpError(404, 'Incident not found');
      if (inc.status !== 'reported') throw new HttpError(409, 'This incident was already decided.');
      if (!ALLOWED[inc.incident_type].includes(decision)) {
        throw new HttpError(400, `The decision "${decision}" is not allowed for a ${inc.incident_type} incident.`);
      }
      if (inc.reported_by === req.user.user_id && !(await selfDecisionAllowed(conn))) {
        throw new HttpError(403, 'You cannot decide an incident that you reported yourself. Another administrator must review it.');
      }

      let rid = null;
      if (decision === 'replace_and_suspend') {
        const days = await getSuspensionDays(conn);
        await conn.execute(
          `UPDATE incidents SET status = 'decided', decision = ?, decision_notes = ?, decided_by = ?, decided_at = NOW()
            WHERE incident_id = ?`,
          [decision, notes, req.user.user_id, id]
        );
        const [r] = await conn.execute(
          `INSERT INTO member_restrictions (member_id, kind, start_date, end_date, reason, incident_id, approved_by)
           VALUES (?, 'suspension', CURDATE(), DATE_ADD(CURDATE(), INTERVAL ? DAY), ?, ?, ?)`,
          [inc.member_id, days, `Damaged book (${inc.incident_ref}): ${days}-day suspension`, id, req.user.user_id]
        );
        rid = r.insertId;
      } else if (decision === 'permanent_restriction') {
        await conn.execute(
          `UPDATE incidents SET status = 'resolved', decision = ?, decision_notes = ?, decided_by = ?,
                  decided_at = NOW(), resolved_at = NOW()
            WHERE incident_id = ?`,
          [decision, notes, req.user.user_id, id]
        );
        const [r] = await conn.execute(
          `INSERT INTO member_restrictions (member_id, kind, start_date, end_date, reason, incident_id, approved_by)
           VALUES (?, 'restriction', CURDATE(), NULL, ?, ?, ?)`,
          [inc.member_id, `Confirmed theft or deliberate concealment (${inc.incident_ref})`, id, req.user.user_id]
        );
        rid = r.insertId;
      } else {
        await conn.execute(
          `UPDATE incidents SET status = 'dismissed', decision = ?, decision_notes = ?, decided_by = ?,
                  decided_at = NOW(), resolved_at = NOW()
            WHERE incident_id = ?`,
          [decision, notes, req.user.user_id, id]
        );
      }
      await logAudit(conn, req.user.user_id, 'incident_decided', 'incident', id,
        `${inc.incident_ref}; ${decision}${rid ? `; restriction ${rid}` : ''}`);
      return rid;
    });

    res.json({
      incident: await getIncident(pool, id),
      restriction: restrictionId ? await getRestriction(pool, restrictionId) : null,
    });
  } catch (err) {
    handleError(res, 'Decide incident error', err);
  }
});

// ---------- POST /api/incidents/:id/resolve (admin only): replacement received ----------
// body: { notes }
router.post('/incidents/:id/resolve', authenticate, requireRole('admin'), async (req, res) => {
  const id = toPositiveInt(req.params.id);
  if (Number.isNaN(id)) return bad(res, 'Incident ID must be a positive whole number');
  const notes = cleanText(isPlainObject(req.body) ? req.body.notes : undefined, 10, 1000);
  if (!notes) return bad(res, 'Please correct the highlighted fields', { notes: 'Describe the replacement received (10-1000 characters)' });

  try {
    await withTransaction(async (conn) => {
      const [rows] = await conn.execute(
        'SELECT incident_ref, status, decision FROM incidents WHERE incident_id = ? FOR UPDATE',
        [id]
      );
      const inc = rows[0];
      if (!inc) throw new HttpError(404, 'Incident not found');
      if (inc.status !== 'decided' || inc.decision !== 'replace_and_suspend') {
        throw new HttpError(409, 'Only a damage incident that is awaiting a replacement can be resolved.');
      }
      await conn.execute(
        `UPDATE incidents
            SET status = 'resolved', replacement_received = 1, resolved_at = NOW(),
                decision_notes = CONCAT(COALESCE(decision_notes, ''), '\n\nReplacement received: ', ?)
          WHERE incident_id = ?`,
        [notes, id]
      );
      await logAudit(conn, req.user.user_id, 'incident_resolved', 'incident', id, `${inc.incident_ref}; replacement received`);
    });
    res.json({ incident: await getIncident(pool, id) });
  } catch (err) {
    handleError(res, 'Resolve incident error', err);
  }
});

// ---------- POST /api/restrictions/:id/revoke (admin only) ----------
// body: { reason }
router.post('/restrictions/:id/revoke', authenticate, requireRole('admin'), async (req, res) => {
  const id = toPositiveInt(req.params.id);
  if (Number.isNaN(id)) return bad(res, 'Restriction ID must be a positive whole number');
  const reason = cleanText(isPlainObject(req.body) ? req.body.reason : undefined, 10, 255);
  if (!reason) return bad(res, 'Please correct the highlighted fields', { reason: 'Give a reason of 10-255 characters' });

  try {
    await withTransaction(async (conn) => {
      const [rows] = await conn.execute(
        `SELECT restriction_id, member_id, kind, revoked_at,
                (end_date IS NOT NULL AND end_date < CURDATE()) AS ended
           FROM member_restrictions WHERE restriction_id = ? FOR UPDATE`,
        [id]
      );
      const r = rows[0];
      if (!r) throw new HttpError(404, 'Restriction not found');
      if (r.revoked_at) throw new HttpError(409, 'This restriction was already lifted.');
      if (r.ended) throw new HttpError(409, 'This suspension has already ended.');
      await conn.execute(
        'UPDATE member_restrictions SET revoked_at = NOW(), revoked_by = ?, revoke_reason = ? WHERE restriction_id = ?',
        [req.user.user_id, reason, id]
      );
      await logAudit(conn, req.user.user_id, 'restriction_revoked', 'member', r.member_id,
        `${r.kind} ${id} lifted`);
    });
    res.json({ restriction: await getRestriction(pool, id) });
  } catch (err) {
    handleError(res, 'Revoke restriction error', err);
  }
});

// ---------- GET /api/members/:id/restrictions : suspension and restriction history ----------
router.get('/members/:id/restrictions', authenticate, async (req, res) => {
  const id = toPositiveInt(req.params.id);
  if (Number.isNaN(id)) return bad(res, 'Member ID must be a positive whole number');
  try {
    const [mrows] = await pool.execute('SELECT home_branch_id FROM members WHERE member_id = ?', [id]);
    if (!mrows[0]) return res.status(404).json({ error: 'Member not found' });
    if (req.user.role === 'staff' && mrows[0].home_branch_id !== req.user.branch_id) {
      return res.status(403).json({ error: 'This member belongs to another branch' });
    }
    const [rows] = await pool.execute(
      `${RESTRICTION_SELECT} WHERE r.member_id = ? ORDER BY r.created_at DESC, r.restriction_id DESC`,
      [id]
    );
    res.json({ data: rows.map(shapeRestriction) });
  } catch (err) {
    handleError(res, 'Member restrictions error', err);
  }
});

module.exports = router;