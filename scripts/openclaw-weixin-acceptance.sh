#!/usr/bin/env bash
# Interactive, post-QR acceptance for the real Tencent Weixin channel.
# It correlates a controlled phone action with durable CRM receipts without
# printing or persisting any raw Weixin account/peer identifier.

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
MODE="${1:---owner}"
OWNER_TIMEOUT_SECONDS="${OPENCLAW_WEIXIN_ACCEPTANCE_TIMEOUT_SECONDS:-120}"
NEGATIVE_OBSERVE_SECONDS="${OPENCLAW_WEIXIN_NEGATIVE_OBSERVE_SECONDS:-45}"

fail() { printf '[WEIXIN ACCEPTANCE ERROR] %s\n' "$*" >&2; exit 1; }
ok() { printf '[WEIXIN ACCEPTANCE OK] %s\n' "$*"; }

declare -A ACCEPTANCE_TRUSTED_SHA256=()
ACCEPTANCE_HEAD=''
ACCEPTANCE_RELEASE_TAG=''
ACCEPTANCE_ENV_SHA256=''
ACCEPTANCE_ENV_IDENTITY=''
ACCEPTANCE_OWNER_DIGEST=''

require_immutable_acceptance_file() {
  local relative="$1" absolute="$PROJECT_DIR/$1" expected_blob actual_blob mode digest_line
  [ -f "$absolute" ] && [ ! -L "$absolute" ] \
    || fail "required acceptance file is missing or symlinked: $relative"
  expected_blob="$(git -C "$PROJECT_DIR" rev-parse --verify "HEAD:${PROJECT_PREFIX}${relative}" 2>/dev/null || true)"
  actual_blob="$(git -C "$PROJECT_DIR" hash-object --no-filters "$absolute" 2>/dev/null || true)"
  [ -n "$expected_blob" ] && [ "$actual_blob" = "$expected_blob" ] \
    || fail "acceptance file does not match immutable HEAD: $relative"
  [ "$(stat -c '%u' "$absolute")" = "$(id -u)" ] \
    || fail "acceptance file must be owned by the acceptance user: $relative"
  mode="$(stat -c '%a' "$absolute")"
  [ $((8#$mode & 0022)) -eq 0 ] \
    || fail "acceptance file must not be group/world writable: $relative"
  digest_line="$(sha256sum -- "$absolute")" || fail "could not hash acceptance file: $relative"
  ACCEPTANCE_TRUSTED_SHA256[$relative]="${digest_line%% *}"
}

assert_acceptance_files_unchanged() {
  local relative digest_line
  for relative in "${!ACCEPTANCE_TRUSTED_SHA256[@]}"; do
    [ -f "$PROJECT_DIR/$relative" ] && [ ! -L "$PROJECT_DIR/$relative" ] \
      || fail "trusted acceptance file disappeared or became a symlink: $relative"
    digest_line="$(sha256sum -- "$PROJECT_DIR/$relative")" \
      || fail "could not re-hash acceptance file: $relative"
    [ "${digest_line%% *}" = "${ACCEPTANCE_TRUSTED_SHA256[$relative]}" ] \
      || fail "trusted acceptance file changed during the scenario: $relative"
  done
}

assert_production_state_unchanged() {
  local current_head current_tag env_digest_line env_identity backend_owner
  [ -f "$ENV_FILE" ] && [ ! -L "$ENV_FILE" ] \
    || fail 'production environment disappeared or became a symlink during acceptance'
  current_head="$(git -C "$PROJECT_DIR" rev-parse --verify HEAD 2>/dev/null || true)"
  [ "$current_head" = "$ACCEPTANCE_HEAD" ] \
    || fail 'production HEAD changed during Weixin acceptance'
  current_tag="$(git -C "$PROJECT_DIR" describe --exact-match --match 'vaysen-crm-lan-v*-r*' HEAD 2>/dev/null || true)"
  [ "$current_tag" = "$ACCEPTANCE_RELEASE_TAG" ] \
    || fail 'production release tag changed during Weixin acceptance'
  [ "$(git -C "$PROJECT_DIR" cat-file -t "$current_tag" 2>/dev/null || true)" = tag ] \
    || fail 'production release anchor is no longer an annotated tag'
  [ "$(git -C "$PROJECT_DIR" rev-parse --verify "$current_tag^{}" 2>/dev/null || true)" = "$ACCEPTANCE_HEAD" ] \
    || fail 'production release tag peel changed during Weixin acceptance'
  [ -z "$(git -C "$PROJECT_DIR" status --porcelain --untracked-files=normal)" ] \
    || fail 'production worktree changed during Weixin acceptance'
  env_digest_line="$(sha256sum -- "$ENV_FILE")" \
    || fail 'could not re-hash the production environment file'
  [ "${env_digest_line%% *}" = "$ACCEPTANCE_ENV_SHA256" ] \
    || fail 'production environment changed during Weixin acceptance'
  env_identity="$(stat -Lc '%d:%i:%s:%Y:%u:%g:%a' "$ENV_FILE")" \
    || fail 'could not re-stat the production environment file'
  [ "$env_identity" = "$ACCEPTANCE_ENV_IDENTITY" ] \
    || fail 'production environment identity changed during Weixin acceptance'
  backend_owner="$(compose exec -T backend sh -c 'printf %s "$OPENCLAW_WECHAT_OWNER_PEER_SHA256"')" \
    || fail 'could not read the running backend owner digest contract'
  [ "$backend_owner" = "$ACCEPTANCE_OWNER_DIGEST" ] \
    || fail 'running backend owner digest differs from the immutable environment'
}

assert_running_release_contract() {
  local service container container_revision image_ref image_revision expected_image expected_digest expected_image_id repo_digests
  for service in backend openclaw-gateway; do
    container="$(compose ps -q "$service")"
    [ -n "$container" ] || fail "$service is not running"
    container_revision="$(docker inspect -f '{{ index .Config.Labels "org.opencontainers.image.revision" }}' "$container" 2>/dev/null || true)"
    [ "$container_revision" = "$ACCEPTANCE_HEAD" ] \
      || fail "$service container revision does not match immutable production HEAD"
  done
  container="$(compose ps -q backend)"
  image_ref="$(docker inspect -f '{{.Image}}' "$container" 2>/dev/null || true)"
  image_revision="$(docker image inspect -f '{{ index .Config.Labels "org.opencontainers.image.revision" }}' "$image_ref" 2>/dev/null || true)"
  [ "$image_revision" = "$ACCEPTANCE_HEAD" ] \
    || fail 'running backend image revision does not match immutable production HEAD'

  expected_image="$(awk -F= '$1 == "OPENCLAW_IMAGE" { print substr($0, index($0, "=") + 1) }' "$ENV_FILE")"
  expected_digest="${expected_image##*@}"
  [[ "$expected_digest" =~ ^sha256:[a-f0-9]{64}$ ]] \
    || fail 'reviewed OpenClaw image digest is malformed'
  expected_image_id="$(docker image inspect -f '{{.Id}}' "$expected_image" 2>/dev/null || true)"
  [[ "$expected_image_id" =~ ^sha256:[a-f0-9]{64}$ ]] \
    || fail 'reviewed OpenClaw image is unavailable locally'
  repo_digests="$(docker image inspect -f '{{range .RepoDigests}}{{println .}}{{end}}' "$expected_image" 2>/dev/null || true)"
  printf '%s\n' "$repo_digests" | grep -Fxq "$expected_image" \
    || fail 'local OpenClaw image does not retain the reviewed RepoDigest'
  container="$(compose ps -q openclaw-gateway)"
  image_ref="$(docker inspect -f '{{.Image}}' "$container" 2>/dev/null || true)"
  [ "$image_ref" = "$expected_image_id" ] \
    || fail 'running OpenClaw image does not match the reviewed immutable digest'
}

validate_weixin_connected_status_json() {
  node -e '
    let raw = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => { raw += chunk; });
    process.stdin.on("end", () => {
      try {
        const payload = JSON.parse(raw);
        if (!payload || typeof payload !== "object" || Array.isArray(payload)
          || payload.configOnly === true || payload.gatewayReachable === false) throw new Error();
        const accounts = payload.channelAccounts?.["openclaw-weixin"];
        if (!Array.isArray(accounts) || accounts.length !== 1) throw new Error();
        const account = accounts[0];
        const accountId = account?.accountId;
        if (!account || typeof account !== "object" || Array.isArray(account)
          || typeof accountId !== "string" || !/^[A-Za-z0-9._-]{1,160}$/.test(accountId)
          || payload.channelDefaultAccountId?.["openclaw-weixin"] !== accountId
          || payload.channels?.["openclaw-weixin"]?.configured !== true
          || account.enabled !== true || account.configured !== true || account.running !== true
          || ![undefined, null, ""].includes(account.lastError)) throw new Error();
      } catch {
        process.exitCode = 1;
      }
    });
  '
}

case "$MODE" in
  --owner|--negative-non-owner|--negative-group|--all) ;;
  *) fail 'usage: openclaw-weixin-acceptance.sh [--owner|--negative-non-owner|--negative-group|--all]' ;;
