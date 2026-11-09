#!/usr/bin/env bash
# Daily SmartQ database backup (cron, 2:00 AM). Keeps the last 14 days in
# /var/backups/smartq. The backups hold personal data: they stay on the server.
set -euo pipefail
DIR=/var/backups/smartq
mkdir -p "$DIR"; chmod 700 "$DIR"
mysqldump --single-transaction --routines --triggers smartq_db | gzip > "$DIR/smartq-$(date +%Y%m%d-%H%M).sql.gz"
find "$DIR" -name 'smartq-*.sql.gz' -mtime +14 -delete
