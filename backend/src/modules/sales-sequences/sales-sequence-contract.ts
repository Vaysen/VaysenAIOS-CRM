/**
 * CRM-03A-1: pure Sales Sequence domain contract.
 *
 * This file deliberately has no Nest, Prisma, queue, provider, clock, or
 * channel dependency. It validates opaque references only and returns
 * deterministic, JSON-safe plans. A plan is not a database write or a send.
 */

import { createHash } from 'node:crypto';

export const SALES_SEQUENCE_SCHEMA_VERSION = 1 as const;
export const SEQUENCE_EXECUTION_MODE = 'DRAFT_ONLY' as const;
export const SEQUENCE_APPROVAL_POLICY = 'MANUAL_PER_STEP' as const;
export const SEQUENCE_CHANNELS = Object.freeze(['EMAIL', 'WHATSAPP'] as const);

export const SEQUENCE_STATES = Object.freeze(['draft', 'active', 'paused', 'archived'] as const);
export const STEP_STATES = Object.freeze(['draft', 'active', 'paused', 'archived'] as const);
export const ENROLLMENT_STATES = Object.freeze([
  'pending', 'active', 'paused', 'blocked', 'exited', 'completed',
] as const);
export const STEP_EXECUTION_STATES = Object.freeze([
  'draft_pending', 'draft_ready', 'approval_required', 'approved',
  'sending', 'sent', 'failed', 'unknown', 'cancelled', 'blocked',
] as const);

export type SequenceState = (typeof SEQUENCE_STATES)[number];
export type StepState = (typeof STEP_STATES)[number];
export type EnrollmentState = (typeof ENROLLMENT_STATES)[number];
export type StepExecutionState = (typeof STEP_EXECUTION_STATES)[number];
export type Channel = (typeof SEQUENCE_CHANNELS)[number];
export type OpaqueRef = string;
export type Digest = string;

export type SequenceContractErrorCode =
  | 'UNSUPPORTED_ENVELOPE'
  | 'UNKNOWN_FIELD'
  | 'EXPLICIT_UNDEFINED'
  | 'TYPE_MISMATCH'
  | 'PII_OR_SECRET_INPUT'
  | 'INVALID_REF'
  | 'INVALID_DIGEST'
  | 'INVALID_VERSION'
  | 'VERSION_MISMATCH'
  | 'INVALID_STATE'
  | 'ILLEGAL_TRANSITION'
  | 'INVALID_CHANNEL'
  | 'INVALID_TIMEZONE'
  | 'INVALID_TIMESTAMP'
  | 'INVALID_POSITION'
  | 'DUPLICATE_POSITION'
  | 'INVALID_DELAY'
  | 'STRING_OUT_OF_RANGE'
  | 'APPROVAL_REQUIRED'
  | 'APPROVAL_FORBIDDEN'
  | 'EXTERNAL_EXECUTION_DEFERRED'
  | 'OUTBOX_CAS_REQUIRED'
  | 'PROVIDER_RECEIPT_NOT_BUSINESS_SENT'
  | 'UNKNOWN_RETRY_FORBIDDEN'
  | 'STOP_REASON_MISMATCH'
  | 'INVALID_FACT_SNAPSHOT'
  | 'AI_PROPOSAL_NOT_AUTHORITATIVE'
  | 'IDEMPOTENCY_CONFLICT'
  | 'INVALID_IDEMPOTENCY'
  | 'CLIENT_RECEIPT_FORBIDDEN'
  | 'INVALID_ACTOR_CONTEXT'
  | 'ACTOR_NOT_AUTHORIZED'
  | 'INVALID_INTENT'
  | 'STOP_REASON_REQUIRED'
  | 'RECEIPT_KIND_CONFLICT';

const ERROR_MESSAGES: Readonly<Record<SequenceContractErrorCode, string>> = Object.freeze({
  UNSUPPORTED_ENVELOPE: 'sales sequence envelope is unsupported',
  UNKNOWN_FIELD: 'sales sequence envelope contains an unknown field',
  EXPLICIT_UNDEFINED: 'sales sequence envelope contains explicit undefined',
  TYPE_MISMATCH: 'sales sequence envelope has an invalid type',
  PII_OR_SECRET_INPUT: 'sales sequence envelope contains disallowed sensitive input',
  INVALID_REF: 'opaque reference is invalid',
  INVALID_DIGEST: 'digest is invalid',
  INVALID_VERSION: 'version is invalid',
  VERSION_MISMATCH: 'expected version does not match the current version',
  INVALID_STATE: 'state is invalid',
  ILLEGAL_TRANSITION: 'state transition is not allowed',
  INVALID_CHANNEL: 'channel is invalid',
  INVALID_TIMEZONE: 'timezone is invalid',
  INVALID_TIMESTAMP: 'timestamp is invalid',
  INVALID_POSITION: 'step position is invalid',
  DUPLICATE_POSITION: 'step positions must be unique',
  INVALID_DELAY: 'step delay is invalid',
  STRING_OUT_OF_RANGE: 'string length is outside the allowed range',
  APPROVAL_REQUIRED: 'manual approval is required before execution',
  APPROVAL_FORBIDDEN: 'actor cannot approve this execution',
  EXTERNAL_EXECUTION_DEFERRED: 'external execution is deferred to a later package',
  OUTBOX_CAS_REQUIRED: 'outbox receipt and compare-and-set are required',
  PROVIDER_RECEIPT_NOT_BUSINESS_SENT: 'provider acceptance is not business sent',
  UNKNOWN_RETRY_FORBIDDEN: 'failed or unknown execution cannot be automatically retried',
  STOP_REASON_MISMATCH: 'stop reason does not permit the requested enrollment state',
  INVALID_FACT_SNAPSHOT: 'verified fact snapshot is invalid',
  AI_PROPOSAL_NOT_AUTHORITATIVE: 'AI proposal cannot change authoritative state',
  IDEMPOTENCY_CONFLICT: 'idempotency key conflicts with the operation intent',
  INVALID_IDEMPOTENCY: 'idempotency key is invalid',
  CLIENT_RECEIPT_FORBIDDEN: 'client supplied receipt metadata is not accepted',
  INVALID_ACTOR_CONTEXT: 'actor context is invalid',
  ACTOR_NOT_AUTHORIZED: 'actor is not authorized for this authoritative transition',
  INVALID_INTENT: 'intent does not match the requested action',
  STOP_REASON_REQUIRED: 'enrollment stop requires a stop reason',
  RECEIPT_KIND_CONFLICT: 'receipt references must have distinct kinds',
});

