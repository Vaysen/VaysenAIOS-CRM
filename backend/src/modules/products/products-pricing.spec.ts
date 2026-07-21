import { ForbiddenException } from '@nestjs/common';
import { ProductsService } from './products.service';
import catalog from './data/usd-price-catalog.json';

describe('USD pricing catalog', () => {
  const service = new ProductsService({} as any);
  const user = { currentCompany: { id: 'company-1' } };

  it('ships only synthetic zero-price rows and requires human approval', () => {
    const result = service.searchUsdPricingCatalog(user, '', 100);
    expect(result.data).toHaveLength(2);
    expect(result.priceVersion).toBe('demo-usd-v1');
    expect(result.pricingPolicy).toMatchObject({
      sourceCurrency: 'USD',
      quoteCurrency: 'USD',
      markup: 1,
      requiresHumanApproval: true,
    });
    expect(result.data.every((item) => item.costCny === 0 && item.saleUsd === 0)).toBe(true);
  });

  it('does not expose a private price through the public catalog', () => {
    for (const item of catalog.items) {
      expect(item.costCny).toBe(0);
      expect(item.saleUsd).toBe(0);
    }
  });

  it('fails closed without a company context', () => {
    expect(() => service.searchUsdPricingCatalog({}, '', 10)).toThrow(ForbiddenException);
  });
});
