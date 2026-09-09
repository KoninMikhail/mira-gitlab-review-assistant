#!/bin/sh
# Wrap cursor-agent so only the engine talks to Cursor API via the xray SOCKS
# sidecar. proxychains4 requires a numeric first hop, so resolve `xray` here.
set -eu
IP=$(getent hosts xray | awk '{ print $1; exit }')
if [ -z "${IP}" ]; then
  echo "cursor-agent-via-proxy: cannot resolve xray" >&2
  exit 1
fi
CONF=/tmp/proxychains.mira.conf
sed "s/^socks5[[:space:]]xray[[:space:]]/socks5 ${IP} /" /etc/mira/proxychains.conf >"${CONF}"
exec proxychains4 -q -f "${CONF}" /root/.local/bin/cursor-agent "$@"
