import OpenAI from 'openai';

export type AiPurpose = 'email' | 'prospect' | 'research' | 'import' | 'general';
export type AiRouteTask = 'clean' | 'profile' | 'evidence' | 'email' | 'research' | 'import' | 'general';
export type ProviderName = 'zhipu' | 'ollama' | 'nvidia' | 'openai';

type AiMessage = { role: 'system' | 'user' | 'assistant'; content: string };
type AiCompleteInput = {
  purpose?: AiPurpose;
  task?: AiRouteTask;
  messages: AiMessage[];
  temperature?: number;
  maxTokens?: number;
};

const PROVIDERS: readonly ProviderName[] = ['zhipu', 'ollama', 'nvidia', 'openai'];
const ZHIPU_BASE_URL = 'https://open.bigmodel.cn/api/paas/v4';
const ZHIPU_MODEL = 'glm-4-flash-250414';

const purposeKeyEnv: Record<AiPurpose, string[]> = {
  email: ['EMAIL_AI_API_KEY', 'ZHIPU_EMAIL_API_KEY', 'ZHIPU_API_KEY', 'OPENAI_API_KEY'],
  prospect: ['PROSPECT_AI_API_KEY', 'ZHIPU_PROSPECT_API_KEY', 'ZHIPU_API_KEY', 'OPENAI_API_KEY'],
  research: ['RESEARCH_AI_API_KEY', 'ZHIPU_RESEARCH_API_KEY', 'ZHIPU_API_KEY', 'OPENAI_API_KEY'],
  import: ['IMPORT_AI_API_KEY', 'ZHIPU_IMPORT_API_KEY', 'ZHIPU_API_KEY', 'OPENAI_API_KEY'],
  general: ['ZHIPU_API_KEY', 'OPENAI_API_KEY'],
};

const purposeBaseEnv: Record<AiPurpose, string[]> = {
  email: ['EMAIL_AI_BASE_URL', 'OLLAMA_BASE_URL', 'ZHIPU_EMAIL_BASE_URL', 'ZHIPU_BASE_URL', 'OPENAI_BASE_URL'],
  prospect: ['PROSPECT_AI_BASE_URL', 'ZHIPU_PROSPECT_BASE_URL', 'ZHIPU_BASE_URL', 'OPENAI_BASE_URL'],
  research: ['RESEARCH_AI_BASE_URL', 'ZHIPU_RESEARCH_BASE_URL', 'ZHIPU_BASE_URL', 'OPENAI_BASE_URL'],
  import: ['IMPORT_AI_BASE_URL', 'ZHIPU_IMPORT_BASE_URL', 'ZHIPU_BASE_URL', 'OPENAI_BASE_URL'],
  general: ['ZHIPU_BASE_URL', 'OPENAI_BASE_URL'],
};

const purposeModelEnv: Record<AiPurpose, string[]> = {
  email: ['EMAIL_AI_MODEL', 'OLLAMA_MODEL', 'ZHIPU_EMAIL_MODEL', 'ZHIPU_MODEL', 'OPENAI_MODEL'],
  prospect: ['PROSPECT_AI_MODEL', 'ZHIPU_PROSPECT_MODEL', 'ZHIPU_MODEL', 'OPENAI_MODEL'],
  research: ['RESEARCH_AI_MODEL', 'ZHIPU_RESEARCH_MODEL', 'ZHIPU_MODEL', 'OPENAI_MODEL'],
  import: ['IMPORT_AI_MODEL', 'ZHIPU_IMPORT_MODEL', 'ZHIPU_MODEL', 'OPENAI_MODEL'],
  general: ['ZHIPU_MODEL', 'OPENAI_MODEL'],
};

const nvidiaLimiter = { windowStartedAt: 0, count: 0 };

function firstEnv(keys: string[]) {
  for (const key of keys) {
    const value = process.env[key];
    if (value) return value;
  }
  return undefined;
}

function normalizeBaseUrl(url: string | undefined) {
  return url?.replace(/\/$/, '');
}

function usesOllama(purpose: AiPurpose) {
  const provider = process.env[`${purpose.toUpperCase()}_AI_PROVIDER`] || process.env.AI_PROVIDER || '';
  const baseUrl = firstEnv(purposeBaseEnv[purpose]) || '';
  return provider.toLowerCase() === 'ollama' || /127\.0\.0\.1:11434|localhost:11434/i.test(baseUrl);
}

export function getAiApiKey(purpose: AiPurpose): string {
  if (usesOllama(purpose)) return process.env.OLLAMA_API_KEY || 'ollama';
  return firstEnv(purposeKeyEnv[purpose]) || 'sk-placeholder';
}

export function createAiClient(purpose: AiPurpose) {
  return new OpenAI({
    timeout: 30000,
    apiKey: getAiApiKey(purpose),
    baseURL: firstEnv(purposeBaseEnv[purpose]) || (usesOllama(purpose) ? 'http://127.0.0.1:11434/v1' : ZHIPU_BASE_URL),
  });
}

export function getAiModel(purpose: AiPurpose = 'general') {
  return firstEnv(purposeModelEnv[purpose]) || (usesOllama(purpose) ? 'qwen2.5:7b' : ZHIPU_MODEL);
}

