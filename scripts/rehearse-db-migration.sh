#!/usr/bin/env bash
# Rehearse the candidate Prisma migration against a verified production backup
# in disposable Docker resources. This script never joins a production network,
# never publishes a port, and never opens or mounts a production database volume.

set -euo pipefail
umask 077

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
FOUNDATION_MIGRATION="20260718170000_owner_notification_outbox"
FOLLOWUP_MIGRATION="20260718193000_openclaw_lead_selection"
TARGET_MIGRATION="20260719211500_backfill_verified_direct_whatsapp_group_status"
TARGET_MIGRATION_FILE="$PROJECT_DIR/backend/prisma/migrations/$TARGET_MIGRATION/migration.sql"
MIGRATION_LOCK_FILE="$PROJECT_DIR/backend/prisma/migrations/migration_lock.toml"
MODE_SELECTOR="$PROJECT_DIR/scripts/select-migration-rehearsal-mode.sh"
LABEL_KEY="com.vaysen.vaysen-crm.migration-rehearsal"

BACKUP_FILE=""
POSTGRES_IMAGE=""
CANDIDATE_IMAGE=""
EXPECTED_REVISION=""
EVIDENCE_FILE=""
SOURCE_DATABASE_BYTES=""
REHEARSAL_DATA_ROOT=""
MAX_DEPLOY_SECONDS="90"
MAX_RESTORE_SECONDS="900"
CONFIRMED=0

usage() {
    cat >&2 <<'USAGE'
Usage:
  bash scripts/rehearse-db-migration.sh \
    --backup /absolute/path/vaysen-crm_YYYYMMDD_HHMMSS_NNNNNNNNN.dump \
    --postgres-image 'postgres@sha256:<64 hex>' \
    --candidate-image 'vaysen-crm-backend:<release revision>' \
    --expected-revision '<40 hex Git commit>' \
    --source-database-bytes '<pg_database_size result>' \
    --data-root /absolute/dedicated/rehearsal/path \
    --max-deploy-seconds 90 \
    --max-restore-seconds 900 \
    --evidence /absolute/path/migration-rehearsal-v1.4.20.env \
    --confirm-isolated-rehearsal

The backup must have a matching .sha256 sidecar. The evidence path must not
already exist. No value is read from the production .env file.
USAGE
    exit 2
}

while [ "$#" -gt 0 ]; do
    case "$1" in
        --backup)
            [ "$#" -ge 2 ] || usage
            BACKUP_FILE="$2"
            shift 2
            ;;
        --postgres-image)
            [ "$#" -ge 2 ] || usage
            POSTGRES_IMAGE="$2"
            shift 2
            ;;
        --candidate-image)
            [ "$#" -ge 2 ] || usage
            CANDIDATE_IMAGE="$2"
            shift 2
            ;;
        --expected-revision)
            [ "$#" -ge 2 ] || usage
            EXPECTED_REVISION="$2"
            shift 2
            ;;
        --evidence)
            [ "$#" -ge 2 ] || usage
            EVIDENCE_FILE="$2"
            shift 2
            ;;
        --source-database-bytes)
            [ "$#" -ge 2 ] || usage
            SOURCE_DATABASE_BYTES="$2"
            shift 2
            ;;
        --data-root)
            [ "$#" -ge 2 ] || usage
            REHEARSAL_DATA_ROOT="$2"
            shift 2
            ;;
        --max-deploy-seconds)
            [ "$#" -ge 2 ] || usage
            MAX_DEPLOY_SECONDS="$2"
            shift 2
            ;;
        --max-restore-seconds)
            [ "$#" -ge 2 ] || usage
            MAX_RESTORE_SECONDS="$2"
            shift 2
            ;;
        --confirm-isolated-rehearsal)
            CONFIRMED=1
            shift
            ;;
        -h|--help) usage ;;
        *) printf '[MIGRATION REHEARSAL ERROR] unknown argument: %s\n' "$1" >&2; usage ;;
    esac
done

fail() {
    if [ -n "${STORAGE_GUARD_FILE:-}" ] && [ -f "$STORAGE_GUARD_FILE" ]; then
        printf '[MIGRATION REHEARSAL ERROR] storage reserve guard stopped the disposable database\n' >&2
    fi
    printf '[MIGRATION REHEARSAL ERROR] %s\n' "$*" >&2
    exit 1
}
info() { printf '[MIGRATION REHEARSAL] %s\n' "$*"; }

[ "$CONFIRMED" -eq 1 ] \
    || fail 'explicit --confirm-isolated-rehearsal acknowledgement is required'
[ -n "$BACKUP_FILE" ] && [ -n "$POSTGRES_IMAGE" ] && [ -n "$CANDIDATE_IMAGE" ] \
    && [ -n "$EXPECTED_REVISION" ] && [ -n "$SOURCE_DATABASE_BYTES" ] \
    && [ -n "$REHEARSAL_DATA_ROOT" ] && [ -n "$EVIDENCE_FILE" ] || usage
[[ "$EXPECTED_REVISION" =~ ^[a-f0-9]{40}$ ]] \
    || fail '--expected-revision must be a lowercase full Git SHA'
[[ "$POSTGRES_IMAGE" =~ @sha256:[a-f0-9]{64}$ ]] \
    || fail '--postgres-image must be an immutable repository@sha256 reference'
[[ "$CANDIDATE_IMAGE" != *:latest ]] \
    || fail 'mutable candidate image tag latest is forbidden'
[[ "$SOURCE_DATABASE_BYTES" =~ ^[1-9][0-9]*$ ]] && [ "$SOURCE_DATABASE_BYTES" -le 1152921504606846976 ] \
    || fail '--source-database-bytes must be a positive, bounded integer'
[[ "$MAX_DEPLOY_SECONDS" =~ ^[1-9][0-9]*$ ]] && [ "$MAX_DEPLOY_SECONDS" -le 120 ] \
    || fail '--max-deploy-seconds must be between 1 and 120'
[[ "$MAX_RESTORE_SECONDS" =~ ^[1-9][0-9]*$ ]] \
    && [ "$MAX_RESTORE_SECONDS" -ge 30 ] && [ "$MAX_RESTORE_SECONDS" -le 3600 ] \
    || fail '--max-restore-seconds must be between 30 and 3600'
