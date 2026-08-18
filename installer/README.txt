【已停用】本目录是旧版开发机安装器，不属于当前发布，所有入口均 fail-closed。
Windows 请使用 release\Vaysen 外贸系统-Setup-1.3.2.exe；Linux 请阅读 docs\LINUX_DEPLOYMENT.md。

╔══════════════════════════════════════════════════════╗
║     镜雅外贸开发系统 — 部署指南                       ║
╚══════════════════════════════════════════════════════╝

=== 新电脑部署步骤 (3步) ===

1. 复制整个 vaysen-ai-crm 文件夹到新电脑 (如 C:\Vaysen)

2. 右键 install.ps1 → 使用 PowerShell 运行
   (自动装 Node.js + Claude Code CLI + VS Code + Docker + 数据库 + 前后端)

3. 双击 start-all.bat 一键启动所有服务

   访问: http://[服务器IP]:4001

=== 装完即用 ===
- 前端界面 + 后端API + n8n工作流
- Claude Code CLI (已配DeepSeek API)
- VS Code workspace
- 数据库(PostgreSQL + Redis)
- 5个@chinaoptical.cn邮箱(阿里云SMTP)
- AI获客 + AI深度背调(Claude Code引擎)
- 素材池(图片自动压缩+PDF)
- 标签系统 + 数据隔离

=== 前置条件 ===
- Windows 10/11 64位
- 16GB+ 内存 (推荐)
- 50GB+ 可用磁盘
- Docker Desktop (安装脚本会自动安装)

=== 包含的组件 ===
- NestJS 后端 API (DeepSeek AI 集成)
- Next.js 前端界面 (中文)
- PostgreSQL 数据库
- Redis 缓存
- n8n 工作流自动化
- Claude Code CLI (预配置 DeepSeek API)
- 5个邮箱账户 (@chinaoptical.cn, 阿里云 SMTP)

=== 首次登录 ===
管理员账号在种子数据中自动创建。
查看 .env 文件获取数据库密码。
# Sync test Fri Jun  5 11:41:08     2026
