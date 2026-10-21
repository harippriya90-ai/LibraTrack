-- LibraTrack schema | MySQL 8.0+
-- Run on an empty server: mysql -u root -p < database/schema.sql
-- WARNING: DROP DATABASE below is for a fresh local demo setup only.

DROP DATABASE IF EXISTS libratrack;
CREATE DATABASE libratrack CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci;
USE libratrack;

SET time_zone = '+05:30';

-- ---------- Branches & users ----------
CREATE TABLE branches (
  branch_id    INT UNSIGNED NOT NULL AUTO_INCREMENT,
  name         VARCHAR(100) NOT NULL,
  address      VARCHAR(255) NOT NULL,
  phone        VARCHAR(20)  NULL,
  email        VARCHAR(120) NULL,
  is_active    TINYINT(1)   NOT NULL DEFAULT 1,
  created_at   DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at   DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (branch_id),
  UNIQUE KEY uq_branch_name (name)
) ENGINE=InnoDB;

CREATE TABLE users (
  user_id         INT UNSIGNED NOT NULL AUTO_INCREMENT,
  username        VARCHAR(50)  NOT NULL,
  password_hash   VARCHAR(100) NOT NULL,
  full_name       VARCHAR(100) NOT NULL,
  role            ENUM('admin','staff') NOT NULL,
  branch_id       INT UNSIGNED NULL,
  is_active       TINYINT(1)   NOT NULL DEFAULT 1,
  failed_attempts TINYINT UNSIGNED NOT NULL DEFAULT 0,
  locked_until    DATETIME     NULL,
  last_login_at   DATETIME     NULL,
  created_at      DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at      DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (user_id),
  UNIQUE KEY uq_username (username),
  KEY idx_users_branch (branch_id),
  CONSTRAINT fk_users_branch FOREIGN KEY (branch_id) REFERENCES branches(branch_id),
  CONSTRAINT chk_user_branch CHECK (
    (role = 'admin' AND branch_id IS NULL) OR (role = 'staff' AND branch_id IS NOT NULL)
  )
) ENGINE=InnoDB;

-- ---------- Catalogue & inventory ----------
CREATE TABLE books (
  book_id          INT UNSIGNED NOT NULL AUTO_INCREMENT,
  isbn             VARCHAR(17)  NULL,
  title            VARCHAR(200) NOT NULL,
  author           VARCHAR(120) NOT NULL,
  category         VARCHAR(60)  NOT NULL,
  edition          VARCHAR(30)  NOT NULL DEFAULT '1st',
  publisher        VARCHAR(100) NULL,
  publication_year SMALLINT UNSIGNED NULL,
  price            DECIMAL(10,2) NOT NULL DEFAULT 0.00,
  fine_per_day     DECIMAL(8,2)  NOT NULL DEFAULT 5.00,
  is_active        TINYINT(1)    NOT NULL DEFAULT 1,
  created_at       DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at       DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (book_id),
  UNIQUE KEY uq_book_isbn (isbn),
  KEY idx_books_sort (category, author, title),
  KEY idx_books_title (title),
  KEY idx_books_author (author),
  CONSTRAINT chk_book_price CHECK (price >= 0),
  CONSTRAINT chk_book_fine CHECK (fine_per_day >= 0),
  CONSTRAINT chk_book_year CHECK (publication_year IS NULL OR publication_year BETWEEN 1400 AND 2100)
) ENGINE=InnoDB;

CREATE TABLE branch_inventory (
  branch_id    INT UNSIGNED NOT NULL,
  book_id      INT UNSIGNED NOT NULL,
  total_copies INT UNSIGNED NOT NULL DEFAULT 0,
  updated_at   DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (branch_id, book_id),
  KEY idx_inv_book (book_id),
  CONSTRAINT fk_inv_branch FOREIGN KEY (branch_id) REFERENCES branches(branch_id),
  CONSTRAINT fk_inv_book   FOREIGN KEY (book_id)   REFERENCES books(book_id)
) ENGINE=InnoDB;

