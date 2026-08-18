import { Injectable, Logger } from '@nestjs/common';
import { completeAiText, AiPurpose, AiRouteTask } from './ai-client.util';
import { safeLogEvent } from '../security/safe-logging';

export interface AiCallOptions {
  task: string;           // e.g. 'translation', 'summary', 'reply_suggestion', 'quote_extraction'
  maxTokens?: number;
  temperature?: number;
}

export interface AiResult {
  success: boolean;
  content: string;
  model?: string;
  error?: string;
  reason?: 'disabled' | 'no_key' | 'api_error' | 'success';
}

@Injectable()
export class AiProviderService {
  private readonly logger = new Logger(AiProviderService.name);

  /** Check if AI external calls are allowed */
  isEnabled(): boolean {
    return process.env.AI_EXTERNAL_CALLS_ENABLED === 'true';
  }

  /** Check if API key is configured */
  hasKey(): boolean {
    const key = process.env.ZHIPU_API_KEY || '';
    return key.length > 0 && !key.includes('your-') && !key.includes('<');
  }

  /** Get the configured model */
  getModel(): string {
    return process.env.ZHIPU_MODEL || process.env.AI_EMAIL_MODEL || 'glm-4-flash-250414';
  }

  /** Get base URL */
  getBaseUrl(): string {
    return process.env.ZHIPU_BASE_URL || 'https://open.bigmodel.cn/api/paas/v4';
  }

  /**
   * Call Zhipu GLM's OpenAI-compatible chat completions API.
   * Safe by default: returns mock content when disabled or key missing.
   */
  async chat(systemPrompt: string, userMessage: string, opts: AiCallOptions = { task: 'general' }): Promise<AiResult> {
    // Safety gate: external calls disabled
    if (!this.isEnabled()) {
      this.logger.warn(safeLogEvent('ai.provider.disabled', { task: opts.task }));
      return this.mockResult(opts.task);
    }

    // Key check
    const apiKey = process.env.ZHIPU_API_KEY || '';
    if (!apiKey || apiKey.includes('your-') || apiKey.includes('<')) {
      this.logger.warn(safeLogEvent('ai.provider.key_missing', { task: opts.task }));
      return this.mockResult(opts.task);
    }

    const purpose = this.resolvePurpose(opts.task);
    const task = this.resolveRouteTask(opts.task);

    try {
      const result = await completeAiText({
        purpose,
        task,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userMessage },
        ],
        maxTokens: opts.maxTokens || 1024,
        temperature: opts.temperature ?? 0.7,
      });
      return { success: true, content: result.text, model: result.model, reason: 'success' };
    } catch (err: any) {
      this.logger.error(safeLogEvent('ai.provider.call_failed', { task: opts.task, error: err }));
      return {
        success: false,
        content: '[AI] 服务暂时不可用，请稍后重试。',
        model: this.getModel(),
        error: 'AI_PROVIDER_ERROR',
        reason: 'api_error',
      };
    }
  }

  private resolvePurpose(task: string): AiPurpose {
    if (/mail|email|reply|translation|summary/i.test(task)) return 'email';
    if (/research/i.test(task)) return 'research';
    if (/import|extract/i.test(task)) return 'import';
    if (/prospect|lead|coach/i.test(task)) return 'prospect';
    return 'general';
  }

  private resolveRouteTask(task: string): AiRouteTask {
    if (/mail|email|reply|translation|summary/i.test(task)) return 'email';
    if (/research/i.test(task)) return 'research';
    if (/import|extract|quote/i.test(task)) return 'import';
    if (/profile|coach/i.test(task)) return 'profile';
    return 'general';
  }

  /** Generate mock content when AI is disabled or unavailable */
  private mockResult(task: string): AiResult {
    const mocks: Record<string, string> = {
      translation: '[AI 翻译] 当前 AI 未启用。请配置智谱 API Key 后使用。',
      summary: '[AI 摘要] AI 服务未配置。配置智谱 API Key 后可自动生成客户需求摘要。',
      reply_suggestion: '[AI 回复建议] 1. 感谢您的询盘，我们将尽快回复。\n2. 请告知具体数量和规格需求。\n3. 如有需要，可联系业务员确认样品政策。',
      quote_extraction: '[AI 报价提取] AI 未启用。请手动填写报价字段。',
      general: '[AI] 服务未配置。',
    };
    return {
      success: false,
      content: mocks[task] || mocks.general,
      reason: this.isEnabled() ? 'no_key' : 'disabled',
    };
  }
}
