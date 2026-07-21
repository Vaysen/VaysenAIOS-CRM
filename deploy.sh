#!/usr/bin/env bash
# Vaysen AI CRM fail-closed production deployment.

set -euo pipefail
umask 077

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; BLUE='\033[0;34m'; NC='\033[0m'
fail() { echo -e "${RED}[DEPLOY ERROR] $*${NC}" >&2; exit 1; }
step() { echo -e "${YELLOW}$*${NC}"; }

PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LIFECYCLE_HELPER="$PROJECT_DIR/scripts/compose-container-lifecycle.sh"
[ -f "$LIFECYCLE_HELPER" ] && [ ! -L "$LIFECYCLE_HELPER" ] \
    || fail "container lifecycle helper is missing or symlinked"
COMPOSE_FILE="${COMPOSE_FILE:-$PROJECT_DIR/docker-compose.prod.yml}"
ENV_FILE="${ENV_FILE:-$PROJECT_DIR/.env}"
COMPOSE_PROJECT_NAME="${COMPOSE_PROJECT_NAME:-vaysen-ai-crm}"
BACKUP_DIR="${BACKUP_DIR:-/var/lib/vaysen-crm/backups}"
RELEASES_DIR="${RELEASES_DIR:-/var/lib/vaysen-crm/releases}"
RELEASE_TAG="${RELEASE_TAG:-}"
PREVIOUS_RELEASE_TAG="${PREVIOUS_RELEASE_TAG:-}"
RESOLVER="$PROJECT_DIR/scripts/resolve-release-revision.mjs"
MANIFEST_VALIDATOR="$PROJECT_DIR/scripts/validate-release-manifest.mjs"

[ -n "$RELEASE_TAG" ] || fail "RELEASE_TAG is required; mutable/default release labels are forbidden"
[ -n "$PREVIOUS_RELEASE_TAG" ] \
    || fail "PREVIOUS_RELEASE_TAG is required; rollback must target the last actually deployed annotated tag"
[ -f "$ENV_FILE" ] || fail "environment file is missing: $ENV_FILE"
[ -f "$COMPOSE_FILE" ] || fail "production compose file is missing: $COMPOSE_FILE"
command -v docker >/dev/null 2>&1 || fail "Docker is not installed"
docker compose version >/dev/null 2>&1 || fail "Docker Compose v2 plugin is required"
COMPOSE_UP_HELP="$(docker compose up --help 2>&1)" || fail "Docker Compose up help is unavailable"
printf '%s\n' "$COMPOSE_UP_HELP" | grep -F -- '--wait' >/dev/null \
    || fail "Docker Compose must support up --wait"
printf '%s\n' "$COMPOSE_UP_HELP" | grep -F -- '--wait-timeout' >/dev/null \
    || fail "Docker Compose must support up --wait-timeout"
COMPOSE_RUN_HELP="$(docker compose run --help 2>&1)" || fail "Docker Compose run help is unavailable"
printf '%s\n' "$COMPOSE_RUN_HELP" | grep -F -- '--name' >/dev/null \
    || fail "Docker Compose must support run --name"
printf '%s\n' "$COMPOSE_RUN_HELP" | grep -F -- '--label' >/dev/null \
    || fail "Docker Compose must support run --label"
command -v timeout >/dev/null 2>&1 || fail "GNU timeout is required for bounded production migrations"
command -v curl >/dev/null 2>&1 || fail "curl is required for published health recovery checks"
command -v node >/dev/null 2>&1 || fail "Node.js is required for release resolution"
command -v flock >/dev/null 2>&1 || fail "flock is required for single-owner deployment execution"
[ -f "$RESOLVER" ] || fail "release resolver is missing: $RESOLVER"
[ -f "$MANIFEST_VALIDATOR" ] || fail "release manifest validator is missing: $MANIFEST_VALIDATOR"
[ "$(node -p 'process.versions.node')" = "20.18.0" ] \
    || fail "host Node.js must be exactly 20.18.0"
git -C "$PROJECT_DIR" rev-parse --is-inside-work-tree >/dev/null 2>&1 \
    || fail "PROJECT_DIR must be a real Git worktree; copied loose files cannot resolve or archive releases"

compose() {
    docker compose --project-name "$COMPOSE_PROJECT_NAME" \
        --project-directory "$PROJECT_DIR" --env-file "$ENV_FILE" \
        -f "$COMPOSE_FILE" "$@"
}

env_value() {
    node - "$ENV_FILE" "$1" <<'NODE'
const fs = require('fs');
const [file, key] = process.argv.slice(2);
for (const raw of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
  const match = raw.trim().match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
  if (!match || match[1] !== key) continue;
  let value = match[2].trim();
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
  process.stdout.write(value);
  process.exit(0);
}
process.exit(1);
NODE
}

cd "$PROJECT_DIR"

step "[1/9] Validate manifest and resolve immutable release tag"
node "$MANIFEST_VALIDATOR" || fail "release manifest schema validation failed"
if ! RESOLVE_OUT="$(node "$RESOLVER" --check --tag "$RELEASE_TAG" 2>&1)"; then
    printf '%s\n' "$RESOLVE_OUT" >&2
    fail "release tag could not be resolved"
