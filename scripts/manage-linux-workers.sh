#!/usr/bin/env bash
set -euo pipefail

APP_DIR="${APP_DIR:-/opt/vaysen-ai-crm}"
LOG_DIR="$APP_DIR/logs"
BACKEND_DIR="$APP_DIR/backend"

EMAIL_WORKERS=(
  email-compose
  email-validate
  email-send
  deep-research
  maintenance
)
ALL_WORKERS=(
  "${EMAIL_WORKERS[@]}"
  prospect-search
  continuous-prospect
)

usage() {
  echo "Usage: $0 {status|restart-email|restart-all|stop-email|stop-all}"
}

worker_pattern() {
  local worker="$1"
  printf 'worker-%s' "$worker"
}

kill_workers() {
  local workers=("$@")
  for worker in "${workers[@]}"; do
    local pattern
    pattern="$(worker_pattern "$worker")"
    ps -eo pid,cmd \
      | awk -v pattern="$pattern" '$0 ~ pattern && $0 !~ /awk/ { print $1 }' \
      | sort -u \
      | xargs -r kill -9
  done
}

start_workers() {
  mkdir -p "$LOG_DIR"
  local workers=("$@")
  for worker in "${workers[@]}"; do
    nohup bash -lc "cd '$BACKEND_DIR' && node dist/src/worker-$worker" \
      > "$LOG_DIR/vaysen-crm-worker-$worker.log" 2>&1 &
  done
}

status() {
  ps -eo pid,ppid,stat,cmd \
    | grep -E 'node dist/src/worker-|npm run start:worker' \
    | grep -v grep || true
}

case "${1:-}" in
  status)
    status
    ;;
  restart-email)
    kill_workers "${EMAIL_WORKERS[@]}"
    start_workers "${EMAIL_WORKERS[@]}"
    sleep 3
    status
    ;;
  restart-all)
    kill_workers "${ALL_WORKERS[@]}"
    start_workers "${ALL_WORKERS[@]}"
    sleep 3
    status
    ;;
  stop-email)
    kill_workers "${EMAIL_WORKERS[@]}"
    status
    ;;
  stop-all)
    kill_workers "${ALL_WORKERS[@]}"
    status
    ;;
  *)
    usage
    exit 1
    ;;
esac
