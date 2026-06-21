#!/usr/bin/env bash
# Create persistent bind-mount directories and assign ownership to the app user.
source "$(dirname "$0")/../lib/common.sh"

require_root

if ! id "$APP_USER" >/dev/null 2>&1; then
  die "App user '$APP_USER' does not exist — run scripts/root/create-app-user.sh first."
fi

dirs=(
  "$MIRA_BASE"
  "$MIRA_PG_DIR"
  "$MIRA_REDIS_DIR"
  "$MIRA_WORK_DIR"
  "$MIRA_CACHE_DIR"
  "$MIRA_CONFIG_DIR"
  "$MIRA_BACKUP_DIR"
)

for dir in "${dirs[@]}"; do
  mkdir -p "$dir"
  chmod 750 "$dir"
  log_ok "Directory ready: $dir"
done

chown -R "$APP_USER":"$APP_USER" "$MIRA_BASE"

log_info "Postgres and Redis containers adjust internal ownership on first start."
log_info "Next step: run scripts/root/setup.sh (if not done) or switch to user '$APP_USER' for app setup."
