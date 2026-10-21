const express = require('express');
const pool = require('../config/db');
const { authenticate } = require('../middleware/auth');
const { branchScope, scopeCondition } = require('../middleware/branchScope');
const { logAudit } = require('../services/dbHelpers');
const { toCsv } = require('../services/csv');

const router = express.Router();
const PAGE_SIZE = 10;
const CSV_MAX_ROWS = 50000;

const STATUS_SQL = {
  active: "v.loan_status = 'active'",
  overdue: "v.loan_status = 'overdue'",
  returned: "v.loan_status = 'returned'",
  open: "v.loan_status IN ('active', 'overdue')",
  returned_late: 'v.return_date IS NOT NULL AND v.overdue_days > 0',
  returned_on_time: 'v.return_date IS NOT NULL AND v.overdue_days = 0',
};
const DAYS_EXPR = 'DATEDIFF(COALESCE(v.return_date, CURDATE()), v.due_date)';

// Whitelisted sort columns; user input never goes into SQL directly.
const SORTS = {
  loan_id: 'v.loan_id',
  issue_date: 'v.issue_date',
  due_date: 'v.due_date',
  return_date: 'v.return_date',
  member: 'mem.full_name',
  title: 'bk.title',
  author: 'bk.author',
  category: 'bk.category',
  branch: 'br.name',
  overdue_days: 'v.overdue_days',
  fine: 'v.fine_amount',
  balance: 'GREATEST(v.fine_amount - v.fine_paid, 0)',
};

const COLUMNS = `v.loan_id, v.book_id, bk.title, bk.author, bk.category, v.member_id,
       mem.full_name AS member_name, v.branch_id, br.name AS branch_name,
       v.issue_date, v.due_date, v.return_date, v.loan_status,
       ${DAYS_EXPR} AS days_past_due, v.overdue_days,
       v.fine_rate_snapshot AS fine_rate, v.fine_kind, v.fine_amount, v.fine_paid,
       GREATEST(v.fine_amount - v.fine_paid, 0) AS fine_balance,
       COALESCE(lf.waived, 0) AS fine_waived`;
const FROM_SQL = `FROM v_loan_details v
       JOIN members mem ON mem.member_id = v.member_id
       JOIN books bk ON bk.book_id = v.book_id
       JOIN branches br ON br.branch_id = v.branch_id
       LEFT JOIN loan_fines lf ON lf.loan_id = v.loan_id`;

