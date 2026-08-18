/**
 * CRM-03C-1: draft artifact proposal and manual approval isolation contract.
 *
 * This is a pure metadata/workflow boundary. It accepts digests and opaque
 * references only, reuses CRM-03A for authoritative StepExecution planning,
 * and never returns a send, queue, provider, or outbox command.
 */

import { createHash } from 'node:crypto';
import {
  planStepExecutionTransition,
  type ActorRole,
  type Channel,
  type StepExecutionState,
  type TransitionPlan,
} from './sales-sequence-contract';

export const DRAFT_APPROVAL_SCHEMA_VERSION = 1 as const;
export const DRAFT_APPROVAL_POLICY_VERSION = 1 as const;
export const DRAFT_APPROVAL_EXECUTION_MODE = 'DRAFT_ONLY' as const;
export const DRAFT_APPROVAL_POLICY = 'MANUAL_PER_STEP' as const;

export type DraftRendererKind = 'SYSTEM_RENDERER' | 'AI_WORKER';
export type DraftApprovalCommand = 'ACCEPT_PROPOSAL' | 'REQUEST_APPROVAL' | 'APPROVE_DRAFT';
export type DraftApprovalIntent = 'REVIEW_DRAFT';
export type DraftApprovalActorKind = 'HUMAN' | 'AI' | 'AI_WORKER' | 'SYSTEM_RENDERER' | 'VIEWER';
export type DraftApprovalActorRole = Extract<ActorRole, 'OWNER' | 'ADMIN' | 'SALES' | 'VIEWER'>;
export type DraftPreState = 'draft_pending' | 'draft_ready' | 'approval_required';
export type DraftPostState = 'draft_ready' | 'approval_required' | 'approved';

export type DraftApprovalIsolationErrorCode =
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
  | 'INVALID_RENDERER'
  | 'INVALID_TIMESTAMP'
  | 'INVALID_STATE'
  | 'INVALID_COMMAND'
  | 'INVALID_INTENT'
  | 'INVALID_ACTOR'
  | 'ACTOR_NOT_AUTHORIZED'
  | 'SCOPE_MISMATCH'
  | 'CAS_CONFLICT'
  | 'PROPOSAL_STALE'
  | 'PROPOSAL_IDENTITY_MISMATCH'
  | 'INVALID_APPROVAL'
  | 'INVALID_RECEIPT'
  | 'REPLAY_STATE_MISMATCH'
  | 'OPERATION_DIGEST_MISMATCH'
  | 'AUTHORITY_TRANSITION_REJECTED'
  | 'SEND_FORBIDDEN';

const ERROR_MESSAGES: Readonly<Record<DraftApprovalIsolationErrorCode, string>> = Object.freeze({
  UNSUPPORTED_ENVELOPE: 'draft approval envelope is unsupported',
  UNKNOWN_FIELD: 'draft approval envelope contains an unknown field',
  EXPLICIT_UNDEFINED: 'draft approval envelope contains explicit undefined',
  TYPE_MISMATCH: 'draft approval envelope has an invalid type',
  PII_OR_SECRET_INPUT: 'draft approval envelope contains disallowed sensitive input',
  INVALID_REF: 'draft approval reference is invalid',
  INVALID_DIGEST: 'draft approval digest is invalid',
  INVALID_VERSION: 'draft approval version is invalid',
  INVALID_POLICY_VERSION: 'draft approval schema or policy version is invalid',
  INVALID_CHANNEL: 'draft approval channel is invalid',
  INVALID_RENDERER: 'draft renderer is invalid',
  INVALID_TIMESTAMP: 'draft approval timestamp is invalid',
  INVALID_STATE: 'draft approval state is invalid',
  INVALID_COMMAND: 'draft approval command is invalid',
  INVALID_INTENT: 'draft approval intent is invalid',
  INVALID_ACTOR: 'draft approval actor context is invalid',
  ACTOR_NOT_AUTHORIZED: 'actor is not authorized for this draft approval action',
  SCOPE_MISMATCH: 'draft approval scope does not match the reader snapshot',
  CAS_CONFLICT: 'draft approval expected version does not match the reader snapshot',
  PROPOSAL_STALE: 'draft artifact proposal is stale for this action',
  PROPOSAL_IDENTITY_MISMATCH: 'draft artifact identity does not match the receipt',
  INVALID_APPROVAL: 'manual approval receipt is invalid',
  INVALID_RECEIPT: 'draft approval receipt is invalid',
  REPLAY_STATE_MISMATCH: 'reader snapshot is not the persisted post-state',
  OPERATION_DIGEST_MISMATCH: 'draft approval operation digest does not match the intent',
  AUTHORITY_TRANSITION_REJECTED: 'CRM-03A rejected the authoritative draft transition',
  SEND_FORBIDDEN: 'draft approval contract cannot plan external execution',
});

export type DraftApprovalIsolationResult<T> =
  | Readonly<{ ok: true; value: T }>
  | Readonly<{ ok: false; error: Readonly<{ code: DraftApprovalIsolationErrorCode; message: string }> }>;

type Failure = Extract<DraftApprovalIsolationResult<never>, { ok: false }>;
type RecordValue = Record<string, unknown>;

export type DraftArtifactProposalInput = Readonly<{
  schemaVersion: 1;
  policyVersion: 1;
  tenantRef: string;
  sequenceRef: string;
  enrollmentRef: string;
  executionRef: string;
  stepRef: string;
  stepVersion: number;
  templateSnapshotDigest: string;
  variableSnapshotDigest: string;
  renderedArtifactRef: string;
  contentDigest: string;
  channel: Channel;
  proposalVersion: number;
  rendererKind: DraftRendererKind;
  rendererRef: string;
  createdAt: string;
}>;

