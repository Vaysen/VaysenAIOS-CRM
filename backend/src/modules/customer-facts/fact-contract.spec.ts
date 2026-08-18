import {
  BUSINESS_MODEL_ALLOWLIST,
  FACT_KEYS,
  INDUSTRY_ALLOWLIST,
  ISO_3166_1_COUNTRY_CODES,
  MAX_LIST_ITEM_LENGTH,
  MAX_LIST_ITEMS,
  MAX_TEXT_LENGTH,
  validateAndNormalizeFactValue,
} from './fact-contract';

const envelope = (type: string, value: unknown): Record<string, unknown> => ({ schemaVersion: 1, type, value });

function expectError(result: ReturnType<typeof validateAndNormalizeFactValue>, code: string, message: string): void {
  expect(result).toEqual({ ok: false, error: { code, message } });
}

describe('CustomerFact V1 key registry', () => {
  it('freezes exactly the ten non-PII V1 keys', () => {
    expect(FACT_KEYS).toEqual([
      'identity.company_name',
      'identity.website_url',
      'identity.country_code',
      'identity.city',
      'company.industry',
      'company.year_established',
      'company.employee_count_range',
      'company.product_categories',
      'company.business_model',
      'company.certification_claims',
    ]);
    expect(FACT_KEYS.join('|')).not.toMatch(/email|phone|account|credential|password|token/i);
    expect(INDUSTRY_ALLOWLIST).toContain('packaging');
    expect(BUSINESS_MODEL_ALLOWLIST).toContain('manufacturer');
    for (const allowlist of [FACT_KEYS, INDUSTRY_ALLOWLIST, BUSINESS_MODEL_ALLOWLIST, ISO_3166_1_COUNTRY_CODES]) {
      expect(Object.isFrozen(allowlist)).toBe(true);
      expect(Object.isExtensible(allowlist)).toBe(false);
    }
    expect(ISO_3166_1_COUNTRY_CODES).not.toBeInstanceOf(Set);
    expect(() => (FACT_KEYS as unknown as string[]).push('identity.forbidden')).toThrow(TypeError);
    expect(() => (ISO_3166_1_COUNTRY_CODES as unknown as string[]).push('ZZ')).toThrow(TypeError);
  });
});