CREATE TABLE ebooks (
  ebook_id         INT UNSIGNED NOT NULL AUTO_INCREMENT,
  title            VARCHAR(200) NOT NULL,
  author           VARCHAR(120) NOT NULL,
  category         VARCHAR(60)  NOT NULL,
  isbn             VARCHAR(17)  NULL,
  edition          VARCHAR(30)  NOT NULL DEFAULT '1st',
  publisher        VARCHAR(100) NULL,
  file_format      ENUM('pdf','epub') NOT NULL,
  stored_file_name VARCHAR(100) NOT NULL,   -- random name inside backend/storage/ebooks
  original_name    VARCHAR(255) NOT NULL,
  file_size_bytes  BIGINT UNSIGNED NOT NULL,
  access_policy    ENUM('read_only','download_allowed','staff_only') NOT NULL DEFAULT 'read_only',
  is_active        TINYINT(1) NOT NULL DEFAULT 1,
  created_at       DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at       DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (ebook_id),
  UNIQUE KEY uq_ebook_file (stored_file_name),
  UNIQUE KEY uq_ebook_isbn (isbn),
  KEY idx_ebooks_sort (category, author, title)
) ENGINE=InnoDB;

-- ---------- Members & memberships ----------
CREATE TABLE members (
  member_id      INT UNSIGNED NOT NULL AUTO_INCREMENT,
  full_name      VARCHAR(100) NOT NULL,
  email          VARCHAR(120) NOT NULL,
  phone          VARCHAR(20)  NOT NULL,
  home_branch_id INT UNSIGNED NOT NULL,
  registered_on  DATE NOT NULL,
  is_active      TINYINT(1) NOT NULL DEFAULT 1,  -- admin-level on/off; suspended/restricted come from member_restrictions
  created_at     DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at     DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (member_id),
  UNIQUE KEY uq_member_email (email),
  UNIQUE KEY uq_member_phone (phone),
  KEY idx_members_branch (home_branch_id),
  KEY idx_members_name (full_name),
  CONSTRAINT fk_members_branch FOREIGN KEY (home_branch_id) REFERENCES branches(branch_id)
) ENGINE=InnoDB;

CREATE TABLE membership_plans (
  plan_id         INT UNSIGNED NOT NULL AUTO_INCREMENT,
  name            VARCHAR(60) NOT NULL,
  duration_months TINYINT UNSIGNED NOT NULL,
  fee             DECIMAL(10,2) NOT NULL,
  max_loans       TINYINT UNSIGNED NOT NULL DEFAULT 3,
  loan_days       TINYINT UNSIGNED NOT NULL DEFAULT 14,
  is_active       TINYINT(1) NOT NULL DEFAULT 1,
  created_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (plan_id),
  UNIQUE KEY uq_plan_name (name),
  CONSTRAINT chk_plan_duration CHECK (duration_months > 0),
  CONSTRAINT chk_plan_fee CHECK (fee >= 0)
) ENGINE=InnoDB;

CREATE TABLE payment_requests (
  request_id          INT UNSIGNED NOT NULL AUTO_INCREMENT,
  reference_no        CHAR(24) NOT NULL,              -- opaque random token; this is what the QR encodes
  member_id           INT UNSIGNED NOT NULL,
  branch_id           INT UNSIGNED NOT NULL,          -- member's home branch at submission
  plan_id             INT UNSIGNED NOT NULL,
  request_type        ENUM('new','renewal') NOT NULL,
  amount              DECIMAL(10,2) NOT NULL,         -- snapshot of plan fee at request time
  method              ENUM('upi','card','netbanking','cash','bank_transfer') NOT NULL,
  submitted_txn_id    VARCHAR(60) NULL,
  verification_txn_id VARCHAR(60) NULL,
  status              ENUM('pending','successful','rejected','expired') NOT NULL DEFAULT 'pending',
  proof_stored_name   VARCHAR(100) NULL,              -- NULL = no proof
  proof_original_name VARCHAR(255) NULL,
  proof_mime          VARCHAR(50)  NULL,
  requested_at        DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  expires_at          DATETIME NOT NULL,              -- set by backend: requested_at + expiry days (default 5)
  verified_by         INT UNSIGNED NULL,
  verified_at         DATETIME NULL,
  rejection_reason    VARCHAR(255) NULL,
  created_by          INT UNSIGNED NOT NULL,
  PRIMARY KEY (request_id),
  UNIQUE KEY uq_pr_reference (reference_no),
  UNIQUE KEY uq_pr_verif_txn (verification_txn_id),
  KEY idx_pr_member (member_id),
  KEY idx_pr_branch_status (branch_id, status),
  KEY idx_pr_requested (requested_at),
  CONSTRAINT fk_pr_member FOREIGN KEY (member_id) REFERENCES members(member_id),
  CONSTRAINT fk_pr_branch FOREIGN KEY (branch_id) REFERENCES branches(branch_id),
  CONSTRAINT fk_pr_plan   FOREIGN KEY (plan_id)   REFERENCES membership_plans(plan_id),
  CONSTRAINT fk_pr_verifier FOREIGN KEY (verified_by) REFERENCES users(user_id),
  CONSTRAINT fk_pr_creator  FOREIGN KEY (created_by)  REFERENCES users(user_id),
  CONSTRAINT chk_pr_amount CHECK (amount >= 0),
  CONSTRAINT chk_pr_verified CHECK (
    status <> 'successful' OR (verified_by IS NOT NULL AND verified_at IS NOT NULL AND verification_txn_id IS NOT NULL)
  )
) ENGINE=InnoDB;

