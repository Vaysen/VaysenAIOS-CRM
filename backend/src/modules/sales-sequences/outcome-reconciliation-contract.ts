/**
 * CRM-03E-1: provider/business outcome and manual reconciliation metadata.
 *
 * This is a pure, fail-closed projection contract. It never calls a provider,
 * writes an Outbox row, retries an action, or claims that a public digest is a
 * signature. CRM-03A remains the only StepExecution authority.
 */

import { createHash } from 'node:crypto';
import {
  computeEnrollmentStopEventDigest,
  computeEnrollmentStopOperationDigest,
  type EnrollmentStopEventReceiptProjection,
} from './enrollment-stop-event-contract';
import {
  computeDedupeEvidenceDigest,
  planOutboxCompliance,
  type OutboxComplianceReceiptProjection,
} from './outbox-compliance-plan-contract';
import {
  planEnrollmentTransition,
  planStepExecutionTransition,
  type Channel,
  type TransitionPlan,
} from './sales-sequence-contract';

export const OUTCOME_RECONCILIATION_SCHEMA_VERSION = 1 as const;
export const OUTCOME_RECONCILIATION_POLICY_VERSION = 1 as const;
export const OUTCOME_RECONCILIATION_INTENT = 'RECONCILE_OUTCOME' as const;

export type ProviderOutcome = 'ACCEPTED' | 'DELIVERED' | 'FAILED' | 'UNKNOWN';
export type OutcomeDecision =
  | 'PROVIDER_EVIDENCE_ONLY'
  | 'BUSINESS_SENT'
  | 'MANUAL_RECONCILIATION_REQUIRED'
  | 'STOP_RECONCILIATION_REQUIRED'
  | 'REPLAY';
export type OutcomeReaderState = 'sending' | 'sent' | 'failed' | 'unknown';
export type OutcomeReconciliationErrorCode =
  | 'UNSUPPORTED_ENVELOPE'
  | 'UNKNOWN_FIELD'
  | 'EXPLICIT_UNDEFINED'
  | 'TYPE_MISMATCH'
  | 'PII_OR_SECRET_INPUT'
  | 'INVALID_REF'
  | 'INVALID_DIGEST'
  | 'INVALID_VERSION'
  | 'INVALID_POLICY_VERSION'
  | 'INVALID_CHANNEL'
  | 'INVALID_TIMESTAMP'
  | 'FUTURE_EVIDENCE'
  | 'STALE_EVIDENCE'
  | 'INVALID_STATE'
  | 'SCOPE_MISMATCH'
  | 'RESERVATION_RECEIPT_INVALID'
  | 'PROVIDER_EVIDENCE_INVALID'
  | 'BUSINESS_RECEIPT_INVALID'
  | 'STOP_DECISION_INVALID'
  | 'STOP_MAPPING_MISMATCH'
  | 'INVALID_OUTCOME'
  | 'OUTCOME_CONFLICT'
  | 'AUTHORITY_TRANSITION_REJECTED'
  | 'FAILED_REQUIRES_MANUAL_RECONCILIATION'
  | 'UNKNOWN_REQUIRES_MANUAL_RECONCILIATION'
  | 'INVALID_PERSISTED_RECEIPT'
  | 'UNSAFE_INPUT_GRAPH'
  | 'REPLAY_STATE_MISMATCH'
  | 'OPERATION_DIGEST_MISMATCH'
  | 'PROVIDER_OUTCOME_FORBIDDEN'
  | 'BUSINESS_SENT_FORBIDDEN'
  | 'RETRY_FORBIDDEN';

const ERROR_MESSAGES: Readonly<Record<OutcomeReconciliationErrorCode, string>> = Object.freeze({
  UNSUPPORTED_ENVELOPE: 'outcome reconciliation envelope is unsupported',
  UNKNOWN_FIELD: 'outcome reconciliation envelope contains an unknown field',
  EXPLICIT_UNDEFINED: 'outcome reconciliation envelope contains explicit undefined',
  TYPE_MISMATCH: 'outcome reconciliation envelope has an invalid type',
  PII_OR_SECRET_INPUT: 'outcome reconciliation envelope contains disallowed sensitive input',
  INVALID_REF: 'outcome reconciliation reference is invalid',
  INVALID_DIGEST: 'outcome reconciliation digest is invalid',
  INVALID_VERSION: 'outcome reconciliation version is invalid',
  INVALID_POLICY_VERSION: 'outcome reconciliation schema or policy version is invalid',
  INVALID_CHANNEL: 'outcome reconciliation channel is invalid',
  INVALID_TIMESTAMP: 'outcome reconciliation timestamp is invalid',
  FUTURE_EVIDENCE: 'outcome reconciliation evidence is future-dated',
  STALE_EVIDENCE: 'outcome reconciliation evidence is stale',
  INVALID_STATE: 'outcome reconciliation reader state is invalid',
  SCOPE_MISMATCH: 'outcome reconciliation scope does not match the reader or reservation',
  RESERVATION_RECEIPT_INVALID: 'persisted Outbox reservation receipt is invalid',
  PROVIDER_EVIDENCE_INVALID: 'provider outcome evidence is invalid',
  BUSINESS_RECEIPT_INVALID: 'business outcome receipt is invalid',
  STOP_DECISION_INVALID: '03B stop decision projection is invalid',
  STOP_MAPPING_MISMATCH: '03B stop decision mapping is invalid',
  INVALID_OUTCOME: 'provider outcome is invalid',
  OUTCOME_CONFLICT: 'outcome conflicts with the persisted operation',
  AUTHORITY_TRANSITION_REJECTED: 'CRM-03A rejected the outcome transition',
  FAILED_REQUIRES_MANUAL_RECONCILIATION: 'provider failure requires manual reconciliation',
  UNKNOWN_REQUIRES_MANUAL_RECONCILIATION: 'unknown provider outcome requires manual reconciliation',
  INVALID_PERSISTED_RECEIPT: 'persisted outcome receipt is invalid',
  UNSAFE_INPUT_GRAPH: 'outcome reconciliation input graph is unsafe',
  REPLAY_STATE_MISMATCH: 'reader snapshot is not the persisted outcome post-state',
  OPERATION_DIGEST_MISMATCH: 'outcome operation digest does not match the intent',
  PROVIDER_OUTCOME_FORBIDDEN: 'provider evidence cannot be projected as business sent',
  BUSINESS_SENT_FORBIDDEN: 'business sent requires provider and business evidence',
  RETRY_FORBIDDEN: 'retry and provider commands are outside this contract',
});

export type OutcomeReconciliationResult<T> =
  | Readonly<{ ok: true; value: T }>
  | Readonly<{ ok: false; error: Readonly<{ code: OutcomeReconciliationErrorCode; message: string }> }>;

type Failure = Extract<OutcomeReconciliationResult<never>, { ok: false }>;
type RecordValue = Record<string, unknown>;

export type OutcomeReaderSnapshot = Readonly<{
  tenantRef: string;
  sequenceRef: string;
  enrollmentRef: string;
  executionRef: string;
  stepRef: string;
  stepVersion: number;
  state: OutcomeReaderState;
  version: number;
}>;

export type ProviderOutcomeProjection = Readonly<{
  kind: 'PROVIDER_OUTCOME_PROJECTION';
  policyVersion: 1;
  tenantRef: string;
  sequenceRef: string;
  enrollmentRef: string;
  executionRef: string;
  stepRef: string;
  stepVersion: number;
  channel: Channel;
  reservationReceiptRef: string;
  reservationOperationDigest: string;
  outboxReceiptRef: string;
  reservationRef: string;
  reservationIdempotencyKey: string;
  sendingVersion: number;
  providerOutcome: ProviderOutcome;
  providerReceiptRef: string;
  sourceKind: 'SYSTEM_PROVIDER_OUTCOME_READER';
  sourceReceiptRef: string;
  observedAt: string;
  evidenceDigest: string;
}>;

export type BusinessSentReceiptProjection = Readonly<{
  kind: 'BUSINESS_SENT_RECEIPT';
  policyVersion: 1;
  tenantRef: string;
  sequenceRef: string;
  enrollmentRef: string;
  executionRef: string;
  stepRef: string;
  stepVersion: number;
  channel: Channel;
  reservationReceiptRef: string;
  reservationOperationDigest: string;
  outboxReceiptRef: string;
  reservationRef: string;
  reservationIdempotencyKey: string;
  sendingVersion: number;
  businessReceiptRef: string;
  providerReceiptRef: string;
  providerEvidenceDigest: string;
  providerOutcome: Extract<ProviderOutcome, 'ACCEPTED' | 'DELIVERED'>;
  sourceKind: 'SYSTEM_BUSINESS_OUTCOME_READER';
  sourceReceiptRef: string;
  observedAt: string;
  evidenceDigest: string;
}>;

