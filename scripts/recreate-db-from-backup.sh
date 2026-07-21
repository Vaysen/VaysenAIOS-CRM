#!/usr/bin/env bash
# Destructively recreate one PostgreSQL database from a verified custom-format
# backup. Callers must stop every application writer before invoking this file.

set -euo pipefail
umask 077

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BACKUP_FILE=""
POSTGRES_CONTAINER="${POSTGRES_CONTAINER:-vaysen-crm-postgres}"
DB_USER="${POSTGRES_USER:-vaysen-crm}"
DB_NAME="${POSTGRES_DB:-vaysen-crm_pilot}"
CONFIRMED=0
MAX_RESTORE_SECONDS="${DB_RESTORE_TIMEOUT_SECONDS:-900}"

fail() { printf '[DB RECREATE ERROR] %s\n' "$*" >&2; exit 1; }
info() { printf '[DB RECREATE] %s\n' "$*"; }
usage() {
    cat >&2 <<'USAGE'
Usage: bash scripts/recreate-db-from-backup.sh \
  --backup /absolute/path/vaysen-crm_<timestamp>.dump \
  [--container vaysen-crm-postgres] [--user vaysen-crm] [--database vaysen-crm_pilot] \
  [--max-restore-seconds 900] \
  --confirm-database-recreate

All application writers and migration one-off containers must already be stopped.
USAGE
    exit 2
}

while [ "$#" -gt 0 ]; do
    case "$1" in
        --backup) [ "$#" -ge 2 ] || usage; BACKUP_FILE="$2"; shift 2 ;;
        --container) [ "$#" -ge 2 ] || usage; POSTGRES_CONTAINER="$2"; shift 2 ;;
        --user) [ "$#" -ge 2 ] || usage; DB_USER="$2"; shift 2 ;;
        --database) [ "$#" -ge 2 ] || usage; DB_NAME="$2"; shift 2 ;;
        --max-restore-seconds) [ "$#" -ge 2 ] || usage; MAX_RESTORE_SECONDS="$2"; shift 2 ;;
        --confirm-database-recreate) CONFIRMED=1; shift ;;
        -h|--help) usage ;;
        *) fail "unknown argument: $1" ;;
    esac
done

