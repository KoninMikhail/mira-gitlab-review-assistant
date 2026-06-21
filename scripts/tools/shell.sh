#!/usr/bin/env bash
# Open an interactive shell in a service (default: worker; usage: shell.sh [service]).
source "$(dirname "$0")/../lib/common.sh"

svc="${1:-worker}"
if [ $# -gt 0 ]; then
  shift
fi

log_info "Opening shell in ${svc}…"
if compose exec "$svc" test -x /bin/bash; then
  compose exec "$svc" /bin/bash "$@"
else
  compose exec "$svc" /bin/sh "$@"
fi
