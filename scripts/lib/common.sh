#!/usr/bin/env bash
# Shared helpers and conventions for every script under scripts/.
# Source it from any script:  . "$(dirname "$0")/../lib/common.sh"
#
# It is intentionally dependency-light (bash + coreutils) so it runs on a fresh
# Ubuntu Server before Docker or anything else is installed.

set -euo pipefail

# ── Paths ────────────────────────────────────────────────────────────────────
# Resolve the repository root from this file's location (scripts/lib/common.sh),
# independent of the caller's working directory.
_MIRA_LIB_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SCRIPTS_DIR="$(dirname "$_MIRA_LIB_DIR")"
REPO_ROOT="$(dirname "$SCRIPTS_DIR")"
export REPO_ROOT SCRIPTS_DIR

# ── Tunable conventions (override via environment if needed) ─────────────────
# OS user that owns and runs the application containers.
APP_USER="${MIRA_APP_USER:-mira}"
# Host root for all persistent bind-mount data (created by the root setup).
MIRA_BASE="${MIRA_BASE:-/opt/mira}"
export APP_USER MIRA_BASE

# Persistent data sub-directories (bind-mounted into containers).
MIRA_PG_DIR="$MIRA_BASE/data/postgres"     # Postgres data dir
MIRA_REDIS_DIR="$MIRA_BASE/data/redis"      # Redis AOF/RDB
MIRA_WORK_DIR="$MIRA_BASE/work"             # ephemeral MR checkouts (WORKSPACE_ROOT)
MIRA_CACHE_DIR="$MIRA_BASE/cache/mirrors"   # git mirror cache (MIRA_CHECKOUT=mirror)
MIRA_CONFIG_DIR="$MIRA_BASE/config"         # policy config.yml lives here
MIRA_BACKUP_DIR="$MIRA_BASE/backups"        # pg_dump output
export MIRA_PG_DIR MIRA_REDIS_DIR MIRA_WORK_DIR MIRA_CACHE_DIR MIRA_CONFIG_DIR MIRA_BACKUP_DIR

# Compose project + files (single source of truth for every script/tool).
COMPOSE_PROJECT="${COMPOSE_PROJECT:-mira}"
COMPOSE_FILE="$REPO_ROOT/deploy/docker-compose.prod.yml"
ENV_FILE="$REPO_ROOT/deploy/.env"
export COMPOSE_PROJECT COMPOSE_FILE ENV_FILE

# ── Logging ──────────────────────────────────────────────────────────────────
if [ -t 1 ] && [ -z "${NO_COLOR:-}" ]; then
  _C_RESET="$(printf '\033[0m')"; _C_RED="$(printf '\033[31m')"
  _C_GRN="$(printf '\033[32m')"; _C_YEL="$(printf '\033[33m')"
  _C_BLU="$(printf '\033[34m')"
else
  _C_RESET=""; _C_RED=""; _C_GRN=""; _C_YEL=""; _C_BLU=""
fi

log_info() { printf '%s[mira]%s %s\n' "$_C_BLU" "$_C_RESET" "$*"; }
log_ok()   { printf '%s[ ok ]%s %s\n' "$_C_GRN" "$_C_RESET" "$*"; }
log_warn() { printf '%s[warn]%s %s\n' "$_C_YEL" "$_C_RESET" "$*" >&2; }
log_error(){ printf '%s[fail]%s %s\n' "$_C_RED" "$_C_RESET" "$*" >&2; }
die()      { log_error "$*"; exit 1; }

# ── Guards ───────────────────────────────────────────────────────────────────
require_root() {
  [ "$(id -u)" -eq 0 ] || die "This script must run as root (use sudo). See scripts/root/."
}

require_not_root() {
  [ "$(id -u)" -ne 0 ] || die "Do not run this as root. Run as the '$APP_USER' user. See scripts/README.md."
}

require_cmd() {
  command -v "$1" >/dev/null 2>&1 || die "Required command not found: $1"
}

confirm() {
  # confirm "Question?"  -> returns 0 on yes. Auto-yes when MIRA_YES=1.
  [ "${MIRA_YES:-0}" = "1" ] && return 0
  local reply
  read -r -p "$1 [y/N] " reply
  case "$reply" in [yY] | [yY][eE][sS]) return 0 ;; *) return 1 ;; esac
}

# ── Docker Compose wrapper ───────────────────────────────────────────────────
# Always targets the production compose file + deploy/.env, from any CWD.
compose() {
  require_cmd docker
  docker compose \
    -p "$COMPOSE_PROJECT" \
    -f "$COMPOSE_FILE" \
    --env-file "$ENV_FILE" \
    "$@"
}

# ── .env handling ────────────────────────────────────────────────────────────
# Load deploy/.env into the current shell (KEY=VALUE lines). Safe loader: ignores
# comments/blank lines, does not execute arbitrary code.
load_env() {
  [ -f "$ENV_FILE" ] || die "Env file not found: $ENV_FILE (run scripts/app/gen-secrets.sh first)."
  set -a
  # shellcheck disable=SC1090
  . "$ENV_FILE"
  set +a
}

# Read a single value from deploy/.env without polluting the environment.
env_get() {
  [ -f "$ENV_FILE" ] || return 1
  sed -n "s/^$1=//p" "$ENV_FILE" | tail -n1
}

# URL-safe random secret (no @ : / + = so it can sit inside redis:// / postgres:// URLs).
gen_password() {
  require_cmd openssl
  openssl rand -base64 48 | tr -d '/+=\n' | cut -c1-40
}
