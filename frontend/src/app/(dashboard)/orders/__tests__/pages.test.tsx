import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import OrdersPage from '../page';
import OrderDetailPage from '../[id]/client-page';
import type { OrderDetail, OrderHistoryResponse, OrderListResponse } from '@/types/order';

const apiGet = vi.fn();
const apiPatch = vi.fn();

vi.mock('@/lib/api', () => ({
  default: {
    get: (...args: unknown[]) => (globalThis as { __orderApiGet?: typeof apiGet }).__orderApiGet?.(...args),
    patch: (...args: unknown[]) => (globalThis as { __orderApiPatch?: typeof apiPatch }).__orderApiPatch?.(...args),
  },
}));

vi.mock('next/link', () => ({
  default: ({ href, children, ...props }: { href: string; children: React.ReactNode }) => <a href={href} {...props}>{children}</a>,
}));

vi.mock('@/lib/use-runtime-route-param', () => ({
  useRuntimeRouteParam: () => 'order-1',
}));

const listFixture: OrderListResponse = {
  data: [{
    id: 'order-1',
    orderNo: 'ORD-20260803-ABCDEF',
    leadId: 'lead-1',
    opportunity: { id: 'opp-1', name: 'Retail launch', stage: 'proposal', amount: '500.00', currency: 'USD', probability: 60, version: 2 },
    quoteId: 'quote-1',
    stage: 'shipping',
    currency: 'USD',
    totalAmount: '121.45',
    paidAmount: '20.00',
    createdAt: '2026-08-01T10:00:00.000Z',
    updatedAt: '2026-08-03T10:00:00.000Z',
    lead: { id: 'lead-1', companyName: 'Buyer Company', contactName: 'Buyer', country: 'US' },
    quote: { id: 'quote-1', referenceNo: 'QT-2026-001', type: 'quote', status: 'accepted', currency: 'USD', totalAmount: '121.45', itemCount: 2 },
  }],
  meta: { page: 1, limit: 100, total: 1, totalPages: 1 },
};

const detailFixture: OrderDetail = {
  ...listFixture.data[0],
  stage: 'production',
  deliveryDate: '2026-08-20T00:00:00.000Z',
  shippingTerms: 'FOB Shenzhen',
  trackingNo: 'TRACK-1',
  stageHistory: [{ stage: 'won', changedAt: '2026-08-01T10:00:00.000Z' }],
};

const historyFixture: OrderHistoryResponse = {
  orders: [listFixture.data[0]],
  stats: {
    totalOrders: 1,
    totalAmount: 121.45,
    paidAmount: 20,
    outstandingAmount: 101.45,
    completedCount: 0,
    activeCount: 1,
    stageDistribution: { shipping: 1 },
  },
};

describe('Order structured pages', () => {
  beforeEach(() => {
    (globalThis as { __orderApiGet?: typeof apiGet }).__orderApiGet = apiGet;
    (globalThis as { __orderApiPatch?: typeof apiPatch }).__orderApiPatch = apiPatch;
    apiGet.mockReset();
    apiPatch.mockReset();
  });

  afterEach(() => {
    delete (globalThis as { __orderApiGet?: typeof apiGet }).__orderApiGet;
    delete (globalThis as { __orderApiPatch?: typeof apiPatch }).__orderApiPatch;
  });

  it('renders structured order list fields without outputContent', async () => {
    apiGet.mockResolvedValueOnce({ data: listFixture });

    render(<OrdersPage />);

    expect(await screen.findByText('ORD-20260803-ABCDEF')).toBeInTheDocument();
    expect(screen.getByText(/Buyer Company/)).toBeInTheDocument();
    expect(screen.getByText(/Retail launch/)).toBeInTheDocument();
    expect(screen.getByText(/USD 121\.45/)).toBeInTheDocument();
    expect(screen.getAllByText('出货').length).toBeGreaterThan(0);
    expect(screen.queryByText('outputContent')).not.toBeInTheDocument();
    expect(apiGet).toHaveBeenCalledWith('/orders', { params: { limit: 100, stage: undefined } });
  });

  it('renders structured detail and uses the server stage update response', async () => {
    const user = userEvent.setup();
    apiGet.mockImplementation((url: string) => Promise.resolve({ data: url === '/orders/order-1' ? detailFixture : historyFixture }));
    apiPatch.mockResolvedValueOnce({ data: { ...detailFixture, stage: 'shipping' } });

    render(<OrderDetailPage />);

    expect(await screen.findByText('ORD-20260803-ABCDEF')).toBeInTheDocument();
    expect(screen.getAllByText(/Buyer Company/).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/USD 121\.45/).length).toBeGreaterThan(0);
    expect(screen.getByText(/累计金额/)).toBeInTheDocument();
    expect(screen.queryByText('常购产品')).not.toBeInTheDocument();
    expect(screen.queryByText('outputContent')).not.toBeInTheDocument();

    await user.selectOptions(screen.getByRole('combobox'), 'shipping');

    await waitFor(() => expect(apiPatch).toHaveBeenCalledWith('/orders/order-1/stage', { stage: 'shipping' }));
  });
});
