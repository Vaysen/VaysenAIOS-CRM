export const CUSTOMER_WORKSPACE_FILTERS = [
  'all',
  'today_follow_up',
  'new_messages',
  'active_opportunities',
  'identity_pending',
  'merge_pending',
  'archived',
] as const;

export type CustomerWorkspaceFilter = typeof CUSTOMER_WORKSPACE_FILTERS[number];

export const CUSTOMER_WORKSPACE_SORTS = [
  'recent_contact',
  'recent_update',
  'follow_up_due',
  'opportunity_amount',
  'name',
] as const;

export type CustomerWorkspaceSort = typeof CUSTOMER_WORKSPACE_SORTS[number];

export interface CustomerWorkspaceRisk {
  key: string;
  label: string;
  severity: 'low' | 'medium' | 'high' | 'critical';
}

export interface CustomerWorkspaceListItem {
  id: string;
  displayName: string;
  companyName?: string | null;
  countryIso2?: string | null;
  ownerName?: string | null;
  status?: string | null;
  lastContactedAt?: string | null;
  updatedAt?: string | null;
  nextFollowUpAt?: string | null;
  opportunityAmount?: number | string | null;
  unreadMessageCount?: number;
  pendingIdentityCount?: number;
  pendingMergeCount?: number;
  archived?: boolean;
  risks?: CustomerWorkspaceRisk[];
}

export interface CustomerWorkspacePage {
  data: CustomerWorkspaceListItem[];
  meta: { page: number; limit: number; total: number; totalPages: number };
}

export interface CustomerWorkspaceCounts {
  total: number;
  todayFollowUp: number;
  newMessages: number;
  activeOpportunities: number;
  identityPending: number;
  mergePending: number;
  archived: number;
  risks?: { high: number; medium: number; low: number };
}

export interface CustomerWorkspaceSummary {
  customer: CustomerWorkspaceListItem & { notes?: string | null; website?: string | null };
  tabs: {
    activity: number;
    profile: number;
    opportunities: number;
    risks: number;
    aiResearch: number;
    documents: number;
    audit: number;
  };
  risks: CustomerWorkspaceRisk[];
  messages: Array<{
    id: string;
    channel?: string | null;
    subject?: string | null;
    preview?: string | null;
    occurredAt?: string | null;
    hasBody: boolean;
  }>;
}

export interface CustomerWorkspaceMessage {
  id: string;
  subject?: string | null;
  body: string;
  occurredAt?: string | null;
  channel?: string | null;
}

export interface CustomerWorkspaceAuditPage {
  data: Array<{ id: string; action: string; actorName?: string | null; createdAt: string; summary?: string | null }>;
  meta: { page: number; limit: number; total: number; totalPages: number };
}
