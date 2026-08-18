import {
  isValidWebhookSecret,
  loadEvolutionConfig,
  requireEvolutionConfig,
} from './evolution-api-policy';
import { EvolutionApiService } from './evolution-api.service';

const VALID_ENV: NodeJS.ProcessEnv = {
  EVOLUTION_API_ENABLED: 'true',
  EVOLUTION_API_URL: 'http://evolution-api:8080',
  EVOLUTION_API_KEY: 'evolution-key-a1b2c3d4e5f6',
  EVOLUTION_WEBHOOK_SECRET: 'webhook-secret-a1b2c3d4e5f6-ghij',
  BACKEND_URL: 'http://backend:4000',
};

describe('Evolution API fail-closed policy', () => {
  it('is disabled unless explicitly enabled', () => {
    expect(loadEvolutionConfig({})).toEqual({ enabled: false });
    expect(() => requireEvolutionConfig({ EVOLUTION_API_ENABLED: 'false' })).toThrow('disabled');
  });

  it('rejects enabled mode with missing/placeholder secrets', () => {
    expect(() => requireEvolutionConfig({ ...VALID_ENV, EVOLUTION_API_KEY: '' })).toThrow('EVOLUTION_API_KEY');
    expect(() => requireEvolutionConfig({ ...VALID_ENV, EVOLUTION_WEBHOOK_SECRET: 'change-me-secret' }))
      .toThrow('EVOLUTION_WEBHOOK_SECRET');
  });

  it.each(['http://localhost:8080', 'http://127.0.0.1:8080', 'http://[::1]:8080'])(
    'rejects loopback Evolution endpoint %s',
    (apiUrl) => expect(() => requireEvolutionConfig({ ...VALID_ENV, EVOLUTION_API_URL: apiUrl }))
      .toThrow('loopback'),
  );

  it('accepts an explicit internal service URL and callback origin', () => {
    expect(requireEvolutionConfig(VALID_ENV)).toMatchObject({
      enabled: true,
      apiUrl: 'http://evolution-api:8080',
      backendUrl: 'http://backend:4000',
    });
  });

  it('compares webhook secrets without accepting empty or wrong values', () => {
    const expected = VALID_ENV.EVOLUTION_WEBHOOK_SECRET as string;
    expect(isValidWebhookSecret(expected, expected)).toBe(true);
    expect(isValidWebhookSecret('wrong-secret', expected)).toBe(false);
    expect(isValidWebhookSecret('', expected)).toBe(false);
  });
});

describe('Evolution API provider outcome classification', () => {
  afterEach(() => jest.restoreAllMocks());

  function serviceWithConfig() {
    const service = new EvolutionApiService();
    jest.spyOn(service, 'assertEnabled').mockReturnValue({
      enabled: true,
      apiUrl: 'https://evolution.example.test',
      apiKey: 'redacted-test-key',
      webhookSecret: 'redacted-test-secret',
      backendUrl: 'https://backend.example.test',
    } as any);
    return service;
  }

  it('classifies an explicit HTTP 4xx as a proven provider rejection', async () => {
    const service = serviceWithConfig();
    jest.spyOn(global, 'fetch').mockResolvedValue({
      ok: false,
      status: 400,
      json: jest.fn().mockResolvedValue({ code: 'VALIDATION_ERROR' }),
    } as any);

    await expect(service.sendTextMessage('instance-1', '+12025550123', 'hello'))
      .resolves.toMatchObject({
        success: false,
        deliveryOutcome: 'REJECTED',
        providerAccepted: false,
      });
  });

  it.each([
    ['HTTP 5xx', () => Promise.resolve({ ok: false, status: 503, json: jest.fn() } as any)],
    ['HTTP 408', () => Promise.resolve({ ok: false, status: 408, json: jest.fn() } as any)],
    ['HTTP 425', () => Promise.resolve({ ok: false, status: 425, json: jest.fn() } as any)],
    ['HTTP 429', () => Promise.resolve({ ok: false, status: 429, json: jest.fn() } as any)],
    ['proxy HTTP 499', () => Promise.resolve({ ok: false, status: 499, json: jest.fn() } as any)],
    ['network reset', () => Promise.reject(Object.assign(new Error('reset'), { code: 'ECONNRESET' }))],
    ['response parse failure', () => Promise.resolve({
      ok: true,
      status: 200,
      json: jest.fn().mockRejectedValue(new SyntaxError('invalid JSON')),
    } as any)],
  ])('preserves %s as an unknown provider outcome', async (_label, response) => {
    const service = serviceWithConfig();
    jest.spyOn(global, 'fetch').mockImplementation(response as any);

    await expect(service.sendTextMessage('instance-1', '+12025550123', 'hello')).rejects.toThrow();
  });

  it('passes AbortSignal to fetch and cannot enter response parsing after cancellation', async () => {
    const service = serviceWithConfig();
    const json = jest.fn();
    jest.spyOn(global, 'fetch').mockImplementation((_url: any, init: any) => (
      new Promise((_resolve, reject) => {
        init.signal.addEventListener('abort', () => {
          reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
        }, { once: true });
      })
    ) as any);
    const controller = new AbortController();

    const pending = service.sendTextMessage(
      'instance-1',
      '+12025550123',
      'hello',
      controller.signal,
    );
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    expect(global.fetch).toHaveBeenCalledWith(
      expect.stringContaining('/message/sendText/instance-1'),
      expect.objectContaining({ signal: controller.signal }),
    );
    expect(json).not.toHaveBeenCalled();
  });

  it('sends document media with a propagated abort signal and safe receipt metadata', async () => {
    const service = serviceWithConfig();
    jest.spyOn(global, 'fetch').mockResolvedValue({
      ok: true,
      status: 201,
      json: jest.fn().mockResolvedValue({
        key: { id: 'evo-media-1' },
        status: 'PENDING',
        messageTimestamp: 1710000000,
      }),
    } as any);
    const controller = new AbortController();
    await expect(service.sendMediaMessage(
      'instance-1',
      '12025550123',
      { type: 'document', url: 'data:application/pdf;base64,JVBERi0x', filename: 'quote.pdf', mimeType: 'application/pdf' },
      controller.signal,
    )).resolves.toMatchObject({
      success: true,
      messageId: 'evo-media-1',
      metadata: { endpoint: 'sendDocument', status: 'PENDING' },
    });
    expect(global.fetch).toHaveBeenCalledWith(
      expect.stringContaining('/message/sendDocument/instance-1'),
      expect.objectContaining({ signal: controller.signal }),
    );
  });

  it('keeps media 5xx as an unknown provider outcome', async () => {
    const service = serviceWithConfig();
    jest.spyOn(global, 'fetch').mockResolvedValue({
      ok: false,
      status: 503,
      json: jest.fn(),
    } as any);
    await expect(service.sendMediaMessage(
      'instance-1',
      '12025550123',
      { type: 'document', url: 'data:application/pdf;base64,JVBERi0x' },
    )).rejects.toThrow('unknown');
  });
});
