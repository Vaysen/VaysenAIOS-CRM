#!/usr/bin/env bash
# Read-only verification for an emergency previous-release rollback. It checks
# only capabilities guaranteed by the legacy release and the LAN safety layer.

set -euo pipefail

COMPOSE_PROJECT_NAME="${COMPOSE_PROJECT_NAME:-vaysen-ai-crm}"
LAN_BIND_IP="${LAN_BIND_IP:-}"
LOCAL_LAN_BIND_IP="${LOCAL_LAN_BIND_IP:-}"
APP_DATA_DIR="${APP_DATA_DIR:-/var/lib/vaysen-crm/data}"
BASE_URL="http://$LAN_BIND_IP"
WORKERS=(worker-email-compose worker-email-validate worker-email-send worker-prospect-search worker-deep-research worker-maintenance)

fail() { printf '[ROLLBACK SMOKE ERROR] %s\n' "$*" >&2; exit 1; }
pass() { printf '[ROLLBACK SMOKE OK] %s\n' "$*"; }
container_for() {
    local service="$1" ids
    ids="$(docker ps -aq \
        --filter "label=com.docker.compose.project=$COMPOSE_PROJECT_NAME" \
        --filter "label=com.docker.compose.service=$service")"
    [ "$(printf '%s\n' "$ids" | sed '/^$/d' | wc -l)" -eq 1 ] \
        || fail "expected exactly one container for service $service"
    printf '%s' "$ids"
}
http_status() {
    curl --noproxy '*' --silent --show-error --output /dev/null --write-out '%{http_code}' \
        --connect-timeout 5 --max-time 15 "$1"
}

[ -n "$LAN_BIND_IP" ] || fail "LAN_BIND_IP is required"
[ -n "$LOCAL_LAN_BIND_IP" ] || fail "LOCAL_LAN_BIND_IP is required"
command -v curl >/dev/null 2>&1 || fail "curl is required"

for service in postgres redis backend frontend nginx; do
    id="$(container_for "$service")"
    state="$(docker inspect -f '{{.State.Status}}' "$id")"
    health="$(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{end}}' "$id")"
    [ "$state" = "running" ] || fail "$service is not running"
    [ "$health" = "healthy" ] || fail "$service is not healthy: ${health:-none}"
done
pass "legacy core services are running and healthy"

for service in "${WORKERS[@]}"; do
    id="$(container_for "$service")"
    [ "$(docker inspect -f '{{.State.Status}}' "$id")" = "running" ] \
        || fail "$service is not running"
done
pass "all six legacy workers are running"

send_id="$(container_for worker-email-send)"
send_env="$(docker inspect -f '{{range .Config.Env}}{{println .}}{{end}}' "$send_id")"
printf '%s\n' "$send_env" | grep -Fx 'EMAIL_SEND_DISABLED=true' >/dev/null \
    || fail "rollback email worker is not disabled"
printf '%s\n' "$send_env" | grep -Fx 'EMAIL_SEND_ENABLED=false' >/dev/null \
    || fail "rollback email worker lacks the negative send guard"
pass "email sending remains fail-closed"

backend_id="$(container_for backend)"
for mapping in \
    "$APP_DATA_DIR/uploads|/app/uploads" \
    "$APP_DATA_DIR/.customizer-assets|/app/.customizer-assets" \
    "$APP_DATA_DIR/.whatsapp-sessions|/app/.whatsapp-sessions"; do
    source="${mapping%%|*}"; destination="${mapping#*|}"
    docker inspect -f '{{range .Mounts}}{{println .Source "|" .Destination}}{{end}}' "$backend_id" \
        | grep -Fx "$source | $destination" >/dev/null \
        || fail "backend is missing protected bind mount: $destination"
done
pass "legacy backend uses canonical host runtime data"

nginx_id="$(container_for nginx)"
bindings="$(docker inspect -f '{{range $port, $items := .NetworkSettings.Ports}}{{range $items}}{{println .HostIp .HostPort}}{{end}}{{end}}' "$nginx_id")"
[ "$(printf '%s\n' "$bindings" | sed '/^$/d' | wc -l)" -eq 2 ] \
    && [ "$(printf '%s\n' "$bindings" | grep -Fxc "$LAN_BIND_IP 80")" -eq 1 ] \
    && [ "$(printf '%s\n' "$bindings" | grep -Fxc "$LOCAL_LAN_BIND_IP 80")" -eq 1 ] \
    || fail "rollback nginx is not bound exclusively to the approved ZeroTier/LAN addresses"
