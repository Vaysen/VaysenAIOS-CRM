#!/usr/bin/env bash
set -euo pipefail

APP_DIR="${APP_DIR:-/opt/vaysen-ai-crm}"
BACKEND_DIR="$APP_DIR/backend"
LOG_DIR="$APP_DIR/logs"
PID_DIR="$LOG_DIR/pids"
ENV_FILE="$BACKEND_DIR/.env.surfacepolish"
PID_FILE="$PID_DIR/surfacepolish-customs-hunter.pid"
LOG_FILE="$LOG_DIR/surfacepolish-worker-customs-hunter.log"
PORT="${CUSTOMS_HUNTER_PORT:-4013}"

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
  ss -ltnp 2>/dev/null | awk -v port=":$PORT" '$0 ~ port" " { if (match($0, /pid=[0-9]+/)) { print substr($0, RSTART+4, RLENGTH-4); exit } }'
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
    echo "SurfacePolish customs hunter already running: $pid"
    return
  fi
  bound_pid="$(find_bound_pid)"
  if is_running "$bound_pid"; then
    echo "$bound_pid" > "$PID_FILE"
    echo "SurfacePolish customs hunter already bound to port $PORT: $bound_pid"
    return
  fi

  setsid bash -lc "
    set -euo pipefail
    cd '$BACKEND_DIR'
    set -a
    source '$ENV_FILE'
    set +a
    export CUSTOMS_HUNTER_PROFILE=surfacepolish
    export CUSTOMS_HUNTER_PORT='$PORT'
    export CUSTOMS_HUNTER_LOCAL_FILE='$APP_DIR/data/surfacepolish-customs-importers.json'
    exec node worker-customs-hunter.js
  " > "$LOG_FILE" 2>&1 < /dev/null &
  echo "$!" > "$PID_FILE"
  echo "SurfacePolish customs hunter started: $!"
}

status_hunter() {
  local pid bound_pid
  pid="$(read_pid)"
  bound_pid="$(find_bound_pid)"
  if is_running "$pid"; then
    echo "surfacepolish customs hunter: running pid=$pid"
  elif is_running "$bound_pid"; then
    echo "surfacepolish customs hunter: running on port $PORT pid=$bound_pid (pid file updated)"
    echo "$bound_pid" > "$PID_FILE"
  else
    echo "surfacepolish customs hunter: stopped"
  fi
  curl -sS -m 5 "http://localhost:$PORT/status" 2>/dev/null || true
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