fi
RELEASE_COMMIT="$(printf '%s\n' "$RESOLVE_OUT" | sed -n 's/^releaseCommit=//p' | tail -1)"
RELEASE_COMMIT_SHORT="$(printf '%s\n' "$RESOLVE_OUT" | sed -n 's/^releaseCommitShort=//p' | tail -1)"
[ -n "$RELEASE_COMMIT" ] && [ -n "$RELEASE_COMMIT_SHORT" ] || fail "resolver returned an incomplete revision"
CURRENT_HEAD="$(git -C "$PROJECT_DIR" rev-parse --verify HEAD)" \
    || fail "current Git HEAD cannot be resolved"
[ "$CURRENT_HEAD" = "$RELEASE_COMMIT" ] \
    || fail "checked-out HEAD ($CURRENT_HEAD) does not match release tag commit ($RELEASE_COMMIT)"
[ -z "$(git -C "$PROJECT_DIR" status --porcelain=v1 --untracked-files=all)" ] \
    || fail "Git worktree is dirty; immutable release images must be built from the exact clean tag"
PREVIOUS_TAG="$PREVIOUS_RELEASE_TAG"
[ "$PREVIOUS_TAG" != "$RELEASE_TAG" ] \
    || fail "PREVIOUS_RELEASE_TAG must differ from RELEASE_TAG"
[ "$(git -C "$PROJECT_DIR" cat-file -t "refs/tags/$PREVIOUS_TAG" 2>/dev/null || true)" = "tag" ] \
    || fail "previous rollback anchor is not an annotated tag: $PREVIOUS_TAG"
PREVIOUS_COMMIT="$(git -C "$PROJECT_DIR" rev-parse --verify "${PREVIOUS_TAG}^{}" 2>/dev/null || true)"
[ -n "$PREVIOUS_COMMIT" ] \
    || fail "previous rollback anchor cannot be peeled to a commit: $PREVIOUS_TAG"
git -C "$PROJECT_DIR" merge-base --is-ancestor "$PREVIOUS_COMMIT" "$RELEASE_COMMIT" \
    || fail "previous rollback anchor is not an ancestor of the candidate release: $PREVIOUS_TAG"
export RELEASE_COMMIT RELEASE_COMMIT_SHORT RELEASE_TAG COMPOSE_FILE ENV_FILE COMPOSE_PROJECT_NAME BACKUP_DIR RELEASES_DIR
echo -e "${GREEN}release: $RELEASE_TAG -> $RELEASE_COMMIT${NC}"

step "[2/9] Validate production environment and filesystem security"
[ -f scripts/validate-production-env.mjs ] || fail "production environment validator is missing"
node scripts/validate-production-env.mjs "$ENV_FILE" || fail "production environment contract failed"
LAN_BIND_IP="$(env_value LAN_BIND_IP)" || fail "LAN_BIND_IP is missing"
LOCAL_LAN_BIND_IP="$(env_value LOCAL_LAN_BIND_IP)" || fail "LOCAL_LAN_BIND_IP is missing"
APP_DATA_DIR="$(env_value APP_DATA_DIR)" || fail "APP_DATA_DIR is missing"
APP_DATA_UID="$(env_value APP_DATA_UID 2>/dev/null || printf '999')"
APP_DATA_GID="$(env_value APP_DATA_GID 2>/dev/null || printf '999')"
[[ "$APP_DATA_UID" =~ ^[0-9]+$ ]] && [ "$APP_DATA_UID" -gt 0 ] \
    || fail "APP_DATA_UID must be a positive numeric container uid"
[[ "$APP_DATA_GID" =~ ^[0-9]+$ ]] && [ "$APP_DATA_GID" -gt 0 ] \
    || fail "APP_DATA_GID must be a positive numeric container gid"
NODE_IMAGE="$(env_value NODE_IMAGE)" || fail "NODE_IMAGE is missing"
POSTGRES_IMAGE="$(env_value POSTGRES_IMAGE)" || fail "POSTGRES_IMAGE is missing"
OPENCLAW_IMAGE="$(env_value OPENCLAW_IMAGE)" || fail "OPENCLAW_IMAGE is missing"
OPENCLAW_DATA_UID="$(env_value OPENCLAW_DATA_UID)" || fail "OPENCLAW_DATA_UID is missing"
OPENCLAW_DATA_GID="$(env_value OPENCLAW_DATA_GID)" || fail "OPENCLAW_DATA_GID is missing"
MIGRATION_REHEARSAL_DATA_ROOT="$(env_value MIGRATION_REHEARSAL_DATA_ROOT)" \
    || fail "MIGRATION_REHEARSAL_DATA_ROOT is missing"
