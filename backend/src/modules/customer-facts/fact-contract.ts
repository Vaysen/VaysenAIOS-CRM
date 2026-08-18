/**
 * CRM-04A-1: pure CustomerFact key/value contract.
 *
 * This module deliberately has no Nest, Prisma, filesystem, network, or clock
 * dependency. It accepts a versioned input envelope and returns either a
 * deterministic JSON-safe normalized envelope or a stable, non-echoing error.
 */

export const FACT_KEYS = Object.freeze([
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
] as const);

export type FactKey = (typeof FACT_KEYS)[number];

export type FactValueType =
  | 'TEXT'
  | 'URL'
  | 'COUNTRY_CODE'
  | 'INTEGER'
  | 'ENUM'
  | 'TEXT_LIST'
  | 'INTEGER_RANGE';

export const INDUSTRY_ALLOWLIST = Object.freeze([
  'apparel',
  'automotive',
  'chemicals',
  'construction',
  'consumer_goods',
  'electronics',
  'food_beverage',
  'furniture',
  'healthcare',
  'industrial_equipment',
  'logistics',
  'machinery',
  'packaging',
  'pharmaceuticals',
  'retail',
  'textiles',
  'other',
] as const);

export const BUSINESS_MODEL_ALLOWLIST = Object.freeze([
  'brand_owner',
  'contract_manufacturer',
  'distributor',
  'ecommerce',
  'exporter',
  'importer',
  'manufacturer',
  'other',
  'retailer',
  'service_provider',
  'wholesaler',
] as const);

export type IndustryCode = (typeof INDUSTRY_ALLOWLIST)[number];
export type BusinessModelCode = (typeof BUSINESS_MODEL_ALLOWLIST)[number];

/**
 * The repository has no authoritative country-code module. Keep this
 * explicit ISO 3166-1 alpha-2 + alpha-3 allowlist local and reviewable rather
 * than accepting arbitrary two/three-letter strings.
 */