export type DraftArtifactProposal = Readonly<DraftArtifactProposalInput & {
  proposalDigest: string;
}>;

export type DraftArtifactProposalPlan = Readonly<{
  decision: 'PROPOSAL_ONLY';
  executionMode: 'DRAFT_ONLY';
  approvalPolicy: 'MANUAL_PER_STEP';
  proposal: DraftArtifactProposal;
  proposalDigest: string;
  sendCommand: null;
}>;

export type DraftApprovalReaderSnapshot = Readonly<{
  tenantRef: string;
  sequenceRef: string;
  enrollmentRef: string;
  executionRef: string;
  stepRef: string;
  stepVersion: number;
  state: StepExecutionState;
  version: number;
}>;

export type ManualApprovalReceipt = Readonly<{
  kind: 'MANUAL_DRAFT_APPROVAL';
  schemaVersion: 1;
  policyVersion: 1;
  receiptRef: string;
  approvalDigest: string;
  tenantRef: string;
  sequenceRef: string;
  enrollmentRef: string;
  executionRef: string;
  stepRef: string;
  stepVersion: number;
  proposalVersion: number;
  proposalDigest: string;
  renderedArtifactRef: string;
  templateSnapshotDigest: string;
  variableSnapshotDigest: string;
  contentDigest: string;
  actorKind: 'HUMAN';
  actorRole: DraftApprovalActorRole;
  actorRef: string;
  approvedAt: string;
}>;

export type DraftApprovalCommandReceipt = Readonly<{
  kind: 'DRAFT_APPROVAL_COMMAND';
  schemaVersion: 1;
  policyVersion: 1;
  receiptRef: string;
  operationDigest: string;
  idempotencyKey: string;
  command: DraftApprovalCommand;
  intent: 'REVIEW_DRAFT';
  tenantRef: string;
  sequenceRef: string;
  enrollmentRef: string;
  executionRef: string;
  stepRef: string;
  stepVersion: number;
  proposalVersion: number;
  proposalDigest: string;
  renderedArtifactRef: string;
  templateSnapshotDigest: string;
  variableSnapshotDigest: string;
  contentDigest: string;
  actorKind: 'HUMAN';
  actorRole: DraftApprovalActorRole;
  actorRef: string;
  preState: DraftPreState;
  preVersion: number;
  postState: DraftPostState;
  postVersion: number;
  authorityPlanDigest: string;
  approvalReceipt?: ManualApprovalReceipt;
}>;

export type DraftApprovalCommandInput = Readonly<{
  schemaVersion: 1;
  policyVersion: 1;
  command: DraftApprovalCommand;
  tenantRef: string;
  sequenceRef: string;
  enrollmentRef: string;
  executionRef: string;
  stepRef: string;
  stepVersion: number;
  expectedVersion: number;
  idempotencyKey: string;
  intent: 'REVIEW_DRAFT';
  actorKind: DraftApprovalActorKind;
  actorRole: DraftApprovalActorRole;
  actorRef: string;
  proposal: DraftArtifactProposal;
  readerSnapshot: DraftApprovalReaderSnapshot;
  operationDigest: string;
  approvalAt?: string;
  persistedReceipt?: DraftApprovalCommandReceipt;
}>;

export type DraftApprovalCommandPlan = Readonly<{
  decision: 'NEW' | 'REPLAY';
  command: DraftApprovalCommand;
  intent: 'REVIEW_DRAFT';
  executionMode: 'DRAFT_ONLY';
  approvalPolicy: 'MANUAL_PER_STEP';
  proposal: DraftArtifactProposal;
  proposalDigest: string;
  operationDigest: string;
  transitionPlan: TransitionPlan | null;
  approvalReceiptToPersist: ManualApprovalReceipt | null;
  receiptToPersist: DraftApprovalCommandReceipt | null;
  sendCommand: null;
}>;

const OPAQUE_REF_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/;
const DIGEST_PATTERN = /^sha256:[a-z0-9-]+:[0-9a-f]{64}$/;
const UTC_TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/;
const IDENTITY_PATTERN = /(?:[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,})|(?:\+?\d{8,15})|(?:@[a-z0-9._-]*(?:s\.whatsapp\.net|g\.us|lid))/i;
const SECRET_PATTERN = /(?:bearer\s+|sk-[a-z0-9]|api[_-]?key\s*[:=]|password\s*[:=]|authorization\s*[:=])/i;
const SENSITIVE_KEY_PATTERN = /(?:email|phone|telephone|mobile|jid|recipient|subject|body|contentText|prompt|output|payload|provider|error|url|confidence|statusText|token|secret|password|cookie|authorization|api.?key)/i;
const PROPOSAL_ARTIFACT_PREFIX = 'draft-artifact:';
const RENDERER_PREFIX = 'draft-renderer:';
const COMMAND_KEY_PREFIX = 'draft-command:';
const COMMAND_RECEIPT_PREFIX = 'draft-approval-receipt:';
const APPROVAL_RECEIPT_PREFIX = 'approval-receipt:';

const COMMAND_TRANSITIONS: Readonly<Record<DraftApprovalCommand, Readonly<{
  from: DraftPreState;
  to: DraftPostState;
}>>> = Object.freeze({
  ACCEPT_PROPOSAL: Object.freeze({ from: 'draft_pending', to: 'draft_ready' }),
  REQUEST_APPROVAL: Object.freeze({ from: 'draft_ready', to: 'approval_required' }),
  APPROVE_DRAFT: Object.freeze({ from: 'approval_required', to: 'approved' }),
});

function deepFreeze<T>(value: T, seen = new Set<object>()): T {
  if (value === null || typeof value !== 'object' || seen.has(value)) return value;
  seen.add(value);
  for (const child of Object.values(value as RecordValue)) deepFreeze(child, seen);
  return Object.freeze(value);
}

