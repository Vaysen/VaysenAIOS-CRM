/**
 * CRM-04A-4B: verified legacy dry-run import plan and rejection report.
 *
 * This contract accepts only the sanitized receipt projection emitted by the
 * 04A-4A adapter. It never accepts legacy rows, URLs, excerpts, reports, AI
 * output, or customer text, and it never creates a database/DML execution plan.
 */

import { createHash } from 'node:crypto';
import {
  LEGACY_ADAPTER_VERSION,
  LEGACY_DISPOSITIONS,
  LEGACY_REASON_CODES,
  LEGACY_SOURCE_KINDS,
  type LegacyDisposition,
  type LegacyProvenanceReceipt,
  type LegacyReasonCode,
  type LegacySourceKind,
} from './legacy-adapter-contract';

export const LEGACY_IMPORT_EXECUTION_MODE = 'DRY_RUN_ONLY' as const;
export const LEGACY_IMPORT_PLAN_VERSION = 'legacy-import-plan-v1' as const;

const PLAN_ITEM_DIGEST_PREFIX = 'sha256:legacy-proposal-plan-item-v1:';
const PLAN_DIGEST_PREFIX = 'sha256:legacy-import-plan-v1:';
const REPORT_ITEM_DIGEST_PREFIX = 'sha256:legacy-rejection-report-item-v1:';
const BATCH_DIGEST_PATTERN = /^sha256:legacy-batch-v1:[0-9a-f]{64}$/;
const PLAN_ITEM_DIGEST_PATTERN = /^sha256:legacy-proposal-plan-item-v1:[0-9a-f]{64}$/;
const LEGACY_REF_DIGEST_PATTERN = /^sha256:legacy-object-ref-v1:[0-9a-f]{64}$/;
const SCOPE_DIGEST_PATTERN = /^sha256:legacy-scope-v1:[0-9a-f]{64}$/;
const FACT_KEY_DIGEST_PATTERN = /^sha256:legacy-fact-key-v1:[0-9a-f]{64}$/;
const VALUE_DIGEST_PATTERN = /^sha256:fact-value-v1:[0-9a-f]{64}$/;
const SOURCE_REF_DIGEST_PATTERN = /^sha256:legacy-source-ref-v1:[0-9a-f]{64}$/;
const EXCERPT_HASH_PATTERN = /^sha256:source-excerpt-v1:[0-9a-f]{64}$/;
const UTC_INSTANT_PATTERN = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})\.(\d{3})Z$/;
const VALUE_TYPES = Object.freeze([
  'TEXT', 'URL', 'COUNTRY_CODE', 'INTEGER', 'ENUM', 'TEXT_LIST', 'INTEGER_RANGE',
] as const);
type ImportValueType = (typeof VALUE_TYPES)[number];

const PROPOSAL_DISPOSITIONS = Object.freeze([
  'PROPOSAL_WITH_EVIDENCE',
  'PROPOSAL_REVIEW_REQUIRED',
] as const);
type ProposalDisposition = (typeof PROPOSAL_DISPOSITIONS)[number];

const ALLOWED_REASON_BY_DISPOSITION: Readonly<Record<LegacyDisposition, readonly LegacyReasonCode[]>> = Object.freeze({
  PROPOSAL_WITH_EVIDENCE: ['EVIDENCE_ACCEPTED', 'VERIFIED_EVIDENCE_ACCEPTED'],
  PROPOSAL_REVIEW_REQUIRED: [
    'NO_INDEPENDENT_EVIDENCE',
    'SOURCE_URL_NOT_EVIDENCE',
    'EVIDENCE_NOT_INDEPENDENT',
    'AI_ARTIFACT_REVIEW_ONLY',
  ],
  QUARANTINED: [
    'EVIDENCE_INVALID',
    'EVIDENCE_CONTRADICTS',
    'SOURCE_REF_INVALID',
    'SOURCE_REF_NOT_ALLOWLISTED',
    'SOURCE_REF_MISMATCH',
    'FINDING_EXCERPT_MISSING',
    'FINDING_MAPPING_INVALID',
    'VERIFIED_EVIDENCE_INVALID',
    'INVALID_FACT_VALUE',
    'UNKNOWN_FACT_KEY',
  ],
  SKIPPED: ['DUPLICATE_SKIPPED'],
});