export function getProviderOrder(task: AiRouteTask = 'general'): ProviderName[] {
  const explicit = process.env[`AI_ROUTE_${task.toUpperCase()}`];
  if (explicit) {
    return [...new Set(explicit.split(',').map((item) => item.trim().toLowerCase())
      .filter((item): item is ProviderName => PROVIDERS.includes(item as ProviderName)))];
  }
  const defaults: Record<AiRouteTask, ProviderName[]> = {
    clean: ['zhipu', 'ollama', 'nvidia'],
    profile: ['zhipu', 'ollama', 'nvidia'],
    evidence: ['zhipu', 'nvidia'],
    email: ['zhipu', 'ollama'],
    research: ['zhipu', 'nvidia'],
    import: ['zhipu', 'ollama'],
    general: ['zhipu', 'nvidia', 'ollama'],
  };
  return defaults[task];
}

function providerReady(provider: ProviderName) {
  if (provider === 'zhipu') return Boolean(process.env.ZHIPU_API_KEY);
  if (provider === 'ollama') return Boolean(process.env.OLLAMA_BASE_URL || process.env.AI_PROVIDER === 'ollama');
  if (provider === 'nvidia') return Boolean(process.env.NVIDIA_API_KEY);
  return Boolean(process.env.OPENAI_API_KEY);
}

function providerModel(provider: ProviderName, purpose: AiPurpose, task: AiRouteTask) {
  if (provider === 'zhipu') return firstEnv(purposeModelEnv[purpose]) || ZHIPU_MODEL;
  if (provider === 'ollama') {
    if (task === 'clean' || task === 'profile') return process.env.OLLAMA_FAST_MODEL || process.env.OLLAMA_MODEL || 'qwen2.5:3b';
    return process.env.OLLAMA_STRONG_MODEL || process.env.OLLAMA_MODEL || 'qwen2.5:7b';
  }
  if (provider === 'nvidia') return process.env.NVIDIA_MODEL || 'meta/llama-3.1-70b-instruct';
  return process.env.OPENAI_MODEL || 'gpt-4o-mini';
}

export function getProviderClientConfig(provider: ProviderName) {
  if (provider === 'zhipu') return { timeout: 30000, apiKey: process.env.ZHIPU_API_KEY || 'missing', baseURL: normalizeBaseUrl(process.env.ZHIPU_BASE_URL) || ZHIPU_BASE_URL };
  if (provider === 'ollama') return { timeout: 30000, apiKey: process.env.OLLAMA_API_KEY || 'ollama', baseURL: normalizeBaseUrl(process.env.OLLAMA_BASE_URL) || 'http://127.0.0.1:11434/v1' };
  if (provider === 'nvidia') return { timeout: 30000, apiKey: process.env.NVIDIA_API_KEY || 'missing', baseURL: normalizeBaseUrl(process.env.NVIDIA_BASE_URL) || 'https://integrate.api.nvidia.com/v1' };
  return { timeout: 30000, apiKey: process.env.OPENAI_API_KEY || 'missing', baseURL: normalizeBaseUrl(process.env.OPENAI_BASE_URL) || 'https://api.openai.com/v1' };
}

async function waitForNvidiaSlot() {
  const rpm = Math.max(1, Number(process.env.NVIDIA_RPM || 40));
  const now = Date.now();
  if (!nvidiaLimiter.windowStartedAt || now - nvidiaLimiter.windowStartedAt >= 60_000) {
    nvidiaLimiter.windowStartedAt = now;
    nvidiaLimiter.count = 0;
  }
  if (nvidiaLimiter.count < rpm) {
    nvidiaLimiter.count += 1;
    return;
  }
  await new Promise((resolve) => setTimeout(resolve, Math.max(100, 60_000 - (now - nvidiaLimiter.windowStartedAt))));
  nvidiaLimiter.windowStartedAt = Date.now();
  nvidiaLimiter.count = 1;
}

export async function completeAiText(input: AiCompleteInput) {
  const purpose = input.purpose || 'general';
  const task = input.task || 'general';
  const errors: string[] = [];
  for (const provider of getProviderOrder(task)) {
    if (!providerReady(provider)) continue;
    const model = providerModel(provider, purpose, task);
    try {
      if (provider === 'nvidia') await waitForNvidiaSlot();
      const client = new OpenAI(getProviderClientConfig(provider));
      const response = await client.chat.completions.create({
        model,
        messages: input.messages,
        temperature: input.temperature ?? 0.2,
        max_tokens: input.maxTokens ?? 1600,
      });
      const text = response.choices[0]?.message?.content || '';
      if (text.trim()) return { text, provider, model };
      throw new Error('empty response');
    } catch (error: any) {
      errors.push(`${provider}: ${error.message || error}`);
    }
  }
  throw new Error(`No AI provider completed ${task}: ${errors.join(' | ') || 'no provider configured'}`);
}

export async function completeAiJson<T = any>(input: AiCompleteInput): Promise<{ data: T; text: string; provider: string; model: string }> {
  const result = await completeAiText(input);
  const clean = result.text.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
  let parsed: any;
  try {
    parsed = JSON.parse(clean);
  } catch {
    const match = clean.match(/\[[\s\S]*\]/)?.[0] || clean.match(/\{[\s\S]*\}/)?.[0];
    if (!match) throw new Error(`AI response was not JSON from ${result.provider}`);
    parsed = JSON.parse(match);
  }
  return { data: parsed as T, text: result.text, provider: result.provider, model: result.model };
}

export function getAiProviderStatus() {
  return PROVIDERS.map((provider) => ({
    provider,
    configured: providerReady(provider),
    model: providerModel(provider, 'general', 'general'),
    rpm: provider === 'nvidia' ? Number(process.env.NVIDIA_RPM || 40) : undefined,
    baseUrl: getProviderClientConfig(provider).baseURL,
  }));
}
