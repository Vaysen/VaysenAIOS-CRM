#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP_DIR="${APP_DIR:-$(cd "$SCRIPT_DIR/.." && pwd)}"
LOG_DIR="$APP_DIR/logs"
STATE_FILE="$LOG_DIR/hunter-watchdog-state.json"
INCIDENT_FILE="$LOG_DIR/hunter-watchdog-incident.log"
AIDER_REQUEST_DIR="$LOG_DIR/aider-repair-requests"

CURL_TIMEOUT_SECONDS="${HUNTER_WATCHDOG_CURL_TIMEOUT_SECONDS:-5}"
CYCLE_ELAPSED_MAX_MS="${HUNTER_CYCLE_ELAPSED_MAX_MS:-1800000}"
TOTAL_FOUND_STALL_SECONDS="${HUNTER_TOTAL_FOUND_STALL_SECONDS:-1800}"
ZERO_FOUND_GRACE_SECONDS="${HUNTER_ZERO_FOUND_GRACE_SECONDS:-900}"
LAST_ERROR_CONSECUTIVE_THRESHOLD="${HUNTER_LAST_ERROR_CONSECUTIVE_THRESHOLD:-2}"
FAILURE_INCIDENT_THRESHOLD="${HUNTER_FAILURE_INCIDENT_THRESHOLD:-3}"
SEARXNG_URL="${SEARXNG_URL:-http://127.0.0.1:8080/search}"
HUNTER_AIDER_AUTO_REPAIR="${HUNTER_AIDER_AUTO_REPAIR:-true}"

mkdir -p "$LOG_DIR" "$AIDER_REQUEST_DIR"

usage() {
  cat <<'USAGE'
Usage: scripts/watch-hunters.sh {status|check|run-once} [--dry-run]

Commands:
  status      Read current service/hunter health and saved watchdog state. No writes.
  check       Evaluate once, write state, and run allowed restarts unless --dry-run.
  run-once    Same as check; intended for manual or timer-driven one-shot runs.

Environment knobs:
  HUNTER_CYCLE_ELAPSED_MAX_MS          Default: 1800000
  HUNTER_TOTAL_FOUND_STALL_SECONDS     Default: 1800
  HUNTER_ZERO_FOUND_GRACE_SECONDS      Default: 900
  HUNTER_LAST_ERROR_CONSECUTIVE_THRESHOLD Default: 2
  HUNTER_FAILURE_INCIDENT_THRESHOLD    Default: 3
  HUNTER_AIDER_AUTO_REPAIR             Default: true
USAGE
}

command="${1:-}"
dry_run=false
if [[ "${2:-}" == "--dry-run" ]]; then
  dry_run=true
elif [[ -n "${2:-}" ]]; then
  usage
  exit 2
fi

case "$command" in
  status|check|run-once) ;;
  *)
    usage
    exit 2
    ;;
esac

if ! command -v jq >/dev/null 2>&1; then
  echo "ERROR: jq is required for watchdog state handling." >&2
  exit 1
fi

now_epoch="$(date +%s)"
now_iso="$(date -u +"%Y-%m-%dT%H:%M:%SZ")"
previous_state='{}'
if [[ -f "$STATE_FILE" ]] && jq empty "$STATE_FILE" >/dev/null 2>&1; then
  previous_state="$(cat "$STATE_FILE")"
fi

entries_file="$(mktemp)"
trap 'rm -f "$entries_file" "${new_state_file:-}"' EXIT

redact() {
  sed -E \
    -e 's/(sk-[A-Za-z0-9_-]{8})[A-Za-z0-9_-]+/\1...REDACTED/g' \
    -e 's/([A-Za-z0-9_]*API[_-]?KEY[A-Za-z0-9_]*=)[^[:space:]]+/\1REDACTED/Ig' \
    -e 's/([A-Za-z0-9_]*TOKEN[A-Za-z0-9_]*=)[^[:space:]]+/\1REDACTED/Ig'
}

