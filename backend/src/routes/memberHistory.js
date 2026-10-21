const express = require('express');
const crypto = require('crypto');
const QRCode = require('qrcode');
const pool = require('../config/db');
const { authenticate } = require('../middleware/auth');
const { logAudit } = require('../services/dbHelpers');
const { toCsv } = require('../services/csv');

const router = express.Router();
const PAGE_SIZE = 10;
const ALL_ROWS_CAP = 2000;
const REF_RE = /^[0-9A-Fa-f]{24}$/;

// ---------- helpers ----------
const present = (v) => v !== undefined && v !== '';
const num = (v) => Number(v || 0);
const money = (v) => Number(v || 0).toFixed(2);
function toPositiveInt(v) {
  if (typeof v === 'number' && Number.isInteger(v) && v > 0) return v;
  if (typeof v === 'string' && /^\d{1,9}$/.test(v) && Number(v) > 0) return Number(v);
  return NaN;
}
function maskId(v) {
  if (!v) return null;
  const s = String(v);
  if (s.length <= 4) return '****';
  return `${'*'.repeat(Math.min(s.length - 4, 8))}${s.slice(-4)}`;
}
// Every value that goes into the printable page is escaped.
function esc(v) {
  return String(v === null || v === undefined ? '' : v)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
function fmt(v) {
  if (v === null || v === undefined) return '';
  if (typeof v === 'boolean') return v ? 'Yes' : 'No';
  return String(v);
}

function shapeLoan(r) {
  const returned = r.return_date !== null;
  const total = Math.round(Number(r.fine_amount) * 100);
  const paid = Math.round(Number(r.fine_paid) * 100);
  let status;
  if (!returned) status = 'estimate';
  else if (r.fine_waived) status = 'waived';
  else if (total === 0) status = 'no_fine';
  else if (paid <= 0) status = 'unpaid';
  else if (paid < total) status = 'partial';
  else status = 'paid';
  return {
    loan_id: r.loan_id, book_id: r.book_id, title: r.title, author: r.author, edition: r.edition,
    branch_name: r.branch_name, issue_date: r.issue_date, due_date: r.due_date, return_date: r.return_date,
    loan_status: r.loan_status, overdue_days: Number(r.overdue_days), fine_rate: r.fine_rate,
    fine_type: r.fine_kind, fine_amount: r.fine_amount, fine_paid: r.fine_paid, fine_balance: r.fine_balance,
    fine_payment_status: status,
  };
}

// Each section: SQL pieces plus the columns used for both the CSV and the printable page.
const SECTIONS = {
  payments: {
    title: 'Membership payments',
    select: `pr.request_id AS payment_id, pr.requested_at, p.name AS plan_name, pr.request_type, pr.amount,
             pr.method, pr.submitted_txn_id, pr.verification_txn_id, pr.status, pr.verified_at,
             vu.full_name AS verified_by_name`,
    from: `FROM payment_requests pr
           JOIN membership_plans p ON p.plan_id = pr.plan_id
           LEFT JOIN users vu ON vu.user_id = pr.verified_by`,
    where: 'pr.member_id = ?',
    order: 'pr.requested_at DESC, pr.request_id DESC',
    shape: (r) => {
      const { submitted_txn_id: s, verification_txn_id: v, ...rest } = r;
      return { ...rest, submitted_txn_masked: maskId(s), verification_txn_masked: maskId(v) };
    },
    cols: [
      { key: 'payment_id', header: 'Payment ID' },
      { key: 'requested_at', header: 'Date and time' },
      { key: 'plan_name', header: 'Plan', text: true },
      { key: 'request_type', header: 'Type' },
      { key: 'amount', header: 'Amount' },
      { key: 'method', header: 'Method' },
      { key: 'submitted_txn_masked', header: 'Submitted transaction (masked)' },
      { key: 'verification_txn_masked', header: 'Verification transaction (masked)' },
      { key: 'status', header: 'Status' },
      { key: 'verified_at', header: 'Verified at' },
      { key: 'verified_by_name', header: 'Verified by', text: true },
    ],
  },
  memberships: {
    title: 'Memberships and renewals',
    select: `ms.membership_id, p.name AS plan_name, ms.start_date, ms.expiry_date, ms.duration_months,
             ms.fee_paid, ms.renewal_of_id, (CURDATE() BETWEEN ms.start_date AND ms.expiry_date) AS is_current`,
    from: 'FROM memberships ms JOIN membership_plans p ON p.plan_id = ms.plan_id',
    where: 'ms.member_id = ?',
    order: 'ms.start_date DESC, ms.membership_id DESC',
    shape: (r) => ({ ...r, is_current: !!r.is_current }),
    cols: [
      { key: 'membership_id', header: 'Membership ID' },
      { key: 'plan_name', header: 'Plan', text: true },
      { key: 'start_date', header: 'Start date' },
      { key: 'expiry_date', header: 'Expiry date' },
      { key: 'duration_months', header: 'Months' },
      { key: 'fee_paid', header: 'Fee paid' },
      { key: 'renewal_of_id', header: 'Renewal of' },
      { key: 'is_current', header: 'Current' },
    ],
  },
  loans: {
    title: 'Borrowing history',
    select: `v.loan_id, v.book_id, bk.title, bk.author, bk.edition, br.name AS branch_name, v.issue_date,
             v.due_date, v.return_date, v.loan_status, v.overdue_days, v.fine_rate_snapshot AS fine_rate,
             v.fine_kind, v.fine_amount, v.fine_paid, GREATEST(v.fine_amount - v.fine_paid, 0) AS fine_balance,
             COALESCE(lf.waived, 0) AS fine_waived`,
    from: `FROM v_loan_details v
           JOIN books bk ON bk.book_id = v.book_id
           JOIN branches br ON br.branch_id = v.branch_id
           LEFT JOIN loan_fines lf ON lf.loan_id = v.loan_id`,
    where: 'v.member_id = ?',
    order: 'v.issue_date DESC, v.loan_id DESC',
    shape: shapeLoan,
    cols: [
      { key: 'loan_id', header: 'Loan ID' },
      { key: 'book_id', header: 'Book ID' },
      { key: 'title', header: 'Book title', text: true },
      { key: 'author', header: 'Author', text: true },
      { key: 'edition', header: 'Edition', text: true },
      { key: 'branch_name', header: 'Branch', text: true },
      { key: 'issue_date', header: 'Issue date' },
      { key: 'due_date', header: 'Due date' },
      { key: 'return_date', header: 'Return date' },
      { key: 'loan_status', header: 'Status' },
      { key: 'overdue_days', header: 'Overdue days' },
      { key: 'fine_rate', header: 'Fine rate per day' },
      { key: 'fine_type', header: 'Fine type' },
      { key: 'fine_amount', header: 'Fine amount' },
      { key: 'fine_paid', header: 'Fine paid' },
      { key: 'fine_balance', header: 'Fine balance' },
      { key: 'fine_payment_status', header: 'Fine payment status' },
    ],
  },
  restrictions: {
    title: 'Suspensions and restrictions',
    select: `r.restriction_id, r.kind, r.start_date, r.end_date, r.reason, i.incident_ref,
             au.full_name AS approved_by_name, r.revoked_at, r.revoke_reason,
             (CASE WHEN r.revoked_at IS NOT NULL THEN 'lifted'
                   WHEN r.kind = 'restriction' OR CURDATE() BETWEEN r.start_date AND r.end_date THEN 'active'
                   ELSE 'ended' END) AS state`,
    from: `FROM member_restrictions r
           LEFT JOIN incidents i ON i.incident_id = r.incident_id
           JOIN users au ON au.user_id = r.approved_by`,
    where: 'r.member_id = ?',
    order: 'r.created_at DESC, r.restriction_id DESC',
    shape: (r) => r,
    cols: [
      { key: 'restriction_id', header: 'Restriction ID' },
      { key: 'kind', header: 'Type' },
      { key: 'start_date', header: 'Start date' },
      { key: 'end_date', header: 'End date' },
      { key: 'state', header: 'State' },
      { key: 'reason', header: 'Reason', text: true },
      { key: 'incident_ref', header: 'Incident' },
      { key: 'approved_by_name', header: 'Approved by', text: true },
      { key: 'revoked_at', header: 'Lifted at' },
      { key: 'revoke_reason', header: 'Lift reason', text: true },
    ],
  },
};
const MEMBER_COLS = [
  { key: 'member_id', header: 'Member ID' },
  { key: 'full_name', header: 'Member name', text: true },
  { key: 'branch_name', header: 'Branch', text: true },
  { key: 'registered_on', header: 'Registered' },
  { key: 'status', header: 'Status' },
];

async function fetchSection(key, memberId, opts) {
  const s = SECTIONS[key];
  const [[c]] = await pool.query(`SELECT COUNT(*) AS n ${s.from} WHERE ${s.where}`, [memberId]);
  const limit = opts.all ? ALL_ROWS_CAP : PAGE_SIZE;
  const offset = opts.all ? 0 : (opts.page - 1) * PAGE_SIZE;
  const [rows] = await pool.query(
    `SELECT ${s.select} ${s.from} WHERE ${s.where} ORDER BY ${s.order} LIMIT ? OFFSET ?`,
    [memberId, limit, offset]
  );
  return {
    data: rows.map(s.shape),
    total: c.n,
    page: opts.all ? 1 : opts.page,
    page_size: limit,
    total_pages: Math.ceil(c.n / limit),
  };
}
async function allSections(memberId) {
  const out = {};
  for (const key of Object.keys(SECTIONS)) out[key] = await fetchSection(key, memberId, { all: true });
  return out;
}

async function getSummary(memberId) {
  const [[pay]] = await pool.execute(
    `SELECT COUNT(*) AS requests, COALESCE(SUM(CASE WHEN status = 'successful' THEN amount END), 0) AS paid_total
       FROM payment_requests WHERE member_id = ?`,
    [memberId]
  );
  const [[ln]] = await pool.execute(
    `SELECT COUNT(*) AS loans_total,
            COUNT(CASE WHEN return_date IS NULL THEN 1 END) AS open_loans,
            COUNT(CASE WHEN loan_status = 'overdue' THEN 1 END) AS overdue_open,
            COALESCE(SUM(CASE WHEN fine_kind = 'finalized' THEN fine_amount END), 0) AS fines_finalized,
            COALESCE(SUM(CASE WHEN fine_kind = 'estimate' THEN fine_amount END), 0) AS fines_estimated,
            COALESCE(SUM(fine_paid), 0) AS fines_paid,
            COALESCE(SUM(GREATEST(fine_amount - fine_paid, 0)), 0) AS fines_outstanding
       FROM v_loan_details WHERE member_id = ?`,
    [memberId]
  );
  const [[ms]] = await pool.execute('SELECT COUNT(*) AS n FROM memberships WHERE member_id = ?', [memberId]);
  const [[rs]] = await pool.execute(
    `SELECT COUNT(*) AS n FROM member_restrictions
      WHERE member_id = ? AND revoked_at IS NULL AND (kind = 'restriction' OR CURDATE() BETWEEN start_date AND end_date)`,
    [memberId]
  );
  return {
    payment_requests: num(pay.requests),
    payments_successful_total: money(pay.paid_total),
    memberships: num(ms.n),
    loans_total: num(ln.loans_total),
    open_loans: num(ln.open_loans),
    overdue_open_loans: num(ln.overdue_open),
    fines_finalized: money(ln.fines_finalized),
    fines_estimated_open: money(ln.fines_estimated),
    fines_paid: money(ln.fines_paid),
    fines_outstanding: money(ln.fines_outstanding),
    restrictions_active: num(rs.n),
  };
}

// Loads the member and checks the caller may see them. Sends the error response itself.
async function loadMember(req, res) {
  const id = toPositiveInt(req.params.id);
  if (Number.isNaN(id)) {
    res.status(400).json({ error: 'Member ID must be a positive whole number' });
    return null;
  }
  const [rows] = await pool.execute(
    `SELECT m.member_id, m.full_name, m.home_branch_id, b.name AS branch_name, m.registered_on,
            vs.effective_status AS status
       FROM members m
       JOIN branches b ON b.branch_id = m.home_branch_id
       JOIN v_member_status vs ON vs.member_id = m.member_id
      WHERE m.member_id = ?`,
    [id]
  );
  const m = rows[0];
  if (!m) {
    res.status(404).json({ error: 'Member not found' });
    return null;
  }
  if (req.user.role === 'staff' && m.home_branch_id !== req.user.branch_id) {
    res.status(403).json({ error: 'This member belongs to another branch' });
    return null;
  }
  return m;
}
const publicMember = (m) => ({
  member_id: m.member_id, full_name: m.full_name, branch_name: m.branch_name,
  registered_on: m.registered_on, status: m.status,
});

// A new random reference for every report. The QR code holds only this value.
async function createRef(memberId, userId) {
  const code = crypto.randomBytes(12).toString('hex').toUpperCase();
  await pool.execute('INSERT INTO member_report_refs (ref_code, member_id, generated_by) VALUES (?, ?, ?)', [code, memberId, userId]);
  return code;
}

function csvBlock(title, cols, rows) {
  const body = toCsv(cols, rows).replace(/^\uFEFF/, '').replace(/\r\n$/, '');
  return `${title}\r\n${body}`;
}

function renderHtml({ member, summary, sections, ref, generatedAt, generatedBy, qr }) {
  const table = (cols, rows) => {
    if (!rows.length) return '<p class="none">No records.</p>';
    const head = cols.map((c) => `<th>${esc(c.header)}</th>`).join('');
    const body = rows.map((r) => `<tr>${cols.map((c) => `<td>${esc(fmt(r[c.key]))}</td>`).join('')}</tr>`).join('');
    return `<table><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>`;
  };
  const section = (key) => {
    const s = SECTIONS[key];
    const d = sections[key];
    const note = d.total > d.data.length
      ? `<p class="note">Showing the first ${d.data.length} of ${d.total} records. Use the CSV download for the full list.</p>` : '';
    return `<h2>${esc(s.title)} <span class="count">(${d.total})</span></h2>${table(s.cols, d.data)}${note}`;
  };
  const kv = (label, value) => `<tr><th>${esc(label)}</th><td>${esc(value)}</td></tr>`;
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<title>Member history - ${esc(member.full_name)}</title>
<style>
:root { --turq:#14978f; --burg:#7a1c3b; --ink:#111; --line:#cfd6d9; }
@page { size: A4 landscape; margin: 10mm; }
body { font-family: Arial, Helvetica, sans-serif; color: var(--ink); background: #fff; margin: 20px; font-size: 12px; }
header { background: var(--turq); color: #fff; padding: 12px 18px; }
header h1 { margin: 0; font-size: 20px; } header p { margin: 2px 0 0; }
h2 { color: var(--burg); font-size: 14px; border-bottom: 2px solid var(--burg); padding-bottom: 4px; margin: 22px 0 0; }
.count { color: #555; font-weight: normal; }
.meta { display: flex; justify-content: space-between; gap: 24px; margin-top: 14px; }
.kv { border-collapse: collapse; } .kv th { text-align: left; padding: 3px 14px 3px 0; color: var(--burg); background: none; }
.kv td { padding: 3px 0; border: none; }
.qr img { display: block; border: 1px solid var(--line); } .qr p { margin: 4px 0 0; font-size: 10px; max-width: 180px; word-break: break-all; }
table { width: 100%; border-collapse: collapse; margin-top: 8px; font-size: 10.5px; }
th { background: var(--turq); color: #fff; text-align: left; padding: 5px 6px; }
td { border-bottom: 1px solid var(--line); padding: 4px 6px; vertical-align: top; word-break: break-word; }
.note, .none { color: #555; font-style: italic; }
footer { margin-top: 24px; font-size: 10px; color: #444; border-top: 1px solid var(--line); padding-top: 8px; }
@media print { body { margin: 0; } header, th { -webkit-print-color-adjust: exact; print-color-adjust: exact; } }
</style></head><body>
<header><h1>LibraTrack</h1><p>Member history report</p></header>
<div class="meta">
  <table class="kv">
    ${kv('Member ID', member.member_id)}${kv('Member name', member.full_name)}${kv('Branch', member.branch_name)}
    ${kv('Registered', member.registered_on)}${kv('Status', member.status)}
    ${kv('Generated', generatedAt)}${kv('Generated by', generatedBy)}
    ${kv('Payments verified (total)', summary.payments_successful_total)}
    ${kv('Open loans', summary.open_loans)}${kv('Outstanding fines', summary.fines_outstanding)}
    ${kv('Active suspensions or restrictions', summary.restrictions_active)}
  </table>
  <div class="qr"><img src="${qr}" alt="QR code for this report reference" width="180" height="180">
    <p>Report reference: <strong>${esc(ref)}</strong></p></div>
</div>
${section('payments')}${section('memberships')}${section('loans')}${section('restrictions')}
<footer>This report contains personal information and must be handled under library policy.
The QR code holds only the report reference above; looking it up requires a LibraTrack login with access to this member.
Fines marked "estimate" belong to unreturned loans and keep growing until the book is returned.</footer>
</body></html>`;
}

function pageParam(q, key) {
  if (!present(q[key])) return 1;
  return typeof q[key] === 'string' && /^\d{1,6}$/.test(q[key]) && Number(q[key]) > 0 ? Number(q[key]) : NaN;
}

// ---------- GET /api/members/:id/history  (JSON, or ?format=csv) ----------
router.get('/members/:id/history', authenticate, async (req, res) => {
  try {
    const member = await loadMember(req, res);
    if (!member) return;
    const q = req.query;
    const format = present(q.format) ? q.format : 'json';
    if (format !== 'json' && format !== 'csv') return res.status(400).json({ error: 'format must be json or csv' });
    const [[now]] = await pool.query('SELECT NOW() AS now');

    if (format === 'csv') {
      const sections = await allSections(member.member_id);
      const ref = await createRef(member.member_id, req.user.user_id);
      await logAudit(pool, req.user.user_id, 'member_history_exported', 'member', member.member_id, `csv; report ${ref}`);
      const parts = [
        `Report reference,${ref}`, `Generated at,${now.now}`, '',
        csvBlock('Member', MEMBER_COLS, [member]), '',
      ];
      for (const key of Object.keys(SECTIONS)) {
        parts.push(csvBlock(SECTIONS[key].title, SECTIONS[key].cols, sections[key].data), '');
      }
      const stamp = String(now.now).replace(/\D/g, '');
      res.set({
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': `attachment; filename="member-${member.member_id}-history-${stamp.slice(0, 8)}-${stamp.slice(8, 14)}.csv"`,
        'X-Report-Generated': now.now,
        'Cache-Control': 'private, no-store',
      });
      return res.send(`\uFEFF${parts.join('\r\n')}\r\n`);
    }

    const pages = {};
    for (const key of Object.keys(SECTIONS)) {
      const p = pageParam(q, `${key}_page`);
      if (Number.isNaN(p)) return res.status(400).json({ error: `${key}_page must be a positive whole number` });
      pages[key] = p;
    }
    const out = {};
    for (const key of Object.keys(SECTIONS)) out[key] = await fetchSection(key, member.member_id, { page: pages[key] });
    res.set('Cache-Control', 'private, no-store');
    res.json({
      generated_at: now.now,
      member: publicMember(member),
      summary: await getSummary(member.member_id),
      ...out,
    });
  } catch (err) {
    console.error('Member history error:', err.message);
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
});

// ---------- GET /api/members/:id/history/print : printable page with QR ----------
router.get('/members/:id/history/print', authenticate, async (req, res) => {
  try {
    const member = await loadMember(req, res);
    if (!member) return;
    const sections = await allSections(member.member_id);
    const summary = await getSummary(member.member_id);
    const ref = await createRef(member.member_id, req.user.user_id);
    const qr = await QRCode.toDataURL(ref, { errorCorrectionLevel: 'M', margin: 2, width: 180 });
    const [[now]] = await pool.query('SELECT NOW() AS now');
    await logAudit(pool, req.user.user_id, 'member_history_exported', 'member', member.member_id, `print; report ${ref}`);
    res.set({
      'Content-Type': 'text/html; charset=utf-8',
      'Content-Security-Policy': "default-src 'none'; img-src data:; style-src 'unsafe-inline'",
      'X-Content-Type-Options': 'nosniff',
      'Cache-Control': 'private, no-store',
    });
    res.send(renderHtml({
      member: publicMember(member), summary, sections, ref,
      generatedAt: now.now, generatedBy: req.user.full_name, qr,
    }));
  } catch (err) {
    console.error('Member history print error:', err.message);
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
});

// ---------- GET /api/member-history/ref/:code : resolve a scanned report reference ----------
router.get('/member-history/ref/:code', authenticate, async (req, res) => {
  const code = req.params.code;
  if (!REF_RE.test(code)) return res.status(400).json({ error: 'Reference must be 24 hexadecimal characters' });
  try {
    const [rows] = await pool.execute(
      `SELECT r.ref_code, r.member_id, r.generated_at, m.full_name, m.home_branch_id, u.full_name AS generated_by_name
         FROM member_report_refs r
         JOIN members m ON m.member_id = r.member_id
         JOIN users u ON u.user_id = r.generated_by
        WHERE r.ref_code = ?`,
      [code.toUpperCase()]
    );
    const r = rows[0];
    if (!r) return res.status(404).json({ error: 'No report matches this reference' });
    if (req.user.role === 'staff' && r.home_branch_id !== req.user.branch_id) {
      return res.status(403).json({ error: 'This report belongs to a member of another branch' });
    }
    res.json({
      reference: {
        ref_code: r.ref_code,
        member_id: r.member_id,
        member_name: r.full_name,
        generated_at: r.generated_at,
        generated_by_name: r.generated_by_name,
      },
      history_path: `/api/members/${r.member_id}/history`,
    });
  } catch (err) {
    console.error('Report reference error:', err.message);
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
});

module.exports = router;