CREATE TABLE memberships (
  membership_id      INT UNSIGNED NOT NULL AUTO_INCREMENT,
  member_id          INT UNSIGNED NOT NULL,
  plan_id            INT UNSIGNED NOT NULL,
  payment_request_id INT UNSIGNED NOT NULL,           -- a membership exists only after verified payment
  renewal_of_id      INT UNSIGNED NULL,
  start_date         DATE NOT NULL,
  expiry_date        DATE NOT NULL,
  duration_months    TINYINT UNSIGNED NOT NULL,       -- snapshot of plan terms
  fee_paid           DECIMAL(10,2) NOT NULL,          -- snapshot
  max_loans          TINYINT UNSIGNED NOT NULL,       -- snapshot
  loan_days          TINYINT UNSIGNED NOT NULL,       -- snapshot
  created_at         DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (membership_id),
  UNIQUE KEY uq_ms_payment (payment_request_id),      -- prevents duplicate activation
  KEY idx_ms_member_dates (member_id, start_date, expiry_date),
  CONSTRAINT fk_ms_member  FOREIGN KEY (member_id) REFERENCES members(member_id),
  CONSTRAINT fk_ms_plan    FOREIGN KEY (plan_id)   REFERENCES membership_plans(plan_id),
  CONSTRAINT fk_ms_payment FOREIGN KEY (payment_request_id) REFERENCES payment_requests(request_id),
  CONSTRAINT fk_ms_renewal FOREIGN KEY (renewal_of_id) REFERENCES memberships(membership_id),
  CONSTRAINT chk_ms_dates CHECK (expiry_date > start_date)
) ENGINE=InnoDB;

-- ---------- Circulation & fines ----------
CREATE TABLE loans (
  loan_id             INT UNSIGNED NOT NULL AUTO_INCREMENT,
  member_id           INT UNSIGNED NOT NULL,
  branch_id           INT UNSIGNED NOT NULL,
  book_id             INT UNSIGNED NOT NULL,
  issue_date          DATE NOT NULL,
  due_date            DATE NOT NULL,
  return_date         DATE NULL,
  fine_rate_snapshot  DECIMAL(8,2) NOT NULL,          -- deliberate denormalization: rate at issue time
  grace_days_snapshot TINYINT UNSIGNED NOT NULL DEFAULT 0,
  fine_cap_snapshot   DECIMAL(10,2) NULL,             -- NULL = no cap
  issued_by           INT UNSIGNED NOT NULL,
  returned_by         INT UNSIGNED NULL,
  created_at          DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (loan_id),
  KEY idx_loans_member (member_id),
  KEY idx_loans_branch_book (branch_id, book_id),
  KEY idx_loans_due (due_date),
  KEY idx_loans_open (branch_id, return_date),
  CONSTRAINT fk_loans_member FOREIGN KEY (member_id) REFERENCES members(member_id),
  CONSTRAINT fk_loans_inv    FOREIGN KEY (branch_id, book_id) REFERENCES branch_inventory(branch_id, book_id),
  CONSTRAINT fk_loans_issuer FOREIGN KEY (issued_by)   REFERENCES users(user_id),
  CONSTRAINT fk_loans_returner FOREIGN KEY (returned_by) REFERENCES users(user_id),
  CONSTRAINT chk_loan_due CHECK (due_date >= issue_date),
  CONSTRAINT chk_loan_return CHECK (return_date IS NULL OR return_date >= issue_date),
  CONSTRAINT chk_loan_rate CHECK (fine_rate_snapshot >= 0)
) ENGINE=InnoDB;

