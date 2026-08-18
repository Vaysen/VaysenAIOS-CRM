import { QuotesService } from './quotes.service';

const user = {
  id: 'user-a',
  activeCompanyId: 'tenant-a',
  activeCompany: { id: 'tenant-a', role: 'sales_user' },
  companies: [{ id: 'tenant-a', role: 'sales_user' }],
};

describe('Quote convert-to-order response contract', () => {
  it('returns a JSON-safe whitelist and keeps business identifiers out of logs', async () => {
    const createdAt = new Date('2026-08-03T10:00:00.000Z');
    const updatedAt = new Date('2026-08-03T10:00:00.000Z');
    const tx: any = {
      quote: {
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        findFirst: jest.fn().mockResolvedValue({
          id: 'quote-1',
          companyId: 'tenant-a',
          leadId: null,
          conversationId: null,
          referenceNo: 'QT-2026-001',
          currency: 'USD',
          totalAmount: '42.00',
          tradeTerms: 'FOB',
        }),
      },
      order: {
        findFirst: jest.fn().mockResolvedValue(null),
        create: jest.fn().mockResolvedValue({
          id: 'order-1',
          companyId: 'tenant-a',
          orderNo: 'ORD-20260803-ABCDEF',
          leadId: null,
          quoteId: 'quote-1',
          assignedUserId: 'user-a',
          stage: 'won',
          currency: 'USD',
          totalAmount: '42.00',
          paidAmount: '0.00',
          notes: 'Converted from quote QT-2026-001',
          stageHistory: [{ stage: 'won' }],
          createdAt,
          updatedAt,
        }),
      },
      lead: { findFirst: jest.fn() },
      conversation: { findFirst: jest.fn() },
      leadActivity: { create: jest.fn() },
    };
    const prisma: any = { $transaction: jest.fn((callback: any) => callback(tx)) };
    const service = new QuotesService(prisma);
    const logger = (service as any).logger;
    logger.log = jest.fn();

    const result = await service.convertToOrder('quote-1', user);

    expect(result).toEqual({
      id: 'order-1',
      orderNo: 'ORD-20260803-ABCDEF',
      leadId: null,
      quoteId: 'quote-1',
      stage: 'won',
      currency: 'USD',
      totalAmount: '42.00',
      paidAmount: '0.00',
      createdAt: '2026-08-03T10:00:00.000Z',
      updatedAt: '2026-08-03T10:00:00.000Z',
    });
    expect(result).not.toHaveProperty('companyId');
    expect(result).not.toHaveProperty('assignedUserId');
    expect(result).not.toHaveProperty('notes');
    expect(result).not.toHaveProperty('stageHistory');
    expect(JSON.stringify(logger.log.mock.calls)).not.toContain('ORD-20260803-ABCDEF');
    expect(JSON.stringify(logger.log.mock.calls)).not.toContain('quote-1');
  });
});
