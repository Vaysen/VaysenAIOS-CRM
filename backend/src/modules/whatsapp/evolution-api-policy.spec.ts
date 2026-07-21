import {
  isValidWebhookSecret,
  loadEvolutionConfig,
  requireEvolutionConfig,
} from './evolution-api-policy';

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
