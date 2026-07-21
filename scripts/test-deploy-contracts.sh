#!/usr/bin/env bash
# Static and sandbox tests for TASK-109 deployment safety contracts.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
PASS=0

pass() { printf '[PASS] %s\n' "$*"; PASS=$((PASS + 1)); }
fail() { printf '[FAIL] %s\n' "$*" >&2; exit 1; }
contains() { grep -Fq -- "$2" "$1" || fail "$1 missing contract: $2"; }
not_contains() {
    if grep -Fq -- "$2" "$1"; then
        fail "$1 contains forbidden contract: $2"
    fi
}
line_of() {
    local file="$1" pattern="$2" result
    result="$(grep -nF -- "$pattern" "$file" | head -1 | cut -d: -f1 || true)"
    [ -n "$result" ] || fail "required ordering anchor is missing from $file: $pattern"
    printf '%s\n' "$result"
}

for script in deploy.sh scripts/deploy-security-preflight.sh scripts/db-preflight.sh \
    scripts/rehearse-db-migration.sh scripts/select-migration-rehearsal-mode.sh scripts/recreate-db-from-backup.sh \
    scripts/backup-db.sh scripts/verify-db-backup.sh scripts/backup-runtime-data.sh scripts/sanitize-openclaw-runtime-snapshot.sh scripts/prepare-runtime-data.sh \
    scripts/restore-db.sh scripts/restore-runtime-data.sh scripts/rollback.sh scripts/deploy-smoke-test.sh scripts/rollback-smoke-test.sh \
    scripts/run-runtime-link-contract.sh scripts/runtime-initialize-transaction.sh scripts/runtime-restore-transaction.sh scripts/prepare-openclaw-runtime.sh scripts/openclaw-runtime-smoke-test.sh \
    scripts/openclaw-real-scene-test.sh scripts/openclaw-weixin-login.sh scripts/openclaw-weixin-login.test.sh \
    scripts/openclaw-weixin-acceptance.sh scripts/configure-searxng.sh; do
    bash -n "$PROJECT_DIR/$script" || fail "bash syntax: $script"
done
sh -n "$PROJECT_DIR/scripts/runtime-link-manifest.sh" \
    || fail "POSIX sh syntax: scripts/runtime-link-manifest.sh"
sh -n "$PROJECT_DIR/scripts/runtime-initialize-transaction.sh" \
    || fail "POSIX sh syntax: scripts/runtime-initialize-transaction.sh"

SEARXNG_FIXTURE="$(mktemp -d "${TMPDIR:-/tmp}/vaysen-crm-searxng-config-XXXXXX")"
printf 'use_default_settings: true\nserver:\n  secret_key: "ultrasecretkey"\n' \
    > "$SEARXNG_FIXTURE/template.yml"
SEARXNG_SETTINGS_PATH="$SEARXNG_FIXTURE/settings.yml" \
SEARXNG_TEMPLATE_PATH="$SEARXNG_FIXTURE/template.yml" \
SEARXNG_CONFIGURE_ONLY=true \
    sh "$PROJECT_DIR/scripts/configure-searxng.sh"
grep -Eq '^[[:space:]]*-[[:space:]]*json([[:space:]#]|$)' "$SEARXNG_FIXTURE/settings.yml" \
    || fail "SearXNG JSON format was not enabled"
contains "$SEARXNG_FIXTURE/settings.yml" '# Vaysen AI CRM China-network evidence engines v1'
contains "$SEARXNG_FIXTURE/settings.yml" '      - baidu'
contains "$SEARXNG_FIXTURE/settings.yml" '      - bing'
contains "$SEARXNG_FIXTURE/settings.yml" '    base_url: https://cn.bing.com'
not_contains "$SEARXNG_FIXTURE/settings.yml" 'ultrasecretkey'
[ "$(stat -c %a "$SEARXNG_FIXTURE/settings.yml")" = 600 ] \
    || fail "SearXNG settings must be mode 0600"
SEARXNG_SETTINGS_PATH="$SEARXNG_FIXTURE/settings.yml" \
SEARXNG_TEMPLATE_PATH="$SEARXNG_FIXTURE/template.yml" \
SEARXNG_CONFIGURE_ONLY=true \
    sh "$PROJECT_DIR/scripts/configure-searxng.sh"
[ "$(grep -c '^search:' "$SEARXNG_FIXTURE/settings.yml")" = 1 ] \
    || fail "SearXNG JSON configuration is not idempotent"
[ "$(grep -c '^engines:' "$SEARXNG_FIXTURE/settings.yml")" = 1 ] \
    || fail "SearXNG evidence-engine policy is not idempotent"
printf 'use_default_settings: true\nsearch:\n  formats:\n    - html\n' \
    > "$SEARXNG_FIXTURE/ambiguous.yml"
if SEARXNG_SETTINGS_PATH="$SEARXNG_FIXTURE/ambiguous.yml" \
    SEARXNG_TEMPLATE_PATH="$SEARXNG_FIXTURE/template.yml" \
    SEARXNG_CONFIGURE_ONLY=true \
    sh "$PROJECT_DIR/scripts/configure-searxng.sh" >/dev/null 2>&1; then
    fail "SearXNG wrapper rewrote an ambiguous existing search policy"
fi
rm -rf "$SEARXNG_FIXTURE"
pass "SearXNG JSON and China-network evidence engines are secure, idempotent, and fail-closed"

contains "$PROJECT_DIR/scripts/deploy-smoke-test.sh" 'searx_evidence_ready()'
contains "$PROJECT_DIR/scripts/deploy-smoke-test.sh" 'for attempt in 1 2 3 4 5 6; do'
contains "$PROJECT_DIR/scripts/deploy-smoke-test.sh" 'SEARX_EVIDENCE_READY=1'
contains "$PROJECT_DIR/scripts/deploy-smoke-test.sh" 'after bounded readiness retries'
pass "SearXNG deployment smoke waits for a real public result with bounded fail-closed retries"

SANITIZE_FIXTURE="$(mktemp -d "${TMPDIR:-/tmp}/vaysen-crm-runtime-sanitize-XXXXXX")"
mkdir -p "$SANITIZE_FIXTURE/plugin-skills"
ln -s /app/dist/extensions/browser/skills/browser-automation \
    "$SANITIZE_FIXTURE/plugin-skills/browser-automation"
bash "$PROJECT_DIR/scripts/sanitize-openclaw-runtime-snapshot.sh" "$SANITIZE_FIXTURE" >/dev/null
[ ! -e "$SANITIZE_FIXTURE/plugin-skills/browser-automation" ] \
    && [ ! -L "$SANITIZE_FIXTURE/plugin-skills/browser-automation" ] \
    || fail "reviewed transient browser skill link was not removed from the copied snapshot"
ln -s /tmp/unreviewed-target "$SANITIZE_FIXTURE/plugin-skills/browser-automation"
if bash "$PROJECT_DIR/scripts/sanitize-openclaw-runtime-snapshot.sh" "$SANITIZE_FIXTURE" >/dev/null 2>&1; then
    fail "snapshot sanitizer accepted an unexpected transient link target"
fi
[ -L "$SANITIZE_FIXTURE/plugin-skills/browser-automation" ] \
    || fail "snapshot sanitizer mutated the unexpected transient link target"
rm -f "$SANITIZE_FIXTURE/plugin-skills/browser-automation"
printf 'not-a-link\n' > "$SANITIZE_FIXTURE/plugin-skills/browser-automation"
if bash "$PROJECT_DIR/scripts/sanitize-openclaw-runtime-snapshot.sh" "$SANITIZE_FIXTURE" >/dev/null 2>&1; then
    fail "snapshot sanitizer accepted a regular file at the transient link path"
fi
rm -rf "$SANITIZE_FIXTURE"
pass "OpenClaw snapshot sanitizer removes only the exact reviewed transient browser skill link"

MODE_SELECTOR="$PROJECT_DIR/scripts/select-migration-rehearsal-mode.sh"
[ "$(bash "$MODE_SELECTOR" 0 0 0 0)" = 'forward-migration' ] \
    || fail "empty target ledger must select forward migration rehearsal"
[ "$(bash "$MODE_SELECTOR" 1 1 0 0)" = 'already-applied-noop' ] \
    || fail "one successful target ledger row must select no-op rehearsal"
for unsafe_state in '0 1 0 0' '1 0 1 0' '1 1 1 0' '1 0 0 1' '1 1 0 1' \
    '2 1 0 1' '2 2 0 0' 'x 0 0 0'; do
    read -r total successful unresolved rolled_back <<< "$unsafe_state"
    if bash "$MODE_SELECTOR" "$total" "$successful" "$unresolved" "$rolled_back" >/dev/null 2>&1; then
        fail "unsafe migration ledger state was accepted: $unsafe_state"
    fi
done
pass "migration rehearsal mode selector accepts only forward and exact already-applied states"
node --test "$PROJECT_DIR/scripts/canonicalize-pg-dump-data.test.mjs" >/dev/null \
    || fail "pg_dump COPY-row canonicalizer fixtures"
contains "$PROJECT_DIR/scripts/rehearse-db-migration.sh" 'canonicalize-pg-dump-data.mjs'
pass "migration data fingerprint ignores physical row order but preserves values and sequence state"
node - "$PROJECT_DIR/scripts/prepare-openclaw-runtime.sh" <<'NODE'
const fs = require("node:fs");
const { spawnSync } = require("node:child_process");
const file = process.argv[2];
const lines = fs.readFileSync(file, "utf8").split(/\r?\n/);
const payloads = [];
let current = null;
let startLine = 0;
let ceuCount = 0;
for (let index = 0; index < lines.length; index += 1) {
  const line = lines[index];
  const hasCeu = /(^|\s)-ceu(\s|$)/.test(line);
  if (hasCeu && !/-ceu '\s*$/.test(line)) {
    throw new Error(`unsupported -ceu quoting at ${file}:${index + 1}`);
  }
  if (current === null && hasCeu) {
    ceuCount += 1;
    current = [];
    startLine = index + 2;
    continue;
  }
  if (current !== null && hasCeu) {
    throw new Error(`nested -ceu payload at ${file}:${index + 1}`);
  }
  if (current !== null && /^\s*'\s*(?:sh\b.*)?$/.test(line)) {
    payloads.push({ startLine, source: current.join("\n") + "\n" });
    current = null;
    continue;
  }
  if (current !== null) {
    if (line.includes("'")) {
      throw new Error(`single quote inside outer single-quoted -ceu payload at ${file}:${index + 1}`);
    }
    current.push(line);
  }
}
if (current !== null) throw new Error(`unterminated -ceu payload starting at ${file}:${startLine}`);
if (ceuCount === 0 || payloads.length !== ceuCount) {
  throw new Error(`-ceu payload coverage mismatch in ${file}: calls=${ceuCount}, payloads=${payloads.length}`);
}
for (const payload of payloads) {
  const checked = spawnSync("sh", ["-n"], { input: payload.source, encoding: "utf8" });
  if (checked.status !== 0) {
    throw new Error(`invalid -ceu payload starting at ${file}:${payload.startLine}: ${checked.stderr.trim()}`);
  }
}
NODE
pass "all deployment scripts pass bash -n"

bash "$PROJECT_DIR/scripts/compose-container-lifecycle.test.sh" >/dev/null \
    || fail "compose lifecycle partial/missing/foreign/stop-race fixtures"
pass "compose lifecycle fail-closed fixtures pass"
bash "$PROJECT_DIR/scripts/openclaw-weixin-login.test.sh" >/dev/null \
    || fail "OpenClaw Weixin enrollment transaction fixtures"
pass "OpenClaw Weixin enrollment transaction fixtures pass"

node "$PROJECT_DIR/scripts/validate-release-manifest.mjs" >/dev/null \
    || fail "release manifest schema and release-tag semantic validation"
pass "release manifest satisfies bundled schema and release-tag semantics"

MANIFEST_TMP="$(mktemp "${TMPDIR:-/tmp}/task109-manifest-linux-tag-XXXXXX.json")"
node - "$PROJECT_DIR/release-manifest.json" "$MANIFEST_TMP" <<'NODE'
const fs = require('fs');
const source = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const currentTag = source.source.releaseTag;
const linuxTag = currentTag.replace('vaysen-crm-lan-source-', 'vaysen-crm-lan-');
source.source.releaseTag = linuxTag;
source.source.buildRevisionNote = source.source.buildRevisionNote.split(currentTag).join(linuxTag);
fs.writeFileSync(process.argv[3], JSON.stringify(source));
NODE
node "$PROJECT_DIR/scripts/validate-release-manifest.mjs" --manifest "$MANIFEST_TMP" >/dev/null \
    || { rm -f "$MANIFEST_TMP"; fail "Linux release-tag form failed manifest validation"; }
rm -f "$MANIFEST_TMP"
pass "release manifest validator accepts the corresponding immutable Linux tag form"

node "$PROJECT_DIR/scripts/validate-openclaw-production.mjs" >/dev/null \
    || fail "OpenClaw production boundary validation"
not_contains "$PROJECT_DIR/scripts/validate-openclaw-production.mjs" "from 'js-yaml'"
contains "$PROJECT_DIR/.gitattributes" 'deploy/openclaw/** text eol=lf'
if git -C "$PROJECT_DIR" ls-files --eol -- deploy/openclaw \
    | grep -Eq '(^|[[:space:]])(i|w)/crlf([[:space:]]|$)'; then
    fail "OpenClaw supply-chain inputs must be LF in both the Git index and working tree"
fi
pass "OpenClaw supply-chain inputs are protected from CRLF drift"
OPENCLAW_CONTRACT_TESTS=(
    "$PROJECT_DIR/deploy/openclaw/plugins/vaysen-crm/test/runtime.test.mjs"
    "$PROJECT_DIR/scripts/assert-no-published-host-ports.test.mjs"
    "$PROJECT_DIR/scripts/openclaw-runtime-probe.test.mjs"
    "$PROJECT_DIR/scripts/validate-openclaw-production.test.mjs"
)
if node -e "import('node:sqlite')" >/dev/null 2>&1; then
    OPENCLAW_CONTRACT_TESTS+=("$PROJECT_DIR/deploy/openclaw/plugins/vaysen-crm/test/audit-managed-install.test.mjs")
    OPENCLAW_CONTRACT_TESTS+=("$PROJECT_DIR/scripts/runtime-link-contract.test.mjs")
else
    printf '[SKIP] local Node lacks node:sqlite; managed-install SQLite tests run in the reviewed OpenClaw runtime\n'
fi
node --test "${OPENCLAW_CONTRACT_TESTS[@]}" >/dev/null \
    || fail "OpenClaw static, broker, and real RPC fixture tests"
pass "OpenClaw isolation, signed broker, and 2026.7.1 RPC contracts pass"

MANIFEST_TMP="$(mktemp "${TMPDIR:-/tmp}/task109-manifest-XXXXXX.json")"
node - "$PROJECT_DIR/release-manifest.json" "$MANIFEST_TMP" <<'NODE'
const fs = require('fs');
const source = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
source.unexpectedReleaseField = true;
fs.writeFileSync(process.argv[3], JSON.stringify(source));
NODE
if node "$PROJECT_DIR/scripts/validate-release-manifest.mjs" --manifest "$MANIFEST_TMP" >/dev/null 2>&1; then
    rm -f "$MANIFEST_TMP"
    fail "manifest validator must reject unexpected properties"
fi
rm -f "$MANIFEST_TMP"
pass "release manifest validator rejects an invalid negative fixture"

MANIFEST_TMP="$(mktemp "${TMPDIR:-/tmp}/task109-manifest-semantic-XXXXXX.json")"
node - "$PROJECT_DIR/release-manifest.json" "$MANIFEST_TMP" <<'NODE'
const fs = require('fs');
const source = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
source.dockerImages.buildExample = source.dockerImages.buildExample.replace(
  /RELEASE_TAG=vaysen-crm-lan-v\d+\.\d+\.\d+-r\d+/,
  'RELEASE_TAG=vaysen-crm-lan-v0.0.0-r0',
);
fs.writeFileSync(process.argv[3], JSON.stringify(source));
NODE
if node "$PROJECT_DIR/scripts/validate-release-manifest.mjs" --manifest "$MANIFEST_TMP" >/dev/null 2>&1; then
    rm -f "$MANIFEST_TMP"
    fail "manifest validator must reject a stale or mismatched Linux release command"
fi
rm -f "$MANIFEST_TMP"
pass "release manifest validator rejects stale cross-revision deployment instructions"

node - "$PROJECT_DIR/release-manifest.json" "$PROJECT_DIR/scripts/validate-release-manifest.mjs" <<'NODE'
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const manifestPath = process.argv[2];
const validatorPath = process.argv[3];
const base = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vaysen-crm-manifest-semantics-'));
const validate = (name, mutate, shouldPass = false) => {
  const fixture = structuredClone(base);
  mutate(fixture);
  const file = path.join(tmp, `${name}.json`);
  fs.writeFileSync(file, JSON.stringify(fixture));
  const result = spawnSync(process.execPath, [validatorPath, '--manifest', file], { encoding: 'utf8' });
  if ((result.status === 0) !== shouldPass) {
    throw new Error(`${name}: expected ${shouldPass ? 'PASS' : 'FAIL'}, got ${result.status}\n${result.stderr}`);
  }
};
try {
  validate('duplicate-release-tag', (fixture) => {
    const stale = 'vaysen-crm-lan-v0.0.0-r0';
    fixture.dockerImages.buildExample = fixture.dockerImages.buildExample.replace(
      /\sbash deploy\.sh$/,
      ` RELEASE_TAG=${stale} bash deploy.sh`,
    );
  });
  validate('revision-prefix-collision', (fixture) => {
    fixture.source.buildRevisionNote = fixture.source.buildRevisionNote.replace(
      fixture.source.releaseTag,
      `${fixture.source.releaseTag}0`,
    );
  });
  validate('unanchored-task', (fixture) => {
    fixture.task = fixture.task.replace(/^TASK-[A-Z0-9-]+-/, 'UNRELATED-');
  });
  validate('stale-formal-cutover', (fixture) => {
    fixture.database.note += ' R1 正式切换。';
  });
  validate('migration-count-drift', (fixture) => {
    fixture.database.migrationsCount += 1;
  });
  validate('migration-list-drift', (fixture) => {
    fixture.database.migrations = fixture.database.migrations.slice(0, -1);
    fixture.database.migrationsCount = fixture.database.migrations.length;
    fixture.database.latestMigration = fixture.database.migrations.at(-1);
  });
  validate('migration-order-drift', (fixture) => {
    fixture.database.migrations = [...fixture.database.migrations].reverse();
    fixture.database.latestMigration = fixture.database.migrations.at(-1);
  });
  validate('frozen-history-is-allowed', (fixture) => {
    fixture.gate.note += ' R1 已冻结，仅作历史记录。';
  }, true);
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}
NODE
pass "release manifest semantic gate rejects tag, current-doc, and migration-tree drift while allowing frozen history"

DOCS_TMP="$(mktemp -d "${TMPDIR:-/tmp}/vaysen-crm-current-release-docs-XXXXXX")"
mkdir -p "$DOCS_TMP/docs"
cp "$PROJECT_DIR/docs/LINUX_DEPLOYMENT.md" "$DOCS_TMP/docs/"
cp "$PROJECT_DIR/docs/TASK-116B-v1.4.20-OpenClaw微信发布验收.md" "$DOCS_TMP/docs/"
node - "$DOCS_TMP/docs/LINUX_DEPLOYMENT.md" <<'NODE'
const fs = require('fs');
const file = process.argv[2];
const source = fs.readFileSync(file, 'utf8');
const start = '<!-- TASK-116B CURRENT RELEASE START -->';
const end = '<!-- TASK-116B CURRENT RELEASE END -->';
const startIndex = source.indexOf(start) + start.length;
const endIndex = source.indexOf(end, startIndex);
const block = source.slice(startIndex, endIndex).replace(/v1\.4\.\d+-r\d+/g, 'v1.4.0-r1');
fs.writeFileSync(file, source.slice(0, startIndex) + block + source.slice(endIndex));
NODE
if node "$PROJECT_DIR/scripts/validate-release-manifest.mjs" --docs-root "$DOCS_TMP" >/dev/null 2>&1; then
    rm -rf "$DOCS_TMP"
    fail "current-release documentation block must reject a stale executable revision"
fi
rm -rf "$DOCS_TMP"
pass "release manifest gate rejects stale current commands in deployment documentation"

RESOLVER_TMP="$(mktemp -d "${TMPDIR:-/tmp}/vaysen-crm-resolver-XXXXXX")"
mkdir -p "$RESOLVER_TMP/scripts"
cp "$PROJECT_DIR/scripts/resolve-release-revision.mjs" "$RESOLVER_TMP/scripts/"
git -C "$RESOLVER_TMP" init -q
git -C "$RESOLVER_TMP" config user.name 'Vaysen AI CRM Contract Test'
git -C "$RESOLVER_TMP" config user.email 'contract-test@localhost'
printf 'fixture\n' > "$RESOLVER_TMP/content.txt"
git -C "$RESOLVER_TMP" add content.txt
git -C "$RESOLVER_TMP" commit -qm 'fixture'
resolver_content_commit="$(git -C "$RESOLVER_TMP" rev-parse HEAD)"
git -C "$RESOLVER_TMP" tag -a resolver-annotated-v1 -m 'annotated fixture'
git -C "$RESOLVER_TMP" tag resolver-lightweight-v1
node - "$RESOLVER_TMP/release-manifest.json" "$resolver_content_commit" <<'NODE'
const fs = require('fs');
fs.writeFileSync(process.argv[2], JSON.stringify({
  source: { contentCommit: process.argv[3], releaseTag: 'resolver-annotated-v1' },
}) + '\n');
NODE
node "$RESOLVER_TMP/scripts/resolve-release-revision.mjs" --check >/dev/null \
    || fail "resolver must accept an annotated refs/tags release anchor"
for invalid_tag in HEAD master resolver-lightweight-v1 'refs/tags/resolver-annotated-v1'; do
    if node "$RESOLVER_TMP/scripts/resolve-release-revision.mjs" --check --tag "$invalid_tag" >/dev/null 2>&1; then
        rm -rf -- "$RESOLVER_TMP"
        fail "resolver must reject non-annotated or ref-injection release input: $invalid_tag"
    fi
done
rm -rf -- "$RESOLVER_TMP"
pass "release resolver accepts only safe annotated refs/tags anchors"

