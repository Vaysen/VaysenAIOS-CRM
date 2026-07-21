# OpenClaw 生产候选边界

> 状态（2026-07-15）：本目录是 `v1.4.20` 本地发布候选实物。腾讯官方微信插件 `2.4.6` 的 `group_id → direct` 缺陷已有确定性、代码锚定的 Vaysen AI CRM 补丁；脱敏群聊/非 owner 拒绝证据与精确 peer 符号链接审计已实现，本地自动门禁通过。候选**尚未部署到目标 Linux、尚未在目标 Docker 安装/审计、尚未负责人微信扫码和真实 owner/非 owner/群聊/重连验收、尚未完成 Windows 1.4.20 安装包验收**。

## 固定版本

- OpenClaw `2026.7.1`：`ghcr.io/openclaw/openclaw@sha256:6a31d44b2944e7adcd2b582bf6fb463111264ebca97a0201795b799135bd102c`
- 腾讯微信插件：`@tencent-weixin/openclaw-weixin@2.4.6`
- 私有 CRM 插件：`@vaysen/openclaw-crm-tools@1.2.1`

Gateway 不发布宿主端口，只加入专用 `openclaw` bridge；只有 backend 同时加入 `vaysen-crm` 与 `openclaw`。OpenClaw 不获得 PostgreSQL、Redis、JWT、Docker、SSH 或备份凭据，不挂载可写源码，也不把 Gateway token/HMAC secret 暴露给浏览器。模型使用自定义 OpenAI-compatible `zhipu-cn` provider、现有 `open.bigmodel.cn` 端点和发布环境固定的 `ZHIPU_MODEL`。

## 四个受限工具

私有插件只暴露四个无外发副作用的只读/内部草稿工具：

- `crm_work_brief`：读取真实工作简报；
- `crm_customer_search`：在当前 tenant/operator 范围内搜索客户和可信会话；
- `crm_start_background_research`：对已由搜索确认的客户创建内部背调任务；
- `crm_prepare_quote_delivery`：准备 `PREPARED_NOT_SENT` 报价草案。

插件从 OpenClaw 运行时上下文取得微信 owner 身份，或从 backend 预注册的 CRM 管理员 session 取得操作者；模型不能自报 `companyId`、`userId`、sender、owner、session 或 tool-call 身份。每次 broker 请求对 timestamp、nonce、精确 `/api/internal/openclaw/tools/*` pathname 和原始 JSON body 做 HMAC-SHA256。后端持久化 nonce 防重放，并继续执行 owner/RBAC、租户、资源范围、租约、速率、幂等与审计。

成功证据是 CRM 中持久化的 requestId、`AgentRun` 和 receipt，不是模型文字。报价 receipt 只有明确返回 `PREPARED_NOT_SENT` 时才可显示“已准备”，并必须提示业务员回到 CRM 人工核对、手动交付；本候选**绝不自动发送 WhatsApp、微信或邮件**。

## 隔离边界

- OpenClaw 容器非 root、只读根文件系统、`cap_drop: ALL`、`no-new-privileges`、PID 限制；
- state 是唯一持久化写入面；配置、workspace、私有插件只读挂载；`skipBootstrap: true` 禁止 OpenClaw 首次对话改写 workspace，但不影响加载已审计的业务规则；会话记录只写 state；临时目录为限额 tmpfs；
- 不加入主业务网络，不直连 DB/Redis；不挂 Docker socket、SSH、宿主项目或备份；
- 通用 `exec`、`process`、filesystem、browser、message、gateway、automation、session spawn/send 工具拒绝；
- Gateway 在启动 Node 前固定 `umask 077`；OpenClaw state 目录/子目录 `0700`，文件和供应链报告 `0600`，运行时 smoke 会在真实模型回合后再次核验；Docker 日志限为 `2 × 5 MiB`；
- 腾讯插件受保护 state、管理员日志或扫码终端仍可能含原始微信标识，均属于敏感管理员表面；原始标识不得进入浏览器、CRM 客户字段、发布报告或工作记录。

智谱仍使用现有 OpenAI-compatible `/api/paas/v4` 端点；锁定模型显式配置 `compat.maxTokensField=max_tokens`，避免 OpenClaw 对自定义 provider 默认发送智谱不接受的 `max_completion_tokens`。静态模型列表只能证明“已配置”，发布验收必须通过真实 `OPENCLAW_MODEL_OK` 往返。

## 腾讯插件固定供应链

`scripts/prepare-openclaw-runtime.sh` 在 Gateway 启动前执行：

