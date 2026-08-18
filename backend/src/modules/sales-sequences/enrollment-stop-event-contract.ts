/**
 * CRM-03B-1: pure, redacted enrollment stop-event reader projection.
 *
 * This contract accepts only the minimum trusted reader projection. It does
 * not parse inbound provider payloads, resolve contacts, read a database, or
 * emit a send/outbox/provider command. Enrollment state authority remains in
 * CRM-03A's planEnrollmentTransition function.
 */

import { createHash } from 'node:crypto';
import {
  planEnrollmentTransition,
  type EnrollmentStopReason,
  type EnrollmentState,
  type OpaqueRef,
  type TransitionPlan,
} from './sales-sequence-contract';

export const ENROLLMENT_STOP_EVENT_SCHEMA_VERSION = 1 as const;
export const ENROLLMENT_STOP_EVENT_POLICY_VERSION = 1 as const;
export const STOP_EVENT_ACTOR_REF = 'system:enrollment-stop-event-reader-v1' as const;

export const STOP_EVENT_KINDS = Object.freeze([
  'REPLY_RECEIVED',
  'OPT_OUT_RECEIVED',
  'BLACKLIST_MATCHED',
  'PERMISSION_REVOKED',
  'CONTACT_UNTRUSTED',
] as const);
export const STOP_EVENT_SOURCE_KINDS = Object.freeze([
  'EMAIL_INBOUND',
  'WHATSAPP_INBOUND',
  'BLACKLIST_REGISTRY',
  'PERMISSION_REGISTRY',
  'CONTACT_TRUST_READER',
] as const);

export type StopEventKind = (typeof STOP_EVENT_KINDS)[number];
export type StopEventSourceKind = (typeof STOP_EVENT_SOURCE_KINDS)[number];
export type StopEventDecision = 'NEW' | 'REPLAY';

export type EnrollmentStopEventContractErrorCode =
  | 'UNSUPPORTED_ENVELOPE'
  | 'UNKNOWN_FIELD'
  | 'EXPLICIT_UNDEFINED'
  | 'TYPE_MISMATCH'
  | 'PII_OR_SECRET_INPUT'
  | 'INVALID_REF'
  | 'INVALID_DIGEST'
  | 'INVALID_VERSION'
  | 'INVALID_POLICY_VERSION'
  | 'INVALID_EVENT_KIND'
  | 'INVALID_SOURCE_KIND'
  | 'EVENT_SOURCE_MISMATCH'
  | 'INVALID_TIMESTAMP'
  | 'FUTURE_EVENT'
  | 'SCOPE_MISMATCH'
  | 'INVALID_STATE'
  | 'TERMINAL_ENROLLMENT'
  | 'EVENT_DIGEST_MISMATCH'
  | 'OPERATION_DIGEST_MISMATCH'
  | 'INVALID_RECEIPT'
  | 'IDEMPOTENCY_CONFLICT'
  | 'REPLAY_STATE_MISMATCH'
  | 'STOP_PLAN_REJECTED';

const ERROR_MESSAGES: Readonly<Record<EnrollmentStopEventContractErrorCode, string>> = Object.freeze({
  UNSUPPORTED_ENVELOPE: 'enrollment stop-event envelope is unsupported',
  UNKNOWN_FIELD: 'enrollment stop-event envelope contains an unknown field',
  EXPLICIT_UNDEFINED: 'enrollment stop-event envelope contains explicit undefined',
  TYPE_MISMATCH: 'enrollment stop-event envelope has an invalid type',
  PII_OR_SECRET_INPUT: 'enrollment stop-event envelope contains disallowed sensitive input',
  INVALID_REF: 'opaque reference is invalid',
  INVALID_DIGEST: 'digest is invalid',
  INVALID_VERSION: 'version is invalid',
  INVALID_POLICY_VERSION: 'stop-event schema or policy version is invalid',
  INVALID_EVENT_KIND: 'stop-event kind is invalid',
  INVALID_SOURCE_KIND: 'stop-event source kind is invalid',
  EVENT_SOURCE_MISMATCH: 'stop-event source kind is not allowed for the event kind',
  INVALID_TIMESTAMP: 'timestamp is invalid',
  FUTURE_EVENT: 'stop event cannot occur after decision time',
  SCOPE_MISMATCH: 'stop-event scope does not match the reader snapshot',
  INVALID_STATE: 'reader enrollment state is invalid',
  TERMINAL_ENROLLMENT: 'terminal enrollment cannot receive a stop event',
  EVENT_DIGEST_MISMATCH: 'event digest does not match the redacted event intent',
  OPERATION_DIGEST_MISMATCH: 'operation digest does not match the redacted stop intent',
  INVALID_RECEIPT: 'persisted stop-event receipt is invalid',
  IDEMPOTENCY_CONFLICT: 'stop-event receipt conflicts with the operation intent',
  REPLAY_STATE_MISMATCH: 'reader snapshot is not the persisted stop-event post-state',
  STOP_PLAN_REJECTED: 'enrollment stop plan was rejected by the state authority',
});

