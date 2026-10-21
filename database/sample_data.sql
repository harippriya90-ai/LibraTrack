-- LibraTrack sample data | run AFTER schema.sql
-- All people, ISBNs, phone numbers and transaction IDs are fictional demo values.
-- password_hash is a placeholder until backend/scripts/set-demo-passwords.js runs.
USE libratrack;
SET time_zone = '+05:30';
SET @t = CURDATE();
SET @n = NOW();

-- ---------- Branches ----------
INSERT INTO branches (branch_id, name, address, phone, email) VALUES
(1, 'Central Branch - Chennai',   '12 Anna Salai, Chennai 600002',          '+914440010001', 'chennai@libratrack.example'),
(2, 'North Branch - Vellore',     '45 Officers Line, Vellore 632001',       '+914160020002', 'vellore@libratrack.example'),
(3, 'South Branch - Coimbatore',  '8 Race Course Road, Coimbatore 641018',  '+914220030003', 'coimbatore@libratrack.example');

-- ---------- Users (hashes set by Node script) ----------
INSERT INTO users (user_id, username, password_hash, full_name, role, branch_id) VALUES
(1, 'admin',            'PENDING-RUN-set-demo-passwords', 'Central Administrator',   'admin', NULL),
(2, 'staff_chennai',    'PENDING-RUN-set-demo-passwords', 'Chennai Branch Staff',    'staff', 1),
(3, 'staff_vellore',    'PENDING-RUN-set-demo-passwords', 'Vellore Branch Staff',    'staff', 2),
(4, 'staff_coimbatore', 'PENDING-RUN-set-demo-passwords', 'Coimbatore Branch Staff', 'staff', 3);

-- ---------- Membership plans ----------
INSERT INTO membership_plans (plan_id, name, duration_months, fee, max_loans, loan_days) VALUES
(1, 'Monthly',   1,   200.00, 2, 14),
(2, 'Quarterly', 3,   500.00, 3, 14),
(3, 'Annual',    12, 1500.00, 5, 21);

-- ---------- Books ----------
INSERT INTO books (book_id, isbn, title, author, category, edition, publisher, publication_year, price, fine_per_day) VALUES
(1,  '978-81-90000-01-1', 'Database System Concepts',                 'Silberschatz, Korth, Sudarshan', 'Computer Science', '7th',  'McGraw-Hill',        2019,  899.00, 5.00),
(2,  '978-81-90000-02-1', 'Fundamentals of Database Systems',         'Elmasri and Navathe',            'Computer Science', '7th',  'Pearson',            2016,  799.00, 5.00),
(3,  '978-81-90000-03-1', 'Introduction to Algorithms',               'Cormen, Leiserson, Rivest, Stein','Computer Science','4th',  'MIT Press',          2022, 1200.00, 5.00),
(4,  '978-81-90000-04-1', 'Operating System Concepts',                'Silberschatz, Galvin, Gagne',    'Computer Science', '10th', 'Wiley',              2018,  850.00, 5.00),
(5,  '978-81-90000-05-1', 'Python Crash Course',                      'Eric Matthes',                   'Computer Science', '3rd',  'No Starch Press',    2023,  650.00, 4.00),
(6,  '978-81-90000-06-1', 'Clean Code',                               'Robert C. Martin',               'Computer Science', '1st',  'Prentice Hall',      2008,  700.00, 4.00),
(7,  '978-81-90000-07-1', 'An Introduction to Statistical Learning',  'James, Witten, Hastie, Tibshirani','Data Science',   '2nd',  'Springer',           2021,  950.00, 5.00),
(8,  '978-81-90000-08-1', 'Python for Data Analysis',                 'Wes McKinney',                   'Data Science',     '3rd',  'OReilly',            2022,  750.00, 5.00),
(9,  '978-81-90000-09-1', 'Hands-On Machine Learning',                'Aurelien Geron',                 'Data Science',     '3rd',  'OReilly',            2022, 1100.00, 6.00),
(10, '978-81-90000-10-1', 'Wings of Fire',                           'A. P. J. Abdul Kalam',           'Biography',        '1st',  'Universities Press', 1999,  250.00, 2.00),
(11, '978-81-90000-11-1', 'The Story of My Experiments with Truth',   'M. K. Gandhi',                   'Biography',        '1st',  'Navajivan',          1927,  150.00, 2.00),
(12, '978-81-90000-12-1', 'Malgudi Days',                             'R. K. Narayan',                  'Fiction',          '1st',  'Indian Thought',     1943,  220.00, 2.00),
(13, '978-81-90000-13-1', 'The Guide',                                'R. K. Narayan',                  'Fiction',          '1st',  'Viking',             1958,  250.00, 2.00),
(14, '978-81-90000-14-1', 'Train to Pakistan',                        'Khushwant Singh',                'Fiction',          '1st',  'Chatto and Windus',  1956,  280.00, 3.00),
(15, '978-81-90000-15-1', 'Sapiens',                                  'Yuval Noah Harari',              'History',          '1st',  'Harvill Secker',     2014,  499.00, 3.00),
(16, '978-81-90000-16-1', 'India After Gandhi',                       'Ramachandra Guha',               'History',          '2nd',  'Picador',            2017,  799.00, 4.00),
(17, '978-81-90000-17-1', 'A Brief History of Time',                  'Stephen Hawking',                'Science',          '1st',  'Bantam',             1988,  399.00, 3.00),
(18, '978-81-90000-18-1', 'Cosmos',                                   'Carl Sagan',                     'Science',          '1st',  'Random House',       1980,  450.00, 3.00),
(19, '978-81-90000-19-1', 'Atomic Habits',                            'James Clear',                    'Self-Help',        '1st',  'Avery',              2018,  599.00, 3.00),
(20, '978-81-90000-20-1', 'Thirukkural',                              'Thiruvalluvar',                  'Literature',       '1st',  NULL,                 NULL,  200.00, 2.00);

