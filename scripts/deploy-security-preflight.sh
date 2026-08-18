#!/usr/bin/env bash
# Vaysen Pilot deployment filesystem security preflight.
# Read-only: this script never changes ownership or permissions.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
ENV_FILE="${ENV_FILE:-$PROJECT_DIR/.env}"
BACKUP_DIR="${BACKUP_DIR:-/var/lib/vaysen-crm/backups}"
RELEASES_DIR="${RELEASES_DIR:-/var/lib/vaysen-crm/releases}"
APP_DATA_DIR="${APP_DATA_DIR:-/var/lib/vaysen-crm/data}"
MIGRATION_REHEARSAL_DATA_ROOT="${MIGRATION_REHEARSAL_DATA_ROOT:-}"
DEPLOY_OWNER="${DEPLOY_OWNER:-$(id -un)}"
DEPLOY_GROUP="${DEPLOY_GROUP:-$(id -gn)}"

FAILURES=0

fail() {
    printf '[SECURITY ERROR] %s\n' "$*" >&2
    FAILURES=$((FAILURES + 1))
}

ok() {
    printf '[SECURITY OK] %s\n' "$*"
}

stat_owner() { stat -c '%U' "$1"; }
stat_group() { stat -c '%G' "$1"; }
stat_mode() { stat -c '%a' "$1"; }

PROJECT_GIT_PREFIX="$(git -C "$PROJECT_DIR" rev-parse --show-prefix 2>/dev/null || true)"
git -C "$PROJECT_DIR" rev-parse --is-inside-work-tree >/dev/null 2>&1 \
    || fail "$PROJECT_DIR must be a Git worktree for immutable byte verification"

