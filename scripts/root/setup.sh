#!/usr/bin/env bash
# One-shot root orchestrator: Docker, app user, and data directories.
source "$(dirname "$0")/../lib/common.sh"

require_root

log_info "Running host bootstrap for Mira Review Bot (root phase)…"

bash "$SCRIPTS_DIR/root/install-docker.sh"
bash "$SCRIPTS_DIR/root/create-app-user.sh"
bash "$SCRIPTS_DIR/root/setup-dirs.sh"

log_ok "Root host setup complete."

cat <<EOF

Next steps
──────────
1. Switch to the app user:
     sudo -iu $APP_USER

2. Clone (or enter) the repository, e.g.:
     git clone <repo-url> ~/mira-review-bot && cd ~/mira-review-bot

3. Generate secrets:
     scripts/app/gen-secrets.sh

4. Edit deploy/.env and fill in GitLab, Kaiten, Cursor, and other secrets.

5. Start the stack:
     scripts/app/up.sh

Optional: inbound firewall hardening (run as root):
     sudo scripts/root/firewall.sh [PORT] [SOURCE_CIDR]
  Default PORT is 8080; omit SOURCE_CIDR to keep health/webhook on loopback only.

EOF