export type SalesSequenceContractResult<T> =
  | Readonly<{ ok: true; value: T }>
  | Readonly<{ ok: false; error: Readonly<{ code: SequenceContractErrorCode; message: string }> }>;

type Failure = Extract<SalesSequenceContractResult<never>, { ok: false }>;

export type SequenceStepInput = Readonly<{
  stepRef: OpaqueRef;
  position: number;
  channel: Channel;
  delaySeconds: number;
  templateRef: OpaqueRef;
  state?: StepState;
  requiresApproval?: true;
}>;

export type SequenceInput = Readonly<{
  schemaVersion: 1;
  sequenceRef: OpaqueRef;
  tenantRef: OpaqueRef;
  name: string;
  version: number;
  timezone: string;
  state?: SequenceState;
  steps: readonly SequenceStepInput[];
}>;

export type VerifiedFactSnapshotRef = Readonly<{
  factRef: OpaqueRef;
  snapshotRef: OpaqueRef;
  normalizedValueDigest: Digest;
  version: number;
  status: 'CONFIRMED';
  verifiedAt: string;
}>;

export type EnrollmentInput = Readonly<{
  schemaVersion: 1;
  enrollmentRef: OpaqueRef;
  tenantRef: OpaqueRef;
  sequenceRef: OpaqueRef;
  leadRef: OpaqueRef;
  opportunityRef?: OpaqueRef;
  contactRef?: OpaqueRef;
  status?: EnrollmentState;
  version: number;
  currentStepPosition?: number;
  nextActionAt?: string;
  factSnapshot?: VerifiedFactSnapshotRef;
}>;

export type StepExecutionInput = Readonly<{
  schemaVersion: 1;
  executionRef: OpaqueRef;
  tenantRef: OpaqueRef;
  sequenceRef: OpaqueRef;
  enrollmentRef: OpaqueRef;
  stepRef: OpaqueRef;
  stepVersion: number;
  expectedVersion: number;
  idempotencyKey: OpaqueRef;
  intent: 'CREATE_DRAFT' | 'REVIEW_DRAFT' | 'SEND_AFTER_APPROVAL';
}>;

export type SequenceDefinition = Readonly<{
  schemaVersion: 1;
  sequenceRef: OpaqueRef;
  tenantRef: OpaqueRef;
  name: string;
  version: number;
  timezone: string;
  state: SequenceState;
  executionMode: 'DRAFT_ONLY';
  approvalPolicy: 'MANUAL_PER_STEP';
  steps: readonly Readonly<{
    stepRef: OpaqueRef;
    position: number;
    channel: Channel;
    delaySeconds: number;
    templateRef: OpaqueRef;
    state: StepState;
    requiresApproval: true;
  }>[];
}>;

export type EnrollmentDefinition = Readonly<{
  schemaVersion: 1;
  enrollmentRef: OpaqueRef;
  tenantRef: OpaqueRef;
  sequenceRef: OpaqueRef;
  leadRef: OpaqueRef;
  opportunityRef?: OpaqueRef;
  contactRef?: OpaqueRef;
  status: EnrollmentState;
  version: number;
  currentStepPosition?: number;
  nextActionAt?: string;
  factSnapshot?: VerifiedFactSnapshotRef;
  evidencePersonalized: boolean;
}>;

export type OperationIntent = Readonly<{
  schemaVersion: 1;
  tenantRef: OpaqueRef;
  sequenceRef: OpaqueRef;
  enrollmentRef: OpaqueRef;
  stepRef: OpaqueRef;
  stepVersion: number;
  expectedVersion: number;
  intent: string;
  object?: string;
  resourceRef?: OpaqueRef;
  from?: string;
  to?: string;
  stopReason?: string;
  actorKind?: string;
  actorRole?: string;
  actorRef?: OpaqueRef;
  evidence?: StepExecutionEvidence;
}>;

export type ActorKind = 'HUMAN' | 'SYSTEM' | 'AI' | 'AI_WORKER' | 'FUTURE_EXTERNAL_EXECUTOR';
export type ActorRole = 'OWNER' | 'ADMIN' | 'SALES' | 'VIEWER' | 'SYSTEM';
export type EnrollmentStopReason = 'reply' | 'optout' | 'blacklist' | 'permission_revoked' | 'contact_untrusted';
export type LifecycleIntent =
  | 'SEQUENCE_ACTIVATE' | 'SEQUENCE_PAUSE' | 'SEQUENCE_RESUME' | 'SEQUENCE_ARCHIVE'
  | 'STEP_ACTIVATE' | 'STEP_PAUSE' | 'STEP_RESUME' | 'STEP_ARCHIVE'
  | 'ENROLLMENT_ACTIVATE' | 'ENROLLMENT_PAUSE' | 'ENROLLMENT_RESUME'
  | 'ENROLLMENT_COMPLETE' | 'ENROLLMENT_STOP';
export type ActorContext = Readonly<{ actorKind: ActorKind; actorRole: ActorRole; actorRef: OpaqueRef }>;
export type StepExecutionEvidence = Readonly<{
  approvalReceiptRef?: OpaqueRef;
  outboxReceiptRef?: OpaqueRef;
  outboxCas?: 'MATCHED';
  providerReceiptRef?: OpaqueRef;
  businessReceiptRef?: OpaqueRef;
}>;

export type TransitionPlan = Readonly<{
  kind: 'TRANSITION';
  object: 'SEQUENCE' | 'STEP' | 'ENROLLMENT' | 'STEP_EXECUTION';
  from: string;
  to: string;
  expectedVersion: number;
  nextVersion: number;
  resourceRef: OpaqueRef;
  actorKind: ActorKind;
  actorRole: ActorRole;
  actorRef: OpaqueRef;
  intent: string;
  stopReason?: EnrollmentStopReason;
  evidence?: StepExecutionEvidence;
  operationDigest: Digest;
  decision: 'PLAN_ONLY';
  sendCommand: null;
}>;

export type NewStepExecutionPlan = Readonly<{
  kind: 'NEW';
  object: 'STEP_EXECUTION';
  decision: 'PLAN_ONLY';
  state: 'draft_pending';
  executionMode: 'DRAFT_ONLY';
  approvalPolicy: 'MANUAL_PER_STEP';
  requiresApproval: true;
  expectedVersion: number;
  nextVersion: number;
  operationDigest: Digest;
  idempotencyKey: OpaqueRef;
  receiptToPersist: Readonly<{
    receiptRef: OpaqueRef;
    operationDigest: Digest;
    expectedVersion: number;
    nextVersion: number;
  }>;
  sendCommand: null;
}>;