const ALLOWED_REASON_BY_SOURCE_KIND: Readonly<Record<LegacySourceKind, Readonly<Record<LegacyDisposition, readonly LegacyReasonCode[]>>>> = Object.freeze({
  LEGACY_LEAD_SCALAR: Object.freeze({
    PROPOSAL_WITH_EVIDENCE: ['EVIDENCE_ACCEPTED'] as const,
    PROPOSAL_REVIEW_REQUIRED: ['NO_INDEPENDENT_EVIDENCE', 'EVIDENCE_NOT_INDEPENDENT'] as const,
    QUARANTINED: ['EVIDENCE_INVALID', 'EVIDENCE_CONTRADICTS', 'FINDING_MAPPING_INVALID', 'INVALID_FACT_VALUE'] as const,
    SKIPPED: ['DUPLICATE_SKIPPED'] as const,
  }),
  LEAD_SOURCE: Object.freeze({
    PROPOSAL_WITH_EVIDENCE: ['EVIDENCE_ACCEPTED'] as const,
    PROPOSAL_REVIEW_REQUIRED: ['SOURCE_URL_NOT_EVIDENCE', 'EVIDENCE_NOT_INDEPENDENT'] as const,
    QUARANTINED: ['SOURCE_REF_INVALID', 'SOURCE_REF_MISMATCH', 'EVIDENCE_INVALID', 'EVIDENCE_CONTRADICTS', 'INVALID_FACT_VALUE'] as const,
    SKIPPED: ['DUPLICATE_SKIPPED'] as const,
  }),
  DEEP_RESEARCH_FINDING: Object.freeze({
    PROPOSAL_WITH_EVIDENCE: ['EVIDENCE_ACCEPTED'] as const,
    PROPOSAL_REVIEW_REQUIRED: [] as const,
    QUARANTINED: ['SOURCE_REF_INVALID', 'SOURCE_REF_NOT_ALLOWLISTED', 'SOURCE_REF_MISMATCH', 'FINDING_EXCERPT_MISSING', 'FINDING_MAPPING_INVALID', 'EVIDENCE_INVALID', 'INVALID_FACT_VALUE'] as const,
    SKIPPED: ['DUPLICATE_SKIPPED'] as const,
  }),
  AI_ARTIFACT: Object.freeze({
    PROPOSAL_WITH_EVIDENCE: ['VERIFIED_EVIDENCE_ACCEPTED'] as const,
    PROPOSAL_REVIEW_REQUIRED: ['AI_ARTIFACT_REVIEW_ONLY'] as const,
    QUARANTINED: ['VERIFIED_EVIDENCE_INVALID', 'EVIDENCE_CONTRADICTS', 'INVALID_FACT_VALUE'] as const,
    SKIPPED: ['DUPLICATE_SKIPPED'] as const,
  }),
});

const ERROR_MESSAGES = Object.freeze({
  UNSUPPORTED_ENVELOPE: 'legacy import plan envelope is unsupported',
  UNKNOWN_FIELD: 'legacy import plan contains an unknown field',
  TYPE_MISMATCH: 'legacy import plan field has an invalid type',
  INVALID_ADAPTER_VERSION: 'legacy import plan adapter version is invalid',
  INVALID_BATCH_DIGEST: 'legacy import plan batch digest is invalid',
  BATCH_DIGEST_MISMATCH: 'legacy import plan batch digest does not match receipts',
  INVALID_BATCH_SIZE: 'legacy import plan batch size is invalid',
  INVALID_TOTALS: 'legacy import plan totals are invalid',
  INVALID_RECORD: 'legacy import plan receipt projection is invalid',
  INVALID_DISPOSITION_REASON: 'legacy import plan disposition and reason are invalid',
  DUPLICATE_RECORD_IDENTITY: 'legacy import plan contains a duplicate receipt identity',
  INVALID_VALUE_DIGEST: 'legacy import plan value digest is invalid',
  VALUE_DIGEST_REQUIRED: 'legacy import plan proposal value digest is required',
  INVALID_VALUE_SHAPE: 'legacy import plan value shape is invalid',
  INVALID_VALUE_TYPE: 'legacy import plan value type is invalid',
  INVALID_TIMESTAMP: 'legacy import plan timestamp is invalid',
  EVIDENCE_COUNT_MISMATCH: 'legacy import plan evidence count does not match evidence',
  INVALID_EVIDENCE_SUMMARY: 'legacy import plan evidence summary is invalid',
  CONTRADICTORY_PROPOSAL: 'contradictory evidence cannot become a proposal plan',
  NON_INDEPENDENT_PROPOSAL: 'proposal plan requires independent source evidence',
  INVALID_RECEIPT_REACHABILITY: 'receipt disposition and reason are not reachable from its source kind',
  INVALID_PLAN_DIGEST: 'legacy import plan digest is invalid',
});

