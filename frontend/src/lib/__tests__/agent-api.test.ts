import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn() }));

vi.mock('@/lib/api', () => ({ default: mocks }));

import {
  cancelAgentRun,
  confirmAgentAuthorization,
  getAssistantChatHistory,
  getAssistantPendingActions,
  getAgentRun,
  listAgentRuns,
  parseAssistantChatHistory,
  parseAssistantPendingActions,
  parseAssistantChatTurn,
  sendAssistantChat,
} from '../agent-api';

const run = {
  id: 'run-1',
  tasks: [],
  authorizations: [],
  status: 'PENDING',
};

function chatTurn(overrides: Record<string, unknown> = {}) {
  return {
    id: '11111111-1111-4111-8111-111111111111',
    input: '查看今日工作简报',
    output: '已读取工作简报。',
    createdAt: '2026-07-15T01:00:00.000Z',
    model: 'openclaw/verified-tool-receipt',
    actionProposal: null,
    accepted: false,
    acceptedAt: null,
    actionStatus: 'COMPLETED',
    businessStatus: 'SUCCEEDED',
    responseKind: 'OPENCLAW_TOOL_RESULT',
    agentRunId: '22222222-2222-4222-8222-222222222222',
    intent: 'ACTION',
    diagnostics: null,
    toolReceipts: [
      {
        requestId: 'a'.repeat(64),
        agentRunId: '22222222-2222-4222-8222-222222222222',
        toolName: 'crm.work_brief',
        status: 'COMPLETED',
        businessStatus: 'SUCCEEDED',
        errorCode: null,
        completedAt: '2026-07-15T01:00:01.000Z',
      },
    ],
    ...overrides,
  };
}

