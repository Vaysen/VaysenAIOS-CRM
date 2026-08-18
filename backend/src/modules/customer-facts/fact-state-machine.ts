/**
 * CRM-04A-3A: pure proposal/fact state-machine and transaction decision contract.
 *
 * This module describes the atomic write plan a database transaction must
 * execute. It does not open a transaction, generate ids, read a clock, or
 * persist anything.
 */

import { createHash } from 'node:crypto';
import { FACT_KEYS, type FactKey } from './fact-contract';
import type { EvidenceRelation } from './evidence-contract';

export const PROPOSAL_STATUSES = Object.freeze([
  'PROPOSED', 'ACCEPTED', 'REJECTED', 'EXPIRED',
] as const);
export type ProposalStatus = (typeof PROPOSAL_STATUSES)[number];

export const CUSTOMER_FACT_STATUSES = Object.freeze([
  'CONFIRMED', 'CONFLICT', 'EXPIRED', 'SUPERSEDED', 'INVALIDATED',
] as const);
export type CustomerFactStatus = (typeof CUSTOMER_FACT_STATUSES)[number];

export const PROPOSAL_ACTIONS = Object.freeze(['ACCEPT', 'REJECT', 'EXPIRE'] as const);
export type ProposalAction = (typeof PROPOSAL_ACTIONS)[number];

export const FACT_LIFECYCLE_ACTIONS = Object.freeze([
  'EXPIRE', 'SUPERSEDE', 'INVALIDATE', 'RESOLVE_CONFLICT',
] as const);
export type FactLifecycleAction = (typeof FACT_LIFECYCLE_ACTIONS)[number];

export const MAX_EVIDENCE_LINKS = 64;
export const MAX_CURRENT_FACT_SUMMARIES = 64;
export const MAX_OPAQUE_REF_LENGTH = 128;

const OPAQUE_REF_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const SENSITIVE_OPAQUE_PATTERN = /(?:^|[._-])(?:email|password|secret|token|cookie|authorization|bearer|api[_-]?key)(?:$|[._-])/i;
const REQUEST_ID_PATTERN = OPAQUE_REF_PATTERN;
const ACCEPT_OPERATION_DIGEST_DOMAIN = 'vaysen-trade-crm/fact-state/accept-operation/v1';
const ACCEPT_OPERATION_DIGEST_PREFIX = 'sha256:accept-operation-v1:';
const OPERATION_DIGEST_PATTERN = new RegExp(`^${ACCEPT_OPERATION_DIGEST_PREFIX}[0-9a-f]{64}$`);
const FACT_VALUE_DIGEST_PATTERN = /^sha256:fact-value-v1:[0-9a-f]{64}$/;
const UTC_INSTANT_PATTERN = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d{1,3}))?Z$/;

export type Scope = Readonly<{
  tenantRef: string;
  leadRef: string;
  factKey: FactKey;
}>;

export type EvidenceLinkInput = Readonly<{
  evidenceId: string;
  relation: EvidenceRelation;
}>;

export type ProposalSnapshot = Readonly<{
  proposalRef: string;
  scope: Scope;
  status: ProposalStatus;
  version: number;
  candidateValueDigest: string;
  expiresAt?: string;
}>;

export type CurrentFactSummary = Readonly<{
  factRef: string;
  scope: Scope;
  status: 'CONFIRMED' | 'CONFLICT';
  normalizedValueDigest: string;
  version: number;
}>;

export type FactStateSnapshot = Readonly<{
  factRef: string;
  scope: Scope;
  status: CustomerFactStatus;
  normalizedValueDigest: string;
  version: number;
}>;

export type PersistedOperationReceipt = Readonly<{
  schemaVersion: 1;
  requestId: string;
  operationDigest: string;
  proposalRef: string;
  decision: 'ACCEPTED';
}>;

export type IdempotencyCheckInput = Readonly<{
  schemaVersion: 1;
  requestId: string;
  operationDigest: string;
  proposalRef: string;
  persistedReceipt?: PersistedOperationReceipt;
}>;

export type AcceptProposalInput = Readonly<{
  schemaVersion: 1;
  operation: 'ACCEPT_PROPOSAL';
  actorKind: 'USER' | 'AI_WORKER';
  role: 'OWNER' | 'ADMIN' | 'VIEWER';
  scope: Scope;
  proposal: ProposalSnapshot;
  expectedVersion: number;
  requestId: string;
  operationDigest: string;
  proposalEvidence: readonly EvidenceLinkInput[];
  currentFacts: readonly CurrentFactSummary[];
  decisionNow: string;
  persistedReceipt?: PersistedOperationReceipt;
}>;

