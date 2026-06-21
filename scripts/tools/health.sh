#!/usr/bin/env bash
# Stack status and HTTP health probe (-h/--help: see docker compose ps / curl docs).
source "$(dirname "$0")/../lib/common.sh"

require_cmd curl
load_env

log_info "Container status:"
compose ps

health_publish="${HEALTH_PUBLISH:-127.0.0.1:8080}"
if [[ "$health_publish" == 0.0.0.0:* ]]; then
  health_publish="127.0.0.1:${health_publish#0.0.0.0:}"
fi

health_url="http://${health_publish}/healthz"
log_info "Probing ${health_url}…"

if response="$(curl -fsS "$health_url" 2>&1)"; then
  log_ok "Health check passed: ${response}"
else
  log_warn "Health check failed: ${response:-no response}"
  exit 1
fi
