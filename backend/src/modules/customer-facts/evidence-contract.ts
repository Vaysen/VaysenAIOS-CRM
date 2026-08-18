/**
 * CRM-04A-2: immutable evidence observation contract.
 *
 * This module has no Nest, Prisma, filesystem, network, or clock dependency.
 * The caller supplies validationNow so temporal validation remains explicit
 * and deterministic.
 */

import { createHash } from 'node:crypto';

export const EVIDENCE_KINDS = Object.freeze(['SOURCE_EXCERPT', 'MANUAL_ATTESTATION'] as const);
export type EvidenceKind = (typeof EVIDENCE_KINDS)[number];

export const EVIDENCE_RELATIONS = Object.freeze(['SUPPORTS', 'CONTRADICTS'] as const);
export type EvidenceRelation = (typeof EVIDENCE_RELATIONS)[number];

const SOURCE_EXCERPT_HASH_DOMAIN = 'vaysen-trade-crm/evidence/source-excerpt/v1';
const MANUAL_REASON_HASH_DOMAIN = 'vaysen-trade-crm/evidence/manual-reason/v1';
const MANUAL_INPUT_DIGEST_DOMAIN = 'vaysen-trade-crm/evidence/manual-input/v1';
const SOURCE_EXCERPT_HASH_PREFIX = 'sha256:source-excerpt-v1:';
const MANUAL_REASON_HASH_PREFIX = 'sha256:manual-reason-v1:';
const MANUAL_INPUT_DIGEST_PREFIX = 'sha256:manual-input-v1:';
const MANUAL_ATTESTATION_LOCATOR = 'manual://attestation';

export const MIN_EXCERPT_CODE_POINTS = 8;
export const MAX_EXCERPT_CODE_POINTS = 2_000;
export const MIN_MANUAL_REASON_CODE_POINTS = 8;
export const MAX_MANUAL_REASON_CODE_POINTS = 500;
export const MAX_MANUAL_RAW_INPUT_CODE_POINTS = 4_096;

type SourceExcerptInput = Readonly<{
  schemaVersion: 1;
  kind: 'SOURCE_EXCERPT';
  sourceRef: string;
  excerpt: string;
  locator: string;
  capturedAt: string;
  publishedAt?: string;
}>;

type ManualAttestationInput = Readonly<{
  schemaVersion: 1;
  kind: 'MANUAL_ATTESTATION';
  actorRef: string;
  reason: string;
  rawInput: string;
  inputDigest: string;
  capturedAt: string;
  locator: typeof MANUAL_ATTESTATION_LOCATOR;
}>;

export type EvidenceInput = SourceExcerptInput | ManualAttestationInput;

export type SourceExcerptObservation = Readonly<{
  schemaVersion: 1;
  kind: 'SOURCE_EXCERPT';
  sourceRef: string;
  excerpt: string;
  excerptHash: string;
  locator: string;
  capturedAt: string;
  publishedAt?: string;
}>;

export type ManualAttestationObservation = Readonly<{
  schemaVersion: 1;
  kind: 'MANUAL_ATTESTATION';
  actorRef: string;
  reason: string;
  manualReasonHash: string;
  inputDigest: string;
  capturedAt: string;
  locator: typeof MANUAL_ATTESTATION_LOCATOR;
}>;

export type ImmutableEvidenceObservation = SourceExcerptObservation | ManualAttestationObservation;

export type EvidenceErrorCode =
  | 'UNSUPPORTED_ENVELOPE'
  | 'UNKNOWN_ENVELOPE_FIELD'
  | 'TYPE_MISMATCH'
  | 'INVALID_VALIDATION_NOW'
  | 'INVALID_DATE'
  | 'CAPTURED_AT_FUTURE'
  | 'PUBLISHED_AT_AFTER_CAPTURE'
  | 'INVALID_SOURCE_REF'
  | 'INVALID_ACTOR_REF'
  | 'INVALID_LOCATOR'
  | 'MANUAL_LOCATOR_INVALID'
  | 'EXCERPT_TOO_SHORT'
  | 'EXCERPT_TOO_LONG'
  | 'MANUAL_REASON_TOO_SHORT'
  | 'MANUAL_REASON_TOO_LONG'
  | 'MANUAL_REASON_TOO_VAGUE'
  | 'RAW_INPUT_EMPTY'
  | 'RAW_INPUT_TOO_LONG'
  | 'INVALID_INPUT_DIGEST'
  | 'DIGEST_MISMATCH'
  | 'SENSITIVE_CONTENT_FORBIDDEN'
  | 'RELATION_INVALID';

