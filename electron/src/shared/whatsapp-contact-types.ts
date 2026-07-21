/**
 * TASK-102D: WhatsApp 联系人采集契约
 *
 * Preload 只传可信字段:
 * - externalId: 来自 DOM data-id 的原始 JID/LID,如 `8613800001234@c.us` 或 `1234567890@lid`
 * - externalIdKind: 仅按 JID 后缀判定,不从状态文本猜测
 * - phoneCandidate: 仅当能从 JID 可靠提取纯数字时给出,否则为 null
 * - displayNameCandidate: DOM title 原文,后端负责用 sanitizeContactNameCandidate 过滤系统文案
 *
 * 不再采集 `lastMessage` / `isOnline` / `unreadCount` 等 UI 状态字段,
 * 也不再从聊天标题/状态文本反推号码。
 */
export interface WhatsAppContactSnapshot {
  externalId: string; // 如 '8613800001234@c.us' 或 '1234567890@lid'
  externalIdKind: 'phone_jid' | 'lid' | 'unknown';
  phoneCandidate: string | null; // 仅当从 JID 可靠提取时,否则 null
  displayNameCandidate: string | null;
  isGroup: boolean;
  isSelf: boolean;
  observedAt: number;
}

/**
 * 用于 /whatsapp/electron-webhook/contacts 的顶层载荷(与主进程透传格式一致)。
 */
export interface ContactsSyncPayload {
  accountId: string;
  contacts: WhatsAppContactSnapshot[];
  /** 主进程透传的兼容字段,后端 DTO 以 optional 接收 */
  timestamp?: number;
  total?: number;
}

/**
 * 消息载荷中携带的可信联系人快照(Electron 入站消息路径)。
 * 仅用于让后端通过 IdentityResolutionService 关联 contactPointId。
 */
export interface WhatsAppMessageContactRef {
  externalId: string;
  externalIdKind: 'phone_jid' | 'lid' | 'unknown';
  phoneCandidate: string | null;
  displayNameCandidate: string | null;
  isGroup: boolean;
  isSelf: boolean;
}
