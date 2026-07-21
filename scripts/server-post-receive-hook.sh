#!/usr/bin/env bash
set -euo pipefail

APP_DIR="${APP_DIR:-/srv/vaysen-ai-crm}"
GIT_WORK_TREE="$APP_DIR"
LOG_DIR="${LOG_DIR:-/var/log/vaysen-ai-crm}"
BRANCH="${DEPLOY_BRANCH:-main}"

mkdir -p "$APP_DIR" "$LOG_DIR"
LOG_FILE="$LOG_DIR/deploy-$(date +%Y%m%d-%H%M%S).log"

while read -r oldrev newrev refname; do
  if [ "$refname" != "refs/heads/$BRANCH" ]; then
    echo "Ignoring $refname; deploy branch is $BRANCH" | tee -a "$LOG_FILE"
    continue
  fi

  {
    echo "Deploying $newrev to $APP_DIR"
    git --work-tree="$GIT_WORK_TREE" --git-dir="$(pwd)" checkout -f "$BRANCH"
    cd "$APP_DIR"

    npm install
    npm run db:generate
    npm run build
    (cd backend && npm run prisma:deploy)

    if command -v pm2 >/dev/null 2>&1; then
      pm2 reload ecosystem.config.js --update-env || pm2 start ecosystem.config.js
      pm2 save || true
    elif command -v systemctl >/dev/null 2>&1; then
      sudo systemctl restart vaysen-crm-api vaysen-crm-frontend vaysen-crm-workers || true
    else
      echo "No pm2/systemd detected. Build finished; restart services manually."
    fi

    echo "Deploy completed at $(date)"
  } 2>&1 | tee -a "$LOG_FILE"
done