export type StateMachineErrorCode =
  | 'UNSUPPORTED_ENVELOPE'
  | 'UNKNOWN_FIELD'
  | 'TYPE_MISMATCH'
  | 'INVALID_STATUS'
  | 'INVALID_PROPOSAL_TRANSITION'
  | 'INVALID_ACTION'
  | 'ILLEGAL_PROPOSAL_TRANSITION'
  | 'ILLEGAL_FACT_TRANSITION'
  | 'AI_NOT_AUTHORIZED'
  | 'ROLE_NOT_AUTHORIZED'
  | 'INVALID_SCOPE'
  | 'SCOPE_MISMATCH'
  | 'INVALID_REF'
  | 'INVALID_FACT_KEY'
  | 'INVALID_VERSION'
  | 'VERSION_MISMATCH'
  | 'INVALID_REQUEST_ID'
  | 'INVALID_OPERATION_DIGEST'
  | 'OPERATION_DIGEST_MISMATCH'
  | 'INVALID_VALUE_DIGEST'
  | 'INVALID_TIMESTAMP'
  | 'PROPOSAL_EXPIRED'
  | 'INVALID_RECEIPT'
  | 'IDEMPOTENCY_CONFLICT'
  | 'EVIDENCE_REQUIRED'
  | 'EVIDENCE_LIMIT_EXCEEDED'
  | 'DUPLICATE_EVIDENCE_ID'
  | 'INVALID_EVIDENCE_LINK'
  | 'SUPPORT_EVIDENCE_REQUIRED'
  | 'INVALID_FACT_SUMMARY'
  | 'DUPLICATE_FACT_REF'
  | 'MULTIPLE_ACTIVE_FACTS'
  | 'SAME_VALUE_REQUIRES_REUSE'
  | 'REPLACEMENT_REQUIRED'
  | 'REPLACEMENT_STATUS_INVALID'
  | 'REPLACEMENT_VALUE_UNCHANGED'
  | 'CONFLICT_FACTS_REQUIRED'
  | 'CONFLICT_FACTS_INVALID';

const ERROR_MESSAGES: Readonly<Record<StateMachineErrorCode, string>> = Object.freeze({
  UNSUPPORTED_ENVELOPE: 'state-machine input envelope is unsupported',
  UNKNOWN_FIELD: 'state-machine input contains an unknown field',
  TYPE_MISMATCH: 'state-machine input has an invalid type',
  INVALID_STATUS: 'state-machine status is invalid',
  INVALID_PROPOSAL_TRANSITION: 'proposal snapshot is invalid',
  INVALID_ACTION: 'state-machine action is invalid',
  ILLEGAL_PROPOSAL_TRANSITION: 'proposal state transition is not allowed',
  ILLEGAL_FACT_TRANSITION: 'customer fact state transition is not allowed',
  AI_NOT_AUTHORIZED: 'AI worker cannot confirm a fact',
  ROLE_NOT_AUTHORIZED: 'role cannot perform this action',
  INVALID_SCOPE: 'scope reference is invalid',
  SCOPE_MISMATCH: 'scope references do not match',
  INVALID_REF: 'opaque reference is invalid',
  INVALID_FACT_KEY: 'fact key is invalid',
  INVALID_VERSION: 'version is invalid',
  VERSION_MISMATCH: 'expected version does not match',
  INVALID_REQUEST_ID: 'request id is invalid',
  INVALID_OPERATION_DIGEST: 'operation digest is invalid',
  OPERATION_DIGEST_MISMATCH: 'operation digest does not match the accepted operation intent',
  INVALID_VALUE_DIGEST: 'normalized value digest is invalid',
  INVALID_TIMESTAMP: 'timestamp is invalid',
  PROPOSAL_EXPIRED: 'proposal is expired',
  INVALID_RECEIPT: 'persisted operation receipt is invalid',
  IDEMPOTENCY_CONFLICT: 'idempotency key conflicts with the persisted operation',
  EVIDENCE_REQUIRED: 'proposal evidence links are required',
  EVIDENCE_LIMIT_EXCEEDED: 'proposal evidence links exceed the maximum',
  DUPLICATE_EVIDENCE_ID: 'proposal evidence ids must be unique',
  INVALID_EVIDENCE_LINK: 'proposal evidence link is invalid',
  SUPPORT_EVIDENCE_REQUIRED: 'at least one supporting evidence link is required',
  INVALID_FACT_SUMMARY: 'current fact summary is invalid',
  DUPLICATE_FACT_REF: 'current fact references must be unique',
  MULTIPLE_ACTIVE_FACTS: 'multiple confirmed facts require conflict resolution',
  SAME_VALUE_REQUIRES_REUSE: 'same value must reuse the existing confirmed fact',
  REPLACEMENT_REQUIRED: 'replacement fact is required',
  REPLACEMENT_STATUS_INVALID: 'replacement fact status is invalid',
  REPLACEMENT_VALUE_UNCHANGED: 'replacement fact value must be different',
  CONFLICT_FACTS_REQUIRED: 'conflict fact group is required',
  CONFLICT_FACTS_INVALID: 'conflict fact group is invalid',
});

export type StateMachineResult<T> =
  | Readonly<{ ok: true; value: T }>
  | Readonly<{ ok: false; error: Readonly<{ code: StateMachineErrorCode; message: string }> }>;

type FailureResult = Extract<StateMachineResult<never>, { ok: false }>;

export type AcceptOperationIntent = Readonly<{
  schemaVersion: 1;
  operation: 'ACCEPT_PROPOSAL';
  proposalRef: string;
  scope: Scope;
  expectedVersion: number;
  candidateValueDigest: string;
  proposalEvidence: readonly EvidenceLinkInput[];
}>;

export function computeAcceptOperationDigest(input: AcceptOperationIntent): string {
  const evidence = [...input.proposalEvidence]
    .map((link) => ({ evidenceId: link.evidenceId, relation: link.relation }))
    .sort((left, right) => left.evidenceId < right.evidenceId ? -1 : left.evidenceId > right.evidenceId ? 1 : left.relation < right.relation ? -1 : left.relation > right.relation ? 1 : 0);
  const canonical = JSON.stringify({
    schemaVersion: input.schemaVersion,
    operation: input.operation,
    proposalRef: input.proposalRef,
    scope: { tenantRef: input.scope.tenantRef, leadRef: input.scope.leadRef, factKey: input.scope.factKey },
    expectedVersion: input.expectedVersion,
    candidateValueDigest: input.candidateValueDigest,
    proposalEvidence: evidence,
  });
  const digest = createHash('sha256')
    .update(`${ACCEPT_OPERATION_DIGEST_DOMAIN}\0`, 'utf8')
    .update(canonical, 'utf8')
    .digest('hex');
  return `${ACCEPT_OPERATION_DIGEST_PREFIX}${digest}`;
}