state_num() {
  local id="$1"
  local expr="$2"
  jq -r --arg id "$id" "$expr" <<<"$previous_state"
}

append_component_state() {
  local id="$1" kind="$2" label="$3" healthy="$4" fail_count="$5" incident_open="$6"
  local action="$7" action_detail="$8" reasons_json="$9" metrics_json="${10}"
  jq -c -n \
    --arg id "$id" \
    --arg kind "$kind" \
    --arg label "$label" \
    --arg checkedAt "$now_iso" \
    --arg action "$action" \
    --arg actionDetail "$action_detail" \
    --argjson healthy "$healthy" \
    --argjson failCount "$fail_count" \
    --argjson incidentOpen "$incident_open" \
    --argjson reasons "$reasons_json" \
    --argjson metrics "$metrics_json" \
    '{
      id: $id,
      kind: $kind,
      label: $label,
      checkedAt: $checkedAt,
      healthy: $healthy,
      failCount: $failCount,
      incidentOpen: $incidentOpen,
      reasons: $reasons,
      metrics: $metrics,
      lastAction: (if $action == "" then null else {at: $checkedAt, action: $action, detail: $actionDetail} end)
    }' >> "$entries_file"
}

print_result() {
  local label="$1" healthy="$2" fail_count="$3" action="$4" reasons_json="$5"
  if [[ "$healthy" == "true" ]]; then
    printf '[ok] %s\n' "$label"
  else
    printf '[fail:%s] %s\n' "$fail_count" "$label"
    jq -r '.[] | "  - " + .' <<<"$reasons_json"
  fi
  if [[ -n "$action" ]]; then
    printf '  action: %s\n' "$action"
  fi
}

maybe_restart() {
  local id="$1" label="$2" fail_count="$3" restart_cmd="$4"
  local action=""

  if [[ "$command" == "status" ]]; then
    echo ""
    return
  fi

  if (( fail_count >= FAILURE_INCIDENT_THRESHOLD )); then
    echo "incident-threshold-reached; restart suppressed"
    return
  fi

  if [[ "$dry_run" == "true" ]]; then
    echo "dry-run would run: $restart_cmd"
    return
  fi

  # shellcheck disable=SC2086
  if bash -lc "cd '$APP_DIR' && $restart_cmd"; then
    action="ran: $restart_cmd"
  else
    action="restart command failed: $restart_cmd"
  fi
  echo "$action"
}

maybe_log_incident() {
  local id="$1" label="$2" fail_count="$3" prev_incident_open="$4" reasons_json="$5"
  local request_file
  if [[ "$command" == "status" || "$dry_run" == "true" ]]; then
    return
  fi
  if (( fail_count >= FAILURE_INCIDENT_THRESHOLD )) && [[ "$prev_incident_open" != "true" ]]; then
    {
      printf '%s %s consecutive_failures=%s\n' "$now_iso" "$label" "$fail_count"
      jq -r '.[] | "  - " + .' <<<"$reasons_json"
    } >> "$INCIDENT_FILE"
    request_file="$(write_aider_request "$id" "$label" "$fail_count" "$reasons_json")"
    maybe_run_aider_repair "$request_file"
  fi
}

maybe_run_aider_repair() {
  local request_file="$1"
  if [[ "$HUNTER_AIDER_AUTO_REPAIR" != "true" ]]; then
    printf '%s aider auto repair disabled for request: %s\n' "$now_iso" "$request_file" >> "$INCIDENT_FILE"
    return
  fi
  if [[ ! -x "$APP_DIR/scripts/run-aider-hunter-repair.sh" ]]; then
    printf '%s aider repair script missing or not executable: %s\n' "$now_iso" "$APP_DIR/scripts/run-aider-hunter-repair.sh" >> "$INCIDENT_FILE"
    return
  fi
  nohup "$APP_DIR/scripts/run-aider-hunter-repair.sh" "$request_file" >> "$LOG_DIR/aider-hunter-repair-launch.log" 2>&1 &
  printf '%s aider auto repair launched for request: %s pid=%s\n' "$now_iso" "$request_file" "$!" >> "$INCIDENT_FILE"
}

