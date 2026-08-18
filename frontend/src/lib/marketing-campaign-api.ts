import api from '@/lib/api';
import type {
  MarketingCampaign,
  MarketingCampaignSegmentLink,
  MarketingCampaignTemplate,
} from '@/types/marketing-campaign';

export async function listMarketingCampaigns(): Promise<MarketingCampaign[]> {
  const response = await api.get<{ data?: MarketingCampaign[] }>('/marketing-campaigns');
  const data = response.data;
  return (data && (data as any).data ? (data as any).data : data) as MarketingCampaign[];
}

export async function getMarketingCampaign(id: string): Promise<MarketingCampaign> {
  const response = await api.get<MarketingCampaign>(`/marketing-campaigns/${id}`);
  const data = response.data;
  return (data && (data as any).data ? (data as any).data : data) as MarketingCampaign;
}

export async function createMarketingCampaign(input: {
  name: string;
  description?: string;
  channel?: 'email' | 'whatsapp';
  windowStart?: string;
  windowEnd?: string;
}): Promise<MarketingCampaign> {
  const response = await api.post('/marketing-campaigns', input);
  const data = response.data;
  return (data && (data as any).data ? (data as any).data : data) as MarketingCampaign;
}

export async function updateMarketingCampaign(
  id: string,
  input: { name?: string; description?: string; channel?: 'email' | 'whatsapp'; windowStart?: string; windowEnd?: string },
): Promise<MarketingCampaign> {
  const response = await api.patch(`/marketing-campaigns/${id}`, input);
  const data = response.data;
  return (data && (data as any).data ? (data as any).data : data) as MarketingCampaign;
}

export async function transitionMarketingCampaign(
  id: string,
  action: string,
): Promise<MarketingCampaign> {
  const response = await api.post(`/marketing-campaigns/${id}/transitions`, { action });
  const data = response.data;
  return (data && (data as any).data ? (data as any).data : data) as MarketingCampaign;
}

export async function listMarketingCampaignEvents(id: string): Promise<any[]> {
  const response = await api.get(`/marketing-campaigns/${id}/events`);
  const data = response.data;
  return (data && (data as any).data ? (data as any).data : data) as any[];
}

export async function listMarketingChannelPlans(id: string): Promise<any[]> {
  const response = await api.get(`/marketing-campaigns/${id}/channel-plans`);
  const data = response.data;
  return (data && (data as any).data ? (data as any).data : data) as any[];
}

export async function addMarketingChannelPlan(
  id: string,
  input: { channel: string; frequency?: number; windowSeconds?: number },
): Promise<any> {
  const response = await api.post(`/marketing-campaigns/${id}/channel-plans`, input);
  const data = response.data;
  return (data && (data as any).data ? (data as any).data : data) as any;
}

export async function runMarketingPreflight(id: string): Promise<any> {
  const response = await api.post(`/marketing-campaigns/${id}/preflight-runs`);
  const data = response.data;
  return (data && (data as any).data ? (data as any).data : data) as any;
}

export async function listMarketingPreflightRuns(id: string): Promise<any[]> {
  const response = await api.get(`/marketing-campaigns/${id}/preflight-runs`);
  const data = response.data;
  return (data && (data as any).data ? (data as any).data : data) as any[];
}

export async function snapshotMarketingAudience(
  id: string,
  input?: { segmentId?: string; leadStatuses?: string[]; channels?: string[]; limit?: number },
): Promise<any> {
  const response = await api.post(`/marketing-campaigns/${id}/audience`, input || {});
  const data = response.data;
  return (data && (data as any).data ? (data as any).data : data) as any;
}

export async function listMarketingCampaignTemplates(): Promise<MarketingCampaignTemplate[]> {
  const response = await api.get('/marketing-campaigns/templates');
  const data = response.data;
  return (data && (data as any).data ? (data as any).data : data) as MarketingCampaignTemplate[];
}

export async function listMarketingCampaignSegments(id: string): Promise<MarketingCampaignSegmentLink[]> {
  const response = await api.get(`/marketing-campaigns/${id}/segments`);
  const data = response.data;
  return (data && (data as any).data ? (data as any).data : data) as MarketingCampaignSegmentLink[];
}

export async function linkMarketingCampaignSegment(id: string, segmentId: string): Promise<any> {
  const response = await api.post(`/marketing-campaigns/${id}/segments`, { segmentId });
  const data = response.data;
  return (data && (data as any).data ? (data as any).data : data) as any;
}

export async function unlinkMarketingCampaignSegment(id: string, segmentId: string): Promise<any> {
  const response = await api.delete(`/marketing-campaigns/${id}/segments/${segmentId}`);
  const data = response.data;
  return (data && (data as any).data ? (data as any).data : data) as any;
}

export async function createMarketingContentVersion(
  id: string,
  input: { title?: string; subject?: string; body?: string; channel?: string; aiPrompt?: string; autoActivate?: boolean },
): Promise<any> {
  const response = await api.post(`/marketing-campaigns/${id}/content-versions`, input);
  const data = response.data;
  return (data && (data as any).data ? (data as any).data : data) as any;
}
