#!/usr/bin/env bash
# Vaysen Pilot rollback using a peeled immutable revision and a complete,
# persistent release archive. Relative bind mounts never resolve from /tmp.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
info() { printf '[ROLLBACK] %s\n' "$*"; }
fail() { printf '[ROLLBACK ERROR] %s\n' "$*" >&2; exit 1; }
REPO_ROOT="$(git -C "$PROJECT_DIR" rev-parse --show-toplevel)" \
    || fail "project directory is not a Git worktree"
PROJECT_PREFIX="$(git -C "$PROJECT_DIR" rev-parse --show-prefix)"
PROJECT_ARCHIVE_PATH="${PROJECT_PREFIX%/}"
LIFECYCLE_HELPER="$SCRIPT_DIR/compose-container-lifecycle.sh"

require_immutable_rollback_file() {
    local relative="$1" file expected_blob actual_blob mode
    file="$PROJECT_DIR/$relative"
    [ -f "$file" ] && [ ! -L "$file" ] \
        || fail "rollback trust-chain file is missing or symlinked: $relative"
    expected_blob="$(git -C "$PROJECT_DIR" rev-parse --verify "HEAD:${PROJECT_PREFIX}${relative}" 2>/dev/null || true)"
    actual_blob="$(git -C "$PROJECT_DIR" hash-object --no-filters "$file" 2>/dev/null || true)"
    [ -n "$expected_blob" ] && [ "$actual_blob" = "$expected_blob" ] \
        || fail "rollback trust-chain file does not match immutable HEAD: $relative"
    [ "$(stat -c '%u' "$file")" = "$(id -u)" ] \
        || fail "rollback trust-chain file must be owned by the rollback user: $relative"
    mode="$(stat -c '%a' "$file")"
    [ $((8#$mode & 0022)) -eq 0 ] \
        || fail "rollback trust-chain file must not be group/world writable: $relative"
}

ROLLBACK_TRUST_CHAIN=(
    scripts/rollback.sh
    scripts/compose-container-lifecycle.sh
    scripts/validate-production-env.mjs
    scripts/verify-db-backup.sh
    scripts/recreate-db-from-backup.sh
    scripts/restore-runtime-data.sh
    scripts/runtime-restore-transaction.sh
    scripts/runtime-link-manifest.sh
    scripts/runtime-link-contract.mjs
    scripts/run-runtime-link-contract.sh
    scripts/verify-runtime-image-baseline.mjs
    scripts/rollback-smoke-test.sh
    docker-compose.prod.yml
    nginx/nginx.conf
    nginx/conf.d/vaysen-crm-lan.conf
)
for trusted_file in "${ROLLBACK_TRUST_CHAIN[@]}"; do
    require_immutable_rollback_file "$trusted_file"
done
# shellcheck source=compose-container-lifecycle.sh
source "$LIFECYCLE_HELPER"
ENV_FILE="${ENV_FILE:-$PROJECT_DIR/.env}"
BACKUP_DIR="${BACKUP_DIR:-/var/lib/vaysen-crm/backups}"
RELEASES_DIR="${RELEASES_DIR:-/var/lib/vaysen-crm/releases}"
COMPOSE_PROJECT_NAME="${COMPOSE_PROJECT_NAME:-vaysen-ai-crm}"
DB_BACKUP=""
RUNTIME_BACKUP=""
USE_LATEST_DB=0
CHECK_ONLY=0
CHECK_APP_ONLY=0
REV=""
RUNTIME_BASELINE=""

while [ "$#" -gt 0 ]; do
    case "$1" in
        --db-backup) [ "$#" -ge 2 ] || fail "--db-backup requires a file"; DB_BACKUP="$2"; shift 2 ;;
        --runtime-backup) [ "$#" -ge 2 ] || fail "--runtime-backup requires a file"; RUNTIME_BACKUP="$2"; shift 2 ;;
        --latest-db) USE_LATEST_DB=1; shift ;;
        --check) CHECK_ONLY=1; shift ;;
        --check-app) CHECK_ONLY=1; CHECK_APP_ONLY=1; shift ;;
        --rev) [ "$#" -ge 2 ] || fail "--rev requires a tag or commit"; REV="$2"; shift 2 ;;
        --runtime-baseline) [ "$#" -ge 2 ] || fail "--runtime-baseline requires a file"; RUNTIME_BASELINE="$2"; shift 2 ;;
        -h|--help) sed -n '1,18p' "$0"; exit 0 ;;
        *) fail "unknown argument: $1" ;;
    esac
