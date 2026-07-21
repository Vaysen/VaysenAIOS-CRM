# Vaysen AI CRM 工具规则

## 选择令牌

- 所有客户级工具先调用 `crm_customer_search`。
- 唯一客户成立后即签发绑定 `leadId` 的独立 `selectionToken`；插件在同一可信会话内自动为下一工具注入正确令牌，模型不需要也不得手工复制。WhatsApp 读写还会额外要求唯一可信直聊，邮件发送会额外要求唯一可信邮箱。
- 令牌绑定公司、操作人、渠道、账号、会话、原始请求、目标工具和可信 conversationId；过期、跨工具、跨上下文、重放或模糊搜索全部拒绝。
- 模型不得提交或猜测 CRM UUID、电话号码、WhatsApp JID、邮箱地址、账号 ID、线程 ID、URL 或文件路径。

## 21 个业务工具

### 读取与工作管理

- `crm_work_brief`：读取真实工作简报。
- `crm_customer_search` / `crm_customer_get`：唯一定位并读取客户安全摘要。
- `crm_order_list` / `crm_quote_list`：读取该客户真实订单与报价。
- `crm_product_search`：读取版本化 USD 产品价格。
- `crm_whatsapp_messages_read` / `crm_email_messages_read`：读取最小化、脱敏的该客户消息。

### CRM 写入

- `crm_customer_add_note`、`crm_customer_update`、`crm_customer_set_stage`
- `crm_task_create`
- `crm_order_create_draft`、`crm_order_update_stage`
- `crm_quote_create_draft`
- `crm_start_background_research`
- `crm_prepare_quote_delivery`

客户电话、WhatsApp 和邮箱身份锚点不能由模型改写；高金额、关键订单阶段和其他高风险动作仍遵循后端审批策略。

### 真实外发

- `crm_whatsapp_send_text`：向唯一选中客户的可信直聊发送一条文本。
- `crm_whatsapp_send_quote`：根据该客户报价列表中的编号，服务端重新生成并发送一个 `approved` 报价 PDF。
- `crm_email_send`：通过后端选定的唯一活动公司邮箱向该客户唯一可信邮箱发送邮件。
- `crm_email_reply`：回复该客户最新可信业务邮件线程。

这些外发只在 `SUPERVISOR` 模式且后端权限允许时执行。群聊、批量、任意目标、多个可信目标、未连接 Baileys、多个发件账号、无真实 provider/SMTP 回执都会 fail closed。

## 执行回执

每次调用只根据后端返回的 `requestId`、`businessStatus`、业务编号和 provider 回执汇报：

- `SUCCEEDED`：真实业务动作完成。
- `BLOCKED` / `APPROVAL_REQUIRED`：没有执行外部副作用。
- `PREPARED_NOT_SENT`：只完成准备，尚未外发。
- WhatsApp/报价必须有真实 provider messageId；邮件必须有真实 SMTP messageId。

成功回执由 OpenClaw receipt 幂等保存；相同请求重试不得创建第二次外发。

## Coding profile 边界

OpenClaw 生产使用 `coding` profile，可使用受限工作区文件工具、浏览器、TTS、心跳和内部 `sessions_send`。文件系统限制在只读 `/opt/vaysen-workspace`。`exec`、`process`、`gateway`、`nodes` 和通用 `message` 始终禁用；CRM 外发必须使用上面的专用工具。

负责人微信验收 marker 格式为 `JYACC_OWNER_[a-f0-9]{16}`，只可作为 `acceptanceMarker` 调用一次 `crm_work_brief`。
