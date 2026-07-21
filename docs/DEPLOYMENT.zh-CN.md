# Vaysen AI CRM 部署指南

## 1. 推荐拓扑

Linux 主机运行 PostgreSQL、Redis、API、前端和可选 OpenClaw；Windows 用户安装 Electron 客户端。远程办公优先使用 ZeroTier、Tailscale、WireGuard 或带访问控制的 HTTPS 入口，不直接暴露数据库和缓存端口。

## 2. 环境要求

- Ubuntu 22.04/24.04 或兼容 Linux
- Docker Engine 与 Docker Compose v2
- Node.js 20.18.0（本地构建/测试）
- 8 GB 内存起步；启用浏览器自动化和 OpenClaw 时建议更高
- 独立备份目录和足够磁盘空间

## 3. 初始化

```bash
git clone <your-repository-url> vaysen-ai-crm
cd vaysen-ai-crm
cp .env.example .env
```

必须修改：

- `DB_PASSWORD`
- `JWT_SECRET` 与 `JWT_REFRESH_SECRET`
- `EMAIL_ENCRYPTION_KEY`
- `N8N_ENCRYPTION_KEY`（启用 n8n 时）
- `OPENCLAW_GATEWAY_TOKEN` 与 `OPENCLAW_CRM_HMAC_SECRET`（启用 OpenClaw 时）
- AI、邮件和 WhatsApp 供应商配置
- `CORS_ORIGIN`、`FRONTEND_URL` 与 API 地址

不要使用示例值启动生产环境。

## 4. 启动基础服务

```bash
docker compose up -d postgres redis
npm ci
npm run db:generate
npm run db:migrate
npm run build
docker compose up -d
```

不同 Compose 文件代表不同场景。正式部署前先运行：

```bash
docker compose -f docker-compose.prod.yml config
```

## 5. 创建管理员

默认不发布固定管理员账号。首次部署可以临时开放注册、创建第一个企业管理员后关闭公开注册，或编写仅在本机执行的初始化脚本。密码必须由部署者生成并妥善保存。

## 6. OpenClaw

OpenClaw 是可选组件。启用前：

1. 配置独立网关令牌和 CRM HMAC 密钥。
2. 仅启用审核过的 `vaysen-crm` 工具插件。
3. 把工具代理置于后端私有网络，不向公网开放管理端口。
4. 完成只读工具、数据变更、邮件和 WhatsApp 的分级验收。

## 7. Windows 客户端

在 Windows 构建机执行：

```powershell
cd electron
npm ci
npm run dist
```

输出位于 `release/`，该目录默认不提交。未签名安装包可能触发 SmartScreen；正式分发应配置代码签名并验证安装、卸载、升级、快捷方式、离线提示和崩溃日志。

## 8. 备份与恢复

- 每日备份 PostgreSQL。
- 同步备份上传目录；运行时会话按独立策略处理。
- 备份完成后校验哈希和可读性。
- 在隔离环境定期恢复，记录恢复时间和失败原因。
- `.env` 与加密密钥不要和数据库备份存放在同一位置。

## 9. 上线检查

- `npm run verify:public-release`
- 后端、前端、Electron 测试通过
- `docker compose ... config` 通过
- `/health` 返回成功
- 真实登录、客户创建、报价生成、邮件测试和 WhatsApp 测试完成
- 恢复演练完成
- 防火墙、HTTPS、日志轮转和告警已配置