MIGRATION_REHEARSAL_MAX_SECONDS="$(env_value MIGRATION_REHEARSAL_MAX_SECONDS 2>/dev/null || printf '90')"
MIGRATION_REHEARSAL_MAX_RESTORE_SECONDS="$(env_value MIGRATION_REHEARSAL_MAX_RESTORE_SECONDS 2>/dev/null || printf '900')"
PRODUCTION_MIGRATION_TIMEOUT_SECONDS="$(env_value PRODUCTION_MIGRATION_TIMEOUT_SECONDS 2>/dev/null || printf '120')"
[[ "$MIGRATION_REHEARSAL_MAX_SECONDS" =~ ^[1-9][0-9]*$ ]] \
    && [ "$MIGRATION_REHEARSAL_MAX_SECONDS" -le 90 ] \
    || fail "MIGRATION_REHEARSAL_MAX_SECONDS must be between 1 and 90"
[[ "$MIGRATION_REHEARSAL_MAX_RESTORE_SECONDS" =~ ^[1-9][0-9]*$ ]] \
    && [ "$MIGRATION_REHEARSAL_MAX_RESTORE_SECONDS" -ge 30 ] \
    && [ "$MIGRATION_REHEARSAL_MAX_RESTORE_SECONDS" -le 3600 ] \
    || fail "MIGRATION_REHEARSAL_MAX_RESTORE_SECONDS must be between 30 and 3600"
[[ "$PRODUCTION_MIGRATION_TIMEOUT_SECONDS" =~ ^[1-9][0-9]*$ ]] \
    && [ "$PRODUCTION_MIGRATION_TIMEOUT_SECONDS" -ge "$((MIGRATION_REHEARSAL_MAX_SECONDS + 30))" ] \
    && [ "$PRODUCTION_MIGRATION_TIMEOUT_SECONDS" -le 120 ] \
    || fail "PRODUCTION_MIGRATION_TIMEOUT_SECONDS must preserve 30s over rehearsal and be at most 120"
OPENCLAW_E2E_COMPANY_ID="${OPENCLAW_E2E_COMPANY_ID:-}"
OPENCLAW_E2E_REQUIRE_WECHAT_BOUND="${OPENCLAW_E2E_REQUIRE_WECHAT_BOUND:-false}"
OPENCLAW_E2E_OWNER_EMAIL="${OPENCLAW_E2E_OWNER_EMAIL:-$(env_value OPENCLAW_OWNER_EMAIL 2>/dev/null || true)}"
printf '%s' "$OPENCLAW_E2E_OWNER_EMAIL" \
    | grep -Eqi '^[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}$' \
    || fail "OPENCLAW_E2E_OWNER_EMAIL (or OPENCLAW_OWNER_EMAIL) must be a valid administrator email"
printf '%s' "$OPENCLAW_E2E_COMPANY_ID" | grep -Eqi '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' \
    || fail "OPENCLAW_E2E_COMPANY_ID must be the authenticated owner company UUID"
case "$OPENCLAW_E2E_REQUIRE_WECHAT_BOUND" in
    true|false) ;;
    *) fail "OPENCLAW_E2E_REQUIRE_WECHAT_BOUND must be true or false" ;;
esac
export LAN_BIND_IP LOCAL_LAN_BIND_IP APP_DATA_DIR APP_DATA_UID APP_DATA_GID NODE_IMAGE POSTGRES_IMAGE OPENCLAW_IMAGE OPENCLAW_DATA_UID OPENCLAW_DATA_GID MIGRATION_REHEARSAL_DATA_ROOT
PRE_CUTOVER_RECOVERY_TIMEOUT_SECONDS="${PRE_CUTOVER_RECOVERY_TIMEOUT_SECONDS:-${MAX_WAIT_SECONDS:-180}}"
[[ "$PRE_CUTOVER_RECOVERY_TIMEOUT_SECONDS" =~ ^[1-9][0-9]*$ ]] \
    && [ "$PRE_CUTOVER_RECOVERY_TIMEOUT_SECONDS" -le 600 ] \
    || fail "PRE_CUTOVER_RECOVERY_TIMEOUT_SECONDS must be between 1 and 600"
[ -f scripts/deploy-security-preflight.sh ] || fail "security preflight script is missing"
bash scripts/deploy-security-preflight.sh || fail "filesystem security preflight failed"
# The preflight above verifies ownership, mode and immutable Git content before
# this helper is sourced. A modified helper must never execute first.
# shellcheck source=scripts/compose-container-lifecycle.sh
source "$LIFECYCLE_HELPER"
compose_lifecycle_acquire_transaction_lock "$RELEASES_DIR" \
    || fail "could not acquire the production lifecycle transaction lock"

step "[3/9] Validate Compose model"
compose config -q || fail "docker compose config validation failed"
BACKUP_DIR="$BACKUP_DIR" RELEASES_DIR="$RELEASES_DIR" \
    bash scripts/rollback.sh --check-app --rev "$PREVIOUS_TAG" \
    || fail "previous release is not rollback-ready"