done

[ -f "$ENV_FILE" ] && [ ! -L "$ENV_FILE" ] || fail "environment file is missing or symlinked: $ENV_FILE"
[ "$(stat -c '%u' "$ENV_FILE")" = "$(id -u)" ] \
    || fail "environment file must be owned by the rollback user"
ENV_MODE="$(stat -c '%a' "$ENV_FILE")"
case "$ENV_MODE" in 600|640) ;; *) fail "environment file mode must be 600 or 640" ;; esac
node "$SCRIPT_DIR/validate-production-env.mjs" "$ENV_FILE" >/dev/null \
    || fail "production environment/image contract failed"
[ "$USE_LATEST_DB" -eq 1 ] || [ -n "$DB_BACKUP" ] || [ -n "$RUNTIME_BACKUP" ] || [ -n "$REV" ] \
    || fail "specify --db-backup/--latest-db, --runtime-backup, and/or --rev"
compose_lifecycle_acquire_transaction_lock "$RELEASES_DIR" \
    || fail "could not acquire the production lifecycle transaction lock"

current_compose() {
    docker compose --project-name "$COMPOSE_PROJECT_NAME" \
        --project-directory "$PROJECT_DIR" --env-file "$ENV_FILE" \
        -f "$PROJECT_DIR/docker-compose.prod.yml" "$@"
}

WORKERS=(worker-email-compose worker-email-validate worker-email-send worker-prospect-search worker-deep-research worker-maintenance)
compose_lifecycle_discover_vaysen-crm "$COMPOSE_PROJECT_NAME" true \
    || fail "could not establish an owned current-container inventory"
CURRENT_OPENCLAW_PRESENT=0
CURRENT_OPENCLAW_CONTAINER_ID=""
if CURRENT_OPENCLAW_CONTAINER_ID="$(compose_lifecycle_id_for_service openclaw-gateway)"; then
    CURRENT_OPENCLAW_PRESENT=1
fi
OLD_HAS_OPENCLAW=0

