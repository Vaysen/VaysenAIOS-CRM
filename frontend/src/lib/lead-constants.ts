export const LEAD_STAGES = [
  'prospect_pool',
  'new',
  'contacted',
  'replied',
  'interested',
  'quoted',
  'won',
  'lost',
] as const;

export const CRM_STAGES = [
  'new',
  'contacted',
  'replied',
  'interested',
  'quoted',
  'won',
  'lost',
] as const;

export const ACTIVE_STAGES = CRM_STAGES.slice(0, 5);
export const CLOSED_STAGES = CRM_STAGES.slice(5);
export const STATUS_VALUES = [...LEAD_STAGES];

export const REVIEW_STATUSES = ['pending', 'needs_enrichment', 'manual_review', 'approved', 'rejected'] as const;
export const REVIEW_STATUS_LABELS: Record<string, string> = {
  pending: '待审核（资料不足）',
  needs_enrichment: '需补充资料',
  manual_review: '人工复核（证据冲突）',
  approved: '已通过（资料充分）',
  rejected: '已拒绝（非目标客户）',
};

export const STATUS_COLORS: Record<string, string> = {
  prospect_pool: 'bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-300',
  new: 'bg-gray-100 text-gray-700 dark:bg-gray-800 dark:text-gray-300',
  contacted: 'bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400',
  replied: 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400',
  interested: 'bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400',
  quoted: 'bg-orange-100 text-orange-700 dark:bg-orange-900/30 dark:text-orange-400',
  won: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-400',
  lost: 'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400',
};

export const REVIEW_STATUS_COLORS: Record<string, string> = {
  pending: 'bg-purple-100 text-purple-700 dark:bg-purple-900/30 dark:text-purple-400',
  needs_enrichment: 'bg-indigo-100 text-indigo-700 dark:bg-indigo-900/30 dark:text-indigo-400',
  manual_review: 'bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400',
  approved: 'bg-teal-100 text-teal-700 dark:bg-teal-900/30 dark:text-teal-400',
  rejected: 'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400',
};

export const GRADE_COLORS: Record<string, string> = {
  A: 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400',
  B: 'bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400',
  C: 'bg-yellow-100 text-yellow-700 dark:bg-yellow-900/30 dark:text-yellow-400',
  D: 'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400',
};

export const COLUMN_BORDER_COLORS: Record<string, string> = {
  prospect_pool: 'border-t-slate-400',
  new: 'border-t-gray-400',
  contacted: 'border-t-blue-400',
  replied: 'border-t-green-400',
  interested: 'border-t-amber-400',
  quoted: 'border-t-orange-400',
  won: 'border-t-emerald-400',
  lost: 'border-t-red-400',
};

export const FOLLOW_UP_LABELS: Record<string, string> = {
  due_today: 'dueToday',
  overdue: 'overdue',
  long_time_no_contact: 'longTimeNoContact',
  normal: 'normal',
};

export const FOLLOW_UP_COLORS: Record<string, string> = {
  due_today: 'bg-yellow-100 text-yellow-700 dark:bg-yellow-900/30 dark:text-yellow-400',
  overdue: 'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400',
  long_time_no_contact: 'bg-orange-100 text-orange-700 dark:bg-orange-900/30 dark:text-orange-400',
  normal: '',
};

// ============================================================
//  Evidence-first 管线状态常量（Phase 2 重构新增）
// ============================================================

/** 邮箱验证状态 — 对应后端 emailVerificationStatus 字段 */
export const EMAIL_VERIFY_STATUSES = [
  'unverified',
  'verified_public_source',
  'public_page_verified',
  'official_page_verified',
  'smtp_verified',
  'mx_domain_verified',
  'domain_verified',
  'rejected',
  'failed',
  'invalid',
  'no_mx',
  'blocked',
  'free_mailbox',
] as const;

