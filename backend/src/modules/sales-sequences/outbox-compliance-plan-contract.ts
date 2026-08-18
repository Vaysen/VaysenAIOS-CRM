/**
 * CRM-03D-1: pure compliance, rate-limit and Outbox planning contract.
 *
 * This module accepts only redacted reader projections and safe identities. It
 * never receives message content or a recipient, never persists anything, and
 * never returns a provider, queue, or send command. CRM-03A remains the sole
 * authority for the approved -> sending StepExecution transition.
 */

import { createHash } from 'node:crypto';
import {
  computeDraftApprovalOperationDigest,
  computeManualDraftApprovalDigest,
  
} from './draft-approval-isolation-contract';
import {
  planStepExecutionTransition,
  type ActorRole,
  type Channel,
  type TransitionPlan,
} from './sales-sequence-contract';

export const OUTBOX_COMPLIANCE_SCHEMA_VERSION = 1 as const;
export const OUTBOX_COMPLIANCE_POLICY_VERSION = 1 as const;
export const OUTBOX_COMPLIANCE_EXECUTION_MODE = 'DRAFT_ONLY' as const;
export const OUTBOX_COMPLIANCE_APPROVAL_POLICY = 'MANUAL_PER_STEP' as const;
export const OUTBOX_COMPLIANCE_INTENT = 'SEND_AFTER_APPROVAL' as const;
export const OUTBOX_COMPLIANCE_ACTOR_REF = 'system:outbox-compliance-plan-v1' as const;

export type ComplianceDecision = 'CLEAR' | 'STOP' | 'BLOCK';
export type ComplianceStopReason =
  | 'reply'
  | 'optout'
  | 'blacklist'
  | 'permission_revoked'
  | 'contact_untrusted';
export type WindowState = 'OPEN' | 'CLOSED';
export type QuietHoursState = 'CLEAR' | 'QUIET';
export type RateLimitDecision = 'ALLOW' | 'LIMITED';
export type DedupeDecision = 'NEW' | 'REPLAY' | 'CONFLICT';
export type PlanDecision =
  | 'NEW'
  | 'REPLAY'
  | 'STOP'
  | 'BLOCK'
  | 'RATE_LIMITED'
  | 'QUIET_HOURS'
  | 'WINDOW_CLOSED'
  | 'DEDUPE_CONFLICT';

export type OutboxComplianceErrorCode =
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
  | 'INVALID_STATE'
  | 'SCOPE_MISMATCH'
  | 'CAS_CONFLICT'
  | 'DRAFT_NOT_APPROVED'
  | 'INVALID_DRAFT_IDENTITY'
  | 'INVALID_COMPLIANCE_EVIDENCE'
  | 'STOP_REASON_MISMATCH'
  | 'INVALID_WINDOW_EVIDENCE'
  | 'INVALID_RATE_LIMIT_EVIDENCE'
  | 'INVALID_DEDUPE_EVIDENCE'
  | 'INVALID_OUTBOX_CAS'
  | 'IDEMPOTENCY_CONFLICT'
  | 'INVALID_RECEIPT'
  | 'REPLAY_STATE_MISMATCH'
  | 'OPERATION_DIGEST_MISMATCH'
  | 'AUTHORITY_TRANSITION_REJECTED'
  | 'UNKNOWN_RETRY_FORBIDDEN'
  | 'PROVIDER_OUTCOME_FORBIDDEN'
  | 'CLIENT_CONFIRMATION_FORBIDDEN';

const ERROR_MESSAGES: Readonly<Record<OutboxComplianceErrorCode, string>> = Object.freeze({
  UNSUPPORTED_ENVELOPE: 'outbox compliance envelope is unsupported',
  UNKNOWN_FIELD: 'outbox compliance envelope contains an unknown field',
  EXPLICIT_UNDEFINED: 'outbox compliance envelope contains explicit undefined',
  TYPE_MISMATCH: 'outbox compliance envelope has an invalid type',
  PII_OR_SECRET_INPUT: 'outbox compliance envelope contains disallowed sensitive input',
  INVALID_REF: 'outbox compliance reference is invalid',
  INVALID_DIGEST: 'outbox compliance digest is invalid',
  INVALID_VERSION: 'outbox compliance version is invalid',
  INVALID_POLICY_VERSION: 'outbox compliance schema or policy version is invalid',
  INVALID_CHANNEL: 'outbox compliance channel is invalid',
  INVALID_TIMESTAMP: 'outbox compliance timestamp is invalid',
  FUTURE_EVIDENCE: 'outbox compliance evidence is future-dated or stale',
  INVALID_STATE: 'outbox compliance reader state is invalid',
  SCOPE_MISMATCH: 'outbox compliance scope does not match the reader projection',
  CAS_CONFLICT: 'outbox compliance compare-and-set does not match the reader version',
  DRAFT_NOT_APPROVED: 'the exact manually approved draft is required',
  INVALID_DRAFT_IDENTITY: 'the draft approval identity is invalid',
  INVALID_COMPLIANCE_EVIDENCE: 'compliance evidence is invalid',
  STOP_REASON_MISMATCH: 'compliance stop reason is not mapped to the decision',
  INVALID_WINDOW_EVIDENCE: 'sending-window evidence is invalid',
  INVALID_RATE_LIMIT_EVIDENCE: 'rate-limit evidence is invalid',
  INVALID_DEDUPE_EVIDENCE: 'dedupe evidence is invalid',
  INVALID_OUTBOX_CAS: 'outbox compare-and-set evidence is invalid',
  IDEMPOTENCY_CONFLICT: 'outbox compliance idempotency conflicts with the operation',
  INVALID_RECEIPT: 'outbox compliance receipt is invalid',
  REPLAY_STATE_MISMATCH: 'reader projection is not the persisted Outbox post-state',
  OPERATION_DIGEST_MISMATCH: 'outbox compliance operation digest does not match the intent',
  AUTHORITY_TRANSITION_REJECTED: 'CRM-03A rejected the approved-to-sending transition',
  UNKNOWN_RETRY_FORBIDDEN: 'UNKNOWN or failed provider outcomes cannot be retried here',
  PROVIDER_OUTCOME_FORBIDDEN: 'provider outcome and provider payloads are outside this contract',
  CLIENT_CONFIRMATION_FORBIDDEN: 'client confirmation metadata is not accepted',
});

export type OutboxComplianceResult<T> =
  | Readonly<{ ok: true; value: T }>
  | Readonly<{ ok: false; error: Readonly<{ code: OutboxComplianceErrorCode; message: string }> }>;

type Failure = Extract<OutboxComplianceResult<never>, { ok: false }>;
type RecordValue = Record<string, unknown>;

export type ApprovedDraftIdentityProjection = Readonly<{
  channel: Channel;
  proposalVersion: number;
  proposalDigest: string;
  renderedArtifactRef: string;
  templateSnapshotDigest: string;
  variableSnapshotDigest: string;
  contentDigest: string;
  approvalReceiptRef: string;
  approvalDigest: string;
  approvalActorRole: Extract<ActorRole, 'OWNER' | 'ADMIN' | 'SALES'>;
  approvalActorRef: string;
  approvedAt: string;
  commandReceiptRef: string;
  commandOperationDigest: string;
  commandIdempotencyKey: string;
  commandPreState: 'approval_required';
  commandPreVersion: number;
  commandPostState: 'approved';
  commandPostVersion: number;
  authorityPlanDigest: string;
}>;

export type ComplianceEvaluationProjection = Readonly<{
  kind: 'COMPLIANCE_EVALUATION';
  policyVersion: 1;
  tenantRef: string;
  enrollmentRef: string;
  decision: ComplianceDecision;
  stopReason?: ComplianceStopReason;
  sourceKind: 'SYSTEM_COMPLIANCE_READER';
  sourceReceiptRef: string;
  evaluatedAt: string;
  evidenceDigest: string;
}>;

