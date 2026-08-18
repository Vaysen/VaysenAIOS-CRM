import api from '@/lib/api';
import type { AgentAuthorization, AgentRun } from '@/types/agent';
import type { AgentRunKind } from '@/types/agent';
import { createClientUuid } from '@/lib/client-id';
import { z } from 'zod';

type CreatableAgentRunKind = Extract<AgentRunKind, 'READ_LEAD_SUMMARY' | 'DRAFT_FOLLOW_UP'>;
export type AssistantBusinessStatus = 'PROCESSING' | 'SUCCEEDED' | 'BLOCKED' | 'FAILED';
export type AssistantMode = 'ask' | 'insight' | 'draft' | 'action';
export type AssistantIntent = 'ASK' | 'INSIGHT' | 'DRAFT' | 'ACTION';
export type AssistantQualityStatus = 'PASSED' | 'RETRIED_PASSED' | 'DEGRADED';

export interface AssistantResponseDiagnostics {
  intent: AssistantIntent;
  responseSource: 'deterministic_action' | 'openclaw_gateway' | 'zhipu' | 'zhipu_fallback' | 'quality_gate_fallback';
  model: string | null;
  latencyMs: number;
  tools: string[];
  approvalReceipt: string | null;
  qualityStatus: AssistantQualityStatus;
  qualityRetryCount: number;
}

export interface AssistantChatTurn {
  id: string;
  input: string;
  output: string;
  createdAt: string;
  model: string | null;
  actionProposal: AssistantActionProposal | null;
  accepted: boolean;
  acceptedAt: string | null;
  actionStatus: string | null;
  businessStatus: AssistantBusinessStatus | null;
  responseKind:
    | 'CHAT'
    | 'TASK_RESERVATION'
    | 'TASK_CREATED'
    | 'TASK_STATUS'
    | 'ACTION_BLOCKED'
    | 'OPENCLAW_TOOL_RESULT';
  agentRunId: string | null;
  toolReceipts: AssistantOpenClawToolReceipt[];
  intent: AssistantIntent;
  diagnostics: AssistantResponseDiagnostics | null;
  /** 业务助理的思考过程（deepseek-reasoner 生成，展示在回复上方折叠区） */
  thinking?: string | null;
}

export interface AssistantOpenClawToolReceipt {
  requestId: string;
  agentRunId: string;
  toolName:
    | 'crm.work_brief'
    | 'crm.customer_search'
    | 'crm.customer_get'
    | 'crm.customer_add_note'
    | 'crm.customer_update'
    | 'crm.customer_set_stage'
    | 'crm.task_create'
    | 'crm.order_list'
    | 'crm.order_create_draft'
    | 'crm.order_update_stage'
    | 'crm.quote_list'
    | 'crm.quote_create_draft'
    | 'crm.product_search'
    | 'crm.start_background_research'
    | 'crm.prepare_quote_delivery'
    | 'crm.whatsapp_messages_read'
    | 'crm.whatsapp_send_text'
    | 'crm.whatsapp_send_quote'
    | 'crm.email_messages_read'
    | 'crm.email_send'
    | 'crm.email_reply';
  status: 'PROCESSING' | 'COMPLETED' | 'FAILED';
  businessStatus: AssistantBusinessStatus;
  errorCode: string | null;
  completedAt: string | null;
}

export interface AssistantQuoteDeliveryProposal {
  kind: 'PREPARE_QUOTE_DELIVERY';
  status: 'REQUIRES_CONFIRMATION' | 'BLOCKED';
  expiresAt: string;
  reason?: string;
  quote?: {
    id: string;
    referenceNo: string;
    status: string;
    totalAmount: string;
    currency: string;
    updatedAt: string;
  };
  target?: {
    name: string;
    phone: string;
    conversationId?: string;
    leadId?: string;
  };
  safety: {
    automaticSend: false;
    requiresHumanConfirmation: true;
    requiresManualWhatsappSend: true;
  };
}

export interface AssistantWhatsappTextProposal {
  kind: 'SEND_WHATSAPP_TEXT';
  status: 'REQUIRES_CONFIRMATION' | 'BLOCKED';
  expiresAt: string;
  reason?: string;
  text?: string;
  target?: {
    name: string;
    phone: string;
    conversationId?: string;
    leadId?: string;
  };
  safety: {
    automaticSend: false;
    requiresHumanConfirmation: true;
  };
}

