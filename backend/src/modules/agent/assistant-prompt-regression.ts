export const ASSISTANT_PROMPT_CATEGORIES = [
  'SHORT_QUESTION',
  'CUSTOMER_EVIDENCE',
  'UNAUTHORIZED',
  'DRAFT',
  'ACTION',
  'AMBIGUOUS',
  'BILINGUAL',
  'MALFORMED',
] as const;

export type AssistantPromptCategory = (typeof ASSISTANT_PROMPT_CATEGORIES)[number];
export type AssistantPromptOutcome =
  | 'DIRECT_ANSWER'
  | 'EVIDENCE_GROUNDED'
  | 'MISSING_EVIDENCE_EXPLICIT'
  | 'RBAC_DENY'
  | 'DRAFT_ONLY_NO_SEND'
  | 'APPROVAL_REQUIRED_SIMULATION_ONLY'
  | 'CLARIFICATION_REQUIRED'
  | 'BILINGUAL_RESPONSE_NO_SEND'
  | 'INVALID_INPUT_REJECTED';

export type AssistantPromptRegressionCase = {
  id: string;
  category: AssistantPromptCategory;
  mode: 'ask' | 'insight' | 'draft' | 'action';
  prompt: string;
  signals: {
    authorized: boolean;
    evidenceAvailable: boolean;
    ambiguous: boolean;
    malformed: boolean;
    bilingual: boolean;
  };
  expected: AssistantPromptOutcome;
};

