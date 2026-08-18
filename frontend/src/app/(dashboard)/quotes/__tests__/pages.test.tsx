import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import QuotesPage from '../page';
import QuoteDetailPage from '../[id]/client-page';
import type { QuoteDetail, QuoteListResponse } from '@/types/quote';

const apiGet = vi.fn();
const apiPost = vi.fn();

vi.mock('@/lib/api', () => ({
  default: {
    get: (...args: unknown[]) => (globalThis as { __quoteApiGet?: typeof apiGet }).__quoteApiGet?.(...args),
    post: (...args: unknown[]) => (globalThis as { __quoteApiPost?: typeof apiPost }).__quoteApiPost?.(...args),
  },
}));

vi.mock('next/link', () => ({
  default: ({ href, children, ...props }: { href: string; children: React.ReactNode }) => <a href={href} {...props}>{children}</a>,
}));

vi.mock('@/lib/use-runtime-route-param', () => ({
  useRuntimeRouteParam: () => 'quote-1',
}));

const listFixture: QuoteListResponse = {
  data: [{
    id: 'quote-1',
    referenceNo: 'QT-2026-001',
    type: 'quote',
    status: 'draft',
    leadId: 'lead-1',
    opportunity: { id: 'opp-1', name: 'Retail launch', stage: 'proposal', amount: '500.00', currency: 'USD', probability: 60, version: 2 },
    currency: 'USD',
    totalAmount: '129.45',
    itemCount: 1,
    createdAt: '2026-08-01T10:00:00.000Z',
    updatedAt: '2026-08-02T10:00:00.000Z',
    lead: { id: 'lead-1', companyName: 'Buyer Company', contactName: 'Buyer', country: 'US' },
  }],
  meta: { page: 1, limit: 100, total: 1, totalPages: 1 },
};

const detailFixture: QuoteDetail = {
  ...listFixture.data[0],
  conversationId: 'conversation-1',
  tradeTerms: 'FOB Shenzhen',
  paymentTerms: 'T/T 30%',
  deliveryTime: '20 days',
  sampleFee: '5.00',
  moldFee: '3.00',
  discount: '2.00',
  taxRate: '0',
  subtotal: '123.45',
  taxAmount: '0',
  validUntil: '2026-08-31T00:00:00.000Z',
  lineItems: [{
    id: 'line-1',
    productCode: 'BAG-001',
    productName: 'Paper Bag',
    material: 'Kraft',
    size: '30x40cm',
    thickness: '180gsm',
    color: null,
    printing: null,
    quantity: 1000,
    unit: 'pcs',
    unitPrice: '0.1234',
    totalPrice: '123.40',
    productSpecId: 'spec-1',
    catalogItemId: 'catalog-1',
    notes: null,
  }],
};

describe('Quote structured pages', () => {
  beforeEach(() => {
    (globalThis as { __quoteApiGet?: typeof apiGet }).__quoteApiGet = apiGet;
    (globalThis as { __quoteApiPost?: typeof apiPost }).__quoteApiPost = apiPost;
    apiGet.mockReset();
    apiPost.mockReset();
  });

  afterEach(() => {
    delete (globalThis as { __quoteApiGet?: typeof apiGet }).__quoteApiGet;
    delete (globalThis as { __quoteApiPost?: typeof apiPost }).__quoteApiPost;
  });

  it('renders structured list fields without outputContent', async () => {
    apiGet.mockResolvedValueOnce({ data: listFixture });

    render(<QuotesPage />);

    expect(await screen.findByText('QT-2026-001')).toBeInTheDocument();
    expect(screen.getByText(/Buyer Company/)).toBeInTheDocument();
    expect(screen.getByText(/Retail launch/)).toBeInTheDocument();
    expect(screen.getByText(/USD 129\.45/)).toBeInTheDocument();
    expect(screen.getByText(/1 项产品/)).toBeInTheDocument();
    expect(screen.getAllByText('草稿').length).toBeGreaterThan(0);
    expect(screen.queryByText('outputContent')).not.toBeInTheDocument();
    expect(apiGet).toHaveBeenCalledWith('/quotes', { params: { limit: 100 } });
  });

  it('renders structured detail fields without outputContent', async () => {
    apiGet.mockResolvedValueOnce({ data: detailFixture });

    render(<QuoteDetailPage />);

    await waitFor(() => expect(screen.getByText('QT-2026-001')).toBeInTheDocument());
    expect(screen.getAllByText(/Buyer Company/).length).toBeGreaterThan(0);
    expect(screen.getByText(/Buyer · US/)).toBeInTheDocument();
    expect(screen.getByText(/USD 129\.45/)).toBeInTheDocument();
    expect(screen.getByText('FOB Shenzhen')).toBeInTheDocument();
    expect(screen.getByText('T/T 30%')).toBeInTheDocument();
    expect(screen.getByText('20 days')).toBeInTheDocument();
    expect(screen.getByText(/Paper Bag × 1000/)).toBeInTheDocument();
    expect(screen.getByText(/USD 123\.40/)).toBeInTheDocument();
    expect(screen.queryByText('outputContent')).not.toBeInTheDocument();
    expect(apiGet).toHaveBeenCalledWith('/quotes/quote-1');
    expect(screen.queryByRole('button', { name: '转为订单' })).not.toBeInTheDocument();
  });

  it('converts a sent quote through the unique convert endpoint', async () => {
    const user = userEvent.setup();
    apiGet.mockResolvedValueOnce({ data: { ...detailFixture, status: 'sent' } });
    apiPost.mockResolvedValueOnce({ data: {
      id: 'order-1',
      orderNo: 'ORD-20260803-ABCDEF',
      quoteId: 'quote-1',
      leadId: 'lead-1',
      stage: 'won',
      currency: 'USD',
      totalAmount: '129.45',
      paidAmount: '0',
      createdAt: '2026-08-03T10:00:00.000Z',
      updatedAt: '2026-08-03T10:00:00.000Z',
    } });

    render(<QuoteDetailPage />);

    const convertButton = await screen.findByRole('button', { name: '转为订单' });
    await user.click(convertButton);

    await waitFor(() => expect(apiPost).toHaveBeenCalledWith('/quotes/quote-1/convert-to-order'));
    expect(await screen.findByRole('link', { name: '查看订单' })).toHaveAttribute('href', '/orders/order-1');
  });
});
