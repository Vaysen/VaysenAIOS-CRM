#!/bin/bash
# =============================================================================
# Vaysen Pilot — Database Restore Script
# =============================================================================
# Usage: ./scripts/restore-db.sh <backup_file.dump>
#
# WARNING: This will OVERWRITE the current database.
# A confirmation prompt is shown before proceeding.
# =============================================================================
set -euo pipefail
restore_fail() { printf '[ERROR] %s\n' "$*" >&2; exit 1; }

if [ $# -lt 1 ]; then
    echo "Usage: $0 <backup_file.dump>"
    echo ""
    echo "Available backups:"
    ls -lh "${BACKUP_DIR:-/var/lib/vaysen-crm/backups}/"*.dump 2>/dev/null || echo "  (none found)"
    exit 1
fi

BACKUP_FILE="$1"

if [ ! -f "$BACKUP_FILE" ] || [ -L "$BACKUP_FILE" ]; then
    echo "[ERROR] Backup file is missing or symlinked: $BACKUP_FILE"
    exit 1
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
LIFECYCLE_HELPER="$SCRIPT_DIR/compose-container-lifecycle.sh"
if [ ! -f "$LIFECYCLE_HELPER" ] || [ -L "$LIFECYCLE_HELPER" ]; then
    restore_fail "Lifecycle helper is missing or symlinked: $LIFECYCLE_HELPER"
fi
git -C "$PROJECT_DIR" rev-parse --is-inside-work-tree >/dev/null 2>&1 \
    || restore_fail "Project directory is not a Git worktree."
git -C "$PROJECT_DIR" ls-files --error-unmatch -- scripts/compose-container-lifecycle.sh >/dev/null 2>&1 \
    && git -C "$PROJECT_DIR" diff --quiet HEAD -- scripts/compose-container-lifecycle.sh \
    || restore_fail "Lifecycle helper does not match immutable HEAD."
[ "$(stat -c '%u' "$LIFECYCLE_HELPER")" = "$(id -u)" ] \
    || restore_fail "Lifecycle helper must be owned by the restore user."
LIFECYCLE_MODE="$(stat -c '%a' "$LIFECYCLE_HELPER")"
[ $((8#$LIFECYCLE_MODE & 0022)) -eq 0 ] \
    || restore_fail "Lifecycle helper must not be group/world writable."
# shellcheck source=compose-container-lifecycle.sh
source "$LIFECYCLE_HELPER"
ENV_FILE="${ENV_FILE:-$PROJECT_DIR/.env}"
RELEASES_DIR="${RELEASES_DIR:-/var/lib/vaysen-crm/releases}"
BACKUP_DIR="${BACKUP_DIR:-/var/lib/vaysen-crm/backups}"
COMPOSE_PROJECT_NAME="${COMPOSE_PROJECT_NAME:-vaysen-ai-crm}"

compose() {
    docker compose --project-name "$COMPOSE_PROJECT_NAME" \
        --project-directory "$PROJECT_DIR" --env-file "$ENV_FILE" \
        -f "$PROJECT_DIR/docker-compose.prod.yml" "$@"
}

# Validate checksum and archive with the matching PostgreSQL client before
# stopping any application process. The host does not need pg_restore.
POSTGRES_CONTAINER="${POSTGRES_CONTAINER:-vaysen-crm-postgres}" \
    bash "$SCRIPT_DIR/verify-db-backup.sh" "$BACKUP_FILE" \
    || exit 1

echo "============================================"
echo " Vaysen Pilot — Database Restore"
echo "============================================"
echo ""
echo "WARNING: This will OVERWRITE the current database with:"
echo "  $BACKUP_FILE ($(du -h "$BACKUP_FILE" | cut -f1))"
echo ""
echo "All current data will be lost."
echo ""
read -rp "Type 'RESTORE' to confirm: " CONFIRM

if [ "$CONFIRM" != "RESTORE" ]; then
    echo "Restore cancelled."
    exit 2
fi

compose_lifecycle_acquire_transaction_lock "$RELEASES_DIR" \
    || restore_fail "Could not acquire the production lifecycle transaction lock."
[ -d "$BACKUP_DIR" ] && [ ! -L "$BACKUP_DIR" ] \
    || restore_fail "Backup directory is missing or symlinked: $BACKUP_DIR"
DATABASE_LOCK="$BACKUP_DIR/.database-backup.lock"
[ ! -L "$DATABASE_LOCK" ] \
    || restore_fail "Database backup lock must not be a symlink."
exec 7>>"$DATABASE_LOCK"
chmod 600 "$DATABASE_LOCK"
flock -n 7 || restore_fail "A database backup/restore transaction is already running."
POSTGRES_CONTAINER="${POSTGRES_CONTAINER:-vaysen-crm-postgres}" \
    bash "$SCRIPT_DIR/verify-db-backup.sh" "$BACKUP_FILE" \
    || restore_fail "Backup changed or failed validation after the restore lock was acquired."

compose_lifecycle_discover_vaysen-crm "$COMPOSE_PROJECT_NAME" true \
    || { echo "[ERROR] Could not establish an owned current-container inventory." >&2; exit 1; }

restart_current_app() {
    compose_lifecycle_start_all
}

remove_owned_migration_oneoffs() {
    compose_lifecycle_remove_production_migration_oneoffs "$COMPOSE_PROJECT_NAME"
}

echo "[$(date)] Stopping backend and workers..."
compose_lifecycle_stop_all \
    || { echo "[ERROR] One or more owned application writers could not be stopped safely." >&2; exit 1; }
remove_owned_migration_oneoffs \
    || { echo "[ERROR] Database writers could not be stopped; application remains stopped." >&2; exit 1; }

echo "[$(date)] Restoring database..."
if [ ! -f "$SCRIPT_DIR/recreate-db-from-backup.sh" ] || [ -L "$SCRIPT_DIR/recreate-db-from-backup.sh" ]; then
    echo "[ERROR] Database recreation helper is missing or symlinked; application remains stopped." >&2
    exit 1
fi
if ! bash "$SCRIPT_DIR/recreate-db-from-backup.sh" \
    --backup "$BACKUP_FILE" --container "${POSTGRES_CONTAINER:-vaysen-crm-postgres}" \
    --user "${POSTGRES_USER:-vaysen-crm}" --database "${POSTGRES_DB:-vaysen-crm_pilot}" \
    --confirm-database-recreate; then
    echo "[ERROR] Restore failed; application remains stopped to protect the empty or partially recovered database." >&2
    exit 1
fi

echo "[$(date)] Starting backend and workers..."
restart_current_app \
    || { echo "[ERROR] Database restored but the inventoried application containers did not restart." >&2; exit 1; }
echo "[$(date)] Every originally running application writer recovered with its original ID, restart count, and healthy stability window."

echo "[$(date)] Restore complete."
echo "Check: docker compose -f docker-compose.prod.yml logs backend"
