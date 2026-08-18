import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type {
  AssistantOpenClawToolReceipt,
  AssistantQuoteDeliveryProposal,
  AssistantWhatsappTextProposal,
} from '@/lib/agent-api';
import type { AgentRun } from '@/types/agent';
import {
  AssistantRunStatusCard,
  OpenClawToolReceiptList,
  QuoteDeliveryCard,
  WhatsappTextSendCard,
  smartTranslationTarget,
} from './business-assistant-orb';

describe('assistant translation direction', () => {
  it('translates Chinese input to English and foreign-language input to Chinese', () => {
    expect(smartTranslationTarget('你好，请问什么时候付款？')).toBe('en');
    expect(smartTranslationTarget('Hello, when can you arrange payment?')).toBe('zh');
    expect(smartTranslationTarget('Hola, ¿cuándo puede pagar?')).toBe('zh');
  });
});

describe('WhatsappTextSendCard', () => {
  const whatsappProposal: AssistantWhatsappTextProposal = {
    kind: 'SEND_WHATSAPP_TEXT',
    status: 'REQUIRES_CONFIRMATION',
    expiresAt: '2026-07-17T12:00:00.000Z',
    text: 'Hello Chris, your order is ready. Please arrange the deposit.',
    target: {
      name: 'Chris',
      phone: '12025550123',
      conversationId: '22222222-2222-4222-8222-222222222222',
    },
    safety: { automaticSend: false, requiresHumanConfirmation: true },
  };

  it('shows the generated message and sends only after a user click', () => {
    const onSend = vi.fn();
    render(<WhatsappTextSendCard proposal={whatsappProposal} sent={false} sending={false} onSend={onSend} />);
    expect(screen.getByText(whatsappProposal.text!)).toBeInTheDocument();
    expect(onSend).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: '核对并真实发送给当前客户' }));
    expect(onSend).toHaveBeenCalledTimes(1);
  });
});

const proposal: AssistantQuoteDeliveryProposal = {
  kind: 'PREPARE_QUOTE_DELIVERY',
  status: 'REQUIRES_CONFIRMATION',
  expiresAt: '2026-07-14T12:00:00.000Z',
  quote: {
    id: 'quote-1',
    referenceNo: 'QT-20260712-2511',
    status: 'draft',
    totalAmount: '640',
    currency: 'USD',
    updatedAt: '2026-07-14T10:00:00.000Z',
  },
  target: {
    name: 'AcmeCorp',
    phone: '8613800000000',
    conversationId: 'conversation-1',
    leadId: 'lead-1',
  },
  safety: {
    automaticSend: false,
    requiresHumanConfirmation: true,
    requiresManualWhatsappSend: true,
  },
};

