#!/usr/bin/env bash
set -euo pipefail

if [[ $# -lt 1 ]]; then
  echo "Usage: sudo bash deploy/vps/bootstrap-ubuntu-docker.sh /path/to/ncaabsb-vps-bundle.zip [app_user]"
  exit 1
fi

ZIP_PATH="$1"
APP_USER="${2:-${SUDO_USER:-ncaabsb}}"
APP_GROUP="$APP_USER"
APP_DIR="/opt/ncaabsb"
RELEASES_DIR="$APP_DIR/releases"
TIMESTAMP="$(date +%Y%m%d%H%M%S)"
RELEASE_DIR="$RELEASES_DIR/$TIMESTAMP"

if [[ ! -f "$ZIP_PATH" ]]; then
  echo "Bundle not found: $ZIP_PATH"
  exit 1
fi

if [[ "$EUID" -ne 0 ]]; then
  echo "Run this script with sudo/root."
  exit 1
fi

export DEBIAN_FRONTEND=noninteractive
apt-get update -y
apt-get install -y ca-certificates curl gnupg unzip

if ! command -v docker >/dev/null 2>&1; then
  install -m 0755 -d /etc/apt/keyrings
  curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
  chmod a+r /etc/apt/keyrings/docker.asc

  . /etc/os-release
  echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu ${VERSION_CODENAME} stable" > /etc/apt/sources.list.d/docker.list

  apt-get update -y
  apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
fi

systemctl enable docker
systemctl start docker

if ! id -u "$APP_USER" >/dev/null 2>&1; then
  useradd --system --create-home --shell /bin/bash "$APP_USER"
fi

usermod -aG docker "$APP_USER"

mkdir -p "$RELEASES_DIR"
mkdir -p "$APP_DIR/shared/data/tmp/x-feed"
unzip -q "$ZIP_PATH" -d "$RELEASE_DIR"

# Persist shared data directory across releases.
rm -rf "$RELEASE_DIR/data"
mkdir -p "$APP_DIR/shared/data"
ln -s "$APP_DIR/shared/data" "$RELEASE_DIR/data"

chown -R "$APP_USER:$APP_GROUP" "$APP_DIR"

ln -sfn "$RELEASE_DIR" "$APP_DIR/current"

if [[ ! -f "$APP_DIR/current/.env" ]]; then
  cp "$APP_DIR/current/.env.example" "$APP_DIR/current/.env"
  chown "$APP_USER:$APP_GROUP" "$APP_DIR/current/.env"
  echo "Created $APP_DIR/current/.env from .env.example. Fill in credentials before starting live posting."
fi

cd "$APP_DIR/current"
docker compose up -d --build

echo "Docker bootstrap complete."
echo "Compose project: $APP_DIR/current/docker-compose.yml"
echo "Container status: docker compose ps"
echo "Logs: docker compose logs -f usmbsb-x-daemon"
