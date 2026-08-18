export type MarketingCampaignStatus =
  | 'DRAFT'
  | 'PLANNING'
  | 'IN_REVIEW'
  | 'APPROVED_PLAN'
  | 'PAUSED'
  | 'CANCELLED'
  | 'ARCHIVED';

export interface MarketingCampaign {
  id: string;
  companyId: string;
  ownerUserId: string;
  name: string;
  description: string | null;
  channel: 'email' | 'whatsapp' | null;
  status: MarketingCampaignStatus;
  scheduleIntent: Record<string, unknown> | null;
  windowStart: string | null;
  windowEnd: string | null;
  createdAt: string;
  updatedAt: string;
  channelPlans?: MarketingChannelPlan[];
  audienceSnapshot?: { id: string; memberCount: number } | null;
  _count?: { events: number; contentVersions: number; deliveryRuns: number };
}

export interface MarketingCampaignSegmentLink {
  id: string;
  campaignId: string;
  segmentId: string;
  segmentName: string | null;
  memberCount: number;
  createdAt: string;
}

export interface MarketingCampaignTemplate {
  id: string;
  name: string;
  description: string;
  defaultCriteria: Record<string, unknown>;
  suggestedChannel: 'email' | 'whatsapp';
  aiPrompt: string;
}

export interface MarketingChannelPlan {
  id: string;
  campaignId: string;
  channel: string;
  status: string;
  frequency: number | null;
  windowSeconds: number | null;
}

export const MARKETING_CAMPAIGN_STATUS_LABELS: Record<MarketingCampaignStatus, string> = {
  DRAFT: '草稿',
  PLANNING: '计划中',
  IN_REVIEW: '审核中',
  APPROVED_PLAN: '已批准',
  PAUSED: '已暂停',
  CANCELLED: '已取消',
  ARCHIVED: '已归档',
};

export const MARKETING_STATUS_COLORS: Record<MarketingCampaignStatus, string> = {
  DRAFT: 'bg-gray-100 text-gray-600',
  PLANNING: 'bg-blue-100 text-blue-700',
  IN_REVIEW: 'bg-amber-100 text-amber-700',
  APPROVED_PLAN: 'bg-green-100 text-green-700',
  PAUSED: 'bg-orange-100 text-orange-700',
  CANCELLED: 'bg-red-100 text-red-600',
  ARCHIVED: 'bg-slate-100 text-slate-500',
};
