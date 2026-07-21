#!/usr/bin/env bash
# One-time migration from a verified runtime backup into protected host bind
# mounts. Existing initialized data is never overwritten by deployment.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
. "$SCRIPT_DIR/runtime-link-manifest.sh"
BACKUP_FILE="${1:-}"
APP_DATA_DIR="${APP_DATA_DIR:-/var/lib/vaysen-crm/data}"
APP_DATA_UID="${APP_DATA_UID:-999}"
APP_DATA_GID="${APP_DATA_GID:-999}"
OPENCLAW_DATA_UID="${OPENCLAW_DATA_UID:-1000}"
OPENCLAW_DATA_GID="${OPENCLAW_DATA_GID:-1000}"
NODE_IMAGE="${NODE_IMAGE:-}"
OPENCLAW_IMAGE="${OPENCLAW_IMAGE:-}"
OPENCLAW_CONTAINER="${OPENCLAW_CONTAINER:-vaysen-crm-openclaw-gateway}"
MARKER="$APP_DATA_DIR/.initialized-v1"

fail() { printf '[RUNTIME PREPARE ERROR] %s\n' "$*" >&2; exit 1; }
info() { printf '[RUNTIME PREPARE] %s\n' "$*"; }

[ -n "$BACKUP_FILE" ] || fail "usage: $0 <runtime-backup.tar.gz>"
[ -f "$BACKUP_FILE" ] && [ ! -L "$BACKUP_FILE" ] || fail "backup is missing or symlinked: $BACKUP_FILE"
[ -f "$BACKUP_FILE.sha256" ] && [ ! -L "$BACKUP_FILE.sha256" ] \
    || fail "checksum sidecar is missing or symlinked: $BACKUP_FILE.sha256"
if ! OPENCLAW_IMAGE="$OPENCLAW_IMAGE" OPENCLAW_CONTAINER="$OPENCLAW_CONTAINER" \
    OPENCLAW_DATA_UID="$OPENCLAW_DATA_UID" OPENCLAW_DATA_GID="$OPENCLAW_DATA_GID" \
    bash "$SCRIPT_DIR/restore-runtime-data.sh" --check "$BACKUP_FILE" >/dev/null; then
    fail "runtime backup failed the shared restore validation contract"
fi
archive_entries="$(tar -tzf "$BACKUP_FILE")" || fail "runtime backup tar validation failed"
normalized_entries="$(sed 's#^\./##' <<< "$archive_entries")"
HAS_OPENCLAW=0
if grep -Eq '^openclaw(/|$)' <<< "$normalized_entries"; then HAS_OPENCLAW=1; fi
[ -n "$NODE_IMAGE" ] || fail "NODE_IMAGE must remain configured for the reviewed deployment contract"
[ -d "$APP_DATA_DIR" ] && [ ! -L "$APP_DATA_DIR" ] && [ -w "$APP_DATA_DIR" ] \
    || fail "APP_DATA_DIR must pre-exist, be writable, and not be a symlink: $APP_DATA_DIR"

resolve_transaction_image() {
    if [ -z "$OPENCLAW_IMAGE" ]; then
        OPENCLAW_IMAGE="$(docker inspect -f '{{.Image}}' "$OPENCLAW_CONTAINER" 2>/dev/null || true)"
    fi
    [ -n "$OPENCLAW_IMAGE" ] \
        || fail "OPENCLAW_IMAGE or an existing OpenClaw container is required for transaction re-entry validation"
    docker image inspect "$OPENCLAW_IMAGE" >/dev/null 2>&1 \
        || fail "OpenClaw transaction image is not available locally: $OPENCLAW_IMAGE"
    RUNTIME_TRANSACTION_IMAGE="$OPENCLAW_IMAGE"
}