export type SendingWindowEvaluationProjection = Readonly<{
  kind: 'SENDING_WINDOW_EVALUATION';
  policyVersion: 1;
  tenantRef: string;
  channel: Channel;
  timezone: string;
  windowState: WindowState;
  quietHoursState: QuietHoursState;
  windowRef: string;
  quietHoursRef: string;
  windowEndsAt: string;
  sourceKind: 'SYSTEM_WINDOW_READER';
  sourceReceiptRef: string;
  evaluatedAt: string;
  evidenceDigest: string;
}>;

export type RateLimitEvaluationProjection = Readonly<{
  kind: 'RATE_LIMIT_EVALUATION';
  policyVersion: 1;
  tenantRef: string;
  channel: Channel;
  bucketRef: string;
  decision: RateLimitDecision;
  limit: number;
  used: number;
  remaining: number;
  windowStartAt: string;
  windowEndsAt: string;
  sourceKind: 'SYSTEM_RATE_LIMIT_READER';
  sourceReceiptRef: string;
  evaluatedAt: string;
  evidenceDigest: string;
}>;

export type DedupeEvaluationProjection = Readonly<{
  kind: 'OUTBOX_DEDUPE_EVALUATION';
  policyVersion: 1;
  tenantRef: string;
  channel: Channel;
  idempotencyKey: string;
  decision: DedupeDecision;
  existingReceiptRef?: string;
  sourceKind: 'SYSTEM_DEDUPE_READER';
  sourceReceiptRef: string;
  evaluatedAt: string;
  evidenceDigest: string;
}>;

export type OutboxCasEvaluationProjection = Readonly<{
  kind: 'OUTBOX_CAS_EVALUATION';
  policyVersion: 1;
  tenantRef: string;
  expectedVersion: number;
  currentVersion: number;
  decision: 'MATCHED';
  sourceKind: 'SYSTEM_OUTBOX_READER';
  sourceReceiptRef: string;
  evaluatedAt: string;
  evidenceDigest: string;
}>;

export type OutboxComplianceReaderSnapshot = Readonly<{
  tenantRef: string;
  sequenceRef: string;
  enrollmentRef: string;
  executionRef: string;
  stepRef: string;
  stepVersion: number;
  state: 'approved' | 'sending';
  version: number;
}>;

export type OutboxComplianceInput = Readonly<{
  schemaVersion: 1;
  policyVersion: 1;
  intent: 'SEND_AFTER_APPROVAL';
  tenantRef: string;
  sequenceRef: string;
  enrollmentRef: string;
  executionRef: string;
  stepRef: string;
  stepVersion: number;
  channel: Channel;
  expectedVersion: number;
  idempotencyKey: string;
  decisionNow: string;
  readerSnapshot: OutboxComplianceReaderSnapshot;
  draftIdentity: ApprovedDraftIdentityProjection;
  compliance: ComplianceEvaluationProjection;
  window?: SendingWindowEvaluationProjection;
  rateLimit?: RateLimitEvaluationProjection;
  dedupe?: DedupeEvaluationProjection;
  outboxCas?: OutboxCasEvaluationProjection;
  persistedReceipt?: OutboxComplianceReceiptProjection;
}>;

export type OutboxComplianceEvidence = Readonly<{
  compliance: ComplianceEvaluationProjection;
  window: SendingWindowEvaluationProjection;
  rateLimit: RateLimitEvaluationProjection;
  dedupe: DedupeEvaluationProjection;
  outboxCas: OutboxCasEvaluationProjection;
}>;

export type OutboxReservationPlan = Readonly<{
  kind: 'OUTBOX_RESERVATION_PLAN';
  reservationRef: string;
  outboxReceiptRef: string;
  idempotencyKey: string;
  channel: Channel;
  preState: 'approved';
  preVersion: number;
  postState: 'sending';
  postVersion: number;
  authorityPlanDigest: string;
  operationDigest: string;
  evidenceDigest: string;
}>;

export type OutboxComplianceReceiptProjection = Readonly<{
  kind: 'OUTBOX_COMPLIANCE_PLAN_RECEIPT';
  schemaVersion: 1;
  policyVersion: 1;
  receiptRef: string;
  operationDigest: string;
  idempotencyKey: string;
  intent: 'SEND_AFTER_APPROVAL';
  tenantRef: string;
  sequenceRef: string;
  enrollmentRef: string;
  executionRef: string;
  stepRef: string;
  stepVersion: number;
  channel: Channel;
  decisionNow: string;
  preState: 'approved';
  preVersion: number;
  postState: 'sending';
  postVersion: number;
  authorityPlanDigest: string;
  outboxReceiptRef: string;
  reservationRef: string;
  draftIdentity: ApprovedDraftIdentityProjection;
  evidence: OutboxComplianceEvidence;
}>;

export type OutboxCompliancePlan = Readonly<{
  decision: PlanDecision;
  executionMode: 'DRAFT_ONLY';
  approvalPolicy: 'MANUAL_PER_STEP';
  intent: 'SEND_AFTER_APPROVAL';
  operationDigest: string | null;
  transitionPlan: TransitionPlan | null;
  reservationPlan: OutboxReservationPlan | null;
  receiptToPersist: OutboxComplianceReceiptProjection | null;
  evidence: Readonly<Partial<OutboxComplianceEvidence>>;
  sendCommand: null;
  providerCommand: null;
  queueCommand: null;
}>;

const OPAQUE_REF_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/;
const DIGEST_PATTERN = /^sha256:[a-z0-9-]+:[0-9a-f]{64}$/;
const UTC_TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/;
const IDENTITY_PATTERN = /(?:[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,})|(?:\+?\d{8,15})|(?:@[a-z0-9._-]*(?:s\.whatsapp\.net|g\.us|lid))/i;
const SECRET_PATTERN = /(?:bearer\s+|sk-[a-z0-9]|api[_-]?key\s*[:=]|password\s*[:=]|authorization\s*[:=])/i;
const SENSITIVE_KEY_PATTERN = /(?:email|phone|telephone|mobile|jid|recipient|subject|body|content|prompt|output|payload|provider|error|url|confidence|confirmed|pass|raw|token|secret|password|cookie|authorization|api.?key)/i;
const APPROVAL_RECEIPT_PREFIX = 'approval-receipt:';
const COMMAND_RECEIPT_PREFIX = 'draft-approval-receipt:';
const OUTBOX_RECEIPT_PREFIX = 'outbox-receipt:';
const OUTBOX_PLAN_RECEIPT_PREFIX = 'outbox-plan-receipt:';
const OUTBOX_RESERVATION_PREFIX = 'outbox-reservation:';
const COMPLIANCE_RECEIPT_PREFIX = 'compliance-receipt:';
const WINDOW_RECEIPT_PREFIX = 'window-receipt:';
const RATE_RECEIPT_PREFIX = 'rate-receipt:';
const DEDUPE_RECEIPT_PREFIX = 'dedupe-receipt:';
const CAS_RECEIPT_PREFIX = 'cas-receipt:';
const DRAFT_COMMAND_PREFIX = 'draft-command:';

function deepFreeze<T>(value: T, seen = new Set<object>()): T {
  if (value === null || typeof value !== 'object' || seen.has(value)) return value;
  seen.add(value);
  for (const child of Object.values(value as RecordValue)) deepFreeze(child, seen);
  return Object.freeze(value);
}

function failure(code: OutboxComplianceErrorCode): Failure {
  return deepFreeze({ ok: false, error: { code, message: ERROR_MESSAGES[code] } });
}

