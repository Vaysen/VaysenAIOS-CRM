#!/usr/bin/env bash
# Prepare the isolated OpenClaw state, verify pinned npm artifacts, install the
# reviewed plugins, and validate the final configuration before the gateway is
# allowed to start. This script never uses a CLI service with network_mode.

set -euo pipefail
umask 077

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
COMPOSE_FILE="${COMPOSE_FILE:-$PROJECT_DIR/docker-compose.prod.yml}"
ENV_FILE="${ENV_FILE:-$PROJECT_DIR/.env}"
COMPOSE_PROJECT_NAME="${COMPOSE_PROJECT_NAME:-vaysen-ai-crm}"
APP_DATA_DIR="${APP_DATA_DIR:-}"
NODE_IMAGE="${NODE_IMAGE:-}"
OPENCLAW_IMAGE="${OPENCLAW_IMAGE:-}"
OPENCLAW_DATA_UID="${OPENCLAW_DATA_UID:-1000}"
OPENCLAW_DATA_GID="${OPENCLAW_DATA_GID:-1000}"
OPENCLAW_PREPARE_RUN_TIMEOUT_SECONDS="${OPENCLAW_PREPARE_RUN_TIMEOUT_SECONDS:-300}"

OPENCLAW_IMAGE_PIN='ghcr.io/openclaw/openclaw@sha256:6a31d44b2944e7adcd2b582bf6fb463111264ebca97a0201795b799135bd102c'
WEIXIN_SPEC='@tencent-weixin/openclaw-weixin@2.4.6'
WEIXIN_INTEGRITY='sha512-qw9k3PLTiMWGNjjsknHgcTManH1w4j+Ji1ArWIaYLKCq3aFRsVwcqnPi127bvOoVMJGW4dbyJ8NECEMgoO+iRw=='
WEIXIN_SHASUM='c7744c5b2d0232703c886b2f4e71681b0170695d'
WEIXIN_TARBALL='tencent-weixin-openclaw-weixin-2.4.6.tgz'
WEIXIN_UPSTREAM_TARBALL='tencent-weixin-openclaw-weixin-2.4.6.upstream.tgz'
WEIXIN_PATCHED_TARBALL='tencent-weixin-openclaw-weixin-2.4.6-vaysen.5.tgz'
WEIXIN_PATCH_MANIFEST='/opt/vaysen-plugins/vaysen-crm/weixin-v2.4.6.patch.json'
WEIXIN_PATCH_TOOL='/opt/vaysen-plugins/vaysen-crm/weixin-patch-supply-chain.mjs'
WEIXIN_PATCH_SHA256='59f180806b5687aa53f4804ec6c496f2ab406817dfaa4d6974f192c362a610e2'
WEIXIN_PATCHED_INTEGRITY='sha512-WarnJ65LzlqhSluRnY4c/SvnnKnZTNhIEMXZEih+iQRDe4iZsVznsp3EySB+ADBdsa6XSH4MfhyijFLgiTPyhQ=='
WEIXIN_PATCHED_SHA256='15cde2b9926263ab5cfba21f2b935c710bc01dd983611e3dee673a052fa203d6'
WEIXIN_UPSTREAM_ARTIFACT_PATH="/home/node/.openclaw/supply-chain/artifacts/$WEIXIN_UPSTREAM_TARBALL"
WEIXIN_PATCHED_ARTIFACT_PATH="/home/node/.openclaw/supply-chain/artifacts/$WEIXIN_PATCHED_TARBALL"
TYPEBOX_SPEC='typebox@1.3.3'
TYPEBOX_NAME='typebox'
TYPEBOX_VERSION='1.3.3'
TYPEBOX_TARBALL='typebox-1.3.3.tgz'
TYPEBOX_INTEGRITY='sha512-URXGUE31PJDQC+PtRMJeLdF4kmmOdFoVPikPCtV2oOIhUpNpppEdIz7W8bH8cFYPYHdDpaRvqwdegMTmHliudg=='
TYPEBOX_SHASUM='b66b4e1200e86936667aeb59c5183e37e1d3919d'
QRCODE_SPEC='qrcode-terminal@0.12.0'
QRCODE_NAME='qrcode-terminal'
QRCODE_VERSION='0.12.0'
QRCODE_TARBALL='qrcode-terminal-0.12.0.tgz'
QRCODE_INTEGRITY='sha512-EXtzRZmC+YGmGlDFbXKxQiMZNwCLEO6BANKXG4iCtSIM0yqc/pappSx3RIKr4r0uh5JsBckOXeKrB3Iz7mdQpQ=='
QRCODE_SHASUM='bb5b699ef7f9f0505092a3748be4464fe71b5819'
ZOD_SPEC='zod@4.3.6'
ZOD_NAME='zod'
ZOD_VERSION='4.3.6'
ZOD_TARBALL='zod-4.3.6.tgz'
ZOD_INTEGRITY='sha512-rftlrkhHZOcjDwkGlnUtZZkvaPHCsDATp4pGpuOOMDaTdDDXF91wuVDJoWoPsKX/3YPQ5fHuF3STjcYyKr+Qhg=='
ZOD_SHASUM='89c56e0aa7d2b05107d894412227087885ab112a'
PRIVATE_CRM_NAME='@vaysen/openclaw-crm-tools'
PRIVATE_CRM_VERSION='1.3.2'
PRIVATE_CRM_TARBALL='vaysen-openclaw-crm-tools-1.3.2.tgz'
PRIVATE_CRM_INTEGRITY='sha512-hpI8KOB+A/Xc66V5kAA8Z74MsTcatFlUEnrg9QiV9r//UWPWtVu1IOz5KKG5YQXpQ2rGW+kXpYsIiZjWel8DjQ=='
PRIVATE_CRM_SHASUM='df125cf3c7a2f323fcc4328d9401bbbbdd04b41a'
PRIVATE_CRM_SHA256='1fadb55fa0be8cf451116e656cf8a5063348a2f37732e435a1d0b9ccc08c1e12'
PRIVATE_CRM_TREE_SHA256='12c25963cfe68631b1e363886bf7001f56c06dc4844b656a1f4a33a5333f8893'
PRIVATE_CRM_ARTIFACT_PATH="/home/node/.openclaw/supply-chain/artifacts/$PRIVATE_CRM_TARBALL"

fail() { printf '[OPENCLAW PREPARE ERROR] %s\n' "$*" >&2; exit 1; }
info() { printf '[OPENCLAW PREPARE] %s\n' "$*"; }