run_openclaw_e2e_auth_gate() {
    local mode="$1"
    (
        set -euo pipefail
        umask 077
        local token_file
        token_file="$(mktemp "$RELEASES_DIR/.openclaw-e2e-auth.XXXXXXXX.token")"
        trap 'rm -f -- "$token_file"' EXIT HUP INT TERM
        OPENCLAW_E2E_COMPANY_ID="$OPENCLAW_E2E_COMPANY_ID" \
        OPENCLAW_E2E_OWNER_EMAIL="$OPENCLAW_E2E_OWNER_EMAIL" \
        OPENCLAW_E2E_TOKEN_OUTPUT_FILE="$token_file" \
            bash scripts/mint-openclaw-e2e-token.sh
        OPENCLAW_E2E_BASE_URL="http://$LAN_BIND_IP" \
        OPENCLAW_E2E_BEARER_TOKEN_FILE="$token_file" \
        OPENCLAW_E2E_COMPANY_ID="$OPENCLAW_E2E_COMPANY_ID" \
        OPENCLAW_E2E_OWNER_EMAIL="$OPENCLAW_E2E_OWNER_EMAIL" \
            node scripts/verify-openclaw-e2e-auth.mjs
        if [ "$mode" = 'real-scene' ]; then
            OPENCLAW_E2E_BASE_URL="http://$LAN_BIND_IP" \
            OPENCLAW_E2E_BEARER_TOKEN_FILE="$token_file" \
            OPENCLAW_E2E_COMPANY_ID="$OPENCLAW_E2E_COMPANY_ID" \
            OPENCLAW_E2E_REQUIRE_WECHAT_BOUND="$OPENCLAW_E2E_REQUIRE_WECHAT_BOUND" \
                bash scripts/openclaw-real-scene-test.sh
        fi
    )
}

# Mint through the running backend, verify the real JWT guard and discard the
# short-lived token before any build or production stop. This catches stale
# administrator identity/configuration while the current release is intact.
run_openclaw_e2e_auth_gate auth-only \
    || fail "current release cannot mint and authenticate the OpenClaw E2E administrator before cutover"

step "[4/9] Back up the current database before building"
[ -f scripts/db-preflight.sh ] || fail "database preflight script is missing"
measure_production_database_bytes() {
    local measured
    measured="$(compose exec -T postgres sh -ceu \
        'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Atqc "SELECT pg_database_size(current_database());"' \
        | tr -d '[:space:]')" || return 1
    [[ "$measured" =~ ^[1-9][0-9]*$ ]] || return 1
    printf '%s' "$measured"
}
SOURCE_DATABASE_BYTES_BEFORE="$(measure_production_database_bytes)" \
    || fail "could not measure the production database size before backup"
PREBUILD_DB_OUTPUT="$(bash scripts/db-preflight.sh --backup)" || fail "pre-build database backup failed"
printf '%s\n' "$PREBUILD_DB_OUTPUT"
PREBUILD_DB_BACKUP="$(printf '%s\n' "$PREBUILD_DB_OUTPUT" | sed -n 's/^backupFile=//p' | tail -1)"
[ -n "$PREBUILD_DB_BACKUP" ] || fail "database backup script returned no pre-build archive path"
SOURCE_DATABASE_BYTES_AFTER="$(measure_production_database_bytes)" \
    || fail "could not measure the production database size after backup"
if [ "$SOURCE_DATABASE_BYTES_BEFORE" -gt "$SOURCE_DATABASE_BYTES_AFTER" ]; then
    SOURCE_DATABASE_BYTES="$SOURCE_DATABASE_BYTES_BEFORE"
else
    SOURCE_DATABASE_BYTES="$SOURCE_DATABASE_BYTES_AFTER"
fi

step "[5/9] Build immutable candidate images and rehearse the migration in isolation"
IMAGE_REUSE_SOURCE_TAG="${IMAGE_REUSE_SOURCE_TAG:-}"
if [ -n "$IMAGE_REUSE_SOURCE_TAG" ]; then
    [ -f scripts/reuse-release-images.sh ] \
        || fail "controlled release image reuse helper is missing"
    bash scripts/reuse-release-images.sh \
        --source-tag "$IMAGE_REUSE_SOURCE_TAG" \
        --release-tag "$RELEASE_TAG" \
        || fail "candidate image reuse failed closed"
else
    compose build || fail "candidate image build failed"
fi
compose pull openclaw-gateway || fail "digest-pinned OpenClaw image pull failed"
docker image inspect "$OPENCLAW_IMAGE" >/dev/null 2>&1 \
    || fail "reviewed OpenClaw image is missing after pull: $OPENCLAW_IMAGE"
for image in backend frontend backend-worker python-service; do
    image_ref="vaysen-crm-${image}:${RELEASE_COMMIT_SHORT}"
    docker image inspect "$image_ref" >/dev/null 2>&1 \
        || fail "candidate image is missing: $image_ref"
    image_revision="$(docker image inspect -f '{{ index .Config.Labels "org.opencontainers.image.revision" }}' "$image_ref" 2>/dev/null || true)"
    [ "$image_revision" = "$RELEASE_COMMIT" ] \
        || fail "candidate image revision label mismatch: $image_ref -> $image_revision"
