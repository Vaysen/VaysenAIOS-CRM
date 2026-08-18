import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import CustomerDetailPage from '../client-page';

const apiGet = vi.fn();
vi.mock('@/lib/api', () => ({ default: { get: (...args: unknown[]) => apiGet(...args), patch: vi.fn(), put: vi.fn(), delete: vi.fn(), post: vi.fn() } }));
vi.mock('next/link', () => ({ default: ({ href, children, ...props }: { href: string; children: React.ReactNode }) => <a href={href} {...props}>{children}</a> }));
vi.mock('next/navigation', () => ({ useParams: () => ({ id: 'lead-1' }) }));
vi.mock('@/features/customer-assets/hooks/use-customer-asset', () => ({ useCustomerAsset: () => ({ data: { companyName: 'Buyer Company', displayName: 'Buyer', countryIso2: 'US', contacts: [], selectedContactId: null, pendingMatchCount: 0, pendingCandidates: [], quotes: [], orders: [], conversations: [], emails: [] }, loading: false, error: null, refetch: vi.fn() }) }));
vi.mock('@/features/customer-assets/hooks/use-customer-merge', () => ({ useCustomerMerge: () => ({ preview: null, pendingAction: null, loadPreview: vi.fn(), doMerge: vi.fn(), doReject: vi.fn() }) }));

describe('Customer opportunity area', () => {
  beforeEach(() => {
    apiGet.mockImplementation((url: string) => {
      if (url === '/leads/lead-1') return Promise.resolve({ data: { id: 'lead-1', companyName: 'Buyer Company', contactName: 'Buyer', country: 'US', status: 'new', tags: [] } });
      if (url === '/leads/lead-1/timeline') return Promise.resolve({ data: { data: [] } });
      if (url === '/tags') return Promise.resolve({ data: [] });
      if (url === '/communications/conversations') return Promise.resolve({ data: { data: [] } });
      if (url === '/quotes/lead/lead-1') return Promise.resolve({ data: [] });
      if (url === '/opportunities') return Promise.resolve({ data: { data: [{ id: 'opp-1', leadId: 'lead-1', name: 'Retail launch', description: null, stage: 'qualified', amount: '3000.00', currency: 'USD', probability: 40, expectedCloseDate: null, nextStep: null, wonAt: null, lostAt: null, lostReason: null, version: 1, createdAt: '2026-08-01T00:00:00.000Z', updatedAt: '2026-08-01T00:00:00.000Z' }], meta: { page: 1, limit: 100, total: 1, totalPages: 1 } } });
      return Promise.resolve({ data: [] });
    });
  });

  it('loads and renders multiple real opportunities for the customer', async () => {
    const user = userEvent.setup();
    render(<CustomerDetailPage />);
    await waitFor(() => expect(screen.getByRole('button', { name: '商机&交易' })).toBeInTheDocument());
    await user.click(screen.getByRole('button', { name: '商机&交易' }));
    expect(await screen.findByText('Retail launch')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: '+ 新建商机' })).toHaveAttribute('href', '/opportunities/new?leadId=lead-1');
    expect(apiGet).toHaveBeenCalledWith('/opportunities', { params: { leadId: 'lead-1', page: 1, limit: 100 } });
  });
});
