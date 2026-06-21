#!/usr/bin/env bash
# Restart one or all Mira Review Bot stack services.
source "$(dirname "$0")/../lib/common.sh"

require_not_root

log_info "Restarting stack services${*:+: $*}…"
compose restart "$@"
log_ok "Restart complete."

cat <<EOF

Next steps
──────────
Check health:  scripts/tools/health.sh
View logs:     scripts/tools/logs.sh

EOF
