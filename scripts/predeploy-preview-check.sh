#!/bin/bash
# ============================================================
# Vaysen AI CRM — Preview Deploy Pre-Check
# Run before: docker compose -f docker-compose.preview.yml up -d
# ============================================================
set -e

RED='\033[0;31m'; GREEN='\033[0;32m'; NC='\033[0m'
pass() { echo -e "${GREEN}[PASS]${NC} $1"; }
fail() { echo -e "${RED}[FAIL]${NC} $1"; exit 1; }

echo "=== Vaysen AI CRM Preview Deploy Pre-Check ==="
echo ""

# 1. Docker
docker --version >/dev/null 2>&1 && pass "Docker installed" || fail "Docker not found"
docker compose version >/dev/null 2>&1 && pass "Docker Compose v2" || fail "Docker Compose v2 not found"

# 2. Ports
for port in 4000 4001 5432 6379; do
  if ss -tlnp | grep -q ":$port "; then
    echo -e "  ${RED}[WARN]${NC} Port $port is in use"
  else
    pass "Port $port available"
  fi
done

# 3. .env.preview
if [ -f .env.preview ]; then
  pass ".env.preview exists"
  # Check safety switches
  grep -q "EMAIL_SEND_ENABLED=false" .env.preview && pass "  Email send DISABLED" || fail "  EMAIL_SEND_ENABLED must be false"
  grep -q "WHATSAPP_SEND_ENABLED=false" .env.preview && pass "  WhatsApp send DISABLED" || fail "  WHATSAPP_SEND_ENABLED must be false"
  grep -q "AI_EXTERNAL_CALLS_ENABLED=false" .env.preview && pass "  AI external calls DISABLED" || fail "  AI_EXTERNAL_CALLS_ENABLED must be false"
	  grep -q "MARKETING_EMAIL_WORKERS_ENABLED=false" .env.preview && pass "  Marketing workers DISABLED" || fail "  MARKETING_EMAIL_WORKERS_ENABLED must be false"
  # Check no real keys
  grep -qi "sk-[a-zA-Z0-9]\{20,\}" .env.preview && fail "  API key found in .env.preview" || pass "  No real API keys detected"
else
  fail ".env.preview not found. Copy from .env.preview.example and configure."
fi

# 4. Files
for f in docker-compose.preview.yml frontend/Dockerfile backend/Dockerfile; do
  [ -f "$f" ] && pass "$f exists" || fail "$f missing"
done

# 5. No production override
[ ! -f docker-compose.prod.yml ] || pass "prod compose exists (separate from preview)"

echo ""
echo "=== Pre-check complete ==="
echo "If all passed: docker compose -f docker-compose.preview.yml --env-file .env.preview up -d --build"