-- ---------- Branch inventory ----------
INSERT INTO branch_inventory (branch_id, book_id, total_copies) VALUES
(1,1,3),(1,2,2),(1,3,2),(1,4,2),(1,5,3),(1,6,2),(1,8,2),(1,9,2),(1,10,3),(1,12,2),(1,15,2),(1,17,2),(1,19,3),
(2,1,2),(2,3,1),(2,5,2),(2,7,2),(2,8,2),(2,10,2),(2,11,2),(2,13,2),(2,14,2),(2,16,1),(2,18,2),(2,20,2),
(3,2,2),(3,4,1),(3,6,2),(3,9,1),(3,12,2),(3,13,2),(3,15,2),(3,16,2),(3,17,1),(3,18,1),(3,19,2),(3,20,1);

-- ---------- Members ----------
INSERT INTO members (member_id, full_name, email, phone, home_branch_id, registered_on, is_active) VALUES
(1,  'Ananya Krishnan',      'ananya.krishnan@example.com',  '+919840010001', 1, DATE_ADD(@t, INTERVAL -130 DAY), 1),
(2,  'Rahul Menon',          'rahul.menon@example.com',      '+919840010002', 1, DATE_ADD(@t, INTERVAL -25 DAY),  1),
(3,  'Divya Raghavan',       'divya.raghavan@example.com',   '+919840010003', 1, DATE_ADD(@t, INTERVAL -45 DAY),  1),
(4,  'Karthik Subramanian',  'karthik.s@example.com',        '+919840010004', 1, DATE_ADD(@t, INTERVAL -155 DAY), 1),
(5,  'Meera Nair',           'meera.nair@example.com',       '+919840010005', 1, DATE_ADD(@t, INTERVAL -95 DAY),  1),
(6,  'Arjun Venkatesh',      'arjun.venkatesh@example.com',  '+919840020006', 2, DATE_ADD(@t, INTERVAL -205 DAY), 1),
(7,  'Priya Shankar',        'priya.shankar@example.com',    '+919840020007', 2, DATE_ADD(@t, INTERVAL -35 DAY),  1),
(8,  'Mohammed Faizan',      'faizan.m@example.com',         '+919840020008', 2, DATE_ADD(@t, INTERVAL -65 DAY),  1),
(9,  'Lakshmi Iyer',         'lakshmi.iyer@example.com',     '+919840020009', 2, DATE_ADD(@t, INTERVAL -20 DAY),  1),
(10, 'Sanjay Kumar',         'sanjay.kumar@example.com',     '+919840020010', 2, DATE_ADD(@t, INTERVAL -105 DAY), 1),
(11, 'Harish Babu',          'harish.babu@example.com',      '+919840030011', 3, DATE_ADD(@t, INTERVAL -50 DAY),  1),
(12, 'Nithya Prakash',       'nithya.prakash@example.com',   '+919840030012', 3, DATE_ADD(@t, INTERVAL -8 DAY),   1),
(13, 'Vikram Rao',           'vikram.rao@example.com',       '+919840030013', 3, DATE_ADD(@t, INTERVAL -2 DAY),   1),
(14, 'Sneha Pillai',         'sneha.pillai@example.com',     '+919840030014', 3, DATE_ADD(@t, INTERVAL -25 DAY),  1),
(15, 'Gokul Raj',            'gokul.raj@example.com',        '+919840030015', 3, DATE_ADD(@t, INTERVAL -14 DAY),  1);

