#!/bin/bash
# =============================================================================
# Vaysen Pilot — Pre-Deployment Check Script
# =============================================================================
# Usage: ./scripts/predeploy-check.sh
#
# Performs a full production readiness check:
#   1. Config validation
#   2. No-cache build of all images
#   3. Start all services (fresh containers)
#   4. Wait 60s for stabilization
#   5. Verify RestartCount == 0 for backend and worker
#   6. Verify State.Status == "running" for backend and worker
#   7. Scan logs for fatal errors
#   8. Preserve volumes on cleanup (no -v)
#
# Exit codes:
#   0 - All checks passed
#   1 - Check failed
# =============================================================================
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
COMPOSE_FILE="$PROJECT_DIR/docker-compose.prod.yml"
ENV_FILE="$PROJECT_DIR/.env.production"

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

pass() { echo -e "${GREEN}[PASS]${NC} $1"; }
fail() { echo -e "${RED}[FAIL]${NC} $1"; exit 1; }
info() { echo -e "${YELLOW}[INFO]${NC} $1"; }

cleanup() {
    info "Cleaning up test containers (preserving volumes)..."
    docker compose -f "$COMPOSE_FILE" --env-file "$ENV_FILE" down --remove-orphans 2>/dev/null || true
}

echo -e "${YELLOW}============================================${NC}"
echo -e "${YELLOW} Vaysen Pilot — Pre-Deployment Check${NC}"
echo -e "${YELLOW}============================================${NC}"
echo ""
echo -e "${YELLOW}This script will stop existing containers, rebuild,${NC}"
echo -e "${YELLOW}and start fresh. Data volumes are preserved.${NC}"
echo -e "${YELLOW}Press Ctrl+C within 5s to cancel.${NC}"
echo ""
sleep 5

trap cleanup EXIT

# ---------------------------------------------------------------------------
# 1. Validate docker compose config
# ---------------------------------------------------------------------------
info "Step 1/5: Validating docker compose config..."
if docker compose -f "$COMPOSE_FILE" --env-file "$ENV_FILE" config --quiet 2>&1; then
    pass "docker compose config is valid"
else
    fail "docker compose config validation failed"
fi

# ---------------------------------------------------------------------------
# 2. Build all images --no-cache
# ---------------------------------------------------------------------------
info "Step 2/5: Building all Docker images (--no-cache)..."
if docker compose -f "$COMPOSE_FILE" --env-file "$ENV_FILE" build --no-cache 2>&1; then
    pass "All images built successfully"
else
    fail "Docker build failed"
fi

# ---------------------------------------------------------------------------
# 3. Start services with --force-recreate
# ---------------------------------------------------------------------------
info "Step 3/5: Starting services with --force-recreate..."
docker compose -f "$COMPOSE_FILE" --env-file "$ENV_FILE" down --remove-orphans 2>/dev/null || true
docker compose -f "$COMPOSE_FILE" --env-file "$ENV_FILE" up -d --force-recreate 2>&1

# ---------------------------------------------------------------------------
# 4. Wait 60s then verify container health
# ---------------------------------------------------------------------------
info "Step 4/5: Waiting 60 seconds for services to stabilize..."
sleep 60

echo ""
info "Container status:"
docker compose -f "$COMPOSE_FILE" --env-file "$ENV_FILE" ps 2>&1
echo ""

FAILED=0

# Check RestartCount and State.Status for backend
BACKEND_RESTART=$(docker inspect vaysen-crm-backend --format '{{.RestartCount}}' 2>/dev/null || echo "-1")
BACKEND_STATUS=$(docker inspect vaysen-crm-backend --format '{{.State.Status}}' 2>/dev/null || echo "missing")
if [ "$BACKEND_RESTART" = "0" ] && [ "$BACKEND_STATUS" = "running" ]; then
    pass "backend: RestartCount=$BACKEND_RESTART, Status=$BACKEND_STATUS"
else
    fail "backend: RestartCount=$BACKEND_RESTART (expected 0), Status=$BACKEND_STATUS (expected running)"
fi

# Check RestartCount and State.Status for worker
WORKER_RESTART=$(docker inspect vaysen-crm-worker --format '{{.RestartCount}}' 2>/dev/null || echo "-1")
WORKER_STATUS=$(docker inspect vaysen-crm-worker --format '{{.State.Status}}' 2>/dev/null || echo "missing")
if [ "$WORKER_RESTART" = "0" ] && [ "$WORKER_STATUS" = "running" ]; then
    pass "worker: RestartCount=$WORKER_RESTART, Status=$WORKER_STATUS"
else
    fail "worker: RestartCount=$WORKER_RESTART (expected 0), Status=$WORKER_STATUS (expected running)"
fi

# ---------------------------------------------------------------------------
# 5. Scan logs for fatal errors
# ---------------------------------------------------------------------------
info "Step 5/5: Scanning backend and worker logs for errors..."

FATAL_PATTERNS='MODULE_NOT_FOUND|Cannot find module|PrismaClientInitializationError|PrismaClientKnownRequestError|libssl|ECONNREFUSED|Error:|Exception|FATAL'

BACKEND_LOGS=$(docker compose -f "$COMPOSE_FILE" --env-file "$ENV_FILE" logs --tail=200 backend 2>&1 || true)
BACKEND_ERRORS=$(echo "$BACKEND_LOGS" | grep -E "$FATAL_PATTERNS" 2>/dev/null || true)
if [ -z "$BACKEND_ERRORS" ]; then
    pass "Backend logs: no fatal errors detected"
else
    echo ""
    echo -e "${RED}Backend log errors:${NC}"
    echo "$BACKEND_ERRORS" | head -20
    echo ""
    fail "Backend logs contain fatal errors"
fi

WORKER_LOGS=$(docker compose -f "$COMPOSE_FILE" --env-file "$ENV_FILE" logs --tail=200 worker 2>&1 || true)
WORKER_ERRORS=$(echo "$WORKER_LOGS" | grep -E "$FATAL_PATTERNS" 2>/dev/null || true)
if [ -z "$WORKER_ERRORS" ]; then
    pass "Worker logs: no fatal errors detected"
else
    echo ""
    echo -e "${RED}Worker log errors:${NC}"
    echo "$WORKER_ERRORS" | head -20
    echo ""
    fail "Worker logs contain fatal errors"
fi

# ---------------------------------------------------------------------------
# Summary
# ---------------------------------------------------------------------------
echo ""
echo -e "${GREEN}============================================${NC}"
echo -e "${GREEN} All pre-deployment checks passed.${NC}"
echo -e "${GREEN}============================================${NC}"
echo ""
echo "Deploy on VPS:"
echo "  cd /opt/vaysen-crm"
echo "  git pull origin master"
echo "  docker compose -f docker-compose.prod.yml --env-file .env.production up -d --build"
echo "  sleep 60"
echo "  docker compose -f docker-compose.prod.yml --env-file .env.production ps"
echo ""
