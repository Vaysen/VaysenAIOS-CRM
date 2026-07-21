#!/usr/bin/env bash
# Transactionally validate or restore protected runtime bind mounts from a
# verified snapshot. The backend container must be stopped for --restore.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
. "$SCRIPT_DIR/runtime-link-manifest.sh"

MODE="--restore"
if [ "${1:-}" = "--check" ]; then
    MODE="--check"
    shift
fi

BACKUP_FILE="${1:-}"
APP_DATA_DIR="${APP_DATA_DIR:-/var/lib/vaysen-crm/data}"
APP_DATA_UID="${APP_DATA_UID:-999}"
APP_DATA_GID="${APP_DATA_GID:-999}"
OPENCLAW_DATA_UID="${OPENCLAW_DATA_UID:-1000}"
OPENCLAW_DATA_GID="${OPENCLAW_DATA_GID:-1000}"
NODE_IMAGE="${NODE_IMAGE:-}"
OPENCLAW_IMAGE="${OPENCLAW_IMAGE:-}"
CONTAINER_NAME="${BACKEND_CONTAINER:-vaysen-crm-backend}"
OPENCLAW_CONTAINER="${OPENCLAW_CONTAINER:-vaysen-crm-openclaw-gateway}"
MARKER="$APP_DATA_DIR/.initialized-v1"

fail() { printf '[RUNTIME RESTORE ERROR] %s\n' "$*" >&2; exit 1; }

[ -n "$BACKUP_FILE" ] || fail "usage: $0 [--check] <runtime-backup.tar.gz>"
[ -f "$BACKUP_FILE" ] && [ ! -L "$BACKUP_FILE" ] || fail "backup is missing or symlinked: $BACKUP_FILE"
[ -f "$BACKUP_FILE.sha256" ] && [ ! -L "$BACKUP_FILE.sha256" ] \
    || fail "checksum sidecar is missing or symlinked: $BACKUP_FILE.sha256"

expected_checksum="$(awk 'NR == 1 { print $1 }' "$BACKUP_FILE.sha256")"
[ "${#expected_checksum}" -eq 64 ] && printf '%s' "$expected_checksum" | grep -Eq '^[0-9a-fA-F]{64}$' \
    || fail "checksum sidecar must contain one SHA-256 digest"
[ "$(wc -l < "$BACKUP_FILE.sha256" | tr -d ' ')" -eq 1 ] \
    || fail "checksum sidecar must contain exactly one record"
actual_checksum="$(sha256sum "$BACKUP_FILE" | cut -d' ' -f1)"
[ "${expected_checksum,,}" = "$actual_checksum" ] || fail "runtime backup checksum validation failed"

archive_entries="$(tar -tzf "$BACKUP_FILE")" || fail "runtime backup tar validation failed"
[ -n "$archive_entries" ] || fail "runtime backup archive is empty"
normalized_entries="$(sed 's#^\./##' <<< "$archive_entries")"
if grep -Eq '(^/|(^|/)\.\.(/|$))' <<< "$normalized_entries"; then
    fail "runtime backup contains an unsafe path"
fi
if LC_ALL=C grep -Eq '(^\./|//|(^|/)\.(/|$)|[[:cntrl:]])' <<< "$normalized_entries"; then
    fail "runtime backup contains a non-canonical path"
fi
canonical_entries="$(sed 's#/$##' <<< "$normalized_entries")"
duplicate_entries="$(printf '%s\n' "$canonical_entries" | LC_ALL=C sort | uniq -d)"
[ -z "$duplicate_entries" ] || fail "runtime backup contains duplicate archive entries"
unexpected_entries="$(grep -Ev '^(uploads|\.customizer-assets|\.whatsapp-sessions|openclaw)(/.*)?$|^\.vaysen-crm-runtime-links-v1$|^\.vaysen-crm-runtime-links-v2\.json$' \
    <<< "$normalized_entries" || true)"
if [ -n "$unexpected_entries" ]; then
    fail "runtime backup contains an unexpected top-level path"
fi
verbose_entries="$(tar -tvzf "$BACKUP_FILE")" || fail "runtime backup verbose validation failed"
if grep -Eq '^[lhcbps]' <<< "$verbose_entries"; then
    fail "runtime backup contains a link or special file"
fi
for runtime_path in uploads .customizer-assets .whatsapp-sessions; do
    root_entry="${runtime_path}/"
    [ "$(grep -Fxc "$root_entry" <<< "$normalized_entries" || true)" -eq 1 ] \
        || fail "runtime backup must contain one explicit root directory: $runtime_path"
    root_type="$(awk -v archive_path="$root_entry" '$NF == archive_path { print substr($1, 1, 1) }' \
        <<< "$verbose_entries")"
    [ "$root_type" = d ] \
        || fail "runtime backup root must be a directory: $runtime_path"
done
HAS_OPENCLAW=0
if grep -Eq '^openclaw(/|$)' <<< "$normalized_entries"; then HAS_OPENCLAW=1; fi

