#!/bin/bash
# =============================================================================
# Vaysen Pilot — 最小部署冒烟测试（容器内部，不依赖外网 DNS/证书）
# =============================================================================
# 覆盖 TASK-109 验收项 #8：主页、health、登录、数据库、Redis、队列、上传目录
#
# 用法：bash scripts/deploy-smoke-test.sh
# 退出码：所有检查通过 = 0；任一检查失败 = 1
# =============================================================================
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
COMPOSE_FILE="${PROJECT_DIR}/docker-compose.prod.yml"
ENV_FILE="${ENV_FILE:-$PROJECT_DIR/.env}"
COMPOSE_PROJECT_NAME="${COMPOSE_PROJECT_NAME:-vaysen-ai-crm}"

GREEN='\033[0;32m'; RED='\033[0;31m'; YELLOW='\033[1;33m'; NC='\033[0m'
PASS=0; FAIL=0

pass() { echo -e "  ${GREEN}[PASS]${NC} $1"; PASS=$((PASS+1)); }
fail() { echo -e "  ${RED}[FAIL]${NC} $1"; FAIL=$((FAIL+1)); }
info() { echo -e "${YELLOW}[INFO]${NC} $1"; }

cd "$PROJECT_DIR" || { echo "cannot cd to $PROJECT_DIR"; exit 1; }

compose() {
    docker compose --project-name "$COMPOSE_PROJECT_NAME" \
        --project-directory "$PROJECT_DIR" --env-file "$ENV_FILE" \
        -f "$COMPOSE_FILE" "$@"
}

# 内部请求工具：使用 nginx 镜像自带的 wget，并显式关闭代理。
# Docker client 代理会自动注入容器环境；BusyBox wget 对 NO_PROXY 的
# host-list 行为不可靠，若不使用 -Y off 会把容器内地址错误送往外部代理。
http_ok() {
    # $1 = 在 nginx 容器内访问的 URL
    local url="$1"
    if docker exec vaysen-crm-nginx wget -Y off -q -O /dev/null "$url" 2>/dev/null; then
        return 0
    fi
    return 1
}

backend_probe() {
    local url="$1" expected="${2:-reachable}"
    docker exec -i vaysen-crm-backend node - "$url" "$expected" <<'NODE' >/dev/null 2>&1
const [url, expected] = process.argv.slice(2);
const controller = new AbortController();
const timer = setTimeout(() => controller.abort(), 8000);
fetch(url, { signal: controller.signal }).then((response) => {
  clearTimeout(timer);
  const ok = /^\d{3}$/.test(expected)
    ? response.status === Number(expected)
    : response.status < 500;
  process.exit(ok ? 0 : 1);
}).catch(() => process.exit(1));
NODE
}

backend_method_probe() {
    local url="$1" method="$2" expected="$3"
    docker exec -i vaysen-crm-backend node - "$url" "$method" "$expected" <<'NODE' >/dev/null 2>&1
const [url, method, expected] = process.argv.slice(2);
const controller = new AbortController();
const timer = setTimeout(() => controller.abort(), 8000);
fetch(url, {
  method,
  signal: controller.signal,
  headers: { 'content-type': 'application/json' },
  body: method === 'GET' ? undefined : '{}',
}).then((response) => {
  clearTimeout(timer);
  process.exit(response.status === Number(expected) ? 0 : 1);
}).catch(() => process.exit(1));
NODE
}

frontend_asset_probe() {
    local origin="$1"
    docker exec vaysen-crm-frontend \
        node scripts/runtime-healthcheck.cjs "$origin" >/dev/null 2>&1
}

echo -e "${YELLOW}============================================${NC}"
echo -e "${YELLOW}  Vaysen Pilot 最小部署冒烟测试${NC}"
echo -e "${YELLOW}  $(date '+%Y-%m-%d %H:%M:%S')${NC}"
echo -e "${YELLOW}============================================${NC}"

# 镜像自身也必须携带不可变 revision。只检查容器 label 会把 Compose
# 运行时元数据误当成镜像溯源，无法证明磁盘上的镜像确由本次源码构建。
for image in backend frontend backend-worker; do
    image_ref="vaysen-crm-${image}:${RELEASE_COMMIT_SHORT:-}"
    image_revision="$(docker image inspect -f '{{ index .Config.Labels "org.opencontainers.image.revision" }}' "$image_ref" 2>/dev/null || true)"
    if [ -n "${RELEASE_COMMIT:-}" ] && [ "$image_revision" = "$RELEASE_COMMIT" ]; then
        pass "镜像 revision 匹配：$image_ref"
    else
        fail "镜像 revision 不匹配：$image_ref -> $image_revision"
    fi