done
[ -f scripts/rehearse-db-migration.sh ] || fail "isolated database migration rehearsal is missing"
MIGRATION_REHEARSAL_EVIDENCE="$RELEASES_DIR/${RELEASE_TAG}-${RELEASE_COMMIT_SHORT}-$(basename "$PREBUILD_DB_BACKUP" .dump)-migration-rehearsal.env"
bash scripts/rehearse-db-migration.sh \
    --backup "$PREBUILD_DB_BACKUP" \
    --postgres-image "$POSTGRES_IMAGE" \
    --candidate-image "vaysen-crm-backend:$RELEASE_COMMIT_SHORT" \
    --expected-revision "$RELEASE_COMMIT" \
    --source-database-bytes "$SOURCE_DATABASE_BYTES" \
    --data-root "$MIGRATION_REHEARSAL_DATA_ROOT" \
    --max-deploy-seconds "$MIGRATION_REHEARSAL_MAX_SECONDS" \
    --max-restore-seconds "$MIGRATION_REHEARSAL_MAX_RESTORE_SECONDS" \
    --evidence "$MIGRATION_REHEARSAL_EVIDENCE" \
    --confirm-isolated-rehearsal \
    || fail "candidate migration failed against the disposable restored production backup"
printf '[DEPLOY] migration rehearsal evidence: %s\n' "$MIGRATION_REHEARSAL_EVIDENCE"

# Exercise the complete network/package/patch/install/config path in an
# isolated state root before any production container is stopped. The real
# cutover repeats the bounded preparation against the backed-up runtime state.
OPENCLAW_PROBE_NAME="openclaw-prepare-${RELEASE_COMMIT_SHORT}-$$"
OPENCLAW_PROBE_ROOT="$MIGRATION_REHEARSAL_DATA_ROOT/$OPENCLAW_PROBE_NAME"
OPENCLAW_PROBE_PROJECT="${COMPOSE_PROJECT_NAME}-ocprobe-${RELEASE_COMMIT_SHORT}"
case "$OPENCLAW_PROBE_ROOT" in
    "$MIGRATION_REHEARSAL_DATA_ROOT"/openclaw-prepare-*) ;;
    *) fail "isolated OpenClaw probe path escaped the rehearsal root" ;;
esac
[ ! -e "$OPENCLAW_PROBE_ROOT" ] || fail "isolated OpenClaw probe root already exists: $OPENCLAW_PROBE_ROOT"
install -d -m 700 "$OPENCLAW_PROBE_ROOT" \
    || fail "could not create isolated OpenClaw probe root"
set +e
APP_DATA_DIR="$OPENCLAW_PROBE_ROOT" COMPOSE_PROJECT_NAME="$OPENCLAW_PROBE_PROJECT" \
NODE_IMAGE="$NODE_IMAGE" OPENCLAW_IMAGE="$OPENCLAW_IMAGE" \
OPENCLAW_DATA_UID="$OPENCLAW_DATA_UID" OPENCLAW_DATA_GID="$OPENCLAW_DATA_GID" \
    bash scripts/prepare-openclaw-runtime.sh
OPENCLAW_PROBE_STATUS=$?
APP_DATA_DIR="$OPENCLAW_PROBE_ROOT" docker compose --project-name "$OPENCLAW_PROBE_PROJECT" \
    --project-directory "$PROJECT_DIR" --env-file "$ENV_FILE" -f "$COMPOSE_FILE" \
    down --remove-orphans --volumes >/dev/null 2>&1
