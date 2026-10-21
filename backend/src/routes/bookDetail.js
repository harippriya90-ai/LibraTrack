const express = require('express');
const QRCode = require('qrcode');
const pool = require('../config/db');
const { authenticate } = require('../middleware/auth');

const router = express.Router();

function toId(v) {
  return typeof v === 'string' && /^\d{1,9}$/.test(v) && Number(v) > 0 ? Number(v) : NaN;
}
const scope = (req, col) => (req.user.role === 'staff' ? { sql: ` AND ${col} = ?`, params: [req.user.branch_id] } : { sql: '', params: [] });

// GET /api/books/:id/details : book, stock per branch, borrowing history, summary
router.get('/:id/details', authenticate, async (req, res) => {
  const id = toId(req.params.id);
  if (Number.isNaN(id)) return res.status(400).json({ error: 'Book ID must be a positive whole number' });
  try {
    const [bk] = await pool.execute('SELECT * FROM books WHERE book_id = ?', [id]);
    if (!bk[0]) return res.status(404).json({ error: 'Book not found' });
    const s1 = scope(req, 'va.branch_id');
    const [stock] = await pool.execute(
      `SELECT va.branch_id, br.name AS branch_name, va.total_copies, va.available_copies
         FROM v_branch_availability va JOIN branches br ON br.branch_id = va.branch_id
        WHERE va.book_id = ?${s1.sql} ORDER BY br.name`, [id, ...s1.params]);
    const s2 = scope(req, 'v.branch_id');
    const [loans] = await pool.execute(
      `SELECT v.loan_id, m.full_name AS member_name, br.name AS branch_name, v.issue_date, v.due_date,
              v.return_date, v.loan_status, v.overdue_days, v.fine_amount, v.fine_paid
         FROM v_loan_details v
         JOIN members m ON m.member_id = v.member_id
         JOIN branches br ON br.branch_id = v.branch_id
        WHERE v.book_id = ?${s2.sql}
        ORDER BY v.issue_date DESC, v.loan_id DESC LIMIT 100`, [id, ...s2.params]);
    const [[sm]] = await pool.execute(
      `SELECT COUNT(*) AS loans_total, COUNT(CASE WHEN v.return_date IS NULL THEN 1 END) AS open_loans,
              COUNT(CASE WHEN v.loan_status = 'overdue' THEN 1 END) AS overdue_now,
              COALESCE(SUM(v.fine_paid), 0) AS fines_collected
         FROM v_loan_details v WHERE v.book_id = ?${s2.sql}`, [id, ...s2.params]);
    res.json({
      book: bk[0],
      stock,
      loans,
      summary: {
        total_copies: stock.reduce((a, x) => a + Number(x.total_copies), 0),
        available_copies: stock.reduce((a, x) => a + Math.max(0, Number(x.available_copies)), 0),
        loans_total: Number(sm.loans_total),
        open_loans: Number(sm.open_loans),
        overdue_now: Number(sm.overdue_now),
        fines_collected: Number(sm.fines_collected).toFixed(2),
      },
      scope: req.user.role === 'staff' ? 'your branch' : 'all branches',
    });
  } catch (err) {
    console.error('Book details error:', err.message);
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
});

// GET /api/books/:id/qr : QR image holding only a link to the book page (opening it needs a login)
router.get('/:id/qr', authenticate, async (req, res) => {
  const id = toId(req.params.id);
  if (Number.isNaN(id)) return res.status(400).json({ error: 'Book ID must be a positive whole number' });
  try {
    const [bk] = await pool.execute('SELECT book_id FROM books WHERE book_id = ?', [id]);
    if (!bk[0]) return res.status(404).json({ error: 'Book not found' });
    const base = (process.env.PUBLIC_URL || `http://localhost:${process.env.PORT || 3000}`).replace(/\/+$/, '');
    const link = `${base}/#book-${id}`;
    const qr = await QRCode.toDataURL(link, { errorCorrectionLevel: 'M', margin: 2, width: 200 });
    res.json({ link, qr });
  } catch (err) {
    console.error('Book QR error:', err.message);
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
});

module.exports = router;