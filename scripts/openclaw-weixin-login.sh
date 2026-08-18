#!/usr/bin/env bash
# Controlled Tencent Weixin QR login and owner-peer digest enrollment. This
# script persists only a digest to CRM configuration. The official plugin can
# still place raw identifiers in its protected state or privileged warn/error
# logs; those surfaces are permission-restricted and retention-capped.

set -euo pipefail
umask 077

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
COMPOSE_FILE="${COMPOSE_FILE:-$PROJECT_DIR/docker-compose.prod.yml}"
ENV_FILE="${ENV_FILE:-$PROJECT_DIR/.env}"
COMPOSE_PROJECT_NAME="${COMPOSE_PROJECT_NAME:-vaysen-ai-crm}"
RELEASES_DIR="${RELEASES_DIR:-/var/lib/vaysen-crm/releases}"
LIFECYCLE_HELPER="$SCRIPT_DIR/compose-container-lifecycle.sh"
ENV_VALIDATOR="$SCRIPT_DIR/validate-production-env.mjs"

declare -A SNAP_ID=()
declare -A SNAP_NAME=()
declare -A SNAP_IMAGE_ID=()
declare -A SNAP_IMAGE_REF=()
declare -A SNAP_CONTAINER_REVISION=()
declare -A SNAP_IMAGE_REVISION=()
declare -A SNAP_CONFIG_HASH=()
declare -A TRUSTED_FILE_SHA256=()

env_backup=''
tmp_env=''
transaction_started=false
transaction_committed=false
channel_login_started=false
recreate_started=false
gateway_restart_started=false
old_owner_env_state='unread'
old_owner_digest=''
active_env_sha256=''
weixin_enrollment_mode='qr'

fail() { printf '[WEIXIN LOGIN ERROR] %s\n' "$*" >&2; exit 1; }
err() { printf '[WEIXIN LOGIN ERROR] %s\n' "$*" >&2; return 1; }
ok() { printf '[WEIXIN LOGIN OK] %s\n' "$*"; }

weixin_login_usage() {
    printf 'Usage: %s [--enroll-existing]\n' "${0##*/}" >&2
}

parse_weixin_login_args() {
    case "$#" in
        0)
            weixin_enrollment_mode='qr'
            ;;
        1)
            if [ "$1" = '--enroll-existing' ]; then
                weixin_enrollment_mode='existing'
            else
                weixin_login_usage
                return 2
            fi
            ;;
        *)
            weixin_login_usage
            return 2
            ;;
    esac
}

compose() {
    docker compose --project-name "$COMPOSE_PROJECT_NAME" \
        --project-directory "$PROJECT_DIR" --env-file "$ENV_FILE" \
        -f "$COMPOSE_FILE" "$@"
}

require_tracked_immutable_file() {
    local relative="$1" absolute="$PROJECT_DIR/$1"
    [ -f "$absolute" ] && [ ! -L "$absolute" ] \
        || err "required release file is missing or symlinked: $relative" \
        || return 1
    git -C "$PROJECT_DIR" ls-files --error-unmatch -- "$relative" >/dev/null 2>&1 \
        && git -C "$PROJECT_DIR" diff --quiet HEAD -- "$relative" \
        || err "release file does not match immutable HEAD: $relative"
}

snapshot_trusted_file() {
    local relative="$1" digest_line digest
    digest_line="$(sha256sum -- "$PROJECT_DIR/$relative")" || return 1
    digest="${digest_line%% *}"
    [[ "$digest" =~ ^[a-f0-9]{64}$ ]] \
        || err "could not snapshot trusted release file: $relative" \
        || return 1
    TRUSTED_FILE_SHA256[$relative]="$digest"
}

assert_trusted_files_unchanged() {
    local relative digest_line digest
    for relative in "${!TRUSTED_FILE_SHA256[@]}"; do
        [ -f "$PROJECT_DIR/$relative" ] && [ ! -L "$PROJECT_DIR/$relative" ] \
            || err "trusted release file disappeared or became a symlink: $relative" \
            || return 1
        digest_line="$(sha256sum -- "$PROJECT_DIR/$relative")" || return 1
        digest="${digest_line%% *}"
        [ "$digest" = "${TRUSTED_FILE_SHA256[$relative]}" ] \
            || err "trusted release file changed during QR enrollment: $relative" \
            || return 1
    done
}

current_service_id() {
    local service="$1" expected_name="$2" compose_check="${3:-true}"
    local ids_output id actual_name project_label service_label oneoff_label
    local ids=()
    ids_output="$(docker ps -aq --no-trunc \
        --filter "label=com.docker.compose.project=$COMPOSE_PROJECT_NAME" \
        --filter "label=com.docker.compose.service=$service" \
        --filter 'label=com.docker.compose.oneoff=False')" \
        || err "could not enumerate the $service container" \
        || return 1
    while IFS= read -r id; do
        [ -n "$id" ] && ids+=("$id")
    done <<< "$ids_output"
    [ "${#ids[@]}" -eq 1 ] \
        || err "expected exactly one regular $service container, found ${#ids[@]}" \
        || return 1
    id="${ids[0]}"
    actual_name="$(docker inspect -f '{{.Name}}' "$id" 2>/dev/null)" || return 1
    actual_name="${actual_name#/}"
    project_label="$(docker inspect -f '{{index .Config.Labels "com.docker.compose.project"}}' "$id" 2>/dev/null)" || return 1
    service_label="$(docker inspect -f '{{index .Config.Labels "com.docker.compose.service"}}' "$id" 2>/dev/null)" || return 1
    oneoff_label="$(docker inspect -f '{{index .Config.Labels "com.docker.compose.oneoff"}}' "$id" 2>/dev/null)" || return 1
    [ "$actual_name" = "$expected_name" ] \
        && [ "$project_label" = "$COMPOSE_PROJECT_NAME" ] \
        && [ "$service_label" = "$service" ] \
        && { [ "$oneoff_label" = False ] || [ "$oneoff_label" = false ]; } \
        || err "$service container failed exact Compose ownership checks" \
        || return 1
    if [ "$compose_check" = true ]; then
        [ "$(compose ps -q "$service")" = "$id" ] \
            || err "$service is not the unique active Compose container" \
            || return 1
    fi
    printf '%s\n' "$id"
}

