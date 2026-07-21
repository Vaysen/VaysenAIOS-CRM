/**
 * TASK-102C: 多租户统一身份解析引擎 — 类型定义
 *
 * ResolveIdentityCommand: 调用方传入的解析请求 (渠道 + 归一化值 + 可选外部身份)
 * ResolveIdentityResult: 解析结果 (discriminated union by action)
 *
 * 设计原则:
 * - companyId 始终必填, 确保租户隔离
 * - normalizedValue 由调用方预先归一化 (E.164 或 lowercase email)
 * - source 区分外部来源与人工编辑, 影响 manual_confirmed 字段保护策略
 */

/**
 * 身份解析命令。
 *
 * @property companyId   - 租户 ID (必填, 所有查询均携带)
 * @property channel     - 接触渠道, 决定 ContactPoint.type
 * @property normalizedValue - 归一化后的唯一值；真实号码不可得时允许 null
 * @property externalIdentity - 可选的外部身份 (如 WhatsApp WA_ID)
 * @property contactNameCandidate - 可选的联系人姓名候选 (外部来源不得覆盖 manual_confirmed)
 * @property countryIso2 - 可选的 ISO 3166-1 alpha-2 国家代码
 * @property source      - 来源标记, 影响字段保护策略
 */
export interface ResolveIdentityCommand {
  companyId: string;
  channel: 'whatsapp' | 'email' | 'phone';
  normalizedValue: string | null;
  externalIdentity?: {
    provider: string;
    externalId: string;
    rawDisplayName?: string;
  };
  contactNameCandidate?: string;
  countryIso2?: string | null;
  source:
    'whatsapp_sync' | 'whatsapp_message' | 'email_message' | 'manual_edit';
}

/**
 * 身份解析结果 (discriminated union)。
 *
 * - linked:         精确匹配到已有 ContactPoint, 直接关联
 * - created:        无任何匹配, 新建 Lead + Contact + ContactPoint
 * - review_required: 尾号相似但 E.164 不同, 新建记录并创建待审候选
 * - unresolved:     只有 LID/JID 等外部身份，尚无可信号码或邮箱
 */
export type ResolveIdentityResult =
  | {
      action: 'linked';
      leadId: string;
      contactId: string;
      contactPointId: string;
    }
  | {
      action: 'created';
      leadId: string;
      contactId: string;
      contactPointId: string;
    }
  | { action: 'review_required'; candidateId: string; leadId: string }
  | { action: 'unresolved'; externalIdentityId: string; reason: string };
