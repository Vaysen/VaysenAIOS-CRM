#!/usr/bin/env bash
# Back up customer uploads, customizer assets, WhatsApp sessions, and (when
# installed) protected OpenClaw state. Legacy three-directory snapshots remain
# valid. The caller stops backend/workers/OpenClaw for a consistent snapshot.

set -euo pipefail
umask 077

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
. "$SCRIPT_DIR/runtime-link-manifest.sh"

BACKUP_DIR="${BACKUP_DIR:-/var/lib/vaysen-crm/backups}"
RETENTION_DAYS="${RETENTION_DAYS:-30}"
CONTAINER_NAME="${BACKEND_CONTAINER:-vaysen-crm-backend}"
OPENCLAW_CONTAINER="${OPENCLAW_CONTAINER:-vaysen-crm-openclaw-gateway}"
OPENCLAW_DATA_UID="${OPENCLAW_DATA_UID:-1000}"
OPENCLAW_DATA_GID="${OPENCLAW_DATA_GID:-1000}"
APP_DATA_DIR="${APP_DATA_DIR:-/var/lib/vaysen-crm/data}"
MODE="${1:---backup}"
TIMESTAMP="$(date +'%Y%m%d_%H%M%S_%N')"
ARCHIVE="$BACKUP_DIR/runtime_${TIMESTAMP}.tar.gz"
CHECKSUM="$ARCHIVE.sha256"

fail() { printf '[RUNTIME BACKUP ERROR] %s\n' "$*" >&2; exit 1; }
info() { printf '[RUNTIME BACKUP] %s\n' "$*"; }

[ -d "$BACKUP_DIR" ] && [ ! -L "$BACKUP_DIR" ] && [ -w "$BACKUP_DIR" ] \
    || fail "backup directory must pre-exist, be writable, and not be a symlink: $BACKUP_DIR"
command -v flock >/dev/null 2>&1 || fail "flock is required for collision-safe backups"
exec 9>"$BACKUP_DIR/.runtime-backup.lock"
flock -n 9 || fail "another runtime backup is already running"
docker container inspect "$CONTAINER_NAME" >/dev/null 2>&1 \
    || fail "backend container does not exist: $CONTAINER_NAME"

case "$MODE" in
    --preflight)
        docker inspect -f '{{.State.Running}}' "$CONTAINER_NAME" 2>/dev/null | grep -qx true \
            || fail "backend container must be running for runtime size preflight"
        SOURCE_KB="$(docker exec "$CONTAINER_NAME" sh -ceu '
            total=0
            for d in /app/uploads /app/.customizer-assets /app/.whatsapp-sessions; do
                size=$(du -sk "$d" | cut -f1)
                total=$((total + size))
            done
            printf "%s" "$total"
        ')"
        if docker container inspect "$OPENCLAW_CONTAINER" >/dev/null 2>&1; then
            docker inspect -f '{{.State.Running}}' "$OPENCLAW_CONTAINER" 2>/dev/null | grep -qx true \
                || fail "OpenClaw container must be running for runtime size preflight"
            OPENCLAW_KB="$(docker exec "$OPENCLAW_CONTAINER" sh -ceu 'du -sk /home/node/.openclaw | cut -f1')"
            SOURCE_KB=$((SOURCE_KB + OPENCLAW_KB))
        elif [ -d "$APP_DATA_DIR/openclaw" ] \
            && find "$APP_DATA_DIR/openclaw" -mindepth 1 -print -quit | grep -q .; then
            fail "OpenClaw state exists but no container is available for a verified snapshot"
        fi
        AVAILABLE_KB="$(df -Pk "$BACKUP_DIR" | awk 'NR==2 {print $4}')"
        # Worst case while stopped: copied staging (S), uncompressed-size
        # archive (S), and shared restore validation extraction (up to S).
        REQUIRED_KB=$((SOURCE_KB * 3 + 524288))
        [ "$AVAILABLE_KB" -ge "$REQUIRED_KB" ] \
            || fail "insufficient backup capacity: available=${AVAILABLE_KB}K required=${REQUIRED_KB}K"
        info "capacity preflight passed: source=${SOURCE_KB}K available=${AVAILABLE_KB}K required=${REQUIRED_KB}K"
        exit 0
        ;;
    --backup) ;;
    *) fail "usage: $0 [--preflight|--backup]" ;;
esac

if docker inspect -f '{{.State.Running}}' "$CONTAINER_NAME" 2>/dev/null | grep -qx true; then
    fail "backend container must be stopped before taking a consistent runtime backup"