ENV_TMP="$(mktemp "${TMPDIR:-/tmp}/vaysen-crm-env-XXXXXX")"
cat > "$ENV_TMP" <<'EOF'
DB_PASSWORD=correct-horse-battery-staple
JWT_SECRET=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
JWT_REFRESH_SECRET=bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb
EMAIL_ENCRYPTION_KEY=cccccccccccccccccccccccccccccccc
N8N_ENCRYPTION_KEY=dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd
ZHIPU_API_KEY=contract-validation-key-abcdefghij
LAN_BIND_IP=127.0.0.1
APPROVED_LAN_BIND_IP=127.0.0.1
LOCAL_LAN_BIND_IP=127.0.0.1
APPROVED_LOCAL_LAN_BIND_IP=127.0.0.1
FRONTEND_URL=http://127.0.0.1
API_BASE_URL=http://127.0.0.1/api
CORS_ORIGIN=http://127.0.0.1,http://127.0.0.1
NEXT_PUBLIC_API_URL=/api
APP_DATA_DIR=/var/lib/vaysen-crm/data
ENABLE_SWAGGER=false
EMAIL_SEND_DISABLED=true
WHATSAPP_RESTORE_SESSIONS=true
DEEP_RESEARCH_RECONCILE_ENABLED=true
EMAIL_SEED_TEST_ENABLED=false
EMAIL_SEED_TEST_ADDRESS=
EMAIL_SEED_TEST_APPROVED_ADDRESSES=
EMAIL_SEED_TEST_INTERVAL=100
EVOLUTION_API_ENABLED=false
NODE_IMAGE=node@sha256:0000000000000000000000000000000000000000000000000000000000000000
PYTHON_IMAGE=python@sha256:0000000000000000000000000000000000000000000000000000000000000000
POSTGRES_IMAGE=postgres@sha256:0000000000000000000000000000000000000000000000000000000000000000
REDIS_IMAGE=redis@sha256:0000000000000000000000000000000000000000000000000000000000000000
NGINX_IMAGE=nginx@sha256:0000000000000000000000000000000000000000000000000000000000000000
REACHER_IMAGE=reacher@sha256:0000000000000000000000000000000000000000000000000000000000000000
SEARXNG_IMAGE=searxng@sha256:0000000000000000000000000000000000000000000000000000000000000000
N8N_IMAGE=n8n@sha256:0000000000000000000000000000000000000000000000000000000000000000
OPENCLAW_ENABLED=true
OPENCLAW_RUNTIME_VERSION=2026.7.1
OPENCLAW_WEIXIN_PLUGIN_VERSION=2.4.6
OPENCLAW_DATA_UID=1000
OPENCLAW_DATA_GID=1000
OPENCLAW_GATEWAY_TOKEN=eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee
OPENCLAW_CRM_HMAC_KEY_ID=vaysen-openclaw-v1
OPENCLAW_CRM_HMAC_SECRET=ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff
OPENCLAW_OWNER_EMAIL=admin@example.com
OPENCLAW_OWNER_COMPANY_SLUG=example-trading-company
OPENCLAW_WECHAT_OWNER_PEER_SHA256=
OPENCLAW_IMAGE=ghcr.io/openclaw/openclaw@sha256:6a31d44b2944e7adcd2b582bf6fb463111264ebca97a0201795b799135bd102c
EOF
node "$PROJECT_DIR/scripts/validate-production-env.mjs" "$ENV_TMP" >/dev/null \
    || fail "secure production environment fixture should pass"
sed 's/^JWT_REFRESH_SECRET=.*/JWT_REFRESH_SECRET=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/' "$ENV_TMP" > "$ENV_TMP.bad"
if node "$PROJECT_DIR/scripts/validate-production-env.mjs" "$ENV_TMP.bad" >/dev/null 2>&1; then
    rm -f "$ENV_TMP" "$ENV_TMP.bad"
    fail "equal JWT secrets must fail production environment validation"
fi
sed 's/^OPENCLAW_GATEWAY_TOKEN=.*/OPENCLAW_GATEWAY_TOKEN=correct-horse-battery-staple/' "$ENV_TMP" > "$ENV_TMP.bad"
if node "$PROJECT_DIR/scripts/validate-production-env.mjs" "$ENV_TMP.bad" >/dev/null 2>&1; then
    rm -f "$ENV_TMP" "$ENV_TMP.bad"
    fail "OpenClaw gateway token reused as DB password must fail production environment validation"
fi
sed 's/^EMAIL_ENCRYPTION_KEY=.*/EMAIL_ENCRYPTION_KEY=ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff/' "$ENV_TMP" > "$ENV_TMP.bad"
if node "$PROJECT_DIR/scripts/validate-production-env.mjs" "$ENV_TMP.bad" >/dev/null 2>&1; then
    rm -f "$ENV_TMP" "$ENV_TMP.bad"
    fail "OpenClaw HMAC secret reused as email encryption key must fail production environment validation"
fi
rm -f "$ENV_TMP" "$ENV_TMP.bad"
pass "production environment validator accepts secure LAN config and rejects reused production secrets"

backup_line="$(line_of "$PROJECT_DIR/deploy.sh" 'db-preflight.sh --backup')"
build_line="$(line_of "$PROJECT_DIR/deploy.sh" 'IMAGE_REUSE_SOURCE_TAG="${IMAGE_REUSE_SOURCE_TAG:-}"')"
rehearsal_line="$(line_of "$PROJECT_DIR/deploy.sh" 'rehearse-db-migration.sh')"
candidate_line="$(line_of "$PROJECT_DIR/deploy.sh" 'db-preflight.sh --candidate')"
[ "$backup_line" -lt "$build_line" ] && [ "$build_line" -lt "$rehearsal_line" ] \
    && [ "$rehearsal_line" -lt "$candidate_line" ] \
    || fail "deploy order must be backup -> build -> isolated rehearsal -> candidate migration check"
