const express = require('express');
const { authenticate } = require('../middleware/auth');
const { branchScope } = require('../middleware/branchScope');
const { makeReport } = require('../services/reportEngine');

const router = express.Router();

// ---------- Branch inventory ----------
const inventory = {
  name: 'branch-inventory',
  fileName: 'branch-inventory',
  select: `va.branch_id, br.name AS branch_name, va.book_id, b.title, b.author, b.category, b.isbn,
           b.edition, b.price, va.total_copies, va.on_loan,
           GREATEST(va.available_copies, 0) AS available_copies, b.is_active`,
  from: `FROM v_branch_availability va
         JOIN branches br ON br.branch_id = va.branch_id
         JOIN books b ON b.book_id = va.book_id`,
  scopeColumn: 'va.branch_id',
  filters: [
    { name: 'book_id', type: 'int', sql: 'va.book_id = ?' },
    { name: 'title', type: 'like', cols: ['b.title'] },
    { name: 'author', type: 'like', cols: ['b.author'] },
    { name: 'category', type: 'exact', sql: 'b.category = ?' },
    { name: 'isbn', type: 'isbn', col: 'b.isbn' },
    { name: 'availability', type: 'enum', values: { available: 'va.available_copies > 0', unavailable: 'va.available_copies <= 0' } },
    { name: 'status', type: 'enum', default: 'active', values: { active: 'b.is_active = 1', inactive: 'b.is_active = 0', all: '1 = 1' } },
  ],
  sorts: {
    branch: 'br.name', title: 'b.title', author: 'b.author', category: 'b.category',
    total: 'va.total_copies', on_loan: 'va.on_loan', available: 'va.available_copies',
  },
  defaultOrder: 'br.name ASC, b.category ASC, b.author ASC, b.title ASC',
  tieBreaker: 'va.branch_id ASC, va.book_id ASC',
  totals: `COUNT(*) AS total,
           COALESCE(SUM(va.total_copies), 0) AS copies,
           COALESCE(SUM(va.on_loan), 0) AS on_loan,
           COALESCE(SUM(GREATEST(va.available_copies, 0)), 0) AS available`,
  shape: (r) => ({
    ...r,
    total_copies: Number(r.total_copies),
    on_loan: Number(r.on_loan),
    available_copies: Number(r.available_copies),
    is_active: !!r.is_active,
  }),
  csv: [
    { key: 'branch_name', header: 'Branch', text: true },
    { key: 'book_id', header: 'Book ID' },
    { key: 'title', header: 'Book title', text: true },
    { key: 'author', header: 'Author', text: true },
    { key: 'category', header: 'Category', text: true },
    { key: 'isbn', header: 'ISBN' },
    { key: 'edition', header: 'Edition', text: true },
    { key: 'price', header: 'Price' },
    { key: 'total_copies', header: 'Total copies' },
    { key: 'on_loan', header: 'Copies on loan' },
    { key: 'available_copies', header: 'Available copies' },
    { key: 'is_active', header: 'Active' },
  ],
};