export type EnrollmentStopEventContractResult<T> =
  | Readonly<{ ok: true; value: T }>
  | Readonly<{ ok: false; error: Readonly<{ code: EnrollmentStopEventContractErrorCode; message: string }> }>;

type Failure = Extract<EnrollmentStopEventContractResult<never>, { ok: false }>;

export type EnrollmentReaderSnapshot = Readonly<{
  tenantRef: OpaqueRef;
  sequenceRef: OpaqueRef;
  enrollmentRef: OpaqueRef;
  leadRef: OpaqueRef;
  contactRef: OpaqueRef | null;
  status: EnrollmentState;
  version: number;
}>;

export type EnrollmentStopEventInput = Readonly<{
  schemaVersion: 1;
  policyVersion: 1;
  eventKey: OpaqueRef;
  eventKind: StopEventKind;
  sourceKind: StopEventSourceKind;
  tenantRef: OpaqueRef;
  sequenceRef: OpaqueRef;
  enrollmentRef: OpaqueRef;
  leadRef: OpaqueRef;
  contactRef?: OpaqueRef | null;
  sourceReceiptRef: OpaqueRef;
  occurredAt: string;
  decisionNow: string;
  eventDigest: string;
  operationDigest: string;
  readerSnapshot: EnrollmentReaderSnapshot;
  persistedReceipt?: EnrollmentStopEventReceiptProjection;
}>;

export type EnrollmentStopEventDigestIntent = Readonly<{
  schemaVersion: 1;
  policyVersion: 1;
  eventKey: OpaqueRef;
  eventKind: StopEventKind;
  sourceKind: StopEventSourceKind;
  tenantRef: OpaqueRef;
  sequenceRef: OpaqueRef;
  enrollmentRef: OpaqueRef;
  leadRef: OpaqueRef;
  contactRef: OpaqueRef | null;
  sourceReceiptRef: OpaqueRef;
  occurredAt: string;
}>;

export type EnrollmentStopOperationDigestIntent = Readonly<{
  schemaVersion: 1;
  policyVersion: 1;
  eventDigest: string;
  eventKey: OpaqueRef;
  eventKind: StopEventKind;
  sourceKind: StopEventSourceKind;
  tenantRef: OpaqueRef;
  sequenceRef: OpaqueRef;
  enrollmentRef: OpaqueRef;
  leadRef: OpaqueRef;
  contactRef: OpaqueRef | null;
  sourceReceiptRef: OpaqueRef;
  occurredAt: string;
  preState: 'pending' | 'active' | 'paused';
  preVersion: number;
  postState: 'exited' | 'blocked';
  postVersion: number;
  stopReason: EnrollmentStopReason;
  stopPlanOperationDigest: string;
}>;

export type EnrollmentStopEventReceiptProjection = Readonly<{
  schemaVersion: 1;
  policyVersion: 1;
  receiptRef: OpaqueRef;
  eventKey: OpaqueRef;
  eventDigest: string;
  operationDigest: string;
  eventKind: StopEventKind;
  sourceKind: StopEventSourceKind;
  tenantRef: OpaqueRef;
  sequenceRef: OpaqueRef;
  enrollmentRef: OpaqueRef;
  leadRef: OpaqueRef;
  contactRef: OpaqueRef | null;
  sourceReceiptRef: OpaqueRef;
  occurredAt: string;
  preState: 'pending' | 'active' | 'paused';
  preVersion: number;
  postState: 'exited' | 'blocked';
  postVersion: number;
  stopReason: EnrollmentStopReason;
  stopPlanOperationDigest: string;
}>;

