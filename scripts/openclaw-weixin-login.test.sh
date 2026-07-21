#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TARGET="$SCRIPT_DIR/openclaw-weixin-login.sh"

bash -n "$TARGET"
# shellcheck source=openclaw-weixin-login.sh
source "$TARGET"

fixture="$(mktemp -d)"
cleanup_test() { rm -rf -- "$fixture"; }
trap cleanup_test EXIT

parse_weixin_login_args
[ "$weixin_enrollment_mode" = qr ]
parse_weixin_login_args --enroll-existing
[ "$weixin_enrollment_mode" = existing ]
if parse_weixin_login_args --unknown 2>/dev/null; then
    printf '[FAIL] unknown enrollment mode was accepted\n' >&2
    exit 1
fi
if parse_weixin_login_args --enroll-existing extra 2>/dev/null; then
    printf '[FAIL] extra enrollment arguments were accepted\n' >&2
    exit 1
fi
if bash "$TARGET" --unknown >"$fixture/unknown-argument.log" 2>&1; then
    printf '[FAIL] executable enrollment entrypoint accepted an unknown argument\n' >&2
    exit 1
fi
grep -Fq 'Usage:' "$fixture/unknown-argument.log"

mode_log="$fixture/enrollment-mode.log"
(
    weixin_enrollment_mode=existing
    channel_login_started=false
    assert_gateway_exact_for_exec() { printf 'assert-exact-gateway\n' >> "$mode_log"; }
    run_gateway_login_exact() { printf 'qr-login-must-not-run\n' >> "$mode_log"; return 97; }
    prepare_owner_binding_for_enrollment
    [ "$channel_login_started" = false ]
)
grep -Fxq 'assert-exact-gateway' "$mode_log"
if grep -Fq 'qr-login-must-not-run' "$mode_log"; then
    printf '[FAIL] --enroll-existing reached the QR login path\n' >&2
    exit 1
fi
(
    : > "$mode_log"
    weixin_enrollment_mode=qr
    channel_login_started=false
    run_gateway_login_exact() { printf 'qr-login\n' >> "$mode_log"; }
    prepare_owner_binding_for_enrollment
    [ "$channel_login_started" = true ]
)
grep -Fxq 'qr-login' "$mode_log"

digest="$(printf 'a%.0s' {1..64})"
printf '%s\n' 'KEEP=value' 'OPENCLAW_WECHAT_OWNER_PEER_SHA256=old' > "$fixture/old.env"
write_owner_env_file "$fixture/old.env" "$fixture/new.env" "$digest"
grep -Fxq 'KEEP=value' "$fixture/new.env"
[ "$(grep -c '^OPENCLAW_WECHAT_OWNER_PEER_SHA256=' "$fixture/new.env")" -eq 1 ]
grep -Fxq "OPENCLAW_WECHAT_OWNER_PEER_SHA256=$digest" "$fixture/new.env"

printf '%s\n' \
  'OPENCLAW_WECHAT_OWNER_PEER_SHA256=one' \
  'OPENCLAW_WECHAT_OWNER_PEER_SHA256=two' > "$fixture/duplicate.env"
if write_owner_env_file "$fixture/duplicate.env" "$fixture/rejected.env" "$digest" 2>/dev/null; then
    printf '[FAIL] duplicate owner digest assignments were accepted\n' >&2
    exit 1
fi

old_digest="$(printf 'b%.0s' {1..64})"
printf 'KEEP=value\n' > "$fixture/missing.env"
read_owner_digest_snapshot "$fixture/missing.env"
[ "$old_owner_env_state" = missing ] && [ -z "$old_owner_digest" ]
printf 'OPENCLAW_WECHAT_OWNER_PEER_SHA256=\n' > "$fixture/empty.env"
read_owner_digest_snapshot "$fixture/empty.env"
[ "$old_owner_env_state" = empty ] && [ -z "$old_owner_digest" ]
printf 'OPENCLAW_WECHAT_OWNER_PEER_SHA256=%s\n' "$old_digest" > "$fixture/digest.env"
read_owner_digest_snapshot "$fixture/digest.env"
[ "$old_owner_env_state" = digest ] && [ "$old_owner_digest" = "$old_digest" ]
if read_owner_digest_snapshot "$fixture/duplicate.env" 2>/dev/null; then
    printf '[FAIL] duplicate owner digest snapshot was accepted\n' >&2
    exit 1
fi