[ -f "$ENV_FILE" ] && [ ! -L "$ENV_FILE" ] || fail "environment file is missing or symlinked: $ENV_FILE"
[ -f "$COMPOSE_FILE" ] && [ ! -L "$COMPOSE_FILE" ] || fail "Compose file is missing or symlinked: $COMPOSE_FILE"
[ -n "$APP_DATA_DIR" ] && [[ "$APP_DATA_DIR" = /* ]] || fail 'APP_DATA_DIR must be an absolute path'
[ -n "$NODE_IMAGE" ] || fail 'NODE_IMAGE is required for protected state preparation'
[ "$OPENCLAW_IMAGE" = "$OPENCLAW_IMAGE_PIN" ] || fail 'OPENCLAW_IMAGE does not match the reviewed 2026.7.1 digest'
[[ "$OPENCLAW_DATA_UID" =~ ^[0-9]+$ ]] && [ "$OPENCLAW_DATA_UID" -eq 1000 ] \
    || fail 'OPENCLAW_DATA_UID must be 1000 for the official image'
[[ "$OPENCLAW_DATA_GID" =~ ^[0-9]+$ ]] && [ "$OPENCLAW_DATA_GID" -eq 1000 ] \
    || fail 'OPENCLAW_DATA_GID must be 1000 for the official image'
[[ "$OPENCLAW_PREPARE_RUN_TIMEOUT_SECONDS" =~ ^[1-9][0-9]*$ ]] \
    && [ "$OPENCLAW_PREPARE_RUN_TIMEOUT_SECONDS" -ge 30 ] \
    && [ "$OPENCLAW_PREPARE_RUN_TIMEOUT_SECONDS" -le 900 ] \
    || fail 'OPENCLAW_PREPARE_RUN_TIMEOUT_SECONDS must be between 30 and 900'
[ -d "$APP_DATA_DIR" ] && [ ! -L "$APP_DATA_DIR" ] || fail "APP_DATA_DIR is missing or symlinked: $APP_DATA_DIR"
command -v timeout >/dev/null 2>&1 || fail 'GNU timeout is required for bounded OpenClaw preparation'
PREPARE_NPM_CACHE_HOST="$APP_DATA_DIR/openclaw/.prepare-npm-cache"

OPENCLAW_PREP_RUN_ID="$$-$(date +%s)"
PREPARE_RUN_COUNTER=0

remove_owned_prepare_container() {
    local name="$1" marker_label
    docker container inspect "$name" >/dev/null 2>&1 || return 0
    marker_label="$(docker inspect -f '{{index .Config.Labels "com.vaysen.vaysen-crm.openclaw-prepare"}}' "$name" 2>/dev/null || true)"
    [ "$marker_label" = "$OPENCLAW_PREP_RUN_ID" ] \
        || fail "refusing to remove an unowned prepare container: $name"
    timeout --signal=TERM --kill-after=5s 20s docker rm -f "$name" >/dev/null \
        || fail "could not remove failed prepare container: $name"
}

compose_run_phase() {
    local phase="$1"
    shift
    local status project_label name attempt=1

    while [ "$attempt" -le 2 ]; do
        PREPARE_RUN_COUNTER=$((PREPARE_RUN_COUNTER + 1))
        name="vaysen-crm-openclaw-prepare-$OPENCLAW_PREP_RUN_ID-$PREPARE_RUN_COUNTER"
        docker container inspect "$name" >/dev/null 2>&1 \
            && fail "prepare phase has a stale or foreign container: $name"
        info "$phase (attempt $attempt/2)"
        set +e
        timeout --signal=TERM --kill-after=15s "${OPENCLAW_PREPARE_RUN_TIMEOUT_SECONDS}s" \
            docker compose --project-name "$COMPOSE_PROJECT_NAME" \
            --project-directory "$PROJECT_DIR" --env-file "$ENV_FILE" \
            -f "$COMPOSE_FILE" run --rm --no-deps --pull never --name "$name" \
            --label "com.vaysen.vaysen-crm.openclaw-prepare=$OPENCLAW_PREP_RUN_ID" "$@"
        status=$?
        set -e

        if docker container inspect "$name" >/dev/null 2>&1; then
            project_label="$(docker inspect -f '{{index .Config.Labels "com.docker.compose.project"}}' "$name" 2>/dev/null || true)"
            [ "$project_label" = "$COMPOSE_PROJECT_NAME" ] \
                || fail "refusing to remove an unowned prepare container: $name"
            remove_owned_prepare_container "$name"
        fi

        case "$status" in
            0) return 0 ;;
            124|137) fail "$phase timed out after ${OPENCLAW_PREPARE_RUN_TIMEOUT_SECONDS}s" ;;
        esac
        if [ "$attempt" -eq 2 ]; then
            fail "$phase failed with exit status $status after 2 attempts"
        fi
        info "$phase failed with exit status $status; retrying once"
        attempt=$((attempt + 1))
    done
}

docker_root_phase() {
    local phase="$1"
    shift
    PREPARE_RUN_COUNTER=$((PREPARE_RUN_COUNTER + 1))
    local name="vaysen-crm-openclaw-prepare-$OPENCLAW_PREP_RUN_ID-$PREPARE_RUN_COUNTER"
    local status

    docker container inspect "$name" >/dev/null 2>&1 \
        && fail "prepare phase has a stale or foreign container: $name"
    info "$phase"
    set +e
    timeout --signal=TERM --kill-after=15s "${OPENCLAW_PREPARE_RUN_TIMEOUT_SECONDS}s" \
        docker run --name "$name" \
        --label "com.vaysen.vaysen-crm.openclaw-prepare=$OPENCLAW_PREP_RUN_ID" \
        --rm "$@"
    status=$?
    set -e
    remove_owned_prepare_container "$name"
    case "$status" in
        0) return 0 ;;
        124|137) fail "$phase timed out after ${OPENCLAW_PREPARE_RUN_TIMEOUT_SECONDS}s" ;;
        *) fail "$phase failed with exit status $status" ;;
    esac
}

# Package managers and third-party plugin code never receive production model,
# gateway, or CRM signing secrets. The reviewed production config is validated
# separately after installation with the real environment.
compose_run_sandboxed_phase() {
    local phase="$1"
    shift
    compose_run_phase "$phase" \
        -e OPENCLAW_GATEWAY_TOKEN=prepare-redacted-gateway-token-000000 \
        -e OPENCLAW_CRM_HMAC_KEY_ID=prepare-redacted \
        -e OPENCLAW_CRM_HMAC_SECRET=prepare-redacted-hmac-secret-000000000000000000000000000000000000 \
        -e ZHIPU_API_KEY=prepare-redacted-zhipu-key \
        "$@"
}

# Registry access is confined to bounded package-cache phases. The cache lives
# below the rollback-protected OpenClaw state, is shared across a single retry,
# and is deleted before the managed state is audited or the gateway can start.
compose_run_package_phase() {
    local phase="$1"
    shift
    compose_run_sandboxed_phase "$phase" \
        -v "$PREPARE_NPM_CACHE_HOST:/tmp/npm-cache" \
        -v "$PREPARE_NPM_CACHE_HOST:/home/node/.npm" \
        -e HOME=/home/node \
        -e NPM_CONFIG_USERCONFIG=/opt/vaysen-config/npm-user.empty \
        -e NPM_CONFIG_GLOBALCONFIG=/opt/vaysen-config/npm-global.empty \
        -e NPM_CONFIG_FETCH_RETRIES=5 \
        -e NPM_CONFIG_FETCH_RETRY_MINTIMEOUT=1000 \
        -e NPM_CONFIG_FETCH_RETRY_MAXTIMEOUT=10000 \
        -e NPM_CONFIG_FETCH_TIMEOUT=60000 \
        -e NPM_CONFIG_PREFER_OFFLINE=true \
        "$@"
}

# The digest-pinned helper runs as root only long enough to create the bind
# root with the official image uid/gid. It has no network or project mount.
docker_root_phase 'prepare protected state ownership' --network none --user 0 \
    --cap-drop ALL --cap-add CHOWN --cap-add FOWNER --cap-add DAC_OVERRIDE \
    --security-opt no-new-privileges --log-driver none \
    -v "$APP_DATA_DIR:/target" \
    "$NODE_IMAGE" sh -ceu '
      if test -e /target/openclaw; then
        test -d /target/openclaw && test ! -L /target/openclaw
      else
        mkdir /target/openclaw
      fi
      cache=/target/openclaw/.prepare-npm-cache
      if test -e "$cache" || test -L "$cache"; then
        test -d "$cache" && test ! -L "$cache"
      else
        mkdir "$cache"
      fi
      if find "$cache" -xdev ! -type d ! -type f -print -quit | grep -q .; then
        echo "npm preparation cache contains a link or special file" >&2
        exit 1
      fi
      find /target/openclaw -xdev -type d -exec chown "$1:$2" {} +
      find /target/openclaw -xdev -type f -exec chown "$1:$2" {} +
      chmod 700 /target/openclaw
      chmod 700 "$cache"
    ' sh "$OPENCLAW_DATA_UID" "$OPENCLAW_DATA_GID"

# Install against the private-plugin-safe writable config. A previous prepare
# may already have registered vaysen-crm, so reverting to the empty bootstrap
# would make the next plugin command validate an installed plugin without its
# required apiBaseUrl. The production channel/tool policy is still copied only
# after both reviewed packages exist.
compose_run_sandboxed_phase 'write replay-safe installation configuration' --entrypoint sh openclaw-gateway -ceu '
  cp /opt/vaysen-config/openclaw.install-private.json "$OPENCLAW_CONFIG_PATH.next"
  chmod 600 "$OPENCLAW_CONFIG_PATH.next"
  mv "$OPENCLAW_CONFIG_PATH.next" "$OPENCLAW_CONFIG_PATH"
'

cache_verified_npm_package() {
    local spec="$1" expected_name="$2" expected_version="$3" expected_tarball="$4"
    local expected_integrity="$5" expected_shasum="$6"
    compose_run_package_phase "cache and verify npm package $spec" --entrypoint sh openclaw-gateway -ceu '
      spec="$1"
      expected_name="$2"
      expected_version="$3"
      expected_tarball="$4"
      expected_integrity="$5"
      expected_shasum="$6"
      online_stage="$(mktemp -d /tmp/vaysen-npm-online.XXXXXX)"
      offline_stage="$(mktemp -d /tmp/vaysen-npm-offline.XXXXXX)"
      cleanup() { rm -rf -- "$online_stage" "$offline_stage"; }
      trap cleanup EXIT HUP INT TERM

      test "$NPM_CONFIG_CACHE" = /tmp/npm-cache
      test -d "$NPM_CONFIG_CACHE" && test ! -L "$NPM_CONFIG_CACHE"
      test "$HOME" = /home/node
      test "$NPM_CONFIG_USERCONFIG" = /opt/vaysen-config/npm-user.empty
      test "$NPM_CONFIG_GLOBALCONFIG" = /opt/vaysen-config/npm-global.empty
      test -f "$NPM_CONFIG_USERCONFIG" && test ! -L "$NPM_CONFIG_USERCONFIG"
      test -f "$NPM_CONFIG_GLOBALCONFIG" && test ! -L "$NPM_CONFIG_GLOBALCONFIG"
      test ! -e /home/node/.npmrc && test ! -L /home/node/.npmrc
      test ! -e /app/.npmrc && test ! -L /app/.npmrc
      if find "$OPENCLAW_STATE_DIR" -xdev -name .npmrc -print -quit | grep -q .; then
        echo "OpenClaw state contains a forbidden npm project configuration" >&2
        exit 1
      fi
      if find "$NPM_CONFIG_CACHE" -xdev ! -type d ! -type f -print -quit | grep -q .; then
        echo "npm preparation cache contains a link or special file" >&2
        exit 1
      fi
      probe="$NPM_CONFIG_CACHE/.vaysen-cache-alias-$$"
      printf alias-ok > "$probe"
      test "$(cat "/home/node/.npm/${probe##*/}")" = alias-ok
      rm -f -- "$probe"
      test ! -e "/home/node/.npm/${probe##*/}"

      verify_pack() {
        stage="$1"
        mode="$2"
        offline_arg=
        test "$mode" = online || offline_arg=--offline
        pack_json="$(npm pack "$spec" --ignore-scripts --json --pack-destination "$stage" \
          --cache "$NPM_CONFIG_CACHE" --update-notifier=false $offline_arg)"
        metadata="$(printf "%s" "$pack_json" | node -e "let raw = \"\"; process.stdin.setEncoding(\"utf8\"); process.stdin.on(\"data\", (chunk) => { raw += chunk; }); process.stdin.on(\"end\", () => { const parsed = JSON.parse(raw); if (!Array.isArray(parsed) || parsed.length !== 1) process.exit(2); const item = parsed[0]; for (const key of [\"name\", \"version\", \"filename\", \"integrity\", \"shasum\"]) { if (typeof item[key] !== \"string\" || !item[key]) process.exit(3); } process.stdout.write([item.name, item.version, item.filename, item.integrity, item.shasum].join(\"\\t\")); });")"
        old_ifs="$IFS"
        IFS="$(printf "\t")"
        set -- $metadata
        IFS="$old_ifs"
        test "$#" -eq 5
        test "$1" = "$expected_name"
        test "$2" = "$expected_version"
        test "$3" = "$expected_tarball"
        test "$4" = "$expected_integrity"
        test "$5" = "$expected_shasum"
        case "$3" in
          ""|*/*|*\\*|.*|*.tgz.tgz) exit 1 ;;
          *.tgz) ;;
          *) exit 1 ;;
        esac
        tgz="$stage/$3"
        test -f "$tgz" && test ! -L "$tgz"
        count="$(find "$stage" -mindepth 1 -maxdepth 1 -type f -name "*.tgz" | wc -l | tr -d "[:space:]")"
        test "$count" = 1
        actual_integrity="$(node -e "const { createHash } = require(\"node:crypto\"); const fs = require(\"node:fs\"); process.stdout.write(\"sha512-\" + createHash(\"sha512\").update(fs.readFileSync(process.argv[1])).digest(\"base64\"));" "$tgz")"
        actual_shasum="$(node -e "const { createHash } = require(\"node:crypto\"); const fs = require(\"node:fs\"); process.stdout.write(createHash(\"sha1\").update(fs.readFileSync(process.argv[1])).digest(\"hex\"));" "$tgz")"
        test "$actual_integrity" = "$expected_integrity"
        test "$actual_shasum" = "$expected_shasum"
      }

      verify_pack "$online_stage" online
      verify_pack "$offline_stage" offline
    ' sh "$spec" "$expected_name" "$expected_version" "$expected_tarball" \
        "$expected_integrity" "$expected_shasum"
}

# npm pack proves tarball bytes but does not necessarily retain the packument
# response consumed by npm install. Resolve a minimal exact dependency project
# online, verify its lock, then replay a fresh full install in offline mode from
# the same dual-mounted cache. OpenClaw is not allowed to install until both
# steps succeed.
warm_verified_install_cache() {
    compose_run_package_phase 'warm and replay exact npm install cache' --entrypoint sh openclaw-gateway -ceu '
      qrcode_version="$1"
      qrcode_integrity="$2"
      zod_version="$3"
      zod_integrity="$4"
      typebox_version="$5"
      typebox_integrity="$6"
      online_stage="$(mktemp -d /tmp/vaysen-lock-online.XXXXXX)"
      offline_stage="$(mktemp -d /tmp/vaysen-lock-offline.XXXXXX)"
      cleanup() { rm -rf -- "$online_stage" "$offline_stage"; }
      trap cleanup EXIT HUP INT TERM

      write_manifest() {
        target="$1"
        node -e "const fs = require(\"node:fs\"); const [file, qrcode, zod, typebox] = process.argv.slice(1); fs.writeFileSync(file, JSON.stringify({ name: \"vaysen-openclaw-offline-cache-fixture\", version: \"1.0.0\", private: true, dependencies: { \"qrcode-terminal\": qrcode, zod, typebox } }, null, 2) + \"\\n\");" \
          "$target/package.json" "$qrcode_version" "$zod_version" "$typebox_version"
      }
      verify_lock() {
        target="$1"
        node -e "const fs = require(\"node:fs\"); const [file, qv, qi, zv, zi, tv, ti] = process.argv.slice(1); const lock = JSON.parse(fs.readFileSync(file, \"utf8\")); const expected = { \"qrcode-terminal\": [qv, qi], zod: [zv, zi], typebox: [tv, ti] }; const names = Object.keys(expected).sort(); const root = lock.packages?.[\"\"]; if (lock.lockfileVersion !== 3 || !root || JSON.stringify(Object.keys(root.dependencies ?? {}).sort()) !== JSON.stringify(names) || names.some((name) => root.dependencies[name] !== expected[name][0])) process.exit(2); const keys = Object.keys(lock.packages ?? {}).sort(); const expectedKeys = [\"\", ...names.map((name) => \"node_modules/\" + name)].sort(); if (JSON.stringify(keys) !== JSON.stringify(expectedKeys)) process.exit(3); for (const [name, [version, integrity]] of Object.entries(expected)) { const item = lock.packages[\"node_modules/\" + name]; if (item?.version !== version || item?.integrity !== integrity || typeof item.resolved !== \"string\" || !item.resolved.startsWith(\"https://registry.npmjs.org/\")) process.exit(4); }" \
          "$target/package-lock.json" "$qrcode_version" "$qrcode_integrity" \
          "$zod_version" "$zod_integrity" "$typebox_version" "$typebox_integrity"
      }

      write_manifest "$online_stage"
      (cd "$online_stage" && npm install --package-lock-only --ignore-scripts \
        --omit=dev --omit=peer --legacy-peer-deps --no-audit --no-fund \
        --loglevel=error --cache "$NPM_CONFIG_CACHE" --update-notifier=false)
      verify_lock "$online_stage"

      write_manifest "$offline_stage"
      (cd "$offline_stage" && env -u NPM_CONFIG_CACHE -u npm_config_cache \
        npm install --offline --ignore-scripts --omit=dev --omit=peer \
        --legacy-peer-deps --no-audit --no-fund --loglevel=error \
        --update-notifier=false)
      verify_lock "$offline_stage"
      for package_name in qrcode-terminal zod typebox; do
        test -f "$offline_stage/node_modules/$package_name/package.json"
        test ! -L "$offline_stage/node_modules/$package_name/package.json"
      done
    ' sh "$QRCODE_VERSION" "$QRCODE_INTEGRITY" "$ZOD_VERSION" "$ZOD_INTEGRITY" \
        "$TYPEBOX_VERSION" "$TYPEBOX_INTEGRITY"
}

install_verified_weixin() {
    local spec="$1" expected="$2" expected_shasum="$3" expected_tarball="$4"
    local upstream_tarball="$5" patched_tarball="$6" patch_manifest="$7" patch_tool="$8"
    local patch_sha256="$9" patched_integrity="${10}" patched_sha256="${11}"
    compose_run_package_phase 'build and install the reviewed Weixin artifact offline' \
      -e NPM_CONFIG_OFFLINE=true -e npm_config_offline=true \
      --entrypoint sh openclaw-gateway -ceu '
      spec="$1"
      expected="$2"
      expected_shasum="$3"
      expected_tarball="$4"
      upstream_tarball="$5"
      patched_tarball="$6"
      patch_manifest="$7"
      patch_tool="$8"
      patch_sha256="$9"
      patched_integrity="${10}"
      patched_sha256="${11}"
      cli="$(pwd)/dist/index.js"
      supply_dir="$OPENCLAW_STATE_DIR/supply-chain"
      artifact_dir="$supply_dir/artifacts"
      stage="$artifact_dir/.npm-pack-stage-$$"
      upstream_artifact="$artifact_dir/$upstream_tarball"
      patched_artifact="$artifact_dir/$patched_tarball"
      upstream_next="$upstream_artifact.next-$$"
      patched_next="$patched_artifact.next-$$"

      cleanup() {
        rm -rf -- "$stage"
        rm -f -- "$upstream_next" "$patched_next"
      }
      trap cleanup EXIT HUP INT TERM

      test -f "$cli" && test ! -L "$cli"
      test -f "$patch_manifest" && test ! -L "$patch_manifest"
      test -f "$patch_tool" && test ! -L "$patch_tool"
      mkdir -p "$supply_dir" "$artifact_dir"
      test -d "$supply_dir" && test ! -L "$supply_dir"
      test -d "$artifact_dir" && test ! -L "$artifact_dir"
      chmod 700 "$supply_dir" "$artifact_dir"
      mkdir "$stage"
      chmod 700 "$stage"
      mkdir -p "$NPM_CONFIG_CACHE"
      test "$NPM_CONFIG_CACHE" = /tmp/npm-cache

      test "$NPM_CONFIG_OFFLINE" = true
      test "$npm_config_offline" = true
      default_cache="$(env -u NPM_CONFIG_CACHE -u npm_config_cache npm config get cache --location=project)"
      test "$default_cache" = /home/node/.npm
      test -d "$default_cache" && test ! -L "$default_cache"
      test "$(npm config get offline --location=project)" = true
      test ! -e /home/node/.npmrc && test ! -L /home/node/.npmrc
      test ! -e /app/.npmrc && test ! -L /app/.npmrc
      if find "$OPENCLAW_STATE_DIR" -xdev -name .npmrc -print -quit | grep -q .; then
        echo "OpenClaw state contains a forbidden npm project configuration" >&2
        exit 1
      fi
      pack_json="$(npm pack "$spec" --ignore-scripts --json --offline --pack-destination "$stage" \
        --cache "$NPM_CONFIG_CACHE" --update-notifier=false)"
      metadata="$(printf "%s" "$pack_json" | node -e "let raw = \"\"; process.stdin.setEncoding(\"utf8\"); process.stdin.on(\"data\", (chunk) => { raw += chunk; }); process.stdin.on(\"end\", () => { const parsed = JSON.parse(raw); if (!Array.isArray(parsed) || parsed.length !== 1) process.exit(2); const item = parsed[0]; for (const key of [\"name\", \"version\", \"filename\", \"integrity\", \"shasum\"]) { if (typeof item[key] !== \"string\" || !item[key]) process.exit(3); } process.stdout.write([item.name, item.version, item.filename, item.integrity, item.shasum].join(\"\\t\")); });")"
      old_ifs="$IFS"
      IFS="$(printf "\t")"
      set -- $metadata
      IFS="$old_ifs"
      test "$#" -eq 5
      package_name="$1"
      package_version="$2"
      filename="$3"
      metadata_integrity="$4"
      metadata_shasum="$5"
      test "$package_name@$package_version" = "$spec"
      test "$filename" = "$expected_tarball"
      case "$filename" in
        ""|*/*|*\\*|.*|*.tgz.tgz) exit 1 ;;
        *.tgz) ;;
        *) exit 1 ;;
      esac

      tgz="$stage/$filename"
      test -f "$tgz" && test ! -L "$tgz"
      count="$(find "$stage" -mindepth 1 -maxdepth 1 -type f -name "*.tgz" | wc -l | tr -d "[:space:]")"
      test "$count" = 1
      actual_integrity="$(node -e "const { createHash } = require(\"node:crypto\"); const fs = require(\"node:fs\"); process.stdout.write(\"sha512-\" + createHash(\"sha512\").update(fs.readFileSync(process.argv[1])).digest(\"base64\"));" "$tgz")"
      actual_shasum="$(node -e "const { createHash } = require(\"node:crypto\"); const fs = require(\"node:fs\"); process.stdout.write(createHash(\"sha1\").update(fs.readFileSync(process.argv[1])).digest(\"hex\"));" "$tgz")"
      test "$actual_integrity" = "$expected"
      test "$metadata_integrity" = "$actual_integrity"
      test "$metadata_shasum" = "$actual_shasum"
      test "$actual_shasum" = "$expected_shasum"

      cp "$tgz" "$upstream_next"
      chmod 600 "$upstream_next"
      mv -f "$upstream_next" "$upstream_artifact"
      test -f "$upstream_artifact" && test ! -L "$upstream_artifact"
      persisted_integrity="$(node -e "const { createHash } = require(\"node:crypto\"); const fs = require(\"node:fs\"); process.stdout.write(\"sha512-\" + createHash(\"sha512\").update(fs.readFileSync(process.argv[1])).digest(\"base64\"));" "$upstream_artifact")"
      test "$persisted_integrity" = "$expected"

      actual_patch_sha256="$(node -e "const { createHash } = require(\"node:crypto\"); const fs = require(\"node:fs\"); process.stdout.write(createHash(\"sha256\").update(fs.readFileSync(process.argv[1])).digest(\"hex\"));" "$patch_manifest")"
      test "$actual_patch_sha256" = "$patch_sha256" || {
        echo "reviewed Weixin patch manifest SHA-256 mismatch" >&2
        exit 1
      }
      node "$patch_tool" "$upstream_artifact" "$patch_manifest" "$patched_next" >/dev/null
      chmod 600 "$patched_next"
      actual_patched_integrity="$(node -e "const { createHash } = require(\"node:crypto\"); const fs = require(\"node:fs\"); process.stdout.write(\"sha512-\" + createHash(\"sha512\").update(fs.readFileSync(process.argv[1])).digest(\"base64\"));" "$patched_next")"
      actual_patched_sha256="$(node -e "const { createHash } = require(\"node:crypto\"); const fs = require(\"node:fs\"); process.stdout.write(createHash(\"sha256\").update(fs.readFileSync(process.argv[1])).digest(\"hex\"));" "$patched_next")"
      test "$actual_patched_integrity" = "$patched_integrity" || {
        echo "patched Weixin SHA-512 integrity mismatch" >&2
        exit 1
      }
      test "$actual_patched_sha256" = "$patched_sha256" || {
        echo "patched Weixin SHA-256 mismatch" >&2
        exit 1
      }
      mv -f "$patched_next" "$patched_artifact"
      test -f "$patched_artifact" && test ! -L "$patched_artifact"

      # Install the exact reviewed patched artifact. The verified upstream tgz
      # remains immutable evidence and is never used as an install source.
      node "$cli" plugins install "npm-pack:$patched_artifact" --force
    ' sh "$spec" "$expected" "$expected_shasum" "$expected_tarball" \
        "$upstream_tarball" "$patched_tarball" "$patch_manifest" "$patch_tool" \
        "$patch_sha256" "$patched_integrity" "$patched_sha256"
}

