const express = require('express');
const pool = require('../config/db');
const { authenticate, requireRole } = require('../middleware/auth');
const { withTransaction, logAudit } = require('../services/dbHelpers');

const router = express.Router();

// The registry of settings: what each is, how it is validated and whether it can be edited.
const DEFS = {
  library_name: {
    label: 'Library name', type: 'text', min: 2, max: 100, editable: true,
    description: 'Display name',
    note: 'Shown in headings and reports.',
  },
  timezone: {
    label: 'Timezone', type: 'text', editable: false,
    description: 'Library timezone',
    note: 'The server runs on India time (UTC+05:30). Changing it needs a server configuration change, not a setting.',
  },
  default_fine_per_day: {
    label: 'Default fine per day (INR)', type: 'money', digits: 6, editable: true,
    description: 'Default fine per overdue day (INR) for new books',
    note: 'Pre-fills the fine rate of new books. Existing books and loans are unchanged.',
  },
  grace_days: {
    label: 'Grace days', type: 'int', min: 0, max: 30, editable: true,
    description: 'Free days after due date, copied onto each new loan',
    note: 'Copied onto each new loan. Existing loans keep the value they were issued with.',
  },
  fine_cap: {
    label: 'Maximum fine per loan (INR)', type: 'moneyOrEmpty', digits: 8, editable: true,
    description: 'Maximum fine per loan in INR; empty = no cap',
    note: 'Empty means no cap. Copied onto each new loan; existing loans are unchanged.',
  },
  payment_expiry_days: {
    label: 'Payment request expiry (days)', type: 'int', min: 1, max: 365, editable: true,
    description: 'Unverified payment requests expire after this many days',
    note: 'Applies to payment requests created from now on.',
  },
  suspension_days_damage: {
    label: 'Suspension after damage (days)', type: 'int', min: 1, max: 365, editable: true,
    description: 'Suspension length after a damage decision',
    note: 'Applies to damage decisions made from now on.',
  },
  default_loan_days: {
    label: 'Default loan period (days)', type: 'int', min: 1, max: 120, editable: true,
    description: 'Fallback loan period',
    note: "Fallback only: a loan uses the borrower's own plan period.",
  },
  allow_self_verification: {
    label: 'Allow administrators to review their own work', type: 'flag', default: '0', editable: true,
    description: 'Allow administrators to review their own payment requests and incident reports',
    note: 'When on, an administrator may verify a payment or decide an incident that they created or reported themselves. Keep it off so every decision has an independent reviewer.',
  },
};

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

// Returns { value } (the text to store) or { error }.
function parseValue(def, raw) {
  switch (def.type) {
    case 'text': {
      const s = typeof raw === 'string' ? raw.trim().replace(/\s+/g, ' ') : '';
      if (s.length < def.min || s.length > def.max) return { error: `Must be ${def.min}-${def.max} characters` };
      return { value: s };
    }
    case 'int': {
      let n = NaN;
      if (typeof raw === 'number' && Number.isInteger(raw)) n = raw;
      else if (typeof raw === 'string' && /^\d{1,4}$/.test(raw.trim())) n = Number(raw.trim());
      if (!(n >= def.min && n <= def.max)) return { error: `Must be a whole number from ${def.min} to ${def.max}` };
      return { value: String(n) };
    }
    case 'money':
    case 'moneyOrEmpty': {
      if (def.type === 'moneyOrEmpty' && (raw === null || raw === '' || (typeof raw === 'string' && raw.trim() === ''))) {
        return { value: '' };
      }
      let s;
      if (typeof raw === 'number' && Number.isFinite(raw)) s = String(raw);
      else if (typeof raw === 'string') s = raw.trim();
      const re = new RegExp(`^\\d{1,${def.digits}}(\\.\\d{1,2})?$`);
      if (s === undefined || !re.test(s)) return { error: 'Must be a non-negative amount with at most 2 decimals' };
      const v = Number(s);
      if (def.type === 'moneyOrEmpty' && v === 0) return { error: 'Must be greater than 0 (leave empty for no cap)' };
      return { value: v.toFixed(2) };
    }
    case 'flag': {
      if (raw === true || raw === 1 || raw === '1' || raw === 'true') return { value: '1' };
      if (raw === false || raw === 0 || raw === '0' || raw === 'false') return { value: '0' };
      return { error: 'Must be true or false' };
    }
    default:
      return { error: 'Unsupported setting' };
  }
}