// ---------- Ebook catalogue and access status ----------
const ebooks = {
  name: 'ebook-catalogue',
  fileName: 'ebook-catalogue',
  // File names and storage paths are never selected.
  select: `e.ebook_id, e.title, e.author, e.category, e.edition, e.publisher, e.file_format,
           e.access_policy, e.is_active, e.file_size_bytes,
           (SELECT COUNT(*) FROM ebook_access ea WHERE ea.ebook_id = e.ebook_id AND ea.granted = 1) AS granted_accesses,
           (SELECT COUNT(*) FROM ebook_access ea WHERE ea.ebook_id = e.ebook_id AND ea.granted = 0) AS denied_accesses`,
  from: 'FROM ebooks e',
  scopeColumn: null,
  filters: [
    { name: 'title', type: 'like', cols: ['e.title'] },
    { name: 'author', type: 'like', cols: ['e.author'] },
    { name: 'category', type: 'exact', sql: 'e.category = ?' },
    { name: 'file_format', type: 'enum', values: ['pdf', 'epub'], sql: 'e.file_format = ?' },
    { name: 'policy', type: 'enum', values: ['read_only', 'download_allowed', 'staff_only'], sql: 'e.access_policy = ?' },
    { name: 'status', type: 'enum', default: 'active', values: { active: 'e.is_active = 1', inactive: 'e.is_active = 0', all: '1 = 1' } },
  ],
  sorts: { title: 'e.title', author: 'e.author', category: 'e.category', format: 'e.file_format', size: 'e.file_size_bytes' },
  defaultOrder: 'e.category ASC, e.author ASC, e.title ASC',
  tieBreaker: 'e.ebook_id ASC',
  totals: `COUNT(*) AS total,
           COALESCE(SUM(e.access_policy = 'read_only'), 0) AS read_only,
           COALESCE(SUM(e.access_policy = 'download_allowed'), 0) AS download_allowed,
           COALESCE(SUM(e.access_policy = 'staff_only'), 0) AS staff_only`,
  shape: (r) => {
    let accessStatus;
    if (!r.is_active) accessStatus = 'inactive';
    else if (r.access_policy === 'staff_only') accessStatus = 'staff only';
    else if (r.access_policy === 'download_allowed') accessStatus = 'read and download';
    else accessStatus = 'read online';
    return {
      ...r,
      is_active: !!r.is_active,
      file_size_bytes: Number(r.file_size_bytes),
      granted_accesses: Number(r.granted_accesses),
      denied_accesses: Number(r.denied_accesses),
      access_status: accessStatus,
    };
  },
  csv: [
    { key: 'ebook_id', header: 'Ebook ID' },
    { key: 'title', header: 'Title', text: true },
    { key: 'author', header: 'Author', text: true },
    { key: 'category', header: 'Category', text: true },
    { key: 'edition', header: 'Edition', text: true },
    { key: 'publisher', header: 'Publisher', text: true },
    { key: 'file_format', header: 'Format' },
    { key: 'access_policy', header: 'Access policy' },
    { key: 'access_status', header: 'Access status' },
    { key: 'file_size_bytes', header: 'Size (bytes)' },
    { key: 'is_active', header: 'Active' },
    { key: 'granted_accesses', header: 'Accesses granted' },
    { key: 'denied_accesses', header: 'Accesses denied' },
  ],
};

// ---------- Memberships expiring soon ----------
// A current membership that ends within the window and has no later membership (renewal) bought yet.
const expiring = {
  name: 'memberships-expiring',
  fileName: 'memberships-expiring',
  sweepPayments: true,
  select: `ms.membership_id, ms.member_id, m.full_name AS member_name, b.name AS branch_name,
           p.name AS plan_name, ms.start_date, ms.expiry_date,
           DATEDIFF(ms.expiry_date, CURDATE()) AS days_left, ms.fee_paid,
           EXISTS (SELECT 1 FROM payment_requests pr WHERE pr.member_id = ms.member_id AND pr.status = 'pending') AS renewal_request_pending`,
  from: `FROM memberships ms
         JOIN members m ON m.member_id = ms.member_id
         JOIN branches b ON b.branch_id = m.home_branch_id
         JOIN membership_plans p ON p.plan_id = ms.plan_id`,
  baseWhere: [
    'm.is_active = 1',
    'CURDATE() BETWEEN ms.start_date AND ms.expiry_date',
    'NOT EXISTS (SELECT 1 FROM memberships nx WHERE nx.member_id = ms.member_id AND nx.start_date > ms.expiry_date)',
  ],
  scopeColumn: 'm.home_branch_id',
  filters: [
    { name: 'days', type: 'days', default: 30, min: 1, max: 365, sql: 'ms.expiry_date <= DATE_ADD(CURDATE(), INTERVAL ? DAY)' },
    { name: 'member_id', type: 'int', sql: 'ms.member_id = ?' },
    { name: 'member_name', type: 'like', cols: ['m.full_name'] },
    { name: 'plan_id', type: 'int', sql: 'ms.plan_id = ?' },
  ],
  sorts: { expiry: 'ms.expiry_date', member: 'm.full_name', branch: 'b.name', plan: 'p.name', days_left: 'DATEDIFF(ms.expiry_date, CURDATE())' },
  defaultOrder: 'ms.expiry_date ASC, ms.membership_id ASC',
  tieBreaker: 'ms.membership_id ASC',
  shape: (r) => ({ ...r, days_left: Number(r.days_left), renewal_request_pending: !!r.renewal_request_pending }),
  csv: [
    { key: 'membership_id', header: 'Membership ID' },
    { key: 'member_id', header: 'Member ID' },
    { key: 'member_name', header: 'Member name', text: true },
    { key: 'branch_name', header: 'Branch', text: true },
    { key: 'plan_name', header: 'Plan', text: true },
    { key: 'start_date', header: 'Start date' },
    { key: 'expiry_date', header: 'Expiry date' },
    { key: 'days_left', header: 'Days left' },
    { key: 'fee_paid', header: 'Fee paid' },
    { key: 'renewal_request_pending', header: 'Renewal request pending' },
  ],
};

