/**
 * CRM-04A-3B: permissioned review/lifecycle command decision contract.
 *
 * This module only produces a deterministic, atomic write plan. It does not
 * authenticate an actor, read a database, read a clock, or execute a
 * transaction. The service must resolve scope and snapshots before calling it.
 */

import { createHash } from 'node:crypto';
import {
  planFactLifecycleAction,
  planProposalTransition,
  type FactLifecyclePlan,
  type FactLifecycleAction,
  type FactStateSnapshot,
  type CustomerFactStatus,
  type ProposalTransitionPlan,
  type ProposalSnapshot,
  type ProposalStatus,
  type Scope,
  type StateMachineResult,
} from './fact-state-machine';
import { FACT_KEYS, type FactKey } from './fact-contract';

export const FACT_COMMANDS = Object.freeze([
  'REJECT_PROPOSAL',
  'EXPIRE_PROPOSAL',
  'EXPIRE_FACT',
  'SUPERSEDE_FACT',
  'INVALIDATE_FACT',
  'RESOLVE_FACT_CONFLICT',
] as const);
export type FactCommand = (typeof FACT_COMMANDS)[number];

export const REJECT_REASON_CODES = Object.freeze([
  'INSUFFICIENT_EVIDENCE',
  'DUPLICATE_PROPOSAL',
  'OUT_OF_SCOPE',
  'UNSUPPORTED_FACT',
] as const);
export const EXPIRY_REASON_CODES = Object.freeze([
  'POLICY_DUE',
  'VALID_UNTIL_REACHED',
] as const);
export const SUPERSEDE_REASON_CODES = Object.freeze([
  'CORRECTED_VALUE',
  'NEWER_SOURCE',
  'DUPLICATE_FACT',
] as const);
export const INVALIDATE_REASON_CODES = Object.freeze([
  'INCORRECT_VALUE',
  'SOURCE_RETRACTED',
  'DUPLICATE_FACT',
] as const);
export const RESOLUTION_REASON_CODES = Object.freeze([
  'SELECT_REPLACEMENT',
  'INVALIDATE_CONFLICT_SET',
] as const);

export type ActorKind = 'USER' | 'SYSTEM' | 'AI_WORKER';
export type CommandRole = 'OWNER' | 'ADMIN' | 'VIEWER' | 'SYSTEM';
export type IdempotencyDecision = 'NEW' | 'IDEMPOTENT_REPLAY' | 'IDEMPOTENCY_CONFLICT';

type ReasonCode =
  | (typeof REJECT_REASON_CODES)[number]
  | (typeof EXPIRY_REASON_CODES)[number]
  | (typeof SUPERSEDE_REASON_CODES)[number]
  | (typeof INVALIDATE_REASON_CODES)[number]
  | (typeof RESOLUTION_REASON_CODES)[number];

type Failure = Readonly<{ ok: false; error: Readonly<{ code: CommandErrorCode; message: string }> }>;
type Result<T> = Readonly<{ ok: true; value: T }> | Failure;

export type CommandErrorCode =
  | 'UNSUPPORTED_ENVELOPE'
  | 'UNKNOWN_FIELD'
  | 'TYPE_MISMATCH'
  | 'INVALID_COMMAND'
  | 'INVALID_ACTOR'
  | 'ACTOR_ROLE_MISMATCH'
  | 'AI_NOT_AUTHORIZED'
  | 'ROLE_NOT_AUTHORIZED'
  | 'SYSTEM_COMMAND_FORBIDDEN'
  | 'INVALID_SCOPE'
  | 'SCOPE_MISMATCH'
  | 'INVALID_REF'
  | 'INVALID_FACT_KEY'
  | 'INVALID_STATUS'
  | 'INVALID_VERSION'
  | 'VERSION_MISMATCH'
  | 'INVALID_REQUEST_ID'
  | 'INVALID_OPERATION_DIGEST'
  | 'OPERATION_DIGEST_MISMATCH'
  | 'INVALID_VALUE_DIGEST'
  | 'INVALID_REASON_CODE'
  | 'INVALID_TIMESTAMP'
  | 'EXPIRY_TIME_REQUIRED'
  | 'EXPIRY_TIME_CONFLICT'
  | 'EXPIRY_NOT_DUE'
  | 'POLICY_VERSION_REQUIRED'
  | 'INVALID_POLICY_VERSION'
  | 'INVALID_RECEIPT'
  | 'IDEMPOTENCY_CONFLICT'
  | 'ILLEGAL_PROPOSAL_TRANSITION'
  | 'ILLEGAL_FACT_TRANSITION'
  | 'CONFLICT_FACTS_INVALID'
  | 'REPLACEMENT_INVALID'
  | 'STATE_PLAN_REJECTED';