export type EnrollmentStopEventPlan = Readonly<{
  decision: StopEventDecision;
  eventDigest: string;
  operationDigest: string;
  stopPlan: TransitionPlan | null;
  receiptToPersist: EnrollmentStopEventReceiptProjection | null;
}>;

const OPAQUE_REF_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/;
const DIGEST_PATTERN = /^sha256:[a-z0-9-]+:[0-9a-f]{64}$/;
const GENERATED_HASH_REF_PATTERN = /:[0-9a-f]{16,}$/i;
const UTC_TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/;
const IDENTITY_PATTERN = /(?:[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,})|(?:\+?\d{8,15})|(?:@[a-z0-9._-]*(?:s\.whatsapp\.net|g\.us|lid))/i;
const SECRET_PATTERN = /(?:bearer\s+|sk-[a-z0-9]|api[_-]?key\s*[:=]|password\s*[:=]|authorization\s*[:=])/i;
const SENSITIVE_KEY_PATTERN = /(?:email|phone|telephone|mobile|jid|body|subject|content|excerpt|payload|provider|error|url|confidence|raw|token|secret|password|cookie|authorization|api.?key)/i;
const EVENT_KEY_PREFIX = 'stop-event:';
const SOURCE_RECEIPT_PREFIX = 'source-receipt:';
const STOP_RECEIPT_PREFIX = 'stop-event-receipt:';
const STOP_EVENT_SCOPE_KEYS = ['tenantRef', 'sequenceRef', 'enrollmentRef', 'leadRef', 'contactRef'] as const;
const ACTIVE_ENROLLMENT_STATES = Object.freeze(['pending', 'active', 'paused'] as const);
const TERMINAL_ENROLLMENT_STATES = Object.freeze(['blocked', 'exited', 'completed'] as const);
const POST_STOP_STATES = Object.freeze(['exited', 'blocked'] as const);
type ActiveEnrollmentState = (typeof ACTIVE_ENROLLMENT_STATES)[number];
type PostStopState = (typeof POST_STOP_STATES)[number];

type RecordValue = Record<string, unknown>;

function deepFreeze<T>(value: T, seen = new Set<object>()): T {
  if (value === null || typeof value !== 'object' || seen.has(value)) return value;
  seen.add(value);
  for (const child of Object.values(value as RecordValue)) deepFreeze(child, seen);
  return Object.freeze(value);
}

function failure(code: EnrollmentStopEventContractErrorCode): Failure {
  return deepFreeze({ ok: false, error: { code, message: ERROR_MESSAGES[code] } });
}

function success<T>(value: T): EnrollmentStopEventContractResult<T> {
  return deepFreeze({ ok: true, value });
}

function isRecord(value: unknown): value is RecordValue {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function isFailure(value: unknown): value is Failure {
  return isRecord(value) && value.ok === false;
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

function containsSensitiveInput(value: unknown, key?: string, seen = new Set<object>()): boolean {
  if (key && SENSITIVE_KEY_PATTERN.test(key)) return true;
  if (typeof value === 'string') {
    const safeTokenField = key !== undefined && /(?:Ref|Key|Digest|At|Version)$/.test(key);
    return ((!safeTokenField && !value.startsWith('sha256:')) && IDENTITY_PATTERN.test(value)) || SECRET_PATTERN.test(value);
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
  const generatedReceiptRef = prefix === STOP_RECEIPT_PREFIX && typeof value === 'string' && GENERATED_HASH_REF_PATTERN.test(value);
  if (typeof value !== 'string' || !OPAQUE_REF_PATTERN.test(value) || value.includes('://') || (!generatedReceiptRef && IDENTITY_PATTERN.test(value)) || /(?:email|phone|jid|token|secret|password|cookie|authorization)/i.test(value)) return failure('INVALID_REF');
  if (prefix !== undefined && !value.startsWith(prefix)) return failure('INVALID_REF');
  return value;
}

function validateDigest(value: unknown): string | Failure {
  if (typeof value !== 'string' || !DIGEST_PATTERN.test(value)) return failure('INVALID_DIGEST');
  return value;
}

function validateVersion(value: unknown): number | Failure {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1 || value > 1_000_000) return failure('INVALID_VERSION');
  return value;
}

function validateTimestamp(value: unknown): string | Failure {
  if (typeof value !== 'string' || !UTC_TIMESTAMP_PATTERN.test(value)) return failure('INVALID_TIMESTAMP');
  const match = value.match(/^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d{1,3}))?Z$/);
  if (!match) return failure('INVALID_TIMESTAMP');
  const canonical = `${match[1]}.${(match[2] ?? '').padEnd(3, '0')}Z`;
  const millis = Date.parse(canonical);
  if (!Number.isFinite(millis) || new Date(millis).toISOString() !== canonical) return failure('INVALID_TIMESTAMP');
  return canonical;
}

