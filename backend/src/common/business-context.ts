export const DEFAULT_BUSINESS_BRAND_NAME = 'Vaysen Packaging (Vaysen包装)';
export const DEFAULT_BUSINESS_PRODUCT_FOCUS =
  'packaging products: poly mailers, kraft paper bags, garbage bags, zip-lock bags, and other customizable flexible packaging';
export const DEFAULT_TARGET_CUSTOMER_PROFILE =
  'brands, wholesalers, distributors, e-commerce sellers, retail chains, logistics companies, and procurement teams that buy customizable packaging in repeat volume';

function readText(value: unknown): string | undefined {
  const text = String(value ?? '').trim();
  return text || undefined;
}

export function isLegacyBusinessText(value: unknown): boolean {
  return /jingseyewear|opulent[_\s-]*gaze|sun\s*glasses?|eye\s*wear|surface\s*polish|fastener\s*nails/i
    .test(String(value ?? ''));
}

function readCurrentSetting(value: unknown): string | undefined {
  const text = readText(value);
  if (!text) return undefined;
  return isLegacyBusinessText(text)
    ? undefined
    : text;
}

export function resolveBusinessContext(
  env: NodeJS.ProcessEnv = process.env,
  companySettings?: Record<string, unknown> | null,
) {
  const settings = companySettings || {};
  const configuredProfiles = settings.targetCustomerProfiles;
  const targetCustomerProfile = Array.isArray(configuredProfiles)
    ? configuredProfiles.map(readCurrentSetting).filter(Boolean).join('; ')
    : readCurrentSetting(configuredProfiles);

  return {
    brandName:
      readCurrentSetting(settings.brandName)
      || readCurrentSetting(settings.companyName)
      || readText(env.BUSINESS_BRAND_NAME)
      || DEFAULT_BUSINESS_BRAND_NAME,
    productFocus:
      readCurrentSetting(settings.defaultProductFocus)
      || readCurrentSetting(settings.productFocus)
      || readCurrentSetting(settings.mainProducts)
      || readText(env.BUSINESS_PRODUCT_FOCUS)
      || DEFAULT_BUSINESS_PRODUCT_FOCUS,
    targetCustomerProfile:
      targetCustomerProfile
      || readText(env.BUSINESS_TARGET_CUSTOMER_PROFILE)
      || DEFAULT_TARGET_CUSTOMER_PROFILE,
  };
}

export function productFocusKeywords(productFocus = resolveBusinessContext().productFocus): string[] {
  return productFocus
    .replace(/^packaging products\s*:\s*/i, '')
    .split(/[,;\n]/)
    .map((value) => value.replace(/^\s*(?:and|other)\s+/i, '').trim())
    .filter(Boolean)
    .slice(0, 8);
}
