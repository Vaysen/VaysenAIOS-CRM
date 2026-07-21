#!/usr/bin/env bash
# Run the SQLite-backed peer-link contract against the protected .openclaw
# state root using local Node or the reviewed OpenClaw image.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MODE="${1:-}"
STATE_ROOT="${2:-}"
MANIFEST="${3:-}"
CONTRACT_HELPER="${RUNTIME_LINK_CONTRACT_HELPER:-$SCRIPT_DIR/runtime-link-contract.mjs}"
OPENCLAW_CONTAINER="${OPENCLAW_CONTAINER:-vaysen-crm-openclaw-gateway}"
OPENCLAW_DATA_UID="${OPENCLAW_DATA_UID:-1000}"
OPENCLAW_DATA_GID="${OPENCLAW_DATA_GID:-1000}"

fail() { printf '[RUNTIME LINK CONTRACT ERROR] %s\n' "$*" >&2; exit 1; }

case "$MODE" in
    emit-v2|verify-tree|verify-live-tree) [ "$#" -eq 2 ] || fail "usage: $0 $MODE <openclaw-state-root>" ;;
    verify-manifest) [ "$#" -eq 3 ] || fail "usage: $0 verify-manifest <openclaw-state-root> <manifest>" ;;
    *) fail "unknown mode: $MODE" ;;
esac
[ -d "$STATE_ROOT" ] && [ ! -L "$STATE_ROOT" ] \
    || fail "OpenClaw state root must be a real directory: $STATE_ROOT"
case "$OPENCLAW_DATA_UID" in ''|*[!0-9]*) fail "OPENCLAW_DATA_UID must be numeric" ;; esac
case "$OPENCLAW_DATA_GID" in ''|*[!0-9]*) fail "OPENCLAW_DATA_GID must be numeric" ;; esac
[ -f "$CONTRACT_HELPER" ] && [ ! -L "$CONTRACT_HELPER" ] \
    || fail "runtime link contract helper is missing or symlinked: $CONTRACT_HELPER"
if [ "$MODE" = verify-manifest ]; then
    [ -f "$MANIFEST" ] && [ ! -L "$MANIFEST" ] \
        || fail "runtime link manifest must be a regular non-symlink file: $MANIFEST"
fi

CONTRACT_NODE="${RUNTIME_LINK_CONTRACT_NODE:-node}"
if command -v "$CONTRACT_NODE" >/dev/null 2>&1 \
    && "$CONTRACT_NODE" --no-warnings -e "require('node:sqlite')" >/dev/null 2>&1; then
    if [ "$MODE" = verify-manifest ]; then
        exec "$CONTRACT_NODE" --no-warnings "$CONTRACT_HELPER" "$MODE" "$STATE_ROOT" "$MANIFEST"
    fi
    exec "$CONTRACT_NODE" --no-warnings "$CONTRACT_HELPER" "$MODE" "$STATE_ROOT"
fi

CONTRACT_IMAGE="${OPENCLAW_IMAGE:-}"
if [ -z "$CONTRACT_IMAGE" ]; then
    CONTRACT_IMAGE="$(docker inspect -f '{{.Image}}' "$OPENCLAW_CONTAINER" 2>/dev/null || true)"
fi
[ -n "$CONTRACT_IMAGE" ] \
    || fail "no sqlite-capable local Node or OpenClaw image/container is available"
docker image inspect "$CONTRACT_IMAGE" >/dev/null 2>&1 \
    || fail "OpenClaw contract image is not available locally: $CONTRACT_IMAGE"

DOCKER_ARGS=(
    run --rm --network none --read-only --user "$OPENCLAW_DATA_UID:$OPENCLAW_DATA_GID"
    --cap-drop ALL --security-opt no-new-privileges
    --tmpfs /tmp:rw,noexec,nosuid,nodev,size=16m
    --entrypoint node
    -v "$STATE_ROOT:/runtime-state:ro"
    -v "$CONTRACT_HELPER:/usr/local/lib/vaysen-crm/runtime-link-contract.mjs:ro"
)
if [ "$MODE" = verify-manifest ]; then
    DOCKER_ARGS+=( -v "$MANIFEST:/runtime-manifest:ro" )
    exec docker "${DOCKER_ARGS[@]}" "$CONTRACT_IMAGE" --no-warnings \
        /usr/local/lib/vaysen-crm/runtime-link-contract.mjs "$MODE" /runtime-state /runtime-manifest
fi
exec docker "${DOCKER_ARGS[@]}" "$CONTRACT_IMAGE" --no-warnings \
    /usr/local/lib/vaysen-crm/runtime-link-contract.mjs "$MODE" /runtime-state