esac
[[ "$OWNER_TIMEOUT_SECONDS" =~ ^[1-9][0-9]*$ ]] && [ "$OWNER_TIMEOUT_SECONDS" -le 300 ] \
  || fail 'OPENCLAW_WEIXIN_ACCEPTANCE_TIMEOUT_SECONDS must be between 1 and 300'
[[ "$NEGATIVE_OBSERVE_SECONDS" =~ ^[1-9][0-9]*$ ]] && [ "$NEGATIVE_OBSERVE_SECONDS" -le 120 ] \
  || fail 'OPENCLAW_WEIXIN_NEGATIVE_OBSERVE_SECONDS must be between 1 and 120'
[ -t 0 ] && [ -t 1 ] || fail 'real Weixin acceptance requires an interactive SSH terminal'
[ -f "$ENV_FILE" ] && [ ! -L "$ENV_FILE" ] || fail 'production environment file is missing or symlinked'
[ "$COMPOSE_FILE" = "$PROJECT_DIR/docker-compose.prod.yml" ] \
  || fail 'acceptance must use the immutable production Compose file'
[ "$ENV_FILE" = "$PROJECT_DIR/.env" ] \
  || fail 'acceptance must use the production environment file'
[ "$COMPOSE_PROJECT_NAME" = vaysen-ai-crm ] \
  || fail 'acceptance must target the production Compose project'