export type StopDecisionProjection = Readonly<{
  schemaVersion: 1;
  policyVersion: 1;
  receiptRef: string;
  eventKey: string;
  eventDigest: string;
  operationDigest: string;
  eventKind: 'REPLY_RECEIVED' | 'OPT_OUT_RECEIVED' | 'BLACKLIST_MATCHED' | 'PERMISSION_REVOKED' | 'CONTACT_UNTRUSTED';
  sourceKind: 'EMAIL_INBOUND' | 'WHATSAPP_INBOUND' | 'BLACKLIST_REGISTRY' | 'PERMISSION_REGISTRY' | 'CONTACT_TRUST_READER';
  tenantRef: string;
  sequenceRef: string;
  enrollmentRef: string;
  leadRef: string;
  contactRef: string | null;
  sourceReceiptRef: string;
  occurredAt: string;
  preState: 'pending' | 'active' | 'paused';
  preVersion: number;
  postState: 'exited' | 'blocked';
  postVersion: number;
  stopReason: 'reply' | 'optout' | 'blacklist' | 'permission_revoked' | 'contact_untrusted';
  stopPlanOperationDigest: string;
}>;

export type OutcomeReconciliationReceiptProjection = Readonly<{
  kind: 'SALES_SEQUENCE_OUTCOME_RECEIPT';
  schemaVersion: 1;
  policyVersion: 1;
  receiptRef: string;
  operationDigest: string;
  outcomeIdempotencyKey: string;
  reservationIdempotencyKey: string;
  intent: 'RECONCILE_OUTCOME';
  decision: Exclude<OutcomeDecision, 'REPLAY'>;
  tenantRef: string;
  sequenceRef: string;
  enrollmentRef: string;
  executionRef: string;
  stepRef: string;
  stepVersion: number;
  channel: Channel;
  decisionNow: string;
  reservationReceiptRef: string;
  reservationOperationDigest: string;
  outboxReceiptRef: string;
  reservationRef: string;
  preState: 'sending';
  preVersion: number;
  postState: 'sending' | 'sent';
  postVersion: number;
  authorityPlanDigest: string | null;
  providerOutcome?: ProviderOutcomeProjection;
  businessReceipt?: BusinessSentReceiptProjection;
  stopDecision?: StopDecisionProjection;
  predecessorOutcomeReceipt?: OutcomeReconciliationReceiptProjection;
}>;

export type OutcomeReconciliationInput = Readonly<{
  schemaVersion: 1;
  policyVersion: 1;
  intent: 'RECONCILE_OUTCOME';
  tenantRef: string;
  sequenceRef: string;
  enrollmentRef: string;
  executionRef: string;
  stepRef: string;
  stepVersion: number;
  channel: Channel;
  expectedVersion: number;
  outcomeIdempotencyKey: string;
  decisionNow: string;
  readerSnapshot: OutcomeReaderSnapshot;
  reservationReceipt: OutboxComplianceReceiptProjection;
  providerOutcome?: ProviderOutcomeProjection;
  businessReceipt?: BusinessSentReceiptProjection;
  stopDecision?: StopDecisionProjection;
  predecessorOutcomeReceipt?: OutcomeReconciliationReceiptProjection;
  persistedOutcomeReceipt?: OutcomeReconciliationReceiptProjection;
}>;

export type OutcomeReconciliationPlan = Readonly<{
  decision: OutcomeDecision;
  executionMode: 'DRAFT_ONLY';
  approvalPolicy: 'MANUAL_PER_STEP';
  intent: 'RECONCILE_OUTCOME';
  operationDigest: string | null;
  transitionPlan: TransitionPlan | null;
  receiptToPersist: OutcomeReconciliationReceiptProjection | null;
  evidence: Readonly<{
    providerOutcome?: ProviderOutcomeProjection;
    businessReceipt?: BusinessSentReceiptProjection;
    stopDecision?: StopDecisionProjection;
  }>;
  reconciliationAction: 'NONE' | 'MANUAL_RECONCILIATION_REQUIRED' | 'STOP_ENROLLMENT_READER';
  sendCommand: null;
  providerCommand: null;
  queueCommand: null;
  retryCommand: null;
}>;

export type OutcomeOperationIntent = Readonly<{
  schemaVersion: 1;
  policyVersion: 1;
  intent: 'RECONCILE_OUTCOME';
  decision: Exclude<OutcomeDecision, 'REPLAY'>;
  tenantRef: string;
  sequenceRef: string;
  enrollmentRef: string;
  executionRef: string;
  stepRef: string;
  stepVersion: number;
  channel: Channel;
  outcomeIdempotencyKey: string;
  reservationIdempotencyKey: string;
  decisionNow: string;
  reservationReceiptRef: string;
  reservationOperationDigest: string;
  outboxReceiptRef: string;
  reservationRef: string;
  preState: 'sending';
  preVersion: number;
  postState: 'sending' | 'sent';
  postVersion: number;
  authorityPlanDigest: string | null;
  providerOutcome?: ProviderOutcomeProjection;
  businessReceipt?: BusinessSentReceiptProjection;
  stopDecision?: StopDecisionProjection;
  predecessorOutcomeReceipt?: OutcomeReconciliationReceiptProjection;
}>;

const OPAQUE_REF_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/;
const DIGEST_PATTERN = /^sha256:[a-z0-9-]+:[0-9a-f]{64}$/;
const UTC_TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/;
const IDENTITY_PATTERN = /(?:[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,})|(?:\+?\d{8,15})|(?:@[a-z0-9._-]*(?:s\.whatsapp\.net|g\.us|lid))/i;
const SECRET_PATTERN = /(?:bearer\s+|sk-[a-z0-9]|api[_-]?key\s*[:=]|password\s*[:=]|authorization\s*[:=])/i;
const SENSITIVE_KEY_PATTERN = /(?:email|phone|telephone|mobile|jid|recipient|subject|body|content|prompt|output|providerPayload|providerError|raw|url|confidence|confirmed|clientPass|clientSuccess|clientRetry|token|secret|password|cookie|authorization|api.?key)/i;
const PROVIDER_RECEIPT_PREFIX = 'provider-receipt:';
const BUSINESS_RECEIPT_PREFIX = 'business-receipt:';
const OUTCOME_RECEIPT_PREFIX = 'outcome-receipt:';
const PROVIDER_SOURCE_RECEIPT_PREFIX = 'provider-outcome-receipt:';
const BUSINESS_SOURCE_RECEIPT_PREFIX = 'business-outcome-receipt:';
const OUTBOX_PLAN_RECEIPT_PREFIX = 'outbox-plan-receipt:';
const OUTBOX_RECEIPT_PREFIX = 'outbox-receipt:';
const OUTBOX_RESERVATION_PREFIX = 'outbox-reservation:';
const STOP_EVENT_PREFIX = 'stop-event:';
const STOP_SOURCE_RECEIPT_PREFIX = 'source-receipt:';
const STOP_RECEIPT_PREFIX = 'stop-event-receipt:';
const OUTBOX_DEDUPE_RECEIPT_PREFIX = 'dedupe-receipt:';
const OUTCOME_EVIDENCE_MAX_AGE_MS = 5 * 60 * 1000;
const MAX_INPUT_GRAPH_DEPTH = 16;
const PROVIDER_ONLY_RECEIPT_KEYS = [
  'kind', 'schemaVersion', 'policyVersion', 'receiptRef', 'operationDigest', 'outcomeIdempotencyKey', 'reservationIdempotencyKey',
  'intent', 'decision', 'tenantRef', 'sequenceRef', 'enrollmentRef', 'executionRef', 'stepRef', 'stepVersion', 'channel', 'decisionNow',
  'reservationReceiptRef', 'reservationOperationDigest', 'outboxReceiptRef', 'reservationRef', 'preState', 'preVersion', 'postState',
  'postVersion', 'authorityPlanDigest', 'providerOutcome',
] as const;
const STOP_RULES = Object.freeze({
  REPLY_RECEIVED: { sources: ['EMAIL_INBOUND', 'WHATSAPP_INBOUND'], reason: 'reply', to: 'exited' },
  OPT_OUT_RECEIVED: { sources: ['EMAIL_INBOUND', 'WHATSAPP_INBOUND'], reason: 'optout', to: 'exited' },
  BLACKLIST_MATCHED: { sources: ['BLACKLIST_REGISTRY'], reason: 'blacklist', to: 'exited' },
  PERMISSION_REVOKED: { sources: ['PERMISSION_REGISTRY'], reason: 'permission_revoked', to: 'blocked' },
  CONTACT_UNTRUSTED: { sources: ['CONTACT_TRUST_READER'], reason: 'contact_untrusted', to: 'blocked' },
} as const);

