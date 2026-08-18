import { BadRequestException, NotFoundException } from '@nestjs/common';
import { QuotesService } from './quotes.service';

const user = (role = 'sales_user', id = 'sales-a') => ({
  id,
  activeCompanyId: 'tenant-a',
  activeCompany: { id: 'tenant-a', role },
  companies: [{ id: 'tenant-a', role }],
});

const opportunity = (overrides: Record<string, unknown> = {}) => ({
  id: 'opp-a',
  companyId: 'tenant-a',
  ownerUserId: 'sales-a',
  leadId: 'lead-a',
  ...overrides,
});

const quoteInput = (overrides: Record<string, unknown> = {}) => ({
  lineItems: [{ productName: 'Bag', quantity: 1, unitPrice: 10 }],
  ...overrides,
});

describe('Quote Opportunity association contract', () => {
  it('keeps the legacy create path unchanged when opportunityId is omitted', async () => {
    const created = { id: 'quote-a' };
    const tx: any = {
      quote: { create: jest.fn().mockResolvedValue(created) },
      leadActivity: { create: jest.fn().mockResolvedValue({}) },
    };
    const prisma: any = {
      lead: { findFirst: jest.fn().mockResolvedValue(null) },
      $transaction: jest.fn((callback: any) => callback(tx)),
    };
    const service = new QuotesService(prisma);

    await expect(service.createQuote(quoteInput(), user())).resolves.toMatchObject({
      id: 'quote-a',
      status: 'draft',
    });
    expect(prisma.opportunity).toBeUndefined();
    expect(tx.quote.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ leadId: null, opportunityId: null }),
    }));
  });

  it('derives lead from an accessible opportunity and writes both keys atomically', async () => {
    const created = { id: 'quote-a' };
    const tx: any = {
      opportunity: { findFirst: jest.fn().mockResolvedValue(opportunity()) },
      lead: { findFirst: jest.fn().mockResolvedValue({ id: 'lead-a' }) },
      quote: { create: jest.fn().mockResolvedValue(created) },
      leadActivity: { create: jest.fn().mockResolvedValue({}) },
    };
    const prisma: any = {
      opportunity: { findFirst: jest.fn().mockResolvedValue(opportunity()) },
      lead: { findFirst: jest.fn().mockResolvedValue({ id: 'lead-a' }) },
      leadActivity: { create: jest.fn().mockResolvedValue({}) },
      $transaction: jest.fn((callback: any) => callback(tx)),
    };
    const service = new QuotesService(prisma);

    await service.createQuote(quoteInput({ opportunityId: 'opp-a' }), user());

    expect(prisma.opportunity.findFirst).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ companyId: 'tenant-a', deletedAt: null, ownerUserId: 'sales-a' }),
    }));
    expect(tx.quote.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ leadId: 'lead-a', opportunityId: 'opp-a' }),
    }));
    expect(tx.opportunity.findFirst).toHaveBeenCalled();
  });

  it('rejects a cross-lead or inaccessible opportunity before quote creation', async () => {
    const prisma: any = {
      opportunity: { findFirst: jest.fn().mockResolvedValue(opportunity({ leadId: 'lead-other' })) },
      quote: { create: jest.fn() },
    };
    const service = new QuotesService(prisma);

    await expect(service.createQuote(
      quoteInput({ leadId: 'lead-a', opportunityId: 'opp-a' }),
      user(),
    )).rejects.toBeInstanceOf(BadRequestException);
    expect(prisma.quote.create).not.toHaveBeenCalled();

    prisma.opportunity.findFirst.mockResolvedValue(null);
    await expect(service.createQuote(
      quoteInput({ opportunityId: 'deleted-or-foreign' }),
      user(),
    )).rejects.toBeInstanceOf(NotFoundException);
  });

  it('revalidates a draft rebind and allows explicit null unlink without dropping lead', async () => {
    const current = { id: 'quote-a', status: 'draft', leadId: 'lead-a', conversationId: null, opportunityId: 'opp-old', discount: 0, taxRate: 0, sampleFee: null, moldFee: null };
    const tx: any = {
      quote: {
        findFirst: jest.fn().mockResolvedValue(current),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      opportunity: { findFirst: jest.fn().mockResolvedValue(opportunity({ id: 'opp-new' })) },
      lead: { findFirst: jest.fn().mockResolvedValue({ id: 'lead-a' }) },
    };
    const prisma: any = { $transaction: jest.fn((callback: any) => callback(tx)) };
    const service = new QuotesService(prisma);

    await service.updateQuote('quote-a', { opportunityId: 'opp-new' } as any, user());
    expect(tx.quote.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ opportunityId: 'opp-new' }),
    }));

    tx.quote.updateMany.mockClear();
    await service.updateQuote('quote-a', { opportunityId: null } as any, user());
    expect(tx.quote.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ opportunityId: null }),
    }));
  });

  it('copies opportunityId during conversion and rechecks its lead boundary', async () => {
    let orderData: any;
    const tx: any = {
      quote: {
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        findFirst: jest.fn().mockResolvedValue({
          id: 'quote-a', companyId: 'tenant-a', leadId: 'lead-a', opportunityId: 'opp-a',
          conversationId: null, referenceNo: 'QT-1', currency: 'USD', totalAmount: 10, tradeTerms: 'FOB',
        }),
      },
      order: {
        findFirst: jest.fn().mockResolvedValue(null),
        create: jest.fn(({ data }: any) => { orderData = data; return Promise.resolve({ id: 'order-a', ...data }); }),
      },
      opportunity: { findFirst: jest.fn().mockResolvedValue(opportunity()) },
      lead: { findFirst: jest.fn().mockResolvedValue({ id: 'lead-a' }) },
      conversation: { findFirst: jest.fn() },
      leadActivity: { create: jest.fn() },
    };
    const prisma: any = { $transaction: jest.fn((callback: any) => callback(tx)) };
    const service = new QuotesService(prisma);

    await service.convertToOrder('quote-a', user());

    expect(orderData).toEqual(expect.objectContaining({
      leadId: 'lead-a', opportunityId: 'opp-a', quoteId: 'quote-a',
    }));
    expect(tx.opportunity.findFirst).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ companyId: 'tenant-a', deletedAt: null, ownerUserId: 'sales-a' }),
    }));
  });

  it('returns only the scoped minimal opportunity summary and null for inaccessible rows', async () => {
    const quote = {
      id: 'quote-a', companyId: 'tenant-a', assignedUserId: 'sales-a', referenceNo: 'QT-1', type: 'quote', status: 'draft',
      leadId: 'lead-a', opportunityId: 'opp-a', conversationId: null, currency: 'USD', totalAmount: '10',
      createdAt: new Date('2026-08-03T00:00:00.000Z'), updatedAt: new Date('2026-08-03T00:00:00.000Z'), lineItems: [], lead: null,
    };
    const prisma: any = {
      quote: { findMany: jest.fn().mockResolvedValue([quote]), count: jest.fn().mockResolvedValue(1) },
      opportunity: { findMany: jest.fn().mockResolvedValue([{ id: 'opp-a', leadId: 'lead-a', name: 'Bag program', stage: 'proposal', amount: '10.00', currency: 'USD', probability: 60, version: 2, deletedAt: null }]) },
    };
    const service = new QuotesService(prisma);

    const result = await service.findAll(user(), { page: 1, limit: 20 });
    expect(result.data[0].opportunity).toEqual({
      id: 'opp-a', name: 'Bag program', stage: 'proposal', amount: '10.00', currency: 'USD', probability: 60, version: 2,
    });
    expect(result.data[0].opportunity).not.toHaveProperty('companyId');
    expect(result.data[0].opportunity).not.toHaveProperty('ownerUserId');
    expect(prisma.opportunity.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ companyId: 'tenant-a', deletedAt: null, ownerUserId: 'sales-a' }),
    }));

    prisma.opportunity.findMany.mockResolvedValue([]);
    await expect(service.findAll(user(), { page: 1, limit: 20 })).resolves.toMatchObject({ data: [{ opportunity: null }] });
  });

  it('returns null when a same-tenant same-owner opportunity is cross-lead to the quote', async () => {
    const quote = {
      id: 'quote-cross-lead', companyId: 'tenant-a', assignedUserId: 'sales-a', referenceNo: 'QT-2', type: 'quote', status: 'draft',
      leadId: 'lead-other', opportunityId: 'opp-a', conversationId: null, currency: 'USD', totalAmount: '10',
      createdAt: new Date('2026-08-03T00:00:00.000Z'), updatedAt: new Date('2026-08-03T00:00:00.000Z'), lineItems: [], lead: null,
    };
    const prisma: any = {
      quote: { findFirst: jest.fn().mockResolvedValue(quote) },
      opportunity: { findMany: jest.fn().mockResolvedValue([{ id: 'opp-a', leadId: 'lead-a', name: 'Bag program', stage: 'proposal', amount: '10.00', currency: 'USD', probability: 60, version: 2, deletedAt: null }]) },
    };
    const service = new QuotesService(prisma);

    await expect(service.findOne('quote-cross-lead', user())).resolves.toMatchObject({ opportunity: null });
  });

  it('does not expose Lead.status writes or raw association ids in service logs', async () => {
    const tx: any = {
      quote: {
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        findFirst: jest.fn().mockResolvedValue({ id: 'quote-a', companyId: 'tenant-a', leadId: null, opportunityId: null, conversationId: null, referenceNo: 'QT-1', currency: 'USD', totalAmount: 1, tradeTerms: null }),
      },
      order: { findFirst: jest.fn().mockResolvedValue(null), create: jest.fn().mockResolvedValue({ id: 'order-a', orderNo: 'ORD-1', leadId: null, quoteId: 'quote-a', stage: 'won', currency: 'USD', totalAmount: 1, paidAmount: 0 }) },
      leadActivity: { create: jest.fn() },
    };
    const prisma: any = { $transaction: jest.fn((callback: any) => callback(tx)) };
    const service = new QuotesService(prisma);
    const logger = (service as any).logger;
    logger.log = jest.fn();
    await service.convertToOrder('quote-a', user());
    expect((prisma as any).lead?.update).toBeUndefined();
    expect(JSON.stringify(logger.log.mock.calls)).not.toContain('quote-a');
  });
});