function deepFreeze<T>(value: T): T {
  if (value === null || typeof value !== 'object' || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const child of Object.values(value)) deepFreeze(child);
  return value;
}

function success<T>(value: T): StateMachineResult<T> {
  return deepFreeze({ ok: true, value });
}

function failure(code: StateMachineErrorCode): FailureResult {
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

function hasOnlyKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  return Object.keys(value).every((key) => allowed.includes(key));
}

function parseUtcInstant(value: unknown): number | FailureResult {
  if (typeof value !== 'string') return failure('INVALID_TIMESTAMP');
  const match = UTC_INSTANT_PATTERN.exec(value);
  if (!match) return failure('INVALID_TIMESTAMP');
  const milliseconds = (match[2] ?? '').padEnd(3, '0');
  const canonical = `${match[1]}.${milliseconds}Z`;
  const timestamp = Date.parse(canonical);
  if (!Number.isFinite(timestamp) || new Date(timestamp).toISOString() !== canonical) return failure('INVALID_TIMESTAMP');
  return timestamp;
}

function validateOpaqueRef(value: unknown): string | FailureResult {
  if (typeof value !== 'string' || value.length > MAX_OPAQUE_REF_LENGTH || !OPAQUE_REF_PATTERN.test(value)) return failure('INVALID_REF');
  if (SENSITIVE_OPAQUE_PATTERN.test(value)) return failure('INVALID_REF');
  return value;
}

function validateRequestId(value: unknown): string | FailureResult {
  const ref = validateOpaqueRef(value);
  return typeof ref === 'string' ? ref : failure('INVALID_REQUEST_ID');
}

function validateOperationDigest(value: unknown): string | FailureResult {
  return typeof value === 'string' && OPERATION_DIGEST_PATTERN.test(value)
    ? value
    : failure('INVALID_OPERATION_DIGEST');
}

function validateValueDigest(value: unknown): string | FailureResult {
  return typeof value === 'string' && FACT_VALUE_DIGEST_PATTERN.test(value)
    ? value
    : failure('INVALID_VALUE_DIGEST');
}

function validateVersion(value: unknown): number | FailureResult {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
    ? value
    : failure('INVALID_VERSION');
}

function validateFactKey(value: unknown): FactKey | FailureResult {
  return typeof value === 'string' && FACT_KEYS.includes(value as FactKey)
    ? value as FactKey
    : failure('INVALID_FACT_KEY');
}

function validateScope(value: unknown): Scope | FailureResult {
  if (!isRecord(value)) return failure('INVALID_SCOPE');
  if (!hasOnlyKeys(value, ['tenantRef', 'leadRef', 'factKey']) || Object.keys(value).length !== 3) return failure('UNKNOWN_FIELD');
  const tenantRef = validateOpaqueRef(value.tenantRef);
  const leadRef = validateOpaqueRef(value.leadRef);
  const factKey = validateFactKey(value.factKey);
  if (typeof tenantRef !== 'string' || typeof leadRef !== 'string' || typeof factKey !== 'string') return failure('INVALID_SCOPE');
  return { tenantRef, leadRef, factKey };
}

function sameScope(left: Scope, right: Scope): boolean {
  return left.tenantRef === right.tenantRef && left.leadRef === right.leadRef && left.factKey === right.factKey;
}

function validateEvidenceLinks(value: unknown): EvidenceLinkInput[] | FailureResult {
  if (!Array.isArray(value)) return failure('TYPE_MISMATCH');
  if (value.length === 0) return failure('EVIDENCE_REQUIRED');
  if (value.length > MAX_EVIDENCE_LINKS) return failure('EVIDENCE_LIMIT_EXCEEDED');
  const ids = new Set<string>();
  const links: EvidenceLinkInput[] = [];
  for (const item of value) {
    if (!isRecord(item)) return failure('INVALID_EVIDENCE_LINK');
    if (!hasOnlyKeys(item, ['evidenceId', 'relation']) || Object.keys(item).length !== 2) return failure('UNKNOWN_FIELD');
    const evidenceId = validateOpaqueRef(item.evidenceId);
    if (typeof evidenceId !== 'string' || (item.relation !== 'SUPPORTS' && item.relation !== 'CONTRADICTS')) {
      return failure('INVALID_EVIDENCE_LINK');
    }
    if (ids.has(evidenceId)) return failure('DUPLICATE_EVIDENCE_ID');
    ids.add(evidenceId);
    links.push({ evidenceId, relation: item.relation });
  }
  if (!links.some((link) => link.relation === 'SUPPORTS')) return failure('SUPPORT_EVIDENCE_REQUIRED');
  return links.sort((left, right) => left.evidenceId < right.evidenceId ? -1 : left.evidenceId > right.evidenceId ? 1 : 0);
}

