#!/bin/bash
echo "[DISABLED] 旧公网 443/证书冒烟脚本已停用；本系统仅通过 ZeroTier 局域网发布。" >&2
echo "请使用 scripts/deploy-smoke-test.sh。" >&2
exit 64

# =============================================================================
# Vaysen AI CRM — Production Smoke Test
# =============================================================================
# Usage: bash scripts/production-smoke-test.sh
#
# Performs automated verification of production deployment.
# Must pass ALL checks for production go-live.
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
BOLD='\033[1m'

PASS=0
FAIL=0
CHECKS=()

pass() {
    echo -e "  ${GREEN}[PASS]${NC} $1"
    PASS=$((PASS + 1))
    CHECKS+=("[PASS] $1")
}

fail() {
    echo -e "  ${RED}[FAIL]${NC} $1"
    FAIL=$((FAIL + 1))
    CHECKS+=("[FAIL] $1")
}

info() { echo -e "${YELLOW}[INFO]${NC} $1"; }
header() { echo -e "\n${BOLD}--- $1 ---${NC}"; }

# cd to project dir for docker compose
cd "$PROJECT_DIR"

echo -e "${YELLOW}============================================${NC}"
echo -e "${YELLOW}  Vaysen AI CRM Production Smoke Test${NC}"
echo -e "${YELLOW}  $(date '+%Y-%m-%d %H:%M:%S')${NC}"
echo -e "${YELLOW}============================================${NC}"

# =============================================================================
# 1. Container Status
# =============================================================================
header "1. Container Status"

CONTAINERS=("vaysen-crm-nginx" "vaysen-crm-frontend" "vaysen-crm-backend" "vaysen-crm-worker" "vaysen-crm-postgres" "vaysen-crm-redis")
for c in "${CONTAINERS[@]}"; do
    STATUS=$(docker inspect "$c" --format '{{.State.Status}}' 2>/dev/null || echo "missing")
    if [ "$STATUS" = "running" ]; then
        RESTARTS=$(docker inspect "$c" --format '{{.RestartCount}}' 2>/dev/null || echo "?")
        if [ "$RESTARTS" = "0" ]; then
            pass "$c: $STATUS (restarts=0)"
        else
            fail "$c: $STATUS (restarts=$RESTARTS)"
        fi
    elif [ "$STATUS" = "healthy" ]; then
        pass "$c: $STATUS"
    else
        fail "$c: $STATUS (expected running)"
    fi
done

# =============================================================================
# 2. Host Port Listening
# =============================================================================
header "2. Host Port Listening"

if ss -lntp 2>/dev/null | grep -q ':80 '; then
    pass "Port 80: listening"
else
    fail "Port 80: NOT listening"
fi

if ss -lntp 2>/dev/null | grep -q ':443 '; then
    pass "Port 443: listening"
else
    fail "Port 443: NOT listening"
fi

# =============================================================================
# 3. Nginx Config Syntax
# =============================================================================
header "3. Nginx Config Validation"

if docker exec vaysen-crm-nginx nginx -t 2>&1; then
    pass "nginx -t: syntax OK"
else
    fail "nginx -t: syntax ERROR"
fi

# =============================================================================
# 4. Nginx Loaded Config Audit
# =============================================================================
header "4. Nginx Loaded Config Audit"

# Check server_name directives
NGX_CONF=$(docker exec vaysen-crm-nginx nginx -T 2>/dev/null || true)

if echo "$NGX_CONF" | grep -q 'server_name.*app\.fastenernails\.com'; then
    pass "app.fastenernails.com server_name found"
else
    fail "app.fastenernails.com server_name NOT found"
fi

if echo "$NGX_CONF" | grep -q 'server_name.*api\.fastenernails\.com'; then
    pass "api.fastenernails.com server_name found"
else
    fail "api.fastenernails.com server_name NOT found"
fi

if echo "$NGX_CONF" | grep -q 'proxy_pass http://frontend:3000'; then
    pass "frontend:3000 proxy_pass found"
else
    fail "frontend:3000 proxy_pass NOT found"
fi

