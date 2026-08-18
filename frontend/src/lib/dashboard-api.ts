import api from '@/lib/api';

export interface EngagementTrendDaily {
  date: string;
  sent: number;
  opened: number;
  clicked: number;
  replied: number;
  openRate: number;
  clickRate: number;
  replyRate: number;
}

export interface MailCenterTrendDaily {
  date: string;
  inbound: number;
  outbound: number;
}

export interface LeadSourceEntry {
  source: string;
  count: number;
  pct: number;
}

export interface WhatsappStats {
  conversations: number;
  activeConversations: number;
  messages: number;
  inbound: number;
  outbound: number;
  read: number;
  unreadConversations: number;
  readRate: number;
}

export interface DeliveryRun {
  id: string;
  campaignId: string;
  campaignName: string;
  channel: string;
  status: string;
  totalCount: number;
  processedCount: number;
  lastError: string | null;
  executedAt: string | null;
  createdAt: string;
}

export interface CampaignEngagementRow {
  id: string;
  name: string;
  channel: string;
  status: string;
  memberCount: number;
  sent: number;
  delivered: number;
  opened: number;
  clicked: number;
  replied: number;
  openRate: number;
  clickRate: number;
  replyRate: number;
}

export interface DailyDiagnosis {
  id: string;
  companyId: string;
  diagnosisDate: string;
  status: 'COMPLETED' | 'FAILED' | 'GENERATING';
  healthScore: number | null;
  summary: string | null;
  highlights: string[] | null;
  risks: string[] | null;
  recommendations:
    | Array<{ priority: 'P0' | 'P1' | 'P2'; title: string; reason: string; action: string }>
    | null;
  metricsSnapshot: unknown;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface FxRates {
  base: string;
  rates: Record<string, number>;
  cross: Record<string, string>;
  updatedAt: string;
  source: string;
}

export async function getEngagementTrends(
  companyId: string,
  days = 14,
): Promise<EngagementTrendDaily[]> {
  const response = await api.get<{ daily?: EngagementTrendDaily[] }>('/analytics/engagement-trends', {
    params: { days },
  });
  return response.data?.daily || [];
}

export async function getMailCenterTrends(
  companyId: string,
  days = 7,
): Promise<MailCenterTrendDaily[]> {
  const response = await api.get<{ daily?: MailCenterTrendDaily[] }>('/analytics/mail-center-trends', {
    params: { days },
  });
  return response.data?.daily || [];
}

export async function getLeadSources(companyId: string): Promise<LeadSourceEntry[]> {
  const response = await api.get<{ sources?: LeadSourceEntry[] }>('/analytics/sources');
  return response.data?.sources || [];
}

export async function getWhatsappStats(companyId: string): Promise<WhatsappStats | null> {
  const response = await api.get<WhatsappStats>('/analytics/whatsapp-stats');
  return response.data || null;
}

export async function getDeliveryRuns(
  companyId: string,
  limit = 12,
): Promise<{ runs: DeliveryRun[]; statusDistribution: Array<{ status: string; count: number }> }> {
  const response = await api.get<{
    runs?: DeliveryRun[];
    statusDistribution?: Array<{ status: string; count: number }>;
  }>('/marketing-execution/delivery-runs', { params: { limit } });
  return {
    runs: response.data?.runs || [],
    statusDistribution: response.data?.statusDistribution || [],
  };
}

export async function getCampaignEngagement(
  companyId: string,
  limit = 12,
): Promise<CampaignEngagementRow[]> {
  const response = await api.get<{ campaigns?: CampaignEngagementRow[] }>(
    '/marketing-campaigns/engagement',
    { params: { limit } },
  );
  return response.data?.campaigns || [];
}

export async function getDailyDiagnosis(
  companyId: string,
): Promise<{ generating: boolean } | DailyDiagnosis | null> {
  const response = await api.get<{ generating?: boolean } | DailyDiagnosis>('/daily-diagnosis/today', {
    params: { companyId },
    timeout: 60000,
  });
  const data = response.data as { generating?: boolean } | DailyDiagnosis | null;
  if (!data) return null;
  if ('generating' in data && data.generating) return { generating: true };
  return data as DailyDiagnosis;
}

export async function regenerateDailyDiagnosis(companyId: string): Promise<DailyDiagnosis> {
  const response = await api.post<DailyDiagnosis>('/daily-diagnosis/regenerate', { companyId });
  return response.data;
}

export async function getFxRates(): Promise<FxRates | null> {
  try {
    const response = await api.get<FxRates>('/exchange-rates/latest', { timeout: 8000 });
    return response.data || null;
  } catch {
    return null;
  }
}
