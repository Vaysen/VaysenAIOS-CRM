import { QuotesService } from './quotes.service';

const user = {
  id: 'sales-1',
  activeCompanyId: 'company-1',
  activeCompany: { id: 'company-1', role: 'sales_user' },
  companies: [{ id: 'company-1', role: 'sales_user' }],
};

function quoteFixture(overrides: Record<string, unknown> = {}) {
  return {
    id: 'quote-1',
    companyId: 'company-1',
    assignedUserId: 'sales-1',
    referenceNo: 'QT-2026-001',
    type: 'quote',
    status: 'draft',
    leadId: 'lead-1',
    conversationId: 'conversation-1',
    currency: 'USD',
    tradeTerms: 'FOB Shenzhen',
    paymentTerms: 'T/T 30%',
    deliveryTime: '20 days',
    sampleFee: '5.00',
    moldFee: '3.00',
    discount: '2.00',
    taxRate: '0',
    subtotal: '123.45',
    taxAmount: '0',
    totalAmount: '129.45',
    notes: 'Internal quote note',
    validUntil: new Date('2026-08-31T00:00:00.000Z'),
    createdAt: new Date('2026-08-01T10:00:00.000Z'),
    updatedAt: new Date('2026-08-02T10:00:00.000Z'),
    lineItems: [{
      id: 'line-1',
      productCode: 'BAG-001',
      productName: 'Paper Bag',
      material: 'Kraft',
      size: '30x40cm',
      thickness: '180gsm',
      color: 'Brown',
      printing: '1 color',
      quantity: 1000,
      unit: 'pcs',
      unitPrice: '0.1234',
      totalPrice: '123.40',
      productSpecId: 'spec-1',
      catalogItemId: 'catalog-1',
      notes: null,
    }],
    lead: {
      id: 'lead-1',
      companyName: 'Buyer Company',
      contactName: 'Buyer',
      country: 'US',
      contactEmail: 'buyer@example.com',
    },
    ...overrides,
  };
}

describe('Quote structured read contracts', () => {
  it('projects list responses without tenant fields, notes, contact email, or outputContent', async () => {
    const prisma: any = {
      quote: {
        findMany: jest.fn().mockResolvedValue([quoteFixture()]),
        count: jest.fn().mockResolvedValue(1),
      },
    };
    const service = new QuotesService(prisma);

    const result = await service.findAll(user, { page: 1, limit: 20 });
    const item = result.data[0];

    expect(item).toMatchObject({
      id: 'quote-1',
      referenceNo: 'QT-2026-001',
      type: 'quote',
      status: 'draft',
      leadId: 'lead-1',
      totalAmount: '129.45',
      itemCount: 1,
      createdAt: '2026-08-01T10:00:00.000Z',
      lead: { id: 'lead-1', companyName: 'Buyer Company', contactName: 'Buyer', country: 'US' },
    });
    expect(item).not.toHaveProperty('companyId');
    expect(item).not.toHaveProperty('assignedUserId');
    expect(item).not.toHaveProperty('notes');
    expect(item).not.toHaveProperty('outputContent');
    expect(item.lead).not.toHaveProperty('contactEmail');
    expect(result.meta).toEqual({ page: 1, limit: 20, total: 1, totalPages: 1 });
  });

  it('projects detail responses with ISO dates, string money, terms, and ordered line items', async () => {
    const prisma: any = { quote: { findFirst: jest.fn().mockResolvedValue(quoteFixture()) } };
    const service = new QuotesService(prisma);

    const result = await service.findOne('quote-1', user);

    expect(result).toMatchObject({
      referenceNo: 'QT-2026-001',
      conversationId: 'conversation-1',
      totalAmount: '129.45',
      subtotal: '123.45',
      tradeTerms: 'FOB Shenzhen',
      paymentTerms: 'T/T 30%',
      deliveryTime: '20 days',
      sampleFee: '5.00',
      moldFee: '3.00',
      validUntil: '2026-08-31T00:00:00.000Z',
      lineItems: [{ id: 'line-1', productName: 'Paper Bag', unitPrice: '0.1234', totalPrice: '123.40' }],
    });
    expect(result).not.toHaveProperty('companyId');
    expect(result).not.toHaveProperty('assignedUserId');
    expect(result).not.toHaveProperty('notes');
    expect(result).not.toHaveProperty('outputContent');
    expect(result.lead).not.toHaveProperty('contactEmail');
  });

  it('returns a lead-history projection with line items and preserves query ordering', async () => {
    const lead = { id: 'lead-1' };
    const prisma: any = {
      lead: { findFirst: jest.fn().mockResolvedValue(lead) },
      quote: { findMany: jest.fn().mockResolvedValue([quoteFixture()]) },
    };
    const service = new QuotesService(prisma);

    const result = await service.listByLead('lead-1', user);

    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ referenceNo: 'QT-2026-001', totalAmount: '129.45', itemCount: 1, lineItems: [{ id: 'line-1' }] });
    expect(result[0]).not.toHaveProperty('companyId');
    expect(result[0]).not.toHaveProperty('assignedUserId');
    expect(result[0]).not.toHaveProperty('outputContent');
    expect(prisma.quote.findMany).toHaveBeenCalledWith(expect.objectContaining({
      include: { lineItems: { orderBy: { sortOrder: 'asc' } } },
    }));
  });

  it('keeps rendering-only quote notes available to the authenticated PI HTML path', async () => {
    const prisma: any = { quote: { findFirst: jest.fn().mockResolvedValue(quoteFixture()) } };
    const service = new QuotesService(prisma);

    const html = await service.generatePiHtml('quote-1', user);

    expect(html).toContain('Internal quote note');
    expect(html).toContain('Sample Fee: USD 5.00');
    expect(html).toContain('Mold Fee: USD 3.00');
    expect(prisma.quote.findFirst).toHaveBeenCalledWith(expect.objectContaining({
      include: expect.objectContaining({
        lead: { select: expect.objectContaining({ contactEmail: true }) },
      }),
    }));
  });
});
