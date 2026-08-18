import { AiProviderService } from './ai-provider.service';
import { completeAiText } from './ai-client.util';

jest.mock('./ai-client.util', () => ({
  completeAiText: jest.fn(),
}));

describe('AiProviderService public provider error boundary', () => {
  const originalEnv = {
    AI_EXTERNAL_CALLS_ENABLED: process.env.AI_EXTERNAL_CALLS_ENABLED,
    ZHIPU_API_KEY: process.env.ZHIPU_API_KEY,
  };

  afterEach(() => {
    jest.clearAllMocks();
    if (originalEnv.AI_EXTERNAL_CALLS_ENABLED === undefined) delete process.env.AI_EXTERNAL_CALLS_ENABLED;
    else process.env.AI_EXTERNAL_CALLS_ENABLED = originalEnv.AI_EXTERNAL_CALLS_ENABLED;
    if (originalEnv.ZHIPU_API_KEY === undefined) delete process.env.ZHIPU_API_KEY;
    else process.env.ZHIPU_API_KEY = originalEnv.ZHIPU_API_KEY;
  });

  it('does not return or log provider error text', async () => {
    process.env.AI_EXTERNAL_CALLS_ENABLED = 'true';
    process.env.ZHIPU_API_KEY = 'unit-test-zhipu-key';
    const sentinel = 'provider raw response sentinel.customer@example.com +8613800012345 token=secret /srv/customer/provider.json';
    (completeAiText as jest.Mock).mockRejectedValueOnce(new Error(sentinel));
    const service = new AiProviderService();
    const logger = (service as any).logger;
    jest.spyOn(logger, 'error');

    const result = await service.chat('system', 'user', { task: 'summary' });

    expect(result).toEqual(expect.objectContaining({
      success: false,
      content: '[AI] 服务暂时不可用，请稍后重试。',
      error: 'AI_PROVIDER_ERROR',
      reason: 'api_error',
    }));
    expect(result.content).not.toContain(sentinel);
    expect(JSON.stringify(result)).not.toContain(sentinel);
    expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('[ai.provider.call_failed]'));
    expect(logger.error.mock.calls[0][0]).not.toContain(sentinel);
  });
});
