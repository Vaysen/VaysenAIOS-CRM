# =============================================================================
# vaysen-ai-crm Frontend - Next.js Dockerfile (Web 版)
# 多阶段构建：node:20.18.0-slim（与 TASK-107 发布基线钉版一致）
# 第一阶段：npm ci + next build（standalone 模式，distDir=.next-web）
# 第二阶段：node:20.18.0-slim + 复制 .next-web/standalone
# =============================================================================

# ---- Stage 1: builder ----
ARG NODE_IMAGE=node:20.18.0-slim
FROM ${NODE_IMAGE} AS builder
WORKDIR /app

# 安装构建原生模块所需工具链
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        python3 \
        make \
        g++ \
    && rm -rf /var/lib/apt/lists/*

# 构建参数：前端运行时请求的后端 API 地址（Web 默认同源 /api，禁止硬编码私网 IP）
ARG NEXT_PUBLIC_API_URL=/api
ARG NEXT_PUBLIC_APP_NAME=Vaysen AI CRM
ENV NEXT_PUBLIC_API_URL=$NEXT_PUBLIC_API_URL
ENV NEXT_PUBLIC_APP_NAME=$NEXT_PUBLIC_APP_NAME
ENV NEXT_TELEMETRY_DISABLED=1
# 显式选择 web (standalone) 目标；与 next.config.mjs 双目标约定一致
ENV NEXT_OUTPUT=standalone

# 先复制依赖清单以利用 Docker 缓存层
COPY package*.json ./
RUN npm ci

# 复制源代码并构建（产出 .next-web/standalone）
COPY . .

# 启用 Next.js standalone 输出模式（next.config.mjs 中 output: 'standalone'）
RUN npm run build:web

# ---- Stage 2: runner ----
FROM ${NODE_IMAGE} AS runner
WORKDIR /app

ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
ENV PORT=3000
ENV HOSTNAME=0.0.0.0

# 创建非 root 用户运行应用
RUN groupadd -r appuser && useradd -r -g appuser appuser

# 复制 standalone 构建产物（含精简后的 node_modules）。distDir 为 .next-web
COPY --from=builder --chown=appuser:appuser /app/.next-web/standalone ./
COPY --from=builder --chown=appuser:appuser /app/.next-web/static ./.next-web/static
COPY --from=builder --chown=appuser:appuser /app/public ./public
COPY --from=builder --chown=appuser:appuser /app/scripts/runtime-healthcheck.cjs ./scripts/runtime-healthcheck.cjs

USER appuser

EXPOSE 3000

# 健康检查（与 TASK-109 统一端口/健康检查契约：3000）
HEALTHCHECK --interval=30s --timeout=10s --start-period=30s --retries=3 \
    CMD ["node", "scripts/runtime-healthcheck.cjs"]

# 使用 standalone 模式的 server.js 启动（体积更小、启动更快）
CMD ["node", "server.js"]