writer_free_boundary_line="$(line_of "$PROJECT_DIR/deploy.sh" 'compose_lifecycle_establish_writer_free_boundary "$COMPOSE_PROJECT_NAME"')"
inventory_line="$(line_of "$PROJECT_DIR/deploy.sh" 'compose_lifecycle_discover_vaysen-crm "$COMPOSE_PROJECT_NAME" true')"
cutover_pending_line="$(line_of "$PROJECT_DIR/deploy.sh" 'CUTOVER_PENDING=1')"
openclaw_probe_line="$(line_of "$PROJECT_DIR/deploy.sh" 'isolated OpenClaw preparation passed before production stop')"
runtime_backup_line="$(line_of "$PROJECT_DIR/deploy.sh" 'RUNTIME_OUTPUT="$(BACKUP_DIR=')"
runtime_prepare_line="$(line_of "$PROJECT_DIR/deploy.sh" 'bash scripts/prepare-runtime-data.sh "$RUNTIME_BACKUP"')"
[ "$rehearsal_line" -lt "$writer_free_boundary_line" ] \
    || fail "isolated migration rehearsal must finish before the current application is stopped"
[ "$openclaw_probe_line" -lt "$writer_free_boundary_line" ] \
    || fail "complete isolated OpenClaw preparation must pass before the current application is stopped"
[ "$inventory_line" -lt "$writer_free_boundary_line" ] \
    || fail "immutable application inventory must be captured before entering the writer-free boundary"
[ "$writer_free_boundary_line" -lt "$cutover_pending_line" ] \
    && [ "$cutover_pending_line" -lt "$runtime_backup_line" ] \
    && [ "$runtime_backup_line" -lt "$runtime_prepare_line" ] \
    || fail "runtime migration order must be writer-free boundary -> recovery-safe flag -> verified container backup -> host initialization"
pass "deployment enforces backup, isolated migration rehearsal, and candidate preflight order"

contains "$PROJECT_DIR/deploy.sh" 'deploy-security-preflight.sh'
contains "$PROJECT_DIR/deploy.sh" 'node "$MANIFEST_VALIDATOR" || fail "release manifest schema validation failed"'
contains "$PROJECT_DIR/deploy.sh" 'RELEASE_TAG is required'
contains "$PROJECT_DIR/deploy.sh" 'PREVIOUS_RELEASE_TAG is required'
contains "$PROJECT_DIR/deploy.sh" 'PREVIOUS_TAG="$PREVIOUS_RELEASE_TAG"'
contains "$PROJECT_DIR/deploy.sh" 'previous rollback anchor is not an ancestor of the candidate release'
contains "$PROJECT_DIR/scripts/verify-baseline.mjs" "'--workspaces=false'"
contains "$PROJECT_DIR/scripts/verify-baseline.mjs" 'frontend: isolated package-lock (npm ci --dry-run)'
contains "$PROJECT_DIR/scripts/verify-baseline.mjs" "npmRun('backend: test (jest)', cwd, 'test', ['--', '--runInBand'])"
contains "$PROJECT_DIR/deploy.sh" 'host Node.js must be exactly 20.18.0'
contains "$PROJECT_DIR/deploy.sh" 'must be a real Git worktree'
contains "$PROJECT_DIR/deploy.sh" 'does not match release tag commit'
contains "$PROJECT_DIR/deploy.sh" 'Git worktree is dirty'
contains "$PROJECT_DIR/deploy.sh" 'bash scripts/reuse-release-images.sh'
contains "$PROJECT_DIR/deploy.sh" 'candidate image reuse failed closed'
contains "$PROJECT_DIR/scripts/reuse-release-images.sh" 'IMAGE_CONTEXT_PATHS=(backend frontend python-service)'
contains "$PROJECT_DIR/scripts/reuse-release-images.sh" 'self-built image contexts differ; a normal full image build is required'
contains "$PROJECT_DIR/scripts/reuse-release-images.sh" 'merge-base --is-ancestor "$SOURCE_COMMIT" "$RELEASE_COMMIT"'
contains "$PROJECT_DIR/scripts/reuse-release-images.sh" 'source image revision mismatch'
contains "$PROJECT_DIR/scripts/reuse-release-images.sh" 'docker build --pull=false --network=none'
contains "$PROJECT_DIR/scripts/reuse-release-images.sh" 'backend BUILD_REVISION mismatch'
contains "$PROJECT_DIR/deploy.sh" 'automatic_rollback_on_failure'
contains "$PROJECT_DIR/deploy.sh" 'compose_lifecycle_establish_writer_free_boundary "$COMPOSE_PROJECT_NAME"'
contains "$PROJECT_DIR/deploy.sh" 'A boundary failure deliberately'
contains "$PROJECT_DIR/deploy.sh" '--runtime-backup "$RUNTIME_BACKUP" --rev "$PREVIOUS_TAG"'
contains "$PROJECT_DIR/deploy.sh" 'rollback.sh --check-app --rev "$PREVIOUS_TAG"'
contains "$PROJECT_DIR/deploy.sh" 'rollback.sh --check --rev "$PREVIOUS_TAG"'
contains "$PROJECT_DIR/deploy.sh" 'APP_DATA_UID must be a positive numeric container uid'
contains "$PROJECT_DIR/scripts/db-preflight.sh" '-e RUN_MIGRATIONS=false -e RUN_SEED=false'
contains "$PROJECT_DIR/scripts/db-preflight.sh" '--pull never'
contains "$PROJECT_DIR/scripts/db-preflight.sh" 'candidate image is missing'
contains "$PROJECT_DIR/scripts/db-preflight.sh" 'RELEASE_COMMIT is required for candidate preflight ownership'
contains "$PROJECT_DIR/scripts/db-preflight.sh" 'CANDIDATE_PRISMA_STATUS_TIMEOUT_SECONDS must be between 1 and 120'
contains "$PROJECT_DIR/scripts/db-preflight.sh" 'timeout --signal=TERM --kill-after=10s "${CANDIDATE_PRISMA_STATUS_TIMEOUT_SECONDS}s"'
contains "$PROJECT_DIR/scripts/db-preflight.sh" '--name "$CANDIDATE_STATUS_CONTAINER"'
contains "$PROJECT_DIR/scripts/db-preflight.sh" '--label "$CANDIDATE_STATUS_LABEL=$RELEASE_COMMIT"'
contains "$PROJECT_DIR/scripts/db-preflight.sh" 'refusing to remove an unowned candidate Prisma status container'
candidate_status_owner_line="$(line_of "$PROJECT_DIR/scripts/db-preflight.sh" 'if [ "$owner_label" != "$RELEASE_COMMIT" ]')"
candidate_status_remove_line="$(line_of "$PROJECT_DIR/scripts/db-preflight.sh" 'docker rm -f "$CANDIDATE_STATUS_CONTAINER"')"
[ "$candidate_status_owner_line" -lt "$candidate_status_remove_line" ] \
    || fail "candidate Prisma status residue must be release-label verified before removal"
contains "$PROJECT_DIR/scripts/rehearse-db-migration.sh" '--confirm-isolated-rehearsal'
contains "$PROJECT_DIR/scripts/rehearse-db-migration.sh" 'REHEARSAL_MODE="$(bash "$MODE_SELECTOR"'
contains "$PROJECT_DIR/scripts/rehearse-db-migration.sh" 'GLOBAL_UNRESOLVED_COUNT'
contains "$PROJECT_DIR/scripts/rehearse-db-migration.sh" '/app/node_modules/.bin/prisma migrate status'
contains "$PROJECT_DIR/scripts/rehearse-db-migration.sh" "rehearsalMode=\$REHEARSAL_MODE"
contains "$PROJECT_DIR/scripts/rehearse-db-migration.sh" 'databaseStateUnchanged=passed'
contains "$PROJECT_DIR/scripts/rehearse-db-migration.sh" 'migration_lock.toml'
contains "$PROJECT_DIR/scripts/rehearse-db-migration.sh" 'data_fingerprint()'
contains "$PROJECT_DIR/scripts/rehearse-db-migration.sh" 'baselineDataSha256='
contains "$PROJECT_DIR/scripts/rehearse-db-migration.sh" 'secondNoopDataSha256='
contains "$PROJECT_DIR/scripts/rehearse-db-migration.sh" "<<'SQL' || return 1"
contains "$PROJECT_DIR/scripts/rehearse-db-migration.sh" '|| return 1'
contains "$PROJECT_DIR/scripts/rehearse-db-migration.sh" 'first no-op candidate deploy changed the disposable database'
contains "$PROJECT_DIR/scripts/rehearse-db-migration.sh" 'second candidate deploy did not prove no-op idempotency'
contains "$PROJECT_DIR/scripts/rehearse-db-migration.sh" 'production rollback primitive did not reproduce the no-op backup exactly'
contains "$PROJECT_DIR/scripts/deploy-security-preflight.sh" 'scripts/select-migration-rehearsal-mode.sh'
contains "$PROJECT_DIR/scripts/rehearse-db-migration.sh" 'docker network create --internal'
contains "$PROJECT_DIR/scripts/rehearse-db-migration.sh" '--entrypoint /usr/bin/env "$CANDIDATE_IMAGE_ID"'
contains "$PROJECT_DIR/scripts/rehearse-db-migration.sh" 'productionDatabaseOrVolumeTouched=false'
contains "$PROJECT_DIR/scripts/rehearse-db-migration.sh" 'simulated first connection failure was observed'
contains "$PROJECT_DIR/scripts/rehearse-db-migration.sh" 'second candidate prisma deploy failed'
contains "$PROJECT_DIR/scripts/rehearse-db-migration.sh" '20260718170000_owner_notification_outbox'
contains "$PROJECT_DIR/scripts/rehearse-db-migration.sh" '20260718193000_openclaw_lead_selection'
not_contains "$PROJECT_DIR/scripts/rehearse-db-migration.sh" 'TARGET_MIGRATION="20260714210000_openclaw_gateway_integration"'
contains "$PROJECT_DIR/scripts/rehearse-db-migration.sh" 'TARGET_MIGRATION="20260719211500_backfill_verified_direct_whatsapp_group_status"'
contains "$PROJECT_DIR/scripts/rehearse-db-migration.sh" 'rehearsal_reject_verified_direct_backfill'
contains "$PROJECT_DIR/scripts/rehearse-db-migration.sh" 'verified-direct WhatsApp backfill changed rows outside the reviewed identity boundary'
contains "$PROJECT_DIR/scripts/rehearse-db-migration.sh" 'OwnerNotificationOutbox'
contains "$PROJECT_DIR/scripts/rehearse-db-migration.sh" 'OpenClawSelectionToken'
contains "$PROJECT_DIR/scripts/rehearse-db-migration.sh" 'disposableResourcesCleaned=passed'
contains "$PROJECT_DIR/scripts/rehearse-db-migration.sh" '--source-database-bytes'
contains "$PROJECT_DIR/scripts/rehearse-db-migration.sh" '--data-root'
contains "$PROJECT_DIR/scripts/rehearse-db-migration.sh" '--memory 4g --memory-swap 4g --cpus 2 --pids-limit 256 --blkio-weight 100'
contains "$PROJECT_DIR/scripts/rehearse-db-migration.sh" '--memory 2g --memory-swap 2g --cpus 1.5 --pids-limit 192 --blkio-weight 100'
contains "$PROJECT_DIR/scripts/rehearse-db-migration.sh" '--log-driver local --log-opt max-size=10m --log-opt max-file=2'
not_contains "$PROJECT_DIR/scripts/rehearse-db-migration.sh" '--log-opt max-file=1'
contains "$PROJECT_DIR/scripts/rehearse-db-migration.sh" '--log-driver none'
contains "$PROJECT_DIR/scripts/rehearse-db-migration.sh" '--cap-drop ALL --cap-add DAC_OVERRIDE --security-opt no-new-privileges'
contains "$PROJECT_DIR/scripts/rehearse-db-migration.sh" 'PG_CLIENT_ENV="PGHOST=127.0.0.1"'
contains "$PROJECT_DIR/scripts/rehearse-db-migration.sh" 'docker exec --user 0 -e "$PG_CLIENT_ENV" "$POSTGRES_CONTAINER" pg_restore'
contains "$PROJECT_DIR/scripts/rehearse-db-migration.sh" 'docker exec -i -e "$PG_CLIENT_ENV" "$POSTGRES_CONTAINER" psql'
not_contains "$PROJECT_DIR/scripts/rehearse-db-migration.sh" 'if docker exec "$POSTGRES_CONTAINER" pg_isready'
contains "$PROJECT_DIR/scripts/rehearse-db-migration.sh" 'current transaction is aborted'
contains "$PROJECT_DIR/scripts/rehearse-db-migration.sh" "'OwnerNotificationStatus'"
contains "$PROJECT_DIR/scripts/rehearse-db-migration.sh" "'OwnerNotificationOutbox_companyId_fkey'"
contains "$PROJECT_DIR/scripts/rehearse-db-migration.sh" "'OpenClawSelectionToken_companyId_leadId_expiresAt_idx'"
contains "$PROJECT_DIR/scripts/rehearse-db-migration.sh" 'array_length(expected_foreign_keys, 1)'
not_contains "$PROJECT_DIR/scripts/rehearse-db-migration.sh" 'foreign-key count is not 7'
contains "$PROJECT_DIR/scripts/rehearse-db-migration.sh" 'storage reserve guard'
contains "$PROJECT_DIR/scripts/rehearse-db-migration.sh" 'firstPrismaDeploySeconds='
contains "$PROJECT_DIR/scripts/rehearse-db-migration.sh" 'maximumAllowedPrismaDeploySeconds='
contains "$PROJECT_DIR/scripts/rehearse-db-migration.sh" 'FIRST_DEPLOY_SECONDS" -le "$MAX_DEPLOY_SECONDS'
contains "$PROJECT_DIR/scripts/rehearse-db-migration.sh" '/app/node_modules/.bin/prisma migrate resolve --rolled-back'
contains "$PROJECT_DIR/scripts/rehearse-db-migration.sh" 'mode=1777'
contains "$PROJECT_DIR/scripts/rehearse-db-migration.sh" 'maximumAllowedBackupRestoreSeconds='
contains "$PROJECT_DIR/scripts/rehearse-db-migration.sh" 'forwardMigrationRollback=passed'
contains "$PROJECT_DIR/scripts/rehearse-db-migration.sh" 'rollbackMigrationLedgerSha256='
contains "$PROJECT_DIR/scripts/rehearse-db-migration.sh" 'scripts/recreate-db-from-backup.sh'
contains "$PROJECT_DIR/scripts/recreate-db-from-backup.sh" 'DROP DATABASE IF EXISTS %I WITH (FORCE)'
contains "$PROJECT_DIR/scripts/recreate-db-from-backup.sh" 'CREATE DATABASE %I WITH OWNER %I TEMPLATE template0'
contains "$PROJECT_DIR/scripts/recreate-db-from-backup.sh" '--single-transaction'
contains "$PROJECT_DIR/scripts/recreate-db-from-backup.sh" 'timeout --signal=TERM --kill-after=30s'
contains "$PROJECT_DIR/scripts/recreate-db-from-backup.sh" "requested database user does not match the PostgreSQL container launch contract"
contains "$PROJECT_DIR/scripts/recreate-db-from-backup.sh" "requested database name does not match the PostgreSQL container launch contract"
contains "$PROJECT_DIR/scripts/recreate-db-from-backup.sh" 'docker stop --time 10 "$POSTGRES_CONTAINER"'
contains "$PROJECT_DIR/scripts/recreate-db-from-backup.sh" "docker inspect --format '{{.State.Running}}'"
contains "$PROJECT_DIR/scripts/recreate-db-from-backup.sh" "[ \"\$POSTGRES_RUNNING\" = 'false' ]"
contains "$PROJECT_DIR/scripts/rollback.sh" 'recreate-db-from-backup.sh'
contains "$PROJECT_DIR/scripts/restore-db.sh" 'recreate-db-from-backup.sh'
contains "$PROJECT_DIR/scripts/rollback.sh" 'application remains stopped'
contains "$PROJECT_DIR/scripts/restore-db.sh" 'application remains stopped'
if grep -Fq -- '--clean --if-exists --no-owner -1' "$PROJECT_DIR/scripts/rollback.sh" "$PROJECT_DIR/scripts/restore-db.sh"; then
    fail "rollback and manual restore must recreate an empty database instead of relying on pg_restore --clean"
fi
if grep -Eq 'vaysen-crm-postgres|postgres_data|docker-compose\.prod|--network[[:space:]]+vaysen-crm' \
    "$PROJECT_DIR/scripts/rehearse-db-migration.sh"; then
    fail "migration rehearsal must not address production containers, volumes, Compose, or networks"
fi
contains "$PROJECT_DIR/deploy.sh" 'candidate image revision label mismatch'
contains "$PROJECT_DIR/deploy.sh" '--postgres-image "$POSTGRES_IMAGE"'
contains "$PROJECT_DIR/deploy.sh" '--candidate-image "vaysen-crm-backend:$RELEASE_COMMIT_SHORT"'
contains "$PROJECT_DIR/deploy.sh" '--expected-revision "$RELEASE_COMMIT"'
contains "$PROJECT_DIR/deploy.sh" '--source-database-bytes "$SOURCE_DATABASE_BYTES"'
contains "$PROJECT_DIR/deploy.sh" '--data-root "$MIGRATION_REHEARSAL_DATA_ROOT"'
contains "$PROJECT_DIR/deploy.sh" 'SELECT pg_database_size(current_database())'
contains "$PROJECT_DIR/deploy.sh" '--confirm-isolated-rehearsal'
contains "$PROJECT_DIR/deploy.sh" 'down --remove-orphans --volumes'
contains "$PROJECT_DIR/deploy.sh" 'docker compose up --help'
contains "$PROJECT_DIR/deploy.sh" "'--wait-timeout'"
contains "$PROJECT_DIR/deploy.sh" 'timeout --signal=TERM --kill-after=30s "${PRODUCTION_MIGRATION_TIMEOUT_SECONDS}s"'
contains "$PROJECT_DIR/deploy.sh" 'backend npm run prisma:deploy'
contains "$PROJECT_DIR/deploy.sh" 'curl is required for published health recovery checks'
contains "$PROJECT_DIR/deploy.sh" 'wait_current_backend_recovery'
contains "$PROJECT_DIR/deploy.sh" 'wait_current_published_health_recovery'
contains "$PROJECT_DIR/deploy.sh" "health=\"\$(docker container inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{end}}' vaysen-crm-backend"
contains "$PROJECT_DIR/deploy.sh" "curl --noproxy '*' --silent --show-error --max-time 5"
contains "$PROJECT_DIR/deploy.sh" "if [ \"\$status_code\" = '200' ]"
contains "$PROJECT_DIR/deploy.sh" 'pre-cutover recovery did not restore a verified production service'
not_contains "$PROJECT_DIR/deploy.sh" 'docker start "${CURRENT_APP_CONTAINERS[@]}" >/dev/null || true'
recovery_start_line="$(line_of "$PROJECT_DIR/deploy.sh" 'if ! compose_lifecycle_start_all; then')"
recovery_backend_line="$(line_of "$PROJECT_DIR/deploy.sh" 'wait_current_backend_recovery || recovery_failed=1')"
recovery_published_line="$(line_of "$PROJECT_DIR/deploy.sh" 'wait_current_published_health_recovery || recovery_failed=1')"
[ "$recovery_start_line" -lt "$recovery_backend_line" ] \
    && [ "$recovery_backend_line" -lt "$recovery_published_line" ] \
    || fail "pre-cutover recovery must start old containers, then verify backend and published health"
compose_feature_probe_line="$(line_of "$PROJECT_DIR/deploy.sh" 'docker compose up --help')"
[ "$compose_feature_probe_line" -lt "$writer_free_boundary_line" ] \
    || fail "Compose wait feature support must be proven before stopping the current application"
stale_migration_check_line="$(line_of "$PROJECT_DIR/deploy.sh" 'stale or foreign production migration container already exists')"
[ "$stale_migration_check_line" -lt "$inventory_line" ] \
    && [ "$inventory_line" -lt "$writer_free_boundary_line" ] \
    || fail "reserved production migration name must be clear before immutable inventory and the writer-free boundary"
production_migration_line="$(line_of "$PROJECT_DIR/deploy.sh" 'backend npm run prisma:deploy')"
backend_start_line="$(line_of "$PROJECT_DIR/deploy.sh" 'postgres redis python-service backend')"
all_services_start_line="$(line_of "$PROJECT_DIR/deploy.sh" 'compose up -d --no-build || fail "candidate startup failed"')"
[ "$production_migration_line" -lt "$backend_start_line" ] && [ "$backend_start_line" -lt "$all_services_start_line" ] \
    || fail "bounded one-off migration and backend health must complete before workers and OpenClaw start"
contains "$PROJECT_DIR/docker-compose.prod.yml" 'RELEASE_COMMIT must be an immutable full SHA'
contains "$PROJECT_DIR/scripts/deploy-smoke-test.sh" '镜像 revision 匹配'
nginx_compose_block="$(sed -n '/^  nginx:/,/^volumes:/p' "$PROJECT_DIR/docker-compose.prod.yml")"
printf '%s\n' "$nginx_compose_block" | grep -Fq 'org.opencontainers.image.revision: "${RELEASE_COMMIT:?RELEASE_COMMIT must be an immutable full SHA}"' \
    || fail "nginx service must vary with the immutable release revision to refresh Docker upstream DNS"
contains "$PROJECT_DIR/scripts/deploy-smoke-test.sh" 'nginx edge revision 匹配，Docker upstream DNS 已随候选刷新'
contains "$PROJECT_DIR/scripts/deploy-smoke-test.sh" "docker inspect -f '{{ index .Config.Labels \"org.opencontainers.image.revision\" }}' vaysen-crm-nginx"
contains "$PROJECT_DIR/nginx/conf.d/vaysen-crm-lan.conf" 'resolver 127.0.0.11 valid=10s ipv6=off;'
contains "$PROJECT_DIR/nginx/conf.d/vaysen-crm-lan.conf" 'server backend:4000 resolve;'
contains "$PROJECT_DIR/nginx/conf.d/vaysen-crm-lan.conf" 'server frontend:3000 resolve;'
contains "$PROJECT_DIR/nginx/conf.d/vaysen-crm-lan.conf" 'proxy_pass http://vaysen-crm_backend_upstream/api/;'
contains "$PROJECT_DIR/nginx/conf.d/vaysen-crm-lan.conf" 'proxy_pass http://vaysen-crm_frontend_upstream;'
not_contains "$PROJECT_DIR/nginx/conf.d/vaysen-crm-lan.conf" 'proxy_pass http://backend:4000'
not_contains "$PROJECT_DIR/nginx/conf.d/vaysen-crm-lan.conf" 'proxy_pass http://frontend:3000'
if grep -Fq -- '--no-build' "$PROJECT_DIR/scripts/db-preflight.sh"; then
    fail "db candidate preflight must not use the unsupported compose run --no-build flag"
fi
for required_env in DB_PASSWORD API_BASE_URL NEXT_PUBLIC_API_URL LAN_BIND_IP APPROVED_LAN_BIND_IP \
    LOCAL_LAN_BIND_IP APPROVED_LOCAL_LAN_BIND_IP \
    APP_DATA_DIR MIGRATION_REHEARSAL_DATA_ROOT MIGRATION_REHEARSAL_MAX_SECONDS MIGRATION_REHEARSAL_MAX_RESTORE_SECONDS \
    PRODUCTION_MIGRATION_TIMEOUT_SECONDS N8N_ENCRYPTION_KEY NODE_IMAGE PYTHON_IMAGE POSTGRES_IMAGE REDIS_IMAGE \
    NGINX_IMAGE REACHER_IMAGE SEARXNG_IMAGE N8N_IMAGE OPENCLAW_ENABLED OPENCLAW_RUNTIME_VERSION \
    OPENCLAW_WEIXIN_PLUGIN_VERSION OPENCLAW_DATA_UID OPENCLAW_DATA_GID OPENCLAW_GATEWAY_TOKEN \
    OPENCLAW_CRM_HMAC_KEY_ID OPENCLAW_CRM_HMAC_SECRET OPENCLAW_OWNER_EMAIL \
    OPENCLAW_OWNER_COMPANY_SLUG OPENCLAW_WECHAT_OWNER_PEER_SHA256 OPENCLAW_IMAGE; do
    grep -Eq "^${required_env}=" "$PROJECT_DIR/.env.example" \
        || fail ".env.example missing production variable: $required_env"
done
contains "$PROJECT_DIR/scripts/backup-db.sh" 'docker exec -i "$CONTAINER_NAME" pg_restore -l'
contains "$PROJECT_DIR/scripts/backup-db.sh" 'backupFile='
contains "$PROJECT_DIR/scripts/backup-db.sh" '.database-backup.lock'
contains "$PROJECT_DIR/scripts/backup-db.sh" 'backupSha256='
contains "$PROJECT_DIR/scripts/verify-db-backup.sh" 'backup checksum mismatch'
contains "$PROJECT_DIR/scripts/backup-runtime-data.sh" 'runtimeBackup='
contains "$PROJECT_DIR/scripts/backup-runtime-data.sh" '--preflight'
contains "$PROJECT_DIR/scripts/backup-runtime-data.sh" 'SOURCE_KB * 3 + 524288'
contains "$PROJECT_DIR/scripts/backup-runtime-data.sh" 'backend container must be stopped before taking a consistent runtime backup'
contains "$PROJECT_DIR/scripts/backup-runtime-data.sh" '.runtime-backup.lock'
contains "$PROJECT_DIR/scripts/backup-runtime-data.sh" 'PUBLICATION_STARTED=1'
contains "$PROJECT_DIR/scripts/backup-runtime-data.sh" 'tar --hard-dereference'
contains "$PROJECT_DIR/scripts/backup-runtime-data.sh" 'created runtime archive failed the shared restore validation contract'
contains "$PROJECT_DIR/scripts/prepare-runtime-data.sh" '.initialized-v1'
contains "$PROJECT_DIR/scripts/prepare-runtime-data.sh" 'restore-runtime-data.sh" --check'
contains "$PROJECT_DIR/scripts/prepare-runtime-data.sh" 'runtime-initialize-transaction.sh:/usr/local/lib/vaysen-crm/runtime-initialize-transaction.sh:ro'
contains "$PROJECT_DIR/scripts/prepare-runtime-data.sh" 'run-runtime-link-contract.sh" verify-live-tree'
contains "$PROJECT_DIR/scripts/prepare-runtime-data.sh" '--cap-add DAC_OVERRIDE'
contains "$PROJECT_DIR/scripts/runtime-initialize-transaction.sh" '.prepare-new'
contains "$PROJECT_DIR/scripts/runtime-initialize-transaction.sh" 'run-runtime-link-contract.sh" verify-manifest'
contains "$PROJECT_DIR/scripts/runtime-initialize-transaction.sh" 'initialize committed sentinel'
contains "$PROJECT_DIR/scripts/restore-runtime-data.sh" 'must be stopped before restoring runtime data'
contains "$PROJECT_DIR/scripts/runtime-restore-transaction.sh" '.restore-transaction'
contains "$PROJECT_DIR/scripts/runtime-restore-transaction.sh" 'txn/committed'
contains "$PROJECT_DIR/scripts/runtime-restore-transaction.sh" 'refusing reverse rollback'
contains "$PROJECT_DIR/scripts/restore-runtime-data.sh" '--check'
contains "$PROJECT_DIR/scripts/restore-runtime-data.sh" 'normalized_entries='
contains "$PROJECT_DIR/scripts/restore-runtime-data.sh" 'runtime backup contains a non-canonical path'
contains "$PROJECT_DIR/scripts/restore-runtime-data.sh" 'TRANSACTION_REENTRY=1'
contains "$PROJECT_DIR/scripts/backup-runtime-data.sh" 'RUNTIME_PATHS+=(openclaw)'
contains "$PROJECT_DIR/scripts/backup-runtime-data.sh" 'sanitize-openclaw-runtime-snapshot.sh'
contains "$PROJECT_DIR/scripts/restore-runtime-data.sh" 'runtime-restore-transaction.sh:/usr/local/lib/vaysen-crm/runtime-restore-transaction.sh:ro'
contains "$PROJECT_DIR/scripts/restore-runtime-data.sh" 'runtime-link-manifest.sh:/usr/local/lib/vaysen-crm/runtime-link-manifest.sh:ro'
contains "$PROJECT_DIR/scripts/backup-runtime-data.sh" 'run-runtime-link-contract.sh" verify-tree'
contains "$PROJECT_DIR/scripts/runtime-link-manifest.sh" "RUNTIME_LINK_MANIFEST_V1='.vaysen-crm-runtime-links-v1'"
contains "$PROJECT_DIR/scripts/runtime-link-manifest.sh" "RUNTIME_LINK_MANIFEST_V2='.vaysen-crm-runtime-links-v2.json'"
contains "$PROJECT_DIR/scripts/runtime-link-manifest.sh" 'tencent-weixin-openclaw-weixin-7783ac86ba'
contains "$PROJECT_DIR/scripts/runtime-link-manifest.sh" 'vaysen-openclaw-crm-tools-f0ac731cd3'
contains "$PROJECT_DIR/scripts/backup-runtime-data.sh" 'run-runtime-link-contract.sh" emit-v2'
contains "$PROJECT_DIR/scripts/restore-runtime-data.sh" 'run-runtime-link-contract.sh" verify-manifest'
contains "$PROJECT_DIR/scripts/runtime-restore-transaction.sh" "recover_dirs=\"\$base_dirs openclaw\""
contains "$PROJECT_DIR/scripts/runtime-restore-transaction.sh" 'successful legacy rollback removes'
contains "$PROJECT_DIR/deploy.sh" 'compose_lifecycle_start_all'
contains "$PROJECT_DIR/scripts/rollback.sh" 'restart_current_app'
contains "$PROJECT_DIR/scripts/rollback.sh" 'ROLLBACK_TRUST_CHAIN=('
contains "$PROJECT_DIR/scripts/rollback.sh" 'validate-production-env.mjs'
contains "$PROJECT_DIR/scripts/rollback.sh" 'runtime-link-contract.mjs'
contains "$PROJECT_DIR/scripts/restore-db.sh" 'restart_current_app'
for lifecycle_consumer in deploy.sh scripts/rollback.sh scripts/restore-db.sh scripts/openclaw-weixin-login.sh; do
    contains "$PROJECT_DIR/$lifecycle_consumer" 'compose-container-lifecycle.sh'
    contains "$PROJECT_DIR/$lifecycle_consumer" 'compose_lifecycle_acquire_transaction_lock'
done
for lifecycle_consumer in deploy.sh scripts/rollback.sh scripts/restore-db.sh; do
    not_contains "$PROJECT_DIR/$lifecycle_consumer" 'docker stop "${CURRENT_APP_CONTAINERS[@]}"'
    not_contains "$PROJECT_DIR/$lifecycle_consumer" 'docker start "${CURRENT_APP_CONTAINERS[@]}"'
done
contains "$PROJECT_DIR/scripts/compose-container-lifecycle.sh" 'label=com.docker.compose.project=$project'
contains "$PROJECT_DIR/scripts/compose-container-lifecycle.sh" 'label=com.docker.compose.service=$expected_service'
contains "$PROJECT_DIR/scripts/compose-container-lifecycle.sh" 'label=com.docker.compose.oneoff=False'
contains "$PROJECT_DIR/scripts/compose-container-lifecycle.sh" 'multiple containers claim'
contains "$PROJECT_DIR/scripts/compose-container-lifecycle.sh" 'current application container is absent; continuing partial rollback'
contains "$PROJECT_DIR/scripts/compose-container-lifecycle.sh" 'container remains running after bounded stop'
contains "$PROJECT_DIR/scripts/compose-container-lifecycle.sh" 'restoring the original application state'
contains "$PROJECT_DIR/scripts/compose-container-lifecycle.sh" 'originally stopped container started during recovery'
contains "$PROJECT_DIR/scripts/compose-container-lifecycle.sh" 'another deploy/rollback/restore/enrollment transaction is already in progress'
contains "$PROJECT_DIR/scripts/compose-container-lifecycle.sh" 'refusing an untrusted Compose backend one-off writer'
contains "$PROJECT_DIR/scripts/deploy-security-preflight.sh" '"$PROJECT_DIR/scripts/compose-container-lifecycle.sh"'
contains "$PROJECT_DIR/scripts/rollback.sh" 'rev-parse --verify "${REV}^{}"'
contains "$PROJECT_DIR/scripts/rollback.sh" 'rev-parse --show-prefix'
contains "$PROJECT_DIR/scripts/rollback.sh" '--project-directory "$OLD_PROJECT"'
contains "$PROJECT_DIR/scripts/rollback.sh" 'up -d --no-build --wait --wait-timeout'
contains "$PROJECT_DIR/scripts/rollback.sh" 'old_compose config --images'
contains "$PROJECT_DIR/scripts/rollback.sh" 'migration tree differs between current and old release'
contains "$PROJECT_DIR/scripts/rollback.sh" 'runtime-bind.override.yml'
contains "$PROJECT_DIR/scripts/rollback.sh" '"$APP_DATA_DIR/uploads:/uploads"'
contains "$PROJECT_DIR/scripts/rollback.sh" 'ports: !override'
contains "$PROJECT_DIR/scripts/rollback.sh" '"$LAN_BIND_IP:80:80"'
contains "$PROJECT_DIR/scripts/rollback.sh" '"$LOCAL_LAN_BIND_IP:80:80"'
contains "$PROJECT_DIR/scripts/rollback.sh" 'rollback nginx ports are not LAN-only'
contains "$PROJECT_DIR/scripts/rollback.sh" 'ENABLE_SWAGGER: "false"'
contains "$PROJECT_DIR/scripts/rollback.sh" 'command: ["node", "dist/src/main.js"]'
contains "$PROJECT_DIR/scripts/rollback.sh" 'rollback backend command still permits the legacy automatic migration'
contains "$PROJECT_DIR/scripts/rollback.sh" 'rollback email worker is not fail-closed'
contains "$PROJECT_DIR/scripts/rollback.sh" 'bash "$SCRIPT_DIR/rollback-smoke-test.sh"'
not_contains "$PROJECT_DIR/scripts/rollback.sh" 'bash "$SCRIPT_DIR/deploy-smoke-test.sh"'
contains "$PROJECT_DIR/scripts/rollback.sh" 'old application image revisions match the peeled rollback commit'
contains "$PROJECT_DIR/scripts/rollback.sh" 'RELEASE_TAG="$OLD_RELEASE_TAG"'
contains "$PROJECT_DIR/scripts/rollback.sh" 'rollback commit must resolve to exactly one immutable Linux release tag'
contains "$PROJECT_DIR/scripts/rollback.sh" 'database backup changed or failed validation after the restore lock was acquired'
contains "$PROJECT_DIR/scripts/rollback.sh" 'runtime backup changed or failed validation after the restore lock was acquired'
contains "$PROJECT_DIR/scripts/rollback.sh" 'compose_lifecycle_establish_writer_free_boundary "$COMPOSE_PROJECT_NAME"'
contains "$PROJECT_DIR/scripts/rollback.sh" 'could not establish a writer-free rollback boundary'
contains "$PROJECT_DIR/scripts/rollback-smoke-test.sh" 'rollback nginx is not bound exclusively'
contains "$PROJECT_DIR/scripts/rollback-smoke-test.sh" 'rollback /health release metadata does not match the immutable target'
contains "$PROJECT_DIR/scripts/rollback-smoke-test.sh" 'RELEASE_TAG=$ROLLBACK_EXPECTED_TAG'
contains "$PROJECT_DIR/scripts/rollback-smoke-test.sh" 'EMAIL_SEND_DISABLED=true'
contains "$PROJECT_DIR/scripts/rollback.sh" 'joint rollback keeps the current backend stopped'
contains "$PROJECT_DIR/scripts/rollback.sh" '--runtime-backup'
contains "$PROJECT_DIR/scripts/rollback.sh" 'restore-runtime-data.sh'
contains "$PROJECT_DIR/scripts/rollback.sh" 'restore-runtime-data.sh" --check'
contains "$PROJECT_DIR/scripts/rollback.sh" 'docker rm "$CURRENT_OPENCLAW_CONTAINER_ID"'
contains "$PROJECT_DIR/scripts/rollback.sh" 'legacy release has no OpenClaw service; candidate gateway removed without orphaning state'
contains "$PROJECT_DIR/scripts/restore-db.sh" 'Backup file is missing or symlinked'
contains "$PROJECT_DIR/scripts/restore-db.sh" 'application remains stopped to protect the empty or partially recovered database'
contains "$PROJECT_DIR/scripts/restore-db.sh" 'Backup changed or failed validation after the restore lock was acquired'
contains "$PROJECT_DIR/scripts/restore-db.sh" '.database-backup.lock'
old_config_line="$(line_of "$PROJECT_DIR/scripts/rollback.sh" 'old_compose config -q')"
restore_line="$(line_of "$PROJECT_DIR/scripts/rollback.sh" 'bash "$SCRIPT_DIR/recreate-db-from-backup.sh"')"
[ "$old_config_line" -lt "$restore_line" ] \
    || fail "joint rollback must validate the old Compose model before restoring the database"
contains "$PROJECT_DIR/scripts/deploy-security-preflight.sh" '"$PROJECT_DIR/frontend"'
contains "$PROJECT_DIR/scripts/deploy-security-preflight.sh" '"$PROJECT_DIR/backend/Dockerfile"'
contains "$PROJECT_DIR/scripts/deploy-security-preflight.sh" '"$PROJECT_DIR/backend/entrypoint.sh"'
contains "$PROJECT_DIR/scripts/deploy-security-preflight.sh" '"$PROJECT_DIR/frontend/Dockerfile"'
contains "$PROJECT_DIR/scripts/deploy-security-preflight.sh" '"$PROJECT_DIR/frontend/scripts/runtime-healthcheck.cjs"'
contains "$PROJECT_DIR/scripts/deploy-security-preflight.sh" '"$PROJECT_DIR/frontend/.dockerignore"'
for ignored_frontend_path in node_modules .next- electron-export '.env.*'; do
    contains "$PROJECT_DIR/frontend/.dockerignore" "$ignored_frontend_path"
done
for ignored_backend_path in .runtime .whatsapp-sessions data uploads '.env.*'; do
    contains "$PROJECT_DIR/backend/.dockerignore" "$ignored_backend_path"
done
contains "$PROJECT_DIR/scripts/deploy-smoke-test.sh" '[ "$WORKERS_RUNNING" -eq 6 ]'
contains "$PROJECT_DIR/scripts/deploy-smoke-test.sh" '[ "$WORKERS_READY" -eq 6 ]'
contains "$PROJECT_DIR/scripts/deploy-smoke-test.sh" "'{{.RestartCount}}'"
contains "$PROJECT_DIR/scripts/deploy-smoke-test.sh" 'node scripts/worker-healthcheck.cjs'
contains "$PROJECT_DIR/docker-compose.prod.yml" 'test: ["CMD", "node", "scripts/worker-healthcheck.cjs"]'
contains "$PROJECT_DIR/deploy.sh" 'did not pass the Prisma/Redis health check'
contains "$PROJECT_DIR/scripts/deploy-smoke-test.sh" '生产 Swagger 已关闭 → 404'
contains "$PROJECT_DIR/scripts/deploy-smoke-test.sh" '未部署 Evolution webhook 默认关闭 → 503'
contains "$PROJECT_DIR/scripts/deploy-smoke-test.sh" 'AI 助理运行时密钥已配置（未回显）'
contains "$PROJECT_DIR/frontend/Dockerfile" '/app/.next-web/static ./.next-web/static'
not_contains "$PROJECT_DIR/frontend/Dockerfile" '/app/.next-web/static ./.next/static'
contains "$PROJECT_DIR/frontend/Dockerfile" 'node", "scripts/runtime-healthcheck.cjs"'
contains "$PROJECT_DIR/docker-compose.prod.yml" 'test: ["CMD", "node", "scripts/runtime-healthcheck.cjs"]'
contains "$PROJECT_DIR/frontend/scripts/runtime-healthcheck.cjs" "for (const extension of ['.css', '.js'])"
contains "$PROJECT_DIR/frontend/scripts/runtime-healthcheck.cjs" "contentType.includes('text/html')"
contains "$PROJECT_DIR/frontend/scripts/runtime-healthcheck.cjs" "for (const assetPath of ['/logo.png', '/favicon.ico'])"
contains "$PROJECT_DIR/scripts/deploy-smoke-test.sh" 'frontend_asset_probe "http://127.0.0.1:3000"'
contains "$PROJECT_DIR/scripts/deploy-smoke-test.sh" 'frontend_asset_probe "http://nginx"'
node --test "$PROJECT_DIR/frontend/scripts/runtime-healthcheck.node-test.cjs" >/dev/null \
    || fail "frontend standalone asset healthcheck fixtures must pass"
contains "$PROJECT_DIR/backend/Dockerfile" 'ENTRYPOINT ["/app/entrypoint.sh"]'
contains "$PROJECT_DIR/backend/Dockerfile" 'CMD ["node", "dist/src/main.js"]'
contains "$PROJECT_DIR/backend/Dockerfile" 'chmod 0555 /app/entrypoint.sh'
contains "$PROJECT_DIR/backend/entrypoint.sh" '${RUN_MIGRATIONS:-false}'
contains "$PROJECT_DIR/docker-compose.prod.yml" 'RUN_MIGRATIONS: "false"'
if grep -Fq 'RUN_MIGRATIONS: "true"' "$PROJECT_DIR/docker-compose.prod.yml"; then
    fail "no long-running production service may apply migrations during startup"
fi
if grep -Fq 'CMD ["sh", "-c", "npm run prisma:deploy' "$PROJECT_DIR/backend/Dockerfile"; then
    fail "backend runtime must not repeat the bounded deploy.sh migration"
fi
contains "$PROJECT_DIR/backend/Dockerfile.worker" 'USER appuser'
contains "$PROJECT_DIR/backend/Dockerfile.worker" 'apt-get install -y --no-install-recommends openssl ca-certificates'
contains "$PROJECT_DIR/backend/Dockerfile.worker" "ldd \"\$engine\""
contains "$PROJECT_DIR/backend/Dockerfile.worker" 'COPY scripts/worker-healthcheck.cjs'
contains "$PROJECT_DIR/scripts/validate-production-env.mjs" "ENABLE_SWAGGER must equal false"
contains "$PROJECT_DIR/scripts/validate-production-env.mjs" "WHATSAPP_RESTORE_SESSIONS must be explicitly true or false"
contains "$PROJECT_DIR/scripts/validate-production-env.mjs" "DEEP_RESEARCH_RECONCILE_ENABLED must be explicitly true or false"
contains "$PROJECT_DIR/scripts/validate-production-env.mjs" "EVOLUTION_API_ENABLED must be explicitly true or false"
contains "$PROJECT_DIR/docker-compose.prod.yml" 'WHATSAPP_RESTORE_SESSIONS: ${WHATSAPP_RESTORE_SESSIONS:-true}'
contains "$PROJECT_DIR/docker-compose.prod.yml" 'DEEP_RESEARCH_RECONCILE_ENABLED: ${DEEP_RESEARCH_RECONCILE_ENABLED:-true}'
if grep -Fq 'OLD_PROJECT="$RELEASE_ROOT/外贸系统/vaysen-ai-crm"' "$PROJECT_DIR/scripts/rollback.sh"; then
    fail "rollback project path must be derived from the Git worktree prefix"
fi
if grep -R -nE '(^|[[:space:]])npx[[:space:]]+prisma' \
    "$PROJECT_DIR/backend/Dockerfile" "$PROJECT_DIR/backend/Dockerfile.worker" \
    "$PROJECT_DIR/backend/entrypoint.sh" "$PROJECT_DIR/scripts/db-preflight.sh"; then
    fail "production deployment path must not invoke npx prisma"
fi
if grep -nE 'image: .*:latest([[:space:]]|$)' "$PROJECT_DIR/docker-compose.prod.yml"; then
    fail "production Compose must not use mutable latest images"
fi
for immutable_image in NODE_IMAGE PYTHON_IMAGE POSTGRES_IMAGE REDIS_IMAGE NGINX_IMAGE \
    REACHER_IMAGE SEARXNG_IMAGE N8N_IMAGE OPENCLAW_IMAGE; do
    contains "$PROJECT_DIR/docker-compose.prod.yml" "\${${immutable_image}:?"
done
contains "$PROJECT_DIR/docker-compose.prod.yml" 'openclaw-gateway:'
contains "$PROJECT_DIR/docker-compose.prod.yml" 'OPENCLAW_GATEWAY_URL: http://openclaw-gateway:18789'
contains "$PROJECT_DIR/docker-compose.prod.yml" 'OPENCLAW_RELEASE_VERSION: ${OPENCLAW_RUNTIME_VERSION:-2026.7.1}'
contains "$PROJECT_DIR/docker-compose.prod.yml" './deploy/openclaw/config:/opt/vaysen-config:ro'
contains "$PROJECT_DIR/docker-compose.prod.yml" './deploy/openclaw/workspace:/opt/vaysen-workspace:ro'
contains "$PROJECT_DIR/docker-compose.prod.yml" './deploy/openclaw/plugins:/opt/vaysen-plugins:ro'
contains "$PROJECT_DIR/docker-compose.prod.yml" 'NPM_CONFIG_CACHE: /tmp/npm-cache'
contains "$PROJECT_DIR/docker-compose.prod.yml" 'NPM_CONFIG_BIN_LINKS: "false"'
contains "$PROJECT_DIR/scripts/prepare-openclaw-runtime.sh" '--cache "$NPM_CONFIG_CACHE" --update-notifier=false'
contains "$PROJECT_DIR/scripts/prepare-openclaw-runtime.sh" 'npm pack "$spec" --ignore-scripts --json'
contains "$PROJECT_DIR/scripts/prepare-openclaw-runtime.sh" 'PREPARE_NPM_CACHE_HOST="$APP_DATA_DIR/openclaw/.prepare-npm-cache"'
contains "$PROJECT_DIR/scripts/prepare-openclaw-runtime.sh" '-v "$PREPARE_NPM_CACHE_HOST:/tmp/npm-cache"'
contains "$PROJECT_DIR/scripts/prepare-openclaw-runtime.sh" '-v "$PREPARE_NPM_CACHE_HOST:/home/node/.npm"'
contains "$PROJECT_DIR/scripts/prepare-openclaw-runtime.sh" 'NPM_CONFIG_USERCONFIG=/opt/vaysen-config/npm-user.empty'
contains "$PROJECT_DIR/scripts/prepare-openclaw-runtime.sh" 'NPM_CONFIG_GLOBALCONFIG=/opt/vaysen-config/npm-global.empty'
contains "$PROJECT_DIR/scripts/prepare-openclaw-runtime.sh" 'verify_pack "$offline_stage" offline'
contains "$PROJECT_DIR/scripts/prepare-openclaw-runtime.sh" 'warm_verified_install_cache'
contains "$PROJECT_DIR/scripts/prepare-openclaw-runtime.sh" 'npm install --package-lock-only --ignore-scripts'
contains "$PROJECT_DIR/scripts/prepare-openclaw-runtime.sh" 'npm install --offline --ignore-scripts'
contains "$PROJECT_DIR/scripts/prepare-openclaw-runtime.sh" 'verify_lock "$offline_stage"'
contains "$PROJECT_DIR/scripts/prepare-openclaw-runtime.sh" 'test "$default_cache" = /home/node/.npm'
contains "$PROJECT_DIR/scripts/prepare-openclaw-runtime.sh" 'npm config get offline --location=project'
contains "$PROJECT_DIR/scripts/prepare-openclaw-runtime.sh" 'OpenClaw state contains a forbidden npm project configuration'
contains "$PROJECT_DIR/scripts/prepare-openclaw-runtime.sh" '.vaysen-cache-alias-$$'
contains "$PROJECT_DIR/deploy/openclaw/config/npm-user.empty" 'Intentionally empty'
contains "$PROJECT_DIR/deploy/openclaw/config/npm-global.empty" 'Intentionally empty'
contains "$PROJECT_DIR/scripts/prepare-openclaw-runtime.sh" 'NPM_CONFIG_FETCH_RETRIES=5'
contains "$PROJECT_DIR/scripts/prepare-openclaw-runtime.sh" 'NPM_CONFIG_OFFLINE=true'
contains "$PROJECT_DIR/scripts/prepare-openclaw-runtime.sh" 'npm_config_offline=true'
contains "$PROJECT_DIR/scripts/prepare-openclaw-runtime.sh" "docker_root_phase 'remove transient npm preparation cache'"
contains "$PROJECT_DIR/scripts/prepare-openclaw-runtime.sh" "TYPEBOX_SPEC='typebox@1.3.3'"
contains "$PROJECT_DIR/scripts/prepare-openclaw-runtime.sh" 'verify OpenClaw host dependency contract'
contains "$PROJECT_DIR/scripts/prepare-openclaw-runtime.sh" 'verify-host-contract.mjs "$TYPEBOX_VERSION"'
contains "$PROJECT_DIR/scripts/prepare-openclaw-runtime.sh" "QRCODE_SPEC='qrcode-terminal@0.12.0'"
contains "$PROJECT_DIR/scripts/prepare-openclaw-runtime.sh" "ZOD_SPEC='zod@4.3.6'"
contains "$PROJECT_DIR/scripts/prepare-openclaw-runtime.sh" "WEIXIN_SPEC='@tencent-weixin/openclaw-weixin@2.4.6'"
contains "$PROJECT_DIR/scripts/prepare-openclaw-runtime.sh" 'test "$actual_integrity" = "$expected"'
contains "$PROJECT_DIR/scripts/prepare-openclaw-runtime.sh" 'test "$metadata_shasum" = "$actual_shasum"'
contains "$PROJECT_DIR/scripts/prepare-openclaw-runtime.sh" 'plugins install "npm-pack:$patched_artifact" --force'
contains "$PROJECT_DIR/scripts/prepare-openclaw-runtime.sh" 'plugins install "npm-pack:$private_artifact" --force'
contains "$PROJECT_DIR/scripts/prepare-openclaw-runtime.sh" 'cmp "$artifact_a" "$artifact_b"'
contains "$PROJECT_DIR/scripts/prepare-openclaw-runtime.sh" 'for relative in package.json npm-shrinkwrap.json openclaw.plugin.json README.md dist/index.js dist/runtime.js'
contains "$PROJECT_DIR/scripts/prepare-openclaw-runtime.sh" 'chmod 644 "$target"'
contains "$PROJECT_DIR/scripts/prepare-openclaw-runtime.sh" 'npm pack "$package_source" --ignore-scripts --json --offline'
contains "$PROJECT_DIR/scripts/prepare-openclaw-runtime.sh" 'PRIVATE_CRM_INTEGRITY='
contains "$PROJECT_DIR/scripts/prepare-openclaw-runtime.sh" 'PRIVATE_CRM_TREE_SHA256='
not_contains "$PROJECT_DIR/scripts/prepare-openclaw-runtime.sh" 'plugins install /opt/vaysen-plugins/vaysen-crm'
contains "$PROJECT_DIR/scripts/prepare-openclaw-runtime.sh" 'WEIXIN_PATCHED_INTEGRITY='
contains "$PROJECT_DIR/scripts/prepare-openclaw-runtime.sh" 'WEIXIN_PATCH_SHA256='
contains "$PROJECT_DIR/scripts/prepare-openclaw-runtime.sh" 'weixin-patch-supply-chain.mjs'
contains "$PROJECT_DIR/scripts/prepare-openclaw-runtime.sh" '! -type d ! -type f ! -type l'
contains "$PROJECT_DIR/scripts/prepare-openclaw-runtime.sh" 'timeout --signal=TERM --kill-after=15s'
contains "$PROJECT_DIR/scripts/prepare-openclaw-runtime.sh" '--pull never --name "$name"'
contains "$PROJECT_DIR/scripts/prepare-openclaw-runtime.sh" 'docker_root_phase'
contains "$PROJECT_DIR/scripts/prepare-openclaw-runtime.sh" 'com.vaysen.vaysen-crm.openclaw-prepare=$OPENCLAW_PREP_RUN_ID'
contains "$PROJECT_DIR/scripts/prepare-openclaw-runtime.sh" 'retrying once'
contains "$PROJECT_DIR/scripts/prepare-openclaw-runtime.sh" 'OPENCLAW_GATEWAY_TOKEN=prepare-redacted-gateway-token-000000'
contains "$PROJECT_DIR/scripts/prepare-openclaw-runtime.sh" 'OPENCLAW_CRM_HMAC_SECRET=prepare-redacted-hmac-secret-000000000000000000000000000000000000'
contains "$PROJECT_DIR/scripts/prepare-openclaw-runtime.sh" 'ZHIPU_API_KEY=prepare-redacted-zhipu-key'
contains "$PROJECT_DIR/scripts/prepare-openclaw-runtime.sh" 'openclaw.install-private.json'
contains "$PROJECT_DIR/scripts/prepare-openclaw-runtime.sh" 'write replay-safe installation configuration'
not_contains "$PROJECT_DIR/scripts/prepare-openclaw-runtime.sh" 'cp /opt/vaysen-config/openclaw.install-bootstrap.json "$OPENCLAW_CONFIG_PATH.next"'
contains "$PROJECT_DIR/scripts/prepare-openclaw-runtime.sh" 'prune inactive retained npm generations'
contains "$PROJECT_DIR/scripts/prepare-openclaw-runtime.sh" '/app/dist/managed-npm-retention-BTuFzcN9.js'
contains "$PROJECT_DIR/scripts/prepare-openclaw-runtime.sh" 'if (failures.length > 0) throw new AggregateError'
contains "$PROJECT_DIR/deploy/openclaw/config/openclaw.install-private.json" '"apiBaseUrl": "http://backend:4000"'
contains "$PROJECT_DIR/deploy/openclaw/config/openclaw.install-private.json" '"hmacSecret": "${OPENCLAW_CRM_HMAC_SECRET}"'
not_contains "$PROJECT_DIR/scripts/prepare-openclaw-runtime.sh" 'set -x'
contains "$PROJECT_DIR/deploy/openclaw/plugins/vaysen-crm/audit-managed-install.mjs" 'verifyManagedStateEntries'
contains "$PROJECT_DIR/deploy/openclaw/plugins/vaysen-crm/audit-managed-install.mjs" "path.join(nodeModules, 'openclaw')"
contains "$PROJECT_DIR/deploy/openclaw/plugins/vaysen-crm/package.json" '"npm-shrinkwrap.json"'
contains "$PROJECT_DIR/deploy/openclaw/plugins/vaysen-crm/verify-weixin-acceptance-evidence.mjs" 'markerDigest, outcome, observedAt'
contains "$PROJECT_DIR/deploy/openclaw/plugins/vaysen-crm/audit-managed-install.mjs" 'installed_plugin_index'
contains "$PROJECT_DIR/deploy/openclaw/plugins/vaysen-crm/audit-managed-install.mjs" 'verifyPrivateNpmPackSupplyChain'
contains "$PROJECT_DIR/deploy/openclaw/plugins/vaysen-crm/audit-managed-install.mjs" "artifactKind: 'npm-pack'"
contains "$PROJECT_DIR/deploy/openclaw/plugins/vaysen-crm/audit-managed-install.mjs" 'managed installPath is outside the OpenClaw npm state root'
contains "$PROJECT_DIR/deploy/openclaw/plugins/vaysen-crm/audit-managed-install.mjs" 'managed published file mismatch'
contains "$PROJECT_DIR/deploy/openclaw/plugins/vaysen-crm/audit-managed-install.mjs" "spec: '4.3.6'"
contains "$PROJECT_DIR/deploy/openclaw/plugins/vaysen-crm/weixin-v2.4.6.patch.json" '\"zod\": \"4.3.6\"'
offline_install_count="$(grep -Fc -- '-e NPM_CONFIG_OFFLINE=true -e npm_config_offline=true' \
    "$PROJECT_DIR/scripts/prepare-openclaw-runtime.sh")"
[ "$offline_install_count" = 2 ] || fail "both plugin install paths must be forced offline"
not_contains "$PROJECT_DIR/scripts/prepare-openclaw-runtime.sh" 'npm view '
if grep -Fq 'plugins install "npm:' "$PROJECT_DIR/scripts/prepare-openclaw-runtime.sh"; then
    fail "Tencent plugin must be installed from the already verified npm-pack artifact"
fi
contains "$PROJECT_DIR/deploy.sh" 'bash scripts/prepare-openclaw-runtime.sh'
contains "$PROJECT_DIR/deploy.sh" 'bash scripts/openclaw-runtime-smoke-test.sh'
contains "$PROJECT_DIR/deploy.sh" 'bash scripts/openclaw-real-scene-test.sh'
contains "$PROJECT_DIR/deploy.sh" 'run_openclaw_e2e_auth_gate auth-only'
contains "$PROJECT_DIR/deploy.sh" 'run_openclaw_e2e_auth_gate real-scene'
contains "$PROJECT_DIR/deploy.sh" 'bash scripts/mint-openclaw-e2e-token.sh'
contains "$PROJECT_DIR/deploy.sh" 'node scripts/verify-openclaw-e2e-auth.mjs'
not_contains "$PROJECT_DIR/deploy.sh" 'OPENCLAW_E2E_BEARER_TOKEN_FILE is required'
contains "$PROJECT_DIR/deploy.sh" 'OPENCLAW_E2E_REQUIRE_WECHAT_BOUND'
contains "$PROJECT_DIR/deploy.sh" 'compose_lifecycle_acquire_transaction_lock "$RELEASES_DIR"'
contains "$PROJECT_DIR/deploy.sh" "sed '/^\$/d' | wc -l"
contains "$PROJECT_DIR/deploy.sh" "grep -Eq '^(0\\.0\\.0\\.0|::) | 443\$'"
contains "$PROJECT_DIR/scripts/rollback-smoke-test.sh" "curl --noproxy '*'"
contains "$PROJECT_DIR/scripts/rollback-smoke-test.sh" 'ROLLBACK_EXPECTED_REVISION'
contains "$PROJECT_DIR/scripts/openclaw-weixin-acceptance.sh" 'run.\"source\" = '\''WECHAT_OWNER'\''::\"AgentRunSource\"'
contains "$PROJECT_DIR/scripts/openclaw-weixin-acceptance.sh" '[ "$count" -le 1 ]'
contains "$PROJECT_DIR/scripts/openclaw-weixin-acceptance.sh" '[ "$tool" = '\''work-brief'\'' ]'
contains "$PROJECT_DIR/scripts/openclaw-weixin-acceptance.sh" 'run_negative_acceptance non-owner'
contains "$PROJECT_DIR/scripts/openclaw-weixin-acceptance.sh" 'run_negative_acceptance group'
contains "$PROJECT_DIR/scripts/openclaw-weixin-acceptance.sh" 'require_immutable_acceptance_file'
contains "$PROJECT_DIR/scripts/openclaw-weixin-acceptance.sh" 'compose_lifecycle_acquire_transaction_lock'
contains "$PROJECT_DIR/scripts/openclaw-weixin-acceptance.sh" 'validate_weixin_connected_status_json'
contains "$PROJECT_DIR/scripts/openclaw-weixin-acceptance.sh" 'account.running !== true'
contains "$PROJECT_DIR/scripts/openclaw-weixin-acceptance.sh" '[OWNER REPLAY TEST]'
contains "$PROJECT_DIR/scripts/openclaw-weixin-acceptance.sh" 'OPENCLAW_ACCEPTANCE_REPLAY_DEDUPLICATED'
contains "$PROJECT_DIR/scripts/openclaw-weixin-acceptance.sh" 'owner duplicate replay did not reach the broker idempotency boundary'
contains "$PROJECT_DIR/scripts/openclaw-weixin-acceptance.sh" 'assert_production_state_unchanged'
contains "$PROJECT_DIR/scripts/openclaw-weixin-acceptance.sh" 'assert_running_release_contract'
contains "$PROJECT_DIR/scripts/openclaw-weixin-acceptance.sh" 'running backend owner digest differs from the immutable environment'
contains "$PROJECT_DIR/scripts/openclaw-weixin-acceptance.sh" 'official Weixin channel final probe failed'
contains "$PROJECT_DIR/scripts/openclaw-weixin-acceptance.sh" '/opt/vaysen-plugins/vaysen-crm/verify-weixin-acceptance-evidence.mjs'
contains "$PROJECT_DIR/scripts/openclaw-weixin-acceptance.sh" "expected_outcome='NON_OWNER_REJECTED'"
contains "$PROJECT_DIR/scripts/openclaw-weixin-acceptance.sh" "expected_outcome='GROUP_REJECTED'"
contains "$PROJECT_DIR/scripts/openclaw-weixin-acceptance.sh" 'evidence.markerDigest !== process.env.EXPECTED_DIGEST'
contains "$PROJECT_DIR/scripts/openclaw-weixin-acceptance.sh" 'AND \"acceptanceMarkerDigest\" = '\''$marker_digest'\'';'
contains "$PROJECT_DIR/scripts/openclaw-weixin-login.sh" 'docker ps -aq --no-trunc'
contains "$PROJECT_DIR/scripts/openclaw-weixin-login.sh" 'docker ps -q --no-trunc'
contains "$PROJECT_DIR/scripts/openclaw-weixin-login.sh" 'docker ps -a --no-trunc --filter'
if grep -Fq 'rejection evidence verifier is not wired yet' "$PROJECT_DIR/scripts/openclaw-weixin-acceptance.sh"; then
    fail "real Weixin negative acceptance must not retain the old fail-closed placeholder"