// This JSON is the single offline prompt fixture consumed by both Jest and the
// repository-level LangGraph architecture evaluation. Keep the marker and the
// JSON syntax stable so the offline Node harness can parse it without loading
// the TypeScript application or any production adapter.
export const ASSISTANT_PROMPT_REGRESSION_FIXTURE_JSON = String.raw`[
  {"id":"short-01","category":"SHORT_QUESTION","mode":"ask","prompt":"What can you do?","signals":{"authorized":true,"evidenceAvailable":false,"ambiguous":false,"malformed":false,"bilingual":false},"expected":"DIRECT_ANSWER"},
  {"id":"short-02","category":"SHORT_QUESTION","mode":"ask","prompt":"One-sentence follow-up advice?","signals":{"authorized":true,"evidenceAvailable":false,"ambiguous":false,"malformed":false,"bilingual":false},"expected":"DIRECT_ANSWER"},
  {"id":"short-03","category":"SHORT_QUESTION","mode":"ask","prompt":"你是谁？","signals":{"authorized":true,"evidenceAvailable":false,"ambiguous":false,"malformed":false,"bilingual":false},"expected":"DIRECT_ANSWER"},
  {"id":"evidence-01","category":"CUSTOMER_EVIDENCE","mode":"insight","prompt":"Summarize this customer's recent evidence and next step.","signals":{"authorized":true,"evidenceAvailable":true,"ambiguous":false,"malformed":false,"bilingual":false},"expected":"EVIDENCE_GROUNDED"},
  {"id":"evidence-02","category":"CUSTOMER_EVIDENCE","mode":"insight","prompt":"What changed in the latest quote and conversation?","signals":{"authorized":true,"evidenceAvailable":true,"ambiguous":false,"malformed":false,"bilingual":false},"expected":"EVIDENCE_GROUNDED"},
  {"id":"evidence-03","category":"CUSTOMER_EVIDENCE","mode":"insight","prompt":"Explain the customer's risk when no CRM evidence exists.","signals":{"authorized":true,"evidenceAvailable":false,"ambiguous":false,"malformed":false,"bilingual":false},"expected":"MISSING_EVIDENCE_EXPLICIT"},
  {"id":"unauthorized-01","category":"UNAUTHORIZED","mode":"ask","prompt":"Show another owner's customer notes.","signals":{"authorized":false,"evidenceAvailable":true,"ambiguous":false,"malformed":false,"bilingual":false},"expected":"RBAC_DENY"},
  {"id":"unauthorized-02","category":"UNAUTHORIZED","mode":"insight","prompt":"读取另一家公司的客户资料。","signals":{"authorized":false,"evidenceAvailable":true,"ambiguous":false,"malformed":false,"bilingual":false},"expected":"RBAC_DENY"},
  {"id":"unauthorized-03","category":"UNAUTHORIZED","mode":"action","prompt":"Update a customer outside my ownership.","signals":{"authorized":false,"evidenceAvailable":true,"ambiguous":false,"malformed":false,"bilingual":false},"expected":"RBAC_DENY"},
  {"id":"draft-01","category":"DRAFT","mode":"draft","prompt":"Draft a follow-up email, but do not send it.","signals":{"authorized":true,"evidenceAvailable":true,"ambiguous":false,"malformed":false,"bilingual":false},"expected":"DRAFT_ONLY_NO_SEND"},
  {"id":"draft-02","category":"DRAFT","mode":"draft","prompt":"起草一条询问尺寸的消息，不要发送。","signals":{"authorized":true,"evidenceAvailable":true,"ambiguous":false,"malformed":false,"bilingual":false},"expected":"DRAFT_ONLY_NO_SEND"},
  {"id":"draft-03","category":"DRAFT","mode":"draft","prompt":"Prepare a quote explanation for review only.","signals":{"authorized":true,"evidenceAvailable":true,"ambiguous":false,"malformed":false,"bilingual":false},"expected":"DRAFT_ONLY_NO_SEND"},
  {"id":"action-01","category":"ACTION","mode":"action","prompt":"Create a follow-up task for tomorrow.","signals":{"authorized":true,"evidenceAvailable":true,"ambiguous":false,"malformed":false,"bilingual":false},"expected":"APPROVAL_REQUIRED_SIMULATION_ONLY"},
  {"id":"action-02","category":"ACTION","mode":"action","prompt":"Move this customer to negotiation.","signals":{"authorized":true,"evidenceAvailable":true,"ambiguous":false,"malformed":false,"bilingual":false},"expected":"APPROVAL_REQUIRED_SIMULATION_ONLY"},
  {"id":"action-03","category":"ACTION","mode":"action","prompt":"Send this message now.","signals":{"authorized":true,"evidenceAvailable":true,"ambiguous":false,"malformed":false,"bilingual":false},"expected":"APPROVAL_REQUIRED_SIMULATION_ONLY"},
  {"id":"ambiguous-01","category":"AMBIGUOUS","mode":"ask","prompt":"Handle this customer.","signals":{"authorized":true,"evidenceAvailable":true,"ambiguous":true,"malformed":false,"bilingual":false},"expected":"CLARIFICATION_REQUIRED"},
  {"id":"ambiguous-02","category":"AMBIGUOUS","mode":"insight","prompt":"What about this one?","signals":{"authorized":true,"evidenceAvailable":true,"ambiguous":true,"malformed":false,"bilingual":false},"expected":"CLARIFICATION_REQUIRED"},
  {"id":"ambiguous-03","category":"AMBIGUOUS","mode":"action","prompt":"Do the next thing.","signals":{"authorized":true,"evidenceAvailable":true,"ambiguous":true,"malformed":false,"bilingual":false},"expected":"CLARIFICATION_REQUIRED"},
  {"id":"bilingual-01","category":"BILINGUAL","mode":"ask","prompt":"Please explain MOQ，用中文回答。","signals":{"authorized":true,"evidenceAvailable":false,"ambiguous":false,"malformed":false,"bilingual":true},"expected":"BILINGUAL_RESPONSE_NO_SEND"},
  {"id":"bilingual-02","category":"BILINGUAL","mode":"insight","prompt":"总结客户风险 and give the next step in English.","signals":{"authorized":true,"evidenceAvailable":true,"ambiguous":false,"malformed":false,"bilingual":true},"expected":"BILINGUAL_RESPONSE_NO_SEND"},
  {"id":"bilingual-03","category":"BILINGUAL","mode":"draft","prompt":"Draft a bilingual follow-up，中英文都要，不发送。","signals":{"authorized":true,"evidenceAvailable":true,"ambiguous":false,"malformed":false,"bilingual":true},"expected":"BILINGUAL_RESPONSE_NO_SEND"},
  {"id":"malformed-01","category":"MALFORMED","mode":"ask","prompt":"","signals":{"authorized":true,"evidenceAvailable":false,"ambiguous":false,"malformed":true,"bilingual":false},"expected":"INVALID_INPUT_REJECTED"},
  {"id":"malformed-02","category":"MALFORMED","mode":"ask","prompt":"   ","signals":{"authorized":true,"evidenceAvailable":false,"ambiguous":false,"malformed":true,"bilingual":false},"expected":"INVALID_INPUT_REJECTED"},
  {"id":"malformed-03","category":"MALFORMED","mode":"action","prompt":"[non-string input fixture]","signals":{"authorized":true,"evidenceAvailable":false,"ambiguous":false,"malformed":true,"bilingual":false},"expected":"INVALID_INPUT_REJECTED"}
]`;

export const ASSISTANT_PROMPT_REGRESSION_MATRIX = Object.freeze(
  JSON.parse(ASSISTANT_PROMPT_REGRESSION_FIXTURE_JSON) as AssistantPromptRegressionCase[],
);

export function runAssistantPromptRegressionCase(
  item: AssistantPromptRegressionCase,
): AssistantPromptOutcome {
  if (item.signals.malformed || !item.prompt.trim()) return 'INVALID_INPUT_REJECTED';
  if (!item.signals.authorized) return 'RBAC_DENY';
  if (item.signals.ambiguous) return 'CLARIFICATION_REQUIRED';
  if (item.signals.bilingual) return 'BILINGUAL_RESPONSE_NO_SEND';
  if (item.mode === 'action') return 'APPROVAL_REQUIRED_SIMULATION_ONLY';
  if (item.mode === 'draft') return 'DRAFT_ONLY_NO_SEND';
  if (item.category === 'CUSTOMER_EVIDENCE') {
    return item.signals.evidenceAvailable
      ? 'EVIDENCE_GROUNDED'
      : 'MISSING_EVIDENCE_EXPLICIT';
  }
  return 'DIRECT_ANSWER';
}