export interface AssistantCustomerActionReviewProposal {
  kind: 'CUSTOMER_ACTION_REVIEW';
  status: 'REQUIRES_CONFIRMATION';
  expiresAt: string;
  instruction: string;
  target: {
    leadId: string;
    name: string;
  };
  safety: {
    automaticSend: false;
    requiresHumanConfirmation: true;
    externalSend: false;
    execution: 'SIMULATION_ONLY';
  };
}

export type AssistantActionProposal =
  | AssistantQuoteDeliveryProposal
  | AssistantWhatsappTextProposal
  | AssistantCustomerActionReviewProposal;

export interface AssistantPendingAction {
  id: string;
  createdAt: string;
  source: 'WECHAT_OWNER' | 'CRM';
  actionProposal: AssistantQuoteDeliveryProposal;
}

export interface AssistantBrief {
  generatedAt: string;
  ai: { enabled: boolean; provider: 'zhipu'; model: string };
  metrics: {
    leads: number;
    newLeads: number;
    pendingReminders: number;
    overdueReminders: number;
    todayReminders: number;
    draftQuotes: number;
    activeAgentRuns: number;
  };
  leadStatusCounts: Record<string, number>;
  reminders: Array<{
    id: string;
    title: string;
    reason?: string | null;
    priority: string;
    dueAt: string;
    leadId: string;
  }>;
  quotes: Array<{
    id: string;
    status: string;
    referenceNo: string;
    totalAmount: string | number;
    currency: string;
    updatedAt: string;
  }>;
  runs: AgentRun[];
}

const isoDateSchema = z
  .string()
  .refine((value) => value.length > 0 && !Number.isNaN(Date.parse(value)), 'invalid ISO timestamp');

const assistantQuoteDeliveryProposalSchema = z
  .strictObject({
    kind: z.literal('PREPARE_QUOTE_DELIVERY'),
    status: z.enum(['REQUIRES_CONFIRMATION', 'BLOCKED']),
    expiresAt: isoDateSchema,
    reason: z.string().min(1).max(2_000).optional(),
    quote: z
      .strictObject({
        id: z.string().uuid(),
        referenceNo: z.string().min(1).max(128),
        status: z.string().min(1).max(64),
        totalAmount: z.string().min(1).max(64),
        currency: z.string().min(1).max(16),
        updatedAt: isoDateSchema,
      })
      .optional(),
    target: z
      .strictObject({
        name: z.string().min(1).max(256),
        phone: z.string().regex(/^\+?\d{7,15}$/),
        conversationId: z.string().uuid().optional(),
        leadId: z.string().uuid().optional(),
      })
      .optional(),
    safety: z.strictObject({
      automaticSend: z.literal(false),
      requiresHumanConfirmation: z.literal(true),
      requiresManualWhatsappSend: z.literal(true),
    }),
  })
  .superRefine((proposal, context) => {
    if (proposal.status === 'REQUIRES_CONFIRMATION' && (!proposal.quote || !proposal.target)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'confirmed quote preparation requires a verified quote and target',
      });
    }
  });

const assistantWhatsappTextProposalSchema = z
  .strictObject({
    kind: z.literal('SEND_WHATSAPP_TEXT'),
    status: z.enum(['REQUIRES_CONFIRMATION', 'BLOCKED']),
    expiresAt: isoDateSchema,
    reason: z.string().min(1).max(2_000).optional(),
    text: z.string().min(1).max(4_000).optional(),
    target: z
      .strictObject({
        name: z.string().min(1).max(256),
        phone: z.string().regex(/^\+?\d{7,15}$/),
        conversationId: z.string().uuid().optional(),
        leadId: z.string().uuid().optional(),
      })
      .optional(),
    safety: z.strictObject({
      automaticSend: z.literal(false),
      requiresHumanConfirmation: z.literal(true),
    }),
  })
  .superRefine((proposal, context) => {
    if (
      proposal.status === 'REQUIRES_CONFIRMATION'
      && (!proposal.text || !proposal.target?.conversationId)
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'WhatsApp send proposal requires verified text and conversation target',
      });
    }
  });

const assistantCustomerActionReviewProposalSchema = z.strictObject({
  kind: z.literal('CUSTOMER_ACTION_REVIEW'),
  status: z.literal('REQUIRES_CONFIRMATION'),
  expiresAt: isoDateSchema,
  instruction: z.string().min(1).max(4_000),
  target: z.strictObject({
    leadId: z.string().uuid(),
    name: z.string().min(1).max(256),
  }),
  safety: z.strictObject({
    automaticSend: z.literal(false),
    requiresHumanConfirmation: z.literal(true),
    externalSend: z.literal(false),
    execution: z.literal('SIMULATION_ONLY'),
  }),
});