write_aider_request() {
  local id="$1" label="$2" fail_count="$3" reasons_json="$4"
  local file="$AIDER_REQUEST_DIR/${now_iso//[:]/-}-${id}.md"
  {
    printf '# Hunter repair request\n\n'
    printf '- Time: `%s`\n' "$now_iso"
    printf '- Component: `%s`\n' "$label"
    printf '- Consecutive failures: `%s`\n\n' "$fail_count"
    printf '## Reasons\n\n'
    jq -r '.[] | "- " + .' <<<"$reasons_json"
    printf '\n## Required boundaries\n\n'
    printf '- Make the smallest safe code fix within the allowed files.\n'
    printf '- Do not print secrets from `.env` files.\n'
    printf '- Do not send email, delete data, or modify customer records.\n'
    printf '- Check SearXNG, `backend/worker-customs-hunter.js`, and hunter logs.\n\n'
    printf '## Useful commands\n\n'
    printf '```bash\n'
    printf 'cd /opt/vaysen-ai-crm\n'
    printf './scripts/watch-hunters.sh status\n'
    printf 'tail -n 120 logs/vaysen-crm-worker-customs-hunter.log logs/surfacepolish-worker-customs-hunter.log\n'
    printf 'curl -sS --max-time 15 "%s?q=test&format=json" | head\n' "$SEARXNG_URL"
    printf '```\n'
  } > "$file"
  printf '%s aider repair request written: %s\n' "$now_iso" "$file" >> "$INCIDENT_FILE"
  printf '%s\n' "$file"
}

check_service() {
  local id="continuous-prospect-service"
  local label="user service vaysen-crm-worker-continuous-prospect.service"
  local service="vaysen-crm-worker-continuous-prospect.service"
  local reasons_json metrics_json active sub_state fail_count prev_fail_count prev_incident_open incident_open healthy action

  active="$(systemctl --user is-active "$service" 2>/dev/null || true)"
  sub_state="$(systemctl --user show "$service" -p SubState --value 2>/dev/null || true)"
  reasons_json='[]'
  if [[ "$active" != "active" ]]; then
    reasons_json="$(jq -c -n --arg active "$active" '[("systemd user service is not active: " + $active)]')"
  fi

  healthy="$([[ "$(jq 'length' <<<"$reasons_json")" -eq 0 ]] && echo true || echo false)"
  prev_fail_count="$(state_num "$id" '.components[$id].failCount // 0')"
  prev_incident_open="$(state_num "$id" '.components[$id].incidentOpen // false')"
  if [[ "$healthy" == "true" ]]; then
    fail_count=0
    incident_open=false
    action=""
  else
    fail_count=$((prev_fail_count + 1))
    action="$(maybe_restart "$id" "$label" "$fail_count" "systemctl --user restart $service")"
    if (( fail_count >= FAILURE_INCIDENT_THRESHOLD )); then incident_open=true; else incident_open=false; fi
    maybe_log_incident "$id" "$label" "$fail_count" "$prev_incident_open" "$reasons_json"
  fi

  metrics_json="$(jq -c -n --arg active "$active" --arg subState "$sub_state" '{active: $active, subState: $subState}')"
  append_component_state "$id" "systemd-user-service" "$label" "$healthy" "$fail_count" "$incident_open" "$action" "" "$reasons_json" "$metrics_json"
  print_result "$label" "$healthy" "$fail_count" "$action" "$reasons_json"
}