function validateEventKind(value: unknown): StopEventKind | Failure {
  if (!STOP_EVENT_KINDS.includes(value as StopEventKind)) return failure('INVALID_EVENT_KIND');
  return value as StopEventKind;
}

function validateSourceKind(value: unknown): StopEventSourceKind | Failure {
  if (!STOP_EVENT_SOURCE_KINDS.includes(value as StopEventSourceKind)) return failure('INVALID_SOURCE_KIND');
  return value as StopEventSourceKind;
}

function validateContactRef(value: unknown): string | null | Failure {
  if (value === null) return null;
  return validateRef(value);
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

function makeReceiptRef(operationDigest: string): OpaqueRef {
  return `${STOP_RECEIPT_PREFIX}${operationDigest.slice(-32)}`;
}

const STOP_EVENT_RULES: Readonly<Record<StopEventKind, Readonly<{
  sourceKinds: readonly StopEventSourceKind[];
  stopReason: EnrollmentStopReason;
  to: 'exited' | 'blocked';
}>>> = Object.freeze({
  REPLY_RECEIVED: Object.freeze({ sourceKinds: Object.freeze(['EMAIL_INBOUND', 'WHATSAPP_INBOUND'] as readonly StopEventSourceKind[]), stopReason: 'reply', to: 'exited' }),
  OPT_OUT_RECEIVED: Object.freeze({ sourceKinds: Object.freeze(['EMAIL_INBOUND', 'WHATSAPP_INBOUND'] as readonly StopEventSourceKind[]), stopReason: 'optout', to: 'exited' }),
  BLACKLIST_MATCHED: Object.freeze({ sourceKinds: Object.freeze(['BLACKLIST_REGISTRY'] as readonly StopEventSourceKind[]), stopReason: 'blacklist', to: 'exited' }),
  PERMISSION_REVOKED: Object.freeze({ sourceKinds: Object.freeze(['PERMISSION_REGISTRY'] as readonly StopEventSourceKind[]), stopReason: 'permission_revoked', to: 'blocked' }),
  CONTACT_UNTRUSTED: Object.freeze({ sourceKinds: Object.freeze(['CONTACT_TRUST_READER'] as readonly StopEventSourceKind[]), stopReason: 'contact_untrusted', to: 'blocked' }),
});

export function computeEnrollmentStopEventDigest(input: EnrollmentStopEventDigestIntent): string {
  return hash('enrollment-stop-event-v1', input);
}

export function computeEnrollmentStopOperationDigest(input: EnrollmentStopOperationDigestIntent): string {
  return hash('enrollment-stop-operation-v1', input);
}

function validateReaderSnapshot(input: unknown): EnrollmentReaderSnapshot | Failure {
  const value = validateEnvelope(input, ['tenantRef', 'sequenceRef', 'enrollmentRef', 'leadRef', 'contactRef', 'status', 'version']);
  if (isFailure(value)) return value;
  const tenantRef = validateRef(value.tenantRef);
  const sequenceRef = validateRef(value.sequenceRef);
  const enrollmentRef = validateRef(value.enrollmentRef);
  const leadRef = validateRef(value.leadRef);
  const contactRef = value.contactRef === undefined ? null : validateContactRef(value.contactRef);
  const version = validateVersion(value.version);
  if (isFailure(tenantRef) || isFailure(sequenceRef) || isFailure(enrollmentRef) || isFailure(leadRef) || isFailure(contactRef) || isFailure(version)) return failure('TYPE_MISMATCH');
  if (![...ACTIVE_ENROLLMENT_STATES, ...TERMINAL_ENROLLMENT_STATES].includes(value.status as EnrollmentState)) return failure('INVALID_STATE');
  return { tenantRef, sequenceRef, enrollmentRef, leadRef, contactRef, status: value.status as EnrollmentState, version };
}

function validateScope(
  event: Readonly<{ tenantRef: string; sequenceRef: string; enrollmentRef: string; leadRef: string; contactRef: string | null }>,
  snapshot: EnrollmentReaderSnapshot,
): Failure | null {
  for (const key of STOP_EVENT_SCOPE_KEYS) {
    if (event[key] !== snapshot[key]) return failure('SCOPE_MISMATCH');
  }
  return null;
}

function validateReceipt(input: unknown): EnrollmentStopEventReceiptProjection | Failure {
  const value = validateEnvelope(input, [
    'schemaVersion', 'policyVersion', 'receiptRef', 'eventKey', 'eventDigest', 'operationDigest',
    'eventKind', 'sourceKind', 'tenantRef', 'sequenceRef', 'enrollmentRef', 'leadRef', 'contactRef',
    'sourceReceiptRef', 'occurredAt', 'preState', 'preVersion', 'postState', 'postVersion', 'stopReason',
    'stopPlanOperationDigest',
  ]);
  if (isFailure(value)) return failure('INVALID_RECEIPT');
  const schemaVersion = value.schemaVersion === ENROLLMENT_STOP_EVENT_SCHEMA_VERSION;
  const policyVersion = value.policyVersion === ENROLLMENT_STOP_EVENT_POLICY_VERSION;
  const receiptRef = validateRef(value.receiptRef, STOP_RECEIPT_PREFIX);
  const eventKey = validateRef(value.eventKey, EVENT_KEY_PREFIX);
  const eventDigest = validateDigest(value.eventDigest);
  const operationDigest = validateDigest(value.operationDigest);
  const eventKind = validateEventKind(value.eventKind);
  const sourceKind = validateSourceKind(value.sourceKind);
  const tenantRef = validateRef(value.tenantRef);
  const sequenceRef = validateRef(value.sequenceRef);
  const enrollmentRef = validateRef(value.enrollmentRef);
  const leadRef = validateRef(value.leadRef);
  const contactRef = validateContactRef(value.contactRef);
  const sourceReceiptRef = validateRef(value.sourceReceiptRef, SOURCE_RECEIPT_PREFIX);
  const occurredAt = validateTimestamp(value.occurredAt);
  const preVersion = validateVersion(value.preVersion);
  const postVersion = validateVersion(value.postVersion);
  const stopPlanOperationDigest = validateDigest(value.stopPlanOperationDigest);
  if (!schemaVersion || !policyVersion) return failure('INVALID_RECEIPT');
  if (isFailure(receiptRef) || isFailure(eventKey) || isFailure(eventDigest) || isFailure(operationDigest) || isFailure(eventKind) || isFailure(sourceKind) || isFailure(tenantRef) || isFailure(sequenceRef) || isFailure(enrollmentRef) || isFailure(leadRef) || isFailure(contactRef) || isFailure(sourceReceiptRef) || isFailure(occurredAt) || isFailure(preVersion) || isFailure(postVersion) || isFailure(stopPlanOperationDigest)) return failure('INVALID_RECEIPT');
  if (!ACTIVE_ENROLLMENT_STATES.includes(value.preState as ActiveEnrollmentState)) return failure('INVALID_RECEIPT');
  if (!POST_STOP_STATES.includes(value.postState as PostStopState)) return failure('INVALID_RECEIPT');
  if (postVersion !== preVersion + 1) return failure('INVALID_RECEIPT');
  if (!['reply', 'optout', 'blacklist', 'permission_revoked', 'contact_untrusted'].includes(value.stopReason as string)) return failure('INVALID_RECEIPT');
  return {
    schemaVersion: 1, policyVersion: 1, receiptRef, eventKey, eventDigest, operationDigest,
    eventKind, sourceKind, tenantRef, sequenceRef, enrollmentRef, leadRef, contactRef,
    sourceReceiptRef, occurredAt, preState: value.preState as ActiveEnrollmentState, preVersion,
    postState: value.postState as PostStopState, postVersion, stopReason: value.stopReason as EnrollmentStopReason,
    stopPlanOperationDigest,
  };
}

function receiptMatches(left: EnrollmentStopEventReceiptProjection, right: EnrollmentStopEventReceiptProjection): boolean {
  return canonicalJson(left) === canonicalJson(right);
}

function createStopPlan(
  tenantRef: OpaqueRef,
  sequenceRef: OpaqueRef,
  enrollmentRef: OpaqueRef,
  preState: ActiveEnrollmentState,
  preVersion: number,
  rule: Readonly<{ stopReason: EnrollmentStopReason; to: PostStopState }>,
): TransitionPlan | Failure {
  const stopPlan = planEnrollmentTransition({
    tenantRef,
    sequenceRef,
    enrollmentRef,
    resourceTenantRef: tenantRef,
    from: preState,
    to: rule.to,
    expectedVersion: preVersion,
    currentVersion: preVersion,
    intent: 'ENROLLMENT_STOP',
    stopReason: rule.stopReason,
    actorKind: 'SYSTEM',
    actorRole: 'SYSTEM',
    actorRef: STOP_EVENT_ACTOR_REF,
  });
  if (!stopPlan.ok || stopPlan.value.decision !== 'PLAN_ONLY' || stopPlan.value.sendCommand !== null) return failure('STOP_PLAN_REJECTED');
  return stopPlan.value;
}

function makeOperationIntent(
  eventIntent: EnrollmentStopEventDigestIntent,
  eventDigest: string,
  preState: ActiveEnrollmentState,
  preVersion: number,
  postState: PostStopState,
  postVersion: number,
  stopReason: EnrollmentStopReason,
  stopPlanOperationDigest: string,
): EnrollmentStopOperationDigestIntent {
  return {
    ...eventIntent,
    eventDigest,
    preState,
    preVersion,
    postState,
    postVersion,
    stopReason,
    stopPlanOperationDigest,
  };
}

function makeReceipt(
  eventIntent: EnrollmentStopEventDigestIntent,
  eventDigest: string,
  operationDigest: string,
  preState: ActiveEnrollmentState,
  preVersion: number,
  postState: PostStopState,
  postVersion: number,
  stopReason: EnrollmentStopReason,
  stopPlanOperationDigest: string,
): EnrollmentStopEventReceiptProjection {
  return {
    schemaVersion: 1,
    policyVersion: 1,
    receiptRef: makeReceiptRef(operationDigest),
    eventKey: eventIntent.eventKey,
    eventDigest,
    operationDigest,
    eventKind: eventIntent.eventKind,
    sourceKind: eventIntent.sourceKind,
    tenantRef: eventIntent.tenantRef,
    sequenceRef: eventIntent.sequenceRef,
    enrollmentRef: eventIntent.enrollmentRef,
    leadRef: eventIntent.leadRef,
    contactRef: eventIntent.contactRef,
    sourceReceiptRef: eventIntent.sourceReceiptRef,
    occurredAt: eventIntent.occurredAt,
    preState,
    preVersion,
    postState,
    postVersion,
    stopReason,
    stopPlanOperationDigest,
  };
}

function validatePersistedReceipt(
  input: EnrollmentStopEventReceiptProjection,
  eventIntent: EnrollmentStopEventDigestIntent,
  eventDigest: string,
  rule: Readonly<{ sourceKinds: readonly StopEventSourceKind[]; stopReason: EnrollmentStopReason; to: PostStopState }>,
): EnrollmentStopEventReceiptProjection | Failure {
  const receipt = validateReceipt(input);
  if (isFailure(receipt)) return receipt;
  if (receipt.eventKey !== eventIntent.eventKey || receipt.eventKind !== eventIntent.eventKind || receipt.sourceKind !== eventIntent.sourceKind || receipt.sourceReceiptRef !== eventIntent.sourceReceiptRef || receipt.occurredAt !== eventIntent.occurredAt || receipt.eventDigest !== eventDigest) return failure('INVALID_RECEIPT');
  if (!rule.sourceKinds.includes(receipt.sourceKind) || receipt.stopReason !== rule.stopReason || receipt.postState !== rule.to) return failure('INVALID_RECEIPT');
  for (const key of STOP_EVENT_SCOPE_KEYS) {
    if (receipt[key] !== eventIntent[key]) return failure('INVALID_RECEIPT');
  }
  const recomputedEventDigest = computeEnrollmentStopEventDigest({
    schemaVersion: 1,
    policyVersion: 1,
    eventKey: receipt.eventKey,
    eventKind: receipt.eventKind,
    sourceKind: receipt.sourceKind,
    tenantRef: receipt.tenantRef,
    sequenceRef: receipt.sequenceRef,
    enrollmentRef: receipt.enrollmentRef,
    leadRef: receipt.leadRef,
    contactRef: receipt.contactRef,
    sourceReceiptRef: receipt.sourceReceiptRef,
    occurredAt: receipt.occurredAt,
  });
  if (recomputedEventDigest !== receipt.eventDigest) return failure('INVALID_RECEIPT');
  const stopPlan = createStopPlan(receipt.tenantRef, receipt.sequenceRef, receipt.enrollmentRef, receipt.preState, receipt.preVersion, rule);
  if (isFailure(stopPlan) || stopPlan.operationDigest !== receipt.stopPlanOperationDigest || stopPlan.nextVersion !== receipt.postVersion) return failure('INVALID_RECEIPT');
  const expectedOperationDigest = computeEnrollmentStopOperationDigest(makeOperationIntent(
    eventIntent,
    eventDigest,
    receipt.preState,
    receipt.preVersion,
    receipt.postState,
    receipt.postVersion,
    receipt.stopReason,
    receipt.stopPlanOperationDigest,
  ));
  if (expectedOperationDigest !== receipt.operationDigest || makeReceiptRef(receipt.operationDigest) !== receipt.receiptRef) return failure('INVALID_RECEIPT');
  return receipt;
}

export function planEnrollmentStopEvent(input: unknown): EnrollmentStopEventContractResult<EnrollmentStopEventPlan> {
  const value = validateEnvelope(input, [
    'schemaVersion', 'policyVersion', 'eventKey', 'eventKind', 'sourceKind', 'tenantRef', 'sequenceRef',
    'enrollmentRef', 'leadRef', 'contactRef', 'sourceReceiptRef', 'occurredAt', 'decisionNow',
    'eventDigest', 'operationDigest', 'readerSnapshot', 'persistedReceipt',
  ]);
  if (isFailure(value)) return value;
  if (value.schemaVersion !== ENROLLMENT_STOP_EVENT_SCHEMA_VERSION || value.policyVersion !== ENROLLMENT_STOP_EVENT_POLICY_VERSION) return failure('INVALID_POLICY_VERSION');

  const eventKey = validateRef(value.eventKey, EVENT_KEY_PREFIX);
  const eventKind = validateEventKind(value.eventKind);
  const sourceKind = validateSourceKind(value.sourceKind);
  const tenantRef = validateRef(value.tenantRef);
  const sequenceRef = validateRef(value.sequenceRef);
  const enrollmentRef = validateRef(value.enrollmentRef);
  const leadRef = validateRef(value.leadRef);
  const contactRef = value.contactRef === undefined ? null : validateContactRef(value.contactRef);
  const sourceReceiptRef = validateRef(value.sourceReceiptRef, SOURCE_RECEIPT_PREFIX);
  const occurredAt = validateTimestamp(value.occurredAt);
  const decisionNow = validateTimestamp(value.decisionNow);
  const eventDigest = validateDigest(value.eventDigest);
  const operationDigest = validateDigest(value.operationDigest);
  if (isFailure(eventKey)) return eventKey;
  if (isFailure(eventKind)) return eventKind;
  if (isFailure(sourceKind)) return sourceKind;
  if (isFailure(tenantRef)) return tenantRef;
  if (isFailure(sequenceRef)) return sequenceRef;
  if (isFailure(enrollmentRef)) return enrollmentRef;
  if (isFailure(leadRef)) return leadRef;
  if (isFailure(contactRef)) return contactRef;
  if (isFailure(sourceReceiptRef)) return sourceReceiptRef;
  if (isFailure(occurredAt)) return occurredAt;
  if (isFailure(decisionNow)) return decisionNow;
  if (isFailure(eventDigest)) return eventDigest;
  if (isFailure(operationDigest)) return operationDigest;

  const rule = STOP_EVENT_RULES[eventKind];
  if (!rule.sourceKinds.includes(sourceKind)) return failure('EVENT_SOURCE_MISMATCH');
  if (occurredAt > decisionNow) return failure('FUTURE_EVENT');
  const snapshot = validateReaderSnapshot(value.readerSnapshot);
  if (isFailure(snapshot)) return snapshot;
  const scopeFailure = validateScope({ tenantRef, sequenceRef, enrollmentRef, leadRef, contactRef }, snapshot);
  if (scopeFailure) return scopeFailure;

  const eventIntent: EnrollmentStopEventDigestIntent = {
    schemaVersion: 1, policyVersion: 1, eventKey, eventKind, sourceKind,
    tenantRef, sequenceRef, enrollmentRef, leadRef, contactRef, sourceReceiptRef, occurredAt,
  };
  const expectedEventDigest = computeEnrollmentStopEventDigest(eventIntent);
  if (eventDigest !== expectedEventDigest) return failure('EVENT_DIGEST_MISMATCH');
  if (value.persistedReceipt !== undefined) {
    const persisted = validatePersistedReceipt(value.persistedReceipt as EnrollmentStopEventReceiptProjection, eventIntent, eventDigest, rule);
    if (isFailure(persisted)) return persisted;
    const persistedScope = validateScope(persisted, snapshot);
    if (persistedScope) return persistedScope;
    if (operationDigest !== persisted.operationDigest) return failure('IDEMPOTENCY_CONFLICT');
    if (snapshot.status !== persisted.postState || snapshot.version !== persisted.postVersion) return failure('REPLAY_STATE_MISMATCH');
    if (!receiptMatches(persisted, makeReceipt(
      eventIntent,
      eventDigest,
      persisted.operationDigest,
      persisted.preState,
      persisted.preVersion,
      persisted.postState,
      persisted.postVersion,
      persisted.stopReason,
      persisted.stopPlanOperationDigest,
    ))) return failure('INVALID_RECEIPT');
    return success({ decision: 'REPLAY', eventDigest, operationDigest, stopPlan: null, receiptToPersist: null });
  }
  if (!ACTIVE_ENROLLMENT_STATES.includes(snapshot.status as ActiveEnrollmentState)) return failure('TERMINAL_ENROLLMENT');
  const preState = snapshot.status as ActiveEnrollmentState;
  const stopPlan = createStopPlan(tenantRef, sequenceRef, enrollmentRef, preState, snapshot.version, rule);
  if (isFailure(stopPlan)) return stopPlan;
  const expectedOperationDigest = computeEnrollmentStopOperationDigest(makeOperationIntent(
    eventIntent,
    eventDigest,
    preState,
    snapshot.version,
    rule.to,
    stopPlan.nextVersion,
    rule.stopReason,
    stopPlan.operationDigest,
  ));
  if (operationDigest !== expectedOperationDigest) return failure('OPERATION_DIGEST_MISMATCH');
  const expectedReceipt = makeReceipt(
    eventIntent,
    eventDigest,
    operationDigest,
    preState,
    snapshot.version,
    rule.to,
    stopPlan.nextVersion,
    rule.stopReason,
    stopPlan.operationDigest,
  );
  return success(deepFreeze({ decision: 'NEW', eventDigest, operationDigest, stopPlan, receiptToPersist: expectedReceipt }));
}
