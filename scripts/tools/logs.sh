#!/usr/bin/env bash
# Follow container logs (optional service names; -h/--help: docker compose logs flags).
source "$(dirname "$0")/../lib/common.sh"

compose logs -f --tail="${TAIL:-200}" "$@"
