import api from '@/lib/api';
import type {
  AudienceSegment,
  AudienceSegmentCriteria,
  AudienceSegmentListResponse,
  AudienceSegmentMember,
} from '@/types/audience-segment';

export async function listAudienceSegments(params?: {
  page?: number;
  pageSize?: number;
  status?: string;
  search?: string;
}): Promise<AudienceSegmentListResponse> {
  const response = await api.get<AudienceSegmentListResponse>('/audience-segments', { params });
  return response.data as any;
}

export async function getAudienceSegment(
  id: string,
  options?: { includeMembers?: boolean; page?: number; pageSize?: number },
): Promise<AudienceSegment & { members?: AudienceSegmentMember[]; totalMembers?: number }> {
  const response = await api.get(`/audience-segments/${id}`, { params: options });
  return response.data as any;
}

export async function createAudienceSegment(input: {
  name: string;
  description?: string;
  criteriaJson: AudienceSegmentCriteria;
  autoRefreshEnabled?: boolean;
  autoRefreshIntervalHours?: number;
}): Promise<AudienceSegment> {
  const response = await api.post('/audience-segments', input);
  return response.data as any;
}

export async function updateAudienceSegment(
  id: string,
  input: {
    name?: string;
    description?: string;
    criteriaJson?: AudienceSegmentCriteria;
    autoRefreshEnabled?: boolean;
    autoRefreshIntervalHours?: number;
    status?: string;
  },
): Promise<AudienceSegment> {
  const response = await api.patch(`/audience-segments/${id}`, input);
  return response.data as any;
}

export async function deleteAudienceSegment(id: string): Promise<void> {
  await api.delete(`/audience-segments/${id}`);
}

export async function refreshAudienceSegment(id: string): Promise<{ memberCount: number }> {
  const response = await api.post(`/audience-segments/${id}/refresh`);
  return response.data as any;
}

export async function previewAudienceSegmentCount(id: string): Promise<{ memberCount: number }> {
  const response = await api.get(`/audience-segments/${id}/preview-count`);
  return response.data as any;
}

export async function addAudienceSegmentMembers(
  id: string,
  leadIds: string[],
): Promise<{ created: number; memberCount: number }> {
  const response = await api.post(`/audience-segments/${id}/members`, { leadIds });
  return response.data as any;
}

export async function removeAudienceSegmentMember(id: string, memberId: string): Promise<void> {
  await api.delete(`/audience-segments/${id}/members/${memberId}`);
}

export async function exportAudienceSegmentLeadIds(id: string): Promise<string[]> {
  const response = await api.get(`/audience-segments/${id}/export`);
  return (response.data as any).leadIds || [];
}
