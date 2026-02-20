#!/usr/bin/env bash
set -euo pipefail

if [[ $# -lt 1 ]]; then
  echo "Usage: sudo bash deploy/vps/update-release-docker.sh /path/to/ncaabsb-vps-bundle.zip [app_user]"
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

mkdir -p "$RELEASES_DIR"
unzip -q "$ZIP_PATH" -d "$RELEASE_DIR"

# Keep persistent data directory.
rm -rf "$RELEASE_DIR/data"
mkdir -p "$APP_DIR/shared/data"
ln -s "$APP_DIR/shared/data" "$RELEASE_DIR/data"

if [[ -f "$APP_DIR/current/.env" ]]; then
  cp "$APP_DIR/current/.env" "$RELEASE_DIR/.env"
fi

chown -R "$APP_USER:$APP_GROUP" "$APP_DIR"
ln -sfn "$RELEASE_DIR" "$APP_DIR/current"

cd "$APP_DIR/current"
docker compose up -d --build

echo "Docker update complete."
echo "Container status: docker compose ps"