OPENCLAW_PROBE_DOWN_STATUS=$?
timeout --signal=TERM --kill-after=10s 60s docker run --rm --network none \
    --user 0 --cap-drop ALL --cap-add DAC_OVERRIDE --security-opt no-new-privileges \
    --log-driver none -v "$MIGRATION_REHEARSAL_DATA_ROOT:/rehearsals" "$NODE_IMAGE" sh -ceu '
      name="$1"
      case "$name" in
        openclaw-prepare-[0-9a-f]*-[0-9]*) ;;
        *) echo "invalid OpenClaw probe cleanup name" >&2; exit 1 ;;
      esac
      case "$name" in */*|*..*) exit 1 ;; esac
      target="/rehearsals/$name"
      test -d "$target" && test ! -L "$target"
      rm -rf -- "$target"
      test ! -e "$target"
    ' sh "$OPENCLAW_PROBE_NAME"
OPENCLAW_PROBE_CLEANUP_STATUS=$?
set -e
[ "$OPENCLAW_PROBE_DOWN_STATUS" -eq 0 ] \
    || fail "isolated OpenClaw probe Compose cleanup failed"
[ "$OPENCLAW_PROBE_CLEANUP_STATUS" -eq 0 ] \
    || fail "isolated OpenClaw probe state cleanup failed"
[ "$OPENCLAW_PROBE_STATUS" -eq 0 ] \
    || fail "isolated OpenClaw preparation failed before production stop"
printf '[DEPLOY] isolated OpenClaw preparation passed before production stop\n'

PRODUCTION_MIGRATION_CONTAINER="vaysen-crm-prisma-migrate-${RELEASE_COMMIT_SHORT}"
PRODUCTION_MIGRATION_LABEL="com.vaysen.vaysen-crm.production-migration"
docker container inspect "$PRODUCTION_MIGRATION_CONTAINER" >/dev/null 2>&1 \
    && fail "stale or foreign production migration container already exists: $PRODUCTION_MIGRATION_CONTAINER"

WORKERS=(worker-email-compose worker-email-validate worker-email-send worker-prospect-search worker-deep-research worker-maintenance)
compose_lifecycle_discover_vaysen-crm "$COMPOSE_PROJECT_NAME" true \
    || fail "could not establish an owned current-container inventory"
CUTOVER_PENDING=0

wait_current_backend_recovery() {
    local waited=0 state health
    while [ "$waited" -lt "$PRE_CUTOVER_RECOVERY_TIMEOUT_SECONDS" ]; do
        state="$(docker container inspect -f '{{.State.Status}}' vaysen-crm-backend 2>/dev/null || true)"
        health="$(docker container inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{end}}' vaysen-crm-backend 2>/dev/null || true)"
        if [ "$state" = 'running' ] && [ "$health" = 'healthy' ]; then
            return 0
        fi
        sleep 5
        waited=$((waited + 5))
    done
    printf '[DEPLOY RECOVERY ERROR] unchanged production backend did not become healthy within %ss\n' \
        "$PRE_CUTOVER_RECOVERY_TIMEOUT_SECONDS" >&2
    return 1
}

wait_current_published_health_recovery() {
    local waited=0 status_code
    while [ "$waited" -lt "$PRE_CUTOVER_RECOVERY_TIMEOUT_SECONDS" ]; do
        status_code="$(curl --noproxy '*' --silent --show-error --max-time 5 \
            --output /dev/null --write-out '%{http_code}' "http://$LAN_BIND_IP/health" 2>/dev/null || true)"
        if [ "$status_code" = '200' ]; then
            return 0
        fi
        sleep 5
        waited=$((waited + 5))
    done
    printf '[DEPLOY RECOVERY ERROR] published http://%s/health did not return 200 within %ss\n' \
        "$LAN_BIND_IP" "$PRE_CUTOVER_RECOVERY_TIMEOUT_SECONDS" >&2
    return 1
}

restart_current_on_pre_cutover_failure() {
    local status=$? recovery_failed=0
    trap - EXIT
    if [ "$status" -ne 0 ] && [ "$CUTOVER_PENDING" -eq 1 ]; then
        printf '[DEPLOY RECOVERY] pre-cutover step failed; restarting unchanged current backend/workers\n' >&2
        if ! compose_lifecycle_start_all; then
            printf '[DEPLOY RECOVERY ERROR] one or more unchanged current containers could not be started\n' >&2
            recovery_failed=1
        fi
        wait_current_backend_recovery || recovery_failed=1
        wait_current_published_health_recovery || recovery_failed=1
        if [ "$recovery_failed" -ne 0 ]; then
            printf '[DEPLOY RECOVERY ERROR] pre-cutover recovery did not restore a verified production service\n' >&2
            exit 1
        fi
        printf '[DEPLOY RECOVERY] unchanged production backend and published /health recovered\n' >&2
    fi
    exit "$status"
}
trap restart_current_on_pre_cutover_failure EXIT

step "[6/9] Quiesce current application and snapshot persistent runtime data"
compose exec -T backend sh -ceu 'mkdir -p /app/uploads /app/.customizer-assets /app/.whatsapp-sessions' \
    || fail "could not prepare current runtime directories for backup"
BACKUP_DIR="$BACKUP_DIR" APP_DATA_DIR="$APP_DATA_DIR" bash scripts/backup-runtime-data.sh --preflight \
    || fail "runtime backup capacity preflight failed"
compose_lifecycle_establish_writer_free_boundary "$COMPOSE_PROJECT_NAME" \
    || fail "could not establish a migration-writer-free backup boundary"
# From this point every trusted migration one-off is proven absent, so the
# pre-cutover trap may safely recover the unchanged regular application if a
# later snapshot or migration preflight fails. A boundary failure deliberately
# leaves this flag at zero because writer state may be indeterminate.
CUTOVER_PENDING=1
RUNTIME_OUTPUT="$(BACKUP_DIR="$BACKUP_DIR" APP_DATA_DIR="$APP_DATA_DIR" bash scripts/backup-runtime-data.sh)" \
    || fail "runtime data backup failed"
printf '%s\n' "$RUNTIME_OUTPUT"
RUNTIME_BACKUP="$(printf '%s\n' "$RUNTIME_OUTPUT" | sed -n 's/^runtimeBackup=//p' | tail -1)"
[ -n "$RUNTIME_BACKUP" ] || fail "runtime backup script returned no verified archive path"
QUIESCED_DB_OUTPUT="$(bash scripts/db-preflight.sh --backup)" || fail "quiesced database backup failed"
printf '%s\n' "$QUIESCED_DB_OUTPUT"
QUIESCED_DB_BACKUP="$(printf '%s\n' "$QUIESCED_DB_OUTPUT" | sed -n 's/^backupFile=//p' | tail -1)"
[ -n "$QUIESCED_DB_BACKUP" ] || fail "database backup script returned no verified archive path"
BACKUP_DIR="$BACKUP_DIR" RELEASES_DIR="$RELEASES_DIR" \
    bash scripts/rollback.sh --check --rev "$PREVIOUS_TAG" \
        --db-backup "$QUIESCED_DB_BACKUP" --runtime-backup "$RUNTIME_BACKUP" \
    || fail "verified data and previous release are not jointly rollback-ready"

step "[7/9] Check migrations with the built candidate image"
bash scripts/db-preflight.sh --candidate || fail "candidate migration preflight failed"

step "[8/9] Start candidate release and wait for health"
NODE_IMAGE="$NODE_IMAGE" OPENCLAW_IMAGE="$OPENCLAW_IMAGE" APP_DATA_DIR="$APP_DATA_DIR" APP_DATA_UID="$APP_DATA_UID" APP_DATA_GID="$APP_DATA_GID" \
    bash scripts/prepare-runtime-data.sh "$RUNTIME_BACKUP" || fail "runtime data migration/preflight failed"
CUTOVER_PENDING=0
trap - EXIT
POST_CUTOVER_ACTIVE=1
automatic_rollback_on_failure() {
    status=$?
    if [ "$status" -ne 0 ] && [ "$POST_CUTOVER_ACTIVE" -eq 1 ]; then
        printf '[DEPLOY RECOVERY] candidate verification failed; restoring %s with verified data snapshots\n' "$PREVIOUS_TAG" >&2
        if ! printf 'ROLLBACK\n' | bash scripts/rollback.sh \
            --db-backup "$QUIESCED_DB_BACKUP" --runtime-backup "$RUNTIME_BACKUP" --rev "$PREVIOUS_TAG"; then
            printf '[DEPLOY RECOVERY ERROR] automatic rollback failed. Run exactly:\n' >&2
            printf "  printf 'ROLLBACK\\n' | bash scripts/rollback.sh --db-backup %q --runtime-backup %q --rev %q\n" \
                "$QUIESCED_DB_BACKUP" "$RUNTIME_BACKUP" "$PREVIOUS_TAG" >&2
        fi
    fi
    exit "$status"
}
trap automatic_rollback_on_failure EXIT
APP_DATA_DIR="$APP_DATA_DIR" NODE_IMAGE="$NODE_IMAGE" OPENCLAW_IMAGE="$OPENCLAW_IMAGE" \
OPENCLAW_DATA_UID="$OPENCLAW_DATA_UID" OPENCLAW_DATA_GID="$OPENCLAW_DATA_GID" \
    bash scripts/prepare-openclaw-runtime.sh || fail "OpenClaw plugin/config preparation failed"

# Apply the reviewed migration in a bounded one-off container while the
# automatic DB/runtime rollback trap is active. The rehearsal budget is lower
# than this hard timeout, preserving at least 30 seconds of cutover margin.
docker container inspect "$PRODUCTION_MIGRATION_CONTAINER" >/dev/null 2>&1 \
    && fail "stale or foreign production migration container already exists: $PRODUCTION_MIGRATION_CONTAINER"
PRODUCTION_MIGRATION_STARTED_AT="$(date +%s)"
set +e
timeout --signal=TERM --kill-after=30s "${PRODUCTION_MIGRATION_TIMEOUT_SECONDS}s" \
    docker compose --project-name "$COMPOSE_PROJECT_NAME" \
      --project-directory "$PROJECT_DIR" --env-file "$ENV_FILE" -f "$COMPOSE_FILE" \
      run --rm --no-deps --pull never --name "$PRODUCTION_MIGRATION_CONTAINER" \
      --label "$PRODUCTION_MIGRATION_LABEL=$RELEASE_COMMIT" \
      -e RUN_MIGRATIONS=false -e RUN_SEED=false \
      backend npm run prisma:deploy
PRODUCTION_MIGRATION_STATUS=$?
set -e
PRODUCTION_MIGRATION_SECONDS=$(( $(date +%s) - PRODUCTION_MIGRATION_STARTED_AT ))
if [ "$PRODUCTION_MIGRATION_STATUS" -ne 0 ]; then
    if docker container inspect "$PRODUCTION_MIGRATION_CONTAINER" >/dev/null 2>&1; then
        migration_label="$(docker container inspect -f "{{index .Config.Labels \"$PRODUCTION_MIGRATION_LABEL\"}}" "$PRODUCTION_MIGRATION_CONTAINER" 2>/dev/null || true)"
        [ "$migration_label" = "$RELEASE_COMMIT" ] \
            || fail "refusing to remove an unowned migration container after failure"
        docker rm -f "$PRODUCTION_MIGRATION_CONTAINER" >/dev/null \
            || fail "failed to stop the timed-out production migration container"
    fi
    fail "production Prisma migration failed or exceeded ${PRODUCTION_MIGRATION_TIMEOUT_SECONDS}s (exit $PRODUCTION_MIGRATION_STATUS)"
fi
if docker container inspect "$PRODUCTION_MIGRATION_CONTAINER" >/dev/null 2>&1; then
    migration_label="$(docker container inspect -f "{{index .Config.Labels \"$PRODUCTION_MIGRATION_LABEL\"}}" "$PRODUCTION_MIGRATION_CONTAINER" 2>/dev/null || true)"
    [ "$migration_label" = "$RELEASE_COMMIT" ] \
        || fail "successful migration left an unowned container with the reserved name"
    docker rm -f "$PRODUCTION_MIGRATION_CONTAINER" >/dev/null \
        || fail "successful migration container was not removed"
    fail "production migration command succeeded but its one-off container was left behind"
fi
[ "$PRODUCTION_MIGRATION_SECONDS" -le "$PRODUCTION_MIGRATION_TIMEOUT_SECONDS" ] \
    || fail "production Prisma migration exceeded its hard time budget"
printf '[DEPLOY] production migration completed in %ss (limit %ss)\n' \
    "$PRODUCTION_MIGRATION_SECONDS" "$PRODUCTION_MIGRATION_TIMEOUT_SECONDS"
# The bounded one-off migration above is the only production migration owner.
# Keep all six workers, frontend, n8n and OpenClaw stopped until backend reports
# healthy, so no candidate process observes a partial enum/DDL transition.
compose up -d --no-build --wait --wait-timeout "${MAX_WAIT_SECONDS:-180}" \
    postgres redis python-service backend \
    || fail "candidate backend migration/startup did not become healthy before dependent services"
compose up -d --no-build || fail "candidate startup failed"

wait_service() {
    local service="$1" require_health="$2" waited=0 container state health
    printf '  waiting for %s ' "$service"
    while [ "$waited" -lt "${MAX_WAIT_SECONDS:-180}" ]; do
        container="$(compose ps -q "$service" 2>/dev/null || true)"
        if [ -n "$container" ]; then
            state="$(docker inspect -f '{{.State.Status}}' "$container" 2>/dev/null || true)"
            health="$(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{end}}' "$container" 2>/dev/null || true)"
            if [ "$state" = "running" ] && { [ "$require_health" = "no" ] || [ "$health" = "healthy" ]; }; then
                echo -e " ${GREEN}OK${NC}"
                return 0
            fi
        fi
        printf '.'
        sleep 5
        waited=$((waited + 5))
    done
    echo
    return 1
}

for service in postgres redis backend frontend python-service openclaw-gateway; do
    wait_service "$service" yes || fail "$service did not become healthy"
done
for service in nginx reacher searxng n8n; do
    wait_service "$service" no || fail "$service did not reach running state"
done
for service in "${WORKERS[@]}"; do
    wait_service "$service" yes || fail "$service did not pass the Prisma/Redis health check"
done

step "[9/9] Run fail-closed deployment smoke test"
[ -f scripts/deploy-smoke-test.sh ] || fail "deployment smoke test is missing"
bash scripts/deploy-smoke-test.sh || fail "deployment smoke test failed; run rollback.sh with the recorded backup and previous tag"
bash scripts/openclaw-runtime-smoke-test.sh \
    || fail "OpenClaw runtime/model smoke failed; automatic rollback will restore the previous release"
run_openclaw_e2e_auth_gate real-scene \
    || fail "authenticated CRM -> OpenClaw -> HMAC broker -> database E2E failed; automatic rollback will restore the previous release"
NGINX_BINDINGS="$(docker inspect -f '{{range $port, $bindings := .NetworkSettings.Ports}}{{range $bindings}}{{println .HostIp .HostPort}}{{end}}{{end}}' vaysen-crm-nginx)"
[ "$(printf '%s\n' "$NGINX_BINDINGS" | sed '/^$/d' | wc -l)" -eq 2 ] \
    && [ "$(printf '%s\n' "$NGINX_BINDINGS" | grep -Fxc "$LAN_BIND_IP 80")" -eq 1 ] \
    && [ "$(printf '%s\n' "$NGINX_BINDINGS" | grep -Fxc "$LOCAL_LAN_BIND_IP 80")" -eq 1 ] \
    || fail "nginx is not published exclusively on the approved ZeroTier/LAN addresses"
if printf '%s\n' "$NGINX_BINDINGS" | grep -Eq '^(0\.0\.0\.0|::) | 443$'; then
    fail "nginx unexpectedly exposes a wildcard or TLS listener"
fi
POST_CUTOVER_ACTIVE=0
trap - EXIT

echo -e "${BLUE}========================================${NC}"
echo -e "${GREEN}Deployment infrastructure and authenticated CRM execution verified${NC}"
if [ "$OPENCLAW_E2E_REQUIRE_WECHAT_BOUND" = 'true' ]; then
    echo -e "${GREEN}Owner WeChat QR binding and command permission verified${NC}"
else
    echo -e "${YELLOW}Owner WeChat final acceptance is pending QR scan plus a bound command; rerun openclaw-real-scene-test.sh with OPENCLAW_E2E_REQUIRE_WECHAT_BOUND=true before customer delivery${NC}"
fi
echo -e "release tag:    $RELEASE_TAG"
echo -e "release commit: $RELEASE_COMMIT"
echo -e "previous tag:   $PREVIOUS_TAG"
echo -e "backup dir:     $BACKUP_DIR"
echo -e "database backup: $QUIESCED_DB_BACKUP"
echo -e "runtime backup:  $RUNTIME_BACKUP"
compose ps