export type LegacyImportPlanErrorCode = keyof typeof ERROR_MESSAGES;

type Failure = Readonly<{
  ok: false;
  error: Readonly<{ code: LegacyImportPlanErrorCode; message: string }>;
}>;
type Result<T> = Readonly<{ ok: true; value: T }> | Failure;

type EvidenceSummary = NonNullable<LegacyProvenanceReceipt['evidence']>[number];

export type LegacyImportBatchInput = Readonly<{
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

export type LegacyProposalPlanItem = Readonly<{
  schemaVersion: 1;
  planItemDigest: string;
  executionMode: typeof LEGACY_IMPORT_EXECUTION_MODE;
  batchDigest: string;
  adapterVersion: typeof LEGACY_ADAPTER_VERSION;
  sourceKind: LegacySourceKind;
  disposition: ProposalDisposition;
  scopeDigest: string;
  legacyObjectRefDigest: string;
  factKeyDigest: string;
  valueDigest: string;
  valueType: ImportValueType;
  sourceObservedAt: string;
  evidenceCount: number;
  evidence?: readonly EvidenceSummary[];
}>;

export type LegacyRejectionReportItem = Readonly<{
  schemaVersion: 1;
  reportItemDigest: string;
  reportKind: 'QUARANTINE' | 'SKIP';
  executionMode: typeof LEGACY_IMPORT_EXECUTION_MODE;
  batchDigest: string;
  adapterVersion: typeof LEGACY_ADAPTER_VERSION;
  sourceKind: LegacySourceKind;
  disposition: 'QUARANTINED' | 'SKIPPED';
  reasonCode: LegacyReasonCode;
  scopeDigest: string;
  legacyObjectRefDigest: string;
  factKeyDigest: string;
  sourceObservedAt: string;
  evidenceCount: number;
  valueDigest?: string;
  valueType?: ImportValueType;
  evidence?: readonly EvidenceSummary[];
}>;

export type LegacyImportPlan = Readonly<{
  schemaVersion: 1;
  executionMode: typeof LEGACY_IMPORT_EXECUTION_MODE;
  planVersion: typeof LEGACY_IMPORT_PLAN_VERSION;
  adapterVersion: typeof LEGACY_ADAPTER_VERSION;
  batchDigest: string;
  planDigest: string;
  proposalPlanItems: readonly LegacyProposalPlanItem[];
  rejectionReport: readonly LegacyRejectionReportItem[];
  totals: Readonly<{
    inputRecords: number;
    proposalPlanItems: number;
    quarantined: number;
    skipped: number;
  }>;
}>;

export type LegacyImportPlanResult = Result<LegacyImportPlan>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asciiCompare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function hasExplicitUndefined(value: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key) && value[key] === undefined;
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  const set = new Set(allowed);
  return Object.keys(value).every((key) => set.has(key));
}

