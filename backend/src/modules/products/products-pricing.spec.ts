import { ForbiddenException } from '@nestjs/common';
import { ProductsService } from './products.service';
import catalog from './data/usd-price-catalog.json';

describe('USD pricing catalog', () => {
  const service = new ProductsService({} as any);
  const user = {
    activeCompanyId: 'company-1',
    activeCompany: { id: 'company-1', name: 'company-1', role: 'sales_user' },
    companies: [{ id: 'company-1', name: 'company-1', role: 'sales_user' }],
  };

  it('contains the 168 approved master-price rows with an auditable policy', () => {
    const result = service.searchUsdPricingCatalog(user, '', 168);
    expect(result.data).toHaveLength(168);
    expect(result.priceVersion).toBe('jym-usd-2026-05-31-v1');
    expect(result.pricingPolicy).toMatchObject({ sourceCurrency: 'CNY', quoteCurrency: 'USD', markup: 1.5 });
  });

  it('keeps the published USD amount consistent with the documented protected-rate formula', () => {
    for (const item of catalog.items) {
      const calculated = Number(((item.costCny * 1.5) / 6.5).toFixed(3));
      expect(Math.abs(item.saleUsd - calculated)).toBeLessThanOrEqual(0.001);
    }
  });

  it('fails closed without a company context', () => {
    expect(() => service.searchUsdPricingCatalog({}, '', 10)).toThrow(ForbiddenException);
  });
});
