#!/usr/bin/env bash
# One-time setup on the server: deploy the production branch automatically.
# Usage (as root, from /opt/plaid):  sudo ./deploy/install-auto-deploy.sh
set -euo pipefail

if [[ "${EUID:-$(id -u)}" -ne 0 ]]; then
  echo "Run as root: sudo ./deploy/install-auto-deploy.sh"
  exit 1
fi

APP_DIR="$(cd "$(dirname "$0")/.." && pwd)"
chmod +x "$APP_DIR/deploy/auto-deploy.sh"

cat > /etc/systemd/system/plaid-auto-deploy.service <<EOF
[Unit]
Description=Deploy new commits from the production branch
After=network-online.target
Wants=network-online.target

[Service]
Type=oneshot
Environment=APP_DIR=$APP_DIR
ExecStart=$APP_DIR/deploy/auto-deploy.sh
EOF

cat > /etc/systemd/system/plaid-auto-deploy.timer <<'EOF'
[Unit]
Description=Check GitHub for production updates every minute

[Timer]
OnActiveSec=1min
OnBootSec=1min
OnUnitActiveSec=1min
AccuracySec=10s

[Install]
WantedBy=timers.target
EOF

systemctl daemon-reload
systemctl enable --now plaid-auto-deploy.timer
echo "Auto-deploy is on. Logs: journalctl -u plaid-auto-deploy -f"