run_initializer() {
    resolve_transaction_image
    docker run --rm --network none --read-only --user 0 \
        --cap-drop ALL --cap-add CHOWN --cap-add DAC_OVERRIDE --cap-add FOWNER \
        --security-opt no-new-privileges --tmpfs /tmp:rw,noexec,nosuid,nodev,size=32m \
        -v "$APP_DATA_DIR:/target" \
        -v "$BACKUP_FILE:/backup/runtime.tar.gz:ro" \
        -v "$SCRIPT_DIR/runtime-initialize-transaction.sh:/usr/local/lib/vaysen-crm/runtime-initialize-transaction.sh:ro" \
        -v "$SCRIPT_DIR/runtime-link-manifest.sh:/usr/local/lib/vaysen-crm/runtime-link-manifest.sh:ro" \
        -v "$SCRIPT_DIR/runtime-link-contract.mjs:/usr/local/lib/vaysen-crm/runtime-link-contract.mjs:ro" \
        -v "$SCRIPT_DIR/run-runtime-link-contract.sh:/usr/local/lib/vaysen-crm/run-runtime-link-contract.sh:ro" \
        --entrypoint sh \
        "$RUNTIME_TRANSACTION_IMAGE" /usr/local/lib/vaysen-crm/runtime-initialize-transaction.sh \
            /target /backup/runtime.tar.gz "$APP_DATA_UID" "$APP_DATA_GID" "$HAS_OPENCLAW" \
            "$OPENCLAW_DATA_UID" "$OPENCLAW_DATA_GID"
}

assert_business_runtime_plain_files() {
    local scan_output scan_status
    set +e
    scan_output="$(find "$APP_DATA_DIR/uploads" "$APP_DATA_DIR/.customizer-assets" \
        "$APP_DATA_DIR/.whatsapp-sessions" ! -type d ! -type f -print -quit 2>&1)"
    scan_status=$?
    set -e
    if [ "$scan_status" -eq 0 ]; then
        [ -z "$scan_output" ] || fail "initialized business runtime contains a link or special file"
        return 0
    fi

    [ -n "$NODE_IMAGE" ] || fail "NODE_IMAGE is required for protected business runtime inspection"
    docker image inspect "$NODE_IMAGE" >/dev/null 2>&1 \
        || fail "protected runtime inspection image is unavailable: $NODE_IMAGE"
    docker run --rm --network none --read-only --user 0 \
        --cap-drop ALL --cap-add DAC_OVERRIDE --security-opt no-new-privileges \
        --tmpfs /tmp:rw,noexec,nosuid,nodev,size=8m \
        -v "$APP_DATA_DIR:/runtime:ro" --entrypoint sh "$NODE_IMAGE" -c '
            set -eu
            for runtime_path in uploads .customizer-assets .whatsapp-sessions; do
                [ -d "/runtime/$runtime_path" ] && [ ! -L "/runtime/$runtime_path" ] || exit 41
            done
            unexpected="$(find /runtime/uploads /runtime/.customizer-assets \
                /runtime/.whatsapp-sessions ! -type d ! -type f -print -quit)"
            [ -z "$unexpected" ]
        ' >/dev/null || fail "protected business runtime contains an unreadable, linked, or special entry"
}

# Let the transaction helper resolve an earlier SIGKILL/power-loss boundary
# before the regular initialized/empty target classification below.
if [ -e "$APP_DATA_DIR/.prepare-new" ] || [ -L "$APP_DATA_DIR/.prepare-new" ]; then
    run_initializer || fail "runtime initialization transaction recovery failed"
fi

if [ -e "$MARKER" ] || [ -L "$MARKER" ]; then
    [ -f "$MARKER" ] && [ ! -L "$MARKER" ] \
        || fail "runtime initialization marker is not a regular non-symlink file"
    [ ! -e "$APP_DATA_DIR/.prepare-new" ] && [ ! -L "$APP_DATA_DIR/.prepare-new" ] \
        || fail "initialized runtime contains unfinished transaction state"
    for manifest_name in "$RUNTIME_LINK_MANIFEST_V1" "$RUNTIME_LINK_MANIFEST_V2"; do
        [ ! -e "$APP_DATA_DIR/$manifest_name" ] && [ ! -L "$APP_DATA_DIR/$manifest_name" ] \
            || fail "initialized runtime contains a leaked peer-link manifest: $manifest_name"
    done
    for runtime_path in uploads .customizer-assets .whatsapp-sessions; do
        [ -d "$APP_DATA_DIR/$runtime_path" ] && [ ! -L "$APP_DATA_DIR/$runtime_path" ] \
            || fail "initialized runtime directory is missing or symlinked: $runtime_path"
        actual="$(stat -c '%u:%g:%a' "$APP_DATA_DIR/$runtime_path")"
        [ "$actual" = "$APP_DATA_UID:$APP_DATA_GID:700" ] \
            || fail "$runtime_path ownership/mode is $actual; expected $APP_DATA_UID:$APP_DATA_GID:700"
    done
    assert_business_runtime_plain_files
    if [ -e "$APP_DATA_DIR/openclaw" ] || [ -L "$APP_DATA_DIR/openclaw" ]; then
        [ -d "$APP_DATA_DIR/openclaw" ] && [ ! -L "$APP_DATA_DIR/openclaw" ] \
            || fail "initialized OpenClaw runtime path is not a real directory"
        actual="$(stat -c '%u:%g:%a' "$APP_DATA_DIR/openclaw")"
        [ "$actual" = "$OPENCLAW_DATA_UID:$OPENCLAW_DATA_GID:700" ] \
            || fail "openclaw ownership/mode is $actual; expected $OPENCLAW_DATA_UID:$OPENCLAW_DATA_GID:700"
        OPENCLAW_IMAGE="$OPENCLAW_IMAGE" OPENCLAW_CONTAINER="$OPENCLAW_CONTAINER" \
            OPENCLAW_DATA_UID="$OPENCLAW_DATA_UID" OPENCLAW_DATA_GID="$OPENCLAW_DATA_GID" \
            bash "$SCRIPT_DIR/run-runtime-link-contract.sh" verify-live-tree "$APP_DATA_DIR/openclaw" >/dev/null \
            || fail "existing OpenClaw runtime does not match its SQLite peer-link contract"
    fi
    info "existing initialized runtime data preserved"
    exit 0