runtime_lines="PATH=/usr/bin
OPENCLAW_WECHAT_OWNER_PEER_SHA256=$digest"
validate_backend_owner_env_lines "$runtime_lines" digest "$digest"
validate_backend_owner_env_lines 'OPENCLAW_WECHAT_OWNER_PEER_SHA256=' missing ''
validate_backend_owner_env_lines "OPENCLAW_WECHAT_OWNER_PEER_SHA256=$old_digest" digest "$old_digest"
# Success must fail if the new digest was not loaded or the old one remained.
if validate_backend_owner_env_lines 'PATH=/usr/bin' digest "$digest" 2>/dev/null; then exit 1; fi
if validate_backend_owner_env_lines "OPENCLAW_WECHAT_OWNER_PEER_SHA256=$old_digest" digest "$digest" 2>/dev/null; then exit 1; fi
# Recovery must fail if the newly enrolled digest remains in an old/missing binding.
if validate_backend_owner_env_lines "OPENCLAW_WECHAT_OWNER_PEER_SHA256=$digest" missing '' 2>/dev/null; then exit 1; fi
if validate_backend_owner_env_lines "OPENCLAW_WECHAT_OWNER_PEER_SHA256=$digest" digest "$old_digest" 2>/dev/null; then exit 1; fi
if validate_backend_owner_env_lines "OPENCLAW_WECHAT_OWNER_PEER_SHA256=$digest
OPENCLAW_WECHAT_OWNER_PEER_SHA256=$digest" digest "$digest" 2>/dev/null; then exit 1; fi

live_status='{"channels":{"openclaw-weixin":{"configured":true}},"channelDefaultAccountId":{"openclaw-weixin":"owner"},"channelAccounts":{"openclaw-weixin":[{"accountId":"owner","enabled":true,"configured":true,"running":true}]}}'
printf '%s' "$live_status" | validate_weixin_live_status_json owner
assert_status_rejected() {
    if printf '%s' "$1" | validate_weixin_live_status_json owner 2>/dev/null; then
        printf '[FAIL] unsafe Weixin status payload was accepted\n' >&2
        exit 1
    fi
}
assert_status_rejected 'not-json'
assert_status_rejected '{"gatewayReachable":false,"configOnly":true,"configuredChannels":["openclaw-weixin"]}'
assert_status_rejected '{"channels":{"openclaw-weixin":{"configured":true}},"channelDefaultAccountId":{"openclaw-weixin":"owner"},"channelAccounts":{}}'
assert_status_rejected '{"channels":{"openclaw-weixin":{"configured":true}},"channelDefaultAccountId":{"openclaw-weixin":"owner"},"channelAccounts":{"openclaw-weixin":[{"accountId":"owner","enabled":true,"configured":false,"running":true}]}}'
assert_status_rejected '{"channels":{"openclaw-weixin":{"configured":true}},"channelDefaultAccountId":{"openclaw-weixin":"owner"},"channelAccounts":{"openclaw-weixin":[{"accountId":"owner","enabled":true,"configured":true,"running":false}]}}'
assert_status_rejected '{"channels":{"openclaw-weixin":{"configured":true}},"channelDefaultAccountId":{"openclaw-weixin":"owner"},"channelAccounts":{"openclaw-weixin":[{"accountId":"owner","enabled":true,"configured":true,"running":true,"lastError":"transport failed"}]}}'
assert_status_rejected '{"channels":{"openclaw-weixin":{"configured":true}},"channelDefaultAccountId":{"openclaw-weixin":"owner"},"channelAccounts":{"openclaw-weixin":[{"accountId":"owner","enabled":true,"configured":true,"running":true},{"accountId":"owner","enabled":true,"configured":true,"running":true}]}}'

config_hash="$(printf 'c%.0s' {1..64})"
drift_hash="$(printf 'd%.0s' {1..64})"
validate_service_config_hash backend "$config_hash" "$config_hash"
# Models an old .env with an undeployed ZHIPU/secret change: current Compose
# hash differs from the running container label and enrollment must stop.
if validate_service_config_hash openclaw-gateway "$config_hash" "$drift_hash" 2>/dev/null; then
    printf '[FAIL] undeployed gateway environment drift was accepted\n' >&2
    exit 1
fi

