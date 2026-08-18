#!/usr/bin/env bash
set -euo pipefail

APP_DIR="${APP_DIR:-/opt/vaysen-ai-crm}"
BACKEND_DIR="$APP_DIR/backend"

cd "$BACKEND_DIR"

DB_URL="$(grep -m1 '^DATABASE_URL=' .env | cut -d= -f2- | sed 's/^"//; s/"$//')"
export PGPASSWORD="$(printf '%s' "$DB_URL" | sed -E 's#.*://[^:]+:([^@]+)@.*#\1#')"

echo "== Runtime listeners =="
ss -ltnp | grep -E ':4000|:4001|:4002|:4010|:4003|:4013' || true

echo
echo "== Environment summary =="
for file in .env .env.surfacepolish; do
  echo "-- $file"
  grep -E '^(DATABASE_URL|PORT|REDIS_DB|DEFAULT_COMPANY_SLUG)=' "$file" \
    | sed -E 's#(://[^:]+:)[^@]+#\1***#' || true
done

for schema in public surfacepolish; do
  echo
  echo "== Schema: $schema =="
  psql -h 127.0.0.1 -p 15432 -U vaysen-crm -d vaysen-crm_pilot -v ON_ERROR_STOP=1 <<SQL
SET search_path TO $schema;
SELECT 'Company' AS table_name, count(*) FROM "Company"
UNION ALL SELECT 'User', count(*) FROM "User"
UNION ALL SELECT 'Lead', count(*) FROM "Lead"
UNION ALL SELECT 'EmailAccount', count(*) FROM "EmailAccount"
UNION ALL SELECT 'EmailMessage', count(*) FROM "EmailMessage"
UNION ALL SELECT 'EmailTemplate', count(*) FROM "EmailTemplate";
SELECT email, "isActive", "deletedAt" IS NOT NULL AS soft_deleted FROM "User" ORDER BY email;
SELECT "senderEmail", status, "dailySentCount", "hourlySentCount" FROM "EmailAccount" ORDER BY "senderEmail";
SQL
done
