#!/usr/bin/env bash
# Open psql in the postgres container (-h/--help: psql flags passthrough).
source "$(dirname "$0")/../lib/common.sh"

load_env

compose exec -e PGPASSWORD="$POSTGRES_PASSWORD" postgres \
  psql -U "${POSTGRES_USER:-mira}" -d "${POSTGRES_DB:-mira}" "$@"