const ERROR_MESSAGES: Readonly<Record<EvidenceErrorCode, string>> = Object.freeze({
  UNSUPPORTED_ENVELOPE: 'evidence envelope is unsupported',
  UNKNOWN_ENVELOPE_FIELD: 'evidence envelope contains an unknown field',
  TYPE_MISMATCH: 'evidence field has an invalid type',
  INVALID_VALIDATION_NOW: 'validationNow is not a valid UTC instant',
  INVALID_DATE: 'date is not a valid UTC instant',
  CAPTURED_AT_FUTURE: 'capturedAt is later than validationNow',
  PUBLISHED_AT_AFTER_CAPTURE: 'publishedAt is later than capturedAt',
  INVALID_SOURCE_REF: 'sourceRef is not an allowed safe reference',
  INVALID_ACTOR_REF: 'actorRef is not an allowed internal reference',
  INVALID_LOCATOR: 'locator is not an allowed source locator',
  MANUAL_LOCATOR_INVALID: 'manual attestation locator is invalid',
  EXCERPT_TOO_SHORT: 'source excerpt is shorter than the minimum length',
  EXCERPT_TOO_LONG: 'source excerpt exceeds the maximum length',
  MANUAL_REASON_TOO_SHORT: 'manual reason is shorter than the minimum length',
  MANUAL_REASON_TOO_LONG: 'manual reason exceeds the maximum length',
  MANUAL_REASON_TOO_VAGUE: 'manual reason is too vague',
  RAW_INPUT_EMPTY: 'manual raw input must not be empty',
  RAW_INPUT_TOO_LONG: 'manual raw input exceeds the maximum length',
  INVALID_INPUT_DIGEST: 'manual input digest is invalid',
  DIGEST_MISMATCH: 'manual input digest does not match raw input',
  SENSITIVE_CONTENT_FORBIDDEN: 'sensitive content is not allowed in evidence text',
  RELATION_INVALID: 'evidence relation is not allowed',
});

export type EvidenceValidationResult =
  | Readonly<{ ok: true; value: ImmutableEvidenceObservation }>
  | Readonly<{ ok: false; error: Readonly<{ code: EvidenceErrorCode; message: string }> }>;

export type RelationValidationResult =
  | Readonly<{ ok: true; relation: EvidenceRelation }>
  | Readonly<{ ok: false; error: Readonly<{ code: 'RELATION_INVALID'; message: string }> }>;

type FailureResult = Extract<EvidenceValidationResult, { ok: false }>;

const SOURCE_EXCERPT_INPUT_KEYS = Object.freeze([
  'schemaVersion', 'kind', 'sourceRef', 'excerpt', 'locator', 'capturedAt', 'publishedAt',
] as const);
const MANUAL_ATTESTATION_INPUT_KEYS = Object.freeze([
  'schemaVersion', 'kind', 'actorRef', 'reason', 'rawInput', 'inputDigest', 'capturedAt', 'locator',
] as const);

const CREDENTIAL_QUERY_KEYS = new Set([
  'token', 'key', 'secret', 'auth', 'authorization', 'password', 'passwd', 'signature', 'sig',
  'api_key', 'apikey', 'access_key', 'access_token', 'client_secret', 'clientsecret',
  'auth_token', 'authtoken', 'api_token', 'api_secret', 'secret_key', 'private_key',
  'session_token', 'refresh_token', 'id_token', 'bearer_token',
]);

const SOURCE_LOCATOR_PATTERN = /^(?:page|paragraph|line):[1-9][0-9]{0,5}$|^finding:[A-Za-z0-9][A-Za-z0-9._-]{0,127}$|^selector:[^\r\n]{1,256}$/;
const INTERNAL_REF_PATTERN = /^internal:\/\/[a-z][a-z0-9_-]{1,31}\/[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const ACTOR_REF_PATTERN = /^internal:\/\/actor\/[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const UTC_INSTANT_PATTERN = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d{1,3}))?Z$/;
const HASH_HEX = '[0-9a-f]{64}';
const MANUAL_INPUT_DIGEST_PATTERN = new RegExp(`^${MANUAL_INPUT_DIGEST_PREFIX}${HASH_HEX}$`);
const EMAIL_PATTERN = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i;
const WEB_URL_PATTERN = /\bhttps?:\/\/[^\s]+/i;
const AUTHORIZATION_CREDENTIAL_PATTERN = /\bauthorization\s*(?::|=)\s*\S+/i;
const BEARER_TOKEN_PATTERN = /\bbearer\s+(?=[A-Za-z0-9._~+/=-]{8,}\b)[A-Za-z0-9._~+/=-]+/i;
const COOKIE_CREDENTIAL_PATTERN = /\b(?:cookie|set-cookie)\s*(?::|=)\s*\S+/i;
const ASSIGNMENT_SECRET_PATTERN = /\b(?:token|password|passwd|secret|api[_-]?key)\s*[:=]\s*[^\s]+/i;
const ABSOLUTE_WINDOWS_PATH_PATTERN = /(?:[A-Z]:[\\/]|\\\\)/i;
const ABSOLUTE_UNIX_PATH_PATTERN = /(?:^|[\s(])\/(?:home|root|Users)(?:[\\/\s)]|$)/i;
const E164_PHONE_PATTERN = /(?<![\w])\+[1-9]\d{7,14}(?![\w])/;