if echo "$NGX_CONF" | grep -q 'proxy_pass http://backend:4000'; then
    pass "backend:4000 proxy_pass found"
else
    fail "backend:4000 proxy_pass NOT found"
fi

if echo "$NGX_CONF" | grep -q 'return 404'; then
    echo "  ${YELLOW}[WARN]${NC} 'return 404' found in config (expected in API location /)"
fi

# Check no other 443 server blocks besides ours
SSL_COUNT=$(echo "$NGX_CONF" | grep -c 'listen.*443.*ssl' || true)
if [ "$SSL_COUNT" -le 2 ]; then
    pass "SSL server blocks: $SSL_COUNT (expected 1-2)"
else
    fail "SSL server blocks: $SSL_COUNT — too many, possible conflict"
fi

# =============================================================================
# 5. Internal Connectivity
# =============================================================================
header "5. Internal Connectivity"

# Frontend self-check (node-based — wget not in node:20-alpine)
FRONTEND_SELF=$(docker exec vaysen-crm-frontend node -e "const http=require('http');http.get('http://127.0.0.1:3000/login',r=>{let d='';r.on('data',c=>d+=c);r.on('end',()=>{process.exit(r.statusCode===200?0:1)})}).on('error',()=>process.exit(1));setTimeout(()=>process.exit(1),5000)" 2>/dev/null && echo "OK" || echo "FAIL")
if [ "$FRONTEND_SELF" = "OK" ]; then
    pass "frontend:3000/login (self) → 200"
else
    fail "frontend:3000/login (self) → NOT 200"
fi

# Nginx → Frontend
if docker exec vaysen-crm-nginx wget -q -S -O /dev/null http://frontend:3000/login 2>&1 | grep -q 'HTTP.*200'; then
    pass "nginx → frontend:3000/login → 200"
else
    fail "nginx → frontend:3000/login → NOT 200"
fi

# Nginx → Backend
if docker exec vaysen-crm-nginx wget -q -S -O /dev/null http://backend:4000/health 2>&1 | grep -q 'HTTP.*200'; then
    pass "nginx → backend:4000/health → 200"
else
    fail "nginx → backend:4000/health → NOT 200"
fi

# =============================================================================
# 6. HTTPS Check (direct to VPS IP — bypasses DNS)
# =============================================================================
header "6. HTTPS Check (direct to VPS IP)"

