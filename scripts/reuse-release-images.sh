#!/usr/bin/env bash
# Re-anchor already-reviewed application images when every Docker build context
# is byte-for-byte unchanged between two immutable annotated release tags.

set -euo pipefail
umask 077

fail() { printf '[IMAGE REUSE ERROR] %s\n' "$*" >&2; exit 1; }

PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SOURCE_TAG=''
RELEASE_TAG=''

while [ "$#" -gt 0 ]; do
    case "$1" in
        --source-tag)
            [ "$#" -ge 2 ] || fail '--source-tag requires a value'
            SOURCE_TAG="$2"
            shift 2
            ;;
        --release-tag)
            [ "$#" -ge 2 ] || fail '--release-tag requires a value'
            RELEASE_TAG="$2"
            shift 2
            ;;
        *) fail "unknown argument: $1" ;;
    esac
done

[ -n "$SOURCE_TAG" ] || fail '--source-tag is required'
[ -n "$RELEASE_TAG" ] || fail '--release-tag is required'
[ "$SOURCE_TAG" != "$RELEASE_TAG" ] || fail 'source and release tags must differ'
command -v docker >/dev/null 2>&1 || fail 'Docker is required'
git -C "$PROJECT_DIR" rev-parse --is-inside-work-tree >/dev/null 2>&1 \
    || fail 'project directory is not a Git worktree'

for tag in "$SOURCE_TAG" "$RELEASE_TAG"; do
    [ "$(git -C "$PROJECT_DIR" cat-file -t "refs/tags/$tag" 2>/dev/null || true)" = tag ] \
        || fail "release image reuse requires an annotated tag: $tag"
done

SOURCE_COMMIT="$(git -C "$PROJECT_DIR" rev-parse --verify "${SOURCE_TAG}^{}" 2>/dev/null || true)"
RELEASE_COMMIT="$(git -C "$PROJECT_DIR" rev-parse --verify "${RELEASE_TAG}^{}" 2>/dev/null || true)"
[[ "$SOURCE_COMMIT" =~ ^[0-9a-f]{40}$ ]] || fail 'source tag did not peel to a full commit'
[[ "$RELEASE_COMMIT" =~ ^[0-9a-f]{40}$ ]] || fail 'release tag did not peel to a full commit'
git -C "$PROJECT_DIR" merge-base --is-ancestor "$SOURCE_COMMIT" "$RELEASE_COMMIT" \
    || fail 'image source tag is not an ancestor of the candidate release'

# The three directories contain every file copied into the four self-built
# images. Compose owns Dockerfile selection and build args, so compare its
# normalized build-only projection separately; unrelated runtime service
# changes (for example SearXNG configuration) must not force network rebuilds.
IMAGE_CONTEXT_PATHS=(backend frontend python-service)
git -C "$PROJECT_DIR" diff --quiet "$SOURCE_COMMIT" "$RELEASE_COMMIT" -- "${IMAGE_CONTEXT_PATHS[@]}" \
    || fail 'self-built image contexts differ; a normal full image build is required'

TMP_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/vaysen-crm-image-reuse.XXXXXXXX")"
trap 'rm -rf -- "$TMP_ROOT"' EXIT HUP INT TERM

REPO_PREFIX="$(git -C "$PROJECT_DIR" rev-parse --show-prefix)"
COMPOSE_TREE_PATH="${REPO_PREFIX}docker-compose.prod.yml"
for spec in "source:$SOURCE_COMMIT" "release:$RELEASE_COMMIT"; do
    label="${spec%%:*}"
    commit="${spec#*:}"
    git -C "$PROJECT_DIR" show "$commit:$COMPOSE_TREE_PATH" > "$TMP_ROOT/$label-compose.yml" \
        || fail "could not read $label compose definition"
    RELEASE_COMMIT="$RELEASE_COMMIT" RELEASE_COMMIT_SHORT="${RELEASE_COMMIT:0:8}" \
        docker compose --project-directory "$PROJECT_DIR" --env-file "$PROJECT_DIR/.env" \
        -f "$TMP_ROOT/$label-compose.yml" config --format json \
        > "$TMP_ROOT/$label-compose.json" \
        || fail "could not normalize $label compose definition"