# Docker Compose returns canonical 64-character IDs from `compose ps -q`,
# while `docker ps -q` abbreviates them unless --no-trunc is explicit. The
# enrollment inventory must use one canonical representation throughout.
(
    canonical_id="$(printf 'e%.0s' {1..64})"
    docker_log="$fixture/docker-id-selection.log"
    docker() {
        printf '%s\n' "$*" >> "$docker_log"
        case "$1" in
            ps)
                [ "$2" = '-aq' ] || return 91
                shift 2
                saw_no_trunc=false
                for argument in "$@"; do
                    [ "$argument" = '--no-trunc' ] && saw_no_trunc=true
                done
                [ "$saw_no_trunc" = true ] || return 92
                printf '%s\n' "$canonical_id"
                ;;
            inspect)
                [ "$2" = '-f' ] && [ "$4" = "$canonical_id" ] || return 93
                case "$3" in
                    '{{.Name}}') printf '/vaysen-crm-backend\n' ;;
                    *'com.docker.compose.project'*) printf '%s\n' "$COMPOSE_PROJECT_NAME" ;;
                    *'com.docker.compose.service'*) printf 'backend\n' ;;
                    *'com.docker.compose.oneoff'*) printf 'False\n' ;;
                    *) return 94 ;;
                esac
                ;;
            *) return 95 ;;
        esac
    }
    compose() {
        [ "$*" = 'ps -q backend' ] || return 96
        printf '%s\n' "$canonical_id"
    }
    selected_id="$(current_service_id backend vaysen-crm-backend)"
    [ "$selected_id" = "$canonical_id" ] && [ "${#selected_id}" -eq 64 ]
    grep -Fq 'ps -aq --no-trunc' "$docker_log"
)

release_repo="$fixture/release-repo"
git init -q "$release_repo"
git -C "$release_repo" config user.name 'Weixin Contract Test'
git -C "$release_repo" config user.email 'weixin-contract@example.invalid'
git -C "$release_repo" commit -q --allow-empty -m fixture
release_tag='vaysen-crm-lan-v1.4.20-r9'
git -C "$release_repo" tag -a "$release_tag" -m fixture
release_full="$(git -C "$release_repo" rev-parse "$release_tag^{}")"
release_short="${release_full:0:8}"
PROJECT_DIR="$release_repo"
unset RELEASE_COMMIT RELEASE_COMMIT_SHORT RELEASE_TAG || true
export_validated_release_tuple "$release_full" "$release_short" "$release_tag"
[ "$RELEASE_COMMIT" = "$release_full" ]
[ "$RELEASE_COMMIT_SHORT" = "$release_short" ]
[ "$RELEASE_TAG" = "$release_tag" ]
release_lines="RELEASE_COMMIT=$release_full
RELEASE_COMMIT_SHORT=$release_short
RELEASE_TAG=$release_tag"
[ "$(read_unique_env_value_from_lines "$release_lines" RELEASE_TAG)" = "$release_tag" ]
if read_unique_env_value_from_lines "RELEASE_TAG=$release_tag
RELEASE_TAG=$release_tag" RELEASE_TAG 2>/dev/null; then exit 1; fi
git -C "$release_repo" commit -q --allow-empty -m head-drift
if export_validated_release_tuple "$release_full" "$release_short" "$release_tag" 2>/dev/null; then
    printf '[FAIL] checked-out HEAD drift from running backend was accepted\n' >&2
    exit 1
fi
git -C "$release_repo" reset -q --hard "$release_full"

# A QR wait may be long. A concurrent secret/ZHIPU .env edit must make persist
# fail before tmp creation, overwrite or any service recreation.
PROJECT_DIR="$fixture"
ENV_FILE="$fixture/toctou.env"
printf 'ZHIPU_API_KEY=before\n' > "$ENV_FILE"
active_env_sha256="$(sha256sum "$ENV_FILE" | awk '{print $1}')"
TRUSTED_FILE_SHA256=()
printf 'ZHIPU_API_KEY=changed-during-qr\n' > "$ENV_FILE"
transaction_started=false
recreate_started=false
tmp_env=''
if persist_owner_digest "$digest" 2>/dev/null; then
    printf '[FAIL] QR wait .env drift was absorbed by owner persistence\n' >&2
    exit 1
fi
grep -Fxq 'ZHIPU_API_KEY=changed-during-qr' "$ENV_FILE"
[ "$transaction_started" = false ] && [ "$recreate_started" = false ] && [ -z "$tmp_env" ]

printf 'trusted-before\n' > "$fixture/trusted-file"
TRUSTED_FILE_SHA256[trusted-file]="$(sha256sum "$fixture/trusted-file" | awk '{print $1}')"
printf 'trusted-after\n' > "$fixture/trusted-file"
if assert_trusted_files_unchanged 2>/dev/null; then
    printf '[FAIL] QR wait trusted-file drift was accepted\n' >&2
    exit 1
fi
TRUSTED_FILE_SHA256=()

compose_log="$fixture/compose.log"
active_env_sha256="$config_hash"
assert_active_environment_unchanged() { return 0; }
assert_original_image_reference() { return 0; }
compose_service_config_hash() { printf '%s\n' "$config_hash"; }
SNAP_CONFIG_HASH[openclaw-gateway]="$config_hash"
compose() { printf '%s\n' "$*" >> "$compose_log"; }
recreate_started=false
recreate_backend_from_current_config
grep -Fxq 'config --quiet' "$compose_log"
grep -Fxq 'up -d --no-deps --force-recreate --no-build --pull never backend' "$compose_log"
[ "$recreate_started" = true ]