inspect_label() {
    local scope="$1" object="$2" label="$3" value
    if [ "$scope" = image ]; then
        value="$(docker image inspect -f "{{index .Config.Labels \"$label\"}}" "$object" 2>/dev/null)" || return 1
    else
        value="$(docker inspect -f "{{index .Config.Labels \"$label\"}}" "$object" 2>/dev/null)" || return 1
    fi
    [ "$value" != '<no value>' ] || value=''
    printf '%s' "$value"
}

assert_original_image_reference() {
    local service="$1" resolved
    resolved="$(docker image inspect -f '{{.Id}}' "${SNAP_IMAGE_REF[$service]}" 2>/dev/null)" \
        || err "$service original image reference is no longer present locally" \
        || return 1
    [ "$resolved" = "${SNAP_IMAGE_ID[$service]}" ] \
        || err "$service original image reference moved after immutable inventory"
}

compose_service_config_hash() {
    local service="$1" output hash
    output="$(compose config --hash "$service")" \
        || err "could not calculate the immutable Compose config hash for $service" \
        || return 1
    if [[ "$output" =~ ^${service}[[:space:]]+([a-f0-9]{64})$ ]]; then
        hash="${BASH_REMATCH[1]}"
    else
        err "Compose returned an invalid config hash contract for $service" || return 1
    fi
    printf '%s\n' "$hash"
}

validate_service_config_hash() {
    local service="$1" actual="$2" expected="$3"
    [[ "$actual" =~ ^[a-f0-9]{64}$ ]] \
        && [[ "$expected" =~ ^[a-f0-9]{64}$ ]] \
        && [ "$actual" = "$expected" ] \
        || err "$service running config differs from immutable Compose plus the active environment"
}

export_validated_release_tuple() {
    local full_revision="$1" short_revision="$2" release_tag="$3" resolved tag_type checked_out_head
    [[ "$full_revision" =~ ^[a-f0-9]{40}$ ]] \
        && [[ "$short_revision" =~ ^[a-f0-9]{8,40}$ ]] \
        && [[ "$full_revision" = "$short_revision"* ]] \
        || err 'running backend did not provide a valid immutable release tuple' \
        || return 1
    [[ "$release_tag" =~ ^vaysen-crm-lan(-pilot)?-v[0-9]+\.[0-9]+\.[0-9]+-r[1-9][0-9]*$ ]] \
        || err 'running backend release tag is not an immutable Linux release tag' \
        || return 1
    tag_type="$(git -C "$PROJECT_DIR" cat-file -t "$release_tag" 2>/dev/null)" \
        || err 'running backend release tag is unavailable in immutable Git history' \
        || return 1
    [ "$tag_type" = tag ] \
        || err 'running backend release tag must be annotated' \
        || return 1
    resolved="$(git -C "$PROJECT_DIR" rev-parse "$release_tag^{}" 2>/dev/null)" \
        || err 'running backend release tag could not be peeled' \
        || return 1
    [ "$resolved" = "$full_revision" ] \
        || err 'running backend release tag does not peel to its OCI revision' \
        || return 1
    checked_out_head="$(git -C "$PROJECT_DIR" rev-parse HEAD 2>/dev/null)" \
        || err 'could not resolve checked-out release HEAD' \
        || return 1
    [ "$checked_out_head" = "$full_revision" ] \
        || err 'checked-out HEAD differs from the running backend; deploy the matching release before QR enrollment' \
        || return 1
    RELEASE_COMMIT="$full_revision"
    RELEASE_COMMIT_SHORT="$short_revision"
    RELEASE_TAG="$release_tag"
    export RELEASE_COMMIT RELEASE_COMMIT_SHORT RELEASE_TAG
}

read_unique_env_value_from_lines() {
    local env_lines="$1" key="$2" line value='' count=0
    while IFS= read -r line; do
        case "$line" in
            "$key"=*)
                count=$((count + 1))
                value="${line#*=}"
                ;;
        esac
    done <<< "$env_lines"
    [ "$count" -eq 1 ] \
        || err "running backend must contain exactly one $key entry" \
        || return 1
    printf '%s\n' "$value"
}

inventory_service() {
    local service="$1" expected_name="$2" id running health image_id image_ref container_revision image_revision tag
    local container_config_hash expected_config_hash runtime_env runtime_full runtime_short runtime_tag
    [ -z "$active_env_sha256" ] || assert_mutation_inputs_unchanged || return 1
    if [ "$service" = backend ]; then
        # RELEASE_COMMIT is required by Compose interpolation, so the first
        # backend inventory must be Docker-label-only. Never trust a caller or
        # .env release value before validating the running container tuple.
        id="$(current_service_id "$service" "$expected_name" false)" || return 1
    else
        id="$(current_service_id "$service" "$expected_name")" || return 1
    fi
    running="$(docker inspect -f '{{.State.Running}}' "$id" 2>/dev/null)" || return 1
    health="$(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' "$id" 2>/dev/null)" || return 1
    [ "$running" = true ] && [ "$health" = healthy ] \
        || err "$service must be running and healthy before QR enrollment" \
        || return 1
    image_id="$(docker inspect -f '{{.Image}}' "$id" 2>/dev/null)" || return 1
    image_ref="$(docker inspect -f '{{.Config.Image}}' "$id" 2>/dev/null)" || return 1
    [[ "$image_id" =~ ^sha256:[a-f0-9]{64}$ ]] \
        && [[ "$image_ref" =~ ^[A-Za-z0-9._/@:+-]+$ ]] \
        || err "$service does not use a safe immutable image identity" \
        || return 1
    container_revision="$(inspect_label container "$id" org.opencontainers.image.revision)" || return 1
    image_revision="$(inspect_label image "$image_id" org.opencontainers.image.revision)" || return 1
    if [ "$service" = backend ]; then
        [[ "$image_ref" =~ ^vaysen-crm-backend:[0-9a-f]{8,40}$ ]] \
            && [[ "$container_revision" =~ ^[0-9a-f]{40}$ ]] \
            && [ "$image_revision" = "$container_revision" ] \
            || err 'backend image/reference/OCI revision is not an immutable release tuple' \
            || return 1
        tag="${image_ref##*:}"
        [[ "$container_revision" = "$tag"* ]] \
            || err 'backend image tag does not prefix-match its OCI revision' \
            || return 1
        runtime_env="$(docker inspect -f '{{range .Config.Env}}{{println .}}{{end}}' "$id" 2>/dev/null)" || return 1
        runtime_full="$(read_unique_env_value_from_lines "$runtime_env" RELEASE_COMMIT)" || return 1
        runtime_short="$(read_unique_env_value_from_lines "$runtime_env" RELEASE_COMMIT_SHORT)" || return 1
        runtime_tag="$(read_unique_env_value_from_lines "$runtime_env" RELEASE_TAG)" || return 1
        [ "$runtime_full" = "$container_revision" ] && [ "$runtime_short" = "$tag" ] \
            || err 'running backend release environment disagrees with its image/OCI tuple' \
            || return 1
        export_validated_release_tuple "$container_revision" "$tag" "$runtime_tag" || return 1
        [ "$(compose ps -q backend)" = "$id" ] \
            || err 'backend is not the unique active Compose container after release tuple bootstrap' \
            || return 1
    else
        [[ "$image_ref" =~ ^ghcr\.io/openclaw/openclaw@sha256:[a-f0-9]{64}$ ]] \
            || err 'openclaw-gateway image is not pinned to the reviewed registry digest' \
            || return 1
    fi

    container_config_hash="$(inspect_label container "$id" com.docker.compose.config-hash)" || return 1
    expected_config_hash="$(compose_service_config_hash "$service")" || return 1
    validate_service_config_hash "$service" "$container_config_hash" "$expected_config_hash" || return 1

    SNAP_ID[$service]="$id"
    SNAP_NAME[$service]="$expected_name"
    SNAP_IMAGE_ID[$service]="$image_id"
    SNAP_IMAGE_REF[$service]="$image_ref"
    SNAP_CONTAINER_REVISION[$service]="$container_revision"
    SNAP_IMAGE_REVISION[$service]="$image_revision"
    SNAP_CONFIG_HASH[$service]="$container_config_hash"
    assert_original_image_reference "$service"
}

write_owner_env_file() {
    local source_file="$1" output_file="$2" digest="$3" matches
    matches="$(grep -c '^OPENCLAW_WECHAT_OWNER_PEER_SHA256=' "$source_file" || true)"
    [ "$matches" -le 1 ] \
        || err 'production environment contains duplicate owner digest assignments' \
        || return 1
    awk -v digest="$digest" '
      BEGIN { replaced = 0 }
      /^OPENCLAW_WECHAT_OWNER_PEER_SHA256=/ {
        print "OPENCLAW_WECHAT_OWNER_PEER_SHA256=" digest
        replaced = 1
        next
      }
      { print }
      END {
        if (!replaced) print "OPENCLAW_WECHAT_OWNER_PEER_SHA256=" digest
      }
    ' "$source_file" > "$output_file"
}

read_owner_digest_snapshot() {
    local source_file="$1" matches value
    matches="$(grep -c '^OPENCLAW_WECHAT_OWNER_PEER_SHA256=' "$source_file" || true)"
    [ "$matches" -le 1 ] \
        || err 'production environment contains duplicate owner digest assignments' \
        || return 1
    if [ "$matches" -eq 0 ]; then
        old_owner_env_state='missing'
        old_owner_digest=''
        return 0
    fi
    value="$(sed -n 's/^OPENCLAW_WECHAT_OWNER_PEER_SHA256=//p' "$source_file")"
    if [ -z "$value" ]; then
        old_owner_env_state='empty'
        old_owner_digest=''
    elif [[ "$value" =~ ^[a-f0-9]{64}$ ]]; then
        old_owner_env_state='digest'
        old_owner_digest="$value"
    else
        err 'existing owner digest assignment is neither empty nor a valid digest'
    fi
}

snapshot_environment() {
    local digest_line
    read_owner_digest_snapshot "$ENV_FILE" || return 1
    env_backup="$(mktemp "$PROJECT_DIR/.env.pre-weixin.XXXXXX")" || return 1
    cp -- "$ENV_FILE" "$env_backup"
    chmod 600 "$env_backup"
    cmp -s -- "$ENV_FILE" "$env_backup" \
        || err 'could not create an exact pre-enrollment environment snapshot' \
        || return 1
    digest_line="$(sha256sum -- "$ENV_FILE")" || return 1
    active_env_sha256="${digest_line%% *}"
    [[ "$active_env_sha256" =~ ^[a-f0-9]{64}$ ]] \
        || err 'could not establish the active environment integrity digest' \
        || return 1
}

persist_owner_digest() {
    local digest="$1" digest_line expected_env_sha256
    assert_mutation_inputs_unchanged || return 1
    tmp_env="$(mktemp "$PROJECT_DIR/.env.owner.XXXXXX")" || return 1
    write_owner_env_file "$env_backup" "$tmp_env" "$digest" || return 1
    chmod 600 "$tmp_env"
    digest_line="$(sha256sum -- "$tmp_env")" || return 1
    expected_env_sha256="${digest_line%% *}"
    [[ "$expected_env_sha256" =~ ^[a-f0-9]{64}$ ]] || return 1
    assert_mutation_inputs_unchanged || return 1
    transaction_started=true
    mv -f -- "$tmp_env" "$ENV_FILE"
    tmp_env=''
    grep -Eq '^OPENCLAW_WECHAT_OWNER_PEER_SHA256=[a-f0-9]{64}$' "$ENV_FILE" \
        || err 'owner digest was not persisted safely' \
        || return 1
    assert_trusted_files_unchanged || return 1
    node "$ENV_VALIDATOR" "$ENV_FILE" >/dev/null \
        || err 'production environment validation failed after owner enrollment' \
        || return 1
    digest_line="$(sha256sum -- "$ENV_FILE")" || return 1
    active_env_sha256="${digest_line%% *}"
    [ "$active_env_sha256" = "$expected_env_sha256" ] \
        || err 'could not establish the enrolled environment integrity digest' \
        || return 1
}

restore_environment_snapshot() {
    local restore_tmp digest_line
    [ -n "$env_backup" ] && [ -f "$env_backup" ] && [ ! -L "$env_backup" ] \
        || err 'pre-enrollment environment snapshot is unavailable for recovery' \
        || return 1
    restore_tmp="$(mktemp "$PROJECT_DIR/.env.restore-weixin.XXXXXX")" || return 1
    if ! cp -- "$env_backup" "$restore_tmp" || ! chmod 600 "$restore_tmp"; then
        rm -f -- "$restore_tmp"
        return 1
    fi
    mv -f -- "$restore_tmp" "$ENV_FILE"
    cmp -s -- "$ENV_FILE" "$env_backup" \
        || err 'restored environment does not byte-match the pre-enrollment snapshot' \
        || return 1
    digest_line="$(sha256sum -- "$ENV_FILE")" || return 1
    active_env_sha256="${digest_line%% *}"
    [[ "$active_env_sha256" =~ ^[a-f0-9]{64}$ ]] \
        || err 'could not establish the restored environment integrity digest' \
        || return 1
}

assert_active_environment_unchanged() {
    local digest_line current_digest
    digest_line="$(sha256sum -- "$ENV_FILE")" || return 1
    current_digest="${digest_line%% *}"
    [ -n "$active_env_sha256" ] && [ "$current_digest" = "$active_env_sha256" ] \
        || err 'production environment changed during the enrollment transaction'
}

assert_mutation_inputs_unchanged() {
    assert_active_environment_unchanged || return 1
    assert_trusted_files_unchanged
}

recreate_backend_from_current_config() {
    local gateway_hash
    assert_mutation_inputs_unchanged || return 1
    assert_original_image_reference backend || return 1
    assert_original_image_reference openclaw-gateway || return 1
    compose config --quiet || return 1
    # The owner digest is not a gateway input. Any gateway hash movement here
    # proves an unrelated .env/config drift and must block the QR transaction.
    gateway_hash="$(compose_service_config_hash openclaw-gateway)" || return 1
    validate_service_config_hash openclaw-gateway \
        "${SNAP_CONFIG_HASH[openclaw-gateway]}" "$gateway_hash" || return 1
    recreate_started=true
    compose up -d --no-deps --force-recreate --no-build --pull never backend
}

restart_gateway_exact() {
    local id
    assert_mutation_inputs_unchanged || return 1
    assert_service_matches_snapshot openclaw-gateway false || return 1
    id="$ASSERTED_ID"
    [ "$id" = "${SNAP_ID[openclaw-gateway]}" ] \
        || err 'openclaw-gateway identity changed; refusing an implicit gateway deployment' \
        || return 1
    gateway_restart_started=true
    timeout --signal=TERM --kill-after=10s "${WEIXIN_GATEWAY_RESTART_TIMEOUT_SECONDS:-60}s" \
        docker restart --timeout "${WEIXIN_GATEWAY_STOP_GRACE_SECONDS:-30}" "$id" >/dev/null \
        || err 'exact openclaw-gateway container restart failed'
}

assert_service_matches_snapshot() {
    local service="$1" compose_check="${2:-true}" id image_id image_ref container_revision image_revision
    local container_config_hash expected_config_hash
    assert_mutation_inputs_unchanged || return 1
    id="$(current_service_id "$service" "${SNAP_NAME[$service]}" "$compose_check")" || return 1
    image_id="$(docker inspect -f '{{.Image}}' "$id" 2>/dev/null)" || return 1
    image_ref="$(docker inspect -f '{{.Config.Image}}' "$id" 2>/dev/null)" || return 1
    container_revision="$(inspect_label container "$id" org.opencontainers.image.revision)" || return 1
    image_revision="$(inspect_label image "$image_id" org.opencontainers.image.revision)" || return 1
    container_config_hash="$(inspect_label container "$id" com.docker.compose.config-hash)" || return 1
    expected_config_hash="$(compose_service_config_hash "$service")" || return 1
    [ "$image_id" = "${SNAP_IMAGE_ID[$service]}" ] \
        && [ "$image_ref" = "${SNAP_IMAGE_REF[$service]}" ] \
        && [ "$container_revision" = "${SNAP_CONTAINER_REVISION[$service]}" ] \
        && [ "$image_revision" = "${SNAP_IMAGE_REVISION[$service]}" ] \
        || err "$service image or OCI revision changed during QR enrollment" \
        || return 1
    validate_service_config_hash "$service" "$container_config_hash" "$expected_config_hash" || return 1
    assert_original_image_reference "$service" || return 1
    ASSERTED_ID="$id"
}

assert_gateway_exact_for_exec() {
    local running health
    assert_service_matches_snapshot openclaw-gateway false || return 1
    [ "$ASSERTED_ID" = "${SNAP_ID[openclaw-gateway]}" ] \
        || err 'openclaw-gateway identity changed before exact-ID execution' \
        || return 1
    running="$(docker inspect -f '{{.State.Running}}' "$ASSERTED_ID" 2>/dev/null)" || return 1
    health="$(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' "$ASSERTED_ID" 2>/dev/null)" || return 1
    [ "$running" = true ] && [ "$health" = healthy ] \
        || err 'openclaw-gateway is not running and healthy before exact-ID execution' \
        || return 1
    EXACT_GATEWAY_ID="$ASSERTED_ID"
}

run_gateway_login_exact() {
    assert_gateway_exact_for_exec || return 1
    docker exec -it "$EXACT_GATEWAY_ID" node dist/index.js channels login --channel openclaw-weixin
}

prepare_owner_binding_for_enrollment() {
    case "$weixin_enrollment_mode" in
        qr)
            printf '[WEIXIN LOGIN] Scan the official plugin QR with the owner phone and confirm on the phone.\n'
            channel_login_started=true
            run_gateway_login_exact
            ;;
        existing)
            printf '[WEIXIN LOGIN] Reusing the unique owner identity from protected state; QR login is intentionally skipped.\n'
            assert_gateway_exact_for_exec
            ;;
        *)
            err 'unknown Weixin enrollment mode'
            ;;
    esac
}

