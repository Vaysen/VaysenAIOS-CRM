#!/bin/bash
# =============================================================================
# Vaysen Pilot — Registration Diagnostic
# =============================================================================
# Run on VPS: bash scripts/test-register.sh
# =============================================================================
set -euo pipefail

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'
BOLD='\033[1m'

echo -e "${YELLOW}============================================${NC}"
echo -e "${YELLOW}  Registration Diagnostic${NC}"
echo -e "${YELLOW}============================================${NC}"

# 1. Check backend container
echo -e "\n${BOLD}1. Backend container status${NC}"
docker inspect vaysen-crm-backend --format 'Status: {{.State.Status}} | Restarts: {{.RestartCount}}' 2>/dev/null || echo "NOT FOUND"

# 2. Check backend logs for seed/errors
echo -e "\n${BOLD}2. Backend logs (last 50 lines)${NC}"
docker logs --tail=50 vaysen-crm-backend 2>&1 || echo "Cannot get logs"

# 3. Check backend health
echo -e "\n${BOLD}3. Backend /health${NC}"
HEALTH=$(curl -s http://localhost:4000/health 2>/dev/null || echo "FAILED")
echo "  $HEALTH"

# 4. Check if roles exist in DB
echo -e "\n${BOLD}4. Database roles check${NC}"
docker exec vaysen-crm-postgres psql -U vaysen-crm -d vaysen-crm_pilot -c "SELECT name, displayName, \"isSystem\" FROM \"Role\" ORDER BY name;" 2>&1 || echo "  Cannot query database"

# 5. Test register API directly (localhost:4000 bypasses nginx)
echo -e "\n${BOLD}5. Direct backend register test${NC}"
TIMESTAMP=$(date +%s)
REGISTER_RESULT=$(curl -s -w '\n%{http_code}' -X POST http://localhost:4000/api/auth/register \
  -H "Content-Type: application/json" \
  -d "{\"firstName\":\"Test\",\"lastName\":\"User\",\"email\":\"test${TIMESTAMP}@example.com\",\"password\":\"TestPass123\",\"companyName\":\"Test Corp\"}" 2>/dev/null || echo "CURL_FAILED")
HTTP_CODE=$(echo "$REGISTER_RESULT" | tail -1)
BODY=$(echo "$REGISTER_RESULT" | sed '$d')
echo "  HTTP status: $HTTP_CODE"
echo "  Response: $BODY"

if [ "$HTTP_CODE" = "201" ]; then
    echo -e "  ${GREEN}[PASS] Registration successful!${NC}"
elif [ "$HTTP_CODE" = "409" ]; then
    echo -e "  ${YELLOW}[WARN]${NC} Email conflict (may be leftover from previous test)"
elif echo "$BODY" | grep -q '"accessToken"'; then
    echo -e "  ${GREEN}[PASS] Registration successful (got accessToken)${NC}"
else
    echo -e "  ${RED}[FAIL]${NC} Registration failed — see response above for reason"
fi

# 6. Check if user was created
echo -e "\n${BOLD}6. Users in database${NC}"
docker exec vaysen-crm-postgres psql -U vaysen-crm -d vaysen-crm_pilot -c "SELECT id, email, \"firstName\", \"lastName\", \"createdAt\" FROM \"User\" ORDER BY \"createdAt\" DESC LIMIT 5;" 2>&1 || echo "  Cannot query"

echo -e "\n${YELLOW}============================================${NC}"
echo -e "${YELLOW}  Diagnostic Complete${NC}"
echo -e "${YELLOW}============================================${NC}"