function failure(code: DraftApprovalIsolationErrorCode): Failure {
  return deepFreeze({ ok: false, error: { code, message: ERROR_MESSAGES[code] } });
}

function success<T>(value: T): DraftApprovalIsolationResult<T> {
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
    const safeDigestOrRef = key !== undefined && /(?:Ref|Digest|Key|At|Version)$/.test(key);
    return (!safeDigestOrRef && !value.startsWith('sha256:') && IDENTITY_PATTERN.test(value))
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
  if (prefix && !value.startsWith(prefix)) return failure('INVALID_REF');
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
  const safeSuffix = digest.slice(-32).replace(/[0-9]/g, (digit) => String.fromCharCode('g'.charCodeAt(0) + Number(digit)));
  return `${prefix}${safeSuffix}`;
}

function validateChannel(value: unknown): Channel | Failure {
  if (value !== 'EMAIL' && value !== 'WHATSAPP') return failure('INVALID_CHANNEL');
  return value;
}

function validateRendererKind(value: unknown): DraftRendererKind | Failure {
  if (value !== 'SYSTEM_RENDERER' && value !== 'AI_WORKER') return failure('INVALID_RENDERER');
  return value;
}

function validateState(value: unknown): StepExecutionState | Failure {
  const states: readonly StepExecutionState[] = ['draft_pending', 'draft_ready', 'approval_required', 'approved', 'sending', 'sent', 'failed', 'unknown', 'cancelled', 'blocked'];
  if (typeof value !== 'string' || !states.includes(value as StepExecutionState)) return failure('INVALID_STATE');
  return value as StepExecutionState;
}

function validateActor(value: RecordValue): Readonly<{ actorRole: DraftApprovalActorRole; actorRef: string }> | Failure {
  if (value.actorKind !== 'HUMAN') return failure('ACTOR_NOT_AUTHORIZED');
  if (value.actorRole !== 'OWNER' && value.actorRole !== 'ADMIN' && value.actorRole !== 'SALES') return failure('ACTOR_NOT_AUTHORIZED');
  const actorRef = validateRef(value.actorRef);
  if (isFailure(actorRef)) return failure('INVALID_ACTOR');
  return { actorRole: value.actorRole, actorRef, };
}

function proposalIdentity(proposal: DraftArtifactProposal): RecordValue {
  return {
    schemaVersion: proposal.schemaVersion,
    policyVersion: proposal.policyVersion,
    tenantRef: proposal.tenantRef,
    sequenceRef: proposal.sequenceRef,
    enrollmentRef: proposal.enrollmentRef,
    executionRef: proposal.executionRef,
    stepRef: proposal.stepRef,
    stepVersion: proposal.stepVersion,
    templateSnapshotDigest: proposal.templateSnapshotDigest,
    variableSnapshotDigest: proposal.variableSnapshotDigest,
    renderedArtifactRef: proposal.renderedArtifactRef,
    contentDigest: proposal.contentDigest,
    channel: proposal.channel,
    proposalVersion: proposal.proposalVersion,
    rendererKind: proposal.rendererKind,
    rendererRef: proposal.rendererRef,
    createdAt: proposal.createdAt,
  };
}

export function computeDraftArtifactProposalDigest(input: DraftArtifactProposalInput): string {
  return hash('sales-sequence-draft-proposal-v1', proposalIdentity(input as DraftArtifactProposal));
}

export function computeManualDraftApprovalDigest(input: Readonly<{
  schemaVersion: 1;
  policyVersion: 1;
  tenantRef: string;
  sequenceRef: string;
  enrollmentRef: string;
  executionRef: string;
  stepRef: string;
  stepVersion: number;
  proposalVersion: number;
  proposalDigest: string;
  renderedArtifactRef: string;
  templateSnapshotDigest: string;
  variableSnapshotDigest: string;
  contentDigest: string;
  actorKind: 'HUMAN';
  actorRole: DraftApprovalActorRole;
  actorRef: string;
  approvedAt: string;
}>): string {
  return hash('sales-sequence-manual-approval-v1', input);
}

export type DraftApprovalOperationIntent = Readonly<{
  schemaVersion: 1;
  policyVersion: 1;
  command: DraftApprovalCommand;
  intent: 'REVIEW_DRAFT';
  idempotencyKey: string;
  tenantRef: string;
  sequenceRef: string;
  enrollmentRef: string;
  executionRef: string;
  stepRef: string;
  stepVersion: number;
  proposalVersion: number;
  proposalDigest: string;
  renderedArtifactRef: string;
  templateSnapshotDigest: string;
  variableSnapshotDigest: string;
  contentDigest: string;
  actorKind: 'HUMAN';
  actorRole: DraftApprovalActorRole;
  actorRef: string;
  preState: DraftPreState;
  preVersion: number;
  postState: DraftPostState;
  postVersion: number;
  authorityPlanDigest: string;
  approvalDigest?: string;
}>;

export function computeDraftApprovalOperationDigest(input: DraftApprovalOperationIntent): string {
  return hash('sales-sequence-draft-approval-v1', input);
}

