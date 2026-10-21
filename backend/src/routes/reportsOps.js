const express = require('express');
const { authenticate } = require('../middleware/auth');
const { branchScope } = require('../middleware/branchScope');
const { makeReport } = require('../services/reportEngine');

const router = express.Router();

// ---------- shared helpers ----------
// Only the last 4 characters of a transaction ID are ever shown.
function maskId(v) {
  if (!v) return null;
  const s = String(v);
  if (s.length <= 4) return '****';
  return `${'*'.repeat(Math.min(s.length - 4, 8))}${s.slice(-4)}`;
}
const money = (v) => Number(v || 0).toFixed(2);
const METHODS = ['upi', 'card', 'netbanking', 'cash', 'bank_transfer'];

// ---------- Membership payments (also the membership-payment history) ----------
const payments = {
  name: 'membership-payments',
  fileName: 'membership-payments',
  sweepPayments: true,
  // The QR reference, proof file names and rejection text are deliberately not selected.
  select: `pr.request_id, pr.member_id, m.full_name AS member_name, pr.branch_id, b.name AS branch_name,
           p.name AS plan_name, pr.request_type, pr.amount, pr.method,
           pr.submitted_txn_id, pr.verification_txn_id, pr.status,
           (pr.proof_stored_name IS NOT NULL) AS has_proof,
           pr.requested_at, pr.expires_at, pr.verified_at, vu.full_name AS verified_by_name`,
  from: `FROM payment_requests pr
         JOIN members m ON m.member_id = pr.member_id
         JOIN branches b ON b.branch_id = pr.branch_id
         JOIN membership_plans p ON p.plan_id = pr.plan_id
         LEFT JOIN users vu ON vu.user_id = pr.verified_by`,
  scopeColumn: 'pr.branch_id',
  filters: [
    { name: 'payment_id', type: 'int', sql: 'pr.request_id = ?' },
    { name: 'member_id', type: 'int', sql: 'pr.member_id = ?' },
    { name: 'member_name', type: 'like', cols: ['m.full_name'] },
    { name: 'plan_id', type: 'int', sql: 'pr.plan_id = ?' },
    { name: 'request_type', type: 'enum', values: ['new', 'renewal'], sql: 'pr.request_type = ?' },
    { name: 'status', type: 'enum', values: ['pending', 'successful', 'rejected', 'expired'], sql: 'pr.status = ?' },
    { name: 'method', type: 'enum', values: METHODS, sql: 'pr.method = ?' },
    { name: 'min_amount', type: 'money', sql: 'pr.amount >= ?' },
    { name: 'max_amount', type: 'money', sql: 'pr.amount <= ?' },
    { name: 'txn', type: 'like', cols: ['pr.submitted_txn_id', 'pr.verification_txn_id'], max: 60 },
    { name: 'proof', type: 'enum', values: { yes: 'pr.proof_stored_name IS NOT NULL', no: 'pr.proof_stored_name IS NULL' } },
    { name: 'requested_from', type: 'date', sql: 'pr.requested_at >= ?' },
    { name: 'requested_to', type: 'date', sql: 'pr.requested_at < DATE_ADD(?, INTERVAL 1 DAY)' },
    { name: 'verified_from', type: 'date', sql: 'pr.verified_at >= ?' },
    { name: 'verified_to', type: 'date', sql: 'pr.verified_at < DATE_ADD(?, INTERVAL 1 DAY)' },
  ],
  sorts: {
    requested: 'pr.requested_at', amount: 'pr.amount', status: 'pr.status', member: 'm.full_name',
    branch: 'b.name', verified: 'pr.verified_at', method: 'pr.method',
  },
  defaultOrder: 'pr.requested_at DESC, pr.request_id DESC',
  tieBreaker: 'pr.request_id DESC',
  totals: `COUNT(*) AS total,
           COALESCE(SUM(pr.status = 'pending'), 0) AS pending,
           COALESCE(SUM(pr.status = 'successful'), 0) AS successful,
           COALESCE(SUM(pr.status = 'rejected'), 0) AS rejected,
           COALESCE(SUM(pr.status = 'expired'), 0) AS expired,
           COALESCE(SUM(CASE WHEN pr.status = 'successful' THEN pr.amount END), 0) AS amount_successful,
           COALESCE(SUM(CASE WHEN pr.status = 'pending' THEN pr.amount END), 0) AS amount_pending`,
  totalsShape: (t) => ({
    pending: Number(t.pending), successful: Number(t.successful), rejected: Number(t.rejected), expired: Number(t.expired),
    amount_successful: money(t.amount_successful), amount_pending: money(t.amount_pending),
  }),
  shape: (r) => {
    const { submitted_txn_id: submitted, verification_txn_id: verified, ...rest } = r;
    return {
      ...rest,
      has_proof: !!r.has_proof,
      submitted_txn_masked: maskId(submitted),
      verification_txn_masked: maskId(verified),
    };
  },
  csv: [
    { key: 'request_id', header: 'Payment ID' },
    { key: 'member_id', header: 'Member ID' },
    { key: 'member_name', header: 'Member name', text: true },
    { key: 'branch_name', header: 'Branch', text: true },
    { key: 'plan_name', header: 'Plan', text: true },
    { key: 'request_type', header: 'Type' },
    { key: 'amount', header: 'Amount' },
    { key: 'method', header: 'Method' },
    { key: 'submitted_txn_masked', header: 'Submitted transaction (masked)' },
    { key: 'verification_txn_masked', header: 'Verification transaction (masked)' },
    { key: 'status', header: 'Status' },
    { key: 'has_proof', header: 'Proof attached' },
    { key: 'requested_at', header: 'Requested at' },
    { key: 'expires_at', header: 'Expires at' },
    { key: 'verified_at', header: 'Verified at' },
    { key: 'verified_by_name', header: 'Verified by', text: true },
  ],
};