restart_current_app() {
    compose_lifecycle_start_all
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

if [ "$USE_LATEST_DB" -eq 1 ]; then
    while IFS= read -r candidate; do
        if [ -f "$candidate.sha256" ] && [ ! -L "$candidate.sha256" ]; then
            DB_BACKUP="$candidate"
            break
        fi
    done < <(find "$BACKUP_DIR" -maxdepth 1 -type f -name 'vaysen-crm_*.dump' -printf '%T@ %p\n' 2>/dev/null \
        | sort -nr | cut -d' ' -f2-)
    [ -n "$DB_BACKUP" ] || fail "no database backup found in $BACKUP_DIR"
fi

if [ -n "$REV" ]; then
    # Resolve and fully validate the old application before touching the
    # database. A joint rollback must never restore an old schema and then
    # discover that its matching immutable images or Compose model are absent.
    OLD_COMMIT="$(git -C "$REPO_ROOT" rev-parse --verify "${REV}^{}")" \
        || fail "revision cannot be peeled to a commit: $REV"
    git -C "$REPO_ROOT" cat-file -e "${OLD_COMMIT}^{commit}" 2>/dev/null \
        || fail "revision is not a commit: $REV"
    OLD_SHORT="$(git -C "$REPO_ROOT" rev-parse --short=8 "$OLD_COMMIT")"
    OLD_RELEASE_TAG=""
    if [[ "$REV" =~ ^vaysen-crm-lan(-pilot)?-v[0-9]+\.[0-9]+\.[0-9]+-r[0-9]+$ ]]; then
        OLD_RELEASE_TAG="$REV"
    else
        mapfile -t OLD_RELEASE_TAGS < <(
            git -C "$REPO_ROOT" tag --points-at "$OLD_COMMIT" \
                | grep -E '^vaysen-crm-lan(-pilot)?-v[0-9]+\.[0-9]+\.[0-9]+-r[0-9]+$' \
                | sort -u || true
        )
        [ "${#OLD_RELEASE_TAGS[@]}" -eq 1 ] \
            || fail "rollback commit must resolve to exactly one immutable Linux release tag"
        OLD_RELEASE_TAG="${OLD_RELEASE_TAGS[0]}"
    fi
    [ "$(git -C "$REPO_ROOT" cat-file -t "$OLD_RELEASE_TAG" 2>/dev/null || true)" = tag ] \
        || fail "rollback release tag must be an annotated immutable tag: $OLD_RELEASE_TAG"
    [ "$(git -C "$REPO_ROOT" rev-parse --verify "${OLD_RELEASE_TAG}^{}")" = "$OLD_COMMIT" ] \
        || fail "rollback release tag does not peel to the selected commit"
    [ -n "$RUNTIME_BASELINE" ] \
        || fail "--runtime-baseline is mandatory for an application rollback"
    [ -f "$RUNTIME_BASELINE" ] && [ ! -L "$RUNTIME_BASELINE" ] \
        || fail "runtime image baseline is missing or symlinked: $RUNTIME_BASELINE"
    RUNTIME_BASELINE_DIR="$(cd "$(dirname "$RUNTIME_BASELINE")" && pwd -P)"
    RUNTIME_BASELINE="$RUNTIME_BASELINE_DIR/$(basename "$RUNTIME_BASELINE")"
    case "$RUNTIME_BASELINE" in
        "$PROJECT_DIR"/security/release-runtime-baselines/*.json) ;;
        *) fail "runtime image baseline must be an immutable file inside the candidate release" ;;
    esac
    [ "$(basename "$RUNTIME_BASELINE")" = "${OLD_RELEASE_TAG}.json" ] \
        || fail "runtime image baseline filename does not match the rollback tag"
    RUNTIME_BASELINE_RELATIVE="${RUNTIME_BASELINE#"$PROJECT_DIR/"}"
    require_immutable_rollback_file "$RUNTIME_BASELINE_RELATIVE"
    node "$SCRIPT_DIR/verify-runtime-image-baseline.mjs" \
        --baseline "$RUNTIME_BASELINE" --expected-tag "$OLD_RELEASE_TAG" \
        --expected-commit "$OLD_COMMIT" --expected-project "$COMPOSE_PROJECT_NAME" \
        --mode validate \
        || fail "runtime image baseline structure or release identity is invalid"

    MIGRATION_PATH="${PROJECT_ARCHIVE_PATH:+$PROJECT_ARCHIVE_PATH/}backend/prisma/migrations"
    CURRENT_MIGRATION_TREE="$(git -C "$REPO_ROOT" rev-parse "HEAD:$MIGRATION_PATH" 2>/dev/null || printf 'missing')"
    OLD_MIGRATION_TREE="$(git -C "$REPO_ROOT" rev-parse "$OLD_COMMIT:$MIGRATION_PATH" 2>/dev/null || printf 'missing')"
    if [ "$CURRENT_MIGRATION_TREE" != "$OLD_MIGRATION_TREE" ] && [ -z "$DB_BACKUP" ] \
        && [ "$CHECK_APP_ONLY" -eq 0 ]; then
        fail "migration tree differs between current and old release; --db-backup is mandatory"
    fi

    [ -d "$RELEASES_DIR" ] && [ ! -L "$RELEASES_DIR" ] && [ -w "$RELEASES_DIR" ] \
        || fail "release archive root must pre-exist, be writable, and not be a symlink: $RELEASES_DIR"
    RELEASE_ROOT="$RELEASES_DIR/$OLD_COMMIT"
    if [ -n "$PROJECT_ARCHIVE_PATH" ]; then
        OLD_PROJECT="$RELEASE_ROOT/$PROJECT_ARCHIVE_PATH"
    else
        OLD_PROJECT="$RELEASE_ROOT"
    fi
    if [ ! -f "$OLD_PROJECT/docker-compose.prod.yml" ]; then
        [ ! -e "$RELEASE_ROOT" ] \
            || fail "incomplete release archive already exists; inspect and remove it manually: $RELEASE_ROOT"
        STAGING="$(mktemp -d "$RELEASES_DIR/.extract-${OLD_SHORT}-XXXXXX")"
        if [ -n "$PROJECT_ARCHIVE_PATH" ]; then
            git -C "$REPO_ROOT" archive "$OLD_COMMIT" -- "$PROJECT_ARCHIVE_PATH" | tar -x -C "$STAGING"
        else
            git -C "$REPO_ROOT" archive "$OLD_COMMIT" | tar -x -C "$STAGING"
        fi
        if [ -n "$PROJECT_ARCHIVE_PATH" ]; then
            STAGED_PROJECT="$STAGING/$PROJECT_ARCHIVE_PATH"
        else
            STAGED_PROJECT="$STAGING"
        fi
        [ -f "$STAGED_PROJECT/docker-compose.prod.yml" ] \
            || fail "release archive does not contain production compose"
        mv "$STAGING" "$RELEASE_ROOT"
    fi

    APP_DATA_DIR="$(env_value APP_DATA_DIR)" || fail "APP_DATA_DIR is missing from environment file"
    LAN_BIND_IP="$(env_value LAN_BIND_IP)" || fail "LAN_BIND_IP is missing from environment file"
    LOCAL_LAN_BIND_IP="$(env_value LOCAL_LAN_BIND_IP)" || fail "LOCAL_LAN_BIND_IP is missing from environment file"
    if [ "$CHECK_ONLY" -eq 0 ]; then
        for runtime_path in uploads .customizer-assets .whatsapp-sessions; do
            [ -d "$APP_DATA_DIR/$runtime_path" ] && [ ! -L "$APP_DATA_DIR/$runtime_path" ] \
                || fail "runtime data directory is missing or symlinked: $APP_DATA_DIR/$runtime_path"
        done
    fi
    # Old releases predate both the host bind-mount contract and the LAN-only
    # edge contract. Apply a generated override so rollback cannot reopen the
    # legacy public 80/443 bindings or revive unsafe runtime feature flags.
    RUNTIME_OVERRIDE="$RELEASE_ROOT/runtime-bind.override.yml"
    SAFE_NGINX_CONFIG="$PROJECT_DIR/nginx/nginx.conf"
    SAFE_NGINX_SITE="$PROJECT_DIR/nginx/conf.d/vaysen-crm-lan.conf"
    [ -f "$SAFE_NGINX_CONFIG" ] && [ ! -L "$SAFE_NGINX_CONFIG" ] \
        || fail "safe rollback nginx config is missing or symlinked"
    [ -f "$SAFE_NGINX_SITE" ] && [ ! -L "$SAFE_NGINX_SITE" ] \
        || fail "safe rollback nginx site is missing or symlinked"
    umask 077
    cat > "$RUNTIME_OVERRIDE" <<EOF
services:
  backend:
    # The pre-migration image hard-codes prisma migrate deploy in CMD and
    # does not honor RUN_MIGRATIONS. Override the command as well as the
    # environment so a database rollback cannot migrate itself forward.
    command: ["node", "dist/src/main.js"]
    volumes:
      - "$APP_DATA_DIR/uploads:/app/uploads"
      - "$APP_DATA_DIR/uploads:/uploads"
      - "$APP_DATA_DIR/.customizer-assets:/app/.customizer-assets"
      - "$APP_DATA_DIR/.whatsapp-sessions:/app/.whatsapp-sessions"
    environment:
      ENABLE_SWAGGER: "false"
      EMAIL_SEND_DISABLED: "true"
      EMAIL_SEED_TEST_ENABLED: "false"
      EVOLUTION_API_ENABLED: "false"
      RUN_MIGRATIONS: "false"
      RUN_SEED: "false"
    healthcheck:
      test: ["CMD", "curl", "-f", "http://localhost:4000/health"]
      interval: 10s
      timeout: 5s
      retries: 18
      start_period: 30s
  frontend:
    healthcheck:
      test: ["CMD", "node", "-e", "fetch('http://127.0.0.1:3000/login').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"]
      interval: 10s
      timeout: 5s
      retries: 18
      start_period: 30s
  worker-email-send:
    environment:
      EMAIL_SEND_DISABLED: "true"
      EMAIL_SEND_ENABLED: "false"
      RUN_MIGRATIONS: "false"
      RUN_SEED: "false"
  nginx:
    ports: !override
      - "$LAN_BIND_IP:80:80"
      - "$LOCAL_LAN_BIND_IP:80:80"
    volumes: !override
      - "$SAFE_NGINX_CONFIG:/etc/nginx/nginx.conf:ro"
      - "$SAFE_NGINX_SITE:/etc/nginx/conf.d/vaysen-crm-lan.conf:ro"
    healthcheck:
      test: ["CMD", "wget", "-Y", "off", "--spider", "-q", "http://127.0.0.1/health"]
      interval: 10s
      timeout: 5s
      retries: 18
      start_period: 20s
EOF
    chmod 600 "$RUNTIME_OVERRIDE"

    IMAGE_OVERRIDE="$RELEASE_ROOT/runtime-images.override.yml"
    [ ! -L "$IMAGE_OVERRIDE" ] \
        || fail "runtime image override must not be a symlink"
    node "$SCRIPT_DIR/verify-runtime-image-baseline.mjs" \
        --baseline "$RUNTIME_BASELINE" --expected-tag "$OLD_RELEASE_TAG" \
        --expected-commit "$OLD_COMMIT" --expected-project "$COMPOSE_PROJECT_NAME" \
        --mode print-override > "$IMAGE_OVERRIDE" \
        || fail "could not render the exact rollback image override"
    chmod 600 "$IMAGE_OVERRIDE"

    old_compose() {
        RELEASE_COMMIT="$OLD_COMMIT" RELEASE_COMMIT_SHORT="$OLD_SHORT" RELEASE_TAG="$OLD_RELEASE_TAG" \
        docker compose --project-name "$COMPOSE_PROJECT_NAME" \
            --project-directory "$OLD_PROJECT" --env-file "$ENV_FILE" \
            -f "$OLD_PROJECT/docker-compose.prod.yml" -f "$RUNTIME_OVERRIDE" -f "$IMAGE_OVERRIDE" "$@"
    }
    old_compose config -q || fail "old release Compose model is invalid with the current environment"
    OLD_CONFIG_JSON="$(old_compose config --format json)" \
        || fail "old release Compose model could not be rendered as JSON"
    if printf '%s' "$OLD_CONFIG_JSON" | node -e '
      const fs = require("fs");
      const config = JSON.parse(fs.readFileSync(0, "utf8"));
      process.exit(config.services?.["openclaw-gateway"] ? 0 : 1);
    '; then
        OLD_HAS_OPENCLAW=1
    fi
    printf '%s' "$OLD_CONFIG_JSON" | node -e '
      const fs = require("fs");
      const expectedIps = new Set(process.argv.slice(1));
      const config = JSON.parse(fs.readFileSync(0, "utf8"));
      const nginx = config.services?.nginx || {};
      const ports = nginx.ports || [];
      const safePort = ports.length === 2
        && ports.every((port) => String(port.target) === "80"
          && String(port.published) === "80"
          && expectedIps.has(port.host_ip))
        && new Set(ports.map((port) => port.host_ip)).size === 2;
      if (!safePort || ports.some((p) => ["0.0.0.0", "::"].includes(p.host_ip) || String(p.target) === "443" || String(p.published) === "443")) {
        throw new Error("rollback nginx ports are not LAN-only");
      }
      const env = config.services?.backend?.environment || {};
      for (const key of ["ENABLE_SWAGGER", "EMAIL_SEND_DISABLED", "EMAIL_SEED_TEST_ENABLED", "EVOLUTION_API_ENABLED", "RUN_MIGRATIONS", "RUN_SEED"]) {
        const expected = key === "EMAIL_SEND_DISABLED" ? "true" : "false";
        if (String(env[key]) !== expected) throw new Error(`unsafe rollback environment: ${key}`);
      }
      const backendCommand = config.services?.backend?.command || [];
      if (!Array.isArray(backendCommand)
        || backendCommand.length !== 2
        || backendCommand[0] !== "node"
        || backendCommand[1] !== "dist/src/main.js") {
        throw new Error("rollback backend command still permits the legacy automatic migration");
      }
      const sendEnv = config.services?.["worker-email-send"]?.environment || {};
      if (String(sendEnv.EMAIL_SEND_DISABLED) !== "true" || String(sendEnv.EMAIL_SEND_ENABLED) !== "false") {
        throw new Error("rollback email worker is not fail-closed");
      }
      const backendHealth = JSON.stringify(config.services?.backend?.healthcheck?.test || []);
      const frontendHealth = JSON.stringify(config.services?.frontend?.healthcheck?.test || []);
      const nginxHealth = JSON.stringify(config.services?.nginx?.healthcheck?.test || []);
      if (!backendHealth.includes("/health")
        || !frontendHealth.includes("3000/login")
        || !nginxHealth.includes("\"-Y\",\"off\"")
        || !nginxHealth.includes("127.0.0.1/health")) {
        throw new Error("rollback healthchecks were not replaced");
      }
    ' "$LAN_BIND_IP" "$LOCAL_LAN_BIND_IP" || fail "old release rollback override violates the LAN safety contract"
    node "$SCRIPT_DIR/verify-runtime-image-baseline.mjs" \
        --baseline "$RUNTIME_BASELINE" --expected-tag "$OLD_RELEASE_TAG" \
        --expected-commit "$OLD_COMMIT" --expected-project "$COMPOSE_PROJECT_NAME" \
        --mode verify-images \
        || fail "one or more exact rollback images are missing or have drifted"
    printf '%s' "$OLD_CONFIG_JSON" | node "$SCRIPT_DIR/verify-runtime-image-baseline.mjs" \
        --baseline "$RUNTIME_BASELINE" --expected-tag "$OLD_RELEASE_TAG" \
        --expected-commit "$OLD_COMMIT" --expected-project "$COMPOSE_PROJECT_NAME" \
        --mode verify-compose \
        || fail "rendered rollback Compose images do not match the runtime baseline"
    if [ "$CHECK_ONLY" -eq 1 ]; then
        BASELINE_CONTAINER_ARGS=(
            --baseline "$RUNTIME_BASELINE" --expected-tag "$OLD_RELEASE_TAG"
            --expected-commit "$OLD_COMMIT" --expected-project "$COMPOSE_PROJECT_NAME"
            --mode verify-containers
        )
        if [ "$CHECK_APP_ONLY" -eq 1 ]; then
            BASELINE_CONTAINER_ARGS+=(--require-runtime-state)
        fi
        node "$SCRIPT_DIR/verify-runtime-image-baseline.mjs" "${BASELINE_CONTAINER_ARGS[@]}" \
            || fail "current rollback baseline containers are missing or have drifted"
    fi
    info "rollback image references, IDs, per-service revisions, and Compose model match the runtime baseline"
fi

if [ -n "$RUNTIME_BACKUP" ]; then
    NODE_IMAGE="$(env_value NODE_IMAGE)" || fail "NODE_IMAGE is missing from environment file"
    OPENCLAW_IMAGE="$(env_value OPENCLAW_IMAGE)" || fail "OPENCLAW_IMAGE is missing from environment file"
    [ -f "$RUNTIME_BACKUP" ] && [ ! -L "$RUNTIME_BACKUP" ] \
        || fail "runtime backup is missing or symlinked: $RUNTIME_BACKUP"
    [ -f "$RUNTIME_BACKUP.sha256" ] && [ ! -L "$RUNTIME_BACKUP.sha256" ] \
        || fail "runtime backup checksum sidecar is missing or symlinked"
    NODE_IMAGE="$NODE_IMAGE" OPENCLAW_IMAGE="$OPENCLAW_IMAGE" \
        bash "$SCRIPT_DIR/restore-runtime-data.sh" --check "$RUNTIME_BACKUP" >/dev/null \
        || fail "runtime backup failed checksum or archive validation"
    info "runtime rollback source validated: $RUNTIME_BACKUP"
fi

if [ -n "$DB_BACKUP" ]; then
    POSTGRES_CONTAINER="${POSTGRES_CONTAINER:-vaysen-crm-postgres}" \
        bash "$SCRIPT_DIR/verify-db-backup.sh" "$DB_BACKUP" >/dev/null \
        || fail "database backup failed checksum or archive validation"
    info "database rollback source validated: $DB_BACKUP"
fi

if [ "$CHECK_ONLY" -eq 1 ]; then
    if [ "$CHECK_APP_ONLY" -eq 1 ] && [ -n "$REV" ]; then
        COMPOSE_PROJECT_NAME="$COMPOSE_PROJECT_NAME" ENV_FILE="$ENV_FILE" \
            LAN_BIND_IP="${LAN_BIND_IP:-}" LOCAL_LAN_BIND_IP="${LOCAL_LAN_BIND_IP:-}" \
            APP_DATA_DIR="${APP_DATA_DIR:-/var/lib/vaysen-crm/data}" \
            ROLLBACK_EXPECTED_REVISION="$OLD_COMMIT" ROLLBACK_EXPECTED_SHORT="$OLD_SHORT" \
            ROLLBACK_EXPECTED_TAG="$OLD_RELEASE_TAG" ROLLBACK_RUNTIME_BASELINE="$RUNTIME_BASELINE" \
            ROLLBACK_SMOKE_MODE=current-baseline \
            bash "$SCRIPT_DIR/rollback-smoke-test.sh" \
            || fail "current rollback baseline failed the read-only runtime smoke"
    fi
    info "rollback preflight passed without changing application or data"
    exit 0
fi

if [ -n "$DB_BACKUP" ] || [ -n "$RUNTIME_BACKUP" ]; then
    read -rp "Type ROLLBACK to overwrite the selected data: " CONFIRM
    [ "$CONFIRM" = "ROLLBACK" ] || fail "data rollback was not confirmed"
    [ -d "$BACKUP_DIR" ] && [ ! -L "$BACKUP_DIR" ] \
        || fail "backup directory is missing or symlinked: $BACKUP_DIR"
fi
if [ -n "$DB_BACKUP" ]; then
    DATABASE_LOCK="$BACKUP_DIR/.database-backup.lock"
    [ ! -L "$DATABASE_LOCK" ] || fail "database backup lock must not be a symlink"
    exec 7>>"$DATABASE_LOCK"
    chmod 600 "$DATABASE_LOCK"
    flock -n 7 || fail "a database backup/restore transaction is already running"
fi
if [ -n "$RUNTIME_BACKUP" ]; then
    RUNTIME_LOCK="$BACKUP_DIR/.runtime-backup.lock"
    [ ! -L "$RUNTIME_LOCK" ] || fail "runtime backup lock must not be a symlink"
    exec 8>>"$RUNTIME_LOCK"
    chmod 600 "$RUNTIME_LOCK"
    flock -n 8 || fail "a runtime backup/restore transaction is already running"
fi
if [ -n "$DB_BACKUP" ]; then
    POSTGRES_CONTAINER="${POSTGRES_CONTAINER:-vaysen-crm-postgres}" \
        bash "$SCRIPT_DIR/verify-db-backup.sh" "$DB_BACKUP" >/dev/null \
        || fail "database backup changed or failed validation after the restore lock was acquired"
fi
if [ -n "$RUNTIME_BACKUP" ]; then
    NODE_IMAGE="$NODE_IMAGE" OPENCLAW_IMAGE="$OPENCLAW_IMAGE" \
        bash "$SCRIPT_DIR/restore-runtime-data.sh" --check "$RUNTIME_BACKUP" >/dev/null \
        || fail "runtime backup changed or failed validation after the restore lock was acquired"
fi

APP_STOPPED=0
compose_lifecycle_establish_writer_free_boundary "$COMPOSE_PROJECT_NAME" \
    || fail "could not establish a writer-free rollback boundary; inspect application and migration containers"
APP_STOPPED=1

if [ -n "$DB_BACKUP" ]; then
    DB_USER="$(env_value POSTGRES_USER 2>/dev/null || printf 'vaysen-crm')"
    DB_NAME="$(env_value POSTGRES_DB 2>/dev/null || printf 'vaysen-crm_pilot')"
    [ -f "$SCRIPT_DIR/recreate-db-from-backup.sh" ] && [ ! -L "$SCRIPT_DIR/recreate-db-from-backup.sh" ] \
        || fail "database recreation helper is missing or symlinked"
    if ! bash "$SCRIPT_DIR/recreate-db-from-backup.sh" \
        --backup "$DB_BACKUP" --container "${POSTGRES_CONTAINER:-vaysen-crm-postgres}" \
        --user "$DB_USER" --database "$DB_NAME" --confirm-database-recreate; then
        fail "database restore failed; application remains stopped to protect the empty or partially recovered database"
    fi
    info "database rollback completed"
fi

if [ -n "$RUNTIME_BACKUP" ]; then
    APP_DATA_DIR="$(env_value APP_DATA_DIR)" || fail "APP_DATA_DIR is missing from environment file"
    APP_DATA_UID="$(env_value APP_DATA_UID 2>/dev/null || printf '999')"
    APP_DATA_GID="$(env_value APP_DATA_GID 2>/dev/null || printf '999')"
    OPENCLAW_DATA_UID="$(env_value OPENCLAW_DATA_UID 2>/dev/null || printf '1000')"
    OPENCLAW_DATA_GID="$(env_value OPENCLAW_DATA_GID 2>/dev/null || printf '1000')"
    if ! NODE_IMAGE="$NODE_IMAGE" OPENCLAW_IMAGE="$OPENCLAW_IMAGE" APP_DATA_DIR="$APP_DATA_DIR" APP_DATA_UID="$APP_DATA_UID" APP_DATA_GID="$APP_DATA_GID" \
        OPENCLAW_DATA_UID="$OPENCLAW_DATA_UID" OPENCLAW_DATA_GID="$OPENCLAW_DATA_GID" \
        bash "$SCRIPT_DIR/restore-runtime-data.sh" "$RUNTIME_BACKUP"; then
        fail "runtime data restore failed; application remains stopped until every selected data restore succeeds"
    fi
    info "runtime data rollback completed"
fi

if [ "$APP_STOPPED" -eq 1 ]; then
    if [ -z "$REV" ]; then
        restart_current_app
    else
        info "joint rollback keeps the current backend stopped until the validated old release starts"
    fi
fi

if [ -n "$REV" ]; then
    if [ "$OLD_HAS_OPENCLAW" -eq 0 ] && [ "$CURRENT_OPENCLAW_PRESENT" -eq 1 ]; then
        if docker container inspect "$CURRENT_OPENCLAW_CONTAINER_ID" >/dev/null 2>&1; then
            compose_lifecycle_stop_service openclaw-gateway \
                || fail "legacy rollback could not stop the candidate OpenClaw gateway"
            docker rm "$CURRENT_OPENCLAW_CONTAINER_ID" >/dev/null \
                || fail "legacy rollback could not remove the stopped candidate OpenClaw gateway"
        fi
        CURRENT_OPENCLAW_PRESENT=0
        info "legacy release has no OpenClaw service; candidate gateway removed without orphaning state"
    fi
    old_compose up -d --no-build --wait --wait-timeout "${ROLLBACK_WAIT_SECONDS:-180}" \
        || fail "old release failed to become ready"
    info "application rollback completed: $REV -> $OLD_COMMIT"
    info "persistent release context: $OLD_PROJECT"
fi

if [ -n "$REV" ]; then
    COMPOSE_PROJECT_NAME="$COMPOSE_PROJECT_NAME" ENV_FILE="$ENV_FILE" LAN_BIND_IP="${LAN_BIND_IP:-}" LOCAL_LAN_BIND_IP="${LOCAL_LAN_BIND_IP:-}" APP_DATA_DIR="${APP_DATA_DIR:-/var/lib/vaysen-crm/data}" \
        ROLLBACK_EXPECTED_REVISION="${OLD_COMMIT:-}" ROLLBACK_EXPECTED_SHORT="${OLD_SHORT:-}" \
        ROLLBACK_EXPECTED_TAG="${OLD_RELEASE_TAG:-}" ROLLBACK_RUNTIME_BASELINE="${RUNTIME_BASELINE:-}" \
        ROLLBACK_SMOKE_MODE=post-rollback \
        bash "$SCRIPT_DIR/rollback-smoke-test.sh" \
        || fail "post-rollback smoke test failed"
else
    info "data-only rollback retained the original container IDs, stopped-state policy, restart counts, and healthy stability window"
fi
info "rollback verification passed"
