/**
 * TASK-102H: 客户资产统一类型定义
 *
 * 与后端 CustomerAssetDto / CustomerContactDto / ContactPointDto 对齐。
 * 所有字段均显式声明类型，禁止 any。
 */

// ---------------------------------------------------------------------------
// 渠道枚举
// ---------------------------------------------------------------------------

/** 联系点类型 —— 与后端 ContactPointType 对齐 */
export type ContactPointType =
  | 'whatsapp'
  | 'email'
  | 'phone'
  | 'website_inquiry'
  | 'manual'
  | 'business_email'
  | 'marketing_email';

// ---------------------------------------------------------------------------
// 核心实体 (与后端 DTO 对齐)
// ---------------------------------------------------------------------------

/** ContactPointDto */
export interface ContactPoint {
  id: string;
  type: ContactPointType;
  /** 原始值，如 "+86 138 0013 8000" 或 "john@example.com" */
  originalValue: string;
  /** 标准化值，如 "8613800138000" 或 "john@example.com" */
  normalizedValue: string;
  /** 关联会话 ID（若该联系点由会话产生） */
  conversationId: string | null;
  /** 是否可用（未失效/未退订） */
  isAvailable: boolean;
}

/** CustomerContactDto */
export interface CustomerContact {
  id: string;
  firstName: string | null;
  lastName: string | null;
  /** 后端计算的显示名 */
  displayName: string;
  isPrimary: boolean;
  contactPoints: ContactPoint[];
  updatedAt: string;
}

/** PendingCandidate —— 待审核的同一身份候选项 */
export interface PendingCandidate {
  id: string;
  /** 候选公司名 */
  companyName: string | null;
  /** 候选显示名 */
  displayName: string;
  /** 匹配渠道 */
  matchedChannel: ContactPointType;
  /** 匹配分数 (0-1) */
  confidence: number;
  /** 候选联系点摘要 */
  contactPointPreview: string;
  updatedAt: string;
}

/** CustomerAssetDto */
export interface CustomerAsset {
  id: string;
  companyName: string | null;
  /** 后端计算的显示名（公司名缺失时为占位符） */
  displayName: string;
  countryIso2: string | null;
  contacts: CustomerContact[];
  /** 当前选中联系人 ID */
  selectedContactId: string | null;
  /** 待匹配数量 */
  pendingMatchCount: number;
  /** 待审核候选列表 */
  pendingCandidates: PendingCandidate[];
  conversations?: Array<{ id: string; channel?: string; subject?: string | null; threadKey?: string | null }>;
  emails?: Array<{ id: string; subject?: string | null; sentAt?: string | null; receivedAt?: string | null }>;
  quotes?: Array<{ id: string; status?: string; createdAt?: string }>;
  orders?: Array<{ id: string; status?: string; createdAt?: string }>;
  updatedAt: string;
}

// ---------------------------------------------------------------------------
// 查重 & 合并请求/响应类型
// ---------------------------------------------------------------------------

/** POST /customer-assets/duplicate-check 请求体 */
export interface DuplicateCheckCommand {
  /** 关键词：公司名、邮箱或号码片段 */
  query: string;
  /** 可选：排除自身 ID */
  excludeId?: string;
}

/** 单条重复项 */
export interface DuplicateMatch {
  id: string;
  companyName: string | null;
  displayName: string;
  countryIso2: string | null;
  contactPointPreview?: string | null;
  /** 匹配分数 (0-1) */
  confidence: number;
  matchedField: 'companyName' | 'email' | 'phone';
}

/** POST /customer-assets/duplicate-check 响应 */
export interface DuplicateCheckResult {
  hasDuplicates: boolean;
  matches: DuplicateMatch[];
}

/** POST /identity-candidates/:id/merge-preview 响应 */
export interface MergeFieldDiff {
  field: string;
  currentValue: string | null;
  candidateValue: string | null;
  /** 是否推荐采用候选值 */
  recommendCandidate: boolean;
}

export interface MergePreview {
  candidateId: string;
  targetAssetId: string;
  /** 预览时目标客户版本，合并确认必须原样回传。 */
  targetUpdatedAt: string;
  /** 差异字段列表 */
  diffs: MergeFieldDiff[];
  /** 合并后会保留的联系人数量 */
  mergedContactCount: number;
  /** 合并后会保留的渠道数量 */
  mergedChannelCount: number;
}

/** POST /identity-candidates/:id/merge 请求体 */
export interface MergeCommand {
  candidateId: string;
  /** 字段级选择：指定采用候选值的字段 */
  adoptFields?: string[];
  targetUpdatedAt: string;
}

/** POST /identity-candidates/:id/merge 响应 */
export interface MergeResult {
  /** 合并审计 ID，用于撤销 */
  auditId: string;
  /** 合并后的客户资产 ID */
  mergedAssetId: string;
}

// ---------------------------------------------------------------------------
// 辅助类型
// ---------------------------------------------------------------------------

/** 用于 formatContactName 的最小输入结构 */
export interface ContactNameInput {
  firstName: string | null;
  lastName: string | null;
  displayName: string | null;
}

/** Hook 状态联合类型 */
export type LoadStatus = 'idle' | 'loading' | 'success' | 'error';