-- ---------- Payment requests ----------
-- reference_no = random 24-char opaque token (this is what the QR will encode)
INSERT INTO payment_requests
 (request_id, reference_no, member_id, branch_id, plan_id, request_type, amount, method,
  submitted_txn_id, verification_txn_id, status, proof_stored_name, proof_original_name, proof_mime,
  requested_at, expires_at, verified_by, verified_at, rejection_reason, created_by) VALUES
(1,  UPPER(LEFT(REPLACE(UUID(),'-',''),24)), 1, 1, 3, 'new',     1500.00, 'upi',           'UPI-A1001',  'VT-0001', 'successful', 'demo_proof_1.png', 'upi_screenshot.png',   'image/png', DATE_ADD(@n, INTERVAL -121 DAY), DATE_ADD(@n, INTERVAL -116 DAY), 1,    DATE_ADD(@n, INTERVAL -120 DAY), NULL, 2),
(2,  UPPER(LEFT(REPLACE(UUID(),'-',''),24)), 2, 1, 1, 'new',      200.00, 'cash',          NULL,         'VT-0002', 'successful', NULL, NULL, NULL,                                     DATE_ADD(@n, INTERVAL -21 DAY),  DATE_ADD(@n, INTERVAL -16 DAY),  1,    DATE_ADD(@n, INTERVAL -20 DAY),  NULL, 2),
(3,  UPPER(LEFT(REPLACE(UUID(),'-',''),24)), 3, 1, 2, 'new',      500.00, 'upi',           'UPI-A1003',  'VT-0003', 'successful', NULL, NULL, NULL,                                     DATE_ADD(@n, INTERVAL -41 DAY),  DATE_ADD(@n, INTERVAL -36 DAY),  1,    DATE_ADD(@n, INTERVAL -40 DAY),  NULL, 2),
(4,  UPPER(LEFT(REPLACE(UUID(),'-',''),24)), 4, 1, 2, 'new',      500.00, 'netbanking',    'NB-77120',   'VT-0004', 'successful', NULL, NULL, NULL,                                     DATE_ADD(@n, INTERVAL -151 DAY), DATE_ADD(@n, INTERVAL -146 DAY), 1,    DATE_ADD(@n, INTERVAL -150 DAY), NULL, 2),
(5,  UPPER(LEFT(REPLACE(UUID(),'-',''),24)), 4, 1, 2, 'renewal',  500.00, 'upi',           'UPI-A1005',  NULL,      'pending',    'demo_proof_2.png', 'renewal_receipt.png', 'image/png', DATE_ADD(@n, INTERVAL -2 DAY),   DATE_ADD(@n, INTERVAL 3 DAY),    NULL, NULL,                            NULL, 2),
(6,  UPPER(LEFT(REPLACE(UUID(),'-',''),24)), 5, 1, 3, 'new',     1500.00, 'netbanking',    'NB-77206',   'VT-0005', 'successful', NULL, NULL, NULL,                                     DATE_ADD(@n, INTERVAL -91 DAY),  DATE_ADD(@n, INTERVAL -86 DAY),  1,    DATE_ADD(@n, INTERVAL -90 DAY),  NULL, 2),
(7,  UPPER(LEFT(REPLACE(UUID(),'-',''),24)), 6, 2, 3, 'new',     1500.00, 'card',          'CARD-5521',  'VT-0006', 'successful', NULL, NULL, NULL,                                     DATE_ADD(@n, INTERVAL -201 DAY), DATE_ADD(@n, INTERVAL -196 DAY), 1,    DATE_ADD(@n, INTERVAL -200 DAY), NULL, 3),
(8,  UPPER(LEFT(REPLACE(UUID(),'-',''),24)), 7, 2, 2, 'new',      500.00, 'upi',           'UPI-A1008',  'VT-0007', 'successful', NULL, NULL, NULL,                                     DATE_ADD(@n, INTERVAL -31 DAY),  DATE_ADD(@n, INTERVAL -26 DAY),  1,    DATE_ADD(@n, INTERVAL -30 DAY),  NULL, 3),
(9,  UPPER(LEFT(REPLACE(UUID(),'-',''),24)), 8, 2, 3, 'new',     1500.00, 'upi',           'UPI-A1009',  'VT-0008', 'successful', NULL, NULL, NULL,                                     DATE_ADD(@n, INTERVAL -61 DAY),  DATE_ADD(@n, INTERVAL -56 DAY),  1,    DATE_ADD(@n, INTERVAL -60 DAY),  NULL, 3),
(10, UPPER(LEFT(REPLACE(UUID(),'-',''),24)), 9, 2, 1, 'new',      200.00, 'cash',          NULL,         'VT-0009', 'successful', NULL, NULL, NULL,                                     DATE_ADD(@n, INTERVAL -16 DAY),  DATE_ADD(@n, INTERVAL -11 DAY),  1,    DATE_ADD(@n, INTERVAL -15 DAY),  NULL, 3),
(11, UPPER(LEFT(REPLACE(UUID(),'-',''),24)), 10, 2, 3, 'new',    1500.00, 'upi',           'UPI-A1011',  'VT-0010', 'successful', NULL, NULL, NULL,                                     DATE_ADD(@n, INTERVAL -101 DAY), DATE_ADD(@n, INTERVAL -96 DAY),  1,    DATE_ADD(@n, INTERVAL -100 DAY), NULL, 3),
(12, UPPER(LEFT(REPLACE(UUID(),'-',''),24)), 11, 3, 3, 'new',    1500.00, 'bank_transfer', 'BT-902331',  'VT-0011', 'successful', NULL, NULL, NULL,                                     DATE_ADD(@n, INTERVAL -46 DAY),  DATE_ADD(@n, INTERVAL -41 DAY),  1,    DATE_ADD(@n, INTERVAL -45 DAY),  NULL, 4),
(13, UPPER(LEFT(REPLACE(UUID(),'-',''),24)), 12, 3, 1, 'new',     200.00, 'cash',          NULL,         'VT-0012', 'successful', NULL, NULL, NULL,                                     DATE_ADD(@n, INTERVAL -6 DAY),   DATE_ADD(@n, INTERVAL -1 DAY),   1,    DATE_ADD(@n, INTERVAL -5 DAY),   NULL, 4),
(14, UPPER(LEFT(REPLACE(UUID(),'-',''),24)), 13, 3, 2, 'new',     500.00, 'upi',           'UPI-A1014',  NULL,      'pending',    NULL, NULL, NULL,                                     DATE_ADD(@n, INTERVAL -1 DAY),   DATE_ADD(@n, INTERVAL 4 DAY),    NULL, NULL,                            NULL, 4),
(15, UPPER(LEFT(REPLACE(UUID(),'-',''),24)), 14, 3, 1, 'new',     200.00, 'upi',           'UPI-A1015',  'VT-0013', 'successful', NULL, NULL, NULL,                                     DATE_ADD(@n, INTERVAL -21 DAY),  DATE_ADD(@n, INTERVAL -16 DAY),  1,    DATE_ADD(@n, INTERVAL -20 DAY),  NULL, 4),
(16, UPPER(LEFT(REPLACE(UUID(),'-',''),24)), 14, 3, 2, 'renewal', 500.00, 'netbanking',    'NB-77316',   'VT-0014', 'successful', NULL, NULL, NULL,                                     DATE_ADD(@n, INTERVAL -6 DAY),   DATE_ADD(@n, INTERVAL -1 DAY),   1,    DATE_ADD(@n, INTERVAL -5 DAY),   NULL, 4),
(17, UPPER(LEFT(REPLACE(UUID(),'-',''),24)), 15, 3, 1, 'new',     200.00, 'upi',           'UPI-A1017',  NULL,      'rejected',   NULL, NULL, NULL,                                     DATE_ADD(@n, INTERVAL -12 DAY),  DATE_ADD(@n, INTERVAL -7 DAY),   1,    DATE_ADD(@n, INTERVAL -11 DAY),  'Transaction ID not found in bank statement', 4),
(18, UPPER(LEFT(REPLACE(UUID(),'-',''),24)), 15, 3, 1, 'new',     200.00, 'upi',           'UPI-A1018',  NULL,      'expired',    NULL, NULL, NULL,                                     DATE_ADD(@n, INTERVAL -9 DAY),   DATE_ADD(@n, INTERVAL -4 DAY),   NULL, NULL,                            NULL, 4);