1. 对精确版本 `@tencent-weixin/openclaw-weixin@2.4.6` 运行 `npm pack --ignore-scripts --json`；
2. 只接受一个预期文件名的官方 `.tgz`，校验包名、版本、npm pack metadata、固定 SHA-512 integrity `sha512-qw9k3PLTiMWGNjjsknHgcTManH1w4j+Ji1ArWIaYLKCq3aFRsVwcqnPi127bvOoVMJGW4dbyJ8NECEMgoO+iRw==` 与实际 SHA-1；
3. 将官方 tgz 原子保存到 `$OPENCLAW_STATE_DIR/supply-chain/artifacts`（目录 `0700`、文件 `0600`）；
4. 用 `weixin-v2.4.6.patch.json` 和 `weixin-patch-supply-chain.mjs` 应用固定、可复现的 Vaysen AI CRM group fail-closed、网页扫码、脱敏 owner digest 与已配对负责人身份传播补丁，并把 Zod 收紧为精确版本；工具严格校验预期命中次数与补丁文件前后摘要，补丁 manifest SHA-256 固定为 `8ab539fd6cc0a3ae1587a6f0a994ad163b511c6d563423772d780c935c8c43f1`；
5. 补丁 tgz 固定 SHA-256 `15cde2b9926263ab5cfba21f2b935c710bc01dd983611e3dee673a052fa203d6`、integrity `sha512-WarnJ65LzlqhSluRnY4c/SvnnKnZTNhIEMXZEih+iQRDe4iZsVznsp3EySB+ADBdsa6XSH4MfhyijFLgiTPyhQ==`、tree SHA-256 `7f2d15c5e1d665ee7b3e7b1fc9885b915854e960d7f82ac97a512939eb2664b1`；先核验固定 OpenClaw 镜像的依赖与 workspace override 均为 `typebox@1.3.3`，再将微信、`qrcode-terminal@0.12.0`、`zod@4.3.6` 与 `typebox@1.3.3` 逐包校验并缓存，以最小精确依赖项目在线生成/核验 lock、在全新目录离线安装重放；私有包只复制 6 个允许发布文件并统一为目录 `0755`、文件 `0644` 后双打包，消除宿主 umask 对 tgz 字节的影响；最后两个插件安装阶段强制 `npm offline`，不从 registry 二次下载；瞬时网络失败最多重试一次，缓存会在受管状态审计前删除；
6. 自动负例证明带 `group_id` 的普通/斜杠消息在 slash/auth/route/dispatch/tool 之前拒绝，非 owner 在鉴权后、route/dispatch/tool 前拒绝，并只写脱敏 marker evidence；
7. 从 OpenClaw `2026.7.1` 的 `state/openclaw.sqlite` / `installed_plugin_index` 读取安装记录，核对 source/spec/sourcePath/installPath/version/artifact/摘要以及补丁后的安装路径；
8. 将“固定官方 tgz + 固定补丁”推导出的全部期望文件与受管安装目录逐文件比对，并核验私有插件 shrinkwrap/依赖树；state 中只允许每个已注册插件自己的 `node_modules/openclaw` peer 符号链接，且必须精确解析到镜像内 OpenClaw package root，其他链接、错误目标、断链和特殊文件全部拒绝；
9. 写入 mode `0600` 的供应链报告。官方 tgz、补丁、安装记录、补丁后安装树或 peer 链接任一差异都会阻断启动。

本地供应链与策略负例已经覆盖 tgz/补丁/受管文件/SQLite 安装记录篡改、`group_id` 普通与 slash 消息、非 owner、peer 链接错误目标和额外链接，并已通过自动门禁。正式 Linux 部署仍必须在目标 Docker 重做安装/审计并保留运行时证据；本地通过不等于 Linux 已安装。

## 微信扫码

OpenClaw 的目标权限是服务已认证的公司管理员 CRM session，并在扫码后服务唯一 owner 微信私聊。普通 CRM 成员继续走现有按用户范围约束的智谱路径。`group_id → direct` 已在本地补丁和自动负例中闭合，但目标 Linux/真实渠道是否提供预期字段仍需真机证明；真实群聊/非 owner/重连未验收前不得宣称微信通道可用。

扫码是受控终端操作：

```bash
bash scripts/openclaw-weixin-login.sh
```

脚本调用官方插件 CLI，并要求真实 TTY，以便二维码、手机确认和验证提示保持可见。扫码完成后只把 owner 原始标识的 SHA-256 digest 写入生产环境文件；不得伪造或猜测 REST 二维码契约。

QR 后在同一类可见交互式 SSH 终端运行：

```bash
bash scripts/openclaw-weixin-acceptance.sh --all
```

