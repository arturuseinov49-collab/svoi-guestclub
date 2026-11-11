#!/usr/bin/env bash
set -euo pipefail
DOMAIN="${1:?Usage: install.sh DOMAIN RELEASE_DIRECTORY}"
RELEASE="${2:?Release directory required}"
[[ "$DOMAIN" =~ ^[a-zA-Z0-9.-]+$ ]] || { echo 'Invalid domain'; exit 1; }
[[ "$RELEASE" =~ ^/opt/svoi/releases/[a-zA-Z0-9._-]+$ ]] || { echo 'Unexpected release directory'; exit 1; }
test -f "$RELEASE/dist/index.html"
test -f "$RELEASE/server/index.mjs"
test -f "$RELEASE/bot/index.mjs"
if [ "$(id -u)" -ne 0 ]; then echo 'Run as root'; exit 1; fi
apt-get update
DEBIAN_FRONTEND=noninteractive apt-get install -y nodejs caddy ca-certificates curl python3
node -e "if (Number(process.versions.node.split('.')[0]) < 22) process.exit(1)" || { echo 'Node.js 22 or newer is required'; exit 1; }
id svoi >/dev/null 2>&1 || useradd --system --home-dir /var/lib/svoi --create-home --shell /usr/sbin/nologin svoi
install -d -m 0750 -o root -g svoi /etc/svoi
install -d -m 0755 /etc/caddy/conf.d
install -d -m 0750 -o svoi -g svoi /var/lib/svoi
if [ ! -e /etc/svoi/svoi.env ]; then
  printf 'PORT=8081\nHOST=127.0.0.1\nPUBLIC_APP_URL=https://%s\nTELEGRAM_BOT_TOKEN=\n' "$DOMAIN" > /etc/svoi/svoi.env
  chmod 0600 /etc/svoi/svoi.env
fi
grep -q '^DATABASE_PATH=' /etc/svoi/svoi.env || printf 'DATABASE_PATH=/var/lib/svoi/svoi.sqlite\n' >> /etc/svoi/svoi.env
ln -sfn "$RELEASE" /opt/svoi/current
cat > /etc/systemd/system/svoi-web.service <<'UNIT'
[Unit]
Description=Svoi Telegram Mini App
After=network-online.target
Wants=network-online.target
[Service]
Type=simple
User=svoi
Group=svoi
WorkingDirectory=/opt/svoi/current
EnvironmentFile=/etc/svoi/svoi.env
ExecStart=/usr/bin/node /opt/svoi/current/server/index.mjs
Restart=on-failure
RestartSec=5
NoNewPrivileges=true
PrivateTmp=true
ProtectHome=true
ProtectSystem=strict
ReadWritePaths=/var/lib/svoi
UMask=0077
[Install]
WantedBy=multi-user.target
UNIT
cat > /etc/systemd/system/svoi-backup.service <<'UNIT'
[Unit]
Description=Svoi daily verified SQLite backup
[Service]
Type=oneshot
ExecStart=/usr/bin/python3 /opt/svoi/current/deploy/backup.py
User=root
UMask=0077
NoNewPrivileges=true
ProtectSystem=strict
ReadWritePaths=/var/lib/svoi
ProtectHome=true
PrivateTmp=true
UNIT
cat > /etc/systemd/system/svoi-backup.timer <<'UNIT'
[Unit]
Description=Svoi daily database backup
[Timer]
OnCalendar=*-*-* 03:20:00 UTC
RandomizedDelaySec=300
Persistent=true
[Install]
WantedBy=timers.target
UNIT
cat > /etc/systemd/system/svoi-bot.service <<'UNIT'
[Unit]
Description=Svoi Telegram Bot
After=network-online.target
Wants=network-online.target
[Service]
Type=simple
User=svoi
Group=svoi
WorkingDirectory=/var/lib/svoi
EnvironmentFile=/etc/svoi/svoi.env
ExecStart=/usr/bin/node /opt/svoi/current/bot/index.mjs
Restart=on-failure
RestartSec=10
NoNewPrivileges=true
PrivateTmp=true
ProtectHome=true
ProtectSystem=strict
ReadWritePaths=/var/lib/svoi
[Install]
WantedBy=multi-user.target
UNIT
printf '%s {\n  encode zstd gzip\n  reverse_proxy 127.0.0.1:8081\n}\n' "$DOMAIN" > /etc/caddy/conf.d/svoi.caddy
grep -qF 'import /etc/caddy/conf.d/*.caddy' /etc/caddy/Caddyfile || printf '\nimport /etc/caddy/conf.d/*.caddy\n' >> /etc/caddy/Caddyfile
caddy validate --config /etc/caddy/Caddyfile
systemctl daemon-reload
systemctl enable --now svoi-web
systemctl restart svoi-web
systemctl enable --now svoi-backup.timer
systemctl enable --now caddy
systemctl reload caddy
curl --fail --silent http://127.0.0.1:8081/api/health
printf '\nWeb deployed. Bot is intentionally not started until its token is configured.\n'