CREATE TABLE loan_fines (
  loan_id         INT UNSIGNED NOT NULL,
  overdue_days    INT UNSIGNED NOT NULL,
  rate_applied    DECIMAL(8,2) NOT NULL,
  calculated_amount DECIMAL(10,2) NOT NULL,           -- after grace and cap
  waived          TINYINT(1) NOT NULL DEFAULT 0,
  waived_by       INT UNSIGNED NULL,
  finalized_at    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (loan_id),
  CONSTRAINT fk_lf_loan FOREIGN KEY (loan_id) REFERENCES loans(loan_id),
  CONSTRAINT fk_lf_waiver FOREIGN KEY (waived_by) REFERENCES users(user_id),
  CONSTRAINT chk_lf_amount CHECK (calculated_amount >= 0)
) ENGINE=InnoDB;

CREATE TABLE fine_payments (
  fine_payment_id INT UNSIGNED NOT NULL AUTO_INCREMENT,
  loan_id         INT UNSIGNED NOT NULL,
  amount          DECIMAL(10,2) NOT NULL,
  method          ENUM('upi','card','netbanking','cash','bank_transfer') NOT NULL,
  transaction_ref VARCHAR(60) NULL,
  status          ENUM('successful','failed','refunded') NOT NULL DEFAULT 'successful',
  paid_at         DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  recorded_by     INT UNSIGNED NOT NULL,
  PRIMARY KEY (fine_payment_id),
  KEY idx_fp_loan (loan_id),
  CONSTRAINT fk_fp_loan FOREIGN KEY (loan_id) REFERENCES loans(loan_id),
  CONSTRAINT fk_fp_user FOREIGN KEY (recorded_by) REFERENCES users(user_id),
  CONSTRAINT chk_fp_amount CHECK (amount > 0)
) ENGINE=InnoDB;

-- ---------- Incidents & restrictions ----------
CREATE TABLE incidents (
  incident_id     INT UNSIGNED NOT NULL AUTO_INCREMENT,
  incident_ref    VARCHAR(20) NOT NULL,
  incident_type   ENUM('damage','theft_concealment') NOT NULL,
  loan_id         INT UNSIGNED NOT NULL,
  member_id       INT UNSIGNED NOT NULL,
  branch_id       INT UNSIGNED NOT NULL,
  book_id         INT UNSIGNED NOT NULL,
  book_edition    VARCHAR(30) NOT NULL,               -- recorded for exact-replacement requirement
  book_isbn       VARCHAR(17) NULL,
  description     TEXT NOT NULL,
  reported_by     INT UNSIGNED NOT NULL,
  reported_at     DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  status          ENUM('reported','decided','resolved','dismissed') NOT NULL DEFAULT 'reported',
  decision        ENUM('none','replace_and_suspend','permanent_restriction','no_action') NOT NULL DEFAULT 'none',
  decision_notes  TEXT NULL,
  decided_by      INT UNSIGNED NULL,
  decided_at      DATETIME NULL,
  replacement_received TINYINT(1) NOT NULL DEFAULT 0,
  resolved_at     DATETIME NULL,
  PRIMARY KEY (incident_id),
  UNIQUE KEY uq_incident_ref (incident_ref),
  KEY idx_inc_branch (branch_id, status),
  CONSTRAINT fk_inc_loan   FOREIGN KEY (loan_id)   REFERENCES loans(loan_id),
  CONSTRAINT fk_inc_member FOREIGN KEY (member_id) REFERENCES members(member_id),
  CONSTRAINT fk_inc_branch FOREIGN KEY (branch_id) REFERENCES branches(branch_id),
  CONSTRAINT fk_inc_book   FOREIGN KEY (book_id)   REFERENCES books(book_id),
  CONSTRAINT fk_inc_reporter FOREIGN KEY (reported_by) REFERENCES users(user_id),
  CONSTRAINT fk_inc_decider  FOREIGN KEY (decided_by)  REFERENCES users(user_id),
  CONSTRAINT chk_inc_decision CHECK (
    status NOT IN ('decided','resolved') OR (decided_by IS NOT NULL AND decided_at IS NOT NULL)
  )
) ENGINE=InnoDB;