export const ISO_3166_1_COUNTRY_CODES = Object.freeze([
  'AF', 'AFG', 'AL', 'ALB', 'DZ', 'DZA', 'AS', 'ASM', 'AD', 'AND', 'AO', 'AGO', 'AI', 'AIA', 'AQ', 'ATA',
  'AG', 'ATG', 'AR', 'ARG', 'AM', 'ARM', 'AW', 'ABW', 'AU', 'AUS', 'AT', 'AUT', 'AZ', 'AZE', 'BS', 'BHS',
  'BH', 'BHR', 'BD', 'BGD', 'BB', 'BRB', 'BY', 'BLR', 'BE', 'BEL', 'BZ', 'BLZ', 'BJ', 'BEN', 'BM', 'BMU',
  'BT', 'BTN', 'BO', 'BOL', 'BQ', 'BES', 'BA', 'BIH', 'BW', 'BWA', 'BV', 'BVT', 'BR', 'BRA', 'IO', 'IOT',
  'BN', 'BRN', 'BG', 'BGR', 'BF', 'BFA', 'BI', 'BDI', 'CV', 'CPV', 'KH', 'KHM', 'CM', 'CMR', 'CA', 'CAN',
  'KY', 'CYM', 'CF', 'CAF', 'TD', 'TCD', 'CL', 'CHL', 'CN', 'CHN', 'CX', 'CXR', 'CC', 'CCK', 'CO', 'COL',
  'KM', 'COM', 'CG', 'COG', 'CD', 'COD', 'CK', 'COK', 'CR', 'CRI', 'CI', 'CIV', 'HR', 'HRV', 'CU', 'CUB',
  'CW', 'CUW', 'CY', 'CYP', 'CZ', 'CZE', 'DK', 'DNK', 'DJ', 'DJI', 'DM', 'DMA', 'DO', 'DOM', 'EC', 'ECU',
  'EG', 'EGY', 'SV', 'SLV', 'GQ', 'GNQ', 'ER', 'ERI', 'EE', 'EST', 'SZ', 'SWZ', 'ET', 'ETH', 'FK', 'FLK',
  'FO', 'FRO', 'FJ', 'FJI', 'FI', 'FIN', 'FR', 'FRA', 'GF', 'GUF', 'PF', 'PYF', 'TF', 'ATF', 'GA', 'GAB',
  'GM', 'GMB', 'GE', 'GEO', 'DE', 'DEU', 'GH', 'GHA', 'GI', 'GIB', 'GR', 'GRC', 'GL', 'GRL', 'GD', 'GRD',
  'GP', 'GLP', 'GU', 'GUM', 'GT', 'GTM', 'GG', 'GGY', 'GN', 'GIN', 'GW', 'GNB', 'GY', 'GUY', 'HT', 'HTI',
  'HM', 'HMD', 'VA', 'VAT', 'HN', 'HND', 'HK', 'HKG', 'HU', 'HUN', 'IS', 'ISL', 'IN', 'IND', 'ID', 'IDN',
  'IR', 'IRN', 'IQ', 'IRQ', 'IE', 'IRL', 'IM', 'IMN', 'IL', 'ISR', 'IT', 'ITA', 'JM', 'JAM', 'JP', 'JPN',
  'JE', 'JEY', 'JO', 'JOR', 'KZ', 'KAZ', 'KE', 'KEN', 'KI', 'KIR', 'KP', 'PRK', 'KR', 'KOR', 'KW', 'KWT',
  'KG', 'KGZ', 'LA', 'LAO', 'LV', 'LVA', 'LB', 'LBN', 'LS', 'LSO', 'LR', 'LBR', 'LY', 'LBY', 'LI', 'LIE',
  'LT', 'LTU', 'LU', 'LUX', 'MO', 'MAC', 'MG', 'MDG', 'MW', 'MWI', 'MY', 'MYS', 'MV', 'MDV', 'ML', 'MLI',
  'MT', 'MLT', 'MH', 'MHL', 'MQ', 'MTQ', 'MR', 'MRT', 'MU', 'MUS', 'YT', 'MYT', 'MX', 'MEX', 'FM', 'FSM',
  'MD', 'MDA', 'MC', 'MCO', 'MN', 'MNG', 'ME', 'MNE', 'MS', 'MSR', 'MA', 'MAR', 'MZ', 'MOZ', 'MM', 'MMR',
  'NA', 'NAM', 'NR', 'NRU', 'NP', 'NPL', 'NL', 'NLD', 'NC', 'NCL', 'NZ', 'NZL', 'NI', 'NIC', 'NE', 'NER',
  'NG', 'NGA', 'NU', 'NIU', 'NF', 'NFK', 'MK', 'MKD', 'MP', 'MNP', 'NO', 'NOR', 'OM', 'OMN', 'PK', 'PAK',
  'PW', 'PLW', 'PS', 'PSE', 'PA', 'PAN', 'PG', 'PNG', 'PY', 'PRY', 'PE', 'PER', 'PH', 'PHL', 'PN', 'PCN',
  'PL', 'POL', 'PT', 'PRT', 'PR', 'PRI', 'QA', 'QAT', 'RE', 'REU', 'RO', 'ROU', 'RU', 'RUS', 'RW', 'RWA',
  'BL', 'BLM', 'SH', 'SHN', 'KN', 'KNA', 'LC', 'LCA', 'MF', 'MAF', 'PM', 'SPM', 'VC', 'VCT', 'WS', 'WSM',
  'SM', 'SMR', 'ST', 'STP', 'SA', 'SAU', 'SN', 'SEN', 'RS', 'SRB', 'SC', 'SYC', 'SL', 'SLE', 'SG', 'SGP',
  'SX', 'SXM', 'SK', 'SVK', 'SI', 'SVN', 'SB', 'SLB', 'SO', 'SOM', 'ZA', 'ZAF', 'GS', 'SGS', 'SS', 'SSD',
  'ES', 'ESP', 'LK', 'LKA', 'SD', 'SDN', 'SR', 'SUR', 'SJ', 'SJM', 'SE', 'SWE', 'CH', 'CHE', 'SY', 'SYR',
  'TW', 'TWN', 'TJ', 'TJK', 'TZ', 'TZA', 'TH', 'THA', 'TL', 'TLS', 'TG', 'TGO', 'TK', 'TKL', 'TO', 'TON',
  'TT', 'TTO', 'TN', 'TUN', 'TR', 'TUR', 'TM', 'TKM', 'TC', 'TCA', 'TV', 'TUV', 'UG', 'UGA', 'UA', 'UKR',
  'AE', 'ARE', 'GB', 'GBR', 'US', 'USA', 'UM', 'UMI', 'UY', 'URY', 'UZ', 'UZB', 'VU', 'VUT', 'VE', 'VEN',
  'VN', 'VNM', 'VG', 'VGB', 'VI', 'VIR', 'WF', 'WLF', 'EH', 'ESH', 'YE', 'YEM', 'ZM', 'ZMB', 'ZW', 'ZWE',
] as const);