check_searxng() {
  local id="searxng-search"
  local label="SearXNG search backend"
  local reasons_json metrics_json fail_count prev_fail_count prev_incident_open incident_open healthy action
  local search_url body result_count unresponsive_count

  search_url="${SEARXNG_URL}?q=site%3Aimportyeti.com%20custom%20packaging%20importer&format=json&language=en"
  body="$(curl -fsS --max-time 15 "$search_url" 2>/dev/null || true)"
  reasons_json='[]'
  result_count=0
  unresponsive_count=0

  if [[ -z "$body" ]] || ! jq empty <<<"$body" >/dev/null 2>&1; then
    reasons_json="$(jq -c -n '[ "SearXNG search endpoint timed out or returned invalid JSON" ]')"
  else
    result_count="$(jq -r '.results | length' <<<"$body" 2>/dev/null || echo 0)"
    unresponsive_count="$(jq -r '.unresponsive_engines | length' <<<"$body" 2>/dev/null || echo 0)"
    if [[ "$result_count" =~ ^[0-9]+$ ]] && (( result_count == 0 )); then
      reasons_json="$(jq -c --arg reason "SearXNG returned zero search results" '. + [$reason]' <<<"$reasons_json")"
    fi
    if [[ "$result_count" =~ ^[0-9]+$ ]] && (( result_count == 0 )) && [[ "$unresponsive_count" =~ ^[0-9]+$ ]] && (( unresponsive_count >= 3 )); then
      reasons_json="$(jq -c --arg reason "SearXNG has $unresponsive_count unresponsive engines" '. + [$reason]' <<<"$reasons_json")"
    fi
  fi

  metrics_json="$(jq -c -n \
    --arg url "$SEARXNG_URL" \
    --argjson resultCount "$result_count" \
    --argjson unresponsiveEngines "$unresponsive_count" \
    '{url: $url, resultCount: $resultCount, unresponsiveEngines: $unresponsiveEngines}')"

  healthy="$([[ "$(jq 'length' <<<"$reasons_json")" -eq 0 ]] && echo true || echo false)"
  prev_fail_count="$(state_num "$id" '.components[$id].failCount // 0')"
  prev_incident_open="$(state_num "$id" '.components[$id].incidentOpen // false')"
  if [[ "$healthy" == "true" ]]; then
    fail_count=0
    incident_open=false
    action=""
  else
    fail_count=$((prev_fail_count + 1))
    action="$(maybe_restart "$id" "$label" "$fail_count" "docker restart searxng")"
    if (( fail_count >= FAILURE_INCIDENT_THRESHOLD )); then incident_open=true; else incident_open=false; fi
    maybe_log_incident "$id" "$label" "$fail_count" "$prev_incident_open" "$reasons_json"
  fi

  append_component_state "$id" "searxng" "$label" "$healthy" "$fail_count" "$incident_open" "$action" "" "$reasons_json" "$metrics_json"
  print_result "$label" "$healthy" "$fail_count" "$action" "$reasons_json"
}