[ "$CONFIRMED" -eq 1 ] || fail 'explicit --confirm-database-recreate acknowledgement is required'
[ -n "$BACKUP_FILE" ] || usage
[[ "$BACKUP_FILE" = /* ]] || fail '--backup must be an absolute Linux path'
[[ "$POSTGRES_CONTAINER" =~ ^[A-Za-z0-9][A-Za-z0-9_.-]*$ ]] \
    || fail 'container name contains unsafe characters'
[[ "$DB_USER" =~ ^[A-Za-z_][A-Za-z0-9_]*$ ]] \
    || fail 'database user is not a safe PostgreSQL identifier'
[[ "$DB_NAME" =~ ^[A-Za-z_][A-Za-z0-9_]*$ ]] \
    || fail 'database name is not a safe PostgreSQL identifier'
[[ "$MAX_RESTORE_SECONDS" =~ ^[1-9][0-9]*$ ]] \
    && [ "$MAX_RESTORE_SECONDS" -ge 30 ] && [ "$MAX_RESTORE_SECONDS" -le 3600 ] \
    || fail '--max-restore-seconds must be between 30 and 3600'
case "$DB_NAME" in
    postgres|template0|template1) fail "refusing to recreate protected database: $DB_NAME" ;;
esac
[ -f "$BACKUP_FILE" ] && [ ! -L "$BACKUP_FILE" ] \
    || fail "backup is missing or symlinked: $BACKUP_FILE"
docker inspect -f '{{.State.Running}}' "$POSTGRES_CONTAINER" 2>/dev/null | grep -qx true \
    || fail "PostgreSQL container is not running: $POSTGRES_CONTAINER"
command -v timeout >/dev/null 2>&1 || fail 'GNU timeout is required for a bounded restore'

# Bind the destructive target to the container's immutable launch contract.
# Never trust a drifting caller shell or .env file to choose a different
# database/user in the same PostgreSQL cluster.
CONTAINER_ENV="$(docker inspect --format '{{range .Config.Env}}{{println .}}{{end}}' "$POSTGRES_CONTAINER" 2>/dev/null)" \
    || fail 'could not inspect the PostgreSQL container environment'
mapfile -t CONTAINER_DB_USERS < <(printf '%s\n' "$CONTAINER_ENV" | sed -n 's/^POSTGRES_USER=//p')
mapfile -t CONTAINER_DB_NAMES < <(printf '%s\n' "$CONTAINER_ENV" | sed -n 's/^POSTGRES_DB=//p')
[ "${#CONTAINER_DB_USERS[@]}" -eq 1 ] && [ "${#CONTAINER_DB_NAMES[@]}" -eq 1 ] \
    || fail 'PostgreSQL container must declare exactly one POSTGRES_USER and POSTGRES_DB'
[ "${CONTAINER_DB_USERS[0]}" = "$DB_USER" ] \
    || fail 'requested database user does not match the PostgreSQL container launch contract'
[ "${CONTAINER_DB_NAMES[0]}" = "$DB_NAME" ] \
    || fail 'requested database name does not match the PostgreSQL container launch contract'

# Perform every validation before DROP DATABASE. This helper intentionally uses
# the same checked archive contract as backup/rollback/deploy.
POSTGRES_CONTAINER="$POSTGRES_CONTAINER" \
    bash "$SCRIPT_DIR/verify-db-backup.sh" "$BACKUP_FILE" >/dev/null \
    || fail 'backup checksum or custom archive validation failed'

info "recreating database $DB_NAME from a verified snapshot"
if ! docker exec -i "$POSTGRES_CONTAINER" \
    psql -v ON_ERROR_STOP=1 -U "$DB_USER" -d postgres \
      -v target_db="$DB_NAME" -v target_owner="$DB_USER" >/dev/null <<'SQL'
SELECT format('DROP DATABASE IF EXISTS %I WITH (FORCE)', :'target_db')
\gexec
SELECT format('CREATE DATABASE %I WITH OWNER %I TEMPLATE template0', :'target_db', :'target_owner')
\gexec
SQL
then
    fail 'database drop/recreate failed; application processes must remain stopped'
fi

# The target is empty, so --clean is neither needed nor sufficient. A single
# restore transaction guarantees that failure leaves the newly-created database
# empty rather than exposing a partially restored schema.
RESTORE_STARTED_AT="$(date +%s)"
set +e
timeout --signal=TERM --kill-after=30s "${MAX_RESTORE_SECONDS}s" \
  docker exec -i "$POSTGRES_CONTAINER" \
    pg_restore -U "$DB_USER" -d "$DB_NAME" \
      --no-owner --no-privileges --exit-on-error --single-transaction \
      < "$BACKUP_FILE"
RESTORE_STATUS=$?
set -e
RESTORE_SECONDS=$(( $(date +%s) - RESTORE_STARTED_AT ))
if [ "$RESTORE_STATUS" -ne 0 ]; then
    # Killing the host docker-exec client is not sufficient proof that its
    # server-side exec process stopped: the exec may connect after a termination
    # query has already observed zero sessions. Stop the whole disposable or
    # production PostgreSQL container and prove it is stopped before returning.
    # Callers intentionally keep every application service stopped on this path.
    docker stop --time 10 "$POSTGRES_CONTAINER" >/dev/null 2>&1 \
        || docker kill "$POSTGRES_CONTAINER" >/dev/null 2>&1 \
        || fail 'failed restore may still be running because PostgreSQL could not be stopped; application processes must remain stopped'

    POSTGRES_RUNNING="$(docker inspect --format '{{.State.Running}}' "$POSTGRES_CONTAINER" 2>/dev/null || printf 'unknown')"
    if [ "$POSTGRES_RUNNING" != 'false' ]; then
        docker kill "$POSTGRES_CONTAINER" >/dev/null 2>&1 || true
        POSTGRES_RUNNING="$(docker inspect --format '{{.State.Running}}' "$POSTGRES_CONTAINER" 2>/dev/null || printf 'unknown')"
    fi
    [ "$POSTGRES_RUNNING" = 'false' ] \
        || fail 'failed restore may still be running because the stopped PostgreSQL state could not be proven; application processes must remain stopped'

    fail "snapshot restore failed or exceeded ${MAX_RESTORE_SECONDS}s (exit $RESTORE_STATUS); PostgreSQL was stopped and application processes must remain stopped"
fi
[ "$RESTORE_SECONDS" -le "$MAX_RESTORE_SECONDS" ] \
    || fail 'snapshot restore exceeded its hard time budget; application processes must remain stopped'

RESTORED_LEDGER="$(docker exec "$POSTGRES_CONTAINER" \
    psql -U "$DB_USER" -d "$DB_NAME" -Atqc \
      "SELECT to_regclass('public.\"_prisma_migrations\"') IS NOT NULL;")"
[ "$RESTORED_LEDGER" = 't' ] \
    || fail 'restored database is missing the Prisma migration ledger; application processes must remain stopped'

info 'database recreation and transactional snapshot restore completed'
printf 'databaseRecreated=%s\n' "$DB_NAME"
printf 'databaseBackup=%s\n' "$BACKUP_FILE"
printf 'databaseRestoreSeconds=%s\n' "$RESTORE_SECONDS"
printf 'databaseRestoreLimitSeconds=%s\n' "$MAX_RESTORE_SECONDS"
