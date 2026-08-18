#!/usr/bin/env bash
# Aider + DeepSeek launcher. Key is read from backend/.env.surfacepolish at runtime
# (never hardcoded). All traffic goes through the local Clash proxy.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# --- proxy (host can only reach the internet via Clash) ---
export https_proxy="${https_proxy:-http://127.0.0.1:7890}"
export http_proxy="${http_proxy:-http://127.0.0.1:7890}"
export all_proxy="${all_proxy:-socks5://127.0.0.1:7891}"

# --- DeepSeek key from env file (key name only referenced, value never printed) ---
if [ -z "${DEEPSEEK_API_KEY:-}" ]; then
  DEEPSEEK_API_KEY="$(grep -m1 '^DEEPSEEK_API_KEY=' "$ROOT/backend/.env.surfacepolish" | cut -d= -f2-)"
fi
export OPENAI_API_KEY="$DEEPSEEK_API_KEY"
export OPENAI_API_BASE="https://api.deepseek.com/v1"

MODEL="${AIDER_MODEL:-openai/deepseek-v4-pro}"
AIDER_BIN="$HOME/snap/code/244/.local/bin/aider"

exec "$AIDER_BIN" \
  --model "$MODEL" \
  --no-auto-commit \
  --no-gitignore \
  --yes-always \
  --no-show-model-warnings \
  --map-tokens 0 \
  --no-stream \
  --no-check-update \
  "$@"