脚本会依次引导 owner 私聊“查看今日工作简报”、非 owner 私聊和真实群聊。owner 正例必须让精确 marker digest 产生唯一完成、业务成功的 `work-brief` receipt。两个负例必须各自由真实 adapter 写出只含 `markerDigest`、`outcome`、`observedAt` 的脱敏拒绝证据，同时 CRM 中该精确 marker digest 的 receipt 数为 0；不是要求整个系统没有其他正常 receipt。脚本不会打印或持久化原始微信标识。它已进入候选，但当前尚未在目标 Linux 实跑；通过后还要验证运行时 `CONNECTED`/绑定时间、重复消息、断线与重连。

## 运行时 smoke

隔离容器、固定插件、认证 RPC、真实智谱回合和敏感边界：

```bash
bash scripts/openclaw-runtime-smoke-test.sh
```

CRM 工具 E2E 必须使用真实公司管理员的短期 bearer token；token 只通过 mode `0600/0400` 文件或当前进程环境传入，禁止写入 `.env`、Shell 历史、日志、前端或 OpenClaw 容器：

```bash
OPENCLAW_E2E_BASE_URL=http://127.0.0.1 \
OPENCLAW_E2E_COMPANY_ID='<company UUID>' \
OPENCLAW_E2E_BEARER_TOKEN_FILE='/run/user/<uid>/openclaw-admin-token' \
bash scripts/openclaw-real-scene-test.sh
```

首次部署使用 `OPENCLAW_E2E_REQUIRE_WECHAT_BOUND=false`；扫码并发出真机指令后必须以 `true` 重跑。

正式 `deploy.sh` 不再复用上述人工短期 token 文件。它会以 `OPENCLAW_E2E_OWNER_EMAIL`（默认读取 `.env` 的 `OPENCLAW_OWNER_EMAIL`）和 `OPENCLAW_E2E_COMPANY_ID` 为身份锚点，通过健康 backend 即时签发 10 分钟 JWT，并在停服前、候选切换后分别请求真实 `/api/auth/me`；临时 token 文件始终为 `0600` 且在子进程退出时删除。

## 生产迁移前演练

OpenClaw migration 进入生产数据库前，必须以最新、校验和通过的 production custom-format dump、精确 PostgreSQL digest 和候选 backend image 在完全隔离的数据根/随机 internal network 中演练：

```bash
bash scripts/rehearse-db-migration.sh \
  --backup /var/lib/vaysen-crm/backups/vaysen-crm_<timestamp>.dump \
  --postgres-image '<POSTGRES_IMAGE repository@sha256>' \
  --candidate-image 'vaysen-crm-backend:<candidate revision>' \
  --expected-revision '<candidate 40-character Git revision>' \
  --source-database-bytes '<SELECT pg_database_size(current_database()) result>' \
  --data-root /var/lib/vaysen-crm/rehearsals \
  --max-deploy-seconds 90 \
  --max-restore-seconds 900 \
  --evidence /var/lib/vaysen-crm/releases/v1.4.20-migration-rehearsal.env \
  --confirm-isolated-rehearsal
```

`deploy.sh` 会在构建和核对候选镜像后、停止现有应用前，用本次 fresh backup 自动执行该门禁。手工旧证据不能跳过正式部署的 fresh-backup 演练。

通过条件包括：容量/保留线和 watchdog、checksum/`pg_restore -l`、首次恢复时限、不可达连接不写迁移账本、故意制造的 enum/DDL 失败触发 P3009、`migrate resolve --rolled-back` 后安全重放、连续两次 migrate deploy、迁移账本/DDL/外键检查，以及使用 rollback/restore 共用 helper 对 forward-migrated disposable DB 做 drop/recreate/单事务恢复。恢复后 schema、迁移账本和逐表行数 fingerprint 必须与备份基线一致，且无 OpenClaw 新对象残留。

正式切换时，`deploy.sh` 在 DB/runtime 联合回滚 trap 已生效后，用具名、带 release label、120 秒 hard timeout 的 one-off candidate 执行唯一生产迁移。backend 运行时保持 `RUN_MIGRATIONS=false`；backend 健康后才启动 workers、OpenClaw、n8n 和 frontend。任何数据库/runtime 恢复失败都让应用保持停止，不能让客户端连接空库或不一致状态。

## 发布顺序

1. 保持已完成的 group fail-closed 补丁、补丁/树摘要、脱敏证据、peer 链接审计和自动负例完整进入 C1；本地统一门禁继续全通过；
2. 创建 C1/C2 与不可变 source tag；
3. 同步到 Linux 独立仓库，形成独立内容提交、manifest 提交和 annotated release tag；
4. 隔离迁移演练、Linux 部署、生产 smoke、真实智谱和 CRM 工具 E2E；
5. 负责人可见 SSH 扫码与真机 owner/群聊/重复/断线验收；
6. 最后才构建、卸载旧版、安装并验收 Windows 1.4.20。

在上述步骤全部完成前，本目录只能称为本地发布候选。