describe('validateAndNormalizeFactValue', () => {
  it('normalizes every first-wave fact type into a deterministic envelope', () => {
    expect(validateAndNormalizeFactValue('identity.company_name', envelope('TEXT', ' e\u0301xample '))).toEqual({
      ok: true,
      value: { schemaVersion: 1, type: 'TEXT', value: 'éxample', normalized: 'éxample' },
    });
    expect(validateAndNormalizeFactValue('identity.website_url', envelope('URL', 'HTTPS://Example.COM/path#fragment'))).toEqual({
      ok: true,
      value: { schemaVersion: 1, type: 'URL', value: 'https://example.com/path', normalized: 'https://example.com/path' },
    });
    expect(validateAndNormalizeFactValue('identity.country_code', envelope('COUNTRY_CODE', ' cn '))).toEqual({
      ok: true,
      value: { schemaVersion: 1, type: 'COUNTRY_CODE', value: 'CN', normalized: 'CN' },
    });
    expect(validateAndNormalizeFactValue('identity.city', envelope('TEXT', ' München '))).toEqual({
      ok: true,
      value: { schemaVersion: 1, type: 'TEXT', value: 'München', normalized: 'münchen' },
    });
    expect(validateAndNormalizeFactValue('company.industry', envelope('ENUM', 'Packaging'))).toEqual({
      ok: true,
      value: { schemaVersion: 1, type: 'ENUM', value: 'packaging', codeSetVersion: 'industry-v1' },
    });
    expect(validateAndNormalizeFactValue('company.year_established', envelope('INTEGER', 1998))).toEqual({
      ok: true,
      value: { schemaVersion: 1, type: 'INTEGER', value: 1998 },
    });
    expect(validateAndNormalizeFactValue('company.employee_count_range', { schemaVersion: 1, type: 'INTEGER_RANGE', min: 10, max: 100 })).toEqual({
      ok: true,
      value: { schemaVersion: 1, type: 'INTEGER_RANGE', min: 10, max: 100 },
    });
    expect(validateAndNormalizeFactValue('company.business_model', envelope('ENUM', 'Contract Manufacturer'))).toEqual({
      ok: true,
      value: { schemaVersion: 1, type: 'ENUM', value: 'contract_manufacturer', codeSetVersion: 'business-model-v1' },
    });
  });

  it('deduplicates lists case-insensitively, trims, NFC-normalizes, and sorts stably', () => {
    expect(validateAndNormalizeFactValue('company.product_categories', envelope('TEXT_LIST', [
      'Beta', ' alpha ', ' beta ', 'ALPHA', 'Gamm\u0061', 'e\u0301clair', 'éclair',
    ]))).toEqual({
      ok: true,
      value: {
        schemaVersion: 1,
        type: 'TEXT_LIST',
        value: ['ALPHA', 'Beta', 'Gamma', 'éclair'],
        normalized: ['alpha', 'beta', 'gamma', 'éclair'],
      },
    });
  });

  it('enforces the 128-code-point list item limit', () => {
    const acceptedItem = 'é'.repeat(MAX_LIST_ITEM_LENGTH);
    expect(validateAndNormalizeFactValue('company.product_categories', envelope('TEXT_LIST', [acceptedItem]))).toEqual({
      ok: true,
      value: {
        schemaVersion: 1,
        type: 'TEXT_LIST',
        value: [acceptedItem],
        normalized: [acceptedItem],
      },
    });
    expectError(
      validateAndNormalizeFactValue('company.product_categories', envelope('TEXT_LIST', ['é'.repeat(MAX_LIST_ITEM_LENGTH + 1)])),
      'LIST_ITEM_TOO_LONG',
      'list item exceeds the maximum length',
    );
  });

  it('marks certification claims as public claims rather than verified facts', () => {
    const result = validateAndNormalizeFactValue('company.certification_claims', envelope('TEXT_LIST', ['ISO 9001 certified']));
    expect(result).toEqual({
      ok: true,
      value: {
        schemaVersion: 1,
        type: 'TEXT_LIST',
        value: ['ISO 9001 certified'],
        normalized: ['iso 9001 certified'],
        semantic: 'PUBLIC_CLAIM_ONLY',
      },
    });
    expect(JSON.stringify(result)).not.toContain('verified');
  });

  it('rejects unknown, PII, missing-version, and mismatched-type inputs without echoing values', () => {
    expectError(
      validateAndNormalizeFactValue('company.unknown', envelope('TEXT', 'secret customer text')),
      'UNKNOWN_FACT_KEY',
      'fact key is not registered',
    );
    expectError(
      validateAndNormalizeFactValue('identity.contact_email', envelope('TEXT', 'person@example.invalid')),
      'PII_FACT_KEY',
      'PII fact keys are not allowed',
    );
    expectError(
      validateAndNormalizeFactValue('identity.company_name', envelope('INTEGER', 1)),
      'TYPE_MISMATCH',
      'value envelope type does not match fact contract',
    );
    expectError(
      validateAndNormalizeFactValue('identity.company_name', { type: 'TEXT', value: 'not-versioned' }),
      'UNSUPPORTED_ENVELOPE',
      'value envelope is unsupported',
    );
    const rejected = validateAndNormalizeFactValue('identity.website_url', envelope('URL', 'https://example.invalid/?api_key=do-not-echo'));
    expect(JSON.stringify(rejected)).not.toContain('do-not-echo');
  });

  it.each(['id', 'page', 'monkey', 'authentic', 'accessibility'])('allows ordinary query key %s', (queryKey) => {
    const result = validateAndNormalizeFactValue('identity.website_url', envelope('URL', `https://example.invalid/?${queryKey}=fixture`));
    expect(result.ok).toBe(true);
  });

  it.each([
    'token', 'key', 'secret', 'auth', 'authorization', 'password', 'passwd', 'signature', 'sig',
    'api_key', 'api-key', 'access_token', 'client_secret', 'auth_token', 'api_token', 'private_key',
  ])('rejects exact credential query key %s without echoing the value', (queryKey) => {
    const result = validateAndNormalizeFactValue('identity.website_url', envelope('URL', `https://example.invalid/?${queryKey}=fixture-secret`));
    expectError(result, 'URL_CREDENTIAL_QUERY_FORBIDDEN', 'URL query contains a credential-like key');
    expect(JSON.stringify(result)).not.toContain('fixture-secret');
  });

  it('rejects unknown envelope fields by type instead of silently ignoring metadata', () => {
    expectError(
      validateAndNormalizeFactValue('identity.company_name', { schemaVersion: 1, type: 'TEXT', value: 'Example', metadata: { key: 'fixture' } }),
      'UNSUPPORTED_ENVELOPE',
      'value envelope is unsupported',
    );
    expectError(
      validateAndNormalizeFactValue('company.employee_count_range', { schemaVersion: 1, type: 'INTEGER_RANGE', min: 1, metadata: { token: 'fixture' } }),
      'UNSUPPORTED_ENVELOPE',
      'value envelope is unsupported',
    );
  });

  it('rejects empty, overlong, and over-deep values fail closed', () => {
    expectError(
      validateAndNormalizeFactValue('identity.city', envelope('TEXT', '   ')),
      'EMPTY_VALUE',
      'value must not be empty',
    );
    expectError(
      validateAndNormalizeFactValue('identity.company_name', envelope('TEXT', 'x'.repeat(MAX_TEXT_LENGTH + 1))),
      'TEXT_TOO_LONG',
      'text value exceeds the maximum length',
    );
    expectError(
      validateAndNormalizeFactValue('company.product_categories', envelope('TEXT_LIST', Array.from({ length: MAX_LIST_ITEMS + 1 }, (_, index) => `item-${index}`))),
      'LIST_TOO_LONG',
      'list exceeds the maximum item count',
    );
    const deep: unknown[] = ['leaf'];
    for (let index = 0; index < 6; index += 1) {
      deep[0] = [deep[0]];
    }
    expectError(
      validateAndNormalizeFactValue('company.product_categories', envelope('TEXT_LIST', deep)),
      'DEPTH_EXCEEDED',
      'value envelope exceeds the maximum depth',
    );
  });

  it('rejects credential-like URLs, URL userinfo, unsupported schemes, and oversized URLs', () => {
    expectError(
      validateAndNormalizeFactValue('identity.website_url', envelope('URL', 'https://user:password@example.invalid/')),
      'URL_USERINFO_FORBIDDEN',
      'URL userinfo is not allowed',
    );
    expectError(
      validateAndNormalizeFactValue('identity.website_url', envelope('URL', 'https://example.invalid/?access_token=redacted')),
      'URL_CREDENTIAL_QUERY_FORBIDDEN',
      'URL query contains a credential-like key',
    );
    expectError(
      validateAndNormalizeFactValue('identity.website_url', envelope('URL', 'ftp://example.invalid/')),
      'URL_INVALID',
      'URL is invalid or uses an unsupported scheme',
    );
    expectError(
      validateAndNormalizeFactValue('identity.website_url', envelope('URL', `https://example.invalid/${'x'.repeat(2_050)}`)),
      'URL_TOO_LONG',
      'URL exceeds the maximum length',
    );
  });

  it('enforces country, enum, year, and range boundaries', () => {
    expectError(
      validateAndNormalizeFactValue('identity.country_code', envelope('COUNTRY_CODE', 'ZZZ')),
      'COUNTRY_CODE_INVALID',
      'country code is not in the ISO allowlist',
    );
    expectError(
      validateAndNormalizeFactValue('company.industry', envelope('ENUM', 'unregistered-industry')),
      'ENUM_VALUE_INVALID',
      'enum value is not in the frozen allowlist',
    );
    expectError(
      validateAndNormalizeFactValue('company.year_established', envelope('INTEGER', 999)),
      'YEAR_OUT_OF_RANGE',
      'established year is outside the allowed range',
    );
    expectError(
      validateAndNormalizeFactValue('company.year_established', envelope('INTEGER', 2101)),
      'YEAR_OUT_OF_RANGE',
      'established year is outside the allowed range',
    );
    expectError(
      validateAndNormalizeFactValue('company.employee_count_range', { schemaVersion: 1, type: 'INTEGER_RANGE' }),
      'RANGE_EMPTY',
      'range must contain a minimum or maximum',
    );
    expectError(
      validateAndNormalizeFactValue('company.employee_count_range', { schemaVersion: 1, type: 'INTEGER_RANGE', min: 100, max: 10 }),
      'RANGE_ORDER_INVALID',
      'range minimum must not exceed maximum',
    );
    expectError(
      validateAndNormalizeFactValue('company.employee_count_range', { schemaVersion: 1, type: 'INTEGER_RANGE', min: -1 }),
      'RANGE_BOUND_INVALID',
      'range bound is invalid',
    );
  });

  it('returns JSON-safe values and stable errors without input-dependent text', () => {
    const range = validateAndNormalizeFactValue('company.employee_count_range', { schemaVersion: 1, type: 'INTEGER_RANGE', max: 0 });
    expect(range.ok).toBe(true);
    expect(JSON.parse(JSON.stringify(range))).toEqual(range);
    const error = validateAndNormalizeFactValue('identity.website_url', envelope('URL', 'https://example.invalid/?signature=fixture-only'));
    expect(error).toEqual({
      ok: false,
      error: { code: 'URL_CREDENTIAL_QUERY_FORBIDDEN', message: 'URL query contains a credential-like key' },
    });
    expect(JSON.stringify(error)).not.toContain('fixture-only');
  });
});
