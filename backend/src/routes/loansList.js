const express = require('express');
const pool = require('../config/db');
const { authenticate } = require('../middleware/auth');
const { branchScope, scopeCondition } = require('../middleware/branchScope');
const { LOAN_COLUMNS, LOAN_FROM } = require('../services/loanQueries');

const router = express.Router();
const PAGE_SIZE = 10;
const STATUSES = ['active', 'overdue', 'returned', 'open'];

// Whitelisted sort columns; user input never goes into SQL directly.
const SORTS = {
  loan_id: 'v.loan_id',
  issue_date: 'v.issue_date',
  due_date: 'v.due_date',
  return_date: 'v.return_date',
  member: 'mem.full_name',
  title: 'bk.title',
  overdue_days: 'v.overdue_days',
  fine: 'v.fine_amount',
};

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
function bad(res, message) {
  return res.status(400).json({ error: message });
}

// GET /api/loans?page=&loan_id=&member_id=&member_name=&book_id=&book=&status=
//     &issued_from=&issued_to=&due_from=&due_to=&returned_from=&returned_to=
//     &min_fine=&max_fine=&branch_id=&sort=&dir=
router.get('/', authenticate, branchScope, async (req, res) => {
  try {
    const q = req.query;
    const conds = [];
    const params = [];

    const sc = scopeCondition(req, 'v.branch_id');
    conds.push(sc.sql);
    params.push(...sc.params);

    for (const [key, col] of [['loan_id', 'v.loan_id'], ['member_id', 'v.member_id'], ['book_id', 'v.book_id']]) {
      const n = intParam(q[key]);
      if (Number.isNaN(n)) return bad(res, `${key} must be a positive whole number`);
      if (n) {
        conds.push(`${col} = ?`);
        params.push(n);
      }
    }

    const name = cleanText(q.member_name, 100);
    if (name) {
      conds.push('mem.full_name LIKE ?');
      params.push(`%${escapeLike(name)}%`);
    }
    const book = cleanText(q.book, 100);
    if (book) {
      const like = `%${escapeLike(book)}%`;
      conds.push('(bk.title LIKE ? OR bk.author LIKE ? OR bk.isbn LIKE ?)');
      params.push(like, like, like);
    }

    if (q.status !== undefined && q.status !== '') {
      if (!STATUSES.includes(q.status)) return bad(res, `status must be one of: ${STATUSES.join(', ')}`);
      if (q.status === 'open') conds.push("v.loan_status IN ('active', 'overdue')");
      else {
        conds.push('v.loan_status = ?');
        params.push(q.status);
      }
    }

    for (const [key, col, op] of [
      ['issued_from', 'v.issue_date', '>='],
      ['issued_to', 'v.issue_date', '<='],
      ['due_from', 'v.due_date', '>='],
      ['due_to', 'v.due_date', '<='],
      ['returned_from', 'v.return_date', '>='],
      ['returned_to', 'v.return_date', '<='],
    ]) {
      const d = dateParam(q[key]);
      if (Number.isNaN(d)) return bad(res, `${key} must be a valid date (YYYY-MM-DD)`);
      if (d) {
        conds.push(`${col} ${op} ?`);
        params.push(d);
      }
    }

    for (const [key, op] of [['min_fine', '>='], ['max_fine', '<=']]) {
      const m = moneyParam(q[key]);
      if (Number.isNaN(m)) return bad(res, `${key} must be a non-negative amount`);
      if (m !== null) {
        conds.push(`v.fine_amount ${op} ?`);
        params.push(m);
      }
    }

    if (q.sort !== undefined && q.sort !== '' && !Object.prototype.hasOwnProperty.call(SORTS, q.sort)) {
      return bad(res, `sort must be one of: ${Object.keys(SORTS).join(', ')}`);
    }
    const dir = q.dir === 'desc' ? 'DESC' : 'ASC';
    const orderBy = q.sort ? `${SORTS[q.sort]} ${dir}, v.loan_id DESC` : 'v.issue_date DESC, v.loan_id DESC';

    const where = `WHERE ${conds.join(' AND ')}`;
    const page = getPage(req);

    const [[{ total }]] = await pool.query(`SELECT COUNT(*) AS total ${LOAN_FROM} ${where}`, params);
    const [rows] = await pool.query(
      `SELECT ${LOAN_COLUMNS} ${LOAN_FROM} ${where} ORDER BY ${orderBy} LIMIT ? OFFSET ?`,
      [...params, PAGE_SIZE, (page - 1) * PAGE_SIZE]
    );

    res.json({
      data: rows,
      page,
      page_size: PAGE_SIZE,
      total,
      total_pages: Math.ceil(total / PAGE_SIZE),
      scope_branch_id: req.scope.branchId,
    });
  } catch (err) {
    console.error('Loans list error:', err.message);
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
});

module.exports = router;