check_immutable_bytes() {
    local file="$1" relative expected_blob actual_blob
    relative="${file#"$PROJECT_DIR"/}"
    expected_blob="$(git -C "$PROJECT_DIR" rev-parse --verify "HEAD:${PROJECT_GIT_PREFIX}${relative}" 2>/dev/null || true)"
    actual_blob="$(git -C "$PROJECT_DIR" hash-object --no-filters "$file" 2>/dev/null || true)"
    if [ -z "$expected_blob" ]; then
        fail "required deployment file is not tracked at immutable HEAD: $relative"
    elif [ "$actual_blob" != "$expected_blob" ]; then
        fail "deployment worktree bytes differ from immutable HEAD: $relative"
    elif [[ "$relative" = deploy/openclaw/* ]] \
        && git -C "$PROJECT_DIR" cat-file blob "$expected_blob" | LC_ALL=C grep -F $'\r' >/dev/null; then
        fail "OpenClaw deployment blob contains forbidden CRLF bytes: $relative"
    fi
}

check_identity() {
    local path="$1"
    local owner group
    owner="$(stat_owner "$path")"
    group="$(stat_group "$path")"
    if [ "$owner" != "$DEPLOY_OWNER" ] || [ "$group" != "$DEPLOY_GROUP" ]; then
        fail "$path owner/group is ${owner}:${group}; expected ${DEPLOY_OWNER}:${DEPLOY_GROUP}"
    fi
}

check_directory_mode() {
    local path="$1"
    local mode group_digit other_digit
    mode="$(stat_mode "$path")"
    group_digit="${mode: -2:1}"
    other_digit="${mode: -1}"
    if [ "$other_digit" -ne 0 ] || [ "$group_digit" -gt 7 ]; then
        fail "$path mode is $mode; deployment directories must be 700, 750, or 770"
        return
    fi
    case "$mode" in
        700|750|770) ;;
        *) fail "$path mode is $mode; deployment directories must be 700, 750, or 770" ;;
    esac
}

check_not_writable_by_group_or_other() {
    local path="$1"
    local mode group_digit other_digit
    mode="$(stat_mode "$path")"
    group_digit="${mode: -2:1}"
    other_digit="${mode: -1}"
    if (( (group_digit & 2) != 0 || (other_digit & 2) != 0 )); then
        fail "$path mode is $mode; deployment code/config must not be group/world writable"
    fi
}

for dir in "$PROJECT_DIR" "$PROJECT_DIR/scripts" "$PROJECT_DIR/backend" "$PROJECT_DIR/frontend" "$PROJECT_DIR/python-service" "$PROJECT_DIR/nginx" "$PROJECT_DIR/workflows" "$PROJECT_DIR/deploy" "$PROJECT_DIR/deploy/openclaw"; do
    if [ ! -d "$dir" ]; then
        fail "required directory missing: $dir"
        continue
    fi
    check_identity "$dir"
    check_directory_mode "$dir"
done

while IFS= read -r deploy_dir; do
    [ -n "$deploy_dir" ] || continue
    check_identity "$deploy_dir"
    check_directory_mode "$deploy_dir"
done < <(find "$PROJECT_DIR/deploy/openclaw" -xdev -type d -print 2>/dev/null)

if [ ! -f "$ENV_FILE" ] || [ -L "$ENV_FILE" ]; then
    fail "environment file must be a regular non-symlink file: $ENV_FILE"
else
    check_identity "$ENV_FILE"
    env_mode="$(stat_mode "$ENV_FILE")"
    case "$env_mode" in
        600|640) ok "$ENV_FILE mode is $env_mode" ;;
        *) fail "$ENV_FILE mode is $env_mode; expected 600 or 640" ;;
    esac
fi

for file in "$PROJECT_DIR/.gitattributes" "$PROJECT_DIR/docker-compose.prod.yml" "$PROJECT_DIR/deploy.sh" "$PROJECT_DIR/backend/.dockerignore" "$PROJECT_DIR/frontend/.dockerignore" "$PROJECT_DIR/python-service/.dockerignore" "$PROJECT_DIR/scripts/compose-container-lifecycle.sh" "$PROJECT_DIR/scripts/db-preflight.sh" "$PROJECT_DIR/scripts/rehearse-db-migration.sh" "$PROJECT_DIR/scripts/select-migration-rehearsal-mode.sh" "$PROJECT_DIR/scripts/recreate-db-from-backup.sh" "$PROJECT_DIR/scripts/backup-db.sh" "$PROJECT_DIR/scripts/verify-db-backup.sh" "$PROJECT_DIR/scripts/restore-db.sh" "$PROJECT_DIR/scripts/backup-runtime-data.sh" "$PROJECT_DIR/scripts/sanitize-openclaw-runtime-snapshot.sh" "$PROJECT_DIR/scripts/prepare-runtime-data.sh" "$PROJECT_DIR/scripts/restore-runtime-data.sh" "$PROJECT_DIR/scripts/runtime-link-manifest.sh" "$PROJECT_DIR/scripts/runtime-link-contract.mjs" "$PROJECT_DIR/scripts/run-runtime-link-contract.sh" "$PROJECT_DIR/scripts/runtime-initialize-transaction.sh" "$PROJECT_DIR/scripts/runtime-restore-transaction.sh" "$PROJECT_DIR/scripts/rollback.sh" "$PROJECT_DIR/scripts/rollback-smoke-test.sh" "$PROJECT_DIR/scripts/prepare-openclaw-runtime.sh" "$PROJECT_DIR/scripts/openclaw-runtime-smoke-test.sh" "$PROJECT_DIR/scripts/openclaw-runtime-probe.mjs" "$PROJECT_DIR/scripts/openclaw-real-scene-test.sh" "$PROJECT_DIR/scripts/openclaw-weixin-login.sh" "$PROJECT_DIR/scripts/openclaw-weixin-acceptance.sh" "$PROJECT_DIR/scripts/validate-openclaw-production.mjs" "$PROJECT_DIR/scripts/validate-production-env.mjs" "$PROJECT_DIR/deploy/openclaw/config/openclaw.install-bootstrap.json" "$PROJECT_DIR/deploy/openclaw/config/openclaw.install-private.json" "$PROJECT_DIR/deploy/openclaw/config/openclaw.production.json" "$PROJECT_DIR/deploy/openclaw/config/npm-user.empty" "$PROJECT_DIR/deploy/openclaw/config/npm-global.empty" "$PROJECT_DIR/deploy/openclaw/plugins/vaysen-crm/package.json" "$PROJECT_DIR/deploy/openclaw/plugins/vaysen-crm/npm-shrinkwrap.json" "$PROJECT_DIR/deploy/openclaw/plugins/vaysen-crm/openclaw.plugin.json" "$PROJECT_DIR/deploy/openclaw/plugins/vaysen-crm/README.md" "$PROJECT_DIR/deploy/openclaw/plugins/vaysen-crm/dist/index.js" "$PROJECT_DIR/deploy/openclaw/plugins/vaysen-crm/dist/runtime.js" "$PROJECT_DIR/deploy/openclaw/plugins/vaysen-crm/audit-managed-install.mjs" "$PROJECT_DIR/deploy/openclaw/plugins/vaysen-crm/verify-host-contract.mjs" "$PROJECT_DIR/deploy/openclaw/plugins/vaysen-crm/test/verify-host-contract.test.mjs" "$PROJECT_DIR/deploy/openclaw/plugins/vaysen-crm/weixin-patch-supply-chain.mjs" "$PROJECT_DIR/deploy/openclaw/plugins/vaysen-crm/weixin-v2.4.6.patch.json" "$PROJECT_DIR/deploy/openclaw/plugins/vaysen-crm/weixin-patch-files/src/security/acceptance-evidence.ts" "$PROJECT_DIR/deploy/openclaw/plugins/vaysen-crm/weixin-patch-files/dist/src/security/acceptance-evidence.js" "$PROJECT_DIR/deploy/openclaw/plugins/vaysen-crm/verify-weixin-acceptance-evidence.mjs"; do
    if [ ! -f "$file" ] || [ -L "$file" ]; then
        fail "required deployment file missing or symlinked: $file"
        continue
    fi
    check_identity "$file"
    check_not_writable_by_group_or_other "$file"
    check_immutable_bytes "$file"
done

for file in "$PROJECT_DIR/backend/Dockerfile" "$PROJECT_DIR/backend/entrypoint.sh" \
    "$PROJECT_DIR/frontend/Dockerfile" "$PROJECT_DIR/frontend/scripts/runtime-healthcheck.cjs"; do
    if [ ! -f "$file" ] || [ -L "$file" ]; then
        fail "required backend runtime file missing or symlinked: $file"
        continue
    fi
    check_identity "$file"
    check_not_writable_by_group_or_other "$file"
    check_immutable_bytes "$file"
done

for file in "$PROJECT_DIR/package.json" "$PROJECT_DIR/package-lock.json" \
    "$PROJECT_DIR/backend/package.json" "$PROJECT_DIR/backend/package-lock.json" \
    "$PROJECT_DIR/frontend/package.json" "$PROJECT_DIR/frontend/package-lock.json" \
    "$PROJECT_DIR/electron/package.json" "$PROJECT_DIR/electron/package-lock.json" \
    "$PROJECT_DIR/deploy/openclaw/plugins/vaysen-crm/package.json" \
    "$PROJECT_DIR/deploy/openclaw/plugins/vaysen-crm/npm-shrinkwrap.json" \
    "$PROJECT_DIR/scripts/verify-production-audit.mjs" \
    "$PROJECT_DIR/security/npm-audit-exceptions.json"; do
    if [ ! -f "$file" ] || [ -L "$file" ]; then
        fail "required production audit input missing or symlinked: $file"
        continue
    fi
    check_identity "$file"
    check_not_writable_by_group_or_other "$file"
    check_immutable_bytes "$file"
done

if npm --prefix "$PROJECT_DIR" run verify:production-audits; then
    ok "five independent live production dependency audits passed"
else
    fail "production dependency audit gate failed"
fi

# A writable helper/config anywhere in these deployment-owned trees can replace
# a command that deploy.sh invokes or alter a bind mount. Check regular files;
# controlled-group writable directories (770) remain allowed by policy.
while IFS= read -r writable_file; do
    [ -n "$writable_file" ] || continue
    fail "deployment file is group/world writable: $writable_file (mode $(stat_mode "$writable_file"))"
done < <(find "$PROJECT_DIR/scripts" "$PROJECT_DIR/backend" "$PROJECT_DIR/frontend" "$PROJECT_DIR/python-service" "$PROJECT_DIR/nginx" "$PROJECT_DIR/workflows" "$PROJECT_DIR/deploy/openclaw" \
    -xdev -type f -perm /022 -print 2>/dev/null)

if [ ! -d "$BACKUP_DIR" ] || [ -L "$BACKUP_DIR" ]; then
    fail "dedicated backup directory must already exist and must not be a symlink: $BACKUP_DIR"
else
    check_identity "$BACKUP_DIR"
    backup_mode="$(stat_mode "$BACKUP_DIR")"
    case "$backup_mode" in
        700|750) ok "$BACKUP_DIR mode is $backup_mode" ;;
        *) fail "$BACKUP_DIR mode is $backup_mode; expected 700 or 750" ;;
    esac
    [ -w "$BACKUP_DIR" ] || fail "backup directory is not writable by deployment user: $BACKUP_DIR"
fi

if [ ! -d "$RELEASES_DIR" ] || [ -L "$RELEASES_DIR" ]; then
    fail "release archive root must already exist and must not be a symlink: $RELEASES_DIR"
else
    check_identity "$RELEASES_DIR"
    releases_mode="$(stat_mode "$RELEASES_DIR")"
    case "$releases_mode" in
        700|750) ok "$RELEASES_DIR mode is $releases_mode" ;;
        *) fail "$RELEASES_DIR mode is $releases_mode; expected 700 or 750" ;;
    esac
    [ -w "$RELEASES_DIR" ] || fail "release archive root is not writable: $RELEASES_DIR"
fi

if [ ! -d "$APP_DATA_DIR" ] || [ -L "$APP_DATA_DIR" ]; then
    fail "application data root must already exist and must not be a symlink: $APP_DATA_DIR"
else
    check_identity "$APP_DATA_DIR"
    data_mode="$(stat_mode "$APP_DATA_DIR")"
    case "$data_mode" in
        700|750) ok "$APP_DATA_DIR mode is $data_mode" ;;
        *) fail "$APP_DATA_DIR mode is $data_mode; expected 700 or 750" ;;
    esac
    [ -w "$APP_DATA_DIR" ] || fail "application data root is not writable by deployment user: $APP_DATA_DIR"
fi

if [ -z "$MIGRATION_REHEARSAL_DATA_ROOT" ]; then
    fail "MIGRATION_REHEARSAL_DATA_ROOT must name a dedicated pre-created directory"
elif [ ! -d "$MIGRATION_REHEARSAL_DATA_ROOT" ] || [ -L "$MIGRATION_REHEARSAL_DATA_ROOT" ]; then
    fail "migration rehearsal data root must already exist and must not be a symlink: $MIGRATION_REHEARSAL_DATA_ROOT"
else
    check_identity "$MIGRATION_REHEARSAL_DATA_ROOT"
    rehearsal_mode="$(stat_mode "$MIGRATION_REHEARSAL_DATA_ROOT")"
    case "$rehearsal_mode" in
        700|750) ok "$MIGRATION_REHEARSAL_DATA_ROOT mode is $rehearsal_mode" ;;
        *) fail "$MIGRATION_REHEARSAL_DATA_ROOT mode is $rehearsal_mode; expected 700 or 750" ;;
    esac
    [ -w "$MIGRATION_REHEARSAL_DATA_ROOT" ] \
        || fail "migration rehearsal data root is not writable: $MIGRATION_REHEARSAL_DATA_ROOT"

    rehearsal_real="$(realpath -e -- "$MIGRATION_REHEARSAL_DATA_ROOT" 2>/dev/null || true)"
    [ -n "$rehearsal_real" ] || fail "migration rehearsal data root could not be resolved safely"
    for protected_path in "$PROJECT_DIR" "$BACKUP_DIR" "$RELEASES_DIR" "$APP_DATA_DIR"; do
        protected_real="$(realpath -e -- "$protected_path" 2>/dev/null || true)"
        [ -n "$protected_real" ] || continue
        case "$rehearsal_real" in
            "$protected_real"|"$protected_real"/*)
                fail "migration rehearsal data root overlaps protected path: $protected_real"
                ;;
        esac
        case "$protected_real" in
            "$rehearsal_real"|"$rehearsal_real"/*)
                fail "protected path is nested below migration rehearsal data root: $protected_real"
                ;;
        esac
    done
fi

if [ "$FAILURES" -ne 0 ]; then
    printf '[SECURITY ERROR] preflight failed with %d issue(s); no deployment action is allowed\n' "$FAILURES" >&2
    exit 1
fi

ok "filesystem ownership and permission contract passed"
