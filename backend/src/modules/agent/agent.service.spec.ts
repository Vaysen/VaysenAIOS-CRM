import { ConflictException, ForbiddenException } from '@nestjs/common';
import { AgentAuthorizationStatus, AgentRunStatus } from '@prisma/client';
import { createHash } from 'crypto';
import { AgentService } from './agent.service';
import { SafeAgentRunKind } from './dto/create-agent-run.dto';

const operator = {
  id: 'user-1',
  companies: [{ id: '11111111-1111-4111-8111-111111111111', role: 'sales_user' }],
};
const admin = {
  id: 'admin-1',
  companies: [{ id: '11111111-1111-4111-8111-111111111111', role: 'company_admin' }],
};

function validQuoteProposal() {
  return {
    kind: 'PREPARE_QUOTE_DELIVERY',
    status: 'REQUIRES_CONFIRMATION',
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    quote: {
      id: 'quote-1', referenceNo: 'QT-1', status: 'approved',
      totalAmount: '100', currency: 'USD', updatedAt: new Date().toISOString(),
    },
    target: {
      name: 'Buyer', phone: '12025550123',
      conversationId: 'conversation-1', leadId: 'lead-1',
    },
    safety: {
      automaticSend: false,
      requiresHumanConfirmation: true,
      requiresManualWhatsappSend: true,
    },
  } as const;
}

function validQuoteConversation() {
  return {
    id: 'conversation-1',
    isGroup: false,
    externalThreadId: '12025550123@s.whatsapp.net',
    leadId: 'lead-1',
    assignedUserId: operator.id,
    contactPoint: {
      type: 'whatsapp', originalValue: '+1 202 555 0123',
      normalizedValue: '+12025550123', isVerified: true,
    },
    lead: { id: 'lead-1', ownerUserId: operator.id },
  };
}

const TEST_ACTION_CLAIM_TOKEN = Buffer.alloc(32, 7).toString('base64url');

function createPrismaMock() {
  const prisma: any = {
    lead: { findFirst: jest.fn() },
    conversation: { findFirst: jest.fn() },
    followUpReminder: { findMany: jest.fn() },
    quote: { findMany: jest.fn(), findFirst: jest.fn() },
    aiArtifact: {
      findMany: jest.fn(),
      findFirst: jest.fn(),
      findUnique: jest.fn(),
      create: jest.fn(),
      upsert: jest.fn(),
      update: jest.fn(),
      updateMany: jest.fn(),
    },
    agentRun: {
      create: jest.fn(),
      update: jest.fn(),
      updateMany: jest.fn(),
      findMany: jest.fn(),
      findUnique: jest.fn(),
      findUniqueOrThrow: jest.fn(),
    },
    agentTask: { updateMany: jest.fn() },
    openClawToolReceipt: { findMany: jest.fn().mockResolvedValue([]) },
    deepResearchReport: { deleteMany: jest.fn() },
    agentAuthorization: { findUnique: jest.fn(), update: jest.fn(), updateMany: jest.fn() },
    agentAuditLog: { create: jest.fn() },
  };
  prisma.$transaction = jest.fn(async (input: any) => {
    if (typeof input === 'function') return input(prisma);
    return Promise.all(input);
  });
  return prisma;
}