validate_backend_owner_env_lines() {
    local env_lines="$1" expected_state="$2" expected_digest="${3:-}" line value=''
    local count=0
    while IFS= read -r line; do
        case "$line" in
            OPENCLAW_WECHAT_OWNER_PEER_SHA256=*)
                count=$((count + 1))
                value="${line#OPENCLAW_WECHAT_OWNER_PEER_SHA256=}"
                ;;
        esac
    done <<< "$env_lines"
    [ "$count" -eq 1 ] \
        || err 'backend runtime must contain exactly one owner digest environment entry' \
        || return 1
    case "$expected_state" in
        digest)
            [[ "$expected_digest" =~ ^[a-f0-9]{64}$ ]] \
                && [ "$value" = "$expected_digest" ] \
                || err 'backend runtime did not load the expected owner digest'
            ;;
        missing|empty)
            # Compose intentionally materializes the optional missing binding
            # as one empty Config.Env entry. Both states mean runtime-unbound;
            # the byte-exact .env restore retains their file-level distinction.
            [ -z "$expected_digest" ] && [ -z "$value" ] \
                || err 'backend runtime retained an owner digest after unbound recovery'
            ;;
        *) err 'unknown owner digest snapshot state' ;;
    esac
}

assert_backend_owner_runtime() {
    local container_id="$1" expected_state="$2" expected_digest="${3:-}" env_lines
    env_lines="$(docker inspect -f '{{range .Config.Env}}{{println .}}{{end}}' "$container_id" 2>/dev/null)" \
        || err 'could not inspect backend runtime environment' \
        || return 1
    validate_backend_owner_env_lines "$env_lines" "$expected_state" "$expected_digest"
}

