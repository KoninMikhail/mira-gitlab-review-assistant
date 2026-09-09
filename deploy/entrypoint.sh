#!/bin/sh
# Container entrypoint. The process role is chosen by the ROLE env var
# (api|worker|poller|all, default all) and handled inside the app.
set -eu

echo "Starting mira (ROLE=${ROLE:-all})"
exec node dist/entrypoints/main.js