[ "$(stat -c '%u' "$ENV_FILE")" = "$(id -u)" ] \
  || fail 'run acceptance as the owner of the production environment file'
case "$(stat -c '%a' "$ENV_FILE")" in 600|640) ;; *) fail 'production environment mode must be 600 or 640' ;; esac
git -C "$PROJECT_DIR" rev-parse --is-inside-work-tree >/dev/null 2>&1 \
  || fail 'project directory is not a Git worktree'
PROJECT_PREFIX="$(git -C "$PROJECT_DIR" rev-parse --show-prefix)"
ACCEPTANCE_HEAD="$(git -C "$PROJECT_DIR" rev-parse --verify HEAD)"
[[ "$ACCEPTANCE_HEAD" =~ ^[a-f0-9]{40}$ ]] || fail 'production HEAD is not an immutable full SHA'
ACCEPTANCE_RELEASE_TAG="$(git -C "$PROJECT_DIR" describe --exact-match --match 'vaysen-crm-lan-v*-r*' HEAD 2>/dev/null || true)"
[[ "$ACCEPTANCE_RELEASE_TAG" =~ ^vaysen-crm-lan-v[0-9]+\.[0-9]+\.[0-9]+-r[0-9]+$ ]] \
  || fail 'production HEAD is not anchored by the exact Linux release tag'
[ "$(git -C "$PROJECT_DIR" cat-file -t "$ACCEPTANCE_RELEASE_TAG" 2>/dev/null || true)" = tag ] \
  || fail 'production release anchor must be an annotated tag'
[ "$(git -C "$PROJECT_DIR" rev-parse --verify "$ACCEPTANCE_RELEASE_TAG^{}" 2>/dev/null || true)" = "$ACCEPTANCE_HEAD" ] \
  || fail 'production release tag does not peel to HEAD'
RELEASE_COMMIT="$ACCEPTANCE_HEAD"
RELEASE_COMMIT_SHORT="${ACCEPTANCE_HEAD:0:8}"
RELEASE_TAG="$ACCEPTANCE_RELEASE_TAG"
export RELEASE_COMMIT RELEASE_COMMIT_SHORT RELEASE_TAG
[ -z "$(git -C "$PROJECT_DIR" status --porcelain --untracked-files=normal)" ] \
  || fail 'production worktree must be clean for Weixin acceptance'
for trusted_file in docker-compose.prod.yml scripts/compose-container-lifecycle.sh \
  scripts/openclaw-weixin-acceptance.sh scripts/validate-production-env.mjs \
  deploy/openclaw/plugins/vaysen-crm/verify-weixin-acceptance-evidence.mjs; do
  require_immutable_acceptance_file "$trusted_file"
done
node "$ENV_VALIDATOR" "$ENV_FILE" >/dev/null \
  || fail 'production environment/image contract failed before acceptance'
