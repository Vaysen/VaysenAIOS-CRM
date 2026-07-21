#!/usr/bin/env bash
# Shared fail-closed discovery and lifecycle controls for production writers.
# This file is sourced by deploy/restore/rollback scripts.

if [ "${BASH_SOURCE[0]}" = "$0" ]; then
    printf '[LIFECYCLE ERROR] source this helper; do not execute it directly\n' >&2
    exit 2
fi

COMPOSE_LIFECYCLE_IDS=()
COMPOSE_LIFECYCLE_NAMES=()
COMPOSE_LIFECYCLE_SERVICES=()
COMPOSE_LIFECYCLE_WAS_RUNNING=()
COMPOSE_LIFECYCLE_INITIAL_RESTARTS=()
COMPOSE_LIFECYCLE_EXPECTED_NAMES=()
COMPOSE_LIFECYCLE_EXPECTED_SERVICES=()
COMPOSE_LIFECYCLE_PROJECT=""

compose_lifecycle_log() {
    printf '[LIFECYCLE] %s\n' "$*" >&2
}

compose_lifecycle_error() {
    printf '[LIFECYCLE ERROR] %s\n' "$*" >&2
    return 1
}

compose_lifecycle_reset() {
    COMPOSE_LIFECYCLE_IDS=()
    COMPOSE_LIFECYCLE_NAMES=()
    COMPOSE_LIFECYCLE_SERVICES=()
    COMPOSE_LIFECYCLE_WAS_RUNNING=()
    COMPOSE_LIFECYCLE_INITIAL_RESTARTS=()
    COMPOSE_LIFECYCLE_EXPECTED_NAMES=()
    COMPOSE_LIFECYCLE_EXPECTED_SERVICES=()
    COMPOSE_LIFECYCLE_PROJECT=""
}

compose_lifecycle_register() {
    local project="$1" expected_name="$2" expected_service="$3"
    local ids_output id actual_name project_label service_label running restart_count
    local ids=()

    if [ -n "$COMPOSE_LIFECYCLE_PROJECT" ] && [ "$COMPOSE_LIFECYCLE_PROJECT" != "$project" ]; then
        compose_lifecycle_error "one inventory cannot mix Compose projects" || return 1
    fi
    COMPOSE_LIFECYCLE_PROJECT="$project"
    COMPOSE_LIFECYCLE_EXPECTED_NAMES+=("$expected_name")
    COMPOSE_LIFECYCLE_EXPECTED_SERVICES+=("$expected_service")

    ids_output="$(docker ps -aq \
        --filter "label=com.docker.compose.project=$project" \
        --filter "label=com.docker.compose.service=$expected_service" \
        --filter 'label=com.docker.compose.oneoff=False')" \
        || compose_lifecycle_error "could not enumerate $project/$expected_service containers" \
        || return 1
    while IFS= read -r id; do
        [ -n "$id" ] && ids+=("$id")
    done <<< "$ids_output"

    if [ "${#ids[@]}" -gt 1 ]; then
        compose_lifecycle_error "multiple containers claim $project/$expected_service" || return 1
    fi
    if [ "${#ids[@]}" -eq 0 ]; then
        if docker container inspect "$expected_name" >/dev/null 2>&1; then
            compose_lifecycle_error "container $expected_name exists but is not owned by $project/$expected_service" || return 1
        fi
        compose_lifecycle_log "current application container is absent; continuing partial rollback: $expected_name"
        return 0
    fi

    id="${ids[0]}"
    actual_name="$(docker inspect -f '{{.Name}}' "$id" 2>/dev/null)" \
        || compose_lifecycle_error "could not inspect container name for $id" \
        || return 1
    actual_name="${actual_name#/}"
    project_label="$(docker inspect -f '{{index .Config.Labels "com.docker.compose.project"}}' "$id" 2>/dev/null)" \
        || compose_lifecycle_error "could not inspect Compose project for $id" \
        || return 1
    service_label="$(docker inspect -f '{{index .Config.Labels "com.docker.compose.service"}}' "$id" 2>/dev/null)" \
        || compose_lifecycle_error "could not inspect Compose service for $id" \
        || return 1
    running="$(docker inspect -f '{{.State.Running}}' "$id" 2>/dev/null)" \
        || compose_lifecycle_error "could not inspect running state for $id" \
        || return 1
    restart_count="$(docker inspect -f '{{.RestartCount}}' "$id" 2>/dev/null)" \
        || compose_lifecycle_error "could not inspect restart count for $id" \
        || return 1
    if [ "$actual_name" != "$expected_name" ] \
        || [ "$project_label" != "$project" ] \
        || [ "$service_label" != "$expected_service" ] \
        || { [ "$running" != true ] && [ "$running" != false ]; } \
        || ! [[ "$restart_count" =~ ^[0-9]+$ ]]; then
        compose_lifecycle_error "container $id failed exact ownership check for $expected_name ($project/$expected_service)" \
            || return 1
    fi

    COMPOSE_LIFECYCLE_IDS+=("$id")
    COMPOSE_LIFECYCLE_NAMES+=("$expected_name")
    COMPOSE_LIFECYCLE_SERVICES+=("$expected_service")
    COMPOSE_LIFECYCLE_WAS_RUNNING+=("$running")
    COMPOSE_LIFECYCLE_INITIAL_RESTARTS+=("$restart_count")
}