function success<T>(value: T): OutboxComplianceResult<T> {
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

function containsSensitiveInput(value: unknown, key?: string, seen = new Set<object>()): boolean {
  const safeField = key !== undefined && /(?:Ref|Digest|Key|At|Version)$/.test(key);
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
  if (typeof value !== 'string' || !OPAQUE_REF_PATTERN.test(value) || value.includes('://') || IDENTITY_PATTERN.test(value)) return failure('INVALID_REF');
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
  return Number.isFinite(millis) && new Date(millis).toISOString() === canonical
    ? canonical : failure('INVALID_TIMESTAMP');
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
  const suffix = digest.slice(-32).replace(/[0-9]/g, (digit) => String.fromCharCode('g'.charCodeAt(0) + Number(digit)));
  return `${prefix}${suffix}`;
}

function validateChannel(value: unknown): Channel | Failure {
  return value === 'EMAIL' || value === 'WHATSAPP' ? value : failure('INVALID_CHANNEL');
}

function validateKindedRef(value: unknown, prefix: string): string | Failure {
  return validateRef(value, prefix);
}

function validateDecisionNow(value: unknown): string | Failure {
  return validateTimestamp(value);
}

function verifyFresh(value: string, decisionNow: string): boolean {
  // REV1 deliberately uses an exact reader snapshot boundary: stale evidence
  // cannot be made current merely by being earlier than decisionNow.
  return value === decisionNow;
}

function validateIanaTimezone(value: unknown): string | Failure {
  if (typeof value !== 'string' || value.length < 1 || value.length > 64 || value === 'GMT' || /[+\-]\d{2}:?\d{2}$/.test(value)) return failure('INVALID_WINDOW_EVIDENCE');
  try {
    const resolved = new Intl.DateTimeFormat('en-US', { timeZone: value }).resolvedOptions().timeZone;
    if (!resolved || (value !== 'UTC' && resolved !== value)) return failure('INVALID_WINDOW_EVIDENCE');
  } catch {
    return failure('INVALID_WINDOW_EVIDENCE');
  }
  return value;
}

function complianceIntent(value: Omit<ComplianceEvaluationProjection, 'evidenceDigest'>): RecordValue {
  return value;
}

export function computeComplianceEvidenceDigest(input: Omit<ComplianceEvaluationProjection, 'evidenceDigest'>): string {
  return hash('sales-sequence-compliance-evidence-v1', complianceIntent(input));
}

export function computeSendingWindowEvidenceDigest(input: Omit<SendingWindowEvaluationProjection, 'evidenceDigest'>): string {
  return hash('sales-sequence-window-evidence-v1', input);
}

export function computeRateLimitEvidenceDigest(input: Omit<RateLimitEvaluationProjection, 'evidenceDigest'>): string {
  return hash('sales-sequence-rate-evidence-v1', input);
}

export function computeDedupeEvidenceDigest(input: Omit<DedupeEvaluationProjection, 'evidenceDigest'>): string {
  return hash('sales-sequence-dedupe-evidence-v1', input);
}

export function computeOutboxCasEvidenceDigest(input: Omit<OutboxCasEvaluationProjection, 'evidenceDigest'>): string {
  return hash('sales-sequence-outbox-cas-v1', input);
}

export type OutboxComplianceOperationIntent = Readonly<{
  schemaVersion: 1;
  policyVersion: 1;
  intent: 'SEND_AFTER_APPROVAL';
  tenantRef: string;
  sequenceRef: string;
  enrollmentRef: string;
  executionRef: string;
  stepRef: string;
  stepVersion: number;
  channel: Channel;
  idempotencyKey: string;
  decisionNow: string;
  preState: 'approved';
  preVersion: number;
  postState: 'sending';
  postVersion: number;
  outboxReceiptRef: string;
  reservationRef: string;
  authorityPlanDigest: string;
  draftIdentity: ApprovedDraftIdentityProjection;
  evidence: OutboxComplianceEvidence;
}>;

export function computeOutboxComplianceOperationDigest(input: OutboxComplianceOperationIntent): string {
  return hash('sales-sequence-outbox-compliance-operation-v1', input);
}

function validateDraftIdentity(input: unknown, outer: RecordValue): ApprovedDraftIdentityProjection | Failure {
  const value = validateEnvelope(input, [
    'channel', 'proposalVersion', 'proposalDigest', 'renderedArtifactRef', 'templateSnapshotDigest',
    'variableSnapshotDigest', 'contentDigest', 'approvalReceiptRef', 'approvalDigest', 'approvalActorRole',
    'approvalActorRef', 'approvedAt', 'commandReceiptRef', 'commandOperationDigest', 'commandIdempotencyKey',
    'commandPreState', 'commandPreVersion', 'commandPostState', 'commandPostVersion', 'authorityPlanDigest',
  ]);
  if (isFailure(value)) return failure('INVALID_DRAFT_IDENTITY');
  const channel = validateChannel(value.channel);
  const proposalVersion = validateVersion(value.proposalVersion);
  const proposalDigest = validateDigest(value.proposalDigest);
  const renderedArtifactRef = validateRef(value.renderedArtifactRef, 'draft-artifact:');
  const templateSnapshotDigest = validateDigest(value.templateSnapshotDigest);
  const variableSnapshotDigest = validateDigest(value.variableSnapshotDigest);
  const contentDigest = validateDigest(value.contentDigest);
  const approvalReceiptRef = validateKindedRef(value.approvalReceiptRef, APPROVAL_RECEIPT_PREFIX);
  const approvalDigest = validateDigest(value.approvalDigest);
  const approvalActorRef = validateRef(value.approvalActorRef);
  const approvedAt = validateTimestamp(value.approvedAt);
  const commandReceiptRef = validateKindedRef(value.commandReceiptRef, COMMAND_RECEIPT_PREFIX);
  const commandOperationDigest = validateDigest(value.commandOperationDigest);
  const commandIdempotencyKey = validateRef(value.commandIdempotencyKey, DRAFT_COMMAND_PREFIX);
  const commandPreVersion = validateVersion(value.commandPreVersion);
  const commandPostVersion = validateVersion(value.commandPostVersion);
  const authorityPlanDigest = validateDigest(value.authorityPlanDigest);
  if (isFailure(channel) || isFailure(proposalVersion) || isFailure(proposalDigest) || isFailure(renderedArtifactRef) || isFailure(templateSnapshotDigest) || isFailure(variableSnapshotDigest) || isFailure(contentDigest) || isFailure(approvalReceiptRef) || isFailure(approvalDigest) || isFailure(approvalActorRef) || isFailure(approvedAt) || isFailure(commandReceiptRef) || isFailure(commandOperationDigest) || isFailure(commandIdempotencyKey) || isFailure(commandPreVersion) || isFailure(commandPostVersion) || isFailure(authorityPlanDigest)) return failure('INVALID_DRAFT_IDENTITY');
  if (value.commandPreState !== 'approval_required' || value.commandPostState !== 'approved' || commandPostVersion !== commandPreVersion + 1) return failure('INVALID_DRAFT_IDENTITY');
  if (outer.channel !== channel) return failure('INVALID_DRAFT_IDENTITY');
  const actorRole = value.approvalActorRole;
  if (actorRole !== 'OWNER' && actorRole !== 'ADMIN' && actorRole !== 'SALES') return failure('INVALID_DRAFT_IDENTITY');
  const approvalExpected = computeManualDraftApprovalDigest({
    schemaVersion: 1,
    policyVersion: 1,
    tenantRef: outer.tenantRef as string,
    sequenceRef: outer.sequenceRef as string,
    enrollmentRef: outer.enrollmentRef as string,
    executionRef: outer.executionRef as string,
    stepRef: outer.stepRef as string,
    stepVersion: outer.stepVersion as number,
    proposalVersion,
    proposalDigest,
    renderedArtifactRef,
    templateSnapshotDigest,
    variableSnapshotDigest,
    contentDigest,
    actorKind: 'HUMAN',
    actorRole,
    actorRef: approvalActorRef,
    approvedAt,
  });
  if (approvalExpected !== approvalDigest || derivedRef(APPROVAL_RECEIPT_PREFIX, approvalDigest) !== approvalReceiptRef) return failure('INVALID_DRAFT_IDENTITY');
  const approvalPlan = planStepExecutionTransition({
    executionRef: outer.executionRef,
    tenantRef: outer.tenantRef,
    sequenceRef: outer.sequenceRef,
    enrollmentRef: outer.enrollmentRef,
    stepRef: outer.stepRef,
    stepVersion: outer.stepVersion,
    from: 'approval_required',
    to: 'approved',
    expectedVersion: commandPreVersion,
    currentVersion: commandPreVersion,
    intent: 'REVIEW_DRAFT',
    approvalReceiptRef,
    actorKind: 'HUMAN',
    actorRole,
    actorRef: approvalActorRef,
  });
  if (!approvalPlan.ok || approvalPlan.value.operationDigest !== authorityPlanDigest) return failure('INVALID_DRAFT_IDENTITY');
  const commandExpected = computeDraftApprovalOperationDigest({
    schemaVersion: 1,
    policyVersion: 1,
    command: 'APPROVE_DRAFT',
    intent: 'REVIEW_DRAFT',
    idempotencyKey: commandIdempotencyKey,
    tenantRef: outer.tenantRef as string,
    sequenceRef: outer.sequenceRef as string,
    enrollmentRef: outer.enrollmentRef as string,
    executionRef: outer.executionRef as string,
    stepRef: outer.stepRef as string,
    stepVersion: outer.stepVersion as number,
    proposalVersion,
    proposalDigest,
    renderedArtifactRef,
    templateSnapshotDigest,
    variableSnapshotDigest,
    contentDigest,
    actorKind: 'HUMAN',
    actorRole,
    actorRef: approvalActorRef,
    preState: 'approval_required',
    preVersion: commandPreVersion,
    postState: 'approved',
    postVersion: commandPostVersion,
    authorityPlanDigest,
    approvalDigest,
  });
  if (commandExpected !== commandOperationDigest || derivedRef(COMMAND_RECEIPT_PREFIX, commandOperationDigest) !== commandReceiptRef) return failure('INVALID_DRAFT_IDENTITY');
  return {
    channel,
    proposalVersion,
    proposalDigest,
    renderedArtifactRef,
    templateSnapshotDigest,
    variableSnapshotDigest,
    contentDigest,
    approvalReceiptRef,
    approvalDigest,
    approvalActorRole: actorRole,
    approvalActorRef,
    approvedAt,
    commandReceiptRef,
    commandOperationDigest,
    commandIdempotencyKey,
    commandPreState: 'approval_required',
    commandPreVersion,
    commandPostState: 'approved',
    commandPostVersion,
    authorityPlanDigest,
  };
}

function validateScope(value: RecordValue, snapshot: OutboxComplianceReaderSnapshot): Failure | null {
  const keys = ['tenantRef', 'sequenceRef', 'enrollmentRef', 'executionRef', 'stepRef', 'stepVersion'] as const;
  for (const key of keys) if (value[key] !== snapshot[key]) return failure('SCOPE_MISMATCH');
  return null;
}

function validateReaderSnapshot(input: unknown): OutboxComplianceReaderSnapshot | Failure {
  const value = validateEnvelope(input, ['tenantRef', 'sequenceRef', 'enrollmentRef', 'executionRef', 'stepRef', 'stepVersion', 'state', 'version']);
  if (isFailure(value)) return value;
  const refs = ['tenantRef', 'sequenceRef', 'enrollmentRef', 'executionRef', 'stepRef'].map((key) => validateRef(value[key]));
  const stepVersion = validateVersion(value.stepVersion);
  const version = validateVersion(value.version);
  if (refs.some(isFailure) || isFailure(stepVersion) || isFailure(version)) return failure('TYPE_MISMATCH');
  if (value.state !== 'approved' && value.state !== 'sending') return failure('INVALID_STATE');
  return {
    tenantRef: refs[0] as string,
    sequenceRef: refs[1] as string,
    enrollmentRef: refs[2] as string,
    executionRef: refs[3] as string,
    stepRef: refs[4] as string,
    stepVersion: stepVersion as number,
    state: value.state,
    version: version as number,
  };
}

function validateCompliance(input: unknown, tenantRef: string, enrollmentRef: string, decisionNow: string): ComplianceEvaluationProjection | Failure {
  const value = validateEnvelope(input, ['kind', 'policyVersion', 'tenantRef', 'enrollmentRef', 'decision', 'stopReason', 'sourceKind', 'sourceReceiptRef', 'evaluatedAt', 'evidenceDigest']);
  if (isFailure(value)) return value;
  const tenant = validateRef(value.tenantRef);
  const enrollment = validateRef(value.enrollmentRef);
  const sourceReceiptRef = validateKindedRef(value.sourceReceiptRef, COMPLIANCE_RECEIPT_PREFIX);
  const evaluatedAt = validateTimestamp(value.evaluatedAt);
  const evidenceDigest = validateDigest(value.evidenceDigest);
  if (value.policyVersion !== 1 || isFailure(tenant) || isFailure(enrollment) || isFailure(sourceReceiptRef) || isFailure(evaluatedAt) || isFailure(evidenceDigest)) return failure('INVALID_COMPLIANCE_EVIDENCE');
  if (tenant !== tenantRef || enrollment !== enrollmentRef || value.sourceKind !== 'SYSTEM_COMPLIANCE_READER') return failure('INVALID_COMPLIANCE_EVIDENCE');
  if (!verifyFresh(evaluatedAt, decisionNow)) return failure('FUTURE_EVIDENCE');
  if (value.decision !== 'CLEAR' && value.decision !== 'STOP' && value.decision !== 'BLOCK') return failure('INVALID_COMPLIANCE_EVIDENCE');
  const stopReason = value.stopReason as ComplianceStopReason | undefined;
  if (value.decision === 'CLEAR' && stopReason !== undefined) return failure('STOP_REASON_MISMATCH');
  if (value.decision === 'STOP' && !['reply', 'optout', 'blacklist'].includes(stopReason || '')) return failure('STOP_REASON_MISMATCH');
  if (value.decision === 'BLOCK' && !['permission_revoked', 'contact_untrusted'].includes(stopReason || '')) return failure('STOP_REASON_MISMATCH');
  const normalized = {
    kind: 'COMPLIANCE_EVALUATION' as const,
    policyVersion: 1 as const,
    tenantRef: tenant,
    enrollmentRef: enrollment,
    decision: value.decision as ComplianceDecision,
    ...(stopReason === undefined ? {} : { stopReason }),
    sourceKind: 'SYSTEM_COMPLIANCE_READER' as const,
    sourceReceiptRef,
    evaluatedAt,
  };
  if (computeComplianceEvidenceDigest(normalized) !== evidenceDigest) return failure('INVALID_COMPLIANCE_EVIDENCE');
  return { ...normalized, evidenceDigest };
}

function validateWindow(input: unknown, tenantRef: string, channel: Channel, decisionNow: string): SendingWindowEvaluationProjection | Failure {
  const value = validateEnvelope(input, ['kind', 'policyVersion', 'tenantRef', 'channel', 'timezone', 'windowState', 'quietHoursState', 'windowRef', 'quietHoursRef', 'windowEndsAt', 'sourceKind', 'sourceReceiptRef', 'evaluatedAt', 'evidenceDigest']);
  if (isFailure(value)) return value;
  const tenant = validateRef(value.tenantRef);
  const actualChannel = validateChannel(value.channel);
  const timezone = validateIanaTimezone(value.timezone);
  const windowRef = validateRef(value.windowRef);
  const quietHoursRef = validateRef(value.quietHoursRef);
  const windowEndsAt = validateTimestamp(value.windowEndsAt);
  const sourceReceiptRef = validateKindedRef(value.sourceReceiptRef, WINDOW_RECEIPT_PREFIX);
  const evaluatedAt = validateTimestamp(value.evaluatedAt);
  const evidenceDigest = validateDigest(value.evidenceDigest);
  if (value.policyVersion !== 1 || isFailure(tenant) || isFailure(actualChannel) || isFailure(timezone) || isFailure(windowRef) || isFailure(quietHoursRef) || isFailure(windowEndsAt) || isFailure(sourceReceiptRef) || isFailure(evaluatedAt) || isFailure(evidenceDigest)) return failure('INVALID_WINDOW_EVIDENCE');
  if (tenant !== tenantRef || actualChannel !== channel || value.sourceKind !== 'SYSTEM_WINDOW_READER') return failure('INVALID_WINDOW_EVIDENCE');
  if (value.windowState !== 'OPEN' && value.windowState !== 'CLOSED') return failure('INVALID_WINDOW_EVIDENCE');
  if (value.quietHoursState !== 'CLEAR' && value.quietHoursState !== 'QUIET') return failure('INVALID_WINDOW_EVIDENCE');
  if (!verifyFresh(evaluatedAt, decisionNow) || Date.parse(windowEndsAt) <= Date.parse(decisionNow)) return failure('FUTURE_EVIDENCE');
  const normalized = {
    kind: 'SENDING_WINDOW_EVALUATION' as const,
    policyVersion: 1 as const,
    tenantRef: tenant,
    channel: actualChannel,
    timezone,
    windowState: value.windowState as WindowState,
    quietHoursState: value.quietHoursState as QuietHoursState,
    windowRef,
    quietHoursRef,
    windowEndsAt,
    sourceKind: 'SYSTEM_WINDOW_READER' as const,
    sourceReceiptRef,
    evaluatedAt,
  };
  if (computeSendingWindowEvidenceDigest(normalized) !== evidenceDigest) return failure('INVALID_WINDOW_EVIDENCE');
  return { ...normalized, evidenceDigest };
}

function validateRateLimit(input: unknown, tenantRef: string, channel: Channel, decisionNow: string): RateLimitEvaluationProjection | Failure {
  const value = validateEnvelope(input, ['kind', 'policyVersion', 'tenantRef', 'channel', 'bucketRef', 'decision', 'limit', 'used', 'remaining', 'windowStartAt', 'windowEndsAt', 'sourceKind', 'sourceReceiptRef', 'evaluatedAt', 'evidenceDigest']);
  if (isFailure(value)) return value;
  const tenant = validateRef(value.tenantRef);
  const actualChannel = validateChannel(value.channel);
  const bucketRef = validateRef(value.bucketRef);
  const limit = value.limit;
  const used = value.used;
  const remaining = value.remaining;
  const windowStartAt = validateTimestamp(value.windowStartAt);
  const windowEndsAt = validateTimestamp(value.windowEndsAt);
  const sourceReceiptRef = validateKindedRef(value.sourceReceiptRef, RATE_RECEIPT_PREFIX);
  const evaluatedAt = validateTimestamp(value.evaluatedAt);
  const evidenceDigest = validateDigest(value.evidenceDigest);
  if (value.policyVersion !== 1 || isFailure(tenant) || isFailure(actualChannel) || isFailure(bucketRef) || isFailure(windowStartAt) || isFailure(windowEndsAt) || isFailure(sourceReceiptRef) || isFailure(evaluatedAt) || isFailure(evidenceDigest)) return failure('INVALID_RATE_LIMIT_EVIDENCE');
  if (tenant !== tenantRef || actualChannel !== channel || value.sourceKind !== 'SYSTEM_RATE_LIMIT_READER') return failure('INVALID_RATE_LIMIT_EVIDENCE');
  if (value.decision !== 'ALLOW' && value.decision !== 'LIMITED') return failure('INVALID_RATE_LIMIT_EVIDENCE');
  if (![limit, used, remaining].every((item) => typeof item === 'number' && Number.isSafeInteger(item) && item >= 0) || (limit as number) < 1 || (used as number) + (remaining as number) !== (limit as number)) return failure('INVALID_RATE_LIMIT_EVIDENCE');
  if (!verifyFresh(evaluatedAt, decisionNow) || Date.parse(windowStartAt) > Date.parse(decisionNow) || Date.parse(windowEndsAt) <= Date.parse(decisionNow)) return failure('FUTURE_EVIDENCE');
  if ((value.decision === 'ALLOW' && (remaining as number) < 1) || (value.decision === 'LIMITED' && (remaining as number) !== 0)) return failure('INVALID_RATE_LIMIT_EVIDENCE');
  const normalized = {
    kind: 'RATE_LIMIT_EVALUATION' as const,
    policyVersion: 1 as const,
    tenantRef: tenant,
    channel: actualChannel,
    bucketRef,
    decision: value.decision as RateLimitDecision,
    limit: limit as number,
    used: used as number,
    remaining: remaining as number,
    windowStartAt,
    windowEndsAt,
    sourceKind: 'SYSTEM_RATE_LIMIT_READER' as const,
    sourceReceiptRef,
    evaluatedAt,
  };
  if (computeRateLimitEvidenceDigest(normalized) !== evidenceDigest) return failure('INVALID_RATE_LIMIT_EVIDENCE');
  return { ...normalized, evidenceDigest };
}

function validateDedupe(input: unknown, tenantRef: string, channel: Channel, idempotencyKey: string, decisionNow: string): DedupeEvaluationProjection | Failure {
  const value = validateEnvelope(input, ['kind', 'policyVersion', 'tenantRef', 'channel', 'idempotencyKey', 'decision', 'existingReceiptRef', 'sourceKind', 'sourceReceiptRef', 'evaluatedAt', 'evidenceDigest']);
  if (isFailure(value)) return value;
  const tenant = validateRef(value.tenantRef);
  const actualChannel = validateChannel(value.channel);
  const key = validateRef(value.idempotencyKey);
  const existingReceiptRef = value.existingReceiptRef === undefined ? undefined : validateKindedRef(value.existingReceiptRef, OUTBOX_PLAN_RECEIPT_PREFIX);
  const sourceReceiptRef = validateKindedRef(value.sourceReceiptRef, DEDUPE_RECEIPT_PREFIX);
  const evaluatedAt = validateTimestamp(value.evaluatedAt);
  const evidenceDigest = validateDigest(value.evidenceDigest);
  if (value.policyVersion !== 1 || isFailure(tenant) || isFailure(actualChannel) || isFailure(key) || isFailure(existingReceiptRef) || isFailure(sourceReceiptRef) || isFailure(evaluatedAt) || isFailure(evidenceDigest)) return failure('INVALID_DEDUPE_EVIDENCE');
  if (tenant !== tenantRef || actualChannel !== channel || key !== idempotencyKey || value.sourceKind !== 'SYSTEM_DEDUPE_READER') return failure('INVALID_DEDUPE_EVIDENCE');
  if (!['NEW', 'REPLAY', 'CONFLICT'].includes(value.decision as string)) return failure('INVALID_DEDUPE_EVIDENCE');
  if (value.decision === 'REPLAY' && existingReceiptRef === undefined) return failure('INVALID_DEDUPE_EVIDENCE');
  if (value.decision !== 'REPLAY' && existingReceiptRef !== undefined) return failure('INVALID_DEDUPE_EVIDENCE');
  if (!verifyFresh(evaluatedAt, decisionNow)) return failure('FUTURE_EVIDENCE');
  const normalized = {
    kind: 'OUTBOX_DEDUPE_EVALUATION' as const,
    policyVersion: 1 as const,
    tenantRef: tenant,
    channel: actualChannel,
    idempotencyKey: key,
    decision: value.decision as DedupeDecision,
    ...(existingReceiptRef === undefined ? {} : { existingReceiptRef }),
    sourceKind: 'SYSTEM_DEDUPE_READER' as const,
    sourceReceiptRef,
    evaluatedAt,
  };
  if (computeDedupeEvidenceDigest(normalized) !== evidenceDigest) return failure('INVALID_DEDUPE_EVIDENCE');
  return { ...normalized, evidenceDigest };
}

function validateCas(input: unknown, tenantRef: string, expectedVersion: number, decisionNow: string): OutboxCasEvaluationProjection | Failure {
  const value = validateEnvelope(input, ['kind', 'policyVersion', 'tenantRef', 'expectedVersion', 'currentVersion', 'decision', 'sourceKind', 'sourceReceiptRef', 'evaluatedAt', 'evidenceDigest']);
  if (isFailure(value)) return value;
  const tenant = validateRef(value.tenantRef);
  const actualExpected = validateVersion(value.expectedVersion);
  const current = validateVersion(value.currentVersion);
  const sourceReceiptRef = validateKindedRef(value.sourceReceiptRef, CAS_RECEIPT_PREFIX);
  const evaluatedAt = validateTimestamp(value.evaluatedAt);
  const evidenceDigest = validateDigest(value.evidenceDigest);
  if (value.policyVersion !== 1 || isFailure(tenant) || isFailure(actualExpected) || isFailure(current) || isFailure(sourceReceiptRef) || isFailure(evaluatedAt) || isFailure(evidenceDigest)) return failure('INVALID_OUTBOX_CAS');
  if (tenant !== tenantRef || actualExpected !== expectedVersion || actualExpected !== current || value.decision !== 'MATCHED' || value.sourceKind !== 'SYSTEM_OUTBOX_READER') return failure('INVALID_OUTBOX_CAS');
  if (!verifyFresh(evaluatedAt, decisionNow)) return failure('FUTURE_EVIDENCE');
  const normalized = {
    kind: 'OUTBOX_CAS_EVALUATION' as const,
    policyVersion: 1 as const,
    tenantRef: tenant,
    expectedVersion: actualExpected,
    currentVersion: current,
    decision: 'MATCHED' as const,
    sourceKind: 'SYSTEM_OUTBOX_READER' as const,
    sourceReceiptRef,
    evaluatedAt,
  };
  if (computeOutboxCasEvidenceDigest(normalized) !== evidenceDigest) return failure('INVALID_OUTBOX_CAS');
  return { ...normalized, evidenceDigest };
}

function evidenceDigest(evidence: OutboxComplianceEvidence): string {
  return hash('sales-sequence-outbox-compliance-evidence-v1', {
    compliance: evidence.compliance.evidenceDigest,
    window: evidence.window.evidenceDigest,
    rateLimit: evidence.rateLimit.evidenceDigest,
    dedupe: evidence.dedupe.evidenceDigest,
    outboxCas: evidence.outboxCas.evidenceDigest,
  });
}

function makeOperationInput(input: RecordValue, draftIdentity: ApprovedDraftIdentityProjection, evidence: OutboxComplianceEvidence, authorityPlanDigest: string, outboxReceiptRef: string, reservationRef: string): OutboxComplianceOperationIntent {
  return {
    schemaVersion: 1,
    policyVersion: 1,
    intent: 'SEND_AFTER_APPROVAL',
    tenantRef: input.tenantRef as string,
    sequenceRef: input.sequenceRef as string,
    enrollmentRef: input.enrollmentRef as string,
    executionRef: input.executionRef as string,
    stepRef: input.stepRef as string,
    stepVersion: input.stepVersion as number,
    channel: input.channel as Channel,
    idempotencyKey: input.idempotencyKey as string,
    decisionNow: input.decisionNow as string,
    preState: 'approved',
    preVersion: input.expectedVersion as number,
    postState: 'sending',
    postVersion: (input.expectedVersion as number) + 1,
    outboxReceiptRef,
    reservationRef,
    authorityPlanDigest,
    draftIdentity,
    evidence,
  };
}

function validatePersistedReceipt(input: unknown, envelope: RecordValue, snapshot: OutboxComplianceReaderSnapshot, draftIdentity: ApprovedDraftIdentityProjection): OutboxComplianceReceiptProjection | Failure {
  const value = validateEnvelope(input, [
    'kind', 'schemaVersion', 'policyVersion', 'receiptRef', 'operationDigest', 'idempotencyKey', 'intent', 'tenantRef', 'sequenceRef', 'enrollmentRef', 'executionRef', 'stepRef', 'stepVersion', 'channel', 'decisionNow', 'preState', 'preVersion', 'postState', 'postVersion', 'authorityPlanDigest', 'outboxReceiptRef', 'reservationRef', 'draftIdentity', 'evidence',
  ]);
  if (isFailure(value)) return failure('INVALID_RECEIPT');
  const receiptRef = validateKindedRef(value.receiptRef, OUTBOX_PLAN_RECEIPT_PREFIX);
  const operationDigest = validateDigest(value.operationDigest);
  const idempotencyKey = validateRef(value.idempotencyKey);
  const tenant = validateRef(value.tenantRef);
  const sequence = validateRef(value.sequenceRef);
  const enrollment = validateRef(value.enrollmentRef);
  const execution = validateRef(value.executionRef);
  const step = validateRef(value.stepRef);
  const stepVersion = validateVersion(value.stepVersion);
  const channel = validateChannel(value.channel);
  const decisionNow = validateTimestamp(value.decisionNow);
  const preVersion = validateVersion(value.preVersion);
  const postVersion = validateVersion(value.postVersion);
  const authorityPlanDigest = validateDigest(value.authorityPlanDigest);
  const outboxReceiptRef = validateKindedRef(value.outboxReceiptRef, OUTBOX_RECEIPT_PREFIX);
  const reservationRef = validateKindedRef(value.reservationRef, OUTBOX_RESERVATION_PREFIX);
  if (value.kind !== 'OUTBOX_COMPLIANCE_PLAN_RECEIPT' || value.schemaVersion !== 1 || value.policyVersion !== 1 || value.intent !== 'SEND_AFTER_APPROVAL' || value.preState !== 'approved' || value.postState !== 'sending' || isFailure(receiptRef) || isFailure(operationDigest) || isFailure(idempotencyKey) || isFailure(tenant) || isFailure(sequence) || isFailure(enrollment) || isFailure(execution) || isFailure(step) || isFailure(stepVersion) || isFailure(channel) || isFailure(decisionNow) || isFailure(preVersion) || isFailure(postVersion) || isFailure(authorityPlanDigest) || isFailure(outboxReceiptRef) || isFailure(reservationRef)) return failure('INVALID_RECEIPT');
  const outer = { ...envelope, tenantRef: tenant, sequenceRef: sequence, enrollmentRef: enrollment, executionRef: execution, stepRef: step, stepVersion };
  if (preVersion !== envelope.expectedVersion || idempotencyKey !== envelope.idempotencyKey || decisionNow !== envelope.decisionNow || tenant !== envelope.tenantRef || sequence !== envelope.sequenceRef || enrollment !== envelope.enrollmentRef || execution !== envelope.executionRef || step !== envelope.stepRef || stepVersion !== envelope.stepVersion || channel !== envelope.channel) return failure('IDEMPOTENCY_CONFLICT');
  if (preVersion + 1 !== postVersion || snapshot.state !== 'sending' || snapshot.version !== postVersion) return failure(snapshot.state === 'sending' && snapshot.version !== postVersion ? 'REPLAY_STATE_MISMATCH' : 'INVALID_RECEIPT');
  const receiptDraft = validateDraftIdentity(value.draftIdentity, outer);
  if (isFailure(receiptDraft)) return failure('INVALID_RECEIPT');
  const evidenceValue = validateEnvelope(value.evidence, ['compliance', 'window', 'rateLimit', 'dedupe', 'outboxCas']);
  if (isFailure(evidenceValue)) return failure('INVALID_RECEIPT');
  const compliance = validateCompliance(evidenceValue.compliance, tenant, enrollment, decisionNow);
  const window = validateWindow(evidenceValue.window, tenant, channel, decisionNow);
  const rateLimit = validateRateLimit(evidenceValue.rateLimit, tenant, channel, decisionNow);
  const dedupe = validateDedupe(evidenceValue.dedupe, tenant, channel, idempotencyKey, decisionNow);
  const outboxCas = validateCas(evidenceValue.outboxCas, tenant, preVersion, decisionNow);
  if (isFailure(compliance) || isFailure(window) || isFailure(rateLimit) || isFailure(dedupe) || isFailure(outboxCas)) return failure('INVALID_RECEIPT');
  if (compliance.decision !== 'CLEAR' || window.windowState !== 'OPEN' || window.quietHoursState !== 'CLEAR' || rateLimit.decision !== 'ALLOW' || dedupe.decision !== 'NEW' || outboxCas.decision !== 'MATCHED') return failure('INVALID_RECEIPT');
  const evidence = { compliance, window, rateLimit, dedupe, outboxCas } as OutboxComplianceEvidence;
  if (canonicalJson(receiptDraft) !== canonicalJson(draftIdentity)) return failure('INVALID_RECEIPT');
  const evidenceHash = evidenceDigest(evidence);
  const reservationSeed = hash('sales-sequence-outbox-reservation-seed-v1', {
    tenantRef: tenant, sequenceRef: sequence, enrollmentRef: enrollment, executionRef: execution, stepRef: step, stepVersion,
    channel, idempotencyKey, expectedVersion: preVersion, draftIdentity, evidenceHash,
  });
  const expectedOutboxReceiptRef = derivedRef(OUTBOX_RECEIPT_PREFIX, reservationSeed);
  const expectedReservationRef = derivedRef(OUTBOX_RESERVATION_PREFIX, reservationSeed);
  const transition = planStepExecutionTransition({
    executionRef: execution, tenantRef: tenant, sequenceRef: sequence, enrollmentRef: enrollment, stepRef: step, stepVersion,
    from: 'approved', to: 'sending', expectedVersion: preVersion, currentVersion: preVersion, intent: 'SEND_AFTER_APPROVAL',
    approvalReceiptRef: receiptDraft.approvalReceiptRef, outboxReceiptRef: expectedOutboxReceiptRef, outboxCas: 'MATCHED',
    actorKind: 'FUTURE_EXTERNAL_EXECUTOR', actorRole: 'SYSTEM', actorRef: OUTBOX_COMPLIANCE_ACTOR_REF,
  });
  if (!transition.ok) return failure('INVALID_RECEIPT');
  const expectedAuthorityPlanDigest = transition.value.operationDigest;
  const operationIntent = makeOperationInput(envelope, receiptDraft, evidence, expectedAuthorityPlanDigest, expectedOutboxReceiptRef, expectedReservationRef);
  const expectedOperationDigest = computeOutboxComplianceOperationDigest(operationIntent);
  if (authorityPlanDigest !== expectedAuthorityPlanDigest || outboxReceiptRef !== expectedOutboxReceiptRef || reservationRef !== expectedReservationRef || operationDigest !== expectedOperationDigest) return failure('INVALID_RECEIPT');
  if (derivedRef(OUTBOX_PLAN_RECEIPT_PREFIX, operationDigest) !== receiptRef) return failure('INVALID_RECEIPT');
  return {
    kind: 'OUTBOX_COMPLIANCE_PLAN_RECEIPT', schemaVersion: 1, policyVersion: 1,
    receiptRef, operationDigest, idempotencyKey, intent: 'SEND_AFTER_APPROVAL',
    tenantRef: tenant, sequenceRef: sequence, enrollmentRef: enrollment, executionRef: execution,
    stepRef: step, stepVersion, channel, decisionNow, preState: 'approved', preVersion,
    postState: 'sending', postVersion, authorityPlanDigest, outboxReceiptRef, reservationRef,
    draftIdentity: receiptDraft, evidence,
  };
}

function emptyPlan(decision: Exclude<PlanDecision, 'NEW' | 'REPLAY'>, evidence: Readonly<Partial<OutboxComplianceEvidence>>): OutboxCompliancePlan {
  return {
    decision,
    executionMode: OUTBOX_COMPLIANCE_EXECUTION_MODE,
    approvalPolicy: OUTBOX_COMPLIANCE_APPROVAL_POLICY,
    intent: OUTBOX_COMPLIANCE_INTENT,
    operationDigest: null,
    transitionPlan: null,
    reservationPlan: null,
    receiptToPersist: null,
    evidence,
    sendCommand: null,
    providerCommand: null,
    queueCommand: null,
  };
}

export function planOutboxCompliance(input: unknown): OutboxComplianceResult<OutboxCompliancePlan> {
  const value = validateEnvelope(input, [
    'schemaVersion', 'policyVersion', 'intent', 'tenantRef', 'sequenceRef', 'enrollmentRef', 'executionRef', 'stepRef',
    'stepVersion', 'channel', 'expectedVersion', 'idempotencyKey', 'decisionNow', 'readerSnapshot', 'draftIdentity',
    'compliance', 'window', 'rateLimit', 'dedupe', 'outboxCas', 'persistedReceipt',
  ]);
  if (isFailure(value)) return value;
  if (value.schemaVersion !== 1 || value.policyVersion !== 1) return failure('INVALID_POLICY_VERSION');
  if (value.intent !== OUTBOX_COMPLIANCE_INTENT) return failure('TYPE_MISMATCH');
  const refs = ['tenantRef', 'sequenceRef', 'enrollmentRef', 'executionRef', 'stepRef'].map((key) => validateRef(value[key]));
  const stepVersion = validateVersion(value.stepVersion);
  const expectedVersion = validateVersion(value.expectedVersion);
  const channel = validateChannel(value.channel);
  const idempotencyKey = validateRef(value.idempotencyKey);
  const decisionNow = validateDecisionNow(value.decisionNow);
  if (refs.some(isFailure)) return failure('INVALID_REF');
  if (isFailure(stepVersion) || isFailure(expectedVersion)) return failure('INVALID_VERSION');
  if (isFailure(channel)) return channel;
  if (isFailure(idempotencyKey)) return failure('INVALID_REF');
  if (isFailure(decisionNow)) return decisionNow;
  if (value.idempotencyKey === '') return failure('INVALID_REF');
  const snapshot = validateReaderSnapshot(value.readerSnapshot);
  if (isFailure(snapshot)) return snapshot;
  const scopeFailure = validateScope(value, snapshot);
  if (scopeFailure) return scopeFailure;
  if (snapshot.stepVersion !== stepVersion || snapshot.state !== 'approved' && snapshot.state !== 'sending') return failure('INVALID_STATE');
  if (snapshot.state === 'approved' && snapshot.version !== expectedVersion) return failure('CAS_CONFLICT');
  const outer = { ...value, tenantRef: refs[0], sequenceRef: refs[1], enrollmentRef: refs[2], executionRef: refs[3], stepRef: refs[4], stepVersion, channel, expectedVersion, idempotencyKey, decisionNow };
  const draftIdentity = validateDraftIdentity(value.draftIdentity, outer);
  if (isFailure(draftIdentity)) return draftIdentity;
  if (draftIdentity.channel !== channel) return failure('INVALID_DRAFT_IDENTITY');
  const compliance = validateCompliance(value.compliance, refs[0] as string, refs[2] as string, decisionNow as string);
  if (isFailure(compliance)) return compliance;
  if (compliance.decision === 'STOP') return success(deepFreeze(emptyPlan('STOP', { compliance })));
  if (compliance.decision === 'BLOCK') return success(deepFreeze(emptyPlan('BLOCK', { compliance })));
  const hasPersistedReceipt = Object.prototype.hasOwnProperty.call(value, 'persistedReceipt');
  if (hasPersistedReceipt) {
    if (snapshot.state !== 'sending') return failure('REPLAY_STATE_MISMATCH');
    if (['window', 'rateLimit', 'outboxCas'].some((key) => Object.prototype.hasOwnProperty.call(value, key))) return failure('INVALID_RECEIPT');
    const dedupe = validateDedupe(value.dedupe, refs[0] as string, channel as Channel, idempotencyKey as string, decisionNow as string);
    if (isFailure(dedupe)) return dedupe;
    if (dedupe.decision !== 'REPLAY') return failure('IDEMPOTENCY_CONFLICT');
    const receipt = validatePersistedReceipt(value.persistedReceipt, value, snapshot, draftIdentity);
    if (isFailure(receipt)) return receipt;
    if (dedupe.existingReceiptRef !== receipt.receiptRef) return failure('IDEMPOTENCY_CONFLICT');
    return success(deepFreeze({
      decision: 'REPLAY', executionMode: OUTBOX_COMPLIANCE_EXECUTION_MODE, approvalPolicy: OUTBOX_COMPLIANCE_APPROVAL_POLICY,
      intent: OUTBOX_COMPLIANCE_INTENT, operationDigest: receipt.operationDigest, transitionPlan: null, reservationPlan: null, receiptToPersist: null,
      evidence: { compliance, dedupe }, sendCommand: null, providerCommand: null, queueCommand: null,
    }));
  }
  if (snapshot.state !== 'approved' || snapshot.version !== expectedVersion) return failure('REPLAY_STATE_MISMATCH');
  const window = validateWindow(value.window, refs[0] as string, channel as Channel, decisionNow as string);
  const rateLimit = validateRateLimit(value.rateLimit, refs[0] as string, channel as Channel, decisionNow as string);
  const dedupe = validateDedupe(value.dedupe, refs[0] as string, channel as Channel, idempotencyKey as string, decisionNow as string);
  const outboxCas = validateCas(value.outboxCas, refs[0] as string, expectedVersion as number, decisionNow as string);
  if (isFailure(window) || isFailure(rateLimit) || isFailure(dedupe) || isFailure(outboxCas)) {
    const code = isFailure(window) ? window.error.code : isFailure(rateLimit) ? rateLimit.error.code : isFailure(dedupe) ? dedupe.error.code : isFailure(outboxCas) ? outboxCas.error.code : 'TYPE_MISMATCH';
    return failure(code);
  }
  const evidence = { compliance, window, rateLimit, dedupe, outboxCas } as OutboxComplianceEvidence;
  if (window.windowState === 'CLOSED') return success(deepFreeze(emptyPlan('WINDOW_CLOSED', { compliance, window, rateLimit, dedupe, outboxCas })));
  if (window.quietHoursState === 'QUIET') return success(deepFreeze(emptyPlan('QUIET_HOURS', { compliance, window, rateLimit, dedupe, outboxCas })));
  if (rateLimit.decision === 'LIMITED') return success(deepFreeze(emptyPlan('RATE_LIMITED', { compliance, window, rateLimit, dedupe, outboxCas })));
  if (dedupe.decision === 'CONFLICT') return success(deepFreeze(emptyPlan('DEDUPE_CONFLICT', { compliance, window, rateLimit, dedupe, outboxCas })));
  if (dedupe.decision !== 'NEW') return failure('INVALID_DEDUPE_EVIDENCE');
  const evidenceHash = evidenceDigest(evidence);
  const reservationSeed = hash('sales-sequence-outbox-reservation-seed-v1', {
    tenantRef: refs[0], sequenceRef: refs[1], enrollmentRef: refs[2], executionRef: refs[3], stepRef: refs[4], stepVersion,
    channel, idempotencyKey, expectedVersion, draftIdentity, evidenceHash,
  });
  const outboxReceiptRef = derivedRef(OUTBOX_RECEIPT_PREFIX, reservationSeed);
  const reservationRef = derivedRef(OUTBOX_RESERVATION_PREFIX, reservationSeed);
  const transition = planStepExecutionTransition({
    executionRef: refs[3], tenantRef: refs[0], sequenceRef: refs[1], enrollmentRef: refs[2], stepRef: refs[4], stepVersion,
    from: 'approved', to: 'sending', expectedVersion, currentVersion: expectedVersion, intent: 'SEND_AFTER_APPROVAL',
    approvalReceiptRef: draftIdentity.approvalReceiptRef, outboxReceiptRef, outboxCas: 'MATCHED',
    actorKind: 'FUTURE_EXTERNAL_EXECUTOR', actorRole: 'SYSTEM', actorRef: OUTBOX_COMPLIANCE_ACTOR_REF,
  });
  if (!transition.ok) return failure(transition.error.code === 'VERSION_MISMATCH' ? 'CAS_CONFLICT' : 'AUTHORITY_TRANSITION_REJECTED');
  const authorityPlanDigest = transition.value.operationDigest;
  const operationIntent = makeOperationInput(value, draftIdentity, evidence, authorityPlanDigest, outboxReceiptRef, reservationRef);
  const operationDigest = computeOutboxComplianceOperationDigest(operationIntent);
  const reservationPlan: OutboxReservationPlan = {
    kind: 'OUTBOX_RESERVATION_PLAN', reservationRef, outboxReceiptRef, idempotencyKey, channel,
    preState: 'approved', preVersion: expectedVersion, postState: 'sending', postVersion: expectedVersion + 1,
    authorityPlanDigest, operationDigest, evidenceDigest: evidenceHash,
  };
  const receiptToPersist: OutboxComplianceReceiptProjection = {
    kind: 'OUTBOX_COMPLIANCE_PLAN_RECEIPT', schemaVersion: 1, policyVersion: 1,
    receiptRef: derivedRef(OUTBOX_PLAN_RECEIPT_PREFIX, operationDigest), operationDigest, idempotencyKey,
    intent: OUTBOX_COMPLIANCE_INTENT, tenantRef: refs[0] as string, sequenceRef: refs[1] as string, enrollmentRef: refs[2] as string,
    executionRef: refs[3] as string, stepRef: refs[4] as string, stepVersion: stepVersion as number, channel: channel as Channel,
    decisionNow: decisionNow as string, preState: 'approved', preVersion: expectedVersion as number, postState: 'sending', postVersion: (expectedVersion as number) + 1,
    authorityPlanDigest, outboxReceiptRef, reservationRef, draftIdentity, evidence,
  };
  return success(deepFreeze({
    decision: 'NEW', executionMode: OUTBOX_COMPLIANCE_EXECUTION_MODE, approvalPolicy: OUTBOX_COMPLIANCE_APPROVAL_POLICY,
    intent: OUTBOX_COMPLIANCE_INTENT, operationDigest, transitionPlan: transition.value, reservationPlan, receiptToPersist,
    evidence, sendCommand: null, providerCommand: null, queueCommand: null,
  }));
}
