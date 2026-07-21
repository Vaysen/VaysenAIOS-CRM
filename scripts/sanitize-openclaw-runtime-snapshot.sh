#!/usr/bin/env bash
# Remove only OpenClaw's reviewed, runtime-generated browser skill link from a
# copied snapshot. The live state is never mutated. Managed npm peer links stay
# intact and remain governed by the SQLite-backed runtime-link contract.

set -euo pipefail

STATE_ROOT="${1:-}"
TRANSIENT_RELATIVE='plugin-skills/browser-automation'
TRANSIENT_TARGET='/app/dist/extensions/browser/skills/browser-automation'

fail() { printf '[RUNTIME SNAPSHOT SANITIZE ERROR] %s\n' "$*" >&2; exit 1; }

[ "$#" -eq 1 ] || fail "usage: $0 <copied-openclaw-state-root>"
[ -d "$STATE_ROOT" ] && [ ! -L "$STATE_ROOT" ] \
    || fail "state root must be a real directory: $STATE_ROOT"

transient_path="$STATE_ROOT/$TRANSIENT_RELATIVE"
if [ -L "$transient_path" ]; then
    actual_target="$(readlink -- "$transient_path")"
    [ "$actual_target" = "$TRANSIENT_TARGET" ] \
        || fail "reviewed transient link has an unexpected target"
    rm -- "$transient_path"
elif [ -e "$transient_path" ]; then
    fail "reviewed transient link path is not a symlink"
fi

printf '[RUNTIME SNAPSHOT SANITIZE] reviewed transient browser skill link is absent from the copied snapshot\n'
