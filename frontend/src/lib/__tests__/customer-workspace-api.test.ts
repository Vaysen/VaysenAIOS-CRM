import { describe, expect, it, vi } from 'vitest';
import api from '@/lib/api';
import {
  getCustomerWorkspaceAudit,
  getCustomerWorkspaceMessage,
  listCustomerWorkspace,
  toCustomerAssetsListParams,
  type CustomerWorkspaceListQuery,
} from '@/lib/customer-workspace-api';
import contract from '../../../../contracts/customer-workspace-list-query.contract.json';

vi.mock('@/lib/api', () => ({ default: { get: vi.fn() } }));

describe('customer workspace typed API contract', () => {
  it('maps the shared real page request to the backend DTO and unwraps a non-empty response', async () => {
    vi.mocked(api.get).mockResolvedValueOnce({
      data: {
        data: {
          data: [contract.responseFixture],
          meta: { page: 2, limit: 50, total: 51, totalPages: 2 },
        },
      },
    } as never);

    await expect(listCustomerWorkspace(contract.uiRequest as CustomerWorkspaceListQuery))
      .resolves.toMatchObject({ data: [contract.responseFixture] });
    expect(api.get).toHaveBeenCalledWith('/customer-assets', { params: contract.backendQuery });
  });

  it.each([
    ['recent_contact', 'lastContactedAt', 'desc'],
    ['recent_update', 'updatedAt', 'desc'],
    ['follow_up_due', 'nextFollowUpAt', 'asc'],
    ['opportunity_amount', 'opportunityAmount', 'desc'],
    ['name', 'companyName', 'asc'],
  ] as const)('maps %s to the allowlisted backend sort', (sort, sortBy, sortOrder) => {
    expect(toCustomerAssetsListParams({ sort })).toMatchObject({ sortBy, sortOrder });
  });

  it.each([
    'all',
    'today_follow_up',
    'new_messages',
    'active_opportunities',
    'identity_pending',
    'merge_pending',
    'archived',
  ] as const)('maps the %s filter to the explicit backend view', (filter) => {
    expect(toCustomerAssetsListParams({ filter })).toMatchObject({ view: filter });
  });

  it('enforces client page boundaries and uses pageSize for list and audit requests', async () => {
    expect(toCustomerAssetsListParams({ page: 0, limit: 500 })).toMatchObject({ page: 1, pageSize: 50 });
    vi.mocked(api.get).mockResolvedValueOnce({ data: { data: { data: [], meta: { page: 1, limit: 1, total: 0, totalPages: 0 } } } } as never);
    await getCustomerWorkspaceAudit('lead-1', 0, 0);
    expect(api.get).toHaveBeenLastCalledWith('/customer-assets/lead-1/audit', { params: { page: 1, pageSize: 1 } });
  });

  it('does not request message bodies until the explicit message call', async () => {
    vi.mocked(api.get).mockResolvedValueOnce({ data: { data: { id: 'message-1', body: 'private body' } } } as never);
    await expect(getCustomerWorkspaceMessage('lead/1', 'message/1')).resolves.toMatchObject({ body: 'private body' });
    expect(api.get).toHaveBeenCalledWith('/customer-assets/lead%2F1/messages/message%2F1');
  });
});