fi
if docker container inspect "$OPENCLAW_CONTAINER" >/dev/null 2>&1 \
    && docker inspect -f '{{.State.Running}}' "$OPENCLAW_CONTAINER" 2>/dev/null | grep -qx true; then
    fail "$OPENCLAW_CONTAINER must be stopped before taking a consistent runtime backup"
fi

STAGING="$(mktemp -d "$BACKUP_DIR/.runtime-${TIMESTAMP}-XXXXXX")"
TMP_ARCHIVE="$(mktemp "$BACKUP_DIR/.runtime-${TIMESTAMP}-XXXXXX.tar.gz.partial")"
TMP_CHECKSUM="$(mktemp "$BACKUP_DIR/.runtime-${TIMESTAMP}-XXXXXX.sha256.partial")"
VALIDATION_CHECKSUM="$TMP_ARCHIVE.sha256"
LINK_PATHS=''
LINK_ACTUAL_PATHS=''
COMMITTED=0
PUBLICATION_STARTED=0
cleanup() {
    rm -f -- "$TMP_ARCHIVE" "$TMP_CHECKSUM" "$VALIDATION_CHECKSUM"
    [ -z "$LINK_PATHS" ] || rm -f -- "$LINK_PATHS"
    [ -z "$LINK_ACTUAL_PATHS" ] || rm -f -- "$LINK_ACTUAL_PATHS"
    if [ "$COMMITTED" -eq 0 ] && [ "$PUBLICATION_STARTED" -eq 1 ]; then
        rm -f -- "$ARCHIVE" "$CHECKSUM"
    fi
    case "$STAGING" in
        "$BACKUP_DIR"/.runtime-*) rm -rf -- "$STAGING" ;;
        *) printf '[RUNTIME BACKUP WARN] refusing unexpected cleanup path: %s\n' "$STAGING" >&2 ;;
    esac
}
trap cleanup EXIT

for runtime_path in uploads .customizer-assets .whatsapp-sessions; do
    mkdir -p "$STAGING/$runtime_path"
    docker cp "$CONTAINER_NAME:/app/$runtime_path/." "$STAGING/$runtime_path/" \
        || fail "could not copy /app/$runtime_path from $CONTAINER_NAME"
done
RUNTIME_PATHS=(uploads .customizer-assets .whatsapp-sessions)
OPENCLAW_INCLUDED=0
if docker container inspect "$OPENCLAW_CONTAINER" >/dev/null 2>&1; then
    mkdir -p "$STAGING/openclaw"
    docker cp "$OPENCLAW_CONTAINER:/home/node/.openclaw/." "$STAGING/openclaw/" \
        || fail "could not copy protected OpenClaw state from $OPENCLAW_CONTAINER"
    bash "$SCRIPT_DIR/sanitize-openclaw-runtime-snapshot.sh" "$STAGING/openclaw" \
        || fail "copied OpenClaw state contains an unsafe transient browser skill entry"
    RUNTIME_PATHS+=(openclaw)
    OPENCLAW_INCLUDED=1
elif [ -d "$APP_DATA_DIR/openclaw" ] \
    && find "$APP_DATA_DIR/openclaw" -mindepth 1 -print -quit | grep -q .; then
    fail "OpenClaw state exists but no container is available for a verified snapshot"
fi

LINK_MANIFEST="$STAGING/$RUNTIME_LINK_MANIFEST"
LINK_PATHS="$(mktemp "$BACKUP_DIR/.runtime-links-${TIMESTAMP}-XXXXXX.expected")"
LINK_ACTUAL_PATHS="$(mktemp "$BACKUP_DIR/.runtime-links-${TIMESTAMP}-XXXXXX.actual")"
: > "$LINK_ACTUAL_PATHS"
if [ "$OPENCLAW_INCLUDED" -eq 1 ]; then
    OPENCLAW_DATA_UID="$OPENCLAW_DATA_UID" OPENCLAW_DATA_GID="$OPENCLAW_DATA_GID" \
        bash "$SCRIPT_DIR/run-runtime-link-contract.sh" verify-tree "$STAGING/openclaw" > "$LINK_PATHS" \
        || fail "OpenClaw tree symlink set does not match the SQLite install index"
    OPENCLAW_DATA_UID="$OPENCLAW_DATA_UID" OPENCLAW_DATA_GID="$OPENCLAW_DATA_GID" \
        bash "$SCRIPT_DIR/run-runtime-link-contract.sh" emit-v2 "$STAGING/openclaw" > "$LINK_MANIFEST" \
        || fail "OpenClaw SQLite/link state failed the reviewed manifest contract"
    OPENCLAW_DATA_UID="$OPENCLAW_DATA_UID" OPENCLAW_DATA_GID="$OPENCLAW_DATA_GID" \
        bash "$SCRIPT_DIR/run-runtime-link-contract.sh" verify-manifest \
        "$STAGING/openclaw" "$LINK_MANIFEST" > "$LINK_ACTUAL_PATHS" \
        || fail "generated OpenClaw peer-link manifest failed independent validation"
    LC_ALL=C sort -o "$LINK_PATHS" "$LINK_PATHS"
    LC_ALL=C sort -o "$LINK_ACTUAL_PATHS" "$LINK_ACTUAL_PATHS"
    cmp -s "$LINK_PATHS" "$LINK_ACTUAL_PATHS" \
        || fail "OpenClaw tree and generated SQLite manifest path sets disagree"
    : > "$LINK_ACTUAL_PATHS"