function validateProposal(input: unknown, requireDigest: boolean): DraftArtifactProposal | Failure {
  const keys = [
    'schemaVersion', 'policyVersion', 'tenantRef', 'sequenceRef', 'enrollmentRef', 'executionRef', 'stepRef', 'stepVersion',
    'templateSnapshotDigest', 'variableSnapshotDigest', 'renderedArtifactRef', 'contentDigest', 'channel', 'proposalVersion',
    'rendererKind', 'rendererRef', 'createdAt', ...(requireDigest ? ['proposalDigest'] : []),
  ];
  const value = validateEnvelope(input, keys);
  if (isFailure(value)) return value;
  if (value.schemaVersion !== 1 || value.policyVersion !== 1) return failure('INVALID_POLICY_VERSION');
  const refs = [
    validateRef(value.tenantRef), validateRef(value.sequenceRef), validateRef(value.enrollmentRef),
    validateRef(value.executionRef), validateRef(value.stepRef), validateRef(value.renderedArtifactRef, PROPOSAL_ARTIFACT_PREFIX),
    validateRef(value.rendererRef, RENDERER_PREFIX),
  ];
  const digests = [validateDigest(value.templateSnapshotDigest), validateDigest(value.variableSnapshotDigest), validateDigest(value.contentDigest)];
  const stepVersion = validateVersion(value.stepVersion);
  const proposalVersion = validateVersion(value.proposalVersion);
  const channel = validateChannel(value.channel);
  const rendererKind = validateRendererKind(value.rendererKind);
  const createdAt = validateTimestamp(value.createdAt);
  if (refs.some(isFailure)) return failure('INVALID_REF');
  if (digests.some(isFailure)) return failure('INVALID_DIGEST');
  if (isFailure(stepVersion) || isFailure(proposalVersion)) return failure('INVALID_VERSION');
  if (isFailure(channel)) return channel;
  if (isFailure(rendererKind)) return rendererKind;
  if (isFailure(createdAt)) return createdAt;
  const proposal: DraftArtifactProposal = {
    schemaVersion: 1,
    policyVersion: 1,
    tenantRef: refs[0] as string,
    sequenceRef: refs[1] as string,
    enrollmentRef: refs[2] as string,
    executionRef: refs[3] as string,
    stepRef: refs[4] as string,
    stepVersion,
    templateSnapshotDigest: digests[0] as string,
    variableSnapshotDigest: digests[1] as string,
    renderedArtifactRef: refs[5] as string,
    contentDigest: digests[2] as string,
    channel,
    proposalVersion,
    rendererKind,
    rendererRef: refs[6] as string,
    createdAt,
    proposalDigest: requireDigest ? (validateDigest(value.proposalDigest) as string) : '',
  };
  const expectedDigest = computeDraftArtifactProposalDigest(proposal);
  if (requireDigest && (isFailure(validateDigest(value.proposalDigest)) || value.proposalDigest !== expectedDigest)) return failure('PROPOSAL_IDENTITY_MISMATCH');
  return proposal;
}

export function normalizeDraftArtifactProposal(input: unknown): DraftApprovalIsolationResult<DraftArtifactProposal> {
  const proposal = validateProposal(input, false);
  if (isFailure(proposal)) return proposal;
  const normalized = { ...proposal, proposalDigest: computeDraftArtifactProposalDigest(proposal) };
  return success(normalized);
}

export function planDraftArtifactProposal(input: unknown): DraftApprovalIsolationResult<DraftArtifactProposalPlan> {
  const proposal = normalizeDraftArtifactProposal(input);
  if (!proposal.ok) return proposal;
  if (proposal.value.rendererKind !== 'SYSTEM_RENDERER' && proposal.value.rendererKind !== 'AI_WORKER') return failure('INVALID_RENDERER');
  return success({
    decision: 'PROPOSAL_ONLY',
    executionMode: DRAFT_APPROVAL_EXECUTION_MODE,
    approvalPolicy: DRAFT_APPROVAL_POLICY,
    proposal: proposal.value,
    proposalDigest: proposal.value.proposalDigest,
    sendCommand: null,
  });
}

function validateSnapshot(input: unknown): DraftApprovalReaderSnapshot | Failure {
  const value = validateEnvelope(input, ['tenantRef', 'sequenceRef', 'enrollmentRef', 'executionRef', 'stepRef', 'stepVersion', 'state', 'version']);
  if (isFailure(value)) return value;
  const refs = [validateRef(value.tenantRef), validateRef(value.sequenceRef), validateRef(value.enrollmentRef), validateRef(value.executionRef), validateRef(value.stepRef)];
  const stepVersion = validateVersion(value.stepVersion);
  const version = validateVersion(value.version);
  const state = validateState(value.state);
  if (refs.some(isFailure) || isFailure(stepVersion) || isFailure(version) || isFailure(state)) return failure('TYPE_MISMATCH');
  return { tenantRef: refs[0] as string, sequenceRef: refs[1] as string, enrollmentRef: refs[2] as string, executionRef: refs[3] as string, stepRef: refs[4] as string, stepVersion, state, version };
}

function validateScope(proposal: DraftArtifactProposal, snapshot: DraftApprovalReaderSnapshot, input: RecordValue): Failure | null {
  if (proposal.tenantRef !== snapshot.tenantRef || proposal.sequenceRef !== snapshot.sequenceRef || proposal.enrollmentRef !== snapshot.enrollmentRef || proposal.executionRef !== snapshot.executionRef || proposal.stepRef !== snapshot.stepRef || proposal.stepVersion !== snapshot.stepVersion) return failure('SCOPE_MISMATCH');
  if (input.tenantRef !== snapshot.tenantRef || input.sequenceRef !== snapshot.sequenceRef || input.enrollmentRef !== snapshot.enrollmentRef || input.executionRef !== snapshot.executionRef || input.stepRef !== snapshot.stepRef || input.stepVersion !== snapshot.stepVersion) return failure('SCOPE_MISMATCH');
  return null;
}

function validateCommand(value: RecordValue): DraftApprovalCommand | Failure {
  if (value.command !== 'ACCEPT_PROPOSAL' && value.command !== 'REQUEST_APPROVAL' && value.command !== 'APPROVE_DRAFT') return failure('INVALID_COMMAND');
  if (value.intent !== 'REVIEW_DRAFT') return failure('INVALID_INTENT');
  if (value.command !== 'APPROVE_DRAFT' && value.approvalAt !== undefined) return failure('INVALID_APPROVAL');
  if (value.command === 'APPROVE_DRAFT' && value.approvalAt === undefined && value.persistedReceipt === undefined) return failure('INVALID_APPROVAL');
  return value.command;
}

