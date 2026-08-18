#!/usr/bin/env bash
set -euo pipefail

APP_DIR="${APP_DIR:-/opt/vaysen-ai-crm}"
BACKEND_DIR="$APP_DIR/backend"
LOG_DIR="$APP_DIR/logs"
PID_DIR="$LOG_DIR/pids"
ENV_FILE="$BACKEND_DIR/.env.surfacepolish"

mkdir -p "$LOG_DIR" "$PID_DIR"

usage() {
  echo "Usage: $0 {status|start-backend|stop-backend|restart-backend|start-workers|stop-workers|restart-workers|start-all|stop-all|restart-all}"
}

read_pid() {
  local name="$1"
  local file="$PID_DIR/surfacepolish-$name.pid"
  [[ -f "$file" ]] && cat "$file" || true
}

is_running() {
  local pid="$1"
  [[ -n "$pid" && -d "/proc/$pid" ]]
}

find_bound_pid() {
  local port="$1"
  ss -ltnp 2>/dev/null | awk -v port=":$port" '$0 ~ port" " { if (match($0, /pid=[0-9]+/)) { print substr($0, RSTART+4, RLENGTH-4); exit } }'
}

stop_pid() {
  local name="$1"
  local port="${2:-}"
  local pid
  pid="$(read_pid "$name")"
  if ! is_running "$pid" && [[ -n "$port" ]]; then
    pid="$(find_bound_pid "$port")"
  fi
  if is_running "$pid"; then
    kill "$pid" 2>/dev/null || true
    for _ in {1..20}; do
      is_running "$pid" || break
      sleep 0.25
    done
    is_running "$pid" && kill -9 "$pid" 2>/dev/null || true
  fi
  rm -f "$PID_DIR/surfacepolish-$name.pid"
}

start_backend() {
  local pid bound_pid
  pid="$(read_pid backend)"
  if is_running "$pid"; then
    echo "SurfacePolish backend already running: $pid"
    return
  fi
  bound_pid="$(find_bound_pid 4010)"
  if is_running "$bound_pid"; then
    echo "$bound_pid" > "$PID_DIR/surfacepolish-backend.pid"
    echo "SurfacePolish backend already bound to port 4010: $bound_pid"
    return
  fi

  setsid bash -lc "
    set -euo pipefail
    cd '$BACKEND_DIR'
    set -a
    source '$ENV_FILE'
    set +a
    exec node dist/src/main
  " > "$LOG_DIR/surfacepolish-backend-4010.log" 2>&1 < /dev/null &
  echo "$!" > "$PID_DIR/surfacepolish-backend.pid"
  echo "SurfacePolish backend started: $!"
}

WORKERS=(
  continuous-prospect
  prospect-search
  email-compose
  email-validate
  email-send
  deep-research
  maintenance
)

start_worker() {
  local worker="$1"
  local pid
  pid="$(read_pid "worker-$worker")"
  if is_running "$pid"; then
    echo "SurfacePolish worker $worker already running: $pid"
    return
  fi

  setsid bash -lc "
    set -euo pipefail
    cd '$BACKEND_DIR'
    set -a
    source '$ENV_FILE'
    set +a
    exec node 'dist/src/worker-$worker'
  " > "$LOG_DIR/surfacepolish-worker-$worker.log" 2>&1 < /dev/null &
  echo "$!" > "$PID_DIR/surfacepolish-worker-$worker.pid"
  echo "SurfacePolish worker $worker started: $!"
}

start_workers() {
  for worker in "${WORKERS[@]}"; do
    start_worker "$worker"
  done
}

stop_workers() {
  for worker in "${WORKERS[@]}"; do
    stop_pid "worker-$worker"
  done
}

status_one() {
  local label="$1"
  local name="$2"
  local pid
  pid="$(read_pid "$name")"
  if is_running "$pid"; then
    echo "$label: running pid=$pid"
  else
    echo "$label: stopped"
  fi
}

status() {
  status_one "backend 4010" backend
  for worker in "${WORKERS[@]}"; do
    status_one "worker $worker" "worker-$worker"
  done
  echo
  ss -ltnp | grep -E ':4010|:4002' || true
}

case "${1:-}" in
  status)
    status
    ;;
  start-backend)
    start_backend
    ;;
  stop-backend)
    stop_pid backend 4010
    ;;
  restart-backend)
    stop_pid backend 4010
    start_backend
    ;;
  start-workers)
    start_workers
    ;;
  stop-workers)
    stop_workers
    ;;
  restart-workers)
    stop_workers
    start_workers
    ;;
  start-all)
    start_backend
    start_workers
    ;;
  stop-all)
    stop_workers
    stop_pid backend 4010
    ;;
  restart-all)
    stop_workers
    stop_pid backend 4010
    start_backend
    start_workers
    ;;
  *)
    usage
    exit 1
    ;;
esac
