USE libratrack;

CREATE OR REPLACE VIEW v_loan_details AS
SELECT l.loan_id, l.member_id, l.branch_id, l.book_id,
       l.issue_date, l.due_date, l.return_date,
       l.fine_rate_snapshot, l.grace_days_snapshot, l.fine_cap_snapshot,
       CASE WHEN l.return_date IS NOT NULL THEN 'returned'
            WHEN CURDATE() > l.due_date THEN 'overdue'
            ELSE 'active' END AS loan_status,
       GREATEST(0, DATEDIFF(COALESCE(l.return_date, CURDATE()), l.due_date) - CAST(l.grace_days_snapshot AS SIGNED)) AS overdue_days,
       CASE WHEN l.return_date IS NOT NULL THEN 'finalized' ELSE 'estimate' END AS fine_kind,
       CASE
         WHEN l.return_date IS NOT NULL THEN
              CASE WHEN COALESCE(lf.waived,0) = 1 THEN 0 ELSE COALESCE(lf.calculated_amount, 0) END
         ELSE LEAST(COALESCE(l.fine_cap_snapshot, 999999999),
                    GREATEST(0, DATEDIFF(CURDATE(), l.due_date) - CAST(l.grace_days_snapshot AS SIGNED)) * l.fine_rate_snapshot)
       END AS fine_amount,
       COALESCE(p.paid, 0) AS fine_paid
FROM loans l
LEFT JOIN loan_fines lf ON lf.loan_id = l.loan_id
LEFT JOIN (SELECT loan_id, SUM(amount) AS paid FROM fine_payments WHERE status = 'successful' GROUP BY loan_id) p
       ON p.loan_id = l.loan_id;