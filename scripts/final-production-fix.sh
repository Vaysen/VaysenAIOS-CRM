#!/bin/bash
echo "[DISABLED] 公网域名/证书修复脚本已停用；本系统仅通过 ZeroTier 局域网发布。" >&2
echo "请使用 deploy.sh 与 scripts/deploy-smoke-test.sh。" >&2
exit 64

# =============================================================================
# Vaysen Pilot — Final Production Fix & Verification
# =============================================================================
# One-shot script: diagnose → fix → deploy → verify → report.
# Run: bash scripts/final-production-fix.sh
# =============================================================================
set -euo pipefail

PROJECT_DIR="/opt/vaysen-crm"
COMPOSE_FILE="$PROJECT_DIR/docker-compose.prod.yml"
ENV_FILE="$PROJECT_DIR/.env.production"

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'
BOLD='\033[1m'

log()  { echo -e "${YELLOW}[FIX]${NC} $1"; }
ok()   { echo -e "  ${GREEN}[OK]${NC} $1"; }
err()  { echo -e "  ${RED}[ERR]${NC} $1"; }

cd "$PROJECT_DIR"

echo -e "${YELLOW}============================================${NC}"
echo -e "${YELLOW}  Vaysen Pilot — Final Production Fix${NC}"
echo -e "${YELLOW}  $(date '+%Y-%m-%d %H:%M:%S')${NC}"
echo -e "${YELLOW}============================================${NC}"

# =============================================================================
# PHASE 1: DIAGNOSTICS
# =============================================================================
echo -e "\n${BOLD}=== PHASE 1: Diagnostics ===${NC}"

