import { ConflictException, ServiceUnavailableException, UnauthorizedException } from '@nestjs/common';
import { createHash, createHmac } from 'crypto';
import { OpenClawHmacGuard } from './openclaw-hmac.guard';

const PATH = '/api/internal/openclaw/tools/work-brief';
const SECRET = 's'.repeat(64);

function signedRequest(body: object, overrides: Record<string, string> = {}) {
  const rawBody = Buffer.from(JSON.stringify(body));
  const timestamp = overrides.timestamp || String(Math.floor(Date.now() / 1000));
  const nonce = overrides.nonce || 'nonce-1234567890-abcdef';
  const bodyDigest = createHash('sha256').update(rawBody).digest('hex');
  const canonical = `${timestamp}\n${nonce}\nPOST\n${PATH}\n${bodyDigest}`;
  const signature = createHmac('sha256', SECRET).update(canonical).digest('hex');
  return {
    method: 'POST',
    originalUrl: PATH,
    url: PATH,
    rawBody,
    headers: {
      'x-openclaw-key-id': 'crm-key-1',
      'x-openclaw-timestamp': timestamp,
      'x-openclaw-nonce': nonce,
      'x-openclaw-signature': overrides.signature || signature,
    },
  };
}

function executionContext(request: any): any {
  return { switchToHttp: () => ({ getRequest: () => request }) };
}

describe('OpenClawHmacGuard', () => {
  let prisma: any;
  let guard: OpenClawHmacGuard;

  beforeEach(() => {
    process.env.OPENCLAW_CRM_HMAC_KEY_ID = 'crm-key-1';
    process.env.OPENCLAW_CRM_HMAC_SECRET = SECRET;
    prisma = { openClawRequestNonce: { create: jest.fn().mockResolvedValue({ id: 'nonce-1' }) } };
    guard = new OpenClawHmacGuard(prisma);
  });

  afterEach(() => {
    delete process.env.OPENCLAW_CRM_HMAC_KEY_ID;
    delete process.env.OPENCLAW_CRM_HMAC_SECRET;
  });

  it('verifies the exact raw body and consumes a SHA-256 nonce receipt', async () => {
    const request: any = signedRequest({ actor: { channel: 'openclaw-weixin' } });
    await expect(guard.canActivate(executionContext(request))).resolves.toBe(true);
    expect(request.openClawVerified).toEqual(expect.objectContaining({
      bodyDigest: createHash('sha256').update(request.rawBody).digest('hex'),
      keyId: 'crm-key-1',
      canonicalPath: PATH,
    }));
    expect(prisma.openClawRequestNonce.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        keyId: 'crm-key-1',
        nonceDigest: expect.stringMatching(/^[a-f0-9]{64}$/),
      }),
    });
  });

  it('rejects a signature if even one raw byte changes', async () => {
    const request: any = signedRequest({ value: 1 });
    request.rawBody = Buffer.from('{"value":2}');
    await expect(guard.canActivate(executionContext(request))).rejects.toBeInstanceOf(UnauthorizedException);
    expect(prisma.openClawRequestNonce.create).not.toHaveBeenCalled();
  });

  it('rejects an expired timestamp before consuming a nonce', async () => {
    const request = signedRequest({}, { timestamp: String(Math.floor(Date.now() / 1000) - 61) });
    await expect(guard.canActivate(executionContext(request))).rejects.toThrow('Expired OpenClaw request');
    expect(prisma.openClawRequestNonce.create).not.toHaveBeenCalled();
  });

  it('rejects a replay when the nonce unique constraint is already occupied', async () => {
    prisma.openClawRequestNonce.create.mockRejectedValue({ code: 'P2002' });
    await expect(guard.canActivate(executionContext(signedRequest({})))).rejects.toBeInstanceOf(ConflictException);
  });

  it('fails closed when Nest raw-body capture or the 48-byte secret is missing', async () => {
    const noRaw: any = signedRequest({});
    delete noRaw.rawBody;
    await expect(guard.canActivate(executionContext(noRaw))).rejects.toBeInstanceOf(ServiceUnavailableException);

    process.env.OPENCLAW_CRM_HMAC_SECRET = 'too-short';
    await expect(guard.canActivate(executionContext(signedRequest({})))).rejects.toBeInstanceOf(ServiceUnavailableException);
  });
});