CREATE TABLE member_restrictions (
  restriction_id INT UNSIGNED NOT NULL AUTO_INCREMENT,
  member_id      INT UNSIGNED NOT NULL,
  kind           ENUM('suspension','restriction') NOT NULL,
  start_date     DATE NOT NULL,
  end_date       DATE NULL,                           -- NULL only for permanent restriction
  reason         VARCHAR(255) NOT NULL,
  incident_id    INT UNSIGNED NULL,
  approved_by    INT UNSIGNED NOT NULL,
  created_at     DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  revoked_at     DATETIME NULL,
  revoked_by     INT UNSIGNED NULL,
  revoke_reason  VARCHAR(255) NULL,
  PRIMARY KEY (restriction_id),
  KEY idx_mr_member (member_id, revoked_at, end_date),
  CONSTRAINT fk_mr_member   FOREIGN KEY (member_id)   REFERENCES members(member_id),
  CONSTRAINT fk_mr_incident FOREIGN KEY (incident_id) REFERENCES incidents(incident_id),
  CONSTRAINT fk_mr_approver FOREIGN KEY (approved_by) REFERENCES users(user_id),
  CONSTRAINT fk_mr_revoker  FOREIGN KEY (revoked_by)  REFERENCES users(user_id),
  CONSTRAINT chk_mr_end CHECK (kind = 'restriction' OR end_date IS NOT NULL),
  CONSTRAINT chk_mr_dates CHECK (end_date IS NULL OR end_date >= start_date)
) ENGINE=InnoDB;

-- ---------- Ebook access log, settings, audit ----------
CREATE TABLE ebook_access (
  access_id   INT UNSIGNED NOT NULL AUTO_INCREMENT,
  ebook_id    INT UNSIGNED NOT NULL,
  member_id   INT UNSIGNED NULL,                      -- NULL when staff/admin accessed
  user_id     INT UNSIGNED NULL,
  action      ENUM('read','download') NOT NULL,
  granted     TINYINT(1) NOT NULL,
  deny_reason VARCHAR(100) NULL,
  accessed_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (access_id),
  KEY idx_ea_ebook (ebook_id),
  KEY idx_ea_member (member_id),
  CONSTRAINT fk_ea_ebook  FOREIGN KEY (ebook_id)  REFERENCES ebooks(ebook_id),
  CONSTRAINT fk_ea_member FOREIGN KEY (member_id) REFERENCES members(member_id),
  CONSTRAINT fk_ea_user   FOREIGN KEY (user_id)   REFERENCES users(user_id)
) ENGINE=InnoDB;

CREATE TABLE system_settings (
  setting_key   VARCHAR(60) NOT NULL,
  setting_value VARCHAR(255) NOT NULL,
  description   VARCHAR(255) NULL,
  updated_by    INT UNSIGNED NULL,
  updated_at    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (setting_key),
  CONSTRAINT fk_ss_user FOREIGN KEY (updated_by) REFERENCES users(user_id)
) ENGINE=InnoDB;

CREATE TABLE audit_logs (
  audit_id    BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  user_id     INT UNSIGNED NULL,
  action      VARCHAR(60) NOT NULL,
  entity_type VARCHAR(40) NOT NULL,
  entity_id   VARCHAR(40) NULL,
  details     VARCHAR(500) NULL,
  created_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (audit_id),
  KEY idx_audit_user (user_id),
  KEY idx_audit_time (created_at),
  CONSTRAINT fk_audit_user FOREIGN KEY (user_id) REFERENCES users(user_id)
) ENGINE=InnoDB;

