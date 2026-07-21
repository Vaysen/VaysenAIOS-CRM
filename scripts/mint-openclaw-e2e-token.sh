#!/usr/bin/env bash
# Mint one short-lived administrator JWT inside the running backend container.
# The token is written atomically to a caller-owned 0600 file and never logged.

set -euo pipefail
umask 077

COMPANY_ID="${OPENCLAW_E2E_COMPANY_ID:-}"
OWNER_EMAIL="${OPENCLAW_E2E_OWNER_EMAIL:-}"
OUTPUT_FILE="${OPENCLAW_E2E_TOKEN_OUTPUT_FILE:-}"
TTL_SECONDS="${OPENCLAW_E2E_TOKEN_TTL_SECONDS:-600}"
BACKEND_CONTAINER="${OPENCLAW_E2E_BACKEND_CONTAINER:-vaysen-crm-backend}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MINT_SCRIPT="$SCRIPT_DIR/mint-openclaw-e2e-token.mjs"

fail() { printf '[OPENCLAW E2E AUTH ERROR] %s\n' "$*" >&2; exit 1; }

printf '%s' "$COMPANY_ID" | grep -Eqi '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' \
  || fail 'OPENCLAW_E2E_COMPANY_ID must be a UUID'
printf '%s' "$OWNER_EMAIL" | grep -Eqi '^[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}$' \
  || fail 'OPENCLAW_E2E_OWNER_EMAIL must be a valid email'
[[ "$TTL_SECONDS" =~ ^[0-9]+$ ]] && [ "$TTL_SECONDS" -ge 300 ] && [ "$TTL_SECONDS" -le 900 ] \
  || fail 'OPENCLAW_E2E_TOKEN_TTL_SECONDS must be between 300 and 900'
[ -n "$OUTPUT_FILE" ] || fail 'OPENCLAW_E2E_TOKEN_OUTPUT_FILE is required'
[ -f "$MINT_SCRIPT" ] && [ ! -L "$MINT_SCRIPT" ] || fail 'token mint implementation is missing or symlinked'
[ -f "$OUTPUT_FILE" ] && [ ! -L "$OUTPUT_FILE" ] || fail 'token output must be an existing regular non-symlink file'
[ "$(stat -c '%u' "$OUTPUT_FILE")" = "$(id -u)" ] || fail 'token output must be owned by the deployment user'
chmod 600 "$OUTPUT_FILE"

state="$(docker inspect -f '{{.State.Status}}' "$BACKEND_CONTAINER" 2>/dev/null || true)"
health="$(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{end}}' "$BACKEND_CONTAINER" 2>/dev/null || true)"
[ "$state" = 'running' ] && [ "$health" = 'healthy' ] \
  || fail 'backend container must be running and healthy before token minting'

next_file="${OUTPUT_FILE}.next-$$"
trap 'rm -f -- "$next_file"' EXIT HUP INT TERM
docker exec -i -w /app "$BACKEND_CONTAINER" \
  node --input-type=module - "$COMPANY_ID" "$OWNER_EMAIL" "$TTL_SECONDS" \
  < "$MINT_SCRIPT" > "$next_file" \
  || fail 'backend refused to mint the short-lived administrator token'
chmod 600 "$next_file"
node - "$next_file" <<'NODE'
const fs = require('fs');
const token = fs.readFileSync(process.argv[2], 'utf8');
if (/\r|\n/.test(token) || !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(token)) process.exit(1);
const payload = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8'));
const remaining = Number(payload.exp) - Math.floor(Date.now() / 1000);
if (!payload.sub || !payload.email || remaining < 295 || remaining > 905) process.exit(2);
NODE
mv -T -- "$next_file" "$OUTPUT_FILE"
trap - EXIT HUP INT TERM
printf '[OPENCLAW E2E AUTH OK] short-lived administrator token minted without disclosure\n'
