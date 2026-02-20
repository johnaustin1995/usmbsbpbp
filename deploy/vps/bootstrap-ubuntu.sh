#!/usr/bin/env bash
set -euo pipefail

if [[ $# -lt 1 ]]; then
  echo "Usage: sudo bash deploy/vps/bootstrap-ubuntu.sh /path/to/ncaabsb-vps-bundle.zip [app_user]"
  exit 1
fi

ZIP_PATH="$1"
APP_USER="${2:-${SUDO_USER:-ncaabsb}}"
APP_GROUP="$APP_USER"
APP_DIR="/opt/ncaabsb"
RELEASES_DIR="$APP_DIR/releases"
SERVICE_NAME="usmbsb-x-daemon"
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
apt-get install -y curl unzip ca-certificates gnupg

if ! command -v node >/dev/null 2>&1; then
  curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
  apt-get install -y nodejs
else
  NODE_MAJOR="$(node -v | sed -E 's/^v([0-9]+).*/\1/')"
  if [[ "$NODE_MAJOR" -lt 20 ]]; then
    curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
    apt-get install -y nodejs
  fi
fi

if ! id -u "$APP_USER" >/dev/null 2>&1; then
  useradd --system --create-home --shell /bin/bash "$APP_USER"
fi

mkdir -p "$RELEASES_DIR"
mkdir -p "$APP_DIR/shared/data/tmp/x-feed"
unzip -q "$ZIP_PATH" -d "$RELEASE_DIR"

chown -R "$APP_USER:$APP_GROUP" "$APP_DIR"

sudo -u "$APP_USER" npm ci --omit=dev --prefix "$RELEASE_DIR"

ln -sfn "$RELEASE_DIR" "$APP_DIR/current"

if [[ ! -f "$APP_DIR/current/.env" ]]; then
  cp "$APP_DIR/current/.env.example" "$APP_DIR/current/.env"
  chown "$APP_USER:$APP_GROUP" "$APP_DIR/current/.env"
  echo "Created $APP_DIR/current/.env from .env.example. Fill in credentials before starting live posting."
fi

cat > "/etc/systemd/system/${SERVICE_NAME}.service" <<UNIT
[Unit]
Description=Southern Miss Baseball X Daemon
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=${APP_USER}
Group=${APP_GROUP}
WorkingDirectory=${APP_DIR}/current
ExecStart=/usr/bin/node dist/tools/x-southern-miss-daemon.js
Restart=always
RestartSec=10

[Install]
WantedBy=multi-user.target
UNIT

systemctl daemon-reload
systemctl enable "$SERVICE_NAME"
systemctl restart "$SERVICE_NAME"

echo "Bootstrap complete."
echo "Service: $SERVICE_NAME"
echo "Status: systemctl status $SERVICE_NAME"
echo "Logs: journalctl -u $SERVICE_NAME -f"