fi

# Compose may have materialized the three bind-mount directories during a
# read-only candidate check. They are safe to remove only when real and empty.
for runtime_path in uploads .customizer-assets .whatsapp-sessions openclaw; do
    candidate="$APP_DATA_DIR/$runtime_path"
    if [ -e "$candidate" ] || [ -L "$candidate" ]; then
        [ -d "$candidate" ] && [ ! -L "$candidate" ] \
            || fail "uninitialized runtime path is not a real directory: $runtime_path"
        find "$candidate" -mindepth 1 -print -quit | grep -q . \
            && fail "uninitialized runtime path is not empty: $runtime_path"
        rmdir "$candidate"
    fi
done
if find "$APP_DATA_DIR" -mindepth 1 -maxdepth 1 ! -name '.prepare-new' -print -quit | grep -q .; then
    fail "uninitialized APP_DATA_DIR is not empty; manual inspection required"
fi

run_initializer

for runtime_path in uploads .customizer-assets .whatsapp-sessions; do
    actual="$(stat -c '%u:%g:%a' "$APP_DATA_DIR/$runtime_path")"
    [ "$actual" = "$APP_DATA_UID:$APP_DATA_GID:700" ] \
        || fail "$runtime_path post-migration ownership/mode is invalid: $actual"
done
if [ "$HAS_OPENCLAW" -eq 1 ]; then
    actual="$(stat -c '%u:%g:%a' "$APP_DATA_DIR/openclaw")"
    [ "$actual" = "$OPENCLAW_DATA_UID:$OPENCLAW_DATA_GID:700" ] \
        || fail "openclaw post-migration ownership/mode is invalid: $actual"
    OPENCLAW_IMAGE="$OPENCLAW_IMAGE" OPENCLAW_CONTAINER="$OPENCLAW_CONTAINER" \
        OPENCLAW_DATA_UID="$OPENCLAW_DATA_UID" OPENCLAW_DATA_GID="$OPENCLAW_DATA_GID" \
        bash "$SCRIPT_DIR/run-runtime-link-contract.sh" verify-tree "$APP_DATA_DIR/openclaw" >/dev/null \
        || fail "OpenClaw post-migration tree does not match its SQLite peer-link contract"
else
    [ "$(find "$APP_DATA_DIR/uploads" "$APP_DATA_DIR/.customizer-assets" \
        "$APP_DATA_DIR/.whatsapp-sessions" -type l | wc -l | tr -d ' ')" -eq 0 ] \
        || fail "legacy post-migration runtime contains an unexpected link"
fi
for manifest_name in "$RUNTIME_LINK_MANIFEST_V1" "$RUNTIME_LINK_MANIFEST_V2"; do
    [ ! -e "$APP_DATA_DIR/$manifest_name" ] && [ ! -L "$APP_DATA_DIR/$manifest_name" ] \
        || fail "internal peer-link manifest leaked into initialized runtime data: $manifest_name"
done
[ ! -e "$APP_DATA_DIR/.prepare-new" ] && [ ! -L "$APP_DATA_DIR/.prepare-new" ] \
    || fail "runtime initialization transaction state leaked into the target"
info "runtime data initialized from $BACKUP_FILE"
