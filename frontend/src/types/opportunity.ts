export const OPPORTUNITY_STAGES = [
  'new',
  'discovery',
  'qualified',
  'proposal',
  'negotiation',
  'won',
  'lost',
] as const;

export type OpportunityStage = (typeof OPPORTUNITY_STAGES)[number];

export const OPPORTUNITY_STAGE_TRANSITIONS: Record<OpportunityStage, readonly OpportunityStage[]> = {
  new: ['discovery', 'lost'],
  discovery: ['qualified', 'lost'],
  qualified: ['proposal', 'lost'],
  proposal: ['negotiation', 'lost'],
  negotiation: ['won', 'lost'],
  won: [],
  lost: [],
};

export const OPPORTUNITY_STAGE_LABELS: Record<OpportunityStage, string> = {
  new: '新建',
  discovery: '需求沟通',
  qualified: '已确认',
  proposal: '方案报价',
  negotiation: '商务谈判',
  won: '已赢单',
  lost: '已输单',
};

export const OPPORTUNITY_CONTACT_ROLE_TYPES = [
  'decision_maker',
  'buyer',
  'champion',
  'influencer',
  'technical',
  'finance',
  'shipping',
  'other',
] as const;

export type OpportunityContactRoleType = (typeof OPPORTUNITY_CONTACT_ROLE_TYPES)[number];

export const OPPORTUNITY_CONTACT_ROLE_LABELS: Record<OpportunityContactRoleType, string> = {
  decision_maker: '决策人',
  buyer: '采购方',
  champion: '支持者',
  influencer: '影响者',
  technical: '技术联系人',
  finance: '财务联系人',
  shipping: '物流联系人',
  other: '其他',
};

export interface OpportunityLeadSummary {
  id: string;
  companyName: string | null;
  contactName: string | null;
  country: string | null;
}

export interface OpportunityOwnerSummary {
  id: string;
  displayName: string;
}

export interface OpportunityContactSummary {
  id: string;
  displayName: string | null;
  title: string | null;
  isPrimary: boolean;
}

export interface OpportunityContactDirectoryItem {
  id: string;
  displayName: string | null;
  firstName: string | null;
  lastName: string | null;
  title: string | null;
  isPrimary: boolean;
}

export interface Opportunity {
  id: string;
  leadId: string;
  lead: OpportunityLeadSummary | null;
  owner: OpportunityOwnerSummary | null;
  name: string;
  description: string | null;
  stage: OpportunityStage;
  amount: string | null;
  currency: string;
  probability: number;
  expectedCloseDate: string | null;
  nextStep: string | null;
  wonAt: string | null;
  lostAt: string | null;
  lostReason: string | null;
  version: number;
  createdAt: string;
  updatedAt: string;
}

export interface OpportunityStageHistoryItem {
  id: string;
  fromStage: OpportunityStage | null;
  toStage: OpportunityStage;
  changedAt: string;
  note: string | null;
  amountSnapshot: string | null;
  probabilitySnapshot: number | null;
  expectedCloseDateSnapshot: string | null;
  source: string;
}

export interface OpportunityContactRole {
  id: string;
  contactId: string;
  roleType: OpportunityContactRoleType;
  isPrimary: boolean;
  createdAt: string;
  contact: OpportunityContactSummary | null;
}

export interface OpportunityListResponse {
  data: Opportunity[];
  meta: {
    page: number;
    limit: number;
    total: number;
    totalPages: number;
  };
}

export interface OpportunityHistoryResponse {
  data: OpportunityStageHistoryItem[];
}

export interface OpportunityContactRoleResponse {
  data: OpportunityContactRole[];
}

export interface CreateOpportunityInput {
  leadId: string;
  name: string;
  description?: string;
  stage?: OpportunityStage;
  amount?: string | null;
  currency?: string;
  probability?: number;
  expectedCloseDate?: string | null;
  nextStep?: string | null;
  lostReason?: string;
}

export interface TransitionOpportunityInput {
  stage: OpportunityStage;
  version: number;
  probability?: number;
  note?: string;
  lostReason?: string;
}

export interface OpportunitySummary {
  id: string;
  name: string;
  stage: OpportunityStage;
  amount: string | null;
  currency: string;
  probability: number;
  version: number;
}

export function formatOpportunityAmount(value: string | null | undefined, currency = 'USD'): string {
  const amount = Number(value || 0);
  return `${currency} ${Number.isFinite(amount) ? amount.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : '0.00'}`;
}

export function formatOpportunityDate(value: string | null | undefined): string {
  if (!value) return '-';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '-' : date.toLocaleDateString('zh-CN');
}

export function formatOpportunityLead(lead: OpportunityLeadSummary | null): string {
  if (!lead) return '客户摘要不可用';
  return lead.companyName?.trim() || lead.contactName?.trim() || '客户名称未提供';
}

export function formatOpportunityContact(lead: OpportunityLeadSummary | null): string {
  if (!lead) return '联系人摘要不可用';
  return lead.contactName?.trim() || '联系人未提供';
}

export function formatOpportunityOwner(owner: OpportunityOwnerSummary | null): string {
  if (!owner || !owner.displayName.trim()) return '负责人摘要不可用';
  return owner.displayName.trim();
}