validate_weixin_live_status_json() {
    local expected_account_id="$1"
    EXPECTED_WEIXIN_ACCOUNT_ID="$expected_account_id" node -e '
      let raw = "";
      process.stdin.setEncoding("utf8");
      process.stdin.on("data", (chunk) => { raw += chunk; });
      process.stdin.on("end", () => {
        try {
          const expected = process.env.EXPECTED_WEIXIN_ACCOUNT_ID;
          if (typeof expected !== "string" || !/^[A-Za-z0-9._-]{1,160}$/.test(expected)) throw new Error();
          const payload = JSON.parse(raw);
          if (!payload || typeof payload !== "object" || Array.isArray(payload)
            || payload.configOnly === true || payload.gatewayReachable === false) throw new Error();
          const accountsByChannel = payload.channelAccounts;
          if (!accountsByChannel || typeof accountsByChannel !== "object" || Array.isArray(accountsByChannel)) throw new Error();
          const accounts = accountsByChannel["openclaw-weixin"];
          if (!Array.isArray(accounts)) throw new Error();
          const matches = accounts.filter((account) => account && typeof account === "object"
            && !Array.isArray(account) && account.accountId === expected);
          if (matches.length !== 1) throw new Error();
          const account = matches[0];
          const lastError = account.lastError;
          if (payload.channelDefaultAccountId?.["openclaw-weixin"] !== expected
            || payload.channels?.["openclaw-weixin"]?.configured !== true
            || account.enabled !== true
            || account.configured !== true
            || account.running !== true
            || (lastError !== undefined && lastError !== null && lastError !== "")) throw new Error();
        } catch {
          process.exitCode = 1;
        }
      });
    '
}

