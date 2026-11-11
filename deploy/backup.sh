#!/usr/bin/env sh
# Hot backup of the SQLite database from the running container.
# Usage: ./deploy/backup.sh [output-dir]   (cron it daily)
set -eu
OUT="${1:-./backups}"
mkdir -p "$OUT"
STAMP="$(date +%Y%m%d-%H%M%S)"
docker compose exec -T app node -e "
const Database = require('better-sqlite3');
new Database('/data/school-tracker.db', { readonly: true }).backup('/data/backup.db').then(() => console.log('ok'));
"
docker compose cp app:/data/backup.db "$OUT/school-tracker-$STAMP.db"
echo "Saved $OUT/school-tracker-$STAMP.db"
