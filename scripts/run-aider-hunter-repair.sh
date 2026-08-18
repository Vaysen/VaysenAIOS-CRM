#!/usr/bin/env bash
set -euo pipefail

APP_DIR="${APP_DIR:-/opt/vaysen-ai-crm}"
BACKEND_DIR="$APP_DIR/backend"
LOG_DIR="$APP_DIR/logs"
REQUEST_FILE="${1:-}"
LOCK_FILE="$LOG_DIR/aider-hunter-repair.lock"
AIDER_BIN="${AIDER_BIN:-/home/jings/snap/code/244/.local/share/uv/tools/aider-chat/bin/aider}"
AIDER_TIMEOUT_SECONDS="${AIDER_TIMEOUT_SECONDS:-1200}"
AIDER_MODEL="${AIDER_MODEL:-deepseek/deepseek-chat}"

mkdir -p "$LOG_DIR"

if [[ -z "$REQUEST_FILE" || ! -f "$REQUEST_FILE" ]]; then
  echo "missing request file: $REQUEST_FILE" >&2
  exit 2
fi

if [[ ! -x "$AIDER_BIN" ]]; then
  echo "aider binary not executable: $AIDER_BIN" >&2
  exit 3
fi

exec 9>"$LOCK_FILE"
if ! flock -n 9; then
  echo "$(date -u +"%Y-%m-%dT%H:%M:%SZ") another aider hunter repair is already running"
  exit 0
fi

run_id="$(date -u +"%Y%m%dT%H%M%SZ")"
log_file="$LOG_DIR/aider-hunter-repair-$run_id.log"
prompt_file="$LOG_DIR/aider-hunter-repair-$run_id.prompt.md"

{
  cat "$REQUEST_FILE"
  cat <<'PROMPT'

## Auto-repair instruction

You are running in production. Make the smallest safe fix for the hunter/search failure.

Allowed files to edit:
- backend/worker-customs-hunter.js
- scripts/watch-hunters.sh
- scripts/manage-customs-hunter.sh
- scripts/manage-surfacepolish-customs-hunter.sh

Rules:
- Do not read or print `.env` secrets.
- Do not modify database data.
- Do not send emails.
- Do not refactor unrelated code.
- Prefer resilient fallback behavior when SearXNG is rate limited, captcha blocked, or slow.
- Keep status endpoints accurate so watchdog can distinguish "running but not producing" from healthy.
- After editing, run `node --check backend/worker-customs-hunter.js` and `bash -n scripts/watch-hunters.sh`.
PROMPT
} > "$prompt_file"

{
  echo "==== aider hunter repair $run_id ===="
  echo "request=$REQUEST_FILE"
  echo "prompt=$prompt_file"
  cd "$APP_DIR"
  set +x
  if [[ -f "$BACKEND_DIR/.env" ]]; then
    set -a
    source "$BACKEND_DIR/.env"
    set +a
  fi
  timeout "$AIDER_TIMEOUT_SECONDS" "$AIDER_BIN" \
    --model "$AIDER_MODEL" \
    --yes-always \
    --no-auto-commits \
    --no-dirty-commits \
    --no-analytics \
    --message-file "$prompt_file" \
    backend/worker-customs-hunter.js \
    scripts/watch-hunters.sh \
    scripts/manage-customs-hunter.sh \
    scripts/manage-surfacepolish-customs-hunter.sh
  echo "---- syntax checks ----"
  node --check backend/worker-customs-hunter.js
  bash -n scripts/watch-hunters.sh
  echo "---- restart hunters ----"
  ./scripts/manage-customs-hunter.sh restart
  ./scripts/manage-surfacepolish-customs-hunter.sh restart
  echo "==== done ===="
} >> "$log_file" 2>&1

echo "$log_file"
