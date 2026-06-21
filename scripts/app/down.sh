#!/usr/bin/env bash
# Stop the Mira Review Bot production stack.
source "$(dirname "$0")/../lib/common.sh"

require_not_root

for arg in "$@"; do
  case "$arg" in
    -v | --volumes)
      confirm "This will remove named volumes and destroy Postgres/Redis data. Continue?" \
        || die "Aborted."
      break
      ;;
  esac
done

log_info "Stopping stack…"
compose down "$@"
log_ok "Stack stopped."

cat <<EOF

Next step
─────────
Start again:
  scripts/app/up.sh

EOF