done

# nginx resolves Docker service names when its configuration is loaded.  The
# edge container must therefore be recreated for each immutable revision; a
# stale container can keep proxying to the removed frontend IP while /health
# happens to remain reachable through a reused backend address.
nginx_revision="$(docker inspect -f '{{ index .Config.Labels "org.opencontainers.image.revision" }}' vaysen-crm-nginx 2>/dev/null || true)"
if [ -n "${RELEASE_COMMIT:-}" ] && [ "$nginx_revision" = "$RELEASE_COMMIT" ]; then
    pass "nginx edge revision 匹配，Docker upstream DNS 已随候选刷新"
else
    fail "nginx edge revision 不匹配：$nginx_revision"
fi

# ----------------------------------------------------------------------------
# 1. 主页（通过 nginx -> frontend:3000）
# ----------------------------------------------------------------------------
if http_ok "http://frontend:3000/"; then
    pass "主页 frontend:3000/ → 200"
else
    fail "主页 frontend:3000/ → 非 200"
fi

# 经由 nginx 80 端口
if http_ok "http://127.0.0.1/"; then
    pass "主页 nginx:80/ → 200"
else
    fail "主页 nginx:80/ → 非 200"
fi

# ----------------------------------------------------------------------------
# 2. 健康检查
# ----------------------------------------------------------------------------
# A 200 HTML shell is not enough: a custom Next.js distDir must carry matching
# CSS and JavaScript into the standalone runtime, both directly and via nginx.
if frontend_asset_probe "http://127.0.0.1:3000"; then
    pass "frontend login CSS/JS assets are executable in the standalone container"
else
    fail "frontend login CSS/JS assets are missing or have invalid MIME types"
fi
if frontend_asset_probe "http://nginx"; then
    pass "nginx serves the matching frontend CSS/JS assets"
else
    fail "nginx returned missing or invalid frontend CSS/JS assets"
fi

if http_ok "http://backend:4000/health"; then
    pass "backend:4000/health → 200"
else
    fail "backend:4000/health → 非 200"
fi

if http_ok "http://127.0.0.1/health"; then
    pass "nginx /health → 200"
else
    fail "nginx /health → 非 200"
fi

# 不能只凭 status=ok 判断部署了新代码。后端必须回显 deploy.sh 注入的
# 不可变发布提交，并声明当前 AI 助理确定性动作协议。
if docker exec vaysen-crm-backend node -e '
const expected=(process.env.RELEASE_COMMIT||"").trim();
fetch("http://127.0.0.1:4000/health")
  .then((r)=>r.json())
  .then((body)=>process.exit(
    /^[a-f0-9]{40}$/i.test(expected)
    && body?.release?.commit===expected
    && body?.release?.buildCommit===expected
    && body?.release?.matchesBuild===true
    && body?.contracts?.assistantAction==="2026-07-14.1" ? 0 : 1
  ))
  .catch(()=>process.exit(1));' >/dev/null 2>&1; then
    pass "后端发布 SHA 与 AI 助理动作协议匹配"
else
    fail "后端发布 SHA/AI 助理动作协议不匹配（可能仍在运行旧镜像）"
fi

for probe in \
    'python-service|http://python-service:5000/ready|200' \
    'reacher|http://reacher:8080/|reachable' \
    'searxng|http://searxng:8080/|reachable' \
    'n8n|http://n8n:5678/healthz|200'; do
    IFS='|' read -r name url expected <<< "$probe"
    if backend_probe "$url" "$expected"; then
        pass "$name 内网功能探针通过"
    else
        fail "$name 内网功能探针失败: $url"
    fi
done

searx_evidence_ready() {
  docker exec vaysen-crm-backend node -e '
fetch("http://searxng:8080/search?q=OpenAI+official+company+website&format=json&language=en", {
  headers: { Accept: "application/json", "User-Agent": "VaysenCRM/2.0 evidence-research" },
  signal: AbortSignal.timeout(20000),
})
  .then(async (response) => {
    if (!response.ok) process.exit(1);
    const body = await response.json();
    const results = Array.isArray(body?.results) ? body.results : [];
    const hasPublicEvidence = results.some((item) => {
      try {
        const url = new URL(String(item?.url || ""));
        return ["http:", "https:"].includes(url.protocol)
          && !["localhost", "127.0.0.1", "::1"].includes(url.hostname)
          && !/^10\./.test(url.hostname)
          && !/^192\.168\./.test(url.hostname)
          && !/^172\.(1[6-9]|2\d|3[01])\./.test(url.hostname);
      } catch { return false; }
    });
    process.exit(hasPublicEvidence ? 0 : 1);
  })
  .catch(() => process.exit(1));' >/dev/null 2>&1
}