else
    : > "$LINK_PATHS"
fi
LINK_COUNT=0
while IFS= read -r -d '' link; do
    relative="${link#"$STAGING"/}"
    runtime_link_path_kind "$relative" >/dev/null \
        || fail "runtime data contains an unapproved symlink path: $relative"
    [ "$(readlink -- "$link")" = /app ] \
        || fail "runtime data contains an approved peer path with the wrong target: $relative"
    printf '%s\n' "$relative" >> "$LINK_ACTUAL_PATHS"
    rm -- "$link"
    LINK_COUNT=$((LINK_COUNT + 1))
done < <(find "$STAGING" -type l -print0)
if [ "$OPENCLAW_INCLUDED" -eq 1 ]; then
    [ "$LINK_COUNT" -eq 2 ] \
        || fail "protected OpenClaw state must contain exactly two reviewed peer links; found $LINK_COUNT"
    LC_ALL=C sort -o "$LINK_PATHS" "$LINK_PATHS"
    LC_ALL=C sort -o "$LINK_ACTUAL_PATHS" "$LINK_ACTUAL_PATHS"
    cmp -s "$LINK_PATHS" "$LINK_ACTUAL_PATHS" \
        || fail "OpenClaw SQLite install paths and copied peer-link set disagree"
    chmod 600 "$LINK_MANIFEST"
    RUNTIME_PATHS+=("$RUNTIME_LINK_MANIFEST")
else
    [ "$LINK_COUNT" -eq 0 ] || fail "legacy runtime state unexpectedly contains OpenClaw peer links"
    rm -f -- "$LINK_MANIFEST"
fi
if find "$STAGING" ! -type d ! -type f -print -quit | grep -q .; then
    fail "runtime data contains a raw link or special file after peer-link encoding"
fi

tar --hard-dereference -C "$STAGING" -czf "$TMP_ARCHIVE" "${RUNTIME_PATHS[@]}"
tar -tzf "$TMP_ARCHIVE" >/dev/null || fail "created archive failed tar validation"
CHECKSUM_VALUE="$(sha256sum "$TMP_ARCHIVE" | cut -d' ' -f1)"
printf '%s  %s\n' "$CHECKSUM_VALUE" "$(basename "$TMP_ARCHIVE")" > "$VALIDATION_CHECKSUM"
OPENCLAW_DATA_UID="$OPENCLAW_DATA_UID" OPENCLAW_DATA_GID="$OPENCLAW_DATA_GID" \
    OPENCLAW_CONTAINER="$OPENCLAW_CONTAINER" \
    bash "$SCRIPT_DIR/restore-runtime-data.sh" --check "$TMP_ARCHIVE" >/dev/null \
    || fail "created runtime archive failed the shared restore validation contract"
rm -f -- "$VALIDATION_CHECKSUM"
printf '%s  %s\n' "$CHECKSUM_VALUE" "$(basename "$ARCHIVE")" > "$TMP_CHECKSUM"
chmod 600 "$TMP_ARCHIVE" "$TMP_CHECKSUM"
[ ! -e "$ARCHIVE" ] && [ ! -e "$CHECKSUM" ] || fail "refusing to overwrite an existing runtime backup"
PUBLICATION_STARTED=1
mv "$TMP_CHECKSUM" "$CHECKSUM"
mv "$TMP_ARCHIVE" "$ARCHIVE"
COMMITTED=1
trap - EXIT
rm -f -- "$LINK_PATHS" "$LINK_ACTUAL_PATHS"
rm -rf -- "$STAGING"

find "$BACKUP_DIR" -maxdepth 1 -type f \
    \( -name 'runtime_*.tar.gz' -o -name 'runtime_*.tar.gz.sha256' \) \
    -mtime "+$RETENTION_DAYS" -delete

info "verified snapshot created: $ARCHIVE"
printf 'runtimeBackup=%s\n' "$ARCHIVE"
printf 'runtimeSha256=%s\n' "$CHECKSUM_VALUE"