wait_pair_healthy() {
    local timeout_seconds="${1:-180}" require_recreated="${2:-true}"
    local expected_owner_state="${3:-digest}" expected_owner_digest="${4:-}"
    local deadline stable=0 service
    local stable_seconds="${WEIXIN_HEALTH_STABLE_SECONDS:-5}" running health restart_count all_healthy
    local -A observed_ids=()
    local -A observed_restarts=()
    [[ "$timeout_seconds" =~ ^[1-9][0-9]*$ ]] \
        || err 'health wait timeout must be a positive integer' \
        || return 1
    [[ "$stable_seconds" =~ ^[1-9][0-9]*$ ]] \
        || err 'health stability duration must be a positive integer' \
        || return 1
    deadline=$(( $(date +%s) + timeout_seconds ))
    while [ "$(date +%s)" -lt "$deadline" ]; do
        all_healthy=true
        for service in backend openclaw-gateway; do
            assert_service_matches_snapshot "$service" || return 1
            if [ "$service" = backend ]; then
                assert_backend_owner_runtime "$ASSERTED_ID" \
                    "$expected_owner_state" "$expected_owner_digest" || return 1
            fi
            if [ -z "${observed_ids[$service]:-}" ]; then
                observed_ids[$service]="$ASSERTED_ID"
                observed_restarts[$service]="$(docker inspect -f '{{.RestartCount}}' "$ASSERTED_ID" 2>/dev/null)" || return 1
                [[ "${observed_restarts[$service]}" =~ ^[0-9]+$ ]] || return 1
                if [ "$service" = backend ]; then
                    if [ "$require_recreated" = true ] && [ "$ASSERTED_ID" = "${SNAP_ID[$service]}" ]; then
                        err 'backend was not recreated after the environment transaction' || return 1
                    elif [ "$require_recreated" != true ] && [ "$ASSERTED_ID" != "${SNAP_ID[$service]}" ]; then
                        err 'backend identity changed before a controlled recreation' || return 1
                    fi
                elif [ "$ASSERTED_ID" != "${SNAP_ID[$service]}" ]; then
                    err 'openclaw-gateway was replaced instead of exact-ID restarted' || return 1
                fi
            fi
            [ "$ASSERTED_ID" = "${observed_ids[$service]}" ] \
                || err "$service container identity changed during the health stability window" \
                || return 1
            running="$(docker inspect -f '{{.State.Running}}' "$ASSERTED_ID" 2>/dev/null)" || return 1
            health="$(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' "$ASSERTED_ID" 2>/dev/null)" || return 1
            restart_count="$(docker inspect -f '{{.RestartCount}}' "$ASSERTED_ID" 2>/dev/null)" || return 1
            [ "$restart_count" = "${observed_restarts[$service]}" ] \
                || err "$service restarted during the health stability window" \
                || return 1
            [ "$running" = true ] && [ "$health" = healthy ] || all_healthy=false
        done
        if [ "$all_healthy" = true ]; then
            stable=$((stable + 1))
            [ "$stable" -ge "$stable_seconds" ] && return 0
        else
            stable=0
        fi
        sleep 1
    done
    err 'backend and openclaw-gateway did not share a healthy stability window'
}

