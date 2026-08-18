/**
 * CRM-04A-4A: read-only legacy classification and provenance contract.
 *
 * This file deliberately produces only a dry-run receipt. It never performs
 * DML and never emits CONFIRMED or an executable database write plan.
 */

import { createHash } from 'node:crypto';
import {
  FACT_KEYS,
  validateAndNormalizeFactValue,
  type FactKey,
  type NormalizedFactValue,
} from './fact-contract';
import {
  validateAndNormalizeEvidence,
  type ImmutableEvidenceObservation,
  type EvidenceRelation,
} from './evidence-contract';

export const LEGACY_SOURCE_KINDS = Object.freeze([
  'LEGACY_LEAD_SCALAR',
  'LEAD_SOURCE',
  'DEEP_RESEARCH_FINDING',
  'AI_ARTIFACT',
] as const);
export type LegacySourceKind = (typeof LEGACY_SOURCE_KINDS)[number];

export const LEGACY_DISPOSITIONS = Object.freeze([
  'PROPOSAL_WITH_EVIDENCE',
  'PROPOSAL_REVIEW_REQUIRED',
  'QUARANTINED',
  'SKIPPED',
] as const);
export type LegacyDisposition = (typeof LEGACY_DISPOSITIONS)[number];

export const LEGACY_ADAPTER_VERSION = 'legacy-adapter-v1' as const;

export const LEGACY_REASON_CODES = Object.freeze([
  'EVIDENCE_ACCEPTED',
  'NO_INDEPENDENT_EVIDENCE',
  'SOURCE_URL_NOT_EVIDENCE',
  'AI_ARTIFACT_REVIEW_ONLY',
  'EVIDENCE_NOT_INDEPENDENT',
  'EVIDENCE_INVALID',
  'EVIDENCE_CONTRADICTS',
  'SOURCE_REF_INVALID',
  'SOURCE_REF_NOT_ALLOWLISTED',
  'SOURCE_REF_MISMATCH',
  'FINDING_EXCERPT_MISSING',
  'FINDING_MAPPING_INVALID',
  'VERIFIED_EVIDENCE_ACCEPTED',
  'VERIFIED_EVIDENCE_INVALID',
  'INVALID_FACT_VALUE',
  'UNKNOWN_FACT_KEY',
  'DUPLICATE_SKIPPED',
  'INPUT_REJECTED',
  'SKIPPED_EMPTY',
] as const);
export type LegacyReasonCode = (typeof LEGACY_REASON_CODES)[number];

export type LegacyAdapterErrorCode =
  | 'UNSUPPORTED_ENVELOPE'
  | 'UNKNOWN_FIELD'
  | 'TYPE_MISMATCH'
  | 'INVALID_CONTEXT'
  | 'INVALID_SOURCE_KIND'
  | 'INVALID_REF'
  | 'INVALID_SCOPE'
  | 'INVALID_TIMESTAMP'
  | 'INVALID_ADAPTER_VERSION'
  | 'BATCH_EMPTY'
  | 'BATCH_TOO_LARGE'
  | 'SENSITIVE_INPUT_FORBIDDEN'
  | 'EVIDENCE_INVALID'
  | 'SOURCE_REF_MISMATCH'
  | 'VERIFIED_EVIDENCE_INVALID'
  | 'UNKNOWN_FACT_KEY'
  | 'INVALID_FACT_VALUE';

const ERROR_MESSAGES: Readonly<Record<LegacyAdapterErrorCode, string>> = Object.freeze({
  UNSUPPORTED_ENVELOPE: 'legacy adapter envelope is unsupported',
  UNKNOWN_FIELD: 'legacy adapter envelope contains an unknown field',
  TYPE_MISMATCH: 'legacy adapter field has an invalid type',
  INVALID_CONTEXT: 'legacy adapter context is invalid',
  INVALID_SOURCE_KIND: 'legacy source kind is invalid',
  INVALID_REF: 'legacy reference is invalid',
  INVALID_SCOPE: 'legacy scope is invalid',
  INVALID_TIMESTAMP: 'legacy timestamp is invalid',
  INVALID_ADAPTER_VERSION: 'legacy adapter version is invalid',
  BATCH_EMPTY: 'legacy adapter batch must not be empty',
  BATCH_TOO_LARGE: 'legacy adapter batch exceeds the maximum size',
  SENSITIVE_INPUT_FORBIDDEN: 'sensitive legacy input is not allowed',
  EVIDENCE_INVALID: 'legacy evidence is invalid',
  SOURCE_REF_MISMATCH: 'legacy evidence source does not match',
  VERIFIED_EVIDENCE_INVALID: 'verified evidence summary is invalid',
  UNKNOWN_FACT_KEY: 'legacy fact key is not supported',
  INVALID_FACT_VALUE: 'legacy fact value is invalid',
});

