#!/usr/bin/env bash
set -euo pipefail

APP_DIR="${APP_DIR:-/opt/vaysen-ai-crm}"
BACKEND_DIR="$APP_DIR/backend"
LOG_DIR="$APP_DIR/logs"
PID_DIR="$LOG_DIR/pids"
ENV_FILE="$BACKEND_DIR/.env"
PID_FILE="$PID_DIR/customs-hunter.pid"
LOG_FILE="$LOG_DIR/vaysen-crm-worker-customs-hunter.log"

mkdir -p "$LOG_DIR" "$PID_DIR"

usage() {
  echo "Usage: $0 {status|start|stop|restart}"
}

read_pid() {
  [[ -f "$PID_FILE" ]] && cat "$PID_FILE" || true
}

is_running() {
  local pid="$1"
  [[ -n "$pid" && -d "/proc/$pid" ]]
}

find_bound_pid() {
  ss -ltnp 2>/dev/null | awk '/:4003 / { if (match($0, /pid=[0-9]+/)) { print substr($0, RSTART+4, RLENGTH-4); exit } }'
}

stop_hunter() {
  local pid
  pid="$(read_pid)"
  if ! is_running "$pid"; then
    pid="$(find_bound_pid)"
  fi
  if is_running "$pid"; then
    kill "$pid" 2>/dev/null || true
    for _ in {1..20}; do
      is_running "$pid" || break
      sleep 0.25
    done
    is_running "$pid" && kill -9 "$pid" 2>/dev/null || true
  fi
  rm -f "$PID_FILE"
}

start_hunter() {
  local pid bound_pid
  pid="$(read_pid)"
  if is_running "$pid"; then
    echo "Customs hunter already running: $pid"
    return
  fi
  bound_pid="$(find_bound_pid)"
  if is_running "$bound_pid"; then
    echo "$bound_pid" > "$PID_FILE"
    echo "Customs hunter already bound to port 4003: $bound_pid"
    return
  fi

  setsid bash -lc "
    set -euo pipefail
    cd '$BACKEND_DIR'
    set -a
    source '$ENV_FILE'
    set +a
    exec node worker-customs-hunter.js
  " > "$LOG_FILE" 2>&1 < /dev/null &
  echo "$!" > "$PID_FILE"
  echo "Customs hunter started: $!"
}

status_hunter() {
  local pid bound_pid
  pid="$(read_pid)"
  bound_pid="$(find_bound_pid)"
  if is_running "$pid"; then
    echo "customs hunter: running pid=$pid"
  elif is_running "$bound_pid"; then
    echo "customs hunter: running on port 4003 pid=$bound_pid (pid file updated)"
    echo "$bound_pid" > "$PID_FILE"
  else
    echo "customs hunter: stopped"
  fi
  curl -sS -m 5 http://localhost:4003/status 2>/dev/null || true
  echo
}

case "${1:-}" in
  status)
    status_hunter
    ;;
  start)
    start_hunter
    ;;
  stop)
    stop_hunter
    ;;
  restart)
    stop_hunter
    start_hunter
    ;;
  *)
    usage
    exit 1
    ;;
esac