verify_owned_isolation_id() {
    local id="$1" service="$2" project_label service_label oneoff_label
    project_label="$(docker inspect -f '{{index .Config.Labels "com.docker.compose.project"}}' "$id" 2>/dev/null)" || return 1
    service_label="$(docker inspect -f '{{index .Config.Labels "com.docker.compose.service"}}' "$id" 2>/dev/null)" || return 1
    oneoff_label="$(docker inspect -f '{{index .Config.Labels "com.docker.compose.oneoff"}}' "$id" 2>/dev/null)" || return 1
    [ "$project_label" = "$COMPOSE_PROJECT_NAME" ] \
        && [ "$service_label" = "$service" ] \
        && { [ "$oneoff_label" = False ] || [ "$oneoff_label" = false ]; } \
        || err "refusing to treat an unowned container as isolated $service"
}

isolate_service_exact() {
    local service="$1" expected_name="$2" ids_output id running named_id
    local ids=() unique_ids=()
    ids_output="$(docker ps -aq --no-trunc \
        --filter "label=com.docker.compose.project=$COMPOSE_PROJECT_NAME" \
        --filter "label=com.docker.compose.service=$service" \
        --filter 'label=com.docker.compose.oneoff=False')" \
        || err "could not enumerate $service for emergency isolation" \
        || return 1
    while IFS= read -r id; do
        [ -n "$id" ] && ids+=("$id")
    done <<< "$ids_output"
    if [ -n "${SNAP_ID[$service]:-}" ] && docker container inspect "${SNAP_ID[$service]}" >/dev/null 2>&1; then
        ids+=("${SNAP_ID[$service]}")
    fi
    for id in "${ids[@]}"; do
        case " ${unique_ids[*]:-} " in
            *" $id "*) continue ;;
        esac
        verify_owned_isolation_id "$id" "$service" || return 1
        unique_ids+=("$id")
    done
    for id in "${unique_ids[@]}"; do
        running="$(docker inspect -f '{{.State.Running}}' "$id" 2>/dev/null)" || return 1
        if [ "$running" = true ]; then
            timeout --signal=TERM --kill-after=10s "${WEIXIN_ISOLATION_TIMEOUT_SECONDS:-30}s" \
                docker stop --timeout "${WEIXIN_ISOLATION_GRACE_SECONDS:-10}" "$id" >/dev/null \
                || err "could not stop exact owned $service container during emergency isolation" \
                || return 1
        elif [ "$running" != false ]; then
            err "could not determine $service running state during emergency isolation" || return 1
        fi
        running="$(docker inspect -f '{{.State.Running}}' "$id" 2>/dev/null)" || return 1
        [ "$running" = false ] \
            || err "$service remained running after emergency isolation" \
            || return 1
    done

    ids_output="$(docker ps -q --no-trunc \
        --filter "label=com.docker.compose.project=$COMPOSE_PROJECT_NAME" \
        --filter "label=com.docker.compose.service=$service" \
        --filter 'label=com.docker.compose.oneoff=False')" || return 1
    [ -z "$ids_output" ] \
        || err "an owned $service container is still running after emergency isolation" \
        || return 1
    if docker container inspect "$expected_name" >/dev/null 2>&1; then
        named_id="$(docker inspect -f '{{.Id}}' "$expected_name" 2>/dev/null)" || return 1
        verify_owned_isolation_id "$named_id" "$service" || return 1
        running="$(docker inspect -f '{{.State.Running}}' "$named_id" 2>/dev/null)" || return 1
        [ "$running" = false ] \
            || err "$expected_name is still running after emergency isolation"
    fi
}

