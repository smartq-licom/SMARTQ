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
   then fill in your MySQL password and the other values it describes.

3. Open a command prompt INSIDE this folder.
   In File Explorer, click the address bar, type: cmd  then press Enter.

4. Install, create the first admin (see "First accounts" below), and run:
       npm install
       node database/create-admin.js
       npm start

5. Open http://localhost:3000

## Public display boards (open on the TV / monitor)
   http://localhost:3000/display/cashier
   http://localhost:3000/display/registrar

## First accounts
No accounts are included. After importing schema.sql, create the admin:

    node database/create-admin.js

It asks for a username and a strong password (8+ characters with upper and
lower case, a number and a symbol). Run it again with the same username to
reset a forgotten admin password.

Then log in as admin and create the cashier and registrar accounts under
Admin > Staff Accounts, posting each one to a service window.

Windows: ONE Cashier window, TWO Registrar windows.
Change them any time under Admin > Service Windows (rename, open/close,
and post a staff member to each window).

Students and guests register themselves at /register.
Admin > Student Accounts lists them (view, search, enable/disable).
Admin > Staff Accounts is where cashier/registrar/admin accounts are created.

## Deploy online (Render + free MySQL)
Render runs the app. Render has no MySQL, so the database lives on a free
MySQL host. Nothing in the code has to change between local and online:
only the environment values differ.

### 1. Create the MySQL database (Aiven, free)
1. Sign up at https://aiven.io > Create service > MySQL > Free plan.
2. When it is Running, open it and note Host, Port, User (avnadmin) and
   Password. Click "Download CA cert" and keep the file.
   (TiDB Cloud Serverless also works: same steps, no CA file needed.)

### 2. Load the tables from your own computer
1. Save Aiven's CA certificate as `ca.pem` in this folder.
2. Create a file named `.env.cloud` in this folder with the Aiven values
   (it is git-ignored, like ca.pem, so it is never uploaded):

       DB_HOST=<aiven host>
       DB_PORT=<aiven port>
       DB_USER=avnadmin
       DB_PASSWORD=<aiven password>
       DB_NAME=smartq_db
       DB_SSL=true
       DB_SSL_CA=ca.pem

3. Run, in this folder:

       npm run cloud:import    (type smartq_db to confirm; creates 17 tables)
       npm run cloud:admin     (creates the admin you will log in with)

Your normal .env is not touched, so the local copy keeps working.

### 3. Put the code on GitHub
Push this folder to a GitHub repository. .env is ignored, so no password is
uploaded. Only commit .env.example.

### 4. Create the Render web service
1. https://dashboard.render.com > New > Blueprint > pick the repository.
   render.yaml creates the "smartq" web service and asks for each secret.
2. Fill in the same DB_* values as .env.cloud, except DB_SSL_CA: paste the
   whole text of ca.pem there instead of the file name. Also fill in the SMTP_* and GOOGLE_*
   values from your .env. SESSION_SECRET is generated for you.
3. GOOGLE_CALLBACK_URL = https://smartq-licom.onrender.com/auth/google/callback
   and add that exact URL in Google Cloud Console > Credentials > your OAuth
   client > Authorised redirect URIs.
4. Deploy. Open https://smartq-licom.onrender.com and log in as admin,
   then create the cashier and registrar accounts.

### Things to know on Render's free plan
- The app sleeps after 15 minutes without visitors; the next visit takes
  about a minute. Open it a few minutes before a demo.
- Logins are stored in MySQL, so sleeping or redeploying does not log
  anyone out.
- Uploaded priority-lane proof files are stored on the server's disk, which
  Render wipes on every deploy and restart. Re-upload after a deploy, or
  add a paid persistent disk mounted at /opt/render/project/src/uploads.
- Free web services may not be allowed to send email over SMTP. If codes do
  not arrive online, students can still use Continue with Google, or move
  the service to a paid instance.
- Google sign-in: while the OAuth consent screen is in "Testing", only the
  Gmail accounts listed as Test users can sign in. Add your testers there,
  or click "Publish app" for everyone.

## Test flow to demo
1. Log in as a student, click Issue Ticket, pick Request Now.
2. Choose "Official Transcript of Records" — the amount shows PHP 110 automatically.
3. Pick a purpose, choose Regular or Priority, submit. You get C-001.
4. Log in as a cashier in another browser. Click Call Next (a chime sounds at the
   counter), then Accept Ticket. Call Again re-announces the same number.
5. Click Record Payment & Issue Receipt. The cashier transaction ends there.
6. The Cashier and the Registrar are NOT linked in one transaction. If the
   student also needs the Registrar, they request a separate Registrar ticket
   themselves from their own dashboard.
7. Log in as a registrar. Call Next, Accept, Complete.
8. Back on the student account: status is Completed, and the receipt is viewable.

## Documents that are picked up later
A document with "To claim" switched on produces something the client collects at
the Registrar. Documents that are pure fees (Late Enrollment, Completion Fee)
have it switched off, so they close at the cashier with nothing to pick up. You
can change that switch per document.

Cashier and Registrar transactions are independent: the cashier never issues a
Registrar ticket on the student's behalf. A student who needs both offices takes
one ticket per office, and may hold at most one open ticket per office at a time.

Claiming is tied to payment. "Claim Released Document" (any Registrar document
with "To claim" on) can only be requested for documents the Cashier has already
recorded as paid: the student ticks which paid documents they are collecting,
today or on a booked date. While their Cashier ticket is unpaid the option is
locked with "Finish your payment at the Cashier first". A completed claim marks
those documents claimed, so they cannot be claimed twice; a cancelled or no-show
claim ticket frees them again. Payments made outside SmartQ (paper receipts)
are handled by the Registrar at the window. Records Inquiry stays open to all.

Existing databases need the claim_items table:  npm run db:migrate
(online: npm run cloud:migrate). It is safe to run more than once.

Cashier and Registrar staff maintain their own office's document list under
Documents. Only the admin can change a price.

## Authentication
Three ways to sign in:

  Username + password  ─┐
  Gmail + password     ─┼─→ Dashboard
  Continue with Google ─┘

- The emailed 6-digit code is used ONCE, when a student registers, to prove the
  Gmail is theirs. After that, the right password signs them straight in.
- Continue with Google never asks for a code: Google has already proven the
  address. First-time Google users fill in their profile before the dashboard.

- Passwords are bcrypt hashed. Nothing is stored or logged in plain text.
- OTP codes are ALSO bcrypt hashed. The code exists only in the email.
- Codes expire in 5 minutes, are single use, allow 5 attempts, and have a
  60-second resend cooldown (max 6 per hour).
- Each code carries a purpose (registration / password_reset /
  account_recovery / email_change) so a reset code cannot complete a login.
- 5 failed passwords locks the account for 15 minutes.

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