// ---------- Fine payments (fine collection) ----------
const finePayments = {
  name: 'fine-payments',
  fileName: 'fine-payments',
  select: `fp.fine_payment_id, fp.loan_id, l.member_id, m.full_name AS member_name, bk.title,
           l.branch_id, b.name AS branch_name, fp.amount, fp.method, fp.transaction_ref,
           fp.status, fp.paid_at, u.full_name AS recorded_by_name`,
  from: `FROM fine_payments fp
         JOIN loans l ON l.loan_id = fp.loan_id
         JOIN members m ON m.member_id = l.member_id
         JOIN books bk ON bk.book_id = l.book_id
         JOIN branches b ON b.branch_id = l.branch_id
         JOIN users u ON u.user_id = fp.recorded_by`,
  scopeColumn: 'l.branch_id',
  filters: [
    { name: 'fine_payment_id', type: 'int', sql: 'fp.fine_payment_id = ?' },
    { name: 'loan_id', type: 'int', sql: 'fp.loan_id = ?' },
    { name: 'member_id', type: 'int', sql: 'l.member_id = ?' },
    { name: 'member_name', type: 'like', cols: ['m.full_name'] },
    { name: 'status', type: 'enum', values: ['successful', 'failed', 'refunded'], sql: 'fp.status = ?' },
    { name: 'method', type: 'enum', values: METHODS, sql: 'fp.method = ?' },
    { name: 'min_amount', type: 'money', sql: 'fp.amount >= ?' },
    { name: 'max_amount', type: 'money', sql: 'fp.amount <= ?' },
    { name: 'txn', type: 'like', cols: ['fp.transaction_ref'], max: 60 },
    { name: 'paid_from', type: 'date', sql: 'fp.paid_at >= ?' },
    { name: 'paid_to', type: 'date', sql: 'fp.paid_at < DATE_ADD(?, INTERVAL 1 DAY)' },
  ],
  sorts: { paid: 'fp.paid_at', amount: 'fp.amount', status: 'fp.status', member: 'm.full_name', branch: 'b.name', loan_id: 'fp.loan_id', method: 'fp.method' },
  defaultOrder: 'fp.paid_at DESC, fp.fine_payment_id DESC',
  tieBreaker: 'fp.fine_payment_id DESC',
  totals: `COUNT(*) AS total,
           COALESCE(SUM(CASE WHEN fp.status = 'successful' THEN fp.amount END), 0) AS collected,
           COALESCE(SUM(CASE WHEN fp.status = 'refunded' THEN fp.amount END), 0) AS refunded,
           COALESCE(SUM(fp.status = 'successful'), 0) AS successful_count,
           COALESCE(SUM(fp.status = 'failed'), 0) AS failed_count,
           COALESCE(SUM(fp.status = 'refunded'), 0) AS refunded_count`,
  totalsShape: (t) => ({
    collected: money(t.collected), refunded: money(t.refunded),
    successful_count: Number(t.successful_count), failed_count: Number(t.failed_count), refunded_count: Number(t.refunded_count),
  }),
  shape: (r) => {
    const { transaction_ref: ref, ...rest } = r;
    return { ...rest, transaction_ref_masked: maskId(ref) };
  },
  csv: [
    { key: 'fine_payment_id', header: 'Fine payment ID' },
    { key: 'loan_id', header: 'Loan ID' },
    { key: 'member_id', header: 'Member ID' },
    { key: 'member_name', header: 'Member name', text: true },
    { key: 'title', header: 'Book title', text: true },
    { key: 'branch_name', header: 'Branch', text: true },
    { key: 'amount', header: 'Amount' },
    { key: 'method', header: 'Method' },
    { key: 'transaction_ref_masked', header: 'Transaction reference (masked)' },
    { key: 'status', header: 'Status' },
    { key: 'paid_at', header: 'Paid at' },
    { key: 'recorded_by_name', header: 'Recorded by', text: true },
  ],
};