compose_lifecycle_discover_vaysen-crm() {
    local project="$1" include_openclaw="${2:-true}" worker
    local workers=(worker-email-compose worker-email-validate worker-email-send worker-prospect-search worker-deep-research worker-maintenance)

    compose_lifecycle_reset
    compose_lifecycle_register "$project" vaysen-crm-backend backend || return 1
    for worker in "${workers[@]}"; do
        compose_lifecycle_register "$project" "vaysen-crm-$worker" "$worker" || return 1
    done
    if [ "$include_openclaw" = true ]; then
        compose_lifecycle_register "$project" vaysen-crm-openclaw-gateway openclaw-gateway || return 1
    fi
}

compose_lifecycle_id_for_service() {
    local expected_service="$1" index
    for index in "${!COMPOSE_LIFECYCLE_SERVICES[@]}"; do
        if [ "${COMPOSE_LIFECYCLE_SERVICES[$index]}" = "$expected_service" ]; then
            printf '%s\n' "${COMPOSE_LIFECYCLE_IDS[$index]}"
            return 0
        fi
    done
    return 1
}

compose_lifecycle_verify_quiesced_service() {
    local expected_name="$1" expected_service="$2"
    local ids_output id original_id actual_name project_label service_label running
    local ids=()

    ids_output="$(docker ps -aq \
        --filter "label=com.docker.compose.project=$COMPOSE_LIFECYCLE_PROJECT" \
        --filter "label=com.docker.compose.service=$expected_service" \
        --filter 'label=com.docker.compose.oneoff=False')" \
        || compose_lifecycle_error "could not re-enumerate $COMPOSE_LIFECYCLE_PROJECT/$expected_service after stop" \
        || return 1
    while IFS= read -r id; do
        [ -n "$id" ] && ids+=("$id")
    done <<< "$ids_output"
    [ "${#ids[@]}" -le 1 ] \
        || compose_lifecycle_error "multiple regular containers appeared after stop for $expected_service" \
        || return 1
    original_id="$(compose_lifecycle_id_for_service "$expected_service" 2>/dev/null || true)"
    if [ "${#ids[@]}" -eq 0 ]; then
        if docker container inspect "$expected_name" >/dev/null 2>&1; then
            compose_lifecycle_error "an unowned same-name container appeared after stop: $expected_name" || return 1
        fi
        [ -z "$original_id" ] \
            || compose_lifecycle_error "inventoried container disappeared before the destructive data boundary: $expected_name ($original_id)" \
            || return 1
        return 0
    fi
    id="${ids[0]}"
    [ -n "$original_id" ] && [ "$id" = "$original_id" ] \
        || compose_lifecycle_error "container identity changed after inventory for $expected_service" \
        || return 1
    actual_name="$(docker inspect -f '{{.Name}}' "$id" 2>/dev/null)" || return 1
    actual_name="${actual_name#/}"
    project_label="$(docker inspect -f '{{index .Config.Labels "com.docker.compose.project"}}' "$id" 2>/dev/null)" || return 1
    service_label="$(docker inspect -f '{{index .Config.Labels "com.docker.compose.service"}}' "$id" 2>/dev/null)" || return 1
    running="$(docker inspect -f '{{.State.Running}}' "$id" 2>/dev/null)" || return 1
    [ "$actual_name" = "$expected_name" ] \
        && [ "$project_label" = "$COMPOSE_LIFECYCLE_PROJECT" ] \
        && [ "$service_label" = "$expected_service" ] \
        && [ "$running" = false ] \
        || compose_lifecycle_error "writer is not safely quiesced after stop: $expected_name ($id)"
}

