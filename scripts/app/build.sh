#!/usr/bin/env bash
# Build the shared mira-review-bot application Docker image.
source "$(dirname "$0")/../lib/common.sh"

require_not_root
require_cmd docker

log_info "Building mira-review-bot:latest (shared by api, poller, worker)…"
compose build "$@"
log_ok "Image built: mira-review-bot:latest"

cat <<EOF

Next step
─────────
Start the stack:
  scripts/app/up.sh

EOF
