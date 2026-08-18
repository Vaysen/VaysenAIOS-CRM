import { BadRequestException, NotFoundException } from '@nestjs/common';
import { OrdersService } from './orders.service';

const user = (role = 'sales_user', id = 'sales-a') => ({
  id,
  activeCompanyId: 'tenant-a',
  activeCompany: { id: 'tenant-a', role },
  companies: [{ id: 'tenant-a', role }],
});

const opportunity = (overrides: Record<string, unknown> = {}) => ({
  id: 'opp-a', companyId: 'tenant-a', ownerUserId: 'sales-a', leadId: 'lead-a', ...overrides,
});

describe('Order Opportunity association contract', () => {
  it('creates a direct order from opportunity-only input and derives leadId', async () => {
    let orderData: any;
    const tx: any = {
      userCompanyRelation: { findFirst: jest.fn().mockResolvedValue({ id: 'membership-a' }) },
      opportunity: { findFirst: jest.fn().mockResolvedValue(opportunity()) },
      lead: { findFirst: jest.fn().mockResolvedValue({ id: 'lead-a' }) },
      order: {
        create: jest.fn(({ data }: any) => { orderData = data; return Promise.resolve({ id: 'order-a', ...data, createdAt: new Date(), updatedAt: new Date() }); }),
      },
      leadActivity: { create: jest.fn() },
    };
    const prisma: any = { $transaction: jest.fn((callback: any) => callback(tx)) };
    const service = new OrdersService(prisma);

    await service.create({ opportunityId: 'opp-a', totalAmount: 10 }, user());

    expect(orderData).toEqual(expect.objectContaining({ leadId: 'lead-a', opportunityId: 'opp-a', quoteId: null }));
    expect(tx.opportunity.findFirst).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ companyId: 'tenant-a', deletedAt: null, ownerUserId: 'sales-a' }),
    }));
  });

  it('rejects a mismatched lead, foreign owner, or soft-deleted opportunity', async () => {
    const tx: any = {
      userCompanyRelation: { findFirst: jest.fn().mockResolvedValue({ id: 'membership-a' }) },
      opportunity: { findFirst: jest.fn().mockResolvedValue(opportunity({ leadId: 'lead-other' })) },
      lead: { findFirst: jest.fn() },
      order: { create: jest.fn() },
    };
    const prisma: any = { $transaction: jest.fn((callback: any) => callback(tx)) };
    const service = new OrdersService(prisma);

    await expect(service.create({ opportunityId: 'opp-a', leadId: 'lead-a' }, user())).rejects.toBeInstanceOf(BadRequestException);
    expect(tx.order.create).not.toHaveBeenCalled();

    tx.opportunity.findFirst.mockResolvedValue(null);
    await expect(service.create({ opportunityId: 'foreign-or-deleted' }, user())).rejects.toBeInstanceOf(NotFoundException);
  });

  it.each(['deleted lead', 'lead owner changed'])(
    'rejects opportunity-only order when the resolved %s and performs no writes',
    async () => {
      const tx: any = {
        userCompanyRelation: { findFirst: jest.fn().mockResolvedValue({ id: 'membership-a' }) },
        opportunity: { findFirst: jest.fn().mockResolvedValue(opportunity()) },
        lead: { findFirst: jest.fn().mockResolvedValue(null) },
        order: { create: jest.fn() },
        leadActivity: { create: jest.fn() },
      };
      const prisma: any = { $transaction: jest.fn((callback: any) => callback(tx)) };
      const service = new OrdersService(prisma);

      await expect(service.create({ opportunityId: 'opp-a' }, user())).rejects.toBeInstanceOf(NotFoundException);
      expect(tx.lead.findFirst).toHaveBeenCalledWith(expect.objectContaining({
        where: expect.objectContaining({ id: 'lead-a', companyId: 'tenant-a', deletedAt: null, ownerUserId: 'sales-a' }),
      }));
      expect(tx.order.create).not.toHaveBeenCalled();
      expect(tx.leadActivity.create).not.toHaveBeenCalled();
    },
  );

  it('keeps order reads scoped and maps orphan or unauthorized opportunity to null', async () => {
    const order = {
      id: 'order-a', companyId: 'tenant-a', orderNo: 'ORD-1', leadId: 'lead-a', opportunityId: 'opp-a', quoteId: null,
      assignedUserId: 'sales-a', stage: 'won', currency: 'USD', totalAmount: '10.00', paidAmount: '0.00',
      deliveryDate: null, shippingTerms: null, trackingNo: null, notes: 'secret', stageHistory: [],
      createdAt: new Date('2026-08-03T00:00:00.000Z'), updatedAt: new Date('2026-08-03T00:00:00.000Z'), lead: null,
    };
    const prisma: any = {
      order: { findMany: jest.fn().mockResolvedValue([order]), count: jest.fn().mockResolvedValue(1) },
      opportunity: { findMany: jest.fn().mockResolvedValue([]) },
    };
    const service = new OrdersService(prisma);

    const result = await service.findAll(user(), { page: 1, limit: 20 });
    expect(result.data[0].opportunity).toBeNull();
    expect(result.data[0]).not.toHaveProperty('notes');
    expect(prisma.opportunity.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ companyId: 'tenant-a', deletedAt: null, ownerUserId: 'sales-a' }),
    }));
  });

  it('returns null when a same-tenant same-owner opportunity is cross-lead to the order', async () => {
    const order = {
      id: 'order-cross-lead', companyId: 'tenant-a', orderNo: 'ORD-2', leadId: 'lead-other', opportunityId: 'opp-a', quoteId: null,
      assignedUserId: 'sales-a', stage: 'won', currency: 'USD', totalAmount: '10.00', paidAmount: '0.00',
      deliveryDate: null, shippingTerms: null, trackingNo: null, notes: 'secret', stageHistory: [],
      createdAt: new Date('2026-08-03T00:00:00.000Z'), updatedAt: new Date('2026-08-03T00:00:00.000Z'), lead: null,
    };
    const prisma: any = {
      order: { findFirst: jest.fn().mockResolvedValue(order) },
      opportunity: { findMany: jest.fn().mockResolvedValue([{ id: 'opp-a', leadId: 'lead-a', name: 'Bag program', stage: 'proposal', amount: '10.00', currency: 'USD', probability: 60, version: 2, deletedAt: null }]) },
    };
    const service = new OrdersService(prisma);

    await expect(service.findOne('order-cross-lead', user())).resolves.toMatchObject({ opportunity: null });
  });

  it('keeps Lead.status out of direct order creation and logs only stable event fields', async () => {
    const tx: any = {
      userCompanyRelation: { findFirst: jest.fn().mockResolvedValue({ id: 'membership-a' }) },
      order: { create: jest.fn().mockResolvedValue({ id: 'order-a', orderNo: 'ORD-1', leadId: null, opportunityId: null, quoteId: null, stage: 'won', currency: 'USD', totalAmount: 0, paidAmount: 0, createdAt: new Date(), updatedAt: new Date(), lead: null }) },
    };
    const prisma: any = { $transaction: jest.fn((callback: any) => callback(tx)) };
    const service = new OrdersService(prisma);
    const logger = (service as any).logger;
    logger.log = jest.fn();

    await service.create({}, user());
    expect((prisma as any).lead?.update).toBeUndefined();
    expect(JSON.stringify(logger.log.mock.calls)).not.toContain('order-a');
  });
});
