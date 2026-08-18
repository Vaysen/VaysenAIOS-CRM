import {
  DEFAULT_BUSINESS_BRAND_NAME,
  DEFAULT_BUSINESS_PRODUCT_FOCUS,
  DEFAULT_TARGET_CUSTOMER_PROFILE,
  productFocusKeywords,
  resolveBusinessContext,
} from './business-context';

describe('business context', () => {
  it('defaults every AI business entry point to Vaysen Packaging', () => {
    const context = resolveBusinessContext({});
    expect(context).toEqual({
      brandName: DEFAULT_BUSINESS_BRAND_NAME,
      productFocus: DEFAULT_BUSINESS_PRODUCT_FOCUS,
      targetCustomerProfile: DEFAULT_TARGET_CUSTOMER_PROFILE,
    });
    expect(JSON.stringify(context)).not.toMatch(/jingseyewear|sunglasses|eyewear/i);
  });

  it('honours environment configuration and company-level overrides', () => {
    expect(resolveBusinessContext({
      BUSINESS_BRAND_NAME: 'Configured Brand',
      BUSINESS_PRODUCT_FOCUS: 'compostable shipping mailers',
      BUSINESS_TARGET_CUSTOMER_PROFILE: 'subscription retailers',
    })).toMatchObject({
      brandName: 'Configured Brand',
      productFocus: 'compostable shipping mailers',
      targetCustomerProfile: 'subscription retailers',
    });

    expect(resolveBusinessContext({}, {
      brandName: 'Workspace Brand',
      defaultProductFocus: 'custom kraft bags',
      targetCustomerProfiles: ['coffee roasters', 'gift wholesalers'],
    })).toMatchObject({
      brandName: 'Workspace Brand',
      productFocus: 'custom kraft bags',
      targetCustomerProfile: 'coffee roasters; gift wholesalers',
    });
  });

  it('does not let stale industry settings override the packaging environment', () => {
    const context = resolveBusinessContext({
      BUSINESS_BRAND_NAME: 'Vaysen Packaging',
      BUSINESS_PRODUCT_FOCUS: 'custom recyclable mailers',
      BUSINESS_TARGET_CUSTOMER_PROFILE: 'e-commerce packaging buyers',
    }, {
      brandName: 'Jingseyewear',
      defaultProductFocus: 'premium sunglasses and eyewear',
      targetCustomerProfiles: ['sports eyewear brands'],
    });

    expect(context).toEqual({
      brandName: 'Vaysen Packaging',
      productFocus: 'custom recyclable mailers',
      targetCustomerProfile: 'e-commerce packaging buyers',
    });
  });

  it('turns the configured product focus into safe default search keywords', () => {
    expect(productFocusKeywords('packaging products: poly mailers, kraft bags, and zip-lock bags'))
      .toEqual(['poly mailers', 'kraft bags', 'zip-lock bags']);
  });
});