const ISO_3166_1_COUNTRY_CODE_SET = new Set<string>(ISO_3166_1_COUNTRY_CODES);

export const FACT_KEY_DEFINITIONS = Object.freeze({
  'identity.company_name': { valueType: 'TEXT' },
  'identity.website_url': { valueType: 'URL' },
  'identity.country_code': { valueType: 'COUNTRY_CODE' },
  'identity.city': { valueType: 'TEXT' },
  'company.industry': { valueType: 'ENUM', codeSet: 'industry-v1' },
  'company.year_established': { valueType: 'INTEGER' },
  'company.employee_count_range': { valueType: 'INTEGER_RANGE' },
  'company.product_categories': { valueType: 'TEXT_LIST' },
  'company.business_model': { valueType: 'ENUM', codeSet: 'business-model-v1' },
  'company.certification_claims': { valueType: 'TEXT_LIST', semantic: 'PUBLIC_CLAIM_ONLY' },
} as const);

export const MAX_TEXT_LENGTH = 512;
export const MAX_URL_LENGTH = 2_048;
export const MAX_LIST_ITEMS = 64;
export const MAX_LIST_ITEM_LENGTH = 128;
export const MAX_JSON_DEPTH = 4;
export const MIN_ESTABLISHED_YEAR = 1_000;
export const MAX_ESTABLISHED_YEAR = 2_100;
export const MIN_EMPLOYEE_COUNT = 0;
export const MAX_EMPLOYEE_COUNT = 10_000_000;
export const MAX_RANGE_RAW_LENGTH = 128;

export type NormalizedFactValue =
  | Readonly<{ schemaVersion: 1; type: 'TEXT'; value: string; normalized: string }>
  | Readonly<{ schemaVersion: 1; type: 'URL'; value: string; normalized: string }>
  | Readonly<{ schemaVersion: 1; type: 'COUNTRY_CODE'; value: string; normalized: string }>
  | Readonly<{ schemaVersion: 1; type: 'INTEGER'; value: number }>
  | Readonly<{ schemaVersion: 1; type: 'ENUM'; value: string; codeSetVersion: string }>
  | Readonly<{
      schemaVersion: 1;
      type: 'TEXT_LIST';
      value: readonly string[];
      normalized: readonly string[];
      semantic?: 'PUBLIC_CLAIM_ONLY';
    }>
  | Readonly<{
      schemaVersion: 1;
      type: 'INTEGER_RANGE';
      min?: number;
      max?: number;
      raw?: string;
    }>;

export type FactContractErrorCode =
  | 'UNKNOWN_FACT_KEY'
  | 'PII_FACT_KEY'
  | 'TYPE_MISMATCH'
  | 'UNSUPPORTED_ENVELOPE'
  | 'DEPTH_EXCEEDED'
  | 'EMPTY_VALUE'
  | 'TEXT_TOO_LONG'
  | 'URL_INVALID'
  | 'URL_TOO_LONG'
  | 'URL_USERINFO_FORBIDDEN'
  | 'URL_CREDENTIAL_QUERY_FORBIDDEN'
  | 'COUNTRY_CODE_INVALID'
  | 'ENUM_VALUE_INVALID'
  | 'LIST_TOO_LONG'
  | 'LIST_ITEM_TOO_LONG'
  | 'LIST_ITEM_INVALID'
  | 'YEAR_OUT_OF_RANGE'
  | 'RANGE_EMPTY'
  | 'RANGE_BOUND_INVALID'
  | 'RANGE_ORDER_INVALID'
  | 'RANGE_RAW_INVALID';

