USE libratrack;

CREATE TABLE IF NOT EXISTS member_report_refs (
  ref_code     CHAR(24)     NOT NULL,
  member_id    INT UNSIGNED NOT NULL,
  generated_by INT UNSIGNED NOT NULL,
  generated_at DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (ref_code),
  KEY idx_mrr_member (member_id),
  CONSTRAINT fk_mrr_member FOREIGN KEY (member_id) REFERENCES members(member_id) ON DELETE CASCADE,
  CONSTRAINT fk_mrr_user   FOREIGN KEY (generated_by) REFERENCES users(user_id)
) ENGINE=InnoDB;