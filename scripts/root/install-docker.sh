#!/usr/bin/env bash
# Install Docker Engine and Compose plugin from Docker's official apt repo.
source "$(dirname "$0")/../lib/common.sh"

require_root

if docker compose version >/dev/null 2>&1; then
  log_ok "Docker Engine and Compose plugin already installed"
  docker --version
  docker compose version
  log_info "Next step: run scripts/root/create-app-user.sh (or scripts/root/setup.sh)"
  exit 0
fi

log_info "Installing Docker Engine and Compose plugin from Docker's official apt repository…"

require_cmd apt-get

export DEBIAN_FRONTEND=noninteractive

apt-get update
apt-get install -y ca-certificates curl gnupg

install -m 0755 -d /etc/apt/keyrings
curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
chmod a+r /etc/apt/keyrings/docker.asc

arch="$(dpkg --print-architecture)"
codename="$(. /etc/os-release && echo "$VERSION_CODENAME")"

cat > /etc/apt/sources.list.d/docker.list <<EOF
deb [arch=${arch} signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu ${codename} stable
EOF

apt-get update
apt-get install -y \
  docker-ce \
  docker-ce-cli \
  containerd.io \
  docker-buildx-plugin \
  docker-compose-plugin

systemctl enable --now docker

log_ok "Docker installed and service enabled"
docker --version
docker compose version

log_info "Next step: run scripts/root/create-app-user.sh (or continue with scripts/root/setup.sh)"