-- ---------- Memberships (one per successful payment) ----------
INSERT INTO memberships
 (membership_id, member_id, plan_id, payment_request_id, renewal_of_id, start_date, expiry_date, duration_months, fee_paid, max_loans, loan_days) VALUES
(1,  1,  3, 1,  NULL, DATE_ADD(@t, INTERVAL -120 DAY), DATE_ADD(DATE_ADD(@t, INTERVAL -120 DAY), INTERVAL 12 MONTH), 12, 1500.00, 5, 21),
(2,  2,  1, 2,  NULL, DATE_ADD(@t, INTERVAL -20 DAY),  DATE_ADD(DATE_ADD(@t, INTERVAL -20 DAY),  INTERVAL 1 MONTH),   1,  200.00, 2, 14),
(3,  3,  2, 3,  NULL, DATE_ADD(@t, INTERVAL -40 DAY),  DATE_ADD(DATE_ADD(@t, INTERVAL -40 DAY),  INTERVAL 3 MONTH),   3,  500.00, 3, 14),
(4,  4,  2, 4,  NULL, DATE_ADD(@t, INTERVAL -150 DAY), DATE_ADD(DATE_ADD(@t, INTERVAL -150 DAY), INTERVAL 3 MONTH),   3,  500.00, 3, 14),
(5,  5,  3, 6,  NULL, DATE_ADD(@t, INTERVAL -90 DAY),  DATE_ADD(DATE_ADD(@t, INTERVAL -90 DAY),  INTERVAL 12 MONTH), 12, 1500.00, 5, 21),
(6,  6,  3, 7,  NULL, DATE_ADD(@t, INTERVAL -200 DAY), DATE_ADD(DATE_ADD(@t, INTERVAL -200 DAY), INTERVAL 12 MONTH), 12, 1500.00, 5, 21),
(7,  7,  2, 8,  NULL, DATE_ADD(@t, INTERVAL -30 DAY),  DATE_ADD(DATE_ADD(@t, INTERVAL -30 DAY),  INTERVAL 3 MONTH),   3,  500.00, 3, 14),
(8,  8,  3, 9,  NULL, DATE_ADD(@t, INTERVAL -60 DAY),  DATE_ADD(DATE_ADD(@t, INTERVAL -60 DAY),  INTERVAL 12 MONTH), 12, 1500.00, 5, 21),
(9,  9,  1, 10, NULL, DATE_ADD(@t, INTERVAL -15 DAY),  DATE_ADD(DATE_ADD(@t, INTERVAL -15 DAY),  INTERVAL 1 MONTH),   1,  200.00, 2, 14),
(10, 10, 3, 11, NULL, DATE_ADD(@t, INTERVAL -100 DAY), DATE_ADD(DATE_ADD(@t, INTERVAL -100 DAY), INTERVAL 12 MONTH), 12, 1500.00, 5, 21),
(11, 11, 3, 12, NULL, DATE_ADD(@t, INTERVAL -45 DAY),  DATE_ADD(DATE_ADD(@t, INTERVAL -45 DAY),  INTERVAL 12 MONTH), 12, 1500.00, 5, 21),
(12, 12, 1, 13, NULL, DATE_ADD(@t, INTERVAL -5 DAY),   DATE_ADD(DATE_ADD(@t, INTERVAL -5 DAY),   INTERVAL 1 MONTH),   1,  200.00, 2, 14),
(13, 14, 1, 15, NULL, DATE_ADD(@t, INTERVAL -20 DAY),  DATE_ADD(DATE_ADD(@t, INTERVAL -20 DAY),  INTERVAL 1 MONTH),   1,  200.00, 2, 14);

