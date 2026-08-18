import api from './api';
import type {
  CustomerWorkspaceAuditPage,
  CustomerWorkspaceCounts,
  CustomerWorkspaceFilter,
  CustomerWorkspaceMessage,
  CustomerWorkspacePage,
  CustomerWorkspaceSort,
  CustomerWorkspaceSummary,
} from '@/types/customer-workspace';

type Envelope<T> = T | { data: T };

function unwrap<T>(value: Envelope<T>): T {
  if (value && typeof value === 'object' && 'data' in value && !('meta' in value)) return value.data as T;
  return value as T;
}

export interface CustomerWorkspaceListQuery {
  search?: string;
  filter?: CustomerWorkspaceFilter;
  sort?: CustomerWorkspaceSort;
  page?: number;
  limit?: number;
}

export interface CustomerAssetsListParams {
  search?: string;
  view: CustomerWorkspaceFilter;
  sortBy: 'lastContactedAt' | 'updatedAt' | 'nextFollowUpAt' | 'opportunityAmount' | 'companyName';
  sortOrder: 'asc' | 'desc';
  page: number;
  pageSize: number;
}

const SORT_PARAMS: Record<CustomerWorkspaceSort, Pick<CustomerAssetsListParams, 'sortBy' | 'sortOrder'>> = {
  recent_contact: { sortBy: 'lastContactedAt', sortOrder: 'desc' },
  recent_update: { sortBy: 'updatedAt', sortOrder: 'desc' },
  follow_up_due: { sortBy: 'nextFollowUpAt', sortOrder: 'asc' },
  opportunity_amount: { sortBy: 'opportunityAmount', sortOrder: 'desc' },
  name: { sortBy: 'companyName', sortOrder: 'asc' },
};

function boundedInteger(value: number | undefined, fallback: number, maximum?: number): number {
  const integer = Number.isFinite(value) ? Math.floor(value as number) : fallback;
  return Math.min(maximum ?? Number.MAX_SAFE_INTEGER, Math.max(1, integer));
}

export function toCustomerAssetsListParams(query: CustomerWorkspaceListQuery = {}): CustomerAssetsListParams {
  const sort = SORT_PARAMS[query.sort ?? 'recent_update'];
  const search = query.search?.trim();
  return {
    ...(search ? { search } : {}),
    view: query.filter ?? 'all',
    ...sort,
    page: boundedInteger(query.page, 1),
    pageSize: boundedInteger(query.limit, 20, 50),
  };
}

export async function getCustomerWorkspaceCounts(): Promise<CustomerWorkspaceCounts> {
  const response = await api.get<Envelope<CustomerWorkspaceCounts>>('/customer-assets/counts');
  return unwrap(response.data);
}

export async function listCustomerWorkspace(query: CustomerWorkspaceListQuery = {}): Promise<CustomerWorkspacePage> {
  const response = await api.get<Envelope<CustomerWorkspacePage>>('/customer-assets', {
    params: toCustomerAssetsListParams(query),
  });
  return unwrap(response.data);
}

export async function getCustomerWorkspace(id: string): Promise<CustomerWorkspaceSummary> {
  const response = await api.get<Envelope<CustomerWorkspaceSummary>>(`/customer-assets/${encodeURIComponent(id)}/workspace`);
  return unwrap(response.data);
}

export async function getCustomerWorkspaceMessage(customerId: string, messageId: string): Promise<CustomerWorkspaceMessage> {
  const response = await api.get<Envelope<CustomerWorkspaceMessage>>(
    `/customer-assets/${encodeURIComponent(customerId)}/messages/${encodeURIComponent(messageId)}`,
  );
  return unwrap(response.data);
}

export async function getCustomerWorkspaceAudit(customerId: string, page = 1, limit = 20): Promise<CustomerWorkspaceAuditPage> {
  const response = await api.get<Envelope<CustomerWorkspaceAuditPage>>(`/customer-assets/${encodeURIComponent(customerId)}/audit`, {
    params: { page: boundedInteger(page, 1), pageSize: boundedInteger(limit, 20, 50) },
  });
  return unwrap(response.data);
}