function authorityPlan(
  value: RecordValue,
  proposal: DraftArtifactProposal,
  actor: Readonly<{ actorRole: DraftApprovalActorRole; actorRef: string }>,
  from: DraftPreState,
  to: DraftPostState,
  preVersion: number,
  approvalReceiptRef?: string,
): TransitionPlan | Failure {
  const plan = planStepExecutionTransition({
    executionRef: proposal.executionRef,
    tenantRef: proposal.tenantRef,
    sequenceRef: proposal.sequenceRef,
    enrollmentRef: proposal.enrollmentRef,
    stepRef: proposal.stepRef,
    stepVersion: proposal.stepVersion,
    from,
    to,
    expectedVersion: preVersion,
    currentVersion: preVersion,
    intent: 'REVIEW_DRAFT',
    actorKind: 'HUMAN',
    actorRole: actor.actorRole,
    actorRef: actor.actorRef,
    ...(approvalReceiptRef === undefined ? {} : { approvalReceiptRef }),
  });
  if (!plan.ok || plan.value.decision !== 'PLAN_ONLY' || plan.value.sendCommand !== null) return failure('AUTHORITY_TRANSITION_REJECTED');
  return plan.value;
}

function makeApprovalReceipt(proposal: DraftArtifactProposal, actor: Readonly<{ actorRole: DraftApprovalActorRole; actorRef: string }>, approvedAt: string): ManualApprovalReceipt {
  const approvalIntent = {
    schemaVersion: 1 as const,
    policyVersion: 1 as const,
    tenantRef: proposal.tenantRef,
    sequenceRef: proposal.sequenceRef,
    enrollmentRef: proposal.enrollmentRef,
    executionRef: proposal.executionRef,
    stepRef: proposal.stepRef,
    stepVersion: proposal.stepVersion,
    proposalVersion: proposal.proposalVersion,
    proposalDigest: proposal.proposalDigest,
    renderedArtifactRef: proposal.renderedArtifactRef,
    templateSnapshotDigest: proposal.templateSnapshotDigest,
    variableSnapshotDigest: proposal.variableSnapshotDigest,
    contentDigest: proposal.contentDigest,
    actorKind: 'HUMAN' as const,
    actorRole: actor.actorRole,
    actorRef: actor.actorRef,
    approvedAt,
  };
  const approvalDigest = computeManualDraftApprovalDigest(approvalIntent);
  return {
    kind: 'MANUAL_DRAFT_APPROVAL',
    ...approvalIntent,
    receiptRef: derivedRef(APPROVAL_RECEIPT_PREFIX, approvalDigest),
    approvalDigest,
  };
}

function makeCommandReceipt(
  value: RecordValue,
  proposal: DraftArtifactProposal,
  actor: Readonly<{ actorRole: DraftApprovalActorRole; actorRef: string }>,
  transition: TransitionPlan,
  command: DraftApprovalCommand,
  operationDigest: string,
  approvalReceipt?: ManualApprovalReceipt,
): DraftApprovalCommandReceipt {
  return {
    kind: 'DRAFT_APPROVAL_COMMAND',
    schemaVersion: 1,
    policyVersion: 1,
    receiptRef: derivedRef(COMMAND_RECEIPT_PREFIX, operationDigest),
    operationDigest,
    idempotencyKey: value.idempotencyKey as string,
    command,
    intent: 'REVIEW_DRAFT',
    tenantRef: proposal.tenantRef,
    sequenceRef: proposal.sequenceRef,
    enrollmentRef: proposal.enrollmentRef,
    executionRef: proposal.executionRef,
    stepRef: proposal.stepRef,
    stepVersion: proposal.stepVersion,
    proposalVersion: proposal.proposalVersion,
    proposalDigest: proposal.proposalDigest,
    renderedArtifactRef: proposal.renderedArtifactRef,
    templateSnapshotDigest: proposal.templateSnapshotDigest,
    variableSnapshotDigest: proposal.variableSnapshotDigest,
    contentDigest: proposal.contentDigest,
    actorKind: 'HUMAN',
    actorRole: actor.actorRole,
    actorRef: actor.actorRef,
    preState: transition.from as DraftPreState,
    preVersion: transition.expectedVersion,
    postState: transition.to as DraftPostState,
    postVersion: transition.nextVersion,
    authorityPlanDigest: transition.operationDigest,
    ...(approvalReceipt === undefined ? {} : { approvalReceipt }),
  };
}