compose_lifecycle_verify_quiesced_all() {
    local index
    for index in "${!COMPOSE_LIFECYCLE_EXPECTED_SERVICES[@]}"; do
        compose_lifecycle_verify_quiesced_service \
            "${COMPOSE_LIFECYCLE_EXPECTED_NAMES[$index]}" \
            "${COMPOSE_LIFECYCLE_EXPECTED_SERVICES[$index]}" \
            || return 1
    done
}

compose_lifecycle_verify_recoverable_identity() {
    local index expected_name expected_service ids_output id original_id
    local actual_name project_label service_label
    local ids=()
    for index in "${!COMPOSE_LIFECYCLE_EXPECTED_SERVICES[@]}"; do
        expected_name="${COMPOSE_LIFECYCLE_EXPECTED_NAMES[$index]}"
        expected_service="${COMPOSE_LIFECYCLE_EXPECTED_SERVICES[$index]}"
        ids=()
        ids_output="$(docker ps -aq \
            --filter "label=com.docker.compose.project=$COMPOSE_LIFECYCLE_PROJECT" \
            --filter "label=com.docker.compose.service=$expected_service" \
            --filter 'label=com.docker.compose.oneoff=False')" \
            || compose_lifecycle_error "could not re-enumerate $expected_service for recovery" \
            || return 1
        while IFS= read -r id; do
            [ -n "$id" ] && ids+=("$id")
        done <<< "$ids_output"
        [ "${#ids[@]}" -le 1 ] \
            || compose_lifecycle_error "multiple regular containers exist during recovery for $expected_service" \
            || return 1
        original_id="$(compose_lifecycle_id_for_service "$expected_service" 2>/dev/null || true)"
        if [ "${#ids[@]}" -eq 0 ]; then
            if docker container inspect "$expected_name" >/dev/null 2>&1; then
                compose_lifecycle_error "an unowned same-name container exists during recovery: $expected_name" || return 1
            fi
            [ -z "$original_id" ] \
                || compose_lifecycle_error "an inventoried container disappeared and cannot be recovered: $expected_name ($original_id)" \
                || return 1
            continue
        fi
        id="${ids[0]}"
        [ -n "$original_id" ] && [ "$id" = "$original_id" ] \
            || compose_lifecycle_error "container identity changed before recovery for $expected_service" \
            || return 1
        actual_name="$(docker inspect -f '{{.Name}}' "$id" 2>/dev/null)" || return 1
        actual_name="${actual_name#/}"
        project_label="$(docker inspect -f '{{index .Config.Labels "com.docker.compose.project"}}' "$id" 2>/dev/null)" || return 1
        service_label="$(docker inspect -f '{{index .Config.Labels "com.docker.compose.service"}}' "$id" 2>/dev/null)" || return 1
        [ "$actual_name" = "$expected_name" ] \
            && [ "$project_label" = "$COMPOSE_LIFECYCLE_PROJECT" ] \
            && [ "$service_label" = "$expected_service" ] \
            || compose_lifecycle_error "container ownership changed before recovery: $expected_name ($id)" \
            || return 1
    done
}

