#!/usr/bin/env bash
# Create a locked, checksummed PostgreSQL custom-format backup outside Git.

set -euo pipefail
umask 077

BACKUP_DIR="${BACKUP_DIR:-/var/lib/vaysen-crm/backups}"
RETENTION_DAYS="${RETENTION_DAYS:-30}"
CONTAINER_NAME="${POSTGRES_CONTAINER:-vaysen-crm-postgres}"
DB_USER="${POSTGRES_USER:-vaysen-crm}"
DB_NAME="${POSTGRES_DB:-vaysen-crm_pilot}"

fail() { printf '[DB BACKUP ERROR] %s\n' "$*" >&2; exit 1; }
info() { printf '[DB BACKUP] %s\n' "$*"; }

[ -d "$BACKUP_DIR" ] && [ ! -L "$BACKUP_DIR" ] && [ -w "$BACKUP_DIR" ] \
    || fail "backup directory must pre-exist, be writable, and not be a symlink: $BACKUP_DIR"
command -v flock >/dev/null 2>&1 || fail "flock is required for collision-safe backups"
command -v sha256sum >/dev/null 2>&1 || fail "sha256sum is required"

exec 9>"$BACKUP_DIR/.database-backup.lock"
flock -n 9 || fail "another database backup is already running"

available_kb="$(df -Pk "$BACKUP_DIR" | awk 'NR == 2 { print $4 }')"
[ -n "$available_kb" ] && [ "$available_kb" -ge 524288 ] \
    || fail "backup directory must have at least 512 MiB free"
docker inspect -f '{{.State.Running}}' "$CONTAINER_NAME" 2>/dev/null | grep -qx true \
    || fail "PostgreSQL container is not running: $CONTAINER_NAME"

timestamp="$(date +'%Y%m%d_%H%M%S_%N')"
backup_file="$BACKUP_DIR/vaysen-crm_${timestamp}.dump"
checksum_file="$backup_file.sha256"
partial="$(mktemp "$BACKUP_DIR/.vaysen-crm-${timestamp}-XXXXXX.dump.partial")"
checksum_partial="$(mktemp "$BACKUP_DIR/.vaysen-crm-${timestamp}-XXXXXX.sha256.partial")"
committed=0
cleanup() {
    rm -f -- "$partial" "$checksum_partial"
    if [ "$committed" -eq 0 ]; then rm -f -- "$checksum_file"; fi
}
trap cleanup EXIT

info "creating a consistent custom-format snapshot of $DB_NAME"
if ! docker exec "$CONTAINER_NAME" \
    pg_dump -U "$DB_USER" -d "$DB_NAME" --clean --if-exists --no-owner -Fc \
    > "$partial"; then
    fail "pg_dump failed"
fi
[ -s "$partial" ] || fail "pg_dump returned an empty file"
docker exec -i "$CONTAINER_NAME" pg_restore -l < "$partial" >/dev/null 2>&1 \
    || fail "created archive failed pg_restore validation"

checksum="$(sha256sum "$partial" | cut -d' ' -f1)"
printf '%s  %s\n' "$checksum" "$(basename "$backup_file")" > "$checksum_partial"
chmod 600 "$partial" "$checksum_partial"
[ ! -e "$backup_file" ] && [ ! -e "$checksum_file" ] \
    || fail "refusing to overwrite an existing backup"

# Publish the checksum first. If power is lost before the dump rename, only an
# orphan sidecar remains; --latest-db never selects it.
mv "$checksum_partial" "$checksum_file"
mv "$partial" "$backup_file"
committed=1
trap - EXIT

find "$BACKUP_DIR" -maxdepth 1 -type f \
    \( -name 'vaysen-crm_*.dump' -o -name 'vaysen-crm_*.dump.sha256' \) \
    -mtime "+$RETENTION_DAYS" -delete

info "verified snapshot created: $backup_file"
printf 'backupFile=%s\n' "$backup_file"
printf 'backupSha256=%s\n' "$checksum"
