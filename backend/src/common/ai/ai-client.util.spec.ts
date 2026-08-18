import {
  createAiClient,
  getAiApiKey,
  getAiModel,
  getAiProviderStatus,
  getProviderClientConfig,
  getProviderOrder,
} from './ai-client.util';

describe('Zhipu AI provider routing', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
    delete process.env.AI_ROUTE_GENERAL;
    delete process.env.AI_PROVIDER;
    delete process.env.OLLAMA_BASE_URL;
    delete process.env.OPENAI_API_KEY;
    process.env.ZHIPU_API_KEY = 'test-zhipu-key';
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  it('uses the verified GLM model and official OpenAI-compatible endpoint by default', () => {
    expect(getAiApiKey('general')).toBe('test-zhipu-key');
    expect(getAiModel('general')).toBe('glm-4-flash-250414');
    expect(getProviderClientConfig('zhipu')).toMatchObject({
      apiKey: 'test-zhipu-key',
      baseURL: 'https://open.bigmodel.cn/api/paas/v4',
    });
    expect(createAiClient('general')).toBeDefined();
  });

  it('removes DeepSeek and Gemini from every default production route and status', () => {
    for (const task of ['clean', 'profile', 'evidence', 'email', 'research', 'import', 'general'] as const) {
      expect(getProviderOrder(task)[0]).toBe('zhipu');
      expect(getProviderOrder(task).join(',')).not.toMatch(/deepseek|gemini/i);
    }
    expect(getAiProviderStatus().map((item) => item.provider)).toEqual(['zhipu', 'ollama', 'nvidia', 'openai']);
  });

  it('drops unknown or retired providers from an explicit route', () => {
    process.env.AI_ROUTE_GENERAL = 'deepseek,zhipu,gemini,zhipu,ollama';
    expect(getProviderOrder('general')).toEqual(['zhipu', 'ollama']);
  });
});
