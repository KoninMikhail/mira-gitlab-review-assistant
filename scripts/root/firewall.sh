#!/usr/bin/env bash
# OPTIONAL host-level hardening with ufw: default-deny inbound, allow SSH only.
#
# IMPORTANT — ufw does NOT firewall Docker-published ports.
#   Docker writes its own iptables rules (DOCKER / DOCKER-USER chains) and
#   container traffic is routed through the FORWARD chain, while ufw mostly
#   filters INPUT (traffic to the host itself). So `ufw deny` will NOT block a
#   port you publish with `-p` / compose `ports:`.
#
#   This is fine for our stack: postgres/redis are NOT published, and `api`
#   binds to 127.0.0.1 (HEALTH_PUBLISH) — nothing is exposed externally. This
#   script only provides baseline host protection (e.g. for sshd).
#
#   If you ever publish a Docker port to 0.0.0.0 and need to filter it, use the
#   DOCKER-USER chain (e.g. the `ufw-docker` helper) — plain ufw rules won't apply.
source "$(dirname "$0")/../lib/common.sh"

require_root

if [ "${1:-}" = "-h" ] || [ "${1:-}" = "--help" ]; then
  cat <<EOF
Usage: $(basename "$0")

  Optional baseline host firewall: default deny incoming, allow outgoing,
  allow SSH. Does NOT (and cannot) filter Docker-published ports — see the
  header comment in this file.
EOF
  exit 0
fi

if ! command -v ufw >/dev/null 2>&1; then
  log_info "Installing ufw…"
  export DEBIAN_FRONTEND=noninteractive
  apt-get update
  apt-get install -y ufw
fi

log_info "Applying baseline ufw rules (idempotent; re-running is safe)…"

ufw default deny incoming
ufw default allow outgoing
ufw allow OpenSSH

log_warn "ufw protects HOST services only — it does NOT filter Docker-published ports."
log_warn "Outbound allowlisting (GitLab, Kaiten, Cursor) is NOT handled here; do it at the network layer if required."

ufw --force enable

log_ok "ufw enabled (default-deny inbound, SSH allowed)"
ufw status verbose || true

log_info "Next step: continue app deployment as user '$APP_USER' (see scripts/root/setup.sh output)."
