const express = require('express');
const pool = require('../config/db');
const { authenticate, requireRole } = require('../middleware/auth');
const { makeReport } = require('../services/reportEngine');

const router = express.Router();

// Read-only: there is deliberately no route that changes or deletes an entry.
const auditLog = {
  name: 'audit-log',
  fileName: 'audit-log',
  select: `a.audit_id, a.created_at, a.user_id, u.username, u.full_name AS user_full_name,
           a.action, a.entity_type, a.entity_id, a.details`,
  from: 'FROM audit_logs a LEFT JOIN users u ON u.user_id = a.user_id',
  scopeColumn: null,
  filters: [
    { name: 'user_id', type: 'int', sql: 'a.user_id = ?' },
    { name: 'username', type: 'like', cols: ['u.username'] },
    { name: 'action', type: 'exact', sql: 'a.action = ?', max: 60 },
    { name: 'entity_type', type: 'exact', sql: 'a.entity_type = ?', max: 40 },
    { name: 'entity_id', type: 'exact', sql: 'a.entity_id = ?', max: 40 },
    { name: 'search', type: 'like', cols: ['a.action', 'a.details'], max: 100 },
    { name: 'from', type: 'date', sql: 'a.created_at >= ?' },
    { name: 'to', type: 'date', sql: 'a.created_at < DATE_ADD(?, INTERVAL 1 DAY)' },
  ],
  sorts: { time: 'a.created_at', action: 'a.action', user: 'u.username', entity: 'a.entity_type' },
  defaultOrder: 'a.created_at DESC, a.audit_id DESC',
  tieBreaker: 'a.audit_id DESC',
  csv: [
    { key: 'audit_id', header: 'Entry' },
    { key: 'created_at', header: 'Time' },
    { key: 'username', header: 'User', text: true },
    { key: 'user_full_name', header: 'User name', text: true },
    { key: 'action', header: 'Action' },
    { key: 'entity_type', header: 'Entity type' },
    { key: 'entity_id', header: 'Entity ID', text: true },
    { key: 'details', header: 'Details', text: true },
  ],
};

// GET /api/audit-logs/actions : the list of action names (for a filter drop-down)
router.get('/actions', authenticate, requireRole('admin'), async (req, res) => {
  try {
    const [rows] = await pool.query('SELECT DISTINCT action FROM audit_logs ORDER BY action');
    res.json({ data: rows.map((r) => r.action) });
  } catch (err) {
    console.error('Audit actions error:', err.message);
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
});

// GET /api/audit-logs?user_id=&username=&action=&entity_type=&entity_id=&search=&from=&to=&page=&format=csv
router.get('/', authenticate, requireRole('admin'), makeReport(auditLog));

module.exports = router;