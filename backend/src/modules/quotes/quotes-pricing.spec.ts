import { QuotesService } from './quotes.service';
import catalog from '../products/data/usd-price-catalog.json';

describe('QuotesService catalog pricing', () => {
  it('ignores a tampered frontend unit/total price and persists the catalog snapshot', async () => {
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
      lineItems: [{
        catalogItemId: item.catalogItemId,
        productName: 'tampered',
        quantity: 1000,
        unitPrice: 999,
        totalPrice: 1,
      }],
    }, { id: 'user-1', companies: [{ id: 'company-1' }] });

    const saved = createdData.lineItems.create[0];
    expect(saved.unitPrice).toBe(item.saleUsd);
    expect(saved.totalPrice).toBe(Number((item.saleUsd * 1000).toFixed(2)));
    expect(saved.costPriceCny).toBe(item.costCny);
    expect(saved.priceVersion).toBe(catalog.priceVersion);
    expect(result.totalAmount).toBe(saved.totalPrice);
  });
});