-- Renewal: starts the day after the current membership (13) expires.
INSERT INTO memberships
 (membership_id, member_id, plan_id, payment_request_id, renewal_of_id, start_date, expiry_date, duration_months, fee_paid, max_loans, loan_days)
SELECT 14, 14, 2, 16, 13,
       DATE_ADD(expiry_date, INTERVAL 1 DAY),
       DATE_ADD(DATE_ADD(expiry_date, INTERVAL 1 DAY), INTERVAL 3 MONTH),
       3, 500.00, 3, 14
FROM memberships WHERE membership_id = 13;

-- ---------- Loans ----------
-- due_date = issue_date + plan loan_days (14 for Monthly/Quarterly, 21 for Annual)
INSERT INTO loans
 (loan_id, member_id, branch_id, book_id, issue_date, due_date, return_date,
  fine_rate_snapshot, grace_days_snapshot, fine_cap_snapshot, issued_by, returned_by) VALUES
(1,  1,  1, 1,  DATE_ADD(@t, INTERVAL -30 DAY),  DATE_ADD(@t, INTERVAL -9 DAY),  NULL,                       5.00, 0, NULL, 2, NULL),
(2,  2,  1, 5,  DATE_ADD(@t, INTERVAL -5 DAY),   DATE_ADD(@t, INTERVAL 9 DAY),   NULL,                       4.00, 0, NULL, 2, NULL),
(3,  3,  1, 9,  DATE_ADD(@t, INTERVAL -20 DAY),  DATE_ADD(@t, INTERVAL -6 DAY),  NULL,                       6.00, 0, NULL, 2, NULL),
(4,  1,  1, 10, DATE_ADD(@t, INTERVAL -60 DAY),  DATE_ADD(@t, INTERVAL -39 DAY), DATE_ADD(@t, INTERVAL -40 DAY),  2.00, 0, NULL, 2, 2),
(5,  3,  1, 3,  DATE_ADD(@t, INTERVAL -35 DAY),  DATE_ADD(@t, INTERVAL -21 DAY), DATE_ADD(@t, INTERVAL -16 DAY),  5.00, 0, NULL, 2, 2),
(6,  5,  1, 17, DATE_ADD(@t, INTERVAL -40 DAY),  DATE_ADD(@t, INTERVAL -19 DAY), DATE_ADD(@t, INTERVAL -13 DAY),  3.00, 0, NULL, 2, 2),
(7,  6,  1, 15, DATE_ADD(@t, INTERVAL -10 DAY),  DATE_ADD(@t, INTERVAL 11 DAY),  NULL,                       3.00, 0, NULL, 2, NULL),
(8,  6,  2, 8,  DATE_ADD(@t, INTERVAL -25 DAY),  DATE_ADD(@t, INTERVAL -4 DAY),  NULL,                       5.00, 0, NULL, 3, NULL),
(9,  7,  2, 7,  DATE_ADD(@t, INTERVAL -12 DAY),  DATE_ADD(@t, INTERVAL 2 DAY),   NULL,                       5.00, 0, NULL, 3, NULL),
(10, 8,  2, 13, DATE_ADD(@t, INTERVAL -50 DAY),  DATE_ADD(@t, INTERVAL -29 DAY), DATE_ADD(@t, INTERVAL -23 DAY),  2.00, 0, NULL, 3, 3),
(11, 8,  2, 14, DATE_ADD(@t, INTERVAL -8 DAY),   DATE_ADD(@t, INTERVAL 13 DAY),  NULL,                       3.00, 0, NULL, 3, NULL),
(12, 9,  2, 10, DATE_ADD(@t, INTERVAL -12 DAY),  DATE_ADD(@t, INTERVAL 2 DAY),   DATE_ADD(@t, INTERVAL -3 DAY),   2.00, 0, NULL, 3, 3),
(13, 10, 2, 11, DATE_ADD(@t, INTERVAL -80 DAY),  DATE_ADD(@t, INTERVAL -59 DAY), NULL,                       2.00, 0, NULL, 3, NULL),
(14, 11, 3, 13, DATE_ADD(@t, INTERVAL -25 DAY),  DATE_ADD(@t, INTERVAL -4 DAY),  NULL,                       2.00, 0, NULL, 4, NULL),
(15, 11, 3, 6,  DATE_ADD(@t, INTERVAL -3 DAY),   DATE_ADD(@t, INTERVAL 18 DAY),  NULL,                       4.00, 0, NULL, 4, NULL),
(16, 12, 3, 12, DATE_ADD(@t, INTERVAL -4 DAY),   DATE_ADD(@t, INTERVAL 10 DAY),  NULL,                       2.00, 0, NULL, 4, NULL),
(17, 14, 3, 19, DATE_ADD(@t, INTERVAL -15 DAY),  DATE_ADD(@t, INTERVAL -1 DAY),  NULL,                       3.00, 0, NULL, 4, NULL),
(18, 11, 3, 4,  DATE_ADD(@t, INTERVAL -40 DAY),  DATE_ADD(@t, INTERVAL -19 DAY), DATE_ADD(@t, INTERVAL -19 DAY),  5.00, 0, NULL, 4, 4),
(19, 7,  2, 18, DATE_ADD(@t, INTERVAL -28 DAY),  DATE_ADD(@t, INTERVAL -14 DAY), DATE_ADD(@t, INTERVAL -9 DAY),   3.00, 0, NULL, 3, 3),
-- Loan 20: rate snapshot 4.00 although Database System Concepts is now 5.00 (rate raised after issue).
(20, 4,  1, 1,  DATE_ADD(@t, INTERVAL -100 DAY), DATE_ADD(@t, INTERVAL -86 DAY), DATE_ADD(@t, INTERVAL -80 DAY),  4.00, 0, NULL, 2, 2),
-- Loan 21: member 4's membership expired while this loan was open; loan stays open and fines keep accruing.
(21, 4,  1, 6,  DATE_ADD(@t, INTERVAL -70 DAY),  DATE_ADD(@t, INTERVAL -56 DAY), NULL,                       4.00, 0, NULL, 2, NULL),
-- Loan 22: takes the only copy of this book at Coimbatore (0 available).
(22, 11, 3, 9,  DATE_ADD(@t, INTERVAL -6 DAY),   DATE_ADD(@t, INTERVAL 15 DAY),  NULL,                       6.00, 0, NULL, 4, NULL);