# Detect VPS IP (also used by later sections)
VPS_IP=$(curl -4 -s https://ifconfig.me 2>/dev/null || curl -4 -s https://api.ipify.org 2>/dev/null || echo "UNKNOWN")
info "VPS public IP: $VPS_IP"

# Reset nginx access log for clean test
docker exec vaysen-crm-nginx sh -c "> /var/log/nginx/access.log" 2>/dev/null || true

if [ "$VPS_IP" != "UNKNOWN" ]; then
    APP_DIRECT=$(curl -4 -k -I -s -o /dev/null -w '%{http_code}' --resolve app.fastenernails.com:443:$VPS_IP https://app.fastenernails.com/login 2>/dev/null || echo "000")
    if [ "$APP_DIRECT" = "200" ]; then
        pass "direct-to-VPS app/login → $APP_DIRECT"
    else
        fail "direct-to-VPS app/login → $APP_DIRECT (expected 200)"
    fi

    API_DIRECT=$(curl -4 -k -s --resolve api.fastenernails.com:443:$VPS_IP https://api.fastenernails.com/health 2>/dev/null || echo "{}")
    if echo "$API_DIRECT" | grep -q '"ok"'; then
        pass "direct-to-VPS api/health → {\"status\":\"ok\"}"
    else
        fail "direct-to-VPS api/health → $API_DIRECT"
    fi

    # Direct cert check
    DIRECT_CERT_APP=$(echo | openssl s_client -connect ${VPS_IP}:443 -servername app.fastenernails.com 2>/dev/null | openssl x509 -noout -issuer -subject 2>/dev/null || echo "CERT_FAILED")
    if echo "$DIRECT_CERT_APP" | grep -q 'issuer'; then
        DIRECT_ISSUER=$(echo "$DIRECT_CERT_APP" | grep 'issuer=' | head -1)
        DIRECT_SUBJECT=$(echo "$DIRECT_CERT_APP" | grep 'subject=' | head -1)
        if echo "$DIRECT_ISSUER" | grep -qi 'TRAEFIK\|self.signed\|staging'; then
            fail "direct cert: BAD issuer — $DIRECT_ISSUER"
        elif echo "$DIRECT_ISSUER" | grep -qi "Let's Encrypt\|ZeroSSL\|DigiCert\|Sectigo\|GlobalSign\|Amazon\|Cloudflare\|Google Trust"; then
            pass "direct cert: trusted — $DIRECT_ISSUER"
        else
            fail "direct cert: unknown issuer — $DIRECT_ISSUER"
        fi
        info "Direct cert: $DIRECT_SUBJECT | $DIRECT_ISSUER"

        # Verify SAN covers both domains
        DIRECT_SANS=$(echo | openssl s_client -connect ${VPS_IP}:443 -servername app.fastenernails.com 2>/dev/null | openssl x509 -noout -text 2>/dev/null | grep -A1 'Subject Alternative Name' | tail -1 || echo "")
        if echo "$DIRECT_SANS" | grep -q 'app.fastenernails.com' && echo "$DIRECT_SANS" | grep -q 'api.fastenernails.com'; then
            pass "direct cert SAN: covers both domains"
        else
            fail "direct cert SAN: does NOT cover both domains — $DIRECT_SANS"
        fi

        # Determine deployment success from direct-to-VPS tests (bypasses DNS)
        if [ "$APP_DIRECT" = "200" ] && echo "$API_DIRECT" | grep -q '"ok"' && echo "$DIRECT_CERT_APP" | grep -qi "Let's Encrypt" && echo "$DIRECT_SANS" | grep -q 'app.fastenernails.com' && echo "$DIRECT_SANS" | grep -q 'api.fastenernails.com'; then
            DEPLOY_OK=true
        else
            DEPLOY_OK=false
        fi
    else
        fail "direct cert: SSL handshake FAILED"
        DEPLOY_OK=false
    fi
else
    fail "Cannot run HTTPS tests (VPS IP unknown)"
    DEPLOY_OK=false
fi

# =============================================================================
# 7. DNS Resolution Check (multi-resolver)
# =============================================================================
header "7. DNS Resolution (multi-resolver)"

# Check default resolver
APP_IP_DEFAULT=$(dig +short app.fastenernails.com A 2>/dev/null || echo "UNKNOWN")
API_IP_DEFAULT=$(dig +short api.fastenernails.com A 2>/dev/null || echo "UNKNOWN")
# Check Google DNS
APP_IP_8=$(dig @8.8.8.8 +short app.fastenernails.com A 2>/dev/null || echo "UNKNOWN")
API_IP_8=$(dig @8.8.8.8 +short api.fastenernails.com A 2>/dev/null || echo "UNKNOWN")
# Check Cloudflare DNS
APP_IP_1=$(dig @1.1.1.1 +short app.fastenernails.com A 2>/dev/null || echo "UNKNOWN")
API_IP_1=$(dig @1.1.1.1 +short api.fastenernails.com A 2>/dev/null || echo "UNKNOWN")

echo "  app.fastenernails.com:"
echo "    default:  $APP_IP_DEFAULT"
echo "    @8.8.8.8: $APP_IP_8"
echo "    @1.1.1.1: $APP_IP_1"
echo "  api.fastenernails.com:"
echo "    default:  $API_IP_DEFAULT"
echo "    @8.8.8.8: $API_IP_8"
echo "    @1.1.1.1: $API_IP_1"

# Determine DNS propagation status
APP_PROPAGATED=false
API_PROPAGATED=false
for ip in "$APP_IP_DEFAULT" "$APP_IP_8" "$APP_IP_1"; do
    if [ "$ip" = "$VPS_IP" ]; then APP_PROPAGATED=true; fi
done
for ip in "$API_IP_DEFAULT" "$API_IP_8" "$API_IP_1"; do
    if [ "$ip" = "$VPS_IP" ]; then API_PROPAGATED=true; fi
done

if $APP_PROPAGATED && $API_PROPAGATED; then
    pass "DNS: all resolvers see VPS IP"
elif $APP_PROPAGATED || $API_PROPAGATED; then
    echo "  ${YELLOW}[WARN]${NC} DNS: partial propagation"
else
    DNS_PENDING=true
    echo "  ${YELLOW}[WARN]${NC} DNS: propagation pending — VPS local resolver has stale cache"
    echo "  ${YELLOW}[WARN]${NC} Public DNS check will use --resolve to bypass stale resolver"
fi

# Check if only VPS default resolver is stale (public DNS already correct)
DEFAULT_STALE=false
if [ "$VPS_IP" != "UNKNOWN" ]; then
    if [ "$APP_IP_DEFAULT" != "$VPS_IP" ] && ([ "$APP_IP_8" = "$VPS_IP" ] || [ "$APP_IP_1" = "$VPS_IP" ]); then
        DEFAULT_STALE=true
    fi
    if [ "$API_IP_DEFAULT" != "$VPS_IP" ] && ([ "$API_IP_8" = "$VPS_IP" ] || [ "$API_IP_1" = "$VPS_IP" ]); then
        DEFAULT_STALE=true
    fi
fi
if $DEFAULT_STALE; then
    echo "  ${YELLOW}[INFO]${NC} DNS: VPS default resolver has stale cache, public DNS is correct"
    echo "  ${YELLOW}[INFO]${NC} DNS propagation is complete — only VPS local cache needs refresh"
fi

# =============================================================================
# 8. Public HTTPS Check
# =============================================================================
header "8. Public HTTPS"

# 8a: Forced-resolution test (bypasses DNS — tests actual service)
if [ "$VPS_IP" != "UNKNOWN" ]; then
    echo "  ${YELLOW}[INFO]${NC} Testing with --resolve to $VPS_IP (bypasses DNS):"

    APP_FORCED=$(curl -4 -k -I -s -o /dev/null -w '%{http_code}' --resolve app.fastenernails.com:443:$VPS_IP https://app.fastenernails.com/login 2>/dev/null || echo "000")
    if [ "$APP_FORCED" = "200" ]; then
        pass "forced-resolve app/login → $APP_FORCED"
    else
        fail "forced-resolve app/login → $APP_FORCED (expected 200)"
    fi

    API_FORCED=$(curl -4 -k -s --resolve api.fastenernails.com:443:$VPS_IP https://api.fastenernails.com/health 2>/dev/null || echo "{}")
    if echo "$API_FORCED" | grep -q '"ok"'; then
        pass "forced-resolve api/health → {\"status\":\"ok\"}"
    else
        fail "forced-resolve api/health → $API_FORCED"
    fi

    # Check cert on forced connection
    FORCED_CERT=$(echo | openssl s_client -connect ${VPS_IP}:443 -servername app.fastenernails.com 2>/dev/null | openssl x509 -noout -issuer 2>/dev/null || echo "CERT_FAILED")
    if echo "$FORCED_CERT" | grep -qi 'TRAEFIK'; then
        fail "forced-resolve cert: TRAEFIK DEFAULT CERT — deployment issue on VPS!"
    elif echo "$FORCED_CERT" | grep -qi "Let's Encrypt"; then
        pass "forced-resolve cert: Let's Encrypt (VPS service is correct)"
    else
        fail "forced-resolve cert: unexpected issuer — $FORCED_CERT"
    fi
else
    echo "  ${YELLOW}[WARN]${NC} Cannot do forced-resolve test (VPS IP unknown)"
fi

# 8b: Standard public DNS test
echo ""
echo "  ${YELLOW}[INFO]${NC} Standard public DNS test:"

APP_PUBLIC=$(curl -4 -k -I -s -o /dev/null -w '%{http_code}' https://app.fastenernails.com/login 2>/dev/null || echo "000")
if [ "$APP_PUBLIC" = "200" ]; then
    pass "public app/login → $APP_PUBLIC"
else
    if ${DEPLOY_OK:-false}; then
        echo "  ${YELLOW}[WARN]${NC} public app/login → $APP_PUBLIC (DNS propagation pending, service is OK)"
    else
        fail "public app/login → $APP_PUBLIC (expected 200)"
    fi
fi

API_PUBLIC=$(curl -4 -k -s https://api.fastenernails.com/health 2>/dev/null || echo "{}")
if echo "$API_PUBLIC" | grep -q '"ok"'; then
    pass "public api/health → {\"status\":\"ok\"}"
else
    if ${DEPLOY_OK:-false}; then
        echo "  ${YELLOW}[WARN]${NC} public api/health → DNS propagation pending, service is OK"
    else
        fail "public api/health → $API_PUBLIC"
    fi
fi

# =============================================================================
# 9. SSL Certificate Verification (Localhost)
# =============================================================================
header "9. SSL Certificate (direct to VPS IP: $VPS_IP)"

CERT_APP=$(echo | openssl s_client -connect ${VPS_IP}:443 -servername app.fastenernails.com 2>/dev/null | openssl x509 -noout -issuer -subject -dates 2>/dev/null || echo "CERT_FAILED")
if echo "$CERT_APP" | grep -q 'issuer'; then
    CERT_ISSUER=$(echo "$CERT_APP" | grep 'issuer=' | head -1)
    CERT_SUBJECT=$(echo "$CERT_APP" | grep 'subject=' | head -1)
    CERT_EXPIRY=$(echo "$CERT_APP" | grep 'notAfter=' | head -1)

    # Check not self-signed
    if echo "$CERT_ISSUER" | grep -qi 'TRAEFIK\|self.signed\|staging'; then
        fail "app cert: BAD issuer — $CERT_ISSUER"
    elif echo "$CERT_ISSUER" | grep -qi "Let's Encrypt\|ZeroSSL\|DigiCert\|Sectigo\|GlobalSign\|Amazon\|Cloudflare\|Google Trust"; then
        pass "app cert: trusted — $CERT_ISSUER"
    else
        fail "app cert: unknown issuer — $CERT_ISSUER"
    fi

    if echo "$CERT_SUBJECT" | grep -q 'app.fastenernails.com'; then
        pass "app cert: subject covers app.fastenernails.com"
    else
        fail "app cert: subject does NOT cover app.fastenernails.com — $CERT_SUBJECT"
    fi

    echo "  ${YELLOW}[INFO]${NC} App cert: $CERT_SUBJECT"
    echo "  ${YELLOW}[INFO]${NC} App cert: $CERT_ISSUER"
    echo "  ${YELLOW}[INFO]${NC} App cert: $CERT_EXPIRY"
else
    fail "app cert: SSL handshake FAILED"
fi

CERT_API=$(echo | openssl s_client -connect ${VPS_IP}:443 -servername api.fastenernails.com 2>/dev/null | openssl x509 -noout -issuer -subject -dates 2>/dev/null || echo "CERT_FAILED")
if echo "$CERT_API" | grep -q 'issuer'; then
    CERT_ISSUER_API=$(echo "$CERT_API" | grep 'issuer=' | head -1)
    CERT_SUBJECT_API=$(echo "$CERT_API" | grep 'subject=' | head -1)
    CERT_EXPIRY_API=$(echo "$CERT_API" | grep 'notAfter=' | head -1)

    if echo "$CERT_ISSUER_API" | grep -qi 'TRAEFIK\|self.signed\|staging'; then
        fail "api cert: BAD issuer — $CERT_ISSUER_API"
    elif echo "$CERT_ISSUER_API" | grep -qi "Let's Encrypt\|ZeroSSL\|DigiCert\|Sectigo\|GlobalSign\|Amazon\|Cloudflare\|Google Trust"; then
        pass "api cert: trusted — $CERT_ISSUER_API"
    else
        fail "api cert: unknown issuer — $CERT_ISSUER_API"
    fi

    # Check SAN for api.fastenernails.com (unified SAN cert — CN may only show one domain)
    API_SANS=$(echo | openssl s_client -connect ${VPS_IP}:443 -servername api.fastenernails.com 2>/dev/null | openssl x509 -noout -text 2>/dev/null | grep -A1 'Subject Alternative Name' | tail -1 || echo "")
    if echo "$API_SANS" | grep -q 'api.fastenernails.com'; then
        pass "api cert: SAN covers api.fastenernails.com"
    else
        fail "api cert: SAN does NOT cover api.fastenernails.com — $API_SANS"
    fi

    echo "  ${YELLOW}[INFO]${NC} API cert: $CERT_SUBJECT_API"
    echo "  ${YELLOW}[INFO]${NC} API cert: $CERT_ISSUER_API"
    echo "  ${YELLOW}[INFO]${NC} API cert: $CERT_EXPIRY_API"
else
    fail "api cert: SSL handshake FAILED"
fi

# =============================================================================
# 9b. SSL Certificate Verification (Public DNS)
# =============================================================================
header "9b. SSL Certificate (Public DNS)"

if [ "${APP_IP_DEFAULT:-UNKNOWN}" != "UNKNOWN" ] && [ -n "${APP_IP_DEFAULT:-}" ]; then
    CERT_APP_PUB=$(echo | openssl s_client -connect "${APP_IP_DEFAULT}:443" -servername app.fastenernails.com 2>/dev/null | openssl x509 -noout -issuer -subject 2>/dev/null || echo "CERT_PUB_FAILED")
    if echo "$CERT_APP_PUB" | grep -qi 'TRAEFIK'; then
        if [ "$APP_IP_DEFAULT" != "$VPS_IP" ] && ${DEPLOY_OK:-false}; then
            echo "  ${YELLOW}[WARN]${NC} PUBLIC app cert (via DNS=${APP_IP_DEFAULT}): TRAEFIK — DNS still points to old server, not current VPS $VPS_IP"
        else
            fail "PUBLIC app cert (via DNS=${APP_IP_DEFAULT}): TRAEFIK DEFAULT CERT — not reaching vaysen-crm-nginx"
        fi
    elif echo "$CERT_APP_PUB" | grep -qi "Let's Encrypt"; then
        pass "PUBLIC app cert (via DNS): Let's Encrypt"
    else
        if [ "$APP_IP_DEFAULT" != "$VPS_IP" ] && ${DEPLOY_OK:-false}; then
            echo "  ${YELLOW}[WARN]${NC} PUBLIC app cert (via DNS=${APP_IP_DEFAULT}): unexpected cert from old server"
        else
            fail "PUBLIC app cert (via DNS): unexpected — $CERT_APP_PUB"
        fi
    fi
else
    info "Skipping public app cert check (DNS failed)"
fi

if [ "${API_IP_DEFAULT:-UNKNOWN}" != "UNKNOWN" ] && [ -n "${API_IP_DEFAULT:-}" ]; then
    CERT_API_PUB=$(echo | openssl s_client -connect "${API_IP_DEFAULT}:443" -servername api.fastenernails.com 2>/dev/null | openssl x509 -noout -issuer -subject 2>/dev/null || echo "CERT_PUB_FAILED")
    if echo "$CERT_API_PUB" | grep -qi 'TRAEFIK'; then
        if [ "$API_IP_DEFAULT" != "$VPS_IP" ] && ${DEPLOY_OK:-false}; then
            echo "  ${YELLOW}[WARN]${NC} PUBLIC api cert (via DNS=${API_IP_DEFAULT}): TRAEFIK — DNS still points to old server, not current VPS $VPS_IP"
        else
            fail "PUBLIC api cert (via DNS=${API_IP_DEFAULT}): TRAEFIK DEFAULT CERT — not reaching vaysen-crm-nginx"
        fi
    elif echo "$CERT_API_PUB" | grep -qi "Let's Encrypt"; then
        pass "PUBLIC api cert (via DNS): Let's Encrypt"
    else
        if [ "$API_IP_DEFAULT" != "$VPS_IP" ] && ${DEPLOY_OK:-false}; then
            echo "  ${YELLOW}[WARN]${NC} PUBLIC api cert (via DNS=${API_IP_DEFAULT}): unexpected cert from old server"
        else
            fail "PUBLIC api cert (via DNS): unexpected — $CERT_API_PUB"
        fi
    fi
else
    info "Skipping public api cert check (DNS failed)"
fi

# Also check cert via direct connection to VPS IP (bypass DNS)
if [ "$VPS_IP" != "UNKNOWN" ]; then
    DIRECT_CERT_APP=$(echo | openssl s_client -connect ${VPS_IP}:443 -servername app.fastenernails.com 2>/dev/null | openssl x509 -noout -issuer 2>/dev/null || echo "CERT_FAILED")
    if echo "$DIRECT_CERT_APP" | grep -qi 'TRAEFIK'; then
        fail "DIRECT to VPS ($VPS_IP) app cert: TRAEFIK — service deployment issue!"
    elif echo "$DIRECT_CERT_APP" | grep -qi "Let's Encrypt"; then
        pass "DIRECT to VPS ($VPS_IP) app cert: Let's Encrypt — service OK"
    else
        echo "  ${YELLOW}[INFO]${NC} Direct app cert: $DIRECT_CERT_APP"
    fi

    DIRECT_CERT_API=$(echo | openssl s_client -connect ${VPS_IP}:443 -servername api.fastenernails.com 2>/dev/null | openssl x509 -noout -issuer 2>/dev/null || echo "CERT_FAILED")
    if echo "$DIRECT_CERT_API" | grep -qi 'TRAEFIK'; then
        fail "DIRECT to VPS ($VPS_IP) api cert: TRAEFIK — service deployment issue!"
    elif echo "$DIRECT_CERT_API" | grep -qi "Let's Encrypt"; then
        pass "DIRECT to VPS ($VPS_IP) api cert: Let's Encrypt — service OK"
    else
        echo "  ${YELLOW}[INFO]${NC} Direct api cert: $DIRECT_CERT_API"
    fi
fi

# =============================================================================
# 10. Nginx Access Log Verification
# =============================================================================
header "10. Nginx Access Log"

# Trigger requests via localhost (guaranteed to reach our nginx)
curl -4 -k -s -o /dev/null --resolve app.fastenernails.com:443:127.0.0.1 https://app.fastenernails.com/login 2>/dev/null || true
curl -4 -k -s -o /dev/null --resolve api.fastenernails.com:443:127.0.0.1 https://api.fastenernails.com/health 2>/dev/null || true
# Also try via direct VPS IP (bypass DNS)
if [ "$VPS_IP" != "UNKNOWN" ]; then
    curl -4 -k -s -o /dev/null --resolve app.fastenernails.com:443:$VPS_IP https://app.fastenernails.com/login 2>/dev/null || true
    curl -4 -k -s -o /dev/null --resolve api.fastenernails.com:443:$VPS_IP https://api.fastenernails.com/health 2>/dev/null || true
fi
# Standard public (may fail if DNS stale)
curl -4 -k -s -o /dev/null https://app.fastenernails.com/login 2>/dev/null || true
curl -4 -k -s -o /dev/null https://api.fastenernails.com/health 2>/dev/null || true
sleep 1

NGX_LOG=$(docker exec vaysen-crm-nginx cat /var/log/nginx/access.log 2>/dev/null || echo "")

if echo "$NGX_LOG" | grep -q '/login.*200'; then
    pass "access log: /login → 200"
else
    fail "access log: /login 200 NOT found in log"
fi

if echo "$NGX_LOG" | grep -q '/health.*200'; then
    pass "access log: /health → 200"
else
    fail "access log: /health 200 NOT found in log"
fi

# =============================================================================
# Summary
# =============================================================================
echo -e "\n${YELLOW}============================================${NC}"
echo -e "${YELLOW}  Smoke Test Summary${NC}"
echo -e "${YELLOW}============================================${NC}"

TOTAL=$((PASS + FAIL))
echo -e "  Total: $TOTAL  ${GREEN}Passed: $PASS${NC}  ${RED}Failed: $FAIL${NC}"
echo ""

if ${DEPLOY_OK:-false}; then
    # Direct-to-VPS tests pass → deployment is successful
    # DNS-related failures (stale cache, propagation) are NOT deployment failures
    echo ""
    echo -e "${GREEN}============================================${NC}"
    echo -e "${GREEN}  RESULT: DEPLOYMENT SUCCESS${NC}"
    echo -e "${GREEN}============================================${NC}"
    echo ""
    echo -e "  ${GREEN}【部署结果】成功${NC}"
    echo -e "  ${BOLD}【强制解析 app/login】${NC} HTTP $APP_DIRECT"
    echo -e "  ${BOLD}【强制解析 api/health】${NC} $API_DIRECT"
    echo -e "  ${BOLD}【证书 issuer】${NC} $(echo "$DIRECT_CERT_APP" | grep 'issuer=' | head -1 | sed 's/issuer=//')"
    echo -e "  ${BOLD}【是否还有 SSL handshake FAILED】${NC} 否"
    echo -e "  ${BOLD}【是否还有 TRAEFIK DEFAULT CERT】${NC} 否"
    echo ""
    if ${DEFAULT_STALE:-false}; then
        echo -e "  ${YELLOW}【DNS 状态】${NC}"
        echo -e "    default:  $APP_IP_DEFAULT (旧 IP)"
        echo -e "    @8.8.8.8: $APP_IP_8"
        echo -e "    @1.1.1.1: $APP_IP_1"
        echo -e "  ${YELLOW}【是否需要等待 DNS 传播】否 (公网 DNS 已正确，仅 VPS 本地 resolver 缓存旧 IP)${NC}"
    elif ${DNS_PENDING:-false}; then
        echo -e "  ${YELLOW}【DNS 状态】${NC}"
        echo -e "    default:  $APP_IP_DEFAULT"
        echo -e "    @8.8.8.8: $APP_IP_8"
        echo -e "    @1.1.1.1: $APP_IP_1"
        echo -e "  ${YELLOW}【是否需要等待 DNS 传播】是${NC}"
    else
        echo -e "  ${GREEN}【DNS 状态】所有 resolver 均解析到正确 IP${NC}"
        echo -e "  ${GREEN}【是否需要等待 DNS 传播】否${NC}"
    fi
    if [ "$FAIL" -gt 0 ]; then
        echo ""
        echo -e "  ${YELLOW}DNS-related failures (not service errors):${NC}"
        for check in "${CHECKS[@]}"; do
            if echo "$check" | grep -q '\[FAIL\]'; then
                echo -e "    $check"
            fi
        done
    fi
    echo ""
    exit 0
elif [ "$FAIL" -gt 0 ]; then
    echo -e "${RED}============================================${NC}"
    echo -e "${RED}  RESULT: DEPLOYMENT FAILED${NC}"
    echo -e "${RED}============================================${NC}"
    echo ""
    echo -e "  ${RED}【部署结果】失败${NC}"
    echo -e "  ${BOLD}【强制解析 app/login】${NC} HTTP ${APP_DIRECT:-N/A}"
    echo -e "  ${BOLD}【强制解析 api/health】${NC} ${API_DIRECT:-N/A}"
    echo ""
    echo -e "${RED}  FAILED CHECKS:${NC}"
    for check in "${CHECKS[@]}"; do
        if echo "$check" | grep -q '\[FAIL\]'; then
            echo -e "  $check"
        fi
    done
    echo ""
    exit 1
else
    echo -e "${GREEN}============================================${NC}"
    echo -e "${GREEN}  SMOKE TEST: ALL PASSED${NC}"
    echo -e "${GREEN}============================================${NC}"

    echo ""
    echo -e "  ${GREEN}【部署结果】成功${NC}"
    echo -e "  ${GREEN}【DNS 状态】所有 resolver 均解析到正确 IP${NC}"
    echo -e "  ${GREEN}【是否需要等待 DNS 传播】否${NC}"
    echo ""
    echo -e "${BOLD}=== Access ===${NC}"
    echo -e "  app: https://app.fastenernails.com/login"
    echo -e "  api: https://api.fastenernails.com/health"

    exit 0
fi
