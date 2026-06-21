#!/usr/bin/env bash
# OPTIONAL: basic inbound hardening with ufw (OpenSSH + optional webhook port).
source "$(dirname "$0")/../lib/common.sh"

require_root

PORT="${1:-8080}"
SOURCE_CIDR="${2:-}"

usage() {
  cat <<EOF
Usage: $(basename "$0") [PORT] [SOURCE_CIDR]

  PORT         TCP port to allow when SOURCE_CIDR is set (default: 8080)
  SOURCE_CIDR  If set, allow inbound TCP to PORT from this CIDR only
               If omitted, no webhook/health port is opened (loopback-only by default)

This script is optional. It does NOT restrict outbound traffic.
EOF
}

if [ "${1:-}" = "-h" ] || [ "${1:-}" = "--help" ]; then
  usage
  exit 0
fi

if ! command -v ufw >/dev/null 2>&1; then
  log_info "Installing ufw…"
  export DEBIAN_FRONTEND=noninteractive
  apt-get update
  apt-get install -y ufw
fi

log_info "Applying ufw rules (idempotent; re-running is safe)…"

ufw default deny incoming
ufw default allow outgoing
ufw allow OpenSSH

if [ -n "$SOURCE_CIDR" ]; then
  log_info "Allowing TCP/$PORT from $SOURCE_CIDR"
  ufw allow from "$SOURCE_CIDR" to any port "$PORT" proto tcp
else
  log_info "No SOURCE_CIDR given — skipping webhook/health port (localhost-only by default)"
fi

log_warn "Outbound allowlisting (GitLab, Kaiten, Cursor, etc.) is NOT handled here."
log_warn "Configure egress restrictions at the network/firewall layer if required."

ufw --force enable

log_ok "ufw enabled"
ufw status verbose || true

log_info "Next step: continue app deployment as user '$APP_USER' (see scripts/root/setup.sh output)."
