#!/usr/bin/env bash
# Vaysen AI CRM database preflight.
# --backup: validate current PostgreSQL and create a rollback point before build.
# --candidate: after build, run Prisma status with the candidate backend image.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
COMPOSE_FILE="${COMPOSE_FILE:-$PROJECT_DIR/docker-compose.prod.yml}"
ENV_FILE="${ENV_FILE:-$PROJECT_DIR/.env}"
COMPOSE_PROJECT_NAME="${COMPOSE_PROJECT_NAME:-vaysen-ai-crm}"
MODE="${1:-}"

case "$MODE" in
    --backup|--candidate) ;;
    *) echo "Usage: $0 --backup|--candidate" >&2; exit 2 ;;
esac

compose() {
    docker compose --project-name "$COMPOSE_PROJECT_NAME" \
        --project-directory "$PROJECT_DIR" --env-file "$ENV_FILE" \
        -f "$COMPOSE_FILE" "$@"
}

err()  { printf '[PREFLIGHT ERROR] %s\n' "$*" >&2; }
ok()   { printf '[PREFLIGHT OK] %s\n' "$*"; }
warn() { printf '[PREFLIGHT WARN] %s\n' "$*"; }

cd "$PROJECT_DIR"

POSTGRES_CONTAINER_ID="$(compose ps -q postgres 2>/dev/null || true)"
POSTGRES_HEALTH=""
if [ -n "$POSTGRES_CONTAINER_ID" ]; then
    POSTGRES_HEALTH="$(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{end}}' "$POSTGRES_CONTAINER_ID" 2>/dev/null || true)"
fi
if [ "$POSTGRES_HEALTH" != "healthy" ]; then
    err "postgres is not healthy; deployment cannot continue"
    exit 1
fi
ok "current postgres is healthy"

if [ "$MODE" = "--backup" ]; then
    if [ ! -f "$SCRIPT_DIR/backup-db.sh" ]; then
        err "backup-db.sh is missing"
        exit 1
    fi
    BACKUP_DIR="${BACKUP_DIR:-/var/lib/vaysen-crm/backups}" \
        POSTGRES_CONTAINER="${POSTGRES_CONTAINER:-vaysen-crm-postgres}" \
        bash "$SCRIPT_DIR/backup-db.sh"
    ok "pre-build rollback backup completed and verified"
    exit 0
fi

# deploy.sh must build the immutable candidate image before invoking this mode.
# Compose run does not build unless --build is requested; --pull never also
# prevents a registry lookup from replacing the locally verified tag.
[ -n "${RELEASE_COMMIT_SHORT:-}" ] \
    || { err "RELEASE_COMMIT_SHORT is required for candidate preflight"; exit 1; }
[ -n "${RELEASE_COMMIT:-}" ] \
    || { err "RELEASE_COMMIT is required for candidate preflight ownership"; exit 1; }
printf '%s' "$RELEASE_COMMIT" | grep -Eqi '^[0-9a-f]{40}$' \
    || { err "RELEASE_COMMIT must be an immutable full SHA"; exit 1; }
CANDIDATE_PRISMA_STATUS_TIMEOUT_SECONDS="${CANDIDATE_PRISMA_STATUS_TIMEOUT_SECONDS:-60}"
[[ "$CANDIDATE_PRISMA_STATUS_TIMEOUT_SECONDS" =~ ^[1-9][0-9]*$ ]] \
    && [ "$CANDIDATE_PRISMA_STATUS_TIMEOUT_SECONDS" -le 120 ] \
    || { err "CANDIDATE_PRISMA_STATUS_TIMEOUT_SECONDS must be between 1 and 120"; exit 1; }
command -v timeout >/dev/null 2>&1 \
    || { err "GNU timeout is required for bounded candidate Prisma status"; exit 1; }
CANDIDATE_IMAGE="vaysen-crm-backend:${RELEASE_COMMIT_SHORT}"
docker image inspect "$CANDIDATE_IMAGE" >/dev/null 2>&1 \
    || { err "candidate image is missing: $CANDIDATE_IMAGE"; exit 1; }