describe('QuoteDeliveryCard', () => {
  it('shows the server-verified target and has no side effect before explicit confirmation', () => {
    const onPrepare = vi.fn();

    render(
      <QuoteDeliveryCard
        turnId="turn-1"
        proposal={proposal}
        accepted={false}
        preparing={false}
        prepared={undefined}
        onPrepare={onPrepare}
        onDragStart={vi.fn()}
      />,
    );

    expect(screen.getByText('AcmeCorp')).toBeInTheDocument();
    expect(screen.getByText('+861****4719')).toBeInTheDocument();
    expect(screen.getByText('QT-20260712-2511')).toBeInTheDocument();
    expect(screen.getByText(/这是草稿报价/)).toBeInTheDocument();
    expect(screen.getByText(/AI 不会自动点击发送/)).toBeInTheDocument();
    expect(onPrepare).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: '我已核对草稿，确认准备 PDF' }));
    expect(onPrepare).toHaveBeenCalledTimes(1);
    expect(onPrepare).toHaveBeenCalledWith('turn-1', proposal);
  });

  it('masks a normalized E.164 number without rendering a duplicate plus sign', () => {
    render(
      <QuoteDeliveryCard
        turnId="turn-e164"
        proposal={{
          ...proposal,
          target: { ...proposal.target!, phone: '+8613800000000' },
        }}
        accepted={false}
        preparing={false}
        prepared={undefined}
        onPrepare={vi.fn()}
        onDragStart={vi.fn()}
      />,
    );

    expect(screen.getByText('+861****4719')).toBeInTheDocument();
    expect(document.body.textContent).not.toContain('++861');
  });

  it('turns into a draggable PDF card and still requires a manual WhatsApp send', () => {
    const onDragStart = vi.fn();

    render(
      <QuoteDeliveryCard
        turnId="turn-1"
        proposal={proposal}
        accepted={true}
        preparing={false}
        prepared={{
          preparedFileId: 'prepared-1',
          quoteId: 'quote-1',
          targetPhone: '8613800000000',
          filename: 'QT-20260712-2511.pdf',
          size: 61_440,
          sha256: 'abc123',
        }}
        onPrepare={vi.fn()}
        onDragStart={onDragStart}
      />,
    );

    const dragRegion = screen.getByTestId('assistant-quote-drag-region');
    expect(dragRegion).toHaveAttribute('draggable', 'true');
    expect(screen.getByText(/拖到左侧当前 WhatsApp/)).toBeInTheDocument();
    expect(screen.getByText(/人工点击发送/)).toBeInTheDocument();

    fireEvent.dragStart(dragRegion);
    expect(onDragStart).toHaveBeenCalledTimes(1);
  });

  it('offers a fresh verification when an accepted proposal has no live drag handle', () => {
    const onPrepare = vi.fn();
    render(
      <QuoteDeliveryCard
        turnId="turn-1"
        proposal={proposal}
        accepted
        preparing={false}
        prepared={undefined}
        onPrepare={onPrepare}
        onDragStart={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: '重新核验并准备 PDF' }));
    expect(onPrepare).toHaveBeenCalledWith('turn-1', proposal);
  });

  it('renders a blocked reason without an executable button', () => {
    render(
      <QuoteDeliveryCard
        turnId="turn-blocked"
        proposal={{
          kind: 'PREPARE_QUOTE_DELIVERY',
          status: 'BLOCKED',
          expiresAt: '2026-07-14T12:00:00.000Z',
          reason: '当前会话没有已验证的 WhatsApp 完整号码，不能准备外发文件',
          safety: proposal.safety,
        }}
        accepted={false}
        preparing={false}
        prepared={undefined}
        onPrepare={vi.fn()}
        onDragStart={vi.fn()}
      />,
    );

    expect(screen.getByText('报价准备已阻止')).toBeInTheDocument();
    expect(screen.getByText(/没有已验证的 WhatsApp 完整号码/)).toBeInTheDocument();
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });
});

function run(status: AgentRun['status']): AgentRun {
  return {
    id: 'run-12345678-aaaa-bbbb-cccc-123456789012',
    companyId: 'company-1',
    operatorUserId: 'user-1',
    kind: 'BACKGROUND_RESEARCH',
    status,
    inputDigest: 'digest',
    subjectType: 'lead',
    subjectId: 'lead-1',
    result: null,
    errorCode: status === 'FAILED' ? 'RESEARCH_EXECUTION_FAILED' : null,
    startedAt: null,
    completedAt: ['COMPLETED', 'FAILED', 'CANCELLED'].includes(status)
      ? '2026-07-14T10:30:00.000Z'
      : null,
    createdAt: '2026-07-14T10:00:00.000Z',
    updatedAt: '2026-07-14T10:30:00.000Z',
    tasks: [],
    authorizations: [],
    researchReport: status === 'COMPLETED'
      ? {
          id: 'report-1', title: 'Verified Buyer Ltd 背调报告', type: 'full',
          createdAt: '2026-07-14T10:30:00.000Z',
        }
      : null,
  };
}

describe('AssistantRunStatusCard', () => {
  it('shows the full task id and allows an active run to be cancelled', () => {
    const onCancel = vi.fn();
    const active = run('RUNNING');
    render(
      <AssistantRunStatusCard
        run={active}
        runId={active.id}
        cancelling={false}
        onCancel={onCancel}
      />,
    );

    expect(screen.getByText(`任务编号：${active.id}`)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '取消任务' }));
    expect(onCancel).toHaveBeenCalledWith(active.id);
  });

  it('delivers a completed report entry back to the customer record', () => {
    const completed = run('COMPLETED');
    render(
      <AssistantRunStatusCard
        run={completed}
        runId={completed.id}
        cancelling={false}
        onCancel={vi.fn()}
      />,
    );

    const report = screen.getByRole('link', { name: /查看报告：Verified Buyer Ltd 背调报告/ });
    expect(report).toHaveAttribute('href', '/leads/lead-1');
    expect(screen.queryByRole('button', { name: '取消任务' })).not.toBeInTheDocument();
  });

  it('shows a durable failure code instead of implying success', () => {
    const failed = run('FAILED');
    render(
      <AssistantRunStatusCard
        run={failed}
        runId={failed.id}
        cancelling={false}
        onCancel={vi.fn()}
      />,
    );

    expect(screen.getByText('失败原因：RESEARCH_EXECUTION_FAILED')).toBeInTheDocument();
    expect(screen.queryByText(/已进入后台执行/)).not.toBeInTheDocument();
  });

  it('does not present a technically completed but business-blocked OpenClaw run as completed', () => {
    const blocked: AgentRun = {
      ...run('COMPLETED'),
      kind: 'OPENCLAW_TOOL',
      result: { businessStatus: 'BLOCKED', status: 'BLOCKED' },
    };
    render(
      <AssistantRunStatusCard
        run={blocked}
        runId={blocked.id}
        cancelling={false}
        onCancel={vi.fn()}
      />,
    );

    expect(screen.getByText('已阻止 · 未执行业务动作')).toBeInTheDocument();
    expect(screen.queryByText('已完成')).not.toBeInTheDocument();
    expect(screen.getByText(/处理于/)).toBeInTheDocument();
  });
});