check_hunter() {
  local id="$1" label="$2" url="$3" restart_cmd="$4"
  local body curl_rc reasons_json metrics_json fail_count prev_fail_count healthy action
  local last_error last_error_present prev_last_error_count last_error_count
  local cycle_elapsed total_found prev_total_found prev_changed_at total_changed_at stall_age cycle prev_cycle started_at prev_started_at
  local prev_incident_open incident_open

  body="$(curl -fsS --max-time "$CURL_TIMEOUT_SECONDS" "$url" 2>/dev/null || true)"
  reasons_json='[]'
  metrics_json='{}'

  if [[ -z "$body" ]] || ! jq empty <<<"$body" >/dev/null 2>&1; then
    reasons_json="$(jq -c -n --arg url "$url" '[("status endpoint unreachable or invalid JSON: " + $url)]')"
  else
    last_error="$(jq -r '.lastError // empty' <<<"$body" | head -c 300 | redact)"
    cycle_elapsed="$(jq -r '.cycleElapsedMs // empty' <<<"$body")"
    total_found="$(jq -r '.totalFound // empty' <<<"$body")"
    cycle="$(jq -r '.cycle // empty' <<<"$body")"
    started_at="$(jq -r '.startedAt // empty' <<<"$body")"
    last_error_present=false
    [[ -n "$last_error" && "$last_error" != "null" ]] && last_error_present=true

    prev_last_error_count="$(state_num "$id" '.components[$id].metrics.lastErrorPresentCount // 0')"
    if [[ "$last_error_present" == "true" ]]; then
      last_error_count=$((prev_last_error_count + 1))
    else
      last_error_count=0
    fi

    if [[ "$last_error_present" == "true" ]] && (( last_error_count >= LAST_ERROR_CONSECUTIVE_THRESHOLD )); then
      reasons_json="$(jq -c --arg reason "lastError present for $last_error_count consecutive checks: $last_error" '. + [$reason]' <<<"$reasons_json")"
    fi

    if [[ "$cycle_elapsed" =~ ^[0-9]+$ ]] && (( cycle_elapsed > CYCLE_ELAPSED_MAX_MS )); then
      reasons_json="$(jq -c --arg reason "cycleElapsedMs $cycle_elapsed exceeds threshold $CYCLE_ELAPSED_MAX_MS" '. + [$reason]' <<<"$reasons_json")"
    fi

    prev_total_found="$(state_num "$id" '.components[$id].metrics.totalFound // empty')"
    prev_changed_at="$(state_num "$id" '.components[$id].metrics.totalFoundChangedAtEpoch // empty')"
    prev_cycle="$(state_num "$id" '.components[$id].metrics.cycle // empty')"
    prev_started_at="$(state_num "$id" '.components[$id].metrics.startedAt // empty')"
    if [[ -z "$total_found" || ! "$total_found" =~ ^[0-9]+$ ]]; then
      total_changed_at="${prev_changed_at:-$now_epoch}"
      stall_age=0
    elif [[ -n "$started_at" && "$started_at" != "$prev_started_at" ]]; then
      total_changed_at="$now_epoch"
      stall_age=0
    elif [[ "$cycle" =~ ^[0-9]+$ && "$prev_cycle" =~ ^[0-9]+$ && "$cycle" -lt "$prev_cycle" ]]; then
      total_changed_at="$now_epoch"
      stall_age=0
    elif [[ "$total_found" != "$prev_total_found" ]]; then
      total_changed_at="$now_epoch"
      stall_age=0
    else
      total_changed_at="${prev_changed_at:-$now_epoch}"
      stall_age=$((now_epoch - total_changed_at))
      if (( stall_age >= TOTAL_FOUND_STALL_SECONDS )); then
        reasons_json="$(jq -c --arg reason "totalFound unchanged at $total_found for ${stall_age}s; threshold ${TOTAL_FOUND_STALL_SECONDS}s" '. + [$reason]' <<<"$reasons_json")"
      fi
      if [[ "$total_found" == "0" ]] && [[ "$cycle_elapsed" =~ ^[0-9]+$ ]] && (( cycle_elapsed >= ZERO_FOUND_GRACE_SECONDS * 1000 )); then
        reasons_json="$(jq -c --arg reason "hunter has produced zero enriched leads for ${cycle_elapsed}ms; threshold $((ZERO_FOUND_GRACE_SECONDS * 1000))ms" '. + [$reason]' <<<"$reasons_json")"
      fi
    fi

    metrics_json="$(jq -c -n \
      --argjson status "$body" \
      --arg lastErrorSummary "$last_error" \
      --argjson lastErrorPresentCount "$last_error_count" \
      --arg totalFoundChangedAtEpoch "$total_changed_at" \
      --argjson stallAgeSeconds "$stall_age" \
      '{
        running: ($status.running // null),
        paused: ($status.paused // null),
        cycle: ($status.cycle // null),
        totalFound: ($status.totalFound // null),
        currentCategory: ($status.currentCategory // null),
        startedAt: ($status.startedAt // null),
        cycleElapsedMs: ($status.cycleElapsedMs // null),
        totalCategories: ($status.totalCategories // null),
        profile: ($status.profile // null),
        lastErrorPresent: (($status.lastError // null) != null and ($status.lastError // "") != ""),
        lastErrorPresentCount: $lastErrorPresentCount,
        lastErrorSummary: (if $lastErrorSummary == "" then null else $lastErrorSummary end),
        totalFoundChangedAtEpoch: ($totalFoundChangedAtEpoch | tonumber),
        totalFoundStallAgeSeconds: $stallAgeSeconds,
        zeroFoundGraceSeconds: env.HUNTER_ZERO_FOUND_GRACE_SECONDS
      }')"

    if [[ "$(jq -r '.running // true' <<<"$body")" != "true" ]]; then
      reasons_json="$(jq -c '. + ["status endpoint reports running=false"]' <<<"$reasons_json")"
    fi
  fi

  healthy="$([[ "$(jq 'length' <<<"$reasons_json")" -eq 0 ]] && echo true || echo false)"
  prev_fail_count="$(state_num "$id" '.components[$id].failCount // 0')"
  prev_incident_open="$(state_num "$id" '.components[$id].incidentOpen // false')"
  if [[ "$healthy" == "true" ]]; then
    fail_count=0
    incident_open=false
    action=""
  else
    fail_count=$((prev_fail_count + 1))
    action="$(maybe_restart "$id" "$label" "$fail_count" "$restart_cmd")"
    if (( fail_count >= FAILURE_INCIDENT_THRESHOLD )); then incident_open=true; else incident_open=false; fi
    maybe_log_incident "$id" "$label" "$fail_count" "$prev_incident_open" "$reasons_json"
  fi

  append_component_state "$id" "customs-hunter" "$label" "$healthy" "$fail_count" "$incident_open" "$action" "" "$reasons_json" "$metrics_json"
  print_result "$label" "$healthy" "$fail_count" "$action" "$reasons_json"
}

printf 'hunter watchdog command=%s dryRun=%s at=%s\n' "$command" "$dry_run" "$now_iso"
check_service
check_searxng
check_hunter "customs-hunter-4003" "4003 customs hunter" "http://127.0.0.1:4003/status" "./scripts/manage-customs-hunter.sh restart"
check_hunter "surface-customs-hunter-4013" "4013 surface customs hunter" "http://127.0.0.1:4013/status" "./scripts/manage-surfacepolish-customs-hunter.sh restart"

if [[ "$command" != "status" && "$dry_run" != "true" ]]; then
  new_state_file="$(mktemp)"
  jq -s -n \
    --arg updatedAt "$now_iso" \
    --argjson cycleElapsedMaxMs "$CYCLE_ELAPSED_MAX_MS" \
    --argjson totalFoundStallSeconds "$TOTAL_FOUND_STALL_SECONDS" \
    --argjson zeroFoundGraceSeconds "$ZERO_FOUND_GRACE_SECONDS" \
    --argjson failureIncidentThreshold "$FAILURE_INCIDENT_THRESHOLD" \
    --slurpfile components "$entries_file" \
    '{
      version: 1,
      updatedAt: $updatedAt,
      thresholds: {
        cycleElapsedMaxMs: $cycleElapsedMaxMs,
        totalFoundStallSeconds: $totalFoundStallSeconds,
        zeroFoundGraceSeconds: $zeroFoundGraceSeconds,
        failureIncidentThreshold: $failureIncidentThreshold
      },
      components: ($components | map({key: .id, value: .}) | from_entries)
    }' > "$new_state_file"
  mv "$new_state_file" "$STATE_FILE"
  printf 'state written: %s\n' "$STATE_FILE"
elif [[ "$dry_run" == "true" ]]; then
  printf 'dry-run: state not written and restarts not executed\n'
fi

if [[ -f "$STATE_FILE" ]]; then
  printf 'state file: %s\n' "$STATE_FILE"
else
  printf 'state file: %s (not created yet)\n' "$STATE_FILE"
fi