ACCEPTANCE_ENV_SHA256="$(sha256sum -- "$ENV_FILE" | awk 'NR == 1 { print $1 }')"
[[ "$ACCEPTANCE_ENV_SHA256" =~ ^[a-f0-9]{64}$ ]] \
  || fail 'could not snapshot the production environment digest'
ACCEPTANCE_ENV_IDENTITY="$(stat -Lc '%d:%i:%s:%Y:%u:%g:%a' "$ENV_FILE")"
ACCEPTANCE_OWNER_DIGEST="$(awk -F= '$1 == "OPENCLAW_WECHAT_OWNER_PEER_SHA256" { print substr($0, index($0, "=") + 1) }' "$ENV_FILE")"
[[ "$ACCEPTANCE_OWNER_DIGEST" =~ ^[a-f0-9]{64}$ ]] \
  || fail 'owner digest is not enrolled; complete openclaw-weixin-login.sh first'
# shellcheck source=compose-container-lifecycle.sh
source "$LIFECYCLE_HELPER"
compose_lifecycle_acquire_transaction_lock "$RELEASES_DIR" \
  || fail 'could not acquire the production lifecycle transaction lock'
compose() {
  docker compose --project-name "$COMPOSE_PROJECT_NAME" \
    --project-directory "$PROJECT_DIR" --env-file "$ENV_FILE" \
    -f "$COMPOSE_FILE" "$@"
}

compose config --quiet || fail 'production Compose configuration is invalid'
assert_running_release_contract
assert_production_state_unchanged
for service in postgres backend openclaw-gateway; do
  container="$(compose ps -q "$service")"
  [ -n "$container" ] || fail "$service is not running"
  health="$(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' "$container" 2>/dev/null || true)"
  [ "$health" = 'healthy' ] || fail "$service is not healthy"
done

WEIXIN_STATUS_JSON="$(compose exec -T openclaw-gateway node dist/index.js channels status --json --probe)" \
  || fail 'official Weixin channel probe failed'
printf '%s' "$WEIXIN_STATUS_JSON" | validate_weixin_connected_status_json \
  || fail 'official Weixin channel is not uniquely configured, running, and error-free'
WEIXIN_STATUS_JSON=''

psql_scalar() {
  compose exec -T postgres psql -X -v ON_ERROR_STOP=1 -U vaysen-crm -d vaysen-crm_pilot -Atqc "$1" \
    | tr -d '\r'
}

db_now() {
  psql_scalar "SELECT to_char(clock_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"');"
}

assert_safe_timestamp() {
  [[ "$1" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z$ ]] \
    || fail 'database returned an invalid acceptance timestamp'
}

receipt_rows_for_marker() {
  local started_at="$1" marker_digest="$2"
  psql_scalar "
    SELECT r.\"status\"::text || '|' || r.\"businessStatus\"::text || '|' || r.\"toolName\" || '|' || r.\"requestKey\"
      FROM \"OpenClawToolReceipt\" r
      JOIN \"AgentRun\" run ON run.\"id\" = r.\"runId\"
      JOIN \"OpenClawOperatorBinding\" binding
        ON binding.\"companyId\" = r.\"companyId\"
       AND binding.\"operatorUserId\" = r.\"operatorUserId\"
       AND binding.\"senderDigest\" = r.\"senderDigest\"
       AND binding.\"channel\" = 'openclaw-weixin'
       AND binding.\"status\" = 'ACTIVE'
     WHERE run.\"source\" = 'WECHAT_OWNER'::\"AgentRunSource\"
       AND r.\"createdAt\" >= '$started_at'::timestamptz
       AND r.\"acceptanceMarkerDigest\" = '$marker_digest'
       AND r.\"toolName\" = 'work-brief'
     ORDER BY r.\"createdAt\" ASC;"
}

receipt_count_for_marker() {
  local started_at="$1" marker_digest="$2"
  psql_scalar "
    SELECT count(*)
      FROM \"OpenClawToolReceipt\" r
      JOIN \"AgentRun\" run ON run.\"id\" = r.\"runId\"
      JOIN \"OpenClawOperatorBinding\" binding
        ON binding.\"companyId\" = r.\"companyId\"
       AND binding.\"operatorUserId\" = r.\"operatorUserId\"
       AND binding.\"senderDigest\" = r.\"senderDigest\"
       AND binding.\"channel\" = 'openclaw-weixin'
       AND binding.\"status\" = 'ACTIVE'
     WHERE run.\"source\" = 'WECHAT_OWNER'::\"AgentRunSource\"
       AND r.\"createdAt\" >= '$started_at'::timestamptz
       AND r.\"acceptanceMarkerDigest\" = '$marker_digest'
       AND r.\"toolName\" = 'work-brief';"
}

