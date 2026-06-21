#!/usr/bin/env bash
# Create the unprivileged app user and grant Docker group membership.
source "$(dirname "$0")/../lib/common.sh"

require_root

if id "$APP_USER" >/dev/null 2>&1; then
  log_ok "User '$APP_USER' already exists"
else
  useradd --create-home --shell /bin/bash "$APP_USER"
  log_ok "Created user '$APP_USER'"
fi

if getent group docker >/dev/null 2>&1; then
  log_ok "Group 'docker' already exists"
else
  groupadd docker
  log_ok "Created group 'docker'"
fi

if id -nG "$APP_USER" | grep -qw docker; then
  log_ok "User '$APP_USER' is already in group 'docker'"
else
  usermod -aG docker "$APP_USER"
  log_ok "Added '$APP_USER' to group 'docker'"
fi

log_warn "Group membership takes effect after logout/login or: newgrp docker"
log_info "Next step: run scripts/root/setup-dirs.sh (or continue with scripts/root/setup.sh)"
