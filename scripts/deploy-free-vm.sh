#!/usr/bin/env bash
set -euo pipefail

TARGET="${1:-}"
DOMAIN="${2:-}"

if [ -z "$TARGET" ]; then
  echo "Usage: ADMIN_PASSWORD='strong-password' $0 user@host [domain]"
  exit 1
fi

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
GAME_SRC="${GAME_SRC:-$(cd "$ROOT/../trick-brick" && pwd)}"
APP_DIR="${APP_DIR:-/opt/trick-brick-server}"
REMOTE_GAME_DIR="${REMOTE_GAME_DIR:-/opt/trick-brick}"
PORT="${PORT:-3000}"

if [ ! -d "$GAME_SRC" ]; then
  echo "Game directory not found: $GAME_SRC"
  exit 1
fi

random_hex() {
  openssl rand -hex 32
}

random_password() {
  openssl rand -base64 18 | tr -d '\n'
}

ADMIN_PASSWORD="${ADMIN_PASSWORD:-$(random_password)}"
JWT_SECRET="${JWT_SECRET:-$(random_hex)}"
IP_SALT="${IP_SALT:-$(random_hex)}"

HOST="${TARGET#*@}"
if [ -z "$DOMAIN" ] && [[ "$HOST" =~ ^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  DOMAIN="$HOST.sslip.io"
fi

UPLOAD_DIR="trick-brick-upload-$(date +%s)"

ssh "$TARGET" "mkdir -p ~/$UPLOAD_DIR/server ~/$UPLOAD_DIR/game"
rsync -az --delete \
  --exclude node_modules \
  --exclude data \
  --exclude .env \
  "$ROOT/" "$TARGET:~/$UPLOAD_DIR/server/"
rsync -az --delete \
  --exclude .git \
  "$GAME_SRC/" "$TARGET:~/$UPLOAD_DIR/game/"

ssh "$TARGET" bash -s -- \
  "$UPLOAD_DIR" "$APP_DIR" "$REMOTE_GAME_DIR" "$PORT" \
  "$ADMIN_PASSWORD" "$JWT_SECRET" "$IP_SALT" "$DOMAIN" <<'REMOTE'
set -euo pipefail

UPLOAD_DIR="$1"
APP_DIR="$2"
REMOTE_GAME_DIR="$3"
PORT="$4"
ADMIN_PASSWORD="$5"
JWT_SECRET="$6"
IP_SALT="$7"
DOMAIN="$8"

if command -v apt-get >/dev/null 2>&1; then
  sudo apt-get update
  sudo apt-get install -y ca-certificates curl rsync build-essential python3
fi

if ! command -v node >/dev/null 2>&1 || ! node -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 20 ? 0 : 1)'; then
  curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
  sudo apt-get install -y nodejs
fi

sudo mkdir -p "$APP_DIR" "$REMOTE_GAME_DIR" "$APP_DIR/data"
sudo rsync -a --delete --exclude data "$HOME/$UPLOAD_DIR/server/" "$APP_DIR/"
sudo rsync -a --delete "$HOME/$UPLOAD_DIR/game/" "$REMOTE_GAME_DIR/"
sudo chown -R "$USER:$USER" "$APP_DIR" "$REMOTE_GAME_DIR"

cd "$APP_DIR"
npm ci --omit=dev

cat > "$APP_DIR/.env" <<ENV
NODE_ENV=production
PORT=$PORT
DATA_DIR=$APP_DIR/data
GAME_DIR=$REMOTE_GAME_DIR
ADMIN_PASSWORD=$ADMIN_PASSWORD
JWT_SECRET=$JWT_SECRET
IP_SALT=$IP_SALT
CORS_ORIGIN=
ENV
chmod 600 "$APP_DIR/.env"

NPM_BIN="$(command -v npm)"
sudo tee /etc/systemd/system/trick-brick-server.service >/dev/null <<SERVICE
[Unit]
Description=trick-brick-server
After=network.target

[Service]
Type=simple
User=$USER
WorkingDirectory=$APP_DIR
ExecStart=$NPM_BIN start
Restart=always
RestartSec=3
Environment=NODE_ENV=production

[Install]
WantedBy=multi-user.target
SERVICE

sudo systemctl daemon-reload
sudo systemctl enable --now trick-brick-server

if [ -n "$DOMAIN" ] && command -v apt-get >/dev/null 2>&1; then
  if ! command -v caddy >/dev/null 2>&1; then
    sudo apt-get install -y debian-keyring debian-archive-keyring apt-transport-https gnupg
    sudo rm -f /usr/share/keyrings/caddy-stable-archive-keyring.gpg
    curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' \
      | sudo gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
    curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' \
      | sudo tee /etc/apt/sources.list.d/caddy-stable.list >/dev/null
    sudo apt-get update
    sudo apt-get install -y caddy
  fi

  sudo tee /etc/caddy/Caddyfile >/dev/null <<CADDY
$DOMAIN {
  reverse_proxy 127.0.0.1:$PORT
}
CADDY
  sudo systemctl reload caddy || sudo systemctl restart caddy
fi

rm -rf "$HOME/$UPLOAD_DIR"
REMOTE

if [ -n "$DOMAIN" ]; then
  echo "Deployed: https://$DOMAIN/game/"
  echo "Admin:    https://$DOMAIN/admin/"
  echo "API:      https://$DOMAIN/api/levels/config"
else
  echo "Deployed on $TARGET:$PORT"
  echo "Set up HTTPS before using it from a GitHub Pages game."
fi

echo "Admin password: $ADMIN_PASSWORD"
