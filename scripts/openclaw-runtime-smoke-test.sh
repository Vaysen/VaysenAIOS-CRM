#!/usr/bin/env bash
# Runtime and real-model smoke for the isolated gateway.
# Authenticated CRM tool E2E is intentionally a separate test: a random
# Gateway session is not a valid CRM authorization boundary.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
COMPOSE_FILE="${COMPOSE_FILE:-$PROJECT_DIR/docker-compose.prod.yml}"
ENV_FILE="${ENV_FILE:-$PROJECT_DIR/.env}"
COMPOSE_PROJECT_NAME="${COMPOSE_PROJECT_NAME:-vaysen-ai-crm}"
RUN_MODEL_SMOKE="${RUN_OPENCLAW_MODEL_SMOKE:-true}"

fail() { printf '[OPENCLAW SMOKE ERROR] %s\n' "$*" >&2; exit 1; }
ok() { printf '[OPENCLAW SMOKE OK] %s\n' "$*"; }
compose() {
    docker compose --project-name "$COMPOSE_PROJECT_NAME" \
        --project-directory "$PROJECT_DIR" --env-file "$ENV_FILE" \
        -f "$COMPOSE_FILE" "$@"
}

container="$(compose ps -q openclaw-gateway)"
[ -n "$container" ] || fail 'openclaw-gateway container is missing'
[ "$(docker inspect -f '{{.State.Status}}' "$container")" = 'running' ] \
    || fail 'openclaw-gateway is not running'
[ "$(docker inspect -f '{{.State.Health.Status}}' "$container")" = 'healthy' ] \
    || fail 'openclaw-gateway is not healthy'

bindings="$(docker inspect -f '{{json .NetworkSettings.Ports}}' "$container")" \
    || fail 'could not inspect openclaw-gateway host port bindings'
if ! printf '%s' "$bindings" | node "$SCRIPT_DIR/assert-no-published-host-ports.mjs"; then
    fail 'openclaw-gateway unexpectedly publishes a host port or returned malformed port metadata'
fi
networks="$(docker inspect -f '{{range $name, $_ := .NetworkSettings.Networks}}{{println $name}}{{end}}' "$container")"
[ "$(printf '%s\n' "$networks" | sed '/^$/d' | wc -l | tr -d ' ')" -eq 1 ] \
    || fail 'openclaw-gateway must join exactly one network'
printf '%s\n' "$networks" | grep -Eq '(^|_)openclaw$' \
    || fail 'openclaw-gateway is not isolated on the OpenClaw bridge'
ok 'container isolation and health passed'

compose exec -T openclaw-gateway node dist/index.js config validate --json >/dev/null
for plugin in admin-http-rpc openclaw-weixin vaysen-crm; do
    compose exec -T openclaw-gateway node dist/index.js plugins inspect "$plugin" --runtime --json >/dev/null \
        || fail "live plugin inspection failed: $plugin"
done
ok 'configuration and enabled plugin runtime registration passed'

compose exec -T -e OPENCLAW_RUNTIME_PROBE_RUN=1 openclaw-gateway \
    node --input-type=module - < "$SCRIPT_DIR/openclaw-runtime-probe.mjs"
ok 'authenticated adapter and real provider/model RPC contracts passed'

if [ "$RUN_MODEL_SMOKE" = 'true' ]; then
    compose exec -T openclaw-gateway node --input-type=module - <<'NODE'
import { createHash, randomUUID } from 'node:crypto';

const token = process.env.OPENCLAW_GATEWAY_TOKEN;
if (!token) throw new Error('gateway token missing');
const commonHeaders = {
  authorization: `Bearer ${token}`,
  'content-type': 'application/json',
  'x-openclaw-agent-id': 'vaysen-crm',
  'x-openclaw-message-channel': 'webchat',
};
const sessionKey = `vaysen-crm:${createHash('sha256')
  .update(`model-smoke:${randomUUID()}`, 'utf8')
  .digest('hex')}`;

const modelResponse = await fetch('http://127.0.0.1:18789/v1/chat/completions', {
  method: 'POST',
  headers: {
    ...commonHeaders,
    'x-openclaw-session-key': sessionKey,
  },
  body: JSON.stringify({
    model: 'openclaw/vaysen-crm',
    stream: false,
    messages: [{
      role: 'user',
      content: 'This is a deployment smoke test. Do not call tools. Reply with exactly OPENCLAW_MODEL_OK.',
    }],
  }),
});
const modelText = await modelResponse.text();
if (!modelResponse.ok) {
  let payload = null;
  try {
    payload = JSON.parse(modelText);
  } catch {
    // Never emit an unstructured upstream body: it may contain secrets.
  }
  const sanitizeDetail = (value) => (typeof value === 'string'
    ? value
      .replace(/Bearer\s+\S+/gi, 'Bearer [REDACTED]')
      .replace(/(api[_-]?key|token|secret)\s*[=:]\s*\S+/gi, '$1=[REDACTED]')
      .slice(0, 300)
    : null);
  const safeFailure = {
    status: modelResponse.status,
    code: sanitizeDetail(payload?.error?.code),
    type: sanitizeDetail(payload?.error?.type),
    message: sanitizeDetail(payload?.error?.message),
  };
  throw new Error(`model smoke failed: ${JSON.stringify(safeFailure)}`);
}
const modelPayload = JSON.parse(modelText);
const modelContent = modelPayload?.choices?.[0]?.message?.content;
if (typeof modelContent !== 'string' || !modelContent.includes('OPENCLAW_MODEL_OK')) {
  throw new Error('model smoke response did not contain the expected marker');
}
NODE
    ok 'real Zhipu model round-trip passed'
elif [ "$RUN_MODEL_SMOKE" = 'false' ]; then
    ok 'model smoke explicitly disabled for this diagnostic run'
else
    fail 'RUN_OPENCLAW_MODEL_SMOKE must be true or false'
fi

compose exec -T openclaw-gateway node dist/index.js channels status --json --probe >/dev/null \
    || fail 'Weixin channel probe command failed'
ok 'Weixin channel probe command passed (login state may still require owner QR)'

compose exec -T openclaw-gateway sh -ceu '
  if find /home/node/.openclaw -xdev -type d ! -perm 0700 -print -quit | grep -q .; then exit 1; fi
  if find /home/node/.openclaw -xdev -type f ! -perm 0600 -print -quit | grep -q .; then exit 1; fi
' >/dev/null || fail 'OpenClaw runtime created state outside the required 0700/0600 mode boundary'
ok 'runtime-created OpenClaw state remains restricted to 0700/0600'