compose_lifecycle_stop_id() {
    local id="$1" name="$2" running
    if ! docker container inspect "$id" >/dev/null 2>&1; then
        compose_lifecycle_error "inventoried container disappeared before stop and cannot be recovered: $name ($id)"
        return 1
    fi
    if timeout --signal=TERM --kill-after=10s "${CONTAINER_STOP_TIMEOUT_SECONDS:-30}s" \
        docker stop --timeout "${CONTAINER_STOP_GRACE_SECONDS:-10}" "$id" >/dev/null; then
        return 0
    fi
    if ! docker container inspect "$id" >/dev/null 2>&1; then
        compose_lifecycle_error "container disappeared during stop and cannot be recovered: $name ($id)"
        return 1
    fi
    running="$(docker inspect -f '{{.State.Running}}' "$id" 2>/dev/null || true)"
    [ "$running" = false ] \
        || compose_lifecycle_error "container remains running after bounded stop: $name ($id)"
}

compose_lifecycle_stop_service() {
    local expected_service="$1" index expected_name=""
    for index in "${!COMPOSE_LIFECYCLE_EXPECTED_SERVICES[@]}"; do
        if [ "${COMPOSE_LIFECYCLE_EXPECTED_SERVICES[$index]}" = "$expected_service" ]; then
            expected_name="${COMPOSE_LIFECYCLE_EXPECTED_NAMES[$index]}"
            break
        fi
    done
    [ -n "$expected_name" ] \
        || compose_lifecycle_error "service is outside the immutable inventory contract: $expected_service" \
        || return 1
    for index in "${!COMPOSE_LIFECYCLE_SERVICES[@]}"; do
        if [ "${COMPOSE_LIFECYCLE_SERVICES[$index]}" = "$expected_service" ]; then
            compose_lifecycle_stop_id \
                "${COMPOSE_LIFECYCLE_IDS[$index]}" "${COMPOSE_LIFECYCLE_NAMES[$index]}"
            compose_lifecycle_verify_quiesced_service "$expected_name" "$expected_service"
            return $?
        fi
    done
    compose_lifecycle_log "service is absent from the immutable inventory; treating it as stopped: $expected_service"
    compose_lifecycle_verify_quiesced_service "$expected_name" "$expected_service"
}

compose_lifecycle_stop_all() {
    local index
    for index in "${!COMPOSE_LIFECYCLE_IDS[@]}"; do
        if ! compose_lifecycle_stop_id \
            "${COMPOSE_LIFECYCLE_IDS[$index]}" "${COMPOSE_LIFECYCLE_NAMES[$index]}"; then
            compose_lifecycle_log "bounded stop failed; restoring the original application state"
            compose_lifecycle_start_all \
                || compose_lifecycle_log "automatic recovery after stop failure did not fully recover"
            return 1
        fi
    done
    if ! compose_lifecycle_verify_quiesced_all; then
        compose_lifecycle_log "final writer quiescence check failed; restoring the original application state"
        compose_lifecycle_start_all \
            || compose_lifecycle_log "automatic recovery after quiescence failure did not fully recover"
        return 1
    fi
}

compose_lifecycle_start_all() {
    local index id name running
    compose_lifecycle_verify_recoverable_identity || return 1
    for index in "${!COMPOSE_LIFECYCLE_IDS[@]}"; do
        id="${COMPOSE_LIFECYCLE_IDS[$index]}"
        name="${COMPOSE_LIFECYCLE_NAMES[$index]}"
        if [ "${COMPOSE_LIFECYCLE_WAS_RUNNING[$index]}" != true ]; then
            running="$(docker inspect -f '{{.State.Running}}' "$id" 2>/dev/null || true)"
            [ "$running" = false ] \
                || compose_lifecycle_error "an originally stopped container started during recovery: $name ($id)" \
                || return 1
            compose_lifecycle_log "leaving an originally stopped container stopped: $name ($id)"
            continue
        fi
        docker container inspect "$id" >/dev/null 2>&1 \
            || compose_lifecycle_error "inventoried container is missing and cannot be restarted: $name ($id)" \
            || return 1
        running="$(docker inspect -f '{{.State.Running}}' "$id" 2>/dev/null || true)"
        if [ "$running" = false ]; then
            timeout --signal=TERM --kill-after=10s "${CONTAINER_START_TIMEOUT_SECONDS:-30}s" \
                docker start "$id" >/dev/null \
                || compose_lifecycle_error "could not restart inventoried container: $name ($id)" \
                || return 1
        elif [ "$running" = true ]; then
            compose_lifecycle_log "originally running container remained running during recovery: $name ($id)"
        else
            compose_lifecycle_error "could not determine container state during recovery: $name ($id)" || return 1
        fi
    done
    compose_lifecycle_wait_original_healthy
}

