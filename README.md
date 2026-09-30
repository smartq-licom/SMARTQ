# SmartQ v5 — Cashier & Registrar Transaction Queue System
Libon Community College

## Requirements
- Node.js 16+   https://nodejs.org  (install the LTS, tick "Add to PATH")
- MySQL 8+ or MariaDB

## Setup

1. Import the database.
   Open MySQL Workbench, then File > Open SQL Script > database/schema.sql > Execute.
   NOTE: schema.sql DROPS and recreates smartq_db. Back up first if you have data.

2. Create your .env file.
   Copy .env.example, rename the copy to exactly `.env` (not .env.txt),
   then fill in your MySQL password.

3. Open a command prompt INSIDE this folder.
   In File Explorer, click the address bar, type: cmd  then press Enter.

4. Install and run:
       npm install
       npm start

5. Open http://localhost:3000

## Public display boards (open on the TV / monitor)
   http://localhost:3000/display/cashier
   http://localhost:3000/display/registrar

## Demo accounts
| Role       | Login                      | Password      |
|------------|----------------------------|---------------|
| Admin      | admin                      | admin123      |
| Cashier    | cashier1                   | cashier123    |
| Registrar 1| registrar1                 | registrar123  |
| Registrar 2| registrar2                 | registrar123  |
| Student    | juan123 or juan@student.lcc.edu.ph | student123 |
| Student    | liza123 or liza@student.lcc.edu.ph | student123 |
| Guest      | ramon123 or visitor@mail.com | guest123    |

Windows: ONE Cashier window, TWO Registrar windows.
Change them any time under Admin > Service Windows (rename, open/close,
and post a staff member to each window).

Students and guests register themselves at /register.
Admin > Student Accounts lists them (view, search, enable/disable).
Admin > Staff Accounts is where cashier/registrar/admin accounts are created.

## Test flow to demo
1. Log in as a student, click Issue Ticket, pick Request Now.
2. Choose "Official Transcript of Records" — the amount shows PHP 110 automatically.
3. Pick a purpose, choose Regular or Priority, submit. You get C-001.
4. Log in as cashier1 in another browser. Click Call Next (a chime sounds at the
   counter), then Accept Ticket. Call Again re-announces the same number.
5. Click Record Payment & Issue Receipt. The cashier transaction ends there.
6. The Cashier and the Registrar are NOT linked in one transaction. If the
   student also needs the Registrar, they request a separate Registrar ticket
   themselves from their own dashboard.
7. Log in as registrar1. Call Next, Accept, Complete.
8. Back on the student account: status is Completed, and the receipt is viewable.

## Documents that are picked up later
A document with "To claim" switched on produces something the client collects at
the Registrar. Documents that are pure fees (Late Enrollment, Completion Fee)
have it switched off, so they close at the cashier with nothing to pick up. You
can change that switch per document.

Cashier and Registrar transactions are independent: the cashier never issues a
Registrar ticket on the student's behalf. A student who needs both offices takes
one ticket per office, and may hold at most one open ticket per office at a time.

Cashier and Registrar staff maintain their own office's document list under
Documents. Only the admin can change a price.

## Authentication
Three ways to sign in, all ending at the same OTP step:

  Username + password  ─┐
  Gmail + password     ─┼─→ 6-digit code by email ─→ Dashboard
  Continue with Google ─┘

- Passwords are bcrypt hashed. Nothing is stored or logged in plain text.
- OTP codes are ALSO bcrypt hashed. The code exists only in the email.
- Codes expire in 5 minutes, are single use, allow 5 attempts, and have a
  60-second resend cooldown (max 6 per hour).
- Each code carries a purpose (registration / login / password_reset /
  account_recovery / email_change) so a reset code cannot complete a login.
- 5 failed passwords locks the account for 15 minutes.
- Staff accounts have no email address, so they sign in without the OTP step.

Pages: /register, /forgot-password, /recover, /verify, /reset-password.
Account settings can change the email address (confirmed by OTP on the NEW
address) and the password (requires the current one).

### Password rules
At least 8 characters, one uppercase, one lowercase, one number, one symbol.

### Email setup (needed for OTP)
Fill the SMTP section of .env. For Gmail: turn on 2-Step Verification, then
Google Account > Security > App passwords, and use that 16-character password.
  SMTP_HOST=smtp.gmail.com  SMTP_PORT=587  SMTP_SECURE=false
  SMTP_USER=you@gmail.com   SMTP_PASS=the app password