function validateApprovalReceipt(input: unknown, proposal: DraftArtifactProposal, actor: Readonly<{ actorRole: DraftApprovalActorRole; actorRef: string }>): ManualApprovalReceipt | Failure {
  const value = validateEnvelope(input, [
    'kind', 'schemaVersion', 'policyVersion', 'receiptRef', 'approvalDigest', 'tenantRef', 'sequenceRef', 'enrollmentRef', 'executionRef', 'stepRef',
    'stepVersion', 'proposalVersion', 'proposalDigest', 'renderedArtifactRef', 'templateSnapshotDigest', 'variableSnapshotDigest', 'contentDigest',
    'actorKind', 'actorRole', 'actorRef', 'approvedAt',
  ]);
  if (isFailure(value)) return failure('INVALID_APPROVAL');
  const receiptRef = validateRef(value.receiptRef, APPROVAL_RECEIPT_PREFIX);
  const approvalDigest = validateDigest(value.approvalDigest);
  const refs = [validateRef(value.tenantRef), validateRef(value.sequenceRef), validateRef(value.enrollmentRef), validateRef(value.executionRef), validateRef(value.stepRef), validateRef(value.renderedArtifactRef, PROPOSAL_ARTIFACT_PREFIX), validateRef(value.actorRef)];
  const digests = [validateDigest(value.proposalDigest), validateDigest(value.templateSnapshotDigest), validateDigest(value.variableSnapshotDigest), validateDigest(value.contentDigest)];
  const versions = [validateVersion(value.stepVersion), validateVersion(value.proposalVersion)];
  const approvedAt = validateTimestamp(value.approvedAt);
  if (value.kind !== 'MANUAL_DRAFT_APPROVAL' || value.schemaVersion !== 1 || value.policyVersion !== 1 || value.actorKind !== 'HUMAN' || value.actorRole !== actor.actorRole || refs.some(isFailure) || digests.some(isFailure) || versions.some(isFailure) || isFailure(receiptRef) || isFailure(approvalDigest) || isFailure(approvedAt)) return failure('INVALID_APPROVAL');
  const receipt: ManualApprovalReceipt = {
    kind: 'MANUAL_DRAFT_APPROVAL', schemaVersion: 1, policyVersion: 1, receiptRef, approvalDigest,
    tenantRef: refs[0] as string, sequenceRef: refs[1] as string, enrollmentRef: refs[2] as string, executionRef: refs[3] as string, stepRef: refs[4] as string,
    stepVersion: versions[0] as number, proposalVersion: versions[1] as number, proposalDigest: digests[0] as string, renderedArtifactRef: refs[5] as string,
    templateSnapshotDigest: digests[1] as string, variableSnapshotDigest: digests[2] as string, contentDigest: digests[3] as string,
    actorKind: 'HUMAN', actorRole: actor.actorRole, actorRef: refs[6] as string, approvedAt: approvedAt as string,
  };
  if (receipt.actorRef !== actor.actorRef || receipt.tenantRef !== proposal.tenantRef || receipt.sequenceRef !== proposal.sequenceRef || receipt.enrollmentRef !== proposal.enrollmentRef || receipt.executionRef !== proposal.executionRef || receipt.stepRef !== proposal.stepRef || receipt.stepVersion !== proposal.stepVersion || receipt.proposalVersion !== proposal.proposalVersion || receipt.proposalDigest !== proposal.proposalDigest || receipt.renderedArtifactRef !== proposal.renderedArtifactRef || receipt.templateSnapshotDigest !== proposal.templateSnapshotDigest || receipt.variableSnapshotDigest !== proposal.variableSnapshotDigest || receipt.contentDigest !== proposal.contentDigest) return failure('PROPOSAL_IDENTITY_MISMATCH');
  const expectedDigest = computeManualDraftApprovalDigest({
    schemaVersion: 1, policyVersion: 1, tenantRef: receipt.tenantRef, sequenceRef: receipt.sequenceRef, enrollmentRef: receipt.enrollmentRef, executionRef: receipt.executionRef,
    stepRef: receipt.stepRef, stepVersion: receipt.stepVersion, proposalVersion: receipt.proposalVersion, proposalDigest: receipt.proposalDigest, renderedArtifactRef: receipt.renderedArtifactRef,
    templateSnapshotDigest: receipt.templateSnapshotDigest, variableSnapshotDigest: receipt.variableSnapshotDigest, contentDigest: receipt.contentDigest,
    actorKind: 'HUMAN', actorRole: receipt.actorRole, actorRef: receipt.actorRef, approvedAt: receipt.approvedAt,
  });
  if (expectedDigest !== receipt.approvalDigest || derivedRef(APPROVAL_RECEIPT_PREFIX, receipt.approvalDigest) !== receipt.receiptRef) return failure('INVALID_APPROVAL');
  return receipt;
}

function receiptExpectedKeys(): string[] {
  return [
    'kind', 'schemaVersion', 'policyVersion', 'receiptRef', 'operationDigest', 'idempotencyKey', 'command', 'intent',
    'tenantRef', 'sequenceRef', 'enrollmentRef', 'executionRef', 'stepRef', 'stepVersion', 'proposalVersion', 'proposalDigest',
    'renderedArtifactRef', 'templateSnapshotDigest', 'variableSnapshotDigest', 'contentDigest', 'actorKind', 'actorRole', 'actorRef',
    'preState', 'preVersion', 'postState', 'postVersion', 'authorityPlanDigest', 'approvalReceipt',
  ];
}

