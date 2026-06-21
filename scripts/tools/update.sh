#!/usr/bin/env bash
# Pull latest code (if clean) and redeploy via scripts/app/up.sh (optional worker count arg).
source "$(dirname "$0")/../lib/common.sh"

require_not_root

cd "$REPO_ROOT"

if git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  if git diff --quiet && git diff --cached --quiet; then
    log_info "Pulling latest changes…"
    git pull --ff-only
  else
    log_warn "Working tree is dirty; skipping git pull."
  fi
else
  log_warn "Not a git repository; skipping git pull."
fi

exec bash "$SCRIPTS_DIR/app/up.sh" "$@"