If SMTP is left blank the code prints in the terminal running "npm start",
which is enough for testing and demos.

## Priority lane (new)
Students and guests can no longer simply tick "Priority". They upload proof
(PWD ID, Senior Citizen ID, or a doctor's certificate) under
Student > Priority Lane. It is stored as Pending.

An admin reviews it under Admin > Priority Requests, sees the uploaded image
or PDF, and approves or rejects it with a reason. Approval stamps the category
onto the account, so every future ticket is flagged priority automatically.
Rejected students can upload new proof and submit again.

Uploads are limited to JPG, PNG or PDF, maximum 5 MB, and are stored in
/uploads/priority. That folder is NOT public: files can only be opened by the
owner or an admin.

## Peak hour detection
Three different measures of "busy", per office, per hour:

| Measure            | Question it answers           | Source                      |
|--------------------|-------------------------------|-----------------------------|
| Requests / day     | How much DEMAND arrives?      | count of requested_at       |
| Waiting at once    | How CROWDED is the lobby?     | tickets whose wait overlaps |
| Average wait       | What did clients EXPERIENCE?  | requested_at -> called_at   |

They do not always agree, which is the point: the hour with the most arrivals
is often not the hour with the longest waits, because a backlog drains into the
hour that follows the rush.

Profiles are built from the last 30 days of the SAME WEEKDAY — the last four or
five Mondays for a Monday — because Monday and Friday are not the same day at a
cashier's window. When a weekday has fewer than 2 days of history the profile
falls back to all days combined and is labelled "Provisional" on screen, rather
than presenting four data points as a pattern.

The break hour is drawn in the chart but never named as busiest or quietest,
since "come at lunch" is not advice for a closed window.

Where it appears:
- Admin > Reports: both offices side by side, with a weekday selector and the
  full figures table. Independent of the report's From/To dates.
- Cashier / Registrar dashboard: today's shape, plus a banner when the current
  hour is usually a busy one.
- Booking Calendar (staff and admin): click a date and the profile for THAT
  date's weekday appears under the bookings, so a cap or closure is set against
  the real shape of that weekday.
- Student request form: one line per office naming the busiest and a quieter
  hour. It follows the date the student picks — choose a Friday three weeks out
  and it switches to Friday's history, no page reload. All seven weekdays are
  sent with the page, and both offices share one history read, so that costs two
  queries rather than fourteen.

Peak hours are READ-ONLY. They never change queue order, the wait estimate, or
booking limits. Results are cached for 10 minutes, because the counter screens
reload every 10 seconds and a month-long scan on each refresh would be waste.

### Seeing it before you have history
A fresh install shows "Not enough history yet" — correctly, since there is
nothing to profile. To fill it with realistic backdated tickets for a demo:

    node database/seed-peak-demo.js            insert ~4 weeks of history
    node database/seed-peak-demo.js --clear    remove it again

It builds a Cashier morning rush (9-11 AM), a Registrar afternoon rush (2-4 PM),
heavier Mondays, a thin lunch hour, and longer waits inside the rush so the
three measures visibly disagree.

THIS IS FAKE DATA. It is attached to the first student account and counts in
Reports ticket totals, so clear it before the system goes into real use. Every
seeded row is marked with a submit_token starting 'demoseed-', and --clear
deletes only those.

## Courses
The course list lives in ONE place: COURSES in data/db.js. It is validated on
the server, so a tampered form cannot store a course the college does not offer.

  BEED, BECE,
  BSED - English / Filipino / Mathematics / Science / Social Studies /
         Values Education,
  BSAB,
  BTVTEd - Automotive Technology / Electrical Technology /
           Food Service Management

If you change the list on a database that already has students, run
database/migrate-courses.sql once: it widens the column and clears course
values that are no longer offered, so those students are asked to re-select.

## Notes
- Scheduling runs up to Admin > Settings > "Schedule max days" ahead
  (30 by default), enforced on the server. Staff can close a single date or
  cap it under Booking Calendar.
- A transaction that has been PAID is never auto-cancelled.
- Prices are set by the admin under Documents. Students never type an amount.
- Queue numbers reset daily. Receipt numbers never reset.
