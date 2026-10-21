const express = require('express');
const pool = require('../config/db');
const { authenticate } = require('../middleware/auth');
const { HttpError, withTransaction, logAudit } = require('../services/dbHelpers');

const router = express.Router();

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
  if (err && (err.code === 'ER_LOCK_DEADLOCK' || err.code === 'ER_LOCK_WAIT_TIMEOUT')) {
    return res.status(503).json({ error: 'The system is busy. Please try again.' });
  }
  console.error(`${label}:`, err.message);
  return res.status(500).json({ error: 'Something went wrong. Please try again.' });
}

// Grace days and fine cap in force today; these get copied onto each new loan.
async function getFineSettings(conn) {
  const [rows] = await conn.execute(
    "SELECT setting_key, setting_value FROM system_settings WHERE setting_key IN ('grace_days', 'fine_cap')"
  );
  const map = {};
  for (const r of rows) map[r.setting_key] = r.setting_value;
  const grace = /^\d{1,3}$/.test(map.grace_days || '') ? Math.min(255, Number(map.grace_days)) : 0;
  const cap = /^\d{1,8}(\.\d{1,2})?$/.test(map.fine_cap || '') ? Number(map.fine_cap).toFixed(2) : null;
  return { grace, cap };
}

// Only the borrower's name and ID are shown; never email or phone.
const LOAN_SELECT = `SELECT v.loan_id, v.member_id, mem.full_name AS member_name, v.book_id,
       bk.title, bk.author, bk.edition, bk.isbn, v.branch_id, br.name AS branch_name,
       v.issue_date, v.due_date, v.return_date, v.loan_status, v.overdue_days,
       v.fine_rate_snapshot AS fine_rate, v.grace_days_snapshot AS grace_days,
       v.fine_cap_snapshot AS fine_cap, v.fine_kind, v.fine_amount, v.fine_paid,
       GREATEST(v.fine_amount - v.fine_paid, 0) AS fine_balance,
       iu.full_name AS issued_by_name
  FROM v_loan_details v
  JOIN loans l ON l.loan_id = v.loan_id
  JOIN members mem ON mem.member_id = v.member_id
  JOIN books bk ON bk.book_id = v.book_id
  JOIN branches br ON br.branch_id = v.branch_id
  JOIN users iu ON iu.user_id = l.issued_by`;

async function getLoan(db, id) {
  const [rows] = await db.execute(`${LOAN_SELECT} WHERE v.loan_id = ?`, [id]);
  return rows[0] || null;
}