done

node - "$TMP_ROOT/source-compose.json" "$TMP_ROOT/release-compose.json" <<'NODE'
const fs = require('node:fs');
const [sourcePath, releasePath] = process.argv.slice(2);
const serviceNames = ['backend', 'frontend', 'python-service', 'worker-email-compose'];
const project = (file) => {
  const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
  return Object.fromEntries(serviceNames.map((name) => {
    const build = parsed?.services?.[name]?.build;
    if (!build) throw new Error(`missing self-built service contract: ${name}`);
    return [name, build];
  }));
};
const source = JSON.stringify(project(sourcePath));
const release = JSON.stringify(project(releasePath));
if (source !== release) {
  console.error('[IMAGE REUSE ERROR] normalized self-built Compose contracts differ');
  process.exit(1);
}
NODE

SOURCE_SHORT="${SOURCE_COMMIT:0:8}"
RELEASE_SHORT="${RELEASE_COMMIT:0:8}"
COMPONENTS=(backend backend-worker frontend python-service)

for component in "${COMPONENTS[@]}"; do
    source_image="vaysen-crm-${component}:${SOURCE_SHORT}"
    docker image inspect "$source_image" >/dev/null 2>&1 \
        || fail "reviewed source image is missing: $source_image"
    source_revision="$(docker image inspect -f '{{ index .Config.Labels "org.opencontainers.image.revision" }}' "$source_image" 2>/dev/null || true)"
    [ "$source_revision" = "$SOURCE_COMMIT" ] \
        || fail "source image revision mismatch: $source_image -> $source_revision"
done

cat > "$TMP_ROOT/Dockerfile.metadata" <<'DOCKERFILE'
ARG BASE_IMAGE=scratch
FROM ${BASE_IMAGE}
ARG RELEASE_COMMIT
LABEL org.opencontainers.image.revision=${RELEASE_COMMIT}
DOCKERFILE

cat > "$TMP_ROOT/Dockerfile.backend" <<'DOCKERFILE'
ARG BASE_IMAGE=scratch
FROM ${BASE_IMAGE}
USER root
ARG RELEASE_COMMIT
RUN set -eu; \
    previous_owner="$(stat -c '%u:%g' /app/BUILD_REVISION)"; \
    printf '%s\n' "$RELEASE_COMMIT" > /app/BUILD_REVISION; \
    chown "$previous_owner" /app/BUILD_REVISION
LABEL org.opencontainers.image.revision=${RELEASE_COMMIT}
USER appuser
DOCKERFILE

for component in "${COMPONENTS[@]}"; do
    source_image="vaysen-crm-${component}:${SOURCE_SHORT}"
    target_image="vaysen-crm-${component}:${RELEASE_SHORT}"
    dockerfile="$TMP_ROOT/Dockerfile.metadata"
    [ "$component" != backend ] || dockerfile="$TMP_ROOT/Dockerfile.backend"
    docker build --pull=false --network=none \
        --build-arg "BASE_IMAGE=$source_image" \
        --build-arg "RELEASE_COMMIT=$RELEASE_COMMIT" \
        --file "$dockerfile" --tag "$target_image" "$TMP_ROOT" >/dev/null \
        || fail "could not re-anchor image: $target_image"
    target_revision="$(docker image inspect -f '{{ index .Config.Labels "org.opencontainers.image.revision" }}' "$target_image" 2>/dev/null || true)"
    [ "$target_revision" = "$RELEASE_COMMIT" ] \
        || fail "target image revision mismatch: $target_image -> $target_revision"
done

backend_revision="$(docker run --rm --network none --entrypoint /bin/sh \
    "vaysen-crm-backend:${RELEASE_SHORT}" -ceu 'cat /app/BUILD_REVISION')"
[ "$backend_revision" = "$RELEASE_COMMIT" ] \
    || fail "backend BUILD_REVISION mismatch: $backend_revision"

printf '[IMAGE REUSE OK] sourceTag=%s sourceCommit=%s releaseTag=%s releaseCommit=%s contexts=unchanged network=none\n' \
    "$SOURCE_TAG" "$SOURCE_COMMIT" "$RELEASE_TAG" "$RELEASE_COMMIT"