const assistantActionProposalSchema = z.union([
  assistantQuoteDeliveryProposalSchema,
  assistantWhatsappTextProposalSchema,
  assistantCustomerActionReviewProposalSchema,
]);

const assistantPendingActionSchema = z
  .strictObject({
    id: z.string().uuid(),
    createdAt: isoDateSchema,
    source: z.enum(['WECHAT_OWNER', 'CRM']),
    actionProposal: assistantQuoteDeliveryProposalSchema,
  })
  .superRefine((action, context) => {
    if (action.actionProposal.status !== 'REQUIRES_CONFIRMATION') {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['actionProposal', 'status'],
        message: 'pending actions must still require confirmation',
      });
    }
  });

const assistantOpenClawToolReceiptSchema = z.strictObject({
  requestId: z.string().regex(/^[a-f0-9]{64}$/),
  agentRunId: z.string().uuid(),
  toolName: z.enum([
    'crm.work_brief',
    'crm.customer_search',
    'crm.customer_get',
    'crm.customer_add_note',
    'crm.customer_update',
    'crm.customer_set_stage',
    'crm.task_create',
    'crm.order_list',
    'crm.order_create_draft',
    'crm.order_update_stage',
    'crm.quote_list',
    'crm.quote_create_draft',
    'crm.product_search',
    'crm.start_background_research',
    'crm.prepare_quote_delivery',
    'crm.whatsapp_messages_read',
    'crm.whatsapp_send_text',
    'crm.whatsapp_send_quote',
    'crm.email_messages_read',
    'crm.email_send',
    'crm.email_reply',
  ]),
  status: z.enum(['PROCESSING', 'COMPLETED', 'FAILED']),
  businessStatus: z.enum(['PROCESSING', 'SUCCEEDED', 'BLOCKED', 'FAILED']),
  errorCode: z
    .string()
    .regex(/^[A-Z0-9_.-]{1,64}$/)
    .nullable(),
  completedAt: isoDateSchema.nullable(),
});

const assistantResponseDiagnosticsSchema = z.strictObject({
  intent: z.enum(['ASK', 'INSIGHT', 'DRAFT', 'ACTION']),
  responseSource: z.enum([
    'deterministic_action',
    'openclaw_gateway',
    'zhipu',
    'zhipu_fallback',
    'quality_gate_fallback',
  ]),
  model: z.string().min(1).max(256).nullable(),
  latencyMs: z.number().int().min(0).max(300_000),
  tools: z.array(z.string().regex(/^crm\.[a-z_]+$/)).max(8),
  approvalReceipt: z.string().min(1).max(160).nullable(),
  qualityStatus: z.enum(['PASSED', 'RETRIED_PASSED', 'DEGRADED']),
  qualityRetryCount: z.number().int().min(0).max(1),
});