acceptance_replay_count_for_marker() {
  local started_at="$1" marker_digest="$2"
  psql_scalar "
    SELECT count(*)
      FROM \"AgentAuditLog\" audit
      JOIN \"OpenClawToolReceipt\" r ON r.\"runId\" = audit.\"runId\"
     WHERE audit.\"eventType\" = 'OPENCLAW_ACCEPTANCE_REPLAY_DEDUPLICATED'
       AND audit.\"createdAt\" >= '$started_at'::timestamptz
       AND r.\"acceptanceMarkerDigest\" = '$marker_digest'
       AND r.\"toolName\" = 'work-brief';"
}

verify_rejection_evidence() {
  local marker="$1" expected_outcome="$2" started_at="$3"
  local marker_digest evidence_json
  marker_digest="$(printf '%s' "$marker" | sha256sum | awk 'NR == 1 { print $1 }')"
  [[ "$marker_digest" =~ ^[a-f0-9]{64}$ ]] || fail 'could not hash the rejection acceptance marker'

  evidence_json="$(compose exec -T openclaw-gateway node \
    /opt/vaysen-plugins/vaysen-crm/verify-weixin-acceptance-evidence.mjs \
    "$marker" "$expected_outcome" /home/node/.openclaw 2>/dev/null)" || return 1

  EVIDENCE_JSON="$evidence_json" EXPECTED_DIGEST="$marker_digest" \
    EXPECTED_OUTCOME="$expected_outcome" STARTED_AT="$started_at" \
    node <<'NODE'
const evidence = JSON.parse(process.env.EVIDENCE_JSON || 'null');
const startedAt = Date.parse(process.env.STARTED_AT || '');
const observedAt = Date.parse(evidence?.observedAt || '');
if (!evidence
  || evidence.markerDigest !== process.env.EXPECTED_DIGEST
  || evidence.outcome !== process.env.EXPECTED_OUTCOME) {
  process.exit(1);
}
if (!Number.isFinite(startedAt) || !Number.isFinite(observedAt) || observedAt < startedAt) {
  process.exit(1);
}
if (observedAt > Date.now() + 30000) {
  process.exit(1);
}
NODE
}

run_owner_acceptance() {
  local marker marker_digest started_at replay_started_at elapsed=0 rows count replay_count status business tool request_key
  marker="JYACC_OWNER_$(openssl rand -hex 8)"
  marker_digest="$(printf '%s' "$marker" | sha256sum | awk 'NR == 1 { print $1 }')"
  [[ "$marker_digest" =~ ^[a-f0-9]{64}$ ]] || fail 'could not hash the owner acceptance marker'
  started_at="$(db_now)"
  assert_safe_timestamp "$started_at"

  printf '%s\n' \
    '[OWNER TEST] Use the just-bound owner Weixin account in a PRIVATE chat.' \
    "Send exactly: 查看今日工作简报 ${marker}" \
    'After the phone shows the message as sent, press Enter here.'
  read -r _

  while [ "$elapsed" -lt "$OWNER_TIMEOUT_SECONDS" ]; do
    count="$(receipt_count_for_marker "$started_at" "$marker_digest")"
    [[ "$count" =~ ^[0-9]+$ ]] || fail 'invalid receipt count from database'
    [ "$count" -le 1 ] || fail "owner message produced duplicate CRM receipts: $count"
    if [ "$count" -eq 1 ]; then
      rows="$(receipt_rows_for_marker "$started_at" "$marker_digest")"
      IFS='|' read -r status business tool request_key <<< "$rows"
      if [ "$status" != 'PROCESSING' ]; then break; fi
    fi
    sleep 2
    elapsed=$((elapsed + 2))
  done

  [ "${count:-0}" -eq 1 ] || fail 'owner message did not produce a durable WECHAT_OWNER receipt before timeout'
  [ "$status" = 'COMPLETED' ] || fail "owner receipt ended as $status"
  [ "$business" = 'SUCCEEDED' ] || fail "owner business receipt ended as $business"
  [ "$tool" = 'work-brief' ] || fail "owner message invoked unexpected tool: $tool"
  [[ "$request_key" =~ ^[a-f0-9]{64}$ ]] || fail 'owner receipt request key is malformed'

  printf '%s\n' \
    '[OWNER REPLAY TEST] Resend the exact same private message once more from the owner phone:' \
    "Send exactly again: 查看今日工作简报 ${marker}" \
    'After the phone shows the duplicate message as sent, press Enter here.'
  replay_started_at="$(db_now)"
  assert_safe_timestamp "$replay_started_at"
  read -r _
  elapsed=0
  replay_count=0
  while [ "$elapsed" -lt "$OWNER_TIMEOUT_SECONDS" ]; do
    replay_count="$(acceptance_replay_count_for_marker "$replay_started_at" "$marker_digest")"
    [[ "$replay_count" =~ ^[0-9]+$ ]] || fail 'invalid acceptance replay count from database'
    [ "$replay_count" -ge 1 ] && break
    sleep 2
    elapsed=$((elapsed + 2))
  done
  [ "$replay_count" -ge 1 ] \
    || fail 'owner duplicate replay did not reach the broker idempotency boundary before timeout'
  count="$(receipt_count_for_marker "$started_at" "$marker_digest")"
  [ "$count" -eq 1 ] || fail "owner duplicate replay produced duplicate CRM receipts: $count"
  ok 'the explicit owner replay reached the broker and reused the one completed CRM work-brief receipt'
}