const CSV_OVERDUE = [
  { key: 'loan_id', header: 'Loan ID' },
  { key: 'book_id', header: 'Book ID' },
  { key: 'title', header: 'Book title', text: true },
  { key: 'author', header: 'Author', text: true },
  { key: 'category', header: 'Category', text: true },
  { key: 'member_id', header: 'Member ID' },
  { key: 'member_name', header: 'Member name', text: true },
  { key: 'branch_name', header: 'Branch', text: true },
  { key: 'issue_date', header: 'Issue date' },
  { key: 'due_date', header: 'Due date' },
  { key: 'days_late', header: 'Days late' },
  { key: 'overdue_days', header: 'Chargeable overdue days' },
  { key: 'fine_rate', header: 'Fine rate per day' },
  { key: 'fine_amount', header: 'Estimated fine' },
  { key: 'fine_paid', header: 'Fine paid' },
  { key: 'fine_balance', header: 'Fine balance' },
  { key: 'fine_payment_status', header: 'Fine payment status' },
];
const CSV_HISTORY = [
  { key: 'loan_id', header: 'Loan ID' },
  { key: 'book_id', header: 'Book ID' },
  { key: 'title', header: 'Book title', text: true },
  { key: 'author', header: 'Author', text: true },
  { key: 'member_id', header: 'Member ID' },
  { key: 'member_name', header: 'Member name', text: true },
  { key: 'branch_name', header: 'Branch', text: true },
  { key: 'issue_date', header: 'Issue date' },
  { key: 'due_date', header: 'Due date' },
  { key: 'return_date', header: 'Return date' },
  { key: 'loan_status', header: 'Loan status' },
  { key: 'return_timing', header: 'Return timing' },
  { key: 'overdue_days', header: 'Chargeable overdue days' },
  { key: 'fine_rate', header: 'Fine rate per day' },
  { key: 'fine_type', header: 'Fine type' },
  { key: 'fine_amount', header: 'Fine amount' },
  { key: 'fine_paid', header: 'Fine paid' },
  { key: 'fine_balance', header: 'Fine balance' },
  { key: 'fine_payment_status', header: 'Fine payment status' },
];

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
function daysParam(v) {
  if (v === undefined || v === '') return null;
  return typeof v === 'string' && /^\d{1,5}$/.test(v) ? Number(v) : NaN;
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

// Builds the WHERE clause from the query string. Returns { error } for bad input.
function buildFilters(req, kind) {
  const q = req.query;
  const conds = [];
  const params = [];

  const sc = scopeCondition(req, 'v.branch_id');
  conds.push(sc.sql);
  params.push(...sc.params);
  if (kind === 'overdue') conds.push("v.loan_status = 'overdue'");

  for (const [key, col] of [['loan_id', 'v.loan_id'], ['member_id', 'v.member_id'], ['book_id', 'v.book_id']]) {
    const n = intParam(q[key]);
    if (Number.isNaN(n)) return { error: `${key} must be a positive whole number` };
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
  const category = cleanText(q.category, 60);
  if (category) {
    conds.push('bk.category = ?');
    params.push(category);
  }

  if (kind === 'history' && q.status !== undefined && q.status !== '') {
    if (!Object.prototype.hasOwnProperty.call(STATUS_SQL, q.status)) {
      return { error: `status must be one of: ${Object.keys(STATUS_SQL).join(', ')}` };
    }
    conds.push(STATUS_SQL[q.status]);
  }

  const dateKeys = [
    ['issued_from', 'v.issue_date', '>='],
    ['issued_to', 'v.issue_date', '<='],
    ['due_from', 'v.due_date', '>='],
    ['due_to', 'v.due_date', '<='],
  ];
  if (kind === 'history') {
    dateKeys.push(['returned_from', 'v.return_date', '>='], ['returned_to', 'v.return_date', '<=']);
  }
  for (const [key, col, op] of dateKeys) {
    const d = dateParam(q[key]);
    if (Number.isNaN(d)) return { error: `${key} must be a valid date (YYYY-MM-DD)` };
    if (d) {
      conds.push(`${col} ${op} ?`);
      params.push(d);
    }
  }

  for (const [key, op] of [['min_fine', '>='], ['max_fine', '<=']]) {
    const m = moneyParam(q[key]);
    if (Number.isNaN(m)) return { error: `${key} must be a non-negative amount` };
    if (m !== null) {
      conds.push(`v.fine_amount ${op} ?`);
      params.push(m);
    }
  }
  for (const [key, op] of [['min_days', '>='], ['max_days', '<=']]) {
    const n = daysParam(q[key]);
    if (Number.isNaN(n)) return { error: `${key} must be a whole number of days` };
    if (n !== null) {
      conds.push(`${DAYS_EXPR} ${op} ?`);
      params.push(n);
    }
  }

  if (q.sort !== undefined && q.sort !== '' && !Object.prototype.hasOwnProperty.call(SORTS, q.sort)) {
    return { error: `sort must be one of: ${Object.keys(SORTS).join(', ')}` };
  }
  const dir = q.dir === 'desc' ? 'DESC' : 'ASC';
  const defaultOrder = kind === 'overdue' ? 'v.due_date ASC, v.loan_id ASC' : 'v.issue_date DESC, v.loan_id DESC';
  const orderBy = q.sort ? `${SORTS[q.sort]} ${dir}, v.loan_id DESC` : defaultOrder;

  return { where: `WHERE ${conds.join(' AND ')}`, params, orderBy };
}

function shapeRow(r) {
  const returned = r.return_date !== null;
  const total = Math.round(Number(r.fine_amount) * 100);
  const paid = Math.round(Number(r.fine_paid) * 100);
  let paymentStatus;
  if (!returned) paymentStatus = 'estimate';
  else if (r.fine_waived) paymentStatus = 'waived';
  else if (total === 0) paymentStatus = 'no_fine';
  else if (paid <= 0) paymentStatus = 'unpaid';
  else if (paid < total) paymentStatus = 'partial';
  else paymentStatus = 'paid';

  return {
    loan_id: r.loan_id,
    book_id: r.book_id,
    title: r.title,
    author: r.author,
    category: r.category,
    member_id: r.member_id,
    member_name: r.member_name,
    branch_id: r.branch_id,
    branch_name: r.branch_name,
    issue_date: r.issue_date,
    due_date: r.due_date,
    return_date: r.return_date,
    loan_status: r.loan_status,
    return_timing: returned ? (Number(r.overdue_days) > 0 ? 'late' : 'on_time') : null,
    days_late: Math.max(0, Number(r.days_past_due)),
    overdue_days: Number(r.overdue_days),
    fine_rate: r.fine_rate,
    fine_type: r.fine_kind,
    fine_amount: r.fine_amount,
    fine_paid: r.fine_paid,
    fine_balance: r.fine_balance,
    fine_payment_status: paymentStatus,
  };
}

function reportHandler(kind, fileName, csvColumns) {
  return async (req, res) => {
    try {
      const f = buildFilters(req, kind);
      if (f.error) return bad(res, f.error);
      const format = req.query.format === undefined || req.query.format === '' ? 'json' : req.query.format;
      if (format !== 'json' && format !== 'csv') return bad(res, 'format must be json or csv');

      const [[now]] = await pool.query('SELECT NOW() AS now');

      if (format === 'csv') {
        // Every matching row, not only the visible page.
        const [rows] = await pool.query(
          `SELECT ${COLUMNS} ${FROM_SQL} ${f.where} ORDER BY ${f.orderBy} LIMIT ?`,
          [...f.params, CSV_MAX_ROWS]
        );
        const stamp = String(now.now).replace(/\D/g, '');
        await logAudit(pool, req.user.user_id, 'report_exported', 'report', null,
          `${kind} report; ${rows.length} rows; branch scope ${req.scope.branchId === null ? 'all' : req.scope.branchId}`);
        res.set({
          'Content-Type': 'text/csv; charset=utf-8',
          'Content-Disposition': `attachment; filename="${fileName}-${stamp.slice(0, 8)}-${stamp.slice(8, 14)}.csv"`,
          'X-Report-Generated': now.now,
          'Cache-Control': 'private, no-store',
        });
        return res.send(toCsv(csvColumns, rows.map(shapeRow)));
      }

      const page = getPage(req);
      const [[agg]] = await pool.query(
        `SELECT COUNT(*) AS total,
                COALESCE(SUM(v.fine_amount), 0) AS fine_total,
                COALESCE(SUM(v.fine_paid), 0) AS paid_total,
                COALESCE(SUM(GREATEST(v.fine_amount - v.fine_paid, 0)), 0) AS balance_total
           ${FROM_SQL} ${f.where}`,
        f.params
      );
      const [rows] = await pool.query(
        `SELECT ${COLUMNS} ${FROM_SQL} ${f.where} ORDER BY ${f.orderBy} LIMIT ? OFFSET ?`,
        [...f.params, PAGE_SIZE, (page - 1) * PAGE_SIZE]
      );
      res.json({
        report: kind === 'overdue' ? 'overdue-loans' : 'loan-history',
        generated_at: now.now,
        data: rows.map(shapeRow),
        page,
        page_size: PAGE_SIZE,
        total: agg.total,
        total_pages: Math.ceil(agg.total / PAGE_SIZE),
        totals: {
          loans: agg.total,
          fine_total: Number(agg.fine_total).toFixed(2),
          fine_paid: Number(agg.paid_total).toFixed(2),
          fine_balance: Number(agg.balance_total).toFixed(2),
        },
        scope_branch_id: req.scope.branchId,
      });
    } catch (err) {
      console.error('Report error:', err.message);
      res.status(500).json({ error: 'Something went wrong. Please try again.' });
    }
  };
}

// Report A: loans that are overdue and not yet returned
router.get('/overdue', authenticate, branchScope, reportHandler('overdue', 'overdue-loans', CSV_OVERDUE));
// Report B: complete borrowing and return history
router.get('/loans', authenticate, branchScope, reportHandler('history', 'loan-history', CSV_HISTORY));

module.exports = router;