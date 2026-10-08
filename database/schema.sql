-- ============================================================================
--  SmartQ v5 — Cashier & Registrar Transaction Queue System
--  Libon Community College
--
--  Import once:  mysql -u root -p < database/schema.sql
--  Safe to re-run: drops and rebuilds the schema cleanly.
-- ============================================================================

DROP DATABASE IF EXISTS smartq_db;
CREATE DATABASE smartq_db CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
USE smartq_db;

-- ── USERS ────────────────────────────────────────────────────────────────────
-- Email is the login for students and guests (student number is optional).
-- Staff and admin log in with a username.
CREATE TABLE users (
  id            INT AUTO_INCREMENT PRIMARY KEY,
  first_name    VARCHAR(60)  NOT NULL,
  middle_name   VARCHAR(60)  DEFAULT NULL,
  last_name     VARCHAR(60)  NOT NULL,
  username      VARCHAR(60)  DEFAULT NULL UNIQUE,
  email         VARCHAR(120) DEFAULT NULL UNIQUE,
  password      VARCHAR(255) DEFAULT NULL,    -- bcrypt hash; NULL for Google-only accounts
  google_id     VARCHAR(64)  DEFAULT NULL UNIQUE,
  profile_picture VARCHAR(255) DEFAULT NULL,
  auth_provider ENUM('local','google','local_google') NOT NULL DEFAULT 'local',
  email_verified TINYINT(1)  NOT NULL DEFAULT 0,
  status        ENUM('pending_verification','active','disabled','locked')
                  NOT NULL DEFAULT 'pending_verification',
  role          ENUM('admin','cashier','registrar','student','guest') NOT NULL,
  contact_no    VARCHAR(20)  DEFAULT NULL,
  -- student-only profile fields
  student_no    VARCHAR(30)  DEFAULT NULL,    -- 9 digits, required for students, one per account
  course        VARCHAR(40)  DEFAULT NULL,
  year_level    TINYINT      DEFAULT NULL,
  academic_year VARCHAR(12)  DEFAULT NULL,
  -- staff-only
  window_id     INT          DEFAULT NULL,
  priority_status ENUM('none','pwd','senior','pregnant') NOT NULL DEFAULT 'none',
  priority_approved_at TIMESTAMP NULL DEFAULT NULL,
  failed_logins INT          NOT NULL DEFAULT 0,
  locked_until  TIMESTAMP    NULL DEFAULT NULL,
  password_changed_at TIMESTAMP NULL DEFAULT NULL,
  last_login    TIMESTAMP    NULL DEFAULT NULL,
  deleted_at    TIMESTAMP    NULL DEFAULT NULL,    -- deleted but kept for old tickets
  must_change_password TINYINT(1) NOT NULL DEFAULT 0, -- set by an admin password reset
  created_at    TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at    TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_student_no (student_no),
  INDEX idx_role (role),
  INDEX idx_status (status)
) ENGINE=InnoDB;

