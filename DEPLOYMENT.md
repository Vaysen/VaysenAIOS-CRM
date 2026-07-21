# Vaysen AI CRM 部署指南

## 环境要求

| 组件 | 版本 | 用途 |
|------|------|------|
| Node.js | 20+ | 运行前后端 |
| npm | 10+ | 包管理 |
| Docker | 24+ | 容器化部署 |
| Docker Compose | v2+ | 多容器编排 |
| PostgreSQL | 15 | 主数据库（Docker 提供） |
| Redis | 7 | 缓存/队列（Docker 提供） |

---

## 一、本地开发部署

### 1. 克隆项目

```bash
git clone <repo-url>
cd vaysen-ai-crm
```

### 2. 启动基础设施

```bash
docker compose up -d postgres redis
```

验证容器状态：
```bash
docker ps
# 应看到 vaysen-crm-postgres (healthy) 和 vaysen-crm-redis (healthy)
```

### 3. 配置后端环境变量

```bash
cp backend/.env.example backend/.env
```

编辑 `backend/.env`：

```env
# 数据库连接
DATABASE_URL=postgresql://vaysen-crm:vaysen-crm_password@localhost:5432/vaysen-crm_pilot?schema=public

# JWT 密钥
JWT_SECRET=change-me-to-a-random-string
JWT_EXPIRES_IN=15m
JWT_REFRESH_EXPIRES_IN=7d

# Redis
REDIS_HOST=localhost
REDIS_PORT=6379

# 邮件加密密钥（32字符随机字符串）
EMAIL_ENCRYPTION_KEY=<生成命令见下方>

# 应用端口
PORT=4000

# 前端地址（CORS）
FRONTEND_URL=http://localhost:4001
```

生成 `EMAIL_ENCRYPTION_KEY`：
```bash
node -e "console.log(require('crypto').randomBytes(32).toString('base64').slice(0,32))"
```

### 4. 安装依赖

```bash
cd backend && npm install
cd ../frontend && npm install
```

### 5. 数据库初始化

```bash
cd backend

# 开发环境：直接推送 Schema（快速）
npx prisma db push

# 生产环境：创建迁移文件（推荐）
npx prisma migrate dev --name init

# 生成 Prisma Client
npx prisma generate

# 可选：导入种子数据
npx prisma db seed
```

### 6. 启动服务

**后端**（端口 4000）：
```bash
cd backend
npm run start:dev
```

**前端**（端口 4001）：
```bash
cd frontend
npx next dev -p 4001
```

### 7. 验证

| 服务 | 地址 | 预期 |
|------|------|------|
| 前端 | http://localhost:4001 | 登录页 |
| 后端 API | http://localhost:4000/api | 401（需认证） |
| Swagger | http://localhost:4000/api/docs | API 文档页 |

---

## 二、Docker 完整部署

`docker-compose.yml` 支持一键启动全部服务：

```bash
docker compose up -d
```

包含服务：
- `postgres` — PostgreSQL 15，端口 5432
- `redis` — Redis 7，端口 6379
- `backend` — NestJS，端口 4000
- `frontend` — Next.js，端口 4001

---

## 三、生产环境注意事项

部署到生产环境前，请确保：

1. **环境变量安全**
   - `JWT_SECRET` 使用强随机字符串（≥ 32 字符）
   - `EMAIL_ENCRYPTION_KEY` 使用强随机字符串
   - 所有密钥通过环境变量注入，不要硬编码

2. **数据库**
   - 使用 `prisma migrate deploy`（非 `db push`）
   - 配置数据库定期备份（pg_dump + cron）
   - 生产数据库使用独立服务器或云数据库

3. **网络安全**
   - 配置 HTTPS（Nginx 反向代理 + Let's Encrypt）
   - 设置防火墙规则，仅暴露 80/443 端口
   - 限制 PostgreSQL 和 Redis 的访问来源

4. **域名配置**
   - `FRONTEND_URL` 设为实际域名
   - CORS 白名单仅包含实际域名
   - 邮件追踪链接使用真实域名（`TRACKING_DOMAIN`）

5. **SMTP 配置**
   - 配置真实 SMTP 服务器（阿里云邮件推送 / SendGrid / AWS SES / Resend）
   - 设置 SPF / DKIM / DMARC 邮件验证
   - 合理设置发送频率限制

6. **备份策略**
   - 数据库：每日自动备份，保留 30 天
   - 应用日志：配置日志轮转
   - 配置文件：纳入 Git 版本管理（排除 .env）

---

## 四、常用命令

```bash
# 查看日志
docker compose logs -f backend

# 重启服务
docker compose restart backend

# 数据库迁移
docker compose exec backend npx prisma migrate deploy

# 进入容器
docker compose exec backend sh
docker compose exec postgres psql -U vaysen-crm -d vaysen-crm_pilot
```

---

## 五、故障排查

| 问题 | 检查 |
|------|------|
| 后端启动失败 | 检查 `backend/.env` 中 `DATABASE_URL` 是否正确 |
| 邮件发送失败 | 检查 SMTP 配置和 `EMAIL_ENCRYPTION_KEY` |
| 前端 500 错误 | 检查后端是否运行，CORS 是否配置 |
| Docker 容器无法启动 | `docker compose down -v && docker compose up -d` |
| Prisma 错误 | `npx prisma generate && npx prisma db push` |
