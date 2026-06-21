#!/usr/bin/env bash
# Start the full Mira Review Bot production stack.
source "$(dirname "$0")/../lib/common.sh"

require_not_root

load_env

missing=()
for key in CURSOR_API_KEY GITLAB_BASE_URL GITLAB_TOKEN KAITEN_BASE_URL KAITEN_TOKEN; do
  val="$(env_get "$key" 2>/dev/null || true)"
  if [ -z "$val" ]; then
    missing+=("$key")
  fi
done

if [ "${#missing[@]}" -gt 0 ]; then
  die "Required secrets are empty in $ENV_FILE: ${missing[*]}. Run scripts/app/gen-secrets.sh, then edit deploy/.env."
fi

config_file="$MIRA_CONFIG_DIR/config.yml"
if [ ! -f "$config_file" ]; then
  mkdir -p "$MIRA_CONFIG_DIR"
  cp "$REPO_ROOT/deploy/config.example.yml" "$config_file"
  log_warn "Created $config_file from deploy/config.example.yml — edit it with real pilot projects before relying on reviews."
fi

WORKERS="${1:-${MIRA_WORKERS:-2}}"
if ! [[ "$WORKERS" =~ ^[1-9][0-9]*$ ]]; then
  die "Worker count must be a positive integer, got: ${WORKERS}"
fi

log_info "Starting stack with ${WORKERS} worker(s)…"
compose up -d --build --scale worker="$WORKERS"
compose ps

log_ok "Stack is up."

cat <<EOF

Next steps
──────────
Check health:  scripts/tools/health.sh
View logs:     scripts/tools/logs.sh

EOF