# SearXNG 的 HTTP 首页先于外部搜索引擎完全就绪。候选容器刚启动时，
# 第一次 JSON 查询可能得到空结果；发布门禁必须等待真实公共证据，而不是
# 只凭 HTTP 200 放行。重试有固定上限，持续无结果仍然 fail-closed。
SEARX_EVIDENCE_READY=0
for attempt in 1 2 3 4 5 6; do
  if searx_evidence_ready; then
    SEARX_EVIDENCE_READY=1
    break
  fi
  [ "$attempt" -eq 6 ] || sleep 5
done
if [ "$SEARX_EVIDENCE_READY" -eq 1 ]; then
    pass "SearXNG internal JSON evidence search returned a public source"
else
    fail "SearXNG internal JSON evidence search returned no public source after bounded readiness retries"
fi

# ----------------------------------------------------------------------------
# 3. 登录页（前端路由）
# ----------------------------------------------------------------------------
if http_ok "http://frontend:3000/login"; then
    pass "登录页 frontend:3000/login → 200"
else
    fail "登录页 frontend:3000/login → 非 200"
fi

# 未认证 API 必须可达但保持鉴权；Swagger 与未部署的 Evolution 集成必须关闭。
if backend_probe "http://nginx/api/auth/me" 401; then
    pass "nginx /api/auth/me 未认证 → 401"
else
    fail "nginx /api/auth/me 未认证未返回 401"
fi
if backend_probe "http://nginx/api/docs" 404; then
    pass "生产 Swagger 已关闭 → 404"
else
    fail "生产 Swagger 仍可访问"
fi
if backend_method_probe "http://nginx/api/whatsapp/evolution-webhook" POST 503; then
    pass "未部署 Evolution webhook 默认关闭 → 503"
else
    fail "Evolution webhook 未 fail-closed"
fi
if docker exec vaysen-crm-backend node -e \
    "const v=(process.env.ZHIPU_API_KEY||'').trim();process.exit(v.length>=16&&!/change|replace|example/i.test(v)?0:1)" \
    >/dev/null 2>&1; then
    pass "AI 助理运行时密钥已配置（未回显）"
else
    fail "AI 助理运行时密钥缺失或为占位值"
fi

# ----------------------------------------------------------------------------
# 4. 数据库（pg_isready + 连接数查询）
# ----------------------------------------------------------------------------
# Docker client proxy defaults must never leak into production containers.
# They are a build-time concern and can make guarded HTTPS transports fail
# even while a plain in-container fetch succeeds.
RUNTIME_EGRESS_SERVICES=(backend openclaw-gateway python-service n8n reacher searxng)
RUNTIME_PROXY_CLEAN=0
for service in "${RUNTIME_EGRESS_SERVICES[@]}"; do
    container="$(compose ps -q "$service" 2>/dev/null || true)"
    if [ -n "$container" ] && docker inspect -f '{{range .Config.Env}}{{println .}}{{end}}' "$container" \
        | node -e '
            let text = "";
            process.stdin.setEncoding("utf8");
            process.stdin.on("data", (chunk) => { text += chunk; });
            process.stdin.on("end", () => {
              const proxyKeys = new Set([
                "HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY",
                "http_proxy", "https_proxy", "all_proxy",
              ]);
              const leaked = text.split(/\r?\n/).some((line) => {
                const index = line.indexOf("=");
                return index > 0
                  && proxyKeys.has(line.slice(0, index))
                  && line.slice(index + 1).trim().length > 0;
              });
              process.exit(leaked ? 1 : 0);
            });
        '; then
        RUNTIME_PROXY_CLEAN=$((RUNTIME_PROXY_CLEAN+1))
    else
        fail "$service inherited an unapproved build proxy; production egress must be direct"
    fi
done
if [ "$RUNTIME_PROXY_CLEAN" -eq "${#RUNTIME_EGRESS_SERVICES[@]}" ]; then
    pass "production egress containers did not inherit build proxies (${#RUNTIME_EGRESS_SERVICES[@]}/${#RUNTIME_EGRESS_SERVICES[@]})"
