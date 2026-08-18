export const ASSISTANT_INTENTS = ['ASK', 'INSIGHT', 'DRAFT', 'ACTION'] as const;
export type AssistantIntent = (typeof ASSISTANT_INTENTS)[number];

export type AssistantQualityStatus = 'PASSED' | 'RETRIED_PASSED' | 'DEGRADED';

export type AssistantResponseDiagnostics = {
  intent: AssistantIntent;
  responseSource: string;
  model: string | null;
  latencyMs: number;
  tools: string[];
  approvalReceipt: string | null;
  qualityStatus: AssistantQualityStatus;
  qualityRetryCount: number;
};

const GREETING_ONLY = /^(?:hi|hello|hey|你好|您好|嗨|早上好|下午好|晚上好)[!！。,.，\s]*$/i;
const FIXED_WELCOME = /(?:我在这里|已经准备好帮助你|准备好帮助您|ready to help you|ready to help you with business questions|请告诉我你需要哪方面的帮助|请告诉我您需要哪方面的帮助).{0,180}(?:客户查询|订单管理|报价处理|customer search|order management|quote processing)/i;
const ACTION_WORDS = /(?:send|reply|create|update|set|schedule|approve|execute|invoke|发送|回复|创建|更新|设置|安排|审批|执行|调用)/i;
const DRAFT_WORDS = /(?:draft|template|prepare|write|compose|quote|email|message|草稿|模板|准备|撰写|报价|邮件|消息)/i;
const INSIGHT_WORDS = /(?:summary|summarize|risk|insight|recommend|next step|brief|分析|摘要|风险|洞察|建议|下一步|简报)/i;

export function inferAssistantIntent(input: {
  message: string;
  actionProposal?: unknown;
  toolReceipts?: unknown[];
  requestedMode?: 'ask' | 'insight' | 'draft' | 'action';
}): AssistantIntent {
  if (input.actionProposal || (input.toolReceipts && input.toolReceipts.length > 0)) return 'ACTION';
  if (input.requestedMode) return input.requestedMode.toUpperCase() as AssistantIntent;
  if (ACTION_WORDS.test(input.message)) return 'ACTION';
  if (DRAFT_WORDS.test(input.message)) return 'DRAFT';
  if (INSIGHT_WORDS.test(input.message)) return 'INSIGHT';
  return 'ASK';
}

export function isFixedWelcomeOrNearTemplate(message: string, output: string): boolean {
  const input = message.trim();
  const content = output.trim();
  if (!input || !content || GREETING_ONLY.test(input)) return false;
  return FIXED_WELCOME.test(content);
}

export function qualityFallbackMessage(intent: AssistantIntent): string {
  return `QUALITY_GATE_DEGRADED: 本次 ${intent} 请求未通过回复质量门禁，系统未将模板化回复持久化为有效结果。请重试；如仍失败，请联系管理员。`;
}

export function buildAssistantDiagnostics(input: AssistantResponseDiagnostics): AssistantResponseDiagnostics {
  return {
    ...input,
    latencyMs: Math.max(0, Math.round(input.latencyMs)),
    tools: [...new Set(input.tools)].sort(),
  };
}