describe('AgentService secure core', () => {
  let prisma: any;
  let ai: any;
  let researchRuns: any;
  let service: AgentService;

  beforeEach(() => {
    prisma = createPrismaMock();
    ai = {
      chat: jest.fn(),
      getModel: jest.fn().mockReturnValue('glm-4.5-air'),
      isEnabled: jest.fn().mockReturnValue(true),
      hasKey: jest.fn().mockReturnValue(true),
    };
    researchRuns = { enqueueForLead: jest.fn() };
    service = new AgentService(prisma, ai, researchRuns);
  });

  it('does not treat negated or capability-question wording as an executable action', () => {
    const internal = service as any;
    expect(internal.isBackgroundResearchIntent('不要给这个客户做背调')).toBe(false);
    expect(internal.isBackgroundResearchIntent('你能给 Sample Buyer 做背调吗？')).toBe(false);
    expect(internal.isBackgroundResearchIntent('如何做客户背景调查？')).toBe(false);
    expect(internal.isBackgroundResearchIntent('是不是帮我给 Sample Buyer 做背调')).toBe(false);
    expect(internal.isBackgroundResearchIntent('Can we run a background check')).toBe(false);
    expect(internal.isBackgroundResearchIntent('Should I start a background check')).toBe(false);
    expect(internal.isBackgroundResearchIntent('之前你已经帮我给 Sample Buyer 做背调了')).toBe(false);
    expect(internal.isBackgroundResearchIntent('我已经开始对 Sample Buyer 做背景调查')).toBe(false);
    expect(internal.isBackgroundResearchIntent('我们已进行客户调查')).toBe(false);
    expect(internal.isBackgroundResearchIntent('We started a background check')).toBe(false);
    expect(internal.isBackgroundResearchIntent('We conducted customer research')).toBe(false);
    expect(internal.isBackgroundResearchIntent('帮我起草客户背调方案')).toBe(false);
    expect(internal.isBackgroundResearchIntent('请说明客户背调流程')).toBe(false);
    expect(internal.isBackgroundResearchIntent('请规划一下怎么做客户背调')).toBe(false);
    expect(internal.isBackgroundResearchIntent('如果给这个客户做背调会查什么？')).toBe(false);
    expect(internal.isBackgroundResearchIntent('演示一下客户背调结果长什么样')).toBe(false);
    expect(internal.isQuoteDeliveryIntent('先不要发送报价单')).toBe(false);
    expect(internal.isQuoteDeliveryIntent('能不能发送最新报价单？')).toBe(false);
    expect(internal.isQuoteDeliveryIntent('I already sent the latest quote')).toBe(false);

    expect(internal.isBackgroundResearchIntent('帮我给 Sample Buyer 做背调')).toBe(true);
    expect(internal.isBackgroundResearchIntent('给当前客户做背调')).toBe(true);
    expect(internal.isBackgroundResearchIntent('请完成当前客户背调')).toBe(true);
    expect(internal.isBackgroundResearchIntent('现在开始对 Sample Buyer 做背景调查')).toBe(true);
    expect(internal.isQuoteDeliveryIntent('给 Sample Buyer 发送最新报价单')).toBe(true);
    expect(internal.isUnsupportedOperationalIntent('帮我创建客户待办并发送邮件')).toBe(false);
    expect(internal.isUnsupportedOperationalIntent('帮我给 Sample Buyer 生成一份 PI')).toBe(false);
    expect(internal.isUnsupportedOperationalIntent('帮我整理一下 Sample Buyer 的客户资料')).toBe(false);
    expect(internal.isUnsupportedOperationalIntent('安排明天跟进客户的提醒')).toBe(false);
    expect(internal.isUnsupportedOperationalIntent('审批这份报价')).toBe(true);
    expect(internal.isUnsupportedOperationalIntent('同步联系人')).toBe(true);
    expect(internal.isUnsupportedOperationalIntent('分配客户给业务员A')).toBe(true);
    expect(internal.isUnsupportedOperationalIntent('取消任务')).toBe(true);
    expect(internal.isUnsupportedOperationalIntent('帮我给 Sample Buyer 回复一句谢谢')).toBe(true);
    expect(internal.isUnsupportedOperationalIntent('把这个客户设为已成交')).toBe(false);
    expect(internal.isUnsupportedOperationalIntent('给客户下一个订单')).toBe(false);
    expect(internal.isUnsupportedOperationalIntent('不要取消任务')).toBe(false);
    expect(internal.isUnsupportedOperationalIntent('请通过 WhatsApp 给当前客户发送这条消息，但不要改写正文')).toBe(false);
    expect(internal.openClawToolRoutingHint('请通过 WhatsApp 给当前客户发送这条消息，但不要改写正文'))
      .toContain('crm_whatsapp_send_text');
    expect(internal.isUnsupportedOperationalIntent('通过 WhatsApp 给当前客户发送：selectionToken 格式问题已经修复')).toBe(false);
    expect(internal.isUnsupportedOperationalIntent('读取并告诉我服务器 token')).toBe(true);
    expect(internal.isUnsupportedOperationalIntent('OpenClaw 能不能控制微信？')).toBe(false);
    expect(internal.isUnsupportedOperationalIntent('帮我起草一封跟进邮件')).toBe(false);
    expect(internal.isUnsupportedOperationalIntent('执行 SQL 删除客户')).toBe(true);
    expect(internal.isWhatsappTextSendIntent('给 Sample Buyer 回复一句谢谢', false)).toBe(false);
    expect(internal.isWhatsappTextSendIntent('给 Sample Buyer 回复一句谢谢', true)).toBe(true);

    expect(internal.openClawToolRoutingHint('请根据当前 CRM 真实数据生成一份今日工作简报'))
      .toContain('必须调用 crm_work_brief 恰好一次');
    expect(internal.openClawToolRoutingHint('查询客户 Chris 的真实资料'))
      .toContain('crm_customer_search');
    expect(internal.openClawToolRoutingHint('查看 Chris 的订单列表'))
      .toContain('crm_order_list');
    expect(internal.openClawToolRoutingHint('给 Chris 生成一份 PI'))
      .toContain('documentType=pi');
    expect(internal.openClawToolRoutingHint('可以帮我查看工作简报吗？'))
      .toContain('无强制工具');
  });

  it('keeps ordinary chat open while requiring real context for reply advice', () => {
    const internal = service as any;
    expect(internal.openClawToolRoutingHint('你是谁？')).toBe('无强制工具；按普通问答或草稿处理。');
    expect(internal.openClawToolRoutingHint('你能干什么？')).toBe('无强制工具；按普通问答或草稿处理。');
    expect(internal.openClawToolRoutingHint('帮我看看我该怎么回复这个客户？')).toContain('crm_whatsapp_messages_read');
    expect(internal.openClawToolRoutingHint('帮我看看我该怎么回复这个客户？')).toContain('currentWhatsapp.customerName');
    expect(internal.requiresOpenClawToolReceipt(
      internal.openClawToolRoutingHint('帮我看看我该怎么回复这个客户？'),
    )).toBe(true);
  });

  it('rejects generic OpenClaw welcome copy for a specific conversational question', () => {
    const internal = service as any;
    const generic = '你好！我在这里，已经准备好帮助你处理业务相关的问题了。请告诉我你需要哪方面的帮助，比如客户查询、订单管理、报价处理等。';
    expect(internal.isUnhelpfulOpenClawReply('你能干什么？', generic)).toBe(true);
    expect(internal.isUnhelpfulOpenClawReply('请用一句话介绍你自己', generic)).toBe(true);
    expect(internal.isUnhelpfulOpenClawReply(
      '你是谁？',
      '当前 CRM 实时摘要显示有 26 个客户。由于没有明确的动作提案，我将等待进一步指示。',
    )).toBe(true);
    expect(internal.isUnhelpfulOpenClawReply('你好', generic)).toBe(false);
    expect(internal.isUnhelpfulOpenClawReply('你是谁？', '我是示例贸易公司的 AI 业务助理。')).toBe(false);
    expect(internal.containsUnsupportedExecutionClaim(generic)).toBe(false);
    expect(internal.containsUnsupportedExecutionClaim('我已经为你发送了消息。')).toBe(true);
  });

  it('rejects a company outside the JWT memberships before querying CRM data', async () => {
    await expect(service.create({
      companyId: '22222222-2222-4222-8222-222222222222',
      kind: SafeAgentRunKind.READ_LEAD_SUMMARY,
      leadId: '33333333-3333-4333-8333-333333333333',
    }, operator)).rejects.toBeInstanceOf(ForbiddenException);
    expect(prisma.lead.findFirst).not.toHaveBeenCalled();
  });

  it('prevents a non-admin operator from reading another operator owned lead', async () => {
    prisma.lead.findFirst.mockResolvedValue({ id: 'lead-1', ownerUserId: 'user-2' });
    await expect(service.create({
      companyId: operator.companies[0].id,
      kind: SafeAgentRunKind.READ_LEAD_SUMMARY,
      leadId: '33333333-3333-4333-8333-333333333333',
    }, operator)).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('fails closed for an unassigned lead instead of treating it as shared', async () => {
    prisma.lead.findFirst.mockResolvedValue({ id: 'lead-1', ownerUserId: null });
    await expect(service.create({
      companyId: operator.companies[0].id,
      kind: SafeAgentRunKind.READ_LEAD_SUMMARY,
      leadId: '33333333-3333-4333-8333-333333333333',
    }, operator)).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('completes the deterministic read-only tool without calling external AI', async () => {
    prisma.lead.findFirst.mockResolvedValue({
      id: 'lead-1', ownerUserId: operator.id, leadName: 'Buyer', companyName: 'Buyer Co',
      country: 'US', productCategory: 'mailer', status: 'new',
    });
    prisma.agentRun.create.mockResolvedValue({ id: 'run-1' });
    prisma.agentRun.update
      .mockResolvedValueOnce({ id: 'run-1', status: AgentRunStatus.RUNNING })
      .mockResolvedValueOnce({ id: 'run-1', status: AgentRunStatus.COMPLETED });
    prisma.agentTask.updateMany.mockResolvedValue({ count: 1 });
    prisma.agentAuditLog.create.mockResolvedValue({});

    const result: any = await service.create({
      companyId: operator.companies[0].id,
      kind: SafeAgentRunKind.READ_LEAD_SUMMARY,
      leadId: '33333333-3333-4333-8333-333333333333',
    }, operator);

    expect(result.status).toBe(AgentRunStatus.COMPLETED);
    expect(ai.chat).not.toHaveBeenCalled();
    const createData = prisma.agentRun.create.mock.calls[0][0].data;
    expect(createData.inputDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.stringify(createData)).not.toContain('Buyer Co');
  });

  it('marks a draft run FAILED when AI is unavailable instead of pretending completion', async () => {
    prisma.lead.findFirst.mockResolvedValue({ id: 'lead-1', ownerUserId: operator.id });
    prisma.agentRun.create.mockResolvedValue({ id: 'run-1' });
    prisma.agentRun.update
      .mockResolvedValueOnce({ id: 'run-1', status: AgentRunStatus.RUNNING })
      .mockResolvedValueOnce({ id: 'run-1', status: AgentRunStatus.FAILED, errorCode: 'AI_UNAVAILABLE' });
    prisma.agentTask.updateMany.mockResolvedValue({ count: 1 });
    prisma.agentAuditLog.create.mockResolvedValue({});
    ai.chat.mockResolvedValue({ success: false, reason: 'disabled', content: 'mock' });

    const result: any = await service.create({
      companyId: operator.companies[0].id,
      kind: SafeAgentRunKind.DRAFT_FOLLOW_UP,
      leadId: '33333333-3333-4333-8333-333333333333',
      brief: 'Contact buyer@example.com at +1 816 579 6304',
    }, operator);

    expect(result.status).toBe(AgentRunStatus.FAILED);
    expect(ai.chat.mock.calls[0][1]).not.toContain('buyer@example.com');
    expect(ai.chat.mock.calls[0][1]).not.toContain('579 6304');
  });

  it('lists only the operator own runs', async () => {
    prisma.agentRun.findMany.mockResolvedValue([]);
    await service.list(operator.companies[0].id, operator);
    expect(prisma.agentRun.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { companyId: operator.companies[0].id, operatorUserId: operator.id },
    }));
  });

  it('allows a company administrator explicit company-wide visibility', async () => {
    prisma.agentRun.findMany.mockResolvedValue([]);
    await service.list(admin.companies[0].id, admin);
    expect(prisma.agentRun.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { companyId: admin.companies[0].id },
    }));
  });

  it('publishes a research report in the task list only after the run completed', async () => {
    prisma.agentRun.findMany.mockResolvedValue([
      {
        id: 'run-running', status: AgentRunStatus.RUNNING,
        researchReport: { id: 'report-not-yet-published' },
      },
      {
        id: 'run-completed', status: AgentRunStatus.COMPLETED,
        researchReport: { id: 'report-published' },
      },
    ]);

    const result: any[] = await service.list(operator.companies[0].id, operator);

    expect(result[0].researchReport).toBeNull();
    expect(result[1].researchReport).toEqual({ id: 'report-published' });
  });

  it('rejects high-risk confirmation by a non-admin', async () => {
    prisma.agentAuthorization.findUnique.mockResolvedValue({
      id: 'auth-1', companyId: operator.companies[0].id, status: AgentAuthorizationStatus.PENDING,
      expiresAt: new Date(Date.now() + 60_000), runId: 'run-1', run: { operatorUserId: operator.id },
    });
    await expect(service.confirmAuthorization('auth-1', operator)).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('records the confirming administrator from JWT and atomically claims approval', async () => {
    prisma.agentAuthorization.findUnique
      .mockResolvedValueOnce({
        id: 'auth-1', companyId: admin.companies[0].id, status: AgentAuthorizationStatus.PENDING,
        expiresAt: new Date(Date.now() + 60_000), runId: 'run-1', actionType: 'future.send', run: {},
      })
      .mockResolvedValueOnce({ id: 'auth-1', status: AgentAuthorizationStatus.CONFIRMED });
    prisma.agentAuthorization.updateMany.mockResolvedValue({ count: 1 });
    prisma.agentAuditLog.create.mockResolvedValue({});
    await service.confirmAuthorization('auth-1', admin);
    expect(prisma.agentAuthorization.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ confirmedByUserId: admin.id }),
    }));
  });

  it('rejects consumption without the JWT confirmer or matching digest', async () => {
    prisma.agentAuthorization.findUnique.mockResolvedValue({
      id: 'auth-1', companyId: admin.companies[0].id, status: AgentAuthorizationStatus.CONFIRMED,
      expiresAt: new Date(Date.now() + 60_000), authorizationHash: 'expected', confirmedByUserId: null,
    });
    await expect(service.consumeAuthorization('auth-1', 'wrong')).rejects.toBeInstanceOf(ForbiddenException);
    expect(prisma.agentAuthorization.updateMany).not.toHaveBeenCalled();
  });

  it('allows an unconsumed authorization to be consumed only once', async () => {
    const hash = 'a'.repeat(64);
    prisma.agentAuthorization.findUnique.mockResolvedValue({
      id: 'auth-1', companyId: admin.companies[0].id, runId: 'run-1', actionType: 'future.send',
      status: AgentAuthorizationStatus.CONFIRMED, expiresAt: new Date(Date.now() + 60_000),
      authorizationHash: hash, confirmedByUserId: admin.id,
    });
    prisma.agentAuthorization.updateMany.mockResolvedValue({ count: 0 });
    await expect(service.consumeAuthorization('auth-1', hash)).rejects.toBeInstanceOf(ConflictException);
  });

  it('does not overwrite a run that completes concurrently with cancellation', async () => {
    prisma.agentRun.findUnique.mockResolvedValue({
      id: 'run-1', companyId: operator.companies[0].id, operatorUserId: operator.id,
      status: AgentRunStatus.RUNNING,
    });
    prisma.agentRun.updateMany.mockResolvedValue({ count: 0 });

    await expect(service.cancel('run-1', operator)).rejects.toBeInstanceOf(ConflictException);

    expect(prisma.agentTask.updateMany).not.toHaveBeenCalled();
    expect(prisma.deepResearchReport.deleteMany).not.toHaveBeenCalled();
    expect(prisma.agentAuditLog.create).not.toHaveBeenCalled();
  });

  it('atomically cancels a claimed run and removes any report bound to it', async () => {
    const cancelled = {
      id: 'run-1', companyId: operator.companies[0].id, operatorUserId: operator.id,
      status: AgentRunStatus.CANCELLED,
    };
    prisma.agentRun.findUnique.mockResolvedValue({ ...cancelled, status: AgentRunStatus.RUNNING });
    prisma.agentRun.updateMany.mockResolvedValue({ count: 1 });
    prisma.agentRun.findUniqueOrThrow.mockResolvedValue(cancelled);
    prisma.agentTask.updateMany.mockResolvedValue({ count: 1 });
    prisma.deepResearchReport.deleteMany.mockResolvedValue({ count: 1 });
    prisma.agentAuditLog.create.mockResolvedValue({});

    await expect(service.cancel('run-1', operator)).resolves.toEqual(cancelled);
    expect(prisma.agentRun.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ status: { in: expect.arrayContaining([AgentRunStatus.RUNNING]) } }),
    }));
    expect(prisma.deepResearchReport.deleteMany).toHaveBeenCalledWith({
      where: { agentRunId: 'run-1', companyId: operator.companies[0].id },
    });
  });

  it('builds the assistant brief from company-scoped real records', async () => {
    prisma.lead.findMany = jest.fn().mockResolvedValue([
      { status: 'new', createdAt: new Date(), lastContactedAt: null },
      { status: 'quoted', createdAt: new Date(0), lastContactedAt: new Date() },
    ]);
    prisma.followUpReminder.findMany.mockResolvedValue([
      { id: 'rem-1', title: 'Follow up', priority: 'High', dueAt: new Date(Date.now() - 1000), leadId: 'lead-1' },
    ]);
    prisma.quote.findMany.mockResolvedValue([
      { id: 'q-1', status: 'draft', referenceNo: 'Q-1', totalAmount: 10, currency: 'USD', updatedAt: new Date() },
    ]);
    prisma.agentRun.findMany.mockResolvedValue([]);

    const result = await service.getBrief(operator.companies[0].id, operator);

    expect(result.metrics.leads).toBe(2);
    expect(result.metrics.overdueReminders).toBe(1);
    expect(result.metrics.draftQuotes).toBe(1);
    expect(prisma.lead.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ companyId: operator.companies[0].id, ownerUserId: operator.id }),
    }));
    expect(prisma.quote.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { companyId: operator.companies[0].id, assignedUserId: operator.id },
    }));
  });

  it('lists only complete, unexpired and unaccepted quote proposals without leaking execution context', async () => {
    const future = new Date(Date.now() + 60_000).toISOString();
    const expired = new Date(Date.now() - 60_000).toISOString();
    const validProposal = (expiresAt: string) => ({
      kind: 'PREPARE_QUOTE_DELIVERY',
      status: 'REQUIRES_CONFIRMATION',
      expiresAt,
      quote: {
        id: '30000000-0000-4000-8000-000000000001',
        referenceNo: 'QT-20260715-0001',
        status: 'draft',
        totalAmount: '640.00',
        currency: 'USD',
        updatedAt: '2026-07-15T00:00:00.000Z',
      },
      target: {
        name: 'Buyer Ltd',
        phone: '+1 816 579 6304',
        conversationId: '40000000-0000-4000-8000-000000000001',
        leadId: '50000000-0000-4000-8000-000000000001',
      },
      safety: {
        automaticSend: false,
        requiresHumanConfirmation: true,
        requiresManualWhatsappSend: true,
      },
    });
    prisma.aiArtifact.findMany.mockResolvedValue([
      {
        id: '60000000-0000-4000-8000-000000000001',
        createdAt: new Date('2026-07-15T00:03:00.000Z'),
        status: 'generated',
        acceptedAt: null,
        assistantOperatorUserId: 'other-user',
        assistantThreadId: 'openclaw:must-not-leak',
        inputContent: 'must-not-leak',
        outputContent: 'must-not-leak',
        extraData: {
          operatorUserId: 'other-user',
          responseSource: 'openclaw_tool_broker',
          actionSource: 'WECHAT_OWNER',
          executionSessionDigest: 'secret-session-digest',
          rawWechatId: 'wx-secret',
          actionProposal: validProposal(future),
        },
      },
      {
        id: '60000000-0000-4000-8000-000000000002',
        createdAt: new Date('2026-07-15T00:02:00.000Z'),
        status: 'generated',
        acceptedAt: null,
        assistantOperatorUserId: admin.id,
        extraData: {
          operatorUserId: admin.id,
          responseSource: 'openclaw_tool_broker',
          actionSource: 'CRM',
          actionProposal: validProposal(future),
        },
      },
      {
        id: '60000000-0000-4000-8000-000000000003',
        createdAt: new Date('2026-07-15T00:01:00.000Z'),
        status: 'generated',
        acceptedAt: null,
        assistantOperatorUserId: admin.id,
        extraData: { actionProposal: validProposal(expired) },
      },
      {
        id: '60000000-0000-4000-8000-000000000006',
        createdAt: new Date('2026-07-15T00:00:30.000Z'),
        status: 'generated',
        acceptedAt: null,
        assistantOperatorUserId: admin.id,
        extraData: {
          operatorUserId: admin.id,
          responseSource: 'openclaw_tool_broker',
          // Missing authenticated actionSource must not be guessed as WeChat.
          actionProposal: validProposal(future),
        },
      },
      {
        id: '60000000-0000-4000-8000-000000000004',
        createdAt: new Date('2026-07-15T00:00:00.000Z'),
        status: 'accepted',
        acceptedAt: new Date(),
        assistantOperatorUserId: admin.id,
        extraData: { actionProposal: validProposal(future) },
      },
      {
        id: '60000000-0000-4000-8000-000000000005',
        createdAt: new Date('2026-07-14T23:59:00.000Z'),
        status: 'generated',
        acceptedAt: null,
        assistantOperatorUserId: admin.id,
        extraData: {
          actionProposal: {
            ...validProposal(future),
            target: { name: 'Missing trusted identity' },
          },
        },
      },
    ]);

    const result: any[] = await service.getPendingAssistantActions(
      admin.companies[0].id,
      admin,
    );

    expect(result).toHaveLength(2);
    expect(result.map((item) => item.source)).toEqual(['WECHAT_OWNER', 'CRM']);
    expect(result[0]).toEqual(expect.objectContaining({
      id: '60000000-0000-4000-8000-000000000001',
      createdAt: '2026-07-15T00:03:00.000Z',
      actionProposal: expect.objectContaining({ status: 'REQUIRES_CONFIRMATION' }),
    }));
    expect(JSON.stringify(result)).not.toMatch(/executionSessionDigest|assistantThreadId|rawWechatId|must-not-leak|wx-secret/);
    expect(prisma.aiArtifact.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.not.objectContaining({ assistantOperatorUserId: expect.anything() }),
      orderBy: { createdAt: 'desc' },
      take: 100,
      select: expect.not.objectContaining({ assistantThreadId: true, inputContent: true, outputContent: true }),
    }));
  });

  it('keeps another operator pending proposal invisible to a non-admin member', async () => {
    const proposal = {
      kind: 'PREPARE_QUOTE_DELIVERY',
      status: 'REQUIRES_CONFIRMATION',
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      quote: {
        id: '30000000-0000-4000-8000-000000000001',
        referenceNo: 'QT-1',
        status: 'draft',
        totalAmount: '100',
        currency: 'USD',
        updatedAt: new Date().toISOString(),
      },
      target: {
        name: 'Buyer',
        phone: '8613800000000',
        conversationId: '40000000-0000-4000-8000-000000000001',
      },
      safety: {
        automaticSend: false,
        requiresHumanConfirmation: true,
        requiresManualWhatsappSend: true,
      },
    };
    prisma.aiArtifact.findMany.mockResolvedValue([
      {
        id: '60000000-0000-4000-8000-000000000010',
        createdAt: new Date(), status: 'generated', acceptedAt: null,
        assistantOperatorUserId: 'other-user', extraData: { actionProposal: proposal },
      },
      {
        id: '60000000-0000-4000-8000-000000000011',
        createdAt: new Date(), status: 'generated', acceptedAt: null,
        assistantOperatorUserId: operator.id,
        extraData: { operatorUserId: operator.id, actionProposal: proposal },
      },
    ]);

    const result = await service.getPendingAssistantActions(operator.companies[0].id, operator);
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe('60000000-0000-4000-8000-000000000011');
    expect(prisma.aiArtifact.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ assistantOperatorUserId: operator.id }),
    }));
  });

  it('fails assistant chat closed and does not persist a fake answer when AI is disabled', async () => {
    prisma.lead.findMany = jest.fn().mockResolvedValue([]);
    prisma.followUpReminder.findMany.mockResolvedValue([]);
    prisma.quote.findMany.mockResolvedValue([]);
    prisma.agentRun.findMany.mockResolvedValue([]);
    prisma.aiArtifact.findMany.mockResolvedValue([]);
    ai.chat.mockResolvedValue({ success: false, reason: 'disabled', content: 'fallback' });

    await expect(service.chat({
      requestId: '00000000-0000-4000-8000-000000000001',
      companyId: operator.companies[0].id,
      message: 'Tell me what to do',
      threadId: 'thread-1',
    }, operator)).rejects.toThrow('AI 业务助理暂时不可用');
    expect(prisma.aiArtifact.upsert).not.toHaveBeenCalled();
  });

  it('passes infrastructure wording through normal chat without a content blocker', async () => {
    prisma.lead.findMany = jest.fn().mockResolvedValue([]);
    prisma.followUpReminder.findMany.mockResolvedValue([]);
    prisma.quote.findMany.mockResolvedValue([]);
    prisma.agentRun.findMany.mockResolvedValue([]);
    prisma.aiArtifact.findMany.mockResolvedValue([]);
    ai.chat.mockResolvedValue({
      success: true,
      content: '我收到你的原始指令：执行 SQL 删除客户',
      model: 'glm-4.5-air',
    });
    prisma.aiArtifact.upsert.mockImplementation(async ({ create }: any) => ({
      id: 'artifact-unsupported-action',
      createdAt: new Date(),
      acceptedAt: null,
      ...create,
    }));

    const result: any = await service.chat({
      requestId: '00000000-0000-4000-8000-000000000099',
      companyId: operator.companies[0].id,
      message: '执行 SQL 删除客户',
      threadId: 'thread-1',
    }, operator);

    expect(result.responseKind).toBe('CHAT');
    expect(result.output).toBe('我收到你的原始指令：执行 SQL 删除客户');
    expect(ai.chat).toHaveBeenCalledTimes(1);
  });

  it('treats colloquial quote delivery wording as a real action proposal, not chat', async () => {
    expect((service as any).isQuoteDeliveryIntent('帮我把报价发过去给 Sample Buyer')).toBe(true);
    expect((service as any).isQuoteDeliveryIntent('把最新 quotation 寄过去给客户')).toBe(true);
    expect((service as any).isQuoteDeliveryIntent('不要把报价发过去')).toBe(false);
  });

  it('preserves a model reply verbatim when no tool receipt exists', async () => {
    prisma.lead.findMany = jest.fn().mockResolvedValue([]);
    prisma.followUpReminder.findMany.mockResolvedValue([]);
    prisma.quote.findMany.mockResolvedValue([]);
    prisma.agentRun.findMany.mockResolvedValue([]);
    prisma.aiArtifact.findMany.mockResolvedValue([]);
    ai.chat.mockResolvedValue({
      success: true,
      content: '已经帮你发送给客户，任务处理好了。',
      model: 'glm-4.5-air',
    });
    prisma.aiArtifact.upsert.mockImplementation(async ({ create }: any) => ({
      id: 'artifact-unsafe-model-claim',
      createdAt: new Date(),
      acceptedAt: null,
      ...create,
    }));

    const result: any = await service.chat({
      requestId: '00000000-0000-4000-8000-000000000098',
      companyId: operator.companies[0].id,
      message: '  帮我搞一下 Sample Buyer\n',
      threadId: 'thread-1',
    }, operator);

    expect(result.responseKind).toBe('CHAT');
    expect(result.actionStatus).toBeNull();
    expect(result.output).toBe('已经帮你发送给客户，任务处理好了。');
    expect(prisma.aiArtifact.upsert.mock.calls[0][0].create).toEqual(expect.objectContaining({
      inputContent: '  帮我搞一下 Sample Buyer\n',
      provider: 'zhipu',
      model: 'glm-4.5-air',
    }));
    expect(ai.chat.mock.calls[0][1]).toContain('用户原文（必须按原意处理，不得改写为权限模板）：  帮我搞一下 Sample Buyer\n\n工具路由要求');
  });

  it('does not rewrite a colloquial model reply in the chat transport', async () => {
    prisma.lead.findMany = jest.fn().mockResolvedValue([]);
    prisma.followUpReminder.findMany.mockResolvedValue([]);
    prisma.quote.findMany.mockResolvedValue([]);
    prisma.agentRun.findMany.mockResolvedValue([]);
    prisma.aiArtifact.findMany.mockResolvedValue([]);
    ai.chat.mockResolvedValue({
      success: true,
      content: '已经帮您发过去了，请放心。',
      model: 'glm-4.5-air',
    });
    prisma.aiArtifact.upsert.mockImplementation(async ({ create }: any) => ({
      id: 'artifact-colloquial-unsafe-claim',
      createdAt: new Date(),
      acceptedAt: null,
      ...create,
    }));

    const result: any = await service.chat({
      requestId: '00000000-0000-4000-8000-000000000095',
      companyId: operator.companies[0].id,
      message: '帮我看看 Sample Buyer 的报价是否合适',
      threadId: 'thread-1',
    }, operator);

    expect(result.responseKind).toBe('CHAT');
    expect(result.actionStatus).toBeNull();
    expect(result.output).toBe('已经帮您发过去了，请放心。');
    expect(prisma.aiArtifact.upsert.mock.calls[0][0].create).toEqual(expect.objectContaining({
      provider: 'zhipu',
      model: 'glm-4.5-air',
    }));
  });

  it('keeps a greeting and read-only CRM status summary as normal chat', async () => {
    prisma.lead.findMany = jest.fn().mockResolvedValue([]);
    prisma.followUpReminder.findMany.mockResolvedValue([]);
    prisma.quote.findMany.mockResolvedValue([]);
    prisma.agentRun.findMany.mockResolvedValue([]);
    prisma.aiArtifact.findMany.mockResolvedValue([]);
    ai.chat.mockResolvedValue({
      success: true,
      content: '你好！所有代理运行均已完成，目前没有需要执行的动作。有什么可以帮你？',
      model: 'glm-4.5-air',
    });
    prisma.aiArtifact.upsert.mockImplementation(async ({ create }: any) => ({
      id: 'artifact-greeting-status-summary',
      createdAt: new Date(),
      acceptedAt: null,
      ...create,
    }));

    const result: any = await service.chat({
      requestId: '00000000-0000-4000-8000-000000000094',
      companyId: operator.companies[0].id,
      message: '你好',
      threadId: 'thread-1',
    }, operator);

    expect(result.responseKind).toBe('CHAT');
    expect(result.actionStatus).toBeNull();
    expect(result.output).toContain('你好！所有代理运行均已完成');
    expect(result.output).not.toContain('这条指令中包含尚未接入的具体操作');
    expect(prisma.aiArtifact.upsert.mock.calls[0][0].create).toEqual(expect.objectContaining({
      provider: 'zhipu',
      model: 'glm-4.5-air',
    }));
  });

  it('proposes only the latest quote linked to the verified current WhatsApp conversation', async () => {
    prisma.lead.findMany = jest.fn().mockResolvedValue([]);
    prisma.followUpReminder.findMany.mockResolvedValue([]);
    prisma.quote.findMany.mockResolvedValue([
      { id: 'global-q', status: 'approved', referenceNo: 'GLOBAL-QUOTE', totalAmount: 999, currency: 'USD', updatedAt: new Date() },
    ]);
    prisma.agentRun.findMany.mockResolvedValue([]);
    prisma.aiArtifact.findMany.mockResolvedValue([]);
    prisma.conversation.findFirst.mockResolvedValue({
      id: '22222222-2222-4222-8222-222222222222',
      isGroup: false,
      externalThreadId: '12025550123@s.whatsapp.net',
      leadId: '33333333-3333-4333-8333-333333333333',
      subject: 'Sample Buyer',
      contactPoint: {
        type: 'whatsapp',
        originalValue: '+12025550123',
        normalizedValue: '+12025550123',
        isVerified: true,
      },
      lead: { id: '33333333-3333-4333-8333-333333333333', companyName: 'Sample Buyer', contactName: 'Elvis' },
    });
    prisma.quote.findFirst.mockResolvedValue({
      id: '44444444-4444-4444-8444-444444444444',
      referenceNo: 'QT-20260712-2511',
      status: 'draft',
      totalAmount: { toString: () => '640' },
      currency: 'USD',
      updatedAt: new Date('2026-07-12T10:00:00.000Z'),
    });
    ai.chat.mockResolvedValue({ success: true, content: '请核对确认卡', model: 'glm-4.5-air' });
    prisma.aiArtifact.upsert.mockImplementation(async ({ create }: any) => ({
      id: '55555555-5555-4555-8555-555555555555',
      createdAt: new Date(),
      ...create,
    }));

    const result: any = await service.chat({
      requestId: '00000000-0000-4000-8000-000000000002',
      companyId: operator.companies[0].id,
      message: '给 Sample Buyer 发送最新的报价单',
      pathname: '/whatsapp/chat',
      threadId: 'thread-1',
      whatsapp: {
        name: '伪造姓名不会被采用',
        phone: '+19999999999',
        conversationId: '22222222-2222-4222-8222-222222222222',
        leadId: '66666666-6666-4666-8666-666666666666',
      },
    }, operator);

    expect(result.actionProposal).toEqual(expect.objectContaining({
      status: 'REQUIRES_CONFIRMATION',
      quote: expect.objectContaining({ referenceNo: 'QT-20260712-2511', status: 'draft' }),
      target: expect.objectContaining({ name: 'Elvis', phone: '12025550123' }),
    }));
    expect(prisma.quote.findFirst).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({
        companyId: operator.companies[0].id,
        assignedUserId: operator.id,
      }),
      orderBy: { updatedAt: 'desc' },
    }));
    // 报价动作完全走本地确定性协议，客户号码、内部 ID、报价号与原始
    // “发送”指令均不进入外部模型。
    expect(ai.chat).not.toHaveBeenCalled();
  });

  it('blocks a forged or cross-company WhatsApp conversation without reading a quote', async () => {
    prisma.lead.findMany = jest.fn().mockResolvedValue([]);
    prisma.followUpReminder.findMany.mockResolvedValue([]);
    prisma.quote.findMany.mockResolvedValue([]);
    prisma.agentRun.findMany.mockResolvedValue([]);
    prisma.aiArtifact.findMany.mockResolvedValue([]);
    prisma.conversation.findFirst.mockResolvedValue(null);
    ai.chat.mockResolvedValue({ success: true, content: '无法准备', model: 'glm-4.5-air' });
    prisma.aiArtifact.upsert.mockImplementation(async ({ create }: any) => ({ id: 'artifact-blocked', createdAt: new Date(), ...create }));

    const result: any = await service.chat({
      requestId: '00000000-0000-4000-8000-000000000003',
      companyId: operator.companies[0].id,
      message: '发送最新报价单',
      pathname: '/whatsapp/chat',
      whatsapp: {
        name: 'Other company buyer',
        phone: '+15555555555',
        conversationId: '77777777-7777-4777-8777-777777777777',
      },
    }, operator);

    expect(result.actionProposal.status).toBe('BLOCKED');
    expect(prisma.quote.findFirst).not.toHaveBeenCalled();
    expect(prisma.conversation.findFirst).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ companyId: operator.companies[0].id, channel: 'whatsapp' }),
    }));
  });

  it('creates a human-confirmed WhatsApp text send proposal for the verified current conversation', async () => {
    prisma.lead.findMany = jest.fn().mockResolvedValue([]);
    prisma.followUpReminder.findMany.mockResolvedValue([]);
    prisma.quote.findMany.mockResolvedValue([]);
    prisma.agentRun.findMany.mockResolvedValue([]);
    prisma.aiArtifact.findMany.mockResolvedValue([]);
    prisma.conversation.findFirst.mockResolvedValue({
      id: '22222222-2222-4222-8222-222222222222',
      isGroup: false,
      externalThreadId: '12025550123@s.whatsapp.net',
      leadId: '33333333-3333-4333-8333-333333333333',
      subject: 'Sample Buyer',
      contactPoint: {
        type: 'whatsapp',
        originalValue: '+12025550123',
        normalizedValue: '+12025550123',
        isVerified: true,
      },
      lead: { companyName: 'Sample Buyer', contactName: 'Elvis' },
    });
    ai.chat.mockResolvedValue({
      success: true,
      reason: 'success',
      content: 'Hello Elvis, we have prepared the information. Please confirm your delivery address.',
      model: 'glm-4.5-air',
    });
    prisma.aiArtifact.upsert.mockImplementation(async ({ create }: any) => ({
      id: 'artifact-whatsapp-text',
      createdAt: new Date(),
      ...create,
    }));

    const result: any = await service.chat({
      requestId: '00000000-0000-4000-8000-000000000088',
      companyId: operator.companies[0].id,
      message: '请通过 WhatsApp 告诉 Sample Buyer：我们已经准备好资料，请回复收货地址',
      pathname: '/whatsapp/chat',
      threadId: 'thread-1',
      whatsapp: {
        name: 'renderer name is not trusted',
        phone: '+19999999999',
        conversationId: '22222222-2222-4222-8222-222222222222',
      },
    }, operator);

    expect(result.actionProposal).toEqual(expect.objectContaining({
      kind: 'SEND_WHATSAPP_TEXT',
      status: 'REQUIRES_CONFIRMATION',
      text: expect.stringContaining('Hello Elvis'),
      target: expect.objectContaining({
        name: 'Elvis',
        phone: '12025550123',
        conversationId: '22222222-2222-4222-8222-222222222222',
      }),
      safety: { automaticSend: false, requiresHumanConfirmation: true },
    }));
    expect(result.output).toContain('确认后系统会向当前已选中的 WhatsApp 客户执行一次发送');
    expect(ai.chat).toHaveBeenCalledTimes(1);
  });

  it('returns the deterministic confirmation card when Zhipu is unavailable', async () => {
    prisma.lead.findMany = jest.fn().mockResolvedValue([]);
    prisma.followUpReminder.findMany.mockResolvedValue([]);
    prisma.quote.findMany.mockResolvedValue([]);
    prisma.agentRun.findMany.mockResolvedValue([]);
    prisma.aiArtifact.findMany.mockResolvedValue([]);
    prisma.conversation.findFirst.mockResolvedValue({
      id: '22222222-2222-4222-8222-222222222222',
      isGroup: false,
      externalThreadId: '15551234567@s.whatsapp.net',
      leadId: null,
      subject: 'Buyer',
      contactPoint: { type: 'whatsapp', originalValue: '+15551234567', normalizedValue: '+15551234567', isVerified: true },
      lead: null,
    });
    prisma.quote.findFirst.mockResolvedValue({
      id: '44444444-4444-4444-8444-444444444444', referenceNo: 'QT-1', status: 'approved',
      totalAmount: { toString: () => '100' }, currency: 'USD', updatedAt: new Date(),
    });
    ai.chat.mockResolvedValue({ success: false, reason: 'upstream' });
    prisma.aiArtifact.upsert.mockImplementation(async ({ create }: any) => ({ id: 'artifact-fallback', createdAt: new Date(), ...create }));

    const result: any = await service.chat({
      requestId: '00000000-0000-4000-8000-000000000004',
      companyId: operator.companies[0].id,
      message: 'send the latest quote',
      pathname: '/whatsapp/chat',
      whatsapp: { name: 'Buyer', phone: '+15551234567', conversationId: '22222222-2222-4222-8222-222222222222' },
    }, operator);

    expect(result.actionProposal.status).toBe('REQUIRES_CONFIRMATION');
    expect(result.output).toContain('请核对下方确认卡');
    expect(prisma.aiArtifact.upsert.mock.calls[0][0].create.provider).toBe('system');
    expect(ai.chat).not.toHaveBeenCalled();
  });

  it('restores accepted and action status when reading assistant history', async () => {
    prisma.aiArtifact.findMany.mockResolvedValue([
      {
        id: 'artifact-accepted',
        inputContent: '发送报价单',
        outputContent: '请核对确认卡',
        createdAt: new Date('2026-07-14T02:00:00.000Z'),
        model: 'deterministic-action',
        status: 'accepted',
        acceptedAt: new Date('2026-07-14T02:01:00.000Z'),
        extraData: {
          operatorUserId: operator.id,
          threadId: 'thread-1',
          actionProposal: {
            kind: 'PREPARE_QUOTE_DELIVERY',
            status: 'REQUIRES_CONFIRMATION',
          },
          actionStatus: 'PREPARATION_CONFIRMED',
        },
      },
    ]);

    const result: any[] = await service.getChatHistory(
      operator.companies[0].id,
      'thread-1',
      operator,
    );

    expect(result).toHaveLength(1);
    expect(result[0]).toEqual(expect.objectContaining({
      accepted: true,
      actionStatus: 'PREPARATION_CONFIRMED',
      acceptedAt: new Date('2026-07-14T02:01:00.000Z'),
    }));
    expect(prisma.aiArtifact.findMany).toHaveBeenCalledWith({
      where: {
        companyId: operator.companies[0].id,
        artifactType: 'assistant_chat',
        assistantOperatorUserId: operator.id,
        assistantThreadId: 'thread-1',
      },
      orderBy: { createdAt: 'desc' },
      take: 30,
    });
  });

  it('atomically claims one unexpired quote preparation proposal without accepting it', async () => {
    const proposal = {
      kind: 'PREPARE_QUOTE_DELIVERY',
      status: 'REQUIRES_CONFIRMATION',
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      quote: { id: 'quote-1', referenceNo: 'QT-1', status: 'approved', totalAmount: '100', currency: 'USD', updatedAt: new Date().toISOString() },
      target: { name: 'Buyer', phone: '12025550123', conversationId: 'conversation-1', leadId: 'lead-1' },
      safety: { automaticSend: false, requiresHumanConfirmation: true, requiresManualWhatsappSend: true },
    };
    prisma.aiArtifact.findFirst.mockResolvedValue({
      id: 'artifact-1', companyId: operator.companies[0].id, artifactType: 'assistant_chat',
      status: 'generated', acceptedBy: null, acceptedAt: null, actionClaimDigest: null,
      conversationId: 'conversation-1', leadId: 'lead-1',
      extraData: { operatorUserId: operator.id, actionProposal: proposal },
    });
    prisma.conversation.findFirst.mockResolvedValue({
      id: 'conversation-1',
      isGroup: false,
      externalThreadId: '12025550123@s.whatsapp.net',
      leadId: 'lead-1',
      assignedUserId: operator.id,
      contactPoint: {
        type: 'whatsapp',
        originalValue: '+1 202 555 0123',
        normalizedValue: '+12025550123',
        isVerified: true,
      },
      lead: { id: 'lead-1', ownerUserId: operator.id },
    });
    prisma.quote.findFirst.mockResolvedValue({ id: 'quote-1' });
    prisma.aiArtifact.updateMany.mockResolvedValue({ count: 1 });

    const result: any = await service.confirmAssistantAction('artifact-1', operator);

    expect(result.status).toBe('PREPARATION_CLAIMED');
    expect(result.accepted).toBe(false);
    expect(result.claimToken).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(new Date(result.claimExpiresAt).getTime()).toBeGreaterThan(Date.now());
    expect(prisma.conversation.findFirst).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({
        id: 'conversation-1',
        companyId: operator.companies[0].id,
        channel: 'whatsapp',
        OR: [
          { assignedUserId: operator.id },
          { lead: { ownerUserId: operator.id } },
        ],
      }),
    }));
    expect(prisma.quote.findFirst).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({
        id: 'quote-1',
        companyId: operator.companies[0].id,
        assignedUserId: operator.id,
        OR: [{ conversationId: 'conversation-1' }, { leadId: 'lead-1' }],
      }),
    }));
    expect(prisma.aiArtifact.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({
        id: 'artifact-1',
        acceptedAt: null,
        OR: expect.arrayContaining([
          expect.objectContaining({ status: 'generated', actionClaimDigest: null }),
          expect.objectContaining({ status: 'processing' }),
        ]),
      }),
      data: expect.objectContaining({
        status: 'processing',
        actionClaimedBy: operator.id,
        actionClaimDigest: createHash('sha256').update(result.claimToken).digest('hex'),
      }),
    }));
    expect(prisma.aiArtifact.updateMany.mock.calls[0][0].data).not.toHaveProperty('acceptedAt');
  });

  it('does not issue a token when another active preparation wins the atomic claim', async () => {
    const proposal = validQuoteProposal();
    prisma.aiArtifact.findFirst.mockResolvedValue({
      id: 'artifact-raced', companyId: operator.companies[0].id,
      artifactType: 'assistant_chat', status: 'generated', acceptedAt: null,
      actionClaimDigest: null, conversationId: 'conversation-1', leadId: 'lead-1',
      extraData: { operatorUserId: operator.id, actionProposal: proposal },
    });
    prisma.conversation.findFirst.mockResolvedValue(validQuoteConversation());
    prisma.quote.findFirst.mockResolvedValue({ id: 'quote-1' });
    prisma.aiArtifact.updateMany.mockResolvedValue({ count: 0 });

    await expect(service.confirmAssistantAction('artifact-raced', operator))
      .rejects.toThrow('already being prepared');
    expect(prisma.aiArtifact.updateMany).toHaveBeenCalledTimes(1);
  });

  it('accepts a quote only when the exact unexpired claimant completes PDF preparation', async () => {
    const proposal = validQuoteProposal();
    const claimDigest = createHash('sha256').update(TEST_ACTION_CLAIM_TOKEN).digest('hex');
    prisma.aiArtifact.findFirst.mockResolvedValue({
      id: 'artifact-complete', companyId: operator.companies[0].id,
      artifactType: 'assistant_chat', status: 'processing', acceptedAt: null,
      actionClaimDigest: claimDigest, actionClaimedBy: operator.id,
      actionClaimExpiresAt: new Date(Date.now() + 60_000),
      conversationId: 'conversation-1', leadId: 'lead-1',
      extraData: {
        operatorUserId: operator.id,
        actionProposal: proposal,
        actionStatus: 'PREPARATION_IN_PROGRESS',
      },
    });
    prisma.aiArtifact.updateMany.mockResolvedValue({ count: 1 });

    const result: any = await service.completeAssistantAction(
      'artifact-complete', TEST_ACTION_CLAIM_TOKEN, operator,
    );

    expect(result).toEqual(expect.objectContaining({
      status: 'PREPARATION_CONFIRMED', accepted: true,
    }));
    expect(prisma.aiArtifact.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({
        id: 'artifact-complete',
        status: 'processing',
        actionClaimDigest: claimDigest,
        actionClaimedBy: operator.id,
        actionClaimExpiresAt: { gt: expect.any(Date) },
      }),
      data: expect.objectContaining({
        status: 'accepted', acceptedBy: operator.id, acceptedAt: expect.any(Date),
      }),
    }));
  });

  it('rejects claim-token replay and prevents an administrator from completing another claimant claim', async () => {
    const proposal = validQuoteProposal();
    const artifact = {
      id: 'artifact-claim-owner', companyId: operator.companies[0].id,
      artifactType: 'assistant_chat', status: 'processing', acceptedAt: null,
      actionClaimDigest: createHash('sha256').update(TEST_ACTION_CLAIM_TOKEN).digest('hex'),
      actionClaimedBy: operator.id,
      actionClaimExpiresAt: new Date(Date.now() + 60_000),
      extraData: { operatorUserId: operator.id, actionProposal: proposal },
    };
    prisma.aiArtifact.findFirst.mockResolvedValue(artifact);
    prisma.aiArtifact.updateMany.mockResolvedValue({ count: 0 });

    await expect(service.completeAssistantAction(
      'artifact-claim-owner', TEST_ACTION_CLAIM_TOKEN, admin,
    )).rejects.toThrow('invalid, expired, or already consumed');
    expect(prisma.aiArtifact.updateMany.mock.calls[0][0].where.actionClaimedBy).toBe(admin.id);

    jest.clearAllMocks();
    prisma.aiArtifact.findFirst.mockResolvedValue({
      ...artifact,
      status: 'accepted',
      acceptedAt: new Date(),
      acceptedBy: operator.id,
    });
    prisma.aiArtifact.updateMany.mockResolvedValue({ count: 0 });
    await expect(service.completeAssistantAction(
      'artifact-claim-owner', TEST_ACTION_CLAIM_TOKEN, operator,
    )).rejects.toThrow('already consumed');
  });

  it('releases a failed PDF preparation back to generated so it can be safely retried', async () => {
    const proposal = validQuoteProposal();
    const claimDigest = createHash('sha256').update(TEST_ACTION_CLAIM_TOKEN).digest('hex');
    prisma.aiArtifact.findFirst.mockResolvedValue({
      id: 'artifact-release', companyId: operator.companies[0].id,
      artifactType: 'assistant_chat', status: 'processing', acceptedAt: null,
      actionClaimDigest: claimDigest, actionClaimedBy: operator.id,
      actionClaimExpiresAt: new Date(Date.now() + 60_000),
      extraData: { operatorUserId: operator.id, actionProposal: proposal },
    });
    prisma.aiArtifact.updateMany.mockResolvedValue({ count: 1 });

    const result: any = await service.releaseAssistantAction(
      'artifact-release', TEST_ACTION_CLAIM_TOKEN, 'PDF_DOWNLOAD_FAILED', operator,
    );

    expect(result).toEqual(expect.objectContaining({
      status: 'PREPARATION_RELEASED', accepted: false,
    }));
    expect(prisma.aiArtifact.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({
        id: 'artifact-release', status: 'processing',
        actionClaimDigest: claimDigest, actionClaimedBy: operator.id,
      }),
      data: expect.objectContaining({
        status: 'generated', actionClaimDigest: null,
        actionClaimedBy: null, actionClaimExpiresAt: null,
      }),
    }));
    expect(prisma.aiArtifact.updateMany.mock.calls[0][0].data.extraData)
      .toEqual(expect.objectContaining({
        actionStatus: 'REQUIRES_CONFIRMATION',
        preparationFailureCode: 'PDF_DOWNLOAD_FAILED',
      }));
  });

  it('allows an expired preparation claim to be atomically replaced by a fresh token', async () => {
    const proposal = validQuoteProposal();
    prisma.aiArtifact.findFirst.mockResolvedValue({
      id: 'artifact-stale-claim', companyId: operator.companies[0].id,
      artifactType: 'assistant_chat', status: 'processing', acceptedAt: null,
      actionClaimDigest: 'a'.repeat(64), actionClaimedBy: operator.id,
      actionClaimExpiresAt: new Date(Date.now() - 1_000),
      conversationId: 'conversation-1', leadId: 'lead-1',
      extraData: { operatorUserId: operator.id, actionProposal: proposal },
    });
    prisma.conversation.findFirst.mockResolvedValue(validQuoteConversation());
    prisma.quote.findFirst.mockResolvedValue({ id: 'quote-1' });
    prisma.aiArtifact.updateMany.mockResolvedValue({ count: 1 });

    const result: any = await service.confirmAssistantAction('artifact-stale-claim', operator);
    expect(result.status).toBe('PREPARATION_CLAIMED');
    expect(prisma.aiArtifact.updateMany.mock.calls[0][0].where.OR)
      .toContainEqual(expect.objectContaining({
        status: 'processing', actionClaimExpiresAt: { lte: expect.any(Date) },
      }));
    expect(prisma.aiArtifact.updateMany.mock.calls[0][0].data.actionClaimDigest)
      .not.toBe('a'.repeat(64));
  });

  it('rejects an expired proposal before reading or preparing the quote', async () => {
    prisma.aiArtifact.findFirst.mockResolvedValue({
      id: 'artifact-expired', companyId: operator.companies[0].id, artifactType: 'assistant_chat', status: 'generated',
      extraData: {
        operatorUserId: operator.id,
        actionProposal: {
          kind: 'PREPARE_QUOTE_DELIVERY', status: 'REQUIRES_CONFIRMATION',
          expiresAt: new Date(Date.now() - 1_000).toISOString(),
          quote: { id: 'quote-1' }, target: { phone: '12025550123', conversationId: 'conversation-1' },
          safety: { automaticSend: false, requiresHumanConfirmation: true, requiresManualWhatsappSend: true },
        },
      },
    });

    await expect(service.confirmAssistantAction('artifact-expired', operator)).rejects.toBeInstanceOf(ConflictException);
    expect(prisma.quote.findFirst).not.toHaveBeenCalled();
    expect(prisma.aiArtifact.updateMany).not.toHaveBeenCalled();
  });

  it('rejects an invalid proposal expiry before reading the conversation', async () => {
    prisma.aiArtifact.findFirst.mockResolvedValue({
      id: 'artifact-invalid-expiry', companyId: operator.companies[0].id,
      artifactType: 'assistant_chat', status: 'generated',
      extraData: {
        operatorUserId: operator.id,
        actionProposal: {
          kind: 'PREPARE_QUOTE_DELIVERY', status: 'REQUIRES_CONFIRMATION',
          expiresAt: 'not-a-date', quote: { id: 'quote-1' },
          target: { phone: '12025550123', conversationId: 'conversation-1' },
          safety: { automaticSend: false, requiresHumanConfirmation: true, requiresManualWhatsappSend: true },
        },
      },
    });

    await expect(service.confirmAssistantAction('artifact-invalid-expiry', operator))
      .rejects.toThrow('invalid expiry');
    expect(prisma.conversation.findFirst).not.toHaveBeenCalled();
    expect(prisma.quote.findFirst).not.toHaveBeenCalled();
  });

  it('rejects a proposal without a trusted conversation id', async () => {
    prisma.aiArtifact.findFirst.mockResolvedValue({
      id: 'artifact-no-conversation', companyId: operator.companies[0].id,
      artifactType: 'assistant_chat', status: 'generated',
      extraData: {
        operatorUserId: operator.id,
        actionProposal: {
          kind: 'PREPARE_QUOTE_DELIVERY', status: 'REQUIRES_CONFIRMATION',
          expiresAt: new Date(Date.now() + 60_000).toISOString(), quote: { id: 'quote-1' },
          target: { phone: '12025550123', conversationId: '   ' },
          safety: { automaticSend: false, requiresHumanConfirmation: true, requiresManualWhatsappSend: true },
        },
      },
    });

    await expect(service.confirmAssistantAction('artifact-no-conversation', operator))
      .rejects.toThrow('no trusted conversation');
    expect(prisma.conversation.findFirst).not.toHaveBeenCalled();
    expect(prisma.quote.findFirst).not.toHaveBeenCalled();
  });

  it('rejects confirmation when the verified WhatsApp recipient changed', async () => {
    const proposal = {
      kind: 'PREPARE_QUOTE_DELIVERY', status: 'REQUIRES_CONFIRMATION',
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      quote: { id: 'quote-1' },
      target: { phone: '12025550123', conversationId: 'conversation-1', leadId: 'lead-1' },
      safety: { automaticSend: false, requiresHumanConfirmation: true, requiresManualWhatsappSend: true },
    };
    prisma.aiArtifact.findFirst.mockResolvedValue({
      id: 'artifact-recipient-changed', companyId: operator.companies[0].id,
      artifactType: 'assistant_chat', status: 'generated', conversationId: 'conversation-1', leadId: 'lead-1',
      extraData: { operatorUserId: operator.id, actionProposal: proposal },
    });
    prisma.conversation.findFirst.mockResolvedValue({
      id: 'conversation-1', leadId: 'lead-1', assignedUserId: operator.id,
      isGroup: false, externalThreadId: '12025550999@s.whatsapp.net',
      contactPoint: {
        type: 'whatsapp', originalValue: '+12025550999', normalizedValue: '+12025550999', isVerified: true,
      },
      lead: { id: 'lead-1', ownerUserId: operator.id },
    });

    await expect(service.confirmAssistantAction('artifact-recipient-changed', operator))
      .rejects.toThrow('recipient no longer matches');
    expect(prisma.quote.findFirst).not.toHaveBeenCalled();
    expect(prisma.aiArtifact.updateMany).not.toHaveBeenCalled();
  });

  it('rejects confirmation when a non-admin no longer owns or is assigned the conversation', async () => {
    prisma.aiArtifact.findFirst.mockResolvedValue({
      id: 'artifact-reassigned', companyId: operator.companies[0].id,
      artifactType: 'assistant_chat', status: 'generated',
      extraData: {
        operatorUserId: operator.id,
        actionProposal: {
          kind: 'PREPARE_QUOTE_DELIVERY', status: 'REQUIRES_CONFIRMATION',
          expiresAt: new Date(Date.now() + 60_000).toISOString(), quote: { id: 'quote-1' },
          target: { phone: '12025550123', conversationId: 'conversation-1', leadId: 'lead-1' },
          safety: { automaticSend: false, requiresHumanConfirmation: true, requiresManualWhatsappSend: true },
        },
      },
    });
    prisma.conversation.findFirst.mockResolvedValue(null);

    await expect(service.confirmAssistantAction('artifact-reassigned', operator))
      .rejects.toBeInstanceOf(ForbiddenException);
    expect(prisma.quote.findFirst).not.toHaveBeenCalled();
    expect(prisma.aiArtifact.updateMany).not.toHaveBeenCalled();
  });

  it('reconciles an accepted proposal for the same user without replaying a claim token', async () => {
    const proposal = {
      kind: 'PREPARE_QUOTE_DELIVERY', status: 'REQUIRES_CONFIRMATION',
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      quote: { id: 'quote-1' }, target: { phone: '12025550123', conversationId: 'conversation-1' },
      safety: { automaticSend: false, requiresHumanConfirmation: true, requiresManualWhatsappSend: true },
    };
    prisma.aiArtifact.findFirst.mockResolvedValue({
      id: 'artifact-accepted', companyId: operator.companies[0].id, artifactType: 'assistant_chat',
      status: 'accepted', acceptedBy: operator.id, acceptedAt: new Date(),
      conversationId: 'conversation-1', leadId: 'lead-1',
      extraData: { operatorUserId: operator.id, actionProposal: proposal },
    });
    const result: any = await service.confirmAssistantAction('artifact-accepted', operator);
    expect(result).toEqual(expect.objectContaining({
      status: 'PREPARATION_CONFIRMED', accepted: true,
    }));
    expect(result).not.toHaveProperty('claimToken');
    expect(prisma.conversation.findFirst).not.toHaveBeenCalled();
    expect(prisma.quote.findFirst).not.toHaveBeenCalled();
    expect(prisma.aiArtifact.updateMany).not.toHaveBeenCalled();
  });

  it('creates a real background-research AgentRun from an explicit WhatsApp command', async () => {
    prisma.conversation.findFirst.mockResolvedValue({
      id: 'conversation-1', companyId: operator.companies[0].id, leadId: 'lead-server',
      isGroup: false, externalThreadId: '12025550123@s.whatsapp.net',
      contactPoint: {
        type: 'whatsapp', originalValue: '+12025550123', normalizedValue: '+12025550123', isVerified: true,
      },
      lead: {
        id: 'lead-server', companyId: operator.companies[0].id, companyName: 'Verified Buyer Ltd',
        companyNameSource: 'manual_confirmed', companyNameConfidence: 'high',
        ownerUserId: operator.id, deletedAt: null,
      },
    });
    researchRuns.enqueueForLead.mockResolvedValue({
      id: 'run-research-1', status: AgentRunStatus.PENDING,
    });
    prisma.aiArtifact.upsert.mockImplementation(async ({ create }: any) => ({
      id: 'artifact-research-1', createdAt: new Date(), ...create,
    }));

    const result: any = await service.chat({
      requestId: '00000000-0000-4000-8000-000000000005',
      companyId: operator.companies[0].id,
      message: '帮我给 Sample Buyer 做背调',
      pathname: '/whatsapp/chat',
      threadId: 'thread-1',
      whatsapp: {
        name: 'forged-name', phone: '+19999999999', conversationId: 'conversation-1',
        leadId: 'forged-lead', isGroup: true,
      },
    }, operator);

    expect(researchRuns.enqueueForLead).toHaveBeenCalledWith({
      companyId: operator.companies[0].id,
      leadId: 'lead-server',
      type: 'full',
      source: 'assistant_chat',
      conversationId: 'conversation-1',
      requestKey: expect.stringMatching(/^assistant-chat:[a-f0-9]{64}$/),
    }, operator);
    expect(result).toEqual(expect.objectContaining({
      responseKind: 'TASK_CREATED', agentRunId: 'run-research-1', actionStatus: 'QUEUED',
    }));
    expect(result.output).toContain('已创建真实客户背调任务');
    expect(ai.chat).not.toHaveBeenCalled();
    expect(prisma.aiArtifact.upsert).toHaveBeenCalledTimes(2);
    expect(prisma.aiArtifact.upsert).toHaveBeenCalledWith(expect.objectContaining({
      where: { requestKey: expect.stringMatching(/^assistant-chat:[a-f0-9]{64}$/) },
      create: expect.objectContaining({
        requestKey: expect.stringMatching(/^assistant-chat:[a-f0-9]{64}$/),
        status: 'processing',
      }),
      update: {},
    }));
    expect(prisma.aiArtifact.upsert).toHaveBeenLastCalledWith(expect.objectContaining({
      update: expect.objectContaining({
        status: 'generated',
        model: 'deterministic-action',
      }),
    }));
    expect(prisma.aiArtifact.upsert.mock.invocationCallOrder[0])
      .toBeLessThan(researchRuns.enqueueForLead.mock.invocationCallOrder[0]);
  });

  it('resumes a crash-left request reservation without allowing another request meaning', async () => {
    const dto = {
      requestId: '00000000-0000-4000-8000-000000000014',
      companyId: operator.companies[0].id,
      message: '请完成当前客户背调',
      pathname: '/whatsapp/chat',
      threadId: 'thread-resume',
      whatsapp: { name: 'Buyer', phone: '', conversationId: 'conversation-1' },
    };
    prisma.aiArtifact.findUnique.mockResolvedValue({
      id: 'artifact-reserved',
      companyId: operator.companies[0].id,
      inputContent: dto.message,
      outputContent: '正在创建可审计的客户背调任务。',
      model: 'deterministic-action-reservation',
      status: 'processing',
      acceptedAt: null,
      createdAt: new Date(),
      extraData: {
        operatorUserId: operator.id,
        requestContextDigest: (service as any).assistantRequestContextDigest(dto, operator),
        actionKind: 'BACKGROUND_RESEARCH',
        actionStatus: 'RESERVED',
      },
    });
    prisma.conversation.findFirst.mockResolvedValue({
      id: 'conversation-1', companyId: operator.companies[0].id, leadId: 'lead-1',
      isGroup: false, externalThreadId: '8613800000000@s.whatsapp.net',
      lead: {
        id: 'lead-1', companyId: operator.companies[0].id, companyName: 'Buyer Ltd',
        companyNameSource: 'manual_confirmed', companyNameConfidence: 'high',
        ownerUserId: operator.id, deletedAt: null,
      },
    });
    researchRuns.enqueueForLead.mockResolvedValue({ id: 'run-resumed', status: AgentRunStatus.PENDING });
    prisma.aiArtifact.upsert.mockImplementation(async ({ create }: any) => ({
      id: 'artifact-reserved', createdAt: new Date(), ...create,
    }));

    const result: any = await service.chat(dto, operator);

    expect(result).toEqual(expect.objectContaining({
      responseKind: 'TASK_CREATED', agentRunId: 'run-resumed', actionStatus: 'QUEUED',
    }));
    expect(researchRuns.enqueueForLead).toHaveBeenCalledTimes(1);
    expect(prisma.aiArtifact.upsert).toHaveBeenCalledTimes(1);
    expect(prisma.aiArtifact.upsert).toHaveBeenCalledWith(expect.objectContaining({
      update: expect.objectContaining({ status: 'generated' }),
    }));
  });

  it('returns the existing assistant artifact for a repeated requestId without another run or model call', async () => {
    const dto = {
      requestId: '00000000-0000-4000-8000-000000000010',
      companyId: operator.companies[0].id,
      message: '帮当前客户做背调',
      pathname: '/whatsapp/chat',
      whatsapp: { name: 'Buyer', phone: '', conversationId: 'conversation-1' },
    };
    prisma.aiArtifact.findUnique.mockResolvedValue({
      id: 'artifact-existing',
      companyId: operator.companies[0].id,
      inputContent: '帮当前客户做背调',
      outputContent: '已创建真实客户背调任务并交给后台执行。',
      model: 'deterministic-action',
      status: 'generated',
      acceptedAt: null,
      createdAt: new Date(),
      extraData: {
        operatorUserId: operator.id,
        responseKind: 'TASK_CREATED',
        actionStatus: 'QUEUED',
        agentRunId: 'run-existing',
        requestContextDigest: (service as any).assistantRequestContextDigest(dto, operator),
      },
    });

    const result: any = await service.chat(dto, operator);

    expect(result).toEqual(expect.objectContaining({
      id: 'artifact-existing', responseKind: 'TASK_CREATED', agentRunId: 'run-existing',
    }));
    expect(researchRuns.enqueueForLead).not.toHaveBeenCalled();
    expect(prisma.aiArtifact.upsert).not.toHaveBeenCalled();
    expect(ai.chat).not.toHaveBeenCalled();
  });

  it('rejects reuse of the same requestId and text for a different customer context', async () => {
    const original = {
      requestId: '00000000-0000-4000-8000-000000000020',
      companyId: operator.companies[0].id,
      message: '帮当前客户做背调',
      pathname: '/whatsapp/chat',
      threadId: 'thread-1',
      whatsapp: { name: 'Buyer A', phone: '', conversationId: 'conversation-a' },
    };
    prisma.aiArtifact.findUnique.mockResolvedValue({
      id: 'artifact-context-a', companyId: operator.companies[0].id,
      inputContent: original.message, outputContent: 'queued', model: 'deterministic-action',
      status: 'generated', acceptedAt: null, createdAt: new Date(),
      extraData: {
        operatorUserId: operator.id,
        requestContextDigest: (service as any).assistantRequestContextDigest(original, operator),
      },
    });

    await expect(service.chat({
      ...original,
      whatsapp: { name: 'Buyer B', phone: '', conversationId: 'conversation-b' },
    }, operator)).rejects.toBeInstanceOf(ConflictException);
    expect(researchRuns.enqueueForLead).not.toHaveBeenCalled();
  });

  it('rejects a server-recorded group chat even when the renderer claims it is private', async () => {
    prisma.conversation.findFirst.mockResolvedValue({
      id: 'group-conversation', companyId: operator.companies[0].id, leadId: 'lead-1',
      isGroup: true, externalThreadId: '120363000000@g.us',
      contactPoint: {
        type: 'whatsapp', originalValue: '+12025550123', normalizedValue: '+12025550123', isVerified: true,
      },
      lead: {
        id: 'lead-1', companyId: operator.companies[0].id, companyName: 'Buyer Ltd',
        companyNameSource: 'manual_confirmed', companyNameConfidence: 'high',
        ownerUserId: operator.id, deletedAt: null,
      },
    });
    prisma.aiArtifact.upsert.mockImplementation(async ({ create }: any) => ({
      id: 'artifact-group-blocked', createdAt: new Date(), ...create,
    }));

    const result: any = await service.chat({
      requestId: '00000000-0000-4000-8000-000000000006',
      companyId: operator.companies[0].id,
      message: '请开始客户背景调查',
      pathname: '/whatsapp/chat',
      whatsapp: {
        name: 'Buyer', phone: '+12025550123', conversationId: 'group-conversation', isGroup: false,
      },
    }, operator);

    expect(result.responseKind).toBe('ACTION_BLOCKED');
    expect(result.output).toContain('群聊没有唯一客户主体');
    expect(researchRuns.enqueueForLead).not.toHaveBeenCalled();
    expect(ai.chat).not.toHaveBeenCalled();
  });

  it('fails closed for a historical conversation whose group status is unknown', async () => {
    prisma.conversation.findFirst.mockResolvedValue({
      id: 'historical-conversation', companyId: operator.companies[0].id, leadId: 'lead-1',
      isGroup: null, externalThreadId: 'legacy-thread-without-trusted-classification',
      lead: {
        id: 'lead-1', companyId: operator.companies[0].id, companyName: 'Buyer Ltd',
        companyNameSource: 'manual_confirmed', companyNameConfidence: 'high',
        ownerUserId: operator.id, deletedAt: null,
      },
    });
    prisma.aiArtifact.upsert.mockImplementation(async ({ create }: any) => ({
      id: 'artifact-unknown-group', createdAt: new Date(), ...create,
    }));

    const result: any = await service.chat({
      requestId: '00000000-0000-4000-8000-000000000011',
      companyId: operator.companies[0].id,
      message: '帮当前客户做背调',
      pathname: '/whatsapp/chat',
      whatsapp: { name: 'Buyer', phone: '', conversationId: 'historical-conversation' },
    }, operator);

    expect(result.responseKind).toBe('ACTION_BLOCKED');
    expect(result.output).toContain('群聊属性尚未由新版 WhatsApp 连接确认');
    expect(researchRuns.enqueueForLead).not.toHaveBeenCalled();
  });

  it('recovers a historical direct chat from its exact verified E.164 identity anchor', async () => {
    prisma.conversation.findFirst.mockResolvedValue({
      id: 'historical-direct-conversation', companyId: operator.companies[0].id, leadId: 'lead-1',
      isGroup: null, externalThreadId: '+12025550123',
      contactPoint: {
        type: 'whatsapp', originalValue: '+86 156 2458 4719',
        normalizedValue: '+12025550123', isVerified: true,
      },
      lead: {
        id: 'lead-1', companyId: operator.companies[0].id, companyName: 'Buyer Ltd',
        companyNameSource: 'manual_confirmed', companyNameConfidence: 'high',
        ownerUserId: operator.id, deletedAt: null,
      },
    });
    researchRuns.enqueueForLead.mockResolvedValue({
      id: 'run-historical-direct', status: AgentRunStatus.PENDING,
    });
    prisma.aiArtifact.upsert.mockImplementation(async ({ create }: any) => ({
      id: 'artifact-historical-direct', createdAt: new Date(), ...create,
    }));

    const result: any = await service.chat({
      requestId: '00000000-0000-4000-8000-000000000021',
      companyId: operator.companies[0].id,
      message: '帮当前客户做背调',
      pathname: '/whatsapp/chat',
      whatsapp: { name: 'Forged', phone: '+12025550123', conversationId: 'historical-direct-conversation' },
    }, operator);

    expect(result).toEqual(expect.objectContaining({
      responseKind: 'TASK_CREATED', actionStatus: 'QUEUED', agentRunId: 'run-historical-direct',
    }));
    expect(researchRuns.enqueueForLead).toHaveBeenCalledWith(expect.objectContaining({
      companyId: operator.companies[0].id,
      leadId: 'lead-1',
      conversationId: 'historical-direct-conversation',
    }), operator);
  });

  it('allows a linked customer without a phone to run read-only background research', async () => {
    prisma.conversation.findFirst.mockResolvedValue({
      id: 'conversation-1', companyId: operator.companies[0].id, leadId: 'lead-1',
      isGroup: false, externalThreadId: '234977878868136@lid',
      contactPoint: null,
      lead: {
        id: 'lead-1', companyId: operator.companies[0].id, companyName: 'Privacy Buyer Ltd',
        companyNameSource: 'manual_confirmed', companyNameConfidence: 'high',
        ownerUserId: operator.id, deletedAt: null,
      },
    });
    researchRuns.enqueueForLead.mockResolvedValue({
      id: 'run-no-phone', status: AgentRunStatus.PENDING,
    });
    prisma.aiArtifact.upsert.mockImplementation(async ({ create }: any) => ({
      id: 'artifact-no-phone', createdAt: new Date(), ...create,
    }));

    const result: any = await service.chat({
      requestId: '00000000-0000-4000-8000-000000000007',
      companyId: operator.companies[0].id,
      message: '帮当前客户做背调',
      pathname: '/whatsapp/chat',
      whatsapp: { name: 'Forged', phone: '+12025550123', conversationId: 'conversation-1' },
    }, operator);

    expect(result.responseKind).toBe('TASK_CREATED');
    expect(result.agentRunId).toBe('run-no-phone');
    expect(researchRuns.enqueueForLead).toHaveBeenCalled();
  });

  it('fails background research closed when no CRM lead is linked', async () => {
    prisma.conversation.findFirst.mockResolvedValue({
      id: 'conversation-1', companyId: operator.companies[0].id, leadId: null,
      isGroup: false, externalThreadId: '234977878868136@lid', lead: null,
    });
    prisma.aiArtifact.upsert.mockImplementation(async ({ create }: any) => ({
      id: 'artifact-no-lead', createdAt: new Date(), ...create,
    }));

    const result: any = await service.chat({
      requestId: '00000000-0000-4000-8000-000000000008',
      companyId: operator.companies[0].id,
      message: '帮当前客户做背调',
      pathname: '/whatsapp/chat',
      whatsapp: { name: 'Forged', phone: '+12025550123', conversationId: 'conversation-1' },
    }, operator);

    expect(result.responseKind).toBe('ACTION_BLOCKED');
    expect(result.output).toContain('尚未关联 CRM 客户档案');
    expect(researchRuns.enqueueForLead).not.toHaveBeenCalled();
  });

  it('fails background research closed when the linked lead has no company name', async () => {
    prisma.conversation.findFirst.mockResolvedValue({
      id: 'conversation-1', companyId: operator.companies[0].id, leadId: 'lead-1',
      isGroup: false, externalThreadId: '8613800000000@s.whatsapp.net',
      lead: {
        id: 'lead-1', companyId: operator.companies[0].id, companyName: '   ',
        companyNameSource: null, companyNameConfidence: null,
        ownerUserId: operator.id, deletedAt: null,
      },
    });
    prisma.aiArtifact.upsert.mockImplementation(async ({ create }: any) => ({
      id: 'artifact-no-company', createdAt: new Date(), ...create,
    }));

    const result: any = await service.chat({
      requestId: '00000000-0000-4000-8000-000000000009',
      companyId: operator.companies[0].id,
      message: '请做客户背景调查',
      pathname: '/whatsapp/chat',
      whatsapp: { name: 'Forged', phone: '', conversationId: 'conversation-1' },
    }, operator);

    expect(result.responseKind).toBe('ACTION_BLOCKED');
    expect(result.output).toContain('缺少公司名称');
    expect(researchRuns.enqueueForLead).not.toHaveBeenCalled();
  });

  it('fails closed when a historical WhatsApp display name was stored as companyName', async () => {
    prisma.conversation.findFirst.mockResolvedValue({
      id: 'conversation-1', companyId: operator.companies[0].id, leadId: 'lead-1',
      isGroup: false, externalThreadId: '8613800000000@s.whatsapp.net',
      lead: {
        id: 'lead-1', companyId: operator.companies[0].id, companyName: 'Sample Buyer',
        companyNameSource: 'untrusted_display', companyNameConfidence: 'low',
        ownerUserId: operator.id, deletedAt: null,
      },
    });
    prisma.aiArtifact.upsert.mockImplementation(async ({ create }: any) => ({
      id: 'artifact-untrusted-company', createdAt: new Date(), ...create,
    }));

    const result: any = await service.chat({
      requestId: '00000000-0000-4000-8000-000000000012',
      companyId: operator.companies[0].id,
      message: '帮我给 Sample Buyer 做背调',
      pathname: '/whatsapp/chat',
      whatsapp: { name: 'Sample Buyer', phone: '', conversationId: 'conversation-1' },
    }, operator);

    expect(result.responseKind).toBe('ACTION_BLOCKED');
    expect(result.output).toContain('尚未人工确认');
    expect(result.output).toContain('不能把 WhatsApp 昵称当作调查主体');
    expect(researchRuns.enqueueForLead).not.toHaveBeenCalled();
  });

  it.each([
    [AgentRunStatus.RUNNING, 'RUNNING', 'TASK_STATUS', '正在执行'],
    [AgentRunStatus.COMPLETED, 'COMPLETED', 'TASK_STATUS', '已经完成'],
    [AgentRunStatus.FAILED, 'FAILED', 'TASK_STATUS', '此前已经失败'],
    [AgentRunStatus.CANCELLED, 'CANCELLED', 'TASK_STATUS', '已经取消'],
  ])('reports an idempotent %s run truthfully', async (runStatus, actionStatus, responseKind, text) => {
    prisma.conversation.findFirst.mockResolvedValue({
      id: 'conversation-1', companyId: operator.companies[0].id, leadId: 'lead-1',
      isGroup: false, externalThreadId: '8613800000000@s.whatsapp.net',
      lead: {
        id: 'lead-1', companyId: operator.companies[0].id, companyName: 'Buyer Ltd',
        companyNameSource: 'manual_confirmed', companyNameConfidence: 'high',
        ownerUserId: operator.id, deletedAt: null,
      },
    });
    researchRuns.enqueueForLead.mockResolvedValue({ id: 'run-existing', status: runStatus });
    prisma.aiArtifact.upsert.mockImplementation(async ({ create }: any) => ({
      id: `artifact-${String(runStatus).toLowerCase()}`, createdAt: new Date(), ...create,
    }));

    const result: any = await service.chat({
      requestId: '00000000-0000-4000-8000-000000000013',
      companyId: operator.companies[0].id,
      message: '帮当前客户做背调',
      pathname: '/whatsapp/chat',
      whatsapp: { name: 'Buyer', phone: '', conversationId: 'conversation-1' },
    }, operator);

    expect(result).toEqual(expect.objectContaining({ responseKind, actionStatus }));
    expect(result.output).toContain(text);
  });

  it('uses OpenClaw only for a company administrator and stores the true response source', async () => {
    prisma.lead.findMany = jest.fn().mockResolvedValue([]);
    prisma.followUpReminder.findMany.mockResolvedValue([]);
    prisma.quote.findMany.mockResolvedValue([]);
    prisma.agentRun.findMany.mockResolvedValue([]);
    prisma.aiArtifact.findMany.mockResolvedValue([]);
    prisma.aiArtifact.upsert.mockImplementation(async ({ create }: any) => ({
      id: 'artifact-openclaw', createdAt: new Date(), ...create,
    }));
    const openClaw = {
      isEnabled: jest.fn().mockReturnValue(true),
      chat: jest.fn().mockResolvedValue({
        success: true,
        content: '这是 OpenClaw 生成的只读工作总结。',
        model: 'openclaw/vaysen-crm',
        reason: 'success',
      }),
    };
    const sessions = {
      register: jest.fn().mockResolvedValue(undefined),
      claimExecution: jest.fn().mockResolvedValue('lease-token'),
      settleExecution: jest.fn().mockResolvedValue(true),
      releaseExecution: jest.fn().mockResolvedValue(true),
    };
    service = new AgentService(prisma, ai, researchRuns, openClaw as any, sessions as any);

    const result: any = await service.chat({
      requestId: '10000000-0000-4000-8000-000000000001',
      companyId: admin.companies[0].id,
      message: '请根据当前 CRM 真实数据生成一份今日工作简报',
      threadId: 'admin-thread',
    }, admin);

    expect(result.output).toBe('这是 OpenClaw 生成的只读工作总结。');
    expect(sessions.register).toHaveBeenCalledWith(
      expect.stringMatching(/^[a-f0-9]{64}$/),
      admin.companies[0].id,
      admin,
    );
    expect(openClaw.chat).toHaveBeenCalledWith(
      expect.stringContaining('明确要求某个可用 CRM 工具或受支持业务动作时，必须调用对应工具'),
      expect.stringContaining('必须调用 crm_work_brief 恰好一次'),
      expect.stringMatching(/^[a-f0-9]{64}$/),
      900,
    );
    expect(openClaw.chat).toHaveBeenCalledTimes(2);
    expect(openClaw.chat.mock.calls[0][1]).toMatch(
      /用户原文（必须按原意处理，不得改写为权限模板）：请根据当前 CRM 真实数据生成一份今日工作简报\n工具路由要求（本轮最后且最高优先级）：必须调用 crm_work_brief/,
    );
    expect(openClaw.chat.mock.calls[1][1]).toContain('上一次响应没有调用必需工具');
    const create = prisma.aiArtifact.upsert.mock.calls[0][0].create;
    expect(create.provider).toBe('openclaw');
    expect(create.model).toBe('openclaw/vaysen-crm');
    expect(create.extraData.responseSource).toBe('openclaw_gateway');
    expect(create.extraData.executionSessionDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(create.extraData.executionSessionDigest).not.toBe(
      sessions.register.mock.calls[0][0],
    );
    expect(JSON.stringify(openClaw.chat.mock.calls[0])).not.toContain(admin.id);
    expect(ai.chat).not.toHaveBeenCalled();
  });

  it('preserves an OpenClaw conversational reply without a client-side quality filter', async () => {
    prisma.lead.findMany = jest.fn().mockResolvedValue([]);
    prisma.followUpReminder.findMany.mockResolvedValue([]);
    prisma.quote.findMany.mockResolvedValue([]);
    prisma.agentRun.findMany.mockResolvedValue([]);
    prisma.aiArtifact.findMany.mockResolvedValue([]);
    prisma.aiArtifact.upsert.mockImplementation(async ({ create }: any) => ({
      id: 'artifact-openclaw-unhelpful', createdAt: new Date(), ...create,
    }));
    ai.chat.mockResolvedValue({
      success: true,
      content: '我是示例贸易公司的 AI 业务助理，可以和你正常讨论客户、报价、订单和工作安排；需要真实操作时我会调用 CRM 工具。',
      model: 'glm-4.5-air',
      reason: 'success',
    });
    const openClaw = {
      isEnabled: jest.fn().mockReturnValue(true),
      chat: jest.fn().mockResolvedValue({
        success: true,
        content: '你好！我在这里，已经准备好帮助你处理业务相关的问题了。请告诉我你需要哪方面的帮助，比如客户查询、订单管理、报价处理等。',
        model: 'openclaw/vaysen-crm',
        reason: 'success',
      }),
    };
    const sessions = {
      register: jest.fn().mockResolvedValue(undefined),
      claimExecution: jest.fn().mockResolvedValue('lease-token'),
      settleExecution: jest.fn().mockResolvedValue(true),
      releaseExecution: jest.fn().mockResolvedValue(true),
    };
    service = new AgentService(prisma, ai, researchRuns, openClaw as any, sessions as any);

    const result: any = await service.chat({
      requestId: '10000000-0000-4000-8000-000000000041',
      companyId: admin.companies[0].id,
      message: '你能干什么？',
      threadId: 'ordinary-chat-thread',
    }, admin);

    expect(result.output).toBe('你好！我在这里，已经准备好帮助你处理业务相关的问题了。请告诉我你需要哪方面的帮助，比如客户查询、订单管理、报价处理等。');
    expect(ai.chat).not.toHaveBeenCalled();
    expect(prisma.aiArtifact.upsert.mock.calls[0][0].create.extraData.responseSource)
      .toBe('openclaw_gateway');
  });

  it('allows only the execution-lease winner to call OpenClaw for concurrent identical requestIds', async () => {
    prisma.lead.findMany = jest.fn().mockResolvedValue([]);
    prisma.followUpReminder.findMany.mockResolvedValue([]);
    prisma.quote.findMany.mockResolvedValue([]);
    prisma.agentRun.findMany.mockResolvedValue([]);
    prisma.aiArtifact.findMany.mockResolvedValue([]);
    prisma.openClawToolReceipt.findMany.mockResolvedValue([]);
    prisma.aiArtifact.upsert.mockImplementation(async ({ create }: any) => ({
      id: 'artifact-concurrent-openclaw', createdAt: new Date(), acceptedAt: null, ...create,
    }));
    let resolveGateway!: (value: any) => void;
    const gatewayPending = new Promise((resolve) => { resolveGateway = resolve; });
    const openClaw = {
      isEnabled: jest.fn().mockReturnValue(true),
      chat: jest.fn().mockReturnValue(gatewayPending),
    };
    const sessions = {
      register: jest.fn().mockResolvedValue(undefined),
      claimExecution: jest.fn()
        .mockResolvedValueOnce('winner-lease')
        .mockResolvedValueOnce(null),
      settleExecution: jest.fn().mockResolvedValue(true),
      releaseExecution: jest.fn().mockResolvedValue(true),
    };
    service = new AgentService(prisma, ai, researchRuns, openClaw as any, sessions as any);
    const dto = {
      requestId: '10000000-0000-4000-8000-000000000021',
      companyId: admin.companies[0].id,
      message: 'Summarize the current CRM work',
      threadId: 'concurrent-admin-thread',
    };

    const winner = service.chat(dto, admin);
    while (openClaw.chat.mock.calls.length === 0) await Promise.resolve();
    await expect(service.chat(dto, admin)).rejects.toThrow(/already processing/i);
    resolveGateway({
      success: true,
      content: 'One verified OpenClaw response.',
      model: 'openclaw/vaysen-crm',
      reason: 'success',
    });
    await expect(winner).resolves.toEqual(expect.objectContaining({
      output: 'One verified OpenClaw response.',
    }));

    expect(openClaw.chat).toHaveBeenCalledTimes(1);
    expect(prisma.aiArtifact.upsert).toHaveBeenCalledTimes(1);
    expect(sessions.settleExecution).toHaveBeenCalledWith(
      expect.stringMatching(/^[a-f0-9]{64}$/),
      'winner-lease',
    );
  });

  it('returns the same-context artifact winner when a concurrent requestKey upsert raises P2002', async () => {
    prisma.lead.findMany = jest.fn().mockResolvedValue([]);
    prisma.followUpReminder.findMany.mockResolvedValue([]);
    prisma.quote.findMany.mockResolvedValue([]);
    prisma.agentRun.findMany.mockResolvedValue([]);
    prisma.aiArtifact.findMany.mockResolvedValue([]);
    prisma.openClawToolReceipt.findMany.mockResolvedValue([]);
    const openClaw = {
      isEnabled: jest.fn().mockReturnValue(true),
      chat: jest.fn().mockResolvedValue({
        success: true,
        content: 'Concurrent OpenClaw response.',
        model: 'openclaw/vaysen-crm',
        reason: 'success',
      }),
    };
    const sessions = {
      register: jest.fn().mockResolvedValue(undefined),
      claimExecution: jest.fn().mockResolvedValue('winner-lease'),
      settleExecution: jest.fn().mockResolvedValue(true),
      releaseExecution: jest.fn().mockResolvedValue(true),
    };
    service = new AgentService(prisma, ai, researchRuns, openClaw as any, sessions as any);
    const dto = {
      requestId: '10000000-0000-4000-8000-000000000023',
      companyId: admin.companies[0].id,
      message: 'Summarize the current CRM work after the race',
      threadId: 'concurrent-artifact-thread',
    };
    const winningArtifact = {
      id: 'artifact-concurrent-winner',
      companyId: dto.companyId,
      inputContent: dto.message,
      outputContent: 'Durable concurrent winner.',
      model: 'openclaw/vaysen-crm',
      status: 'generated',
      acceptedAt: null,
      createdAt: new Date('2026-07-15T14:00:00.000Z'),
      extraData: {
        operatorUserId: admin.id,
        threadId: dto.threadId,
        requestContextDigest: (service as any).assistantRequestContextDigest(dto, admin),
        responseKind: 'CHAT',
        responseSource: 'openclaw_gateway',
        toolReceipts: [],
      },
    };
    prisma.aiArtifact.findUnique
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(winningArtifact);
    prisma.aiArtifact.upsert.mockRejectedValue({
      code: 'P2002',
      meta: { target: ['requestKey'] },
    });

    await expect(service.chat(dto, admin)).resolves.toEqual(expect.objectContaining({
      id: winningArtifact.id,
      output: winningArtifact.outputContent,
    }));
    expect(prisma.aiArtifact.findUnique).toHaveBeenCalledTimes(2);
    expect(sessions.settleExecution).toHaveBeenCalledWith(
      expect.stringMatching(/^[a-f0-9]{64}$/),
      'winner-lease',
    );
    expect(sessions.releaseExecution).not.toHaveBeenCalled();
  });

  it('releases the OpenClaw lease and rethrows an unrelated P2002 persistence failure', async () => {
    prisma.lead.findMany = jest.fn().mockResolvedValue([]);
    prisma.followUpReminder.findMany.mockResolvedValue([]);
    prisma.quote.findMany.mockResolvedValue([]);
    prisma.agentRun.findMany.mockResolvedValue([]);
    prisma.aiArtifact.findMany.mockResolvedValue([]);
    prisma.openClawToolReceipt.findMany.mockResolvedValue([]);
    prisma.aiArtifact.findUnique.mockResolvedValue(null);
    const persistenceError = { code: 'P2002', meta: { target: ['id'] } };
    prisma.aiArtifact.upsert.mockRejectedValue(persistenceError);
    const openClaw = {
      isEnabled: jest.fn().mockReturnValue(true),
      chat: jest.fn().mockResolvedValue({
        success: true,
        content: 'Response that cannot be persisted.',
        model: 'openclaw/vaysen-crm',
        reason: 'success',
      }),
    };
    const sessions = {
      register: jest.fn().mockResolvedValue(undefined),
      claimExecution: jest.fn().mockResolvedValue('failed-persistence-lease'),
      settleExecution: jest.fn().mockResolvedValue(true),
      releaseExecution: jest.fn().mockResolvedValue(true),
    };
    service = new AgentService(prisma, ai, researchRuns, openClaw as any, sessions as any);

    await expect(service.chat({
      requestId: '10000000-0000-4000-8000-000000000024',
      companyId: admin.companies[0].id,
      message: 'Summarize the current CRM work before a persistence failure',
      threadId: 'failed-persistence-thread',
    }, admin)).rejects.toBe(persistenceError);
    expect(sessions.releaseExecution).toHaveBeenCalledWith(
      expect.stringMatching(/^[a-f0-9]{64}$/),
      'failed-persistence-lease',
    );
    expect(sessions.settleExecution).not.toHaveBeenCalled();
  });

  it('reconciles a late durable tool receipt over an existing Zhipu fallback artifact', async () => {
    const sessionDigest = 'd'.repeat(64);
    const existing = {
      id: 'artifact-late-receipt',
      companyId: admin.companies[0].id,
      inputContent: 'Read today work brief',
      outputContent: 'Old fallback draft',
      createdAt: new Date('2026-07-14T12:00:00.000Z'),
      acceptedAt: null,
      model: 'glm-4-flash-250414',
      status: 'generated',
      extraData: {
        operatorUserId: admin.id,
        threadId: 'late-receipt-thread',
        requestContextDigest: '',
        executionSessionDigest: sessionDigest,
        responseKind: 'CHAT',
        responseSource: 'zhipu_fallback',
        toolReceipts: [],
      },
    };
    const dto: any = {
      requestId: '10000000-0000-4000-8000-000000000022',
      companyId: admin.companies[0].id,
      message: existing.inputContent,
      threadId: 'late-receipt-thread',
    };
    existing.extraData.requestContextDigest = (service as any).assistantRequestContextDigest(dto, admin);
    prisma.aiArtifact.findUnique.mockResolvedValue(existing);
    prisma.openClawToolReceipt.findMany.mockResolvedValue([{
      requestKey: 'e'.repeat(64),
      runId: '20000000-0000-4000-8000-000000000022',
      toolName: 'work-brief',
      status: 'COMPLETED',
      businessStatus: 'SUCCEEDED',
      errorCode: null,
      completedAt: new Date('2026-07-14T12:00:05.000Z'),
    }]);
    prisma.aiArtifact.update.mockImplementation(async ({ data }: any) => ({
      ...existing,
      ...data,
      extraData: data.extraData,
    }));

    const result: any = await service.chat(dto, admin);

    expect(result.responseKind).toBe('OPENCLAW_TOOL_RESULT');
    expect(result.actionStatus).toBe('COMPLETED');
    expect(result.toolReceipts).toEqual([expect.objectContaining({
      requestId: 'e'.repeat(64),
      status: 'COMPLETED',
    })]);
    expect(result.output).not.toContain('Old fallback draft');
    expect(prisma.aiArtifact.update).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: 'artifact-late-receipt' },
      data: expect.objectContaining({ provider: 'openclaw', status: 'generated' }),
    }));
    expect(ai.chat).not.toHaveBeenCalled();
  });

  it('returns structured database receipts for real OpenClaw tools instead of a model completion claim', async () => {
    prisma.lead.findMany = jest.fn().mockResolvedValue([]);
    prisma.followUpReminder.findMany.mockResolvedValue([]);
    prisma.quote.findMany.mockResolvedValue([]);
    prisma.agentRun.findMany.mockResolvedValue([]);
    prisma.aiArtifact.findMany.mockResolvedValue([]);
    prisma.openClawToolReceipt.findMany
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{
        requestKey: 'a'.repeat(64),
        runId: '20000000-0000-4000-8000-000000000001',
        toolName: 'prepare-quote-delivery',
        status: 'COMPLETED',
        businessStatus: 'SUCCEEDED',
        errorCode: null,
        completedAt: new Date('2026-07-14T12:00:00.000Z'),
      }]);
    prisma.aiArtifact.upsert.mockImplementation(async ({ create }: any) => ({
      id: 'artifact-openclaw-tool', createdAt: new Date(), acceptedAt: null, ...create,
    }));
    const openClaw = {
      isEnabled: jest.fn().mockReturnValue(true),
      chat: jest.fn().mockResolvedValue({
        success: true,
        content: '报价已经发送成功。',
        model: 'openclaw/vaysen-crm',
        reason: 'success',
      }),
    };
    const sessions = {
      register: jest.fn().mockResolvedValue(undefined),
      claimExecution: jest.fn().mockResolvedValue('lease-token'),
      settleExecution: jest.fn().mockResolvedValue(true),
      releaseExecution: jest.fn().mockResolvedValue(true),
    };
    service = new AgentService(prisma, ai, researchRuns, openClaw as any, sessions as any);

    const result: any = await service.chat({
      requestId: '10000000-0000-4000-8000-000000000011',
      companyId: admin.companies[0].id,
      message: '查看并准备当前报价工作',
      threadId: 'admin-tool-thread',
    }, admin);

    expect(result.responseKind).toBe('OPENCLAW_TOOL_RESULT');
    expect(result.actionStatus).toBe('COMPLETED');
    expect(result.agentRunId).toBe('20000000-0000-4000-8000-000000000001');
    expect(result.toolReceipts).toEqual([expect.objectContaining({
      requestId: 'a'.repeat(64),
      toolName: 'crm.prepare_quote_delivery',
      status: 'COMPLETED',
    })]);
    expect(result.output).toBe('报价已经发送成功。');
    const create = prisma.aiArtifact.upsert.mock.calls[0][0].create;
    expect(create.extraData.permission).toBe('verified_openclaw_tool_receipt');
    expect(create.extraData.responseKind).toBe('OPENCLAW_TOOL_RESULT');
  });

  it('renders a technically completed but business-blocked quote receipt as blocked', async () => {
    const sessionDigest = 'f'.repeat(64);
    const existing = {
      id: 'artifact-blocked-quote-receipt',
      companyId: admin.companies[0].id,
      inputContent: '准备发送当前客户报价',
      outputContent: '旧的模型文本，不应继续展示。',
      createdAt: new Date('2026-07-14T12:30:00.000Z'),
      acceptedAt: null,
      model: 'openclaw/vaysen-crm',
      status: 'generated',
      assistantOperatorUserId: admin.id,
      assistantThreadId: 'blocked-quote-thread',
      extraData: {
        operatorUserId: admin.id,
        threadId: 'blocked-quote-thread',
        executionSessionDigest: sessionDigest,
        responseKind: 'CHAT',
        responseSource: 'openclaw_gateway',
        toolReceipts: [],
      },
    };
    prisma.aiArtifact.findMany.mockResolvedValue([existing]);
    prisma.openClawToolReceipt.findMany.mockResolvedValue([{
      requestKey: 'c'.repeat(64),
      runId: '20000000-0000-4000-8000-000000000099',
      toolName: 'prepare-quote-delivery',
      status: 'COMPLETED',
      businessStatus: 'BLOCKED',
      errorCode: null,
      completedAt: new Date('2026-07-14T12:30:05.000Z'),
    }]);
    prisma.aiArtifact.update.mockImplementation(async ({ data }: any) => ({
      ...existing,
      ...data,
      extraData: data.extraData,
    }));

    const [result]: any[] = await service.getChatHistory(
      admin.companies[0].id,
      'blocked-quote-thread',
      admin,
    );

    expect(result).toEqual(expect.objectContaining({
      actionStatus: 'COMPLETED',
      businessStatus: 'BLOCKED',
      responseKind: 'OPENCLAW_TOOL_RESULT',
    }));
    expect(result.toolReceipts).toEqual([expect.objectContaining({
      status: 'COMPLETED',
      businessStatus: 'BLOCKED',
    })]);
    expect(result.output).toContain('报价交付提案准备：已阻止（未执行业务动作）');
    expect(result.output).not.toContain('报价交付提案准备：已完成');
    expect(result.output).not.toContain('旧的模型文本');
  });

  it('preserves a verified WhatsApp quote provider receipt in assistant history', async () => {
    const sessionDigest = '9'.repeat(64);
    const existing = {
      id: 'artifact-whatsapp-quote-receipt',
      companyId: admin.companies[0].id,
      inputContent: '把已审核报价发送给当前客户',
      outputContent: '旧模型文本，不应覆盖真实发送回执。',
      createdAt: new Date('2026-07-19T01:00:00.000Z'),
      acceptedAt: null,
      model: 'openclaw/vaysen-crm',
      status: 'generated',
      assistantOperatorUserId: admin.id,
      assistantThreadId: 'whatsapp-quote-thread',
      extraData: {
        operatorUserId: admin.id,
        threadId: 'whatsapp-quote-thread',
        executionSessionDigest: sessionDigest,
        responseKind: 'CHAT',
        responseSource: 'openclaw_gateway',
        toolReceipts: [],
      },
    };
    prisma.aiArtifact.findMany.mockResolvedValue([existing]);
    prisma.openClawToolReceipt.findMany.mockResolvedValue([{
      requestKey: '8'.repeat(64),
      runId: '20000000-0000-4000-8000-000000000100',
      toolName: 'whatsapp-send-quote',
      status: 'COMPLETED',
      businessStatus: 'SUCCEEDED',
      errorCode: null,
      completedAt: new Date('2026-07-19T01:00:03.000Z'),
    }]);
    prisma.aiArtifact.update.mockImplementation(async ({ data }: any) => ({
      ...existing,
      ...data,
      extraData: data.extraData,
    }));

    const [result]: any[] = await service.getChatHistory(
      admin.companies[0].id,
      'whatsapp-quote-thread',
      admin,
    );

    expect(result).toEqual(expect.objectContaining({
      actionStatus: 'COMPLETED',
      businessStatus: 'SUCCEEDED',
      responseKind: 'OPENCLAW_TOOL_RESULT',
    }));
    expect(result.toolReceipts).toEqual([expect.objectContaining({
      toolName: 'crm.whatsapp_send_quote',
      status: 'COMPLETED',
      businessStatus: 'SUCCEEDED',
    })]);
    expect(result.output).toContain('发送已审核 WhatsApp 报价：已完成');
    expect(result.output).not.toContain('旧模型文本');
  });

  it('recovers an existing request-scoped OpenClaw receipt without invoking the Gateway again', async () => {
    prisma.lead.findMany = jest.fn().mockResolvedValue([]);
    prisma.followUpReminder.findMany.mockResolvedValue([]);
    prisma.quote.findMany.mockResolvedValue([]);
    prisma.agentRun.findMany.mockResolvedValue([]);
    prisma.aiArtifact.findMany.mockResolvedValue([]);
    prisma.openClawToolReceipt.findMany.mockResolvedValue([{
      requestKey: 'b'.repeat(64),
      runId: '20000000-0000-4000-8000-000000000002',
      toolName: 'work-brief',
      status: 'COMPLETED',
      businessStatus: 'SUCCEEDED',
      errorCode: null,
      completedAt: new Date('2026-07-14T12:00:00.000Z'),
    }]);
    prisma.aiArtifact.upsert.mockImplementation(async ({ create }: any) => ({
      id: 'artifact-openclaw-recovered', createdAt: new Date(), acceptedAt: null, ...create,
    }));
    const openClaw = {
      isEnabled: jest.fn().mockReturnValue(true),
      chat: jest.fn(),
    };
    const sessions = {
      register: jest.fn().mockResolvedValue(undefined),
      claimExecution: jest.fn().mockResolvedValue('lease-token'),
      settleExecution: jest.fn().mockResolvedValue(true),
      releaseExecution: jest.fn().mockResolvedValue(true),
    };
    service = new AgentService(prisma, ai, researchRuns, openClaw as any, sessions as any);

    const result: any = await service.chat({
      requestId: '10000000-0000-4000-8000-000000000012',
      companyId: admin.companies[0].id,
      message: '查看今日工作简报',
      threadId: 'admin-recovery-thread',
    }, admin);

    expect(openClaw.chat).not.toHaveBeenCalled();
    expect(ai.chat).not.toHaveBeenCalled();
    expect(result.responseKind).toBe('OPENCLAW_TOOL_RESULT');
    expect(result.output).toContain('工作简报读取：已完成');
  });

  it('keeps a normal company member on scoped Zhipu without registering an owner session', async () => {
    prisma.lead.findMany = jest.fn().mockResolvedValue([]);
    prisma.followUpReminder.findMany.mockResolvedValue([]);
    prisma.quote.findMany.mockResolvedValue([]);
    prisma.agentRun.findMany.mockResolvedValue([]);
    prisma.aiArtifact.findMany.mockResolvedValue([]);
    prisma.aiArtifact.upsert.mockImplementation(async ({ create }: any) => ({
      id: 'artifact-zhipu', createdAt: new Date(), ...create,
    }));
    ai.chat.mockResolvedValue({ success: true, content: '智谱安全草稿', model: 'glm-4-flash-250414' });
    const openClaw = { isEnabled: jest.fn().mockReturnValue(true), chat: jest.fn() };
    const sessions = {
      register: jest.fn(),
      claimExecution: jest.fn(),
      settleExecution: jest.fn(),
      releaseExecution: jest.fn(),
    };
    service = new AgentService(prisma, ai, researchRuns, openClaw as any, sessions as any);

    await service.chat({
      requestId: '10000000-0000-4000-8000-000000000002',
      companyId: operator.companies[0].id,
      message: '帮我整理工作重点',
    }, operator);

    expect(openClaw.chat).not.toHaveBeenCalled();
    expect(sessions.register).not.toHaveBeenCalled();
    expect(ai.chat).toHaveBeenCalledTimes(1);
    expect(prisma.aiArtifact.upsert.mock.calls[0][0].create.extraData.responseSource).toBe('zhipu');
  });

  it('falls back to Zhipu without claiming OpenClaw execution when Gateway is degraded', async () => {
    prisma.lead.findMany = jest.fn().mockResolvedValue([]);
    prisma.followUpReminder.findMany.mockResolvedValue([]);
    prisma.quote.findMany.mockResolvedValue([]);
    prisma.agentRun.findMany.mockResolvedValue([]);
    prisma.aiArtifact.findMany.mockResolvedValue([]);
    prisma.aiArtifact.upsert.mockImplementation(async ({ create }: any) => ({
      id: 'artifact-fallback', createdAt: new Date(), ...create,
    }));
    ai.chat.mockResolvedValue({ success: true, content: '智谱降级草稿', model: 'glm-4-flash-250414' });
    const openClaw = {
      isEnabled: jest.fn().mockReturnValue(true),
      chat: jest.fn().mockResolvedValue({ success: false, reason: 'not_ready' }),
    };
    const sessions = {
      register: jest.fn().mockResolvedValue(undefined),
      claimExecution: jest.fn().mockResolvedValue('lease-token'),
      settleExecution: jest.fn().mockResolvedValue(true),
      releaseExecution: jest.fn().mockResolvedValue(true),
    };
    service = new AgentService(prisma, ai, researchRuns, openClaw as any, sessions as any);

    await service.chat({
      requestId: '10000000-0000-4000-8000-000000000003',
      companyId: admin.companies[0].id,
      message: '整理今日重点',
    }, admin);

    expect(openClaw.chat).toHaveBeenCalledTimes(1);
    expect(ai.chat).toHaveBeenCalledTimes(1);
    const create = prisma.aiArtifact.upsert.mock.calls[0][0].create;
    expect(create.provider).toBe('zhipu');
    expect(create.extraData.responseSource).toBe('zhipu_fallback');
  });

  it('returns all scoped customer-search matches with only exact active direct conversation ids', async () => {
    prisma.lead.findMany = jest.fn().mockResolvedValue([
      {
        id: 'lead-1', companyName: 'Buyer One', leadName: null, contactName: 'Alice',
        country: 'US', productCategory: 'Mailer', status: 'new', leadGrade: 'B',
        updatedAt: new Date('2026-07-14T10:00:00.000Z'),
        conversations: [{ id: 'conversation-1', isGroup: false, externalThreadId: null, contactPoint: null }],
      },
      {
        id: 'lead-2', companyName: 'Buyer Two', leadName: null, contactName: 'Bob',
        country: 'GB', productCategory: 'Bag', status: 'new', leadGrade: 'C',
        updatedAt: new Date('2026-07-14T09:00:00.000Z'), conversations: [],
      },
    ]);
    const result = await service.searchCustomersForOpenClaw(
      operator.companies[0].id,
      'Buyer',
      5,
      operator,
    );
    expect(result.count).toBe(2);
    expect(result.hasMore).toBe(false);
    expect(result.uniqueMatch).toBe(false);
    expect(result.customers).toEqual([
      expect.objectContaining({ customerName: 'Buyer One', whatsappConversationId: 'conversation-1' }),
      expect.objectContaining({ customerName: 'Buyer Two', whatsappConversationId: null }),
    ]);
    expect(result.customers).toEqual([
      expect.objectContaining({ trustedLeadId: 'lead-1' }),
      expect.objectContaining({ trustedLeadId: 'lead-2' }),
    ]);
    expect(prisma.lead.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({
        companyId: operator.companies[0].id,
        ownerUserId: operator.id,
      }),
      select: expect.objectContaining({
        conversations: {
          where: { channel: 'whatsapp', status: 'active' },
          select: {
            id: true,
            whatsappSessionId: true,
            isGroup: true,
            externalThreadId: true,
            contactPoint: {
              select: {
                type: true,
                originalValue: true,
                normalizedValue: true,
                isVerified: true,
              },
            },
          },
          orderBy: { updatedAt: 'desc' },
        },
      }),
      take: 6,
    }));
  });

  it('does not prove uniqueness when limit=1 hides another matching lead', async () => {
    prisma.lead.findMany = jest.fn().mockResolvedValue([
      {
        id: 'lead-1', companyName: 'Buyer One', leadName: null, contactName: 'Alice',
        country: 'US', productCategory: 'Mailer', status: 'new', leadGrade: 'B',
        updatedAt: new Date('2026-07-14T10:00:00.000Z'),
        conversations: [{
          id: '11111111-1111-4111-8111-111111111111',
          isGroup: false,
          externalThreadId: null,
          contactPoint: null,
        }],
      },
      {
        id: 'lead-2', companyName: 'Buyer Two', leadName: null, contactName: 'Bob',
        country: 'GB', productCategory: 'Bag', status: 'new', leadGrade: 'C',
        updatedAt: new Date('2026-07-14T09:00:00.000Z'),
        conversations: [{
          id: '22222222-2222-4222-8222-222222222222',
          isGroup: false,
          externalThreadId: null,
          contactPoint: null,
        }],
      },
    ]);

    const result = await service.searchCustomersForOpenClaw(
      operator.companies[0].id,
      'Buyer',
      1,
      operator,
    );

    expect(result).toEqual(expect.objectContaining({
      count: 1,
      hasMore: true,
      uniqueMatch: false,
      customers: [expect.objectContaining({ customerName: 'Buyer One' })],
    }));
    expect(prisma.lead.findMany).toHaveBeenCalledWith(expect.objectContaining({ take: 2 }));
  });

  it('does not select a conversation when one lead has multiple eligible WhatsApp chats', async () => {
    prisma.lead.findMany = jest.fn().mockResolvedValue([{
      id: 'lead-1', companyName: 'Buyer One', leadName: null, contactName: 'Alice',
      country: 'US', productCategory: 'Mailer', status: 'new', leadGrade: 'B',
      updatedAt: new Date('2026-07-14T10:00:00.000Z'),
      conversations: [
        {
          id: '11111111-1111-4111-8111-111111111111',
          isGroup: false,
          externalThreadId: null,
          contactPoint: null,
        },
        {
          id: '22222222-2222-4222-8222-222222222222',
          isGroup: false,
          externalThreadId: null,
          contactPoint: null,
        },
      ],
    }]);

    const result = await service.searchCustomersForOpenClaw(
      operator.companies[0].id,
      'Buyer One',
      5,
      operator,
    );

    expect(result).toEqual(expect.objectContaining({
      count: 1,
      hasMore: false,
      uniqueMatch: true,
      customers: [expect.objectContaining({
        customerName: 'Buyer One',
        whatsappConversationId: null,
      })],
    }));
  });

  it('deduplicates Electron and server conversations for the same trusted WhatsApp target', async () => {
    prisma.lead.findMany = jest.fn().mockResolvedValue([{
      id: 'lead-1', companyName: 'Buyer One', leadName: null, contactName: 'Alice',
      country: 'US', productCategory: 'Mailer', status: 'new', leadGrade: 'B',
      updatedAt: new Date('2026-07-14T10:00:00.000Z'),
      conversations: [
        {
          id: 'server-conversation',
          whatsappSessionId: 'server-session',
          isGroup: false,
          externalThreadId: '8613800001234@s.whatsapp.net',
          contactPoint: null,
        },
        {
          id: 'electron-conversation',
          whatsappSessionId: null,
          isGroup: false,
          externalThreadId: '+86 138 0000 1234',
          contactPoint: null,
        },
      ],
    }]);

    const result = await service.searchCustomersForOpenClaw(
      operator.companies[0].id,
      'Buyer One',
      5,
      operator,
    );

    expect(result.customers).toEqual([
      expect.objectContaining({ whatsappConversationId: 'server-conversation' }),
    ]);
  });

  it('does not merge conversations that point to different WhatsApp numbers', async () => {
    prisma.lead.findMany = jest.fn().mockResolvedValue([{
      id: 'lead-1', companyName: 'Buyer One', leadName: null, contactName: 'Alice',
      country: 'US', productCategory: 'Mailer', status: 'new', leadGrade: 'B',
      updatedAt: new Date('2026-07-14T10:00:00.000Z'),
      conversations: [
        {
          id: 'conversation-a', whatsappSessionId: 'server-session', isGroup: false,
          externalThreadId: '8613800001234@s.whatsapp.net', contactPoint: null,
        },
        {
          id: 'conversation-b', whatsappSessionId: null, isGroup: false,
          externalThreadId: '12025550123@s.whatsapp.net', contactPoint: null,
        },
      ],
    }]);

    const result = await service.searchCustomersForOpenClaw(
      operator.companies[0].id,
      'Buyer One',
      5,
      operator,
    );

    expect(result.customers).toEqual([
      expect.objectContaining({ whatsappConversationId: null }),
    ]);
  });

  it('starts trusted OpenClaw background research without requiring a WhatsApp conversation', async () => {
    prisma.lead.findFirst.mockResolvedValue({
      id: 'lead-research-only',
      companyId: operator.companies[0].id,
      companyName: 'Verified Buyer Ltd',
      companyNameSource: 'manual_confirmed',
      companyNameConfidence: 'high',
      ownerUserId: operator.id,
      deletedAt: null,
      isMerged: false,
      conversations: [],
    });
    researchRuns.enqueueForLead.mockResolvedValue({
      id: 'run-research-only',
      status: AgentRunStatus.PENDING,
    });
    prisma.aiArtifact.upsert.mockImplementation(async ({ create }: any) => ({
      id: 'artifact-research-only',
      acceptedAt: null,
      createdAt: new Date(),
      ...create,
    }));

    const result: any = await service.startBackgroundResearchForOpenClaw(
      operator.companies[0].id,
      'lead-research-only',
      'request-key-research-only',
      'a'.repeat(64),
      operator,
      'CRM',
    );

    expect(researchRuns.enqueueForLead).toHaveBeenCalledWith({
      companyId: operator.companies[0].id,
      leadId: 'lead-research-only',
      type: 'full',
      source: 'assistant_chat',
      conversationId: undefined,
      requestKey: 'openclaw-research:request-key-research-only',
    }, operator);
    expect(prisma.conversation.findFirst).not.toHaveBeenCalled();
    expect(result).toEqual(expect.objectContaining({
      responseKind: 'TASK_CREATED',
      actionStatus: 'QUEUED',
      agentRunId: 'run-research-only',
    }));
    expect(prisma.aiArtifact.upsert).toHaveBeenCalledWith(expect.objectContaining({
      create: expect.objectContaining({
        companyId: operator.companies[0].id,
        leadId: 'lead-research-only',
        conversationId: undefined,
      }),
    }));
  });

  it('keeps unverified company names blocked even without a WhatsApp dependency', async () => {
    prisma.lead.findFirst.mockResolvedValue({
      id: 'lead-unverified-name',
      companyId: operator.companies[0].id,
      companyName: 'WhatsApp Display Name',
      companyNameSource: 'whatsapp_display_name',
      companyNameConfidence: 'low',
      ownerUserId: operator.id,
      deletedAt: null,
      isMerged: false,
      conversations: [],
    });
    prisma.aiArtifact.upsert.mockImplementation(async ({ create }: any) => ({
      id: 'artifact-unverified-name',
      acceptedAt: null,
      createdAt: new Date(),
      ...create,
    }));

    const result: any = await service.startBackgroundResearchForOpenClaw(
      operator.companies[0].id,
      'lead-unverified-name',
      'request-key-unverified-name',
      'b'.repeat(64),
      operator,
      'CRM',
    );

    expect(researchRuns.enqueueForLead).not.toHaveBeenCalled();
    expect(result).toEqual(expect.objectContaining({
      responseKind: 'ACTION_BLOCKED',
      actionStatus: 'BLOCKED',
      agentRunId: null,
    }));
  });
});