best_effort_isolate_services() {
    local result=0
    isolate_service_exact backend vaysen-crm-backend || result=1
    isolate_service_exact openclaw-gateway vaysen-crm-openclaw-gateway || result=1
    if [ "$result" -eq 0 ]; then
        printf '[WEIXIN LOGIN ISOLATION] ISOLATION=PROVEN_STOPPED; exact owned backend and gateway are stopped\n' >&2
        return 0
    fi
    printf '%s\n' \
        '[WEIXIN LOGIN CRITICAL] ISOLATION=UNPROVEN; do not expose the CRM until both services are confirmed stopped.' \
        '[WEIXIN LOGIN MANUAL] docker ps -a --no-trunc --filter label=com.docker.compose.project=vaysen-ai-crm --filter label=com.docker.compose.service=backend --filter label=com.docker.compose.oneoff=False' \
        '[WEIXIN LOGIN MANUAL] docker ps -a --no-trunc --filter label=com.docker.compose.project=vaysen-ai-crm --filter label=com.docker.compose.service=openclaw-gateway --filter label=com.docker.compose.oneoff=False' \
        '[WEIXIN LOGIN MANUAL] docker stop --timeout 10 vaysen-crm-backend vaysen-crm-openclaw-gateway' >&2
    return 1
}

cleanup_temp_artifacts() {
    [ -z "$tmp_env" ] || rm -f -- "$tmp_env"
    if [ -n "$env_backup" ]; then
        if [ "$transaction_committed" = true ] \
            || { [ "$channel_login_started" = false ] && [ "$transaction_started" = false ]; }; then
            rm -f -- "$env_backup"
        else
            printf '[WEIXIN LOGIN CRITICAL] secure pre-scan environment snapshot retained at %s\n' "$env_backup" >&2
        fi
    fi
}

handle_exit() {
    local status=$?
    trap - EXIT
    set +e
    if [ "$transaction_committed" != true ] \
        && { [ "$channel_login_started" = true ] || [ "$transaction_started" = true ]; }; then
        if [ "$channel_login_started" = true ]; then
            printf '[WEIXIN LOGIN CRITICAL] QR login crossed an irreversible channel boundary; service recovery is forbidden\n' >&2
        else
            printf '[WEIXIN LOGIN CRITICAL] existing-binding enrollment crossed the environment mutation boundary; automatic service recovery is forbidden\n' >&2
        fi
        restore_environment_snapshot \
            || printf '[WEIXIN LOGIN CRITICAL] byte-exact pre-scan .env restoration failed\n' >&2
        best_effort_isolate_services \
            || printf '[WEIXIN LOGIN CRITICAL] automatic isolation could not be proven; run the printed manual commands now\n' >&2
        if [ "$channel_login_started" = true ]; then
            printf '[WEIXIN LOGIN MANUAL] owner binding is not accepted; manually recover the services and scan a fresh QR again\n' >&2
        else
            printf '[WEIXIN LOGIN MANUAL] existing owner digest is not accepted; manually recover the exact reviewed services before retrying enrollment\n' >&2
        fi
        status=1
    fi
    cleanup_temp_artifacts
    exit "$status"
}

