# VPS Deployment (Ubuntu)

## 1. Build bundle locally

From your local project:

```bash
bash scripts/build-vps-bundle.sh
```

The zip lands in `artifacts/`.

## 2. Upload bundle to VPS

Example:

```bash
scp artifacts/ncaabsb-vps-bundle-*.zip user@your-vps:/tmp/ncaabsb-vps-bundle.zip
```

## 3. Bootstrap VPS (first time)

SSH to VPS and run:

### Option A: Docker (recommended if your VPS already runs Docker)

```bash
sudo bash /path/to/repo/deploy/vps/bootstrap-ubuntu-docker.sh /tmp/ncaabsb-vps-bundle.zip
```

### Option B: Node + systemd (no Docker)

```bash
sudo bash /path/to/repo/deploy/vps/bootstrap-ubuntu.sh /tmp/ncaabsb-vps-bundle.zip
```

Option A installs Docker Engine + Compose plugin (if needed) and starts the `usmbsb-x-daemon` container via `docker compose`.

Option B installs Node 20 and starts systemd service `usmbsb-x-daemon`.

## 4. Add credentials

Edit:

```bash
sudo -u ncaabsb nano /opt/ncaabsb/current/.env
```

Fill:

- `X_API_KEY`
- `X_API_SECRET`
- `X_ACCESS_TOKEN`
- `X_ACCESS_TOKEN_SECRET`
- `X_DAEMON_SCHEDULE_FILE` (recommended): `data/schedules/southern-miss-2026.json`
- `X_FEED_THREAD_MODE`: `none` (standalone posts) or `reply` (thread)
- `X_FEED_FINAL_GRACE_SECONDS`: e.g. `120`

Then restart:

### Docker

```bash
cd /opt/ncaabsb/current
sudo docker compose up -d --build
```

### systemd

```bash
sudo systemctl restart usmbsb-x-daemon
```

## 5. Check status/logs

### Docker

```bash
cd /opt/ncaabsb/current
sudo docker compose ps
sudo docker compose logs -f usmbsb-x-daemon
```

Web UI/API run in container `usmbsb-web` on port `8787`:

```bash
sudo docker compose logs -f usmbsb-web
curl http://localhost:8787/health
```

Southern Miss live frontend URL:

- `http://YOUR_SERVER_IP:8787/usm-live.html`

### systemd

```bash
systemctl status usmbsb-x-daemon
journalctl -u usmbsb-x-daemon -f
```

## Update deployment

Upload a new bundle and run:

### Docker

```bash
sudo bash /opt/ncaabsb/current/deploy/vps/update-release-docker.sh /tmp/ncaabsb-vps-bundle.zip
```

### systemd

```bash
sudo bash /opt/ncaabsb/current/deploy/vps/update-release.sh /tmp/ncaabsb-vps-bundle.zip
```