const ERROR_MESSAGES: Readonly<Record<FactContractErrorCode, string>> = Object.freeze({
  UNKNOWN_FACT_KEY: 'fact key is not registered',
  PII_FACT_KEY: 'PII fact keys are not allowed',
  TYPE_MISMATCH: 'value envelope type does not match fact contract',
  UNSUPPORTED_ENVELOPE: 'value envelope is unsupported',
  DEPTH_EXCEEDED: 'value envelope exceeds the maximum depth',
  EMPTY_VALUE: 'value must not be empty',
  TEXT_TOO_LONG: 'text value exceeds the maximum length',
  URL_INVALID: 'URL is invalid or uses an unsupported scheme',
  URL_TOO_LONG: 'URL exceeds the maximum length',
  URL_USERINFO_FORBIDDEN: 'URL userinfo is not allowed',
  URL_CREDENTIAL_QUERY_FORBIDDEN: 'URL query contains a credential-like key',
  COUNTRY_CODE_INVALID: 'country code is not in the ISO allowlist',
  ENUM_VALUE_INVALID: 'enum value is not in the frozen allowlist',
  LIST_TOO_LONG: 'list exceeds the maximum item count',
  LIST_ITEM_TOO_LONG: 'list item exceeds the maximum length',
  LIST_ITEM_INVALID: 'list item must be a non-empty string',
  YEAR_OUT_OF_RANGE: 'established year is outside the allowed range',
  RANGE_EMPTY: 'range must contain a minimum or maximum',
  RANGE_BOUND_INVALID: 'range bound is invalid',
  RANGE_ORDER_INVALID: 'range minimum must not exceed maximum',
  RANGE_RAW_INVALID: 'range raw value is invalid',
});

export type FactValidationResult =
  | Readonly<{ ok: true; value: NormalizedFactValue }>
  | Readonly<{ ok: false; error: Readonly<{ code: FactContractErrorCode; message: string }> }>;

type FailureResult = Extract<FactValidationResult, { ok: false }>;

const PII_KEY_TOKEN = /^(email|phone|telephone|mobile|account|credential|password|token|secret|username|iban|bank|login)$/;
const CREDENTIAL_QUERY_KEYS = new Set([
  'token',
  'key',
  'secret',
  'auth',
  'authorization',
  'password',
  'passwd',
  'signature',
  'sig',
  'api_key',
  'apikey',
  'access_key',
  'access_token',
  'client_secret',
  'clientsecret',
  'auth_token',
  'authtoken',
  'api_token',
  'api_secret',
  'secret_key',
  'private_key',
  'session_token',
  'refresh_token',
  'id_token',
  'bearer_token',
]);

const ENVELOPE_KEYS: Readonly<Record<FactValueType, readonly string[]>> = Object.freeze({
  TEXT: ['schemaVersion', 'type', 'value'],
  URL: ['schemaVersion', 'type', 'value'],
  COUNTRY_CODE: ['schemaVersion', 'type', 'value'],
  INTEGER: ['schemaVersion', 'type', 'value'],
  ENUM: ['schemaVersion', 'type', 'value'],
  TEXT_LIST: ['schemaVersion', 'type', 'value'],
  INTEGER_RANGE: ['schemaVersion', 'type', 'min', 'max', 'raw'],
});

function success(value: NormalizedFactValue): FactValidationResult {
  return Object.freeze({ ok: true, value });
}

