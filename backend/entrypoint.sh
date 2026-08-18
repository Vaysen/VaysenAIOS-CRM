#!/bin/sh
set -e

# =============================================================================
# Vaysen Docker Entrypoint — Production Startup
# =============================================================================
# 1. Wait for PostgreSQL TCP port to be reachable
# 2. Wait for PostgreSQL to accept authenticated connections
# 3. Run Prisma migrations only for an explicitly opted-in one-off command
# 4. Start the application
# =============================================================================

MAX_RETRIES=60
RETRY_INTERVAL=3

echo "[entrypoint] Waiting for PostgreSQL TCP port at postgres:5432..."

i=0
while [ $i -lt $MAX_RETRIES ]; do
  if node -e "const net=require('net');const s=net.createConnection(5432,'postgres');s.on('connect',()=>{s.end();process.exit(0)});s.on('error',()=>{s.destroy();process.exit(1)});setTimeout(()=>{s.destroy();process.exit(1)},3000)" 2>/dev/null; then
    echo "[entrypoint] PostgreSQL TCP port is reachable."
    break
  fi
  i=$((i + 1))
  if [ $i -ge $MAX_RETRIES ]; then
    echo "[entrypoint] ERROR: PostgreSQL TCP port not reachable after $((MAX_RETRIES * RETRY_INTERVAL))s"
    exit 1
  fi
  echo "[entrypoint] TCP not ready (attempt $i/$MAX_RETRIES), retrying in ${RETRY_INTERVAL}s..."
  sleep $RETRY_INTERVAL
done

echo "[entrypoint] Verifying database credentials and connectivity..."

i=0
while [ $i -lt $MAX_RETRIES ]; do
  if node -e "
    const { PrismaClient } = require('@prisma/client');
    const prisma = new PrismaClient();
    prisma.\$connect()
      .then(() => { prisma.\$disconnect().then(() => process.exit(0)); })
      .catch((e) => { console.error(e.message); process.exit(1); });
  " 2>&1; then
    echo "[entrypoint] PostgreSQL is ready and credentials are valid."
    break
  fi
  i=$((i + 1))
  if [ $i -ge $MAX_RETRIES ]; then
    echo "[entrypoint] ERROR: PostgreSQL authentication failed after $((MAX_RETRIES * RETRY_INTERVAL))s"
    exit 1
  fi
  echo "[entrypoint] Database not ready (attempt $i/$MAX_RETRIES), retrying in ${RETRY_INTERVAL}s..."
  sleep $RETRY_INTERVAL
done

if [ "${RUN_SEED:-false}" = "true" ]; then
  echo "[entrypoint] ERROR: production runtime seeding is forbidden; run an audited one-off seed job" >&2
  exit 1
fi

if [ "${RUN_MIGRATIONS:-false}" = "true" ]; then
  echo "[entrypoint] Running Prisma migrations..."
  # 迁移失败必须阻断启动；禁止根据日志文本自动 migrate resolve，避免把
  # 未经 DBA 核验的失败迁移标记为 rolled-back 后继续启动。
  npm run prisma:deploy -- --schema=/app/prisma/schema.prisma

else
  echo "[entrypoint] Skipping Prisma migrations because RUN_MIGRATIONS=false"
fi

echo "[entrypoint] Starting application: $@"
exec "$@"