export const EMAIL_VERIFY_LABELS: Record<string, string> = {
  unverified: '未验证',
  verified_public_source: '公开来源确认',
  public_page_verified: '公开页面确认',
  official_page_verified: '官网验证',
  smtp_verified: 'SMTP 确认（可群发）',
  mx_domain_verified: '仅 MX 有效（需复核）',
  domain_verified: '域名已验证（需复核）',
  rejected: '已拒绝',
  failed: '验证失败',
  invalid: '格式无效',
  no_mx: '域名无 MX 记录',
  blocked: '被拦截（role邮箱）',
  free_mailbox: '免费邮箱（不允许）',
};

export const EMAIL_VERIFY_COLORS: Record<string, string> = {
  unverified: 'bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-400',
  verified_public_source: 'bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400',
  public_page_verified: 'bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400',
  official_page_verified: 'bg-teal-100 text-teal-700 dark:bg-teal-900/30 dark:text-teal-400',
  smtp_verified: 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400',
  mx_domain_verified: 'bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400',
  domain_verified: 'bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400',
  rejected: 'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400',
  failed: 'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400',
  invalid: 'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400',
  no_mx: 'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400',
  blocked: 'bg-orange-100 text-orange-700 dark:bg-orange-900/30 dark:text-orange-400',
  free_mailbox: 'bg-orange-100 text-orange-700 dark:bg-orange-900/30 dark:text-orange-400',
};

export const EMAIL_VERIFY_ICONS: Record<string, string> = {
  unverified: '❓',
  verified_public_source: 'OK',
  public_page_verified: 'OK',
  official_page_verified: 'OK',
  smtp_verified: 'SECURE',
  mx_domain_verified: 'OK',
  domain_verified: '📡',
  rejected: '🚫',
  failed: '❌',
  invalid: '❗',
  no_mx: '📭',
  blocked: '🛡️',
  free_mailbox: '📧',
};

/** 可信任进入自动开发链路的验证等级 */
export const TRUSTED_VERIFY_LEVELS = ['verified_public_source', 'official_page_verified', 'smtp_verified'];

/** 获客管线三栏：对应后端 reviewStatus + 判定逻辑 */
export const PIPELINE_COLUMNS = [
  { key: 'ready_for_outreach', label: '可开发', color: 'border-t-green-400', bg: 'bg-green-50/50 dark:bg-green-900/5', description: '邮箱已通过可信验证，信息完整，可直接群发开发信' },
  { key: 'manual_review', label: '人工复核', color: 'border-t-amber-400', bg: 'bg-amber-50/50 dark:bg-amber-900/5', description: '信息不全或来源不够可靠，需人工确认后再开发' },
  { key: 'rejected', label: '已拒绝', color: 'border-t-red-400', bg: 'bg-red-50/50 dark:bg-red-900/5', description: '邮箱无效、占位信息、或行业/规模明确不匹配' },
] as const;

export const PIPELINE_COLUMN_LABELS: Record<string, string> = {
  ready_for_outreach: '可开发',
  manual_review: '人工复核',
  rejected: '已拒绝',
};

/** 拒绝原因预设 — 对应后端 rejectionReason / emailVerificationReason */
export const REJECTION_REASONS: Record<string, string> = {
  placeholder_phone: '占位号码（+81-3-1234-5678 等模式）',
  invalid_email_format: '邮箱格式无效',
  email_bounced: '邮箱已被退信',
  catch_all_domain: '域名 catch-all，无法确认邮箱真实存在',
  no_online_presence: '无网络痕迹可验证公司真实性',
  wrong_industry: '行业不匹配目标画像',
  duplicate_lead: '重复客户',
  too_small: '规模过小（个体户/无员工信息）',
  no_import_record: '海关无进口记录',
  ai_low_confidence: 'AI 匹配置信度不足',
};

/** 数据来源类型 */
export const SOURCE_TYPE_LABELS: Record<string, string> = {
  google_maps: 'Google Maps',
  linkedin: 'LinkedIn',
  searxng: 'SearXNG 搜索',
  facebook: 'Facebook',
  instagram: 'Instagram',
  trade_show: '展会名录',
  customs_data: '海关数据',
  company_website: '公司官网',
  manual_entry: '手动录入',
  csv_import: 'CSV 导入',
  ai_search: 'AI 搜索',
};
