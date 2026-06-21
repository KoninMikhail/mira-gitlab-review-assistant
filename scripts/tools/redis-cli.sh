#!/usr/bin/env bash
# Open redis-cli in the redis container (-h/--help: redis-cli flags passthrough).
source "$(dirname "$0")/../lib/common.sh"

compose exec redis redis-cli "$@"
