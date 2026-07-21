#!/usr/bin/env bash
# Classify the restored backup without weakening migration rehearsal. A release
# may either introduce the reviewed target migration, or be a later code-only
# release whose production backup already contains exactly one successful copy.

set -euo pipefail

fail() {
    printf '[MIGRATION MODE ERROR] %s\n' "$*" >&2
    exit 1
}

[ "$#" -eq 4 ] \
    || fail 'expected: total successful unresolved rolled-back'

TOTAL="$1"
SUCCESSFUL="$2"
UNRESOLVED="$3"
ROLLED_BACK="$4"

for value in "$TOTAL" "$SUCCESSFUL" "$UNRESOLVED" "$ROLLED_BACK"; do
    [[ "$value" =~ ^[0-9]+$ ]] || fail 'all migration-ledger counts must be non-negative integers'
done

if [ "$TOTAL" -eq 0 ] && [ "$SUCCESSFUL" -eq 0 ] \
    && [ "$UNRESOLVED" -eq 0 ] && [ "$ROLLED_BACK" -eq 0 ]; then
    printf 'forward-migration\n'
    exit 0
fi

if [ "$TOTAL" -eq 1 ] && [ "$SUCCESSFUL" -eq 1 ] \
    && [ "$UNRESOLVED" -eq 0 ] && [ "$ROLLED_BACK" -eq 0 ]; then
    printf 'already-applied-noop\n'
    exit 0
fi

fail "unsafe target migration ledger state: total=$TOTAL successful=$SUCCESSFUL unresolved=$UNRESOLVED rolledBack=$ROLLED_BACK"