// ---------- POST /api/loans : issue a physical book ----------
// body: { member_id, book_id, branch_id (administrators only) }
router.post('/', authenticate, async (req, res) => {
  if (!isPlainObject(req.body)) return bad(res, 'Send the loan details as a JSON object');

  const errors = {};
  const memberId = toPositiveInt(req.body.member_id);
  if (Number.isNaN(memberId)) errors.member_id = 'Member ID is required';
  const bookId = toPositiveInt(req.body.book_id);
  if (Number.isNaN(bookId)) errors.book_id = 'Book ID is required';
  if (Object.keys(errors).length) return bad(res, 'Please correct the highlighted fields', errors);

  let branchId;
  if (req.user.role === 'staff') {
    branchId = req.user.branch_id; // from the database, never from the request
    const sent = req.body.branch_id;
    if (sent !== undefined && sent !== null && toPositiveInt(sent) !== branchId) {
      return res.status(403).json({ error: 'You can only issue books at your own branch' });
    }
  } else {
    branchId = toPositiveInt(req.body.branch_id);
    if (Number.isNaN(branchId)) return bad(res, 'branch_id is required for administrators');
  }

  try {
    const loanId = await withTransaction(async (conn) => {
      // 1. Lock the member first: two issues for the same member are handled one after the other.
      const [mrows] = await conn.execute(
        'SELECT member_id, is_active FROM members WHERE member_id = ? FOR UPDATE',
        [memberId]
      );
      const member = mrows[0];
      if (!member) throw new HttpError(404, 'Member not found. Register the member before issuing a book.');
      if (!member.is_active) throw new HttpError(409, 'This member is deactivated and cannot borrow.');

      const [brows] = await conn.execute('SELECT is_active FROM branches WHERE branch_id = ?', [branchId]);
      if (!brows[0]) throw new HttpError(404, 'Branch not found');
      if (!brows[0].is_active) throw new HttpError(409, 'This branch is inactive');

      // 2. Restriction or suspension
      const [rest] = await conn.execute(
        `SELECT kind, end_date FROM member_restrictions
          WHERE member_id = ? AND revoked_at IS NULL
            AND (kind = 'restriction' OR CURDATE() BETWEEN start_date AND end_date)
          ORDER BY (kind = 'restriction') DESC, end_date DESC
          LIMIT 1`,
        [memberId]
      );
      if (rest[0]) {
        if (rest[0].kind === 'restriction') {
          throw new HttpError(409, 'This member is permanently restricted from borrowing.');
        }
        throw new HttpError(409, `This member is suspended until ${rest[0].end_date}.`);
      }

      // 3. A membership covering today (memberships exist only after a verified payment)
      const [cur] = await conn.execute(
        `SELECT membership_id, max_loans, loan_days FROM memberships
          WHERE member_id = ? AND CURDATE() BETWEEN start_date AND expiry_date
          ORDER BY expiry_date DESC, membership_id DESC
          LIMIT 1`,
        [memberId]
      );
      if (!cur[0]) {
        const [last] = await conn.execute(
          `SELECT start_date, expiry_date, (start_date > CURDATE()) AS not_started
             FROM memberships WHERE member_id = ? ORDER BY expiry_date DESC LIMIT 1`,
          [memberId]
        );
        if (!last[0]) {
          throw new HttpError(409, 'This member has no membership. A verified membership payment is required before borrowing.');
        }
        if (last[0].not_started) throw new HttpError(409, `This member's membership starts on ${last[0].start_date}.`);
        throw new HttpError(409, `This member's membership expired on ${last[0].expiry_date}.`);
      }
      const membership = cur[0];

      // 4. The book
      const [bk] = await conn.execute('SELECT book_id, fine_per_day, is_active FROM books WHERE book_id = ?', [bookId]);
      if (!bk[0]) throw new HttpError(404, 'Book not found');
      if (!bk[0].is_active) throw new HttpError(409, 'This book is archived and cannot be issued.');

      // 5. Lock this branch's stock row for the book: only one issue at a time can pass this point.
      const [inv] = await conn.execute(
        'SELECT total_copies FROM branch_inventory WHERE branch_id = ? AND book_id = ? FOR UPDATE',
        [branchId, bookId]
      );
      if (!inv[0]) throw new HttpError(409, 'This branch does not stock this book.');

      // Reads run under READ COMMITTED, so these counts include every loan committed so far.
      const [[open]] = await conn.execute(
        'SELECT COUNT(*) AS n FROM loans WHERE branch_id = ? AND book_id = ? AND return_date IS NULL',
        [branchId, bookId]
      );
      if (Number(open.n) >= Number(inv[0].total_copies)) {
        throw new HttpError(409, 'No copy of this book is available at this branch.');
      }

      // 6. Duplicate title and borrowing limit (the member row is locked, so this count is stable)
      const [mine] = await conn.execute(
        'SELECT book_id FROM loans WHERE member_id = ? AND return_date IS NULL',
        [memberId]
      );
      if (mine.some((l) => l.book_id === bookId)) {
        throw new HttpError(409, 'This member already has this book on loan.');
      }
      if (mine.length >= membership.max_loans) {
        throw new HttpError(409, `Borrowing limit reached: this member already has ${mine.length} of ${membership.max_loans} books on loan.`);
      }

      // 7. Create the loan. Dates come from the server clock. Rate, grace and cap are copied.
      const fine = await getFineSettings(conn);
      const [ins] = await conn.execute(
        `INSERT INTO loans
           (member_id, branch_id, book_id, issue_date, due_date,
            fine_rate_snapshot, grace_days_snapshot, fine_cap_snapshot, issued_by)
         VALUES (?, ?, ?, CURDATE(), DATE_ADD(CURDATE(), INTERVAL ? DAY), ?, ?, ?, ?)`,
        [memberId, branchId, bookId, membership.loan_days, bk[0].fine_per_day, fine.grace, fine.cap, req.user.user_id]
      );
      await logAudit(conn, req.user.user_id, 'loan_issued', 'loan', ins.insertId,
        `member ${memberId}, book ${bookId}, branch ${branchId}, due in ${membership.loan_days} days`);
      return ins.insertId;
    }, { isolation: 'READ COMMITTED' });

    const [[stock]] = await pool.execute(
      `SELECT total_copies, on_loan, GREATEST(available_copies, 0) AS available_copies
         FROM v_branch_availability WHERE branch_id = ? AND book_id = ?`,
      [branchId, bookId]
    );
    res.status(201).json({
      loan: await getLoan(pool, loanId),
      stock: {
        total_copies: Number(stock.total_copies),
        on_loan: Number(stock.on_loan),
        available_copies: Number(stock.available_copies),
      },
    });
  } catch (err) {
    handleError(res, 'Issue loan error', err);
  }
});

// ---------- GET /api/loans/:id ----------
router.get('/:id', authenticate, async (req, res) => {
  const id = toPositiveInt(req.params.id);
  if (Number.isNaN(id)) return bad(res, 'Loan ID must be a positive whole number');
  try {
    const loan = await getLoan(pool, id);
    if (!loan) return res.status(404).json({ error: 'Loan not found' });
    if (req.user.role === 'staff' && loan.branch_id !== req.user.branch_id) {
      return res.status(403).json({ error: 'This loan belongs to another branch' });
    }
    res.json({ loan });
  } catch (err) {
    handleError(res, 'Loan detail error', err);
  }
});

module.exports = router;