function validateProposalSnapshot(value: unknown): ProposalSnapshot | FailureResult {
  if (!isRecord(value)) return failure('TYPE_MISMATCH');
  if (!hasOnlyKeys(value, ['proposalRef', 'scope', 'status', 'version', 'candidateValueDigest', 'expiresAt'])
    || Object.keys(value).some((key) => key === 'expiresAt' && value[key] === undefined)) return failure('UNKNOWN_FIELD');
  const proposalRef = validateOpaqueRef(value.proposalRef);
  const scope = validateScope(value.scope);
  const version = validateVersion(value.version);
  const candidateValueDigest = validateValueDigest(value.candidateValueDigest);
  if (typeof proposalRef !== 'string' || isFailureResult(scope) || typeof version !== 'number' || typeof candidateValueDigest !== 'string') {
    return failure('INVALID_PROPOSAL_TRANSITION');
  }
  if (!PROPOSAL_STATUSES.includes(value.status as ProposalStatus)) return failure('INVALID_STATUS');
  let expiresAt: string | undefined;
  if (Object.prototype.hasOwnProperty.call(value, 'expiresAt')) {
    if (typeof value.expiresAt !== 'string' || typeof parseUtcInstant(value.expiresAt) !== 'number') return failure('INVALID_TIMESTAMP');
    expiresAt = value.expiresAt;
  }
  return {
    proposalRef,
    scope: scope as Scope,
    status: value.status as ProposalStatus,
    version,
    candidateValueDigest,
    ...(expiresAt ? { expiresAt } : {}),
  };
}

function validateCurrentFacts(value: unknown, scope: Scope): CurrentFactSummary[] | FailureResult {
  if (!Array.isArray(value)) return failure('TYPE_MISMATCH');
  if (value.length > MAX_CURRENT_FACT_SUMMARIES) return failure('INVALID_FACT_SUMMARY');
  const refs = new Set<string>();
  const facts: CurrentFactSummary[] = [];
  for (const item of value) {
    if (!isRecord(item)) return failure('INVALID_FACT_SUMMARY');
    if (!hasOnlyKeys(item, ['factRef', 'scope', 'status', 'normalizedValueDigest', 'version']) || Object.keys(item).length !== 5) {
      return failure('UNKNOWN_FIELD');
    }
    const factRef = validateOpaqueRef(item.factRef);
    const factScope = validateScope(item.scope);
    const digest = validateValueDigest(item.normalizedValueDigest);
    const version = validateVersion(item.version);
    if (typeof factRef !== 'string' || isFailureResult(factScope) || typeof digest !== 'string' || typeof version !== 'number') return failure('INVALID_FACT_SUMMARY');
    if (isFailureResult(factScope) || !sameScope(factScope, scope)) return failure('SCOPE_MISMATCH');
    if (item.status !== 'CONFIRMED' && item.status !== 'CONFLICT') return failure('INVALID_FACT_SUMMARY');
    if (refs.has(factRef)) return failure('DUPLICATE_FACT_REF');
    refs.add(factRef);
    facts.push({ factRef, scope: factScope as Scope, status: item.status, normalizedValueDigest: digest, version });
  }
  return facts.sort((left, right) => left.factRef < right.factRef ? -1 : left.factRef > right.factRef ? 1 : 0);
}

function validateReceipt(value: unknown): PersistedOperationReceipt | FailureResult {
  if (!isRecord(value)) return failure('INVALID_RECEIPT');
  if (!hasOnlyKeys(value, ['schemaVersion', 'requestId', 'operationDigest', 'proposalRef', 'decision']) || Object.keys(value).length !== 5) {
    return failure('INVALID_RECEIPT');
  }
  const requestId = validateRequestId(value.requestId);
  const operationDigest = validateOperationDigest(value.operationDigest);
  const proposalRef = validateOpaqueRef(value.proposalRef);
  if (typeof requestId !== 'string' || typeof operationDigest !== 'string' || typeof proposalRef !== 'string' || value.schemaVersion !== 1 || value.decision !== 'ACCEPTED') {
    return failure('INVALID_RECEIPT');
  }
  return { schemaVersion: 1, requestId, operationDigest, proposalRef, decision: 'ACCEPTED' };
}

export type IdempotencyDecision = Readonly<{
  decision: 'NEW' | 'IDEMPOTENT_REPLAY';
}>;

export function classifyIdempotency(input: unknown): StateMachineResult<IdempotencyDecision> {
  if (!isRecord(input)) return failure('UNSUPPORTED_ENVELOPE');
  if (!hasOnlyKeys(input, ['schemaVersion', 'requestId', 'operationDigest', 'proposalRef', 'persistedReceipt']) || input.schemaVersion !== 1) return failure('UNKNOWN_FIELD');
  const requestId = validateRequestId(input.requestId);
  const operationDigest = validateOperationDigest(input.operationDigest);
  const proposalRef = validateOpaqueRef(input.proposalRef);
  if (typeof requestId !== 'string' || typeof operationDigest !== 'string' || typeof proposalRef !== 'string') return failure('INVALID_RECEIPT');
  if (!Object.prototype.hasOwnProperty.call(input, 'persistedReceipt')) return success({ decision: 'NEW' });
  const receipt = validateReceipt(input.persistedReceipt);
  if (isFailureResult(receipt)) return receipt;
  if (receipt.requestId !== requestId || receipt.operationDigest !== operationDigest || receipt.proposalRef !== proposalRef) return failure('IDEMPOTENCY_CONFLICT');
  return success({ decision: 'IDEMPOTENT_REPLAY' });
}

export type ProposalTransitionPlan = Readonly<{
  object: 'PROPOSAL';
  from: ProposalStatus;
  to: ProposalStatus;
}>;