function validateCommandReceipt(input: unknown, proposal: DraftArtifactProposal, value: RecordValue, actor: Readonly<{ actorRole: DraftApprovalActorRole; actorRef: string }>): DraftApprovalCommandReceipt | Failure {
  const envelope = validateEnvelope(input, receiptExpectedKeys());
  if (isFailure(envelope)) return failure('INVALID_RECEIPT');
  const command = envelope.command;
  if (command !== 'ACCEPT_PROPOSAL' && command !== 'REQUEST_APPROVAL' && command !== 'APPROVE_DRAFT') return failure('INVALID_RECEIPT');
  if (envelope.intent !== 'REVIEW_DRAFT') return failure('INVALID_RECEIPT');
  const refs = [validateRef(envelope.receiptRef, COMMAND_RECEIPT_PREFIX), validateRef(envelope.idempotencyKey, COMMAND_KEY_PREFIX), validateRef(envelope.tenantRef), validateRef(envelope.sequenceRef), validateRef(envelope.enrollmentRef), validateRef(envelope.executionRef), validateRef(envelope.stepRef), validateRef(envelope.renderedArtifactRef, PROPOSAL_ARTIFACT_PREFIX), validateRef(envelope.actorRef)];
  const digests = [validateDigest(envelope.operationDigest), validateDigest(envelope.proposalDigest), validateDigest(envelope.templateSnapshotDigest), validateDigest(envelope.variableSnapshotDigest), validateDigest(envelope.contentDigest), validateDigest(envelope.authorityPlanDigest)];
  const versions = [validateVersion(envelope.stepVersion), validateVersion(envelope.proposalVersion), validateVersion(envelope.preVersion), validateVersion(envelope.postVersion)];
  const state = typeof envelope.preState === 'string' && typeof envelope.postState === 'string' ? { preState: envelope.preState, postState: envelope.postState } : null;
  if (envelope.kind !== 'DRAFT_APPROVAL_COMMAND' || envelope.schemaVersion !== 1 || envelope.policyVersion !== 1 || envelope.intent !== 'REVIEW_DRAFT' || envelope.actorKind !== 'HUMAN' || envelope.actorRole !== actor.actorRole || refs.some(isFailure) || digests.some(isFailure) || versions.some(isFailure) || !state) return failure('INVALID_RECEIPT');
  const mapping = COMMAND_TRANSITIONS[command];
  if (state.preState !== mapping.from || state.postState !== mapping.to || versions[3] !== (versions[2] as number) + 1 || envelope.actorRef !== actor.actorRef) return failure('INVALID_RECEIPT');
  const approvalReceipt = envelope.approvalReceipt === undefined ? undefined : validateApprovalReceipt(envelope.approvalReceipt, proposal, actor);
  if (isFailure(approvalReceipt)) return failure('INVALID_RECEIPT');
  if (command === 'APPROVE_DRAFT' && approvalReceipt === undefined) return failure('INVALID_RECEIPT');
  if (command !== 'APPROVE_DRAFT' && approvalReceipt !== undefined) return failure('INVALID_RECEIPT');
  const receipt: DraftApprovalCommandReceipt = {
    kind: 'DRAFT_APPROVAL_COMMAND', schemaVersion: 1, policyVersion: 1,
    receiptRef: refs[0] as string, operationDigest: digests[0] as string, idempotencyKey: refs[1] as string,
    command, intent: 'REVIEW_DRAFT', tenantRef: refs[2] as string, sequenceRef: refs[3] as string, enrollmentRef: refs[4] as string,
    executionRef: refs[5] as string, stepRef: refs[6] as string, stepVersion: versions[0] as number, proposalVersion: versions[1] as number,
    proposalDigest: digests[1] as string, renderedArtifactRef: refs[7] as string, templateSnapshotDigest: digests[2] as string,
    variableSnapshotDigest: digests[3] as string, contentDigest: digests[4] as string, actorKind: 'HUMAN', actorRole: actor.actorRole,
    actorRef: refs[8] as string, preState: state.preState as DraftPreState, preVersion: versions[2] as number, postState: state.postState as DraftPostState,
    postVersion: versions[3] as number, authorityPlanDigest: digests[5] as string, ...(approvalReceipt === undefined ? {} : { approvalReceipt }),
  };
  if (receipt.tenantRef !== proposal.tenantRef || receipt.sequenceRef !== proposal.sequenceRef || receipt.enrollmentRef !== proposal.enrollmentRef || receipt.executionRef !== proposal.executionRef || receipt.stepRef !== proposal.stepRef || receipt.stepVersion !== proposal.stepVersion || receipt.proposalVersion !== proposal.proposalVersion || receipt.proposalDigest !== proposal.proposalDigest || receipt.renderedArtifactRef !== proposal.renderedArtifactRef || receipt.templateSnapshotDigest !== proposal.templateSnapshotDigest || receipt.variableSnapshotDigest !== proposal.variableSnapshotDigest || receipt.contentDigest !== proposal.contentDigest || receipt.idempotencyKey !== value.idempotencyKey || receipt.command !== value.command) return failure('PROPOSAL_IDENTITY_MISMATCH');
  return receipt;
}

function operationIntentFromReceipt(receipt: DraftApprovalCommandReceipt): DraftApprovalOperationIntent {
  return {
    schemaVersion: 1, policyVersion: 1, command: receipt.command, intent: 'REVIEW_DRAFT', idempotencyKey: receipt.idempotencyKey,
    tenantRef: receipt.tenantRef, sequenceRef: receipt.sequenceRef, enrollmentRef: receipt.enrollmentRef, executionRef: receipt.executionRef, stepRef: receipt.stepRef,
    stepVersion: receipt.stepVersion, proposalVersion: receipt.proposalVersion, proposalDigest: receipt.proposalDigest, renderedArtifactRef: receipt.renderedArtifactRef,
    templateSnapshotDigest: receipt.templateSnapshotDigest, variableSnapshotDigest: receipt.variableSnapshotDigest, contentDigest: receipt.contentDigest,
    actorKind: 'HUMAN', actorRole: receipt.actorRole, actorRef: receipt.actorRef, preState: receipt.preState, preVersion: receipt.preVersion,
    postState: receipt.postState, postVersion: receipt.postVersion, authorityPlanDigest: receipt.authorityPlanDigest,
    ...(receipt.approvalReceipt === undefined ? {} : { approvalDigest: receipt.approvalReceipt.approvalDigest }),
  };
}

function validateReceiptSemantics(receipt: DraftApprovalCommandReceipt, proposal: DraftArtifactProposal, value: RecordValue, actor: Readonly<{ actorRole: DraftApprovalActorRole; actorRef: string }>): DraftApprovalCommandReceipt | Failure {
  const mapping = COMMAND_TRANSITIONS[receipt.command];
  const approvalReceipt = receipt.approvalReceipt;
  const authority = authorityPlan(value, proposal, actor, receipt.preState, receipt.postState, receipt.preVersion, approvalReceipt?.receiptRef);
  if (isFailure(authority) || authority.operationDigest !== receipt.authorityPlanDigest || authority.nextVersion !== receipt.postVersion) return failure('INVALID_RECEIPT');
  if (computeDraftApprovalOperationDigest(operationIntentFromReceipt(receipt)) !== receipt.operationDigest) return failure('INVALID_RECEIPT');
  if (derivedRef(COMMAND_RECEIPT_PREFIX, receipt.operationDigest) !== receipt.receiptRef) return failure('INVALID_RECEIPT');
  if (mapping.from !== receipt.preState || mapping.to !== receipt.postState) return failure('INVALID_RECEIPT');
  return receipt;
}