function deepFreeze<T>(value: T, seen = new Set<object>()): T {
  if (value === null || typeof value !== 'object' || seen.has(value)) return value;
  seen.add(value);
  for (const child of Object.values(value as RecordValue)) deepFreeze(child, seen);
  return Object.freeze(value);
}

function failure(code: OutcomeReconciliationErrorCode): Failure {
  return deepFreeze({ ok: false, error: { code, message: ERROR_MESSAGES[code] } });
}

function success<T>(value: T): OutcomeReconciliationResult<T> {
  return deepFreeze({ ok: true, value });
}

function isFailure(value: unknown): value is Failure {
  return isRecord(value) && value.ok === false;
}

function isRecord(value: unknown): value is RecordValue {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function hasOnlyKeys(value: RecordValue, keys: readonly string[]): boolean {
  const allowed = new Set(keys);
  return Object.keys(value).every((key) => allowed.has(key));
}

function hasUndefinedDeep(value: unknown, seen = new Set<object>()): boolean {
  if (value === undefined) return true;
  if (value === null || typeof value !== 'object') return false;
  if (seen.has(value)) return true;
  seen.add(value);
  if (Array.isArray(value)) return value.some((item) => hasUndefinedDeep(item, seen));
  if (!isRecord(value)) return true;
  return Object.values(value).some((item) => hasUndefinedDeep(item, seen));
}

function validateInputGraph(value: unknown, depth = 0, active = new Set<object>()): OutcomeReconciliationErrorCode | null {
  if (value === undefined || value === null || typeof value === 'string' || typeof value === 'boolean') return null;
  if (typeof value === 'number') return Number.isFinite(value) ? null : 'UNSAFE_INPUT_GRAPH';
  if (typeof value !== 'object') return 'UNSAFE_INPUT_GRAPH';
  if (depth > MAX_INPUT_GRAPH_DEPTH || active.has(value)) return 'UNSAFE_INPUT_GRAPH';
  if (!Array.isArray(value) && !isRecord(value)) return 'UNSAFE_INPUT_GRAPH';
  active.add(value);
  const children = Array.isArray(value) ? value : Object.values(value);
  for (const child of children) {
    const error = validateInputGraph(child, depth + 1, active);
    if (error) return error;
  }
  active.delete(value);
  return null;
}

function containsSensitiveInput(value: unknown, key?: string, seen = new Set<object>()): boolean {
  const safeField = key !== undefined && (/(?:Ref|Digest|Key|At|Version)$/.test(key) || ['providerOutcome', 'businessReceipt', 'stopDecision', 'reservationReceipt'].includes(key));
  if (key && SENSITIVE_KEY_PATTERN.test(key) && !safeField) return true;
  if (typeof value === 'string') {
    return (!safeField && IDENTITY_PATTERN.test(value))
      || SECRET_PATTERN.test(value)
      || /(?:https?:\/\/|file:\/\/|ftp:\/\/|www\.)/i.test(value);
  }
  if (value === null || typeof value !== 'object') return false;
  if (seen.has(value)) return true;
  seen.add(value);
  if (Array.isArray(value)) return value.some((item) => containsSensitiveInput(item, undefined, seen));
  if (!isRecord(value)) return true;
  return Object.entries(value).some(([entryKey, entryValue]) => containsSensitiveInput(entryValue, entryKey, seen));
}

function validateEnvelope(input: unknown, keys: readonly string[]): RecordValue | Failure {
  if (!isRecord(input)) return failure('UNSUPPORTED_ENVELOPE');
  if (hasUndefinedDeep(input)) return failure('EXPLICIT_UNDEFINED');
  if (!hasOnlyKeys(input, keys)) return failure('UNKNOWN_FIELD');
  if (containsSensitiveInput(input)) return failure('PII_OR_SECRET_INPUT');
  return input;
}

function validateRef(value: unknown, prefix?: string): string | Failure {
  if (typeof value !== 'string' || !OPAQUE_REF_PATTERN.test(value) || value.includes('://') || (prefix === undefined && IDENTITY_PATTERN.test(value))) return failure('INVALID_REF');
  if (prefix !== undefined && !value.startsWith(prefix)) return failure('INVALID_REF');
  return value;
}

function validateDigest(value: unknown): string | Failure {
  return typeof value === 'string' && DIGEST_PATTERN.test(value) ? value : failure('INVALID_DIGEST');
}

function validateVersion(value: unknown): number | Failure {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 1 && value <= 1_000_000
    ? value : failure('INVALID_VERSION');
}

function validateTimestamp(value: unknown): string | Failure {
  if (typeof value !== 'string' || !UTC_TIMESTAMP_PATTERN.test(value)) return failure('INVALID_TIMESTAMP');
  const match = value.match(/^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d{1,3}))?Z$/);
  if (!match) return failure('INVALID_TIMESTAMP');
  const canonical = `${match[1]}.${(match[2] ?? '').padEnd(3, '0')}Z`;
  const millis = Date.parse(canonical);
  return Number.isFinite(millis) && new Date(millis).toISOString() === canonical ? canonical : failure('INVALID_TIMESTAMP');
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const record = value as RecordValue;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(',')}}`;
}

function hash(domain: string, value: unknown): string {
  return `sha256:${domain}:${createHash('sha256').update(`${domain}|${canonicalJson(value)}`, 'utf8').digest('hex')}`;
}

function derivedRef(prefix: string, digest: string): string {
  return `${prefix}${digest.slice(-32)}`;
}

function validateScope(value: RecordValue, expected: RecordValue): Failure | null {
  for (const key of ['tenantRef', 'sequenceRef', 'enrollmentRef', 'executionRef', 'stepRef', 'stepVersion'] as const) {
    if (value[key] !== expected[key]) return failure('SCOPE_MISMATCH');
  }
  return null;
}

function validateChannel(value: unknown): Channel | Failure {
  return value === 'EMAIL' || value === 'WHATSAPP' ? value : failure('INVALID_CHANNEL');
}

function validateFreshTimestamp(value: unknown, decisionNow: string): string | Failure {
  const timestamp = validateTimestamp(value);
  if (isFailure(timestamp)) return timestamp;
  const age = Date.parse(decisionNow) - Date.parse(timestamp);
  if (age < 0) return failure('FUTURE_EVIDENCE');
  if (age > OUTCOME_EVIDENCE_MAX_AGE_MS) return failure('STALE_EVIDENCE');
  return timestamp;
}

export function computeProviderOutcomeDigest(input: Omit<ProviderOutcomeProjection, 'evidenceDigest'>): string {
  return hash('sales-sequence-provider-outcome-v1', input);
}

export function computeBusinessSentReceiptDigest(input: Omit<BusinessSentReceiptProjection, 'evidenceDigest'>): string {
  return hash('sales-sequence-business-sent-v1', input);
}

export function computeOutcomeOperationDigest(input: OutcomeOperationIntent): string {
  return hash('sales-sequence-outcome-reconciliation-v1', input);
}

function validateReaderSnapshot(input: unknown): OutcomeReaderSnapshot | Failure {
  const value = validateEnvelope(input, ['tenantRef', 'sequenceRef', 'enrollmentRef', 'executionRef', 'stepRef', 'stepVersion', 'state', 'version']);
  if (isFailure(value)) return value;
  const refs = ['tenantRef', 'sequenceRef', 'enrollmentRef', 'executionRef', 'stepRef'].map((key) => validateRef(value[key]));
  const stepVersion = validateVersion(value.stepVersion);
  const version = validateVersion(value.version);
  if (refs.some(isFailure) || isFailure(stepVersion) || isFailure(version)) return failure('TYPE_MISMATCH');
  if (!['sending', 'sent', 'failed', 'unknown'].includes(value.state as string)) return failure('INVALID_STATE');
  return { tenantRef: refs[0] as string, sequenceRef: refs[1] as string, enrollmentRef: refs[2] as string, executionRef: refs[3] as string, stepRef: refs[4] as string, stepVersion: stepVersion as number, state: value.state as OutcomeReaderState, version: version as number };
}

function validateReservationBinding(value: RecordValue, reservation: OutboxComplianceReceiptProjection): Failure | null {
  if (value.reservationReceiptRef !== reservation.receiptRef || value.reservationOperationDigest !== reservation.operationDigest || value.outboxReceiptRef !== reservation.outboxReceiptRef || value.reservationRef !== reservation.reservationRef || value.reservationIdempotencyKey !== reservation.idempotencyKey || value.sendingVersion !== reservation.postVersion) return failure('SCOPE_MISMATCH');
  return null;
}

function validateProviderOutcome(input: unknown, outer: RecordValue, decisionNow: string, reservation: OutboxComplianceReceiptProjection): ProviderOutcomeProjection | Failure {
  const value = validateEnvelope(input, ['kind', 'policyVersion', 'tenantRef', 'sequenceRef', 'enrollmentRef', 'executionRef', 'stepRef', 'stepVersion', 'channel', 'reservationReceiptRef', 'reservationOperationDigest', 'outboxReceiptRef', 'reservationRef', 'reservationIdempotencyKey', 'sendingVersion', 'providerOutcome', 'providerReceiptRef', 'sourceKind', 'sourceReceiptRef', 'observedAt', 'evidenceDigest']);
  if (isFailure(value)) return value;
  const refs = ['tenantRef', 'sequenceRef', 'enrollmentRef', 'executionRef', 'stepRef'].map((key) => validateRef(value[key]));
  const stepVersion = validateVersion(value.stepVersion);
  const channel = validateChannel(value.channel);
  const reservationReceiptRef = validateRef(value.reservationReceiptRef, OUTBOX_PLAN_RECEIPT_PREFIX);
  const reservationOperationDigest = validateDigest(value.reservationOperationDigest);
  const outboxReceiptRef = validateRef(value.outboxReceiptRef, OUTBOX_RECEIPT_PREFIX);
  const reservationRef = validateRef(value.reservationRef, OUTBOX_RESERVATION_PREFIX);
  const reservationIdempotencyKey = validateRef(value.reservationIdempotencyKey);
  const sendingVersion = validateVersion(value.sendingVersion);
  const providerReceiptRef = validateRef(value.providerReceiptRef, PROVIDER_RECEIPT_PREFIX);
  const sourceReceiptRef = validateRef(value.sourceReceiptRef, PROVIDER_SOURCE_RECEIPT_PREFIX);
  const observedAt = validateFreshTimestamp(value.observedAt, decisionNow);
  const evidenceDigest = validateDigest(value.evidenceDigest);
  if (value.kind !== 'PROVIDER_OUTCOME_PROJECTION' || value.policyVersion !== 1 || value.sourceKind !== 'SYSTEM_PROVIDER_OUTCOME_READER' || !['ACCEPTED', 'DELIVERED', 'FAILED', 'UNKNOWN'].includes(value.providerOutcome as string) || refs.some(isFailure) || isFailure(stepVersion) || isFailure(channel) || isFailure(reservationReceiptRef) || isFailure(reservationOperationDigest) || isFailure(outboxReceiptRef) || isFailure(reservationRef) || isFailure(reservationIdempotencyKey) || isFailure(sendingVersion) || isFailure(providerReceiptRef) || isFailure(sourceReceiptRef) || isFailure(observedAt) || isFailure(evidenceDigest)) return failure('PROVIDER_EVIDENCE_INVALID');
  const scope = validateScope(value, outer);
  if (scope || channel !== outer.channel) return failure('SCOPE_MISMATCH');
  const binding = validateReservationBinding(value, reservation);
  if (binding) return binding;
  const normalized = { kind: 'PROVIDER_OUTCOME_PROJECTION' as const, policyVersion: 1 as const, tenantRef: refs[0] as string, sequenceRef: refs[1] as string, enrollmentRef: refs[2] as string, executionRef: refs[3] as string, stepRef: refs[4] as string, stepVersion: stepVersion as number, channel: channel as Channel, reservationReceiptRef: reservationReceiptRef as string, reservationOperationDigest: reservationOperationDigest as string, outboxReceiptRef: outboxReceiptRef as string, reservationRef: reservationRef as string, reservationIdempotencyKey: reservationIdempotencyKey as string, sendingVersion: sendingVersion as number, providerOutcome: value.providerOutcome as ProviderOutcome, providerReceiptRef: providerReceiptRef as string, sourceKind: 'SYSTEM_PROVIDER_OUTCOME_READER' as const, sourceReceiptRef: sourceReceiptRef as string, observedAt: observedAt as string };
  return computeProviderOutcomeDigest(normalized) === evidenceDigest ? { ...normalized, evidenceDigest: evidenceDigest as string } : failure('PROVIDER_EVIDENCE_INVALID');
}

function validateBusinessReceipt(input: unknown, outer: RecordValue, decisionNow: string, reservation: OutboxComplianceReceiptProjection, providerOutcome: ProviderOutcomeProjection): BusinessSentReceiptProjection | Failure {
  const value = validateEnvelope(input, ['kind', 'policyVersion', 'tenantRef', 'sequenceRef', 'enrollmentRef', 'executionRef', 'stepRef', 'stepVersion', 'channel', 'reservationReceiptRef', 'reservationOperationDigest', 'outboxReceiptRef', 'reservationRef', 'reservationIdempotencyKey', 'sendingVersion', 'businessReceiptRef', 'providerReceiptRef', 'providerEvidenceDigest', 'providerOutcome', 'sourceKind', 'sourceReceiptRef', 'observedAt', 'evidenceDigest']);
  if (isFailure(value)) return value;
  const refs = ['tenantRef', 'sequenceRef', 'enrollmentRef', 'executionRef', 'stepRef'].map((key) => validateRef(value[key]));
  const stepVersion = validateVersion(value.stepVersion);
  const channel = validateChannel(value.channel);
  const reservationReceiptRef = validateRef(value.reservationReceiptRef, OUTBOX_PLAN_RECEIPT_PREFIX);
  const reservationOperationDigest = validateDigest(value.reservationOperationDigest);
  const outboxReceiptRef = validateRef(value.outboxReceiptRef, OUTBOX_RECEIPT_PREFIX);
  const reservationRef = validateRef(value.reservationRef, OUTBOX_RESERVATION_PREFIX);
  const reservationIdempotencyKey = validateRef(value.reservationIdempotencyKey);
  const sendingVersion = validateVersion(value.sendingVersion);
  const businessReceiptRef = validateRef(value.businessReceiptRef, BUSINESS_RECEIPT_PREFIX);
  const providerReceiptRef = validateRef(value.providerReceiptRef, PROVIDER_RECEIPT_PREFIX);
  const providerEvidenceDigest = validateDigest(value.providerEvidenceDigest);
  const sourceReceiptRef = validateRef(value.sourceReceiptRef, BUSINESS_SOURCE_RECEIPT_PREFIX);
  const observedAt = validateFreshTimestamp(value.observedAt, decisionNow);
  const evidenceDigest = validateDigest(value.evidenceDigest);
  if (value.kind !== 'BUSINESS_SENT_RECEIPT' || value.policyVersion !== 1 || value.sourceKind !== 'SYSTEM_BUSINESS_OUTCOME_READER' || value.providerOutcome !== providerOutcome.providerOutcome || !['ACCEPTED', 'DELIVERED'].includes(value.providerOutcome as string) || refs.some(isFailure) || isFailure(stepVersion) || isFailure(channel) || isFailure(reservationReceiptRef) || isFailure(reservationOperationDigest) || isFailure(outboxReceiptRef) || isFailure(reservationRef) || isFailure(reservationIdempotencyKey) || isFailure(sendingVersion) || isFailure(businessReceiptRef) || isFailure(providerReceiptRef) || isFailure(providerEvidenceDigest) || isFailure(sourceReceiptRef) || isFailure(observedAt) || isFailure(evidenceDigest)) return failure('BUSINESS_RECEIPT_INVALID');
  const scope = validateScope(value, outer);
  if (scope || channel !== outer.channel) return failure('SCOPE_MISMATCH');
  const binding = validateReservationBinding(value, reservation);
  if (binding) return binding;
  if (providerReceiptRef !== providerOutcome.providerReceiptRef || providerEvidenceDigest !== providerOutcome.evidenceDigest) return failure('BUSINESS_RECEIPT_INVALID');
  const normalized = { kind: 'BUSINESS_SENT_RECEIPT' as const, policyVersion: 1 as const, tenantRef: refs[0] as string, sequenceRef: refs[1] as string, enrollmentRef: refs[2] as string, executionRef: refs[3] as string, stepRef: refs[4] as string, stepVersion: stepVersion as number, channel: channel as Channel, reservationReceiptRef: reservationReceiptRef as string, reservationOperationDigest: reservationOperationDigest as string, outboxReceiptRef: outboxReceiptRef as string, reservationRef: reservationRef as string, reservationIdempotencyKey: reservationIdempotencyKey as string, sendingVersion: sendingVersion as number, businessReceiptRef: businessReceiptRef as string, providerReceiptRef: providerReceiptRef as string, providerEvidenceDigest: providerEvidenceDigest as string, providerOutcome: value.providerOutcome as Extract<ProviderOutcome, 'ACCEPTED' | 'DELIVERED'>, sourceKind: 'SYSTEM_BUSINESS_OUTCOME_READER' as const, sourceReceiptRef: sourceReceiptRef as string, observedAt: observedAt as string };
  return computeBusinessSentReceiptDigest(normalized) === evidenceDigest ? { ...normalized, evidenceDigest: evidenceDigest as string } : failure('BUSINESS_RECEIPT_INVALID');
}

function validateStopDecision(input: unknown, outer: RecordValue, decisionNow: string): StopDecisionProjection | Failure {
  const value = validateEnvelope(input, ['schemaVersion', 'policyVersion', 'receiptRef', 'eventKey', 'eventDigest', 'operationDigest', 'eventKind', 'sourceKind', 'tenantRef', 'sequenceRef', 'enrollmentRef', 'leadRef', 'contactRef', 'sourceReceiptRef', 'occurredAt', 'preState', 'preVersion', 'postState', 'postVersion', 'stopReason', 'stopPlanOperationDigest']);
  if (isFailure(value)) return value;
  const receiptRef = validateRef(value.receiptRef, STOP_RECEIPT_PREFIX);
  const eventKey = validateRef(value.eventKey, STOP_EVENT_PREFIX);
  const eventDigest = validateDigest(value.eventDigest);
  const operationDigest = validateDigest(value.operationDigest);
  const eventKind = value.eventKind as keyof typeof STOP_RULES;
  const rule = STOP_RULES[eventKind];
  const sourceKind = validateRef(value.sourceKind);
  const refs = ['tenantRef', 'sequenceRef', 'enrollmentRef', 'leadRef', 'sourceReceiptRef', 'stopPlanOperationDigest'].map((key) => validateRef(value[key]));
  const contactRef = value.contactRef === null ? null : validateRef(value.contactRef);
  const occurredAt = validateFreshTimestamp(value.occurredAt, decisionNow);
  const preVersion = validateVersion(value.preVersion);
  const postVersion = validateVersion(value.postVersion);
  if (value.schemaVersion !== 1 || value.policyVersion !== 1 || !rule || !['EMAIL_INBOUND', 'WHATSAPP_INBOUND', 'BLACKLIST_REGISTRY', 'PERMISSION_REGISTRY', 'CONTACT_TRUST_READER'].includes(value.sourceKind as string) || !rule.sources.includes(value.sourceKind as never) || !['pending', 'active', 'paused'].includes(value.preState as string) || !['exited', 'blocked'].includes(value.postState as string) || !['reply', 'optout', 'blacklist', 'permission_revoked', 'contact_untrusted'].includes(value.stopReason as string) || value.stopReason !== rule.reason || value.postState !== rule.to || isFailure(receiptRef) || isFailure(eventKey) || isFailure(eventDigest) || isFailure(operationDigest) || isFailure(sourceKind) || refs.some(isFailure) || isFailure(contactRef) || isFailure(occurredAt) || isFailure(preVersion) || isFailure(postVersion)) return failure('STOP_MAPPING_MISMATCH');
  if (postVersion !== (preVersion as number) + 1) return failure('STOP_DECISION_INVALID');
  if (value.tenantRef !== outer.tenantRef || value.sequenceRef !== outer.sequenceRef || value.enrollmentRef !== outer.enrollmentRef) return failure('SCOPE_MISMATCH');
  const normalizedSourceKind = value.sourceKind as StopDecisionProjection['sourceKind'];
  const [tenantRef, sequenceRef, enrollmentRef, leadRef, sourceReceiptRef, stopPlanOperationDigest] = refs as string[];
  const preState = value.preState as StopDecisionProjection['preState'];
  const postState = value.postState as StopDecisionProjection['postState'];
  const stopReason = value.stopReason as StopDecisionProjection['stopReason'];
  const eventIntent = { schemaVersion: 1 as const, policyVersion: 1 as const, eventKey, eventKind, sourceKind: normalizedSourceKind, tenantRef, sequenceRef, enrollmentRef, leadRef, contactRef, sourceReceiptRef, occurredAt };
  if (computeEnrollmentStopEventDigest(eventIntent) !== eventDigest) return failure('STOP_DECISION_INVALID');
  const stopPlan = planEnrollmentTransition({ tenantRef, resourceTenantRef: tenantRef, sequenceRef, enrollmentRef, from: preState, to: postState, expectedVersion: preVersion, currentVersion: preVersion, intent: 'ENROLLMENT_STOP', stopReason, actorKind: 'SYSTEM', actorRole: 'SYSTEM', actorRef: 'system:enrollment-stop-event-reader-v1' });
  if (!stopPlan.ok || stopPlan.value.operationDigest !== value.stopPlanOperationDigest || stopPlan.value.nextVersion !== postVersion) return failure('STOP_DECISION_INVALID');
  const operationIntent = { schemaVersion: 1 as const, policyVersion: 1 as const, eventDigest, eventKey, eventKind, sourceKind: normalizedSourceKind, tenantRef, sequenceRef, enrollmentRef, leadRef, contactRef, sourceReceiptRef, occurredAt, preState, preVersion, postState, postVersion, stopReason, stopPlanOperationDigest };
  const expectedOperationDigest = computeEnrollmentStopOperationDigest(operationIntent);
  if (expectedOperationDigest !== operationDigest || derivedRef(STOP_RECEIPT_PREFIX, operationDigest as string) !== receiptRef) return failure('STOP_DECISION_INVALID');
  return { schemaVersion: 1, policyVersion: 1, receiptRef: receiptRef as string, eventKey: eventKey as string, eventDigest: eventDigest as string, operationDigest: operationDigest as string, eventKind, sourceKind: value.sourceKind as StopDecisionProjection['sourceKind'], tenantRef: refs[0] as string, sequenceRef: refs[1] as string, enrollmentRef: refs[2] as string, leadRef: refs[3] as string, contactRef: contactRef as string | null, sourceReceiptRef: refs[4] as string, occurredAt: occurredAt as string, preState: value.preState as StopDecisionProjection['preState'], preVersion: preVersion as number, postState: value.postState as StopDecisionProjection['postState'], postVersion: postVersion as number, stopReason: value.stopReason as StopDecisionProjection['stopReason'], stopPlanOperationDigest: value.stopPlanOperationDigest as string };
}

function validateReservationReceipt(input: unknown): OutboxComplianceReceiptProjection | Failure {
  if (!isRecord(input)) return failure('RESERVATION_RECEIPT_INVALID');
  const receipt = input as OutboxComplianceReceiptProjection;
  if (receipt.kind !== 'OUTBOX_COMPLIANCE_PLAN_RECEIPT' || !isRecord(receipt.evidence) || !isRecord(receipt.evidence.compliance)) return failure('RESERVATION_RECEIPT_INVALID');
  const dedupeWithoutDigest = { kind: 'OUTBOX_DEDUPE_EVALUATION' as const, policyVersion: 1 as const, tenantRef: receipt.tenantRef, channel: receipt.channel, idempotencyKey: receipt.idempotencyKey, decision: 'REPLAY' as const, existingReceiptRef: receipt.receiptRef, sourceKind: 'SYSTEM_DEDUPE_READER' as const, sourceReceiptRef: `${OUTBOX_DEDUPE_RECEIPT_PREFIX}03e-structural`, evaluatedAt: receipt.decisionNow };
  const checked = planOutboxCompliance({ schemaVersion: 1, policyVersion: 1, intent: 'SEND_AFTER_APPROVAL', tenantRef: receipt.tenantRef, sequenceRef: receipt.sequenceRef, enrollmentRef: receipt.enrollmentRef, executionRef: receipt.executionRef, stepRef: receipt.stepRef, stepVersion: receipt.stepVersion, channel: receipt.channel, expectedVersion: receipt.preVersion, idempotencyKey: receipt.idempotencyKey, decisionNow: receipt.decisionNow, readerSnapshot: { tenantRef: receipt.tenantRef, sequenceRef: receipt.sequenceRef, enrollmentRef: receipt.enrollmentRef, executionRef: receipt.executionRef, stepRef: receipt.stepRef, stepVersion: receipt.stepVersion, state: 'sending', version: receipt.postVersion }, draftIdentity: { ...receipt.draftIdentity }, compliance: { ...receipt.evidence.compliance }, dedupe: { ...dedupeWithoutDigest, evidenceDigest: computeDedupeEvidenceDigest(dedupeWithoutDigest) }, persistedReceipt: receipt });
  return checked.ok && checked.value.decision === 'REPLAY' && checked.value.operationDigest === receipt.operationDigest ? receipt : failure('RESERVATION_RECEIPT_INVALID');
}

function validateOutcomeReceipt(input: unknown, outer: RecordValue, reservation: OutboxComplianceReceiptProjection, expectedOutcomeIdempotencyKey?: string, expectedDecisionNow?: string): OutcomeReconciliationReceiptProjection | Failure {
  const value = validateEnvelope(input, ['kind', 'schemaVersion', 'policyVersion', 'receiptRef', 'operationDigest', 'outcomeIdempotencyKey', 'reservationIdempotencyKey', 'intent', 'decision', 'tenantRef', 'sequenceRef', 'enrollmentRef', 'executionRef', 'stepRef', 'stepVersion', 'channel', 'decisionNow', 'reservationReceiptRef', 'reservationOperationDigest', 'outboxReceiptRef', 'reservationRef', 'preState', 'preVersion', 'postState', 'postVersion', 'authorityPlanDigest', 'providerOutcome', 'businessReceipt', 'stopDecision', 'predecessorOutcomeReceipt']);
  if (isFailure(value)) return failure('INVALID_PERSISTED_RECEIPT');
  const receiptRef = validateRef(value.receiptRef, OUTCOME_RECEIPT_PREFIX);
  const operationDigest = validateDigest(value.operationDigest);
  const outcomeIdempotencyKey = validateRef(value.outcomeIdempotencyKey);
  const reservationIdempotencyKey = validateRef(value.reservationIdempotencyKey);
  const refs = ['tenantRef', 'sequenceRef', 'enrollmentRef', 'executionRef', 'stepRef', 'reservationReceiptRef', 'outboxReceiptRef', 'reservationRef'].map((key) => validateRef(value[key]));
  const stepVersion = validateVersion(value.stepVersion);
  const channel = validateChannel(value.channel);
  const receiptDecisionNow = validateTimestamp(value.decisionNow);
  const preVersion = validateVersion(value.preVersion);
  const postVersion = validateVersion(value.postVersion);
  const authorityPlanDigest = value.authorityPlanDigest === null ? null : validateDigest(value.authorityPlanDigest);
  if (value.kind !== 'SALES_SEQUENCE_OUTCOME_RECEIPT' || value.schemaVersion !== 1 || value.policyVersion !== 1 || value.intent !== OUTCOME_RECONCILIATION_INTENT || !['PROVIDER_EVIDENCE_ONLY', 'BUSINESS_SENT', 'MANUAL_RECONCILIATION_REQUIRED', 'STOP_RECONCILIATION_REQUIRED'].includes(value.decision as string) || value.preState !== 'sending' || !['sending', 'sent'].includes(value.postState as string) || isFailure(receiptRef) || isFailure(operationDigest) || isFailure(outcomeIdempotencyKey) || isFailure(reservationIdempotencyKey) || refs.some(isFailure) || isFailure(stepVersion) || isFailure(channel) || isFailure(receiptDecisionNow) || isFailure(preVersion) || isFailure(postVersion) || isFailure(authorityPlanDigest)) return failure('INVALID_PERSISTED_RECEIPT');
  if (expectedOutcomeIdempotencyKey !== undefined && outcomeIdempotencyKey !== expectedOutcomeIdempotencyKey) return failure('OUTCOME_CONFLICT');
  if (expectedDecisionNow !== undefined && receiptDecisionNow !== expectedDecisionNow) return failure('OUTCOME_CONFLICT');
  const outerScope = { ...outer, tenantRef: refs[0], sequenceRef: refs[1], enrollmentRef: refs[2], executionRef: refs[3], stepRef: refs[4], stepVersion, channel };
  if (validateScope({ tenantRef: refs[0], sequenceRef: refs[1], enrollmentRef: refs[2], executionRef: refs[3], stepRef: refs[4], stepVersion }, outer) || refs[5] !== reservation.receiptRef || refs[6] !== reservation.outboxReceiptRef || refs[7] !== reservation.reservationRef || value.reservationOperationDigest !== reservation.operationDigest || reservationIdempotencyKey !== reservation.idempotencyKey || preVersion !== outer.expectedVersion || preVersion !== reservation.postVersion || channel !== outer.channel) return failure('OUTCOME_CONFLICT');
  if (postVersion !== ((value.decision === 'BUSINESS_SENT') ? (preVersion as number) + 1 : preVersion) || value.decision === 'BUSINESS_SENT' && value.postState !== 'sent' || value.decision !== 'BUSINESS_SENT' && value.postState !== 'sending') return failure('INVALID_PERSISTED_RECEIPT');
  const providerOutcome = value.providerOutcome === undefined ? undefined : validateProviderOutcome(value.providerOutcome, outerScope, receiptDecisionNow as string, reservation);
  if (isFailure(providerOutcome)) return failure('INVALID_PERSISTED_RECEIPT');
  if (value.predecessorOutcomeReceipt !== undefined && (!isRecord(value.predecessorOutcomeReceipt) || !hasOnlyKeys(value.predecessorOutcomeReceipt, PROVIDER_ONLY_RECEIPT_KEYS) || value.predecessorOutcomeReceipt.decision !== 'PROVIDER_EVIDENCE_ONLY' || value.predecessorOutcomeReceipt.preState !== 'sending' || value.predecessorOutcomeReceipt.postState !== 'sending' || !isRecord(value.predecessorOutcomeReceipt.providerOutcome))) return failure('INVALID_PERSISTED_RECEIPT');
  const predecessor = value.predecessorOutcomeReceipt === undefined ? undefined : validateOutcomeReceipt(value.predecessorOutcomeReceipt, outerScope, reservation);
  if (isFailure(predecessor)) return failure('INVALID_PERSISTED_RECEIPT');
  if (predecessor !== undefined && (predecessor.decision !== 'PROVIDER_EVIDENCE_ONLY' || predecessor.postState !== 'sending' || predecessor.postVersion !== preVersion || predecessor.providerOutcome === undefined || predecessor.outcomeIdempotencyKey === outcomeIdempotencyKey)) return failure('INVALID_PERSISTED_RECEIPT');
  const effectiveProvider = providerOutcome ?? predecessor?.providerOutcome;
  const businessReceipt = value.businessReceipt === undefined ? undefined : effectiveProvider === undefined ? failure('INVALID_PERSISTED_RECEIPT') : validateBusinessReceipt(value.businessReceipt, outerScope, receiptDecisionNow as string, reservation, effectiveProvider);
  const stopDecision = value.stopDecision === undefined ? undefined : validateStopDecision(value.stopDecision, outerScope, receiptDecisionNow as string);
  if (isFailure(providerOutcome) || isFailure(businessReceipt) || isFailure(stopDecision)) return failure('INVALID_PERSISTED_RECEIPT');
  if (value.decision === 'BUSINESS_SENT' && ((!predecessor && !providerOutcome) || (predecessor && providerOutcome) || !effectiveProvider || !businessReceipt || !['ACCEPTED', 'DELIVERED'].includes(effectiveProvider.providerOutcome) || stopDecision !== undefined)) return failure('INVALID_PERSISTED_RECEIPT');
  if (value.decision === 'PROVIDER_EVIDENCE_ONLY' && (!providerOutcome || !['ACCEPTED', 'DELIVERED'].includes(providerOutcome.providerOutcome) || businessReceipt !== undefined || stopDecision !== undefined || predecessor !== undefined)) return failure('INVALID_PERSISTED_RECEIPT');
  if (value.decision === 'MANUAL_RECONCILIATION_REQUIRED' && (!providerOutcome || !['FAILED', 'UNKNOWN'].includes(providerOutcome.providerOutcome) || businessReceipt !== undefined || stopDecision !== undefined || predecessor !== undefined)) return failure('INVALID_PERSISTED_RECEIPT');
  if (value.decision === 'STOP_RECONCILIATION_REQUIRED' && (stopDecision === undefined || businessReceipt !== undefined)) return failure('INVALID_PERSISTED_RECEIPT');
  let expectedAuthority: string | null = null;
  if (value.decision === 'BUSINESS_SENT') {
    const transition = planStepExecutionTransition({ executionRef: reservation.executionRef, tenantRef: reservation.tenantRef, sequenceRef: reservation.sequenceRef, enrollmentRef: reservation.enrollmentRef, stepRef: reservation.stepRef, stepVersion: reservation.stepVersion, from: 'sending', to: 'sent', expectedVersion: preVersion, currentVersion: preVersion, intent: 'SEND_AFTER_APPROVAL', providerReceiptRef: effectiveProvider!.providerReceiptRef, businessReceiptRef: businessReceipt!.businessReceiptRef, actorKind: 'FUTURE_EXTERNAL_EXECUTOR', actorRole: 'SYSTEM', actorRef: 'system:outcome-reconciliation-v1' });
    if (!transition.ok) return failure('INVALID_PERSISTED_RECEIPT');
    expectedAuthority = transition.value.operationDigest;
  }
  if (authorityPlanDigest !== expectedAuthority) return failure('INVALID_PERSISTED_RECEIPT');
  const operationIntent: OutcomeOperationIntent = { schemaVersion: 1, policyVersion: 1, intent: OUTCOME_RECONCILIATION_INTENT, decision: value.decision as Exclude<OutcomeDecision, 'REPLAY'>, tenantRef: refs[0] as string, sequenceRef: refs[1] as string, enrollmentRef: refs[2] as string, executionRef: refs[3] as string, stepRef: refs[4] as string, stepVersion: stepVersion as number, channel: channel as Channel, outcomeIdempotencyKey: outcomeIdempotencyKey as string, reservationIdempotencyKey: reservationIdempotencyKey as string, decisionNow: receiptDecisionNow as string, reservationReceiptRef: refs[5] as string, reservationOperationDigest: value.reservationOperationDigest as string, outboxReceiptRef: refs[6] as string, reservationRef: refs[7] as string, preState: 'sending', preVersion: preVersion as number, postState: value.postState as 'sending' | 'sent', postVersion: postVersion as number, authorityPlanDigest: authorityPlanDigest as string | null, ...(providerOutcome === undefined ? {} : { providerOutcome }), ...(businessReceipt === undefined ? {} : { businessReceipt }), ...(stopDecision === undefined ? {} : { stopDecision }), ...(predecessor === undefined ? {} : { predecessorOutcomeReceipt: predecessor }) };
  if (computeOutcomeOperationDigest(operationIntent) !== operationDigest || derivedRef(OUTCOME_RECEIPT_PREFIX, operationDigest as string) !== receiptRef) return failure('INVALID_PERSISTED_RECEIPT');
  return { kind: 'SALES_SEQUENCE_OUTCOME_RECEIPT', schemaVersion: 1, policyVersion: 1, receiptRef: receiptRef as string, operationDigest: operationDigest as string, outcomeIdempotencyKey: outcomeIdempotencyKey as string, reservationIdempotencyKey: reservationIdempotencyKey as string, intent: OUTCOME_RECONCILIATION_INTENT, decision: value.decision as Exclude<OutcomeDecision, 'REPLAY'>, tenantRef: refs[0] as string, sequenceRef: refs[1] as string, enrollmentRef: refs[2] as string, executionRef: refs[3] as string, stepRef: refs[4] as string, stepVersion: stepVersion as number, channel: channel as Channel, decisionNow: receiptDecisionNow as string, reservationReceiptRef: refs[5] as string, reservationOperationDigest: value.reservationOperationDigest as string, outboxReceiptRef: refs[6] as string, reservationRef: refs[7] as string, preState: 'sending', preVersion: preVersion as number, postState: value.postState as 'sending' | 'sent', postVersion: postVersion as number, authorityPlanDigest: authorityPlanDigest as string | null, ...(providerOutcome === undefined ? {} : { providerOutcome }), ...(businessReceipt === undefined ? {} : { businessReceipt }), ...(stopDecision === undefined ? {} : { stopDecision }), ...(predecessor === undefined ? {} : { predecessorOutcomeReceipt: predecessor }) };
}

function makeReceipt(input: RecordValue, reservation: OutboxComplianceReceiptProjection, decision: Exclude<OutcomeDecision, 'REPLAY'>, providerOutcome: ProviderOutcomeProjection | undefined, businessReceipt: BusinessSentReceiptProjection | undefined, stopDecision: StopDecisionProjection | undefined, predecessorOutcomeReceipt: OutcomeReconciliationReceiptProjection | undefined, authorityPlanDigest: string | null, postState: 'sending' | 'sent', postVersion: number): OutcomeReconciliationReceiptProjection {
  const base: OutcomeOperationIntent = { schemaVersion: 1, policyVersion: 1, intent: OUTCOME_RECONCILIATION_INTENT, decision, tenantRef: input.tenantRef as string, sequenceRef: input.sequenceRef as string, enrollmentRef: input.enrollmentRef as string, executionRef: input.executionRef as string, stepRef: input.stepRef as string, stepVersion: input.stepVersion as number, channel: input.channel as Channel, outcomeIdempotencyKey: input.outcomeIdempotencyKey as string, reservationIdempotencyKey: reservation.idempotencyKey, decisionNow: input.decisionNow as string, reservationReceiptRef: reservation.receiptRef, reservationOperationDigest: reservation.operationDigest, outboxReceiptRef: reservation.outboxReceiptRef, reservationRef: reservation.reservationRef, preState: 'sending', preVersion: input.expectedVersion as number, postState, postVersion, authorityPlanDigest, ...(providerOutcome === undefined ? {} : { providerOutcome }), ...(businessReceipt === undefined ? {} : { businessReceipt }), ...(stopDecision === undefined ? {} : { stopDecision }), ...(predecessorOutcomeReceipt === undefined ? {} : { predecessorOutcomeReceipt }) };
  const operationDigest = computeOutcomeOperationDigest(base);
  return { kind: 'SALES_SEQUENCE_OUTCOME_RECEIPT', schemaVersion: 1, policyVersion: 1, receiptRef: derivedRef(OUTCOME_RECEIPT_PREFIX, operationDigest), operationDigest, outcomeIdempotencyKey: base.outcomeIdempotencyKey, reservationIdempotencyKey: base.reservationIdempotencyKey, intent: OUTCOME_RECONCILIATION_INTENT, decision, tenantRef: base.tenantRef, sequenceRef: base.sequenceRef, enrollmentRef: base.enrollmentRef, executionRef: base.executionRef, stepRef: base.stepRef, stepVersion: base.stepVersion, channel: base.channel, decisionNow: base.decisionNow, reservationReceiptRef: base.reservationReceiptRef, reservationOperationDigest: base.reservationOperationDigest, outboxReceiptRef: base.outboxReceiptRef, reservationRef: base.reservationRef, preState: 'sending', preVersion: base.preVersion, postState, postVersion, authorityPlanDigest, ...(providerOutcome === undefined ? {} : { providerOutcome }), ...(businessReceipt === undefined ? {} : { businessReceipt }), ...(stopDecision === undefined ? {} : { stopDecision }), ...(predecessorOutcomeReceipt === undefined ? {} : { predecessorOutcomeReceipt }) };
}

export function planOutcomeReconciliation(input: unknown): OutcomeReconciliationResult<OutcomeReconciliationPlan> {
  const graphError = validateInputGraph(input);
  if (graphError) return failure(graphError);
  const value = validateEnvelope(input, ['schemaVersion', 'policyVersion', 'intent', 'tenantRef', 'sequenceRef', 'enrollmentRef', 'executionRef', 'stepRef', 'stepVersion', 'channel', 'expectedVersion', 'outcomeIdempotencyKey', 'decisionNow', 'readerSnapshot', 'reservationReceipt', 'providerOutcome', 'businessReceipt', 'stopDecision', 'predecessorOutcomeReceipt', 'persistedOutcomeReceipt']);
  if (isFailure(value)) return value;
  if (value.schemaVersion !== 1 || value.policyVersion !== 1) return failure('INVALID_POLICY_VERSION');
  if (value.intent !== OUTCOME_RECONCILIATION_INTENT) return failure('TYPE_MISMATCH');
  const refs = ['tenantRef', 'sequenceRef', 'enrollmentRef', 'executionRef', 'stepRef'].map((key) => validateRef(value[key]));
  const stepVersion = validateVersion(value.stepVersion);
  const expectedVersion = validateVersion(value.expectedVersion);
  const channel = validateChannel(value.channel);
  const outcomeIdempotencyKey = validateRef(value.outcomeIdempotencyKey);
  const decisionNow = validateTimestamp(value.decisionNow);
  if (refs.some(isFailure)) return failure('INVALID_REF');
  if (isFailure(stepVersion) || isFailure(expectedVersion)) return failure('INVALID_VERSION');
  if (isFailure(channel)) return channel;
  if (isFailure(outcomeIdempotencyKey) || isFailure(decisionNow)) return failure('INVALID_REF');
  const outer = { tenantRef: refs[0], sequenceRef: refs[1], enrollmentRef: refs[2], executionRef: refs[3], stepRef: refs[4], stepVersion, channel, expectedVersion, outcomeIdempotencyKey, decisionNow };
  const snapshot = validateReaderSnapshot(value.readerSnapshot);
  if (isFailure(snapshot)) return snapshot;
  if (validateScope(snapshot, outer)) return failure('SCOPE_MISMATCH');
  if (snapshot.stepVersion !== stepVersion) return failure('SCOPE_MISMATCH');
  const reservation = validateReservationReceipt(value.reservationReceipt);
  if (isFailure(reservation)) return reservation;
  if (reservation.tenantRef !== refs[0] || reservation.sequenceRef !== refs[1] || reservation.enrollmentRef !== refs[2] || reservation.executionRef !== refs[3] || reservation.stepRef !== refs[4] || reservation.stepVersion !== stepVersion || reservation.channel !== channel || reservation.postVersion < 1) return failure('SCOPE_MISMATCH');
  const providerOutcome = value.providerOutcome === undefined ? undefined : validateProviderOutcome(value.providerOutcome, outer, decisionNow as string, reservation);
  if (isFailure(providerOutcome)) return providerOutcome;
  const predecessorOutcomeReceipt = value.predecessorOutcomeReceipt === undefined ? undefined : validateOutcomeReceipt(value.predecessorOutcomeReceipt, outer, reservation);
  if (isFailure(predecessorOutcomeReceipt)) return predecessorOutcomeReceipt;
  if (predecessorOutcomeReceipt !== undefined && (predecessorOutcomeReceipt.decision !== 'PROVIDER_EVIDENCE_ONLY' || predecessorOutcomeReceipt.postState !== 'sending' || predecessorOutcomeReceipt.postVersion !== reservation.postVersion || predecessorOutcomeReceipt.providerOutcome === undefined || predecessorOutcomeReceipt.outcomeIdempotencyKey === outcomeIdempotencyKey)) return failure('OUTCOME_CONFLICT');
  const effectiveProvider = providerOutcome ?? predecessorOutcomeReceipt?.providerOutcome;
  const businessReceipt = value.businessReceipt === undefined ? undefined : effectiveProvider === undefined ? failure('INVALID_OUTCOME') : validateBusinessReceipt(value.businessReceipt, outer, decisionNow as string, reservation, effectiveProvider);
  const stopDecision = value.stopDecision === undefined ? undefined : validateStopDecision(value.stopDecision, outer, decisionNow as string);
  if (isFailure(businessReceipt)) return businessReceipt;
  if (isFailure(stopDecision)) return stopDecision;
  if (predecessorOutcomeReceipt !== undefined && providerOutcome !== undefined) return failure('OUTCOME_CONFLICT');
  if (value.persistedOutcomeReceipt !== undefined) {
    const persisted = validateOutcomeReceipt(value.persistedOutcomeReceipt, outer, reservation, outcomeIdempotencyKey as string, decisionNow as string);
    if (isFailure(persisted)) return persisted;
    if (snapshot.state !== persisted.postState || snapshot.version !== persisted.postVersion) return failure('REPLAY_STATE_MISMATCH');
    if ((providerOutcome !== undefined && canonicalJson(providerOutcome) !== canonicalJson(persisted.providerOutcome)) || (businessReceipt !== undefined && canonicalJson(businessReceipt) !== canonicalJson(persisted.businessReceipt)) || (stopDecision !== undefined && canonicalJson(stopDecision) !== canonicalJson(persisted.stopDecision)) || (predecessorOutcomeReceipt !== undefined && canonicalJson(predecessorOutcomeReceipt) !== canonicalJson(persisted.predecessorOutcomeReceipt))) return failure('OUTCOME_CONFLICT');
    return success(deepFreeze({ decision: 'REPLAY', executionMode: 'DRAFT_ONLY', approvalPolicy: 'MANUAL_PER_STEP', intent: OUTCOME_RECONCILIATION_INTENT, operationDigest: persisted.operationDigest, transitionPlan: null, receiptToPersist: null, evidence: { ...(persisted.providerOutcome === undefined ? {} : { providerOutcome: persisted.providerOutcome }), ...(persisted.businessReceipt === undefined ? {} : { businessReceipt: persisted.businessReceipt }), ...(persisted.stopDecision === undefined ? {} : { stopDecision: persisted.stopDecision }) }, reconciliationAction: persisted.decision === 'STOP_RECONCILIATION_REQUIRED' ? 'STOP_ENROLLMENT_READER' : persisted.decision === 'MANUAL_RECONCILIATION_REQUIRED' ? 'MANUAL_RECONCILIATION_REQUIRED' : 'NONE', sendCommand: null, providerCommand: null, queueCommand: null, retryCommand: null }));
  }
  if (snapshot.state !== 'sending' || snapshot.version !== reservation.postVersion || expectedVersion !== reservation.postVersion) return failure('REPLAY_STATE_MISMATCH');
  if (stopDecision !== undefined) {
    if (businessReceipt !== undefined || predecessorOutcomeReceipt !== undefined) return failure('BUSINESS_SENT_FORBIDDEN');
    const receipt = makeReceipt(value, reservation, 'STOP_RECONCILIATION_REQUIRED', providerOutcome as ProviderOutcomeProjection | undefined, undefined, stopDecision, undefined, null, 'sending', expectedVersion as number);
    return success(deepFreeze({ decision: 'STOP_RECONCILIATION_REQUIRED', executionMode: 'DRAFT_ONLY', approvalPolicy: 'MANUAL_PER_STEP', intent: OUTCOME_RECONCILIATION_INTENT, operationDigest: receipt.operationDigest, transitionPlan: null, receiptToPersist: receipt, evidence: { ...(providerOutcome === undefined ? {} : { providerOutcome }), stopDecision }, reconciliationAction: 'STOP_ENROLLMENT_READER', sendCommand: null, providerCommand: null, queueCommand: null, retryCommand: null }));
  }
  if (!effectiveProvider) return failure('INVALID_OUTCOME');
  if (effectiveProvider.providerOutcome === 'FAILED' || effectiveProvider.providerOutcome === 'UNKNOWN') {
    if (businessReceipt !== undefined) return failure('BUSINESS_SENT_FORBIDDEN');
    const decision = 'MANUAL_RECONCILIATION_REQUIRED' as const;
    if (predecessorOutcomeReceipt !== undefined) return failure('OUTCOME_CONFLICT');
    const receipt = makeReceipt(value, reservation, decision, effectiveProvider, undefined, undefined, undefined, null, 'sending', expectedVersion as number);
    return success(deepFreeze({ decision, executionMode: 'DRAFT_ONLY', approvalPolicy: 'MANUAL_PER_STEP', intent: OUTCOME_RECONCILIATION_INTENT, operationDigest: receipt.operationDigest, transitionPlan: null, receiptToPersist: receipt, evidence: { providerOutcome }, reconciliationAction: 'MANUAL_RECONCILIATION_REQUIRED', sendCommand: null, providerCommand: null, queueCommand: null, retryCommand: null }));
  }
  if (businessReceipt === undefined) {
    if (predecessorOutcomeReceipt !== undefined) return failure('OUTCOME_CONFLICT');
    const receipt = makeReceipt(value, reservation, 'PROVIDER_EVIDENCE_ONLY', effectiveProvider, undefined, undefined, undefined, null, 'sending', expectedVersion as number);
    return success(deepFreeze({ decision: 'PROVIDER_EVIDENCE_ONLY', executionMode: 'DRAFT_ONLY', approvalPolicy: 'MANUAL_PER_STEP', intent: OUTCOME_RECONCILIATION_INTENT, operationDigest: receipt.operationDigest, transitionPlan: null, receiptToPersist: receipt, evidence: { providerOutcome }, reconciliationAction: 'NONE', sendCommand: null, providerCommand: null, queueCommand: null, retryCommand: null }));
  }
  if (!['ACCEPTED', 'DELIVERED'].includes(effectiveProvider.providerOutcome)) return failure('BUSINESS_SENT_FORBIDDEN');
  const transition = planStepExecutionTransition({ executionRef: reservation.executionRef, tenantRef: reservation.tenantRef, sequenceRef: reservation.sequenceRef, enrollmentRef: reservation.enrollmentRef, stepRef: reservation.stepRef, stepVersion: reservation.stepVersion, from: 'sending', to: 'sent', expectedVersion, currentVersion: expectedVersion, intent: 'SEND_AFTER_APPROVAL', providerReceiptRef: effectiveProvider.providerReceiptRef, businessReceiptRef: businessReceipt.businessReceiptRef, actorKind: 'FUTURE_EXTERNAL_EXECUTOR', actorRole: 'SYSTEM', actorRef: 'system:outcome-reconciliation-v1' });
  if (!transition.ok) return failure('AUTHORITY_TRANSITION_REJECTED');
  const receipt = makeReceipt(value, reservation, 'BUSINESS_SENT', predecessorOutcomeReceipt === undefined ? providerOutcome : undefined, businessReceipt, undefined, predecessorOutcomeReceipt, transition.value.operationDigest, 'sent', (expectedVersion as number) + 1);
  return success(deepFreeze({ decision: 'BUSINESS_SENT', executionMode: 'DRAFT_ONLY', approvalPolicy: 'MANUAL_PER_STEP', intent: OUTCOME_RECONCILIATION_INTENT, operationDigest: receipt.operationDigest, transitionPlan: transition.value, receiptToPersist: receipt, evidence: { ...(providerOutcome === undefined ? {} : { providerOutcome }), businessReceipt }, reconciliationAction: 'NONE', sendCommand: null, providerCommand: null, queueCommand: null, retryCommand: null }));
}