export function planProposalTransition(input: unknown): StateMachineResult<ProposalTransitionPlan> {
  if (!isRecord(input)) return failure('UNSUPPORTED_ENVELOPE');
  if (!hasOnlyKeys(input, ['schemaVersion', 'currentStatus', 'action']) || Object.keys(input).length !== 3 || input.schemaVersion !== 1) return failure('UNKNOWN_FIELD');
  if (!PROPOSAL_STATUSES.includes(input.currentStatus as ProposalStatus)) return failure('INVALID_STATUS');
  if (!PROPOSAL_ACTIONS.includes(input.action as ProposalAction)) return failure('INVALID_ACTION');
  if (input.currentStatus !== 'PROPOSED') return failure('ILLEGAL_PROPOSAL_TRANSITION');
  const to: Record<ProposalAction, ProposalStatus> = { ACCEPT: 'ACCEPTED', REJECT: 'REJECTED', EXPIRE: 'EXPIRED' };
  return success({ object: 'PROPOSAL', from: 'PROPOSED', to: to[input.action as ProposalAction] });
}

export type AcceptProposalPlan = Readonly<{
  schemaVersion: 1;
  decision: 'NEW';
  atomic: 'ALL_OR_NOTHING';
  proposalUpdate: Readonly<{ status: 'ACCEPTED'; expectedVersion: number; nextVersion: number }>;
  factOutcome: Readonly<
    | { action: 'CREATE'; status: 'CONFIRMED' | 'CONFLICT'; normalizedValueDigest: string; effectiveProjection: 'EFFECTIVE' | 'EMPTY' }
    | { action: 'REUSE_CONFIRMED'; status: 'CONFIRMED'; existingFactRef: string; normalizedValueDigest: string; effectiveProjection: 'EFFECTIVE' | 'EMPTY' }
  >;
  factTransitions: readonly Readonly<{ factRef: string; from: 'CONFIRMED'; to: 'CONFLICT'; expectedVersion: number; nextVersion: number }>[];
  factVersionUpdates: readonly Readonly<{ factRef: string; expectedVersion: number; nextVersion: number }>[];
  factEvidenceLinks: readonly Readonly<{ target: 'NEW_FACT' | 'EXISTING_CONFIRMED'; targetFactRef?: string; evidenceId: string; relation: EvidenceRelation }>[];
  audit: Readonly<{ event: 'PROPOSAL_ACCEPTED'; factOutcome: 'CREATE_CONFIRMED' | 'CREATE_CONFLICT' | 'REUSE_CONFIRMED' }>;
  receiptToPersist: PersistedOperationReceipt;
}>;

export type AcceptanceDecision = AcceptProposalPlan | Readonly<{ schemaVersion: 1; decision: 'IDEMPOTENT_REPLAY' }>;

function validateAcceptInput(input: unknown): StateMachineResult<AcceptProposalInput> {
  if (!isRecord(input)) return failure('UNSUPPORTED_ENVELOPE');
  const allowed = ['schemaVersion', 'operation', 'actorKind', 'role', 'scope', 'proposal', 'expectedVersion', 'requestId', 'operationDigest', 'proposalEvidence', 'currentFacts', 'decisionNow', 'persistedReceipt'];
  if (!hasOnlyKeys(input, allowed)) return failure('UNKNOWN_FIELD');
  if (input.schemaVersion !== 1 || input.operation !== 'ACCEPT_PROPOSAL') return failure('UNSUPPORTED_ENVELOPE');
  if (input.actorKind !== 'USER' && input.actorKind !== 'AI_WORKER') return failure('TYPE_MISMATCH');
  if (input.role !== 'OWNER' && input.role !== 'ADMIN' && input.role !== 'VIEWER') return failure('TYPE_MISMATCH');
  const scope = validateScope(input.scope);
  const proposal = validateProposalSnapshot(input.proposal);
  const expectedVersion = validateVersion(input.expectedVersion);
  const requestId = validateRequestId(input.requestId);
  const operationDigest = validateOperationDigest(input.operationDigest);
  const proposalEvidence = validateEvidenceLinks(input.proposalEvidence);
  if (isFailureResult(scope)) return scope;
  if (isFailureResult(proposal)) return proposal;
  if (isFailureResult(expectedVersion)) return expectedVersion;
  if (isFailureResult(requestId)) return requestId;
  if (isFailureResult(operationDigest)) return operationDigest;
  if (isFailureResult(proposalEvidence)) return proposalEvidence;
  const currentFacts = validateCurrentFacts(input.currentFacts, scope as Scope);
  if (!Array.isArray(currentFacts)) return currentFacts;
  const now = parseUtcInstant(input.decisionNow);
  if (typeof now !== 'number') return now;
  let persistedReceipt: PersistedOperationReceipt | undefined;
  if (Object.prototype.hasOwnProperty.call(input, 'persistedReceipt')) {
    const receipt = validateReceipt(input.persistedReceipt);
    if (isFailureResult(receipt)) return receipt;
    persistedReceipt = receipt;
  }
  const normalizedProposal = proposal as ProposalSnapshot;
  if (!sameScope(scope as Scope, normalizedProposal.scope)) return failure('SCOPE_MISMATCH');
  return {
    ok: true,
    value: {
      schemaVersion: 1,
      operation: 'ACCEPT_PROPOSAL',
      actorKind: input.actorKind,
      role: input.role,
      scope: scope as Scope,
      proposal: normalizedProposal,
      expectedVersion,
      requestId,
      operationDigest,
      proposalEvidence: proposalEvidence as EvidenceLinkInput[],
      currentFacts,
      decisionNow: input.decisionNow as string,
      ...(persistedReceipt ? { persistedReceipt } : {}),
    },
  };
}