LINK_CONTRACT_TMP=''
LINK_MANIFEST_TMP=''
LINK_PATHS_TMP=''
LINK_CONTRACT_TMP_ROOT="${RUNTIME_CONTRACT_TMP_ROOT:-$(dirname "$BACKUP_FILE")}"
[ -d "$LINK_CONTRACT_TMP_ROOT" ] && [ ! -L "$LINK_CONTRACT_TMP_ROOT" ] \
    && [ -w "$LINK_CONTRACT_TMP_ROOT" ] \
    || fail "runtime contract temp root must be a writable real directory: $LINK_CONTRACT_TMP_ROOT"
LINK_CONTRACT_TMP_ROOT="$(cd "$LINK_CONTRACT_TMP_ROOT" && pwd -P)"
cleanup_link_manifest() {
    if [ -n "$LINK_CONTRACT_TMP" ]; then
        case "$LINK_CONTRACT_TMP" in
            "$LINK_CONTRACT_TMP_ROOT"/vaysen-crm-runtime-contract-*) rm -rf -- "$LINK_CONTRACT_TMP" ;;
            *) printf '[RUNTIME RESTORE WARN] refusing unexpected contract cleanup path: %s\n' "$LINK_CONTRACT_TMP" >&2 ;;
        esac
    fi
}
trap cleanup_link_manifest EXIT
LINK_MANIFEST_V1_COUNT="$(grep -Fxc "$RUNTIME_LINK_MANIFEST_V1" <<< "$normalized_entries" || true)"
LINK_MANIFEST_V2_COUNT="$(grep -Fxc "$RUNTIME_LINK_MANIFEST_V2" <<< "$normalized_entries" || true)"
LINK_MANIFEST_COUNT=$((LINK_MANIFEST_V1_COUNT + LINK_MANIFEST_V2_COUNT))
LINK_MANIFEST_NAME=''
case "$LINK_MANIFEST_COUNT" in
    0) ;;
    1)
        if [ "$LINK_MANIFEST_V2_COUNT" -eq 1 ]; then
            LINK_MANIFEST_NAME="$RUNTIME_LINK_MANIFEST_V2"
        else
            LINK_MANIFEST_NAME="$RUNTIME_LINK_MANIFEST_V1"
        fi
        manifest_type="$(awk -v path="$LINK_MANIFEST_NAME" '$NF == path { print substr($1, 1, 1) }' <<< "$verbose_entries")"
        [ "$manifest_type" = '-' ] || fail "runtime peer-link manifest must be one regular file"
        LINK_CONTRACT_TMP="$(mktemp -d "$LINK_CONTRACT_TMP_ROOT/vaysen-crm-runtime-contract-XXXXXXXX")"
        tar -xzf "$BACKUP_FILE" -C "$LINK_CONTRACT_TMP" openclaw "$LINK_MANIFEST_NAME" \
            || fail "runtime peer-link state/manifest could not be extracted for validation"
        LINK_MANIFEST_TMP="$LINK_CONTRACT_TMP/$LINK_MANIFEST_NAME"
        LINK_PATHS_TMP="$LINK_CONTRACT_TMP/.validated-peer-paths"
        OPENCLAW_IMAGE="$OPENCLAW_IMAGE" OPENCLAW_CONTAINER="$OPENCLAW_CONTAINER" \
            OPENCLAW_DATA_UID="$OPENCLAW_DATA_UID" OPENCLAW_DATA_GID="$OPENCLAW_DATA_GID" \
            bash "$SCRIPT_DIR/run-runtime-link-contract.sh" verify-manifest \
                "$LINK_CONTRACT_TMP/openclaw" "$LINK_MANIFEST_TMP" > "$LINK_PATHS_TMP" \
            || fail "runtime peer-link manifest does not match the OpenClaw SQLite install index"
        while IFS= read -r relative || [ -n "$relative" ]; do
            runtime_link_path_kind "$relative" >/dev/null \
                || fail "runtime peer-link helper returned an unapproved path"
            [ "$(grep -Fxc "$relative" <<< "$normalized_entries" || true)" -eq 0 ] \
                || fail "runtime archive must not store a peer link as a regular entry: $relative"
            if awk -v prefix="$relative/" 'index($0, prefix) == 1 { found = 1 } END { exit(found ? 0 : 1) }' \
                <<< "$normalized_entries"; then
                fail "runtime archive must not contain an entry at or below a peer-link path: $relative"
            fi
            parent="${relative%/*}"
            while :; do
                parent_entry="$parent/"
                [ "$(grep -Fxc "$parent_entry" <<< "$normalized_entries" || true)" -eq 1 ] \
                    || fail "runtime peer-link parent must be one explicit archive directory: $parent"
                parent_type="$(awk -v path="$parent_entry" '$NF == path { print substr($1, 1, 1) }' <<< "$verbose_entries")"
                [ "$parent_type" = d ] \
                    || fail "runtime peer-link parent is not an archive directory: $parent"
                [ "$parent" = openclaw ] && break
                parent="${parent%/*}"
            done
        done < "$LINK_PATHS_TMP"
        ;;
    *) fail "runtime backup contains duplicate peer-link manifests" ;;