fi

if docker exec vaysen-crm-postgres pg_isready -U vaysen-crm -d vaysen-crm_pilot 2>/dev/null | grep -q "accepting connections"; then
    pass "PostgreSQL 接受连接"
else
    fail "PostgreSQL 未就绪"
fi

# ----------------------------------------------------------------------------
# 5. Redis
# ----------------------------------------------------------------------------
if [ "$(docker exec vaysen-crm-redis redis-cli ping 2>/dev/null)" = "PONG" ]; then
    pass "Redis PING → PONG"
else
    fail "Redis PING 失败"
fi

# ----------------------------------------------------------------------------
# 6. 队列（worker 健康 + Prisma 查询 + Redis + 零重启）
# ----------------------------------------------------------------------------
WORKERS=(worker-email-compose worker-email-validate worker-email-send worker-prospect-search worker-deep-research worker-maintenance)
WORKERS_RUNNING=0
WORKERS_READY=0
for w in "${WORKERS[@]}"; do
    container="$(compose ps -q "$w" 2>/dev/null || true)"
    state=""; health=""; restarts=""
    if [ -n "$container" ]; then
        state="$(docker inspect -f '{{.State.Status}}' "$container" 2>/dev/null || true)"
        health="$(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{end}}' "$container" 2>/dev/null || true)"
        restarts="$(docker inspect -f '{{.RestartCount}}' "$container" 2>/dev/null || true)"
    fi
    if [ "$state" = "running" ] && [ "$health" = "healthy" ] && [ "$restarts" = "0" ]; then
        WORKERS_RUNNING=$((WORKERS_RUNNING+1))
        # Execute the exact health script again so the release evidence includes
        # a real Prisma SELECT 1 and Redis connection from every final container.
        if docker exec "$container" node scripts/worker-healthcheck.cjs >/dev/null 2>&1; then
            WORKERS_READY=$((WORKERS_READY+1))
        else
            fail "$w Prisma/Redis 实际健康探针失败"
        fi
    else
        fail "$w 未稳定就绪 (state=${state:-missing}, health=${health:-none}, restarts=${restarts:-unknown})"
    fi
done
if [ "$WORKERS_RUNNING" -eq 6 ] && [ "$WORKERS_READY" -eq 6 ]; then
    pass "全部队列 worker 稳定健康、Prisma/Redis 可用且零重启 (6/6)"
fi

QUEUE_KEYS=$(docker exec vaysen-crm-redis redis-cli --scan --pattern 'bull:*' 2>/dev/null | wc -l | tr -d ' ')
info "Redis bull 队列键数量: $QUEUE_KEYS（空闲新环境可为 0；6/6 worker Prisma/Redis 健康为发布门禁）"

# ----------------------------------------------------------------------------
# 7. 三类业务运行时目录必须是可写的宿主 bind mount
# ----------------------------------------------------------------------------
MOUNT_REPORT="$(docker inspect -f '{{range .Mounts}}{{println .Destination .Type .Source}}{{end}}' vaysen-crm-backend 2>/dev/null || true)"
APP_DATA_DIR="${APP_DATA_DIR:-/var/lib/vaysen-crm/data}"
for mapping in \
    '/app/uploads|uploads' \
    '/app/.customizer-assets|.customizer-assets' \
    '/app/.whatsapp-sessions|.whatsapp-sessions'; do
    IFS='|' read -r runtime_path host_name <<< "$mapping"
    expected="$runtime_path bind $APP_DATA_DIR/$host_name"
    if printf '%s\n' "$MOUNT_REPORT" | grep -Fx "$expected" >/dev/null \
        && docker exec vaysen-crm-backend test -w "$runtime_path" 2>/dev/null; then
        pass "backend 持久目录 $runtime_path 为可写 bind mount"
    else
        fail "backend 持久目录 $runtime_path 未正确挂载或不可写"
    fi
done

# ----------------------------------------------------------------------------
# 汇总
# ----------------------------------------------------------------------------
echo -e "\n${YELLOW}============================================${NC}"
echo -e "  通过: ${GREEN}$PASS${NC}  失败: ${RED}$FAIL${NC}"
echo -e "${YELLOW}============================================${NC}"

if [ "$FAIL" -gt 0 ]; then
    echo -e "${RED}冒烟测试未通过${NC}"
    exit 1
else
    echo -e "${GREEN}冒烟测试全部通过${NC}"
    exit 0
fi