export function decideAcceptProposal(input: unknown): StateMachineResult<AcceptanceDecision> {
  const normalized = validateAcceptInput(input);
  if (!normalized.ok) return normalized;
  if (normalized.value.actorKind === 'AI_WORKER') return failure('AI_NOT_AUTHORIZED');
  if (normalized.value.role === 'VIEWER') return failure('ROLE_NOT_AUTHORIZED');

  const computedOperationDigest = computeAcceptOperationDigest({
    schemaVersion: normalized.value.schemaVersion,
    operation: normalized.value.operation,
    proposalRef: normalized.value.proposal.proposalRef,
    scope: normalized.value.scope,
    expectedVersion: normalized.value.expectedVersion,
    candidateValueDigest: normalized.value.proposal.candidateValueDigest,
    proposalEvidence: normalized.value.proposalEvidence,
  });
  if (normalized.value.operationDigest !== computedOperationDigest) return failure('OPERATION_DIGEST_MISMATCH');

  const idempotency = classifyIdempotency({
    schemaVersion: 1,
    requestId: normalized.value.requestId,
    operationDigest: normalized.value.operationDigest,
    proposalRef: normalized.value.proposal.proposalRef,
    ...(normalized.value.persistedReceipt ? { persistedReceipt: normalized.value.persistedReceipt } : {}),
  });
  if (!idempotency.ok) return idempotency;
  if (idempotency.value.decision === 'IDEMPOTENT_REPLAY') return success({ schemaVersion: 1, decision: 'IDEMPOTENT_REPLAY' });
  if (normalized.value.proposal.version !== normalized.value.expectedVersion) return failure('VERSION_MISMATCH');
  if (normalized.value.proposal.status !== 'PROPOSED') return failure('ILLEGAL_PROPOSAL_TRANSITION');
  const decisionTimestamp = parseUtcInstant(normalized.value.decisionNow);
  if (typeof decisionTimestamp !== 'number') return decisionTimestamp;
  if (normalized.value.proposal.expiresAt && decisionTimestamp >= (parseUtcInstant(normalized.value.proposal.expiresAt) as number)) return failure('PROPOSAL_EXPIRED');

  const confirmed = normalized.value.currentFacts.filter((fact) => fact.status === 'CONFIRMED');
  const conflicts = normalized.value.currentFacts.some((fact) => fact.status === 'CONFLICT');
  const hasContradictingEvidence = normalized.value.proposalEvidence.some((link) => link.relation === 'CONTRADICTS');
  if (confirmed.length > 1) return failure('MULTIPLE_ACTIVE_FACTS');
  const sameConfirmed = confirmed[0]?.normalizedValueDigest === normalized.value.proposal.candidateValueDigest;
  const hasDifferentConfirmed = confirmed.some((fact) => fact.normalizedValueDigest !== normalized.value.proposal.candidateValueDigest);
  const canReuseConfirmed = sameConfirmed && !conflicts && !hasDifferentConfirmed && !hasContradictingEvidence;

  const factEvidenceLinks = normalized.value.proposalEvidence.map((link) => ({
    ...(canReuseConfirmed ? { target: 'EXISTING_CONFIRMED' as const, targetFactRef: confirmed[0].factRef } : { target: 'NEW_FACT' as const }),
    evidenceId: link.evidenceId,
    relation: link.relation,
  }));

  if (canReuseConfirmed) {
    const existing = confirmed[0];
    return success({
      schemaVersion: 1,
      decision: 'NEW',
      atomic: 'ALL_OR_NOTHING',
      proposalUpdate: { status: 'ACCEPTED', expectedVersion: normalized.value.expectedVersion, nextVersion: normalized.value.expectedVersion + 1 },
      factOutcome: { action: 'REUSE_CONFIRMED', status: 'CONFIRMED', existingFactRef: existing.factRef, normalizedValueDigest: existing.normalizedValueDigest, effectiveProjection: 'EFFECTIVE' },
      factTransitions: [],
      factVersionUpdates: [{ factRef: existing.factRef, expectedVersion: existing.version, nextVersion: existing.version + 1 }],
      factEvidenceLinks,
      audit: { event: 'PROPOSAL_ACCEPTED', factOutcome: 'REUSE_CONFIRMED' },
      receiptToPersist: {
        schemaVersion: 1,
        requestId: normalized.value.requestId,
        operationDigest: computedOperationDigest,
        proposalRef: normalized.value.proposal.proposalRef,
        decision: 'ACCEPTED',
      },
    });
  }

  const shouldConflict = conflicts || hasDifferentConfirmed || hasContradictingEvidence;
  const factTransitions = shouldConflict
    ? confirmed.map((fact) => ({ factRef: fact.factRef, from: 'CONFIRMED' as const, to: 'CONFLICT' as const, expectedVersion: fact.version, nextVersion: fact.version + 1 }))
    : [];
  const factOutcomeStatus = shouldConflict ? 'CONFLICT' as const : 'CONFIRMED' as const;
  return success({
    schemaVersion: 1,
    decision: 'NEW',
    atomic: 'ALL_OR_NOTHING',
    proposalUpdate: { status: 'ACCEPTED', expectedVersion: normalized.value.expectedVersion, nextVersion: normalized.value.expectedVersion + 1 },
    factOutcome: { action: 'CREATE', status: factOutcomeStatus, normalizedValueDigest: normalized.value.proposal.candidateValueDigest, effectiveProjection: shouldConflict ? 'EMPTY' : 'EFFECTIVE' },
    factTransitions,
    factVersionUpdates: [],
    factEvidenceLinks,
    audit: { event: 'PROPOSAL_ACCEPTED', factOutcome: shouldConflict ? 'CREATE_CONFLICT' : 'CREATE_CONFIRMED' },
    receiptToPersist: {
      schemaVersion: 1,
      requestId: normalized.value.requestId,
      operationDigest: computedOperationDigest,
      proposalRef: normalized.value.proposal.proposalRef,
      decision: 'ACCEPTED',
    },
  });
}

