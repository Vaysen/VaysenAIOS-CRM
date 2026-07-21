#!/usr/bin/env bash
# Verify a PostgreSQL custom-format dump and its SHA-256 sidecar without writes.

set -euo pipefail

BACKUP_FILE="${1:-}"
CONTAINER_NAME="${POSTGRES_CONTAINER:-vaysen-crm-postgres}"
fail() { printf '[DB BACKUP VERIFY ERROR] %s\n' "$*" >&2; exit 1; }

[ -n "$BACKUP_FILE" ] || fail "usage: $0 <backup-file.dump>"
[ -f "$BACKUP_FILE" ] && [ ! -L "$BACKUP_FILE" ] || fail "backup is missing or symlinked: $BACKUP_FILE"
[ -f "$BACKUP_FILE.sha256" ] && [ ! -L "$BACKUP_FILE.sha256" ] \
    || fail "backup checksum sidecar is missing or symlinked: $BACKUP_FILE.sha256"
expected="$(awk 'NR == 1 { print $1 }' "$BACKUP_FILE.sha256")"
[ "${#expected}" -eq 64 ] && printf '%s' "$expected" | grep -Eq '^[0-9a-fA-F]{64}$' \
    || fail "backup checksum sidecar is malformed"
[ "$(wc -l < "$BACKUP_FILE.sha256" | tr -d ' ')" -eq 1 ] \
    || fail "backup checksum sidecar must contain exactly one record"
actual="$(sha256sum "$BACKUP_FILE" | cut -d' ' -f1)"
[ "${expected,,}" = "$actual" ] || fail "backup checksum mismatch"
docker inspect -f '{{.State.Running}}' "$CONTAINER_NAME" 2>/dev/null | grep -qx true \
    || fail "PostgreSQL container is not running: $CONTAINER_NAME"
docker exec -i "$CONTAINER_NAME" pg_restore -l < "$BACKUP_FILE" >/dev/null 2>&1 \
    || fail "backup archive failed container pg_restore validation"
printf '[DB BACKUP VERIFY] valid snapshot: %s\n' "$BACKUP_FILE"