openclaw_cli() {
    local phase="$1"
    shift
    compose_run_phase "$phase" --entrypoint node openclaw-gateway dist/index.js "$@"
}

openclaw_cli_sandboxed() {
    local phase="$1"
    shift
    compose_run_sandboxed_phase "$phase" --entrypoint node openclaw-gateway dist/index.js "$@"
}

install_verified_private_crm() {
    local expected_name="$1" expected_version="$2" expected_tarball="$3"
    local expected_integrity="$4" expected_shasum="$5" expected_sha256="$6"
    local expected_tree_sha256="$7" private_artifact="$8"
    compose_run_package_phase 'build and install the private CRM artifact offline' \
      -e NPM_CONFIG_OFFLINE=true -e npm_config_offline=true \
      --entrypoint sh openclaw-gateway -ceu '
      expected_name="$1"
      expected_version="$2"
      expected_tarball="$3"
      expected_integrity="$4"
      expected_shasum="$5"
      expected_sha256="$6"
      expected_tree_sha256="$7"
      private_artifact="$8"
      source_dir=/opt/vaysen-plugins/vaysen-crm
      cli="$(pwd)/dist/index.js"
      artifact_dir="$OPENCLAW_STATE_DIR/supply-chain/artifacts"
      stage_root="$artifact_dir/.private-pack-stage-$$"
      source_a="$stage_root/source-a"
      source_b="$stage_root/source-b"
      pack_a="$stage_root/pack-a"
      pack_b="$stage_root/pack-b"
      artifact_next="$private_artifact.next-$$"

      cleanup() {
        rm -rf -- "$stage_root"
        rm -f -- "$artifact_next"
      }
      trap cleanup EXIT HUP INT TERM

      assert_equal() {
        label="$1"
        expected="$2"
        actual="$3"
        if [ "$actual" != "$expected" ]; then
          printf "private CRM %s mismatch: expected %s, got %s\n" "$label" "$expected" "$actual" >&2
          exit 1
        fi
      }

      test -d "$source_dir" && test ! -L "$source_dir"
      test -d "$source_dir/dist" && test ! -L "$source_dir/dist"
      test -f "$source_dir/package.json" && test ! -L "$source_dir/package.json"
      test -f "$source_dir/npm-shrinkwrap.json" && test ! -L "$source_dir/npm-shrinkwrap.json"
      test -f "$cli" && test ! -L "$cli"
      mkdir -p "$artifact_dir"
      test -d "$artifact_dir" && test ! -L "$artifact_dir"
      chmod 700 "$artifact_dir"
      mkdir "$stage_root" "$source_a" "$source_b" "$pack_a" "$pack_b"
      chmod 700 "$stage_root" "$pack_a" "$pack_b"

      # npm pack preserves non-executable source permission bits in tar metadata.
      # Copy only the seven reviewed publish files and normalize modes so the tgz
      # is byte-identical across deployment hosts with different umasks.
      stage_private_source() {
        destination="$1"
        mkdir "$destination/dist"
        chmod 755 "$destination" "$destination/dist"
        for relative in package.json npm-shrinkwrap.json openclaw.plugin.json README.md dist/index.js dist/runtime.js dist/notify-owner.js; do
          source_file="$source_dir/$relative"
          target="$destination/$relative"
          test -f "$source_file" && test ! -L "$source_file"
          cp -- "$source_file" "$target"
          chmod 644 "$target"
        done
        test "$(find "$destination" -xdev -type f | wc -l)" -eq 7
        test -z "$(find "$destination" -xdev ! -type d ! -type f -print -quit)"
      }
      stage_private_source "$source_a"
      stage_private_source "$source_b"

      test "$NPM_CONFIG_OFFLINE" = true
      test "$npm_config_offline" = true
      default_cache="$(env -u NPM_CONFIG_CACHE -u npm_config_cache npm config get cache --location=project)"
      test "$default_cache" = /home/node/.npm
      test -d "$default_cache" && test ! -L "$default_cache"
      test "$(npm config get offline --location=project)" = true
      test ! -e /home/node/.npmrc && test ! -L /home/node/.npmrc
      test ! -e /app/.npmrc && test ! -L /app/.npmrc

      pack_once() {
        package_source="$1"
        destination="$2"
        npm pack "$package_source" --ignore-scripts --json --offline \
          --pack-destination "$destination" --cache "$NPM_CONFIG_CACHE" \
          --update-notifier=false
      }
      parse_metadata() {
        node -e "let raw = \"\"; process.stdin.setEncoding(\"utf8\"); process.stdin.on(\"data\", (chunk) => { raw += chunk; }); process.stdin.on(\"end\", () => { const parsed = JSON.parse(raw); if (!Array.isArray(parsed) || parsed.length !== 1) process.exit(2); const item = parsed[0]; for (const key of [\"name\", \"version\", \"filename\", \"integrity\", \"shasum\"]) { if (typeof item[key] !== \"string\" || !item[key]) process.exit(3); } process.stdout.write([item.name, item.version, item.filename, item.integrity, item.shasum].join(\"\\t\")); });"
      }

      metadata_a="$(pack_once "$source_a" "$pack_a" | parse_metadata)"
      metadata_b="$(pack_once "$source_b" "$pack_b" | parse_metadata)"
      test "$metadata_a" = "$metadata_b" || {
        echo "private CRM npm-pack metadata is not deterministic" >&2
        exit 1
      }
      old_ifs="$IFS"
      IFS="$(printf "\t")"
      set -- $metadata_a
      IFS="$old_ifs"
      test "$#" -eq 5 || {
        echo "private CRM npm-pack metadata field count mismatch" >&2
        exit 1
      }
      package_name="$1"
      package_version="$2"
      filename="$3"
      metadata_integrity="$4"
      metadata_shasum="$5"
      assert_equal "package name" "$expected_name" "$package_name"
      assert_equal "package version" "$expected_version" "$package_version"
      assert_equal "tarball name" "$expected_tarball" "$filename"
      case "$filename" in ""|*/*|*\\*|.*|*.tgz.tgz) exit 1 ;; *.tgz) ;; *) exit 1 ;; esac

      artifact_a="$pack_a/$filename"
      artifact_b="$pack_b/$filename"
      test -f "$artifact_a" && test ! -L "$artifact_a"
      test -f "$artifact_b" && test ! -L "$artifact_b"
      cmp "$artifact_a" "$artifact_b" || {
        echo "private CRM npm-pack bytes are not deterministic" >&2
        exit 1
      }
      actual_integrity="$(node -e "const { createHash } = require(\"node:crypto\"); const fs = require(\"node:fs\"); process.stdout.write(\"sha512-\" + createHash(\"sha512\").update(fs.readFileSync(process.argv[1])).digest(\"base64\"));" "$artifact_a")"
      actual_shasum="$(node -e "const { createHash } = require(\"node:crypto\"); const fs = require(\"node:fs\"); process.stdout.write(createHash(\"sha1\").update(fs.readFileSync(process.argv[1])).digest(\"hex\"));" "$artifact_a")"
      actual_sha256="$(node -e "const { createHash } = require(\"node:crypto\"); const fs = require(\"node:fs\"); process.stdout.write(createHash(\"sha256\").update(fs.readFileSync(process.argv[1])).digest(\"hex\"));" "$artifact_a")"
      actual_tree_sha256="$(node --input-type=module -e "import { createHash } from \"node:crypto\"; import { readNpmPackFiles } from \"/opt/vaysen-plugins/vaysen-crm/audit-managed-install.mjs\"; const files = readNpmPackFiles(process.argv[1]); const records = [...files.keys()].sort().map((relative) => { const content = files.get(relative); return relative + \"\\0\" + content.length + \"\\0\" + createHash(\"sha256\").update(content).digest(\"hex\"); }); process.stdout.write(createHash(\"sha256\").update(records.join(\"\\n\") + \"\\n\", \"utf8\").digest(\"hex\"));" "$artifact_a")"
      assert_equal "metadata integrity" "$actual_integrity" "$metadata_integrity"
      assert_equal "metadata shasum" "$actual_shasum" "$metadata_shasum"
      assert_equal "artifact integrity" "$expected_integrity" "$actual_integrity"
      assert_equal "artifact shasum" "$expected_shasum" "$actual_shasum"
      assert_equal "artifact SHA-256" "$expected_sha256" "$actual_sha256"
      assert_equal "normalized tree SHA-256" "$expected_tree_sha256" "$actual_tree_sha256"

      cp "$artifact_a" "$artifact_next"
      chmod 600 "$artifact_next"
      mv -f "$artifact_next" "$private_artifact"
      test -f "$private_artifact" && test ! -L "$private_artifact"

      # npm-pack is required here: OpenClaw directory installs intentionally
      # skip runtime dependencies and would leave typebox unresolved.
      node "$cli" plugins install "npm-pack:$private_artifact" --force
    ' sh "$expected_name" "$expected_version" "$expected_tarball" \
        "$expected_integrity" "$expected_shasum" "$expected_sha256" \
        "$expected_tree_sha256" "$private_artifact"
}

# OpenClaw's managed npm root applies the host workspace overrides to every
# plugin. Verify the fixed image dependency and override before warming any
# package cache so a host/plugin TypeBox drift fails before installation.
compose_run_sandboxed_phase 'verify OpenClaw host dependency contract' --entrypoint node openclaw-gateway \
    /opt/vaysen-plugins/vaysen-crm/verify-host-contract.mjs "$TYPEBOX_VERSION"

cache_verified_npm_package "$TYPEBOX_SPEC" "$TYPEBOX_NAME" "$TYPEBOX_VERSION" \
    "$TYPEBOX_TARBALL" "$TYPEBOX_INTEGRITY" "$TYPEBOX_SHASUM"
cache_verified_npm_package "$QRCODE_SPEC" "$QRCODE_NAME" "$QRCODE_VERSION" \
    "$QRCODE_TARBALL" "$QRCODE_INTEGRITY" "$QRCODE_SHASUM"
cache_verified_npm_package "$ZOD_SPEC" "$ZOD_NAME" "$ZOD_VERSION" \
    "$ZOD_TARBALL" "$ZOD_INTEGRITY" "$ZOD_SHASUM"
cache_verified_npm_package "$WEIXIN_SPEC" '@tencent-weixin/openclaw-weixin' '2.4.6' \
    "$WEIXIN_TARBALL" "$WEIXIN_INTEGRITY" "$WEIXIN_SHASUM"
warm_verified_install_cache
install_verified_weixin "$WEIXIN_SPEC" "$WEIXIN_INTEGRITY" "$WEIXIN_SHASUM" "$WEIXIN_TARBALL" \
    "$WEIXIN_UPSTREAM_TARBALL" "$WEIXIN_PATCHED_TARBALL" "$WEIXIN_PATCH_MANIFEST" \
    "$WEIXIN_PATCH_TOOL" "$WEIXIN_PATCH_SHA256" "$WEIXIN_PATCHED_INTEGRITY" "$WEIXIN_PATCHED_SHA256"

# The private tool package is mounted read-only and copied into managed plugin
# state by OpenClaw. Its pure runtime tests run before installation.
compose_run_sandboxed_phase 'run private CRM plugin tests' --entrypoint sh openclaw-gateway -ceu '
  cd /opt/vaysen-plugins/vaysen-crm
  node --test test/*.test.mjs
'
compose_run_sandboxed_phase 'write private CRM installation configuration' --entrypoint sh openclaw-gateway -ceu '
  cp /opt/vaysen-config/openclaw.install-private.json "$OPENCLAW_CONFIG_PATH.next"
  chmod 600 "$OPENCLAW_CONFIG_PATH.next"
  mv "$OPENCLAW_CONFIG_PATH.next" "$OPENCLAW_CONFIG_PATH"
'
install_verified_private_crm "$PRIVATE_CRM_NAME" "$PRIVATE_CRM_VERSION" "$PRIVATE_CRM_TARBALL" \
    "$PRIVATE_CRM_INTEGRITY" "$PRIVATE_CRM_SHASUM" "$PRIVATE_CRM_SHA256" \
    "$PRIVATE_CRM_TREE_SHA256" "$PRIVATE_CRM_ARTIFACT_PATH"

# Remove the transient registry cache before any managed-state audit. This is a
# fail-closed, confined delete below the exact rollback-protected state root.
docker_root_phase 'remove transient npm preparation cache' --network none --user 0 \
    --cap-drop ALL --cap-add FOWNER --cap-add DAC_OVERRIDE \
    --security-opt no-new-privileges --log-driver none \
    -v "$APP_DATA_DIR:/target" \
    "$NODE_IMAGE" sh -ceu '
      root=/target/openclaw
      cache="$root/.prepare-npm-cache"
      test -d "$root" && test ! -L "$root"
      test -d "$cache" && test ! -L "$cache"
      if find "$root" -xdev -name .npmrc -print -quit | grep -q .; then
        echo "OpenClaw state contains a forbidden npm project configuration" >&2
        exit 1
      fi
      if find "$cache" -xdev ! -type d ! -type f -print -quit | grep -q .; then
        echo "npm preparation cache contains a link or special file" >&2
        exit 1
      fi
      find "$cache" -xdev -depth -delete
      test ! -e "$cache" && test ! -L "$cache"
    '

# OpenClaw deliberately retains the previously active managed npm generation
# until gateway startup so a failed config commit can roll back. Preparation
# reinstalls both pinned packages before the gateway is allowed to start, so a
# replay would otherwise leave those retired roots (and their OpenClaw peer
# links) in state. Invoke the cleanup implementation from the digest-pinned
# 2026.7.1 image with the current SQLite install paths, fail on every cleanup
# error, and let the following full-state audit prove that nothing stale or
# unapproved remains.
compose_run_sandboxed_phase 'prune inactive retained npm generations' --entrypoint node openclaw-gateway \
    --input-type=module -e '
      import path from "node:path";
      import { t as cleanupRetainedManagedNpmInstallGenerations } from "/app/dist/managed-npm-retention-BTuFzcN9.js";
      import { readOpenClawInstallRecords } from "/opt/vaysen-plugins/vaysen-crm/audit-managed-install.mjs";

      const stateDir = process.env.OPENCLAW_STATE_DIR;
      if (!stateDir || !path.isAbsolute(stateDir)) throw new Error("OPENCLAW_STATE_DIR must be absolute");
      const records = readOpenClawInstallRecords(path.join(stateDir, "state", "openclaw.sqlite"));
      const activeInstallPaths = [...new Set(Object.values(records).flatMap((record) =>
        typeof record?.installPath === "string" && record.installPath.trim() ? [record.installPath] : []))];
      const failures = [];
      const removed = await cleanupRetainedManagedNpmInstallGenerations({
        npmDir: path.join(stateDir, "npm"),
        activeInstallPaths,
        onError: (error, projectRoot) => failures.push(new Error(`cleanup failed for ${projectRoot}`, { cause: error })),
      });
      if (failures.length > 0) throw new AggregateError(failures, "retained npm generation cleanup failed");
      if (!Number.isSafeInteger(removed) || removed < 0) throw new Error("retained npm cleanup returned an invalid count");
      process.stdout.write(`pruned inactive retained npm generations: ${removed}\n`);
    '
compose_run_sandboxed_phase 'audit managed plugin installation' \
    -e OPENCLAW_AUDIT_MODE=live --entrypoint node openclaw-gateway \
    /opt/vaysen-plugins/vaysen-crm/audit-managed-install.mjs \
    /home/node/.openclaw/supply-chain \
    "$PRIVATE_CRM_ARTIFACT_PATH" \
    "$WEIXIN_UPSTREAM_ARTIFACT_PATH" \
    "$WEIXIN_PATCHED_ARTIFACT_PATH" \
    "$WEIXIN_PATCH_MANIFEST"

# Replace the private-install config with the reviewed production policy. Secrets remain
# environment references; no key material is written by this script.
compose_run_sandboxed_phase 'write reviewed production configuration' --entrypoint sh openclaw-gateway -ceu '
  cp /opt/vaysen-config/openclaw.production.json "$OPENCLAW_CONFIG_PATH.next"
  chmod 600 "$OPENCLAW_CONFIG_PATH.next"
  mv "$OPENCLAW_CONFIG_PATH.next" "$OPENCLAW_CONFIG_PATH"
'

# Official Weixin state can contain raw account/peer identifiers. Restrict the
# complete state tree and generated supply-chain reports before validation.
# The managed audit has allowed only each registered plugin's exact
# node_modules/openclaw peer link. Do not follow or mutate those links.
docker_root_phase 'normalize protected state permissions' --network none --user 0 \
    --cap-drop ALL --cap-add CHOWN --cap-add FOWNER --cap-add DAC_OVERRIDE \
    --security-opt no-new-privileges --log-driver none \
    -v "$APP_DATA_DIR:/target" \
    "$NODE_IMAGE" sh -ceu '
      test -d /target/openclaw && test ! -L /target/openclaw
      if find /target/openclaw -xdev ! -type d ! -type f ! -type l -print -quit | grep -q .; then
        echo "OpenClaw state contains a special file" >&2
        exit 1
      fi
      find /target/openclaw -xdev -type d -exec chmod 700 {} +
      find /target/openclaw -xdev -type f -exec chmod 600 {} +
      find /target/openclaw -xdev -type d -exec chown "$1:$2" {} +
      find /target/openclaw -xdev -type f -exec chown "$1:$2" {} +
    ' sh "$OPENCLAW_DATA_UID" "$OPENCLAW_DATA_GID"

# Re-audit after root-owned permission normalization to close the gap between
# link approval and the final state consumed by the gateway.
compose_run_sandboxed_phase 're-audit normalized managed state' \
    -e OPENCLAW_AUDIT_MODE=live --entrypoint node openclaw-gateway \
    /opt/vaysen-plugins/vaysen-crm/audit-managed-install.mjs \
    /home/node/.openclaw/supply-chain \
    "$PRIVATE_CRM_ARTIFACT_PATH" \
    "$WEIXIN_UPSTREAM_ARTIFACT_PATH" \
    "$WEIXIN_PATCHED_ARTIFACT_PATH" \
    "$WEIXIN_PATCH_MANIFEST"

openclaw_cli 'validate reviewed production configuration' config validate --json
for plugin in admin-http-rpc openclaw-weixin vaysen-crm; do
    openclaw_cli "inspect plugin runtime: $plugin" plugins inspect "$plugin" --runtime --json >/dev/null \
        || fail "plugin runtime inspection failed: $plugin"
done

actual="$(stat -c '%u:%g:%a' "$APP_DATA_DIR/openclaw")"
[ "$actual" = '1000:1000:700' ] || fail "OpenClaw state ownership/mode is invalid: $actual"
find "$APP_DATA_DIR/openclaw" -xdev -type d ! -perm 0700 -print -quit | grep -q . \
    && fail 'OpenClaw state contains a directory not restricted to mode 0700'
find "$APP_DATA_DIR/openclaw" -xdev -type f ! -perm 0600 -print -quit | grep -q . \
    && fail 'OpenClaw state contains a file/report not restricted to mode 0600'
info 'pinned plugins and reviewed configuration are ready'