function deepFreeze<T>(value: T): T {
  if (value === null || typeof value !== 'object' || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  return value;
}

function success<T>(value: T): Result<T> {
  return deepFreeze({ ok: true, value });
}

function failure(code: LegacyImportPlanErrorCode): Failure {
  return deepFreeze({ ok: false, error: { code, message: ERROR_MESSAGES[code] } });
}

function isFailure(value: unknown): value is Failure {
  return isRecord(value) && value.ok === false && isRecord(value.error);
}

function stableCanonical(value: unknown): string {
  if (value === null) return 'null';
  if (typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number' || typeof value === 'boolean') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableCanonical).join(',')}]`;
  if (isRecord(value)) {
    return `{${Object.keys(value).sort(asciiCompare).map((key) => `${JSON.stringify(key)}:${stableCanonical(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(String(value));
}

function digest(prefix: string, domain: string, value: unknown): string {
  const canonical = stableCanonical(value);
  const hash = createHash('sha256').update(`${domain}\0${canonical}`, 'utf8').digest('hex');
  return `${prefix}${hash}`;
}

function canonicalUtc(value: unknown): string | Failure {
  if (typeof value !== 'string') return failure('INVALID_TIMESTAMP');
  const match = UTC_INSTANT_PATTERN.exec(value);
  if (!match) return failure('INVALID_TIMESTAMP');
  const timestamp = Date.parse(value);
  const normalized = Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : '';
  return normalized === value ? value : failure('INVALID_TIMESTAMP');
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function validateMap(value: unknown, keys: readonly string[]): Record<string, number> | Failure {
  if (!isRecord(value) || !hasOnlyKeys(value, keys) || Object.keys(value).length !== keys.length) return failure('INVALID_TOTALS');
  const output: Record<string, number> = {};
  for (const key of keys) {
    if (hasExplicitUndefined(value, key) || !isNonNegativeInteger(value[key])) return failure('INVALID_TOTALS');
    output[key] = value[key] as number;
  }
  return output;
}

function validateEvidenceSummary(value: unknown): EvidenceSummary | Failure {
  if (!isRecord(value) || !hasOnlyKeys(value, ['relation', 'kind', 'sourceRefDigest', 'excerptHash'])) return failure('INVALID_EVIDENCE_SUMMARY');
  for (const key of ['sourceRefDigest', 'excerptHash']) {
    if (hasExplicitUndefined(value, key)) return failure('UNKNOWN_FIELD');
  }
  if (value.relation !== 'SUPPORTS' && value.relation !== 'CONTRADICTS') return failure('INVALID_EVIDENCE_SUMMARY');
  if (value.kind === 'SOURCE_EXCERPT') {
    if (typeof value.sourceRefDigest !== 'string' || !SOURCE_REF_DIGEST_PATTERN.test(value.sourceRefDigest)) return failure('INVALID_EVIDENCE_SUMMARY');
    if (typeof value.excerptHash !== 'string' || !EXCERPT_HASH_PATTERN.test(value.excerptHash)) return failure('INVALID_EVIDENCE_SUMMARY');
    return { relation: value.relation, kind: value.kind, sourceRefDigest: value.sourceRefDigest, excerptHash: value.excerptHash };
  }
  if (value.kind === 'MANUAL_ATTESTATION' && !Object.prototype.hasOwnProperty.call(value, 'sourceRefDigest') && !Object.prototype.hasOwnProperty.call(value, 'excerptHash')) {
    return { relation: value.relation, kind: value.kind };
  }
  return failure('INVALID_EVIDENCE_SUMMARY');
}

function evidenceCanonicalKey(value: EvidenceSummary): string {
  return stableCanonical(value);
}

function validateEvidenceShape(
  disposition: LegacyDisposition,
  reasonCode: LegacyReasonCode,
  evidenceCount: number,
  evidence: readonly EvidenceSummary[] | undefined,
  hasValueDigest: boolean,
): Failure | undefined {
  if (evidenceCount > 1) return failure('EVIDENCE_COUNT_MISMATCH');
  if (evidenceCount === 0) {
    if (reasonCode === 'DUPLICATE_SKIPPED' && (!hasValueDigest || disposition !== 'SKIPPED')) return failure('VALUE_DIGEST_REQUIRED');
    if (disposition === 'PROPOSAL_WITH_EVIDENCE') return failure('CONTRADICTORY_PROPOSAL');
    if (reasonCode === 'EVIDENCE_NOT_INDEPENDENT' || reasonCode === 'EVIDENCE_ACCEPTED' || reasonCode === 'VERIFIED_EVIDENCE_ACCEPTED' || reasonCode === 'EVIDENCE_CONTRADICTS') {
      return failure('INVALID_EVIDENCE_SUMMARY');
    }
    return undefined;
  }

  const item = evidence?.[0];
  if (!item) return failure('EVIDENCE_COUNT_MISMATCH');
  if (reasonCode === 'EVIDENCE_ACCEPTED' || reasonCode === 'VERIFIED_EVIDENCE_ACCEPTED') {
    if (item.relation === 'CONTRADICTS') return failure('CONTRADICTORY_PROPOSAL');
    if (item.kind !== 'SOURCE_EXCERPT') return failure('NON_INDEPENDENT_PROPOSAL');
    if (item.relation !== 'SUPPORTS') return failure('INVALID_EVIDENCE_SUMMARY');
    return undefined;
  }
  if (reasonCode === 'EVIDENCE_CONTRADICTS') {
    return item.kind === 'SOURCE_EXCERPT' && item.relation === 'CONTRADICTS'
      ? undefined
      : failure('INVALID_EVIDENCE_SUMMARY');
  }
  if (reasonCode === 'EVIDENCE_NOT_INDEPENDENT') {
    return item.kind === 'MANUAL_ATTESTATION' && item.relation === 'SUPPORTS'
      ? undefined
      : failure('INVALID_EVIDENCE_SUMMARY');
  }
  return failure('INVALID_EVIDENCE_SUMMARY');
}

function validateReceipt(value: unknown): LegacyProvenanceReceipt | Failure {
  const allowed = [
    'schemaVersion', 'sourceKind', 'disposition', 'reasonCode',
    'legacyObjectRefDigest', 'scopeDigest', 'factKeyDigest', 'sourceObservedAt',
    'adapterVersion', 'valueDigest', 'valueType', 'evidenceCount', 'evidence',
  ];
  if (!isRecord(value)) return failure('INVALID_RECORD');
  if (!hasOnlyKeys(value, allowed)) return failure('UNKNOWN_FIELD');
  if (value.schemaVersion !== 1) return failure('INVALID_RECORD');
  if (allowed.some((key) => hasExplicitUndefined(value, key))) return failure('UNKNOWN_FIELD');
  if (!LEGACY_SOURCE_KINDS.includes(value.sourceKind as LegacySourceKind) || !LEGACY_DISPOSITIONS.includes(value.disposition as LegacyDisposition) || !LEGACY_REASON_CODES.includes(value.reasonCode as LegacyReasonCode)) return failure('INVALID_RECORD');
  const disposition = value.disposition as LegacyDisposition;
  if (!ALLOWED_REASON_BY_DISPOSITION[disposition].includes(value.reasonCode as LegacyReasonCode)) return failure('INVALID_DISPOSITION_REASON');
  if (typeof value.adapterVersion !== 'string' || value.adapterVersion !== LEGACY_ADAPTER_VERSION) return failure('INVALID_ADAPTER_VERSION');
  if (typeof value.legacyObjectRefDigest !== 'string' || !LEGACY_REF_DIGEST_PATTERN.test(value.legacyObjectRefDigest) || typeof value.scopeDigest !== 'string' || !SCOPE_DIGEST_PATTERN.test(value.scopeDigest) || typeof value.factKeyDigest !== 'string' || !FACT_KEY_DIGEST_PATTERN.test(value.factKeyDigest)) return failure('INVALID_RECORD');
  const sourceObservedAt = canonicalUtc(value.sourceObservedAt);
  if (isFailure(sourceObservedAt)) return sourceObservedAt;

  const hasValueDigest = Object.prototype.hasOwnProperty.call(value, 'valueDigest');
  const hasValueType = Object.prototype.hasOwnProperty.call(value, 'valueType');
  if (hasValueDigest !== hasValueType) return failure('INVALID_RECORD');
  let valueDigest: string | undefined;
  let valueType: ImportValueType | undefined;
  if (hasValueDigest) {
    if (typeof value.valueDigest !== 'string' || !VALUE_DIGEST_PATTERN.test(value.valueDigest)) return failure('INVALID_VALUE_DIGEST');
    if (typeof value.valueType !== 'string' || !VALUE_TYPES.includes(value.valueType as ImportValueType)) return failure('INVALID_VALUE_TYPE');
    valueDigest = value.valueDigest;
    valueType = value.valueType as ImportValueType;
  }

  if (typeof value.evidenceCount !== 'number' || !isNonNegativeInteger(value.evidenceCount)) return failure('EVIDENCE_COUNT_MISMATCH');
  if (value.evidenceCount > 1) return failure('EVIDENCE_COUNT_MISMATCH');
  const hasEvidence = Object.prototype.hasOwnProperty.call(value, 'evidence');
  if (value.evidenceCount === 0 && hasEvidence) return failure('EVIDENCE_COUNT_MISMATCH');
  let evidence: readonly EvidenceSummary[] | undefined;
  if (value.evidenceCount > 0) {
    if (!hasEvidence || !Array.isArray(value.evidence) || value.evidence.length !== value.evidenceCount) return failure('EVIDENCE_COUNT_MISMATCH');
    const summaries: EvidenceSummary[] = [];
    for (const item of value.evidence) {
      const summary = validateEvidenceSummary(item);
      if (isFailure(summary)) return summary;
      summaries.push(summary);
    }
    evidence = summaries;
  }
  if (disposition === 'PROPOSAL_WITH_EVIDENCE' && (!valueDigest || !valueType)) return failure('VALUE_DIGEST_REQUIRED');
  if ((disposition === 'PROPOSAL_WITH_EVIDENCE' || disposition === 'PROPOSAL_REVIEW_REQUIRED') && evidence?.some((item) => item.relation === 'CONTRADICTS')) return failure('CONTRADICTORY_PROPOSAL');
  const sourceKind = value.sourceKind as LegacySourceKind;
  if (!ALLOWED_REASON_BY_SOURCE_KIND[sourceKind][disposition].includes(value.reasonCode as LegacyReasonCode)) return failure('INVALID_RECEIPT_REACHABILITY');
  if (value.reasonCode === 'INVALID_FACT_VALUE') {
    if (hasValueDigest || hasValueType) return failure('INVALID_VALUE_SHAPE');
  } else if (!hasValueDigest || !hasValueType) {
    return failure('INVALID_VALUE_SHAPE');
  }
  const evidenceShapeFailure = validateEvidenceShape(disposition, value.reasonCode as LegacyReasonCode, value.evidenceCount, evidence, hasValueDigest);
  if (evidenceShapeFailure) return evidenceShapeFailure;
  return {
    schemaVersion: 1,
    sourceKind: value.sourceKind as LegacySourceKind,
    disposition,
    reasonCode: value.reasonCode as LegacyReasonCode,
    legacyObjectRefDigest: value.legacyObjectRefDigest,
    scopeDigest: value.scopeDigest,
    factKeyDigest: value.factKeyDigest,
    sourceObservedAt,
    adapterVersion: LEGACY_ADAPTER_VERSION,
    ...(valueDigest && valueType ? { valueDigest, valueType } : {}),
    evidenceCount: value.evidenceCount,
    ...(evidence ? { evidence } : {}),
  };
}

function receiptIdentity(value: LegacyProvenanceReceipt): string {
  return [
    value.sourceKind,
    value.scopeDigest,
    value.legacyObjectRefDigest,
    value.factKeyDigest,
    value.valueDigest as string,
  ].join('|');
}

function hasCompleteValue(value: LegacyProvenanceReceipt): boolean {
  return value.valueDigest !== undefined && value.valueType !== undefined;
}

function isDuplicateSkip(value: LegacyProvenanceReceipt): boolean {
  return value.disposition === 'SKIPPED'
    && value.reasonCode === 'DUPLICATE_SKIPPED'
    && value.evidenceCount === 0
    && value.evidence === undefined
    && hasCompleteValue(value);
}

function validateBatch(input: unknown): Result<Readonly<{ adapterVersion: typeof LEGACY_ADAPTER_VERSION; batchDigest: string; records: readonly LegacyProvenanceReceipt[] }>> {
  const allowed = ['schemaVersion', 'adapterVersion', 'batchDigest', 'totals', 'records'];
  if (!isRecord(input)) return failure('UNSUPPORTED_ENVELOPE');
  if (!hasOnlyKeys(input, allowed)) return failure('UNKNOWN_FIELD');
  if (input.schemaVersion !== 1) return failure('UNSUPPORTED_ENVELOPE');
  if (allowed.some((key) => hasExplicitUndefined(input, key))) return failure('UNKNOWN_FIELD');
  if (input.adapterVersion !== LEGACY_ADAPTER_VERSION) return failure('INVALID_ADAPTER_VERSION');
  if (typeof input.batchDigest !== 'string' || !BATCH_DIGEST_PATTERN.test(input.batchDigest)) return failure('INVALID_BATCH_DIGEST');
  if (!Array.isArray(input.records) || input.records.length < 1 || input.records.length > 500) return failure('INVALID_BATCH_SIZE');
  const byDisposition = validateMap(isRecord(input.totals) ? input.totals.byDisposition : undefined, LEGACY_DISPOSITIONS);
  const bySourceKind = validateMap(isRecord(input.totals) ? input.totals.bySourceKind : undefined, LEGACY_SOURCE_KINDS);
  const byReasonCode = validateMap(isRecord(input.totals) ? input.totals.byReasonCode : undefined, LEGACY_REASON_CODES);
  if (isFailure(byDisposition) || isFailure(bySourceKind) || isFailure(byReasonCode)) return failure('INVALID_TOTALS');
  if (!isRecord(input.totals) || !hasOnlyKeys(input.totals, ['byDisposition', 'bySourceKind', 'byReasonCode']) || Object.keys(input.totals).length !== 3) return failure('INVALID_TOTALS');

  const records: LegacyProvenanceReceipt[] = [];
  for (const raw of input.records) {
    const record = validateReceipt(raw);
    if (isFailure(record)) return record;
    records.push(record);
  }
  const groups = new Map<string, LegacyProvenanceReceipt[]>();
  for (const record of records) {
    if (!hasCompleteValue(record)) continue;
    const key = receiptIdentity(record);
    const group = groups.get(key) ?? [];
    group.push(record);
    groups.set(key, group);
  }
  for (const group of groups.values()) {
    const primaries = group.filter((record) => !isDuplicateSkip(record));
    if (primaries.length !== 1) return failure('DUPLICATE_RECORD_IDENTITY');
  }

  const sortedRecords = [...records].sort((left, right) => asciiCompare(stableCanonical(left), stableCanonical(right)));
  const computedBatchDigest = digest('sha256:legacy-batch-v1:', 'vaysen-trade-crm/legacy-adapter/batch/v1', sortedRecords);
  if (computedBatchDigest !== input.batchDigest) return failure('BATCH_DIGEST_MISMATCH');

  const expectedDisposition = Object.fromEntries(LEGACY_DISPOSITIONS.map((key) => [key, 0])) as Record<LegacyDisposition, number>;
  const expectedSourceKind = Object.fromEntries(LEGACY_SOURCE_KINDS.map((key) => [key, 0])) as Record<LegacySourceKind, number>;
  const expectedReason = Object.fromEntries(LEGACY_REASON_CODES.map((key) => [key, 0])) as Record<LegacyReasonCode, number>;
  for (const record of records) {
    expectedDisposition[record.disposition] += 1;
    expectedSourceKind[record.sourceKind] += 1;
    expectedReason[record.reasonCode] += 1;
  }
  if (stableCanonical(expectedDisposition) !== stableCanonical(byDisposition) || stableCanonical(expectedSourceKind) !== stableCanonical(bySourceKind) || stableCanonical(expectedReason) !== stableCanonical(byReasonCode)) return failure('INVALID_TOTALS');
  return success({ adapterVersion: LEGACY_ADAPTER_VERSION, batchDigest: input.batchDigest, records: sortedRecords });
}

function sortedEvidence(value: readonly EvidenceSummary[] | undefined): readonly EvidenceSummary[] | undefined {
  if (!value) return undefined;
  return [...value].sort((left, right) => asciiCompare(evidenceCanonicalKey(left), evidenceCanonicalKey(right)));
}

function planItemFromReceipt(receipt: LegacyProvenanceReceipt, batchDigest: string): LegacyProposalPlanItem {
  const evidence = sortedEvidence(receipt.evidence);
  const itemWithoutDigest = {
    schemaVersion: 1 as const,
    executionMode: LEGACY_IMPORT_EXECUTION_MODE,
    batchDigest,
    adapterVersion: LEGACY_ADAPTER_VERSION,
    sourceKind: receipt.sourceKind,
    disposition: receipt.disposition as ProposalDisposition,
    scopeDigest: receipt.scopeDigest,
    legacyObjectRefDigest: receipt.legacyObjectRefDigest,
    factKeyDigest: receipt.factKeyDigest,
    valueDigest: receipt.valueDigest as string,
    valueType: receipt.valueType as ImportValueType,
    sourceObservedAt: receipt.sourceObservedAt as string,
    evidenceCount: receipt.evidenceCount,
    ...(evidence ? { evidence } : {}),
  };
  return {
    ...itemWithoutDigest,
    planItemDigest: digest(PLAN_ITEM_DIGEST_PREFIX, 'vaysen-trade-crm/legacy-import/proposal-plan-item/v1', itemWithoutDigest),
  };
}

function reportItemFromReceipt(receipt: LegacyProvenanceReceipt, batchDigest: string): LegacyRejectionReportItem {
  const evidence = sortedEvidence(receipt.evidence);
  const itemWithoutDigest = {
    schemaVersion: 1 as const,
    reportKind: receipt.disposition === 'QUARANTINED' ? 'QUARANTINE' as const : 'SKIP' as const,
    executionMode: LEGACY_IMPORT_EXECUTION_MODE,
    batchDigest,
    adapterVersion: LEGACY_ADAPTER_VERSION,
    sourceKind: receipt.sourceKind,
    disposition: receipt.disposition as 'QUARANTINED' | 'SKIPPED',
    reasonCode: receipt.reasonCode,
    scopeDigest: receipt.scopeDigest,
    legacyObjectRefDigest: receipt.legacyObjectRefDigest,
    factKeyDigest: receipt.factKeyDigest,
    sourceObservedAt: receipt.sourceObservedAt as string,
    evidenceCount: receipt.evidenceCount,
    ...(receipt.valueDigest && receipt.valueType ? { valueDigest: receipt.valueDigest, valueType: receipt.valueType } : {}),
    ...(evidence ? { evidence } : {}),
  };
  return {
    ...itemWithoutDigest,
    reportItemDigest: digest(REPORT_ITEM_DIGEST_PREFIX, 'vaysen-trade-crm/legacy-import/rejection-report-item/v1', itemWithoutDigest),
  };
}

export function buildLegacyImportPlan(input: unknown): LegacyImportPlanResult {
  const batch = validateBatch(input);
  if (isFailure(batch)) return batch;
  const proposalPlanItems: LegacyProposalPlanItem[] = [];
  const rejectionReport: LegacyRejectionReportItem[] = [];
  for (const receipt of batch.value.records) {
    if (receipt.disposition === 'PROPOSAL_WITH_EVIDENCE' || receipt.disposition === 'PROPOSAL_REVIEW_REQUIRED') {
      if (!receipt.valueDigest || !receipt.valueType || !receipt.sourceObservedAt) return failure('VALUE_DIGEST_REQUIRED');
      proposalPlanItems.push(planItemFromReceipt(receipt, batch.value.batchDigest));
    } else {
      rejectionReport.push(reportItemFromReceipt(receipt, batch.value.batchDigest));
    }
  }
  proposalPlanItems.sort((left, right) => asciiCompare(left.planItemDigest, right.planItemDigest));
  rejectionReport.sort((left, right) => asciiCompare(left.reportItemDigest, right.reportItemDigest));
  const totals = {
    inputRecords: batch.value.records.length,
    proposalPlanItems: proposalPlanItems.length,
    quarantined: rejectionReport.filter((item) => item.reportKind === 'QUARANTINE').length,
    skipped: rejectionReport.filter((item) => item.reportKind === 'SKIP').length,
  };
  const planWithoutDigest = {
    schemaVersion: 1 as const,
    executionMode: LEGACY_IMPORT_EXECUTION_MODE,
    planVersion: LEGACY_IMPORT_PLAN_VERSION,
    adapterVersion: LEGACY_ADAPTER_VERSION,
    batchDigest: batch.value.batchDigest,
    proposalPlanItems,
    rejectionReport,
    totals,
  };
  const planDigest = digest(PLAN_DIGEST_PREFIX, 'vaysen-trade-crm/legacy-import/plan/v1', planWithoutDigest);
  return success({ ...planWithoutDigest, planDigest });
}