describe('OpenClawToolReceiptList', () => {
  it('renders auditable completed, processing and failed tool states as real receipts', () => {
    const receipt = (
      toolName: AssistantOpenClawToolReceipt['toolName'],
      status: AssistantOpenClawToolReceipt['status'],
      errorCode: string | null = null,
    ): AssistantOpenClawToolReceipt => ({
      requestId: `${status === 'COMPLETED' ? 'a' : status === 'PROCESSING' ? 'b' : 'c'}`.repeat(64),
      agentRunId: status === 'COMPLETED'
        ? '11111111-1111-4111-8111-111111111111'
        : status === 'PROCESSING'
          ? '22222222-2222-4222-8222-222222222222'
          : '33333333-3333-4333-8333-333333333333',
      toolName,
      status,
      businessStatus: status === 'COMPLETED'
        ? 'SUCCEEDED'
        : status === 'PROCESSING'
          ? 'PROCESSING'
          : 'FAILED',
      errorCode,
      completedAt: status === 'PROCESSING' ? null : '2026-07-15T01:00:00.000Z',
    });

    render(<OpenClawToolReceiptList receipts={[
      receipt('crm.work_brief', 'COMPLETED'),
      receipt('crm.whatsapp_send_text', 'COMPLETED'),
      receipt('crm.email_reply', 'COMPLETED'),
      receipt('crm.start_background_research', 'PROCESSING'),
      receipt('crm.prepare_quote_delivery', 'FAILED', 'QUOTE_NOT_FOUND'),
    ]} />);

    expect(screen.getByText('AI 工作过程 · 可审计执行轨迹')).toBeInTheDocument();
    expect(screen.getByText(/不展示模型私有草稿/)).toBeInTheDocument();
    expect(screen.getByText('1. 理解任务')).toBeInTheDocument();
    expect(screen.getByText('2. 匹配业务对象')).toBeInTheDocument();
    expect(screen.getByText('3. 调用业务工具')).toBeInTheDocument();
    expect(screen.getByText('4. 核验真实回执')).toBeInTheDocument();
    expect(screen.getByText('读取工作简报')).toBeInTheDocument();
    expect(screen.getByText('发送 WhatsApp 单客户消息')).toBeInTheDocument();
    expect(screen.getByText('回复客户邮件')).toBeInTheDocument();
    expect(screen.getByText('创建客户背调任务')).toBeInTheDocument();
    expect(screen.getByText(/为唯一匹配客户创建真实后台背调任务/)).toBeInTheDocument();
    expect(screen.getByText('准备报价交付提案')).toBeInTheDocument();
    expect(screen.getAllByText('业务已完成')).toHaveLength(3);
    expect(screen.getByText('执行中')).toBeInTheDocument();
    expect(screen.getByText('失败')).toBeInTheDocument();
    expect(screen.getByText('错误码：QUOTE_NOT_FOUND')).toBeInTheDocument();
    expect(screen.getAllByText(/回执：a{12}…/).length).toBeGreaterThan(0);
    expect(document.body.textContent).not.toContain('a'.repeat(64));
  });

  it('shows a transport-complete but business-blocked tool without claiming completion', () => {
    render(<OpenClawToolReceiptList receipts={[{
      requestId: 'd'.repeat(64),
      agentRunId: '44444444-4444-4444-8444-444444444444',
      toolName: 'crm.prepare_quote_delivery',
      status: 'COMPLETED',
      businessStatus: 'BLOCKED',
      errorCode: null,
      completedAt: '2026-07-15T01:00:00.000Z',
    }]} />);

    expect(screen.getByText('已阻止 · 未执行业务动作')).toBeInTheDocument();
    expect(screen.queryByText('业务已完成')).not.toBeInTheDocument();
  });
});