async function buildList(isAdmin) {
  const [rows] = await pool.query(
    `SELECT s.setting_key, s.setting_value, s.updated_at, u.full_name AS updated_by_name
       FROM system_settings s LEFT JOIN users u ON u.user_id = s.updated_by`
  );
  const map = {};
  for (const r of rows) map[r.setting_key] = r;
  return Object.keys(DEFS).map((key) => {
    const def = DEFS[key];
    const row = map[key];
    return {
      key,
      label: def.label,
      type: def.type,
      value: row ? row.setting_value : def.default || '',
      editable: isAdmin && def.editable,
      note: def.note,
      updated_at: row ? row.updated_at : null,
      updated_by_name: row ? row.updated_by_name : null,
    };
  });
}

// ---------- GET /api/settings (every signed-in staff member and administrator) ----------
router.get('/', authenticate, async (req, res) => {
  try {
    res.json({ data: await buildList(req.user.role === 'admin') });
  } catch (err) {
    console.error('Settings error:', err.message);
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
});

// ---------- PATCH /api/settings (administrators only; all or nothing) ----------
// body: { "grace_days": 2, "fine_cap": "30", ... }
router.patch('/', authenticate, requireRole('admin'), async (req, res) => {
  const body = req.body;
  if (!isPlainObject(body) || Object.keys(body).length === 0) {
    return res.status(400).json({ error: 'Send the settings to change as a JSON object' });
  }

  const errors = {};
  const parsed = {};
  const readOnly = [];
  for (const [key, raw] of Object.entries(body)) {
    if (!Object.prototype.hasOwnProperty.call(DEFS, key)) {
      errors[key] = 'Unknown setting';
      continue;
    }
    const def = DEFS[key];
    if (!def.editable) {
      readOnly.push(key);
      continue;
    }
    const p = parseValue(def, raw);
    if (p.error) errors[key] = p.error;
    else parsed[key] = p.value;
  }
  if (Object.keys(errors).length) {
    return res.status(400).json({ error: 'Please correct the highlighted fields', fields: errors });
  }
  if (readOnly.length) {
    return res.status(409).json({ error: `These settings are read-only: ${readOnly.join(', ')}` });
  }

  try {
    const changed = await withTransaction(async (conn) => {
      const done = [];
      for (const key of Object.keys(parsed)) {
        const [rows] = await conn.execute('SELECT setting_value FROM system_settings WHERE setting_key = ? FOR UPDATE', [key]);
        const old = rows[0] ? rows[0].setting_value : DEFS[key].default || '';
        if (old === parsed[key]) continue;
        if (rows[0]) {
          await conn.execute(
            'UPDATE system_settings SET setting_value = ?, updated_by = ? WHERE setting_key = ?',
            [parsed[key], req.user.user_id, key]
          );
        } else {
          await conn.execute(
            'INSERT INTO system_settings (setting_key, setting_value, description, updated_by) VALUES (?, ?, ?, ?)',
            [key, parsed[key], DEFS[key].description, req.user.user_id]
          );
        }
        await logAudit(conn, req.user.user_id, 'setting_changed', 'setting', key,
          `${key}: ${old === '' ? '(empty)' : old} -> ${parsed[key] === '' ? '(empty)' : parsed[key]}`);
        done.push(key);
      }
      return done;
    });
    res.json({ changed, data: await buildList(true) });
  } catch (err) {
    console.error('Update settings error:', err.message);
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
});

module.exports = router;