fi
contains "$PROJECT_DIR/scripts/openclaw-runtime-smoke-test.sh" 'openclaw-runtime-probe.mjs'
contains "$PROJECT_DIR/scripts/openclaw-runtime-smoke-test.sh" 'assert-no-published-host-ports.mjs'
contains "$PROJECT_DIR/scripts/openclaw-runtime-smoke-test.sh" 'const sanitizeDetail = (value)'
contains "$PROJECT_DIR/scripts/openclaw-runtime-smoke-test.sh" 'model smoke failed: ${JSON.stringify(safeFailure)}'
contains "$PROJECT_DIR/scripts/openclaw-runtime-smoke-test.sh" 'runtime-created OpenClaw state remains restricted to 0700/0600'
not_contains "$PROJECT_DIR/scripts/openclaw-runtime-smoke-test.sh" 'model smoke HTTP ${modelResponse.status}'
contains "$PROJECT_DIR/deploy/openclaw/config/openclaw.production.json" '"workspace": "/opt/vaysen-workspace"'
contains "$PROJECT_DIR/deploy/openclaw/config/openclaw.production.json" '"skipBootstrap": true'
contains "$PROJECT_DIR/deploy/openclaw/config/openclaw.production.json" '"maxTokensField": "max_tokens"'
contains "$PROJECT_DIR/docker-compose.prod.yml" './deploy/openclaw/workspace:/opt/vaysen-workspace:ro'
contains "$PROJECT_DIR/docker-compose.prod.yml" 'command: ["umask 077; exec node dist/index.js gateway --bind lan --port 18789"]'
contains "$PROJECT_DIR/deploy/openclaw/workspace/IDENTITY.md" 'JY AI 业务助理'
contains "$PROJECT_DIR/deploy/openclaw/workspace/HEARTBEAT.md" '不配置任何自主心跳任务'
contains "$PROJECT_DIR/docker-compose.prod.yml" 'x-direct-runtime-env: &direct-runtime-env'
contains "$PROJECT_DIR/docker-compose.prod.yml" 'HTTP_PROXY: ""'
contains "$PROJECT_DIR/docker-compose.prod.yml" 'http_proxy: ""'
contains "$PROJECT_DIR/docker-compose.prod.yml" '<<: *direct-runtime-env'
contains "$PROJECT_DIR/scripts/deploy-smoke-test.sh" 'RUNTIME_EGRESS_SERVICES=(backend openclaw-gateway python-service n8n reacher searxng)'
contains "$PROJECT_DIR/scripts/deploy-smoke-test.sh" 'proxyKeys = new Set(['
contains "$PROJECT_DIR/scripts/deploy-smoke-test.sh" 'line.slice(index + 1).trim().length > 0'
contains "$PROJECT_DIR/scripts/reuse-release-images.sh" "serviceNames = ['backend', 'frontend', 'python-service', 'worker-email-compose']"
contains "$PROJECT_DIR/scripts/reuse-release-images.sh" 'normalized self-built Compose contracts differ'
contains "$PROJECT_DIR/scripts/openclaw-runtime-probe.mjs" "model.available === true"
contains "$PROJECT_DIR/scripts/openclaw-runtime-probe.mjs" "model?.provider === PROVIDER_ID"
contains "$PROJECT_DIR/scripts/openclaw-real-scene-test.sh" "run.kind === 'OPENCLAW_TOOL'"
contains "$PROJECT_DIR/scripts/openclaw-real-scene-test.sh" "task?.toolName === 'openclaw.work-brief'"
contains "$PROJECT_DIR/scripts/openclaw-real-scene-test.sh" "chat.responseKind !== 'OPENCLAW_TOOL_RESULT'"
contains "$PROJECT_DIR/scripts/openclaw-real-scene-test.sh" 'Array.isArray(chat.toolReceipts)'
contains "$PROJECT_DIR/scripts/openclaw-real-scene-test.sh" 'new AbortController()'
contains "$PROJECT_DIR/scripts/openclaw-real-scene-test.sh" 'same requestId returned more than one assistant artifact'
contains "$PROJECT_DIR/scripts/openclaw-real-scene-test.sh" 'duplicateRuns.length !== 1'
contains "$PROJECT_DIR/scripts/openclaw-real-scene-test.sh" "run?.subjectId === executionSessionDigest"
contains "$PROJECT_DIR/scripts/openclaw-real-scene-test.sh" "duplicateRuns[0]?.id !== receiptRunId"
contains "$PROJECT_DIR/scripts/openclaw-real-scene-test.sh" 'OPENCLAW_E2E_BEARER_TOKEN_FILE mode must be 600 or 400'
contains "$PROJECT_DIR/scripts/mint-openclaw-e2e-token.sh" 'short-lived administrator token minted without disclosure'
contains "$PROJECT_DIR/scripts/mint-openclaw-e2e-token.sh" 'node --input-type=module - "$COMPANY_ID" "$OWNER_EMAIL" "$TTL_SECONDS"'
contains "$PROJECT_DIR/scripts/mint-openclaw-e2e-token.sh" 'backend container must be running and healthy before token minting'
contains "$PROJECT_DIR/scripts/mint-openclaw-e2e-token.mjs" "role?.name !== 'company_admin'"
contains "$PROJECT_DIR/scripts/mint-openclaw-e2e-token.mjs" 'expiresIn: ttlSeconds'
contains "$PROJECT_DIR/scripts/verify-openclaw-e2e-auth.mjs" "new URL('/api/auth/me', baseUrl)"
contains "$PROJECT_DIR/scripts/verify-openclaw-e2e-auth.mjs" "item?.role === 'company_admin'"
not_contains "$PROJECT_DIR/scripts/mint-openclaw-e2e-token.sh" 'set -x'
not_contains "$PROJECT_DIR/scripts/mint-openclaw-e2e-token.mjs" 'console.log(token)'
contains "$PROJECT_DIR/scripts/openclaw-real-scene-test.sh" "runtime?.wechatOwnerChannel?.status !== 'CONNECTED'"
contains "$PROJECT_DIR/scripts/openclaw-real-scene-test.sh" 'runtime?.permissions?.canIssueWechatCommands !== true'
OPENCLAW_MIGRATION="$PROJECT_DIR/backend/prisma/migrations/20260714210000_openclaw_gateway_integration/migration.sql"
contains "$OPENCLAW_MIGRATION" 'ALTER TYPE "AgentRunKind" ADD VALUE IF NOT EXISTS'
[ "$(grep -Ec '^[[:space:]]*BEGIN;[[:space:]]*$' "$OPENCLAW_MIGRATION")" -eq 2 ] \
    || fail "OpenClaw migration must isolate the enum change and wrap all remaining DDL in a transaction"
