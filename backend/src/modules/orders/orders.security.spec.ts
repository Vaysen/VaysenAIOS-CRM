import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
  ValidationPipe,
} from '@nestjs/common';
import { OrdersService } from './orders.service';
import { CreateOrderDto } from './dto/create-order.dto';
import { QuotesService } from '../quotes/quotes.service';

const tenantUser = (role: string, id = 'user-a') => ({
  id,
  activeCompanyId: 'tenant-a',
  activeCompany: { id: 'tenant-a', role },
  companies: [{ id: 'tenant-a', role }],
});

describe('OrdersService write isolation', () => {
  it.each([
    ['draft', 'draft-quote'],
    ['sent', 'sent-quote'],
    ['accepted', 'accepted-quote'],
    ['foreign tenant', 'foreign-quote'],
    ['mismatched lead', 'mismatched-quote'],
    ['duplicate attempt', 'already-linked-quote'],
  ])('rejects a manual %s quote link without looking it up', async (
    _scenario,
    quoteId,
  ) => {
    const prisma: any = {
      quote: { findFirst: jest.fn() },
      order: { create: jest.fn() },
      $transaction: jest.fn(),
    };
    const service = new OrdersService(prisma);

    await expect(service.create(
      {
        quoteId,
        currency: 'EUR',
        totalAmount: 1,
      },
      tenantUser('sales_user'),
    )).rejects.toBeInstanceOf(ConflictException);
    expect(prisma.quote.findFirst).not.toHaveBeenCalled();
    expect(prisma.order.create).not.toHaveBeenCalled();
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it.each([
    ['negative total', { totalAmount: -1 }],
    ['negative paid', { paidAmount: -1 }],
    ['NaN total', { totalAmount: Number.NaN }],
    ['infinite total', { totalAmount: Number.POSITIVE_INFINITY }],
    ['invalid currency', { currency: 'USDX' }],
    ['lowercase currency', { currency: 'usd' }],
    ['invalid public stage', { stage: 'draft' }],
    ['total with three decimal places', { totalAmount: 1.001 }],
    ['paid amount with three decimal places', { paidAmount: 0.001 }],
    ['nonexistent delivery date', { deliveryDate: '2026-02-30' }],
    ['unknown field', { extraField: 'smuggled' }],
  ])('rejects %s through the runtime CreateOrderDto', async (
    _scenario,
    payload,
  ) => {
    const pipe = new ValidationPipe({
      transform: true,
      whitelist: true,
      forbidNonWhitelisted: true,
    });

    await expect(pipe.transform(payload, {
      type: 'body',
      metatype: CreateOrderDto,
      data: '',
    })).rejects.toBeInstanceOf(BadRequestException);
  });

  it('accepts the exact Decimal(12,2) monetary boundary', async () => {
    const pipe = new ValidationPipe({
      transform: true,
      whitelist: true,
      forbidNonWhitelisted: true,
    });

    await expect(pipe.transform({
      totalAmount: 9_999_999_999.99,
      paidAmount: 9_999_999_999.99,
      deliveryDate: '2026-02-28',
    }, {
      type: 'body',
      metatype: CreateOrderDto,
      data: '',
    })).resolves.toEqual(expect.objectContaining({
      totalAmount: 9_999_999_999.99,
      paidAmount: 9_999_999_999.99,
      deliveryDate: '2026-02-28',
    }));
  });

  it('rejects paid amount above total before database access', async () => {
    const prisma: any = { $transaction: jest.fn() };
    const service = new OrdersService(prisma);

    await expect(service.create(
      { totalAmount: 10, paidAmount: 10.01 },
      tenantUser('sales_user'),
    )).rejects.toBeInstanceOf(ConflictException);
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('creates a normal quote-free order and timeline in one transaction', async () => {
    const tx: any = {
      userCompanyRelation: {
        findFirst: jest.fn().mockResolvedValue({ id: 'membership-a' }),
      },
      lead: {
        findFirst: jest.fn().mockResolvedValue({ id: 'lead-a' }),
      },
      order: {
        create: jest.fn(({ data }: any) => Promise.resolve({
          id: 'order-a',
          orderNo: data.orderNo,
          ...data,
          createdAt: new Date('2026-08-03T10:00:00.000Z'),
          updatedAt: new Date('2026-08-03T10:00:00.000Z'),
        })),
      },
      leadActivity: { create: jest.fn().mockResolvedValue({}) },
    };
    const prisma: any = {
      $transaction: jest.fn((callback: any) => callback(tx)),
    };
    const service = new OrdersService(prisma);

    const result = await service.create(
      {
        leadId: 'lead-a',
        currency: 'EUR',
        totalAmount: 100,
        paidAmount: 25,
        notes: 'INTERNAL-ORDER-NOTE',
      },
      tenantUser('sales_user'),
    );
    expect(result).toEqual(expect.objectContaining({
      id: 'order-a',
      quoteId: null,
      currency: 'EUR',
      totalAmount: '100',
      paidAmount: '25',
      deliveryDate: null,
      shippingTerms: null,
      trackingNo: null,
      stageHistory: [expect.objectContaining({
        stage: 'won',
        note: 'Order created',
      })],
    }));
    expect(result).not.toHaveProperty('companyId');
    expect(result).not.toHaveProperty('assignedUserId');
    expect(result).not.toHaveProperty('notes');
    expect(result.stageHistory[0]).not.toHaveProperty('changedBy');
    expect(prisma.$transaction).toHaveBeenCalledWith(
      expect.any(Function),
      { isolationLevel: 'Serializable' },
    );
    expect(tx.order.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        companyId: 'tenant-a',
        leadId: 'lead-a',
        quoteId: null,
        assignedUserId: 'user-a',
      }),
    }));
    expect(tx.leadActivity.create).toHaveBeenCalledTimes(1);
  });

  it('retries an order-number collision with a fresh high-entropy suffix and no orphan activity', async () => {
    const attemptedOrderNos: string[] = [];
    let committedActivities = 0;
    let transactionAttempt = 0;
    const prisma: any = {
      $transaction: jest.fn(async (callback: any) => {
        const attempt = transactionAttempt++;
        let localActivities = 0;
        const tx: any = {
          userCompanyRelation: {
            findFirst: jest.fn().mockResolvedValue({ id: 'membership-a' }),
          },
          lead: { findFirst: jest.fn().mockResolvedValue({ id: 'lead-a' }) },
          order: {
            create: jest.fn(({ data }: any) => {
              attemptedOrderNos.push(data.orderNo);
              if (attempt === 0) {
                return Promise.reject({
                  code: 'P2002',
                  meta: { target: ['orderNo'] },
                });
              }
              return Promise.resolve({
                id: 'order-a',
                ...data,
                createdAt: new Date('2026-08-03T10:00:00.000Z'),
                updatedAt: new Date('2026-08-03T10:00:00.000Z'),
              });
            }),
          },
          leadActivity: {
            create: jest.fn(() => {
              localActivities += 1;
              return Promise.resolve({});
            }),
          },
        };
        const result = await callback(tx);
        committedActivities += localActivities;
        return result;
      }),
    };
    const service = new OrdersService(prisma);

    await expect(service.create(
      { leadId: 'lead-a', totalAmount: 10 },
      tenantUser('sales_user'),
    )).resolves.toEqual(expect.objectContaining({ id: 'order-a' }));

    expect(prisma.$transaction).toHaveBeenCalledTimes(2);
    expect(attemptedOrderNos).toHaveLength(2);
    expect(new Set(attemptedOrderNos).size).toBe(2);
    for (const orderNo of attemptedOrderNos) {
      expect(orderNo).toMatch(/^ORD-\d{8}-[A-F0-9]{32}$/);
      expect(orderNo).toHaveLength(45);
    }
    expect(committedActivities).toBe(1);
  });

  it('maps exhausted order-number collisions to a conflict', async () => {
    const prisma: any = {
      $transaction: jest.fn().mockRejectedValue({
        code: 'P2002',
        meta: { target: ['orderNo'] },
      }),
    };
    const service = new OrdersService(prisma);

    await expect(service.create(
      { totalAmount: 10 },
      tenantUser('sales_user'),
    )).rejects.toMatchObject({
      message: 'Could not allocate a unique order number; retry',
    });
    expect(prisma.$transaction).toHaveBeenCalledTimes(3);
  });

  it('maps create serialization failures to conflict', async () => {
    const prisma: any = {
      $transaction: jest.fn().mockRejectedValue({ code: 'P2034' }),
    };
    const service = new OrdersService(prisma);

    await expect(service.create(
      { totalAmount: 10 },
      tenantUser('sales_user'),
    )).rejects.toBeInstanceOf(ConflictException);
  });

  it('does not let a viewer create an order', async () => {
    const prisma: any = {
      userCompanyRelation: { findFirst: jest.fn() },
      order: { create: jest.fn() },
    };
    const service = new OrdersService(prisma);

    await expect(service.create({}, tenantUser('viewer')))
      .rejects.toBeInstanceOf(ForbiddenException);
    expect(prisma.userCompanyRelation.findFirst).not.toHaveBeenCalled();
    expect(prisma.order.create).not.toHaveBeenCalled();
  });

  it('does not allow a cross-tenant assignee on order creation', async () => {
    const tx: any = {
      userCompanyRelation: {
        findFirst: jest.fn().mockResolvedValue(null),
      },
      order: { create: jest.fn() },
    };
    const prisma: any = {
      $transaction: jest.fn((callback: any) => callback(tx)),
    };
    const service = new OrdersService(prisma);

    await expect(service.create(
      { assignedUserId: 'tenant-b-user' },
      tenantUser('company_admin', 'admin-a'),
    )).rejects.toBeInstanceOf(NotFoundException);
    expect(tx.userCompanyRelation.findFirst).toHaveBeenCalledWith({
      where: {
        userId: 'tenant-b-user',
        companyId: 'tenant-a',
        isActive: true,
        user: { isActive: true, deletedAt: null },
      },
      select: { id: true },
    });
    expect(tx.order.create).not.toHaveBeenCalled();
  });

  it('does not let a non-admin update another owner order stage', async () => {
    const prisma: any = {
      order: {
        findFirst: jest.fn().mockResolvedValue(null),
        update: jest.fn(),
      },
    };
    const service = new OrdersService(prisma);

    await expect(service.updateStage(
      'other-user-order',
      'production',
      tenantUser('sales_manager', 'manager-a'),
    )).rejects.toBeInstanceOf(NotFoundException);
    expect(prisma.order.findFirst).toHaveBeenCalledWith({
      where: {
        id: 'other-user-order',
        companyId: 'tenant-a',
        assignedUserId: 'manager-a',
      },
    });
    expect(prisma.order.update).not.toHaveBeenCalled();
  });

  it('does not create an order for another salesperson lead', async () => {
    const tx: any = {
      userCompanyRelation: {
        findFirst: jest.fn().mockResolvedValue({ id: 'membership-a' }),
      },
      lead: { findFirst: jest.fn().mockResolvedValue(null) },
      order: { create: jest.fn() },
    };
    const prisma: any = {
      $transaction: jest.fn((callback: any) => callback(tx)),
    };
    const service = new OrdersService(prisma);

    await expect(service.create(
      { leadId: 'other-sales-lead' },
      tenantUser('sales_user'),
    )).rejects.toBeInstanceOf(NotFoundException);
    expect(tx.lead.findFirst).toHaveBeenCalledWith({
      where: {
        id: 'other-sales-lead',
        companyId: 'tenant-a',
        deletedAt: null,
        ownerUserId: 'user-a',
      },
    });
    expect(tx.order.create).not.toHaveBeenCalled();
  });

  it('does not expose foreign customer order history', async () => {
    const prisma: any = {
      lead: { findFirst: jest.fn().mockResolvedValue(null) },
      order: { findMany: jest.fn() },
    };
    const service = new OrdersService(prisma);

    await expect(service.getCustomerOrderHistory(
      'tenant-b-lead',
      tenantUser('sales_user'),
    )).rejects.toBeInstanceOf(NotFoundException);
    expect(prisma.order.findMany).not.toHaveBeenCalled();
  });

  it('rejects manual quote attachment before any database access', async () => {
    const prisma: any = {
      $transaction: jest.fn(),
    };
    const service = new OrdersService(prisma);

    await expect(service.create(
      { leadId: 'lead-a', quoteId: 'quote-a' },
      tenantUser('sales_user'),
    )).rejects.toBeInstanceOf(ConflictException);
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('lets conversion win over a racing manual quote create and preserves the quote snapshot', async () => {
    let status = 'sent';
    let createdOrderData: any;
    const tx: any = {
      quote: {
        updateMany: jest.fn(({ where, data }: any) => {
          if (where.status !== status) return Promise.resolve({ count: 0 });
          status = data.status;
          return Promise.resolve({ count: 1 });
        }),
        findFirst: jest.fn().mockImplementation(() => Promise.resolve({
          id: 'quote-a',
          companyId: 'tenant-a',
          leadId: null,
          conversationId: null,
          referenceNo: 'QT-SNAPSHOT',
          currency: 'USD',
          totalAmount: 42,
          tradeTerms: 'FOB',
        })),
      },
      lead: { findFirst: jest.fn() },
      conversation: { findFirst: jest.fn() },
      order: {
        findFirst: jest.fn().mockResolvedValue(null),
        create: jest.fn(({ data }: any) => {
          createdOrderData = data;
          return Promise.resolve({ id: 'order-a', ...data });
        }),
      },
      leadActivity: { create: jest.fn() },
    };
    const prisma: any = {
      $transaction: jest.fn((callback: any) => callback(tx)),
    };
    const orders = new OrdersService(prisma);
    const quotes = new QuotesService(prisma);
    const user = tenantUser('sales_user');

    const [conversion, manual] = await Promise.allSettled([
      quotes.convertToOrder('quote-a', user),
      orders.create({
        quoteId: 'quote-a',
        currency: 'EUR',
        totalAmount: 0.01,
      }, user),
    ]);

    expect(conversion.status).toBe('fulfilled');
    expect(manual.status).toBe('rejected');
    expect(status).toBe('accepted');
    expect(tx.order.create).toHaveBeenCalledTimes(1);
    expect(createdOrderData).toEqual(expect.objectContaining({
      quoteId: 'quote-a',
      currency: 'USD',
      totalAmount: 42,
      shippingTerms: 'FOB',
    }));
  });
});
