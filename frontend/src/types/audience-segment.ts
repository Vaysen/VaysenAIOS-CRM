export type AudienceSegmentStatus = 'active' | 'paused';

export interface AudienceSegmentCriteria {
  leadStatuses?: string[];
  leadGrades?: string[];
  countries?: string[];
  sourceTypes?: string[];
  tags?: string[];
  createdWithinDays?: number;
  hasSampleQuote?: boolean;
  hasOrder?: boolean;
  followedUpNoReplyDays?: number;
  hasEmail?: boolean;
  hasWhatsapp?: boolean;
  opportunityStages?: string[];
  notInSegmentIds?: string[];
  limit?: number;
}

export interface AudienceSegment {
  id: string;
  companyId: string;
  name: string;
  description: string | null;
  criteriaJson: AudienceSegmentCriteria;
  memberCount: number;
  autoRefreshEnabled: boolean;
  autoRefreshIntervalHours: number;
  lastRefreshedAt: string | null;
  status: AudienceSegmentStatus;
  createdById: string;
  createdAt: string;
  updatedAt: string;
}

export interface AudienceSegmentMember {
  id: string;
  segmentId: string;
  leadId: string;
  status: string;
  addedReason: string;
  createdAt: string;
  lead?: {
    id: string;
    leadName?: string | null;
    companyName?: string | null;
    country?: string | null;
    sourceType?: string | null;
    leadGrade?: string | null;
    status?: string | null;
    contactEmail?: string | null;
    whatsapp?: string | null;
  };
}

export interface AudienceSegmentListResponse {
  items: AudienceSegment[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
}

export const AUDIENCE_SEGMENT_STATUS_LABELS: Record<AudienceSegmentStatus, string> = {
  active: '启用',
  paused: '暂停',
};

export const LEAD_STATUS_OPTIONS = [
  { value: 'new', label: '新客户' },
  { value: 'prospect_pool', label: '潜客池' },
  { value: 'contacted', label: '已联系' },
  { value: 'replied', label: '已回复' },
  { value: 'quoted', label: '已报价' },
  { value: 'interested', label: '感兴趣' },
  { value: 'won', label: '成交' },
  { value: 'lost', label: '流失' },
];

export const LEAD_GRADE_OPTIONS = [
  { value: 'A', label: 'A 级' },
  { value: 'B', label: 'B 级' },
  { value: 'C', label: 'C 级' },
];
