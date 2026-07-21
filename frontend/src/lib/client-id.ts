/**
 * Generate an RFC 4122 version-4 UUID without assuming `crypto.randomUUID`
 * exists. Chromium only exposes randomUUID in a secure context, while the
 * LAN web surface can legitimately run on a private HTTP origin.
 *
 * `crypto.getRandomValues` remains available in that context and preserves
 * the entropy required for an idempotency key. Fail closed if no CSPRNG is
 * available instead of silently falling back to Math.random.
 */
export function createClientUuid(): string {
  const cryptoApi = globalThis.crypto;
  if (typeof cryptoApi?.randomUUID === 'function') return cryptoApi.randomUUID();
  if (typeof cryptoApi?.getRandomValues !== 'function') {
    throw new Error('当前环境缺少安全随机数能力，无法创建请求编号');
  }

  const bytes = cryptoApi.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, (value) => value.toString(16).padStart(2, '0'));
  return [
    hex.slice(0, 4).join(''),
    hex.slice(4, 6).join(''),
    hex.slice(6, 8).join(''),
    hex.slice(8, 10).join(''),
    hex.slice(10, 16).join(''),
  ].join('-');
}