export type IdempotencyResult = Readonly<{
  decision: 'NEW' | 'EXACT_REPLAY' | 'INTENT_CONFLICT';
  operationDigest: Digest;
}>;

const OPAQUE_REF_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/;
const DIGEST_PATTERN = /^sha256:[a-z0-9-]+:[0-9a-f]{64}$/;
const IDENTITY_PATTERN = /(?:[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,})|(?:\+?\d{8,15})|(?:@[a-z0-9._-]*(?:s\.whatsapp\.net|g\.us|lid))/i;
const SECRET_PATTERN = /(?:bearer\s+|sk-[a-z0-9]|api[_-]?key\s*[:=]|password\s*[:=]|authorization\s*[:=])/i;
const UTC_TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/;
const MAX_STEPS = 1000;
const MAX_DELAY_SECONDS = 31_536_000;
const APPROVAL_RECEIPT_PREFIX = 'approval-receipt:';
const OUTBOX_RECEIPT_PREFIX = 'outbox-receipt:';
const PROVIDER_RECEIPT_PREFIX = 'provider-receipt:';
const BUSINESS_RECEIPT_PREFIX = 'business-receipt:';

function failure(code: SequenceContractErrorCode): Failure {
  return deepFreeze({ ok: false, error: { code, message: ERROR_MESSAGES[code] } });
}

function success<T>(value: T): SalesSequenceContractResult<T> {
  return deepFreeze({ ok: true, value });
}

function isFailureResult(value: unknown): value is Failure {
  return isRecord(value) && value.ok === false;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function hasOnlyKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
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
  if (key && /(?:email|phone|telephone|mobile|jid|subject|body|content|recipient|password|token|secret|cookie|authorization|api.?key|provider.?error|raw.?error)/i.test(key)) return true;
  if (typeof value === 'string') return !value.startsWith('sha256:') && (IDENTITY_PATTERN.test(value) || SECRET_PATTERN.test(value));
  if (value === null || typeof value !== 'object') return false;
  if (seen.has(value)) return true;
  seen.add(value);
  if (Array.isArray(value)) return value.some((item) => containsSensitiveInput(item, undefined, seen));
  if (!isRecord(value)) return true;
  return Object.entries(value).some(([entryKey, entryValue]) => containsSensitiveInput(entryValue, entryKey, seen));
}

function deepFreeze<T>(value: T, seen = new Set<object>()): T {
  if (value === null || typeof value !== 'object' || seen.has(value)) return value;
  seen.add(value);
  for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child, seen);
  return Object.freeze(value);
}

function asciiCompare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function validateEnvelope(input: unknown, keys: readonly string[]): Record<string, unknown> | Failure {
  if (!isRecord(input)) return failure('UNSUPPORTED_ENVELOPE');
  if (hasUndefinedDeep(input)) return failure('EXPLICIT_UNDEFINED');
  if (!hasOnlyKeys(input, keys)) return failure('UNKNOWN_FIELD');
  if (containsSensitiveInput(input)) return failure('PII_OR_SECRET_INPUT');
  return input;
}

function validateRef(value: unknown): string | Failure {
  if (typeof value !== 'string' || !OPAQUE_REF_PATTERN.test(value) || /(?:email|phone|jid|token|secret|password|cookie|authorization)/i.test(value)) return failure('INVALID_REF');
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

function validateString(value: unknown, min: number, max: number): string | Failure {
  if (typeof value !== 'string' || value.length < min || value.length > max) return failure('STRING_OUT_OF_RANGE');
  return value;
}

function validateTimestamp(value: unknown): string | Failure {
  if (typeof value !== 'string' || !UTC_TIMESTAMP_PATTERN.test(value)) return failure('INVALID_TIMESTAMP');
  // UTC input permits seconds or 1-3 fractional digits. Output is canonical
  // millisecond precision; comparing against the parsed calendar rejects
  // Date.parse rollover such as 2026-02-31 and non-leap-year 02-29.
  const match = value.match(/^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d{1,3}))?Z$/);
  if (!match) return failure('INVALID_TIMESTAMP');
  const canonicalInput = `${match[1]}.${(match[2] ?? '').padEnd(3, '0')}Z`;
  const millis = Date.parse(canonicalInput);
  if (!Number.isFinite(millis) || new Date(millis).toISOString() !== canonicalInput) return failure('INVALID_TIMESTAMP');
  return canonicalInput;
}

function validateTimezone(value: unknown): string | Failure {
  if (typeof value !== 'string' || value.length < 1 || value.length > 64 || /[+\-]\d{2}:?\d{2}$/.test(value) || value === 'GMT') return failure('INVALID_TIMEZONE');
  try {
    const resolved = new Intl.DateTimeFormat('en-US', { timeZone: value }).resolvedOptions().timeZone;
    if (!resolved || (value !== 'UTC' && resolved !== value)) return failure('INVALID_TIMEZONE');
  } catch {
    return failure('INVALID_TIMEZONE');
  }
  return value;
}

function validateState<T extends string>(value: unknown, states: readonly T[]): T | Failure {
  if (typeof value !== 'string' || !states.includes(value as T)) return failure('INVALID_STATE');
  return value as T;
}

function validatePosition(value: unknown): number | Failure {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1 || value > MAX_STEPS) return failure('INVALID_POSITION');
  return value;
}

