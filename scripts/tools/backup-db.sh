#!/usr/bin/env bash
# Dump Postgres to a timestamped .sql.gz under $MIRA_BACKUP_DIR.
source "$(dirname "$0")/../lib/common.sh"

load_env
mkdir -p "$MIRA_BACKUP_DIR"

file="$MIRA_BACKUP_DIR/mira-$(date +%Y%m%d-%H%M%S).sql.gz"
log_info "Backing up database to ${file}…"

compose exec -T -e PGPASSWORD="$POSTGRES_PASSWORD" postgres \
  pg_dump -U "${POSTGRES_USER:-mira}" -d "${POSTGRES_DB:-mira}" | gzip > "$file"

size="$(du -h "$file" | awk '{print $1}')"
log_ok "Backup saved: ${file} (${size})"