const ERROR_MESSAGES: Readonly<Record<CommandErrorCode, string>> = Object.freeze({
  UNSUPPORTED_ENVELOPE: 'command input envelope is unsupported',
  UNKNOWN_FIELD: 'command input contains an unknown field',
  TYPE_MISMATCH: 'command input has an invalid type',
  INVALID_COMMAND: 'command is invalid',
  INVALID_ACTOR: 'actor kind is invalid',
  ACTOR_ROLE_MISMATCH: 'actor kind and role do not match',
  AI_NOT_AUTHORIZED: 'AI worker cannot perform review or lifecycle writes',
  ROLE_NOT_AUTHORIZED: 'role cannot perform this command',
  SYSTEM_COMMAND_FORBIDDEN: 'system actor is restricted to expiry commands',
  INVALID_SCOPE: 'scope is invalid',
  SCOPE_MISMATCH: 'scope references do not match',
  INVALID_REF: 'opaque reference is invalid',
  INVALID_FACT_KEY: 'fact key is invalid',
  INVALID_STATUS: 'status is invalid',
  INVALID_VERSION: 'version is invalid',
  VERSION_MISMATCH: 'expected version does not match the snapshot',
  INVALID_REQUEST_ID: 'request id is invalid',
  INVALID_OPERATION_DIGEST: 'operation digest is invalid',
  OPERATION_DIGEST_MISMATCH: 'operation digest does not match the command intent',
  INVALID_VALUE_DIGEST: 'normalized value digest is invalid',
  INVALID_REASON_CODE: 'reason code is invalid',
  INVALID_TIMESTAMP: 'timestamp is invalid',
  EXPIRY_TIME_REQUIRED: 'an expiry time is required',
  EXPIRY_TIME_CONFLICT: 'expiry times conflict',
  EXPIRY_NOT_DUE: 'expiry time has not been reached',
  POLICY_VERSION_REQUIRED: 'expiry policy version is required',
  INVALID_POLICY_VERSION: 'expiry policy version is invalid',
  INVALID_RECEIPT: 'persisted command receipt is invalid',
  IDEMPOTENCY_CONFLICT: 'idempotency key conflicts with the persisted command',
  ILLEGAL_PROPOSAL_TRANSITION: 'proposal transition is not allowed',
  ILLEGAL_FACT_TRANSITION: 'fact lifecycle transition is not allowed',
  CONFLICT_FACTS_INVALID: 'conflict fact group is invalid',
  REPLACEMENT_INVALID: 'replacement fact is invalid',
  STATE_PLAN_REJECTED: 'underlying state plan rejected the command',
});

const OPAQUE_REF_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const SENSITIVE_REF_PATTERN = /(?:^|[._-])(?:email|password|secret|token|cookie|authorization|bearer|api[_-]?key)(?:$|[._-])/i;
const VALUE_DIGEST_PATTERN = /^sha256:fact-value-v1:[0-9a-f]{64}$/;
const COMMAND_DIGEST_PREFIX = 'sha256:fact-command-v1:';
const COMMAND_DIGEST_PATTERN = new RegExp(`^${COMMAND_DIGEST_PREFIX}[0-9a-f]{64}$`);
const COMMAND_DIGEST_DOMAIN = 'vaysen-trade-crm/fact-command/v1';
const UTC_INSTANT_PATTERN = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d{1,3}))?Z$/;
export const EXPIRY_POLICY_VERSION = 'expiry-policy-v1' as const;
const MAX_TARGET_REFS = 64;

function asciiCompare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

export type FactCommandOperationIntent = Readonly<{
  schemaVersion: 1;
  command: FactCommand;
  targetRefs: readonly string[];
  scope: Scope;
  expectedVersions: readonly Readonly<{ targetRef: string; expectedVersion: number }>[];
  reasonCode: ReasonCode;
  replacementValueDigest?: string;
  expiryDueAt?: string;
  policyVersion: string | null;
}>;

export type CommandReceipt = Readonly<{
  schemaVersion: 1;
  requestId: string;
  command: FactCommand;
  targetRefs: readonly string[];
  operationDigest: string;
  decision: 'COMPLETED';
}>;

export type CommandIdempotencyInput = Readonly<{
  schemaVersion: 1;
  requestId: string;
  command: FactCommand;
  targetRefs: readonly string[];
  operationDigest: string;
  persistedReceipt?: CommandReceipt;
}>;

export type CommandIdempotencyResult = Readonly<{
  schemaVersion: 1;
  decision: IdempotencyDecision;
}>;

export type FactCommandPlan = Readonly<{
  schemaVersion: 1;
  decision: 'NEW';
  command: FactCommand;
  atomic: 'ALL_OR_NOTHING';
  underlyingPlan: Readonly<FactLifecyclePlan | (ProposalTransitionPlan & Readonly<{ proposalUpdate: Readonly<{ status: 'REJECTED' | 'EXPIRED'; expectedVersion: number; nextVersion: number }> }>)>;
  receiptToPersist: CommandReceipt;
}>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasOnlyKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const allowed = new Set(keys);
  return Object.keys(value).every((key) => allowed.has(key));
}

function hasExplicitUndefined(value: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key) && value[key] === undefined;
}

function failure(code: CommandErrorCode): Failure {
  return deepFreeze({ ok: false, error: { code, message: ERROR_MESSAGES[code] } });
}

function success<T>(value: T): Result<T> {
  return deepFreeze({ ok: true, value });
}

function isFailure(value: unknown): value is Failure {
  return isRecord(value) && value.ok === false && isRecord(value.error);
}