// ---------- Members by status ----------
const LATEST_PAYMENT = `(SELECT pr.status FROM payment_requests pr WHERE pr.member_id = m.member_id
                         ORDER BY pr.requested_at DESC, pr.request_id DESC LIMIT 1)`;
const MAX_EXPIRY = '(SELECT MAX(ms.expiry_date) FROM memberships ms WHERE ms.member_id = m.member_id)';
const members = {
  name: 'members-by-status',
  fileName: 'members-by-status',
  sweepPayments: true,
  // Email and phone are deliberately left out of this report and its CSV.
  select: `m.member_id, m.full_name AS member_name, b.name AS branch_name, m.registered_on,
           vs.effective_status AS status, ${MAX_EXPIRY} AS membership_expiry,
           ${LATEST_PAYMENT} AS latest_payment_status,
           (SELECT COUNT(*) FROM loans l WHERE l.member_id = m.member_id AND l.return_date IS NULL) AS open_loans`,
  from: `FROM members m
         JOIN branches b ON b.branch_id = m.home_branch_id
         JOIN v_member_status vs ON vs.member_id = m.member_id`,
  scopeColumn: 'm.home_branch_id',
  filters: [
    { name: 'member_id', type: 'int', sql: 'm.member_id = ?' },
    { name: 'member_name', type: 'like', cols: ['m.full_name'] },
    { name: 'status', type: 'enum', values: ['active', 'inactive', 'suspended', 'restricted'], sql: 'vs.effective_status = ?' },
    {
      name: 'payment_status',
      type: 'enum',
      values: {
        pending: `${LATEST_PAYMENT} = 'pending'`,
        successful: `${LATEST_PAYMENT} = 'successful'`,
        rejected: `${LATEST_PAYMENT} = 'rejected'`,
        expired: `${LATEST_PAYMENT} = 'expired'`,
        none: 'NOT EXISTS (SELECT 1 FROM payment_requests pr WHERE pr.member_id = m.member_id)',
      },
    },
    { name: 'registered_from', type: 'date', sql: 'm.registered_on >= ?' },
    { name: 'registered_to', type: 'date', sql: 'm.registered_on <= ?' },
    { name: 'expiry_from', type: 'date', sql: `${MAX_EXPIRY} >= ?` },
    { name: 'expiry_to', type: 'date', sql: `${MAX_EXPIRY} <= ?` },
  ],
  sorts: { member: 'm.full_name', branch: 'b.name', status: 'vs.effective_status', registered: 'm.registered_on', expiry: MAX_EXPIRY },
  defaultOrder: 'm.full_name ASC, m.member_id ASC',
  tieBreaker: 'm.member_id ASC',
  totals: `COUNT(*) AS total,
           COALESCE(SUM(vs.effective_status = 'active'), 0) AS active,
           COALESCE(SUM(vs.effective_status = 'inactive'), 0) AS inactive,
           COALESCE(SUM(vs.effective_status = 'suspended'), 0) AS suspended,
           COALESCE(SUM(vs.effective_status = 'restricted'), 0) AS restricted`,
  shape: (r) => ({ ...r, open_loans: Number(r.open_loans) }),
  csv: [
    { key: 'member_id', header: 'Member ID' },
    { key: 'member_name', header: 'Member name', text: true },
    { key: 'branch_name', header: 'Branch', text: true },
    { key: 'registered_on', header: 'Registered' },
    { key: 'status', header: 'Status' },
    { key: 'membership_expiry', header: 'Membership expiry' },
    { key: 'latest_payment_status', header: 'Latest payment status' },
    { key: 'open_loans', header: 'Open loans' },
  ],
};

const guard = [authenticate, branchScope];
router.get('/inventory', ...guard, makeReport(inventory));
router.get('/ebooks', ...guard, makeReport(ebooks));
router.get('/memberships-expiring', ...guard, makeReport(expiring));
router.get('/members', ...guard, makeReport(members));

module.exports = router;
