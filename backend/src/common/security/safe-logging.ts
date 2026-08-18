import { createHash } from 'node:crypto';

const DIGEST_LENGTH = 16;
const SAFE_EVENT_CODE = /^[a-z0-9_.:-]{1,80}$/i;
const HTTP_METHODS = new Set(['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS', 'TRACE', 'CONNECT']);
const NUMERIC_KEYS = new Set(['bytes', 'contentBytes', 'count', 'durationMs']);
const BOOLEAN_KEYS = new Set(['isGroup', 'accepted', 'hasAttachment', 'matched']);
const LABEL_KEYS = new Set([
  'status',
  'method',
  'contentType',
  'reasonCode',
  'providerStatus',
  'stage',
  'direction',
  'errorCategory',
]);
const OPERATIONAL_LABELS: Record<string, ReadonlySet<string>> = {
  status: new Set([
    'accepted', 'active', 'blocked', 'closed', 'connected', 'connecting', 'delivered',
    'disconnected', 'error', 'failed', 'ignored', 'inactive', 'logged_in', 'offline',
    'open', 'pending', 'ready', 'read', 'reconnecting', 'rejected', 'sent', 'success',
    'unknown', 'updated', 'warning',
  ]),
  contentType: new Set(['audio', 'document', 'html', 'image', 'json', 'text', 'video']),
  providerStatus: new Set(['accepted', 'connected', 'delivered', 'disconnected', 'failed', 'pending', 'read', 'rejected', 'sent', 'timeout', 'unknown']),
  reasonCode: new Set(['email_send_disabled']),
  stage: new Set(['dispatch', 'projection', 'reservation', 'verification']),
  direction: new Set(['inbound', 'outbound']),
  errorCategory: new Set(['internal_error', 'network', 'provider_failure', 'rejected', 'timeout']),
};

export type SafeLogFields = Record<string, unknown>;

/**
 * Produces a non-reversible, domain-separated identifier for diagnostics.
 * The original value must never be appended to the returned string.
 */
export function safeDigest(value: unknown, domain: string): string {
  const normalizedDomain = domain.trim().toLowerCase() || 'value';
  const normalizedValue = String(value ?? '');
  const digest = createHash('sha256')
    .update(`${normalizedDomain}\u0000${normalizedValue}`, 'utf8')
    .digest('hex')
    .slice(0, DIGEST_LENGTH);
  return `sha256:${normalizedDomain}:${digest}`;
}

/**
 * Removes query and fragment components while retaining the request path.
 */
export function safeRequestPath(rawUrl: unknown): string {
  const value = String(rawUrl ?? '');
  if (!value) return '/';
  try {
    return new URL(value, 'http://127.0.0.1').pathname || '/';
  } catch {
    return value.split(/[?#]/, 1)[0] || '/';
  }
}

/**
 * Maps an internal error to an operational category without emitting its text,
 * provider response, URL, or stack.
 */
export function safeErrorCategory(error: unknown): string {
  const candidate = error as { code?: unknown; status?: unknown; response?: { status?: unknown }; message?: unknown } | null;
  const code = String(candidate?.code ?? '').toLowerCase();
  const status = Number(candidate?.status ?? candidate?.response?.status);
  const message = String(candidate?.message ?? error ?? '').toLowerCase();
  if (code.includes('timeout') || code === 'etimedout' || message.includes('timeout')) return 'timeout';
  if (code.includes('econn') || code.includes('network') || message.includes('network')) return 'network';
  if (Number.isFinite(status) && status >= 400 && status < 500) return 'rejected';
  if (Number.isFinite(status) && status >= 500) return 'provider_failure';
  return 'internal_error';
}

/**
 * Formats a structured log line from a small operational allowlist. Unknown or
 * sensitive-looking fields are represented by a domain-separated digest or a
 * safe error category, never by their original value.
 */
export function safeLogEvent(eventCode: string, fields: SafeLogFields = {}): string {
  const event = SAFE_EVENT_CODE.test(eventCode) ? eventCode : safeDigest(eventCode, 'event');
  const safeFields: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(fields)) {
    if (value === undefined) continue;
    if (key === 'error' || key === 'stack') {
      if (key === 'error') safeFields.errorCategory = safeErrorCategory(value);
      continue;
    }
    if (key === 'eventType') {
      safeFields.eventType = safeEventType(value);
      continue;
    }
    if (key === 'requestPath') {
      safeFields.requestPath = safeRequestPath(value);
      continue;
    }
    const validated = validateOperationalField(key, value);
    if (validated.accept) {
      safeFields[key] = validated.value;
      continue;
    }
    safeFields[`${key}Digest`] = safeDigest(value, key);
  }

  return `[${event}] ${JSON.stringify(safeFields)}`;
}

function safeEventType(value: unknown): string {
  const candidate = String(value ?? '');
  return SAFE_EVENT_CODE.test(candidate) ? candidate : safeDigest(candidate, 'event-type');
}

function validateOperationalField(key: string, value: unknown): { accept: true; value: string | number | boolean } | { accept: false } {
  if (key === 'method') {
    return typeof value === 'string' && HTTP_METHODS.has(value) ? { accept: true, value } : { accept: false };
  }
  if (NUMERIC_KEYS.has(key)) {
    return typeof value === 'number' && Number.isFinite(value) && value >= 0
      ? { accept: true, value }
      : { accept: false };
  }
  if (BOOLEAN_KEYS.has(key)) {
    return typeof value === 'boolean' ? { accept: true, value } : { accept: false };
  }
  if (LABEL_KEYS.has(key)) {
    const normalized = typeof value === 'string' ? value.toLowerCase() : '';
    const allowed = OPERATIONAL_LABELS[key];
    return allowed?.has(normalized) ? { accept: true, value: String(value) } : { accept: false };
  }
  return { accept: false };
}