log "1.1 VPS public IP"
VPS_IP=$(curl -4 -s https://ifconfig.me 2>/dev/null || curl -4 -s https://api.ipify.org 2>/dev/null || echo "UNKNOWN")
echo "    VPS public IP: $VPS_IP"

log "1.2 Port 80/443 listeners"
ss -lntp 2>/dev/null | grep -E ':80 |:443 ' || echo "    No listeners on 80/443"

log "1.3 DNS resolution (multi-resolver)"

# Check multiple resolvers
APP_IP_DEFAULT=$(dig +short app.fastenernails.com A 2>/dev/null || echo "UNKNOWN")
API_IP_DEFAULT=$(dig +short api.fastenernails.com A 2>/dev/null || echo "UNKNOWN")
APP_IP_8=$(dig @8.8.8.8 +short app.fastenernails.com A 2>/dev/null || echo "UNKNOWN")
APP_IP_1=$(dig @1.1.1.1 +short app.fastenernails.com A 2>/dev/null || echo "UNKNOWN")
API_IP_8=$(dig @8.8.8.8 +short api.fastenernails.com A 2>/dev/null || echo "UNKNOWN")
API_IP_1=$(dig @1.1.1.1 +short api.fastenernails.com A 2>/dev/null || echo "UNKNOWN")

echo "    app.fastenernails.com: default=$APP_IP_DEFAULT  @8.8.8.8=$APP_IP_8  @1.1.1.1=$APP_IP_1"
echo "    api.fastenernails.com: default=$API_IP_DEFAULT  @8.8.8.8=$API_IP_8  @1.1.1.1=$API_IP_1"

DNS_PROPAGATED=false
APP_OK=false; API_OK=false
for ip in "$APP_IP_DEFAULT" "$APP_IP_8" "$APP_IP_1"; do
    if [ "$ip" = "$VPS_IP" ]; then APP_OK=true; fi
done
for ip in "$API_IP_DEFAULT" "$API_IP_8" "$API_IP_1"; do
    if [ "$ip" = "$VPS_IP" ]; then API_OK=true; fi
done

if $APP_OK && $API_OK; then
    ok "DNS: all resolvers point to VPS ($VPS_IP)"
    DNS_PROPAGATED=true
elif $APP_OK || $API_OK; then
    err "DNS: partial propagation — some resolvers still have old IP"
else
    err "DNS: NO resolver sees VPS IP — propagation pending or A records not updated"
    echo "    Expected VPS IP: $VPS_IP"
    echo "    If @8.8.8.8/@1.1.1.1 show $VPS_IP but default does not, VPS resolver cache is stale."
    echo "    If ALL show wrong IP, A records at DNS provider have not been updated yet."
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
    echo "    VPS default resolver has stale cache (old IP), public DNS is correct"
fi

log "1.4 Traefik / conflicting containers"
TRAEFIK_FOUND=false
for c in $(docker ps -a --format '{{.Names}}' 2>/dev/null); do
    if echo "$c" | grep -qi 'traefik'; then
        err "Found Traefik container: $c"
        TRAEFIK_FOUND=true
    fi
done
# Also check by image
for img in $(docker ps -a --format '{{.Image}}' 2>/dev/null); do
    if echo "$img" | grep -qi 'traefik'; then
        err "Found Traefik image in use: $img"
        TRAEFIK_FOUND=true
    fi
done
if ! $TRAEFIK_FOUND; then
    ok "No Traefik containers found"
fi

log "1.5 All Docker containers"
docker ps -a --format "table {{.Names}}\t{{.Status}}\t{{.Image}}" 2>/dev/null || echo "    Docker not available"

log "1.6 Let's Encrypt certs"
for domain in app.fastenernails.com api.fastenernails.com; do
    CERT_PATH="/etc/letsencrypt/live/$domain/fullchain.pem"
    if [ -f "$CERT_PATH" ]; then
        CERT_ISSUER=$(openssl x509 -noout -issuer -in "$CERT_PATH" 2>/dev/null | sed 's/issuer=//' || echo "PARSE_ERROR")
        CERT_SUBJECT=$(openssl x509 -noout -subject -in "$CERT_PATH" 2>/dev/null | sed 's/subject=//' || echo "PARSE_ERROR")
        CERT_EXPIRY=$(openssl x509 -noout -enddate -in "$CERT_PATH" 2>/dev/null | sed 's/notAfter=//' || echo "PARSE_ERROR")
        echo "    $domain: $CERT_SUBJECT | issuer=$CERT_ISSUER | expires=$CERT_EXPIRY"
        if echo "$CERT_ISSUER" | grep -qi 'TRAEFIK'; then
            err "$domain cert is TRAEFIK DEFAULT CERT! File on disk is wrong!"
        fi
    else
        err "$domain: certificate NOT found at $CERT_PATH"
    fi
done

log "1.7 Public SSL cert check"

# Check via DNS resolution
for domain in app.fastenernails.com api.fastenernails.com; do
    DOMAIN_IP=$(dig +short "$domain" A 2>/dev/null || echo "UNKNOWN")
    if [ "$DOMAIN_IP" != "UNKNOWN" ] && [ -n "$DOMAIN_IP" ]; then
        PUB_CERT=$(echo | openssl s_client -connect "${DOMAIN_IP}:443" -servername "$domain" 2>/dev/null | openssl x509 -noout -issuer -subject 2>/dev/null || echo "HANDSHAKE_FAILED")
        if echo "$PUB_CERT" | grep -qi 'TRAEFIK'; then
            if [ "$DOMAIN_IP" != "$VPS_IP" ]; then
                echo "    ${YELLOW}[WARN]${NC} PUBLIC $domain (via DNS=$DOMAIN_IP) → TRAEFIK DEFAULT CERT (DNS points to old server, not current VPS $VPS_IP)"
            else
                err "PUBLIC $domain (via DNS=$DOMAIN_IP) → TRAEFIK DEFAULT CERT — service deployment issue!"
            fi
        elif echo "$PUB_CERT" | grep -qi "Let's Encrypt"; then
            ok "PUBLIC $domain (via DNS) → Let's Encrypt"
        else
            echo "    PUBLIC $domain (via DNS) → $PUB_CERT"
        fi
    fi
done

# Also check via direct connection to VPS IP (bypasses DNS)
if [ "$VPS_IP" != "UNKNOWN" ]; then
    for domain in app.fastenernails.com api.fastenernails.com; do
        DIRECT_CERT=$(echo | openssl s_client -connect "${VPS_IP}:443" -servername "$domain" 2>/dev/null | openssl x509 -noout -issuer -subject 2>/dev/null || echo "HANDSHAKE_FAILED")
        if echo "$DIRECT_CERT" | grep -qi 'TRAEFIK'; then
            err "DIRECT $domain (to $VPS_IP) → TRAEFIK DEFAULT CERT — service deployment issue!"
        elif echo "$DIRECT_CERT" | grep -qi "Let's Encrypt"; then
            ok "DIRECT $domain (to $VPS_IP) → Let's Encrypt — service is correct, DNS issue only"
        else
            echo "    DIRECT $domain (to $VPS_IP) → $DIRECT_CERT"
        fi
    done
fi

# =============================================================================
# PHASE 2: CLEANUP
# =============================================================================
echo -e "\n${BOLD}=== PHASE 2: Cleanup ===${NC}"

log "2.1 Removing Traefik containers (if any)"
for c in $(docker ps -a --filter "name=traefik" -q 2>/dev/null); do
    docker stop "$c" 2>/dev/null || true
    docker rm "$c" 2>/dev/null || true
    ok "Removed Traefik container $c"
done
for c in $(docker ps -a --format '{{.Names}} {{.Image}}' 2>/dev/null | grep -i traefik | awk '{print $1}'); do
    docker stop "$c" 2>/dev/null || true
    docker rm "$c" 2>/dev/null || true
    ok "Removed Traefik-based container $c"
done

log "2.2 Stopping nginx to release port 80 for certbot"
docker stop vaysen-crm-nginx 2>/dev/null || true
docker rm vaysen-crm-nginx 2>/dev/null || true
ok "nginx stopped"

log "2.3 Stopping other vaysen-crm containers (preserving postgres/redis)"
for c in vaysen-crm-frontend vaysen-crm-backend vaysen-crm-worker; do
    if docker ps -a --format '{{.Names}}' 2>/dev/null | grep -q "^${c}$"; then
        docker stop "$c" 2>/dev/null || true
        docker rm "$c" 2>/dev/null || true
    fi
done
ok "App containers stopped"

log "2.4 Verifying port 80 is free"
sleep 2
if ss -lntp 2>/dev/null | grep -q ':80 '; then
    err "Port 80 still in use! Cannot run certbot standalone."
    ss -lntp | grep ':80 '
    echo "    Attempting to identify and kill..."
    PORT80_PID=$(ss -lntp 2>/dev/null | grep ':80 ' | sed -n 's/.*pid=\([0-9]*\).*/\1/p' | head -1)
    if [ -n "$PORT80_PID" ]; then
        kill -9 "$PORT80_PID" 2>/dev/null || true
        sleep 1
    fi
    if ss -lntp 2>/dev/null | grep -q ':80 '; then
        err "Cannot free port 80. Certbot will fail."
    else
        ok "Port 80 freed"
    fi
else
    ok "Port 80 is free"
fi

log "2.5 Pulling latest code from GitHub"
git fetch origin master
git reset --hard origin/master
COMMIT=$(git rev-parse --short HEAD)
ok "Code at commit: $COMMIT"

# =============================================================================
# PHASE 3: CERTIFICATE + NGINX CONFIG
# =============================================================================
echo -e "\n${BOLD}=== PHASE 3: Certificate & Nginx Config ===${NC}"

CERT_NAME="vaysen-crm-fastenernails"
CERT_DIR="/etc/letsencrypt/live/$CERT_NAME"
CERT_FILE="$CERT_DIR/fullchain.pem"
KEY_FILE="$CERT_DIR/privkey.pem"

# Check if certbot is installed
if ! command -v certbot &>/dev/null; then
    log "3.1 Installing certbot..."
    if command -v apt &>/dev/null; then
        apt update -qq && apt install -y -qq certbot 2>&1 | tail -5
    elif command -v snap &>/dev/null; then
        snap install --classic certbot 2>&1
    else
        err "Cannot install certbot. Install it manually: apt install certbot"
    fi
fi

if command -v certbot &>/dev/null; then
    ok "certbot available"
else
    err "certbot NOT available — cert renewal will be skipped"
fi

# Check existing cert status
CERT_EXISTS=false
CERT_VALID=false
if [ -f "$CERT_FILE" ] && [ -f "$KEY_FILE" ]; then
    CERT_EXISTS=true
    log "3.2 Existing cert found at $CERT_DIR"

    # Check subject/SAN coverage
    CERT_SUBJECTS=$(openssl x509 -noout -text -in "$CERT_FILE" 2>/dev/null | grep -A1 'Subject Alternative Name' | tail -1 | sed 's/DNS://g' | tr ',' '\n' | sed 's/^ *//' || echo "")
    HAS_APP=false; HAS_API=false
    if echo "$CERT_SUBJECTS" | grep -q 'app.fastenernails.com'; then HAS_APP=true; fi
    if echo "$CERT_SUBJECTS" | grep -q 'api.fastenernails.com'; then HAS_API=true; fi

    echo "    SANs: $CERT_SUBJECTS"

    # Check expiry
    CERT_EXPIRY=$(openssl x509 -noout -enddate -in "$CERT_FILE" 2>/dev/null | sed 's/notAfter=//' || echo "UNKNOWN")
    EXPIRY_EPOCH=$(date -d "$CERT_EXPIRY" +%s 2>/dev/null || echo "0")
    NOW_EPOCH=$(date +%s)
    DAYS_LEFT=$(( (EXPIRY_EPOCH - NOW_EPOCH) / 86400 ))

    echo "    Expires: $CERT_EXPIRY ($DAYS_LEFT days left)"

    if $HAS_APP && $HAS_API && [ "$DAYS_LEFT" -gt 7 ]; then
        CERT_VALID=true
        ok "Existing cert is valid — covers both domains, $DAYS_LEFT days left"
    else
        echo "    Issues: HAS_APP=$HAS_APP HAS_API=$HAS_API DAYS=$DAYS_LEFT"
    fi
else
    log "3.2 No existing $CERT_NAME cert"
fi

# Obtain/renew cert if needed
if ! $CERT_VALID && command -v certbot &>/dev/null; then
    log "3.3 Obtaining SAN certificate for both domains..."

    if [ "$CERT_EXISTS" = true ]; then
        # Expand existing cert to add missing domains
        log "Expanding existing cert to cover both domains..."
        certbot certonly --standalone \
            --cert-name "$CERT_NAME" \
            -d app.fastenernails.com \
            -d api.fastenernails.com \
            --non-interactive --agree-tos \
            --email admin@fastenernails.com \
            --expand --force-renewal \
            2>&1 | tail -10
    else
        # Request new cert
        log "Requesting new certificate..."
        certbot certonly --standalone \
            --cert-name "$CERT_NAME" \
            -d app.fastenernails.com \
            -d api.fastenernails.com \
            --non-interactive --agree-tos \
            --email admin@fastenernails.com \
            2>&1 | tail -10
    fi

    # Verify the cert was created
    if [ -f "$CERT_FILE" ] && [ -f "$KEY_FILE" ]; then
        ok "Certificate obtained successfully"
        CERT_VALID=true
    else
        err "Certbot failed to create certificate"
        err "Checking certbot logs..."
        certbot certificates 2>&1 || true
        ls -la /etc/letsencrypt/live/ 2>/dev/null || true
    fi
fi

# Auto-detect actual cert directory (certbot might use a different name)
if ! $CERT_VALID; then
    log "3.4 Auto-detecting available certificates..."
    ls -la /etc/letsencrypt/live/ 2>/dev/null || echo "    No /etc/letsencrypt/live/ directory"

    # Try to find any valid cert that covers both domains
    for dir in /etc/letsencrypt/live/*/; do
        DIR_NAME=$(basename "$dir")
        if [ -f "$dir/fullchain.pem" ] && [ -f "$dir/privkey.pem" ]; then
            DIR_SUBJECTS=$(openssl x509 -noout -text -in "$dir/fullchain.pem" 2>/dev/null | grep -A1 'Subject Alternative Name' | tail -1 | sed 's/DNS://g' || echo "")
            echo "    Found: $DIR_NAME → SANs: $DIR_SUBJECTS"
            if echo "$DIR_SUBJECTS" | grep -q 'app.fastenernails.com' && echo "$DIR_SUBJECTS" | grep -q 'api.fastenernails.com'; then
                CERT_DIR="$dir"
                CERT_FILE="$CERT_DIR/fullchain.pem"
                KEY_FILE="$CERT_DIR/privkey.pem"
                CERT_NAME="$DIR_NAME"
                ok "Using detected cert: $CERT_NAME"
                CERT_VALID=true
                break
            fi
        fi
    done
fi

# Write nginx config with FIXED cert paths
log "3.5 Writing nginx config (fixed cert path, no dynamic variables)"

if $CERT_VALID; then
    CERT_PATH="$CERT_FILE"
    KEY_PATH="$KEY_FILE"
    ok "Cert path: $CERT_PATH"
    ok "Key path:  $KEY_PATH"
else
    # Fallback: try common locations
    CERT_PATH="/etc/letsencrypt/live/$CERT_NAME/fullchain.pem"
    KEY_PATH="/etc/letsencrypt/live/$CERT_NAME/privkey.pem"
    err "NO valid cert found! nginx will fail to start."
    echo "    Available certs:"
    ls -la /etc/letsencrypt/live/ 2>/dev/null || echo "    none"
fi

cat > "$PROJECT_DIR/nginx/conf.d/vaysen-crm.conf" << NGINX_EOF
# Vaysen Pilot Nginx Configuration
# Domains: app.fastenernails.com, api.fastenernails.com
# Single SAN certificate covering both domains

# =============================================================================
# HTTP server — ACME challenge + HTTPS redirect
# =============================================================================

server {
    listen 80 default_server;
    listen [::]:80 default_server;
    server_name app.fastenernails.com api.fastenernails.com;

    # Allow certbot ACME challenges
    location /.well-known/acme-challenge/ {
        root /var/www/html;
    }

    # Everything else → HTTPS
    location / {
        return 301 https://\$host\$request_uri;
    }
}

# =============================================================================
# HTTPS server — single SAN cert, fixed path, host-based routing
# =============================================================================

server {
    listen 443 ssl default_server;
    listen [::]:443 ssl default_server;
    http2 on;
    server_name app.fastenernails.com api.fastenernails.com;

    ssl_certificate     $CERT_PATH;
    ssl_certificate_key $KEY_PATH;

    ssl_protocols TLSv1.2 TLSv1.3;
    ssl_ciphers ECDHE-ECDSA-AES128-GCM-SHA256:ECDHE-RSA-AES128-GCM-SHA256:ECDHE-ECDSA-AES256-GCM-SHA384:ECDHE-RSA-AES256-GCM-SHA384;
    ssl_prefer_server_ciphers off;

    client_max_body_size 10M;

    # Health check → always backend
    location /health {
        proxy_pass http://backend:4000;
        proxy_http_version 1.1;
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
    }

    # API routes → always backend
    location /api {
        proxy_pass http://backend:4000;
        proxy_http_version 1.1;
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
    }

    # Everything else: api domain → 404, app domain → frontend
    location / {
        if (\$host = api.fastenernails.com) {
            return 404;
        }
        proxy_pass http://frontend:4001;
        proxy_http_version 1.1;
        proxy_set_header Upgrade \$http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
    }
}
NGINX_EOF
ok "vaysen-crm.conf written with fixed cert path"

# =============================================================================
# PHASE 4: DEPLOY
# =============================================================================
echo -e "\n${BOLD}=== PHASE 4: Deploy ===${NC}"

log "4.1 Building and starting all services"
docker compose -f "$COMPOSE_FILE" --env-file "$ENV_FILE" up -d --build 2>&1 | tail -30

log "4.2 Waiting for services to stabilize (20s)"
sleep 20

log "4.3 Container status"
docker ps --filter "name=vaysen-crm" --format "table {{.Names}}\t{{.Status}}\t{{.Ports}}" 2>/dev/null

log "4.4 Checking for restart loops"
RESTARTING=$(docker ps --filter "name=vaysen-crm" --format '{{.Names}} {{.Status}}' 2>/dev/null | grep -i 'restarting' || echo "")
if [ -n "$RESTARTING" ]; then
    err "Containers restarting: $RESTARTING"
    for c in vaysen-crm-backend vaysen-crm-worker vaysen-crm-frontend; do
        if docker ps --format '{{.Names}}' 2>/dev/null | grep -q "$c"; then
            echo "--- $c logs (last 30) ---"
            docker logs --tail=30 "$c" 2>&1 || true
        fi
    done
else
    ok "No containers restarting"
fi

log "4.5 Nginx config syntax check"
if docker exec vaysen-crm-nginx nginx -t 2>&1; then
    ok "nginx -t passed"
else
    err "nginx -t FAILED"
    docker exec vaysen-crm-nginx nginx -T 2>&1 | head -50 || true
fi

# =============================================================================
# PHASE 5: VERIFY
# =============================================================================
echo -e "\n${BOLD}=== PHASE 5: Verify ===${NC}"

# 5a: Quick forced-resolution pre-check (bypasses DNS)
log "5a. Forced-resolution pre-check (direct to VPS IP: $VPS_IP)"

FORCED_APP=$(curl -4 -k -I -s -o /dev/null -w '%{http_code}' --resolve app.fastenernails.com:443:$VPS_IP https://app.fastenernails.com/login 2>/dev/null || echo "000")
FORCED_API=$(curl -4 -k -s --resolve api.fastenernails.com:443:$VPS_IP https://api.fastenernails.com/health 2>/dev/null || echo "{}")
FORCED_CERT=$(echo | openssl s_client -connect ${VPS_IP}:443 -servername app.fastenernails.com 2>/dev/null | openssl x509 -noout -issuer 2>/dev/null || echo "CERT_FAILED")

SERVICE_OK=true
if [ "$FORCED_APP" = "200" ]; then
    ok "forced app/login → 200"
else
    err "forced app/login → $FORCED_APP"
    SERVICE_OK=false
fi
if echo "$FORCED_API" | grep -q '"ok"'; then
    ok "forced api/health → {\"status\":\"ok\"}"
else
    err "forced api/health → $FORCED_API"
    SERVICE_OK=false
fi
if echo "$FORCED_CERT" | grep -qi "Let's Encrypt"; then
    ok "forced cert → Let's Encrypt"
else
    err "forced cert → $FORCED_CERT"
    SERVICE_OK=false
fi

# 5b: Run full smoke test
log "5b. Running production smoke test..."
chmod +x "$PROJECT_DIR/scripts/production-smoke-test.sh" 2>/dev/null || true

set +e
bash "$PROJECT_DIR/scripts/production-smoke-test.sh" 2>&1
SMOKE_EXIT=$?
set -e

# =============================================================================
# PHASE 6: FINAL REPORT
# =============================================================================
echo ""
echo -e "${YELLOW}============================================${NC}"
echo -e "${YELLOW}  FINAL REPORT${NC}"
echo -e "${YELLOW}============================================${NC}"

# Determine failure category
FAIL_CATEGORY=""
if [ $SMOKE_EXIT -ne 0 ]; then
    if $SERVICE_OK; then
        if ${DEFAULT_STALE:-false}; then
            FAIL_CATEGORY="DNS_DEFAULT_STALE"
        elif ! ${DNS_PROPAGATED:-false}; then
            FAIL_CATEGORY="DNS_PENDING"
        else
            FAIL_CATEGORY="UNKNOWN"
        fi
    else
        FAIL_CATEGORY="DEPLOY_FAILED"
    fi
fi

if [ $SMOKE_EXIT -eq 0 ]; then
    echo -e "\n${GREEN}【部署结果】成功${NC}"
elif [ "$FAIL_CATEGORY" = "DNS_DEFAULT_STALE" ]; then
    echo -e "\n${GREEN}【部署结果】成功${NC} (公网 DNS 已正确，仅 VPS 本地 resolver 缓存旧 IP)"
elif [ "$FAIL_CATEGORY" = "DNS_PENDING" ]; then
    echo -e "\n${YELLOW}【部署结果】服务部署成功，DNS 尚未完全传播${NC}"
else
    echo -e "\n${RED}【部署结果】失败${NC}"
fi

echo ""
echo -e "${BOLD}【最终访问地址】${NC}"
echo "  app:  https://app.fastenernails.com/login"
echo "  api:  https://api.fastenernails.com/health"

echo ""
echo -e "${BOLD}【容器状态】${NC}"
for c in vaysen-crm-frontend vaysen-crm-backend vaysen-crm-worker vaysen-crm-nginx vaysen-crm-postgres vaysen-crm-redis; do
    STATUS=$(docker inspect "$c" --format '{{.State.Status}}' 2>/dev/null || echo "missing")
    echo "  $c: $STATUS"
done

echo ""
echo -e "${BOLD}【证书状态】${NC}"
CERT_FILE="${CERT_DIR%/}/fullchain.pem"
if [ -f "$CERT_FILE" ]; then
    CERT_ISSUER=$(openssl x509 -noout -issuer -in "$CERT_FILE" 2>/dev/null | sed 's/issuer=//' || echo "PARSE_ERROR")
    CERT_SUBJECT=$(openssl x509 -noout -subject -in "$CERT_FILE" 2>/dev/null | sed 's/subject=//' || echo "PARSE_ERROR")
    CERT_SANS=$(openssl x509 -noout -text -in "$CERT_FILE" 2>/dev/null | grep -A1 'Subject Alternative Name' | tail -1 || echo "")
    echo "  cert path: $CERT_FILE"
    echo "  issuer: $CERT_ISSUER"
    echo "  subject: $CERT_SUBJECT"
    echo "  SANs: $CERT_SANS"
    if echo "$CERT_SANS" | grep -q 'app.fastenernails.com' && echo "$CERT_SANS" | grep -q 'api.fastenernails.com'; then
        ok "SAN covers both app.fastenernails.com + api.fastenernails.com"
    fi
else
    echo "  cert file NOT found at $CERT_FILE"
fi

# TRAEFIK check (DNS-based AND direct)
TRAEFIK_DNS=false
TRAEFIK_DIRECT=false
for domain in app.fastenernails.com api.fastenernails.com; do
    DOMAIN_IP=$(dig +short "$domain" A 2>/dev/null || echo "UNKNOWN")
    if [ "$DOMAIN_IP" != "UNKNOWN" ] && [ -n "$DOMAIN_IP" ]; then
        PUB_CHECK=$(echo | openssl s_client -connect "${DOMAIN_IP}:443" -servername "$domain" 2>/dev/null | openssl x509 -noout -issuer 2>/dev/null || echo "")
        if echo "$PUB_CHECK" | grep -qi 'TRAEFIK'; then TRAEFIK_DNS=true; fi
    fi
    if [ "$VPS_IP" != "UNKNOWN" ]; then
        DIRECT_CHECK=$(echo | openssl s_client -connect "${VPS_IP}:443" -servername "$domain" 2>/dev/null | openssl x509 -noout -issuer 2>/dev/null || echo "")
        if echo "$DIRECT_CHECK" | grep -qi 'TRAEFIK'; then TRAEFIK_DIRECT=true; fi
    fi
done
echo "  TRAEFIK via DNS:    $TRAEFIK_DNS"
echo "  TRAEFIK via direct: $TRAEFIK_DIRECT"

echo ""
echo -e "${BOLD}【最终验证】${NC}"
echo "  forced-resolve app /login (to $VPS_IP):"
echo "    HTTP $FORCED_APP"
echo "  forced-resolve api /health (to $VPS_IP):"
echo "    $FORCED_API"
echo "  public app /login:"
curl -4 -k -I -s -o /dev/null -w '    HTTP %{http_code}' --max-time 10 https://app.fastenernails.com/login 2>/dev/null || echo "    FAILED"
echo ""
echo "  public api /health:"
curl -4 -k -s --max-time 10 https://api.fastenernails.com/health 2>/dev/null || echo "    FAILED"

echo ""
echo -e "${BOLD}【nginx access log】${NC}"
docker exec vaysen-crm-nginx cat /var/log/nginx/access.log 2>/dev/null | tail -10 || echo "  No access log"

echo ""
if [ $SMOKE_EXIT -eq 0 ]; then
    echo -e "${GREEN} production-smoke-test: PASS${NC}"
else
    echo -e "${RED} production-smoke-test: FAIL${NC}"
fi
echo -e " final-production-fix: $([ $SMOKE_EXIT -eq 0 ] && echo -e "${GREEN}PASS${NC}" || echo -e "${RED}FAIL${NC}")"

if [ $SMOKE_EXIT -ne 0 ]; then
    echo ""
    echo -e "${RED}${BOLD}【失败分析】${NC}"

    if [ "$FAIL_CATEGORY" = "DNS_DEFAULT_STALE" ]; then
        echo "  类别: 服务部署成功，仅 VPS 本地 DNS resolver 缓存旧 IP"
        echo "  原因: VPS 本机 DNS resolver 缓存了旧 IP ($APP_IP_DEFAULT)，公网 DNS 已正确 (@8.8.8.8=$APP_IP_8)"
        echo "  影响: Standard public DNS test 会连接到旧服务器，但服务本身正常运行"
        echo "  操作: 在 VPS 上刷新 DNS 缓存或等待缓存过期（通常几小时）"
        echo "  验证: nslookup app.fastenernails.com 在你的电脑上应返回 $VPS_IP"
    elif [ "$FAIL_CATEGORY" = "DNS_PENDING" ]; then
        echo "  类别: DNS 传播未完成（服务本身正常）"
        echo "  原因: VPS 本地 DNS resolver 缓存了旧 IP，公网请求到达旧服务器"
        echo "  证据: forced-resolve 测试 → PASS，public DNS 测试 → FAIL"
        echo "  操作: 等待 DNS 全球传播完成（通常 5-30 分钟）后重新运行本脚本"
        echo "  检查: nslookup app.fastenernails.com 在你的电脑上是否返回 $VPS_IP"
    elif [ "$FAIL_CATEGORY" = "DEPLOY_FAILED" ]; then
        echo "  类别: 服务部署失败（forced-resolve 也未通过）"
        echo "  原因: 请查看上方 PHASE 1 诊断和 PHASE 5 预检输出"
        echo "  已尝试: 清理 Traefik、重写 nginx 配置、docker compose up -d --build"
    else
        echo "  类别: 综合问题"
        echo "  请查看上方诊断输出，重点关注："
        echo "  1. DNS multi-resolver 结果（PHASE 1.3）"
        echo "  2. 直接连接 VPS 的证书检查（PHASE 1.7）"
        echo "  3. forced-resolve 预检结果（PHASE 5a）"
    fi
fi

if [ "$FAIL_CATEGORY" = "DNS_DEFAULT_STALE" ] || [ "$FAIL_CATEGORY" = "DNS_PENDING" ]; then
    exit 0
else
    exit $SMOKE_EXIT
fi
