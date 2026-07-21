# =============================================================================
# vaysen-ai-crm Backend - NestJS Dockerfile (Linux 服务器部署)
# 多阶段构建：node:20.18.0-slim
# 第一阶段：安装依赖 + 编译 TypeScript
# 第二阶段：仅复制 dist + node_modules + prisma schema
# =============================================================================

# ---- Stage 1: builder ----
ARG NODE_IMAGE=node:20.18.0-slim
FROM ${NODE_IMAGE} AS builder
WORKDIR /app

# 安装构建原生模块所需的工具链（bcrypt/sharp/playwright 等需要）
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        python3 \
        make \
        g++ \
        openssl \
        ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# 先复制依赖清单以利用 Docker 缓存层
COPY package*.json ./
COPY prisma ./prisma

# 安装全部依赖（含 devDependencies，编译需要）
RUN npm ci

# 生成 Prisma Client；只调用锁文件安装的本地 CLI，禁止 npx 隐式下载。
RUN npm run prisma:generate

# 复制源代码并编译 TypeScript
COPY . .
RUN npm run build

# 真实加载编译后的 CommonJS 入口，并验证 ESM-only Baileys 可由原生动态
# import 解析。该门禁能在镜像构建期拦住 ERR_REQUIRE_ESM 启动循环。
RUN node scripts/verify-runtime-load.cjs

# 生产依赖修剪（剔除 devDependencies，减小最终镜像体积）
RUN npm prune --omit=dev

# ---- Stage 2: runner ----
FROM ${NODE_IMAGE} AS runner
WORKDIR /app
ARG RELEASE_COMMIT=unknown

# 宿主机运行时目录由部署契约固定为 999:999。Chromium 会新增系统账户，
# 因此不能依赖 groupadd/useradd 的“下一个可用 ID”，否则 UID 会随 apt 包漂移。
ARG APP_UID=999
ARG APP_GID=999

ENV NODE_ENV=production
ENV PORT=4000
ENV PATH="/app/node_modules/.bin:${PATH}"
ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium
# Chromium crashpad 需要可写 HOME；appuser 没有宿主机持久 home，使用容器临时目录。
ENV HOME=/tmp

# 安装运行时所需系统依赖（openssl 供 Prisma 使用）
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        openssl \
        ca-certificates \
        chromium \
        fonts-noto-cjk \
        curl \
    && rm -rf /var/lib/apt/lists/*

# 创建固定 UID 的非 root 用户。Debian 的 Chromium 依赖可能已经占用 GID 999
#（组名不重要，数字 GID 才是 bind mount 的权限契约），此时复用该数字组。
RUN ! getent passwd "${APP_UID}" >/dev/null \
    && if ! getent group "${APP_GID}" >/dev/null; then groupadd --gid "${APP_GID}" appuser; fi \
    && useradd --uid "${APP_UID}" --gid "${APP_GID}" --no-create-home --shell /usr/sbin/nologin appuser

# 仅复制构建产物 + 生产依赖 + prisma schema
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/prisma ./prisma
COPY --from=builder /app/package.json ./package.json
COPY --from=builder /app/tools ./tools
COPY entrypoint.sh ./entrypoint.sh

# Bake the source revision into the image filesystem. Runtime environment
# variables can be misconfigured independently; /health compares both values
# so a correct label alone cannot make an old image look current.
RUN printf '%s\n' "$RELEASE_COMMIT" > /app/BUILD_REVISION

# 创建数据目录并设置权限
RUN mkdir -p /app/logs /app/uploads \
    && chmod 0555 /app/entrypoint.sh \
    && chown -R "${APP_UID}:${APP_GID}" /app

# 构建期即以最终非 root 用户真实启动一次 Chromium，防止“只安装了二进制、
# 运行时却因 HOME/crashpad/权限失败”的假绿镜像进入发布。
RUN su appuser -s /bin/sh -c \
    'HOME=/tmp chromium --headless --no-sandbox --disable-gpu --dump-dom about:blank >/dev/null 2>&1'

USER appuser

EXPOSE 4000

# 健康检查
# 后端在 raw Express 实例上暴露 /health（绕过 NestJS 全局前缀 api），
# 因此健康检查必须命中 http://localhost:4000/health 而非 /api/health。
HEALTHCHECK --interval=30s --timeout=10s --start-period=40s --retries=3 \
    CMD curl -f http://localhost:4000/health || exit 1

# 正式迁移只允许由 deploy.sh 在超时、备份和回滚边界内执行一次。
# 容器入口仅检查数据库就绪状态，运行时启动不得再次迁移。
ENTRYPOINT ["/app/entrypoint.sh"]
CMD ["node", "dist/src/main.js"]