describe('agent API fail-closed contract', () => {
  beforeEach(() => {
    mocks.get.mockReset();
    mocks.post.mockReset();
  });

  afterEach(() => vi.unstubAllGlobals());

  it('requires the active company for tenant-scoped lists', async () => {
    await expect(listAgentRuns('')).rejects.toThrow('未选择当前公司');
    expect(mocks.get).not.toHaveBeenCalled();
  });

  it('rejects list and detail payloads without auditable relations', async () => {
    mocks.get.mockResolvedValueOnce({ data: [{ id: 'run-1' }] });
    await expect(listAgentRuns('company-1')).rejects.toThrow('AI 任务返回格式无效');

    mocks.get.mockResolvedValueOnce({ data: { id: 'run-1', tasks: [] } });
    await expect(getAgentRun('run-1')).rejects.toThrow('AI 任务返回格式无效');
  });

  it('uses the real authorization confirmation and cancellation endpoints', async () => {
    mocks.post
      .mockResolvedValueOnce({ data: { id: 'auth-1', status: 'CONFIRMED' } })
      .mockResolvedValueOnce({ data: { ...run, status: 'CANCELLED' } });

    await confirmAgentAuthorization('auth/1'.replace('/', '-'));
    await cancelAgentRun('run-1');

    expect(mocks.post).toHaveBeenNthCalledWith(1, '/agent-runs/authorizations/auth-1/confirm', {});
    expect(mocks.post).toHaveBeenNthCalledWith(2, '/agent-runs/run-1/cancel', {});
  });

  it('does not accept an ambiguous authorization response', async () => {
    mocks.post.mockResolvedValue({ data: { id: 'auth-1', status: 'PENDING' } });
    await expect(confirmAgentAuthorization('auth-1')).rejects.toThrow('服务端未确认该授权');
  });

  it('creates a UUID request id when randomUUID is unavailable on a LAN origin', async () => {
    vi.stubGlobal('crypto', {
      getRandomValues: (target: Uint8Array) => {
        target.fill(7);
        return target;
      },
    });
    mocks.post.mockResolvedValue({
      data: chatTurn({
        input: 'hi',
        output: 'ok',
        responseKind: 'CHAT',
        actionStatus: null,
        businessStatus: null,
        agentRunId: null,
        toolReceipts: [],
      }),
    });

    await sendAssistantChat({
      companyId: '11111111-1111-4111-8111-111111111111',
      threadId: 'thread-1',
      message: 'hi',
    });

    expect(mocks.post).toHaveBeenCalledWith(
      '/agent-runs/assistant/chat',
      expect.objectContaining({
        requestId: expect.stringMatching(
          /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/,
        ),
      }),
    );
  });

  it('accepts TASK_RESERVATION and verified OpenClaw tool receipts', () => {
    expect(parseAssistantChatTurn(chatTurn()).responseKind).toBe('OPENCLAW_TOOL_RESULT');
    expect(
      parseAssistantChatTurn(
        chatTurn({
          responseKind: 'TASK_RESERVATION',
          actionStatus: 'RESERVED',
          agentRunId: null,
          toolReceipts: [],
        }),
      ).responseKind,
    ).toBe('TASK_RESERVATION');
  });

  it.each([
    'crm.whatsapp_messages_read',
    'crm.whatsapp_send_text',
    'crm.whatsapp_send_quote',
    'crm.email_messages_read',
    'crm.email_send',
    'crm.email_reply',
  ])('accepts the verified messaging tool receipt %s', (toolName) => {
    const base = chatTurn();
    const parsed = parseAssistantChatTurn(chatTurn({
      toolReceipts: [{ ...base.toolReceipts[0], toolName }],
    }));
    expect(parsed.toolReceipts[0].toolName).toBe(toolName);
  });

  it('accepts a server-verified WhatsApp text confirmation proposal', () => {
    const parsed = parseAssistantChatTurn(chatTurn({
      responseKind: 'CHAT',
      actionStatus: 'REQUIRES_CONFIRMATION',
      businessStatus: null,
      agentRunId: null,
      toolReceipts: [],
      actionProposal: {
        kind: 'SEND_WHATSAPP_TEXT',
        status: 'REQUIRES_CONFIRMATION',
        expiresAt: '2026-07-17T12:15:00.000Z',
        text: 'Hello Chris, your order is ready. Please arrange the deposit.',
        target: {
          name: 'Chris',
          phone: '12025550123',
          conversationId: '33333333-3333-4333-8333-333333333333',
        },
        safety: { automaticSend: false, requiresHumanConfirmation: true },
      },
    }));
    expect(parsed.actionProposal?.kind).toBe('SEND_WHATSAPP_TEXT');
  });

  it('accepts a customer action review only as a simulation-only approval card', () => {
    const parsed = parseAssistantChatTurn(chatTurn({
      responseKind: 'CHAT',
      actionStatus: 'REQUIRES_CONFIRMATION',
      businessStatus: null,
      agentRunId: null,
      toolReceipts: [],
      actionProposal: {
        kind: 'CUSTOMER_ACTION_REVIEW',
        status: 'REQUIRES_CONFIRMATION',
        expiresAt: '2026-07-17T12:15:00.000Z',
        instruction: 'Create a follow-up task tomorrow',
        target: {
          leadId: '33333333-3333-4333-8333-333333333333',
          name: 'Example Buyer',
        },
        safety: {
          automaticSend: false,
          requiresHumanConfirmation: true,
          externalSend: false,
          execution: 'SIMULATION_ONLY',
        },
      },
    }));

    expect(parsed.actionProposal?.kind).toBe('CUSTOMER_ACTION_REVIEW');
    expect(parsed.actionProposal?.safety.automaticSend).toBe(false);
  });

  it('preserves allowlisted intent and diagnostics while rejecting extra diagnostic fields', () => {
    const diagnostics = {
      intent: 'INSIGHT',
      responseSource: 'openclaw_gateway',
      model: 'openclaw/stable',
      latencyMs: 42,
      tools: ['crm.customer_get'],
      approvalReceipt: 'a'.repeat(64),
      qualityStatus: 'RETRIED_PASSED',
      qualityRetryCount: 1,
    };
    const parsed = parseAssistantChatTurn(chatTurn({ intent: 'INSIGHT', diagnostics }));
    expect(parsed.intent).toBe('INSIGHT');
    expect(parsed.diagnostics).toEqual(diagnostics);

    expect(() => parseAssistantChatTurn(chatTurn({
      intent: 'INSIGHT',
      diagnostics: { ...diagnostics, secretPrompt: 'do not expose' },
    }))).toThrow('AI 对话返回格式无效');
    expect(() => parseAssistantChatTurn(chatTurn({
      intent: 'ASK',
      diagnostics,
    }))).toThrow('AI 对话返回格式无效');
  });

  it('fails closed for an unknown response kind or malformed tool receipt', () => {
    expect(() => parseAssistantChatTurn(chatTurn({ responseKind: 'TOOL_MAYBE' }))).toThrow(
      'AI 对话返回格式无效',
    );
    expect(() =>
      parseAssistantChatTurn(
        chatTurn({
          toolReceipts: [
            {
              requestId: 'not-a-digest',
              agentRunId: '22222222-2222-4222-8222-222222222222',
              toolName: 'crm.work_brief',
              status: 'COMPLETED',
              errorCode: null,
              completedAt: null,
            },
          ],
        }),
      ),
    ).toThrow('AI 对话返回格式无效');
  });

  it('binds tool receipts to OPENCLAW_TOOL_RESULT and the exact top-level run', () => {
    const firstReceipt = chatTurn().toolReceipts[0];
    const secondReceipt = {
      ...firstReceipt,
      requestId: 'b'.repeat(64),
      agentRunId: '33333333-3333-4333-8333-333333333333',
    };

    expect(() => parseAssistantChatTurn(chatTurn({ toolReceipts: [] }))).toThrow(
      'AI 对话返回格式无效',
    );
    expect(() =>
      parseAssistantChatTurn(
        chatTurn({
          responseKind: 'TASK_RESERVATION',
          actionStatus: 'RESERVED',
          agentRunId: null,
        }),
      ),
    ).toThrow('AI 对话返回格式无效');
    expect(() =>
      parseAssistantChatTurn(
        chatTurn({
          agentRunId: '33333333-3333-4333-8333-333333333333',
        }),
      ),
    ).toThrow('AI 对话返回格式无效');

    expect(
      parseAssistantChatTurn(
        chatTurn({
          agentRunId: null,
          toolReceipts: [firstReceipt, secondReceipt],
        }),
      ).toolReceipts,
    ).toHaveLength(2);
    expect(() =>
      parseAssistantChatTurn(
        chatTurn({
          toolReceipts: [firstReceipt, secondReceipt],
        }),
      ),
    ).toThrow('AI 对话返回格式无效');
  });

  it.each([
    [
      'PROCESSING with completedAt',
      { status: 'PROCESSING', completedAt: '2026-07-15T01:00:01.000Z', errorCode: null },
    ],
    [
      'PROCESSING with errorCode',
      { status: 'PROCESSING', completedAt: null, errorCode: 'STILL_RUNNING' },
    ],
    ['COMPLETED without completedAt', { status: 'COMPLETED', completedAt: null, errorCode: null }],
    [
      'COMPLETED with errorCode',
      { status: 'COMPLETED', completedAt: '2026-07-15T01:00:01.000Z', errorCode: 'UNEXPECTED' },
    ],
    [
      'FAILED without completedAt',
      { status: 'FAILED', completedAt: null, errorCode: 'TOOL_FAILED' },
    ],
    [
      'FAILED without errorCode',
      { status: 'FAILED', completedAt: '2026-07-15T01:00:01.000Z', errorCode: null },
    ],
  ])('rejects semantically invalid tool receipt: %s', (_label, receiptOverride) => {
    const receipt = { ...chatTurn().toolReceipts[0], ...receiptOverride };
    expect(() => parseAssistantChatTurn(chatTurn({ toolReceipts: [receipt] }))).toThrow(
      'AI 对话返回格式无效',
    );
  });

  it.each([
    ['PROCESSING', null, null],
    ['COMPLETED', '2026-07-15T01:00:01.000Z', null],
    ['FAILED', '2026-07-15T01:00:01.000Z', 'TOOL_FAILED'],
  ])('accepts a semantically consistent %s receipt', (status, completedAt, errorCode) => {
    const businessStatus =
      status === 'PROCESSING' ? 'PROCESSING' : status === 'FAILED' ? 'FAILED' : 'SUCCEEDED';
    const receipt = {
      ...chatTurn().toolReceipts[0],
      status,
      businessStatus,
      completedAt,
      errorCode,
    };
    expect(
      parseAssistantChatTurn(
        chatTurn({
          actionStatus: status === 'PROCESSING' ? 'RUNNING' : status,
          businessStatus,
          toolReceipts: [receipt],
        }),
      ).toolReceipts[0],
    ).toEqual(receipt);
  });

  it('separates a completed transport call from a blocked business action', () => {
    const receipt = {
      ...chatTurn().toolReceipts[0],
      status: 'COMPLETED',
      businessStatus: 'BLOCKED',
    };
    expect(
      parseAssistantChatTurn(
        chatTurn({
          actionStatus: 'COMPLETED',
          businessStatus: 'BLOCKED',
          toolReceipts: [receipt],
        }),
      ).toolReceipts[0].businessStatus,
    ).toBe('BLOCKED');

    expect(() =>
      parseAssistantChatTurn(
        chatTurn({
          toolReceipts: [{ ...receipt, status: 'PROCESSING' }],
        }),
      ),
    ).toThrow('AI 对话返回格式无效');
  });

  it('shows a completed tool transport with a failed background job as a business failure', () => {
    const receipt = {
      ...chatTurn().toolReceipts[0],
      status: 'COMPLETED',
      businessStatus: 'FAILED',
      errorCode: null,
    };
    const parsed = parseAssistantChatTurn(
      chatTurn({
        actionStatus: 'COMPLETED',
        businessStatus: 'FAILED',
        toolReceipts: [receipt],
      }),
    );

    expect(parsed.toolReceipts[0]).toEqual(receipt);
    expect(parsed.businessStatus).toBe('FAILED');
  });

  it('rejects a top-level action status that contradicts receipt transport aggregation', () => {
    const processing = {
      ...chatTurn().toolReceipts[0],
      status: 'PROCESSING',
      businessStatus: 'PROCESSING',
      completedAt: null,
    };
    expect(() =>
      parseAssistantChatTurn(
        chatTurn({
          actionStatus: 'COMPLETED',
          businessStatus: 'PROCESSING',
          toolReceipts: [processing],
        }),
      ),
    ).toThrow('AI 对话返回格式无效');

    const failed = {
      ...chatTurn().toolReceipts[0],
      status: 'FAILED',
      businessStatus: 'FAILED',
      errorCode: 'TOOL_FAILED',
    };
    expect(() =>
      parseAssistantChatTurn(
        chatTurn({
          actionStatus: 'RUNNING',
          businessStatus: 'FAILED',
          toolReceipts: [failed],
        }),
      ),
    ).toThrow('AI 对话返回格式无效');
  });

  it('rejects non-array or partially valid history instead of silently returning an empty list', async () => {
    expect(() => parseAssistantChatHistory({ data: [] })).toThrow('AI 对话历史返回格式无效');
    expect(() => parseAssistantChatHistory([chatTurn(), { id: 'partial' }])).toThrow(
      'AI 对话返回格式无效',
    );

    mocks.get.mockResolvedValueOnce({ data: { data: [] } });
    await expect(getAssistantChatHistory('company-1', 'thread-1')).rejects.toThrow(
      'AI 对话历史返回格式无效',
    );
  });

  it('rejects unreviewed fields and malformed quote safety contracts', () => {
    expect(() => parseAssistantChatTurn(chatTurn({ unexpected: 'field' }))).toThrow(
      'AI 对话返回格式无效',
    );
    expect(() =>
      parseAssistantChatTurn(
        chatTurn({
          responseKind: 'CHAT',
          actionStatus: 'REQUIRES_CONFIRMATION',
          agentRunId: null,
          toolReceipts: [],
          actionProposal: {
            kind: 'PREPARE_QUOTE_DELIVERY',
            status: 'REQUIRES_CONFIRMATION',
            expiresAt: '2026-07-15T01:05:00.000Z',
            safety: {
              automaticSend: true,
              requiresHumanConfirmation: true,
              requiresManualWhatsappSend: true,
            },
          },
        }),
      ),
    ).toThrow('AI 对话返回格式无效');
  });

  it('loads only strict pending quote actions from the cross-channel inbox', async () => {
    const pending = {
      id: '11111111-1111-4111-8111-111111111111',
      createdAt: '2026-07-15T01:00:00.000Z',
      source: 'WECHAT_OWNER',
      actionProposal: {
        kind: 'PREPARE_QUOTE_DELIVERY',
        status: 'REQUIRES_CONFIRMATION',
        expiresAt: '2026-07-15T01:05:00.000Z',
        quote: {
          id: '22222222-2222-4222-8222-222222222222',
          referenceNo: 'QT-20260715-0001',
          status: 'draft',
          totalAmount: '640',
          currency: 'USD',
          updatedAt: '2026-07-15T00:59:00.000Z',
        },
        target: {
          name: 'AcmeCorp',
          phone: '+8613800138000',
          conversationId: '33333333-3333-4333-8333-333333333333',
        },
        safety: {
          automaticSend: false,
          requiresHumanConfirmation: true,
          requiresManualWhatsappSend: true,
        },
      },
    };
    mocks.get.mockResolvedValueOnce({ data: [pending] });

    await expect(getAssistantPendingActions('company-1')).resolves.toEqual([pending]);
    expect(mocks.get).toHaveBeenCalledWith('/agent-runs/assistant/pending-actions', {
      params: { companyId: 'company-1' },
    });
    expect(parseAssistantPendingActions([pending])).toEqual([pending]);
  });

  it('fails closed for blocked or unreviewed cross-channel pending actions', () => {
    const malformed = {
      id: '11111111-1111-4111-8111-111111111111',
      createdAt: '2026-07-15T01:00:00.000Z',
      source: 'WECHAT_OWNER',
      actionProposal: {
        kind: 'PREPARE_QUOTE_DELIVERY',
        status: 'BLOCKED',
        expiresAt: '2026-07-15T01:05:00.000Z',
        safety: {
          automaticSend: false,
          requiresHumanConfirmation: true,
          requiresManualWhatsappSend: true,
        },
      },
    };
    expect(() => parseAssistantPendingActions([malformed])).toThrow('AI 待确认操作返回格式无效');
    expect(() => parseAssistantPendingActions([{ ...malformed, unexpected: true }])).toThrow(
      'AI 待确认操作返回格式无效',
    );
  });
});
