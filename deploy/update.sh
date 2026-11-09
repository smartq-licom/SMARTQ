#!/usr/bin/env bash
# Put the latest SmartQ from GitHub live on the VPS. Run as root:
#   bash /var/www/smartq/deploy/update.sh
# Takes a backup first, pulls the code, adds any new database columns, and
# reloads the app without dropping visitors.
set -euo pipefail
APP_DIR=/var/www/smartq
/usr/local/bin/smartq-backup
sudo -u smartq bash -c "cd $APP_DIR && git pull --ff-only && npm ci --omit=dev && node database/migrate.js && pm2 reload smartq"
echo "SmartQ updated: $(sudo -u smartq git -C $APP_DIR log --oneline -1)"