function failure(code: FactContractErrorCode): FailureResult {
  return Object.freeze({
    ok: false,
    error: Object.freeze({ code, message: ERROR_MESSAGES[code] }),
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isFailureResult(value: unknown): value is FailureResult {
  return isRecord(value) && value.ok === false && isRecord(value.error);
}

function exceedsDepth(value: unknown, depth = 0, seen = new Set<object>()): boolean {
  if (value === null || typeof value !== 'object') return false;
  if (depth > MAX_JSON_DEPTH) return true;
  if (seen.has(value)) return true;
  seen.add(value);
  if (Array.isArray(value)) return value.some((item) => exceedsDepth(item, depth + 1, seen));
  return Object.values(value).some((item) => exceedsDepth(item, depth + 1, seen));
}

function normalizeText(value: unknown): string | FailureResult {
  if (typeof value !== 'string') return failure('TYPE_MISMATCH');
  const normalized = value.normalize('NFC').trim();
  if (!normalized) return failure('EMPTY_VALUE');
  if (Array.from(normalized).length > MAX_TEXT_LENGTH) return failure('TEXT_TOO_LONG');
  return normalized;
}

function validateEnvelope(value: unknown, expectedType: FactValueType): Record<string, unknown> | FailureResult {
  if (!isRecord(value)) return failure('TYPE_MISMATCH');
  if (value.schemaVersion !== 1 || typeof value.type !== 'string') return failure('UNSUPPORTED_ENVELOPE');
  if (value.type !== expectedType) return failure('TYPE_MISMATCH');
  const allowedKeys = ENVELOPE_KEYS[expectedType];
  if (Object.keys(value).some((key) => !allowedKeys.includes(key))) return failure('UNSUPPORTED_ENVELOPE');
  return value;
}

function normalizeUrl(input: unknown): FactValidationResult {
  const envelope = validateEnvelope(input, 'URL');
  if (isFailureResult(envelope)) return envelope;
  if (typeof envelope.value !== 'string') return failure('TYPE_MISMATCH');
  const text = envelope.value.normalize('NFC').trim();
  if (!text) return failure('EMPTY_VALUE');
  if (text.length > MAX_URL_LENGTH) return failure('URL_TOO_LONG');

  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return failure('URL_INVALID');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return failure('URL_INVALID');
  if (!url.hostname || url.username || url.password) return failure('URL_USERINFO_FORBIDDEN');
  for (const [key] of url.searchParams) {
    const normalizedKey = key.normalize('NFC').trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
    if (CREDENTIAL_QUERY_KEYS.has(normalizedKey)) {
      return failure('URL_CREDENTIAL_QUERY_FORBIDDEN');
    }
  }
  url.protocol = url.protocol.toLowerCase();
  url.hostname = url.hostname.toLowerCase().replace(/\.$/, '');
  url.hash = '';
  const normalizedUrl = url.toString();
  if (normalizedUrl.length > MAX_URL_LENGTH) return failure('URL_TOO_LONG');
  return success({ schemaVersion: 1, type: 'URL', value: normalizedUrl, normalized: normalizedUrl });
}

function normalizeCountryCode(input: unknown): FactValidationResult {
  const envelope = validateEnvelope(input, 'COUNTRY_CODE');
  if (isFailureResult(envelope)) return envelope;
  const text = normalizeText(envelope.value);
  if (typeof text !== 'string') return text;
  const code = text.toUpperCase();
  if (!ISO_3166_1_COUNTRY_CODE_SET.has(code)) return failure('COUNTRY_CODE_INVALID');
  return success({ schemaVersion: 1, type: 'COUNTRY_CODE', value: code, normalized: code });
}

function normalizeInteger(input: unknown): FactValidationResult {
  const envelope = validateEnvelope(input, 'INTEGER');
  if (isFailureResult(envelope)) return envelope;
  if (typeof envelope.value !== 'number' || !Number.isSafeInteger(envelope.value)) return failure('TYPE_MISMATCH');
  if (envelope.value < MIN_ESTABLISHED_YEAR || envelope.value > MAX_ESTABLISHED_YEAR) {
    return failure('YEAR_OUT_OF_RANGE');
  }
  return success({ schemaVersion: 1, type: 'INTEGER', value: envelope.value });
}

function normalizeEnum(input: unknown, codeSet: readonly string[]): FactValidationResult {
  const envelope = validateEnvelope(input, 'ENUM');
  if (isFailureResult(envelope)) return envelope;
  const text = normalizeText(envelope.value);
  if (typeof text !== 'string') return text;
  const code = text.toLowerCase().replace(/[ -]+/g, '_');
  if (!codeSet.includes(code)) return failure('ENUM_VALUE_INVALID');
  const codeSetVersion = codeSet === INDUSTRY_ALLOWLIST ? 'industry-v1' : 'business-model-v1';
  return success({ schemaVersion: 1, type: 'ENUM', value: code, codeSetVersion });
}

function normalizeTextList(input: unknown, semantic?: 'PUBLIC_CLAIM_ONLY'): FactValidationResult {
  const envelope = validateEnvelope(input, 'TEXT_LIST');
  if (isFailureResult(envelope)) return envelope;
  if (!Array.isArray(envelope.value)) return failure('TYPE_MISMATCH');
  if (envelope.value.length === 0) return failure('EMPTY_VALUE');
  if (envelope.value.length > MAX_LIST_ITEMS) return failure('LIST_TOO_LONG');

  const canonical = new Map<string, string>();
  for (const item of envelope.value) {
    const normalized = normalizeText(item);
    if (typeof normalized !== 'string') {
      return normalized.error.code === 'TEXT_TOO_LONG' ? failure('LIST_ITEM_TOO_LONG') : failure('LIST_ITEM_INVALID');
    }
    if (Array.from(normalized).length > MAX_LIST_ITEM_LENGTH) return failure('LIST_ITEM_TOO_LONG');
    const key = normalized.toLowerCase();
    const previous = canonical.get(key);
    if (!previous || normalized < previous) canonical.set(key, normalized);
  }
  if (canonical.size === 0) return failure('EMPTY_VALUE');
  const normalizedKeys = [...canonical.keys()].sort();
  const values = normalizedKeys.map((key) => canonical.get(key) as string);
  return success({
    schemaVersion: 1,
    type: 'TEXT_LIST',
    value: values,
    normalized: normalizedKeys,
    ...(semantic ? { semantic } : {}),
  });
}

function normalizeRange(input: unknown): FactValidationResult {
  const envelope = validateEnvelope(input, 'INTEGER_RANGE');
  if (isFailureResult(envelope)) return envelope;
  const hasMin = envelope.min !== undefined && envelope.min !== null;
  const hasMax = envelope.max !== undefined && envelope.max !== null;
  if (!hasMin && !hasMax) return failure('RANGE_EMPTY');

  const min = hasMin ? envelope.min : undefined;
  const max = hasMax ? envelope.max : undefined;
  for (const bound of [min, max]) {
    if (bound === undefined) continue;
    if (typeof bound !== 'number' || !Number.isSafeInteger(bound) || bound < MIN_EMPLOYEE_COUNT || bound > MAX_EMPLOYEE_COUNT) {
      return failure('RANGE_BOUND_INVALID');
    }
  }
  const minNumber = min as number | undefined;
  const maxNumber = max as number | undefined;
  if (minNumber !== undefined && maxNumber !== undefined && minNumber > maxNumber) return failure('RANGE_ORDER_INVALID');

  let raw: string | undefined;
  if (envelope.raw !== undefined) {
    if (typeof envelope.raw !== 'string') return failure('RANGE_RAW_INVALID');
    raw = envelope.raw.normalize('NFC').trim();
    if (!raw || Array.from(raw).length > MAX_RANGE_RAW_LENGTH) return failure('RANGE_RAW_INVALID');
  }
  return success({
    schemaVersion: 1,
    type: 'INTEGER_RANGE',
    ...(minNumber !== undefined ? { min: minNumber } : {}),
    ...(maxNumber !== undefined ? { max: maxNumber } : {}),
    ...(raw !== undefined ? { raw } : {}),
  });
}

function isPiiFactKey(factKey: string): boolean {
  return factKey
    .toLowerCase()
    .split(/[._-]+/)
    .some((token) => PII_KEY_TOKEN.test(token));
}

export function validateAndNormalizeFactValue(factKey: string, value: unknown): FactValidationResult {
  if (typeof factKey !== 'string' || isPiiFactKey(factKey)) return failure('PII_FACT_KEY');
  if (!(factKey in FACT_KEY_DEFINITIONS)) return failure('UNKNOWN_FACT_KEY');
  if (exceedsDepth(value)) return failure('DEPTH_EXCEEDED');

  switch (factKey) {
    case 'identity.company_name':
    case 'identity.city': {
      const envelope = validateEnvelope(value, 'TEXT');
      if (isFailureResult(envelope)) return envelope;
      const text = normalizeText(envelope.value);
      if (typeof text !== 'string') return text;
      return success({ schemaVersion: 1, type: 'TEXT', value: text, normalized: text.toLowerCase() });
    }
    case 'identity.website_url':
      return normalizeUrl(value);
    case 'identity.country_code':
      return normalizeCountryCode(value);
    case 'company.industry':
      return normalizeEnum(value, INDUSTRY_ALLOWLIST);
    case 'company.year_established':
      return normalizeInteger(value);
    case 'company.employee_count_range':
      return normalizeRange(value);
    case 'company.product_categories':
      return normalizeTextList(value);
    case 'company.business_model':
      return normalizeEnum(value, BUSINESS_MODEL_ALLOWLIST);
    case 'company.certification_claims':
      return normalizeTextList(value, 'PUBLIC_CLAIM_ONLY');
    default:
      return failure('UNKNOWN_FACT_KEY');
  }
}
