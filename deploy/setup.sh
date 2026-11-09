#!/usr/bin/env bash
# SmartQ on a Hostinger VPS (Ubuntu 24.04 or 26.04 LTS), set up once.
#
#   bash setup.sh <domain-or-vps-hostname> <git-repo-url> <admin-email>
#   e.g. bash setup.sh srv123456.hstgr.cloud https://github.com/smartq-licom/SMARTQ.git admin@example.com
#
# Installs Node.js 22, MariaDB, nginx (HTTPS by Let's Encrypt), PM2, a firewall
# and a daily database backup; creates the database and its own user; puts the
# app in /var/www/smartq and starts it. Safe to run again: it never resets the
# database or an existing .env.
set -euo pipefail

DOMAIN="${1:?Usage: bash setup.sh <domain> <git-repo-url> <admin-email>}"
REPO="${2:?Usage: bash setup.sh <domain> <git-repo-url> <admin-email>}"
EMAIL="${3:?Usage: bash setup.sh <domain> <git-repo-url> <admin-email>}"
APP_DIR=/var/www/smartq
APP_USER=smartq

echo "== 1/8 System: Philippine time, updates, packages"
timedatectl set-timezone Asia/Manila
apt-get update
DEBIAN_FRONTEND=noninteractive apt-get -y upgrade
DEBIAN_FRONTEND=noninteractive apt-get install -y curl git nginx mariadb-server certbot python3-certbot-nginx ufw
if ! command -v node >/dev/null || [ "$(node -v | cut -c2- | cut -d. -f1)" -lt 20 ]; then
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
  apt-get install -y nodejs
fi
command -v pm2 >/dev/null || npm install -g pm2

echo "== 2/8 App user"
id -u "$APP_USER" >/dev/null 2>&1 || useradd -m -s /bin/bash "$APP_USER"

echo "== 3/8 App code"
if [ ! -d "$APP_DIR/.git" ]; then
  mkdir -p "$APP_DIR"; chown "$APP_USER:$APP_USER" "$APP_DIR"
  sudo -u "$APP_USER" git clone "$REPO" "$APP_DIR"
fi
sudo -u "$APP_USER" bash -c "cd $APP_DIR && npm ci --omit=dev"
mkdir -p "$APP_DIR/uploads/priority"; chown -R "$APP_USER:$APP_USER" "$APP_DIR/uploads"

echo "== 4/8 Database (MariaDB, local only) and .env"
if [ ! -f "$APP_DIR/.env" ]; then
  DB_PASS=$(openssl rand -hex 16)
  mysql -e "CREATE DATABASE IF NOT EXISTS smartq_db CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
            CREATE USER IF NOT EXISTS 'smartq'@'localhost' IDENTIFIED BY '$DB_PASS';
            ALTER USER 'smartq'@'localhost' IDENTIFIED BY '$DB_PASS';
            GRANT ALL PRIVILEGES ON smartq_db.* TO 'smartq'@'localhost'; FLUSH PRIVILEGES;"
  sed -e "s|__DB_PASSWORD__|$DB_PASS|" \
      -e "s|__SESSION_SECRET__|$(openssl rand -hex 32)|" \
      -e "s|__DOMAIN__|$DOMAIN|g" \
      "$APP_DIR/deploy/env.production.example" > "$APP_DIR/.env"
  chown "$APP_USER:$APP_USER" "$APP_DIR/.env"; chmod 600 "$APP_DIR/.env"
  echo "   .env created. Fill in SMTP_* and VAPID_* (see deploy/HOSTINGER.md, step 5)."
else
  echo "   .env already there: kept as it is."
fi

echo "== 5/8 Tables (only if the database is empty)"
TABLES=$(mysql -N -e "SELECT COUNT(*) FROM information_schema.tables WHERE table_schema='smartq_db'")
if [ "$TABLES" = "0" ]; then
  sudo -u "$APP_USER" bash -c "cd $APP_DIR && node database/import-schema.js"
else
  sudo -u "$APP_USER" bash -c "cd $APP_DIR && node database/migrate.js"
fi

echo "== 6/8 Web server (nginx) and HTTPS"
sed "s|__DOMAIN__|$DOMAIN|g" "$APP_DIR/deploy/nginx-smartq.conf" > /etc/nginx/sites-available/smartq
ln -sf /etc/nginx/sites-available/smartq /etc/nginx/sites-enabled/smartq
rm -f /etc/nginx/sites-enabled/default
nginx -t && systemctl reload nginx
ufw allow OpenSSH; ufw allow 'Nginx Full'; ufw --force enable
certbot --nginx -d "$DOMAIN" --non-interactive --agree-tos -m "$EMAIL" --redirect || \
  echo "   HTTPS not issued yet: check that $DOMAIN points to this server, then run: certbot --nginx -d $DOMAIN"

echo "== 7/8 Start SmartQ (PM2 keeps it running and restarts it after a reboot)"
sudo -u "$APP_USER" bash -c "cd $APP_DIR && pm2 startOrReload deploy/ecosystem.config.cjs && pm2 save"
env PATH="$PATH" pm2 startup systemd -u "$APP_USER" --hp "/home/$APP_USER" >/dev/null

echo "== 8/8 Daily database backup at 2:00 AM (last 14 kept)"
install -m 750 "$APP_DIR/deploy/backup.sh" /usr/local/bin/smartq-backup
echo "0 2 * * * root /usr/local/bin/smartq-backup" > /etc/cron.d/smartq-backup

echo
echo "SmartQ is running at https://$DOMAIN"
echo "Next: fill SMTP_* and VAPID_* in $APP_DIR/.env, move the data (deploy/HOSTINGER.md step 6), then:"
echo "      sudo -u $APP_USER pm2 reload smartq"