-- ---------- Finalized fines (written at return) ----------
INSERT INTO loan_fines (loan_id, overdue_days, rate_applied, calculated_amount, finalized_at) VALUES
(4,  0, 2.00,  0.00, DATE_ADD(@n, INTERVAL -40 DAY)),
(5,  5, 5.00, 25.00, DATE_ADD(@n, INTERVAL -16 DAY)),
(6,  6, 3.00, 18.00, DATE_ADD(@n, INTERVAL -13 DAY)),
(10, 6, 2.00, 12.00, DATE_ADD(@n, INTERVAL -23 DAY)),
(12, 0, 2.00,  0.00, DATE_ADD(@n, INTERVAL -3 DAY)),
(18, 0, 5.00,  0.00, DATE_ADD(@n, INTERVAL -19 DAY)),
(19, 5, 3.00, 15.00, DATE_ADD(@n, INTERVAL -9 DAY)),
(20, 6, 4.00, 24.00, DATE_ADD(@n, INTERVAL -80 DAY));

-- ---------- Fine payments (separate from membership payments) ----------
INSERT INTO fine_payments (fine_payment_id, loan_id, amount, method, transaction_ref, status, paid_at, recorded_by) VALUES
(1, 5,  10.00, 'cash', NULL,          'successful', DATE_ADD(@n, INTERVAL -14 DAY), 2),  -- partial: 15.00 still owed
(2, 6,  18.00, 'upi',  'UPI-FN-2001', 'successful', DATE_ADD(@n, INTERVAL -12 DAY), 2),  -- fully paid
(3, 19, 15.00, 'cash', NULL,          'successful', DATE_ADD(@n, INTERVAL -8 DAY),  3),  -- fully paid
(4, 10, 12.00, 'upi',  'UPI-FN-2004', 'failed',     DATE_ADD(@n, INTERVAL -22 DAY), 3);  -- failed: does not count as paid