export type FactLifecycleInput = Readonly<{
  schemaVersion: 1;
  action: FactLifecycleAction;
  currentFact?: FactStateSnapshot;
  conflictFacts?: readonly FactStateSnapshot[];
  replacement?: Readonly<{ scope: Scope; status: 'CONFIRMED' | 'CONFLICT'; normalizedValueDigest: string }>;
  resolution?: 'SUPERSEDE' | 'INVALIDATE';
}>;

export type FactLifecyclePlan = Readonly<{
  schemaVersion: 1;
  decision: 'NEW';
  atomic: 'ALL_OR_NOTHING';
  action: FactLifecycleAction;
  factTransitions: readonly Readonly<{ factRef: string; from: CustomerFactStatus; to: CustomerFactStatus; expectedVersion: number; nextVersion: number }>[];
  supersedesFactRefs?: readonly string[];
  newFact?: Readonly<{ status: 'CONFIRMED' | 'CONFLICT'; normalizedValueDigest: string; effectiveProjection: 'EFFECTIVE' | 'EMPTY' }>;
  audit: Readonly<{ event: 'FACT_EXPIRED' | 'FACT_SUPERSEDED' | 'FACT_INVALIDATED' | 'CONFLICT_RESOLVED'; outcome: string }>;
}>;

function validateCurrentFactForLifecycle(value: unknown): FactStateSnapshot | FailureResult {
  if (!isRecord(value) || !hasOnlyKeys(value, ['factRef', 'scope', 'status', 'normalizedValueDigest', 'version']) || Object.keys(value).length !== 5) return failure('INVALID_FACT_SUMMARY');
  const factRef = validateOpaqueRef(value.factRef);
  const scope = validateScope(value.scope);
  const digest = validateValueDigest(value.normalizedValueDigest);
  const version = validateVersion(value.version);
  if (typeof factRef !== 'string' || isFailureResult(scope) || typeof digest !== 'string' || typeof version !== 'number') return failure('INVALID_FACT_SUMMARY');
  if (isFailureResult(scope) || !CUSTOMER_FACT_STATUSES.includes(value.status as CustomerFactStatus)) return failure('INVALID_FACT_SUMMARY');
  return { factRef, scope: scope as Scope, status: value.status as CustomerFactStatus, normalizedValueDigest: digest, version };
}

function validateConflictFacts(value: unknown): FactStateSnapshot[] | FailureResult {
  if (!Array.isArray(value)) return failure('CONFLICT_FACTS_REQUIRED');
  if (value.length < 2 || value.length > MAX_CURRENT_FACT_SUMMARIES) return failure('CONFLICT_FACTS_INVALID');
  const refs = new Set<string>();
  let groupScope: Scope | undefined;
  const facts: FactStateSnapshot[] = [];
  for (const item of value) {
    const fact = validateCurrentFactForLifecycle(item);
    if (isFailureResult(fact)) return failure('CONFLICT_FACTS_INVALID');
    if (fact.status !== 'CONFLICT' || refs.has(fact.factRef)) return failure('CONFLICT_FACTS_INVALID');
    if (groupScope && !sameScope(groupScope, fact.scope)) return failure('SCOPE_MISMATCH');
    groupScope = fact.scope;
    refs.add(fact.factRef);
    facts.push(fact);
  }
  return facts.sort((left, right) => left.factRef < right.factRef ? -1 : left.factRef > right.factRef ? 1 : 0);
}

function validateReplacement(value: unknown): NonNullable<FactLifecycleInput['replacement']> | FailureResult {
  if (value === undefined) return failure('REPLACEMENT_REQUIRED');
  if (!isRecord(value)) return failure('REPLACEMENT_REQUIRED');
  if (!hasOnlyKeys(value, ['scope', 'status', 'normalizedValueDigest']) || Object.keys(value).length !== 3) return failure('UNKNOWN_FIELD');
  const scope = validateScope(value.scope);
  const digest = validateValueDigest(value.normalizedValueDigest);
  if (isFailureResult(scope) || typeof digest !== 'string' || (value.status !== 'CONFIRMED' && value.status !== 'CONFLICT')) return failure('REPLACEMENT_STATUS_INVALID');
  return { scope: scope as Scope, status: value.status, normalizedValueDigest: digest };
}