// ---------- Outstanding fines ----------
const BALANCE = 'GREATEST(v.fine_amount - v.fine_paid, 0)';
const outstanding = {
  name: 'outstanding-fines',
  fileName: 'outstanding-fines',
  select: `v.loan_id, v.member_id, mem.full_name AS member_name, bk.title, v.branch_id,
           br.name AS branch_name, v.due_date, v.return_date, v.loan_status, v.overdue_days,
           v.fine_rate_snapshot AS fine_rate, v.fine_kind AS fine_type, v.fine_amount, v.fine_paid,
           ${BALANCE} AS balance`,
  from: `FROM v_loan_details v
         JOIN members mem ON mem.member_id = v.member_id
         JOIN books bk ON bk.book_id = v.book_id
         JOIN branches br ON br.branch_id = v.branch_id`,
  baseWhere: [`${BALANCE} > 0`],
  scopeColumn: 'v.branch_id',
  filters: [
    { name: 'kind', type: 'enum', values: { finalized: "v.fine_kind = 'finalized'", estimate: "v.fine_kind = 'estimate'" } },
    { name: 'loan_id', type: 'int', sql: 'v.loan_id = ?' },
    { name: 'member_id', type: 'int', sql: 'v.member_id = ?' },
    { name: 'member_name', type: 'like', cols: ['mem.full_name'] },
    { name: 'min_balance', type: 'money', sql: `${BALANCE} >= ?` },
    { name: 'max_balance', type: 'money', sql: `${BALANCE} <= ?` },
    { name: 'due_from', type: 'date', sql: 'v.due_date >= ?' },
    { name: 'due_to', type: 'date', sql: 'v.due_date <= ?' },
  ],
  sorts: { balance: BALANCE, due_date: 'v.due_date', member: 'mem.full_name', title: 'bk.title', branch: 'br.name', loan_id: 'v.loan_id', overdue_days: 'v.overdue_days' },
  defaultOrder: `${BALANCE} DESC, v.loan_id ASC`,
  tieBreaker: 'v.loan_id ASC',
  totals: `COUNT(*) AS total,
           COALESCE(SUM(${BALANCE}), 0) AS balance_total,
           COALESCE(SUM(CASE WHEN v.fine_kind = 'finalized' THEN ${BALANCE} END), 0) AS finalized_balance,
           COALESCE(SUM(CASE WHEN v.fine_kind = 'estimate' THEN ${BALANCE} END), 0) AS estimated_balance`,
  totalsShape: (t) => ({
    balance_total: money(t.balance_total), finalized_balance: money(t.finalized_balance), estimated_balance: money(t.estimated_balance),
  }),
  csv: [
    { key: 'loan_id', header: 'Loan ID' },
    { key: 'member_id', header: 'Member ID' },
    { key: 'member_name', header: 'Member name', text: true },
    { key: 'title', header: 'Book title', text: true },
    { key: 'branch_name', header: 'Branch', text: true },
    { key: 'due_date', header: 'Due date' },
    { key: 'return_date', header: 'Return date' },
    { key: 'loan_status', header: 'Loan status' },
    { key: 'overdue_days', header: 'Chargeable overdue days' },
    { key: 'fine_rate', header: 'Fine rate per day' },
    { key: 'fine_type', header: 'Fine type' },
    { key: 'fine_amount', header: 'Fine amount' },
    { key: 'fine_paid', header: 'Fine paid' },
    { key: 'balance', header: 'Outstanding balance' },
  ],
};

// ---------- Damage and theft/concealment incidents ----------
const RESTRICTION_STATE = `(CASE WHEN r.restriction_id IS NULL THEN 'none'
       WHEN r.revoked_at IS NOT NULL THEN 'lifted'
       WHEN r.kind = 'restriction' OR CURDATE() BETWEEN r.start_date AND r.end_date THEN 'active'
       ELSE 'ended' END)`;
