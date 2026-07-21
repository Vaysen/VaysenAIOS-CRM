# Vaysen AI CRM Voice Agent

该目录是 AI 语音客服的独立部署边界。当前 v0.1 只提供可容器化的健康/就绪控制面和严格的 provider 配置检查；CRM 数据模型、测试会话、转人工上下文与审计已在 NestJS 后端实现。

真实媒体工作进程将在 M1 接入 LiveKit Agents + OpenAI Realtime。没有 LiveKit/Meta/OpenAI 凭据时保持 `VOICE_PROVIDER_MODE=disabled`，`/health` 可用于容器存活检查，`/ready` 必须返回 503，避免把“脚手架可启动”误报成“电话可用”。

WhatsApp Calls 上线还要求 Meta Calls 权限、支持地区、客户许可与公网 webhook；这些条件未满足前不得切换生产模式。完整架构和验收见 `docs/AI-VOICE-CUSTOMER-SERVICE-PRD.md`。