CANDIDATE_STATUS_CONTAINER="vaysen-crm-prisma-status-${RELEASE_COMMIT_SHORT}"
CANDIDATE_STATUS_LABEL="com.vaysen.vaysen-crm.candidate-prisma-status"
cleanup_candidate_status_container() {
    if ! docker container inspect "$CANDIDATE_STATUS_CONTAINER" >/dev/null 2>&1; then
        return 0
    fi
    local owner_label
    owner_label="$(docker container inspect \
        -f "{{index .Config.Labels \"$CANDIDATE_STATUS_LABEL\"}}" \
        "$CANDIDATE_STATUS_CONTAINER" 2>/dev/null || true)"
    if [ "$owner_label" != "$RELEASE_COMMIT" ]; then
        err "refusing to remove an unowned candidate Prisma status container"
        return 1
    fi
    docker rm -f "$CANDIDATE_STATUS_CONTAINER" >/dev/null \
        || { err "failed to remove the owned candidate Prisma status container"; return 1; }
}

if docker container inspect "$CANDIDATE_STATUS_CONTAINER" >/dev/null 2>&1; then
    cleanup_candidate_status_container || exit 1
    err "removed an owned stale candidate Prisma status container; rerun the preflight"
    exit 1
fi

PREFILE="$(mktemp)"
trap 'rm -f "$PREFILE"' EXIT
set +e
timeout --signal=TERM --kill-after=10s "${CANDIDATE_PRISMA_STATUS_TIMEOUT_SECONDS}s" \
    docker compose --project-name "$COMPOSE_PROJECT_NAME" \
    --project-directory "$PROJECT_DIR" --env-file "$ENV_FILE" \
    -f "$COMPOSE_FILE" run --rm --no-deps --pull never \
    --name "$CANDIDATE_STATUS_CONTAINER" \
    --label "$CANDIDATE_STATUS_LABEL=$RELEASE_COMMIT" \
    -e RUN_MIGRATIONS=false -e RUN_SEED=false \
    backend npm run prisma:status > "$PREFILE" 2>&1
STATUS=$?
set -e
if [ "$STATUS" -ne 0 ]; then
    cleanup_candidate_status_container \
        || { sed 's/^/    /' "$PREFILE" >&2; exit 1; }
fi
if [ "$STATUS" -eq 124 ] || [ "$STATUS" -eq 137 ]; then
    err "candidate-image Prisma status exceeded ${CANDIDATE_PRISMA_STATUS_TIMEOUT_SECONDS}s"
    sed 's/^/    /' "$PREFILE" >&2
    exit 1
fi
if [ "$STATUS" -eq 0 ]; then
    if docker container inspect "$CANDIDATE_STATUS_CONTAINER" >/dev/null 2>&1; then
        cleanup_candidate_status_container || exit 1
        err "candidate Prisma status succeeded but its one-off container was left behind"
        exit 1
    fi
    if grep -Eqi "no pending migrations|Database schema is up to date" "$PREFILE"; then
        ok "candidate image reports no pending migrations"
    else
        warn "candidate image reports pending migrations; deploy.sh will apply them in its bounded one-off step"
        sed 's/^/    /' "$PREFILE"
    fi
elif grep -Eqi "migration(s)? (have|has) not yet been applied|Following migration.*not yet been applied" "$PREFILE" \
    && grep -Eqi "prisma migrate deploy|migrate deploy" "$PREFILE"; then
    # Prisma intentionally exits non-zero when production has legitimate
    # pending migrations. This is the expected candidate state: deploy.sh
    # applies the reviewed migration once inside its backup/timeout boundary.
    warn "candidate image contains reviewed pending migrations; deploy.sh will apply them once"
    sed 's/^/    /' "$PREFILE"
else
    err "candidate-image prisma migrate status failed unexpectedly (exit $STATUS)"
    sed 's/^/    /' "$PREFILE" >&2
    exit 1
fi

ok "candidate migration preflight passed"
