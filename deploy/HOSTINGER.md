# SmartQ on Hostinger (VPS)

SmartQ runs on one Hostinger VPS: the app, its database and HTTPS, all on the
same server. Address: **https://smartq-licom.online**

```
Phone / kiosk / TV  ──HTTPS──▶  nginx  ──▶  SmartQ (Node 22, PM2)  ──▶  MariaDB
                                 (port 443)    (127.0.0.1:3000)          (local only)
```

Why a VPS and not Hostinger "Web Hosting": SmartQ keeps a live connection open
to every ticket page, TV and window screen (real-time updates). Shared hosting
cuts those off; a VPS does not.

## Where everything is

| What | Where |
|---|---|
| Server | Hostinger hPanel → **VPS** (Ubuntu, KVM 1). Root password and SSH keys are set there |
| Domain | Hostinger hPanel → **Domains** → smartq-licom.online (A records `@` and `www` → the VPS IP) |
| App code | `/var/www/smartq` (runs as user `smartq`, kept running by PM2, starts again after a reboot) |
| Settings and secrets | `/var/www/smartq/.env` (database password, email key, phone-alert keys). Never commit or share it |
| Database | MariaDB on the same server, database `smartq_db`, reachable only from the server itself |
| Backups | Every day at 2:00 AM to `/var/backups/smartq` (last 14 kept) |
| HTTPS certificate | Let's Encrypt, renews by itself |
| Email | Brevo (`BREVO_API_KEY` in `.env`), sender licom.smartq@gmail.com |
| Server clock | Philippine time |

## Day to day

Sign in to the server first: `ssh root@<VPS-IP>` (or hPanel → VPS → **Browser terminal**).

| Task | Command (as root) |
|---|---|
| Put the newest GitHub code live | `bash /var/www/smartq/deploy/update.sh` (backs up first) |
| Is it running? | `sudo -u smartq pm2 status` |
| Error log | `sudo -u smartq pm2 logs smartq --lines 100` |
| Restart SmartQ | `sudo -u smartq pm2 reload smartq` |
| Backup now | `smartq-backup` |
| Restore a backup | `gunzip -c /var/backups/smartq/<file>.sql.gz \| mysql smartq_db` |
| HTTPS renewal | automatic (certbot timer); test: `certbot renew --dry-run` |
| Edit settings / secrets | `nano /var/www/smartq/.env`, then restart SmartQ |

Download a backup to your computer now and then (`scp root@<VPS-IP>:/var/backups/smartq/<file> .`)
so a copy lives off the server too.

Renew the **VPS** and the **domain** in hPanel before they expire, or the site goes offline.

## The secrets in `.env`

| Setting | Why it matters |
|---|---|
| `DB_*` | The local database. Made by the setup; leave as is |
| `BREVO_API_KEY`, `MAIL_FROM`, `SMTP_*` | Staff sign-in codes and queue code emails |
| `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, `VAPID_SUBJECT` | Phone alerts. Keep the **same** keys, also when moving to another server, or phones with alerts on stop getting them |

## Setting up a new server (only if ever needed)

How this server was built, for moving to a new one later:

1. hPanel → VPS → **Ubuntu LTS** (plain OS, no panel), set a root password and an SSH key.
2. Point the domain's A records (`@`, `www`) to the new IP; wait until `ping smartq-licom.online` shows it.
3. GitHub → Settings → Developer settings → **Fine-grained token**, only this repo,
   **Contents: Read-only**. The repo address is `https://<token>@github.com/<owner>/<repo>.git`
   (type it on the server only).
4. Copy the script up and run it:
   ```bash
   scp deploy/setup.sh root@<VPS-IP>:/root/
   ssh root@<VPS-IP>
   bash setup.sh smartq-licom.online <repo-url-with-token> <your-email>
   ```
   It installs everything, creates the database with its own random password,
   writes `.env`, gets the HTTPS certificate, starts SmartQ with PM2, opens only
   ports 22/80/443 and schedules the daily backup.
5. Copy the secrets (table above) from the old server's `.env` into the new one.
6. Move the data: on the old server `smartq-backup`, copy the newest file from
   `/var/backups/smartq` to the new server, restore it (command above), then
   `cd /var/www/smartq && sudo -u smartq node database/migrate.js` and restart.
   Do this when the office is closed, so no ticket is made in between.
7. Re-open the TV and window screens. Students with phone alerts on open their ticket once.