[ "$(grep -Ec '^[[:space:]]*COMMIT;[[:space:]]*$' "$OPENCLAW_MIGRATION")" -eq 2 ] \
    || fail "OpenClaw migration transaction boundaries are incomplete"
if grep -Fq 'payload?.ok === true' "$PROJECT_DIR/scripts/openclaw-runtime-smoke-test.sh"; then
    fail "OpenClaw smoke must not use the fabricated payload.ok RPC shape"
fi
pass "release, backup, rollback, and 6/6 worker contracts are present"

# LAN/ZeroTier-only deployment contract.
contains "$PROJECT_DIR/docker-compose.prod.yml" '${LAN_BIND_IP:-127.0.0.1}:80:80'
contains "$PROJECT_DIR/docker-compose.prod.yml" '${LOCAL_LAN_BIND_IP:?LOCAL_LAN_BIND_IP must be an approved RFC1918 host address}:80:80'
contains "$PROJECT_DIR/docker-compose.prod.yml" 'WHATSAPP_PROXY: ${WHATSAPP_PROXY:-}'
contains "$PROJECT_DIR/docker-compose.prod.yml" '${APP_DATA_DIR:?APP_DATA_DIR must be an approved absolute host path}/uploads:/app/uploads'
contains "$PROJECT_DIR/docker-compose.prod.yml" '${APP_DATA_DIR:?APP_DATA_DIR must be an approved absolute host path}/.customizer-assets:/app/.customizer-assets'
contains "$PROJECT_DIR/docker-compose.prod.yml" 'IMAGE_PROCESSOR_URL: ${IMAGE_PROCESSOR_URL:-http://python-service:5000}'
contains "$PROJECT_DIR/docker-compose.prod.yml" 'vaysen-crm-python-service:${RELEASE_COMMIT_SHORT:-local}'
if grep -Fq -- '- "80:80"' "$PROJECT_DIR/docker-compose.prod.yml"; then
    fail "nginx must not bind port 80 on every host interface"
fi
if grep -Eq '443:443|letsencrypt' "$PROJECT_DIR/docker-compose.prod.yml"; then
    fail "LAN-only Compose must not expose 443 or mount public TLS certificates"
fi
if grep -Fq 'nginx_logs:/var/log/nginx' "$PROJECT_DIR/docker-compose.prod.yml"; then
    fail "nginx must log to stdout/stderr instead of an unrotated named volume"
fi
contains "$PROJECT_DIR/nginx/nginx.conf" 'error_log /dev/stderr warn;'
contains "$PROJECT_DIR/nginx/nginx.conf" 'access_log /dev/stdout main;'
contains "$PROJECT_DIR/nginx/nginx.conf" 'include /etc/nginx/conf.d/*.conf;'
contains "$PROJECT_DIR/nginx/conf.d/vaysen-crm-lan.conf" 'server_name _;'
contains "$PROJECT_DIR/nginx/conf.d/vaysen-crm-lan.conf" 'proxy_pass http://vaysen-crm_backend_upstream/health;'
contains "$PROJECT_DIR/nginx/conf.d/vaysen-crm-lan.conf" 'proxy_buffering off;'
contains "$PROJECT_DIR/docker-compose.prod.yml" 'test: ["CMD", "wget", "-Y", "off", "--spider", "-q", "http://127.0.0.1/health"]'
contains "$PROJECT_DIR/scripts/deploy-smoke-test.sh" 'wget -Y off'
contains "$PROJECT_DIR/scripts/rollback.sh" '"wget", "-Y", "off"'
contains "$PROJECT_DIR/backend/src/modules/whatsapp/evolution-webhook.controller.ts" '@Public()'
if grep -R -nE 'fastenernails\.com|updates\.vaysenpackaging\.com|listen[[:space:]]+443' \
    "$PROJECT_DIR/docker-compose.prod.yml" "$PROJECT_DIR/nginx" "$PROJECT_DIR/electron/electron-builder.yml"; then
    fail "canonical LAN deployment path must not reference public domains, updater, or port 443"
fi
if grep -Eq '^[[:space:]]*publish:' "$PROJECT_DIR/electron/electron-builder.yml"; then
    fail "LAN installer must use manual updates and omit electron-builder publish"
fi
contains "$PROJECT_DIR/scripts/final-production-fix.sh" '[DISABLED]'
contains "$PROJECT_DIR/scripts/production-smoke-test.sh" '[DISABLED]'
pass "LAN-only bind, nginx, manual-update, and legacy-script contracts are present"

case "$(uname -s)" in
    MINGW*|MSYS*)
        printf '[SKIP] NTFS/MSYS reports synthesized 755/644 modes; sandbox chmod assertions require Linux\n'
        printf 'TASK-109 deployment contract tests passed: %d groups (1 Linux-only group skipped)\n' "$PASS"
        exit 0
        ;;
esac

TMP_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/task109-contract-XXXXXX")"
PYTHON_SQLITE=''
if command -v python3 >/dev/null 2>&1; then PYTHON_SQLITE=python3
elif command -v python >/dev/null 2>&1; then PYTHON_SQLITE=python
else fail "python3/python is required to create SQLite/tar contract fixtures"
fi
cleanup() {
    case "$TMP_ROOT" in
        "${TMPDIR:-/tmp}"/task109-contract-*) rm -rf -- "$TMP_ROOT" ;;
        *) printf '[WARN] refusing to remove unexpected temp path: %s\n' "$TMP_ROOT" >&2 ;;
    esac
}
trap cleanup EXIT

FIXTURE="$TMP_ROOT/project"
BACKUPS="$TMP_ROOT/backups"
RELEASES="$TMP_ROOT/releases"
APP_DATA="$TMP_ROOT/data"
REHEARSALS="$TMP_ROOT/rehearsals"
mkdir -p "$FIXTURE/scripts" "$FIXTURE/backend" "$FIXTURE/frontend/scripts" "$FIXTURE/python-service" "$FIXTURE/nginx" "$FIXTURE/workflows" \
    "$FIXTURE/deploy/openclaw/config" "$FIXTURE/deploy/openclaw/plugins/vaysen-crm/dist" \
    "$FIXTURE/deploy/openclaw/plugins/vaysen-crm/test" \
    "$FIXTURE/deploy/openclaw/plugins/vaysen-crm/weixin-patch-files/src/security" \
    "$FIXTURE/deploy/openclaw/plugins/vaysen-crm/weixin-patch-files/dist/src/security" \
    "$BACKUPS" "$RELEASES" "$APP_DATA" "$REHEARSALS"
cp "$PROJECT_DIR/scripts/deploy-security-preflight.sh" "$PROJECT_DIR/scripts/compose-container-lifecycle.sh" \
    "$PROJECT_DIR/scripts/select-migration-rehearsal-mode.sh" "$FIXTURE/scripts/"
chmod 750 "$FIXTURE/scripts/deploy-security-preflight.sh"
printf '.gitattributes text eol=lf\n*.sh text eol=lf\ndeploy/openclaw/** text eol=lf\n' > "$FIXTURE/.gitattributes"
printf '.env\n' > "$FIXTURE/.gitignore"
for file in deploy.sh docker-compose.prod.yml; do printf 'fixture\n' > "$FIXTURE/$file"; done
for file in db-preflight.sh rehearse-db-migration.sh recreate-db-from-backup.sh backup-db.sh rollback.sh; do printf 'fixture\n' > "$FIXTURE/scripts/$file"; done
for file in verify-db-backup.sh restore-db.sh backup-runtime-data.sh sanitize-openclaw-runtime-snapshot.sh prepare-runtime-data.sh restore-runtime-data.sh rollback-smoke-test.sh; do printf 'fixture\n' > "$FIXTURE/scripts/$file"; done
for file in runtime-link-manifest.sh runtime-link-contract.mjs run-runtime-link-contract.sh runtime-initialize-transaction.sh runtime-restore-transaction.sh validate-production-env.mjs prepare-openclaw-runtime.sh openclaw-runtime-smoke-test.sh openclaw-runtime-probe.mjs \
    assert-no-published-host-ports.mjs assert-no-published-host-ports.test.mjs \
    openclaw-real-scene-test.sh openclaw-weixin-login.sh openclaw-weixin-acceptance.sh validate-openclaw-production.mjs; do
    printf 'fixture\n' > "$FIXTURE/scripts/$file"
done
for file in package.json npm-shrinkwrap.json openclaw.plugin.json README.md audit-managed-install.mjs verify-host-contract.mjs weixin-patch-supply-chain.mjs \
    weixin-v2.4.6.patch.json verify-weixin-acceptance-evidence.mjs; do
    printf 'fixture\n' > "$FIXTURE/deploy/openclaw/plugins/vaysen-crm/$file"
done
printf 'fixture\n' > "$FIXTURE/deploy/openclaw/plugins/vaysen-crm/test/verify-host-contract.test.mjs"
for file in index.js runtime.js; do
    printf 'fixture\n' > "$FIXTURE/deploy/openclaw/plugins/vaysen-crm/dist/$file"
done
printf 'fixture\n' > "$FIXTURE/deploy/openclaw/plugins/vaysen-crm/weixin-patch-files/src/security/acceptance-evidence.ts"
printf 'fixture\n' > "$FIXTURE/deploy/openclaw/plugins/vaysen-crm/weixin-patch-files/dist/src/security/acceptance-evidence.js"
printf 'fixture\n' > "$FIXTURE/deploy/openclaw/config/openclaw.install-bootstrap.json"
printf 'fixture\n' > "$FIXTURE/deploy/openclaw/config/openclaw.install-private.json"
printf 'fixture\n' > "$FIXTURE/deploy/openclaw/config/openclaw.production.json"
printf '# fixture\n' > "$FIXTURE/deploy/openclaw/config/npm-user.empty"
printf '# fixture\n' > "$FIXTURE/deploy/openclaw/config/npm-global.empty"
printf 'fixture\n' > "$FIXTURE/backend/.dockerignore"
printf 'fixture\n' > "$FIXTURE/backend/Dockerfile"
printf 'fixture\n' > "$FIXTURE/backend/entrypoint.sh"
printf 'fixture\n' > "$FIXTURE/frontend/.dockerignore"
printf 'fixture\n' > "$FIXTURE/frontend/Dockerfile"
printf 'fixture\n' > "$FIXTURE/frontend/scripts/runtime-healthcheck.cjs"
printf 'fixture\n' > "$FIXTURE/python-service/.dockerignore"
printf 'DB_PASSWORD=not-a-real-secret\n' > "$FIXTURE/.env"
chmod 750 "$FIXTURE" "$FIXTURE/scripts" "$FIXTURE/backend" "$FIXTURE/frontend" "$FIXTURE/frontend/scripts" "$FIXTURE/python-service" "$FIXTURE/nginx" "$FIXTURE/workflows" \
    "$FIXTURE/deploy" "$FIXTURE/deploy/openclaw" "$FIXTURE/deploy/openclaw/config" \
    "$FIXTURE/deploy/openclaw/plugins" "$FIXTURE/deploy/openclaw/plugins/vaysen-crm" \
    "$FIXTURE/deploy/openclaw/plugins/vaysen-crm/dist" "$FIXTURE/deploy/openclaw/plugins/vaysen-crm/test" \
    "$FIXTURE/deploy/openclaw/plugins/vaysen-crm/weixin-patch-files" \
    "$FIXTURE/deploy/openclaw/plugins/vaysen-crm/weixin-patch-files/src" \
    "$FIXTURE/deploy/openclaw/plugins/vaysen-crm/weixin-patch-files/src/security" \
    "$FIXTURE/deploy/openclaw/plugins/vaysen-crm/weixin-patch-files/dist" \
    "$FIXTURE/deploy/openclaw/plugins/vaysen-crm/weixin-patch-files/dist/src" \
    "$FIXTURE/deploy/openclaw/plugins/vaysen-crm/weixin-patch-files/dist/src/security" "$APP_DATA"
chmod 700 "$BACKUPS"
chmod 700 "$REHEARSALS"
chmod 750 "$RELEASES"
chmod 600 "$FIXTURE/.env"
chmod 640 "$FIXTURE/.gitattributes" "$FIXTURE/deploy.sh" "$FIXTURE/docker-compose.prod.yml" \
    "$FIXTURE/backend/Dockerfile" "$FIXTURE/backend/entrypoint.sh" \
    "$FIXTURE/backend/.dockerignore" "$FIXTURE/frontend/.dockerignore" "$FIXTURE/frontend/Dockerfile" \
    "$FIXTURE/frontend/scripts/runtime-healthcheck.cjs" "$FIXTURE/python-service/.dockerignore" \
    "$FIXTURE/scripts/compose-container-lifecycle.sh" \
    "$FIXTURE/scripts/select-migration-rehearsal-mode.sh" \
    "$FIXTURE/scripts/db-preflight.sh" "$FIXTURE/scripts/rehearse-db-migration.sh" "$FIXTURE/scripts/recreate-db-from-backup.sh" "$FIXTURE/scripts/backup-db.sh" "$FIXTURE/scripts/backup-runtime-data.sh" \
    "$FIXTURE/scripts/sanitize-openclaw-runtime-snapshot.sh" \
    "$FIXTURE/scripts/verify-db-backup.sh" \
    "$FIXTURE/scripts/restore-db.sh" \
    "$FIXTURE/scripts/prepare-runtime-data.sh" \
    "$FIXTURE/scripts/restore-runtime-data.sh" "$FIXTURE/scripts/rollback.sh" "$FIXTURE/scripts/rollback-smoke-test.sh" \
    "$FIXTURE/scripts/runtime-link-manifest.sh" "$FIXTURE/scripts/runtime-link-contract.mjs" "$FIXTURE/scripts/run-runtime-link-contract.sh" \
    "$FIXTURE/scripts/runtime-initialize-transaction.sh" "$FIXTURE/scripts/runtime-restore-transaction.sh" \
    "$FIXTURE/scripts/prepare-openclaw-runtime.sh" "$FIXTURE/scripts/openclaw-runtime-smoke-test.sh" \
    "$FIXTURE/scripts/openclaw-runtime-probe.mjs" "$FIXTURE/scripts/assert-no-published-host-ports.mjs" \
    "$FIXTURE/scripts/assert-no-published-host-ports.test.mjs" "$FIXTURE/scripts/openclaw-real-scene-test.sh" \
    "$FIXTURE/scripts/openclaw-weixin-login.sh" "$FIXTURE/scripts/openclaw-weixin-acceptance.sh" "$FIXTURE/scripts/validate-openclaw-production.mjs" \
    "$FIXTURE/scripts/validate-production-env.mjs" \
    "$FIXTURE/deploy/openclaw/config/openclaw.install-bootstrap.json" \
    "$FIXTURE/deploy/openclaw/config/openclaw.install-private.json" \
    "$FIXTURE/deploy/openclaw/config/openclaw.production.json" \
    "$FIXTURE/deploy/openclaw/config/npm-user.empty" "$FIXTURE/deploy/openclaw/config/npm-global.empty" \
    "$FIXTURE/deploy/openclaw/plugins/vaysen-crm/package.json" \
    "$FIXTURE/deploy/openclaw/plugins/vaysen-crm/openclaw.plugin.json" \
    "$FIXTURE/deploy/openclaw/plugins/vaysen-crm/npm-shrinkwrap.json" \
    "$FIXTURE/deploy/openclaw/plugins/vaysen-crm/README.md" \
    "$FIXTURE/deploy/openclaw/plugins/vaysen-crm/audit-managed-install.mjs" \
    "$FIXTURE/deploy/openclaw/plugins/vaysen-crm/verify-host-contract.mjs" \
    "$FIXTURE/deploy/openclaw/plugins/vaysen-crm/test/verify-host-contract.test.mjs" \
    "$FIXTURE/deploy/openclaw/plugins/vaysen-crm/weixin-patch-supply-chain.mjs" \
    "$FIXTURE/deploy/openclaw/plugins/vaysen-crm/weixin-v2.4.6.patch.json" \
    "$FIXTURE/deploy/openclaw/plugins/vaysen-crm/verify-weixin-acceptance-evidence.mjs" \
    "$FIXTURE/deploy/openclaw/plugins/vaysen-crm/weixin-patch-files/src/security/acceptance-evidence.ts" \
    "$FIXTURE/deploy/openclaw/plugins/vaysen-crm/weixin-patch-files/dist/src/security/acceptance-evidence.js" \
    "$FIXTURE/deploy/openclaw/plugins/vaysen-crm/dist/index.js" \
    "$FIXTURE/deploy/openclaw/plugins/vaysen-crm/dist/runtime.js"
FIXTURE_OWNER="$(stat -c '%U' "$FIXTURE")"
FIXTURE_GROUP="$(stat -c '%G' "$FIXTURE")"
git -C "$FIXTURE" init -q
git -C "$FIXTURE" config user.name 'Vaysen AI CRM Security Fixture'
git -C "$FIXTURE" config user.email 'security-fixture@localhost'
git -C "$FIXTURE" add -A
git -C "$FIXTURE" commit -qm 'secure fixture'

DEPLOY_OWNER="$FIXTURE_OWNER" DEPLOY_GROUP="$FIXTURE_GROUP" BACKUP_DIR="$BACKUPS" RELEASES_DIR="$RELEASES" APP_DATA_DIR="$APP_DATA" MIGRATION_REHEARSAL_DATA_ROOT="$REHEARSALS" \
    bash "$FIXTURE/scripts/deploy-security-preflight.sh" >/dev/null \
    || fail "secure fixture should pass permission preflight"
pass "secure owner/mode fixture passes"

printf 'fixture\r\n' > "$FIXTURE/deploy/openclaw/config/openclaw.production.json"
if DEPLOY_OWNER="$FIXTURE_OWNER" DEPLOY_GROUP="$FIXTURE_GROUP" BACKUP_DIR="$BACKUPS" RELEASES_DIR="$RELEASES" APP_DATA_DIR="$APP_DATA" MIGRATION_REHEARSAL_DATA_ROOT="$REHEARSALS" \
    bash "$FIXTURE/scripts/deploy-security-preflight.sh" >/dev/null 2>&1; then
    fail "raw CRLF worktree bytes must fail immutable deployment preflight"
fi
printf 'fixture\n' > "$FIXTURE/deploy/openclaw/config/openclaw.production.json"
pass "immutable byte preflight catches raw CRLF drift"

if DEPLOY_OWNER="$FIXTURE_OWNER" DEPLOY_GROUP="$FIXTURE_GROUP" BACKUP_DIR="$BACKUPS" RELEASES_DIR="$RELEASES" APP_DATA_DIR="$APP_DATA" MIGRATION_REHEARSAL_DATA_ROOT="$APP_DATA" \
    bash "$FIXTURE/scripts/deploy-security-preflight.sh" >/dev/null 2>&1; then
    fail "migration rehearsal data root must not overlap application data"
fi
pass "migration rehearsal storage must be an isolated path"

chmod 777 "$FIXTURE"
if DEPLOY_OWNER="$FIXTURE_OWNER" DEPLOY_GROUP="$FIXTURE_GROUP" BACKUP_DIR="$BACKUPS" RELEASES_DIR="$RELEASES" APP_DATA_DIR="$APP_DATA" MIGRATION_REHEARSAL_DATA_ROOT="$REHEARSALS" \
    bash "$FIXTURE/scripts/deploy-security-preflight.sh" >/dev/null 2>&1; then
    fail "world-writable project directory must fail permission preflight"
fi
chmod 750 "$FIXTURE"
chmod 644 "$FIXTURE/.env"
if DEPLOY_OWNER="$FIXTURE_OWNER" DEPLOY_GROUP="$FIXTURE_GROUP" BACKUP_DIR="$BACKUPS" RELEASES_DIR="$RELEASES" APP_DATA_DIR="$APP_DATA" MIGRATION_REHEARSAL_DATA_ROOT="$REHEARSALS" \
    bash "$FIXTURE/scripts/deploy-security-preflight.sh" >/dev/null 2>&1; then
    fail "world-readable environment file must fail permission preflight"
fi
pass "insecure directory and secret modes fail closed"

# Standalone rollback must reject a dirty high-privilege restore helper before
# it parses an environment or touches Docker. --help is intentionally used so
# the positive fixture needs no production secrets or running containers.
ROLLBACK_TRUST_FIXTURE="$TMP_ROOT/rollback-trust"
mkdir -p "$ROLLBACK_TRUST_FIXTURE/scripts" "$ROLLBACK_TRUST_FIXTURE/nginx/conf.d"
for trusted_path in scripts/rollback.sh scripts/compose-container-lifecycle.sh \
    scripts/validate-production-env.mjs scripts/verify-db-backup.sh \
    scripts/recreate-db-from-backup.sh scripts/restore-runtime-data.sh \
    scripts/runtime-restore-transaction.sh scripts/runtime-link-manifest.sh \
    scripts/runtime-link-contract.mjs scripts/run-runtime-link-contract.sh \
    scripts/rollback-smoke-test.sh docker-compose.prod.yml nginx/nginx.conf \
    nginx/conf.d/vaysen-crm-lan.conf; do
    mkdir -p "$ROLLBACK_TRUST_FIXTURE/$(dirname "$trusted_path")"
    cp "$PROJECT_DIR/$trusted_path" "$ROLLBACK_TRUST_FIXTURE/$trusted_path"
done
git -C "$ROLLBACK_TRUST_FIXTURE" init -q
git -C "$ROLLBACK_TRUST_FIXTURE" config user.name 'Vaysen AI CRM Rollback Trust Fixture'
git -C "$ROLLBACK_TRUST_FIXTURE" config user.email 'rollback-trust@localhost'
git -C "$ROLLBACK_TRUST_FIXTURE" add -A
git -C "$ROLLBACK_TRUST_FIXTURE" commit -qm 'immutable rollback trust fixture'
bash "$ROLLBACK_TRUST_FIXTURE/scripts/rollback.sh" --help >/dev/null \
    || fail "immutable standalone rollback trust fixture must accept --help"
printf 'dirty helper\n' >> "$ROLLBACK_TRUST_FIXTURE/scripts/runtime-link-contract.mjs"
if bash "$ROLLBACK_TRUST_FIXTURE/scripts/rollback.sh" --help >/dev/null 2>&1; then
    fail "standalone rollback trusted a dirty high-privilege restore helper"
fi
pass "standalone rollback trust chain rejects dirty restore helpers"

# A large archive used to make `grep -q` close its pipe early under pipefail,
# so valid top-level directories were reported missing only with real data.
RUNTIME_FIXTURE="$TMP_ROOT/runtime-large"
mkdir -p "$RUNTIME_FIXTURE/uploads" "$RUNTIME_FIXTURE/.customizer-assets" "$RUNTIME_FIXTURE/.whatsapp-sessions"
for i in $(seq 1 2500); do
    printf 'x' > "$RUNTIME_FIXTURE/uploads/file-${i}-abcdefghijklmnopqrstuvwxyz0123456789.txt"