const VAGUE_MANUAL_REASONS = new Set([
  'ok', 'yes', 'no', 'confirmed', 'confirm', 'verified', 'reviewed', 'valid', 'same',
  'manual confirmation', 'manual check', 'looks good', 'n/a', 'na', 'none', 'test', 'testing',
  '确认', '已确认', '人工确认', '已核实', '同上', '无',
]);

function success(value: ImmutableEvidenceObservation): EvidenceValidationResult {
  return deepFreeze({ ok: true, value });
}

function failure(code: EvidenceErrorCode): FailureResult {
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

function deepFreeze<T>(value: T): T {
  if (value === null || typeof value !== 'object' || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const child of Object.values(value)) deepFreeze(child);
  return value;
}

function normalizeObservationText(value: unknown): string | FailureResult {
  if (typeof value !== 'string') return failure('TYPE_MISMATCH');
  return value.normalize('NFC').replace(/\r\n?/g, '\n').trim();
}

function codePointLength(value: string): number {
  return Array.from(value).length;
}

function validateStrictEnvelope(value: unknown, kind: EvidenceKind): Record<string, unknown> | FailureResult {
  if (!isRecord(value) || value.schemaVersion !== 1 || value.kind !== kind) return failure('UNSUPPORTED_ENVELOPE');
  const allowedKeys = kind === 'SOURCE_EXCERPT' ? SOURCE_EXCERPT_INPUT_KEYS : MANUAL_ATTESTATION_INPUT_KEYS;
  if (Object.keys(value).some((key) => !allowedKeys.includes(key as never))) return failure('UNKNOWN_ENVELOPE_FIELD');
  return value;
}

function parseUtcInstant(value: unknown, invalidCode: 'INVALID_DATE' | 'INVALID_VALIDATION_NOW'): number | FailureResult {
  if (typeof value !== 'string') return failure(invalidCode);
  const match = UTC_INSTANT_PATTERN.exec(value);
  if (!match) return failure(invalidCode);
  const milliseconds = (match[2] ?? '').padEnd(3, '0');
  const canonical = `${match[1]}.${milliseconds}Z`;
  const timestamp = Date.parse(canonical);
  if (!Number.isFinite(timestamp) || new Date(timestamp).toISOString() !== canonical) return failure(invalidCode);
  return timestamp;
}

function canonicalUtcInstant(value: number): string {
  return new Date(value).toISOString();
}

function normalizeQueryKey(value: string): string {
  return value.normalize('NFC').trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
}

function hasCredentialLikeQueryKey(url: URL): boolean {
  for (const [key] of url.searchParams) {
    if (CREDENTIAL_QUERY_KEYS.has(normalizeQueryKey(key))) return true;
  }
  return false;
}

function normalizeSourceRef(value: unknown): string | FailureResult {
  if (typeof value !== 'string') return failure('TYPE_MISMATCH');
  const sourceRef = value.normalize('NFC').trim();
  if (INTERNAL_REF_PATTERN.test(sourceRef)) return sourceRef;
  if (!/^https:\/\//i.test(sourceRef)) return failure('INVALID_SOURCE_REF');

  let url: URL;
  try {
    url = new URL(sourceRef);
  } catch {
    return failure('INVALID_SOURCE_REF');
  }
  if (url.protocol !== 'https:' || !url.hostname || url.username || url.password || hasCredentialLikeQueryKey(url)) {
    return failure('INVALID_SOURCE_REF');
  }
  url.hostname = url.hostname.toLowerCase().replace(/\.$/, '');
  url.hash = '';
  return url.toString();
}

function normalizeActorRef(value: unknown): string | FailureResult {
  if (typeof value !== 'string') return failure('TYPE_MISMATCH');
  const actorRef = value.normalize('NFC').trim();
  return ACTOR_REF_PATTERN.test(actorRef) ? actorRef : failure('INVALID_ACTOR_REF');
}

function normalizeSourceLocator(value: unknown): string | FailureResult {
  if (typeof value !== 'string') return failure('TYPE_MISMATCH');
  const locator = value.normalize('NFC').trim();
  if (!SOURCE_LOCATOR_PATTERN.test(locator)) return failure('INVALID_LOCATOR');
  return containsSensitiveContent(locator) ? failure('SENSITIVE_CONTENT_FORBIDDEN') : locator;
}

function normalizeExcerpt(value: unknown): string | FailureResult {
  const excerpt = normalizeObservationText(value);
  if (typeof excerpt !== 'string') return excerpt;
  const length = codePointLength(excerpt);
  if (length < MIN_EXCERPT_CODE_POINTS) return failure('EXCERPT_TOO_SHORT');
  if (length > MAX_EXCERPT_CODE_POINTS) return failure('EXCERPT_TOO_LONG');
  return excerpt;
}

function normalizeManualReason(value: unknown): string | FailureResult {
  const reason = normalizeObservationText(value);
  if (typeof reason !== 'string') return reason;
  if (containsSensitiveContent(reason)) return failure('SENSITIVE_CONTENT_FORBIDDEN');
  const length = codePointLength(reason);
  if (length < MIN_MANUAL_REASON_CODE_POINTS) return failure('MANUAL_REASON_TOO_SHORT');
  if (length > MAX_MANUAL_REASON_CODE_POINTS) return failure('MANUAL_REASON_TOO_LONG');
  const comparable = reason.toLowerCase();
  if (VAGUE_MANUAL_REASONS.has(comparable) || !/\p{L}/u.test(reason)) return failure('MANUAL_REASON_TOO_VAGUE');
  return reason;
}

function validateManualRawInput(value: unknown): string | FailureResult {
  if (typeof value !== 'string') return failure('TYPE_MISMATCH');
  const normalizedForCheck = normalizeHashInput(value);
  if (!normalizedForCheck.trim()) return failure('RAW_INPUT_EMPTY');
  if (codePointLength(normalizedForCheck) > MAX_MANUAL_RAW_INPUT_CODE_POINTS) return failure('RAW_INPUT_TOO_LONG');
  return value;
}

function validateManualInputDigest(value: unknown): string | FailureResult {
  if (typeof value !== 'string' || !MANUAL_INPUT_DIGEST_PATTERN.test(value)) return failure('INVALID_INPUT_DIGEST');
  return value;
}

function containsSensitiveContent(value: string): boolean {
  return EMAIL_PATTERN.test(value)
    || WEB_URL_PATTERN.test(value)
    || AUTHORIZATION_CREDENTIAL_PATTERN.test(value)
    || BEARER_TOKEN_PATTERN.test(value)
    || COOKIE_CREDENTIAL_PATTERN.test(value)
    || ASSIGNMENT_SECRET_PATTERN.test(value)
    || ABSOLUTE_WINDOWS_PATH_PATTERN.test(value)
    || ABSOLUTE_UNIX_PATH_PATTERN.test(value)
    || E164_PHONE_PATTERN.test(value);
}

function hashWithDomain(domain: string, value: string): string {
  const digest = createHash('sha256').update(`${domain}\0`, 'utf8').update(value, 'utf8').digest('hex');
  return digest;
}

function normalizeHashInput(value: string): string {
  return value.normalize('NFC').replace(/\r\n?/g, '\n');
}

export function normalizeEvidenceExcerpt(rawExcerpt: string): string {
  return normalizeHashInput(rawExcerpt).trim();
}

export function computeExcerptHash(rawExcerpt: string): string {
  return `${SOURCE_EXCERPT_HASH_PREFIX}${hashWithDomain(SOURCE_EXCERPT_HASH_DOMAIN, normalizeEvidenceExcerpt(rawExcerpt))}`;
}

export function computeManualReasonHash(rawReason: string): string {
  return `${MANUAL_REASON_HASH_PREFIX}${hashWithDomain(MANUAL_REASON_HASH_DOMAIN, normalizeEvidenceExcerpt(rawReason))}`;
}

export function computeManualInputDigest(rawInput: string): string {
  if (typeof rawInput !== 'string') throw new TypeError('raw input must be a string');
  return `${MANUAL_INPUT_DIGEST_PREFIX}${hashWithDomain(MANUAL_INPUT_DIGEST_DOMAIN, normalizeHashInput(rawInput))}`;
}

export function validateEvidenceRelation(value: unknown): RelationValidationResult {
  if (value === 'SUPPORTS' || value === 'CONTRADICTS') return Object.freeze({ ok: true, relation: value });
  return Object.freeze({ ok: false, error: Object.freeze({ code: 'RELATION_INVALID' as const, message: ERROR_MESSAGES.RELATION_INVALID }) });
}

export function validateAndNormalizeEvidence(input: unknown, validationNow: string): EvidenceValidationResult {
  const validationTimestamp = parseUtcInstant(validationNow, 'INVALID_VALIDATION_NOW');
  if (typeof validationTimestamp !== 'number') return validationTimestamp;

  if (!isRecord(input) || typeof input.kind !== 'string') return failure('UNSUPPORTED_ENVELOPE');
  if (input.kind === 'SOURCE_EXCERPT') {
    const envelope = validateStrictEnvelope(input, 'SOURCE_EXCERPT');
    if (isFailureResult(envelope)) return envelope;
    const sourceRef = normalizeSourceRef(envelope.sourceRef);
    if (typeof sourceRef !== 'string') return sourceRef;
    const excerpt = normalizeExcerpt(envelope.excerpt);
    if (typeof excerpt !== 'string') return excerpt;
    if (containsSensitiveContent(excerpt)) return failure('SENSITIVE_CONTENT_FORBIDDEN');
    const locator = normalizeSourceLocator(envelope.locator);
    if (typeof locator !== 'string') return locator;
    const capturedTimestamp = parseUtcInstant(envelope.capturedAt, 'INVALID_DATE');
    if (typeof capturedTimestamp !== 'number') return capturedTimestamp;
    if (capturedTimestamp > validationTimestamp) return failure('CAPTURED_AT_FUTURE');

    let publishedAt: string | undefined;
    if (Object.prototype.hasOwnProperty.call(envelope, 'publishedAt')) {
      const publishedTimestamp = parseUtcInstant(envelope.publishedAt, 'INVALID_DATE');
      if (typeof publishedTimestamp !== 'number') return publishedTimestamp;
      if (publishedTimestamp > capturedTimestamp) return failure('PUBLISHED_AT_AFTER_CAPTURE');
      publishedAt = canonicalUtcInstant(publishedTimestamp);
    }
    return success({
      schemaVersion: 1,
      kind: 'SOURCE_EXCERPT',
      sourceRef,
      excerpt,
      excerptHash: computeExcerptHash(excerpt),
      locator,
      capturedAt: canonicalUtcInstant(capturedTimestamp),
      ...(publishedAt ? { publishedAt } : {}),
    });
  }

  if (input.kind === 'MANUAL_ATTESTATION') {
    const envelope = validateStrictEnvelope(input, 'MANUAL_ATTESTATION');
    if (isFailureResult(envelope)) return envelope;
    const actorRef = normalizeActorRef(envelope.actorRef);
    if (typeof actorRef !== 'string') return actorRef;
    const reason = normalizeManualReason(envelope.reason);
    if (typeof reason !== 'string') return reason;
    const rawInput = validateManualRawInput(envelope.rawInput);
    if (typeof rawInput !== 'string') return rawInput;
    const inputDigest = validateManualInputDigest(envelope.inputDigest);
    if (typeof inputDigest !== 'string') return inputDigest;
    if (inputDigest !== computeManualInputDigest(rawInput)) return failure('DIGEST_MISMATCH');
    if (envelope.locator !== MANUAL_ATTESTATION_LOCATOR) return failure('MANUAL_LOCATOR_INVALID');
    const capturedTimestamp = parseUtcInstant(envelope.capturedAt, 'INVALID_DATE');
    if (typeof capturedTimestamp !== 'number') return capturedTimestamp;
    if (capturedTimestamp > validationTimestamp) return failure('CAPTURED_AT_FUTURE');
    return success({
      schemaVersion: 1,
      kind: 'MANUAL_ATTESTATION',
      actorRef,
      reason,
      manualReasonHash: computeManualReasonHash(reason),
      inputDigest,
      capturedAt: canonicalUtcInstant(capturedTimestamp),
      locator: MANUAL_ATTESTATION_LOCATOR,
    });
  }

  return failure('UNSUPPORTED_ENVELOPE');
}