-- ---------- Incidents ----------
INSERT INTO incidents
 (incident_id, incident_ref, incident_type, loan_id, member_id, branch_id, book_id, book_edition, book_isbn,
  description, reported_by, reported_at, status, decision, decision_notes, decided_by, decided_at, replacement_received, resolved_at) VALUES
(1, 'INC-2026-0001', 'damage', 12, 9, 2, 10, '1st', '978-81-90000-10-1',
 'Water damage to inner pages and warped cover found on return.', 3, DATE_ADD(@n, INTERVAL -3 DAY),
 'decided', 'replace_and_suspend',
 'Replace with same title, edition and cover (or an approved equivalent). Two-week suspension applied.', 1, DATE_ADD(@n, INTERVAL -2 DAY), 0, NULL),
(2, 'INC-2026-0002', 'theft_concealment', 13, 10, 2, 11, '1st', '978-81-90000-11-1',
 'Book unreturned well past due date; repeated contact attempts documented. Referred for administrator review.', 3, DATE_ADD(@n, INTERVAL -30 DAY),
 'resolved', 'permanent_restriction',
 'Administrator reviewed the documented evidence and confirmed deliberate non-return. Permanent borrowing restriction applied.', 1, DATE_ADD(@n, INTERVAL -20 DAY), 0, DATE_ADD(@n, INTERVAL -20 DAY)),
