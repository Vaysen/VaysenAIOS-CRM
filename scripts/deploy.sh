#!/usr/bin/env bash
# Deprecated compatibility entrypoint. There is exactly one production
# deployment implementation: the immutable, backup-first root deploy.sh.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"

printf '[DEPRECATED] scripts/deploy.sh delegates to the audited root deploy.sh.\n' >&2
printf '[DEPRECATED] RELEASE_TAG and the production owner/directory contract remain mandatory.\n' >&2
exec bash "$PROJECT_DIR/deploy.sh" "$@"
