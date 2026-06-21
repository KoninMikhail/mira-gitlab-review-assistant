#!/usr/bin/env bash
# Install an SSH public key into the app user's authorized_keys (run as root).
#
# Usage (any of):
#   sudo scripts/root/add-ssh-key.sh ~/keys/id_ed25519.pub      # from a .pub file
#   sudo scripts/root/add-ssh-key.sh "ssh-ed25519 AAAA... me"   # inline key
#   cat id_ed25519.pub | sudo scripts/root/add-ssh-key.sh       # from stdin
#
# Idempotent: re-adding the same key is a no-op. Fixes ownership/permissions.
source "$(dirname "$0")/../lib/common.sh"

require_root

if [ "${1:-}" = "-h" ] || [ "${1:-}" = "--help" ]; then
  sed -n '2,11p' "$0" | sed 's/^# \{0,1\}//'
  exit 0
fi

id "$APP_USER" >/dev/null 2>&1 \
  || die "App user '$APP_USER' does not exist — run scripts/root/create-app-user.sh first."

# Resolve the public key: file arg -> inline args -> stdin.
if [ "$#" -ge 1 ] && [ -f "$1" ]; then
  key="$(cat "$1")"
elif [ "$#" -ge 1 ]; then
  key="$*"
else
  log_info "Paste the public key, then Ctrl-D:"
  key="$(cat)"
fi

key="$(printf '%s' "$key" | tr -d '\r' | sed 's/^[[:space:]]*//; s/[[:space:]]*$//')"
[ -n "$key" ] || die "No key provided."

case "$key" in
  ssh-* | ecdsa-* | sk-*) : ;;
  *) die "This does not look like an SSH public key (expected ssh-* / ecdsa-* / sk-*). Did you pass a PRIVATE key by mistake?" ;;
esac

home="$(getent passwd "$APP_USER" | cut -d: -f6)"
[ -n "$home" ] && [ -d "$home" ] || die "Could not resolve home directory for '$APP_USER'."

ssh_dir="$home/.ssh"
auth="$ssh_dir/authorized_keys"

mkdir -p "$ssh_dir"
touch "$auth"

if grep -qxF "$key" "$auth" 2>/dev/null; then
  log_ok "Key already present in $auth — nothing to do."
else
  printf '%s\n' "$key" >>"$auth"
  log_ok "Added key to $auth."
fi

chown -R "$APP_USER":"$APP_USER" "$ssh_dir"
chmod 700 "$ssh_dir"
chmod 600 "$auth"
log_ok "Fixed ownership ($APP_USER) and permissions (700 .ssh / 600 authorized_keys)."

log_info "Now test from your machine:  ssh $APP_USER@<server>"
log_warn "If login is refused: ensure sshd has PubkeyAuthentication yes, and that"
log_warn "AllowUsers/AllowGroups (if set in /etc/ssh/sshd_config) includes '$APP_USER'."