compose_lifecycle_wait_original_healthy() {
    local index id name expected_restarts timeout_seconds stable_seconds deadline
    local running health restart_count stable all_healthy original_running_count
    timeout_seconds="${CONTAINER_RECOVERY_TIMEOUT_SECONDS:-120}"
    stable_seconds="${CONTAINER_RECOVERY_STABLE_SECONDS:-3}"
    [[ "$timeout_seconds" =~ ^[1-9][0-9]*$ ]] && [[ "$stable_seconds" =~ ^[1-9][0-9]*$ ]] \
        || compose_lifecycle_error "container recovery timeouts must be positive integers" \
        || return 1
    original_running_count=0
    for index in "${!COMPOSE_LIFECYCLE_IDS[@]}"; do
        [ "${COMPOSE_LIFECYCLE_WAS_RUNNING[$index]}" = true ] \
            && original_running_count=$((original_running_count + 1))
    done
    [ "$original_running_count" -gt 0 ] || return 0
    deadline=$(( $(date +%s) + timeout_seconds ))
    stable=0
    while [ "$(date +%s)" -lt "$deadline" ]; do
        all_healthy=true
        for index in "${!COMPOSE_LIFECYCLE_IDS[@]}"; do
            [ "${COMPOSE_LIFECYCLE_WAS_RUNNING[$index]}" = true ] || continue
            id="${COMPOSE_LIFECYCLE_IDS[$index]}"
            name="${COMPOSE_LIFECYCLE_NAMES[$index]}"
            expected_restarts="${COMPOSE_LIFECYCLE_INITIAL_RESTARTS[$index]}"
            running="$(docker inspect -f '{{.State.Running}}' "$id" 2>/dev/null || true)"
            health="$(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{end}}' "$id" 2>/dev/null || true)"
            restart_count="$(docker inspect -f '{{.RestartCount}}' "$id" 2>/dev/null || true)"
            if [ "$restart_count" != "$expected_restarts" ]; then
                compose_lifecycle_error "container restarted during recovery: $name ($id)" || return 1
            fi
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
    for index in "${!COMPOSE_LIFECYCLE_IDS[@]}"; do
        if [ "${COMPOSE_LIFECYCLE_WAS_RUNNING[$index]}" = true ]; then
            compose_lifecycle_log "recovery health timeout includes: ${COMPOSE_LIFECYCLE_NAMES[$index]} (${COMPOSE_LIFECYCLE_IDS[$index]})"
        fi
    done
    compose_lifecycle_error "originally running containers did not share one healthy stability window"
}