-- ── OTP VERIFICATIONS ────────────────────────────────────────────────────────
-- Codes are stored as bcrypt hashes, never in plain text.
-- `purpose` stops a code issued for one action being reused for another.
CREATE TABLE otp_verifications (
  id          INT AUTO_INCREMENT PRIMARY KEY,
  user_id     INT          NOT NULL,
  email       VARCHAR(120) NOT NULL,
  otp_hash    VARCHAR(255) NOT NULL,
  purpose     ENUM('registration','login','password_reset',
                   'account_recovery','email_change') NOT NULL,
  payload     VARCHAR(160) DEFAULT NULL,   -- e.g. the new address for email_change
  expires_at  TIMESTAMP    NOT NULL,
  attempts    INT          NOT NULL DEFAULT 0,
  verified_at TIMESTAMP    NULL DEFAULT NULL,
  created_at  TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_user_purpose (user_id, purpose),
  INDEX idx_created (created_at),
  CONSTRAINT fk_otp_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB;

-- ── ROLE PERMISSIONS ─────────────────────────────────────────────────────────
CREATE TABLE role_permissions (
  role       ENUM('admin','cashier','registrar','student','guest') NOT NULL,
  permission VARCHAR(40) NOT NULL,
  PRIMARY KEY (role, permission)
) ENGINE=InnoDB;

-- ── SERVICES / REQUESTED ITEMS ───────────────────────────────────────────────
-- price drives Amount Due. payment_required=0 means the document goes straight
-- to the Registrar with no cashier step.
CREATE TABLE documents (
  id               INT AUTO_INCREMENT PRIMARY KEY,
  name             VARCHAR(80)   NOT NULL UNIQUE,
  price            DECIMAL(10,2) NOT NULL DEFAULT 0.00,
  payment_required TINYINT(1)    NOT NULL DEFAULT 1,
  office        ENUM('Cashier','Registrar') NOT NULL DEFAULT 'Registrar',
  needs_purpose TINYINT(1)   NOT NULL DEFAULT 0,  -- ask why it is being requested
  needs_requirements TINYINT(1) NOT NULL DEFAULT 0,  -- has things the client must bring
  requires_claim   TINYINT(1)    NOT NULL DEFAULT 1,  -- produces a document to pick up
  guest_allowed    TINYINT(1)    NOT NULL DEFAULT 0,
  baseline_minutes INT           NOT NULL DEFAULT 8,
  is_active        TINYINT(1)    NOT NULL DEFAULT 1,
  deleted_at       TIMESTAMP     NULL DEFAULT NULL,   -- deleted but kept for old tickets
  INDEX idx_active (is_active)
) ENGINE=InnoDB;

-- ── WINDOWS ──────────────────────────────────────────────────────────────────
-- Exactly 2 Cashier windows and 1 Registrar window.
CREATE TABLE windows (
  id          INT AUTO_INCREMENT PRIMARY KEY,
  label       VARCHAR(30) NOT NULL,
  department  ENUM('Cashier','Registrar') NOT NULL,
  status      ENUM('open','closed','break') NOT NULL DEFAULT 'open',
  rr_position INT NOT NULL DEFAULT 0,
  INDEX idx_dept (department)
) ENGINE=InnoDB;

-- ── TRANSACTIONS ─────────────────────────────────────────────────────────────
-- One row per ticket. A cashier ticket may carry several items (batch);
-- the documents requested live in transaction_documents.
CREATE TABLE transactions (
  id              INT AUTO_INCREMENT PRIMARY KEY,
  ticket_no       VARCHAR(12) NOT NULL,             -- C-001 / R-001, priority CP-001 / RP-001 (per office, daily)
  department      ENUM('Cashier','Registrar') NOT NULL,
  queue_category  ENUM('priority','regular') NOT NULL DEFAULT 'regular',
  priority_type   ENUM('none','pwd','senior','pregnant') NOT NULL DEFAULT 'none',

  user_id         INT NOT NULL,
  client_type     ENUM('student','guest') NOT NULL DEFAULT 'student',
  -- snapshot of who requested (kept even if the profile changes later)
  first_name      VARCHAR(60) NOT NULL,
  middle_name     VARCHAR(60) DEFAULT NULL,
  last_name       VARCHAR(60) NOT NULL,
  student_no      VARCHAR(30) DEFAULT NULL,
  course          VARCHAR(40) DEFAULT NULL,
  year_level      TINYINT     DEFAULT NULL,
  academic_year   VARCHAR(12) DEFAULT NULL,

  claimant        ENUM('self','representative') NOT NULL DEFAULT 'self',
  rep_name        VARCHAR(120) DEFAULT NULL,
  rep_relationship VARCHAR(60) DEFAULT NULL,
  rep_contact     VARCHAR(30)  DEFAULT NULL,
  rep_auth_file   VARCHAR(160) DEFAULT NULL,   -- authorisation letter upload
  purpose         ENUM('Transfer','Personal Reference','Job Purposes',
                       'Board Examination','Graduation / Dean\'s List','Others') DEFAULT NULL,
  other_purpose   VARCHAR(160) DEFAULT NULL,

  amount_due      DECIMAL(10,2) NOT NULL DEFAULT 0.00,

  ticket_status   ENUM('waiting','called','serving','completed','cancelled','no-show')
                    NOT NULL DEFAULT 'waiting',
  payment_status  ENUM('not_required','pending','paid','cancelled')
                    NOT NULL DEFAULT 'pending',
  overall_status  ENUM('pending','cashier_processing','payment_completed',
                       'waiting_registrar','registrar_processing',
                       'completed','cancelled')
                    NOT NULL DEFAULT 'pending',

  is_scheduled    TINYINT(1) NOT NULL DEFAULT 0,
  scheduled_date  DATE       DEFAULT NULL,
  service_date    DATE       NOT NULL,               -- day this ticket belongs to

  staff_id        INT DEFAULT NULL,
  staff_name      VARCHAR(120) DEFAULT NULL,
  window_id       INT DEFAULT NULL,
  window_label    VARCHAR(30) DEFAULT NULL,

  requires_claim  TINYINT(1) NOT NULL DEFAULT 0,     -- batch produces a document to pick up
  claimed_at      TIMESTAMP NULL DEFAULT NULL,

  submit_token    CHAR(36) DEFAULT NULL UNIQUE,      -- duplicate-submit guard
  access_token    CHAR(32) DEFAULT NULL,             -- opens the ticket from the phone (no login)
  booking_code    CHAR(6)  DEFAULT NULL,             -- finds the ticket again on another phone
  queue_at        DATETIME DEFAULT NULL,             -- place in line: when they joined, or the booked slot's start
  slot_start      TIME DEFAULT NULL,                 -- booked 30-minute slot (NULL for same-day "join now")
  slot_end        TIME DEFAULT NULL,
  risk_at         DATETIME DEFAULT NULL,             -- warned that they may not be served today
  alerts_sent     VARCHAR(80) NOT NULL DEFAULT '',   -- phone alerts already given (leave, next, risk...)
  hold_until      DATETIME DEFAULT NULL,             -- "available from": not called before this time
  hold_used       TINYINT(1) NOT NULL DEFAULT 0,     -- the hold can be used once per ticket
  missed_count    TINYINT NOT NULL DEFAULT 0,        -- called but not there: 1 = moved back, 2 = cancelled
  skip_count      TINYINT NOT NULL DEFAULT 0,        -- passed over by smart Call Next (never more than 2)

  requested_at    TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  called_at       TIMESTAMP NULL DEFAULT NULL,
  started_at      TIMESTAMP NULL DEFAULT NULL,
  completed_at    TIMESTAMP NULL DEFAULT NULL,
  warned_at       TIMESTAMP NULL DEFAULT NULL,
  actual_minutes  INT DEFAULT NULL,
  predicted_wait  INT DEFAULT NULL,          -- minutes predicted when issued
  predicted_service INT DEFAULT NULL,        -- minutes of service predicted
  prediction_source VARCHAR(20) DEFAULT NULL,-- historical / office / baseline
  cancel_reason   VARCHAR(120) DEFAULT NULL,

  UNIQUE KEY uq_ticket_day (ticket_no, department, service_date),
  UNIQUE KEY uq_access_token (access_token),
  INDEX idx_staff (staff_id),
  INDEX idx_dept_status (department, ticket_status),
  INDEX idx_user (user_id),
  INDEX idx_service_date (service_date),
  INDEX idx_queue (department, service_date, ticket_status, queue_at),
  CONSTRAINT fk_tx_user   FOREIGN KEY (user_id)   REFERENCES users(id)  ON DELETE CASCADE
) ENGINE=InnoDB;

-- ── TRANSACTION ITEMS (batch line items) ─────────────────────────────────────
CREATE TABLE transaction_documents (
  id             INT AUTO_INCREMENT PRIMARY KEY,
  transaction_id INT NOT NULL,
  document_id    INT NOT NULL,
  document_name  VARCHAR(80)   NOT NULL,   -- snapshot
  unit_price     DECIMAL(10,2) NOT NULL DEFAULT 0.00,
  copies         INT           NOT NULL DEFAULT 1,
  price          DECIMAL(10,2) NOT NULL,   -- unit_price * copies
  INDEX idx_tx (transaction_id),
  CONSTRAINT fk_td_tx  FOREIGN KEY (transaction_id) REFERENCES transactions(id) ON DELETE CASCADE,
  CONSTRAINT fk_td_doc FOREIGN KEY (document_id)    REFERENCES documents(id)
) ENGINE=InnoDB;

-- ── PAYMENTS ─────────────────────────────────────────────────────────────────
CREATE TABLE payments (
  id             INT AUTO_INCREMENT PRIMARY KEY,
  transaction_id INT NOT NULL UNIQUE,
  amount         DECIMAL(10,2) NOT NULL,
  status         ENUM('paid','cancelled') NOT NULL DEFAULT 'paid',
  paid_at        TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  staff_id       INT DEFAULT NULL,
  staff_name     VARCHAR(120) DEFAULT NULL,
  window_label   VARCHAR(30)  DEFAULT NULL,
  CONSTRAINT fk_pay_tx FOREIGN KEY (transaction_id) REFERENCES transactions(id) ON DELETE CASCADE
) ENGINE=InnoDB;

-- ── RECEIPTS ─────────────────────────────────────────────────────────────────
-- Receipt numbers never reset, so history stays unique.
CREATE TABLE receipts (
  id             INT AUTO_INCREMENT PRIMARY KEY,
  receipt_no     VARCHAR(24) NOT NULL UNIQUE,
  transaction_id INT NOT NULL UNIQUE,
  payment_id     INT NOT NULL,
  amount_paid    DECIMAL(10,2) NOT NULL,
  issued_at      TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_rc_tx  FOREIGN KEY (transaction_id) REFERENCES transactions(id) ON DELETE CASCADE,
  CONSTRAINT fk_rc_pay FOREIGN KEY (payment_id)     REFERENCES payments(id)     ON DELETE CASCADE
) ENGINE=InnoDB;

-- ── CLAIM ITEMS ──────────────────────────────────────────────────────────────
-- Links a Registrar "Claim Released Document" ticket to the paid Cashier
-- document lines it is collecting. A line is claimed once its claim ticket is
-- completed; a cancelled or no-show claim ticket frees the line again.
CREATE TABLE claim_items (
  id           INT AUTO_INCREMENT PRIMARY KEY,
  claim_tx_id  INT NOT NULL,   -- the Registrar claim ticket
  line_id      INT NOT NULL,   -- transaction_documents.id of the paid Cashier line
  UNIQUE KEY uq_claim_line (claim_tx_id, line_id),
  INDEX idx_line (line_id),
  CONSTRAINT fk_ci_tx   FOREIGN KEY (claim_tx_id) REFERENCES transactions(id)          ON DELETE CASCADE,
  CONSTRAINT fk_ci_line FOREIGN KEY (line_id)     REFERENCES transaction_documents(id) ON DELETE CASCADE
) ENGINE=InnoDB;

-- ── QUEUE HISTORY (audit trail) ──────────────────────────────────────────────
CREATE TABLE queue_history (
  id             INT AUTO_INCREMENT PRIMARY KEY,
  transaction_id INT NOT NULL,
  ticket_no      VARCHAR(12) NOT NULL,
  action         VARCHAR(40) NOT NULL,
  staff_id       INT DEFAULT NULL,
  staff_name     VARCHAR(120) DEFAULT NULL,
  department     VARCHAR(20) DEFAULT NULL,
  window_label   VARCHAR(30) DEFAULT NULL,
  note           VARCHAR(200) DEFAULT NULL,
  created_at     TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_tx (transaction_id),
  INDEX idx_created (created_at),
  CONSTRAINT fk_qh_tx FOREIGN KEY (transaction_id) REFERENCES transactions(id) ON DELETE CASCADE
) ENGINE=InnoDB;

-- ── SETTINGS ─────────────────────────────────────────────────────────────────
CREATE TABLE settings (
  id                    INT PRIMARY KEY DEFAULT 1,
  institution_name      VARCHAR(120) NOT NULL DEFAULT 'Libon Community College',
  system_name           VARCHAR(40)  NOT NULL DEFAULT 'SmartQ',
  academic_year         VARCHAR(12)  NOT NULL DEFAULT '2025-2026',
  open_time             TIME NOT NULL DEFAULT '08:00:00',
  close_time            TIME NOT NULL DEFAULT '17:00:00',
  break_start           TIME NOT NULL DEFAULT '12:00:00',
  break_end             TIME NOT NULL DEFAULT '13:00:00',
  open_days             VARCHAR(20) NOT NULL DEFAULT '1,2,3,4,5',  -- 1=Mon .. 7=Sun
  cashier_capacity      INT NOT NULL DEFAULT 120,
  registrar_capacity    INT NOT NULL DEFAULT 60,
  capacity_mode         ENUM('manual','auto') NOT NULL DEFAULT 'auto',
  avg_service_minutes   INT NOT NULL DEFAULT 8,
  min_samples           INT NOT NULL DEFAULT 3,
  cancel_after_minutes  INT NOT NULL DEFAULT 15,
  warn_before_minutes   INT NOT NULL DEFAULT 5,
  no_show_after_minutes INT NOT NULL DEFAULT 5,
  expire_waiting_minutes INT NOT NULL DEFAULT 60,  -- unattended ticket never called
  schedule_max_days     INT NOT NULL DEFAULT 30,   -- how far ahead a student may book
  allow_same_day        TINYINT(1) NOT NULL DEFAULT 1,  -- allow "Request Now" today
  daily_slot_limit      INT NOT NULL DEFAULT 0,    -- 0 = no cap per office per day
  max_copies            INT NOT NULL DEFAULT 10,
  max_batch_documents       INT NOT NULL DEFAULT 4,
  refresh_rate          INT NOT NULL DEFAULT 10,
  announcement          VARCHAR(255) DEFAULT 'Please watch the screen for your number.',
  updated_at            TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB;

-- ── DECISION LOG: why the system accepted, warned or held a ticket ───────────
CREATE TABLE decision_log (
  id             INT AUTO_INCREMENT PRIMARY KEY,
  transaction_id INT DEFAULT NULL,
  department     VARCHAR(20) DEFAULT NULL,
  decision       VARCHAR(30) NOT NULL,
  reason         VARCHAR(255) NOT NULL,
  detail         TEXT DEFAULT NULL,
  created_at     TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_tx (transaction_id),
  INDEX idx_created (created_at)
) ENGINE=InnoDB;

-- ── COUNTERS (daily ticket numbering + never-reset receipt numbering) ────────
CREATE TABLE counters (
  name       VARCHAR(40) NOT NULL,
  ref_date   DATE        NOT NULL,
  value      INT         NOT NULL DEFAULT 0,
  PRIMARY KEY (name, ref_date)
) ENGINE=InnoDB;

-- ── REQUIREMENTS PER DOCUMENT ────────────────────────────────────────────────
-- What a client must bring for a given item. The admin maintains this list;
-- the student sees it before requesting; staff tick off what was received.
CREATE TABLE document_requirements (
  id          INT AUTO_INCREMENT PRIMARY KEY,
  document_id INT NOT NULL,
  label       VARCHAR(140) NOT NULL,
  note        VARCHAR(200) DEFAULT NULL,
  is_required TINYINT(1) NOT NULL DEFAULT 1,
  sort_order  INT NOT NULL DEFAULT 0,
  INDEX idx_document (document_id),
  CONSTRAINT fk_req_document FOREIGN KEY (document_id) REFERENCES documents(id) ON DELETE CASCADE
) ENGINE=InnoDB;

-- A snapshot per transaction, so staff can record exactly what was submitted.
CREATE TABLE transaction_requirements (
  id             INT AUTO_INCREMENT PRIMARY KEY,
  transaction_id INT NOT NULL,
  requirement_id INT DEFAULT NULL,
  label          VARCHAR(140) NOT NULL,
  is_required    TINYINT(1) NOT NULL DEFAULT 1,
  submitted      TINYINT(1) NOT NULL DEFAULT 0,
  checked_by     INT DEFAULT NULL,
  checker_name   VARCHAR(120) DEFAULT NULL,
  checked_at     TIMESTAMP NULL DEFAULT NULL,
  INDEX idx_tx (transaction_id),
  CONSTRAINT fk_treq_tx FOREIGN KEY (transaction_id) REFERENCES transactions(id) ON DELETE CASCADE
) ENGINE=InnoDB;

-- Notes and release details the staff record at the window.
-- ── ANNOUNCEMENTS ────────────────────────────────────────────────────────────
-- One row every time a ticket is called or re-called. The display boards and
-- the student's own ticket page watch the newest id and chime when it changes.
CREATE TABLE announcements (
  id           INT AUTO_INCREMENT PRIMARY KEY,
  transaction_id INT NOT NULL,
  ticket_no    VARCHAR(12) NOT NULL,
  department   VARCHAR(20) NOT NULL,
  window_label VARCHAR(30) DEFAULT NULL,
  client_name  VARCHAR(120) DEFAULT NULL,
  is_recall    TINYINT(1) NOT NULL DEFAULT 0,
  created_at   TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_dept (department, id),
  CONSTRAINT fk_ann_tx FOREIGN KEY (transaction_id) REFERENCES transactions(id) ON DELETE CASCADE
) ENGINE=InnoDB;

-- ── PER-DAY OVERRIDES ────────────────────────────────────────────────────────
-- Staff can close a single date or give it its own cap without touching the
-- office-wide settings. One row per office per date.
CREATE TABLE day_overrides (
  id          INT AUTO_INCREMENT PRIMARY KEY,
  department  ENUM('Cashier','Registrar') NOT NULL,
  day         DATE NOT NULL,
  is_closed   TINYINT(1) NOT NULL DEFAULT 0,
  slot_limit  INT DEFAULT NULL,           -- NULL falls back to the global cap
  note        VARCHAR(160) DEFAULT NULL,  -- shown to students who try to book
  set_by      INT DEFAULT NULL,
  setter_name VARCHAR(120) DEFAULT NULL,
  updated_at  TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_dept_day (department, day)
) ENGINE=InnoDB;

-- ── PRIORITY LANE REQUESTS ───────────────────────────────────────────────────
-- A student/guest uploads proof; an admin approves or rejects it.
CREATE TABLE priority_requests (
  id           INT AUTO_INCREMENT PRIMARY KEY,
  user_id      INT NOT NULL,
  category     ENUM('pwd','senior','pregnant') NOT NULL,
  transaction_id INT DEFAULT NULL,             -- the ticket waiting on this review (QR walk-ins)
  proof_file   VARCHAR(160) NOT NULL,          -- stored filename under /uploads/priority ('' when in proof_data)
  proof_data   MEDIUMBLOB   DEFAULT NULL,      -- the proof itself, for walk-ins (survives server restarts)
  proof_mime   VARCHAR(60)  NOT NULL,
  proof_name   VARCHAR(160) NOT NULL,          -- original filename, for display
  status       ENUM('pending','approved','rejected') NOT NULL DEFAULT 'pending',
  reason       VARCHAR(255) DEFAULT NULL,      -- why it was rejected
  reviewed_by  INT DEFAULT NULL,
  reviewer_name VARCHAR(120) DEFAULT NULL,
  reviewed_at  TIMESTAMP NULL DEFAULT NULL,
  created_at   TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_user (user_id),
  INDEX idx_status (status),
  INDEX idx_tx (transaction_id),
  CONSTRAINT fk_pr_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  CONSTRAINT fk_pr_tx   FOREIGN KEY (transaction_id) REFERENCES transactions(id) ON DELETE CASCADE
) ENGINE=InnoDB;

-- ── PHONE NOTIFICATIONS (Web Push), one row per ticket and phone ──────────────
CREATE TABLE push_subscriptions (
  id             INT AUTO_INCREMENT PRIMARY KEY,
  transaction_id INT NOT NULL,
  endpoint_hash  CHAR(64) NOT NULL,
  endpoint       TEXT NOT NULL,
  p256dh         VARCHAR(255) NOT NULL,
  auth           VARCHAR(255) NOT NULL,
  created_at     TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_tx_endpoint (transaction_id, endpoint_hash),
  CONSTRAINT fk_ps_tx FOREIGN KEY (transaction_id) REFERENCES transactions(id) ON DELETE CASCADE
) ENGINE=InnoDB;

-- ============================================================================
--  SEED DATA
-- ============================================================================

INSERT INTO settings (id) VALUES (1);

-- One Cashier window, two Registrar windows (as configured by the offices).
INSERT INTO windows (id,label,department,status,rr_position) VALUES
  (1,'Cashier Window 1',  'Cashier',  'open',1),
  (2,'Registrar Window 1','Registrar','open',1),
  (3,'Registrar Window 2','Registrar','open',2);

-- Official price list
INSERT INTO documents (name,price,payment_required,requires_claim,guest_allowed,baseline_minutes) VALUES
  ('Official Transcript of Records',           110.00,1,1,1,12),
  ('Authentication',                            30.00,1,1,1, 6),
  ('Photocopy of Certificate of Registration',  30.00,1,1,1, 5),
  ('Good Moral',                                30.00,1,1,1, 7),
  ('Certificate of Grades',                     30.00,1,1,1, 7),
  ('Certificate',                               30.00,1,1,1, 7),
  ('Honorable Dismissal',                       30.00,1,1,1, 8),
  ('FS Rating',                                 30.00,1,1,0, 7),
  ('GWA',                                       30.00,1,1,0, 7),
  ('Practice Teaching',                         30.00,1,1,0, 8),
  ('Certificate of Enrollment',                 30.00,1,1,1, 7),
  -- pure fees: nothing to pick up, the transaction ends at the cashier
  ('Late Enrollment',                          150.00,1,0,0,15),
  ('Completion Fee',                            30.00,1,0,0, 7),
  -- no payment: straight to the Registrar
  ('Claim Released Document',                    0.00,0,1,1, 5),
  ('Records Inquiry',                            0.00,0,0,1, 5);

-- Only the Official Transcript of Records asks for a purpose and has
-- requirements the client must bring.
UPDATE documents SET needs_purpose = 1, needs_requirements = 1
 WHERE name = 'Official Transcript of Records';

-- Office is derived from whether the document is paid for.
UPDATE documents SET office = IF(payment_required = 1, 'Cashier', 'Registrar');

-- Requirements the office asks for, per document
INSERT INTO document_requirements (document_id,label,note,is_required,sort_order)
SELECT id, 'Valid school or government ID', 'Original, presented at the window', 1, 1
  FROM documents WHERE name = 'Official Transcript of Records'
UNION ALL
SELECT id, 'Accomplished request form', 'Available at the Registrar', 1, 2
  FROM documents WHERE name = 'Official Transcript of Records'
UNION ALL
SELECT id, 'Clearance for the last term enrolled', NULL, 1, 3
  FROM documents WHERE name = 'Official Transcript of Records';

-- Permissions
INSERT INTO role_permissions (role,permission) VALUES
  ('admin','dashboard'),('admin','users.manage'),('admin','documents.manage'),
  ('admin','windows.manage'),('admin','reports.view'),('admin','settings.manage'),
  ('admin','queue.manage'),('admin','display.view'),('admin','priority.review'),
  ('cashier','dashboard'),('cashier','queue.cashier'),('cashier','queue.call'),
  ('cashier','payment.process'),('cashier','receipt.issue'),('cashier','display.view'),
  ('registrar','dashboard'),('registrar','queue.registrar'),('registrar','queue.call'),
  ('registrar','document.process'),('registrar','display.view'),
  ('student','dashboard'),('student','ticket.request'),('student','ticket.schedule'),
  ('student','ticket.own'),('student','history.own'),('student','receipt.own'),
  ('student','account.manage'),('student','display.view'),('student','priority.request'),
  ('guest','dashboard'),('guest','ticket.request'),('guest','ticket.own'),
  ('guest','receipt.own'),('guest','account.manage'),('guest','display.view'),
  ('guest','priority.request');

-- No user accounts are seeded. After importing this file, create the first
-- admin with:  node database/create-admin.js
-- Staff accounts are then added from Admin > Staff Accounts, and students
-- register themselves at /register.
