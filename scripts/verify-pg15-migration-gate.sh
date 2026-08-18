#!/usr/bin/env bash
set -euo pipefail

PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PRISMA_CLI="$PROJECT_DIR/node_modules/prisma/build/index.js"
SCHEMA="$PROJECT_DIR/backend/prisma/schema.prisma"
IDENTITY_HELPER="$PROJECT_DIR/scripts/verify-pg15-database-identity.sh"

[ -n "${DATABASE_URL:-}" ] || {
  echo "DATABASE_URL must point to a disposable empty PostgreSQL 15 database" >&2
  exit 1
}
[ -n "${RESTORED_DATABASE_URL:-}" ] || {
  echo "RESTORED_DATABASE_URL must point to a distinct restored PostgreSQL 15 database" >&2
  exit 2
}
[ -f "$PRISMA_CLI" ] || {
  echo "Prisma CLI is missing; run the Node 20/npm 10 clean install first" >&2
  exit 1
}
command -v psql >/dev/null 2>&1 || {
  echo "psql is required to attest the PostgreSQL server version" >&2
  exit 1
}

assert_pg15() {
  local label="$1"
  local database_url="$2"
  local server_version
  server_version="$(psql "$database_url" --no-psqlrc -Atqc 'SHOW server_version_num')"
  case "$server_version" in
    15????) ;;
    *)
      echo "[pg15-migrations] ${label}: expected PostgreSQL 15, got server_version_num=${server_version:-missing}" >&2
      exit 1
      ;;
  esac
}

assert_empty_database() {
  local database_url="$1"
  local user_relations prisma_table_absent
  user_relations="$(psql "$database_url" --no-psqlrc -v ON_ERROR_STOP=1 -Atqc \
    "SELECT count(*) FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname NOT IN ('pg_catalog', 'information_schema') AND n.nspname !~ '^pg_toast' AND c.relkind IN ('r', 'p', 'v', 'm', 'f')")"
  prisma_table_absent="$(psql "$database_url" --no-psqlrc -v ON_ERROR_STOP=1 -Atqc \
    "SELECT to_regclass('public._prisma_migrations') IS NULL")"
  if [ "$user_relations" != "0" ] || [ "$prisma_table_absent" != "t" ]; then
    echo "[pg15-migrations] empty database is not pristine before first deploy" >&2
    exit 1
  fi
}

run_gate() {
  local label="$1"
  local database_url="$2"
  echo "[pg15-migrations] ${label}: first deploy"
  DATABASE_URL="$database_url" node "$PRISMA_CLI" migrate deploy --schema "$SCHEMA"
  DATABASE_URL="$database_url" node "$PRISMA_CLI" migrate status --schema "$SCHEMA"
  DATABASE_URL="$database_url" node "$PRISMA_CLI" migrate diff \
    --from-url "$database_url" \
    --to-schema-datamodel "$SCHEMA" \
    --exit-code
  echo "[pg15-migrations] ${label}: continuous/idempotent deploy"
  DATABASE_URL="$database_url" node "$PRISMA_CLI" migrate deploy --schema "$SCHEMA"
}

node "$PROJECT_DIR/scripts/verify-prisma-migrations.mjs"
bash "$IDENTITY_HELPER"

assert_pg15 "empty database" "$DATABASE_URL"
assert_pg15 "restored database" "$RESTORED_DATABASE_URL"
assert_empty_database "$DATABASE_URL"
run_gate "empty database" "$DATABASE_URL"
run_gate "restored production-shaped database" "$RESTORED_DATABASE_URL"

echo "[pg15-migrations] PASS: empty, restored, drift, and continuous apply contracts"
