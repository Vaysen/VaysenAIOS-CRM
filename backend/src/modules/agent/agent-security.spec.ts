import { digestAgentInput, equalAgentDigest, redactForExternalAi } from './agent-security';

describe('agent security helpers', () => {
  it('creates a stable SHA-256 digest without retaining plaintext', () => {
    const a = digestAgentInput({ brief: 'confidential buyer text', leadId: 'lead-1' });
    const b = digestAgentInput({ leadId: 'lead-1', brief: 'confidential buyer text' });
    expect(a).toMatch(/^[a-f0-9]{64}$/);
    expect(a).toBe(b);
    expect(a).not.toContain('confidential');
  });

  it('redacts internal ids, email, phone and token-shaped secrets before an external AI call', () => {
    const result = redactForExternalAi(
      'Lead 11111111-1111-4111-8111-111111111111, email buyer@example.com, call +1 (816) 579-6304, token token-abcdefghijklmnop, API_KEY=private-value-123',
    );
    expect(result).toContain('[ID_REDACTED]');
    expect(result).toContain('[EMAIL_REDACTED]');
    expect(result).toContain('[PHONE_REDACTED]');
    expect(result).toContain('[SECRET_REDACTED]');
    expect(result).not.toContain('buyer@example.com');
    expect(result).not.toContain('579-6304');
    expect(result).not.toContain('private-value-123');
  });

  it('redacts OpenClaw environment secrets, bearer JWTs and raw high-entropy values', () => {
    const gatewayToken = 'a'.repeat(64);
    const hmacSecret = 'hmac-secret-value-1234567890-abcdef';
    const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJhZG1pbiJ9.signature123456';
    const rawEntropy = 'Z9_'.repeat(24);
    const result = redactForExternalAi([
      `OPENCLAW_GATEWAY_TOKEN=${gatewayToken}`,
      `OPENCLAW_CRM_HMAC_SECRET='${hmacSecret}'`,
      `Authorization: Bearer ${jwt}`,
      `unlabelled ${rawEntropy}`,
    ].join('\n'));

    expect(result).toContain('OPENCLAW_GATEWAY_TOKEN=[SECRET_REDACTED]');
    expect(result).toContain("OPENCLAW_CRM_HMAC_SECRET='[SECRET_REDACTED]'");
    expect(result).toContain('Authorization: Bearer [SECRET_REDACTED]');
    expect(result).not.toContain(gatewayToken);
    expect(result).not.toContain(hmacSecret);
    expect(result).not.toContain(jwt);
    expect(result).not.toContain(rawEntropy);
  });

  it('redacts quoted JSON credential keys without requiring env syntax', () => {
    const apiKey = '12345678.abcdefghijklmno';
    const password = '123456';
    const hmacSecret = 'super-secret-value-1234567890';
    const clientSecret = 'oauth-client-secret-1234567890';
    const refreshToken = 'refresh-token-value-1234567890';
    const json = JSON.stringify({
      ZHIPU_API_KEY: apiKey,
      password,
      hmacSecret,
      clientSecret,
      refreshToken,
      model: 'glm-4-flash',
      secretaryName: 'Alice Example',
    });
    const result = redactForExternalAi(json);

    expect(result).toContain('"ZHIPU_API_KEY":"[SECRET_REDACTED]"');
    expect(result).toContain('"password":"[SECRET_REDACTED]"');
    expect(result).toContain('"hmacSecret":"[SECRET_REDACTED]"');
    expect(result).toContain('"clientSecret":"[SECRET_REDACTED]"');
    expect(result).toContain('"refreshToken":"[SECRET_REDACTED]"');
    expect(result).toContain('"model":"glm-4-flash"');
    expect(result).toContain('"secretaryName":"Alice Example"');
    expect(result).not.toContain(apiKey);
    expect(result).not.toContain(password);
    expect(result).not.toContain(hmacSecret);
    expect(result).not.toContain(clientSecret);
    expect(result).not.toContain(refreshToken);
  });

  it('redacts short explicit password values in env syntax', () => {
    const result = redactForExternalAi('PASSWORD=123456');
    expect(result).toBe('PASSWORD=[SECRET_REDACTED]');
    expect(result).not.toContain('123456');
  });

  it('redacts the complete escaped JSON credential value', () => {
    const password = 'abc"DEF\\secret';
    const input = JSON.stringify({ password, model: 'glm-4-flash' });
    const result = redactForExternalAi(input);

    expect(result).toBe('{"password":"[SECRET_REDACTED]","model":"glm-4-flash"}');
    expect(result).not.toContain('abc');
    expect(result).not.toContain('DEF');
    expect(result).not.toContain('secret');
  });

  it('keeps ordinary quotation and CRM wording intact', () => {
    const text = 'Quote QT-20260712-2511 is USD 0.0697/pc; FOB Shenzhen, MOQ 10,000 pcs.';
    expect(redactForExternalAi(text)).toBe(text);
  });

  it('compares only well-formed digests in constant-time', () => {
    const digest = digestAgentInput({ action: 'future.send' });
    expect(equalAgentDigest(digest, digest)).toBe(true);
    expect(equalAgentDigest(digest, digestAgentInput({ action: 'other' }))).toBe(false);
    expect(equalAgentDigest(digest, 'not-a-digest')).toBe(false);
  });
});