function deepFreeze<T>(value: T): T {
  if (value === null || typeof value !== 'object' || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  return value;
}

function validateOpaqueRef(value: unknown): string | Failure {
  if (typeof value !== 'string' || !OPAQUE_REF_PATTERN.test(value) || SENSITIVE_REF_PATTERN.test(value)) return failure('INVALID_REF');
  return value;
}

function validateRequestId(value: unknown): string | Failure {
  const result = validateOpaqueRef(value);
  return isFailure(result) ? failure('INVALID_REQUEST_ID') : result;
}

function validateScope(value: unknown): Scope | Failure {
  if (!isRecord(value) || !hasOnlyKeys(value, ['tenantRef', 'leadRef', 'factKey']) || Object.keys(value).length !== 3) return failure('INVALID_SCOPE');
  const tenantRef = validateOpaqueRef(value.tenantRef);
  const leadRef = validateOpaqueRef(value.leadRef);
  if (isFailure(tenantRef) || isFailure(leadRef)) return failure('INVALID_SCOPE');
  if (typeof value.factKey !== 'string' || !FACT_KEYS.includes(value.factKey as FactKey)) return failure('INVALID_FACT_KEY');
  return { tenantRef, leadRef, factKey: value.factKey as FactKey };
}

function sameScope(left: Scope, right: Scope): boolean {
  return left.tenantRef === right.tenantRef && left.leadRef === right.leadRef && left.factKey === right.factKey;
}

function validateVersion(value: unknown): number | Failure {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : failure('INVALID_VERSION');
}

function validateDigest(value: unknown): string | Failure {
  return typeof value === 'string' && VALUE_DIGEST_PATTERN.test(value) ? value : failure('INVALID_VALUE_DIGEST');
}

function validateCommandDigest(value: unknown): string | Failure {
  return typeof value === 'string' && COMMAND_DIGEST_PATTERN.test(value) ? value : failure('INVALID_OPERATION_DIGEST');
}

function validateTimestamp(value: unknown): number | Failure {
  if (typeof value !== 'string') return failure('INVALID_TIMESTAMP');
  const match = UTC_INSTANT_PATTERN.exec(value);
  if (!match) return failure('INVALID_TIMESTAMP');
  const date = Date.parse(value);
  if (!Number.isFinite(date) || new Date(date).toISOString() !== `${match[1]}.${(match[2] ?? '').padEnd(3, '0')}Z`) return failure('INVALID_TIMESTAMP');
  return date;
}

function validateReason(value: unknown, allowlist: readonly string[]): ReasonCode | Failure {
  return typeof value === 'string' && allowlist.includes(value) ? value as ReasonCode : failure('INVALID_REASON_CODE');
}

function validateActor(value: unknown): ActorKind | Failure {
  return value === 'USER' || value === 'SYSTEM' || value === 'AI_WORKER' ? value : failure('INVALID_ACTOR');
}

function validateRole(value: unknown): CommandRole | Failure {
  return value === 'OWNER' || value === 'ADMIN' || value === 'VIEWER' || value === 'SYSTEM' ? value : failure('ACTOR_ROLE_MISMATCH');
}

function authorize(command: FactCommand, actorKind: ActorKind, role: CommandRole): Failure | undefined {
  if (actorKind === 'USER' && role === 'SYSTEM') return failure('ACTOR_ROLE_MISMATCH');
  if (actorKind === 'SYSTEM' && role !== 'SYSTEM') return failure('ACTOR_ROLE_MISMATCH');
  if (actorKind === 'AI_WORKER' && role === 'SYSTEM') return failure('ACTOR_ROLE_MISMATCH');
  if (actorKind === 'AI_WORKER') return failure('AI_NOT_AUTHORIZED');
  if (actorKind === 'SYSTEM') return command === 'EXPIRE_PROPOSAL' || command === 'EXPIRE_FACT' ? undefined : failure('SYSTEM_COMMAND_FORBIDDEN');
  if (role === 'VIEWER') return failure('ROLE_NOT_AUTHORIZED');
  return undefined;
}

function validateBase(value: Record<string, unknown>, command: FactCommand, extraKeys: readonly string[]): Result<Readonly<{ actorKind: ActorKind; role: CommandRole; scope: Scope; requestId: string; operationDigest: string; persistedReceipt?: CommandReceipt }>> {
  const keys = ['schemaVersion', 'command', 'actorKind', 'role', 'scope', 'requestId', 'operationDigest', 'persistedReceipt', ...extraKeys];
  if (!hasOnlyKeys(value, keys) || value.schemaVersion !== 1 || value.command !== command) return failure(value.command === command ? 'UNKNOWN_FIELD' : 'INVALID_COMMAND');
  const actorKind = validateActor(value.actorKind);
  const role = validateRole(value.role);
  const scope = validateScope(value.scope);
  const requestId = validateRequestId(value.requestId);
  const operationDigest = validateCommandDigest(value.operationDigest);
  if (isFailure(actorKind)) return actorKind;
  if (isFailure(role)) return role;
  if (isFailure(scope)) return scope;
  if (isFailure(requestId)) return requestId;
  if (isFailure(operationDigest)) return operationDigest;
  if (hasExplicitUndefined(value, 'persistedReceipt')) return failure('UNKNOWN_FIELD');
  const persistedReceipt = validateOptionalReceipt(Object.prototype.hasOwnProperty.call(value, 'persistedReceipt') ? value.persistedReceipt : undefined);
  if (isFailure(persistedReceipt)) return persistedReceipt;
  return success({ actorKind, role, scope, requestId, operationDigest, persistedReceipt });
}

function validateOptionalReceipt(value: unknown): CommandReceipt | undefined | Failure {
  if (value === undefined) return undefined;
  if (!isRecord(value) || !hasOnlyKeys(value, ['schemaVersion', 'requestId', 'command', 'targetRefs', 'operationDigest', 'decision']) || Object.keys(value).length !== 6 || value.schemaVersion !== 1 || value.decision !== 'COMPLETED') return failure('INVALID_RECEIPT');
  const requestId = validateRequestId(value.requestId);
  const operationDigest = validateCommandDigest(value.operationDigest);
  if (isFailure(requestId) || isFailure(operationDigest) || !FACT_COMMANDS.includes(value.command as FactCommand) || !Array.isArray(value.targetRefs)) return failure('INVALID_RECEIPT');
  const refs = validateTargetRefs(value.targetRefs);
  if (isFailure(refs)) return failure('INVALID_RECEIPT');
  return { schemaVersion: 1, requestId, command: value.command as FactCommand, targetRefs: refs, operationDigest, decision: 'COMPLETED' };
}

function validateTargetRefs(value: unknown): string[] | Failure {
  if (!Array.isArray(value) || value.length < 1 || value.length > MAX_TARGET_REFS) return failure('INVALID_REF');
  const refs: string[] = [];
  const seen = new Set<string>();
  for (const item of value) {
    const ref = validateOpaqueRef(item);
    if (isFailure(ref) || seen.has(ref)) return failure('INVALID_REF');
    seen.add(ref);
    refs.push(ref);
  }
  return refs.sort(asciiCompare);
}

function canonicalIntent(input: FactCommandOperationIntent): string {
  const targetRefs = [...input.targetRefs].sort(asciiCompare);
  const expectedVersions = [...input.expectedVersions]
    .map((item) => ({ targetRef: item.targetRef, expectedVersion: item.expectedVersion }))
    .sort((left, right) => asciiCompare(left.targetRef, right.targetRef));
  return JSON.stringify({
    schemaVersion: input.schemaVersion,
    command: input.command,
    targetRefs,
    scope: { tenantRef: input.scope.tenantRef, leadRef: input.scope.leadRef, factKey: input.scope.factKey },
    expectedVersions,
    reasonCode: input.reasonCode,
    replacementValueDigest: input.replacementValueDigest ?? null,
    expiryDueAt: input.expiryDueAt ?? null,
    policyVersion: input.policyVersion,
  });
}

export function computeFactCommandOperationDigest(input: FactCommandOperationIntent): string {
  const digest = createHash('sha256').update(`${COMMAND_DIGEST_DOMAIN}\0`, 'utf8').update(canonicalIntent(input), 'utf8').digest('hex');
  return `${COMMAND_DIGEST_PREFIX}${digest}`;
}

function receiptMatches(input: CommandIdempotencyInput, receipt: CommandReceipt): boolean {
  return receipt.requestId === input.requestId && receipt.command === input.command && receipt.operationDigest === input.operationDigest && JSON.stringify([...receipt.targetRefs].sort(asciiCompare)) === JSON.stringify([...input.targetRefs].sort(asciiCompare));
}

export function classifyFactCommandIdempotency(input: unknown): Result<CommandIdempotencyResult> {
  if (!isRecord(input) || !hasOnlyKeys(input, ['schemaVersion', 'requestId', 'command', 'targetRefs', 'operationDigest', 'persistedReceipt']) || input.schemaVersion !== 1 || !FACT_COMMANDS.includes(input.command as FactCommand)) return failure('UNKNOWN_FIELD');
  const requestId = validateRequestId(input.requestId);
  const operationDigest = validateCommandDigest(input.operationDigest);
  const targetRefs = validateTargetRefs(input.targetRefs);
  if (isFailure(requestId)) return requestId;
  if (isFailure(operationDigest)) return operationDigest;
  if (isFailure(targetRefs)) return targetRefs;
  if (hasExplicitUndefined(input, 'persistedReceipt')) return failure('UNKNOWN_FIELD');
  const persistedReceipt = validateOptionalReceipt(Object.prototype.hasOwnProperty.call(input, 'persistedReceipt') ? input.persistedReceipt : undefined);
  if (isFailure(persistedReceipt)) return persistedReceipt;
  if (!persistedReceipt) return success({ schemaVersion: 1, decision: 'NEW' });
  return success({ schemaVersion: 1, decision: receiptMatches({ schemaVersion: 1, requestId, command: input.command as FactCommand, targetRefs, operationDigest, persistedReceipt }, persistedReceipt) ? 'IDEMPOTENT_REPLAY' : 'IDEMPOTENCY_CONFLICT' });
}

type ProposalCommandSnapshot = Readonly<{ proposalRef: string; scope: Scope; status: ProposalStatus; version: number }>;
type FactCommandSnapshot = Readonly<{ factRef: string; scope: Scope; status: CustomerFactStatus; version: number; normalizedValueDigest: string }>;
type NormalizedCommand = Readonly<{
  command: FactCommand;
  actorKind: ActorKind;
  role: CommandRole;
  scope: Scope;
  requestId: string;
  operationDigest: string;
  persistedReceipt?: CommandReceipt;
  targetRefs: readonly string[];
  intent: FactCommandOperationIntent;
  plannerInput: unknown;
  expiryDueAt?: string;
  decisionNow?: number;
  policyVersion?: string;
  currentVersions: readonly number[];
}>;

function validateProposalSnapshot(value: unknown): ProposalCommandSnapshot | Failure {
  if (!isRecord(value) || !hasOnlyKeys(value, ['proposalRef', 'scope', 'status', 'version']) || Object.keys(value).length !== 4) return failure('UNKNOWN_FIELD');
  const proposalRef = validateOpaqueRef(value.proposalRef);
  const scope = validateScope(value.scope);
  const version = validateVersion(value.version);
  if (isFailure(proposalRef)) return proposalRef;
  if (isFailure(scope)) return scope;
  if (isFailure(version)) return version;
  if (typeof value.status !== 'string' || !(['PROPOSED', 'ACCEPTED', 'REJECTED', 'EXPIRED'] as const).includes(value.status as ProposalStatus)) return failure('INVALID_STATUS');
  return { proposalRef, scope, status: value.status as ProposalStatus, version };
}

function validateExpiryProposalSnapshot(value: unknown): Readonly<ProposalCommandSnapshot & { expiresAt?: string; expiryDueAt?: string }> | Failure {
  if (!isRecord(value) || !hasOnlyKeys(value, ['proposalRef', 'scope', 'status', 'version', 'expiresAt', 'expiryDueAt']) || !Object.keys(value).includes('proposalRef')) return failure('UNKNOWN_FIELD');
  if (hasExplicitUndefined(value, 'expiresAt') || hasExplicitUndefined(value, 'expiryDueAt')) return failure('UNKNOWN_FIELD');
  const basic = validateProposalSnapshot({ proposalRef: value.proposalRef, scope: value.scope, status: value.status, version: value.version });
  if (isFailure(basic)) return basic;
  const expiresAt = value.expiresAt === undefined ? undefined : typeof value.expiresAt === 'string' ? value.expiresAt : null;
  const expiryDueAt = value.expiryDueAt === undefined ? undefined : typeof value.expiryDueAt === 'string' ? value.expiryDueAt : null;
  if (expiresAt === null || expiryDueAt === null) return failure('INVALID_TIMESTAMP');
  if (expiresAt !== undefined && isFailure(validateTimestamp(expiresAt))) return failure('INVALID_TIMESTAMP');
  if (expiryDueAt !== undefined && isFailure(validateTimestamp(expiryDueAt))) return failure('INVALID_TIMESTAMP');
  return { ...basic, ...(expiresAt === undefined ? {} : { expiresAt }), ...(expiryDueAt === undefined ? {} : { expiryDueAt }) };
}

function validateFactSnapshot(value: unknown): FactCommandSnapshot | Failure {
  if (!isRecord(value) || !hasOnlyKeys(value, ['factRef', 'scope', 'status', 'version', 'normalizedValueDigest']) || Object.keys(value).length !== 5) return failure('UNKNOWN_FIELD');
  const factRef = validateOpaqueRef(value.factRef);
  const scope = validateScope(value.scope);
  const version = validateVersion(value.version);
  const digest = validateDigest(value.normalizedValueDigest);
  if (isFailure(factRef)) return factRef;
  if (isFailure(scope)) return scope;
  if (isFailure(version)) return version;
  if (isFailure(digest)) return digest;
  if (typeof value.status !== 'string' || !(['CONFIRMED', 'CONFLICT', 'EXPIRED', 'SUPERSEDED', 'INVALIDATED'] as const).includes(value.status as CustomerFactStatus)) return failure('INVALID_STATUS');
  return { factRef, scope, status: value.status as CustomerFactStatus, version, normalizedValueDigest: digest };
}

function validateExpiryFactSnapshot(value: unknown): Readonly<FactCommandSnapshot & { validUntil?: string; expiryDueAt?: string }> | Failure {
  if (!isRecord(value) || !hasOnlyKeys(value, ['factRef', 'scope', 'status', 'version', 'normalizedValueDigest', 'validUntil', 'expiryDueAt'])) return failure('UNKNOWN_FIELD');
  if (hasExplicitUndefined(value, 'validUntil') || hasExplicitUndefined(value, 'expiryDueAt')) return failure('UNKNOWN_FIELD');
  const basic = validateFactSnapshot({ factRef: value.factRef, scope: value.scope, status: value.status, version: value.version, normalizedValueDigest: value.normalizedValueDigest });
  if (isFailure(basic)) return basic;
  const validUntil = value.validUntil === undefined ? undefined : typeof value.validUntil === 'string' ? value.validUntil : null;
  const expiryDueAt = value.expiryDueAt === undefined ? undefined : typeof value.expiryDueAt === 'string' ? value.expiryDueAt : null;
  if (validUntil === null || expiryDueAt === null) return failure('INVALID_TIMESTAMP');
  if (validUntil !== undefined && isFailure(validateTimestamp(validUntil))) return failure('INVALID_TIMESTAMP');
  if (expiryDueAt !== undefined && isFailure(validateTimestamp(expiryDueAt))) return failure('INVALID_TIMESTAMP');
  return { ...basic, ...(validUntil === undefined ? {} : { validUntil }), ...(expiryDueAt === undefined ? {} : { expiryDueAt }) };
}

function validateExpectedVersion(input: Record<string, unknown>, snapshotVersion: number): Failure | undefined {
  const expected = validateVersion(input.expectedVersion);
  if (isFailure(expected)) return expected;
  return expected === snapshotVersion ? undefined : failure('VERSION_MISMATCH');
}

function getExpiryDueAt(snapshot: Readonly<{ expiresAt?: string; validUntil?: string; expiryDueAt?: string }>): Result<Readonly<{ value: string; millis: number }>> {
  const primary = snapshot.expiresAt ?? snapshot.validUntil;
  if (!primary && !snapshot.expiryDueAt) return failure('EXPIRY_TIME_REQUIRED');
  if (primary && snapshot.expiryDueAt) {
    const left = validateTimestamp(primary);
    const right = validateTimestamp(snapshot.expiryDueAt);
    if (isFailure(left) || isFailure(right) || left !== right) return failure('EXPIRY_TIME_CONFLICT');
  }
  const value = snapshot.expiryDueAt ?? primary;
  if (!value) return failure('EXPIRY_TIME_REQUIRED');
  const millis = validateTimestamp(value);
  return isFailure(millis) ? millis : success({ value, millis });
}

function validateReplacement(value: unknown, scope: Scope): Readonly<{ scope: Scope; status: 'CONFIRMED' | 'CONFLICT'; normalizedValueDigest: string }> | Failure {
  if (!isRecord(value) || !hasOnlyKeys(value, ['scope', 'status', 'normalizedValueDigest']) || Object.keys(value).length !== 3) return failure(value === undefined ? 'REPLACEMENT_INVALID' : 'UNKNOWN_FIELD');
  const replacementScope = validateScope(value.scope);
  const digest = validateDigest(value.normalizedValueDigest);
  if (isFailure(replacementScope)) return failure('REPLACEMENT_INVALID');
  if (isFailure(digest)) return failure('REPLACEMENT_INVALID');
  if ((value.status !== 'CONFIRMED' && value.status !== 'CONFLICT') || !sameScope(scope, replacementScope)) return failure('REPLACEMENT_INVALID');
  return { scope: replacementScope, status: value.status, normalizedValueDigest: digest };
}

type ConflictCommandFacts = Readonly<{
  facts: readonly FactCommandSnapshot[];
  expectedVersions: readonly Readonly<{ targetRef: string; expectedVersion: number }>[];
}>;

function validateConflictFacts(value: unknown, scope: Scope): ConflictCommandFacts | Failure {
  if (!Array.isArray(value) || value.length < 2 || value.length > 64) return failure('CONFLICT_FACTS_INVALID');
  const refs = new Set<string>();
  const facts: FactCommandSnapshot[] = [];
  const expectedVersions: Readonly<{ targetRef: string; expectedVersion: number }>[] = [];
  for (const item of value) {
    if (!isRecord(item) || !hasOnlyKeys(item, ['factRef', 'scope', 'status', 'normalizedValueDigest', 'expectedVersion', 'currentVersion']) || Object.keys(item).length !== 6 || hasExplicitUndefined(item, 'expectedVersion') || hasExplicitUndefined(item, 'currentVersion')) return failure('CONFLICT_FACTS_INVALID');
    const factRef = validateOpaqueRef(item.factRef);
    const itemScope = validateScope(item.scope);
    const digest = validateDigest(item.normalizedValueDigest);
    const expectedVersion = validateVersion(item.expectedVersion);
    const currentVersion = validateVersion(item.currentVersion);
    if (isFailure(factRef) || isFailure(itemScope) || isFailure(digest) || isFailure(expectedVersion) || isFailure(currentVersion) || typeof item.status !== 'string' || !(['CONFIRMED', 'CONFLICT', 'EXPIRED', 'SUPERSEDED', 'INVALIDATED'] as const).includes(item.status as CustomerFactStatus)) return failure('CONFLICT_FACTS_INVALID');
    if (refs.has(factRef) || !sameScope(scope, itemScope)) return failure('CONFLICT_FACTS_INVALID');
    refs.add(factRef);
    expectedVersions.push({ targetRef: factRef, expectedVersion });
    facts.push({ factRef, scope: itemScope, status: item.status as CustomerFactStatus, normalizedValueDigest: digest, version: currentVersion });
  }
  facts.sort((left, right) => asciiCompare(left.factRef, right.factRef));
  expectedVersions.sort((left, right) => asciiCompare(left.targetRef, right.targetRef));
  return { facts, expectedVersions };
}

function makeIntent(command: FactCommand, scope: Scope, targetRefs: readonly string[], expectedVersions: readonly Readonly<{ targetRef: string; expectedVersion: number }>[], reasonCode: ReasonCode, replacementValueDigest?: string, expiryDueAt?: string, policyVersion: string | null = null): FactCommandOperationIntent {
  return { schemaVersion: 1, command, targetRefs: [...targetRefs].sort(asciiCompare), scope, expectedVersions: [...expectedVersions].sort((left, right) => asciiCompare(left.targetRef, right.targetRef)), reasonCode, ...(replacementValueDigest === undefined ? {} : { replacementValueDigest }), ...(expiryDueAt === undefined ? {} : { expiryDueAt }), policyVersion };
}

function baseFor(value: Record<string, unknown>, command: FactCommand, extraKeys: readonly string[]): Result<Readonly<{ actorKind: ActorKind; role: CommandRole; scope: Scope; requestId: string; operationDigest: string; persistedReceipt?: CommandReceipt }>> {
  return validateBase(value, command, extraKeys);
}

function normalizeCommand(input: unknown): Result<NormalizedCommand> {
  if (!isRecord(input) || typeof input.command !== 'string' || !FACT_COMMANDS.includes(input.command as FactCommand)) return failure('UNSUPPORTED_ENVELOPE');
  const command = input.command as FactCommand;
  const common = ['snapshot', 'expectedVersion'];
  let base: Result<Readonly<{ actorKind: ActorKind; role: CommandRole; scope: Scope; requestId: string; operationDigest: string; persistedReceipt?: CommandReceipt }>>;
  if (command === 'REJECT_PROPOSAL') {
    base = baseFor(input, command, [...common, 'rejectReasonCode']);
    if (isFailure(base)) return base;
    const snapshot = validateProposalSnapshot(input.snapshot);
    const reason = validateReason(input.rejectReasonCode, REJECT_REASON_CODES);
    if (isFailure(snapshot)) return snapshot;
    if (isFailure(reason)) return reason;
    if (!sameScope(base.value.scope, snapshot.scope)) return failure('SCOPE_MISMATCH');
    const expectedVersion = validateVersion(input.expectedVersion);
    if (isFailure(expectedVersion)) return expectedVersion;
    const intent = makeIntent(command, base.value.scope, [snapshot.proposalRef], [{ targetRef: snapshot.proposalRef, expectedVersion }], reason);
    return success({ ...base.value, command, targetRefs: [snapshot.proposalRef], intent, plannerInput: { schemaVersion: 1, action: 'REJECT', currentStatus: snapshot.status }, currentVersions: [snapshot.version] });
  }
  if (command === 'EXPIRE_PROPOSAL') {
    base = baseFor(input, command, [...common, 'expiryReasonCode', 'decisionNow', 'policyVersion']);
    if (isFailure(base)) return base;
    if (hasExplicitUndefined(input, 'policyVersion')) return failure('UNKNOWN_FIELD');
    const snapshot = validateExpiryProposalSnapshot(input.snapshot);
    const reason = validateReason(input.expiryReasonCode, EXPIRY_REASON_CODES);
    const decisionNow = validateTimestamp(input.decisionNow);
    if (isFailure(snapshot)) return snapshot;
    if (isFailure(reason)) return reason;
    if (isFailure(decisionNow)) return decisionNow;
    const due = getExpiryDueAt(snapshot);
    if (isFailure(due)) return due;
    if (base.value.actorKind === 'SYSTEM' && input.policyVersion !== EXPIRY_POLICY_VERSION) return input.policyVersion === undefined ? failure('POLICY_VERSION_REQUIRED') : failure('INVALID_POLICY_VERSION');
    if (base.value.actorKind === 'USER' && input.policyVersion !== undefined) return failure('INVALID_POLICY_VERSION');
    if (!sameScope(base.value.scope, snapshot.scope)) return failure('SCOPE_MISMATCH');
    const expectedVersion = validateVersion(input.expectedVersion);
    if (isFailure(expectedVersion)) return expectedVersion;
    const policyVersion = base.value.actorKind === 'SYSTEM' ? EXPIRY_POLICY_VERSION : null;
    const intent = makeIntent(command, base.value.scope, [snapshot.proposalRef], [{ targetRef: snapshot.proposalRef, expectedVersion }], reason, undefined, due.value.value, policyVersion);
    return success({ ...base.value, command, targetRefs: [snapshot.proposalRef], intent, plannerInput: { schemaVersion: 1, action: 'EXPIRE', currentStatus: snapshot.status }, expiryDueAt: due.value.value, decisionNow, policyVersion: input.policyVersion as string | undefined, currentVersions: [snapshot.version] });
  }
  if (command === 'EXPIRE_FACT') {
    base = baseFor(input, command, [...common, 'expiryReasonCode', 'decisionNow', 'policyVersion']);
    if (isFailure(base)) return base;
    if (hasExplicitUndefined(input, 'policyVersion')) return failure('UNKNOWN_FIELD');
    const snapshot = validateExpiryFactSnapshot(input.snapshot);
    const reason = validateReason(input.expiryReasonCode, EXPIRY_REASON_CODES);
    const decisionNow = validateTimestamp(input.decisionNow);
    if (isFailure(snapshot)) return snapshot;
    if (isFailure(reason)) return reason;
    if (isFailure(decisionNow)) return decisionNow;
    const due = getExpiryDueAt(snapshot);
    if (isFailure(due)) return due;
    if (base.value.actorKind === 'SYSTEM' && input.policyVersion !== EXPIRY_POLICY_VERSION) return input.policyVersion === undefined ? failure('POLICY_VERSION_REQUIRED') : failure('INVALID_POLICY_VERSION');
    if (base.value.actorKind === 'USER' && input.policyVersion !== undefined) return failure('INVALID_POLICY_VERSION');
    if (!sameScope(base.value.scope, snapshot.scope)) return failure('SCOPE_MISMATCH');
    const expectedVersion = validateVersion(input.expectedVersion);
    if (isFailure(expectedVersion)) return expectedVersion;
    const currentFact: FactStateSnapshot = { factRef: snapshot.factRef, scope: snapshot.scope, status: snapshot.status, normalizedValueDigest: snapshot.normalizedValueDigest, version: snapshot.version };
    const policyVersion = base.value.actorKind === 'SYSTEM' ? EXPIRY_POLICY_VERSION : null;
    const intent = makeIntent(command, base.value.scope, [snapshot.factRef], [{ targetRef: snapshot.factRef, expectedVersion }], reason, undefined, due.value.value, policyVersion);
    return success({ ...base.value, command, targetRefs: [snapshot.factRef], intent, plannerInput: { schemaVersion: 1, action: 'EXPIRE', currentFact }, expiryDueAt: due.value.value, decisionNow, policyVersion: input.policyVersion as string | undefined, currentVersions: [snapshot.version] });
  }
  if (command === 'SUPERSEDE_FACT') {
    base = baseFor(input, command, [...common, 'supersedeReasonCode', 'replacement']);
    if (isFailure(base)) return base;
    const snapshot = validateFactSnapshot(input.snapshot);
    const replacement = validateReplacement(input.replacement, base.value.scope);
    const reason = validateReason(input.supersedeReasonCode, SUPERSEDE_REASON_CODES);
    if (isFailure(snapshot)) return snapshot;
    if (isFailure(replacement)) return replacement;
    if (isFailure(reason)) return reason;
    if (!sameScope(base.value.scope, snapshot.scope)) return failure('SCOPE_MISMATCH');
    const expectedVersion = validateVersion(input.expectedVersion);
    if (isFailure(expectedVersion)) return expectedVersion;
    const currentFact: FactStateSnapshot = snapshot;
    const intent = makeIntent(command, base.value.scope, [snapshot.factRef], [{ targetRef: snapshot.factRef, expectedVersion }], reason, replacement.normalizedValueDigest);
    return success({ ...base.value, command, targetRefs: [snapshot.factRef], intent, plannerInput: { schemaVersion: 1, action: 'SUPERSEDE', currentFact, replacement }, currentVersions: [snapshot.version] });
  }
  if (command === 'INVALIDATE_FACT') {
    base = baseFor(input, command, [...common, 'invalidateReasonCode']);
    if (isFailure(base)) return base;
    const snapshot = validateFactSnapshot(input.snapshot);
    const reason = validateReason(input.invalidateReasonCode, INVALIDATE_REASON_CODES);
    if (isFailure(snapshot)) return snapshot;
    if (isFailure(reason)) return reason;
    if (!sameScope(base.value.scope, snapshot.scope)) return failure('SCOPE_MISMATCH');
    const expectedVersion = validateVersion(input.expectedVersion);
    if (isFailure(expectedVersion)) return expectedVersion;
    const currentFact: FactStateSnapshot = snapshot;
    const intent = makeIntent(command, base.value.scope, [snapshot.factRef], [{ targetRef: snapshot.factRef, expectedVersion }], reason);
    return success({ ...base.value, command, targetRefs: [snapshot.factRef], intent, plannerInput: { schemaVersion: 1, action: 'INVALIDATE', currentFact }, currentVersions: [snapshot.version] });
  }
  base = baseFor(input, command, ['conflictFacts', 'replacement', 'resolutionReasonCode']);
  if (isFailure(base)) return base;
  const facts = validateConflictFacts(input.conflictFacts, base.value.scope);
  const replacement = validateReplacement(input.replacement, base.value.scope);
  const reason = validateReason(input.resolutionReasonCode, RESOLUTION_REASON_CODES);
  if (isFailure(facts)) return facts;
  if (isFailure(replacement)) return replacement;
  if (isFailure(reason)) return reason;
  if (replacement.status !== 'CONFIRMED') return failure('REPLACEMENT_INVALID');
  const targetRefs = facts.facts.map((fact) => fact.factRef);
  const expectedVersions = facts.expectedVersions;
  const intent = makeIntent(command, base.value.scope, targetRefs, expectedVersions, reason, replacement.normalizedValueDigest);
  return success({ ...base.value, command, targetRefs, intent, plannerInput: { schemaVersion: 1, action: 'RESOLVE_CONFLICT', conflictFacts: facts.facts, replacement, resolution: reason === 'INVALIDATE_CONFLICT_SET' ? 'INVALIDATE' : 'SUPERSEDE' }, currentVersions: facts.facts.map((fact) => fact.version) });
}

function planNormalizedCommand(normalized: NormalizedCommand, computed: string): Result<FactCommandPlan> {
  const expectedVersions = [...normalized.intent.expectedVersions].sort((left, right) => asciiCompare(left.targetRef, right.targetRef));
  if (expectedVersions.length !== normalized.currentVersions.length || expectedVersions.some((item, index) => item.expectedVersion !== normalized.currentVersions[index])) return failure('VERSION_MISMATCH');
  if (normalized.expiryDueAt !== undefined && normalized.decisionNow !== undefined) {
    const due = validateTimestamp(normalized.expiryDueAt);
    if (isFailure(due) || normalized.decisionNow < due) return failure('EXPIRY_NOT_DUE');
  }
  if (normalized.command === 'RESOLVE_FACT_CONFLICT') {
    const conflictFacts = (normalized.plannerInput as { conflictFacts: readonly FactStateSnapshot[] }).conflictFacts;
    if (conflictFacts.some((fact) => fact.status !== 'CONFLICT')) return failure('CONFLICT_FACTS_INVALID');
  }
  const underlying = normalized.command === 'REJECT_PROPOSAL' || normalized.command === 'EXPIRE_PROPOSAL'
    ? planProposalTransition(normalized.plannerInput)
    : planFactLifecycleAction(normalized.plannerInput);
  if (!underlying.ok) return failure('STATE_PLAN_REJECTED');
  const underlyingPlan = normalized.command === 'REJECT_PROPOSAL' || normalized.command === 'EXPIRE_PROPOSAL'
    ? {
      ...(underlying.value as Readonly<{ object: 'PROPOSAL'; from: 'PROPOSED'; to: 'REJECTED' | 'EXPIRED' }>),
      proposalUpdate: {
        status: (underlying.value as Readonly<{ to: 'REJECTED' | 'EXPIRED' }>).to,
        expectedVersion: normalized.intent.expectedVersions[0].expectedVersion,
        nextVersion: normalized.intent.expectedVersions[0].expectedVersion + 1,
      },
    }
    : underlying.value;
  const receiptToPersist: CommandReceipt = {
    schemaVersion: 1,
    requestId: normalized.requestId,
    command: normalized.command,
    targetRefs: [...normalized.targetRefs].sort(asciiCompare),
    operationDigest: computed,
    decision: 'COMPLETED',
  };
  return success(deepFreeze({
    schemaVersion: 1,
    decision: 'NEW',
    command: normalized.command,
    atomic: 'ALL_OR_NOTHING',
    underlyingPlan: underlyingPlan as FactCommandPlan['underlyingPlan'],
    receiptToPersist,
  }));
}

export function decideFactCommand(input: unknown): Result<FactCommandPlan | CommandIdempotencyResult> {
  const normalized = normalizeCommand(input);
  if (isFailure(normalized)) return normalized;
  const auth = authorize(normalized.value.command, normalized.value.actorKind, normalized.value.role);
  if (auth) return auth;
  const computed = computeFactCommandOperationDigest(normalized.value.intent);
  if (computed !== normalized.value.operationDigest) return failure('OPERATION_DIGEST_MISMATCH');
  const idempotency = classifyFactCommandIdempotency({
    schemaVersion: 1,
    requestId: normalized.value.requestId,
    command: normalized.value.command,
    targetRefs: normalized.value.targetRefs,
    operationDigest: normalized.value.operationDigest,
    ...(normalized.value.persistedReceipt === undefined ? {} : { persistedReceipt: normalized.value.persistedReceipt }),
  });
  if (isFailure(idempotency)) return idempotency;
  if (idempotency.value.decision === 'IDEMPOTENCY_CONFLICT') return failure('IDEMPOTENCY_CONFLICT');
  if (idempotency.value.decision === 'IDEMPOTENT_REPLAY') return success(idempotency.value);
  return planNormalizedCommand(normalized.value, computed);
}