function validateDelay(value: unknown): number | Failure {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0 || value > MAX_DELAY_SECONDS) return failure('INVALID_DELAY');
  return value;
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort(asciiCompare).map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(',')}}`;
}

function hash(domain: string, value: unknown): string {
  return `sha256:${domain}:${createHash('sha256').update(`${domain}|${canonicalJson(value)}`, 'utf8').digest('hex')}`;
}

function makeReceiptRef(operationDigest: string): string {
  return `receipt:${operationDigest.slice(-32)}`;
}

function validateKindedReceiptRef(value: unknown, prefix: string): string | Failure {
  if (typeof value !== 'string' || !value.startsWith(prefix)) return failure('INVALID_REF');
  return validateRef(value);
}

export function computeSalesSequenceOperationDigest(input: OperationIntent): Digest {
  return hash('sales-sequence-v1', {
    schemaVersion: 1,
    tenantRef: input.tenantRef,
    sequenceRef: input.sequenceRef,
    enrollmentRef: input.enrollmentRef,
    stepRef: input.stepRef,
    stepVersion: input.stepVersion,
    expectedVersion: input.expectedVersion,
    intent: input.intent,
    ...(input.object === undefined ? {} : { object: input.object }),
    ...(input.resourceRef === undefined ? {} : { resourceRef: input.resourceRef }),
    ...(input.from === undefined ? {} : { from: input.from }),
    ...(input.to === undefined ? {} : { to: input.to }),
    ...(input.stopReason === undefined ? {} : { stopReason: input.stopReason }),
    ...(input.actorKind === undefined ? {} : { actorKind: input.actorKind }),
    ...(input.actorRole === undefined ? {} : { actorRole: input.actorRole }),
    ...(input.actorRef === undefined ? {} : { actorRef: input.actorRef }),
    ...(input.evidence === undefined ? {} : { evidence: input.evidence }),
  });
}

export function computeSalesSequenceLifecycleOperationDigest(input: OperationIntent): Digest {
  return hash('sales-sequence-lifecycle-v1', {
    schemaVersion: 1,
    object: input.object,
    tenantRef: input.tenantRef,
    resourceRef: input.resourceRef,
    sequenceRef: input.sequenceRef,
    enrollmentRef: input.enrollmentRef,
    stepRef: input.stepRef,
    actorKind: input.actorKind,
    actorRole: input.actorRole,
    actorRef: input.actorRef,
    from: input.from,
    to: input.to,
    expectedVersion: input.expectedVersion,
    intent: input.intent,
    ...(input.stopReason === undefined ? {} : { stopReason: input.stopReason }),
    ...(input.evidence === undefined ? {} : { evidence: input.evidence }),
  });
}

export function classifySalesSequenceIdempotency(input: unknown): SalesSequenceContractResult<IdempotencyResult> {
  const envelope = validateEnvelope(input, ['idempotencyKey', 'operationDigest', 'persisted']);
  if (isFailureResult(envelope)) return envelope;
  const idempotencyKey = validateRef(envelope.idempotencyKey);
  const operationDigest = validateDigest(envelope.operationDigest);
  if (isFailureResult(idempotencyKey)) return idempotencyKey;
  if (isFailureResult(operationDigest)) return operationDigest;
  if (envelope.persisted === undefined) return success({ decision: 'NEW', operationDigest });
  const persisted = validateEnvelope(envelope.persisted, ['idempotencyKey', 'operationDigest']);
  if (isFailureResult(persisted)) return persisted;
  const previousKey = validateRef(persisted.idempotencyKey);
  const previousDigest = validateDigest(persisted.operationDigest);
  if (isFailureResult(previousKey)) return previousKey;
  if (isFailureResult(previousDigest)) return previousDigest;
  if (previousKey === idempotencyKey && previousDigest === operationDigest) return success({ decision: 'EXACT_REPLAY', operationDigest });
  if (previousKey === idempotencyKey || previousDigest === operationDigest) return success({ decision: 'INTENT_CONFLICT', operationDigest });
  return success({ decision: 'NEW', operationDigest });
}

function normalizeStep(input: unknown): SequenceDefinition['steps'][number] | Failure {
  const value = validateEnvelope(input, ['stepRef', 'position', 'channel', 'delaySeconds', 'templateRef', 'state', 'requiresApproval']);
  if (isFailureResult(value)) return value;
  const stepRef = validateRef(value.stepRef);
  const position = validatePosition(value.position);
  const delaySeconds = validateDelay(value.delaySeconds);
  const templateRef = validateRef(value.templateRef);
  const state = value.state === undefined ? 'draft' : validateState(value.state, STEP_STATES);
  if (isFailureResult(stepRef)) return stepRef;
  if (isFailureResult(position)) return position;
  if (isFailureResult(delaySeconds)) return delaySeconds;
  if (isFailureResult(templateRef)) return templateRef;
  if (isFailureResult(state)) return state;
  if (value.channel !== 'EMAIL' && value.channel !== 'WHATSAPP') return failure('INVALID_CHANNEL');
  if (value.requiresApproval !== undefined && value.requiresApproval !== true) return failure('APPROVAL_REQUIRED');
  return { stepRef, position, channel: value.channel, delaySeconds, templateRef, state, requiresApproval: true };
}

export function normalizeSequence(input: unknown): SalesSequenceContractResult<SequenceDefinition> {
  const value = validateEnvelope(input, ['schemaVersion', 'sequenceRef', 'tenantRef', 'name', 'version', 'timezone', 'state', 'steps']);
  if (isFailureResult(value)) return value;
  if (value.schemaVersion !== 1) return failure('TYPE_MISMATCH');
  const sequenceRef = validateRef(value.sequenceRef);
  const tenantRef = validateRef(value.tenantRef);
  const name = validateString(value.name, 1, 120);
  const version = validateVersion(value.version);
  const timezone = validateTimezone(value.timezone);
  const state = value.state === undefined ? 'draft' : validateState(value.state, SEQUENCE_STATES);
  if (isFailureResult(sequenceRef)) return sequenceRef;
  if (isFailureResult(tenantRef)) return tenantRef;
  if (isFailureResult(name)) return name;
  if (isFailureResult(version)) return version;
  if (isFailureResult(timezone)) return timezone;
  if (isFailureResult(state)) return state;
  if (!Array.isArray(value.steps) || value.steps.length < 1 || value.steps.length > MAX_STEPS) return failure('TYPE_MISMATCH');
  const steps: SequenceDefinition['steps'][number][] = [];
  const positions = new Set<number>();
  for (const item of value.steps) {
    const step = normalizeStep(item);
    if ('ok' in step) return step;
    if (positions.has(step.position)) return failure('DUPLICATE_POSITION');
    positions.add(step.position);
    steps.push(step);
  }
  steps.sort((left, right) => left.position - right.position || asciiCompare(left.stepRef, right.stepRef));
  return success(deepFreeze({
    schemaVersion: 1, sequenceRef, tenantRef, name, version, timezone, state,
    executionMode: SEQUENCE_EXECUTION_MODE,
    approvalPolicy: SEQUENCE_APPROVAL_POLICY,
    steps,
  }));
}

function normalizeFactSnapshot(input: unknown): VerifiedFactSnapshotRef | Failure {
  const value = validateEnvelope(input, ['factRef', 'snapshotRef', 'normalizedValueDigest', 'version', 'status', 'verifiedAt']);
  if (isFailureResult(value)) return value;
  const factRef = validateRef(value.factRef);
  const snapshotRef = validateRef(value.snapshotRef);
  const digest = validateDigest(value.normalizedValueDigest);
  const version = validateVersion(value.version);
  const verifiedAt = validateTimestamp(value.verifiedAt);
  if (isFailureResult(factRef) || isFailureResult(snapshotRef) || isFailureResult(digest) || isFailureResult(version) || isFailureResult(verifiedAt) || value.status !== 'CONFIRMED') return failure('INVALID_FACT_SNAPSHOT');
  return { factRef, snapshotRef, normalizedValueDigest: digest, version, status: 'CONFIRMED', verifiedAt };
}

export function normalizeEnrollment(input: unknown): SalesSequenceContractResult<EnrollmentDefinition> {
  const value = validateEnvelope(input, ['schemaVersion', 'enrollmentRef', 'tenantRef', 'sequenceRef', 'leadRef', 'opportunityRef', 'contactRef', 'status', 'version', 'currentStepPosition', 'nextActionAt', 'factSnapshot']);
  if (isFailureResult(value)) return value;
  if (value.schemaVersion !== 1) return failure('TYPE_MISMATCH');
  const enrollmentRef = validateRef(value.enrollmentRef);
  const tenantRef = validateRef(value.tenantRef);
  const sequenceRef = validateRef(value.sequenceRef);
  const leadRef = validateRef(value.leadRef);
  const version = validateVersion(value.version);
  const status = value.status === undefined ? 'pending' : validateState(value.status, ENROLLMENT_STATES);
  if (isFailureResult(enrollmentRef) || isFailureResult(tenantRef) || isFailureResult(sequenceRef) || isFailureResult(leadRef) || isFailureResult(version) || isFailureResult(status)) return failure('TYPE_MISMATCH');
  const optionalRefs: Record<string, string> = {};
  for (const key of ['opportunityRef', 'contactRef'] as const) {
    if (value[key] !== undefined) {
      const ref = validateRef(value[key]);
      if (isFailureResult(ref)) return ref;
      optionalRefs[key] = ref;
    }
  }
  let currentStepPosition: number | undefined;
  if (value.currentStepPosition !== undefined) {
    const position = validatePosition(value.currentStepPosition);
    if (isFailureResult(position)) return position;
    currentStepPosition = position;
  }
  let nextActionAt: string | undefined;
  if (value.nextActionAt !== undefined) {
    const timestamp = validateTimestamp(value.nextActionAt);
    if (isFailureResult(timestamp)) return timestamp;
    nextActionAt = timestamp;
  }
  let factSnapshot: VerifiedFactSnapshotRef | undefined;
  if (value.factSnapshot !== undefined) {
    const snapshot = normalizeFactSnapshot(value.factSnapshot);
    if (isFailureResult(snapshot)) return snapshot;
    factSnapshot = snapshot;
  }
  return success(deepFreeze({
    schemaVersion: 1, enrollmentRef, tenantRef, sequenceRef, leadRef, ...optionalRefs,
    status, version, ...(currentStepPosition === undefined ? {} : { currentStepPosition }),
    ...(nextActionAt === undefined ? {} : { nextActionAt }),
    ...(factSnapshot === undefined ? {} : { factSnapshot }),
    evidencePersonalized: factSnapshot !== undefined,
  }));
}

function versionedPlan(object: TransitionPlan['object'], from: string, to: string, expectedVersion: unknown, currentVersion: unknown): Omit<TransitionPlan, 'resourceRef' | 'actorKind' | 'actorRole' | 'actorRef' | 'intent' | 'stopReason' | 'operationDigest'> | Failure {
  const expected = validateVersion(expectedVersion);
  const current = validateVersion(currentVersion);
  if (isFailureResult(expected) || isFailureResult(current)) return failure('INVALID_VERSION');
  if (expected !== current) return failure('VERSION_MISMATCH');
  return { kind: 'TRANSITION', object, from, to, expectedVersion: expected, nextVersion: expected + 1, decision: 'PLAN_ONLY', sendCommand: null };
}

function legalTransition<T extends string>(from: T, to: T, allowed: Readonly<Record<T, readonly T[]>>): boolean {
  return allowed[from]?.includes(to) ?? false;
}

const SEQUENCE_TRANSITIONS: Readonly<Record<SequenceState, readonly SequenceState[]>> = Object.freeze({
  draft: ['active', 'archived'], active: ['paused', 'archived'], paused: ['active', 'archived'], archived: [],
});
const STEP_TRANSITIONS: Readonly<Record<StepState, readonly StepState[]>> = Object.freeze({
  draft: ['active', 'archived'], active: ['paused', 'archived'], paused: ['active', 'archived'], archived: [],
});
const ENROLLMENT_TRANSITIONS: Readonly<Record<EnrollmentState, readonly EnrollmentState[]>> = Object.freeze({
  pending: ['active', 'paused', 'blocked', 'exited'],
  active: ['paused', 'blocked', 'exited', 'completed'],
  paused: ['active', 'blocked', 'exited'],
  blocked: [], exited: [], completed: [],
});

function validateActorContext(value: Record<string, unknown>, allowSystemStop: boolean): ActorContext | Failure {
  const actorRef = validateRef(value.actorRef);
  const actorKinds: readonly ActorKind[] = ['HUMAN', 'SYSTEM', 'AI', 'AI_WORKER', 'FUTURE_EXTERNAL_EXECUTOR'];
  const actorRoles: readonly ActorRole[] = ['OWNER', 'ADMIN', 'SALES', 'VIEWER', 'SYSTEM'];
  if (isFailureResult(actorRef) || !actorKinds.includes(value.actorKind as ActorKind) || !actorRoles.includes(value.actorRole as ActorRole)) return failure('INVALID_ACTOR_CONTEXT');
  const actorKind = value.actorKind as ActorKind;
  const actorRole = value.actorRole as ActorRole;
  if (actorKind === 'AI' || actorKind === 'AI_WORKER' || actorRole === 'VIEWER') return failure('AI_PROPOSAL_NOT_AUTHORITATIVE');
  if (actorKind === 'HUMAN' && (actorRole === 'OWNER' || actorRole === 'ADMIN' || actorRole === 'SALES')) return { actorKind, actorRole, actorRef };
  if (actorKind === 'SYSTEM' && allowSystemStop && actorRole === 'SYSTEM') return { actorKind, actorRole, actorRef };
  return failure('ACTOR_NOT_AUTHORIZED');
}

function expectedLifecycleIntent(object: 'SEQUENCE' | 'STEP' | 'ENROLLMENT', from: string, to: string, stopReason?: EnrollmentStopReason): LifecycleIntent | Failure {
  if (object === 'ENROLLMENT' && (to === 'exited' || to === 'blocked')) {
    if (stopReason === undefined) return failure('STOP_REASON_REQUIRED');
    return 'ENROLLMENT_STOP';
  }
  if (stopReason !== undefined) return failure('STOP_REASON_MISMATCH');
  const prefix = object === 'SEQUENCE' ? 'SEQUENCE' : object === 'STEP' ? 'STEP' : 'ENROLLMENT';
  if (from === 'draft' && to === 'active') return `${prefix}_ACTIVATE` as LifecycleIntent;
  if (from === 'pending' && to === 'active') return 'ENROLLMENT_ACTIVATE';
  if (from === 'active' && to === 'paused') return `${prefix}_PAUSE` as LifecycleIntent;
  if (from === 'paused' && to === 'active') return `${prefix}_RESUME` as LifecycleIntent;
  if ((from === 'draft' || from === 'active' || from === 'paused') && to === 'archived') return `${prefix}_ARCHIVE` as LifecycleIntent;
  if (object === 'ENROLLMENT' && from === 'active' && to === 'completed') return 'ENROLLMENT_COMPLETE';
  return failure('INVALID_INTENT');
}

function lifecyclePlan(
  base: Omit<TransitionPlan, 'resourceRef' | 'actorKind' | 'actorRole' | 'actorRef' | 'intent' | 'stopReason' | 'operationDigest'>,
  input: Record<string, unknown>,
  object: TransitionPlan['object'],
  resourceRef: OpaqueRef,
  actor: ActorContext,
  intent: string,
  stopReason?: EnrollmentStopReason,
  sequenceRef?: OpaqueRef,
  enrollmentRef?: OpaqueRef,
  stepRef?: OpaqueRef,
): TransitionPlan {
  const operationDigest = computeSalesSequenceLifecycleOperationDigest({
    schemaVersion: 1,
    tenantRef: input.tenantRef as string,
    sequenceRef: sequenceRef ?? (object === 'SEQUENCE' ? resourceRef : ''),
    enrollmentRef: enrollmentRef ?? (object === 'ENROLLMENT' ? resourceRef : ''),
    stepRef: stepRef ?? (object === 'STEP' ? resourceRef : ''),
    stepVersion: 1,
    expectedVersion: base.expectedVersion,
    intent,
    object,
    resourceRef,
    from: base.from,
    to: base.to,
    actorKind: actor.actorKind,
    actorRole: actor.actorRole,
    actorRef: actor.actorRef,
    ...(stopReason === undefined ? {} : { stopReason }),
  });
  return {
    ...base,
    resourceRef,
    actorKind: actor.actorKind,
    actorRole: actor.actorRole,
    actorRef: actor.actorRef,
    intent,
    ...(stopReason === undefined ? {} : { stopReason }),
    operationDigest,
  };
}

export function planSequenceTransition(input: unknown): SalesSequenceContractResult<TransitionPlan> {
  const value = validateEnvelope(input, ['tenantRef', 'sequenceRef', 'resourceTenantRef', 'from', 'to', 'expectedVersion', 'currentVersion', 'intent', 'actorKind', 'actorRole', 'actorRef']);
  if (isFailureResult(value)) return value;
  const tenantRef = validateRef(value.tenantRef);
  const sequenceRef = validateRef(value.sequenceRef);
  const resourceTenantRef = validateRef(value.resourceTenantRef);
  if (isFailureResult(tenantRef) || isFailureResult(sequenceRef) || isFailureResult(resourceTenantRef)) return failure('INVALID_REF');
  if (tenantRef !== resourceTenantRef) return failure('INVALID_REF');
  const from = validateState(value.from, SEQUENCE_STATES);
  const to = validateState(value.to, SEQUENCE_STATES);
  if (isFailureResult(from) || isFailureResult(to)) return failure('INVALID_STATE');
  if (!legalTransition(from, to, SEQUENCE_TRANSITIONS)) return failure('ILLEGAL_TRANSITION');
  const intent = expectedLifecycleIntent('SEQUENCE', from, to);
  if (isFailureResult(intent) || value.intent !== intent) return failure('INVALID_INTENT');
  const actor = validateActorContext(value, false);
  if (isFailureResult(actor)) return actor;
  const plan = versionedPlan('SEQUENCE', from, to, value.expectedVersion, value.currentVersion);
  if (isFailureResult(plan)) return plan;
  return success(deepFreeze(lifecyclePlan(plan, value, 'SEQUENCE', sequenceRef, actor, intent, undefined, sequenceRef)));
}

export function planStepTransition(input: unknown): SalesSequenceContractResult<TransitionPlan> {
  const value = validateEnvelope(input, ['tenantRef', 'sequenceRef', 'resourceTenantRef', 'stepRef', 'from', 'to', 'expectedVersion', 'currentVersion', 'intent', 'actorKind', 'actorRole', 'actorRef']);
  if (isFailureResult(value)) return value;
  const tenantRef = validateRef(value.tenantRef);
  const resourceTenantRef = validateRef(value.resourceTenantRef);
  const stepRef = validateRef(value.stepRef);
  const sequenceRef = validateRef(value.sequenceRef);
  if (isFailureResult(tenantRef) || isFailureResult(resourceTenantRef) || isFailureResult(stepRef) || isFailureResult(sequenceRef)) return failure('INVALID_REF');
  if (tenantRef !== resourceTenantRef) return failure('INVALID_REF');
  const from = validateState(value.from, STEP_STATES);
  const to = validateState(value.to, STEP_STATES);
  if (isFailureResult(from) || isFailureResult(to)) return failure('INVALID_STATE');
  if (!legalTransition(from, to, STEP_TRANSITIONS)) return failure('ILLEGAL_TRANSITION');
  const intent = expectedLifecycleIntent('STEP', from, to);
  if (isFailureResult(intent) || value.intent !== intent) return failure('INVALID_INTENT');
  const actor = validateActorContext(value, false);
  if (isFailureResult(actor)) return actor;
  const plan = versionedPlan('STEP', from, to, value.expectedVersion, value.currentVersion);
  if (isFailureResult(plan)) return plan;
  return success(deepFreeze(lifecyclePlan(plan, value, 'STEP', stepRef, actor, intent, undefined, sequenceRef, undefined, stepRef)));
}

export function planEnrollmentTransition(input: unknown): SalesSequenceContractResult<TransitionPlan> {
  const value = validateEnvelope(input, ['tenantRef', 'sequenceRef', 'enrollmentRef', 'resourceTenantRef', 'from', 'to', 'expectedVersion', 'currentVersion', 'intent', 'stopReason', 'actorKind', 'actorRole', 'actorRef']);
  if (isFailureResult(value)) return value;
  const tenantRef = validateRef(value.tenantRef);
  const resourceTenantRef = validateRef(value.resourceTenantRef);
  const sequenceRef = validateRef(value.sequenceRef);
  const enrollmentRef = validateRef(value.enrollmentRef);
  if (isFailureResult(tenantRef) || isFailureResult(resourceTenantRef) || isFailureResult(sequenceRef) || isFailureResult(enrollmentRef)) return failure('INVALID_REF');
  if (tenantRef !== resourceTenantRef) return failure('INVALID_REF');
  const from = validateState(value.from, ENROLLMENT_STATES);
  const to = validateState(value.to, ENROLLMENT_STATES);
  if (isFailureResult(from) || isFailureResult(to)) return failure('INVALID_STATE');
  if (!legalTransition(from, to, ENROLLMENT_TRANSITIONS)) return failure('ILLEGAL_TRANSITION');
  const stopReasons: readonly EnrollmentStopReason[] = ['reply', 'optout', 'blacklist', 'permission_revoked', 'contact_untrusted'];
  if (value.stopReason !== undefined && !stopReasons.includes(value.stopReason as EnrollmentStopReason)) return failure('STOP_REASON_MISMATCH');
  const stopReason = value.stopReason as EnrollmentStopReason | undefined;
  if (stopReason !== undefined) {
    const expectedState = stopReason === 'permission_revoked' || stopReason === 'contact_untrusted' ? 'blocked' : 'exited';
    if (to !== expectedState) return failure('STOP_REASON_MISMATCH');
  }
  const intent = expectedLifecycleIntent('ENROLLMENT', from, to, stopReason);
  if (isFailureResult(intent) || value.intent !== intent) return isFailureResult(intent) ? intent : failure('INVALID_INTENT');
  const isStop = to === 'exited' || to === 'blocked';
  const actor = validateActorContext(value, isStop);
  if (isFailureResult(actor)) return actor;
  const plan = versionedPlan('ENROLLMENT', from, to, value.expectedVersion, value.currentVersion);
  if (isFailureResult(plan)) return plan;
  return success(deepFreeze(lifecyclePlan(plan, value, 'ENROLLMENT', enrollmentRef, actor, intent, stopReason, sequenceRef, enrollmentRef)));
}

function validateExecutionRefs(value: Record<string, unknown>): Failure | Readonly<{ tenantRef: string; sequenceRef: string; enrollmentRef: string; stepRef: string; stepVersion: number; expectedVersion: number; intent: string }> {
  const tenantRef = validateRef(value.tenantRef);
  const sequenceRef = validateRef(value.sequenceRef);
  const enrollmentRef = validateRef(value.enrollmentRef);
  const stepRef = validateRef(value.stepRef);
  const stepVersion = validateVersion(value.stepVersion);
  const expectedVersion = validateVersion(value.expectedVersion);
  if (isFailureResult(tenantRef) || isFailureResult(sequenceRef) || isFailureResult(enrollmentRef) || isFailureResult(stepRef) || isFailureResult(stepVersion) || isFailureResult(expectedVersion)) return failure('TYPE_MISMATCH');
  if (typeof value.intent !== 'string' || !['CREATE_DRAFT', 'REVIEW_DRAFT', 'SEND_AFTER_APPROVAL'].includes(value.intent)) return failure('INVALID_INTENT');
  return { tenantRef, sequenceRef, enrollmentRef, stepRef, stepVersion, expectedVersion, intent: value.intent };
}

function validateExecutionActor(value: Record<string, unknown>, allowFutureExecutor: boolean): ActorContext | Failure {
  const actorRef = validateRef(value.actorRef);
  if (isFailureResult(actorRef)) return failure('INVALID_ACTOR_CONTEXT');
  if (value.actorKind === 'AI' || value.actorKind === 'AI_WORKER' || value.actorRole === 'VIEWER') return failure('AI_PROPOSAL_NOT_AUTHORITATIVE');
  if (value.actorKind === 'HUMAN' && ['OWNER', 'ADMIN', 'SALES'].includes(value.actorRole as string)) return { actorKind: 'HUMAN', actorRole: value.actorRole as ActorRole, actorRef };
  if (allowFutureExecutor && value.actorKind === 'FUTURE_EXTERNAL_EXECUTOR' && value.actorRole === 'SYSTEM') return { actorKind: 'FUTURE_EXTERNAL_EXECUTOR', actorRole: 'SYSTEM', actorRef };
  return failure('APPROVAL_FORBIDDEN');
}

function expectedExecutionIntent(from: StepExecutionState, to: StepExecutionState): 'REVIEW_DRAFT' | 'SEND_AFTER_APPROVAL' | Failure {
  if (from === 'approved' && to === 'sending') return 'SEND_AFTER_APPROVAL';
  if (from === 'sending' && to === 'sent') return 'SEND_AFTER_APPROVAL';
  if (from === 'draft_pending' && to === 'draft_ready') return 'REVIEW_DRAFT';
  if (from === 'draft_ready' && to === 'approval_required') return 'REVIEW_DRAFT';
  if (from === 'approval_required' && to === 'approved') return 'REVIEW_DRAFT';
  if (to === 'cancelled' || to === 'blocked') return 'REVIEW_DRAFT';
  return failure('INVALID_INTENT');
}

export function planNewStepExecution(input: unknown): SalesSequenceContractResult<NewStepExecutionPlan> {
  const value = validateEnvelope(input, ['schemaVersion', 'executionRef', 'tenantRef', 'sequenceRef', 'enrollmentRef', 'stepRef', 'stepVersion', 'expectedVersion', 'idempotencyKey', 'intent']);
  if (isFailureResult(value)) return value;
  if (value.schemaVersion !== 1) return failure('TYPE_MISMATCH');
  const refs = validateExecutionRefs(value);
  if (isFailureResult(refs)) return refs;
  if (refs.intent !== 'CREATE_DRAFT') return failure('INVALID_INTENT');
  const idempotencyKey = validateRef(value.idempotencyKey);
  const executionRef = validateRef(value.executionRef);
  if (isFailureResult(idempotencyKey) || isFailureResult(executionRef)) return failure('INVALID_IDEMPOTENCY');
  const operationDigest = computeSalesSequenceOperationDigest({ schemaVersion: 1, ...refs });
  return success(deepFreeze({
    kind: 'NEW', object: 'STEP_EXECUTION', decision: 'PLAN_ONLY', state: 'draft_pending',
    executionMode: SEQUENCE_EXECUTION_MODE, approvalPolicy: SEQUENCE_APPROVAL_POLICY,
    requiresApproval: true, expectedVersion: refs.expectedVersion, nextVersion: refs.expectedVersion + 1,
    operationDigest, idempotencyKey,
    receiptToPersist: { receiptRef: makeReceiptRef(operationDigest), operationDigest, expectedVersion: refs.expectedVersion, nextVersion: refs.expectedVersion + 1 },
    sendCommand: null,
  }));
}

const EXECUTION_TRANSITIONS: Readonly<Record<StepExecutionState, readonly StepExecutionState[]>> = Object.freeze({
  draft_pending: ['draft_ready', 'cancelled', 'blocked'],
  draft_ready: ['approval_required', 'cancelled', 'blocked'],
  approval_required: ['approved', 'cancelled', 'blocked'],
  approved: ['sending', 'cancelled', 'blocked'],
  sending: ['sent', 'failed', 'unknown'],
  sent: [], failed: [], unknown: [], cancelled: [], blocked: [],
});

export function planStepExecutionTransition(input: unknown): SalesSequenceContractResult<TransitionPlan> {
  const keys = ['executionRef', 'tenantRef', 'sequenceRef', 'enrollmentRef', 'stepRef', 'stepVersion', 'from', 'to', 'expectedVersion', 'currentVersion', 'intent', 'approvalReceiptRef', 'outboxReceiptRef', 'outboxCas', 'providerReceiptRef', 'businessReceiptRef', 'actorKind', 'actorRole', 'actorRef', 'recoveryMode'];
  const value = validateEnvelope(input, keys);
  if (isFailureResult(value)) return value;
  const refs = validateExecutionRefs({ ...value, expectedVersion: value.expectedVersion });
  if (isFailureResult(refs)) return refs;
  const executionRef = validateRef(value.executionRef);
  if (isFailureResult(executionRef)) return executionRef;
  const from = validateState(value.from, STEP_EXECUTION_STATES);
  const to = validateState(value.to, STEP_EXECUTION_STATES);
  if (isFailureResult(from) || isFailureResult(to)) return failure('INVALID_STATE');
  if (from === 'failed' || from === 'unknown') return failure('UNKNOWN_RETRY_FORBIDDEN');
  if (!legalTransition(from, to, EXECUTION_TRANSITIONS)) return failure('ILLEGAL_TRANSITION');
  const intent = expectedExecutionIntent(from, to);
  if (isFailureResult(intent) || value.intent !== intent) return failure('INVALID_INTENT');
  const actor = validateExecutionActor(value, to === 'sending' || to === 'sent');
  if (isFailureResult(actor)) return actor;
  const allowedEvidenceKeys = to === 'approved'
    ? ['approvalReceiptRef']
    : to === 'sending'
      ? ['approvalReceiptRef', 'outboxReceiptRef', 'outboxCas']
      : to === 'sent'
        ? ['providerReceiptRef', 'businessReceiptRef']
        : [];
  const evidenceKeys = ['approvalReceiptRef', 'outboxReceiptRef', 'outboxCas', 'providerReceiptRef', 'businessReceiptRef'];
  if (evidenceKeys.some((key) => value[key] !== undefined && !allowedEvidenceKeys.includes(key))) return failure('CLIENT_RECEIPT_FORBIDDEN');
  let evidence: StepExecutionEvidence | undefined;
  if (to === 'approved') {
    const approvalReceiptRef = validateKindedReceiptRef(value.approvalReceiptRef, APPROVAL_RECEIPT_PREFIX);
    if (isFailureResult(approvalReceiptRef)) return failure('APPROVAL_REQUIRED');
    if (actor.actorKind !== 'HUMAN') return failure('APPROVAL_FORBIDDEN');
    evidence = { approvalReceiptRef };
  }
  if (to === 'sending') {
    if (actor.actorKind !== 'FUTURE_EXTERNAL_EXECUTOR' || value.outboxCas !== 'MATCHED') return failure('OUTBOX_CAS_REQUIRED');
    const approvalReceiptRef = validateKindedReceiptRef(value.approvalReceiptRef, APPROVAL_RECEIPT_PREFIX);
    const outboxReceiptRef = validateKindedReceiptRef(value.outboxReceiptRef, OUTBOX_RECEIPT_PREFIX);
    if (isFailureResult(approvalReceiptRef) || isFailureResult(outboxReceiptRef)) return failure('OUTBOX_CAS_REQUIRED');
    evidence = { approvalReceiptRef, outboxReceiptRef, outboxCas: 'MATCHED' };
  }
  if (to === 'sent') {
    if (actor.actorKind !== 'FUTURE_EXTERNAL_EXECUTOR') return failure('EXTERNAL_EXECUTION_DEFERRED');
    const providerReceiptRef = validateKindedReceiptRef(value.providerReceiptRef, PROVIDER_RECEIPT_PREFIX);
    const businessReceiptRef = validateKindedReceiptRef(value.businessReceiptRef, BUSINESS_RECEIPT_PREFIX);
    if (isFailureResult(providerReceiptRef) || isFailureResult(businessReceiptRef)) return failure('PROVIDER_RECEIPT_NOT_BUSINESS_SENT');
    if (providerReceiptRef.slice(PROVIDER_RECEIPT_PREFIX.length) === businessReceiptRef.slice(BUSINESS_RECEIPT_PREFIX.length)) return failure('RECEIPT_KIND_CONFLICT');
    evidence = { providerReceiptRef, businessReceiptRef };
  }
  const plan = versionedPlan('STEP_EXECUTION', from, to, value.expectedVersion, value.currentVersion);
  if (isFailureResult(plan)) return plan;
  const operationDigest = computeSalesSequenceLifecycleOperationDigest({
    schemaVersion: 1,
    tenantRef: refs.tenantRef,
    sequenceRef: refs.sequenceRef,
    enrollmentRef: refs.enrollmentRef,
    stepRef: refs.stepRef,
    stepVersion: refs.stepVersion,
    expectedVersion: refs.expectedVersion,
    intent,
    object: 'STEP_EXECUTION',
    resourceRef: executionRef,
    from,
    to,
    actorKind: actor.actorKind,
    actorRole: actor.actorRole,
    actorRef: actor.actorRef,
    ...(evidence === undefined ? {} : { evidence }),
  });
  return success(deepFreeze({ ...plan, resourceRef: executionRef, actorKind: actor.actorKind, actorRole: actor.actorRole, actorRef: actor.actorRef, intent, ...(evidence === undefined ? {} : { evidence }), operationDigest }));
}
