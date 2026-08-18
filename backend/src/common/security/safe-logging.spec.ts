import { safeDigest, safeErrorCategory, safeLogEvent, safeRequestPath } from './safe-logging';

describe('safe logging', () => {
  const sentinelEmail = 'sentinel.customer@example.com';
  const sentinelPhone = '+8613800012345';
  const sentinelJid = '8613800012345@s.whatsapp.net';
  const sentinelBody = 'Sentinel private customer message body';
  const sentinelUrl = 'https://example.test/hook?token=sentinel-token&password=sentinel-password';
  const windowsPath = 'C:\\Users\\customer\\uploads\\quote.pdf';
  const linuxPath = '/srv/vaysen-crm/uploads/customer/quote.pdf';

  it('uses a fixed domain separator and never returns the original value', () => {
    const result = safeDigest(sentinelEmail, 'email');
    expect(result).toMatch(/^sha256:email:[0-9a-f]{16}$/);
    expect(result).not.toContain(sentinelEmail);
    expect(safeDigest(sentinelEmail, 'email')).not.toBe(safeDigest(sentinelEmail, 'phone'));
  });

  it('keeps only the path from request URLs', () => {
    expect(safeRequestPath('/api/messages?token=sentinel-token#fragment')).toBe('/api/messages');
    expect(safeRequestPath(sentinelUrl)).toBe('/hook');
    expect(safeRequestPath('not a URL?token=sentinel-token')).toBe('/not%20a%20URL');
  });

  it('does not emit sentinel PII, body, URL secrets, or absolute paths', () => {
    const output = safeLogEvent('security.sentinel', {
      email: sentinelEmail,
      phone: sentinelPhone,
      jid: sentinelJid,
      message: sentinelBody,
      url: sentinelUrl,
      filePath: windowsPath,
      attachmentPath: linuxPath,
      status: 'failed',
      contentType: 'document',
      bytes: 128,
    });

    for (const value of [sentinelEmail, sentinelPhone, sentinelJid, sentinelBody, sentinelUrl, windowsPath, linuxPath, 'sentinel-token', 'sentinel-password']) {
      expect(output).not.toContain(value);
    }
    expect(output).toContain('"status":"failed"');
    expect(output).toContain('"contentType":"document"');
    expect(output).toContain('"bytes":128');
    expect(output).toContain('sha256:email:');
    expect(output).toContain('sha256:phone:');
    expect(output).toContain('sha256:jid:');
  });

  it('does not trust sensitive values placed into operational allowlist keys', () => {
    const output = safeLogEvent('security.allowlist_sentinel', {
      method: sentinelEmail,
      bytes: sentinelPhone,
      contentBytes: sentinelUrl,
      count: sentinelBody,
      durationMs: sentinelEmail,
      isGroup: sentinelPhone,
      accepted: sentinelUrl,
      hasAttachment: sentinelBody,
      matched: sentinelBody,
      status: sentinelEmail,
      contentType: sentinelPhone,
      providerStatus: sentinelUrl,
      reasonCode: sentinelBody,
      stage: sentinelEmail,
      direction: sentinelPhone,
      errorCategory: sentinelUrl,
    });

    for (const value of [sentinelEmail, sentinelPhone, sentinelUrl, sentinelBody, 'sentinel-token', 'sentinel-password']) {
      expect(output).not.toContain(value);
    }
  });

  it('retains only valid HTTP methods, labels, booleans, and finite non-negative numbers', () => {
    const output = safeLogEvent('security.allowlist_valid', {
      method: 'GET',
      status: 'accepted',
      contentType: 'text',
      providerStatus: 'accepted',
      reasonCode: 'EMAIL_SEND_DISABLED',
      stage: 'dispatch',
      direction: 'outbound',
      errorCategory: 'timeout',
      bytes: 12,
      contentBytes: 13,
      count: 2,
      durationMs: 4.5,
      isGroup: false,
      accepted: true,
      hasAttachment: false,
      matched: true,
    });

    for (const expected of [
      '"method":"GET"', '"status":"accepted"', '"contentType":"text"',
      '"providerStatus":"accepted"', '"reasonCode":"EMAIL_SEND_DISABLED"',
      '"stage":"dispatch"', '"direction":"outbound"', '"errorCategory":"timeout"',
      '"bytes":12', '"contentBytes":13', '"count":2', '"durationMs":4.5',
      '"isGroup":false', '"accepted":true', '"hasAttachment":false', '"matched":true',
    ]) {
      expect(output).toContain(expected);
    }
  });

  it('emits only a stable error category', () => {
    const output = safeLogEvent('provider.send_failed', {
      error: new Error(`provider response contains ${sentinelBody} ${sentinelUrl}`),
      stack: `at send (${windowsPath}:1:1)`,
    });
    expect(output).toBe('[provider.send_failed] {"errorCategory":"internal_error"}');
    expect(output).not.toContain(sentinelBody);
    expect(output).not.toContain(sentinelUrl);
    expect(output).not.toContain(windowsPath);
    expect(safeErrorCategory({ code: 'ETIMEDOUT' })).toBe('timeout');
    expect(safeErrorCategory({ response: { status: 503 } })).toBe('provider_failure');
    expect(safeErrorCategory({ response: { status: 400 } })).toBe('rejected');
  });
});