done
RUNTIME_ARCHIVE="$TMP_ROOT/runtime-large.tar.gz"
tar -C "$RUNTIME_FIXTURE" -czf "$RUNTIME_ARCHIVE" uploads .customizer-assets .whatsapp-sessions
printf '%s  %s\n' "$(sha256sum "$RUNTIME_ARCHIVE" | cut -d' ' -f1)" "$(basename "$RUNTIME_ARCHIVE")" \
    > "$RUNTIME_ARCHIVE.sha256"
bash "$PROJECT_DIR/scripts/restore-runtime-data.sh" --check "$RUNTIME_ARCHIVE" >/dev/null \
    || fail "large valid runtime archive must pass without a pipefail/SIGPIPE false negative"

REGULAR_ROOT_ARCHIVE="$TMP_ROOT/runtime-regular-root.tar.gz"
"$PYTHON_SQLITE" - "$REGULAR_ROOT_ARCHIVE" <<'PY'
import io
import tarfile
import sys

with tarfile.open(sys.argv[1], 'w:gz') as archive:
    payload = b'not-a-directory\n'
    root = tarfile.TarInfo('uploads')
    root.size = len(payload)
    archive.addfile(root, io.BytesIO(payload))
    for name in ('.customizer-assets', '.whatsapp-sessions'):
        directory = tarfile.TarInfo(f'{name}/')
        directory.type = tarfile.DIRTYPE
        directory.mode = 0o700
        archive.addfile(directory)
PY
printf '%s  %s\n' "$(sha256sum "$REGULAR_ROOT_ARCHIVE" | cut -d' ' -f1)" "$(basename "$REGULAR_ROOT_ARCHIVE")" \
    > "$REGULAR_ROOT_ARCHIVE.sha256"
if bash "$PROJECT_DIR/scripts/restore-runtime-data.sh" --check "$REGULAR_ROOT_ARCHIVE" >/dev/null 2>&1; then
    fail "runtime archive trusted a regular file as the uploads root"
fi

ALIAS_DUPLICATE_ARCHIVE="$TMP_ROOT/runtime-alias-duplicate.tar.gz"
"$PYTHON_SQLITE" - "$ALIAS_DUPLICATE_ARCHIVE" <<'PY'
import io
import tarfile
import sys

with tarfile.open(sys.argv[1], 'w:gz') as archive:
    for name in ('uploads', '.customizer-assets', '.whatsapp-sessions'):
        directory = tarfile.TarInfo(f'{name}/')
        directory.type = tarfile.DIRTYPE
        directory.mode = 0o700
        archive.addfile(directory)
    for name in ('uploads/alias.txt', 'uploads//alias.txt'):
        payload = b'alias\n'
        item = tarfile.TarInfo(name)
        item.size = len(payload)
        archive.addfile(item, io.BytesIO(payload))
PY
printf '%s  %s\n' "$(sha256sum "$ALIAS_DUPLICATE_ARCHIVE" | cut -d' ' -f1)" "$(basename "$ALIAS_DUPLICATE_ARCHIVE")" \
    > "$ALIAS_DUPLICATE_ARCHIVE.sha256"
if bash "$PROJECT_DIR/scripts/restore-runtime-data.sh" --check "$ALIAS_DUPLICATE_ARCHIVE" >/dev/null 2>&1; then
    fail "runtime archive trusted two non-canonical aliases for the same path"
fi
ln -s forbidden "$RUNTIME_FIXTURE/uploads/unsafe-link"
UNSAFE_ARCHIVE="$TMP_ROOT/runtime-unsafe.tar.gz"
tar -C "$RUNTIME_FIXTURE" -czf "$UNSAFE_ARCHIVE" uploads .customizer-assets .whatsapp-sessions
printf '%s  %s\n' "$(sha256sum "$UNSAFE_ARCHIVE" | cut -d' ' -f1)" "$(basename "$UNSAFE_ARCHIVE")" \
    > "$UNSAFE_ARCHIVE.sha256"
if bash "$PROJECT_DIR/scripts/restore-runtime-data.sh" --check "$UNSAFE_ARCHIVE" >/dev/null 2>&1; then
    fail "runtime archive with a symlink must fail closed"
fi

# The exact production transaction helper must remove candidate OpenClaw
# state when restoring a verified legacy snapshot that predates OpenClaw.
RESTORE_TARGET="$TMP_ROOT/runtime-restore-target"
mkdir -p "$RESTORE_TARGET/uploads" "$RESTORE_TARGET/.customizer-assets" \
    "$RESTORE_TARGET/.whatsapp-sessions" "$RESTORE_TARGET/openclaw"
printf 'current-marker\n' > "$RESTORE_TARGET/.initialized-v1"
printf 'candidate-secret-state\n' > "$RESTORE_TARGET/openclaw/candidate.txt"
printf 'candidate-upload\n' > "$RESTORE_TARGET/uploads/candidate.txt"
sh "$PROJECT_DIR/scripts/runtime-restore-transaction.sh" \
    "$RESTORE_TARGET" "$RUNTIME_ARCHIVE" "$(id -u)" "$(id -g)" 0 "$(id -u)" "$(id -g)" \
    || fail "legacy exact restore transaction must succeed"
[ ! -e "$RESTORE_TARGET/openclaw" ] \
    || fail "legacy exact restore must remove candidate-created OpenClaw state"
[ ! -e "$RESTORE_TARGET/uploads/candidate.txt" ] \
    || fail "legacy exact restore must replace, not merge, candidate uploads"
[ -f "$RESTORE_TARGET/uploads/file-1-abcdefghijklmnopqrstuvwxyz0123456789.txt" ] \
    || fail "legacy exact restore did not install verified snapshot contents"

EMPTY_TXN_MISSING_ROOT="$TMP_ROOT/runtime-empty-txn-missing-root"
mkdir -p "$EMPTY_TXN_MISSING_ROOT/.customizer-assets" \
    "$EMPTY_TXN_MISSING_ROOT/.whatsapp-sessions" "$EMPTY_TXN_MISSING_ROOT/.restore-transaction"
printf 'current marker\n' > "$EMPTY_TXN_MISSING_ROOT/.initialized-v1"
if sh "$PROJECT_DIR/scripts/runtime-restore-transaction.sh" \
    "$EMPTY_TXN_MISSING_ROOT" "$RUNTIME_ARCHIVE" "$(id -u)" "$(id -g)" 0 "$(id -u)" "$(id -g)" \
    >/dev/null 2>&1; then
    fail "empty restore transaction masked a missing original uploads directory"
fi
[ ! -e "$EMPTY_TXN_MISSING_ROOT/uploads/file-1-abcdefghijklmnopqrstuvwxyz0123456789.txt" ] \
    || fail "empty restore transaction installed candidate data over a missing original root"

OPENCLAW_FIXTURE="$TMP_ROOT/runtime-openclaw"
mkdir -p "$OPENCLAW_FIXTURE/uploads" "$OPENCLAW_FIXTURE/.customizer-assets" \
    "$OPENCLAW_FIXTURE/.whatsapp-sessions" "$OPENCLAW_FIXTURE/openclaw/state"
printf 'protected-state\n' > "$OPENCLAW_FIXTURE/openclaw/state.json"
WEIXIN_LINK_REL='openclaw/npm/projects/tencent-weixin-openclaw-weixin-7783ac86ba/node_modules/@tencent-weixin/openclaw-weixin/node_modules/openclaw'
CRM_LINK_REL='openclaw/npm/projects/vaysen-openclaw-crm-tools-f0ac731cd3/node_modules/@vaysen/openclaw-crm-tools/node_modules/openclaw'
WEIXIN_PACKAGE_REL="${WEIXIN_LINK_REL%/node_modules/openclaw}"
CRM_PACKAGE_REL="${CRM_LINK_REL%/node_modules/openclaw}"
mkdir -p "$OPENCLAW_FIXTURE/$WEIXIN_PACKAGE_REL" "$OPENCLAW_FIXTURE/$CRM_PACKAGE_REL"
printf '{"name":"@tencent-weixin/openclaw-weixin","version":"2.4.6"}\n' \
    > "$OPENCLAW_FIXTURE/$WEIXIN_PACKAGE_REL/package.json"
printf '{"name":"@vaysen/openclaw-crm-tools","version":"1.2.0"}\n' \
    > "$OPENCLAW_FIXTURE/$CRM_PACKAGE_REL/package.json"
"$PYTHON_SQLITE" - "$OPENCLAW_FIXTURE/openclaw/state/openclaw.sqlite" <<'PY'
import json
import sqlite3
import sys

database = sqlite3.connect(sys.argv[1])
database.execute('CREATE TABLE installed_plugin_index (index_key TEXT PRIMARY KEY, install_records_json TEXT NOT NULL)')
records = {
    'vaysen-crm': {
        'source': 'npm',
        'spec': '@vaysen/openclaw-crm-tools@1.2.0',
        'installPath': '/home/node/.openclaw/npm/projects/vaysen-openclaw-crm-tools-f0ac731cd3/node_modules/@vaysen/openclaw-crm-tools',
        'version': '1.2.0',
        'resolvedName': '@vaysen/openclaw-crm-tools',
        'resolvedVersion': '1.2.0',
        'resolvedSpec': '@vaysen/openclaw-crm-tools@1.2.0',
    },
    'openclaw-weixin': {
        'source': 'npm',
        'spec': '@tencent-weixin/openclaw-weixin@2.4.6',
        'installPath': '/home/node/.openclaw/npm/projects/tencent-weixin-openclaw-weixin-7783ac86ba/node_modules/@tencent-weixin/openclaw-weixin',
        'version': '2.4.6',
        'resolvedName': '@tencent-weixin/openclaw-weixin',
        'resolvedVersion': '2.4.6',
        'resolvedSpec': '@tencent-weixin/openclaw-weixin@2.4.6',
    },
}
database.execute(
    'INSERT INTO installed_plugin_index (index_key, install_records_json) VALUES (?, ?)',
    ('installed-plugin-index', json.dumps(records, separators=(',', ':'))),
)
database.commit()
database.close()
PY
OPENCLAW_ARCHIVE="$TMP_ROOT/runtime-openclaw.tar.gz"
tar -C "$OPENCLAW_FIXTURE" -czf "$OPENCLAW_ARCHIVE" uploads .customizer-assets .whatsapp-sessions openclaw
printf '%s  %s\n' "$(sha256sum "$OPENCLAW_ARCHIVE" | cut -d' ' -f1)" "$(basename "$OPENCLAW_ARCHIVE")" \
    > "$OPENCLAW_ARCHIVE.sha256"
if bash "$PROJECT_DIR/scripts/restore-runtime-data.sh" --check "$OPENCLAW_ARCHIVE" >/dev/null 2>&1; then
    fail "OpenClaw archive without the exact peer-link manifest must fail closed"
fi

printf '%s\n%s\n' "$WEIXIN_LINK_REL" "$CRM_LINK_REL" > "$OPENCLAW_FIXTURE/.vaysen-crm-runtime-links-v1"
MISSING_PARENT_ARCHIVE="$TMP_ROOT/runtime-openclaw-missing-link-parent.tar.gz"
tar -C "$OPENCLAW_FIXTURE" -czf "$MISSING_PARENT_ARCHIVE" \
    uploads .customizer-assets .whatsapp-sessions openclaw .vaysen-crm-runtime-links-v1
printf '%s  %s\n' "$(sha256sum "$MISSING_PARENT_ARCHIVE" | cut -d' ' -f1)" "$(basename "$MISSING_PARENT_ARCHIVE")" \
    > "$MISSING_PARENT_ARCHIVE.sha256"
if bash "$PROJECT_DIR/scripts/restore-runtime-data.sh" --check "$MISSING_PARENT_ARCHIVE" >/dev/null 2>&1; then
    fail "peer-link manifest whose archive parents are missing must fail during --check"
fi
mkdir -p "$OPENCLAW_FIXTURE/${WEIXIN_LINK_REL%/*}" "$OPENCLAW_FIXTURE/${CRM_LINK_REL%/*}"
printf '%s\n%s\n' "$WEIXIN_LINK_REL" "$CRM_LINK_REL" > "$OPENCLAW_FIXTURE/.vaysen-crm-runtime-links-v1"
mkdir -p "$OPENCLAW_FIXTURE/$WEIXIN_LINK_REL"
printf 'must-not-be-archived-below-a-peer-link\n' > "$OPENCLAW_FIXTURE/$WEIXIN_LINK_REL/descendant.txt"
PEER_DESCENDANT_ARCHIVE="$TMP_ROOT/runtime-openclaw-peer-descendant.tar.gz"
tar -C "$OPENCLAW_FIXTURE" -czf "$PEER_DESCENDANT_ARCHIVE" \
    uploads .customizer-assets .whatsapp-sessions openclaw .vaysen-crm-runtime-links-v1
printf '%s  %s\n' "$(sha256sum "$PEER_DESCENDANT_ARCHIVE" | cut -d' ' -f1)" "$(basename "$PEER_DESCENDANT_ARCHIVE")" \
    > "$PEER_DESCENDANT_ARCHIVE.sha256"
if bash "$PROJECT_DIR/scripts/restore-runtime-data.sh" --check "$PEER_DESCENDANT_ARCHIVE" >/dev/null 2>&1; then
    fail "archive entries below a reconstructed peer-link path must fail during --check"
fi
rm -rf "$OPENCLAW_FIXTURE/$WEIXIN_LINK_REL"
ENCODED_LINK_ARCHIVE="$TMP_ROOT/runtime-openclaw-encoded-links.tar.gz"
tar -C "$OPENCLAW_FIXTURE" -czf "$ENCODED_LINK_ARCHIVE" \
    uploads .customizer-assets .whatsapp-sessions openclaw .vaysen-crm-runtime-links-v1
printf '%s  %s\n' "$(sha256sum "$ENCODED_LINK_ARCHIVE" | cut -d' ' -f1)" "$(basename "$ENCODED_LINK_ARCHIVE")" \
    > "$ENCODED_LINK_ARCHIVE.sha256"
bash "$PROJECT_DIR/scripts/restore-runtime-data.sh" --check "$ENCODED_LINK_ARCHIVE" >/dev/null \
    || fail "encoded reviewed OpenClaw peer links must pass archive validation"

# v1 remains read-only compatible, but a single archive may never carry both
# v1 and v2 because that would make the reconstruction authority ambiguous.
bash "$PROJECT_DIR/scripts/run-runtime-link-contract.sh" emit-v2 "$OPENCLAW_FIXTURE/openclaw" \
    > "$OPENCLAW_FIXTURE/.vaysen-crm-runtime-links-v2.json"
DUAL_MANIFEST_ARCHIVE="$TMP_ROOT/runtime-openclaw-dual-manifest.tar.gz"
tar -C "$OPENCLAW_FIXTURE" -czf "$DUAL_MANIFEST_ARCHIVE" \
    uploads .customizer-assets .whatsapp-sessions openclaw \
    .vaysen-crm-runtime-links-v1 .vaysen-crm-runtime-links-v2.json
printf '%s  %s\n' "$(sha256sum "$DUAL_MANIFEST_ARCHIVE" | cut -d' ' -f1)" "$(basename "$DUAL_MANIFEST_ARCHIVE")" \
    > "$DUAL_MANIFEST_ARCHIVE.sha256"
if bash "$PROJECT_DIR/scripts/restore-runtime-data.sh" --check "$DUAL_MANIFEST_ARCHIVE" >/dev/null 2>&1; then
    fail "OpenClaw archive carrying both v1 and v2 manifests must fail closed"
fi

# A syntactically valid generation path is not trusted unless the snapshot's
# SQLite installPath selects that exact generation.
node - "$OPENCLAW_FIXTURE/.vaysen-crm-runtime-links-v2.json" <<'NODE'
const fs = require('fs');
const file = process.argv[2];
const manifest = JSON.parse(fs.readFileSync(file, 'utf8'));
manifest.links[0].relativePath = manifest.links[0].relativePath.replace(
  'vaysen-openclaw-crm-tools-f0ac731cd3/',
  'vaysen-openclaw-crm-tools-f0ac731cd3__openclaw-generation__g-0123456789abcdef/',
);
fs.writeFileSync(file, `${JSON.stringify(manifest, null, 2)}\n`);
NODE
SQLITE_MISMATCH_ARCHIVE="$TMP_ROOT/runtime-openclaw-sqlite-mismatch.tar.gz"
tar -C "$OPENCLAW_FIXTURE" -czf "$SQLITE_MISMATCH_ARCHIVE" \
    uploads .customizer-assets .whatsapp-sessions openclaw .vaysen-crm-runtime-links-v2.json
printf '%s  %s\n' "$(sha256sum "$SQLITE_MISMATCH_ARCHIVE" | cut -d' ' -f1)" "$(basename "$SQLITE_MISMATCH_ARCHIVE")" \
    > "$SQLITE_MISMATCH_ARCHIVE.sha256"
if bash "$PROJECT_DIR/scripts/restore-runtime-data.sh" --check "$SQLITE_MISMATCH_ARCHIVE" >/dev/null 2>&1; then
    fail "generation-shaped manifest not selected by SQLite must fail closed"
fi
rm -f "$OPENCLAW_FIXTURE/.vaysen-crm-runtime-links-v2.json"

# R14 failed here in production: the backup/restore consumers understood the
# encoded manifest, but prepare-runtime-data still rejected it as an unknown
# top-level path. An already initialized target must accept the same shared
# validation contract and preserve every current byte. It may use the reviewed
# read-only SQLite helper, but must never start the writable transaction helper.
PREPARE_EXISTING_TARGET="$TMP_ROOT/runtime-prepare-existing"
PREPARE_DOCKER_BIN="$TMP_ROOT/runtime-prepare-bin"
PREPARE_TRANSACTION_CALLED="$TMP_ROOT/runtime-prepare-transaction-called"
mkdir -p "$PREPARE_EXISTING_TARGET/uploads" "$PREPARE_EXISTING_TARGET/.customizer-assets" \
    "$PREPARE_EXISTING_TARGET/.whatsapp-sessions" "$PREPARE_EXISTING_TARGET/openclaw" "$PREPARE_DOCKER_BIN"
cp -a "$OPENCLAW_FIXTURE/openclaw/." "$PREPARE_EXISTING_TARGET/openclaw/"
ln -s /app "$PREPARE_EXISTING_TARGET/${WEIXIN_LINK_REL}"
ln -s /app "$PREPARE_EXISTING_TARGET/${CRM_LINK_REL}"
PREPARE_REAL_DOCKER="$(command -v docker || true)"
PREPARE_OPENCLAW_IMAGE="${OPENCLAW_CONTRACT_TEST_IMAGE:-}"
if ! node --no-warnings -e "require('node:sqlite')" >/dev/null 2>&1; then
    [ -n "$PREPARE_REAL_DOCKER" ] \
        || fail "SQLite contract tests require Node >=22 or Docker with the reviewed OpenClaw image"
    if [ -z "$PREPARE_OPENCLAW_IMAGE" ]; then
        PREPARE_OPENCLAW_IMAGE="$($PREPARE_REAL_DOCKER inspect -f '{{.Image}}' vaysen-crm-openclaw-gateway 2>/dev/null || true)"
    fi
    [ -n "$PREPARE_OPENCLAW_IMAGE" ] \
        || fail "SQLite contract tests could not resolve the reviewed OpenClaw image"
fi
cat > "$PREPARE_DOCKER_BIN/docker" <<'SH'
#!/usr/bin/env sh
set -eu
for argument in "$@"; do
  if [ "$argument" = "$PREPARE_EXISTING_TARGET:/target" ] \
      && [ "${ALLOW_TARGET_TRANSACTION:-false}" != true ]; then
    : > "$PREPARE_TRANSACTION_CALLED"
    exit 97
  fi
done
[ -n "${PREPARE_REAL_DOCKER:-}" ] || exit 96
exec "$PREPARE_REAL_DOCKER" "$@"
SH
chmod 750 "$PREPARE_DOCKER_BIN/docker"
printf 'initialized\n' > "$PREPARE_EXISTING_TARGET/.initialized-v1"
printf 'preserve-upload\n' > "$PREPARE_EXISTING_TARGET/uploads/current.txt"
printf 'preserve-openclaw\n' > "$PREPARE_EXISTING_TARGET/openclaw/current.txt"
chmod 700 "$PREPARE_EXISTING_TARGET/uploads" "$PREPARE_EXISTING_TARGET/.customizer-assets" \
    "$PREPARE_EXISTING_TARGET/.whatsapp-sessions" "$PREPARE_EXISTING_TARGET/openclaw"
chmod 600 "$PREPARE_EXISTING_TARGET/.initialized-v1"
PATH="$PREPARE_DOCKER_BIN:$PATH" PREPARE_REAL_DOCKER="$PREPARE_REAL_DOCKER" \
    PREPARE_EXISTING_TARGET="$PREPARE_EXISTING_TARGET" PREPARE_TRANSACTION_CALLED="$PREPARE_TRANSACTION_CALLED" \
    APP_DATA_DIR="$PREPARE_EXISTING_TARGET" APP_DATA_UID="$(id -u)" APP_DATA_GID="$(id -g)" \
    OPENCLAW_DATA_UID="$(id -u)" OPENCLAW_DATA_GID="$(id -g)" NODE_IMAGE=unused:fixture \
    OPENCLAW_IMAGE="$PREPARE_OPENCLAW_IMAGE" \
    bash "$PROJECT_DIR/scripts/prepare-runtime-data.sh" "$ENCODED_LINK_ARCHIVE" >/dev/null \
    || fail "initialized runtime prepare must accept an encoded peer-link snapshot"
[ "$(cat "$PREPARE_EXISTING_TARGET/uploads/current.txt")" = preserve-upload ] \
    && [ "$(cat "$PREPARE_EXISTING_TARGET/openclaw/current.txt")" = preserve-openclaw ] \
    || fail "initialized runtime prepare overwrote current data"
[ ! -e "$PREPARE_TRANSACTION_CALLED" ] \
    || fail "initialized runtime prepare invoked the writable transaction helper"
rm -f "$PREPARE_EXISTING_TARGET/${CRM_LINK_REL}"
if PATH="$PREPARE_DOCKER_BIN:$PATH" PREPARE_REAL_DOCKER="$PREPARE_REAL_DOCKER" \
    PREPARE_EXISTING_TARGET="$PREPARE_EXISTING_TARGET" PREPARE_TRANSACTION_CALLED="$PREPARE_TRANSACTION_CALLED" \
    APP_DATA_DIR="$PREPARE_EXISTING_TARGET" APP_DATA_UID="$(id -u)" APP_DATA_GID="$(id -g)" \
    OPENCLAW_DATA_UID="$(id -u)" OPENCLAW_DATA_GID="$(id -g)" NODE_IMAGE=unused:fixture \
    OPENCLAW_IMAGE="$PREPARE_OPENCLAW_IMAGE" \
    bash "$PROJECT_DIR/scripts/prepare-runtime-data.sh" "$ENCODED_LINK_ARCHIVE" >/dev/null 2>&1; then
    fail "initialized runtime prepare trusted a missing SQLite-selected peer link"
fi
ln -s /app "$PREPARE_EXISTING_TARGET/${CRM_LINK_REL}"

PREPARE_SYMLINK_MARKER_TARGET="$TMP_ROOT/runtime-prepare-symlink-marker"
mkdir -p "$PREPARE_SYMLINK_MARKER_TARGET/uploads" "$PREPARE_SYMLINK_MARKER_TARGET/.customizer-assets" \
    "$PREPARE_SYMLINK_MARKER_TARGET/.whatsapp-sessions" "$PREPARE_SYMLINK_MARKER_TARGET/openclaw"
