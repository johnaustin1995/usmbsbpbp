#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

npm run build >/dev/null

STAMP="$(date +%Y%m%d-%H%M%S)"
BUNDLE_NAME="ncaabsb-vps-bundle-${STAMP}"
STAGE_DIR="/tmp/${BUNDLE_NAME}"
ZIP_PATH="$ROOT_DIR/artifacts/${BUNDLE_NAME}.zip"

rm -rf "$STAGE_DIR"
mkdir -p "$STAGE_DIR"

cp -R dist "$STAGE_DIR/dist"
cp package.json "$STAGE_DIR/package.json"
cp package-lock.json "$STAGE_DIR/package-lock.json"
cp .env.example "$STAGE_DIR/.env.example"
cp README.md "$STAGE_DIR/README.md"
cp -R deploy "$STAGE_DIR/deploy"
cp Dockerfile "$STAGE_DIR/Dockerfile"
cp docker-compose.yml "$STAGE_DIR/docker-compose.yml"
cp .dockerignore "$STAGE_DIR/.dockerignore"

cd "$STAGE_DIR"
zip -qr "$ZIP_PATH" .

cd "$ROOT_DIR"
rm -rf "$STAGE_DIR"

echo "Created bundle: $ZIP_PATH"
