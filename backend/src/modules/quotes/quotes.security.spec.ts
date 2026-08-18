import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
  ValidationPipe,
} from '@nestjs/common';
import { QuotesService } from './quotes.service';
import { CreateQuoteDto } from './dto/create-quote.dto';
import { OrdersService } from '../orders/orders.service';

const tenantAUser = {
  id: 'sales-a',
  activeCompanyId: 'tenant-a',
  activeCompany: { id: 'tenant-a', role: 'sales_user' },
  companies: [{ id: 'tenant-a', role: 'sales_user' }],
};
const tenantAViewer = {
  ...tenantAUser,
  id: 'viewer-a',
  activeCompany: { id: 'tenant-a', role: 'viewer' },
  companies: [{ id: 'tenant-a', role: 'viewer' }],
};

describe('QuotesService mutation isolation', () => {
  it('rejects nested line-item mass assignment through the strict DTO', async () => {
    const pipe = new ValidationPipe({
      transform: true,
      whitelist: true,
      forbidNonWhitelisted: true,
    });
    await expect(pipe.transform({
      lineItems: [{
        productName: 'Bag',
        quantity: 1,
        unitPrice: 1,
        quoteId: 'foreign-quote',
      }],
    }, {
      type: 'body',
      metatype: CreateQuoteDto,
      data: '',
    })).rejects.toBeInstanceOf(BadRequestException);
  });

  it.each([
    ['create', (service: QuotesService) => service.createQuote({
      lineItems: [],
    }, tenantAViewer)],
    ['update', (service: QuotesService) => service.updateQuote(
      'quote-a',
      { notes: 'changed' },
      tenantAViewer,
    )],
    ['status', (service: QuotesService) => service.updateStatus(
      'quote-a',
      'sent',
      tenantAViewer,
    )],
    ['convert', (service: QuotesService) => service.convertToOrder(
      'quote-a',
      tenantAViewer,
    )],
  ])('rejects viewer quote %s writes before database access', async (_name, run) => {
    const prisma: any = {
      quote: {
        findFirst: jest.fn(),
        create: jest.fn(),
        update: jest.fn(),
      },
      order: { create: jest.fn() },
    };
    const service = new QuotesService(prisma);

    await expect(run(service)).rejects.toBeInstanceOf(ForbiddenException);
    expect(prisma.quote.findFirst).not.toHaveBeenCalled();
    expect(prisma.quote.update).not.toHaveBeenCalled();
    expect(prisma.order.create).not.toHaveBeenCalled();
  });

  it('rejects a foreign explicit lead even with an active-tenant conversation', async () => {
    const prisma: any = {
      lead: { findFirst: jest.fn().mockResolvedValue(null) },
      conversation: { findFirst: jest.fn() },
      quote: { create: jest.fn() },
    };
    const service = new QuotesService(prisma);

    await expect(service.createQuote({
      leadId: 'tenant-b-lead',
      conversationId: 'tenant-a-conversation',
      lineItems: [],
    }, tenantAUser)).rejects.toBeInstanceOf(NotFoundException);
    expect(prisma.lead.findFirst).toHaveBeenCalledWith({
      where: {
        id: 'tenant-b-lead',
        companyId: 'tenant-a',
        deletedAt: null,
      },
      select: { id: true },
    });
    expect(prisma.conversation.findFirst).not.toHaveBeenCalled();
    expect(prisma.quote.create).not.toHaveBeenCalled();
  });

  it('rejects a conversation and explicit lead mismatch in the active tenant', async () => {
    const prisma: any = {
      lead: {
        findFirst: jest.fn()
          .mockResolvedValueOnce({ id: 'lead-a' })
          .mockResolvedValueOnce({ id: 'lead-other' }),
      },
      conversation: {
        findFirst: jest.fn().mockResolvedValue({
          id: 'conversation-a',
          companyId: 'tenant-a',
          leadId: 'lead-other',
        }),
      },
      quote: { create: jest.fn() },
    };
    const service = new QuotesService(prisma);

    await expect(service.createQuote({
      leadId: 'lead-a',
      conversationId: 'conversation-a',
      lineItems: [],
    }, tenantAUser)).rejects.toBeInstanceOf(BadRequestException);
    expect(prisma.conversation.findFirst).toHaveBeenCalledWith({
      where: {
        id: 'conversation-a',
        companyId: 'tenant-a',
        assignedUserId: 'sales-a',
      },
      select: { id: true, companyId: true, leadId: true },
    });
    expect(prisma.quote.create).not.toHaveBeenCalled();
  });

  it('does not list quotes through a foreign lead id', async () => {
    const prisma: any = {
      lead: { findFirst: jest.fn().mockResolvedValue(null) },
      quote: { findMany: jest.fn() },
    };
    const service = new QuotesService(prisma);

    await expect(service.listByLead(
      'tenant-b-lead',
      tenantAUser,
    )).rejects.toBeInstanceOf(NotFoundException);
    expect(prisma.lead.findFirst).toHaveBeenCalledWith({
      where: {
        id: 'tenant-b-lead',
        companyId: 'tenant-a',
        deletedAt: null,
        ownerUserId: 'sales-a',
      },
      select: { id: true },
    });
    expect(prisma.quote.findMany).not.toHaveBeenCalled();
  });

  it('does not read or mutate another salesperson quote', async () => {
    const prisma: any = {
      quote: {
        findFirst: jest.fn().mockResolvedValue(null),
        update: jest.fn(),
      },
    };
    const service = new QuotesService(prisma);

    await expect(service.updateStatus(
      'other-sales-quote',
      'sent',
      tenantAUser,
    )).rejects.toBeInstanceOf(NotFoundException);
    expect(prisma.quote.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          id: 'other-sales-quote',
          companyId: 'tenant-a',
          assignedUserId: 'sales-a',
        },
      }),
    );
    expect(prisma.quote.update).not.toHaveBeenCalled();
  });

  it('rejects an undefined or illegal quote status transition', async () => {
    const prisma: any = {
      quote: { updateMany: jest.fn() },
    };
    const service = new QuotesService(prisma);
    jest.spyOn(service, 'findOne').mockResolvedValue({
      id: 'quote-a',
      companyId: 'tenant-a',
      assignedUserId: 'sales-a',
      status: 'draft',
    } as any);

    await expect(service.updateStatus(
      'quote-a',
      'accepted',
      tenantAUser,
    )).rejects.toBeInstanceOf(BadRequestException);
    expect(prisma.quote.updateMany).not.toHaveBeenCalled();
  });

  it('keeps replacement line items and quote update in one failed transaction', async () => {
    const tx: any = {
      quoteLineItem: {
        deleteMany: jest.fn().mockResolvedValue({ count: 1 }),
        createMany: jest.fn().mockRejectedValue(new Error('insert failed')),
      },
      quote: {
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        findFirst: jest.fn().mockResolvedValue({
          id: 'quote-a',
          status: 'draft',
          leadId: null,
          conversationId: null,
          discount: 0,
          taxRate: 0,
        }),
      },
    };
    const prisma: any = {
      $transaction: jest.fn((callback: any) => callback(tx)),
    };
    const service = new QuotesService(prisma);

    await expect(service.updateQuote(
      'quote-a',
      {
        lineItems: [{
          productName: 'Bag',
          quantity: 10,
          unitPrice: 1,
        }],
      },
      tenantAUser,
    )).rejects.toThrow('insert failed');
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(tx.quote.updateMany).toHaveBeenCalledWith({
      where: {
        id: 'quote-a',
        companyId: 'tenant-a',
        assignedUserId: 'sales-a',
        status: 'draft',
      },
      data: {
        sampleFee: 0,
        moldFee: 0,
        subtotal: 10,
        taxAmount: 0,
        totalAmount: 10,
      },
    });
  });

  it('does not update a foreign line item through an accessible quote id', async () => {
    const tx: any = {
      quote: {
        findFirst: jest.fn().mockResolvedValue({
          id: 'quote-a',
          status: 'draft',
          discount: 0,
          taxRate: 0,
        }),
      },
      quoteLineItem: {
        findFirst: jest.fn().mockResolvedValue(null),
        updateMany: jest.fn(),
      },
    };
    const prisma: any = {
      $transaction: jest.fn((callback: any) => callback(tx)),
    };
    const service = new QuotesService(prisma);

    await expect(service.updateLineItem(
      'quote-a',
      'tenant-b-item',
      { quantity: 2 },
      tenantAUser,
    )).rejects.toBeInstanceOf(NotFoundException);
    expect(tx.quoteLineItem.findFirst).toHaveBeenCalledWith({
      where: { id: 'tenant-b-item', quoteId: 'quote-a' },
    });
    expect(tx.quoteLineItem.updateMany).not.toHaveBeenCalled();
  });

  it('does not delete a foreign line item through an accessible quote id', async () => {
    const tx: any = {
      quote: {
        findFirst: jest.fn().mockResolvedValue({
          id: 'quote-a',
          status: 'draft',
          discount: 0,
          taxRate: 0,
        }),
      },
      quoteLineItem: {
        deleteMany: jest.fn().mockResolvedValue({ count: 0 }),
      },
    };
    const prisma: any = {
      $transaction: jest.fn((callback: any) => callback(tx)),
    };
    const service = new QuotesService(prisma);

    await expect(service.deleteLineItem(
      'quote-a',
      'tenant-b-item',
      tenantAUser,
    )).rejects.toBeInstanceOf(NotFoundException);
    expect(tx.quoteLineItem.deleteMany).toHaveBeenCalledWith({
      where: { id: 'tenant-b-item', quoteId: 'quote-a' },
    });
  });

  it('rejects companyId mass assignment before updating a quote', async () => {
    const prisma: any = {
      quote: { update: jest.fn() },
    };
    const service = new QuotesService(prisma);
    const findOne = jest.spyOn(service, 'findOne');

    await expect(service.updateQuote(
      'quote-a',
      { companyId: 'tenant-b', notes: 'moved' } as any,
      tenantAUser,
    )).rejects.toBeInstanceOf(BadRequestException);
    expect(findOne).not.toHaveBeenCalled();
    expect(prisma.quote.update).not.toHaveBeenCalled();
  });

  it('rejects a lead relationship outside the active tenant', async () => {
    const tx: any = {
      quote: {
        findFirst: jest.fn().mockResolvedValue({
          id: 'quote-a',
          status: 'draft',
          leadId: null,
          conversationId: null,
          discount: 0,
          taxRate: 0,
        }),
      },
      lead: { findFirst: jest.fn().mockResolvedValue(null) },
    };
    const prisma: any = {
      $transaction: jest.fn((callback: any) => callback(tx)),
    };
    const service = new QuotesService(prisma);

    await expect(service.updateQuote(
      'quote-a',
      { leadId: 'tenant-b-lead' },
      tenantAUser,
    )).rejects.toBeInstanceOf(NotFoundException);
    expect(tx.lead.findFirst).toHaveBeenCalledWith({
      where: {
        id: 'tenant-b-lead',
        companyId: 'tenant-a',
        deletedAt: null,
        ownerUserId: 'sales-a',
      },
      select: { id: true },
    });
  });

  it('rejects rebinding a quote to another salesperson lead or conversation', async () => {
    const tx: any = {
      quote: {
        findFirst: jest.fn().mockResolvedValue({
          id: 'quote-a',
          status: 'draft',
          leadId: 'lead-a',
          conversationId: null,
          discount: 0,
          taxRate: 0,
        }),
      },
      lead: {
        findFirst: jest.fn()
          .mockResolvedValueOnce(null)
          .mockResolvedValueOnce({ id: 'lead-a' }),
      },
      conversation: { findFirst: jest.fn().mockResolvedValue(null) },
    };
    const prisma: any = {
      $transaction: jest.fn((callback: any) => callback(tx)),
    };
    const service = new QuotesService(prisma);

    await expect(service.updateQuote(
      'quote-a',
      { leadId: 'other-sales-lead' },
      tenantAUser,
    )).rejects.toBeInstanceOf(NotFoundException);
    expect(tx.lead.findFirst).toHaveBeenCalledWith({
      where: {
        id: 'other-sales-lead',
        companyId: 'tenant-a',
        deletedAt: null,
        ownerUserId: 'sales-a',
      },
      select: { id: true },
    });

    await expect(service.updateQuote(
      'quote-a',
      { conversationId: 'other-sales-conversation' },
      tenantAUser,
    )).rejects.toBeInstanceOf(NotFoundException);
    expect(tx.conversation.findFirst).toHaveBeenCalledWith({
      where: {
        id: 'other-sales-conversation',
        companyId: 'tenant-a',
        assignedUserId: 'sales-a',
      },
      select: { id: true, leadId: true },
    });
  });

  it('rejects a lead-only update that conflicts with the existing conversation', async () => {
    const tx: any = {
      quote: {
        findFirst: jest.fn().mockResolvedValue({
          id: 'quote-a',
          status: 'draft',
          leadId: 'old-lead',
          conversationId: 'conversation-a',
          discount: 0,
          taxRate: 0,
        }),
      },
      lead: { findFirst: jest.fn().mockResolvedValue({ id: 'new-lead' }) },
      conversation: {
        findFirst: jest.fn().mockResolvedValue({
          id: 'conversation-a',
          leadId: 'old-lead',
        }),
      },
    };
    const prisma: any = {
      $transaction: jest.fn((callback: any) => callback(tx)),
    };
    const service = new QuotesService(prisma);

    await expect(service.updateQuote(
      'quote-a',
      { leadId: 'new-lead' },
      tenantAUser,
    )).rejects.toBeInstanceOf(BadRequestException);
    expect(tx.conversation.findFirst).toHaveBeenCalledWith({
      where: {
        id: 'conversation-a',
        companyId: 'tenant-a',
        assignedUserId: 'sales-a',
      },
      select: { id: true, leadId: true },
    });
  });

  it.each(['sent', 'accepted', 'rejected', 'expired', 'cancelled'])(
    'rejects structural updates while a quote is %s',
    async (status) => {
      const tx: any = {
        quote: {
          findFirst: jest.fn().mockResolvedValue({
            id: 'quote-a',
            status,
            leadId: null,
            conversationId: null,
            discount: 0,
            taxRate: 0,
          }),
          updateMany: jest.fn(),
        },
        quoteLineItem: {
          deleteMany: jest.fn(),
          createMany: jest.fn(),
        },
      };
      const prisma: any = {
        $transaction: jest.fn((callback: any) => callback(tx)),
      };
      const service = new QuotesService(prisma);

      await expect(service.updateQuote(
        'quote-a',
        { notes: 'must not drift' },
        tenantAUser,
      )).rejects.toBeInstanceOf(ConflictException);
      expect(tx.quote.updateMany).not.toHaveBeenCalled();
      expect(tx.quoteLineItem.deleteMany).not.toHaveBeenCalled();
    },
  );

  it('restricts deletion of a historically referenced draft quote', async () => {
    const tx: any = {
      quote: {
        findFirst: jest.fn().mockResolvedValue({
          id: 'quote-a',
          companyId: 'tenant-a',
          status: 'draft',
        }),
        deleteMany: jest.fn(),
      },
      order: {
        findFirst: jest.fn().mockResolvedValue({ id: 'legacy-order' }),
      },
    };
    const prisma: any = {
      $transaction: jest.fn((callback: any) => callback(tx)),
    };
    const service = new QuotesService(prisma);

    await expect(service.deleteQuote('quote-a', tenantAUser))
      .rejects.toBeInstanceOf(ConflictException);
    expect(tx.order.findFirst).toHaveBeenCalledWith({
      where: { quoteId: 'quote-a' },
      select: { id: true },
    });
    expect(tx.quote.deleteMany).not.toHaveBeenCalled();
  });

  it('restricts deletion on a cross-tenant legacy order reference without disclosing it', async () => {
    const tx: any = {
      quote: {
        findFirst: jest.fn().mockResolvedValue({
          id: 'quote-a',
          companyId: 'tenant-a',
          status: 'draft',
        }),
        deleteMany: jest.fn(),
      },
      order: {
        findFirst: jest.fn().mockResolvedValue({
          id: 'tenant-b-order',
          companyId: 'tenant-b',
        }),
      },
    };
    const prisma: any = {
      $transaction: jest.fn((callback: any) => callback(tx)),
    };
    const service = new QuotesService(prisma);

    const result = await service.deleteQuote(
      'quote-a',
      tenantAUser,
    ).catch((error) => error);

    expect(result).toBeInstanceOf(ConflictException);
    expect(result.message).toBe(
      'Quote is referenced by an order and cannot be deleted',
    );
    expect(result.message).not.toContain('tenant-b');
    expect(result.message).not.toContain('tenant-b-order');
    expect(tx.order.findFirst).toHaveBeenCalledWith({
      where: { quoteId: 'quote-a' },
      select: { id: true },
    });
    expect(tx.quote.deleteMany).not.toHaveBeenCalled();
  });

  it('deletes an unreferenced draft through the draft CAS transaction', async () => {
    const tx: any = {
      quote: {
        findFirst: jest.fn().mockResolvedValue({
          id: 'quote-a',
          companyId: 'tenant-a',
          status: 'draft',
        }),
        deleteMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      order: {
        findFirst: jest.fn().mockResolvedValue(null),
      },
    };
    const prisma: any = {
      $transaction: jest.fn((callback: any) => callback(tx)),
    };
    const service = new QuotesService(prisma);

    await expect(service.deleteQuote('quote-a', tenantAUser))
      .resolves.toEqual(expect.objectContaining({ id: 'quote-a' }));
    expect(tx.quote.deleteMany).toHaveBeenCalledWith({
      where: {
        id: 'quote-a',
        companyId: 'tenant-a',
        assignedUserId: 'sales-a',
        status: 'draft',
      },
    });
  });

  it('cannot create a quote-linked manual order while deleting a draft', async () => {
    const tx: any = {
      quote: {
        findFirst: jest.fn().mockResolvedValue({
          id: 'quote-a',
          companyId: 'tenant-a',
          status: 'draft',
        }),
        deleteMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      order: {
        findFirst: jest.fn().mockResolvedValue(null),
        create: jest.fn(),
      },
    };
    const prisma: any = {
      $transaction: jest.fn((callback: any) => callback(tx)),
    };
    const quotes = new QuotesService(prisma);
    const orders = new OrdersService(prisma);

    const [manualCreate, deletion] = await Promise.allSettled([
      orders.create({ quoteId: 'quote-a' }, tenantAUser),
      quotes.deleteQuote('quote-a', tenantAUser),
    ]);

    expect(manualCreate.status).toBe('rejected');
    expect(deletion.status).toBe('fulfilled');
    expect(tx.order.create).not.toHaveBeenCalled();
    expect(tx.quote.deleteMany).toHaveBeenCalledTimes(1);
  });

  it.each(
    ['sent', 'accepted', 'rejected', 'expired', 'cancelled'].flatMap(
      (status) => [
        [status, 'remove', (service: QuotesService) =>
          service.deleteQuote('quote-a', tenantAUser)],
        [status, 'add-line', (service: QuotesService) =>
          service.addLineItem('quote-a', {
            productName: 'Late item',
            quantity: 1,
            unitPrice: 5,
          }, tenantAUser)],
        [status, 'update-line', (service: QuotesService) =>
          service.updateLineItem(
            'quote-a',
            'item-a',
            { quantity: 2 },
            tenantAUser,
          )],
        [status, 'delete-line', (service: QuotesService) =>
          service.deleteLineItem('quote-a', 'item-a', tenantAUser)],
        [status, 'calculate', (service: QuotesService) =>
          service.calculate('quote-a', tenantAUser)],
      ],
    ),
  )(
    'rejects %s quote %s mutations before changing rows',
    async (status, _operation, run) => {
      const tx: any = {
        quote: {
          findFirst: jest.fn().mockResolvedValue({
            id: 'quote-a',
            status,
            discount: 0,
            taxRate: 0,
          }),
          updateMany: jest.fn(),
          deleteMany: jest.fn(),
        },
        quoteLineItem: {
          count: jest.fn(),
          create: jest.fn(),
          findFirst: jest.fn(),
          findMany: jest.fn(),
          updateMany: jest.fn(),
          deleteMany: jest.fn(),
        },
      };
      const prisma: any = {
        $transaction: jest.fn((callback: any) => callback(tx)),
      };
      const service = new QuotesService(prisma);

      await expect(run(service)).rejects.toBeInstanceOf(ConflictException);
      expect(tx.quote.deleteMany).not.toHaveBeenCalled();
      expect(tx.quote.updateMany).not.toHaveBeenCalled();
      expect(tx.quoteLineItem.create).not.toHaveBeenCalled();
      expect(tx.quoteLineItem.updateMany).not.toHaveBeenCalled();
      expect(tx.quoteLineItem.deleteMany).not.toHaveBeenCalled();
    },
  );

  it.each([
    ['remove', (service: QuotesService) =>
      service.deleteQuote('quote-a', tenantAUser)],
    ['add-line', (service: QuotesService) =>
      service.addLineItem('quote-a', {
        productName: 'Item',
        quantity: 1,
        unitPrice: 1,
      }, tenantAUser)],
    ['update-line', (service: QuotesService) =>
      service.updateLineItem(
        'quote-a',
        'item-a',
        { quantity: 2 },
        tenantAUser,
      )],
    ['delete-line', (service: QuotesService) =>
      service.deleteLineItem('quote-a', 'item-a', tenantAUser)],
    ['calculate', (service: QuotesService) =>
      service.calculate('quote-a', tenantAUser)],
  ])('maps %s serialization failures to conflict', async (_operation, run) => {
    const prisma: any = {
      $transaction: jest.fn().mockRejectedValue({ code: 'P2034' }),
    };
    const service = new QuotesService(prisma);

    await expect(run(service)).rejects.toBeInstanceOf(ConflictException);
  });

  it.each([
    ['remove', (service: QuotesService) =>
      service.deleteQuote('quote-a', tenantAUser)],
    ['add-line', (service: QuotesService) =>
      service.addLineItem('quote-a', {
        productName: 'Late item',
        quantity: 1,
        unitPrice: 5,
      }, tenantAUser)],
    ['update-line', (service: QuotesService) =>
      service.updateLineItem(
        'quote-a',
        'item-a',
        { quantity: 2 },
        tenantAUser,
      )],
    ['delete-line', (service: QuotesService) =>
      service.deleteLineItem('quote-a', 'item-a', tenantAUser)],
    ['calculate', (service: QuotesService) =>
      service.calculate('quote-a', tenantAUser)],
  ])(
    'rejects %s after the quote has been converted',
    async (_operation, run) => {
      let status = 'sent';
      const tx: any = {
        quote: {
          updateMany: jest.fn(({ where, data }: any) => {
            if (where.status === 'sent' && status === 'sent') {
              status = data.status;
              return Promise.resolve({ count: 1 });
            }
            return Promise.resolve({ count: 0 });
          }),
          findFirst: jest.fn(({ where }: any) => {
            if (where.status === 'accepted' && status === 'accepted') {
              return Promise.resolve({
                id: 'quote-a',
                companyId: 'tenant-a',
                leadId: null,
                conversationId: null,
                referenceNo: 'QT-1',
                currency: 'USD',
                totalAmount: 10,
                tradeTerms: null,
              });
            }
            return Promise.resolve({
              id: 'quote-a',
              status,
              discount: 0,
              taxRate: 0,
            });
          }),
          deleteMany: jest.fn(),
        },
        quoteLineItem: {
          count: jest.fn(),
          create: jest.fn(),
          findFirst: jest.fn(),
          findMany: jest.fn(),
          updateMany: jest.fn(),
          deleteMany: jest.fn(),
        },
        lead: { findFirst: jest.fn() },
        conversation: { findFirst: jest.fn() },
        order: {
          findFirst: jest.fn().mockResolvedValue(null),
          create: jest.fn(({ data }: any) =>
            Promise.resolve({ id: 'order-a', ...data })),
        },
        leadActivity: { create: jest.fn() },
      };
      const prisma: any = {
        $transaction: jest.fn((callback: any) => callback(tx)),
      };
      const service = new QuotesService(prisma);

      await service.convertToOrder('quote-a', tenantAUser);
      await expect(run(service)).rejects.toBeInstanceOf(ConflictException);
      expect(status).toBe('accepted');
    },
  );

  it('rejects an update that read draft before a concurrent conversion committed', async () => {
    let status = 'draft';
    let transactionIndex = 0;
    let pauseUpdate!: () => void;
    let releaseUpdate!: () => void;
    const updatePaused = new Promise<void>((resolve) => {
      pauseUpdate = resolve;
    });
    const updateRelease = new Promise<void>((resolve) => {
      releaseUpdate = resolve;
    });
    let createdOrder: any;
    const prisma: any = {};
    prisma.$transaction = jest.fn(async (callback: any) => {
      const index = transactionIndex++;
      const tx: any = {
        quote: {
          findFirst: jest.fn(({ where }: any) => {
            if (where.status === 'accepted') {
              return Promise.resolve(status === 'accepted' ? {
                id: 'quote-a',
                companyId: 'tenant-a',
                leadId: 'lead-a',
                conversationId: null,
                referenceNo: 'QT-FINAL',
                currency: 'USD',
                totalAmount: 25,
                tradeTerms: 'FOB',
              } : null);
            }
            return Promise.resolve({
              id: 'quote-a',
              status: index === 0 ? 'draft' : status,
              leadId: 'lead-a',
              conversationId: null,
              discount: 0,
              taxRate: 0,
            });
          }),
          updateMany: jest.fn(({ where }: any) => {
            if (where.status === 'sent' && status === 'sent') {
              status = 'accepted';
              return Promise.resolve({ count: 1 });
            }
            if (where.status === 'draft' && status === 'draft') {
              return Promise.resolve({ count: 1 });
            }
            return Promise.resolve({ count: 0 });
          }),
        },
        lead: {
          findFirst: jest.fn(async () => {
            if (index === 0) {
              pauseUpdate();
              await updateRelease;
            }
            return { id: 'lead-a' };
          }),
        },
        conversation: { findFirst: jest.fn() },
        quoteLineItem: {
          deleteMany: jest.fn(),
          createMany: jest.fn(),
        },
        order: {
          findFirst: jest.fn().mockResolvedValue(null),
          create: jest.fn(({ data }: any) => {
            createdOrder = { id: 'order-a', ...data };
            return Promise.resolve(createdOrder);
          }),
        },
        leadActivity: { create: jest.fn().mockResolvedValue({}) },
      };
      return callback(tx);
    });
    const service = new QuotesService(prisma);

    const updatePromise = service.updateQuote(
      'quote-a',
      { leadId: 'lead-a', notes: 'stale update' },
      tenantAUser,
    );
    await updatePaused;
    status = 'sent';
    await expect(service.convertToOrder('quote-a', tenantAUser))
      .resolves.toEqual(expect.objectContaining({ id: 'order-a' }));
    releaseUpdate();
    await expect(updatePromise).rejects.toBeInstanceOf(ConflictException);
    expect(status).toBe('accepted');
    expect(createdOrder).toEqual(expect.objectContaining({
      leadId: 'lead-a',
      totalAmount: 25,
    }));
  });

  it('commits conversion but rolls back a racing line-item addition', async () => {
    let status = 'draft';
    let quoteTotal = 10;
    const committedItemTotals = [10];
    let transactionIndex = 0;
    let pauseLineItem!: () => void;
    let releaseLineItem!: () => void;
    const lineItemPaused = new Promise<void>((resolve) => {
      pauseLineItem = resolve;
    });
    const lineItemRelease = new Promise<void>((resolve) => {
      releaseLineItem = resolve;
    });
    let createdOrder: any;
    const prisma: any = {};
    prisma.$transaction = jest.fn(async (callback: any) => {
      const index = transactionIndex++;
      const localItemTotals = [...committedItemTotals];
      const tx: any = {
        quote: {
          findFirst: jest.fn(({ where }: any) => {
            if (where.status === 'accepted') {
              return Promise.resolve(status === 'accepted' ? {
                id: 'quote-a',
                companyId: 'tenant-a',
                leadId: null,
                conversationId: null,
                referenceNo: 'QT-SNAPSHOT',
                currency: 'USD',
                totalAmount: quoteTotal,
                tradeTerms: 'FOB',
              } : null);
            }
            return Promise.resolve({
              id: 'quote-a',
              status,
              discount: 0,
              taxRate: 0,
            });
          }),
          updateMany: jest.fn(({ where, data }: any) => {
            if (where.status === 'sent' && status === 'sent') {
              status = 'accepted';
              return Promise.resolve({ count: 1 });
            }
            if (where.status === 'draft' && status === 'draft') {
              quoteTotal = data.totalAmount;
              return Promise.resolve({ count: 1 });
            }
            return Promise.resolve({ count: 0 });
          }),
        },
        quoteLineItem: {
          count: jest.fn().mockResolvedValue(localItemTotals.length),
          create: jest.fn(async ({ data }: any) => {
            if (index === 0) {
              pauseLineItem();
              await lineItemRelease;
            }
            localItemTotals.push(Number(data.totalPrice));
            return { id: 'late-item', ...data };
          }),
          findMany: jest.fn().mockImplementation(() =>
            Promise.resolve(localItemTotals.map((totalPrice) => ({
              totalPrice,
            })))),
        },
        lead: { findFirst: jest.fn() },
        conversation: { findFirst: jest.fn() },
        order: {
          findFirst: jest.fn().mockResolvedValue(null),
          create: jest.fn(({ data }: any) => {
            createdOrder = { id: 'order-a', ...data };
            return Promise.resolve(createdOrder);
          }),
        },
        leadActivity: { create: jest.fn() },
      };
      const result = await callback(tx);
      if (index === 0) {
        committedItemTotals.splice(
          0,
          committedItemTotals.length,
          ...localItemTotals,
        );
      }
      return result;
    });
    const service = new QuotesService(prisma);

    const lineItemPromise = service.addLineItem('quote-a', {
      productName: 'Racing item',
      quantity: 1,
      unitPrice: 5,
    }, tenantAUser);
    await lineItemPaused;
    status = 'sent';
    await expect(service.convertToOrder('quote-a', tenantAUser))
      .resolves.toEqual(expect.objectContaining({ id: 'order-a' }));
    releaseLineItem();
    await expect(lineItemPromise).rejects.toBeInstanceOf(ConflictException);

    expect(status).toBe('accepted');
    expect(committedItemTotals).toEqual([10]);
    expect(quoteTotal).toBe(10);
    expect(createdOrder).toEqual(expect.objectContaining({
      totalAmount: 10,
      notes: 'Converted from quote QT-SNAPSHOT',
    }));
  });

  it('does not allow structural updates after conversion has committed', async () => {
    let status = 'sent';
    const prisma: any = {};
    prisma.$transaction = jest.fn((callback: any) => {
      const tx: any = {
        quote: {
          updateMany: jest.fn(({ where }: any) => {
            if (where.status === 'sent' && status === 'sent') {
              status = 'accepted';
              return Promise.resolve({ count: 1 });
            }
            return Promise.resolve({ count: 0 });
          }),
          findFirst: jest.fn(({ where }: any) => {
            if (where.status === 'accepted') {
              return Promise.resolve({
                id: 'quote-a',
                companyId: 'tenant-a',
                leadId: null,
                conversationId: null,
                referenceNo: 'QT-1',
                currency: 'USD',
                totalAmount: 10,
                tradeTerms: null,
              });
            }
            return Promise.resolve({
              id: 'quote-a',
              status,
              leadId: null,
              conversationId: null,
              discount: 0,
              taxRate: 0,
            });
          }),
        },
        order: {
          findFirst: jest.fn().mockResolvedValue(null),
          create: jest.fn(({ data }: any) =>
            Promise.resolve({ id: 'order-a', ...data })),
        },
        lead: { findFirst: jest.fn() },
        conversation: { findFirst: jest.fn() },
        leadActivity: { create: jest.fn() },
        quoteLineItem: {
          deleteMany: jest.fn(),
          createMany: jest.fn(),
        },
      };
      return callback(tx);
    });
    const service = new QuotesService(prisma);

    await service.convertToOrder('quote-a', tenantAUser);
    await expect(service.updateQuote(
      'quote-a',
      { notes: 'late mutation' },
      tenantAUser,
    )).rejects.toBeInstanceOf(ConflictException);
    expect(status).toBe('accepted');
  });

  it('converts a sent quote only once through a status CAS transaction', async () => {
    let status = 'sent';
    let orderCount = 0;
    let createdOrderData: any;
    const prisma: any = {};
    prisma.$transaction = jest.fn(async (callback: any, options: any) => {
      const tx: any = {
        quote: {
          updateMany: jest.fn(() => {
            if (status !== 'sent') return Promise.resolve({ count: 0 });
            status = 'accepted';
            return Promise.resolve({ count: 1 });
          }),
          findFirst: jest.fn(() => Promise.resolve(status === 'accepted' ? {
            id: 'quote-a',
            companyId: 'tenant-a',
            leadId: 'lead-final',
            conversationId: null,
            referenceNo: 'QT-FINAL',
            currency: 'EUR',
            totalAmount: 42,
            tradeTerms: 'FOB',
          } : null)),
        },
        lead: {
          findFirst: jest.fn().mockResolvedValue({ id: 'lead-final' }),
        },
        conversation: { findFirst: jest.fn() },
        order: {
          findFirst: jest.fn().mockResolvedValue(null),
          create: jest.fn(({ data }: any) => {
            createdOrderData = data;
            orderCount += 1;
            return Promise.resolve({ id: `order-${orderCount}`, ...data });
          }),
        },
        leadActivity: { create: jest.fn() },
      };
      expect(options).toEqual({ isolationLevel: 'Serializable' });
      return callback(tx);
    });
    const service = new QuotesService(prisma);
    const findOne = jest.spyOn(service, 'findOne');

    await expect(service.convertToOrder('quote-a', tenantAUser))
      .resolves.toEqual(expect.objectContaining({ id: 'order-1' }));
    await expect(service.convertToOrder('quote-a', tenantAUser))
      .rejects.toBeInstanceOf(ConflictException);
    expect(orderCount).toBe(1);
    expect(findOne).not.toHaveBeenCalled();
    expect(createdOrderData).toEqual(expect.objectContaining({
      companyId: 'tenant-a',
      leadId: 'lead-final',
      quoteId: 'quote-a',
      currency: 'EUR',
      totalAmount: 42,
      shippingTerms: 'FOB',
      notes: 'Converted from quote QT-FINAL',
      stageHistory: [
        expect.objectContaining({
          stage: 'won',
          changedBy: 'sales-a',
          note: 'Converted from QT-FINAL',
        }),
      ],
    }));
    expect(Array.isArray(createdOrderData.stageHistory)).toBe(true);
  });

  it('does not convert a quote with a historical order reference', async () => {
    const tx: any = {
      order: {
        findFirst: jest.fn().mockResolvedValue({ id: 'legacy-order' }),
        create: jest.fn(),
      },
      quote: {
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        findFirst: jest.fn(),
      },
    };
    const prisma: any = {
      $transaction: jest.fn((callback: any) => callback(tx)),
    };
    const service = new QuotesService(prisma);

    await expect(service.convertToOrder('quote-a', tenantAUser))
      .rejects.toBeInstanceOf(ConflictException);
    expect(tx.order.findFirst).toHaveBeenCalledWith({
      where: { quoteId: 'quote-a' },
      select: { id: true },
    });
    expect(tx.quote.updateMany).toHaveBeenCalledWith({
      where: expect.objectContaining({
        id: 'quote-a',
        companyId: 'tenant-a',
        assignedUserId: 'sales-a',
        status: 'sent',
      }),
      data: expect.objectContaining({ status: 'accepted' }),
    });
    expect(tx.order.create).not.toHaveBeenCalled();
  });

  it('does not convert across a legacy foreign-tenant order reference or disclose it', async () => {
    const tx: any = {
      order: {
        findFirst: jest.fn().mockResolvedValue({
          id: 'tenant-b-order',
          companyId: 'tenant-b',
        }),
        create: jest.fn(),
      },
      quote: {
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        findFirst: jest.fn(),
      },
    };
    const prisma: any = {
      $transaction: jest.fn((callback: any) => callback(tx)),
    };
    const service = new QuotesService(prisma);

    const result = await service.convertToOrder(
      'quote-a',
      tenantAUser,
    ).catch((error) => error);

    expect(result).toBeInstanceOf(ConflictException);
    expect(result.message).toBe('Quote is already linked to an order');
    expect(result.message).not.toContain('tenant-b');
    expect(result.message).not.toContain('tenant-b-order');
    expect(tx.order.findFirst).toHaveBeenCalledWith({
      where: { quoteId: 'quote-a' },
      select: { id: true },
    });
    expect(tx.quote.updateMany).toHaveBeenCalled();
    expect(tx.order.create).not.toHaveBeenCalled();
  });

  it.each([
    ['without a historical order', null],
    ['with a historical order', { id: 'foreign-order' }],
  ])(
    'returns the same error for a foreign quote UUID %s before the global reference lookup',
    async (_scenario, historicalOrder) => {
      const tx: any = {
        quote: {
          updateMany: jest.fn().mockResolvedValue({ count: 0 }),
          findFirst: jest.fn(),
        },
        order: {
          findFirst: jest.fn().mockResolvedValue(historicalOrder),
          create: jest.fn(),
        },
      };
      const prisma: any = {
        $transaction: jest.fn((callback: any) => callback(tx)),
      };
      const service = new QuotesService(prisma);

      const result = await service.convertToOrder(
        'foreign-quote-uuid',
        tenantAUser,
      ).catch((error) => error);

      expect(result).toBeInstanceOf(ConflictException);
      expect(result.message).toBe(
        'Quote was already converted or changed concurrently',
      );
      expect(tx.order.findFirst).not.toHaveBeenCalled();
      expect(tx.quote.findFirst).not.toHaveBeenCalled();
      expect(tx.order.create).not.toHaveBeenCalled();
    },
  );

  it('retries conversion order-number collisions from a rolled-back sent snapshot', async () => {
    let committedStatus = 'sent';
    let committedActivities = 0;
    let committedOrders = 0;
    let transactionAttempt = 0;
    const attemptedOrderNos: string[] = [];
    const prisma: any = {
      $transaction: jest.fn(async (callback: any) => {
        const attempt = transactionAttempt++;
        let localStatus = committedStatus;
        let localActivities = 0;
        let localOrders = 0;
        const tx: any = {
          quote: {
            updateMany: jest.fn(({ where, data }: any) => {
              if (where.status !== localStatus) {
                return Promise.resolve({ count: 0 });
              }
              localStatus = data.status;
              return Promise.resolve({ count: 1 });
            }),
            findFirst: jest.fn().mockResolvedValue({
              id: 'quote-a',
              companyId: 'tenant-a',
              leadId: 'lead-a',
              conversationId: null,
              referenceNo: 'QT-RETRY',
              currency: 'USD',
              totalAmount: 12.34,
              tradeTerms: 'FOB',
            }),
          },
          lead: { findFirst: jest.fn().mockResolvedValue({ id: 'lead-a' }) },
          conversation: { findFirst: jest.fn() },
          order: {
            findFirst: jest.fn().mockResolvedValue(null),
            create: jest.fn(({ data }: any) => {
              attemptedOrderNos.push(data.orderNo);
              if (attempt === 0) {
                return Promise.reject({
                  code: 'P2002',
                  meta: { target: ['orderNo'] },
                });
              }
              localOrders += 1;
              return Promise.resolve({ id: 'order-a', ...data });
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
        committedStatus = localStatus;
        committedActivities += localActivities;
        committedOrders += localOrders;
        return result;
      }),
    };
    const service = new QuotesService(prisma);

    await expect(service.convertToOrder('quote-a', tenantAUser))
      .resolves.toEqual(expect.objectContaining({
        id: 'order-a',
        quoteId: 'quote-a',
        totalAmount: '12.34',
      }));

    expect(prisma.$transaction).toHaveBeenCalledTimes(2);
    expect(committedStatus).toBe('accepted');
    expect(committedOrders).toBe(1);
    expect(committedActivities).toBe(1);
    expect(attemptedOrderNos).toHaveLength(2);
    expect(new Set(attemptedOrderNos).size).toBe(2);
    for (const orderNo of attemptedOrderNos) {
      expect(orderNo).toMatch(/^ORD-\d{8}-[A-F0-9]{32}$/);
      expect(orderNo).toHaveLength(45);
    }
  });

  it.each([
    [
      'discount-only',
      { discount: 0, taxRate: 10 },
      { discount: 10 },
      { subtotal: 100, taxAmount: 9, totalAmount: 99 },
    ],
    [
      'tax-rate rounding',
      { discount: 10, taxRate: 0 },
      { taxRate: 7.25 },
      { subtotal: 100, taxAmount: 6.53, totalAmount: 96.53 },
    ],
    [
      'zero tax-rate boundary',
      { discount: 10, taxRate: 7.25 },
      { taxRate: 0 },
      { subtotal: 100, taxAmount: 0, totalAmount: 90 },
    ],
    [
      'maximum tax-rate boundary',
      { discount: 10, taxRate: 0 },
      { taxRate: 100 },
      { subtotal: 100, taxAmount: 90, totalAmount: 180 },
    ],
  ])(
    'recalculates a %s patch before send and converts the exact total',
    async (_scenario, initialPricing, patch, expected) => {
      const quote: any = {
        id: 'quote-a',
        companyId: 'tenant-a',
        assignedUserId: 'sales-a',
        leadId: null,
        conversationId: null,
        referenceNo: 'QT-PRICE',
        currency: 'USD',
        tradeTerms: 'FOB',
        status: 'draft',
        acceptedAt: null,
        subtotal: 100,
        taxAmount: 0,
        totalAmount: 100,
        ...initialPricing,
      };
      const lineItems = [
        { id: 'item-1', quoteId: 'quote-a', totalPrice: 60 },
        { id: 'item-2', quoteId: 'quote-a', totalPrice: 40 },
      ];
      let createdOrderData: any;
      const findQuote = ({ where }: any) => {
        if (where.id !== quote.id || where.companyId !== quote.companyId) {
          return Promise.resolve(null);
        }
        if (where.assignedUserId
          && where.assignedUserId !== quote.assignedUserId) {
          return Promise.resolve(null);
        }
        if (where.status && where.status !== quote.status) {
          return Promise.resolve(null);
        }
        if (where.acceptedAt && where.acceptedAt !== quote.acceptedAt) {
          return Promise.resolve(null);
        }
        return Promise.resolve({ ...quote, lineItems });
      };
      const updateQuote = ({ where, data }: any) => {
        if (where.id !== quote.id || where.companyId !== quote.companyId) {
          return Promise.resolve({ count: 0 });
        }
        if (where.assignedUserId
          && where.assignedUserId !== quote.assignedUserId) {
          return Promise.resolve({ count: 0 });
        }
        if (where.status && where.status !== quote.status) {
          return Promise.resolve({ count: 0 });
        }
        Object.assign(quote, data);
        return Promise.resolve({ count: 1 });
      };
      const tx: any = {
        quote: {
          findFirst: jest.fn(findQuote),
          updateMany: jest.fn(updateQuote),
        },
        quoteLineItem: {
          findMany: jest.fn().mockResolvedValue(lineItems),
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
        quote: {
          findFirst: jest.fn(findQuote),
          updateMany: jest.fn(updateQuote),
        },
        $transaction: jest.fn((callback: any) => callback(tx)),
      };
      const service = new QuotesService(prisma);

      await service.updateQuote('quote-a', patch as any, tenantAUser);
      expect(quote).toEqual(expect.objectContaining(expected));
      await service.updateStatus('quote-a', 'sent', tenantAUser);
      expect(quote.status).toBe('sent');
      const order = await service.convertToOrder('quote-a', tenantAUser);

      expect(quote.status).toBe('accepted');
      expect(quote).toEqual(expect.objectContaining(expected));
      expect(order.totalAmount).toBe(String(expected.totalAmount));
      expect(createdOrderData.totalAmount).toBe(quote.totalAmount);
    },
  );

  it('rejects a discount above the final subtotal before the draft CAS', async () => {
    const tx: any = {
      quote: {
        findFirst: jest.fn().mockResolvedValue({
          id: 'quote-a',
          status: 'draft',
          leadId: null,
          conversationId: null,
          discount: 0,
          taxRate: 0,
        }),
        updateMany: jest.fn(),
      },
      quoteLineItem: {
        findMany: jest.fn().mockResolvedValue([{ totalPrice: 10 }]),
      },
    };
    const prisma: any = {
      $transaction: jest.fn((callback: any) => callback(tx)),
    };
    const service = new QuotesService(prisma);

    await expect(service.updateQuote(
      'quote-a',
      { discount: 10.01 },
      tenantAUser,
    )).rejects.toBeInstanceOf(BadRequestException);
    expect(tx.quote.updateMany).not.toHaveBeenCalled();
  });

  it('uses one rounded pricing formula for calculate and line-item mutations', async () => {
    const quote: any = {
      id: 'quote-a',
      companyId: 'tenant-a',
      assignedUserId: 'sales-a',
      status: 'draft',
      discount: 10,
      taxRate: 7.25,
      sampleFee: 2,
      moldFee: 1,
      subtotal: 0,
      taxAmount: 0,
      totalAmount: 0,
    };
    const items: any[] = [
      {
        id: 'item-1',
        quoteId: 'quote-a',
        quantity: 1,
        unitPrice: 60,
        totalPrice: 60,
      },
      {
        id: 'item-2',
        quoteId: 'quote-a',
        quantity: 1,
        unitPrice: 40,
        totalPrice: 40,
      },
    ];
    const tx: any = {
      quote: {
        findFirst: jest.fn(({ where }: any) => {
          if (where.status && where.status !== quote.status) {
            return Promise.resolve(null);
          }
          return Promise.resolve({ ...quote, lineItems: [...items] });
        }),
        updateMany: jest.fn(({ where, data }: any) => {
          if (where.status !== quote.status) {
            return Promise.resolve({ count: 0 });
          }
          Object.assign(quote, data);
          return Promise.resolve({ count: 1 });
        }),
      },
      quoteLineItem: {
        count: jest.fn().mockImplementation(() =>
          Promise.resolve(items.length)),
        create: jest.fn(({ data }: any) => {
          const item = { id: `item-${items.length + 1}`, ...data };
          items.push(item);
          return Promise.resolve(item);
        }),
        findMany: jest.fn().mockImplementation(() =>
          Promise.resolve(items.map(({ totalPrice }) => ({ totalPrice })))),
        findFirst: jest.fn(({ where }: any) =>
          Promise.resolve(items.find((item) =>
            item.id === where.id && item.quoteId === where.quoteId) || null)),
        updateMany: jest.fn(({ where, data }: any) => {
          const item = items.find((candidate) =>
            candidate.id === where.id
            && candidate.quoteId === where.quoteId);
          if (!item) return Promise.resolve({ count: 0 });
          Object.assign(item, data);
          return Promise.resolve({ count: 1 });
        }),
        deleteMany: jest.fn(({ where }: any) => {
          const index = items.findIndex((item) =>
            item.id === where.id && item.quoteId === where.quoteId);
          if (index < 0) return Promise.resolve({ count: 0 });
          items.splice(index, 1);
          return Promise.resolve({ count: 1 });
        }),
      },
    };
    const prisma: any = {
      $transaction: jest.fn((callback: any) => callback(tx)),
    };
    const service = new QuotesService(prisma);

    await service.calculate('quote-a', tenantAUser);
    expect(quote).toEqual(expect.objectContaining({
      subtotal: 100,
      taxAmount: 6.53,
      totalAmount: 99.53,
    }));

    await service.addLineItem('quote-a', {
      productName: 'Rounded item',
      quantity: 3,
      unitPrice: 0.335,
      totalPrice: 999,
    }, tenantAUser);
    expect(items[2].totalPrice).toBe(1.01);
    expect(quote).toEqual(expect.objectContaining({
      subtotal: 101.01,
      taxAmount: 6.6,
      totalAmount: 100.61,
    }));

    await service.updateLineItem(
      'quote-a',
      'item-1',
      { quantity: 3, unitPrice: 10.005, totalPrice: 999 },
      tenantAUser,
    );
    expect(items[0].totalPrice).toBe(30.02);
    expect(quote).toEqual(expect.objectContaining({
      subtotal: 71.03,
      taxAmount: 4.42,
      totalAmount: 68.45,
    }));

    await service.deleteLineItem('quote-a', 'item-2', tenantAUser);
    expect(quote).toEqual(expect.objectContaining({
      subtotal: 31.03,
      taxAmount: 1.52,
      totalAmount: 25.55,
    }));
  });

  it('rolls back one concurrent quote conversion on a serializable conflict', async () => {
    let version = 0;
    let committedOrders = 0;
    let arrivals = 0;
    let release!: () => void;
    const ready = new Promise<void>((resolve) => {
      release = resolve;
    });
    const prisma: any = {};
    prisma.$transaction = jest.fn(async (callback: any) => {
      const startVersion = version;
      let snapshotStatus = 'sent';
      let snapshotOrders = committedOrders;
      const tx: any = {
        quote: {
          updateMany: jest.fn(async () => {
            if (snapshotStatus !== 'sent') return { count: 0 };
            snapshotStatus = 'accepted';
            arrivals += 1;
            if (arrivals === 2) release();
            await ready;
            return { count: 1 };
          }),
          findFirst: jest.fn().mockResolvedValue({
            id: 'quote-a',
            companyId: 'tenant-a',
            leadId: null,
            conversationId: null,
            referenceNo: 'QT-1',
            currency: 'USD',
            totalAmount: 10,
            tradeTerms: null,
          }),
        },
        lead: { findFirst: jest.fn() },
        conversation: { findFirst: jest.fn() },
        order: {
          findFirst: jest.fn().mockResolvedValue(null),
          create: jest.fn(({ data }: any) => {
            snapshotOrders += 1;
            return Promise.resolve({ id: `order-${snapshotOrders}`, ...data });
          }),
        },
        leadActivity: { create: jest.fn() },
      };
      const result = await callback(tx);
      if (version !== startVersion) {
        throw Object.assign(new Error('serializable conflict'), { code: 'P2034' });
      }
      committedOrders = snapshotOrders;
      version += 1;
      return result;
    });
    const service = new QuotesService(prisma);

    const results = await Promise.allSettled([
      service.convertToOrder('quote-a', tenantAUser),
      service.convertToOrder('quote-a', tenantAUser),
    ]);

    expect(results.filter((result) => result.status === 'fulfilled'))
      .toHaveLength(1);
    const rejected = results.find(
      (result) => result.status === 'rejected',
    ) as PromiseRejectedResult;
    expect(rejected.reason).toBeInstanceOf(ConflictException);
    expect(committedOrders).toBe(1);
  });
});
