#!/usr/bin/env bash
# Restore a backup produced by backup-db.sh (usage: restore-db.sh <path-to-.sql-or-.sql.gz>).
source "$(dirname "$0")/../lib/common.sh"

if [ $# -lt 1 ] || [ "$1" = "-h" ] || [ "$1" = "--help" ]; then
  die "Usage: $(basename "$0") <path-to-.sql-or-.sql.gz>"
fi

file="$1"
[ -f "$file" ] || die "Backup file not found: $file"

load_env

confirm "This OVERWRITES the current database. Continue?" || die "Restore aborted."

log_info "Restoring from ${file}…"

if [[ "$file" == *.gz ]]; then
  gzip -dc "$file"
else
  cat "$file"
fi | compose exec -T -e PGPASSWORD="$POSTGRES_PASSWORD" postgres \
  psql -U "${POSTGRES_USER:-mira}" -d "${POSTGRES_DB:-mira}"

log_ok "Database restored from ${file}"