if printf '%s\n' "$bindings" | grep -Eq '^(0\.0\.0\.0|::) | 443$'; then
    fail "rollback nginx exposes a public or TLS listener"
fi
pass "rollback edge is ZeroTier/LAN-only"

if [ -n "${ROLLBACK_EXPECTED_REVISION:-}" ]; then
    [[ "${ROLLBACK_EXPECTED_REVISION}" =~ ^[0-9a-f]{40}$ ]] \
        || fail "rollback expected revision is invalid"
    [[ "${ROLLBACK_EXPECTED_SHORT:-}" =~ ^[0-9a-f]{8}$ ]] \
        && [ "${ROLLBACK_EXPECTED_REVISION:0:8}" = "$ROLLBACK_EXPECTED_SHORT" ] \
        || fail "rollback expected short revision is invalid"
    [[ "${ROLLBACK_EXPECTED_TAG:-}" =~ ^vaysen-crm-lan-v[0-9]+\.[0-9]+\.[0-9]+-r[0-9]+$ ]] \
        || fail "rollback expected release tag is invalid"
    for service in backend frontend python-service worker-email-compose worker-email-validate worker-email-send worker-prospect-search worker-deep-research worker-maintenance; do
        service_id="$(container_for "$service")"
        actual_revision="$(docker inspect -f '{{index .Config.Labels "org.opencontainers.image.revision"}}' "$service_id")"
        [ "$actual_revision" = "$ROLLBACK_EXPECTED_REVISION" ] \
            || fail "rollback service $service does not use the expected immutable revision"
    done
    pass "rollback application images match the expected immutable revision"
    backend_env="$(docker inspect -f '{{range .Config.Env}}{{println .}}{{end}}' "$backend_id")"
    for expected in \
        "RELEASE_COMMIT=$ROLLBACK_EXPECTED_REVISION" \
        "RELEASE_COMMIT_SHORT=$ROLLBACK_EXPECTED_SHORT" \
        "RELEASE_TAG=$ROLLBACK_EXPECTED_TAG"; do
        [ "$(printf '%s\n' "$backend_env" | grep -Fxc "$expected")" -eq 1 ] \
            || fail "rollback backend release environment is not exact: ${expected%%=*}"
    done
    pass "rollback backend release environment matches the immutable target"
fi

health_body="$(curl --noproxy '*' --silent --show-error --fail --connect-timeout 5 --max-time 15 "$BASE_URL/health")" \
    || fail "rollback /health is not 200"
if [ -n "${ROLLBACK_EXPECTED_REVISION:-}" ]; then
    printf '%s' "$health_body" | node -e '
      let raw = "";
      process.stdin.setEncoding("utf8");
      process.stdin.on("data", (chunk) => { raw += chunk; });
      process.stdin.on("end", () => {
        const body = JSON.parse(raw);
        const [revision, short, tag] = process.argv.slice(1);
        const release = body?.release || {};
        if (release.commit !== revision
          || release.commitShort !== short
          || release.tag !== tag
          || release.buildCommit !== revision
          || release.matchesBuild !== true) process.exit(1);
      });
    ' "$ROLLBACK_EXPECTED_REVISION" "$ROLLBACK_EXPECTED_SHORT" "$ROLLBACK_EXPECTED_TAG" \
        || fail "rollback /health release metadata does not match the immutable target"
    pass "rollback /health release metadata matches the immutable target"
fi
[ "$(http_status "$BASE_URL/login")" = "200" ] || fail "rollback /login is not 200"
[ "$(http_status "$BASE_URL/api/auth/me")" = "401" ] || fail "unauthenticated API is not 401"
[ "$(http_status "$BASE_URL/api/docs")" = "404" ] || fail "Swagger unexpectedly remains exposed"
pass "rollback HTTP, authentication, and Swagger contracts passed"