selector_log="$fixture/selector.log"
assert_gateway_exact_for_exec() { return 1; }
docker() { printf '%s\n' "$*" >> "$selector_log"; }
if run_gateway_login_exact 2>/dev/null; then
    printf '[FAIL] replaced gateway selector reached interactive login\n' >&2
    exit 1
fi
[ ! -s "$selector_log" ]
unset -f docker assert_gateway_exact_for_exec

restart_log="$fixture/restart.log"
SNAP_NAME[openclaw-gateway]=vaysen-crm-openclaw-gateway
SNAP_ID[openclaw-gateway]=gateway-id
current_service_id() { printf 'gateway-id\n'; }
assert_service_matches_snapshot() { ASSERTED_ID=gateway-id; }
timeout() {
    printf '%s\n' "$*" >> "$restart_log"
    case "$*" in
        *' docker restart --timeout '*) return 0 ;;
        *) return 64 ;;
    esac
}
restart_gateway_exact
grep -Fq 'docker restart --timeout 30 gateway-id' "$restart_log"

isolation_log="$fixture/isolation.log"
isolate_service_exact() {
    printf '%s\n' "$1" >> "$isolation_log"
    [ "$1" = backend ]
}
if best_effort_isolate_services 2>/dev/null; then
    printf '[FAIL] partial emergency isolation was reported as proven\n' >&2
    exit 1
fi
printf '%s\n' backend openclaw-gateway > "$fixture/expected-isolation.log"
cmp -s "$fixture/expected-isolation.log" "$isolation_log"

env_backup="$fixture/retained-pre-scan.env"
printf 'OPENCLAW_WECHAT_OWNER_PEER_SHA256=%s\n' "$old_digest" > "$env_backup"
channel_login_started=true
transaction_committed=false
tmp_env=''
cleanup_temp_artifacts 2>/dev/null
[ -f "$env_backup" ]

trap_log="$fixture/trap.log"
set +e
(
    transaction_started=true
    transaction_committed=false
    channel_login_started=true
    restore_environment_snapshot() { printf 'restore-old-owner-A-to-disk\n' >> "$trap_log"; }
    best_effort_isolate_services() { printf 'isolate-owned-services\n' >> "$trap_log"; }
    cleanup_temp_artifacts() { printf 'cleanup\n' >> "$trap_log"; }
    false
    handle_exit
)
trap_status=$?
set -e
[ "$trap_status" -eq 1 ]
printf '%s\n' restore-old-owner-A-to-disk isolate-owned-services cleanup > "$fixture/expected-trap.log"
cmp -s "$fixture/expected-trap.log" "$trap_log"
if grep -Eq 'recreate|restart-gateway|verify-images' "$trap_log"; then
    printf '[FAIL] irreversible owner A to owner B failure attempted service recovery\n' >&2
    exit 1
fi

existing_trap_log="$fixture/existing-trap.log"
set +e
(
    transaction_started=true
    transaction_committed=false
    channel_login_started=false
    restore_environment_snapshot() { printf 'restore-existing-env\n' >> "$existing_trap_log"; }
    best_effort_isolate_services() { printf 'isolate-existing-services\n' >> "$existing_trap_log"; }
    cleanup_temp_artifacts() { printf 'cleanup-existing\n' >> "$existing_trap_log"; }
    false
    handle_exit
)
existing_trap_status=$?
set -e
[ "$existing_trap_status" -eq 1 ]
printf '%s\n' restore-existing-env isolate-existing-services cleanup-existing > "$fixture/expected-existing-trap.log"
cmp -s "$fixture/expected-existing-trap.log" "$existing_trap_log"

grep -Fq 'trap handle_exit EXIT' "$TARGET"
grep -Fq 'transaction_committed=true' "$TARGET"
grep -Fq 'image or OCI revision changed during QR enrollment' "$TARGET"
grep -Fq 'ISOLATION=PROVEN_STOPPED' "$TARGET"
grep -Fq 'ISOLATION=UNPROVEN' "$TARGET"
grep -Fq 'channel_login_started=true' "$TARGET"
grep -Fq -- '--enroll-existing' "$TARGET"
grep -Fq 'docker ps -aq --no-trunc' "$TARGET"
grep -Fq 'docker ps -q --no-trunc' "$TARGET"
[ "$(grep -Fc 'docker ps -a --no-trunc --filter' "$TARGET")" -eq 2 ]
if grep -Fq 'recovery_succeeded=true' "$TARGET"; then exit 1; fi

printf '[PASS] OpenClaw Weixin enrollment immutable-config/isolation contract\n'