type Failure = Readonly<{ ok: false; error: Readonly<{ code: LegacyAdapterErrorCode; message: string }> }>;
type Result<T> = Readonly<{ ok: true; value: T }> | Failure;

export type LegacyAdapterContext = Readonly<{
  schemaVersion: 1;
  validationNow: string;
  adapterVersion: string;
  allowlistedSourceRefs?: readonly string[];
}>;

type LegacyScope = Readonly<{ tenantRef: string; leadRef: string; factKey: FactKey }>;

type CommonLegacyInput = Readonly<{
  schemaVersion: 1;
  sourceKind: LegacySourceKind;
  legacyObjectRef: string;
  scope: LegacyScope;
  factKey: FactKey;
  observedAt?: string;
  createdAt?: string;
  valueEnvelope: unknown;
}>;

export type LegacyRecordInput = CommonLegacyInput & Readonly<Record<string, unknown>>;

export type LegacyProvenanceReceipt = Readonly<{
  schemaVersion: 1;
  sourceKind: LegacySourceKind;
  disposition: LegacyDisposition;
  reasonCode: LegacyReasonCode;
  legacyObjectRefDigest: string;
  scopeDigest: string;
  factKeyDigest: string;
  sourceObservedAt?: string;
  adapterVersion: string;
  valueDigest?: string;
  valueType?: NormalizedFactValue['type'];
  evidenceCount: number;
  evidence?: readonly Readonly<{
    relation: EvidenceRelation;
    kind: 'SOURCE_EXCERPT' | 'MANUAL_ATTESTATION';
    sourceRefDigest?: string;
    excerptHash?: string;
  }>[];
}>;

export type LegacyClassificationResult = Result<LegacyProvenanceReceipt>;

export type LegacyDryRunBatch = Readonly<{
  schemaVersion: 1;
  adapterVersion: string;
  batchDigest: string;
  totals: Readonly<{
    byDisposition: Readonly<Record<LegacyDisposition, number>>;
    bySourceKind: Readonly<Record<LegacySourceKind, number>>;
    byReasonCode: Readonly<Record<LegacyReasonCode, number>>;
  }>;
  records: readonly LegacyProvenanceReceipt[];
}>;

export type LegacyBatchResult = Result<LegacyDryRunBatch>;

const OPAQUE_REF_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const INTERNAL_REF_PATTERN = /^internal:\/\/[a-z][a-z0-9_-]{1,31}\/[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const UTC_INSTANT_PATTERN = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d{1,3}))?Z$/;
const SOURCE_REF_DIGEST_PREFIX = 'sha256:legacy-source-ref-v1:';
const LEGACY_REF_DIGEST_PREFIX = 'sha256:legacy-object-ref-v1:';
const SCOPE_DIGEST_PREFIX = 'sha256:legacy-scope-v1:';
const FACT_VALUE_DIGEST_PREFIX = 'sha256:fact-value-v1:';
const BATCH_DIGEST_PREFIX = 'sha256:legacy-batch-v1:';
const SOURCE_REF_DOMAIN = 'vaysen-trade-crm/legacy-adapter/source-ref/v1';
const LEGACY_REF_DOMAIN = 'vaysen-trade-crm/legacy-adapter/object-ref/v1';
const SCOPE_DOMAIN = 'vaysen-trade-crm/legacy-adapter/scope/v1';
const FACT_VALUE_DOMAIN = 'vaysen-trade-crm/legacy-adapter/fact-value/v1';
const BATCH_DOMAIN = 'vaysen-trade-crm/legacy-adapter/batch/v1';
const SOURCE_REF_DIGEST_PATTERN = /^sha256:legacy-source-ref-v1:[0-9a-f]{64}$/;
const SOURCE_EXCERPT_HASH_PATTERN = /^sha256:source-excerpt-v1:[0-9a-f]{64}$/;
const SOURCE_REF_QUERY_DENYLIST = new Set([
  'token', 'key', 'secret', 'auth', 'authorization', 'password', 'passwd', 'signature', 'sig',
  'api_key', 'apikey', 'access_key', 'access_token', 'client_secret', 'clientsecret',
  'auth_token', 'authtoken', 'api_token', 'api_secret', 'secret_key', 'private_key',
  'session_token', 'refresh_token', 'id_token', 'bearer_token',
]);
const SOURCE_KIND_RANK: Readonly<Record<LegacySourceKind, number>> = Object.freeze({
  LEGACY_LEAD_SCALAR: 0,
  LEAD_SOURCE: 1,
  DEEP_RESEARCH_FINDING: 2,
  AI_ARTIFACT: 3,
});
const DISPOSITION_RANK: Readonly<Record<LegacyDisposition, number>> = Object.freeze({
  PROPOSAL_WITH_EVIDENCE: 0,
  PROPOSAL_REVIEW_REQUIRED: 1,
  QUARANTINED: 2,
  SKIPPED: 3,
});

