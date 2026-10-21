USE libratrack;

CREATE TABLE IF NOT EXISTS member_accounts (
  member_id            INT UNSIGNED NOT NULL,
  password_hash        VARCHAR(100) NOT NULL,
  is_active            TINYINT(1)   NOT NULL DEFAULT 1,
  must_change_password TINYINT(1)   NOT NULL DEFAULT 1,
  failed_attempts      TINYINT UNSIGNED NOT NULL DEFAULT 0,
  locked_until         DATETIME     NULL,
  last_login_at        DATETIME     NULL,
  password_changed_at  DATETIME     NULL,
  created_by           INT UNSIGNED NULL,
  created_at           DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at           DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (member_id),
  CONSTRAINT fk_ma_member  FOREIGN KEY (member_id)  REFERENCES members(member_id),
  CONSTRAINT fk_ma_creator FOREIGN KEY (created_by) REFERENCES users(user_id)
) ENGINE=InnoDB;

-- Demo accounts: 1 = active member, 4 = expired membership, 9 = suspended, 11 = several loans.
-- Hashes are placeholders until set-demo-member-passwords.js runs.
INSERT IGNORE INTO member_accounts (member_id, password_hash, must_change_password, created_by) VALUES
(1,  'PENDING-RUN-set-demo-member-passwords', 0, 2),
(4,  'PENDING-RUN-set-demo-member-passwords', 0, 2),
(9,  'PENDING-RUN-set-demo-member-passwords', 0, 3),
(11, 'PENDING-RUN-set-demo-member-passwords', 0, 4);