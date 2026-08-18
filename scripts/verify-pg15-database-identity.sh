#!/usr/bin/env bash
set -euo pipefail

: "${DATABASE_URL:?DATABASE_URL is required}"
: "${RESTORED_DATABASE_URL:?RESTORED_DATABASE_URL is required}"
command -v psql >/dev/null 2>&1 || {
  echo "[pg15-identity] psql is required" >&2
  exit 1
}

database_identity() {
  local database_url="$1"
  local identity
  identity="$(
    psql "$database_url" --no-psqlrc -v ON_ERROR_STOP=1 -AtF '|' -c \
      "SELECT pcs.system_identifier::text, db.oid::text FROM pg_control_system() AS pcs CROSS JOIN pg_database AS db WHERE db.datname = current_database()"
  )" || {
    echo "[pg15-identity] stable cluster/database identity query failed" >&2
    return 1
  }
  if [[ ! "$identity" =~ ^[0-9]+\|[0-9]+$ ]]; then
    echo "[pg15-identity] stable cluster/database identity is missing or malformed" >&2
    return 1
  fi
  printf '%s\n' "$identity"
}

empty_identity="$(database_identity "$DATABASE_URL")"
restored_identity="$(database_identity "$RESTORED_DATABASE_URL")"
if [ "$empty_identity" = "$restored_identity" ]; then
  echo "[pg15-identity] empty and restored URLs resolve to the same cluster system identifier and database OID" >&2
  exit 1
fi

echo "[pg15-identity] PASS: disposable databases have distinct stable identities"