const LEGACY_FIELD_BY_FACT_KEY: Readonly<Record<FactKey, string>> = Object.freeze({
  'identity.company_name': 'companyName',
  'identity.website_url': 'website',
  'identity.country_code': 'country',
  'identity.city': 'city',
  'company.industry': 'industry',
  'company.year_established': 'yearEstablished',
  'company.employee_count_range': 'employeeCount',
  'company.product_categories': 'productCategory',
  'company.business_model': 'businessType',
  'company.certification_claims': 'certificationClaims',
});

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asciiCompare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function hasExplicitUndefined(value: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key) && value[key] === undefined;
}

function deepFreeze<T>(value: T): T {
  if (value === null || typeof value !== 'object' || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  return value;
}

function failure(code: LegacyAdapterErrorCode): Failure {
  return deepFreeze({ ok: false, error: { code, message: ERROR_MESSAGES[code] } });
}

function success<T>(value: T): Result<T> {
  return deepFreeze({ ok: true, value });
}

function isFailure(value: unknown): value is Failure {
  return isRecord(value) && value.ok === false && isRecord(value.error);
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  const keys = new Set(allowed);
  return Object.keys(value).every((key) => keys.has(key));
}

function hashWithDomain(domain: string, canonical: string): string {
  return createHash('sha256').update(`${domain}\0${canonical}`, 'utf8').digest('hex');
}

function stableCanonical(value: unknown): string {
  if (value === null) return 'null';
  if (typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number' || typeof value === 'boolean') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableCanonical).join(',')}]`;
  if (isRecord(value)) return `{${Object.keys(value).sort(asciiCompare).map((key) => `${JSON.stringify(key)}:${stableCanonical(value[key])}`).join(',')}}`;
  return JSON.stringify(String(value));
}

function digest(prefix: string, domain: string, value: unknown): string {
  return `${prefix}${hashWithDomain(domain, stableCanonical(value))}`;
}

function canonicalUtc(value: unknown): string | Failure {
  if (typeof value !== 'string') return failure('INVALID_TIMESTAMP');
  const match = UTC_INSTANT_PATTERN.exec(value);
  if (!match) return failure('INVALID_TIMESTAMP');
  const millis = Date.parse(value);
  const normalized = Number.isFinite(millis) ? new Date(millis).toISOString() : '';
  const expected = `${match[1]}.${(match[2] ?? '').padEnd(3, '0')}Z`;
  return normalized === expected ? normalized : failure('INVALID_TIMESTAMP');
}

function validateOpaqueRef(value: unknown): string | Failure {
  if (typeof value !== 'string' || !OPAQUE_REF_PATTERN.test(value) || /(?:email|password|secret|token|credential|cookie|authorization|bearer)/i.test(value)) return failure('INVALID_REF');
  return value;
}

function canonicalSourceRef(value: unknown): string | Failure {
  if (typeof value !== 'string' || value.trim() !== value || !value) return failure('INVALID_REF');
  if (INTERNAL_REF_PATTERN.test(value)) return value;
  let url: URL;
  try { url = new URL(value); } catch { return failure('INVALID_REF'); }
  if (url.protocol !== 'https:') return failure('INVALID_REF');
  if (url.username || url.password || !url.hostname) return failure('SENSITIVE_INPUT_FORBIDDEN');
  for (const [key] of url.searchParams) {
    const normalizedKey = key.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
    if (SOURCE_REF_QUERY_DENYLIST.has(normalizedKey)) return failure('SENSITIVE_INPUT_FORBIDDEN');
  }
  url.protocol = url.protocol.toLowerCase();
  url.hostname = url.hostname.toLowerCase().replace(/\.$/, '');
  url.hash = '';
  return url.toString();
}

function validateContext(value: unknown): Result<Readonly<{ validationNow: string; adapterVersion: string; allowlistedSourceRefs: readonly string[] }>> {
  if (!isRecord(value) || !hasOnlyKeys(value, ['schemaVersion', 'validationNow', 'adapterVersion', 'allowlistedSourceRefs']) || value.schemaVersion !== 1) return failure('INVALID_CONTEXT');
  if (hasExplicitUndefined(value, 'allowlistedSourceRefs')) return failure('UNKNOWN_FIELD');
  const validationNow = canonicalUtc(value.validationNow);
  if (isFailure(validationNow)) return validationNow;
  if (value.adapterVersion !== LEGACY_ADAPTER_VERSION) return failure('INVALID_ADAPTER_VERSION');
  const refs: string[] = [];
  if (value.allowlistedSourceRefs !== undefined) {
    if (!Array.isArray(value.allowlistedSourceRefs)) return failure('INVALID_CONTEXT');
    for (const item of value.allowlistedSourceRefs) {
      const ref = canonicalSourceRef(item);
      if (isFailure(ref) || refs.includes(ref)) return failure('INVALID_CONTEXT');
      refs.push(ref);
    }
  }
  refs.sort(asciiCompare);
  return success({ validationNow, adapterVersion: value.adapterVersion, allowlistedSourceRefs: refs });
}

function validateScope(value: unknown): LegacyScope | Failure {
  if (!isRecord(value) || !hasOnlyKeys(value, ['tenantRef', 'leadRef', 'factKey']) || Object.keys(value).length !== 3) return failure('INVALID_SCOPE');
  const tenantRef = validateOpaqueRef(value.tenantRef);
  const leadRef = validateOpaqueRef(value.leadRef);
  if (isFailure(tenantRef) || isFailure(leadRef) || typeof value.factKey !== 'string') return failure('INVALID_SCOPE');
  if (!FACT_KEYS.includes(value.factKey as FactKey)) return failure('INVALID_SCOPE');
  return { tenantRef, leadRef, factKey: value.factKey as FactKey };
}

function observedAt(input: Record<string, unknown>): string | Failure {
  if (hasExplicitUndefined(input, 'observedAt') || hasExplicitUndefined(input, 'createdAt')) return failure('UNKNOWN_FIELD');
  const observed = input.observedAt ?? input.createdAt;
  if (observed === undefined) return failure('INVALID_TIMESTAMP');
  return canonicalUtc(observed);
}

function factKeyDigest(factKey: FactKey): string {
  return digest('sha256:legacy-fact-key-v1:', 'vaysen-trade-crm/legacy-adapter/fact-key/v1', factKey);
}

function normalizeValue(factKey: FactKey, valueEnvelope: unknown): Result<Readonly<{ valueDigest: string; valueType: NormalizedFactValue['type'] }>> {
  const normalized = validateAndNormalizeFactValue(factKey, valueEnvelope);
  if (normalized.ok === false) return failure(normalized.error.code === 'UNKNOWN_FACT_KEY' ? 'UNKNOWN_FACT_KEY' : 'INVALID_FACT_VALUE');
  return success({ valueDigest: digest(FACT_VALUE_DIGEST_PREFIX, FACT_VALUE_DOMAIN, normalized.value), valueType: normalized.value.type });
}

function validateEvidenceCandidate(value: unknown, context: Readonly<{ validationNow: string }>, expectedFactKey: FactKey, expectedValueDigest: string, expectedSourceRef?: string): Result<Readonly<{ relation: EvidenceRelation; observation: ImmutableEvidenceObservation }>> {
  if (!isRecord(value) || !hasOnlyKeys(value, ['schemaVersion', 'relation', 'factKey', 'valueDigest', 'observation']) || Object.keys(value).length !== 5 || value.schemaVersion !== 1) return failure('EVIDENCE_INVALID');
  if (value.relation !== 'SUPPORTS' && value.relation !== 'CONTRADICTS') return failure('EVIDENCE_INVALID');
  if (value.factKey !== expectedFactKey || value.valueDigest !== expectedValueDigest) return failure('EVIDENCE_INVALID');
  const observation = validateAndNormalizeEvidence(value.observation, context.validationNow);
  if (observation.ok === false) return failure(observation.error.code === 'SENSITIVE_CONTENT_FORBIDDEN' ? 'SENSITIVE_INPUT_FORBIDDEN' : 'EVIDENCE_INVALID');
  if (observation.value.kind !== 'SOURCE_EXCERPT') return success({ relation: value.relation, observation: observation.value });
  if (expectedSourceRef !== undefined && observation.value.sourceRef !== expectedSourceRef) return failure('SOURCE_REF_MISMATCH');
  return success({ relation: value.relation, observation: observation.value });
}

function evidenceSummary(candidate: Readonly<{ relation: EvidenceRelation; observation: ImmutableEvidenceObservation }>): Readonly<{ relation: EvidenceRelation; kind: 'SOURCE_EXCERPT' | 'MANUAL_ATTESTATION'; sourceRefDigest?: string; excerptHash?: string }> {
  if (candidate.observation.kind === 'SOURCE_EXCERPT') return {
    relation: candidate.relation,
    kind: candidate.observation.kind,
    sourceRefDigest: digest(SOURCE_REF_DIGEST_PREFIX, SOURCE_REF_DOMAIN, candidate.observation.sourceRef),
    excerptHash: candidate.observation.excerptHash,
  };
  return { relation: candidate.relation, kind: candidate.observation.kind };
}

function verifiedEvidence(value: unknown, factKey: FactKey, valueDigest: string, allowlistedSourceRefs: readonly string[]): Result<Readonly<{ relation: EvidenceRelation; sourceRefDigest: string; excerptHash: string }>> {
  if (!isRecord(value) || !hasOnlyKeys(value, ['schemaVersion', 'relation', 'factKey', 'valueDigest', 'sourceRefDigest', 'excerptHash']) || Object.keys(value).length !== 6 || value.schemaVersion !== 1) return failure('VERIFIED_EVIDENCE_INVALID');
  if (value.relation !== 'SUPPORTS' && value.relation !== 'CONTRADICTS') return failure('VERIFIED_EVIDENCE_INVALID');
  if (value.factKey !== factKey || value.valueDigest !== valueDigest || typeof value.sourceRefDigest !== 'string' || !SOURCE_REF_DIGEST_PATTERN.test(value.sourceRefDigest) || !allowlistedSourceRefs.some((sourceRef) => digest(SOURCE_REF_DIGEST_PREFIX, SOURCE_REF_DOMAIN, sourceRef) === value.sourceRefDigest) || typeof value.excerptHash !== 'string' || !SOURCE_EXCERPT_HASH_PATTERN.test(value.excerptHash)) return failure('VERIFIED_EVIDENCE_INVALID');
  return success({ relation: value.relation, sourceRefDigest: value.sourceRefDigest, excerptHash: value.excerptHash });
}

function baseReceipt(input: CommonLegacyInput, context: Readonly<{ adapterVersion: string }>, disposition: LegacyDisposition, reasonCode: LegacyReasonCode, value?: Readonly<{ valueDigest: string; valueType: NormalizedFactValue['type'] }>, evidence: readonly Readonly<{ relation: EvidenceRelation; kind: 'SOURCE_EXCERPT' | 'MANUAL_ATTESTATION'; sourceRefDigest?: string; excerptHash?: string }>[] = [], sourceObservedAtValue?: string): LegacyProvenanceReceipt {
  return {
    schemaVersion: 1,
    sourceKind: input.sourceKind,
    disposition,
    reasonCode,
    legacyObjectRefDigest: digest(LEGACY_REF_DIGEST_PREFIX, LEGACY_REF_DOMAIN, input.legacyObjectRef),
    scopeDigest: digest(SCOPE_DIGEST_PREFIX, SCOPE_DOMAIN, input.scope),
    factKeyDigest: factKeyDigest(input.scope.factKey),
    ...(sourceObservedAtValue ? { sourceObservedAt: sourceObservedAtValue } : {}),
    adapterVersion: context.adapterVersion,
    ...(value ? { valueDigest: value.valueDigest, valueType: value.valueType } : {}),
    evidenceCount: evidence.length,
    ...(evidence.length ? { evidence } : {}),
  };
}

function sourceKindFields(sourceKind: LegacySourceKind): readonly string[] {
  const common = ['schemaVersion', 'sourceKind', 'legacyObjectRef', 'scope', 'factKey', 'observedAt', 'createdAt', 'valueEnvelope'];
  if (sourceKind === 'LEGACY_LEAD_SCALAR') return [...common, 'legacyField', 'evidence'];
  if (sourceKind === 'LEAD_SOURCE') return [...common, 'sourceUrl', 'sourceTitle', 'evidence'];
  if (sourceKind === 'DEEP_RESEARCH_FINDING') return [...common, 'findingRef', 'sourceRef', 'evidenceSourceRef', 'supportingExcerpt', 'locator'];
  return [...common, 'artifactStatus', 'confidenceScore', 'provider', 'model', 'verifiedEvidence'];
}

function classifyParsed(input: Record<string, unknown>, context: Readonly<{ validationNow: string; adapterVersion: string; allowlistedSourceRefs: readonly string[] }>, common: CommonLegacyInput, value: Readonly<{ valueDigest: string; valueType: NormalizedFactValue['type'] }>, sourceObservedAtValue: string): LegacyClassificationResult {
  const sourceKind = common.sourceKind;
  const evidenceOutput: Readonly<{ relation: EvidenceRelation; kind: 'SOURCE_EXCERPT' | 'MANUAL_ATTESTATION'; sourceRefDigest?: string; excerptHash?: string }>[] = [];
  const withEvidence = (candidate: Readonly<{ relation: EvidenceRelation; observation: ImmutableEvidenceObservation }>, reason: LegacyReasonCode = 'EVIDENCE_ACCEPTED'): LegacyClassificationResult => {
    if (candidate.relation === 'CONTRADICTS') return success(baseReceipt(common, context, 'QUARANTINED', 'EVIDENCE_CONTRADICTS', value, [evidenceSummary(candidate)], sourceObservedAtValue));
    if (candidate.observation.kind !== 'SOURCE_EXCERPT') return success(baseReceipt(common, context, 'PROPOSAL_REVIEW_REQUIRED', 'EVIDENCE_NOT_INDEPENDENT', value, [evidenceSummary(candidate)], sourceObservedAtValue));
    evidenceOutput.push(evidenceSummary(candidate));
    return success(baseReceipt(common, context, 'PROPOSAL_WITH_EVIDENCE', reason, value, evidenceOutput, sourceObservedAtValue));
  };

  if (sourceKind === 'LEGACY_LEAD_SCALAR') {
    if (typeof input.legacyField !== 'string') return failure('TYPE_MISMATCH');
    if (input.legacyField !== LEGACY_FIELD_BY_FACT_KEY[common.scope.factKey]) return success(baseReceipt(common, context, 'QUARANTINED', 'FINDING_MAPPING_INVALID', value, [], sourceObservedAtValue));
    if (input.evidence === undefined) return success(baseReceipt(common, context, 'PROPOSAL_REVIEW_REQUIRED', 'NO_INDEPENDENT_EVIDENCE', value, [], sourceObservedAtValue));
    const candidate = validateEvidenceCandidate(input.evidence, context, common.scope.factKey, value.valueDigest);
    if (isFailure(candidate)) return success(baseReceipt(common, context, 'QUARANTINED', candidate.error.code === 'SENSITIVE_INPUT_FORBIDDEN' ? 'EVIDENCE_INVALID' : 'EVIDENCE_INVALID', value, [], sourceObservedAtValue));
    return withEvidence(candidate.value);
  }

  if (sourceKind === 'LEAD_SOURCE') {
    if (input.sourceTitle !== undefined && typeof input.sourceTitle !== 'string') return failure('TYPE_MISMATCH');
    if (input.sourceUrl !== undefined && isFailure(canonicalSourceRef(input.sourceUrl))) return success(baseReceipt(common, context, 'QUARANTINED', 'SOURCE_REF_INVALID', value, [], sourceObservedAtValue));
    if (input.evidence === undefined) return success(baseReceipt(common, context, 'PROPOSAL_REVIEW_REQUIRED', 'SOURCE_URL_NOT_EVIDENCE', value, [], sourceObservedAtValue));
    const expectedSourceRef = input.sourceUrl === undefined ? undefined : canonicalSourceRef(input.sourceUrl);
    if (isFailure(expectedSourceRef)) return success(baseReceipt(common, context, 'QUARANTINED', 'SOURCE_REF_INVALID', value, [], sourceObservedAtValue));
    const candidate = validateEvidenceCandidate(input.evidence, context, common.scope.factKey, value.valueDigest, expectedSourceRef);
    if (isFailure(candidate)) return success(baseReceipt(common, context, 'QUARANTINED', candidate.error.code === 'SOURCE_REF_MISMATCH' ? 'SOURCE_REF_MISMATCH' : 'EVIDENCE_INVALID', value, [], sourceObservedAtValue));
    return withEvidence(candidate.value);
  }

  if (sourceKind === 'DEEP_RESEARCH_FINDING') {
    if (isFailure(validateOpaqueRef(input.findingRef))) return success(baseReceipt(common, context, 'QUARANTINED', 'FINDING_MAPPING_INVALID', value, [], sourceObservedAtValue));
    const sourceRef = canonicalSourceRef(input.sourceRef);
    if (isFailure(sourceRef)) return success(baseReceipt(common, context, 'QUARANTINED', 'SOURCE_REF_INVALID', value, [], sourceObservedAtValue));
    if (!context.allowlistedSourceRefs.includes(sourceRef)) return success(baseReceipt(common, context, 'QUARANTINED', 'SOURCE_REF_NOT_ALLOWLISTED', value, [], sourceObservedAtValue));
    if (typeof input.supportingExcerpt !== 'string' || !input.supportingExcerpt.trim()) return success(baseReceipt(common, context, 'QUARANTINED', 'FINDING_EXCERPT_MISSING', value, [], sourceObservedAtValue));
    const evidenceRef = input.evidenceSourceRef === undefined ? sourceRef : canonicalSourceRef(input.evidenceSourceRef);
    if (isFailure(evidenceRef)) return success(baseReceipt(common, context, 'QUARANTINED', 'SOURCE_REF_INVALID', value, [], sourceObservedAtValue));
    const observation = validateAndNormalizeEvidence({ schemaVersion: 1, kind: 'SOURCE_EXCERPT', sourceRef: evidenceRef, excerpt: input.supportingExcerpt, locator: input.locator, capturedAt: sourceObservedAtValue }, context.validationNow);
    if (observation.ok === false) return success(baseReceipt(common, context, 'QUARANTINED', observation.error.code === 'SENSITIVE_CONTENT_FORBIDDEN' ? 'EVIDENCE_INVALID' : 'EVIDENCE_INVALID', value, [], sourceObservedAtValue));
    if (observation.value.kind !== 'SOURCE_EXCERPT' || observation.value.sourceRef !== sourceRef) return success(baseReceipt(common, context, 'QUARANTINED', 'SOURCE_REF_MISMATCH', value, [], sourceObservedAtValue));
    return withEvidence({ relation: 'SUPPORTS', observation: observation.value });
  }

  for (const field of ['artifactStatus', 'provider', 'model']) {
    if (input[field] !== undefined && typeof input[field] !== 'string') return failure('TYPE_MISMATCH');
  }
  if (input.confidenceScore !== undefined && (typeof input.confidenceScore !== 'number' || !Number.isFinite(input.confidenceScore))) return failure('TYPE_MISMATCH');
  if (input.verifiedEvidence === undefined) return success(baseReceipt(common, context, 'PROPOSAL_REVIEW_REQUIRED', 'AI_ARTIFACT_REVIEW_ONLY', value, [], sourceObservedAtValue));
  const verified = verifiedEvidence(input.verifiedEvidence, common.scope.factKey, value.valueDigest, context.allowlistedSourceRefs);
  if (isFailure(verified)) return success(baseReceipt(common, context, 'QUARANTINED', 'VERIFIED_EVIDENCE_INVALID', value, [], sourceObservedAtValue));
  if (verified.value.relation === 'CONTRADICTS') return success(baseReceipt(common, context, 'QUARANTINED', 'EVIDENCE_CONTRADICTS', value, [{ relation: verified.value.relation, kind: 'SOURCE_EXCERPT', sourceRefDigest: verified.value.sourceRefDigest, excerptHash: verified.value.excerptHash }], sourceObservedAtValue));
  return success(baseReceipt(common, context, 'PROPOSAL_WITH_EVIDENCE', 'VERIFIED_EVIDENCE_ACCEPTED', value, [{ relation: verified.value.relation, kind: 'SOURCE_EXCERPT', sourceRefDigest: verified.value.sourceRefDigest, excerptHash: verified.value.excerptHash }], sourceObservedAtValue));
}

export function classifyLegacyRecord(input: unknown, contextInput: unknown): LegacyClassificationResult {
  const context = validateContext(contextInput);
  if (isFailure(context)) return context;
  if (!isRecord(input) || typeof input.sourceKind !== 'string' || !LEGACY_SOURCE_KINDS.includes(input.sourceKind as LegacySourceKind)) return failure('UNSUPPORTED_ENVELOPE');
  const sourceKind = input.sourceKind as LegacySourceKind;
  const allowedFields = sourceKindFields(sourceKind);
  if (!hasOnlyKeys(input, allowedFields) || input.schemaVersion !== 1) return failure('UNKNOWN_FIELD');
  if (allowedFields.some((field) => hasExplicitUndefined(input, field))) return failure('UNKNOWN_FIELD');
  const legacyObjectRef = validateOpaqueRef(input.legacyObjectRef);
  const scope = validateScope(input.scope);
  if (isFailure(legacyObjectRef)) return legacyObjectRef;
  if (isFailure(scope)) return scope;
  if (typeof input.factKey !== 'string' || !FACT_KEYS.includes(input.factKey as FactKey) || input.factKey !== scope.factKey) return failure('INVALID_SCOPE');
  const sourceObservedAtValue = observedAt(input);
  if (isFailure(sourceObservedAtValue)) return sourceObservedAtValue;
  if (Date.parse(sourceObservedAtValue) > Date.parse(context.value.validationNow)) return failure('INVALID_TIMESTAMP');
  const common: CommonLegacyInput = { schemaVersion: 1, sourceKind, legacyObjectRef, scope, factKey: scope.factKey, ...(input.observedAt === undefined ? {} : { observedAt: input.observedAt as string }), ...(input.createdAt === undefined ? {} : { createdAt: input.createdAt as string }), valueEnvelope: input.valueEnvelope };
  const value = normalizeValue(scope.factKey, input.valueEnvelope);
  if (isFailure(value)) {
    const reason: LegacyReasonCode = value.error.code === 'UNKNOWN_FACT_KEY' ? 'UNKNOWN_FACT_KEY' : 'INVALID_FACT_VALUE';
    return success(baseReceipt(common, context.value, 'QUARANTINED', reason, undefined, [], sourceObservedAtValue));
  }
  return classifyParsed(input, context.value, common, value.value, sourceObservedAtValue);
}

function sourceIdentityKey(receipt: LegacyProvenanceReceipt): string {
  return `${receipt.sourceKind}|${receipt.scopeDigest}|${receipt.legacyObjectRefDigest}|${receipt.factKeyDigest}|${receipt.valueDigest ?? 'NO_VALUE_DIGEST'}`;
}

function receiptCanonical(receipt: LegacyProvenanceReceipt): string {
  return stableCanonical(receipt);
}

function emptyTotals(): { byDisposition: Record<LegacyDisposition, number>; bySourceKind: Record<LegacySourceKind, number>; byReasonCode: Record<LegacyReasonCode, number> } {
  return {
    byDisposition: { PROPOSAL_WITH_EVIDENCE: 0, PROPOSAL_REVIEW_REQUIRED: 0, QUARANTINED: 0, SKIPPED: 0 },
    bySourceKind: { LEGACY_LEAD_SCALAR: 0, LEAD_SOURCE: 0, DEEP_RESEARCH_FINDING: 0, AI_ARTIFACT: 0 },
    byReasonCode: Object.fromEntries(LEGACY_REASON_CODES.map((code) => [code, 0])) as Record<LegacyReasonCode, number>,
  };
}

export function dryRunLegacyBatch(input: unknown, contextInput: unknown): LegacyBatchResult {
  const context = validateContext(contextInput);
  if (isFailure(context)) return context;
  if (!isRecord(input) || !hasOnlyKeys(input, ['schemaVersion', 'records']) || input.schemaVersion !== 1) return failure('UNKNOWN_FIELD');
  if (!Array.isArray(input.records) || input.records.length === 0) return failure('BATCH_EMPTY');
  if (input.records.length > 500) return failure('BATCH_TOO_LARGE');
  const classified: LegacyProvenanceReceipt[] = [];
  for (const record of input.records) {
    const result = classifyLegacyRecord(record, contextInput);
    if (isFailure(result)) return result;
    classified.push(result.value);
  }
  const sorted = [...classified].sort((left, right) => {
    const identity = asciiCompare(sourceIdentityKey(left), sourceIdentityKey(right));
    if (identity !== 0) return identity;
    const disposition = DISPOSITION_RANK[left.disposition] - DISPOSITION_RANK[right.disposition];
    if (disposition !== 0) return disposition;
    const sourceKind = SOURCE_KIND_RANK[left.sourceKind] - SOURCE_KIND_RANK[right.sourceKind];
    if (sourceKind !== 0) return sourceKind;
    return asciiCompare(receiptCanonical(left), receiptCanonical(right));
  });
  const seen = new Set<string>();
  const output: LegacyProvenanceReceipt[] = [];
  for (const receipt of sorted) {
    const key = sourceIdentityKey(receipt);
    if (receipt.valueDigest && seen.has(key)) {
      const { evidence: _evidence, ...receiptWithoutEvidence } = receipt;
      void _evidence;
      output.push({ ...receiptWithoutEvidence, disposition: 'SKIPPED', reasonCode: 'DUPLICATE_SKIPPED', evidenceCount: 0 });
      continue;
    }
    if (receipt.valueDigest) seen.add(key);
    output.push(receipt);
  }
  output.sort((left, right) => asciiCompare(receiptCanonical(left), receiptCanonical(right)));
  const totals = emptyTotals();
  for (const receipt of output) {
    totals.byDisposition[receipt.disposition] += 1;
    totals.bySourceKind[receipt.sourceKind] += 1;
    totals.byReasonCode[receipt.reasonCode] += 1;
  }
  const batchDigest = digest(BATCH_DIGEST_PREFIX, BATCH_DOMAIN, output);
  return success({ schemaVersion: 1, adapterVersion: context.value.adapterVersion, batchDigest, totals, records: output });
}
