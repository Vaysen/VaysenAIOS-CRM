# Vaysen AI CRM

面向国际 B2B 团队的自托管 CRM、沟通工作台与 AI 业务助理。

Vaysen AI CRM 将客户资产、订单与报价、邮件、WhatsApp、待办、背调和 AI 助理放在同一套可审计工作流中。项目支持 Linux 后端与 Windows Electron 客户端，也可以直接运行 Web 前端。

> 当前仓库是从内部业务系统生成的独立开源发行版。Git 历史、客户资料、真实价格、账号、密钥、服务器地址、会话文件、备份和内部验收记录均未导入。

## 核心能力

- 客户资产、联系人、标签、评分、查重、自动建档与时间线
- 报价、PI、订单、产品目录和待办协作
- SMTP/IMAP 邮件工作台及可选 Brevo 入站 Webhook
- WhatsApp 会话工作台与可选 Evolution API 适配器
- OpenClaw 工具代理、AI 对话、执行轨迹与人工确认
- 客户背调、线索搜索和销售分析
- Next.js Web 前端、NestJS API、PostgreSQL、Redis/BullMQ
- Windows Electron 桌面客户端与 Docker Compose 自托管

## 开源数据说明

仓库中的公司、联系人、邮箱、电话号码和价格均为合成示例。`backend/src/modules/products/data/usd-price-catalog.json` 的价格固定为 `0`，不能直接用于商业报价。首次部署前请建立自己的租户、产品目录和账号。

## 快速开始

要求：Node.js `20.18.0`、npm `10.x`、Docker Engine 与 Docker Compose v2。

```bash
cp .env.example .env
# 修改所有 change-me / replace-with 值
docker compose up -d postgres redis
npm ci
npm run db:generate
npm run db:migrate
npm run dev
```

默认开发地址：

- Web：`http://127.0.0.1:4001`
- API：`http://127.0.0.1:4000/api`
- Swagger（显式启用后）：`http://127.0.0.1:4000/api/docs`

本项目不提供硬编码管理员密码。请通过注册流程创建第一个租户管理员，或使用你审核过的种子脚本。

## 文档

- [产品白皮书](docs/WHITEPAPER.zh-CN.md)
- [使用指南](docs/USER-GUIDE.zh-CN.md)
- [部署指南](docs/DEPLOYMENT.zh-CN.md)
- [技术架构](docs/ARCHITECTURE.md)
- [品牌资源规则](docs/BRANDING.md)
- [开源去敏报告](docs/OPEN-SOURCE-SANITIZATION.md)
- [依赖安全基线](docs/DEPENDENCY-RISK.md)
- [安全政策](SECURITY.md)

## 开源发布门禁

```bash
npm run verify:public-release
```

该命令会阻止真实品牌、内部域名、历史服务器地址、私钥/数据库/会话文件、常见密钥形态和非零私有价格进入提交。

## License

源代码采用 [Apache License 2.0](LICENSE)。Vaysen 名称、Logo 和品牌资源不因代码许可证而授予商标或品牌授权，详见 [TRADEMARKS.md](TRADEMARKS.md)。第三方组件仍适用各自许可证。

---

English summary: Vaysen AI CRM is a self-hosted international B2B CRM with email, WhatsApp, quotation, order, research and auditable AI-agent workflows. See the Chinese whitepaper and deployment guide for the current verified scope.
