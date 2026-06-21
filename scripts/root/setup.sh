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

Optional: baseline host firewall hardening (run as root):
     sudo scripts/root/firewall.sh
  Default-deny inbound + allow SSH. Note: ufw does NOT filter Docker-published
  ports; our stack publishes nothing externally (api binds to 127.0.0.1).

EOF
