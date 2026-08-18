import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { sendAssistantChat } from '@/lib/agent-api';
import { useAuthStore } from '@/store/authStore';
import { CustomerSalesCopilot } from './customer-sales-copilot';

vi.mock('@/lib/agent-api', async (importOriginal) => {
  const original = await importOriginal<typeof import('@/lib/agent-api')>();
  return { ...original, sendAssistantChat: vi.fn() };
});

const mockedSendAssistantChat = vi.mocked(sendAssistantChat);
const companyId = '11111111-1111-4111-8111-111111111111';
const customerId = '33333333-3333-4333-8333-333333333333';

function setRole(role: string) {
  act(() => {
    useAuthStore.setState({
      activeCompanyId: companyId,
      user: {
        id: 'user-1',
        email: 'user@example.test',
        firstName: 'Test',
        lastName: 'User',
        companies: [{
          id: companyId,
          name: 'Fixture Company',
          slug: 'fixture-company',
          role,
          isDefault: true,
        }],
      },
    });
  });
}

function actionTurn() {
  return {
    id: '44444444-4444-4444-8444-444444444444',
    input: 'Create a follow-up task for tomorrow',
    output: 'Internal review card created.',
    createdAt: '2026-08-10T00:00:00.000Z',
    model: 'deterministic-action',
    actionProposal: {
      kind: 'CUSTOMER_ACTION_REVIEW' as const,
      status: 'REQUIRES_CONFIRMATION' as const,
      expiresAt: '2026-08-10T00:10:00.000Z',
      instruction: 'Create a follow-up task for tomorrow',
      target: { leadId: customerId, name: 'Buyer Co' },
      safety: {
        automaticSend: false as const,
        requiresHumanConfirmation: true as const,
        externalSend: false as const,
        execution: 'SIMULATION_ONLY' as const,
      },
    },
    accepted: false,
    acceptedAt: null,
    actionStatus: 'REQUIRES_CONFIRMATION',
    businessStatus: null,
    responseKind: 'CHAT' as const,
    agentRunId: null,
    toolReceipts: [],
    intent: 'ACTION' as const,
    diagnostics: {
      intent: 'ACTION' as const,
      responseSource: 'deterministic_action' as const,
      model: 'deterministic-action',
      latencyMs: 8,
      tools: [],
      approvalReceipt: null,
      qualityStatus: 'PASSED' as const,
      qualityRetryCount: 0,
    },
  };
}

beforeEach(() => {
  mockedSendAssistantChat.mockReset();
  setRole('company_admin');
});

describe('CustomerSalesCopilot safe embedded interaction', () => {
  it('sends the exact four-mode customer payload then edits and approves only a local simulation', async () => {
    mockedSendAssistantChat.mockResolvedValue(actionTurn());
    const user = userEvent.setup();
    render(<CustomerSalesCopilot customerId={customerId} customerName="Buyer Co" />);

    await user.click(screen.getByRole('tab', { name: /Action/ }));
    await user.type(screen.getByLabelText('向销售副驾提问'), 'Create a follow-up task for tomorrow');
    await user.click(screen.getByRole('button', { name: '运行 Action' }));

    await waitFor(() => expect(mockedSendAssistantChat).toHaveBeenCalledTimes(1));
    expect(mockedSendAssistantChat).toHaveBeenCalledWith(expect.objectContaining({
      companyId,
      customerId,
      mode: 'action',
      message: 'Create a follow-up task for tomorrow',
      pathname: `/customers/${customerId}`,
      threadId: `customer-${customerId}-user-1`,
    }));

    await user.click(await screen.findByRole('button', { name: '编辑' }));
    const editor = screen.getByLabelText('编辑动作草稿');
    await user.clear(editor);
    await user.type(editor, 'Create an internal follow-up draft for Friday');
    await user.click(screen.getByRole('button', { name: '批准安全模拟' }));

    expect(await screen.findByRole('status')).toHaveTextContent('未写入外部通道');
    expect(mockedSendAssistantChat).toHaveBeenCalledTimes(1);
  });

  it('rejects the approval card without a second API call or outbound adapter', async () => {
    mockedSendAssistantChat.mockResolvedValue(actionTurn());
    const user = userEvent.setup();
    render(<CustomerSalesCopilot customerId={customerId} customerName="Buyer Co" />);

    await user.click(screen.getByRole('tab', { name: /Action/ }));
    await user.type(screen.getByLabelText('向销售副驾提问'), 'Create a follow-up task for tomorrow');
    await user.click(screen.getByRole('button', { name: '运行 Action' }));
    await user.click(await screen.findByRole('button', { name: '拒绝' }));

    expect(await screen.findByRole('status')).toHaveTextContent('未执行，未发送任何消息');
    expect(mockedSendAssistantChat).toHaveBeenCalledTimes(1);
  });

  it('shows detailed allowlisted diagnostics only to managers and administrators', async () => {
    const turn = {
      ...actionTurn(),
      actionProposal: null,
      actionStatus: null,
      intent: 'INSIGHT' as const,
      diagnostics: {
        intent: 'INSIGHT' as const,
        responseSource: 'openclaw_gateway' as const,
        model: 'openclaw/stable',
        latencyMs: 42,
        tools: ['crm.customer_get'],
        approvalReceipt: 'sensitive-receipt-must-not-render',
        qualityStatus: 'RETRIED_PASSED' as const,
        qualityRetryCount: 1,
      },
    };
    mockedSendAssistantChat.mockResolvedValue(turn);
    const user = userEvent.setup();
    render(<CustomerSalesCopilot customerId={customerId} customerName="Buyer Co" />);
    await user.type(screen.getByLabelText('向销售副驾提问'), 'Summarize the customer');
    await user.click(screen.getByRole('button', { name: '运行 Insight' }));

    const diagnostics = await screen.findByLabelText('AI 响应诊断');
    expect(diagnostics).toHaveTextContent('意图：INSIGHT');
    expect(diagnostics).toHaveTextContent('来源：openclaw_gateway');
    expect(diagnostics).toHaveTextContent('crm.customer_get');
    expect(diagnostics).not.toHaveTextContent('sensitive-receipt-must-not-render');
  });

  it('keeps detailed diagnostics hidden from a normal sales user', async () => {
    setRole('sales_user');
    mockedSendAssistantChat.mockResolvedValue({
      ...actionTurn(),
      actionProposal: null,
      actionStatus: null,
      intent: 'ASK',
      diagnostics: {
        ...actionTurn().diagnostics,
        intent: 'ASK',
        responseSource: 'zhipu',
        model: 'private-model-name',
        tools: ['crm.customer_get'],
      },
    });
    const user = userEvent.setup();
    render(<CustomerSalesCopilot customerId={customerId} customerName="Buyer Co" />);
    await user.click(screen.getByRole('tab', { name: /Ask/ }));
    await user.type(screen.getByLabelText('向销售副驾提问'), 'What should I do?');
    await user.click(screen.getByRole('button', { name: '运行 Ask' }));

    const diagnostics = await screen.findByLabelText('AI 响应诊断');
    expect(diagnostics).toHaveTextContent('意图：ASK');
    expect(diagnostics).toHaveTextContent('质量：PASSED');
    expect(diagnostics).not.toHaveTextContent('zhipu');
    expect(diagnostics).not.toHaveTextContent('private-model-name');
    expect(diagnostics).not.toHaveTextContent('crm.customer_get');
  });
});
