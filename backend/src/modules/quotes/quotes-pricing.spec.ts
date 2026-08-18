import { QuotesService } from './quotes.service';
import { Logger } from '@nestjs/common';
import catalog from '../products/data/usd-price-catalog.json';

describe('QuotesService catalog pricing', () => {
  it('ignores a tampered frontend unit/total price and persists the catalog snapshot', async () => {
    const loggerLog = jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    let createdData: any;
    const tx = {
      quote: { create: jest.fn(async ({ data }) => {
        createdData = data;
        return { id: 'quote-1', ...data, lineItems: data.lineItems.create };
      }) },
    };
    const prisma = { $transaction: jest.fn(async (callback) => callback(tx)) } as any;
    const service = new QuotesService(prisma);
    const item = catalog.items[0];

    const result = await service.createQuote({
      currency: 'USD',
      referenceNo: 'QT-SENTINEL-REF',
      sampleFee: 2.5,
      moldFee: 1.25,
      lineItems: [{
        catalogItemId: item.catalogItemId,
        productName: 'tampered',
        quantity: 1000,
        unitPrice: 999,
        totalPrice: 1,
      }],
    }, {
      id: 'user-1',
      activeCompanyId: 'company-1',
      activeCompany: { id: 'company-1', name: 'company-1', role: 'sales_user' },
      companies: [{ id: 'company-1', name: 'company-1', role: 'sales_user' }],
    });

    const saved = createdData.lineItems.create[0];
    expect(saved.unitPrice).toBe(item.saleUsd);
    expect(saved.totalPrice).toBe(Number((item.saleUsd * 1000).toFixed(2)));
    expect(saved.costPriceCny).toBe(item.costCny);
    expect(saved.priceVersion).toBe(catalog.priceVersion);
    expect(createdData.sampleFee).toBe(2.5);
    expect(createdData.moldFee).toBe(1.25);
    expect(result.totalAmount).toBe(Number((saved.totalPrice + 2.5 + 1.25).toFixed(2)));
    const output = loggerLog.mock.calls.map(([message]) => String(message)).join('\n');
    expect(output).toContain('quote.created');
    expect(output).toContain('"count":1');
    expect(output).not.toContain('QT-SENTINEL-REF');
    expect(output).not.toContain('quote-1');
    expect(output).not.toContain('company-1');
    expect(output).not.toContain('user-1');
  });
});
