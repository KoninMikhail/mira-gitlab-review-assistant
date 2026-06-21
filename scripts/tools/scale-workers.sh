#!/usr/bin/env bash
# Scale only the worker service (usage: scale-workers.sh <N>).
source "$(dirname "$0")/../lib/common.sh"

require_not_root

if [ $# -lt 1 ] || [ "$1" = "-h" ] || [ "$1" = "--help" ]; then
  die "Usage: $(basename "$0") <N>  (N = positive integer worker count)"
fi

count="$1"
if ! [[ "$count" =~ ^[1-9][0-9]*$ ]]; then
  die "Worker count must be a positive integer, got: ${count}"
fi

log_info "Scaling worker service to ${count} instance(s)…"
compose up -d --no-recreate --scale worker="$count" worker
compose ps worker

log_ok "Worker scale set to ${count}."
