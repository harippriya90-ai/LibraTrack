// Shared SQL for loan listings and details. Only the borrower's name and ID are shown,
// never email or phone.
const LOAN_COLUMNS = `v.loan_id, v.member_id, mem.full_name AS member_name, v.book_id,
       bk.title, bk.author, bk.edition, bk.isbn, v.branch_id, br.name AS branch_name,
       v.issue_date, v.due_date, v.return_date, v.loan_status, v.overdue_days,
       v.fine_rate_snapshot AS fine_rate, v.grace_days_snapshot AS grace_days,
       v.fine_cap_snapshot AS fine_cap, v.fine_kind, v.fine_amount, v.fine_paid,
       GREATEST(v.fine_amount - v.fine_paid, 0) AS fine_balance,
       iu.full_name AS issued_by_name, ru.full_name AS returned_by_name`;

const LOAN_FROM = `FROM v_loan_details v
       JOIN loans l ON l.loan_id = v.loan_id
       JOIN members mem ON mem.member_id = v.member_id
       JOIN books bk ON bk.book_id = v.book_id
       JOIN branches br ON br.branch_id = v.branch_id
       JOIN users iu ON iu.user_id = l.issued_by
       LEFT JOIN users ru ON ru.user_id = l.returned_by`;

async function getLoan(db, id) {
  const [rows] = await db.execute(`SELECT ${LOAN_COLUMNS} ${LOAN_FROM} WHERE v.loan_id = ?`, [id]);
  return rows[0] || null;
}

async function getStock(db, branchId, bookId) {
  const [rows] = await db.execute(
    `SELECT total_copies, on_loan, GREATEST(available_copies, 0) AS available_copies
       FROM v_branch_availability WHERE branch_id = ? AND book_id = ?`,
    [branchId, bookId]
  );
  const s = rows[0];
  return s
    ? { total_copies: Number(s.total_copies), on_loan: Number(s.on_loan), available_copies: Number(s.available_copies) }
    : { total_copies: 0, on_loan: 0, available_copies: 0 };
}

module.exports = { LOAN_COLUMNS, LOAN_FROM, getLoan, getStock };