weixin_login_main() {
    local owner_account_id owner_digest owner_identity_output status_json trusted_file
    local -a owner_identity=()
    parse_weixin_login_args "$@" || return 2
    [ -t 0 ] && [ -t 1 ] \
        || fail 'run this script in an interactive SSH/terminal session; redirected QR login is forbidden'
    [ -f "$ENV_FILE" ] && [ ! -L "$ENV_FILE" ] \
        || fail 'production environment file is missing or symlinked'
    [ "$(stat -c '%u' "$ENV_FILE")" = "$(id -u)" ] \
        || fail 'run the login script as the owner of the production environment file'
    git -C "$PROJECT_DIR" rev-parse --is-inside-work-tree >/dev/null 2>&1 \
        || fail 'project directory is not a Git worktree'
    require_tracked_immutable_file docker-compose.prod.yml || fail 'Compose release contract is not immutable'
    require_tracked_immutable_file scripts/compose-container-lifecycle.sh || fail 'lifecycle helper is not immutable'
    require_tracked_immutable_file scripts/openclaw-weixin-login.sh || fail 'login script is not immutable'
    require_tracked_immutable_file scripts/validate-production-env.mjs || fail 'environment validator is not immutable'
    for trusted_file in docker-compose.prod.yml scripts/compose-container-lifecycle.sh \
        scripts/openclaw-weixin-login.sh scripts/validate-production-env.mjs; do
        snapshot_trusted_file "$trusted_file" || fail 'could not snapshot immutable enrollment inputs'
    done
    node "$ENV_VALIDATOR" "$ENV_FILE" >/dev/null \
        || fail 'production environment validation failed before QR enrollment'
    [ "$(stat -c '%u' "$LIFECYCLE_HELPER")" = "$(id -u)" ] \
        || fail 'lifecycle helper must be owned by the enrollment user'
    LIFECYCLE_MODE="$(stat -c '%a' "$LIFECYCLE_HELPER")"
    [ $((8#$LIFECYCLE_MODE & 0022)) -eq 0 ] \
        || fail 'lifecycle helper must not be group/world writable'
    # shellcheck source=compose-container-lifecycle.sh
    source "$LIFECYCLE_HELPER"
    compose_lifecycle_acquire_transaction_lock "$RELEASES_DIR" \
        || fail 'could not acquire the production lifecycle transaction lock'

    trap handle_exit EXIT
    snapshot_environment || fail 'could not snapshot the production environment'
    inventory_service backend vaysen-crm-backend \
        || fail 'backend immutable inventory failed'
    inventory_service openclaw-gateway vaysen-crm-openclaw-gateway \
        || fail 'openclaw-gateway immutable inventory failed'

    prepare_owner_binding_for_enrollment \
        || fail 'exact-ID Weixin owner binding preparation failed'

    # Tencent's reviewed plugin stores the scanner userId in its protected
    # account state and may also store it in an account-scoped allowFrom file.
    # Read only those fields, require one owner, and emit only a digest.
    assert_gateway_exact_for_exec || fail 'gateway changed before owner digest extraction'
    owner_identity_output="$(docker exec -i "$EXACT_GATEWAY_ID" node --input-type=module - <<'NODE'
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const stateDir = process.env.OPENCLAW_STATE_DIR || '/home/node/.openclaw';
const channelDir = path.join(stateDir, 'openclaw-weixin');
const indexPath = path.join(channelDir, 'accounts.json');
const ids = new Set();
const ownerAccountIds = new Set();

function readJson(file) {
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('unsafe Weixin state entry');
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

const accountIds = readJson(indexPath);
if (!Array.isArray(accountIds) || accountIds.length === 0) {
  throw new Error('no indexed Weixin account after QR login');
}
for (const accountId of accountIds) {
  if (typeof accountId !== 'string' || !/^[A-Za-z0-9._-]{1,160}$/.test(accountId)) {
    throw new Error('unsafe Weixin account index');
  }
  const account = readJson(path.join(channelDir, 'accounts', `${accountId}.json`));
  const accountOwnerIds = new Set();
  if (typeof account.userId === 'string' && account.userId.trim()) accountOwnerIds.add(account.userId.trim());

  const allowPath = path.join(stateDir, 'credentials', `openclaw-weixin-${accountId.toLowerCase()}-allowFrom.json`);
  if (fs.existsSync(allowPath)) {
    const allow = readJson(allowPath)?.allowFrom;
    if (!Array.isArray(allow)) throw new Error('invalid Weixin allowFrom state');
    for (const value of allow) {
      if (typeof value === 'string' && value.trim()) accountOwnerIds.add(value.trim());
    }
  }
  if (accountOwnerIds.size > 0) ownerAccountIds.add(accountId);
  for (const value of accountOwnerIds) ids.add(value);
}
if (ids.size !== 1 || ownerAccountIds.size !== 1) {
  throw new Error('QR login must resolve to exactly one unique owner identity and account');
}
const [ownerId] = ids;
const [ownerAccountId] = ownerAccountIds;
process.stdout.write(`${createHash('sha256').update(ownerId, 'utf8').digest('hex')}\n${ownerAccountId}`);
NODE
)" || fail 'owner identity extraction command failed'
    mapfile -t owner_identity <<< "$owner_identity_output"
    owner_identity_output=''
    [ "${#owner_identity[@]}" -eq 2 ] \
        || fail 'owner identity extraction returned an ambiguous result'
    owner_digest="${owner_identity[0]}"
    owner_account_id="${owner_identity[1]}"
    [[ "$owner_digest" =~ ^[a-f0-9]{64}$ ]] \
        && [[ "$owner_account_id" =~ ^[A-Za-z0-9._-]{1,160}$ ]] \
        || fail 'owner identity digest extraction failed; no raw identifier was retained'

    persist_owner_digest "$owner_digest" || fail 'owner digest environment transaction failed'
    recreate_backend_from_current_config || fail 'controlled backend recreation failed'
    restart_gateway_exact || fail 'controlled exact-ID gateway restart failed'
    wait_pair_healthy 180 true digest "$owner_digest" \
        || fail 'backend/gateway immutable image or health verification failed'
    assert_gateway_exact_for_exec || fail 'gateway changed before final status probe'
    status_json="$(docker exec -i "$EXACT_GATEWAY_ID" node dist/index.js channels status --json --probe)" \
        || fail 'Weixin official status probe failed after controlled recreation'
    printf '%s' "$status_json" | validate_weixin_live_status_json "$owner_account_id" \
        || fail 'Weixin live status is not uniquely configured, running and error-free'
    status_json=''
    transaction_committed=true
    ok 'owner digest enrolled; backend and gateway retained their exact pre-scan images and OCI revisions'

    printf '%s\n' \
      '[WEIXIN MANUAL ACCEPTANCE REQUIRED]' \
      '1. From the just-bound owner Weixin account, privately send: 查看今日工作简报' \
      '2. Confirm the assistant returns a real requestId/status (not a fabricated completion).' \
      '3. In the authenticated CRM administrator UI, verify the runtime status shows the masked owner binding and boundAt/lastSeenAt.' \
      'The script deliberately cannot create this binding itself; only a real owner message may do so.'
}

if [ "${BASH_SOURCE[0]}" = "$0" ]; then
    weixin_login_main "$@"
fi
