import { createHash, timingSafeEqual } from 'crypto';

export function digestAgentInput(value: unknown): string {
  return createHash('sha256').update(stableJson(value), 'utf8').digest('hex');
}

export function redactForExternalAi(value: string): string {
  return value
    // Header-style credentials need their own rule because the secret follows
    // the word "Bearer" rather than the ':' separator itself.
    .replace(/(authorization\s*:\s*bearer\s+)[^\s,;]+/gi, '$1[SECRET_REDACTED]')
    .replace(/(\bbearer\s+)(?:eyJ)?[A-Za-z0-9_-]{16,}(?:\.[A-Za-z0-9_-]{8,}){0,2}/gi, '$1[SECRET_REDACTED]')
    // Standard JSON commonly quotes both the sensitive key and its value.
    // Handle it before the unquoted environment/YAML form below and retain
    // only the key plus a fixed marker.
    .replace(
      /((["'])(?:[A-Za-z][A-Za-z0-9_-]{0,63})?(?:API[_-]?KEY|TOKEN|SECRET|PASSWORD|PASSWD|PRIVATE[_-]?KEY|ACCESS[_-]?KEY)\2\s*:\s*)(["'])(?:\\.|(?!\3)[^\\\r\n])*\3/gi,
      '$1$3[SECRET_REDACTED]$3',
    )
    // Match complete environment/JSON keys such as OPENCLAW_GATEWAY_TOKEN,
    // OPENCLAW_CRM_HMAC_SECRET and ZHIPU_API_KEY. A word-boundary before
    // TOKEN/SECRET is not sufficient because '_' is a word character.
    .replace(
      /((?:[A-Za-z][A-Za-z0-9_-]{0,63})?(?:API[_-]?KEY|TOKEN|SECRET|PASSWORD|PASSWD|PRIVATE[_-]?KEY|ACCESS[_-]?KEY)\s*[:=]\s*)(["']?)[^\s,;"'`]+\2/gi,
      '$1$2[SECRET_REDACTED]$2',
    )
    .replace(/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/gi, '[SECRET_REDACTED]')
    .replace(/\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\b/g, '[SECRET_REDACTED]')
    // Last-resort protection for pasted machine credentials. Long raw
    // hexadecimal/base64url blobs are not useful model context; redact them
    // even when the operator omitted the key name.
    .replace(/(?<![A-Za-z0-9_-])(?:[a-f0-9]{48,}|[A-Za-z0-9_-]{64,})(?![A-Za-z0-9_-])/gi, '[SECRET_REDACTED]')
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/gi, '[ID_REDACTED]')
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, '[EMAIL_REDACTED]')
    .replace(/(?<![A-Za-z0-9]-)(?<!\w)(?:\+?\d[\d\s().-]{6,}\d)(?!\w)/g, '[PHONE_REDACTED]')
    .replace(/\b(?:sk|key|token)[-_][A-Za-z0-9_-]{12,}\b/gi, '[SECRET_REDACTED]')
    .replace(
      /(\b(?:api[_-]?key|secret|password|bearer|token)\s*[:=]\s*)(?!\[SECRET_REDACTED\])[^\s,;]+/gi,
      '$1[SECRET_REDACTED]',
    );
}

export function equalAgentDigest(left: string, right: string): boolean {
  if (!/^[a-f0-9]{64}$/i.test(left) || !/^[a-f0-9]{64}$/i.test(right)) return false;
  return timingSafeEqual(Buffer.from(left, 'hex'), Buffer.from(right, 'hex'));
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}
