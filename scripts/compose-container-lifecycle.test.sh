#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TMP_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/vaysen-crm-lifecycle-test-XXXXXX")"
trap 'rm -rf -- "$TMP_ROOT"' EXIT
mkdir -p "$TMP_ROOT/bin" "$TMP_ROOT/state/containers" "$TMP_ROOT/state/behavior"
export FAKE_DOCKER_STATE="$TMP_ROOT/state"

cat >"$TMP_ROOT/bin/docker" <<'FAKE_DOCKER'
#!/usr/bin/env bash
set -euo pipefail

state="${FAKE_DOCKER_STATE:?}"
resolve_id() {
    local target="$1" file id name project service running oneoff migration
    for file in "$state"/containers/*; do
        [ -f "$file" ] || continue
        IFS='|' read -r id name project service running oneoff migration <"$file"
        if [ "$target" = "$id" ] || [ "$target" = "$name" ]; then
            printf '%s\n' "$id"
            return 0
        fi
    done
    return 1
}
read_container() {
    local id="$1"
    [ -f "$state/containers/$id" ] || return 1
    cat "$state/containers/$id"
}

case "${1:-}" in
    ps)
        shift
        project=''; service=''; oneoff_filter=''; require_migration=0
        while [ "$#" -gt 0 ]; do
            if [ "$1" = --filter ]; then
                case "$2" in
                    label=com.docker.compose.project=*) project="${2##*=}" ;;
                    label=com.docker.compose.service=*) service="${2##*=}" ;;
                    label=com.docker.compose.oneoff=*) oneoff_filter="${2##*=}" ;;
                    label=com.vaysen.vaysen-crm.production-migration) require_migration=1 ;;
                esac
                shift 2
            else
                shift
            fi
        done
        for file in "$state"/containers/*; do
            [ -f "$file" ] || continue
            IFS='|' read -r id name actual_project actual_service running oneoff migration <"$file"
            [ -z "$project" ] || [ "$actual_project" = "$project" ] || continue
            [ -z "$service" ] || [ "$actual_service" = "$service" ] || continue
            [ -z "$oneoff_filter" ] || [ "$oneoff" = "$oneoff_filter" ] || continue
            [ "$require_migration" -eq 0 ] || [ -n "$migration" ] || continue
            printf '%s\n' "$id"
        done
        exit 0
        ;;
    container)
        [ "${2:-}" = inspect ] || exit 2
        resolve_id "${3:-}" >/dev/null
        ;;
    inspect)
        [ "${2:-}" = -f ] || exit 2
        format="$3"; target="$4"
        id="$(resolve_id "$target")"
        IFS='|' read -r id name project service running oneoff migration <<<"$(read_container "$id")"
        case "$format" in
            '{{.Name}}') printf '/%s\n' "$name" ;;
            *com.docker.compose.project*) printf '%s\n' "$project" ;;
            *com.docker.compose.service*) printf '%s\n' "$service" ;;
            *com.docker.compose.oneoff*) printf '%s\n' "$oneoff" ;;
            *com.vaysen.vaysen-crm.production-migration*) printf '%s\n' "$migration" ;;
            *State.Running*) printf '%s\n' "$running" ;;
            *State.Health*)
                if [ -f "$state/behavior/health-flap-after-first-$id" ]; then
                    counter_file="$state/behavior/health-count-$id"
                    count="$(cat "$counter_file" 2>/dev/null || printf '0')"
                    printf '%s\n' "$((count + 1))" >"$counter_file"
                    [ "$count" -eq 0 ] && printf 'healthy\n' || printf 'unhealthy\n'
                elif [ "$running" = true ]; then
                    printf 'healthy\n'
                else
                    printf 'unhealthy\n'
                fi
                ;;
            *RestartCount*) printf '0\n' ;;
            *) exit 2 ;;
        esac
        ;;
    stop)
        [ "$#" -eq 4 ] || exit 64
        [ "$2" = --timeout ] || exit 64
        case "$3" in
            ''|*[!0-9]*) exit 64 ;;
        esac
        target="$4"
        id="$(resolve_id "$target")"
        IFS='|' read -r id name project service running oneoff migration <<<"$(read_container "$id")"
        printf 'stop %s\n' "$id" >>"$state/calls.log"
        if [ -f "$state/behavior/stop-fail-running-$id" ]; then exit 1; fi
        printf '%s|%s|%s|%s|false|%s|%s\n' "$id" "$name" "$project" "$service" "$oneoff" "$migration" >"$state/containers/$id"
        if [ -f "$state/behavior/stop-fail-stopped-$id" ]; then exit 1; fi
        ;;
    start)
        target="${2:-}"
        id="$(resolve_id "$target")"
        IFS='|' read -r id name project service running oneoff migration <<<"$(read_container "$id")"
        printf 'start %s\n' "$id" >>"$state/calls.log"
        printf '%s|%s|%s|%s|true|%s|%s\n' "$id" "$name" "$project" "$service" "$oneoff" "$migration" >"$state/containers/$id"
        ;;
    rm)
        target="${@: -1}"
        id="$(resolve_id "$target")"
        printf 'rm %s\n' "$id" >>"$state/calls.log"
        if [ -f "$state/behavior/rm-fail-$id" ]; then exit 1; fi
        rm -f "$state/containers/$id"
        ;;
    *) exit 2 ;;
esac
FAKE_DOCKER
chmod 700 "$TMP_ROOT/bin/docker"
PATH="$TMP_ROOT/bin:$PATH"
export PATH

# shellcheck source=compose-container-lifecycle.sh
source "$SCRIPT_DIR/compose-container-lifecycle.sh"
export CONTAINER_RECOVERY_STABLE_SECONDS=1

reset_state() {
    rm -f "$FAKE_DOCKER_STATE"/containers/* "$FAKE_DOCKER_STATE"/behavior/* "$FAKE_DOCKER_STATE/calls.log"
    compose_lifecycle_reset
}
add_container() {
    printf '%s|%s|%s|%s|%s|%s|%s\n' \
        "$1" "$2" "$3" "$4" "$5" "${6:-False}" "${7:-}" \
        >"$FAKE_DOCKER_STATE/containers/$1"
}
assert_no_calls() {
    [ ! -s "$FAKE_DOCKER_STATE/calls.log" ]
}

# Missing services are accepted, while every present owned container is
# controlled by immutable ID rather than a possibly-reused name.
reset_state
add_container id-backend vaysen-crm-backend vaysen-ai-crm backend true
add_container id-worker vaysen-crm-worker-email-compose vaysen-ai-crm worker-email-compose false
compose_lifecycle_discover_vaysen-crm vaysen-ai-crm true
[ "${#COMPOSE_LIFECYCLE_IDS[@]}" -eq 2 ]
compose_lifecycle_stop_all
compose_lifecycle_start_all
grep -Fx 'stop id-backend' "$FAKE_DOCKER_STATE/calls.log" >/dev/null
grep -Fx 'start id-backend' "$FAKE_DOCKER_STATE/calls.log" >/dev/null
if grep -Fx 'start id-worker' "$FAKE_DOCKER_STATE/calls.log" >/dev/null; then exit 1; fi

# Recovery after a partial stop failure restores already-stopped original IDs
# without rejecting or restarting an original writer that remained running.
reset_state
add_container id-backend vaysen-crm-backend vaysen-ai-crm backend true
add_container id-worker vaysen-crm-worker-email-compose vaysen-ai-crm worker-email-compose true
compose_lifecycle_register vaysen-ai-crm vaysen-crm-backend backend
compose_lifecycle_register vaysen-ai-crm vaysen-crm-worker-email-compose worker-email-compose
compose_lifecycle_stop_id id-backend vaysen-crm-backend
compose_lifecycle_start_all
grep -Fx 'start id-backend' "$FAKE_DOCKER_STATE/calls.log" >/dev/null
if grep -Fx 'start id-worker' "$FAKE_DOCKER_STATE/calls.log" >/dev/null; then exit 1; fi

# One early healthy sample is insufficient: every originally running
# container must share the same continuous stability window.
reset_state
add_container id-backend vaysen-crm-backend vaysen-ai-crm backend true
touch "$FAKE_DOCKER_STATE/behavior/health-flap-after-first-id-backend"
compose_lifecycle_register vaysen-ai-crm vaysen-crm-backend backend
export CONTAINER_RECOVERY_TIMEOUT_SECONDS=2 CONTAINER_RECOVERY_STABLE_SECONDS=2
if compose_lifecycle_wait_original_healthy 2>/dev/null; then exit 1; fi
export CONTAINER_RECOVERY_TIMEOUT_SECONDS=120 CONTAINER_RECOVERY_STABLE_SECONDS=1

# A foreign same-name container and duplicate service both fail before stop.
reset_state
add_container id-foreign vaysen-crm-backend other-project backend true
if compose_lifecycle_discover_vaysen-crm vaysen-ai-crm true 2>/dev/null; then exit 1; fi
assert_no_calls

reset_state
add_container id-backend vaysen-crm-backend vaysen-ai-crm backend true
add_container id-duplicate unexpected-backend vaysen-ai-crm backend true
if compose_lifecycle_discover_vaysen-crm vaysen-ai-crm true 2>/dev/null; then exit 1; fi
assert_no_calls

# Disappearance after inventory is already-stopped; a failed stop is accepted
# only when a second inspect proves the container is no longer running.
reset_state
add_container id-backend vaysen-crm-backend vaysen-ai-crm backend true
compose_lifecycle_register vaysen-ai-crm vaysen-crm-backend backend
rm -f "$FAKE_DOCKER_STATE/containers/id-backend"
if compose_lifecycle_stop_all 2>/dev/null; then exit 1; fi
assert_no_calls

reset_state
add_container id-backend vaysen-crm-backend vaysen-ai-crm backend true
touch "$FAKE_DOCKER_STATE/behavior/stop-fail-running-id-backend"
compose_lifecycle_register vaysen-ai-crm vaysen-crm-backend backend
if compose_lifecycle_stop_all 2>/dev/null; then exit 1; fi

reset_state
add_container id-backend vaysen-crm-backend vaysen-ai-crm backend true
add_container id-worker vaysen-crm-worker-email-compose vaysen-ai-crm worker-email-compose true
touch "$FAKE_DOCKER_STATE/behavior/stop-fail-running-id-worker"
compose_lifecycle_register vaysen-ai-crm vaysen-crm-backend backend
compose_lifecycle_register vaysen-ai-crm vaysen-crm-worker-email-compose worker-email-compose
if compose_lifecycle_stop_all 2>/dev/null; then exit 1; fi
grep -Fx 'start id-backend' "$FAKE_DOCKER_STATE/calls.log" >/dev/null
[ "$(docker inspect -f '{{.State.Running}}' id-backend)" = true ]
[ "$(docker inspect -f '{{.State.Running}}' id-worker)" = true ]

reset_state
add_container id-backend vaysen-crm-backend vaysen-ai-crm backend true
touch "$FAKE_DOCKER_STATE/behavior/stop-fail-stopped-id-backend"
compose_lifecycle_register vaysen-ai-crm vaysen-crm-backend backend
compose_lifecycle_stop_all

# A single-service stop supports code-only rollback where the candidate-only
# OpenClaw container is still running and the old release has no such service.
reset_state
add_container id-backend vaysen-crm-backend vaysen-ai-crm backend true
add_container id-openclaw vaysen-crm-openclaw-gateway vaysen-ai-crm openclaw-gateway true
compose_lifecycle_register vaysen-ai-crm vaysen-crm-backend backend
compose_lifecycle_register vaysen-ai-crm vaysen-crm-openclaw-gateway openclaw-gateway
compose_lifecycle_stop_service openclaw-gateway
grep -Fx 'stop id-openclaw' "$FAKE_DOCKER_STATE/calls.log" >/dev/null
if grep -Fx 'stop id-backend' "$FAKE_DOCKER_STATE/calls.log" >/dev/null; then exit 1; fi

# Final re-inventory rejects an ID replacement and a writer that restarts
# after its individual bounded stop but before the whole set is quiesced.
reset_state
add_container id-backend vaysen-crm-backend vaysen-ai-crm backend true
compose_lifecycle_register vaysen-ai-crm vaysen-crm-backend backend
compose_lifecycle_stop_id id-backend vaysen-crm-backend
rm -f "$FAKE_DOCKER_STATE/containers/id-backend"
add_container id-replacement vaysen-crm-backend vaysen-ai-crm backend true
if compose_lifecycle_verify_quiesced_all 2>/dev/null; then exit 1; fi

reset_state
add_container id-backend vaysen-crm-backend vaysen-ai-crm backend true
add_container id-worker vaysen-crm-worker-email-compose vaysen-ai-crm worker-email-compose true
compose_lifecycle_register vaysen-ai-crm vaysen-crm-backend backend
compose_lifecycle_register vaysen-ai-crm vaysen-crm-worker-email-compose worker-email-compose
compose_lifecycle_stop_id id-backend vaysen-crm-backend
printf 'id-backend|vaysen-crm-backend|vaysen-ai-crm|backend|true|False|\n' >"$FAKE_DOCKER_STATE/containers/id-backend"
compose_lifecycle_stop_id id-worker vaysen-crm-worker-email-compose
if compose_lifecycle_verify_quiesced_all 2>/dev/null; then exit 1; fi

# A trusted interrupted migration one-off is excluded from regular inventory
# and removed only after its project/service/name/revision contract is proven.
reset_state
revision='0123456789abcdef0123456789abcdef01234567'
add_container id-backend vaysen-crm-backend vaysen-ai-crm backend true False
add_container id-migration vaysen-crm-prisma-migrate-01234567 vaysen-ai-crm backend true True "$revision"
compose_lifecycle_discover_vaysen-crm vaysen-ai-crm false
[ "${#COMPOSE_LIFECYCLE_IDS[@]}" -eq 1 ]
compose_lifecycle_establish_writer_free_boundary vaysen-ai-crm
grep -Fx 'stop id-backend' "$FAKE_DOCKER_STATE/calls.log" >/dev/null
grep -Fx 'rm id-migration' "$FAKE_DOCKER_STATE/calls.log" >/dev/null
stop_call_line="$(grep -nFx 'stop id-backend' "$FAKE_DOCKER_STATE/calls.log" | cut -d: -f1)"
rm_call_line="$(grep -nFx 'rm id-migration' "$FAKE_DOCKER_STATE/calls.log" | cut -d: -f1)"
[ "$stop_call_line" -lt "$rm_call_line" ] || {
    printf '[FAIL] regular writers must stop before trusted migration one-offs are removed\n' >&2
    exit 1
}

# A forged migration writer makes the code-only rollback boundary fail closed:
# regular writers stay stopped because migration state is indeterminate.
reset_state
add_container id-backend vaysen-crm-backend vaysen-ai-crm backend true False
add_container id-forged vaysen-crm-prisma-migrate-01234567 vaysen-ai-crm backend true True
compose_lifecycle_discover_vaysen-crm vaysen-ai-crm false
if compose_lifecycle_establish_writer_free_boundary vaysen-ai-crm 2>/dev/null; then exit 1; fi
grep -Fx 'stop id-backend' "$FAKE_DOCKER_STATE/calls.log" >/dev/null
if grep -Fx 'start id-backend' "$FAKE_DOCKER_STATE/calls.log" >/dev/null; then exit 1; fi
[ "$(docker inspect -f '{{.State.Running}}' id-backend)" = false ]

# If removal fails after another trusted migration one-off was already
# removed, the regular application must remain stopped: cleanup state is no
# longer safe enough for automatic recovery.
reset_state
revision_a='0123456789abcdef0123456789abcdef01234567'
revision_b='89abcdef0123456789abcdef0123456789abcdef'
add_container id-backend vaysen-crm-backend vaysen-ai-crm backend true False
add_container id-migration-a vaysen-crm-prisma-migrate-01234567 vaysen-ai-crm backend true True "$revision_a"
add_container id-migration-b vaysen-crm-prisma-migrate-89abcdef vaysen-ai-crm backend true True "$revision_b"
touch "$FAKE_DOCKER_STATE/behavior/rm-fail-id-migration-b"
compose_lifecycle_discover_vaysen-crm vaysen-ai-crm false
if compose_lifecycle_establish_writer_free_boundary vaysen-ai-crm 2>/dev/null; then exit 1; fi
grep -Fx 'rm id-migration-a' "$FAKE_DOCKER_STATE/calls.log" >/dev/null
grep -Fx 'rm id-migration-b' "$FAKE_DOCKER_STATE/calls.log" >/dev/null
[ ! -f "$FAKE_DOCKER_STATE/containers/id-migration-a" ]
[ -f "$FAKE_DOCKER_STATE/containers/id-migration-b" ]
[ "$(docker inspect -f '{{.State.Running}}' id-backend)" = false ]
if grep -Fx 'start id-backend' "$FAKE_DOCKER_STATE/calls.log" >/dev/null; then exit 1; fi

reset_state
add_container id-forged vaysen-crm-prisma-migrate-01234567 vaysen-ai-crm backend true True
if compose_lifecycle_remove_production_migration_oneoffs vaysen-ai-crm 2>/dev/null; then exit 1; fi
assert_no_calls

# Child rollback checks reuse the inherited locked FD, while an unrelated
# process with no inherited descriptor must be rejected by the same lock.
lock_dir="$TMP_ROOT/releases"
case "$(uname -s)" in
    MINGW*|MSYS*|CYGWIN*)
        printf '[SKIP] production flock ownership fixture runs in the mandatory Linux gate\n'
        ;;
    *)
        mkdir "$lock_dir"
        chmod 700 "$lock_dir"
        compose_lifecycle_acquire_transaction_lock "$lock_dir"
        bash -ceu 'source "$1"; compose_lifecycle_acquire_transaction_lock "$2"' \
            bash "$SCRIPT_DIR/compose-container-lifecycle.sh" "$lock_dir"
        bash -ceu 'exec 9>&-; source "$1"; if compose_lifecycle_acquire_transaction_lock "$2" 2>/dev/null; then exit 1; fi' \
            bash "$SCRIPT_DIR/compose-container-lifecycle.sh" "$lock_dir"
        exec 9>&-
        ;;
esac

printf '[PASS] compose lifecycle partial/missing/foreign/stop-race fixtures\n'
