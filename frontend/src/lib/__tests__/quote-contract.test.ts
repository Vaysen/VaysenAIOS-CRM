import {
  formatQuoteAmount,
  formatQuoteDate,
  toQuoteCreateLineItem,
  calculateQuotePreviewTotals,
  type QuoteListResponse,
} from '@/types/quote';

const fixture: QuoteListResponse = {
  data: [{
    id: 'quote-1',
    referenceNo: 'QT-2026-001',
    type: 'quote',
    status: 'draft',
    leadId: 'lead-1',
    opportunity: null,
    currency: 'USD',
    totalAmount: '121.45',
    itemCount: 1,
    createdAt: '2026-08-01T10:00:00.000Z',
    updatedAt: '2026-08-02T10:00:00.000Z',
    lead: { id: 'lead-1', companyName: 'Buyer Company', contactName: 'Buyer', country: 'US' },
  }],
  meta: { page: 1, limit: 20, total: 1, totalPages: 1 },
};

describe('Quote structured frontend contract', () => {
  it('accepts a JSON-safe fixture without outputContent and keeps key fields typed', () => {
    expect(fixture.data[0]).toMatchObject({ referenceNo: 'QT-2026-001', totalAmount: '121.45', itemCount: 1 });
    expect(fixture.data[0]).not.toHaveProperty('outputContent');
    expect(fixture.data[0].createdAt).toBe('2026-08-01T10:00:00.000Z');
  });

  it('converts Decimal strings and ISO dates for display', () => {
    expect(formatQuoteAmount(fixture.data[0].totalAmount, fixture.data[0].currency)).toBe('USD 121.45');
    expect(formatQuoteDate(fixture.data[0].createdAt)).toBe(new Date('2026-08-01T10:00:00.000Z').toLocaleDateString('zh-CN'));
  });

  it('copies line items without sending read-only line-item ids', () => {
    const input = toQuoteCreateLineItem({
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
    });

    expect(input).toMatchObject({ productName: 'Paper Bag', quantity: 1000, unitPrice: 0.1234, totalPrice: 123.4 });
    expect(input).not.toHaveProperty('id');
  });

  it('uses the shared packaging-fee formula and treats legacy null fees as zero', () => {
    expect(calculateQuotePreviewTotals([100, 50], 10, 7.25, '2.50', '1.25'))
      .toMatchObject({ subtotal: 150, taxableAmount: 140, taxAmount: 10.15, totalAmount: 153.9 });
    expect(calculateQuotePreviewTotals([100], 0, 0, null, undefined).totalAmount).toBe(100);
  });
});