const assistantChatTurnSchema = z
  .strictObject({
    id: z.string().uuid(),
    input: z.string(),
    output: z.string(),
    createdAt: isoDateSchema,
    model: z.string().min(1).max(256).nullable(),
    actionProposal: assistantActionProposalSchema.nullable(),
    accepted: z.boolean(),
    acceptedAt: isoDateSchema.nullable(),
    actionStatus: z
      .string()
      .regex(/^[A-Z0-9_.-]{1,64}$/)
      .nullable(),
    businessStatus: z.enum(['PROCESSING', 'SUCCEEDED', 'BLOCKED', 'FAILED']).nullable(),
    responseKind: z.enum([
      'CHAT',
      'TASK_RESERVATION',
      'TASK_CREATED',
      'TASK_STATUS',
      'ACTION_BLOCKED',
      'OPENCLAW_TOOL_RESULT',
    ]),
    agentRunId: z.string().uuid().nullable(),
    toolReceipts: z.array(assistantOpenClawToolReceiptSchema).max(8),
    intent: z.enum(['ASK', 'INSIGHT', 'DRAFT', 'ACTION']),
    diagnostics: assistantResponseDiagnosticsSchema.nullable(),
    thinking: z.string().nullable().optional(),
  })
  .superRefine((turn, context) => {
    if (turn.diagnostics && turn.diagnostics.intent !== turn.intent) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['diagnostics', 'intent'],
        message: 'diagnostic intent must match the response intent',
      });
    }
    const isOpenClawToolResult = turn.responseKind === 'OPENCLAW_TOOL_RESULT';
    if (isOpenClawToolResult && turn.toolReceipts.length === 0) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['toolReceipts'],
        message: 'OpenClaw tool results require at least one verified receipt',
      });
    }
    if (!isOpenClawToolResult && turn.toolReceipts.length > 0) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['toolReceipts'],
        message: 'non-OpenClaw turns cannot carry tool receipts',
      });
    }
    if (turn.toolReceipts.length === 1 && turn.agentRunId !== turn.toolReceipts[0].agentRunId) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['agentRunId'],
        message: 'single receipt must match the top-level agent run',
      });
    }
    if (turn.toolReceipts.length > 1 && turn.agentRunId !== null) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['agentRunId'],
        message: 'multiple receipts cannot claim a single top-level agent run',
      });
    }
    if (isOpenClawToolResult) {
      const expectedActionStatus = turn.toolReceipts.some((item) => item.status === 'FAILED')
        ? 'FAILED'
        : turn.toolReceipts.some((item) => item.status === 'PROCESSING')
          ? 'RUNNING'
          : 'COMPLETED';
      if (turn.actionStatus !== expectedActionStatus) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['actionStatus'],
          message: 'turn action status must match its verified receipt transport states',
        });
      }
      const expectedBusinessStatus = turn.toolReceipts.some(
        (item) => item.businessStatus === 'FAILED',
      )
        ? 'FAILED'
        : turn.toolReceipts.some((item) => item.businessStatus === 'BLOCKED')
          ? 'BLOCKED'
          : turn.toolReceipts.some((item) => item.businessStatus === 'PROCESSING')
            ? 'PROCESSING'
            : 'SUCCEEDED';
      if (turn.businessStatus !== expectedBusinessStatus) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['businessStatus'],
          message: 'turn business outcome must match its verified receipts',
        });
      }
    }
    turn.toolReceipts.forEach((receipt, index) => {
      if (receipt.status === 'PROCESSING' && receipt.completedAt !== null) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['toolReceipts', index, 'completedAt'],
          message: 'processing receipt cannot be completed',
        });
      }
      if (receipt.status !== 'PROCESSING' && receipt.completedAt === null) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['toolReceipts', index, 'completedAt'],
          message: 'terminal receipt requires a completion timestamp',
        });
      }
      if (receipt.status === 'FAILED' && receipt.errorCode === null) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['toolReceipts', index, 'errorCode'],
          message: 'failed receipt requires an error code',
        });
      }
      if (receipt.status !== 'FAILED' && receipt.errorCode !== null) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['toolReceipts', index, 'errorCode'],
          message: 'non-failed receipt cannot carry an error code',
        });
      }
      const businessMatchesTransport =
        (receipt.status === 'PROCESSING' && receipt.businessStatus === 'PROCESSING') ||
        (receipt.status === 'FAILED' && receipt.businessStatus === 'FAILED') ||
        (receipt.status === 'COMPLETED' &&
          ['SUCCEEDED', 'BLOCKED', 'FAILED'].includes(receipt.businessStatus));
      if (!businessMatchesTransport) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['toolReceipts', index, 'businessStatus'],
          message: 'business outcome must match the transport receipt state',
        });
      }
    });
  });

export function parseAssistantChatTurn(value: unknown): AssistantChatTurn {
  const parsed = assistantChatTurnSchema.safeParse(value);
  if (!parsed.success) {
    throw new Error('AI 对话返回格式无效，已停止展示或执行');
  }
  return parsed.data as AssistantChatTurn;
}

export function parseAssistantChatHistory(value: unknown): AssistantChatTurn[] {
  if (!Array.isArray(value)) {
    throw new Error('AI 对话历史返回格式无效，已停止展示');
  }
  return value.map((turn) => parseAssistantChatTurn(turn));
}

export function parseAssistantPendingActions(value: unknown): AssistantPendingAction[] {
  if (!Array.isArray(value)) {
    throw new Error('AI 待确认操作返回格式无效，已停止展示');
  }
  return value.map((action) => {
    const parsed = assistantPendingActionSchema.safeParse(action);
    if (!parsed.success) {
      throw new Error('AI 待确认操作返回格式无效，已停止展示');
    }
    return parsed.data as AssistantPendingAction;
  });
}