esac
[ "$HAS_OPENCLAW:$LINK_MANIFEST_COUNT" = '0:0' ] \
    || [ "$HAS_OPENCLAW:$LINK_MANIFEST_COUNT" = '1:1' ] \
    || fail "OpenClaw snapshots require exactly one reviewed peer-link manifest"

if [ "$MODE" = "--check" ]; then
    printf '[RUNTIME RESTORE] verified snapshot: %s\n' "$BACKUP_FILE"
    exit 0
fi

[ -n "$NODE_IMAGE" ] || fail "NODE_IMAGE must remain configured for the reviewed deployment contract"
if [ -z "$OPENCLAW_IMAGE" ]; then
    OPENCLAW_IMAGE="$(docker inspect -f '{{.Image}}' "$OPENCLAW_CONTAINER" 2>/dev/null || true)"
fi
[ -n "$OPENCLAW_IMAGE" ] \
    || fail "OPENCLAW_IMAGE or an existing OpenClaw container is required for transaction re-entry validation"
docker image inspect "$OPENCLAW_IMAGE" >/dev/null 2>&1 \
    || fail "OpenClaw transaction image is not available locally: $OPENCLAW_IMAGE"
RUNTIME_TRANSACTION_IMAGE="$OPENCLAW_IMAGE"
[ -d "$APP_DATA_DIR" ] && [ ! -L "$APP_DATA_DIR" ] \
    || fail "APP_DATA_DIR is missing or symlinked: $APP_DATA_DIR"
[ -f "$MARKER" ] && [ ! -L "$MARKER" ] \
    || fail "runtime data is not initialized; refusing destructive restore"
RESTORE_TRANSACTION="$APP_DATA_DIR/.restore-transaction"
TRANSACTION_REENTRY=0
if [ -e "$RESTORE_TRANSACTION" ] || [ -L "$RESTORE_TRANSACTION" ]; then
    [ -d "$RESTORE_TRANSACTION" ] && [ ! -L "$RESTORE_TRANSACTION" ] \
        || fail "runtime restore transaction path is unsafe"
    TRANSACTION_REENTRY=1
fi
for runtime_path in uploads .customizer-assets .whatsapp-sessions; do
    if [ -e "$APP_DATA_DIR/$runtime_path" ] || [ -L "$APP_DATA_DIR/$runtime_path" ]; then
        [ -d "$APP_DATA_DIR/$runtime_path" ] && [ ! -L "$APP_DATA_DIR/$runtime_path" ] \
            || fail "current runtime directory is unsafe: $runtime_path"
    elif [ "$TRANSACTION_REENTRY" -eq 0 ]; then
        fail "current runtime directory is missing: $runtime_path"
    fi
done
for manifest_name in "$RUNTIME_LINK_MANIFEST_V1" "$RUNTIME_LINK_MANIFEST_V2"; do
    [ ! -e "$APP_DATA_DIR/$manifest_name" ] && [ ! -L "$APP_DATA_DIR/$manifest_name" ] \
        || fail "current runtime contains a leaked peer-link manifest: $manifest_name"
done
if docker inspect -f '{{.State.Running}}' "$CONTAINER_NAME" 2>/dev/null | grep -qx true; then
    fail "$CONTAINER_NAME must be stopped before restoring runtime data"
fi
if docker inspect -f '{{.State.Running}}' "$OPENCLAW_CONTAINER" 2>/dev/null | grep -qx true; then
    fail "$OPENCLAW_CONTAINER must be stopped before restoring runtime data"
fi

docker run --rm --network none --read-only --user 0 \
    --cap-drop ALL --cap-add CHOWN --cap-add DAC_OVERRIDE --cap-add FOWNER \
    --security-opt no-new-privileges --tmpfs /tmp:rw,noexec,nosuid,nodev,size=32m \
    -v "$APP_DATA_DIR:/target" \
    -v "$BACKUP_FILE:/backup/runtime.tar.gz:ro" \
    -v "$SCRIPT_DIR/runtime-restore-transaction.sh:/usr/local/lib/vaysen-crm/runtime-restore-transaction.sh:ro" \
    -v "$SCRIPT_DIR/runtime-link-manifest.sh:/usr/local/lib/vaysen-crm/runtime-link-manifest.sh:ro" \
    -v "$SCRIPT_DIR/runtime-link-contract.mjs:/usr/local/lib/vaysen-crm/runtime-link-contract.mjs:ro" \
    -v "$SCRIPT_DIR/run-runtime-link-contract.sh:/usr/local/lib/vaysen-crm/run-runtime-link-contract.sh:ro" \
    --entrypoint sh \
    "$RUNTIME_TRANSACTION_IMAGE" /usr/local/lib/vaysen-crm/runtime-restore-transaction.sh \
        /target /backup/runtime.tar.gz "$APP_DATA_UID" "$APP_DATA_GID" "$HAS_OPENCLAW" \
        "$OPENCLAW_DATA_UID" "$OPENCLAW_DATA_GID"

printf '[RUNTIME RESTORE] completed from %s\n' "$BACKUP_FILE"
