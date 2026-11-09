# SmartQ on Hostinger (VPS)

SmartQ runs on one Hostinger VPS: the app, its database and HTTPS, all on the
same server. Replaces Render (app) and Aiven (database).

```
Phone / kiosk / TV  ──HTTPS──▶  nginx  ──▶  SmartQ (Node 22, PM2)  ──▶  MariaDB
                                 (port 443)    (127.0.0.1:3000)          (local only)
```

Why a VPS and not Hostinger "Web Hosting": SmartQ keeps a live connection open
to every ticket page, TV and window screen (real-time updates). Shared hosting
cuts those off; a VPS does not.

## 1. Buy the server (hPanel)

1. Hostinger → **VPS Hosting** → **KVM 1** (1 vCPU, 4 GB RAM) is enough.
   Pick the data center nearest the Philippines (Singapore if offered).
2. Operating system: **Ubuntu 26.04 LTS** (or 24.04 LTS; plain OS, no panel).
3. Set a root password and add your **SSH key** (hPanel → VPS → Settings → SSH keys).
4. Note the server's **IP address** and **hostname** (looks like `srv123456.hstgr.cloud`).

## 2. A web address

Either use the free hostname from step 1.4, or point your own domain:
DNS → add an **A record** `smartq` → the VPS IP (gives `smartq.yourdomain.com`).
Wait until `ping smartq.yourdomain.com` shows the VPS IP before step 4.

## 3. Let the server read the code

The GitHub repo is private, so the server needs read access. GitHub →
Settings → Developer settings → **Fine-grained token** → only this repo,
**Contents: Read-only**. The repo address for step 4 is then
`https://<token>@github.com/<owner>/<repo>.git` (type it on the server only).

## 4. Run the setup (once)

From your computer, copy the script up, then run it on the server:

```bash
scp deploy/setup.sh root@<VPS-IP>:/root/
ssh root@<VPS-IP>
bash setup.sh <your-address> <repo-url-with-token> <your-email>
```

It installs everything, creates the database with its own random password,
writes `/var/www/smartq/.env`, gets the HTTPS certificate, starts SmartQ with
PM2 (it comes back by itself after a reboot), opens only ports 22/80/443, and
schedules a database backup every day at 2:00 AM (last 14 kept in
`/var/backups/smartq`). The server clock is set to Philippine time.

## 5. Fill in the secrets

```bash
nano /var/www/smartq/.env
```

Copy from Render's Environment tab (never commit these, never paste them in chat):

| Setting | Why it matters |
|---|---|
| `BREVO_API_KEY`, `MAIL_FROM`, and the `SMTP_*` lines | Staff sign-in codes and queue code emails |
| `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, `VAPID_SUBJECT` | Use the **same** keys as Render, or phones with alerts on stop getting them |

Then: `sudo -u smartq pm2 reload smartq`

## 6. Move the data from Aiven (once, at switch-over)

Do this when the office is closed, so no ticket is made in between.

```bash
# on the VPS: copy the database out of Aiven (values from your .env.cloud)
mysqldump --ssl -h <aiven-host> -P <aiven-port> -u <aiven-user> -p \
  --single-transaction --routines --triggers --no-tablespaces smartq_db > aiven.sql

# Aiven is MySQL 8, the VPS has MariaDB: switch the MySQL-8-only collation
sed -i 's/utf8mb4_0900_ai_ci/utf8mb4_unicode_ci/g' aiven.sql

# load it, add any newer columns, restart
mysql smartq_db < aiven.sql
cd /var/www/smartq && sudo -u smartq node database/migrate.js
sudo -u smartq pm2 reload smartq
rm aiven.sql        # it holds personal data
```

Check: sign in as staff, open Reports, find yesterday's tickets.
(No old data to keep? Skip this and run `sudo -u smartq node database/create-admin.js`.)

## 7. Switch over

1. Print new QR codes / kiosk links with the new address.
2. Re-open the TV and window screens on the new address.
3. Students with phone alerts on must open their ticket once on the new address
   (alerts are tied to the website address).
4. Keep Render and Aiven for one week as a fallback, then delete them.

## Day to day

| Task | Command (as root) |
|---|---|
| Put the newest GitHub code live | `bash /var/www/smartq/deploy/update.sh` (backs up first) |
| Is it running? | `sudo -u smartq pm2 status` |
| Error log | `sudo -u smartq pm2 logs smartq --lines 100` |
| Backup now | `smartq-backup` |
| Restore a backup | `gunzip -c /var/backups/smartq/<file>.sql.gz \| mysql smartq_db` |
| HTTPS renewal | automatic (certbot timer); test: `certbot renew --dry-run` |

Download a backup to your computer now and then (`scp root@<VPS-IP>:/var/backups/smartq/<file> .`)
so a copy lives off the server too.
