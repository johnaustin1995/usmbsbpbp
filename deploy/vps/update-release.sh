#!/usr/bin/env bash
set -euo pipefail

if [[ $# -lt 1 ]]; then
  echo "Usage: sudo bash deploy/vps/update-release.sh /path/to/ncaabsb-vps-bundle.zip [app_user]"
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

mkdir -p "$RELEASES_DIR"
unzip -q "$ZIP_PATH" -d "$RELEASE_DIR"

chown -R "$APP_USER:$APP_GROUP" "$APP_DIR"

sudo -u "$APP_USER" npm ci --omit=dev --prefix "$RELEASE_DIR"

if [[ -f "$APP_DIR/current/.env" ]]; then
  cp "$APP_DIR/current/.env" "$RELEASE_DIR/.env"
  chown "$APP_USER:$APP_GROUP" "$RELEASE_DIR/.env"
fi

ln -sfn "$RELEASE_DIR" "$APP_DIR/current"

systemctl restart "$SERVICE_NAME"

echo "Update complete."
echo "Service: $SERVICE_NAME"
echo "Status: systemctl status $SERVICE_NAME"