[[ "$BACKUP_FILE" = /* ]] || fail '--backup must be an absolute Linux path'
[[ "$EVIDENCE_FILE" = /* ]] || fail '--evidence must be an absolute Linux path'
[[ "$REHEARSAL_DATA_ROOT" = /* ]] || fail '--data-root must be an absolute Linux path'
[[ "$BACKUP_FILE" != *','* && "$BACKUP_FILE" != *$'\n'* ]] \
    || fail 'backup path contains an unsafe Docker mount character'
[[ "$REHEARSAL_DATA_ROOT" != *','* && "$REHEARSAL_DATA_ROOT" != *$'\n'* ]] \
    || fail 'rehearsal data root contains an unsafe Docker mount character'

for command in docker node openssl realpath sha256sum stat awk grep find sort mktemp date timeout df \
    wc tr basename dirname sed tail seq sleep chmod ln rm mkdir rmdir kill; do
    command -v "$command" >/dev/null 2>&1 || fail "required command is missing: $command"
done
[ -f "$TARGET_MIGRATION_FILE" ] && [ ! -L "$TARGET_MIGRATION_FILE" ] \
    || fail "reviewed migration source is missing or symlinked: $TARGET_MIGRATION_FILE"
[ -f "$MIGRATION_LOCK_FILE" ] && [ ! -L "$MIGRATION_LOCK_FILE" ] \
    || fail "Prisma migration lock is missing or symlinked: $MIGRATION_LOCK_FILE"
[ -f "$MODE_SELECTOR" ] && [ ! -L "$MODE_SELECTOR" ] \
    || fail "migration rehearsal mode selector is missing or symlinked: $MODE_SELECTOR"

[ -f "$BACKUP_FILE" ] && [ ! -L "$BACKUP_FILE" ] \
    || fail "backup is missing or symlinked: $BACKUP_FILE"
BACKUP_FILE="$(realpath -e -- "$BACKUP_FILE")"
CHECKSUM_FILE="$BACKUP_FILE.sha256"
[ -f "$BACKUP_FILE" ] && [ ! -L "$BACKUP_FILE" ] \
    || fail "backup is missing or symlinked: $BACKUP_FILE"
[ -f "$CHECKSUM_FILE" ] && [ ! -L "$CHECKSUM_FILE" ] \
    || fail "backup checksum sidecar is missing or symlinked: $CHECKSUM_FILE"
[ "$(stat -c '%u' "$BACKUP_FILE")" = "$(id -u)" ] \
    && [ "$(stat -c '%u' "$CHECKSUM_FILE")" = "$(id -u)" ] \
    || fail 'backup and checksum sidecar must be owned by the rehearsal operator'
for protected_file in "$BACKUP_FILE" "$CHECKSUM_FILE"; do
    mode="$(stat -c '%a' "$protected_file")"
    group_digit="${mode: -2:1}"
    other_digit="${mode: -1}"
    (( (group_digit & 2) == 0 && (other_digit & 2) == 0 )) \
        || fail "backup input is group/world writable: $protected_file (mode $mode)"
done

[ "$(wc -l < "$CHECKSUM_FILE" | tr -d ' ')" -eq 1 ] \
    || fail 'backup checksum sidecar must contain exactly one record'
read -r EXPECTED_BACKUP_SHA CHECKSUM_BASENAME CHECKSUM_EXTRA < "$CHECKSUM_FILE" || true
[[ "${EXPECTED_BACKUP_SHA:-}" =~ ^[A-Fa-f0-9]{64}$ ]] \
    || fail 'backup checksum sidecar is malformed'
[ -z "${CHECKSUM_EXTRA:-}" ] \
    || fail 'backup checksum sidecar contains unexpected fields'
CHECKSUM_BASENAME="${CHECKSUM_BASENAME#\*}"
[ "$CHECKSUM_BASENAME" = "$(basename "$BACKUP_FILE")" ] \
    || fail 'backup checksum sidecar names a different archive'
ACTUAL_BACKUP_SHA="$(sha256sum "$BACKUP_FILE" | awk 'NR == 1 { print $1 }')"
[ "${EXPECTED_BACKUP_SHA,,}" = "$ACTUAL_BACKUP_SHA" ] \
    || fail 'backup checksum mismatch'

EVIDENCE_BASENAME="$(basename "$EVIDENCE_FILE")"
[ "$EVIDENCE_BASENAME" != '.' ] && [ "$EVIDENCE_BASENAME" != '..' ] \
    && [[ "$EVIDENCE_BASENAME" != *$'\n'* ]] \
    || fail 'evidence filename is unsafe'
EVIDENCE_DIR_INPUT="$(dirname "$EVIDENCE_FILE")"
[ -d "$EVIDENCE_DIR_INPUT" ] && [ ! -L "$EVIDENCE_DIR_INPUT" ] \
    || fail "evidence directory is missing or symlinked: $EVIDENCE_DIR_INPUT"
EVIDENCE_DIR="$(realpath -e -- "$EVIDENCE_DIR_INPUT")"
EVIDENCE_FILE="$EVIDENCE_DIR/$EVIDENCE_BASENAME"
[ -d "$EVIDENCE_DIR" ] && [ ! -L "$EVIDENCE_DIR" ] && [ -w "$EVIDENCE_DIR" ] \
    || fail "evidence directory must pre-exist, be writable, and not be a symlink: $EVIDENCE_DIR"
[ "$(stat -c '%u' "$EVIDENCE_DIR")" = "$(id -u)" ] \
    || fail 'evidence directory must be owned by the rehearsal operator'
evidence_dir_mode="$(stat -c '%a' "$EVIDENCE_DIR")"
evidence_group_digit="${evidence_dir_mode: -2:1}"
evidence_other_digit="${evidence_dir_mode: -1}"
(( (evidence_group_digit & 2) == 0 && (evidence_other_digit & 2) == 0 )) \
    || fail "evidence directory must not be group/world writable (mode $evidence_dir_mode)"
[ ! -e "$EVIDENCE_FILE" ] && [ ! -L "$EVIDENCE_FILE" ] \
    || fail "refusing to overwrite existing evidence: $EVIDENCE_FILE"

docker info >/dev/null 2>&1 || fail 'Docker daemon is unavailable'
DOCKER_ROOT="$(docker info --format '{{.DockerRootDir}}' 2>/dev/null)"
[ -n "$DOCKER_ROOT" ] && [ -d "$DOCKER_ROOT" ] && [ ! -L "$DOCKER_ROOT" ] \
    || fail 'DockerRootDir is missing or symlinked; rehearsal storage cannot be bounded safely'
DOCKER_ROOT="$(realpath -e -- "$DOCKER_ROOT")"
[ -d "$REHEARSAL_DATA_ROOT" ] && [ ! -L "$REHEARSAL_DATA_ROOT" ] && [ -w "$REHEARSAL_DATA_ROOT" ] \
    || fail "dedicated rehearsal data root must pre-exist, be writable, and not be a symlink: $REHEARSAL_DATA_ROOT"
[ "$(stat -c '%u' "$REHEARSAL_DATA_ROOT")" = "$(id -u)" ] \
    || fail 'dedicated rehearsal data root must be owned by the rehearsal operator'
REHEARSAL_ROOT_MODE="$(stat -c '%a' "$REHEARSAL_DATA_ROOT")"
case "$REHEARSAL_ROOT_MODE" in
    700|750) ;;
    *) fail "dedicated rehearsal data root mode must be 700 or 750, got $REHEARSAL_ROOT_MODE" ;;
esac
REHEARSAL_DATA_ROOT="$(realpath -e -- "$REHEARSAL_DATA_ROOT")"
case "$REHEARSAL_DATA_ROOT" in
    "$DOCKER_ROOT"|"$DOCKER_ROOT"/*) fail 'rehearsal data root must be outside DockerRootDir' ;;
esac
BACKUP_BYTES="$(stat -c '%s' "$BACKUP_FILE")"
MAX_CAPACITY_INPUT_BYTES=500000000000000000
[[ "$BACKUP_BYTES" =~ ^[1-9][0-9]*$ ]] && [ "$BACKUP_BYTES" -le "$MAX_CAPACITY_INPUT_BYTES" ] \
    || fail 'backup size is empty or outside the safe arithmetic range'
[ "$SOURCE_DATABASE_BYTES" -le "$MAX_CAPACITY_INPUT_BYTES" ] \
    || fail '--source-database-bytes is outside the safe capacity arithmetic range'
FOUR_GIB=$((4 * 1024 * 1024 * 1024))
TEN_GIB=$((10 * 1024 * 1024 * 1024))
DATABASE_RESTORE_BUDGET=$((SOURCE_DATABASE_BYTES * 4 + FOUR_GIB))
COMPRESSED_RESTORE_BUDGET=$((BACKUP_BYTES * 12 + FOUR_GIB))
if [ "$COMPRESSED_RESTORE_BUDGET" -gt "$DATABASE_RESTORE_BUDGET" ]; then
    RESTORE_BUDGET_BYTES="$COMPRESSED_RESTORE_BUDGET"
else
    RESTORE_BUDGET_BYTES="$DATABASE_RESTORE_BUDGET"
fi
SOURCE_RESERVE_BYTES=$((SOURCE_DATABASE_BYTES * 2))
if [ "$SOURCE_RESERVE_BYTES" -gt "$TEN_GIB" ]; then
    HOST_RESERVE_BYTES="$SOURCE_RESERVE_BYTES"
else
    HOST_RESERVE_BYTES="$TEN_GIB"
fi
REQUIRED_FREE_BYTES=$((RESTORE_BUDGET_BYTES + HOST_RESERVE_BYTES))
AVAILABLE_REHEARSAL_BYTES="$(df -PB1 "$REHEARSAL_DATA_ROOT" | awk 'END { print $4 }')"
[[ "$AVAILABLE_REHEARSAL_BYTES" =~ ^[0-9]+$ ]] \
    || fail 'unable to determine free bytes on the rehearsal data filesystem'
[ "$AVAILABLE_REHEARSAL_BYTES" -ge "$REQUIRED_FREE_BYTES" ] \
    || fail "rehearsal data root lacks headroom: available=$AVAILABLE_REHEARSAL_BYTES required=$REQUIRED_FREE_BYTES"
info "rehearsal capacity gate passed (available=$AVAILABLE_REHEARSAL_BYTES, restoreBudget=$RESTORE_BUDGET_BYTES, protectedReserve=$HOST_RESERVE_BYTES)"
POSTGRES_IMAGE_ID="$(docker image inspect -f '{{.Id}}' "$POSTGRES_IMAGE" 2>/dev/null)" \
    || fail 'exact PostgreSQL image is not present locally; pre-pull the reviewed digest'
CANDIDATE_IMAGE_ID="$(docker image inspect -f '{{.Id}}' "$CANDIDATE_IMAGE" 2>/dev/null)" \
    || fail "candidate backend image is missing: $CANDIDATE_IMAGE"
[[ "$POSTGRES_IMAGE_ID" =~ ^sha256:[a-f0-9]{64}$ ]] \
    || fail 'unable to resolve exact PostgreSQL image ID'
[[ "$CANDIDATE_IMAGE_ID" =~ ^sha256:[a-f0-9]{64}$ ]] \
    || fail 'unable to resolve immutable candidate backend image ID'
CANDIDATE_REVISION="$(docker image inspect -f '{{index .Config.Labels "org.opencontainers.image.revision"}}' "$CANDIDATE_IMAGE" 2>/dev/null)"
[ "$CANDIDATE_REVISION" = "$EXPECTED_REVISION" ] \
    || fail 'candidate backend OCI revision does not match --expected-revision'

SOURCE_MIGRATION_SHA="$(sha256sum "$TARGET_MIGRATION_FILE" | awk 'NR == 1 { print $1 }')"
CANDIDATE_MIGRATION_SHA="$(docker run --rm --pull never --network none \
    --read-only --cap-drop ALL --security-opt no-new-privileges \
    --memory 256m --memory-swap 256m --cpus 0.5 --pids-limit 64 --blkio-weight 100 \
    --entrypoint sha256sum "$CANDIDATE_IMAGE_ID" \
    "/app/prisma/migrations/$TARGET_MIGRATION/migration.sql" | awk 'NR == 1 { print $1 }')" \
    || fail 'candidate image does not contain the reviewed verified-direct WhatsApp backfill migration'
[ "$CANDIDATE_MIGRATION_SHA" = "$SOURCE_MIGRATION_SHA" ] \
    || fail 'candidate migration bytes differ from the reviewed source tree'
SOURCE_MIGRATION_TREE_SHA="$(
    cd "$PROJECT_DIR/backend/prisma/migrations"
    while IFS= read -r relative_path; do
        printf '%s  %s\n' "$(sha256sum "$relative_path" | awk 'NR == 1 { print $1 }')" "$relative_path"
    done < <({ printf 'migration_lock.toml\n'; find . -mindepth 2 -maxdepth 2 -type f -name migration.sql -printf '%P\n'; } | LC_ALL=C sort)
)"
SOURCE_MIGRATION_TREE_SHA="$(printf '%s\n' "$SOURCE_MIGRATION_TREE_SHA" | sha256sum | awk 'NR == 1 { print $1 }')"
CANDIDATE_MIGRATION_TREE_SHA="$(docker run --rm --pull never --network none \
    --read-only --cap-drop ALL --security-opt no-new-privileges \
    --memory 256m --memory-swap 256m --cpus 0.5 --pids-limit 64 --blkio-weight 100 \
    --entrypoint sh "$CANDIDATE_IMAGE_ID" -ceu '
      cd /app/prisma/migrations
      migration_paths="$({ printf "migration_lock.toml\n"; find . -mindepth 2 -maxdepth 2 -type f -name migration.sql -printf "%P\n"; })"
      [ -n "$migration_paths" ]
      migration_paths="$(printf "%s\n" "$migration_paths" | LC_ALL=C sort)"
      migration_tree="$(
        while IFS= read -r relative_path; do
          digest_output="$(sha256sum "$relative_path")"
          printf "%s  %s\n" "${digest_output%% *}" "$relative_path"
        done <<EOF_INNER
$migration_paths
EOF_INNER
      )"
      tree_digest_output="$(printf "%s\n" "$migration_tree" | sha256sum)"
      printf "%s\n" "${tree_digest_output%% *}"
    ')" \
    || fail 'candidate image migration tree could not be fingerprinted'
[ "$CANDIDATE_MIGRATION_TREE_SHA" = "$SOURCE_MIGRATION_TREE_SHA" ] \
    || fail 'candidate image migration tree differs from the reviewed source tree'

RUN_ID="$(date -u +'%Y%m%dT%H%M%SZ')-$(openssl rand -hex 8)"
RESOURCE_PREFIX="vaysen-crm-migration-rehearsal-${RUN_ID}"
NETWORK_NAME="${RESOURCE_PREFIX}-network"
RUN_DATA_DIR="$REHEARSAL_DATA_ROOT/$RESOURCE_PREFIX"
PGDATA_DIR="$RUN_DATA_DIR/pgdata"
POSTGRES_CONTAINER="${RESOURCE_PREFIX}-postgres"
FAILURE_CONTAINER="${RESOURCE_PREFIX}-connection-failure"
STATUS_CONTAINER="${RESOURCE_PREFIX}-migration-status"
PARTIAL_FAILURE_CONTAINER="${RESOURCE_PREFIX}-partial-ddl-failure"
P3009_CONTAINER="${RESOURCE_PREFIX}-blocked-retry"
RESOLVE_CONTAINER="${RESOURCE_PREFIX}-resolve-rolled-back"
DEPLOY_ONE_CONTAINER="${RESOURCE_PREFIX}-deploy-one"
DEPLOY_TWO_CONTAINER="${RESOURCE_PREFIX}-deploy-two"
CLEANUP_CONTAINER="${RESOURCE_PREFIX}-data-cleanup"
TMP_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/vaysen-crm-migration-rehearsal-XXXXXX")"
EVIDENCE_TMP=""
STORAGE_GUARD_FILE="$TMP_ROOT/storage-reserve-triggered"
STORAGE_WATCHDOG_PID=""
RESOURCES_CREATED=0
RESOURCES_CLEANED=0

resource_label() {
    local kind="$1" name="$2"
    case "$kind" in
        container) docker container inspect -f '{{index .Config.Labels "com.vaysen.vaysen-crm.migration-rehearsal"}}' "$name" 2>/dev/null ;;
        network) docker network inspect -f '{{index .Labels "com.vaysen.vaysen-crm.migration-rehearsal"}}' "$name" 2>/dev/null ;;
        *) return 2 ;;
    esac
}

remove_owned_container() {
    local name="$1" label
    docker container inspect "$name" >/dev/null 2>&1 || return 0
    label="$(resource_label container "$name" || true)"
    [ "$label" = "$RUN_ID" ] || { printf '[MIGRATION REHEARSAL CLEANUP ERROR] refusing foreign container: %s\n' "$name" >&2; return 1; }
    docker rm -f "$name" >/dev/null
}

cleanup_resources() {
    local failed=0 label name
    for name in "$FAILURE_CONTAINER" "$STATUS_CONTAINER" "$PARTIAL_FAILURE_CONTAINER" \
        "$P3009_CONTAINER" "$RESOLVE_CONTAINER" "$DEPLOY_ONE_CONTAINER" \
        "$DEPLOY_TWO_CONTAINER" "$POSTGRES_CONTAINER" "$CLEANUP_CONTAINER"; do
        remove_owned_container "$name" || failed=1
    done
    if [ -e "$RUN_DATA_DIR" ]; then
        case "$RUN_DATA_DIR" in
            "$REHEARSAL_DATA_ROOT"/vaysen-crm-migration-rehearsal-*) ;;
            *) printf '[MIGRATION REHEARSAL CLEANUP ERROR] refusing unexpected data path: %s\n' "$RUN_DATA_DIR" >&2; failed=1 ;;
        esac
        if [ "$failed" -eq 0 ] && [ -d "$RUN_DATA_DIR" ] && [ ! -L "$RUN_DATA_DIR" ]; then
            docker run --rm --pull never --name "$CLEANUP_CONTAINER" \
                --label "$LABEL_KEY=$RUN_ID" --network none --user 0 --read-only \
                --log-driver none \
                --memory 256m --memory-swap 256m --cpus 0.5 --pids-limit 64 --blkio-weight 100 \
                --cap-drop ALL --cap-add DAC_OVERRIDE --security-opt no-new-privileges \
                --mount "type=bind,src=$RUN_DATA_DIR,dst=/scratch" \
                --entrypoint sh "$POSTGRES_IMAGE_ID" -ceu '
                  test -d /scratch && test ! -L /scratch
                  if find /scratch -xdev ! -type d ! -type f -print -quit | grep -q .; then
                    echo "rehearsal data contains a link or special file" >&2
                    exit 1
                  fi
                  find /scratch -xdev -mindepth 1 -depth -delete
                ' >/dev/null 2>&1 || failed=1
            [ "$failed" -ne 0 ] || rmdir -- "$RUN_DATA_DIR" || failed=1
        else
            failed=1
        fi
    fi
    if docker network inspect "$NETWORK_NAME" >/dev/null 2>&1; then
        label="$(resource_label network "$NETWORK_NAME" || true)"
        if [ "$label" = "$RUN_ID" ]; then docker network rm "$NETWORK_NAME" >/dev/null || failed=1
        else printf '[MIGRATION REHEARSAL CLEANUP ERROR] refusing foreign network: %s\n' "$NETWORK_NAME" >&2; failed=1
        fi
    fi
    [ "$failed" -eq 0 ] || return 1
    RESOURCES_CLEANED=1
}

stop_storage_watchdog() {
    if [ -n "$STORAGE_WATCHDOG_PID" ]; then
        kill "$STORAGE_WATCHDOG_PID" >/dev/null 2>&1 || true
        wait "$STORAGE_WATCHDOG_PID" 2>/dev/null || true
        STORAGE_WATCHDOG_PID=""
    fi
}

cleanup() {
    local status=$?
    trap - EXIT INT TERM
    set +e
    stop_storage_watchdog
    if [ "$RESOURCES_CREATED" -eq 1 ] && [ "$RESOURCES_CLEANED" -eq 0 ]; then
        cleanup_resources || status=1
    fi
    [ -z "$EVIDENCE_TMP" ] || rm -f -- "$EVIDENCE_TMP"
    case "$TMP_ROOT" in
        "${TMPDIR:-/tmp}"/vaysen-crm-migration-rehearsal-*) rm -rf -- "$TMP_ROOT" ;;
        *) printf '[MIGRATION REHEARSAL CLEANUP ERROR] refusing unexpected temp path: %s\n' "$TMP_ROOT" >&2; status=1 ;;
    esac
    exit "$status"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

print_redacted_log() {
    local file="$1"
    sed "s/${REHEARSAL_DB_PASSWORD}/[redacted]/g" "$file" | tail -n 80 >&2
}

mkdir -m 700 -- "$RUN_DATA_DIR"
RESOURCES_CREATED=1
mkdir -m 700 -- "$PGDATA_DIR"
docker network create --internal --label "$LABEL_KEY=$RUN_ID" "$NETWORK_NAME" >/dev/null

REHEARSAL_DB_USER="vaysen-crm_rehearsal"
REHEARSAL_DB_NAME="vaysen-crm_rehearsal"
REHEARSAL_DB_PASSWORD="$(openssl rand -hex 24)"
PG_CLIENT_ENV="PGHOST=127.0.0.1"
# Docker's local logging driver compresses rotated files by default and
# rejects compression when max-file is 1 (observed on Docker 29). Keep a
# bounded two-file rotation so the disposable rehearsal is portable and
# disk-limited.
docker run -d --pull never --name "$POSTGRES_CONTAINER" \
    --label "$LABEL_KEY=$RUN_ID" \
    --network "$NETWORK_NAME" --network-alias postgres \
    --memory 4g --memory-swap 4g --cpus 2 --pids-limit 256 --blkio-weight 100 \
    --shm-size 256m \
    --log-driver local --log-opt max-size=10m --log-opt max-file=2 \
    --mount "type=bind,src=$PGDATA_DIR,dst=/var/lib/postgresql/data" \
    --mount "type=bind,src=$BACKUP_FILE,dst=/rehearsal/input.dump,readonly" \
    --tmpfs /run/postgresql:rw,nosuid,nodev,size=16m \
    -e "POSTGRES_USER=$REHEARSAL_DB_USER" \
    -e "POSTGRES_PASSWORD=$REHEARSAL_DB_PASSWORD" \
    -e "POSTGRES_DB=$REHEARSAL_DB_NAME" \
    "$POSTGRES_IMAGE" >/dev/null

(
    while docker container inspect "$POSTGRES_CONTAINER" >/dev/null 2>&1; do
        free_bytes="$(df -PB1 "$REHEARSAL_DATA_ROOT" | awk 'END { print $4 }')"
        if ! [[ "$free_bytes" =~ ^[0-9]+$ ]] || [ "$free_bytes" -lt "$HOST_RESERVE_BYTES" ]; then
            : > "$STORAGE_GUARD_FILE"
            docker stop --time 10 "$POSTGRES_CONTAINER" >/dev/null 2>&1 || true
            exit 0
        fi
        sleep 2
    done
) &
STORAGE_WATCHDOG_PID=$!

RUNNING_POSTGRES_IMAGE_ID="$(docker container inspect -f '{{.Image}}' "$POSTGRES_CONTAINER")"
[ "$RUNNING_POSTGRES_IMAGE_ID" = "$POSTGRES_IMAGE_ID" ] \
    || fail 'temporary PostgreSQL container did not use the reviewed image ID'

ready=0
for _ in $(seq 1 60); do
    if docker exec -e "$PG_CLIENT_ENV" "$POSTGRES_CONTAINER" pg_isready -U "$REHEARSAL_DB_USER" -d "$REHEARSAL_DB_NAME" >/dev/null 2>&1; then
        ready=1
        break
    fi
    sleep 2
done
[ "$ready" -eq 1 ] || fail 'temporary PostgreSQL did not become ready within 120 seconds'

MOUNTED_BACKUP_SHA="$(docker exec --user 0 "$POSTGRES_CONTAINER" sha256sum /rehearsal/input.dump | awk 'NR == 1 { print $1 }')"
[ "$MOUNTED_BACKUP_SHA" = "$ACTUAL_BACKUP_SHA" ] \
    || fail 'read-only Docker backup mount differs from the verified host archive'
docker exec --user 0 "$POSTGRES_CONTAINER" pg_restore -l /rehearsal/input.dump >/dev/null \
    || fail 'verified checksum archive is not a PostgreSQL custom-format dump'
RESTORE_STARTED_AT="$(date +%s)"
set +e
timeout --signal=TERM --kill-after=30s "${MAX_RESTORE_SECONDS}s" \
  docker exec --user 0 -e "$PG_CLIENT_ENV" "$POSTGRES_CONTAINER" pg_restore \
    -U "$REHEARSAL_DB_USER" -d "$REHEARSAL_DB_NAME" \
    --clean --if-exists --no-owner --no-privileges --exit-on-error \
    /rehearsal/input.dump >/dev/null
RESTORE_STATUS=$?
set -e
RESTORE_SECONDS=$(( $(date +%s) - RESTORE_STARTED_AT ))
if [ "$RESTORE_STATUS" -ne 0 ]; then
    # A timed-out docker exec may leave pg_restore running server-side. Killing
    # the disposable PostgreSQL container guarantees all restore work stops
    # before the capacity/cleanup failure is returned.
    docker stop --time 10 "$POSTGRES_CONTAINER" >/dev/null 2>&1 || true
    fail "production backup restore failed or exceeded ${MAX_RESTORE_SECONDS}s in disposable PostgreSQL (exit $RESTORE_STATUS)"
fi
[ "$RESTORE_SECONDS" -le "$MAX_RESTORE_SECONDS" ] \
    || fail 'production backup restore exceeded its hard time budget'
POST_RESTORE_BACKUP_SHA="$(docker exec --user 0 "$POSTGRES_CONTAINER" sha256sum /rehearsal/input.dump | awk 'NR == 1 { print $1 }')"
[ "$POST_RESTORE_BACKUP_SHA" = "$ACTUAL_BACKUP_SHA" ] \
    || fail 'backup archive changed while the disposable restore was running'
info 'verified production backup restored into an isolated disposable data root'

BASELINE_COUNT="$(docker exec -e "$PG_CLIENT_ENV" "$POSTGRES_CONTAINER" psql -U "$REHEARSAL_DB_USER" -d "$REHEARSAL_DB_NAME" -Atqc \
    "SELECT count(*) FROM \"_prisma_migrations\" WHERE migration_name = '$TARGET_MIGRATION';")"
BASELINE_SUCCESSFUL_COUNT="$(docker exec -e "$PG_CLIENT_ENV" "$POSTGRES_CONTAINER" psql -U "$REHEARSAL_DB_USER" -d "$REHEARSAL_DB_NAME" -Atqc \
    "SELECT count(*) FROM \"_prisma_migrations\" WHERE migration_name = '$TARGET_MIGRATION' AND finished_at IS NOT NULL AND rolled_back_at IS NULL;")"
BASELINE_UNRESOLVED_COUNT="$(docker exec -e "$PG_CLIENT_ENV" "$POSTGRES_CONTAINER" psql -U "$REHEARSAL_DB_USER" -d "$REHEARSAL_DB_NAME" -Atqc \
    "SELECT count(*) FROM \"_prisma_migrations\" WHERE migration_name = '$TARGET_MIGRATION' AND finished_at IS NULL AND rolled_back_at IS NULL;")"
BASELINE_ROLLED_BACK_COUNT="$(docker exec -e "$PG_CLIENT_ENV" "$POSTGRES_CONTAINER" psql -U "$REHEARSAL_DB_USER" -d "$REHEARSAL_DB_NAME" -Atqc \
    "SELECT count(*) FROM \"_prisma_migrations\" WHERE migration_name = '$TARGET_MIGRATION' AND rolled_back_at IS NOT NULL;")"
REHEARSAL_MODE="$(bash "$MODE_SELECTOR" "$BASELINE_COUNT" "$BASELINE_SUCCESSFUL_COUNT" \
    "$BASELINE_UNRESOLVED_COUNT" "$BASELINE_ROLLED_BACK_COUNT")" \
    || fail 'restored backup has an unsafe target migration ledger state'
GLOBAL_UNRESOLVED_COUNT="$(docker exec -e "$PG_CLIENT_ENV" "$POSTGRES_CONTAINER" psql -U "$REHEARSAL_DB_USER" -d "$REHEARSAL_DB_NAME" -Atqc \
    'SELECT count(*) FROM "_prisma_migrations" WHERE finished_at IS NULL AND rolled_back_at IS NULL;')"
[ "$GLOBAL_UNRESOLVED_COUNT" = '0' ] \
    || fail "restored backup contains unresolved Prisma migrations: $GLOBAL_UNRESOLVED_COUNT"

if [ "$REHEARSAL_MODE" = 'forward-migration' ]; then
    BASELINE_FOUNDATION_SUCCESSFUL="$(docker exec -e "$PG_CLIENT_ENV" "$POSTGRES_CONTAINER" psql -U "$REHEARSAL_DB_USER" -d "$REHEARSAL_DB_NAME" -Atqc \
        "SELECT count(*) FROM \"_prisma_migrations\" WHERE migration_name='$FOUNDATION_MIGRATION' AND finished_at IS NOT NULL AND rolled_back_at IS NULL;")"
    BASELINE_FOLLOWUP_SUCCESSFUL="$(docker exec -e "$PG_CLIENT_ENV" "$POSTGRES_CONTAINER" psql -U "$REHEARSAL_DB_USER" -d "$REHEARSAL_DB_NAME" -Atqc \
        "SELECT count(*) FROM \"_prisma_migrations\" WHERE migration_name='$FOLLOWUP_MIGRATION' AND finished_at IS NOT NULL AND rolled_back_at IS NULL;")"
    [ "$BASELINE_FOUNDATION_SUCCESSFUL" = '1' ] && [ "$BASELINE_FOLLOWUP_SUCCESSFUL" = '1' ] \
        || fail 'production backup is missing the reviewed OpenClaw foundation migrations'
else
    BASELINE_LEDGER_CHECKSUM="$(docker exec -e "$PG_CLIENT_ENV" "$POSTGRES_CONTAINER" psql -U "$REHEARSAL_DB_USER" -d "$REHEARSAL_DB_NAME" -Atqc \
        "SELECT checksum FROM \"_prisma_migrations\" WHERE migration_name = '$TARGET_MIGRATION' AND finished_at IS NOT NULL AND rolled_back_at IS NULL;")"
    [ "$BASELINE_LEDGER_CHECKSUM" = "$SOURCE_MIGRATION_SHA" ] \
        || fail 'applied target migration checksum differs from the reviewed candidate migration'
fi
info "selected safe rehearsal mode: $REHEARSAL_MODE"

backfill_state() {
    docker exec -i -e "$PG_CLIENT_ENV" "$POSTGRES_CONTAINER" psql \
      -v ON_ERROR_STOP=1 -U "$REHEARSAL_DB_USER" -d "$REHEARSAL_DB_NAME" -F ',' -At <<'SQL'
WITH classified AS (
  SELECT
    conversation.id,
    conversation."isGroup" AS is_group,
    conversation."updatedAt" AS updated_at,
    conversation."externalThreadId" AS external_thread_id,
    conversation."contactPointId" AS contact_point_id,
    (
      conversation.channel = 'whatsapp'
      AND conversation."externalThreadId" !~* '@g\.us$'
      AND conversation."externalThreadId" ~* '^\+?[1-9][0-9]{6,14}(@s\.whatsapp\.net)?$'
      AND EXISTS (
        SELECT 1
        FROM "ContactPoint" AS contact_point
        WHERE contact_point.id = conversation."contactPointId"
          AND contact_point.type = 'whatsapp'
          AND contact_point."isVerified" = TRUE
          AND contact_point."normalizedValue" ~ '^\+[1-9][0-9]{6,14}$'
          AND regexp_replace(
            regexp_replace(conversation."externalThreadId", '@s\.whatsapp\.net$', '', 'i'),
            '\D',
            '',
            'g'
          ) = regexp_replace(contact_point."normalizedValue", '\D', '', 'g')
      )
    ) AS eligible_identity
  FROM "Conversation" AS conversation
)
SELECT
  count(*) FILTER (WHERE is_group IS NULL AND eligible_identity IS TRUE),
  count(*) FILTER (WHERE is_group IS FALSE AND eligible_identity IS TRUE),
  count(*) FILTER (WHERE is_group IS TRUE AND eligible_identity IS TRUE),
  count(*) FILTER (WHERE is_group IS NULL AND eligible_identity IS NOT TRUE),
  md5(COALESCE(string_agg(
    concat_ws('|', id::text, external_thread_id, contact_point_id::text, updated_at::text),
    E'\n' ORDER BY id
  ) FILTER (WHERE is_group IS NULL AND eligible_identity IS NOT TRUE), ''))
FROM classified;
SQL
}

if [ "$REHEARSAL_MODE" = 'forward-migration' ]; then
    IFS=',' read -r BASELINE_ELIGIBLE_NULL BASELINE_ELIGIBLE_FALSE BASELINE_ELIGIBLE_TRUE \
        BASELINE_OTHER_NULL_COUNT BASELINE_OTHER_NULL_DIGEST <<< "$(backfill_state)"
    [[ "$BASELINE_ELIGIBLE_NULL" =~ ^[1-9][0-9]*$ ]] \
        || fail 'production backup contains no verified direct WhatsApp legacy row for the reviewed backfill'
    for value in "$BASELINE_ELIGIBLE_FALSE" "$BASELINE_ELIGIBLE_TRUE" "$BASELINE_OTHER_NULL_COUNT"; do
        [[ "$value" =~ ^[0-9]+$ ]] || fail 'could not classify the restored WhatsApp conversation state'
    done
    [[ "$BASELINE_OTHER_NULL_DIGEST" =~ ^[a-f0-9]{32}$ ]] \
        || fail 'could not fingerprint legacy conversations excluded from the reviewed backfill'
fi

schema_fingerprint() {
    docker exec -e "$PG_CLIENT_ENV" "$POSTGRES_CONTAINER" pg_dump \
      -U "$REHEARSAL_DB_USER" -d "$REHEARSAL_DB_NAME" \
      --schema-only --no-owner --no-privileges \
      | sed -E '/^\\(un)?restrict /d; /^-- Dumped (from database|by pg_dump) version /d' \
      | sha256sum | awk 'NR == 1 { print $1 }'
}

ledger_fingerprint() {
    docker exec -e "$PG_CLIENT_ENV" "$POSTGRES_CONTAINER" psql \
      -U "$REHEARSAL_DB_USER" -d "$REHEARSAL_DB_NAME" -Atqc \
      'COPY (SELECT id, checksum, finished_at, migration_name, logs, rolled_back_at, started_at, applied_steps_count FROM "_prisma_migrations" ORDER BY id) TO STDOUT WITH (FORMAT csv)' \
      | sha256sum | awk 'NR == 1 { print $1 }'
}

row_count_fingerprint() {
    docker exec -i -e "$PG_CLIENT_ENV" "$POSTGRES_CONTAINER" psql \
      -v ON_ERROR_STOP=1 -U "$REHEARSAL_DB_USER" -d "$REHEARSAL_DB_NAME" -At <<'SQL' \
      | sha256sum | awk 'NR == 1 { print $1 }'
SELECT format(
  'SELECT %L || ''='' || count(*) FROM %I.%I;',
  schemaname || '.' || tablename,
  schemaname,
  tablename
)
FROM pg_tables
WHERE schemaname = 'public'
ORDER BY schemaname, tablename
\gexec
SQL
}

data_fingerprint() {
    docker exec -e "$PG_CLIENT_ENV" "$POSTGRES_CONTAINER" pg_dump \
      -U "$REHEARSAL_DB_USER" -d "$REHEARSAL_DB_NAME" \
      --data-only --no-owner --no-privileges \
      | sed -E '/^\\(un)?restrict /d; /^-- Dumped (from database|by pg_dump) version /d' \
      | node "$PROJECT_DIR/scripts/canonicalize-pg-dump-data.mjs" \
      | sha256sum | awk 'NR == 1 { print $1 }'
}

verify_release_migration_schema_contract() {
    local expected_rolled_back_rows="$1"
    docker exec -i -e "$PG_CLIENT_ENV" "$POSTGRES_CONTAINER" psql -v ON_ERROR_STOP=1 \
      -U "$REHEARSAL_DB_USER" -d "$REHEARSAL_DB_NAME" >/dev/null <<'SQL' || return 1
DO $verify$
DECLARE
  expected_tables text[] := ARRAY['OwnerNotificationOutbox'];
  expected_types text[] := ARRAY['OwnerNotificationStatus'];
  expected_indexes text[] := ARRAY[
    'OwnerNotificationOutbox_eventKey_key',
    'OwnerNotificationOutbox_status_nextAttemptAt_idx',
    'OwnerNotificationOutbox_status_expiresAt_idx',
    'OwnerNotificationOutbox_companyId_status_createdAt_idx',
    'OpenClawSelectionToken_companyId_leadId_expiresAt_idx'
  ];
  expected_foreign_keys text[] := ARRAY['OwnerNotificationOutbox_companyId_fkey'];
  item text;
BEGIN
  FOREACH item IN ARRAY expected_types LOOP
    IF to_regtype(format('%I', item)) IS NULL THEN
      RAISE EXCEPTION 'missing enum type %', item;
    END IF;
  END LOOP;

  FOREACH item IN ARRAY expected_tables LOOP
    IF to_regclass(format('%I', item)) IS NULL THEN
      RAISE EXCEPTION 'missing table %', item;
    END IF;
  END LOOP;

  FOREACH item IN ARRAY expected_indexes LOOP
    IF to_regclass(format('%I', item)) IS NULL THEN
      RAISE EXCEPTION 'missing index %', item;
    END IF;
  END LOOP;

  FOREACH item IN ARRAY expected_foreign_keys LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = item) THEN
      RAISE EXCEPTION 'missing foreign key %', item;
    END IF;
  END LOOP;

  IF (
    SELECT count(*)
    FROM pg_constraint constraint_row
    JOIN pg_class target_table ON target_table.oid = constraint_row.conrelid
    JOIN pg_namespace target_schema ON target_schema.oid = target_table.relnamespace
    WHERE constraint_row.contype = 'f'
      AND target_schema.nspname = 'public'
      AND target_table.relname = 'OwnerNotificationOutbox'
  ) <> array_length(expected_foreign_keys, 1) THEN
    RAISE EXCEPTION 'owner notification outbox foreign-key count differs from the reviewed set';
  END IF;

  IF (SELECT count(*) FROM "_prisma_migrations"
      WHERE migration_name = '20260718170000_owner_notification_outbox'
        AND finished_at IS NOT NULL
        AND rolled_back_at IS NULL) <> 1 THEN
    RAISE EXCEPTION 'target Prisma migration ledger entry is not exactly one successful row';
  END IF;

  IF (SELECT count(*) FROM "_prisma_migrations"
      WHERE migration_name = '20260718193000_openclaw_lead_selection'
        AND finished_at IS NOT NULL
        AND rolled_back_at IS NULL) <> 1 THEN
    RAISE EXCEPTION 'follow-up Prisma migration ledger entry is not exactly one successful row';
  END IF;

  IF (SELECT count(*) FROM "_prisma_migrations"
      WHERE migration_name = '20260719211500_backfill_verified_direct_whatsapp_group_status'
        AND finished_at IS NOT NULL
        AND rolled_back_at IS NULL) <> 1 THEN
    RAISE EXCEPTION 'verified-direct WhatsApp backfill ledger entry is not exactly one successful row';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema='public' AND table_name='OpenClawSelectionToken'
      AND column_name='leadId' AND is_nullable='NO'
  ) THEN
    RAISE EXCEPTION 'OpenClawSelectionToken.leadId is missing or nullable';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema='public' AND table_name='OpenClawSelectionToken'
      AND column_name='conversationId' AND is_nullable='YES'
  ) THEN
    RAISE EXCEPTION 'OpenClawSelectionToken.conversationId is not nullable';
  END IF;
END
$verify$;
SQL
    local actual_rolled_back_rows
    actual_rolled_back_rows="$(docker exec -e "$PG_CLIENT_ENV" "$POSTGRES_CONTAINER" psql \
      -U "$REHEARSAL_DB_USER" -d "$REHEARSAL_DB_NAME" -Atqc \
      "SELECT count(*) FROM \"_prisma_migrations\" WHERE migration_name='$TARGET_MIGRATION' AND rolled_back_at IS NOT NULL;")" \
      || return 1
    [ "$actual_rolled_back_rows" = "$expected_rolled_back_rows" ] \
      || fail "target Prisma migration recovery rows differ: expected=$expected_rolled_back_rows actual=$actual_rolled_back_rows"
}

BASELINE_SCHEMA_SHA="$(schema_fingerprint)" \
    || fail 'could not fingerprint the restored baseline schema'
BASELINE_LEDGER_SHA="$(ledger_fingerprint)" \
    || fail 'could not fingerprint the restored baseline migration ledger'
BASELINE_ROW_COUNTS_SHA="$(row_count_fingerprint)" \
    || fail 'could not fingerprint the restored baseline table row counts'
BASELINE_DATA_SHA="$(data_fingerprint)" \
    || fail 'could not fingerprint the restored baseline data values and sequences'

run_candidate_command() {
    local name="$1" url="$2" output="$3"
    shift 3
    timeout --signal=TERM --kill-after=30s "$((MAX_DEPLOY_SECONDS + 30))s" \
      docker run --rm --name "$name" --label "$LABEL_KEY=$RUN_ID" \
        --network "$NETWORK_NAME" --read-only \
        --memory 2g --memory-swap 2g --cpus 1.5 --pids-limit 192 --blkio-weight 100 \
        --tmpfs /tmp:rw,noexec,nosuid,nodev,size=64m,mode=1777 \
        --cap-drop ALL --security-opt no-new-privileges \
        -e "DATABASE_URL=$url" -e NODE_ENV=production \
        -e RUN_MIGRATIONS=false -e RUN_SEED=false \
        --entrypoint /usr/bin/env "$CANDIDATE_IMAGE_ID" "$@" > "$output" 2>&1
}

run_candidate_migration() {
    local name="$1" url="$2" output="$3"
    run_candidate_command "$name" "$url" "$output" npm run prisma:deploy
}

BAD_DATABASE_URL="postgresql://${REHEARSAL_DB_USER}:${REHEARSAL_DB_PASSWORD}@postgres-unreachable:5432/${REHEARSAL_DB_NAME}?schema=public"
set +e
run_candidate_migration "$FAILURE_CONTAINER" "$BAD_DATABASE_URL" "$TMP_ROOT/connection-failure.log"
FAILURE_STATUS=$?
set -e
[ "$FAILURE_STATUS" -ne 0 ] \
    || fail 'simulated first database connection unexpectedly succeeded'
grep -Eqi 'P1001|Can.t reach database server' "$TMP_ROOT/connection-failure.log" \
    || { print_redacted_log "$TMP_ROOT/connection-failure.log"; fail 'failed attempt was not a database connection failure'; }
AFTER_FAILURE_SCHEMA_SHA="$(schema_fingerprint)" \
    || fail 'could not fingerprint schema after simulated connection failure'
AFTER_FAILURE_LEDGER_SHA="$(ledger_fingerprint)" \
    || fail 'could not fingerprint migration ledger after simulated connection failure'
AFTER_FAILURE_ROW_COUNTS_SHA="$(row_count_fingerprint)" \
    || fail 'could not fingerprint row counts after simulated connection failure'
AFTER_FAILURE_DATA_SHA="$(data_fingerprint)" \
    || fail 'could not fingerprint data after simulated connection failure'
[ "$AFTER_FAILURE_SCHEMA_SHA" = "$BASELINE_SCHEMA_SHA" ] \
    && [ "$AFTER_FAILURE_LEDGER_SHA" = "$BASELINE_LEDGER_SHA" ] \
    && [ "$AFTER_FAILURE_ROW_COUNTS_SHA" = "$BASELINE_ROW_COUNTS_SHA" ] \
    && [ "$AFTER_FAILURE_DATA_SHA" = "$BASELINE_DATA_SHA" ] \
    || fail 'failed connection attempt changed the disposable database'
info 'simulated first connection failure was observed and left the database unchanged'

CORRECT_DATABASE_URL="postgresql://${REHEARSAL_DB_USER}:${REHEARSAL_DB_PASSWORD}@postgres:5432/${REHEARSAL_DB_NAME}?schema=public"
if [ "$REHEARSAL_MODE" = 'already-applied-noop' ]; then
    set +e
    run_candidate_command "$STATUS_CONTAINER" "$CORRECT_DATABASE_URL" "$TMP_ROOT/migrate-status.log" \
        /app/node_modules/.bin/prisma migrate status
    STATUS_RESULT=$?
    set -e
    if [ "$STATUS_RESULT" -ne 0 ]; then
        if grep -Fq 'Following migrations have not yet been applied:' "$TMP_ROOT/migrate-status.log"; then
            REHEARSAL_MODE='followup-forward-migrations'
            info 'reviewed historical target is applied but later candidate migrations remain pending'
        else
            print_redacted_log "$TMP_ROOT/migrate-status.log"
            fail 'candidate prisma migrate status rejected the restored production backup'
        fi
    fi
fi

if [ "$REHEARSAL_MODE" = 'followup-forward-migrations' ]; then
    FIRST_DEPLOY_STARTED_AT="$(date +%s)"
    run_candidate_migration "$DEPLOY_ONE_CONTAINER" "$CORRECT_DATABASE_URL" "$TMP_ROOT/deploy-one.log" \
        || { print_redacted_log "$TMP_ROOT/deploy-one.log"; fail 'candidate follow-up migrations failed'; }
    FIRST_DEPLOY_SECONDS=$(( $(date +%s) - FIRST_DEPLOY_STARTED_AT ))
    [ "$FIRST_DEPLOY_SECONDS" -le "$MAX_DEPLOY_SECONDS" ] \
        || fail "follow-up migrations exceeded rehearsal budget: ${FIRST_DEPLOY_SECONDS}s > ${MAX_DEPLOY_SECONDS}s"

    run_candidate_migration "$DEPLOY_TWO_CONTAINER" "$CORRECT_DATABASE_URL" "$TMP_ROOT/deploy-two.log" \
        || { print_redacted_log "$TMP_ROOT/deploy-two.log"; fail 'second follow-up prisma deploy failed'; }
    grep -Eqi 'No pending migrations to apply|Database schema is up to date' "$TMP_ROOT/deploy-two.log" \
        || { print_redacted_log "$TMP_ROOT/deploy-two.log"; fail 'second follow-up deploy did not prove idempotency'; }
    run_candidate_command "$STATUS_CONTAINER" "$CORRECT_DATABASE_URL" "$TMP_ROOT/migrate-status-after.log" \
        /app/node_modules/.bin/prisma migrate status \
        || { print_redacted_log "$TMP_ROOT/migrate-status-after.log"; fail 'candidate status rejected the migrated rehearsal database'; }
    grep -Eqi 'Database schema is up to date|No pending migrations' "$TMP_ROOT/migrate-status-after.log" \
        || fail 'candidate status did not prove all follow-up migrations applied'

    SOURCE_MIGRATION_COUNT="$(find "$PROJECT_DIR/backend/prisma/migrations" -mindepth 1 -maxdepth 1 -type d | wc -l | tr -d '[:space:]')"
    SUCCESSFUL_MIGRATION_COUNT="$(docker exec -e "$PG_CLIENT_ENV" "$POSTGRES_CONTAINER" psql \
      -U "$REHEARSAL_DB_USER" -d "$REHEARSAL_DB_NAME" -Atqc \
      'SELECT count(*) FROM "_prisma_migrations" WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL;')"
    DISTINCT_SUCCESSFUL_MIGRATION_COUNT="$(docker exec -e "$PG_CLIENT_ENV" "$POSTGRES_CONTAINER" psql \
      -U "$REHEARSAL_DB_USER" -d "$REHEARSAL_DB_NAME" -Atqc \
      'SELECT count(DISTINCT migration_name) FROM "_prisma_migrations" WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL;')"
    [ "$SUCCESSFUL_MIGRATION_COUNT" = "$SOURCE_MIGRATION_COUNT" ] \
        && [ "$DISTINCT_SUCCESSFUL_MIGRATION_COUNT" = "$SOURCE_MIGRATION_COUNT" ] \
        || fail "candidate migration ledger is not exactly complete: source=$SOURCE_MIGRATION_COUNT successful=$SUCCESSFUL_MIGRATION_COUNT distinct=$DISTINCT_SUCCESSFUL_MIGRATION_COUNT"

    FOLLOWUP_SCHEMA_SHA="$(schema_fingerprint)" \
        || fail 'could not fingerprint schema after follow-up migrations'
    FOLLOWUP_LEDGER_SHA="$(ledger_fingerprint)" \
        || fail 'could not fingerprint migration ledger after follow-up migrations'
    FOLLOWUP_ROW_COUNTS_SHA="$(row_count_fingerprint)" \
        || fail 'could not fingerprint row counts after follow-up migrations'
    FOLLOWUP_DATA_SHA="$(data_fingerprint)" \
        || fail 'could not fingerprint data after follow-up migrations'

    FOLLOWUP_ROLLBACK_OUTPUT="$(bash "$PROJECT_DIR/scripts/recreate-db-from-backup.sh" \
        --backup "$BACKUP_FILE" --container "$POSTGRES_CONTAINER" \
        --user "$REHEARSAL_DB_USER" --database "$REHEARSAL_DB_NAME" \
        --max-restore-seconds "$MAX_RESTORE_SECONDS" --confirm-database-recreate)" \
        || fail 'follow-up migrated database could not be restored through the production rollback primitive'
    FOLLOWUP_ROLLBACK_SECONDS="$(printf '%s\n' "$FOLLOWUP_ROLLBACK_OUTPUT" | sed -n 's/^databaseRestoreSeconds=//p' | tail -1)"
    [[ "$FOLLOWUP_ROLLBACK_SECONDS" =~ ^[0-9]+$ ]] \
        || fail 'rollback primitive returned no auditable restore duration'
    FOLLOWUP_RESTORED_SCHEMA_SHA="$(schema_fingerprint)" \
        || fail 'could not fingerprint schema after follow-up rollback'
    FOLLOWUP_RESTORED_LEDGER_SHA="$(ledger_fingerprint)" \
        || fail 'could not fingerprint migration ledger after follow-up rollback'
    FOLLOWUP_RESTORED_ROW_COUNTS_SHA="$(row_count_fingerprint)" \
        || fail 'could not fingerprint row counts after follow-up rollback'
    FOLLOWUP_RESTORED_DATA_SHA="$(data_fingerprint)" \
        || fail 'could not fingerprint data after follow-up rollback'
    [ "$FOLLOWUP_RESTORED_SCHEMA_SHA" = "$BASELINE_SCHEMA_SHA" ] \
        && [ "$FOLLOWUP_RESTORED_LEDGER_SHA" = "$BASELINE_LEDGER_SHA" ] \
        && [ "$FOLLOWUP_RESTORED_ROW_COUNTS_SHA" = "$BASELINE_ROW_COUNTS_SHA" ] \
        && [ "$FOLLOWUP_RESTORED_DATA_SHA" = "$BASELINE_DATA_SHA" ] \
        || fail 'follow-up migration rollback did not reproduce the production backup exactly'
    info 'all candidate follow-up migrations, idempotency, and exact rollback restore passed'

    [ ! -f "$STORAGE_GUARD_FILE" ] || fail 'storage reserve guard was triggered during the rehearsal'
    stop_storage_watchdog
    cleanup_resources || fail 'disposable Docker resources could not be removed safely'
    EVIDENCE_TMP="$(mktemp "$EVIDENCE_DIR/.migration-rehearsal-XXXXXX.tmp")"
    cat > "$EVIDENCE_TMP" <<EOF
status=passed
completedAt=$(date -u +'%Y-%m-%dT%H:%M:%SZ')
runId=$RUN_ID
rehearsalMode=$REHEARSAL_MODE
backupSha256=$ACTUAL_BACKUP_SHA
backupBytes=$BACKUP_BYTES
sourceDatabaseBytes=$SOURCE_DATABASE_BYTES
candidateImage=$CANDIDATE_IMAGE
candidateImageId=$CANDIDATE_IMAGE_ID
candidateRevision=$CANDIDATE_REVISION
sourceMigrationCount=$SOURCE_MIGRATION_COUNT
successfulMigrationCount=$SUCCESSFUL_MIGRATION_COUNT
firstPrismaDeploySeconds=$FIRST_DEPLOY_SECONDS
secondPrismaDeployIdempotent=passed-noop
candidateMigrationStatus=up-to-date
migratedSchemaSha256=$FOLLOWUP_SCHEMA_SHA
migratedMigrationLedgerSha256=$FOLLOWUP_LEDGER_SHA
migratedTableRowCountsSha256=$FOLLOWUP_ROW_COUNTS_SHA
migratedDataSha256=$FOLLOWUP_DATA_SHA
rollbackPrimitiveRestore=passed
rollbackRestoreSeconds=$FOLLOWUP_ROLLBACK_SECONDS
baselineSchemaSha256=$BASELINE_SCHEMA_SHA
baselineMigrationLedgerSha256=$BASELINE_LEDGER_SHA
baselineTableRowCountsSha256=$BASELINE_ROW_COUNTS_SHA
baselineDataSha256=$BASELINE_DATA_SHA
restoredSchemaSha256=$FOLLOWUP_RESTORED_SCHEMA_SHA
restoredMigrationLedgerSha256=$FOLLOWUP_RESTORED_LEDGER_SHA
restoredTableRowCountsSha256=$FOLLOWUP_RESTORED_ROW_COUNTS_SHA
restoredDataSha256=$FOLLOWUP_RESTORED_DATA_SHA
disposableResourcesCleaned=passed
productionDatabaseOrVolumeTouched=false
EOF
    chmod 600 "$EVIDENCE_TMP"
    ln -- "$EVIDENCE_TMP" "$EVIDENCE_FILE" || fail 'evidence path appeared concurrently; refusing to overwrite it'
    rm -f -- "$EVIDENCE_TMP"
    EVIDENCE_TMP=""
    info "auditable follow-up migration evidence written with mode 600: $EVIDENCE_FILE"
    exit 0
fi

if [ "$REHEARSAL_MODE" = 'already-applied-noop' ]; then
    run_candidate_command "$STATUS_CONTAINER" "$CORRECT_DATABASE_URL" "$TMP_ROOT/migrate-status.log" \
        /app/node_modules/.bin/prisma migrate status \
        || { print_redacted_log "$TMP_ROOT/migrate-status.log"; fail 'candidate prisma migrate status rejected the already-applied production backup'; }
    grep -Eqi 'Database schema is up to date|No pending migrations' "$TMP_ROOT/migrate-status.log" \
        || { print_redacted_log "$TMP_ROOT/migrate-status.log"; fail 'candidate migration status did not prove an up-to-date schema'; }

    FIRST_DEPLOY_STARTED_AT="$(date +%s)"
    run_candidate_migration "$DEPLOY_ONE_CONTAINER" "$CORRECT_DATABASE_URL" "$TMP_ROOT/deploy-one.log" \
        || { print_redacted_log "$TMP_ROOT/deploy-one.log"; fail 'first no-op candidate prisma deploy failed'; }
    FIRST_DEPLOY_SECONDS=$(( $(date +%s) - FIRST_DEPLOY_STARTED_AT ))
    [ "$FIRST_DEPLOY_SECONDS" -le "$MAX_DEPLOY_SECONDS" ] \
        || fail "first no-op candidate deploy exceeded rehearsal budget: ${FIRST_DEPLOY_SECONDS}s > ${MAX_DEPLOY_SECONDS}s"
    grep -Eqi 'No pending migrations to apply|Database schema is up to date' "$TMP_ROOT/deploy-one.log" \
        || { print_redacted_log "$TMP_ROOT/deploy-one.log"; fail 'first candidate deploy was not a proven no-op'; }
    FIRST_NOOP_SCHEMA_SHA="$(schema_fingerprint)" \
        || fail 'could not fingerprint schema after first no-op deploy'
    FIRST_NOOP_LEDGER_SHA="$(ledger_fingerprint)" \
        || fail 'could not fingerprint migration ledger after first no-op deploy'
    FIRST_NOOP_ROW_COUNTS_SHA="$(row_count_fingerprint)" \
        || fail 'could not fingerprint row counts after first no-op deploy'
    FIRST_NOOP_DATA_SHA="$(data_fingerprint)" \
        || fail 'could not fingerprint data after first no-op deploy'
    [ "$FIRST_NOOP_SCHEMA_SHA" = "$BASELINE_SCHEMA_SHA" ] \
        && [ "$FIRST_NOOP_LEDGER_SHA" = "$BASELINE_LEDGER_SHA" ] \
        && [ "$FIRST_NOOP_ROW_COUNTS_SHA" = "$BASELINE_ROW_COUNTS_SHA" ] \
        && [ "$FIRST_NOOP_DATA_SHA" = "$BASELINE_DATA_SHA" ] \
        || fail 'first no-op candidate deploy changed the disposable database'

    run_candidate_migration "$DEPLOY_TWO_CONTAINER" "$CORRECT_DATABASE_URL" "$TMP_ROOT/deploy-two.log" \
        || { print_redacted_log "$TMP_ROOT/deploy-two.log"; fail 'second no-op candidate prisma deploy failed'; }
    grep -Eqi 'No pending migrations to apply|Database schema is up to date' "$TMP_ROOT/deploy-two.log" \
        || { print_redacted_log "$TMP_ROOT/deploy-two.log"; fail 'second candidate deploy did not prove no-op idempotency'; }

    NOOP_SCHEMA_SHA="$(schema_fingerprint)" \
        || fail 'could not fingerprint schema after no-op deploys'
    NOOP_LEDGER_SHA="$(ledger_fingerprint)" \
        || fail 'could not fingerprint migration ledger after no-op deploys'
    NOOP_ROW_COUNTS_SHA="$(row_count_fingerprint)" \
        || fail 'could not fingerprint row counts after no-op deploys'
    NOOP_DATA_SHA="$(data_fingerprint)" \
        || fail 'could not fingerprint data after no-op deploys'
    [ "$NOOP_SCHEMA_SHA" = "$BASELINE_SCHEMA_SHA" ] \
        && [ "$NOOP_LEDGER_SHA" = "$BASELINE_LEDGER_SHA" ] \
        && [ "$NOOP_ROW_COUNTS_SHA" = "$BASELINE_ROW_COUNTS_SHA" ] \
        && [ "$NOOP_DATA_SHA" = "$BASELINE_DATA_SHA" ] \
        || fail 'no-op candidate deploy changed schema, migration ledger, or table row counts'
    verify_release_migration_schema_contract 0 \
        || fail 'already-applied release migration schema contract is incomplete'
    info 'candidate status and two no-op deploys preserved the exact restored database state'

    [ -f "$PROJECT_DIR/scripts/recreate-db-from-backup.sh" ] \
        && [ ! -L "$PROJECT_DIR/scripts/recreate-db-from-backup.sh" ] \
        || fail 'shared database recreation helper is missing or symlinked'
    NOOP_ROLLBACK_OUTPUT="$(bash "$PROJECT_DIR/scripts/recreate-db-from-backup.sh" \
        --backup "$BACKUP_FILE" --container "$POSTGRES_CONTAINER" \
        --user "$REHEARSAL_DB_USER" --database "$REHEARSAL_DB_NAME" \
        --max-restore-seconds "$MAX_RESTORE_SECONDS" --confirm-database-recreate)" \
        || fail 'no-op disposable database could not be restored through the production rollback primitive'
    NOOP_ROLLBACK_RESTORE_SECONDS="$(printf '%s\n' "$NOOP_ROLLBACK_OUTPUT" | sed -n 's/^databaseRestoreSeconds=//p' | tail -1)"
    [[ "$NOOP_ROLLBACK_RESTORE_SECONDS" =~ ^[0-9]+$ ]] \
        || fail 'database recreation helper returned no auditable restore duration after no-op deploys'
    NOOP_RESTORED_SCHEMA_SHA="$(schema_fingerprint)" \
        || fail 'could not fingerprint schema after no-op rollback restore'
    NOOP_RESTORED_LEDGER_SHA="$(ledger_fingerprint)" \
        || fail 'could not fingerprint migration ledger after no-op rollback restore'
    NOOP_RESTORED_ROW_COUNTS_SHA="$(row_count_fingerprint)" \
        || fail 'could not fingerprint row counts after no-op rollback restore'
    NOOP_RESTORED_DATA_SHA="$(data_fingerprint)" \
        || fail 'could not fingerprint data after no-op rollback restore'
    [ "$NOOP_RESTORED_SCHEMA_SHA" = "$BASELINE_SCHEMA_SHA" ] \
        && [ "$NOOP_RESTORED_LEDGER_SHA" = "$BASELINE_LEDGER_SHA" ] \
        && [ "$NOOP_RESTORED_ROW_COUNTS_SHA" = "$BASELINE_ROW_COUNTS_SHA" ] \
        && [ "$NOOP_RESTORED_DATA_SHA" = "$BASELINE_DATA_SHA" ] \
        || fail 'production rollback primitive did not reproduce the no-op backup exactly'
    verify_release_migration_schema_contract 0 \
        || fail 'restored already-applied release migration schema contract is incomplete'
    info 'production rollback primitive reproduced the already-applied backup exactly'

    [ ! -f "$STORAGE_GUARD_FILE" ] \
        || fail 'storage reserve guard was triggered during the rehearsal'
    stop_storage_watchdog
    cleanup_resources || fail 'disposable Docker resources could not be removed safely'

    EVIDENCE_TMP="$(mktemp "$EVIDENCE_DIR/.migration-rehearsal-XXXXXX.tmp")"
    cat > "$EVIDENCE_TMP" <<EOF
status=passed
completedAt=$(date -u +'%Y-%m-%dT%H:%M:%SZ')
runId=$RUN_ID
rehearsalMode=$REHEARSAL_MODE
backupSha256=$ACTUAL_BACKUP_SHA
backupBytes=$BACKUP_BYTES
sourceDatabaseBytes=$SOURCE_DATABASE_BYTES
rehearsalDataRoot=$REHEARSAL_DATA_ROOT
availableBytesAtStart=$AVAILABLE_REHEARSAL_BYTES
restoreBudgetBytes=$RESTORE_BUDGET_BYTES
protectedHostReserveBytes=$HOST_RESERVE_BYTES
backupRestoreSeconds=$RESTORE_SECONDS
maximumAllowedBackupRestoreSeconds=$MAX_RESTORE_SECONDS
postgresResourceLimit=memory=4g,memorySwap=4g,cpus=2,pids=256,blkioWeight=100,logs=10m_x_1
candidateResourceLimit=memory=2g,memorySwap=2g,cpus=1.5,pids=192,blkioWeight=100
postgresImage=$POSTGRES_IMAGE
postgresImageId=$POSTGRES_IMAGE_ID
candidateImage=$CANDIDATE_IMAGE
candidateImageId=$CANDIDATE_IMAGE_ID
candidateRevision=$CANDIDATE_REVISION
migration=$TARGET_MIGRATION
foundationMigration=$FOUNDATION_MIGRATION
followupMigration=$FOLLOWUP_MIGRATION
migrationSha256=$SOURCE_MIGRATION_SHA
sourceMigrationTreeSha256=$SOURCE_MIGRATION_TREE_SHA
candidateMigrationTreeSha256=$CANDIDATE_MIGRATION_TREE_SHA
baselineMigrationState=already-applied-successfully
candidateMigrationStatus=up-to-date
simulatedFirstConnectionFailure=passed
transactionalBackfillFailureRecovery=not-applicable
unresolvedRetryBlockedByP3009=not-applicable
firstPrismaDeploy=passed-noop
firstPrismaDeploySeconds=$FIRST_DEPLOY_SECONDS
maximumAllowedPrismaDeploySeconds=$MAX_DEPLOY_SECONDS
secondPrismaDeployIdempotent=passed-noop
schemaContract=passed
databaseStateUnchanged=passed
firstNoopSchemaSha256=$FIRST_NOOP_SCHEMA_SHA
firstNoopMigrationLedgerSha256=$FIRST_NOOP_LEDGER_SHA
firstNoopTableRowCountsSha256=$FIRST_NOOP_ROW_COUNTS_SHA
firstNoopDataSha256=$FIRST_NOOP_DATA_SHA
secondNoopSchemaSha256=$NOOP_SCHEMA_SHA
secondNoopMigrationLedgerSha256=$NOOP_LEDGER_SHA
secondNoopTableRowCountsSha256=$NOOP_ROW_COUNTS_SHA
secondNoopDataSha256=$NOOP_DATA_SHA
baselineSchemaSha256=$BASELINE_SCHEMA_SHA
baselineMigrationLedgerSha256=$BASELINE_LEDGER_SHA
baselineTableRowCountsSha256=$BASELINE_ROW_COUNTS_SHA
baselineDataSha256=$BASELINE_DATA_SHA
forwardMigrationRollback=not-applicable-no-forward-change
rollbackPrimitiveRestore=passed
rollbackRestoreSeconds=$NOOP_ROLLBACK_RESTORE_SECONDS
rollbackSchemaSha256=$NOOP_RESTORED_SCHEMA_SHA
rollbackMigrationLedgerSha256=$NOOP_RESTORED_LEDGER_SHA
rollbackTableRowCountsSha256=$NOOP_RESTORED_ROW_COUNTS_SHA
rollbackDataSha256=$NOOP_RESTORED_DATA_SHA
disposableResourcesCleaned=passed
productionDatabaseOrVolumeTouched=false
EOF
    chmod 600 "$EVIDENCE_TMP"
    ln -- "$EVIDENCE_TMP" "$EVIDENCE_FILE" \
        || fail 'evidence path appeared concurrently; refusing to overwrite it'
    rm -f -- "$EVIDENCE_TMP"
    EVIDENCE_TMP=""
    info "auditable no-op evidence written with mode 600: $EVIDENCE_FILE"
    exit 0
fi

# Exercise the current data migration's transactional failure boundary. A
# disposable trigger rejects the exact NULL -> FALSE transition performed by
# the reviewed backfill. The UPDATE statement must remain atomic and Prisma
# must block an unsafe blind retry (P3009). After removing only the rehearsal
# trigger, `migrate resolve --rolled-back` must permit a clean replay.
docker exec -i -e "$PG_CLIENT_ENV" "$POSTGRES_CONTAINER" psql -v ON_ERROR_STOP=1 \
    -U "$REHEARSAL_DB_USER" -d "$REHEARSAL_DB_NAME" >/dev/null <<'SQL'
CREATE FUNCTION rehearsal_reject_verified_direct_backfill()
RETURNS trigger
LANGUAGE plpgsql
AS $trigger$
BEGIN
  IF OLD."isGroup" IS NULL AND NEW."isGroup" IS FALSE THEN
    RAISE EXCEPTION 'rehearsal forced verified-direct backfill failure';
  END IF;
  RETURN NEW;
END
$trigger$;

CREATE TRIGGER rehearsal_reject_verified_direct_backfill
BEFORE UPDATE OF "isGroup" ON "Conversation"
FOR EACH ROW
EXECUTE FUNCTION rehearsal_reject_verified_direct_backfill();
SQL
set +e
run_candidate_migration "$PARTIAL_FAILURE_CONTAINER" "$CORRECT_DATABASE_URL" "$TMP_ROOT/partial-ddl-failure.log"
PARTIAL_FAILURE_STATUS=$?
set -e
[ "$PARTIAL_FAILURE_STATUS" -ne 0 ] \
    || fail 'forced transactional backfill conflict unexpectedly succeeded'
grep -Eqi 'P3018|rehearsal forced verified-direct backfill failure|failed to apply|current transaction is aborted' "$TMP_ROOT/partial-ddl-failure.log" \
    || { print_redacted_log "$TMP_ROOT/partial-ddl-failure.log"; fail 'forced backfill conflict was not reported as a migration failure'; }
PARTIAL_FAILED_LEDGER="$(docker exec -e "$PG_CLIENT_ENV" "$POSTGRES_CONTAINER" psql -U "$REHEARSAL_DB_USER" -d "$REHEARSAL_DB_NAME" -Atqc \
    "SELECT count(*) FROM \"_prisma_migrations\" WHERE migration_name='$TARGET_MIGRATION' AND finished_at IS NULL AND rolled_back_at IS NULL;")"
IFS=',' read -r PARTIAL_ELIGIBLE_NULL PARTIAL_ELIGIBLE_FALSE PARTIAL_ELIGIBLE_TRUE \
    PARTIAL_OTHER_NULL_COUNT PARTIAL_OTHER_NULL_DIGEST <<< "$(backfill_state)"
[ "$PARTIAL_FAILED_LEDGER" = '1' ] \
    && [ "$PARTIAL_ELIGIBLE_NULL" = "$BASELINE_ELIGIBLE_NULL" ] \
    && [ "$PARTIAL_ELIGIBLE_FALSE" = "$BASELINE_ELIGIBLE_FALSE" ] \
    && [ "$PARTIAL_ELIGIBLE_TRUE" = "$BASELINE_ELIGIBLE_TRUE" ] \
    && [ "$PARTIAL_OTHER_NULL_COUNT" = "$BASELINE_OTHER_NULL_COUNT" ] \
    && [ "$PARTIAL_OTHER_NULL_DIGEST" = "$BASELINE_OTHER_NULL_DIGEST" ] \
    || fail 'forced migration failure did not preserve backfill atomicity and one failed ledger row'

set +e
run_candidate_migration "$P3009_CONTAINER" "$CORRECT_DATABASE_URL" "$TMP_ROOT/blocked-retry.log"
P3009_STATUS=$?
set -e
[ "$P3009_STATUS" -ne 0 ] && grep -Eq 'P3009' "$TMP_ROOT/blocked-retry.log" \
    || { print_redacted_log "$TMP_ROOT/blocked-retry.log"; fail 'Prisma did not block retry of the unresolved failed migration'; }
docker exec -e "$PG_CLIENT_ENV" "$POSTGRES_CONTAINER" psql -v ON_ERROR_STOP=1 \
    -U "$REHEARSAL_DB_USER" -d "$REHEARSAL_DB_NAME" \
    -c 'DROP TRIGGER rehearsal_reject_verified_direct_backfill ON "Conversation"; DROP FUNCTION rehearsal_reject_verified_direct_backfill();' >/dev/null
run_candidate_command "$RESOLVE_CONTAINER" "$CORRECT_DATABASE_URL" "$TMP_ROOT/resolve-rolled-back.log" \
    /app/node_modules/.bin/prisma migrate resolve --rolled-back "$TARGET_MIGRATION" \
    || { print_redacted_log "$TMP_ROOT/resolve-rolled-back.log"; fail 'candidate Prisma could not resolve the disposable failed migration as rolled back'; }
ROLLED_BACK_LEDGER="$(docker exec -e "$PG_CLIENT_ENV" "$POSTGRES_CONTAINER" psql -U "$REHEARSAL_DB_USER" -d "$REHEARSAL_DB_NAME" -Atqc \
    "SELECT count(*) FROM \"_prisma_migrations\" WHERE migration_name='$TARGET_MIGRATION' AND rolled_back_at IS NOT NULL;")"
[ "$ROLLED_BACK_LEDGER" = '1' ] \
    || fail 'resolved failed migration is not recorded exactly once as rolled back'
info 'transactional backfill failure and P3009 recovery path passed in the disposable database'

FIRST_DEPLOY_STARTED_AT="$(date +%s)"
run_candidate_migration "$DEPLOY_ONE_CONTAINER" "$CORRECT_DATABASE_URL" "$TMP_ROOT/deploy-one.log" \
    || { print_redacted_log "$TMP_ROOT/deploy-one.log"; fail 'first candidate prisma deploy failed'; }
FIRST_DEPLOY_SECONDS=$(( $(date +%s) - FIRST_DEPLOY_STARTED_AT ))
[ "$FIRST_DEPLOY_SECONDS" -le "$MAX_DEPLOY_SECONDS" ] \
    || fail "first candidate prisma deploy exceeded rehearsal budget: ${FIRST_DEPLOY_SECONDS}s > ${MAX_DEPLOY_SECONDS}s"
run_candidate_migration "$DEPLOY_TWO_CONTAINER" "$CORRECT_DATABASE_URL" "$TMP_ROOT/deploy-two.log" \
    || { print_redacted_log "$TMP_ROOT/deploy-two.log"; fail 'second candidate prisma deploy failed'; }
grep -Eqi 'No pending migrations to apply|Database schema is up to date' "$TMP_ROOT/deploy-two.log" \
    || { print_redacted_log "$TMP_ROOT/deploy-two.log"; fail 'second prisma deploy did not prove idempotency'; }

verify_release_migration_schema_contract 1 \
    || fail 'forward-migrated release schema contract is incomplete'
IFS=',' read -r MIGRATED_ELIGIBLE_NULL MIGRATED_ELIGIBLE_FALSE MIGRATED_ELIGIBLE_TRUE \
    MIGRATED_OTHER_NULL_COUNT MIGRATED_OTHER_NULL_DIGEST <<< "$(backfill_state)"
EXPECTED_MIGRATED_FALSE=$((BASELINE_ELIGIBLE_FALSE + BASELINE_ELIGIBLE_NULL))
[ "$MIGRATED_ELIGIBLE_NULL" = '0' ] \
    && [ "$MIGRATED_ELIGIBLE_FALSE" = "$EXPECTED_MIGRATED_FALSE" ] \
    && [ "$MIGRATED_ELIGIBLE_TRUE" = "$BASELINE_ELIGIBLE_TRUE" ] \
    && [ "$MIGRATED_OTHER_NULL_COUNT" = "$BASELINE_OTHER_NULL_COUNT" ] \
    && [ "$MIGRATED_OTHER_NULL_DIGEST" = "$BASELINE_OTHER_NULL_DIGEST" ] \
    || fail 'verified-direct WhatsApp backfill changed rows outside the reviewed identity boundary'
info 'candidate migration applied twice, changed only verified direct legacy rows, and all release contracts passed'

# Exercise the exact destructive restore primitive used by both rollback.sh and
# restore-db.sh. An old archive cannot remove forward-only objects with
# pg_restore --clean, so the helper must recreate the whole database first.
[ -f "$PROJECT_DIR/scripts/recreate-db-from-backup.sh" ] \
    && [ ! -L "$PROJECT_DIR/scripts/recreate-db-from-backup.sh" ] \
    || fail 'shared database recreation helper is missing or symlinked'
ROLLBACK_OUTPUT="$(bash "$PROJECT_DIR/scripts/recreate-db-from-backup.sh" \
    --backup "$BACKUP_FILE" --container "$POSTGRES_CONTAINER" \
    --user "$REHEARSAL_DB_USER" --database "$REHEARSAL_DB_NAME" \
    --max-restore-seconds "$MAX_RESTORE_SECONDS" --confirm-database-recreate)" \
    || fail 'forward-migrated disposable database could not be restored through the production rollback primitive'
ROLLBACK_RESTORE_SECONDS="$(printf '%s\n' "$ROLLBACK_OUTPUT" | sed -n 's/^databaseRestoreSeconds=//p' | tail -1)"
[[ "$ROLLBACK_RESTORE_SECONDS" =~ ^[0-9]+$ ]] \
    || fail 'database recreation helper returned no auditable restore duration'
RESTORED_SCHEMA_SHA="$(schema_fingerprint)" \
    || fail 'could not fingerprint schema after rollback restore'
RESTORED_LEDGER_SHA="$(ledger_fingerprint)" \
    || fail 'could not fingerprint migration ledger after rollback restore'
RESTORED_ROW_COUNTS_SHA="$(row_count_fingerprint)" \
    || fail 'could not fingerprint table row counts after rollback restore'
RESTORED_DATA_SHA="$(data_fingerprint)" \
    || fail 'could not fingerprint data after rollback restore'
ROLLBACK_MISMATCHES=()
[ "$RESTORED_SCHEMA_SHA" = "$BASELINE_SCHEMA_SHA" ] \
    || ROLLBACK_MISMATCHES+=("schema:$BASELINE_SCHEMA_SHA/$RESTORED_SCHEMA_SHA")
[ "$RESTORED_LEDGER_SHA" = "$BASELINE_LEDGER_SHA" ] \
    || ROLLBACK_MISMATCHES+=("ledger:$BASELINE_LEDGER_SHA/$RESTORED_LEDGER_SHA")
[ "$RESTORED_ROW_COUNTS_SHA" = "$BASELINE_ROW_COUNTS_SHA" ] \
    || ROLLBACK_MISMATCHES+=("row-counts:$BASELINE_ROW_COUNTS_SHA/$RESTORED_ROW_COUNTS_SHA")
[ "$RESTORED_DATA_SHA" = "$BASELINE_DATA_SHA" ] \
    || ROLLBACK_MISMATCHES+=("data:$BASELINE_DATA_SHA/$RESTORED_DATA_SHA")
[ "${#ROLLBACK_MISMATCHES[@]}" -eq 0 ] \
    || fail "forward migration rollback fingerprint mismatch: ${ROLLBACK_MISMATCHES[*]}"
ROLLBACK_TARGET_ROWS="$(docker exec -e "$PG_CLIENT_ENV" "$POSTGRES_CONTAINER" psql -U "$REHEARSAL_DB_USER" -d "$REHEARSAL_DB_NAME" -Atqc \
    "SELECT count(*) FROM \"_prisma_migrations\" WHERE migration_name='$TARGET_MIGRATION';")"
ROLLBACK_FOUNDATION_ROWS="$(docker exec -e "$PG_CLIENT_ENV" "$POSTGRES_CONTAINER" psql -U "$REHEARSAL_DB_USER" -d "$REHEARSAL_DB_NAME" -Atqc \
    "SELECT count(*) FROM \"_prisma_migrations\" WHERE migration_name='$FOUNDATION_MIGRATION' AND finished_at IS NOT NULL AND rolled_back_at IS NULL;")"
ROLLBACK_FOLLOWUP_ROWS="$(docker exec -e "$PG_CLIENT_ENV" "$POSTGRES_CONTAINER" psql -U "$REHEARSAL_DB_USER" -d "$REHEARSAL_DB_NAME" -Atqc \
    "SELECT count(*) FROM \"_prisma_migrations\" WHERE migration_name='$FOLLOWUP_MIGRATION' AND finished_at IS NOT NULL AND rolled_back_at IS NULL;")"
ROLLBACK_RELEASE_TABLE="$(docker exec -e "$PG_CLIENT_ENV" "$POSTGRES_CONTAINER" psql -U "$REHEARSAL_DB_USER" -d "$REHEARSAL_DB_NAME" -Atqc \
    "SELECT to_regclass('public.\"OwnerNotificationOutbox\"') IS NOT NULL;")"
ROLLBACK_RELEASE_ENUM="$(docker exec -e "$PG_CLIENT_ENV" "$POSTGRES_CONTAINER" psql -U "$REHEARSAL_DB_USER" -d "$REHEARSAL_DB_NAME" -Atqc \
    "SELECT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'OwnerNotificationStatus');")"
ROLLBACK_SELECTION_COLUMN="$(docker exec -e "$PG_CLIENT_ENV" "$POSTGRES_CONTAINER" psql -U "$REHEARSAL_DB_USER" -d "$REHEARSAL_DB_NAME" -Atqc \
    "SELECT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='OpenClawSelectionToken' AND column_name='leadId');")"
[ "$ROLLBACK_TARGET_ROWS" = '0' ] && [ "$ROLLBACK_FOUNDATION_ROWS" = '1' ] && [ "$ROLLBACK_FOLLOWUP_ROWS" = '1' ] \
    && [ "$ROLLBACK_RELEASE_TABLE" = 't' ] && [ "$ROLLBACK_RELEASE_ENUM" = 't' ] && [ "$ROLLBACK_SELECTION_COLUMN" = 't' ] \
    || fail 'recreated-database rollback did not restore the exact pre-backfill migration foundation'
info 'forward migration -> shared production rollback primitive -> baseline equivalence passed'

[ ! -f "$STORAGE_GUARD_FILE" ] \
    || fail 'storage reserve guard was triggered during the rehearsal'
stop_storage_watchdog
cleanup_resources || fail 'disposable Docker resources could not be removed safely'

EVIDENCE_TMP="$(mktemp "$EVIDENCE_DIR/.migration-rehearsal-XXXXXX.tmp")"
cat > "$EVIDENCE_TMP" <<EOF
status=passed
completedAt=$(date -u +'%Y-%m-%dT%H:%M:%SZ')
runId=$RUN_ID
rehearsalMode=$REHEARSAL_MODE
backupSha256=$ACTUAL_BACKUP_SHA
backupBytes=$BACKUP_BYTES
sourceDatabaseBytes=$SOURCE_DATABASE_BYTES
rehearsalDataRoot=$REHEARSAL_DATA_ROOT
availableBytesAtStart=$AVAILABLE_REHEARSAL_BYTES
restoreBudgetBytes=$RESTORE_BUDGET_BYTES
protectedHostReserveBytes=$HOST_RESERVE_BYTES
backupRestoreSeconds=$RESTORE_SECONDS
maximumAllowedBackupRestoreSeconds=$MAX_RESTORE_SECONDS
postgresResourceLimit=memory=4g,memorySwap=4g,cpus=2,pids=256,blkioWeight=100,logs=10m_x_1
candidateResourceLimit=memory=2g,memorySwap=2g,cpus=1.5,pids=192,blkioWeight=100
postgresImage=$POSTGRES_IMAGE
postgresImageId=$POSTGRES_IMAGE_ID
candidateImage=$CANDIDATE_IMAGE
candidateImageId=$CANDIDATE_IMAGE_ID
candidateRevision=$CANDIDATE_REVISION
migration=$TARGET_MIGRATION
foundationMigration=$FOUNDATION_MIGRATION
followupMigration=$FOLLOWUP_MIGRATION
migrationSha256=$SOURCE_MIGRATION_SHA
sourceMigrationTreeSha256=$SOURCE_MIGRATION_TREE_SHA
candidateMigrationTreeSha256=$CANDIDATE_MIGRATION_TREE_SHA
simulatedFirstConnectionFailure=passed
baselineEligibleNullRows=$BASELINE_ELIGIBLE_NULL
baselineEligibleFalseRows=$BASELINE_ELIGIBLE_FALSE
baselineExcludedNullRows=$BASELINE_OTHER_NULL_COUNT
migratedEligibleNullRows=$MIGRATED_ELIGIBLE_NULL
migratedEligibleFalseRows=$MIGRATED_ELIGIBLE_FALSE
excludedNullRowsUnchanged=passed
transactionalBackfillFailureRecovery=passed
unresolvedRetryBlockedByP3009=passed
firstPrismaDeploy=passed
firstPrismaDeploySeconds=$FIRST_DEPLOY_SECONDS
maximumAllowedPrismaDeploySeconds=$MAX_DEPLOY_SECONDS
secondPrismaDeployIdempotent=passed
schemaContract=passed
forwardMigrationRollback=passed
rollbackRestoreSeconds=$ROLLBACK_RESTORE_SECONDS
rollbackSchemaSha256=$RESTORED_SCHEMA_SHA
rollbackMigrationLedgerSha256=$RESTORED_LEDGER_SHA
rollbackTableRowCountsSha256=$RESTORED_ROW_COUNTS_SHA
rollbackDataSha256=$RESTORED_DATA_SHA
disposableResourcesCleaned=passed
productionDatabaseOrVolumeTouched=false
EOF
chmod 600 "$EVIDENCE_TMP"
ln -- "$EVIDENCE_TMP" "$EVIDENCE_FILE" \
    || fail 'evidence path appeared concurrently; refusing to overwrite it'
rm -f -- "$EVIDENCE_TMP"
EVIDENCE_TMP=""
info "auditable evidence written with mode 600: $EVIDENCE_FILE"
info 'isolated migration rehearsal passed; no production database or volume was addressed'