export function planDraftApprovalCommand(input: unknown): DraftApprovalIsolationResult<DraftApprovalCommandPlan> {
  const envelope = validateEnvelope(input, [
    'schemaVersion', 'policyVersion', 'command', 'tenantRef', 'sequenceRef', 'enrollmentRef', 'executionRef', 'stepRef', 'stepVersion', 'expectedVersion',
    'idempotencyKey', 'intent', 'actorKind', 'actorRole', 'actorRef', 'proposal', 'readerSnapshot', 'operationDigest', 'approvalAt', 'persistedReceipt',
  ]);
  if (isFailure(envelope)) return envelope;
  if (envelope.schemaVersion !== 1 || envelope.policyVersion !== 1) return failure('INVALID_POLICY_VERSION');
  const command = validateCommand(envelope);
  if (isFailure(command)) return command;
  const actor = validateActor(envelope);
  if (isFailure(actor)) return actor;
  const proposal = validateProposal(envelope.proposal, true);
  if (isFailure(proposal)) return proposal;
  const snapshot = validateSnapshot(envelope.readerSnapshot);
  if (isFailure(snapshot)) return snapshot;
  const expectedVersion = validateVersion(envelope.expectedVersion);
  const idempotencyKey = validateRef(envelope.idempotencyKey, COMMAND_KEY_PREFIX);
  const operationDigest = validateDigest(envelope.operationDigest);
  if (isFailure(expectedVersion) || isFailure(idempotencyKey) || isFailure(operationDigest)) return failure('TYPE_MISMATCH');
  const scopeFailure = validateScope(proposal, snapshot, envelope);
  if (scopeFailure) return scopeFailure;
  if (proposal.proposalDigest !== computeDraftArtifactProposalDigest(proposal)) return failure('PROPOSAL_IDENTITY_MISMATCH');
  const mapping = COMMAND_TRANSITIONS[command];
  const approvalAt = envelope.approvalAt === undefined ? undefined : validateTimestamp(envelope.approvalAt);
  if (isFailure(approvalAt)) return approvalAt;

  if (envelope.persistedReceipt !== undefined) {
    const persisted = validateCommandReceipt(envelope.persistedReceipt, proposal, envelope, actor);
    if (isFailure(persisted)) return persisted;
    const semantic = validateReceiptSemantics(persisted, proposal, envelope, actor);
    if (isFailure(semantic)) return semantic;
    if (persisted.operationDigest !== operationDigest || persisted.idempotencyKey !== idempotencyKey) return failure('PROPOSAL_IDENTITY_MISMATCH');
    if (expectedVersion !== persisted.preVersion) return failure('CAS_CONFLICT');
    if (command === 'APPROVE_DRAFT' && approvalAt !== undefined && (!persisted.approvalReceipt || approvalAt !== persisted.approvalReceipt.approvedAt)) return failure('INVALID_APPROVAL');
    if (snapshot.state !== persisted.postState || snapshot.version !== persisted.postVersion) return failure('REPLAY_STATE_MISMATCH');
    return success({ decision: 'REPLAY', command, intent: 'REVIEW_DRAFT', executionMode: DRAFT_APPROVAL_EXECUTION_MODE, approvalPolicy: DRAFT_APPROVAL_POLICY, proposal, proposalDigest: proposal.proposalDigest, operationDigest, transitionPlan: null, approvalReceiptToPersist: null, receiptToPersist: null, sendCommand: null });
  }

  if (snapshot.state !== mapping.from || snapshot.version !== expectedVersion) return failure(snapshot.state !== mapping.from ? 'PROPOSAL_STALE' : 'CAS_CONFLICT');
  if (command !== 'APPROVE_DRAFT' && approvalAt !== undefined) return failure('INVALID_APPROVAL');
  let approvalReceipt: ManualApprovalReceipt | undefined;
  if (command === 'APPROVE_DRAFT') {
    if (typeof approvalAt !== 'string') return failure('INVALID_APPROVAL');
    approvalReceipt = makeApprovalReceipt(proposal, actor, approvalAt);
  }
  const transition = authorityPlan(envelope, proposal, actor, mapping.from, mapping.to, expectedVersion, approvalReceipt?.receiptRef);
  if (isFailure(transition)) return transition;
  const receiptWithoutDigest = makeCommandReceipt(envelope, proposal, actor, transition, command, 'sha256:placeholder:' + '0'.repeat(64), approvalReceipt);
  const expectedOperationDigest = computeDraftApprovalOperationDigest(operationIntentFromReceipt(receiptWithoutDigest));
  if (operationDigest !== expectedOperationDigest) return failure('OPERATION_DIGEST_MISMATCH');
  const receipt = makeCommandReceipt(envelope, proposal, actor, transition, command, operationDigest, approvalReceipt);
  return success({ decision: 'NEW', command, intent: 'REVIEW_DRAFT', executionMode: DRAFT_APPROVAL_EXECUTION_MODE, approvalPolicy: DRAFT_APPROVAL_POLICY, proposal, proposalDigest: proposal.proposalDigest, operationDigest, transitionPlan: transition, approvalReceiptToPersist: approvalReceipt ?? null, receiptToPersist: receipt, sendCommand: null });
}