printf 'forbidden-marker-target\n' > "$TMP_ROOT/marker-target"
ln -s "$TMP_ROOT/marker-target" "$PREPARE_SYMLINK_MARKER_TARGET/.initialized-v1"
chmod 700 "$PREPARE_SYMLINK_MARKER_TARGET/uploads" "$PREPARE_SYMLINK_MARKER_TARGET/.customizer-assets" \
    "$PREPARE_SYMLINK_MARKER_TARGET/.whatsapp-sessions" "$PREPARE_SYMLINK_MARKER_TARGET/openclaw"
if PATH="$PREPARE_DOCKER_BIN:$PATH" PREPARE_REAL_DOCKER="$PREPARE_REAL_DOCKER" \
    PREPARE_EXISTING_TARGET="$PREPARE_SYMLINK_MARKER_TARGET" PREPARE_TRANSACTION_CALLED="$PREPARE_TRANSACTION_CALLED" \
    APP_DATA_DIR="$PREPARE_SYMLINK_MARKER_TARGET" APP_DATA_UID="$(id -u)" APP_DATA_GID="$(id -g)" \
    OPENCLAW_DATA_UID="$(id -u)" OPENCLAW_DATA_GID="$(id -g)" NODE_IMAGE=unused:fixture \
    OPENCLAW_IMAGE="$PREPARE_OPENCLAW_IMAGE" \
    bash "$PROJECT_DIR/scripts/prepare-runtime-data.sh" "$ENCODED_LINK_ARCHIVE" >/dev/null 2>&1; then
    fail "runtime prepare trusted a symlinked initialization marker"
fi

# Exercise the real wrapper, not only the transaction helper: an interruption
# after the first old directory was moved must reach helper re-entry and finish
# a clean restore instead of failing forever on the temporarily missing root.
if [ -z "$PREPARE_OPENCLAW_IMAGE" ] && [ -n "$PREPARE_REAL_DOCKER" ]; then
    PREPARE_OPENCLAW_IMAGE="$($PREPARE_REAL_DOCKER inspect -f '{{.Image}}' vaysen-crm-openclaw-gateway 2>/dev/null || true)"
fi
[ -n "$PREPARE_REAL_DOCKER" ] && [ -n "$PREPARE_OPENCLAW_IMAGE" ] \
    || fail "wrapper-level restore re-entry test requires Docker and the reviewed OpenClaw image"
WRAPPER_REENTRY_SOURCE="$TMP_ROOT/runtime-wrapper-reentry-source"
WRAPPER_REENTRY_TARGET="$TMP_ROOT/runtime-wrapper-reentry-target"
WRAPPER_REENTRY_ARCHIVE="$TMP_ROOT/runtime-wrapper-reentry.tar.gz"
mkdir -p "$WRAPPER_REENTRY_SOURCE/uploads" "$WRAPPER_REENTRY_SOURCE/.customizer-assets" \
    "$WRAPPER_REENTRY_SOURCE/.whatsapp-sessions" "$WRAPPER_REENTRY_TARGET/uploads" \
    "$WRAPPER_REENTRY_TARGET/.customizer-assets" "$WRAPPER_REENTRY_TARGET/.whatsapp-sessions" \
    "$WRAPPER_REENTRY_TARGET/.restore-transaction/old" "$WRAPPER_REENTRY_TARGET/.restore-transaction/new"
printf 'replacement\n' > "$WRAPPER_REENTRY_SOURCE/uploads/replacement.txt"
tar -C "$WRAPPER_REENTRY_SOURCE" -czf "$WRAPPER_REENTRY_ARCHIVE" \
    uploads .customizer-assets .whatsapp-sessions
printf '%s  %s\n' "$(sha256sum "$WRAPPER_REENTRY_ARCHIVE" | cut -d' ' -f1)" "$(basename "$WRAPPER_REENTRY_ARCHIVE")" \
    > "$WRAPPER_REENTRY_ARCHIVE.sha256"
printf 'current marker\n' > "$WRAPPER_REENTRY_TARGET/.initialized-v1"
printf 'old upload\n' > "$WRAPPER_REENTRY_TARGET/uploads/old.txt"
cp "$WRAPPER_REENTRY_TARGET/.initialized-v1" "$WRAPPER_REENTRY_TARGET/.restore-transaction/marker"
printf 'uploads\n.customizer-assets\n.whatsapp-sessions\n' \
    > "$WRAPPER_REENTRY_TARGET/.restore-transaction/original-dirs"
mv "$WRAPPER_REENTRY_TARGET/uploads" "$WRAPPER_REENTRY_TARGET/.restore-transaction/old/uploads"
PATH="$PREPARE_DOCKER_BIN:$PATH" PREPARE_REAL_DOCKER="$PREPARE_REAL_DOCKER" \
    PREPARE_EXISTING_TARGET="$WRAPPER_REENTRY_TARGET" PREPARE_TRANSACTION_CALLED="$PREPARE_TRANSACTION_CALLED" \
    ALLOW_TARGET_TRANSACTION=true \
    APP_DATA_DIR="$WRAPPER_REENTRY_TARGET" APP_DATA_UID="$(id -u)" APP_DATA_GID="$(id -g)" \
    OPENCLAW_DATA_UID="$(id -u)" OPENCLAW_DATA_GID="$(id -g)" NODE_IMAGE=unused:fixture \
    OPENCLAW_IMAGE="$PREPARE_OPENCLAW_IMAGE" BACKEND_CONTAINER=missing-backend OPENCLAW_CONTAINER=missing-openclaw \
    bash "$PROJECT_DIR/scripts/restore-runtime-data.sh" "$WRAPPER_REENTRY_ARCHIVE" >/dev/null \
    || fail "runtime restore wrapper did not recover an interrupted partial move"
[ -f "$WRAPPER_REENTRY_TARGET/uploads/replacement.txt" ] \
    && [ ! -e "$WRAPPER_REENTRY_TARGET/.restore-transaction" ] \
    || fail "runtime restore wrapper re-entry did not commit and clean the replacement tree"

# A genuinely empty host must install the regular tree, reconstruct exactly
# the two reviewed /app links after chown, and consume the internal manifest.
INITIALIZE_PRESTATE_TARGET="$TMP_ROOT/runtime-initialize-prestate-reentry"
mkdir -p "$INITIALIZE_PRESTATE_TARGET/.prepare-new"
sh "$PROJECT_DIR/scripts/runtime-initialize-transaction.sh" \
    "$INITIALIZE_PRESTATE_TARGET" "$ENCODED_LINK_ARCHIVE" "$(id -u)" "$(id -g)" 1 "$(id -u)" "$(id -g)" \
    || fail "empty pre-state initialization transaction did not cleanly retry"
[ -f "$INITIALIZE_PRESTATE_TARGET/.initialized-v1" ] \
    && [ ! -e "$INITIALIZE_PRESTATE_TARGET/.prepare-new" ] \
    || fail "empty pre-state initialization recovery leaked transaction state"

INITIALIZE_PRESTATE_UNSAFE_TARGET="$TMP_ROOT/runtime-initialize-prestate-unsafe"
mkdir -p "$INITIALIZE_PRESTATE_UNSAFE_TARGET/.prepare-new" \
    "$INITIALIZE_PRESTATE_UNSAFE_TARGET/uploads"
printf 'must-preserve\n' > "$INITIALIZE_PRESTATE_UNSAFE_TARGET/uploads/evidence.txt"
if sh "$PROJECT_DIR/scripts/runtime-initialize-transaction.sh" \
    "$INITIALIZE_PRESTATE_UNSAFE_TARGET" "$ENCODED_LINK_ARCHIVE" "$(id -u)" "$(id -g)" 1 "$(id -u)" "$(id -g)" \
    >/dev/null 2>&1; then
    fail "missing initialize state with business data was guessed instead of failing closed"
fi
[ "$(cat "$INITIALIZE_PRESTATE_UNSAFE_TARGET/uploads/evidence.txt")" = must-preserve ] \
    && [ -d "$INITIALIZE_PRESTATE_UNSAFE_TARGET/.prepare-new" ] \
    || fail "unsafe pre-state initialization recovery changed inspection evidence"

INITIALIZE_TARGET="$TMP_ROOT/runtime-initialize-target"
mkdir -p "$INITIALIZE_TARGET"
sh "$PROJECT_DIR/scripts/runtime-initialize-transaction.sh" \
    "$INITIALIZE_TARGET" "$ENCODED_LINK_ARCHIVE" "$(id -u)" "$(id -g)" 1 "$(id -u)" "$(id -g)" \
    || fail "encoded OpenClaw first-run initialization must succeed"
[ "$(readlink "$INITIALIZE_TARGET/$WEIXIN_LINK_REL")" = /app ] \
    || fail "first-run initialization did not reconstruct the Weixin peer link"
[ "$(readlink "$INITIALIZE_TARGET/$CRM_LINK_REL")" = /app ] \
    || fail "first-run initialization did not reconstruct the CRM peer link"
[ "$(find "$INITIALIZE_TARGET/openclaw" -type l | wc -l | tr -d ' ')" -eq 2 ] \
    || fail "first-run initialization reconstructed an unexpected link count"
[ -f "$INITIALIZE_TARGET/.initialized-v1" ] \
    && [ ! -e "$INITIALIZE_TARGET/.vaysen-crm-runtime-links-v1" ] \
    && [ ! -e "$INITIALIZE_TARGET/.prepare-new" ] \
    || fail "first-run initialization leaked internal transaction state"

# Simulate SIGKILL after the new runtime directories/marker are visible but
# before the committed sentinel exists. Re-entry cannot rely on an EXIT trap:
# it must roll the fixed target back to empty and perform a clean retry.
INITIALIZE_UNCOMMITTED_TARGET="$TMP_ROOT/runtime-initialize-uncommitted-reentry"
mkdir -p "$INITIALIZE_UNCOMMITTED_TARGET/uploads" \
    "$INITIALIZE_UNCOMMITTED_TARGET/.customizer-assets" \
    "$INITIALIZE_UNCOMMITTED_TARGET/.whatsapp-sessions" \
    "$INITIALIZE_UNCOMMITTED_TARGET/openclaw" \
    "$INITIALIZE_UNCOMMITTED_TARGET/.prepare-new"
printf 'partial-after-power-loss\n' > "$INITIALIZE_UNCOMMITTED_TARGET/uploads/partial.txt"
printf 'partial-marker\n' > "$INITIALIZE_UNCOMMITTED_TARGET/.initialized-v1"
printf '1\n' > "$INITIALIZE_UNCOMMITTED_TARGET/.prepare-new/.initialize-state-v1"
sh "$PROJECT_DIR/scripts/runtime-initialize-transaction.sh" \
    "$INITIALIZE_UNCOMMITTED_TARGET" "$ENCODED_LINK_ARCHIVE" "$(id -u)" "$(id -g)" 1 "$(id -u)" "$(id -g)" \
    || fail "uncommitted first-run initialization did not recover and retry"
[ ! -e "$INITIALIZE_UNCOMMITTED_TARGET/uploads/partial.txt" ] \
    && [ "$(readlink "$INITIALIZE_UNCOMMITTED_TARGET/$WEIXIN_LINK_REL")" = /app ] \
    && [ -f "$INITIALIZE_UNCOMMITTED_TARGET/.initialized-v1" ] \
    && [ ! -e "$INITIALIZE_UNCOMMITTED_TARGET/.prepare-new" ] \
    || fail "uncommitted first-run re-entry exposed partial runtime state"

# Simulate SIGKILL after the durable commit decision but before txn cleanup.
# Even a corrupt retry archive must not reverse or overwrite the committed tree.
mkdir -p "$INITIALIZE_TARGET/.prepare-new"
printf '1\n' > "$INITIALIZE_TARGET/.prepare-new/.initialize-state-v1"
printf '1\n' > "$INITIALIZE_TARGET/.prepare-new/committed"
INITIALIZE_CORRUPT_ARCHIVE="$TMP_ROOT/runtime-initialize-corrupt.tar.gz"
printf 'not-a-tar\n' > "$INITIALIZE_CORRUPT_ARCHIVE"
printf 'preserve-committed\n' > "$INITIALIZE_TARGET/uploads/committed.txt"
sh "$PROJECT_DIR/scripts/runtime-initialize-transaction.sh" \
    "$INITIALIZE_TARGET" "$INITIALIZE_CORRUPT_ARCHIVE" "$(id -u)" "$(id -g)" 1 "$(id -u)" "$(id -g)" \
    || fail "committed first-run initialization re-entry did not clean stale txn state"
[ "$(cat "$INITIALIZE_TARGET/uploads/committed.txt")" = preserve-committed ] \
    && [ ! -e "$INITIALIZE_TARGET/.prepare-new" ] \
    || fail "committed first-run re-entry changed the installed runtime tree"

# Cleanup removes the state file before the committed sentinel. Re-entry from
# that exact durable boundary must still preserve the installed tree.
mkdir -p "$INITIALIZE_TARGET/.prepare-new"
printf '1\n' > "$INITIALIZE_TARGET/.prepare-new/committed"
sh "$PROJECT_DIR/scripts/runtime-initialize-transaction.sh" \
    "$INITIALIZE_TARGET" "$INITIALIZE_CORRUPT_ARCHIVE" "$(id -u)" "$(id -g)" 1 "$(id -u)" "$(id -g)" \
    || fail "initialize cleanup boundary without state did not preserve the committed tree"
[ "$(cat "$INITIALIZE_TARGET/uploads/committed.txt")" = preserve-committed ] \
    && [ ! -e "$INITIALIZE_TARGET/.prepare-new" ] \
    || fail "initialize ordered cleanup boundary changed committed runtime data"

# Interrupt the second directory commit after uploads has moved. The helper's
# transaction trap must remove the first move and every hidden/internal file.
INITIALIZE_FAIL_TARGET="$TMP_ROOT/runtime-initialize-fail-target"
INITIALIZE_MV_BIN="$TMP_ROOT/runtime-initialize-mv-bin"
INITIALIZE_MV_HIT="$TMP_ROOT/runtime-initialize-mv-hit"
mkdir -p "$INITIALIZE_FAIL_TARGET" "$INITIALIZE_MV_BIN"
REAL_MV="$(command -v mv)"
cat > "$INITIALIZE_MV_BIN/mv" <<'SH'
#!/usr/bin/env sh
set -eu
case "${1:-}" in
  */.prepare-new/.customizer-assets)
    case "${2:-}" in
      */.customizer-assets)
        : > "$INITIALIZE_MV_HIT"
        exit 98
        ;;
    esac
    ;;
esac
exec "$REAL_MV" "$@"
SH
chmod 750 "$INITIALIZE_MV_BIN/mv"
if PATH="$INITIALIZE_MV_BIN:$PATH" REAL_MV="$REAL_MV" INITIALIZE_MV_HIT="$INITIALIZE_MV_HIT" \
    sh "$PROJECT_DIR/scripts/runtime-initialize-transaction.sh" \
        "$INITIALIZE_FAIL_TARGET" "$ENCODED_LINK_ARCHIVE" "$(id -u)" "$(id -g)" 1 "$(id -u)" "$(id -g)" \
        >/dev/null 2>&1; then
    fail "first-run initialization unexpectedly survived a partial move failure"
fi
[ -f "$INITIALIZE_MV_HIT" ] \
    || fail "first-run partial-move failure injection did not execute"
[ -z "$(find "$INITIALIZE_FAIL_TARGET" -mindepth 1 -print -quit)" ] \
    || fail "failed first-run initialization left partial runtime state"

# The marker rename is the last commit boundary. If it fails after all four
# directories moved, the initializer must still return to a completely empty
# target rather than expose an unmarked partial installation.
INITIALIZE_MARKER_FAIL_TARGET="$TMP_ROOT/runtime-initialize-marker-fail-target"
INITIALIZE_MARKER_MV_BIN="$TMP_ROOT/runtime-initialize-marker-mv-bin"
mkdir -p "$INITIALIZE_MARKER_FAIL_TARGET" "$INITIALIZE_MARKER_MV_BIN"
cat > "$INITIALIZE_MARKER_MV_BIN/mv" <<'SH'
#!/usr/bin/env sh
set -eu
case "${2:-}" in
  */.initialized-v1) exit 99 ;;
esac
exec "$REAL_MV" "$@"
SH
chmod 750 "$INITIALIZE_MARKER_MV_BIN/mv"
if PATH="$INITIALIZE_MARKER_MV_BIN:$PATH" REAL_MV="$REAL_MV" \
    sh "$PROJECT_DIR/scripts/runtime-initialize-transaction.sh" \
        "$INITIALIZE_MARKER_FAIL_TARGET" "$ENCODED_LINK_ARCHIVE" "$(id -u)" "$(id -g)" 1 "$(id -u)" "$(id -g)" \
        >/dev/null 2>&1; then
    fail "first-run initialization unexpectedly survived marker commit failure"
fi
[ -z "$(find "$INITIALIZE_MARKER_FAIL_TARGET" -mindepth 1 -print -quit)" ] \
    || fail "marker commit failure left partial runtime state"

INITIALIZE_PARENT_FAIL_TARGET="$TMP_ROOT/runtime-initialize-parent-fail-target"
mkdir -p "$INITIALIZE_PARENT_FAIL_TARGET"
if sh "$PROJECT_DIR/scripts/runtime-initialize-transaction.sh" \
    "$INITIALIZE_PARENT_FAIL_TARGET" "$MISSING_PARENT_ARCHIVE" "$(id -u)" "$(id -g)" 1 "$(id -u)" "$(id -g)" \
    >/dev/null 2>&1; then
    fail "first-run initialization accepted an archive with missing peer-link parents"
fi
[ -z "$(find "$INITIALIZE_PARENT_FAIL_TARGET" -mindepth 1 -print -quit)" ] \
    || fail "invalid peer-link parent failure left initialization residue"

ENCODED_RESTORE_TARGET="$TMP_ROOT/runtime-encoded-restore-target"
mkdir -p "$ENCODED_RESTORE_TARGET/uploads" "$ENCODED_RESTORE_TARGET/.customizer-assets" \
    "$ENCODED_RESTORE_TARGET/.whatsapp-sessions" "$ENCODED_RESTORE_TARGET/openclaw"
printf 'current-marker\n' > "$ENCODED_RESTORE_TARGET/.initialized-v1"
sh "$PROJECT_DIR/scripts/runtime-restore-transaction.sh" \
    "$ENCODED_RESTORE_TARGET" "$ENCODED_LINK_ARCHIVE" "$(id -u)" "$(id -g)" 1 "$(id -u)" "$(id -g)" \
    || fail "encoded OpenClaw peer-link restore transaction must succeed"
[ "$(readlink "$ENCODED_RESTORE_TARGET/$WEIXIN_LINK_REL")" = /app ] \
    || fail "Weixin peer link was not reconstructed with the fixed target"
[ "$(readlink "$ENCODED_RESTORE_TARGET/$CRM_LINK_REL")" = /app ] \
    || fail "CRM peer link was not reconstructed with the fixed target"
[ "$(find "$ENCODED_RESTORE_TARGET/openclaw" -type l | wc -l | tr -d ' ')" -eq 2 ] \
    || fail "encoded OpenClaw restore reconstructed an unexpected link count"
[ ! -e "$ENCODED_RESTORE_TARGET/.vaysen-crm-runtime-links-v1" ] \
    || fail "internal peer-link manifest leaked into restored runtime state"

# Re-entry must use the durable committed sentinel, not the presence of old
# directories. A stale txn/old after a successful restore is cleanup-only;
# without the sentinel, the exact recorded old tree must be restored.
COMMITTED_REENTRY_TARGET="$TMP_ROOT/runtime-restore-committed-reentry"
mkdir -p "$COMMITTED_REENTRY_TARGET/uploads" "$COMMITTED_REENTRY_TARGET/.customizer-assets" \
    "$COMMITTED_REENTRY_TARGET/.whatsapp-sessions" \
    "$COMMITTED_REENTRY_TARGET/.restore-transaction/old/uploads"
printf 'new-upload\n' > "$COMMITTED_REENTRY_TARGET/uploads/new.txt"
printf 'new-marker\n' > "$COMMITTED_REENTRY_TARGET/.initialized-v1"
printf 'old-upload\n' > "$COMMITTED_REENTRY_TARGET/.restore-transaction/old/uploads/old.txt"
printf 'old-marker\n' > "$COMMITTED_REENTRY_TARGET/.restore-transaction/marker"
printf 'uploads\n.customizer-assets\n.whatsapp-sessions\n' \
    > "$COMMITTED_REENTRY_TARGET/.restore-transaction/original-dirs"
printf '0\n' > "$COMMITTED_REENTRY_TARGET/.restore-transaction/committed"
CORRUPT_RESTORE_ARCHIVE="$TMP_ROOT/runtime-corrupt-reentry.tar.gz"
printf 'not-a-tar\n' > "$CORRUPT_RESTORE_ARCHIVE"
if sh "$PROJECT_DIR/scripts/runtime-restore-transaction.sh" \
    "$COMMITTED_REENTRY_TARGET" "$CORRUPT_RESTORE_ARCHIVE" "$(id -u)" "$(id -g)" 0 "$(id -u)" "$(id -g)" \
    >/dev/null 2>&1; then
    fail "corrupt archive unexpectedly succeeded after committed restore re-entry"
fi
[ "$(cat "$COMMITTED_REENTRY_TARGET/uploads/new.txt")" = new-upload ] \
    && [ "$(cat "$COMMITTED_REENTRY_TARGET/.initialized-v1")" = new-marker ] \
    && [ ! -e "$COMMITTED_REENTRY_TARGET/uploads/old.txt" ] \
    && [ ! -e "$COMMITTED_REENTRY_TARGET/.restore-transaction" ] \
    || fail "committed restore re-entry reversed a successful runtime restore"

UNCOMMITTED_REENTRY_TARGET="$TMP_ROOT/runtime-restore-uncommitted-reentry"
mkdir -p "$UNCOMMITTED_REENTRY_TARGET/uploads" "$UNCOMMITTED_REENTRY_TARGET/.customizer-assets" \
    "$UNCOMMITTED_REENTRY_TARGET/.whatsapp-sessions" \
    "$UNCOMMITTED_REENTRY_TARGET/.restore-transaction/old/uploads" \
    "$UNCOMMITTED_REENTRY_TARGET/.restore-transaction/old/.customizer-assets" \
    "$UNCOMMITTED_REENTRY_TARGET/.restore-transaction/old/.whatsapp-sessions"
printf 'partial-new\n' > "$UNCOMMITTED_REENTRY_TARGET/uploads/partial.txt"
printf 'partial-marker\n' > "$UNCOMMITTED_REENTRY_TARGET/.initialized-v1"
printf 'old-upload\n' > "$UNCOMMITTED_REENTRY_TARGET/.restore-transaction/old/uploads/old.txt"
printf 'old-marker\n' > "$UNCOMMITTED_REENTRY_TARGET/.restore-transaction/marker"
printf 'uploads\n.customizer-assets\n.whatsapp-sessions\n' \
    > "$UNCOMMITTED_REENTRY_TARGET/.restore-transaction/original-dirs"
if sh "$PROJECT_DIR/scripts/runtime-restore-transaction.sh" \
    "$UNCOMMITTED_REENTRY_TARGET" "$CORRUPT_RESTORE_ARCHIVE" "$(id -u)" "$(id -g)" 0 "$(id -u)" "$(id -g)" \
    >/dev/null 2>&1; then
    fail "corrupt archive unexpectedly succeeded after uncommitted restore re-entry"
fi
[ "$(cat "$UNCOMMITTED_REENTRY_TARGET/uploads/old.txt")" = old-upload ] \
    && [ "$(cat "$UNCOMMITTED_REENTRY_TARGET/.initialized-v1")" = old-marker ] \
    && [ ! -e "$UNCOMMITTED_REENTRY_TARGET/uploads/partial.txt" ] \
    && [ ! -e "$UNCOMMITTED_REENTRY_TARGET/.restore-transaction" ] \
    || fail "uncommitted restore re-entry did not recover the exact old runtime tree"