const incidents = {
  name: 'incidents',
  fileName: 'incidents',
  // The free-text description and decision notes are deliberately not included.
  select: `i.incident_id, i.incident_ref, i.incident_type, i.status, i.decision, i.loan_id, i.member_id,
           m.full_name AS member_name, i.branch_id, b.name AS branch_name, i.book_id,
           bk.title AS book_title, i.book_edition, i.book_isbn, i.reported_at, ru.full_name AS reported_by_name,
           i.decided_at, du.full_name AS decided_by_name, i.replacement_received,
           r.kind AS restriction_kind, r.end_date AS restriction_end, ${RESTRICTION_STATE} AS restriction_state`,
  from: `FROM incidents i
         JOIN members m ON m.member_id = i.member_id
         JOIN branches b ON b.branch_id = i.branch_id
         JOIN books bk ON bk.book_id = i.book_id
         JOIN users ru ON ru.user_id = i.reported_by
         LEFT JOIN users du ON du.user_id = i.decided_by
         LEFT JOIN member_restrictions r ON r.incident_id = i.incident_id`,
  scopeColumn: 'i.branch_id',
  filters: [
    { name: 'type', type: 'enum', values: ['damage', 'theft_concealment'], sql: 'i.incident_type = ?' },
    { name: 'status', type: 'enum', values: ['reported', 'decided', 'resolved', 'dismissed'], sql: 'i.status = ?' },
    { name: 'decision', type: 'enum', values: ['none', 'replace_and_suspend', 'permanent_restriction', 'no_action'], sql: 'i.decision = ?' },
    {
      name: 'restriction',
      type: 'enum',
      values: {
        none: `${RESTRICTION_STATE} = 'none'`,
        active: `${RESTRICTION_STATE} = 'active'`,
        lifted: `${RESTRICTION_STATE} = 'lifted'`,
        ended: `${RESTRICTION_STATE} = 'ended'`,
      },
    },
    { name: 'member_id', type: 'int', sql: 'i.member_id = ?' },
    { name: 'member_name', type: 'like', cols: ['m.full_name'] },
    { name: 'loan_id', type: 'int', sql: 'i.loan_id = ?' },
    { name: 'book_id', type: 'int', sql: 'i.book_id = ?' },
    { name: 'reported_from', type: 'date', sql: 'i.reported_at >= ?' },
    { name: 'reported_to', type: 'date', sql: 'i.reported_at < DATE_ADD(?, INTERVAL 1 DAY)' },
  ],
  sorts: { reported: 'i.reported_at', type: 'i.incident_type', status: 'i.status', member: 'm.full_name', branch: 'b.name', ref: 'i.incident_ref' },
  defaultOrder: 'i.reported_at DESC, i.incident_id DESC',
  tieBreaker: 'i.incident_id DESC',
  totals: `COUNT(*) AS total,
           COALESCE(SUM(i.incident_type = 'damage'), 0) AS damage,
           COALESCE(SUM(i.incident_type = 'theft_concealment'), 0) AS theft_concealment,
           COALESCE(SUM(i.status = 'reported'), 0) AS awaiting_review,
           COALESCE(SUM(${RESTRICTION_STATE} = 'active'), 0) AS restriction_active`,
  shape: (r) => ({ ...r, replacement_received: !!r.replacement_received }),
  csv: [
    { key: 'incident_ref', header: 'Incident' },
    { key: 'incident_type', header: 'Type' },
    { key: 'status', header: 'Status' },
    { key: 'decision', header: 'Decision' },
    { key: 'loan_id', header: 'Loan ID' },
    { key: 'member_id', header: 'Member ID' },
    { key: 'member_name', header: 'Member name', text: true },
    { key: 'branch_name', header: 'Branch', text: true },
    { key: 'book_title', header: 'Book title', text: true },
    { key: 'book_edition', header: 'Edition', text: true },
    { key: 'book_isbn', header: 'ISBN' },
    { key: 'reported_at', header: 'Reported at' },
    { key: 'reported_by_name', header: 'Reported by', text: true },
    { key: 'decided_at', header: 'Decided at' },
    { key: 'decided_by_name', header: 'Decided by', text: true },
    { key: 'replacement_received', header: 'Replacement received' },
    { key: 'restriction_kind', header: 'Restriction type' },
    { key: 'restriction_end', header: 'Restriction end' },
    { key: 'restriction_state', header: 'Restriction state' },
  ],
};

const guard = [authenticate, branchScope];
router.get('/payments', ...guard, makeReport(payments));
router.get('/fine-payments', ...guard, makeReport(finePayments));
router.get('/fines-outstanding', ...guard, makeReport(outstanding));
router.get('/incidents', ...guard, makeReport(incidents));

module.exports = router;