compose_lifecycle_remove_production_migration_oneoffs() {
    local project="$1" id project_label service_label oneoff_label migration_label actual_name
    local globally_labeled all_backend oneoff_ids=()
    globally_labeled="$(docker ps -aq --filter 'label=com.vaysen.vaysen-crm.production-migration')" \
        || compose_lifecycle_error "could not enumerate production migration one-off containers" \
        || return 1
    while IFS= read -r id; do
        [ -n "$id" ] || continue
        project_label="$(docker inspect -f '{{index .Config.Labels "com.docker.compose.project"}}' "$id" 2>/dev/null || true)"
        service_label="$(docker inspect -f '{{index .Config.Labels "com.docker.compose.service"}}' "$id" 2>/dev/null || true)"
        oneoff_label="$(docker inspect -f '{{index .Config.Labels "com.docker.compose.oneoff"}}' "$id" 2>/dev/null || true)"
        [ "$project_label" = "$project" ] && [ "$service_label" = backend ] \
            && { [ "$oneoff_label" = True ] || [ "$oneoff_label" = true ]; } \
            || compose_lifecycle_error "refusing a foreign container carrying the production-migration label: $id" \
            || return 1
    done <<< "$globally_labeled"

    all_backend="$(docker ps -aq \
        --filter "label=com.docker.compose.project=$project" \
        --filter 'label=com.docker.compose.service=backend')" \
        || compose_lifecycle_error "could not enumerate Compose backend containers before migration cleanup" \
        || return 1
    while IFS= read -r id; do
        [ -n "$id" ] || continue
        oneoff_label="$(docker inspect -f '{{index .Config.Labels "com.docker.compose.oneoff"}}' "$id" 2>/dev/null || true)"
        case "$oneoff_label" in
            False|false) continue ;;
            True|true) ;;
            *) compose_lifecycle_error "backend container has an invalid Compose one-off label: $id" || return 1 ;;
        esac
        migration_label="$(docker inspect -f '{{index .Config.Labels "com.vaysen.vaysen-crm.production-migration"}}' "$id" 2>/dev/null || true)"
        actual_name="$(docker inspect -f '{{.Name}}' "$id" 2>/dev/null || true)"
        actual_name="${actual_name#/}"
        [[ "$migration_label" =~ ^[0-9a-f]{40}$ ]] \
            && [ "$actual_name" = "vaysen-crm-prisma-migrate-${migration_label:0:8}" ] \
            || compose_lifecycle_error "refusing an untrusted Compose backend one-off writer: $id" \
            || return 1
        oneoff_ids+=("$id")
    done <<< "$all_backend"

    # Validate the entire set first; only then make removals. This avoids a
    # partial cleanup if a forged writer is present beside a legitimate one.
    for id in "${oneoff_ids[@]}"; do
        docker rm -f "$id" >/dev/null \
            || compose_lifecycle_error "could not stop/remove production migration one-off container: $id" \
            || return 1
    done
}

compose_lifecycle_establish_writer_free_boundary() {
    local project="$1"
    compose_lifecycle_stop_all || return 1
    if ! compose_lifecycle_remove_production_migration_oneoffs "$project"; then
        # Cleanup may have removed only part of a previously validated set.
        # Keep the regular application stopped rather than risk restarting it
        # beside an indeterminate migration writer.
        compose_lifecycle_error "migration cleanup failed after regular writers stopped; application remains stopped"
        return 1
    fi
}

compose_lifecycle_acquire_transaction_lock() {
    local releases_dir="$1" lock_file="$1/.vaysen-crm-deploy.lock" mode fd_identity path_identity
    command -v flock >/dev/null 2>&1 \
        || compose_lifecycle_error "flock is required for production lifecycle transactions" \
        || return 1
    [ -d "$releases_dir" ] && [ ! -L "$releases_dir" ] \
        || compose_lifecycle_error "release directory is missing or symlinked: $releases_dir" \
        || return 1
    [ "$(stat -c '%u' "$releases_dir")" = "$(id -u)" ] \
        || compose_lifecycle_error "release directory must be owned by the current deployment user" \
        || return 1
    mode="$(stat -c '%a' "$releases_dir")"
    [ $((8#$mode & 0022)) -eq 0 ] \
        || compose_lifecycle_error "release directory must not be group/world writable" \
        || return 1
    if [ -e "$lock_file" ] || [ -L "$lock_file" ]; then
        [ -f "$lock_file" ] && [ ! -L "$lock_file" ] \
            || compose_lifecycle_error "transaction lock is not a regular non-symlink file" \
            || return 1
        [ "$(stat -c '%u' "$lock_file")" = "$(id -u)" ] \
            || compose_lifecycle_error "transaction lock is not owned by the deployment user" \
            || return 1
    fi
    fd_identity="$(stat -Lc '%d:%i' /proc/$$/fd/9 2>/dev/null || true)"
    path_identity="$(stat -Lc '%d:%i' "$lock_file" 2>/dev/null || true)"
    if [ -z "$fd_identity" ] || [ "$fd_identity" != "$path_identity" ]; then
        exec 9>>"$lock_file"
    fi
    chmod 600 "$lock_file"
    flock -n 9 \
        || compose_lifecycle_error "another deploy/rollback/restore/enrollment transaction is already in progress"
}