run_negative_acceptance() {
  local kind="$1" marker expected_outcome started_at marker_digest count elapsed=0
  case "$kind" in
    non-owner)
      marker="JYACC_NONOWNER_$(openssl rand -hex 8)"
      expected_outcome='NON_OWNER_REJECTED'
      ;;
    group)
      marker="JYACC_GROUP_$(openssl rand -hex 8)"
      expected_outcome='GROUP_REJECTED'
      ;;
    *) fail 'unsupported negative acceptance kind' ;;
  esac
  marker_digest="$(printf '%s' "$marker" | sha256sum | awk 'NR == 1 { print $1 }')"
  [[ "$marker_digest" =~ ^[a-f0-9]{64}$ ]] || fail 'could not hash the rejection acceptance marker'
  started_at="$(db_now)"
  assert_safe_timestamp "$started_at"
  if [ "$kind" = 'non-owner' ]; then
    printf '%s\n' \
      '[NON-OWNER NEGATIVE TEST] From a DIFFERENT, unapproved Weixin account, privately send:' \
      "查看今日工作简报 拒绝验收码 ${marker}" \
      'After sending, press Enter here.'
  else
    printf '%s\n' \
      '[GROUP NEGATIVE TEST] From the BOUND OWNER account, send in a Weixin GROUP:' \
      "查看今日工作简报 群聊拒绝验收码 ${marker}" \
      'After sending, press Enter here.'
  fi
  read -r _

  while [ "$elapsed" -lt "$NEGATIVE_OBSERVE_SECONDS" ]; do
    if verify_rejection_evidence "$marker" "$expected_outcome" "$started_at"; then
      break
    fi
    sleep 2
    elapsed=$((elapsed + 2))
  done
  [ "$elapsed" -lt "$NEGATIVE_OBSERVE_SECONDS" ] \
    || fail "$kind message did not produce verified sanitized rejection evidence before timeout"

  count="$(psql_scalar "
    SELECT count(*)
      FROM \"OpenClawToolReceipt\"
     WHERE \"createdAt\" >= '$started_at'::timestamptz
       AND \"acceptanceMarkerDigest\" = '$marker_digest';")"
  [[ "$count" =~ ^[0-9]+$ ]] || fail 'invalid negative receipt count from database'
  [ "$count" -eq 0 ] || fail "$kind message crossed the rejection boundary and created a CRM receipt"
  ok "$kind message was observed by the real adapter, rejected before CRM execution, and stored only sanitized evidence"
}

case "$MODE" in
  --owner) run_owner_acceptance ;;
  --negative-non-owner) run_negative_acceptance non-owner ;;
  --negative-group) run_negative_acceptance group ;;
  --all)
    run_owner_acceptance
    run_negative_acceptance non-owner
    run_negative_acceptance group
    ;;
esac

WEIXIN_STATUS_JSON="$(compose exec -T openclaw-gateway node dist/index.js channels status --json --probe)" \
  || fail 'official Weixin channel final probe failed'
printf '%s' "$WEIXIN_STATUS_JSON" | validate_weixin_connected_status_json \
  || fail 'official Weixin channel disconnected or drifted during acceptance'
WEIXIN_STATUS_JSON=''
assert_running_release_contract
assert_production_state_unchanged
assert_acceptance_files_unchanged
ok 'requested real Weixin acceptance scenario(s) passed without exposing raw peer identifiers'