export function planFactLifecycleAction(input: unknown): StateMachineResult<FactLifecyclePlan> {
  if (!isRecord(input)) return failure('UNSUPPORTED_ENVELOPE');
  if (!hasOnlyKeys(input, ['schemaVersion', 'action', 'currentFact', 'conflictFacts', 'replacement', 'resolution']) || input.schemaVersion !== 1) return failure('UNKNOWN_FIELD');
  if (!FACT_LIFECYCLE_ACTIONS.includes(input.action as FactLifecycleAction)) return failure('INVALID_ACTION');
  const action = input.action as FactLifecycleAction;
  if (action === 'RESOLVE_CONFLICT') {
    if (Object.prototype.hasOwnProperty.call(input, 'currentFact')) return failure('UNKNOWN_FIELD');
    const conflictFacts = validateConflictFacts(input.conflictFacts);
    if (isFailureResult(conflictFacts)) return conflictFacts;
    const replacement = validateReplacement(input.replacement);
    if (isFailureResult(replacement)) return replacement;
    if (input.resolution !== 'SUPERSEDE' && input.resolution !== 'INVALIDATE') return failure('ILLEGAL_FACT_TRANSITION');
    if (replacement.status !== 'CONFIRMED' || !sameScope(conflictFacts[0].scope, replacement.scope)) return replacement.status !== 'CONFIRMED' ? failure('REPLACEMENT_STATUS_INVALID') : failure('SCOPE_MISMATCH');
    const supersedesFactRefs = conflictFacts.map((fact) => fact.factRef);
    return success({
      schemaVersion: 1,
      decision: 'NEW',
      atomic: 'ALL_OR_NOTHING',
      action,
      factTransitions: conflictFacts.map((fact) => ({
        factRef: fact.factRef,
        from: 'CONFLICT' as const,
        to: input.resolution === 'SUPERSEDE' ? 'SUPERSEDED' as const : 'INVALIDATED' as const,
        expectedVersion: fact.version,
        nextVersion: fact.version + 1,
      })),
      supersedesFactRefs,
      newFact: { status: 'CONFIRMED', normalizedValueDigest: replacement.normalizedValueDigest, effectiveProjection: 'EFFECTIVE' },
      audit: { event: 'CONFLICT_RESOLVED', outcome: input.resolution === 'SUPERSEDE' ? 'CONFLICT_GROUP_SUPERSEDED_WITH_NEW_CONFIRMED' : 'CONFLICT_GROUP_INVALIDATED_WITH_NEW_CONFIRMED' },
    });
  }
  if (Object.prototype.hasOwnProperty.call(input, 'conflictFacts')) return failure('UNKNOWN_FIELD');
  const currentFact = validateCurrentFactForLifecycle(input.currentFact);
  if (isFailureResult(currentFact)) return currentFact;
  if (action === 'EXPIRE') {
    if (Object.prototype.hasOwnProperty.call(input, 'replacement') || Object.prototype.hasOwnProperty.call(input, 'resolution')) return failure('UNKNOWN_FIELD');
    if (currentFact.status !== 'CONFIRMED' && currentFact.status !== 'CONFLICT') return failure('ILLEGAL_FACT_TRANSITION');
    return success({
      schemaVersion: 1, decision: 'NEW', atomic: 'ALL_OR_NOTHING', action,
      factTransitions: [{ factRef: currentFact.factRef, from: currentFact.status, to: 'EXPIRED', expectedVersion: currentFact.version, nextVersion: currentFact.version + 1 }],
      audit: { event: 'FACT_EXPIRED', outcome: 'EXPIRED' },
    });
  }
  if (action === 'INVALIDATE') {
    if (Object.prototype.hasOwnProperty.call(input, 'replacement') || Object.prototype.hasOwnProperty.call(input, 'resolution')) return failure('UNKNOWN_FIELD');
    if (currentFact.status !== 'CONFIRMED' && currentFact.status !== 'CONFLICT') return failure('ILLEGAL_FACT_TRANSITION');
    return success({
      schemaVersion: 1, decision: 'NEW', atomic: 'ALL_OR_NOTHING', action,
      factTransitions: [{ factRef: currentFact.factRef, from: currentFact.status, to: 'INVALIDATED', expectedVersion: currentFact.version, nextVersion: currentFact.version + 1 }],
      audit: { event: 'FACT_INVALIDATED', outcome: 'INVALIDATED' },
    });
  }
  const replacement = validateReplacement(input.replacement);
  if (isFailureResult(replacement)) return replacement;
  if (!sameScope(currentFact.scope, replacement.scope)) return failure('SCOPE_MISMATCH');
  if (replacement.normalizedValueDigest === currentFact.normalizedValueDigest) return failure('REPLACEMENT_VALUE_UNCHANGED');
  if (action === 'SUPERSEDE') {
    if (currentFact.status !== 'CONFIRMED' || Object.prototype.hasOwnProperty.call(input, 'resolution')) return failure('ILLEGAL_FACT_TRANSITION');
    return success({
      schemaVersion: 1, decision: 'NEW', atomic: 'ALL_OR_NOTHING', action,
      factTransitions: [{ factRef: currentFact.factRef, from: 'CONFIRMED', to: 'SUPERSEDED', expectedVersion: currentFact.version, nextVersion: currentFact.version + 1 }],
      supersedesFactRefs: [currentFact.factRef],
      newFact: { status: replacement.status, normalizedValueDigest: replacement.normalizedValueDigest, effectiveProjection: replacement.status === 'CONFIRMED' ? 'EFFECTIVE' : 'EMPTY' },
      audit: { event: 'FACT_SUPERSEDED', outcome: replacement.status === 'CONFIRMED' ? 'NEW_CONFIRMED' : 'NEW_CONFLICT' },
    });
  }
  return failure('ILLEGAL_FACT_TRANSITION');
}