function requireRun(value: unknown, expectedId?: string): AgentRun {
  const run = value as Partial<AgentRun> | null;
  if (
    !run ||
    typeof run.id !== 'string' ||
    (expectedId && run.id !== expectedId) ||
    !Array.isArray(run.tasks) ||
    !Array.isArray(run.authorizations)
  ) {
    throw new Error('AI 任务返回格式无效，已禁止后续操作');
  }
  return run as AgentRun;
}

export async function listAgentRuns(companyId: string): Promise<AgentRun[]> {
  if (!companyId) throw new Error('未选择当前公司，无法读取 AI 任务');
  const response = await api.get<unknown>('/agent-runs', { params: { companyId } });
  if (!Array.isArray(response.data)) throw new Error('AI 任务列表返回格式无效');
  return response.data.map((run) => requireRun(run));
}

export async function createAgentRun(input: {
  companyId: string;
  kind: CreatableAgentRunKind;
  leadId: string;
  brief?: string;
  language?: string;
}): Promise<AgentRun> {
  const response = await api.post<unknown>('/agent-runs', input);
  return requireRun(response.data);
}

export async function getAgentRun(id: string): Promise<AgentRun> {
  const response = await api.get<unknown>(`/agent-runs/${encodeURIComponent(id)}`);
  return requireRun(response.data, id);
}

export async function confirmAgentAuthorization(id: string): Promise<AgentAuthorization> {
  const response = await api.post<AgentAuthorization>(
    `/agent-runs/authorizations/${encodeURIComponent(id)}/confirm`,
    {},
  );
  if (!response.data || response.data.id !== id || response.data.status !== 'CONFIRMED') {
    throw new Error('服务端未确认该授权，任务不会继续执行');
  }
  return response.data;
}

export async function cancelAgentRun(id: string): Promise<AgentRun> {
  const response = await api.post<unknown>(`/agent-runs/${encodeURIComponent(id)}/cancel`, {});
  const run = response.data as Partial<AgentRun> | null;
  if (!run || run.id !== id || run.status !== 'CANCELLED') {
    throw new Error('服务端未确认取消任务');
  }
  return run as AgentRun;
}

export async function getAssistantBrief(companyId: string): Promise<AssistantBrief> {
  if (!companyId) throw new Error('未选择当前公司，无法生成工作摘要');
  const response = await api.get<AssistantBrief>('/agent-runs/assistant/brief', {
    params: { companyId },
  });
  return response.data;
}

export async function getAssistantChatHistory(
  companyId: string,
  threadId: string,
): Promise<AssistantChatTurn[]> {
  const response = await api.get<unknown>('/agent-runs/assistant/chat', {
    params: { companyId, threadId },
  });
  return parseAssistantChatHistory(response.data);
}

export async function getAssistantPendingActions(
  companyId: string,
): Promise<AssistantPendingAction[]> {
  if (!companyId) throw new Error('未选择当前公司，无法读取待确认操作');
  const response = await api.get<unknown>('/agent-runs/assistant/pending-actions', {
    params: { companyId },
  });
  return parseAssistantPendingActions(response.data);
}

export async function sendAssistantChat(input: {
  requestId?: string;
  companyId: string;
  threadId: string;
  message: string;
  mode?: AssistantMode;
  customerId?: string;
  pathname?: string;
  whatsapp?: {
    name: string;
    phone: string;
    conversationId?: string;
    leadId?: string;
    isGroup?: boolean;
  };
}): Promise<AssistantChatTurn> {
  const requestId = input.requestId || createClientUuid();
  // OpenClaw 对话（含工具调用）可能耗时 20-60s+，超出全局 15s 超时会导致前端先断。
  // 这里单独给 AI 业务助理对话 90s 超时，避免 outbox 锁死导致"无法收发消息"。
  const response = await api.post<unknown>(
    '/agent-runs/assistant/chat',
    { ...input, requestId },
    { timeout: 90000 },
  );
  return parseAssistantChatTurn(response.data);
}

export async function confirmAssistantAction(proposalId: string): Promise<{
  proposalId: string;
  actionProposal: AssistantQuoteDeliveryProposal;
  status: 'PREPARATION_CONFIRMED';
}> {
  const response = await api.post(
    `/agent-runs/assistant/actions/${encodeURIComponent(proposalId)}/confirm`,
    {},
  );
  if (
    !response.data ||
    response.data.proposalId !== proposalId ||
    response.data.status !== 'PREPARATION_CONFIRMED'
  ) {
    throw new Error('服务端未确认本次报价准备操作');
  }
  return response.data;
}
