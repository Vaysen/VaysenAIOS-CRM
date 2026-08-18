import { OrdersService } from './orders.service';

const user = (role = 'sales_user', id = 'user-a') => ({
  id,
  activeCompanyId: 'tenant-a',
  activeCompany: { id: 'tenant-a', role },
  companies: [{ id: 'tenant-a', role }],
});

const orderFixture = (overrides: Record<string, unknown> = {}) => ({
  id: 'order-1',
  companyId: 'tenant-a',
  orderNo: 'ORD-20260803-ABCDEF',
  leadId: 'lead-1',
  quoteId: 'quote-1',
  assignedUserId: 'user-a',
  stage: 'shipping',
  currency: 'USD',
  totalAmount: '121.45',
  paidAmount: '20.00',
  deliveryDate: new Date('2026-08-20T00:00:00.000Z'),
  shippingTerms: 'FOB Shenzhen',
  trackingNo: 'TRACK-1',
  notes: 'Internal order note',
  stageHistory: [
    { stage: 'won', changedAt: '2026-08-01T10:00:00.000Z', changedBy: 'user-a', note: 'Created' },
    { stage: 'shipping', fromStage: 'production', changedAt: '2026-08-03T10:00:00.000Z', changedBy: 'user-a' },
    { stage: 'invalid', changedAt: 'not-a-date', changedBy: 'user-a' },
  ],
  createdAt: new Date('2026-08-01T10:00:00.000Z'),
  updatedAt: new Date('2026-08-03T10:00:00.000Z'),
  lead: { id: 'lead-1', companyName: 'Buyer Company', contactName: 'Buyer', country: 'US' },
  ...overrides,
});

const quoteSummary = {
  id: 'quote-1',
  referenceNo: 'QT-2026-001',
  type: 'quote',
  status: 'accepted',
  currency: 'USD',
  totalAmount: '121.45',
  _count: { lineItems: 2 },
};

describe('Order structured read contracts', () => {
  it('projects list fields and performs an explicit scoped quote summary lookup', async () => {
    const prisma: any = {
      order: {
        findMany: jest.fn().mockResolvedValue([orderFixture()]),
        count: jest.fn().mockResolvedValue(1),
      },
      quote: { findMany: jest.fn().mockResolvedValue([quoteSummary]) },
    };
    const service = new OrdersService(prisma);

    const result = await service.findAll(user(), { page: 1, limit: 20 });

    expect(result.data).toEqual([expect.objectContaining({
      id: 'order-1',
      orderNo: 'ORD-20260803-ABCDEF',
      stage: 'shipping',
      lead: { id: 'lead-1', companyName: 'Buyer Company', contactName: 'Buyer', country: 'US' },
      totalAmount: '121.45',
      quote: expect.objectContaining({ referenceNo: 'QT-2026-001', itemCount: 2 }),
    })]);
    expect(result.data[0]).not.toHaveProperty('outputContent');
    expect(result.data[0]).not.toHaveProperty('notes');
    expect(result.data[0]).not.toHaveProperty('companyId');
    expect(result.data[0]).not.toHaveProperty('assignedUserId');
    expect(prisma.quote.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ companyId: 'tenant-a', assignedUserId: 'user-a' }),
    }));
  });

  it('projects detail fields with JSON-safe dates and sanitized stage history', async () => {
    const prisma: any = {
      order: { findFirst: jest.fn().mockResolvedValue(orderFixture()) },
      quote: { findMany: jest.fn().mockResolvedValue([quoteSummary]) },
    };
    const service = new OrdersService(prisma);

    const result = await service.findOne('order-1', user());

    expect(result).toEqual(expect.objectContaining({
      orderNo: 'ORD-20260803-ABCDEF',
      stage: 'shipping',
      totalAmount: '121.45',
      deliveryDate: '2026-08-20T00:00:00.000Z',
      stageHistory: [
        { stage: 'won', changedAt: '2026-08-01T10:00:00.000Z', note: 'Created' },
        { stage: 'shipping', fromStage: 'production', changedAt: '2026-08-03T10:00:00.000Z' },
      ],
    }));
    expect(result.stageHistory[0]).not.toHaveProperty('changedBy');
    expect(result).not.toHaveProperty('notes');
    expect(result).not.toHaveProperty('outputContent');
  });

  it('returns only real customer history statistics and no fabricated topProducts', async () => {
    const prisma: any = {
      lead: { findFirst: jest.fn().mockResolvedValue({ id: 'lead-1' }) },
      order: { findMany: jest.fn().mockResolvedValue([orderFixture()]) },
      quote: { findMany: jest.fn().mockResolvedValue([]) },
    };
    const service = new OrdersService(prisma);

    const result = await service.getCustomerOrderHistory('lead-1', user());

    expect(result.stats).toEqual({
      totalOrders: 1,
      totalAmount: 121.45,
      paidAmount: 20,
      outstandingAmount: 101.45,
      completedCount: 0,
      activeCount: 1,
      stageDistribution: { shipping: 1 },
    });
    expect(result).not.toHaveProperty('topProducts');
    expect(result.stats).not.toHaveProperty('topProducts');
    expect(result.orders[0]).not.toHaveProperty('notes');
    expect(result.orders[0]).not.toHaveProperty('stageHistory');
  });

  it('does not write raw order identifiers to stage-update logs', async () => {
    const order = orderFixture({ stage: 'production' });
    const prisma: any = {
      order: {
        findFirst: jest.fn().mockResolvedValue(order),
        update: jest.fn().mockResolvedValue({ ...order, stage: 'shipping' }),
      },
      quote: { findMany: jest.fn().mockResolvedValue([]) },
      leadActivity: { create: jest.fn().mockResolvedValue({}) },
    };
    const service = new OrdersService(prisma);
    const logger = (service as any).logger;
    logger.log = jest.fn();

    await service.updateStage('order-1', 'shipping', user());

    expect(JSON.stringify(logger.log.mock.calls)).not.toContain('ORD-20260803-ABCDEF');
    expect(JSON.stringify(logger.log.mock.calls)).toContain('order.stage_updated');
  });
});