(3, 'INC-2026-0003', 'damage', 19, 7, 2, 18, '1st', '978-81-90000-18-1',
 'Torn back cover noticed on return. Awaiting administrator assessment.', 3, DATE_ADD(@n, INTERVAL -1 DAY),
 'reported', 'none', NULL, NULL, NULL, 0, NULL);

-- ---------- Suspensions and restrictions ----------
INSERT INTO member_restrictions (restriction_id, member_id, kind, start_date, end_date, reason, incident_id, approved_by) VALUES
(1, 9,  'suspension',  DATE_ADD(@t, INTERVAL -2 DAY),  DATE_ADD(@t, INTERVAL 12 DAY), 'Damaged book (INC-2026-0001): two-week suspension', 1, 1),
(2, 10, 'restriction', DATE_ADD(@t, INTERVAL -20 DAY), NULL,                          'Confirmed deliberate non-return (INC-2026-0002)',    2, 1);

-- ---------- Ebooks (files are placeholders created by the Node script) ----------
INSERT INTO ebooks (ebook_id, title, author, category, edition, publisher, file_format, stored_file_name, original_name, file_size_bytes, access_policy) VALUES
(1, 'Think Python',                  'Allen B. Downey',          'Computer Science', '2nd', 'Green Tea Press', 'pdf', 'demo_ebook_1.pdf', 'think_python.pdf',        1000, 'read_only'),
(2, 'Pride and Prejudice',           'Jane Austen',              'Fiction',          '1st', NULL,              'pdf', 'demo_ebook_2.pdf', 'pride_prejudice.pdf',     1000, 'download_allowed'),
(3, 'Meditations',                   'Marcus Aurelius',          'Philosophy',       '1st', NULL,              'pdf', 'demo_ebook_3.pdf', 'meditations.pdf',         1000, 'read_only'),
(4, 'LibraTrack Staff Handbook',     'LibraTrack Administration','Internal',         '1st', NULL,              'pdf', 'demo_ebook_4.pdf', 'staff_handbook.pdf',      1000, 'staff_only');

INSERT INTO ebook_access (access_id, ebook_id, member_id, user_id, action, granted, deny_reason, accessed_at) VALUES
(1, 1, 1,    NULL, 'read',     1, NULL,                 DATE_ADD(@n, INTERVAL -3 DAY)),
(2, 1, 4,    NULL, 'read',     0, 'Membership expired', DATE_ADD(@n, INTERVAL -2 DAY)),
(3, 2, 10,   NULL, 'download', 0, 'Member restricted',  DATE_ADD(@n, INTERVAL -1 DAY)),
(4, 4, NULL, 2,    'read',     1, NULL,                 DATE_ADD(@n, INTERVAL -1 DAY));

-- ---------- Audit logs ----------
INSERT INTO audit_logs (user_id, action, entity_type, entity_id, details, created_at) VALUES
(1, 'payment_verified', 'payment_request', '1',  'VT-0001 verified; membership 1 activated',          DATE_ADD(@n, INTERVAL -120 DAY)),
(1, 'payment_rejected', 'payment_request', '17', 'Rejected: transaction ID not found',                DATE_ADD(@n, INTERVAL -11 DAY)),
(1, 'incident_decided', 'incident',        '2',  'permanent_restriction confirmed; restriction 2',    DATE_ADD(@n, INTERVAL -20 DAY)),
(3, 'incident_reported','incident',        '1',  'Damage reported for loan 12',                       DATE_ADD(@n, INTERVAL -3 DAY)),
(1, 'incident_decided', 'incident',        '1',  'replace_and_suspend; suspension 1 created',         DATE_ADD(@n, INTERVAL -2 DAY)),
(4, 'loan_issued',      'loan',            '22', 'Member 11, book 9, branch 3',                       DATE_ADD(@n, INTERVAL -6 DAY));
