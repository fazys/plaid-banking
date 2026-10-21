#!/usr/bin/env bash
# Automatic deploy: checks GitHub for a new commit on the production branch and,
# if there is one, updates /opt/plaid, rebuilds the dashboard and restarts the app.
# Runs every minute from the plaid-auto-deploy systemd timer (see install-auto-deploy.sh).
# .env, google-service-account.json and data/ are not in git, so they are never touched.
set -euo pipefail

APP_DIR="${APP_DIR:-/opt/plaid}"
BRANCH="${DEPLOY_BRANCH:-production}"
SERVICE="${SERVICE_NAME:-plaid}"
APP_USER="${APP_USER:-plaid}"

cd "$APP_DIR"
git_() { git -c safe.directory="$APP_DIR" -C "$APP_DIR" "$@"; }

git_ fetch --quiet origin "$BRANCH"
current="$(git_ rev-parse HEAD)"
latest="$(git_ rev-parse "origin/$BRANCH")"

if [[ "$current" == "$latest" ]]; then
  exit 0
fi

echo "New $BRANCH commit: $(git_ log -1 --format='%h %s' "$latest")"
changed="$(git_ diff --name-only "$current" "$latest" || true)"

git_ checkout --quiet -B "$BRANCH" "origin/$BRANCH"
git_ reset --quiet --hard "origin/$BRANCH"

if [[ ! -d node_modules ]] || grep -qE '(^|/)package(-lock)?\.json$' <<<"$changed"; then
  echo "Installing npm packages..."
  npm ci --no-audit --no-fund
fi

echo "Building the dashboard..."
npm run build

chown -R "$APP_USER:$APP_USER" "$APP_DIR"
systemctl restart "$SERVICE"

sleep 3
if systemctl is-active --quiet "$SERVICE"; then
  echo "Deployed $(git_ log -1 --format='%h %s')"
else
  echo "Deploy finished but $SERVICE is not running. Check: journalctl -u $SERVICE -n 50"
  exit 1
fi
