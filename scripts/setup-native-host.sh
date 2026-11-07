#!/usr/bin/env bash
# Usage: sudo bash scripts/setup-native-host.sh api|worker
set -Eeuo pipefail
ROLE=${1:-}
[[ $ROLE == api || $ROLE == worker ]] || { echo 'Usage: setup-native-host.sh api|worker'; exit 1; }
[[ $EUID == 0 ]] || { echo 'Run as root'; exit 1; }
apt-get update -y
apt-get install -y ca-certificates curl gnupg nginx python3 python3-pip awscli unzip
curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
apt-get install -y nodejs
id cloudstream >/dev/null 2>&1 || useradd --system --home /opt/cloudstream --shell /usr/sbin/nologin cloudstream
install -d -o cloudstream -g cloudstream -m 0755 /opt/cloudstream
install -d -m 0700 /etc/cloudstream
if [[ $ROLE == api ]]; then
  apt-get install -y guacd libguac-client-vnc0t64
  install -d /etc/systemd/system/guacd.service.d
  cat >/etc/systemd/system/guacd.service.d/cloudstream-loopback.conf <<'GUAC'
[Service]
Type=simple
ExecStart=
ExecStart=/usr/sbin/guacd -f -b 127.0.0.1 -l 4822
GUAC
  systemctl daemon-reload
  systemctl enable --now guacd
  systemctl restart guacd
  cat >/etc/systemd/system/cloudstream-api.service <<'UNIT'
[Unit]
Description=CloudStream native API and Guacamole gateway
After=network-online.target
Wants=network-online.target
[Service]
Type=simple
User=cloudstream
Group=cloudstream
WorkingDirectory=/opt/cloudstream/backend
EnvironmentFile=/etc/cloudstream/backend.env
ExecStart=/usr/bin/node dist/server.js
Restart=always
RestartSec=5
NoNewPrivileges=true
ProtectSystem=strict
ReadWritePaths=/opt/cloudstream
[Install]
WantedBy=multi-user.target
UNIT
else
  apt-get install -y clamav clamav-freshclam
  systemctl stop clamav-freshclam || true
  freshclam || true
  systemctl enable --now clamav-freshclam
  cat >/etc/systemd/system/cloudstream-worker.service <<'UNIT'
[Unit]
Description=CloudStream asynchronous EC2 provisioning and malware scanner
After=network-online.target
Wants=network-online.target
[Service]
Type=simple
User=cloudstream
Group=cloudstream
WorkingDirectory=/opt/cloudstream/backend
EnvironmentFile=/etc/cloudstream/backend.env
ExecStart=/usr/bin/node dist/workers/worker.js
Restart=always
RestartSec=5
NoNewPrivileges=true
ProtectSystem=strict
ReadWritePaths=/tmp /opt/cloudstream
[Install]
WantedBy=multi-user.target
UNIT
fi
systemctl daemon-reload
printf 'Host dependencies installed for %s. Next: place code and /etc/cloudstream/backend.env, npm install && npm run build, then start service.\n' "$ROLE"