LEGACY_AMBIGUOUS_TARGET="$TMP_ROOT/runtime-restore-legacy-ambiguous"
mkdir -p "$LEGACY_AMBIGUOUS_TARGET/uploads" "$LEGACY_AMBIGUOUS_TARGET/.customizer-assets" \
    "$LEGACY_AMBIGUOUS_TARGET/.whatsapp-sessions" \
    "$LEGACY_AMBIGUOUS_TARGET/.restore-transaction/new"
printf 'ambiguous-current\n' > "$LEGACY_AMBIGUOUS_TARGET/uploads/current.txt"
printf 'legacy-marker\n' > "$LEGACY_AMBIGUOUS_TARGET/.initialized-v1"
printf 'legacy-marker\n' > "$LEGACY_AMBIGUOUS_TARGET/.restore-transaction/marker"
if sh "$PROJECT_DIR/scripts/runtime-restore-transaction.sh" \
    "$LEGACY_AMBIGUOUS_TARGET" "$CORRUPT_RESTORE_ARCHIVE" "$(id -u)" "$(id -g)" 0 "$(id -u)" "$(id -g)" \
    >/dev/null 2>&1; then
    fail "ambiguous legacy restore transaction was guessed instead of failing closed"
fi
[ "$(cat "$LEGACY_AMBIGUOUS_TARGET/uploads/current.txt")" = ambiguous-current ] \
    && [ -d "$LEGACY_AMBIGUOUS_TARGET/.restore-transaction" ] \
    || fail "ambiguous legacy restore failure changed evidence needed for manual recovery"

LEGACY_LATE_AMBIGUOUS_TARGET="$TMP_ROOT/runtime-restore-legacy-late-ambiguous"
mkdir -p "$LEGACY_LATE_AMBIGUOUS_TARGET/uploads" \
    "$LEGACY_LATE_AMBIGUOUS_TARGET/.customizer-assets" \
    "$LEGACY_LATE_AMBIGUOUS_TARGET/.whatsapp-sessions" \
    "$LEGACY_LATE_AMBIGUOUS_TARGET/.restore-transaction/old/uploads"
printf 'candidate-upload\n' > "$LEGACY_LATE_AMBIGUOUS_TARGET/uploads/candidate.txt"
printf 'ambiguous-customizer\n' > "$LEGACY_LATE_AMBIGUOUS_TARGET/.customizer-assets/current.txt"
printf 'definite-old-upload\n' > "$LEGACY_LATE_AMBIGUOUS_TARGET/.restore-transaction/old/uploads/old.txt"
printf 'legacy-marker\n' > "$LEGACY_LATE_AMBIGUOUS_TARGET/.initialized-v1"
printf 'legacy-marker\n' > "$LEGACY_LATE_AMBIGUOUS_TARGET/.restore-transaction/marker"
if sh "$PROJECT_DIR/scripts/runtime-restore-transaction.sh" \
    "$LEGACY_LATE_AMBIGUOUS_TARGET" "$CORRUPT_RESTORE_ARCHIVE" "$(id -u)" "$(id -g)" 0 "$(id -u)" "$(id -g)" \
    >/dev/null 2>&1; then
    fail "late ambiguous legacy restore transaction was guessed instead of failing closed"
fi
[ "$(cat "$LEGACY_LATE_AMBIGUOUS_TARGET/uploads/candidate.txt")" = candidate-upload ] \
    && [ "$(cat "$LEGACY_LATE_AMBIGUOUS_TARGET/.customizer-assets/current.txt")" = ambiguous-customizer ] \
    && [ "$(cat "$LEGACY_LATE_AMBIGUOUS_TARGET/.restore-transaction/old/uploads/old.txt")" = definite-old-upload ] \
    || fail "late legacy ambiguity mutated evidence before fail-closed inspection"

MOCK_RUNTIME_SOURCE="$TMP_ROOT/runtime-mock-source"
MOCK_DOCKER_BIN="$TMP_ROOT/runtime-mock-bin"
MOCK_BACKUPS="$TMP_ROOT/runtime-mock-backups"
mkdir -p "$MOCK_RUNTIME_SOURCE/uploads" "$MOCK_RUNTIME_SOURCE/.customizer-assets" \
    "$MOCK_RUNTIME_SOURCE/.whatsapp-sessions" "$MOCK_RUNTIME_SOURCE/openclaw" \
    "$MOCK_DOCKER_BIN" "$MOCK_BACKUPS"
cp -a "$OPENCLAW_FIXTURE/openclaw/." "$MOCK_RUNTIME_SOURCE/openclaw/"
WEIXIN_GENERATION_PROJECT='tencent-weixin-openclaw-weixin-7783ac86ba__openclaw-generation__g-da663653010cdc3b'
CRM_GENERATION_PROJECT='vaysen-openclaw-crm-tools-f0ac731cd3__openclaw-generation__g-c8c77eb604dd2228'
WEIXIN_ACTIVE_LINK_REL="openclaw/npm/projects/$WEIXIN_GENERATION_PROJECT/node_modules/@tencent-weixin/openclaw-weixin/node_modules/openclaw"
CRM_ACTIVE_LINK_REL="openclaw/npm/projects/$CRM_GENERATION_PROJECT/node_modules/@vaysen/openclaw-crm-tools/node_modules/openclaw"
mv "$MOCK_RUNTIME_SOURCE/openclaw/npm/projects/tencent-weixin-openclaw-weixin-7783ac86ba" \
    "$MOCK_RUNTIME_SOURCE/openclaw/npm/projects/$WEIXIN_GENERATION_PROJECT"
mv "$MOCK_RUNTIME_SOURCE/openclaw/npm/projects/vaysen-openclaw-crm-tools-f0ac731cd3" \
    "$MOCK_RUNTIME_SOURCE/openclaw/npm/projects/$CRM_GENERATION_PROJECT"
"$PYTHON_SQLITE" - "$MOCK_RUNTIME_SOURCE/openclaw/state/openclaw.sqlite" \
    "$WEIXIN_GENERATION_PROJECT" "$CRM_GENERATION_PROJECT" <<'PY'
import json
import sqlite3
import sys

database = sqlite3.connect(sys.argv[1])
raw = database.execute(
    'SELECT install_records_json FROM installed_plugin_index WHERE index_key = ?',
    ('installed-plugin-index',),
).fetchone()[0]
records = json.loads(raw)
records['openclaw-weixin']['installPath'] = (
    f'/home/node/.openclaw/npm/projects/{sys.argv[2]}/node_modules/@tencent-weixin/openclaw-weixin'
)
records['vaysen-crm']['installPath'] = (
    f'/home/node/.openclaw/npm/projects/{sys.argv[3]}/node_modules/@vaysen/openclaw-crm-tools'
)
database.execute(
    'UPDATE installed_plugin_index SET install_records_json = ? WHERE index_key = ?',
    (json.dumps(records, separators=(',', ':')), 'installed-plugin-index'),
)
database.commit()
database.close()
PY
printf 'upload\n' > "$MOCK_RUNTIME_SOURCE/uploads/customer.txt"
ln "$MOCK_RUNTIME_SOURCE/uploads/customer.txt" "$MOCK_RUNTIME_SOURCE/uploads/customer-hardlink.txt"
ln -s /app "$MOCK_RUNTIME_SOURCE/openclaw/${WEIXIN_ACTIVE_LINK_REL#openclaw/}"
ln -s /app "$MOCK_RUNTIME_SOURCE/openclaw/${CRM_ACTIVE_LINK_REL#openclaw/}"
REAL_DOCKER="$(command -v docker || true)"
MOCK_OPENCLAW_IMAGE=''
if [ -n "$REAL_DOCKER" ]; then
    MOCK_OPENCLAW_IMAGE="$($REAL_DOCKER inspect -f '{{.Image}}' vaysen-crm-openclaw-gateway 2>/dev/null || true)"
fi
export REAL_DOCKER MOCK_OPENCLAW_IMAGE
cat > "$MOCK_DOCKER_BIN/docker" <<'SH'
#!/usr/bin/env sh
set -eu
case "${1:-}" in
  container)
    [ "${2:-}" = inspect ]
    exit 0
    ;;
  inspect)
    if [ "${3:-}" = '{{.Image}}' ]; then
      [ -n "${MOCK_OPENCLAW_IMAGE:-}" ] || exit 92
      printf '%s\n' "$MOCK_OPENCLAW_IMAGE"
    else
      printf 'false\n'
    fi
    exit 0
    ;;
  image|run)
    [ -n "${REAL_DOCKER:-}" ] || exit 93
    exec "$REAL_DOCKER" "$@"
    ;;
  cp)
    source_path="${2:-}"
    destination="${3:-}"
    case "$source_path" in
      *:/app/uploads/.) source_dir="$MOCK_RUNTIME_SOURCE/uploads" ;;
      *:/app/.customizer-assets/.) source_dir="$MOCK_RUNTIME_SOURCE/.customizer-assets" ;;
      *:/app/.whatsapp-sessions/.) source_dir="$MOCK_RUNTIME_SOURCE/.whatsapp-sessions" ;;
      *:/home/node/.openclaw/.) source_dir="$MOCK_RUNTIME_SOURCE/openclaw" ;;
      *) exit 90 ;;
    esac
    cp -a "$source_dir/." "$destination/"
    ;;
  *) exit 91 ;;
esac
SH
chmod 750 "$MOCK_DOCKER_BIN/docker"
MOCK_BACKUP_OUTPUT="$(PATH="$MOCK_DOCKER_BIN:$PATH" MOCK_RUNTIME_SOURCE="$MOCK_RUNTIME_SOURCE" \
    BACKUP_DIR="$MOCK_BACKUPS" BACKEND_CONTAINER=mock-backend OPENCLAW_CONTAINER=mock-openclaw \
    bash "$PROJECT_DIR/scripts/backup-runtime-data.sh")" \
    || fail "runtime backup must encode the two reviewed OpenClaw peer links"
MOCK_RUNTIME_ARCHIVE="$(printf '%s\n' "$MOCK_BACKUP_OUTPUT" | sed -n 's/^runtimeBackup=//p')"
[ -f "$MOCK_RUNTIME_ARCHIVE" ] && [ -f "$MOCK_RUNTIME_ARCHIVE.sha256" ] \
    || fail "mock runtime backup did not commit an archive and checksum"
bash "$PROJECT_DIR/scripts/restore-runtime-data.sh" --check "$MOCK_RUNTIME_ARCHIVE" >/dev/null \
    || fail "backup-produced encoded peer-link archive must pass restore validation"
if tar -tvzf "$MOCK_RUNTIME_ARCHIVE" | grep -Eq '^[lhcbps]'; then
    fail "backup-produced runtime archive contains a raw link or special file"
fi
tar -xOzf "$MOCK_RUNTIME_ARCHIVE" .vaysen-crm-runtime-links-v2.json \
    | node -e 'let s="";process.stdin.on("data",c=>s+=c);process.stdin.on("end",()=>{const m=JSON.parse(s);const a=m.links?.map(x=>x.relativePath).sort();const e=process.argv.slice(1).sort();if(m.schemaVersion!==2||!Array.isArray(m.links)||m.links.length!==2||m.links.some(x=>x.target!=="/app")||JSON.stringify(a)!==JSON.stringify(e))process.exit(1);})' \
        "$WEIXIN_ACTIVE_LINK_REL" "$CRM_ACTIVE_LINK_REL" \
    || fail "backup-produced v2 peer-link manifest is not the strict two-link schema"

GENERATION_INITIALIZE_TARGET="$TMP_ROOT/runtime-generation-initialize"
mkdir -p "$GENERATION_INITIALIZE_TARGET"
sh "$PROJECT_DIR/scripts/runtime-initialize-transaction.sh" \
    "$GENERATION_INITIALIZE_TARGET" "$MOCK_RUNTIME_ARCHIVE" "$(id -u)" "$(id -g)" 1 "$(id -u)" "$(id -g)" \
    || fail "generation-root v2 archive must initialize transactionally"
[ "$(readlink "$GENERATION_INITIALIZE_TARGET/$WEIXIN_ACTIVE_LINK_REL")" = /app ] \
    && [ "$(readlink "$GENERATION_INITIALIZE_TARGET/$CRM_ACTIVE_LINK_REL")" = /app ] \
    || fail "generation-root initialization did not reconstruct SQLite-selected links"

GENERATION_RESTORE_TARGET="$TMP_ROOT/runtime-generation-restore"
mkdir -p "$GENERATION_RESTORE_TARGET/uploads" "$GENERATION_RESTORE_TARGET/.customizer-assets" \
    "$GENERATION_RESTORE_TARGET/.whatsapp-sessions"
printf 'old-marker\n' > "$GENERATION_RESTORE_TARGET/.initialized-v1"
sh "$PROJECT_DIR/scripts/runtime-restore-transaction.sh" \
    "$GENERATION_RESTORE_TARGET" "$MOCK_RUNTIME_ARCHIVE" "$(id -u)" "$(id -g)" 1 "$(id -u)" "$(id -g)" \
    || fail "generation-root v2 archive must restore transactionally"
[ "$(readlink "$GENERATION_RESTORE_TARGET/$WEIXIN_ACTIVE_LINK_REL")" = /app ] \
    && [ "$(readlink "$GENERATION_RESTORE_TARGET/$CRM_ACTIVE_LINK_REL")" = /app ] \
    || fail "generation-root restore did not reconstruct SQLite-selected links"

# If the archive rename reaches its destination but reports failure, the EXIT
# trap still sees an uncommitted publication and must remove both final files.
MOCK_FAILED_BACKUPS="$TMP_ROOT/runtime-mock-failed-backups"
MOCK_MV_BIN="$TMP_ROOT/runtime-mock-mv-bin"
mkdir -p "$MOCK_FAILED_BACKUPS" "$MOCK_MV_BIN"
cat > "$MOCK_MV_BIN/mv" <<'SH'
#!/usr/bin/env sh
set -eu
case "${2:-}" in
  */runtime_*.tar.gz)
    "$REAL_MV" "$@"
    exit 98
    ;;
esac
exec "$REAL_MV" "$@"
SH
chmod 750 "$MOCK_MV_BIN/mv"
if PATH="$MOCK_MV_BIN:$MOCK_DOCKER_BIN:$PATH" REAL_MV="$REAL_MV" \
    MOCK_RUNTIME_SOURCE="$MOCK_RUNTIME_SOURCE" BACKUP_DIR="$MOCK_FAILED_BACKUPS" \
    BACKEND_CONTAINER=mock-backend OPENCLAW_CONTAINER=mock-openclaw \
    bash "$PROJECT_DIR/scripts/backup-runtime-data.sh" >/dev/null 2>&1; then
    fail "runtime backup unexpectedly survived archive publication failure"
fi
[ -z "$(find "$MOCK_FAILED_BACKUPS" -maxdepth 1 -type f \
    \( -name 'runtime_*.tar.gz' -o -name 'runtime_*.tar.gz.sha256' \) -print -quit)" ] \
    || fail "failed runtime backup left an orphan final archive or checksum"

# A pre-existing filename collision is not this run's partial publication and
# must never be deleted by cleanup. Freeze the timestamp to exercise that path.
MOCK_COLLISION_BACKUPS="$TMP_ROOT/runtime-mock-collision-backups"
MOCK_DATE_BIN="$TMP_ROOT/runtime-mock-date-bin"
mkdir -p "$MOCK_COLLISION_BACKUPS" "$MOCK_DATE_BIN"
COLLISION_ARCHIVE="$MOCK_COLLISION_BACKUPS/runtime_20000101_000000_000000001.tar.gz"
printf 'protected-existing-archive\n' > "$COLLISION_ARCHIVE"
printf 'protected-existing-checksum\n' > "$COLLISION_ARCHIVE.sha256"
REAL_DATE="$(command -v date)"
cat > "$MOCK_DATE_BIN/date" <<'SH'
#!/usr/bin/env sh
set -eu
if [ "${1:-}" = '+%Y%m%d_%H%M%S_%N' ]; then
  printf '20000101_000000_000000001\n'
  exit 0
fi
exec "$REAL_DATE" "$@"
SH
chmod 750 "$MOCK_DATE_BIN/date"
if PATH="$MOCK_DATE_BIN:$MOCK_DOCKER_BIN:$PATH" REAL_DATE="$REAL_DATE" \
    MOCK_RUNTIME_SOURCE="$MOCK_RUNTIME_SOURCE" BACKUP_DIR="$MOCK_COLLISION_BACKUPS" \
    BACKEND_CONTAINER=mock-backend OPENCLAW_CONTAINER=mock-openclaw \
    bash "$PROJECT_DIR/scripts/backup-runtime-data.sh" >/dev/null 2>&1; then
    fail "runtime backup overwrote a pre-existing timestamp collision"
fi
[ "$(cat "$COLLISION_ARCHIVE")" = protected-existing-archive ] \
    && [ "$(cat "$COLLISION_ARCHIVE.sha256")" = protected-existing-checksum ] \
    || fail "runtime backup cleanup deleted or changed a pre-existing collision"

rm -f "$MOCK_RUNTIME_SOURCE/openclaw/${CRM_ACTIVE_LINK_REL#openclaw/}"
if PATH="$MOCK_DOCKER_BIN:$PATH" MOCK_RUNTIME_SOURCE="$MOCK_RUNTIME_SOURCE" \
    BACKUP_DIR="$MOCK_BACKUPS" BACKEND_CONTAINER=mock-backend OPENCLAW_CONTAINER=mock-openclaw \
    bash "$PROJECT_DIR/scripts/backup-runtime-data.sh" >/dev/null 2>&1; then
    fail "OpenClaw backup with only one reviewed peer link must fail closed"
fi
ln -s /wrong-host-root "$MOCK_RUNTIME_SOURCE/openclaw/${CRM_ACTIVE_LINK_REL#openclaw/}"
if PATH="$MOCK_DOCKER_BIN:$PATH" MOCK_RUNTIME_SOURCE="$MOCK_RUNTIME_SOURCE" \
    BACKUP_DIR="$MOCK_BACKUPS" BACKEND_CONTAINER=mock-backend OPENCLAW_CONTAINER=mock-openclaw \
    bash "$PROJECT_DIR/scripts/backup-runtime-data.sh" >/dev/null 2>&1; then
    fail "reviewed OpenClaw peer path with the wrong target must fail closed"
fi
rm -f "$MOCK_RUNTIME_SOURCE/openclaw/${CRM_ACTIVE_LINK_REL#openclaw/}"
ln -s /app "$MOCK_RUNTIME_SOURCE/openclaw/${CRM_ACTIVE_LINK_REL#openclaw/}"
ln -s /app "$MOCK_RUNTIME_SOURCE/openclaw/unapproved-peer-link"
if PATH="$MOCK_DOCKER_BIN:$PATH" MOCK_RUNTIME_SOURCE="$MOCK_RUNTIME_SOURCE" \
    BACKUP_DIR="$MOCK_BACKUPS" BACKEND_CONTAINER=mock-backend OPENCLAW_CONTAINER=mock-openclaw \
    bash "$PROJECT_DIR/scripts/backup-runtime-data.sh" >/dev/null 2>&1; then
    fail "OpenClaw backup with an additional unapproved peer link must fail closed"
fi

printf '%s\n' "$WEIXIN_LINK_REL" > "$OPENCLAW_FIXTURE/.vaysen-crm-runtime-links-v1"
INCOMPLETE_LINK_ARCHIVE="$TMP_ROOT/runtime-openclaw-incomplete-links.tar.gz"
tar -C "$OPENCLAW_FIXTURE" -czf "$INCOMPLETE_LINK_ARCHIVE" \
    uploads .customizer-assets .whatsapp-sessions openclaw .vaysen-crm-runtime-links-v1
printf '%s  %s\n' "$(sha256sum "$INCOMPLETE_LINK_ARCHIVE" | cut -d' ' -f1)" "$(basename "$INCOMPLETE_LINK_ARCHIVE")" \
    > "$INCOMPLETE_LINK_ARCHIVE.sha256"
if bash "$PROJECT_DIR/scripts/restore-runtime-data.sh" --check "$INCOMPLETE_LINK_ARCHIVE" >/dev/null 2>&1; then
    fail "incomplete OpenClaw peer-link manifest must fail closed"
fi
WRONG_HASH_LINK_REL='openclaw/npm/projects/vaysen-openclaw-crm-tools-0000000000/node_modules/@vaysen/openclaw-crm-tools/node_modules/openclaw'
printf '%s\n%s\n' "$WEIXIN_LINK_REL" "$WRONG_HASH_LINK_REL" > "$OPENCLAW_FIXTURE/.vaysen-crm-runtime-links-v1"
WRONG_HASH_LINK_ARCHIVE="$TMP_ROOT/runtime-openclaw-wrong-link-hash.tar.gz"
tar -C "$OPENCLAW_FIXTURE" -czf "$WRONG_HASH_LINK_ARCHIVE" \
    uploads .customizer-assets .whatsapp-sessions openclaw .vaysen-crm-runtime-links-v1
printf '%s  %s\n' "$(sha256sum "$WRONG_HASH_LINK_ARCHIVE" | cut -d' ' -f1)" "$(basename "$WRONG_HASH_LINK_ARCHIVE")" \
    > "$WRONG_HASH_LINK_ARCHIVE.sha256"
if bash "$PROJECT_DIR/scripts/restore-runtime-data.sh" --check "$WRONG_HASH_LINK_ARCHIVE" >/dev/null 2>&1; then
    fail "OpenClaw peer-link manifest with a non-reviewed project hash must fail closed"
fi
printf '%s\n%s\n' "$WEIXIN_LINK_REL" "$CRM_LINK_REL" > "$OPENCLAW_FIXTURE/.vaysen-crm-runtime-links-v1"

ln -s forbidden "$OPENCLAW_FIXTURE/openclaw/unsafe-link"
OPENCLAW_LINK_ARCHIVE="$TMP_ROOT/runtime-openclaw-link.tar.gz"
tar -C "$OPENCLAW_FIXTURE" -czf "$OPENCLAW_LINK_ARCHIVE" uploads .customizer-assets .whatsapp-sessions openclaw
printf '%s  %s\n' "$(sha256sum "$OPENCLAW_LINK_ARCHIVE" | cut -d' ' -f1)" "$(basename "$OPENCLAW_LINK_ARCHIVE")" \
    > "$OPENCLAW_LINK_ARCHIVE.sha256"
if bash "$PROJECT_DIR/scripts/restore-runtime-data.sh" --check "$OPENCLAW_LINK_ARCHIVE" >/dev/null 2>&1; then
    fail "OpenClaw runtime archive with a symlink must fail closed"
fi
rm -f "$OPENCLAW_FIXTURE/openclaw/unsafe-link"
mkfifo "$OPENCLAW_FIXTURE/openclaw/unsafe-fifo"
OPENCLAW_SPECIAL_ARCHIVE="$TMP_ROOT/runtime-openclaw-special.tar.gz"
tar -C "$OPENCLAW_FIXTURE" -czf "$OPENCLAW_SPECIAL_ARCHIVE" uploads .customizer-assets .whatsapp-sessions openclaw
printf '%s  %s\n' "$(sha256sum "$OPENCLAW_SPECIAL_ARCHIVE" | cut -d' ' -f1)" "$(basename "$OPENCLAW_SPECIAL_ARCHIVE")" \
    > "$OPENCLAW_SPECIAL_ARCHIVE.sha256"
if bash "$PROJECT_DIR/scripts/restore-runtime-data.sh" --check "$OPENCLAW_SPECIAL_ARCHIVE" >/dev/null 2>&1; then
    fail "OpenClaw runtime archive with a special file must fail closed"
fi
pass "legacy/OpenClaw snapshots, encoded peer links, exact removal, raw-link and special-file fixtures pass"

printf 'TASK-109 deployment contract tests passed: %d groups\n' "$PASS"