-- ---------- Default policy settings (required configuration, not demo data) ----------
INSERT INTO system_settings (setting_key, setting_value, description) VALUES
 ('library_name',            'LibraTrack Library Network', 'Display name'),
 ('timezone',                'Asia/Kolkata',  'Library timezone'),
 ('default_fine_per_day',    '5.00',          'Default fine per overdue day (INR) for new books'),
 ('grace_days',              '0',             'Free days after due date, copied onto each new loan'),
 ('fine_cap',                '',              'Maximum fine per loan in INR; empty = no cap'),
 ('payment_expiry_days',     '5',             'Unverified payment requests expire after this many days'),
 ('suspension_days_damage',  '14',            'Suspension length after a damage decision'),
 ('default_loan_days',       '14',            'Fallback loan period');

-- ---------- Views ----------
-- Availability is derived, never stored.
CREATE VIEW v_branch_availability AS
SELECT bi.branch_id, bi.book_id, bi.total_copies,
       COUNT(l.loan_id) AS on_loan,
       CAST(bi.total_copies AS SIGNED) - COUNT(l.loan_id) AS available_copies
FROM branch_inventory bi
LEFT JOIN loans l ON l.branch_id = bi.branch_id AND l.book_id = bi.book_id AND l.return_date IS NULL
GROUP BY bi.branch_id, bi.book_id, bi.total_copies;

-- One row per loan with status, overdue days, fine (live estimate or finalized) and balance.
-- Overdue days = max(0, DATEDIFF(return_date or today, due_date) - grace_snapshot).
CREATE VIEW v_loan_details AS
SELECT l.loan_id, l.member_id, l.branch_id, l.book_id,
       l.issue_date, l.due_date, l.return_date,
       l.fine_rate_snapshot, l.grace_days_snapshot, l.fine_cap_snapshot,
       CASE WHEN l.return_date IS NOT NULL THEN 'returned'
            WHEN CURDATE() > l.due_date THEN 'overdue'
            ELSE 'active' END AS loan_status,
       GREATEST(0, DATEDIFF(COALESCE(l.return_date, CURDATE()), l.due_date) - l.grace_days_snapshot) AS overdue_days,
       CASE WHEN l.return_date IS NOT NULL THEN 'finalized' ELSE 'estimate' END AS fine_kind,
       CASE
         WHEN l.return_date IS NOT NULL THEN
              CASE WHEN COALESCE(lf.waived,0) = 1 THEN 0 ELSE COALESCE(lf.calculated_amount, 0) END
         ELSE LEAST(COALESCE(l.fine_cap_snapshot, 999999999),
                    GREATEST(0, DATEDIFF(CURDATE(), l.due_date) - l.grace_days_snapshot) * l.fine_rate_snapshot)
       END AS fine_amount,
       COALESCE(p.paid, 0) AS fine_paid
FROM loans l
LEFT JOIN loan_fines lf ON lf.loan_id = l.loan_id
LEFT JOIN (SELECT loan_id, SUM(amount) AS paid FROM fine_payments WHERE status = 'successful' GROUP BY loan_id) p
       ON p.loan_id = l.loan_id;

-- Effective member status: restricted > suspended > inactive > active.
CREATE VIEW v_member_status AS
SELECT m.member_id,
  CASE
    WHEN EXISTS (SELECT 1 FROM member_restrictions r WHERE r.member_id = m.member_id AND r.kind='restriction' AND r.revoked_at IS NULL) THEN 'restricted'
    WHEN EXISTS (SELECT 1 FROM member_restrictions r WHERE r.member_id = m.member_id AND r.kind='suspension' AND r.revoked_at IS NULL
                 AND CURDATE() BETWEEN r.start_date AND r.end_date) THEN 'suspended'
    WHEN m.is_active = 0 THEN 'inactive'
    WHEN NOT EXISTS (SELECT 1 FROM memberships ms WHERE ms.member_id = m.member_id AND CURDATE() BETWEEN ms.start_date AND ms.expiry_date) THEN 'inactive'
    ELSE 'active'
  END AS effective_status
FROM members m;