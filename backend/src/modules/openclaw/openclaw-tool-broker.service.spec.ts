import { ConflictException, ForbiddenException } from '@nestjs/common';
import {
  AgentRunSource,
  OpenClawBindingStatus,
  OpenClawCrmExecutionStatus,
  OpenClawReceiptStatus,
} from '@prisma/client';
import { createHash } from 'crypto';
import { OpenClawToolBrokerService } from './openclaw-tool-broker.service';

const COMPANY_ID = '11111111-1111-4111-8111-111111111111';
const CONVERSATION_ID = '22222222-2222-4222-8222-222222222222';
const LEAD_ID = '33333333-3333-4333-8333-333333333333';
const OWNER_SENDER = 'wx-owner-opaque-id';
const QUOTE_SELECTION_TOKEN = 'Q'.repeat(43);
const RESEARCH_SELECTION_TOKEN = 'R'.repeat(43);
const ALL_SELECTION_TOKENS = {
  'prepare-quote-delivery': QUOTE_SELECTION_TOKEN,
  'start-background-research': RESEARCH_SELECTION_TOKEN,
  'customer-get': 'A'.repeat(43),
  'customer-add-note': 'B'.repeat(43),
  'customer-update': 'U'.repeat(43),
  'customer-set-stage': 'C'.repeat(43),
  'task-create': 'D'.repeat(43),
  'order-list': 'E'.repeat(43),
  'order-create-draft': 'F'.repeat(43),
  'order-update-stage': 'G'.repeat(43),
  'quote-list': 'H'.repeat(43),
  'quote-create-draft': 'I'.repeat(43),
  'whatsapp-messages-read': 'J'.repeat(43),
  'whatsapp-send-text': 'K'.repeat(43),
  'whatsapp-send-quote': 'L'.repeat(43),
  'email-messages-read': 'M'.repeat(43),
  'email-send': 'N'.repeat(43),
  'email-reply': 'O'.repeat(43),
};
const ACCEPTANCE_MARKER = 'JYACC_OWNER_0123456789abcdef';
const PROCESSING_RECEIPT_STALE_MS_FOR_TEST = 6 * 60_000;
const verified: any = {
  bodyDigest: 'b'.repeat(64),
  nonceDigest: 'n'.repeat(64),
  keyId: 'crm-key-1',
  canonicalPath: '/api/internal/openclaw/tools/work-brief',
};

function advisoryLockKeyAt(mock: jest.Mock, index: number): string {
  const [query, ...parameters] = mock.mock.calls[index];
  const parameterizedSql = Array.from(query as readonly string[]).join('?');
  expect(parameterizedSql).toMatch(
    /pg_advisory_xact_lock\(hashtextextended\(\?, 0\)\)::text AS locked/,
  );
  expect(parameters).toHaveLength(1);
  expect(parameterizedSql).not.toContain(String(parameters[0]));
  return parameters[0] as string;
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function wechatActor(overrides: Record<string, unknown> = {}): any {
  return {
    channel: 'openclaw-weixin',
    source: 'openclaw-weixin',
    senderIsOwner: true,
    requesterSenderId: OWNER_SENDER,
    sessionKey: 'wx-session-opaque',
    toolCallId: 'tool-call-1',
    agentAccountId: 'wx-agent-account',
    ...overrides,
  };
}

function crmActor(overrides: Record<string, unknown> = {}): any {
  return {
    channel: 'vaysen-crm',
    source: 'vaysen-crm',
    senderIsOwner: true,
    agentId: 'vaysen-crm',
    sessionKey: `vaysen-crm:${'a'.repeat(64)}`,
    toolCallId: 'crm-tool-call-1',
    ...overrides,
  };
}

function createHarness() {
  let receiptStore: any = null;
  const prisma: any = {
    user: {
      findFirst: jest.fn().mockResolvedValue({
        id: 'owner-user',
        email: 'owner@example.com',
        companies: [{
          companyId: COMPANY_ID,
          company: { id: COMPANY_ID, slug: 'demo-company' },
          role: { name: 'company_admin' },
        }],
      }),
    },
    openClawOperatorBinding: {
      findFirst: jest.fn().mockResolvedValue(null),
      updateMany: jest.fn().mockResolvedValue({ count: 0 }),
      upsert: jest.fn().mockResolvedValue({
        id: 'binding-1',
        companyId: COMPANY_ID,
        operatorUserId: 'owner-user',
        status: OpenClawBindingStatus.ACTIVE,
      }),
    },
    openClawCrmSession: {
      findUnique: jest.fn().mockResolvedValue({
        id: 'crm-session-1',
        sessionDigest: 'a'.repeat(64),
        companyId: COMPANY_ID,
        operatorUserId: 'crm-admin',
        expiresAt: new Date(Date.now() + 60_000),
        executionStatus: OpenClawCrmExecutionStatus.RUNNING,
        executionLeaseToken: 'lease-live',
        executionLeaseExpiresAt: new Date(Date.now() + 30_000),
      }),
    },
    openClawToolReceipt: {
      findUnique: jest.fn(async ({ where }: any) => {
        const matchesRequestKey = where.requestKey && receiptStore?.requestKey === where.requestKey;
        const matchesId = where.id && receiptStore?.id === where.id;
        return matchesRequestKey || matchesId ? receiptStore : null;
      }),
      create: jest.fn(async ({ data }: any) => {
        receiptStore = {
          id: 'receipt-1',
          createdAt: new Date(),
          result: null,
          errorCode: null,
          completedAt: null,
          ...data,
        };
        return receiptStore;
      }),
      update: jest.fn(async ({ data }: any) => {
        receiptStore = { ...receiptStore, ...data };
        return receiptStore;
      }),
      updateMany: jest.fn(async ({ where, data }: any) => {
        const matches = receiptStore
          && receiptStore.id === where.id
          && receiptStore.status === where.status
          && (!where.createdAt?.lte || receiptStore.createdAt <= where.createdAt.lte);
        if (!matches) return { count: 0 };
        receiptStore = { ...receiptStore, ...data };
        return { count: 1 };
      }),
      count: jest.fn().mockResolvedValue(0),
      findFirst: jest.fn().mockResolvedValue(null),
    },
    agentRun: {
      create: jest.fn().mockResolvedValue({ id: 'wrapper-run-1' }),
      update: jest.fn().mockResolvedValue({ id: 'wrapper-run-1' }),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
    agentTask: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
    agentAuditLog: { create: jest.fn().mockResolvedValue({ id: 'audit-1' }) },
    conversation: {
      findFirst: jest.fn().mockResolvedValue({
        id: CONVERSATION_ID,
        companyId: COMPANY_ID,
        channel: 'whatsapp',
        status: 'active',
        isGroup: false,
        externalThreadId: '8613800000000@s.whatsapp.net',
        whatsappSessionId: 'wa-session-1',
        assignedUserId: 'owner-user',
        leadId: LEAD_ID,
        lead: {
          id: LEAD_ID,
          companyName: 'Unique Buyer',
          leadName: null,
          contactName: 'Buyer',
          ownerUserId: 'owner-user',
          deletedAt: null,
          isMerged: false,
          contactEmail: 'buyer@example.com',
          emailVerificationStatus: 'smtp_verified',
          contactPoints: [],
        },
      }),
    },
    lead: {
      findFirst: jest.fn().mockResolvedValue({
        id: LEAD_ID,
        companyId: COMPANY_ID,
        companyName: 'Unique Buyer',
        leadName: null,
        contactName: 'Buyer',
        ownerUserId: 'owner-user',
        deletedAt: null,
        isMerged: false,
        contactEmail: 'buyer@example.com',
        emailVerificationStatus: 'smtp_verified',
        contactPoints: [],
        conversations: [{ assignedUserId: 'owner-user' }],
      }),
    },
    whatsAppSession: {
      findFirst: jest.fn().mockResolvedValue({ id: 'wa-session-1', authStatePath: 'baileys/session-1' }),
      findMany: jest.fn().mockResolvedValue([]),
    },
    quote: {
      findMany: jest.fn().mockResolvedValue([{
        id: 'quote-1',
        referenceNo: 'QT-20260718-ABC123',
        status: 'approved',
      }]),
    },
    communicationMessage: { findMany: jest.fn().mockResolvedValue([]) },
    emailAccount: {
      findMany: jest.fn().mockResolvedValue([{ id: 'email-account-1', userId: 'owner-user' }]),
    },
    $queryRaw: jest.fn().mockResolvedValue([{ locked: '' }]),
  };
  prisma.$transaction = jest.fn(async (input: any) => (
    typeof input === 'function' ? input(prisma) : Promise.all(input)
  ));
  const agent: any = {
    getBrief: jest.fn().mockResolvedValue({ metrics: { leads: 1 } }),
    searchCustomersForOpenClaw: jest.fn().mockResolvedValue({ count: 0, customers: [] }),
    prepareQuoteDeliveryForOpenClaw: jest.fn().mockResolvedValue({
      id: 'proposal-1',
      output: '请人工确认',
      actionStatus: 'REQUIRES_CONFIRMATION',
      actionProposal: {
        status: 'REQUIRES_CONFIRMATION',
        quote: { referenceNo: 'QT-1', status: 'draft', totalAmount: '100', currency: 'USD' },
        target: { name: 'Buyer', phone: '+8613800000000' },
      },
    }),
    startBackgroundResearchForOpenClaw: jest.fn().mockResolvedValue({
      agentRunId: 'research-run-1',
      actionStatus: 'QUEUED',
      responseKind: 'TASK_CREATED',
      output: '背调任务已创建',
    }),
  };
  Object.assign(agent, {
    getCustomerForOpenClaw: jest.fn().mockResolvedValue({ status: 'SUCCEEDED', customer: { name: 'Buyer' } }),
    addCustomerNoteForOpenClaw: jest.fn().mockResolvedValue({ status: 'SUCCEEDED', customerName: 'Buyer' }),
    updateCustomerForOpenClaw: jest.fn().mockResolvedValue({ status: 'SUCCEEDED', customerName: 'Buyer', updatedFields: ['country'] }),
    setCustomerStageForOpenClaw: jest.fn().mockResolvedValue({ status: 'SUCCEEDED', customerName: 'Buyer', stage: 'quoted' }),
    createTaskForOpenClaw: jest.fn().mockResolvedValue({ status: 'SUCCEEDED', title: 'Follow up', dueAt: '2026-07-20T00:00:00.000Z' }),
    listOrdersForOpenClaw: jest.fn().mockResolvedValue({ status: 'SUCCEEDED', orders: [] }),
    createOrderDraftForOpenClaw: jest.fn().mockResolvedValue({ status: 'SUCCEEDED', orderNo: 'ORD-20260717-ABC12345', stage: 'draft' }),
    updateOrderStageForOpenClaw: jest.fn().mockResolvedValue({ status: 'SUCCEEDED', orderNo: 'ORD-20260717-ABC12345', stage: 'production' }),
    listQuotesForOpenClaw: jest.fn().mockResolvedValue({ status: 'SUCCEEDED', quotes: [] }),
    createQuoteDraftForOpenClaw: jest.fn().mockResolvedValue({ status: 'SUCCEEDED', referenceNo: 'QT-20260717-ABC12345', currency: 'USD', totalAmount: '100' }),
    searchProductsForOpenClaw: jest.fn().mockResolvedValue({ status: 'SUCCEEDED', currency: 'USD', products: [] }),
  });
  const crmSessions: any = {
    resolve: jest.fn().mockResolvedValue({
      companyId: COMPANY_ID,
      operatorUserId: 'crm-admin',
      executionLeaseToken: 'lease-live',
      user: {
        id: 'crm-admin',
        email: 'admin@example.com',
        companies: [{ id: COMPANY_ID, role: 'company_admin' }],
      },
    }),
    reconcileLockedToolExecutionAfterReceipt: jest.fn().mockResolvedValue(true),
  };
  crmSessions.runToolTerminalTransaction = jest.fn(async (
    _sessionDigest: string,
    _leaseToken: string,
    terminalTransition: (tx: any) => Promise<any>,
  ) => {
    const result = await prisma.$transaction(terminalTransition);
    if (result.claimed) {
      const reconciled = await crmSessions.reconcileLockedToolExecutionAfterReceipt(
        prisma,
        _sessionDigest,
        _leaseToken,
      );
      if (!reconciled) throw new ConflictException('lease mismatch');
    }
    return result;
  });
  const selections: any = {
    issueForUniqueSearch: jest.fn().mockResolvedValue(null),
    consume: jest.fn().mockResolvedValue({
      leadId: LEAD_ID,
      conversationId: CONVERSATION_ID,
      replay: false,
    }),
  };
  const assistantPermissions: any = {
    evaluate: jest.fn().mockResolvedValue({ decision: 'ALLOW', reason: 'PROFILE_POLICY' }),
  };
  const whatsapp: any = {
    sendMessage: jest.fn().mockResolvedValue({ success: true, messageId: 'provider-message-1' }),
    sendMediaOnly: jest.fn().mockResolvedValue({
      success: true,
      providerMessageId: 'provider-quote-1',
      acceptedAt: '2026-07-18T10:00:00.000Z',
    }),
  };
  const businessMail: any = {
    sendMail: jest.fn().mockResolvedValue({ messageId: '<provider-email-1@example.com>' }),
  };
  const quotes: any = {
    generatePiHtml: jest.fn().mockResolvedValue('<html>quote</html>'),
    htmlToPdf: jest.fn().mockResolvedValue(Buffer.from('%PDF-test')),
  };
  return {
    prisma,
    agent,
    crmSessions,
    selections,
    assistantPermissions,
    whatsapp,
    businessMail,
    quotes,
    service: new OpenClawToolBrokerService(
      prisma,
      agent,
      crmSessions,
      selections,
      assistantPermissions,
      whatsapp,
      businessMail,
      quotes,
    ),
    getReceipt: () => receiptStore,
  };
}

describe('OpenClawToolBrokerService', () => {
  beforeEach(() => {
    process.env.OPENCLAW_OWNER_EMAIL = 'owner@example.com';
    process.env.OPENCLAW_OWNER_COMPANY_SLUG = 'demo-company';
    process.env.OPENCLAW_WECHAT_OWNER_PEER_SHA256 = createHash('sha256')
      .update(OWNER_SENDER)
      .digest('hex');
  });

  afterEach(() => {
    jest.useRealTimers();
    delete process.env.OPENCLAW_OWNER_EMAIL;
    delete process.env.OPENCLAW_OWNER_COMPANY_SLUG;
    delete process.env.OPENCLAW_WECHAT_OWNER_PEER_SHA256;
  });

  it('creates the first owner WeChat binding and durable run using hashes only', async () => {
    const { service, prisma } = createHarness();
    const result = await service.execute('work-brief', { actor: wechatActor() }, verified);
    expect(result).toEqual(expect.objectContaining({
      status: OpenClawReceiptStatus.COMPLETED,
      businessStatus: 'SUCCEEDED',
    }));
    expect(result).not.toHaveProperty('runId');
    const bindingArgs = prisma.openClawOperatorBinding.upsert.mock.calls[0][0];
    expect(bindingArgs.create).toEqual(expect.objectContaining({
      companyId: COMPANY_ID,
      operatorUserId: 'owner-user',
      displayName: '负责人微信',
      senderDigest: createHash('sha256').update(OWNER_SENDER).digest('hex'),
    }));
    expect(JSON.stringify(bindingArgs)).not.toContain(OWNER_SENDER);
    expect(prisma.agentRun.create).toHaveBeenCalledTimes(1);
    expect(prisma.agentRun.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        source: AgentRunSource.WECHAT_OWNER,
        subjectType: 'openclaw_tool',
        subjectId: expect.stringMatching(/^[a-f0-9]{64}$/),
      }),
    }));
    expect(prisma.agentAuditLog.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ eventType: 'OPENCLAW_TOOL_STARTED' }),
    }));
    expect(prisma.agentTask.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        status: 'COMPLETED',
        result: expect.objectContaining({ businessStatus: 'SUCCEEDED' }),
      }),
    }));
    expect(prisma.agentRun.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        status: 'COMPLETED',
        result: expect.objectContaining({ businessStatus: 'SUCCEEDED' }),
      }),
    }));
  });

  it('persists only the SHA-256 acceptance marker correlation on work brief', async () => {
    const { service, prisma, agent, getReceipt } = createHarness();
    const result = await service.execute('work-brief', {
      actor: wechatActor({ toolCallId: 'acceptance-marker-1' }),
      input: { acceptanceMarker: ACCEPTANCE_MARKER },
    }, verified);
    const markerDigest = createHash('sha256').update(ACCEPTANCE_MARKER).digest('hex');

    expect(getReceipt()).toEqual(expect.objectContaining({
      acceptanceMarkerDigest: markerDigest,
      status: OpenClawReceiptStatus.COMPLETED,
    }));
    expect(result).not.toHaveProperty('acceptanceMarker');
    expect(result).not.toHaveProperty('acceptanceMarkerDigest');
    const persistenceStructures = JSON.stringify({
      receiptCreate: prisma.openClawToolReceipt.create.mock.calls,
      runCreate: prisma.agentRun.create.mock.calls,
      taskUpdate: prisma.agentTask.updateMany.mock.calls,
      auditCreate: prisma.agentAuditLog.create.mock.calls,
      response: result,
    });
    expect(persistenceStructures).not.toContain(ACCEPTANCE_MARKER);
    expect(persistenceStructures).toContain(markerDigest);

    const replay = await service.execute('work-brief', {
      actor: wechatActor({ toolCallId: 'acceptance-marker-2' }),
      input: { acceptanceMarker: ACCEPTANCE_MARKER },
    }, { ...verified, bodyDigest: 'c'.repeat(64) });
    expect(replay.requestId).toBe(result.requestId);
    expect(agent.getBrief).toHaveBeenCalledTimes(1);
    expect(prisma.openClawToolReceipt.create).toHaveBeenCalledTimes(1);
    expect(prisma.agentRun.create).toHaveBeenCalledTimes(1);
    expect(prisma.agentAuditLog.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        runId: 'wrapper-run-1',
        eventType: 'OPENCLAW_ACCEPTANCE_REPLAY_DEDUPLICATED',
        metadata: expect.objectContaining({ reusedRequestKey: true }),
      }),
    }));
    expect(JSON.stringify(prisma.agentAuditLog.create.mock.calls)).not.toContain(ACCEPTANCE_MARKER);
  });

  it.each([
    'JYACC_OWNER_0123456789ABCDEF',
    'JYACC_OWNER_0123456789abcde',
    'JYACC_OWNER_0123456789abcdef_extra',
    'other-marker-0123456789abcdef',
  ])('rejects an invalid acceptance marker without reserving a receipt: %s', async (marker) => {
    const { service, prisma } = createHarness();
    await expect(service.execute('work-brief', {
      actor: wechatActor({ toolCallId: 'invalid-marker' }),
      input: { acceptanceMarker: marker },
    }, verified)).rejects.toThrow(/marker format is invalid/i);
    expect(prisma.openClawToolReceipt.create).not.toHaveBeenCalled();
    expect(prisma.agentRun.create).not.toHaveBeenCalled();
  });

  it('rejects acceptance marker input on every non-work-brief tool', async () => {
    const { service, prisma, selections } = createHarness();
    await expect(service.execute('customer-search', {
      actor: wechatActor({ toolCallId: 'marker-smuggle-search' }),
      input: { query: 'Buyer', acceptanceMarker: ACCEPTANCE_MARKER },
    }, verified)).rejects.toThrow(/allowed only for work brief/i);
    expect(selections.consume).not.toHaveBeenCalled();
    expect(prisma.openClawToolReceipt.create).not.toHaveBeenCalled();
  });

  it('minimizes the work brief before it reaches OpenClaw or a model context', async () => {
    const { service, agent } = createHarness();
    agent.getBrief.mockResolvedValue({
      generatedAt: '2026-07-14T12:00:00.000Z',
      ai: { provider: 'zhipu', model: 'secret-model' },
      metrics: { leads: 2, pendingReminders: 1 },
      leadStatusCounts: { new: 2 },
      reminders: [{
        id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        leadId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
        title: '联系 buyer@example.com +86 138 0000 0000',
        reason: 'token-secretsecretsecret',
        priority: 'High',
        dueAt: new Date('2026-07-15T01:00:00.000Z'),
      }],
      quotes: [{
        id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
        referenceNo: 'QT-20260714-1001',
        status: 'draft',
        totalAmount: '100.50',
        currency: 'usd',
      }],
      runs: [{
        id: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
        kind: 'BACKGROUND_RESEARCH',
        status: 'RUNNING',
        result: {
          referenceNo: 'TASK-20260714-01',
          customerEmail: 'private@example.com',
          phone: '+1 816 579 6304',
          apiKey: 'sk-secretsecretsecret',
        },
        errorCode: 'private failure text',
      }],
    });

    const response: any = await service.execute('work-brief', {
      actor: wechatActor({ toolCallId: 'brief-minimize-1' }),
    }, verified);
    const resultText = JSON.stringify(response.result);
    expect(response.result).toEqual(expect.objectContaining({
      metrics: { leads: 2, pendingReminders: 1 },
      reminders: [expect.objectContaining({
        title: '联系 [EMAIL_REDACTED] [PHONE_REDACTED]',
      })],
      quotes: [expect.objectContaining({
        referenceNo: 'QT-20260714-1001',
        totalAmount: '100.50',
        currency: 'USD',
      })],
      runs: [expect.objectContaining({
        kind: 'BACKGROUND_RESEARCH',
        status: 'RUNNING',
        businessReference: 'TASK-20260714-01',
      })],
    }));
    expect(resultText).not.toMatch(/[0-9a-f]{8}-[0-9a-f-]{27,}/i);
    expect(resultText).not.toContain('buyer@example.com');
    expect(resultText).not.toContain('private@example.com');
    expect(resultText).not.toContain('138 0000 0000');
    expect(resultText).not.toContain('816 579 6304');
    expect(resultText).not.toContain('sk-secretsecretsecret');
    expect(resultText).not.toContain('private failure text');
  });

  it('rejects an unknown sender and non-allowlisted/group-like channel before CRM access', async () => {
    const { service, prisma } = createHarness();
    await expect(service.execute('work-brief', {
      actor: wechatActor({ requesterSenderId: 'unknown-sender' }),
    }, verified)).rejects.toBeInstanceOf(ForbiddenException);
    await expect(service.execute('work-brief', {
      actor: wechatActor({ channel: 'openclaw-weixin-group', source: 'openclaw-weixin-group' }),
    }, verified)).rejects.toBeInstanceOf(ForbiddenException);
    expect(prisma.openClawOperatorBinding.upsert).not.toHaveBeenCalled();
  });

  it('uses the durable QR-time database binding when the legacy environment digest is empty', async () => {
    delete process.env.OPENCLAW_WECHAT_OWNER_PEER_SHA256;
    const { service, prisma } = createHarness();
    prisma.openClawOperatorBinding.findFirst.mockResolvedValue({
      id: 'binding-from-web-qr',
      senderDigest: createHash('sha256').update(OWNER_SENDER).digest('hex'),
    });

    await expect(service.execute('work-brief', { actor: wechatActor() }, verified)).resolves.toEqual(
      expect.objectContaining({ status: OpenClawReceiptStatus.COMPLETED }),
    );
    expect(prisma.openClawOperatorBinding.findFirst).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({
        companyId: COMPANY_ID,
        operatorUserId: 'owner-user',
        channel: 'openclaw-weixin',
        status: OpenClawBindingStatus.ACTIVE,
      }),
    }));
  });

  it('treats an ACTIVE database binding as canonical over a stale legacy environment digest', async () => {
    process.env.OPENCLAW_WECHAT_OWNER_PEER_SHA256 = createHash('sha256')
      .update('old-owner@im.wechat')
      .digest('hex');
    const { service, prisma } = createHarness();
    prisma.openClawOperatorBinding.findFirst.mockResolvedValue({
      senderDigest: createHash('sha256').update(OWNER_SENDER).digest('hex'),
    });

    await expect(service.execute('work-brief', { actor: wechatActor() }, verified)).resolves.toEqual(
      expect.objectContaining({ status: OpenClawReceiptStatus.COMPLETED }),
    );
    await expect(service.execute('work-brief', {
      actor: wechatActor({ requesterSenderId: 'old-owner@im.wechat', toolCallId: 'stale-env-owner' }),
    }, verified)).rejects.toThrow('Unknown OpenClaw WeChat sender');
  });

  it('does not let the first post-scan message claim ownership without a durable digest anchor', async () => {
    delete process.env.OPENCLAW_WECHAT_OWNER_PEER_SHA256;
    const { service, prisma } = createHarness();
    prisma.openClawOperatorBinding.findFirst.mockResolvedValue(null);

    await expect(service.execute('work-brief', { actor: wechatActor() }, verified)).rejects.toThrow(
      'Unknown OpenClaw WeChat sender',
    );
    expect(prisma.openClawOperatorBinding.upsert).not.toHaveBeenCalled();
    expect(prisma.agentRun.create).not.toHaveBeenCalled();
  });

  it('fails closed when the exact owner company slug is not configured', async () => {
    delete process.env.OPENCLAW_OWNER_COMPANY_SLUG;
    const { service, prisma } = createHarness();
    await expect(service.execute('work-brief', {
      actor: wechatActor(),
    }, verified)).rejects.toThrow(/owner is not configured/i);
    expect(prisma.user.findFirst).not.toHaveBeenCalled();
  });

  it('maps a CRM actor through the registered admin session without a WeChat binding', async () => {
    const { service, prisma, crmSessions } = createHarness();
    const result = await service.execute('customer-search', {
      actor: crmActor(),
      input: { query: 'Buyer', limit: 5 },
    }, verified);
    expect(result.status).toBe(OpenClawReceiptStatus.COMPLETED);
    expect(crmSessions.resolve).toHaveBeenCalledWith(`vaysen-crm:${'a'.repeat(64)}`);
    expect(crmSessions.runToolTerminalTransaction).toHaveBeenCalledWith(
      'a'.repeat(64),
      'lease-live',
      expect.any(Function),
    );
    expect(crmSessions.reconcileLockedToolExecutionAfterReceipt).toHaveBeenCalledWith(
      prisma,
      'a'.repeat(64),
      'lease-live',
    );
    expect(prisma.user.findFirst).not.toHaveBeenCalled();
    expect(prisma.openClawOperatorBinding.upsert).not.toHaveBeenCalled();
    expect(prisma.agentRun.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ source: AgentRunSource.CRM }),
    }));
  });

  it.each([
    ['owner WeChat', wechatActor({ toolCallId: 'quote-source-wechat' }), 'WECHAT_OWNER'],
    ['CRM assistant', crmActor({ toolCallId: 'quote-source-crm' }), 'CRM'],
  ])('passes the authenticated %s source into the quote proposal artifact', async (_label, actor, source) => {
    const { service, agent, prisma } = createHarness();
    await service.execute('prepare-quote-delivery', {
      actor,
      input: { selectionToken: QUOTE_SELECTION_TOKEN },
    }, verified);
    expect(agent.prepareQuoteDeliveryForOpenClaw).toHaveBeenCalledWith(
      COMPANY_ID,
      LEAD_ID,
      expect.stringMatching(/^[a-f0-9]{64}$/),
      expect.stringMatching(/^[a-f0-9]{64}$/),
      expect.objectContaining({ id: actor.channel === 'vaysen-crm' ? 'crm-admin' : 'owner-user' }),
      source,
    );
    const lockKeys = prisma.$queryRaw.mock.calls.map((_: unknown, index: number) => (
      advisoryLockKeyAt(prisma.$queryRaw, index)
    ));
    if (actor.channel === 'vaysen-crm') {
      expect(lockKeys).toHaveLength(2);
      expect(lockKeys[0]).toBe(`openclaw-crm-execution:${'a'.repeat(64)}`);
      expect(lockKeys[1]).toMatch(
        new RegExp(`^openclaw-execution-receipts:${COMPANY_ID}:crm-admin:`),
      );
    } else {
      expect(lockKeys).toHaveLength(3);
      expect(lockKeys[0]).toBe(`openclaw-weixin-owner-binding:${COMPANY_ID}:owner-user`);
      expect(lockKeys[1]).toMatch(/^openclaw-business-input:[a-f0-9]{64}$/);
      expect(lockKeys[2]).toMatch(
        new RegExp(`^openclaw-execution-receipts:${COMPANY_ID}:owner-user:`),
      );
    }
  });

  it.each([
    {
      label: 'READY',
      executionStatus: OpenClawCrmExecutionStatus.READY,
      executionLeaseToken: null,
      executionLeaseExpiresAt: null,
    },
    {
      label: 'DRAINING',
      executionStatus: OpenClawCrmExecutionStatus.DRAINING,
      executionLeaseToken: 'lease-live',
      executionLeaseExpiresAt: new Date(Date.now() + 30_000),
    },
    {
      label: 'SETTLED',
      executionStatus: OpenClawCrmExecutionStatus.SETTLED,
      executionLeaseToken: null,
      executionLeaseExpiresAt: null,
    },
    {
      label: 'expired RUNNING lease',
      executionStatus: OpenClawCrmExecutionStatus.RUNNING,
      executionLeaseToken: 'expired-lease',
      executionLeaseExpiresAt: new Date(Date.now() - 1),
    },
  ])('rejects a CRM callback whose current execution is $label before business access', async (state) => {
    const { service, prisma, agent } = createHarness();
    prisma.openClawCrmSession.findUnique.mockResolvedValue({
      id: 'crm-session-1',
      sessionDigest: 'a'.repeat(64),
      companyId: COMPANY_ID,
      operatorUserId: 'crm-admin',
      expiresAt: new Date(Date.now() + 60_000),
      ...state,
    });

    await expect(service.execute('customer-search', {
      actor: crmActor({ toolCallId: `late-${state.label}` }),
      input: { query: 'Buyer', limit: 5 },
    }, verified)).rejects.toThrow(/execution lease is not active/i);
    expect(agent.searchCustomersForOpenClaw).not.toHaveBeenCalled();
    expect(prisma.openClawToolReceipt.create).not.toHaveBeenCalled();
    expect(prisma.agentRun.create).not.toHaveBeenCalled();
  });

  it('rejects a callback resolved under an old token before reserving against a newer RUNNING lease', async () => {
    const { service, prisma, agent, crmSessions } = createHarness();
    crmSessions.resolve.mockResolvedValue({
      companyId: COMPANY_ID,
      operatorUserId: 'crm-admin',
      executionLeaseToken: 'lease-old',
      user: {
        id: 'crm-admin',
        email: 'admin@example.com',
        companies: [{ id: COMPANY_ID, role: 'company_admin' }],
      },
    });
    prisma.openClawCrmSession.findUnique.mockResolvedValue({
      id: 'crm-session-1',
      sessionDigest: 'a'.repeat(64),
      companyId: COMPANY_ID,
      operatorUserId: 'crm-admin',
      expiresAt: new Date(Date.now() + 60_000),
      executionStatus: OpenClawCrmExecutionStatus.RUNNING,
      executionLeaseToken: 'lease-new',
      executionLeaseExpiresAt: new Date(Date.now() + 30_000),
    });

    await expect(service.execute('customer-search', {
      actor: crmActor({ toolCallId: 'old-lease-callback' }),
      input: { query: 'Buyer', limit: 5 },
    }, verified)).rejects.toThrow(/execution lease is not active/i);
    expect(agent.searchCustomersForOpenClaw).not.toHaveBeenCalled();
    expect(prisma.openClawToolReceipt.create).not.toHaveBeenCalled();
  });

  it('deduplicates one frontend request by CRM session, tool and input even if the model changes toolCallId', async () => {
    const { service, prisma, agent } = createHarness();
    const first = await service.execute('customer-search', {
      actor: crmActor({ toolCallId: 'model-call-attempt-1' }),
      input: { query: 'Buyer', limit: 5 },
    }, verified);
    const second = await service.execute('customer-search', {
      actor: crmActor({ toolCallId: 'model-call-attempt-2' }),
      input: { query: 'Buyer', limit: 5 },
    }, { ...verified, bodyDigest: 'c'.repeat(64) });

    expect(second).toEqual(first);
    expect(agent.searchCustomersForOpenClaw).toHaveBeenCalledTimes(1);
    expect(prisma.openClawToolReceipt.create).toHaveBeenCalledTimes(1);
    expect(prisma.agentRun.create).toHaveBeenCalledTimes(1);
  });

  it('returns action tokens only for an exactly-one customer search and never exposes the conversation UUID', async () => {
    const { service, agent, prisma, selections, getReceipt } = createHarness();
    agent.searchCustomersForOpenClaw.mockResolvedValue({
      count: 1,
      hasMore: false,
      uniqueMatch: true,
      customers: [{
        customerName: 'Verified Buyer',
        country: 'US',
        whatsappConversationId: CONVERSATION_ID,
      }],
    });
    selections.issueForUniqueSearch.mockResolvedValue({
      expiresAt: '2026-07-15T10:02:00.000Z',
      tokens: ALL_SELECTION_TOKENS,
    });

    const result: any = await service.execute('customer-search', {
      actor: wechatActor({ toolCallId: 'unique-search-1', messageId: 'owner-message-1' }),
      input: { query: 'Verified Buyer', limit: 5 },
    }, verified);

    expect(result.result).toEqual(expect.objectContaining({
      count: 1,
      hasMore: false,
      uniqueMatch: true,
      customers: [expect.objectContaining({ customerName: 'Verified Buyer' })],
      selection: expect.objectContaining({
        tokens: expect.objectContaining({
          'prepare-quote-delivery': QUOTE_SELECTION_TOKEN,
          'start-background-research': RESEARCH_SELECTION_TOKEN,
        }),
      }),
      selectionRequiredForActions: true,
    }));
    expect(JSON.stringify(result)).not.toContain(CONVERSATION_ID);
    const durableStructures = JSON.stringify({
      receipt: getReceipt(),
      runUpdates: prisma.agentRun.updateMany.mock.calls,
      taskUpdates: prisma.agentTask.updateMany.mock.calls,
    });
    expect(durableStructures).not.toContain(QUOTE_SELECTION_TOKEN);
    expect(durableStructures).not.toContain(RESEARCH_SELECTION_TOKEN);
    expect(getReceipt().result.selection).toBeNull();
    expect(selections.issueForUniqueSearch).toHaveBeenCalledWith(
      expect.objectContaining({
        companyId: COMPANY_ID,
        operatorUserId: 'owner-user',
        sessionDigest: expect.stringMatching(/^[a-f0-9]{64}$/),
        messageDigest: expect.stringMatching(/^[a-f0-9]{64}$/),
      }),
      expect.stringMatching(/^[a-f0-9]{64}$/),
      expect.any(Object),
    );
  });

  it('derives the customer UUID from the one-use token while preserving validated action fields', async () => {
    const { service, agent, selections } = createHarness();
    const result: any = await service.execute('customer-add-note', {
      actor: crmActor({ toolCallId: 'customer-note-1' }),
      input: {
        selectionToken: ALL_SELECTION_TOKENS['customer-add-note'],
        note: '  Confirmed MOQ discussion  ',
      },
    }, verified);

    expect(selections.consume).toHaveBeenCalledWith(
      ALL_SELECTION_TOKENS['customer-add-note'],
      'customer-add-note',
      expect.any(Object),
    );
    expect(agent.addCustomerNoteForOpenClaw).toHaveBeenCalledWith(
      COMPANY_ID,
      LEAD_ID,
      '  Confirmed MOQ discussion  ',
      expect.stringMatching(/^[a-f0-9]{64}$/),
      expect.objectContaining({ id: 'crm-admin' }),
    );
    expect(result).toEqual(expect.objectContaining({
      businessStatus: 'SUCCEEDED',
      result: expect.objectContaining({ status: 'SUCCEEDED', customerName: 'Buyer' }),
    }));
    expect(JSON.stringify(agent.addCustomerNoteForOpenClaw.mock.calls)).not.toContain(
      ALL_SELECTION_TOKENS['customer-add-note'],
    );
  });

  it('rejects a CRM actor that attempts to smuggle a WeChat sender or wrong agent id', async () => {
    const { service, crmSessions } = createHarness();
    await expect(service.execute('work-brief', {
      actor: crmActor({ requesterSenderId: OWNER_SENDER }),
    }, verified)).rejects.toBeInstanceOf(ForbiddenException);
    await expect(service.execute('work-brief', {
      actor: crmActor({ agentId: 'other-agent' }),
    }, verified)).rejects.toBeInstanceOf(ForbiddenException);
    expect(crmSessions.resolve).not.toHaveBeenCalled();
  });

  it('reuses one research receipt for the same messageId-less business input across toolCallIds', async () => {
    const { service, agent, prisma, selections, getReceipt } = createHarness();
    let tokenConsumed = false;
    selections.consume.mockImplementation(async () => {
      const replay = tokenConsumed;
      tokenConsumed = true;
      return { leadId: LEAD_ID, conversationId: CONVERSATION_ID, replay };
    });
    prisma.openClawToolReceipt.findFirst.mockImplementation(({ where }: any) => {
      const receipt = getReceipt();
      return receipt?.businessInputDigest === where.businessInputDigest ? receipt : null;
    });
    const first = await service.execute('start-background-research', {
      actor: wechatActor({ toolCallId: 'research-call-1' }),
      input: { selectionToken: RESEARCH_SELECTION_TOKEN },
    }, verified);
    const second = await service.execute('start-background-research', {
      actor: wechatActor({ toolCallId: 'research-call-2' }),
      input: { selectionToken: RESEARCH_SELECTION_TOKEN },
    }, { ...verified, bodyDigest: 'c'.repeat(64) });
    expect(second).toEqual(first);
    expect(agent.startBackgroundResearchForOpenClaw).toHaveBeenCalledTimes(1);
    expect(prisma.agentRun.create).toHaveBeenCalledTimes(1);
    expect(prisma.openClawToolReceipt.findFirst).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({
        businessInputDigest: expect.stringMatching(/^[a-f0-9]{64}$/),
        createdAt: { gte: expect.any(Date) },
      }),
    }));
  });

  it('serializes concurrent messageId-less action retries and creates one side effect', async () => {
    const { service, agent, prisma, selections, getReceipt } = createHarness();
    let tokenConsumeCalls = 0;
    selections.consume.mockImplementation(async () => ({
      leadId: LEAD_ID,
      conversationId: CONVERSATION_ID,
      replay: tokenConsumeCalls++ > 0,
    }));
    let transactionTail: Promise<void> = Promise.resolve();
    prisma.$transaction.mockImplementation(async (callback: any) => {
      const previous = transactionTail;
      let release!: () => void;
      transactionTail = new Promise<void>((resolve) => { release = resolve; });
      await previous;
      try {
        return await callback(prisma);
      } finally {
        release();
      }
    });
    prisma.openClawToolReceipt.findFirst.mockImplementation(({ where }: any) => {
      const receipt = getReceipt();
      return receipt?.businessInputDigest === where.businessInputDigest ? receipt : null;
    });

    const settled = await Promise.all([
      service.execute('prepare-quote-delivery', {
        actor: wechatActor({ toolCallId: 'quote-concurrent-1' }),
        input: { selectionToken: QUOTE_SELECTION_TOKEN },
      }, verified),
      service.execute('prepare-quote-delivery', {
        actor: wechatActor({ toolCallId: 'quote-concurrent-2' }),
        input: { selectionToken: QUOTE_SELECTION_TOKEN },
      }, { ...verified, bodyDigest: 'd'.repeat(64) }),
    ]);

    expect(settled).toHaveLength(2);
    expect(agent.prepareQuoteDeliveryForOpenClaw).toHaveBeenCalledTimes(1);
    expect(prisma.openClawToolReceipt.create).toHaveBeenCalledTimes(1);
    expect(prisma.agentRun.create).toHaveBeenCalledTimes(1);
  });

  it('rejects a consumed selection replay when no receipt was reserved', async () => {
    const { service, agent, prisma, selections } = createHarness();
    selections.consume.mockResolvedValue({
      leadId: LEAD_ID,
      conversationId: CONVERSATION_ID,
      replay: true,
    });

    await expect(service.execute('prepare-quote-delivery', {
      actor: wechatActor({ toolCallId: 'quote-replay-without-receipt' }),
      input: { selectionToken: QUOTE_SELECTION_TOKEN },
    }, verified)).rejects.toThrow(/replay has no active receipt/i);
    expect(agent.prepareQuoteDeliveryForOpenClaw).not.toHaveBeenCalled();
    expect(prisma.agentRun.create).not.toHaveBeenCalled();
    expect(prisma.openClawToolReceipt.create).not.toHaveBeenCalled();
  });

  it('does not merge different action inputs and allows the same input after the dedupe window', async () => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-07-15T10:00:00.000Z'));
    const { service, agent, prisma, selections, getReceipt } = createHarness();
    selections.consume.mockImplementation(async (token: string) => ({
      leadId: token.startsWith('D')
        ? '44444444-4444-4444-8444-444444444444'
        : LEAD_ID,
      conversationId: token.startsWith('D')
        ? '44444444-4444-4444-8444-444444444444'
        : CONVERSATION_ID,
      replay: false,
    }));
    prisma.openClawToolReceipt.findFirst.mockImplementation(({ where }: any) => {
      const receipt = getReceipt();
      return receipt
        && receipt.businessInputDigest === where.businessInputDigest
        && receipt.createdAt >= where.createdAt.gte
        ? receipt
        : null;
    });

    await service.execute('prepare-quote-delivery', {
      actor: wechatActor({ toolCallId: 'quote-window-1' }),
      input: { selectionToken: QUOTE_SELECTION_TOKEN },
    }, verified);
    await service.execute('prepare-quote-delivery', {
      actor: wechatActor({ toolCallId: 'quote-different-input' }),
      input: { selectionToken: 'D'.repeat(43) },
    }, verified);
    expect(agent.prepareQuoteDeliveryForOpenClaw).toHaveBeenCalledTimes(2);

    // The latest stored receipt represents the different input. Move it out
    // of the window, then repeat that same trusted input with a fresh token.
    getReceipt().createdAt = new Date('2026-07-15T09:58:00.000Z');
    await service.execute('prepare-quote-delivery', {
      actor: wechatActor({ toolCallId: 'quote-window-expired' }),
      input: { selectionToken: 'D'.repeat(42) + '2' },
    }, verified);
    expect(agent.prepareQuoteDeliveryForOpenClaw).toHaveBeenCalledTimes(3);
    expect(prisma.openClawToolReceipt.create).toHaveBeenCalledTimes(3);
  });

  it('fails closed before creating a ninth receipt in the same operator session', async () => {
    const { service, prisma } = createHarness();
    prisma.openClawToolReceipt.count.mockResolvedValue(8);
    const messageId = 'same-owner-message-capacity';

    await expect(service.execute('work-brief', {
      actor: wechatActor({ toolCallId: 'session-capacity-ninth', messageId }),
    }, verified)).rejects.toBeInstanceOf(ConflictException);

    expect(prisma.$queryRaw).toHaveBeenCalledTimes(2);
    expect(advisoryLockKeyAt(prisma.$queryRaw, 0)).toBe(
      `openclaw-weixin-owner-binding:${COMPANY_ID}:owner-user`,
    );
    expect(advisoryLockKeyAt(prisma.$queryRaw, 1)).toMatch(
      new RegExp(`^openclaw-execution-receipts:${COMPANY_ID}:owner-user:`),
    );
    expect(prisma.openClawToolReceipt.count).toHaveBeenCalledWith({
      where: {
        companyId: COMPANY_ID,
        operatorUserId: 'owner-user',
        sessionDigest: createHash('sha256').update('wx-session-opaque').digest('hex'),
        messageDigest: createHash('sha256').update(messageId).digest('hex'),
      },
    });
    expect(prisma.agentRun.create).not.toHaveBeenCalled();
    expect(prisma.openClawToolReceipt.create).not.toHaveBeenCalled();
    expect(prisma.openClawToolReceipt.updateMany).not.toHaveBeenCalled();
    expect(prisma.agentTask.updateMany).not.toHaveBeenCalled();
    expect(prisma.agentAuditLog.create).not.toHaveBeenCalled();
  });

  it('does not count historical receipts from earlier messages in a stable owner WeChat peer session', async () => {
    const { service, prisma } = createHarness();
    const historicalMessageDigest = createHash('sha256').update('old-owner-message').digest('hex');
    const currentMessageId = 'new-owner-message';
    const currentMessageDigest = createHash('sha256').update(currentMessageId).digest('hex');
    prisma.openClawToolReceipt.count.mockImplementation(({ where }: any) => (
      where.messageDigest === historicalMessageDigest ? 8 : 0
    ));

    await expect(service.execute('work-brief', {
      actor: wechatActor({
        toolCallId: 'new-message-first-tool',
        messageId: currentMessageId,
      }),
    }, verified)).resolves.toEqual(expect.objectContaining({
      status: OpenClawReceiptStatus.COMPLETED,
    }));

    expect(prisma.openClawToolReceipt.count).toHaveBeenCalledWith({
      where: {
        companyId: COMPANY_ID,
        operatorUserId: 'owner-user',
        sessionDigest: createHash('sha256').update('wx-session-opaque').digest('hex'),
        messageDigest: currentMessageDigest,
      },
    });
    expect(prisma.openClawToolReceipt.create).toHaveBeenCalledTimes(1);
  });

  it('rejects a ninth owner-WeChat callback inside the messageId-less rolling safety window', async () => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-07-15T08:01:00.000Z'));
    const { service, prisma } = createHarness();
    prisma.openClawToolReceipt.count.mockResolvedValue(8);

    await expect(service.execute('work-brief', {
      actor: wechatActor({ toolCallId: 'rolling-window-ninth' }),
    }, verified)).rejects.toThrow(/execution receipt capacity exceeded/i);

    expect(prisma.openClawToolReceipt.count).toHaveBeenCalledWith({
      where: {
        companyId: COMPANY_ID,
        operatorUserId: 'owner-user',
        sessionDigest: createHash('sha256').update('wx-session-opaque').digest('hex'),
        createdAt: { gte: new Date('2026-07-15T08:00:00.000Z') },
      },
    });
    expect(prisma.openClawToolReceipt.create).not.toHaveBeenCalled();
    expect(prisma.agentRun.create).not.toHaveBeenCalled();
  });

  it('allows owner-WeChat tools again after old messageId-less receipts leave the rolling window', async () => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-07-15T08:01:01.000Z'));
    const { service, prisma } = createHarness();
    const historicalReceipts = Array.from({ length: 8 }, () => ({
      createdAt: new Date('2026-07-15T08:00:00.000Z'),
    }));
    prisma.openClawToolReceipt.count.mockImplementation(({ where }: any) => (
      historicalReceipts.filter((receipt) => receipt.createdAt >= where.createdAt.gte).length
    ));

    await expect(service.execute('work-brief', {
      actor: wechatActor({ toolCallId: 'rolling-window-recovered' }),
    }, verified)).resolves.toEqual(expect.objectContaining({
      status: OpenClawReceiptStatus.COMPLETED,
    }));

    expect(prisma.openClawToolReceipt.count).toHaveBeenCalledWith({
      where: expect.objectContaining({
        sessionDigest: createHash('sha256').update('wx-session-opaque').digest('hex'),
        createdAt: { gte: new Date('2026-07-15T08:00:01.000Z') },
      }),
    });
    expect(prisma.openClawToolReceipt.create).toHaveBeenCalledTimes(1);
  });

  it('serializes concurrent eighth and ninth reservations so only one is created', async () => {
    const { service, prisma } = createHarness();
    let durableReceiptCount = 7;
    let advisoryLockTail: Promise<void> = Promise.resolve();
    let advisoryLockCalls = 0;
    let capacityAdvisoryLockCalls = 0;
    const createReceipt = prisma.openClawToolReceipt.create.getMockImplementation();

    prisma.openClawToolReceipt.count.mockImplementation(
      () => Promise.resolve(durableReceiptCount),
    );
    prisma.openClawToolReceipt.create.mockImplementation(async (args: any) => {
      const receipt = await createReceipt(args);
      durableReceiptCount += 1;
      return receipt;
    });
    // Model transaction-scoped advisory-lock semantics: only transactions
    // that execute pg_advisory_xact_lock are serialized, and the lock is held
    // until their callback commits or rolls back.
    prisma.$transaction.mockImplementation(async (input: any) => {
      if (typeof input !== 'function') return Promise.all(input);
      let releaseAdvisoryLock: (() => void) | undefined;
      const tx = {
        ...prisma,
        $queryRaw: jest.fn(async (_query: readonly string[], lockKey: string) => {
          advisoryLockCalls += 1;
          if (!lockKey.startsWith('openclaw-execution-receipts:')) {
            return [{ locked: '' }];
          }
          capacityAdvisoryLockCalls += 1;
          const previous = advisoryLockTail;
          let release!: () => void;
          advisoryLockTail = new Promise<void>((resolve) => {
            release = resolve;
          });
          await previous;
          releaseAdvisoryLock = release;
          return [{ locked: '' }];
        }),
      };
      try {
        return await input(tx);
      } finally {
        releaseAdvisoryLock?.();
      }
    });

    const settled = await Promise.allSettled([
      service.execute('work-brief', {
        actor: wechatActor({ toolCallId: 'session-capacity-eighth' }),
      }, verified),
      service.execute('work-brief', {
        actor: wechatActor({ toolCallId: 'session-capacity-ninth-racing' }),
      }, verified),
    ]);

    expect(settled.filter((item) => item.status === 'fulfilled')).toHaveLength(1);
    const rejected = settled.filter((item) => item.status === 'rejected') as PromiseRejectedResult[];
    expect(rejected).toHaveLength(1);
    expect(rejected[0].reason).toBeInstanceOf(ConflictException);
    expect(advisoryLockCalls).toBe(4);
    expect(capacityAdvisoryLockCalls).toBe(2);
    expect(durableReceiptCount).toBe(8);
    expect(prisma.openClawToolReceipt.count).toHaveBeenCalledTimes(2);
    expect(prisma.openClawToolReceipt.create).toHaveBeenCalledTimes(1);
    expect(prisma.agentRun.create).toHaveBeenCalledTimes(1);
  });

  it('fails a stale PROCESSING receipt without replaying it and permits only a fresh tool call', async () => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-07-14T12:10:00.000Z'));
    const { service, agent, prisma, getReceipt } = createHarness();
    const actor = wechatActor({ toolCallId: 'stale-work-brief-1' });
    await service.execute('work-brief', { actor }, verified);
    Object.assign(getReceipt(), {
      status: OpenClawReceiptStatus.PROCESSING,
      result: null,
      completedAt: null,
      createdAt: new Date('2026-07-14T12:00:00.000Z'),
    });

    const stale: any = await service.execute('work-brief', { actor }, verified);
    expect(stale).toEqual(expect.objectContaining({
      status: OpenClawReceiptStatus.FAILED,
      errorCode: 'OPENCLAW_STALE_PROCESSING',
      result: null,
    }));
    expect(stale).not.toHaveProperty('runId');
    expect(agent.getBrief).toHaveBeenCalledTimes(1);
    expect(prisma.agentRun.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ id: 'wrapper-run-1', status: 'RUNNING' }),
      data: expect.objectContaining({
        status: 'FAILED',
        errorCode: 'OPENCLAW_STALE_PROCESSING',
      }),
    }));
    expect(prisma.agentAuditLog.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        eventType: 'OPENCLAW_TOOL_STALE_FAILED',
        metadata: expect.objectContaining({ automaticRetry: false }),
      }),
    }));

    await service.execute('work-brief', {
      actor: wechatActor({ toolCallId: 'fresh-work-brief-2' }),
    }, verified);
    expect(agent.getBrief).toHaveBeenCalledTimes(2);
  });

  it('keeps stale FAILED terminal state when the original invocation succeeds late', async () => {
    const { service, agent, prisma, getReceipt } = createHarness();
    const invocation = deferred<any>();
    const entered = deferred<void>();
    agent.getBrief.mockImplementationOnce(() => {
      entered.resolve();
      return invocation.promise;
    });
    const actor = wechatActor({ toolCallId: 'late-success-after-stale-1' });
    const original = service.execute('work-brief', { actor }, verified);
    await entered.promise;
    Object.assign(getReceipt(), {
      createdAt: new Date(Date.now() - PROCESSING_RECEIPT_STALE_MS_FOR_TEST),
    });

    const recovered: any = await service.execute('work-brief', { actor }, verified);
    expect(recovered).toEqual(expect.objectContaining({
      status: OpenClawReceiptStatus.FAILED,
      errorCode: 'OPENCLAW_STALE_PROCESSING',
    }));

    invocation.resolve({ metrics: { leads: 99 } });
    await expect(original).resolves.toEqual(expect.objectContaining({
      status: OpenClawReceiptStatus.FAILED,
      errorCode: 'OPENCLAW_STALE_PROCESSING',
      result: null,
    }));
    expect(getReceipt()).toEqual(expect.objectContaining({
      status: OpenClawReceiptStatus.FAILED,
      errorCode: 'OPENCLAW_STALE_PROCESSING',
      result: null,
    }));
    expect(prisma.agentRun.updateMany).not.toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ status: 'COMPLETED' }),
    }));
    expect(prisma.agentTask.updateMany).not.toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ status: 'COMPLETED' }),
    }));
    expect(prisma.agentAuditLog.create).not.toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ eventType: 'OPENCLAW_TOOL_COMPLETED' }),
    }));
  });

  it('keeps stale FAILED error when the original invocation throws late', async () => {
    const { service, agent, prisma, getReceipt } = createHarness();
    const invocation = deferred<any>();
    const entered = deferred<void>();
    agent.getBrief.mockImplementationOnce(() => {
      entered.resolve();
      return invocation.promise;
    });
    const actor = wechatActor({ toolCallId: 'late-failure-after-stale-1' });
    const original = service.execute('work-brief', { actor }, verified);
    await entered.promise;
    Object.assign(getReceipt(), {
      createdAt: new Date(Date.now() - PROCESSING_RECEIPT_STALE_MS_FOR_TEST),
    });

    await service.execute('work-brief', { actor }, verified);
    invocation.reject(new Error('late invocation failure'));

    await expect(original).resolves.toEqual(expect.objectContaining({
      status: OpenClawReceiptStatus.FAILED,
      errorCode: 'OPENCLAW_STALE_PROCESSING',
      result: null,
    }));
    expect(getReceipt().errorCode).toBe('OPENCLAW_STALE_PROCESSING');
    expect(prisma.agentRun.updateMany).not.toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ errorCode: 'OPENCLAW_TOOL_FAILED' }),
    }));
    expect(prisma.agentTask.updateMany).not.toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ errorCode: 'OPENCLAW_TOOL_FAILED' }),
    }));
    expect(prisma.agentAuditLog.create).not.toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ eventType: 'OPENCLAW_TOOL_FAILED' }),
    }));
  });

  it('returns 409 when the same toolCallId is reused with different parameters', async () => {
    const { service, selections } = createHarness();
    selections.consume.mockImplementation(async (token: string) => ({
      leadId: token === QUOTE_SELECTION_TOKEN
        ? LEAD_ID
        : '44444444-4444-4444-8444-444444444444',
      conversationId: token === QUOTE_SELECTION_TOKEN
        ? CONVERSATION_ID
        : '44444444-4444-4444-8444-444444444444',
      replay: false,
    }));
    const actor = wechatActor({ toolCallId: 'quote-call-1' });
    await service.execute('prepare-quote-delivery', {
      actor,
      input: { selectionToken: QUOTE_SELECTION_TOKEN },
    }, verified);
    await expect(service.execute('prepare-quote-delivery', {
      actor,
      input: { selectionToken: 'X'.repeat(43) },
    }, { ...verified, bodyDigest: 'c'.repeat(64) })).rejects.toBeInstanceOf(ConflictException);
  });

  it('never returns the trusted recipient phone from a quote preparation tool', async () => {
    const { service } = createHarness();
    const result = await service.execute('prepare-quote-delivery', {
      actor: wechatActor({ toolCallId: 'quote-redaction-1' }),
      input: { selectionToken: QUOTE_SELECTION_TOKEN },
    }, verified);
    expect(result.result).toEqual(expect.objectContaining({
      automaticSend: false,
      requiresHumanConfirmation: true,
      requiresManualWhatsappSend: true,
    }));
    expect(result).not.toHaveProperty('runId');
    expect(result.result).not.toHaveProperty('proposalId');
    expect(result.result).not.toHaveProperty('agentRunId');
    expect(JSON.stringify(result)).not.toContain('+8613800000000');
  });

  it('sends email to one stored customer address even when the customer has no WhatsApp conversation', async () => {
    const { service, prisma, selections, businessMail } = createHarness();
    selections.consume.mockResolvedValue({
      leadId: LEAD_ID,
      conversationId: null,
      replay: false,
    });
    prisma.lead.findFirst.mockResolvedValueOnce({
      id: LEAD_ID,
      companyId: COMPANY_ID,
      companyName: 'Unique Buyer',
      leadName: null,
      contactName: 'Buyer',
      ownerUserId: 'owner-user',
      deletedAt: null,
      isMerged: false,
      contactEmail: 'buyer@example.com',
      emailVerificationStatus: null,
      contactPoints: [],
      conversations: [],
    });

    const result: any = await service.execute('email-send', {
      actor: wechatActor({ toolCallId: 'email-send-no-whatsapp', messageId: 'owner-email-send-1' }),
      input: {
        selectionToken: ALL_SELECTION_TOKENS['email-send'],
        subject: 'Updated quotation',
        body: 'Please find the updated commercial terms below.',
      },
    }, verified);

    expect(businessMail.sendMail).toHaveBeenCalledWith(expect.objectContaining({
      to: 'buyer@example.com',
      subject: 'Updated quotation',
      leadId: LEAD_ID,
    }), expect.objectContaining({ id: 'owner-user' }));
    expect(result).toEqual(expect.objectContaining({
      businessStatus: 'SUCCEEDED',
      result: expect.objectContaining({
        status: 'SUCCEEDED',
        channel: 'email',
        delivered: true,
      }),
    }));
  });

  it('sends one approved quote PDF through the selected Baileys conversation and returns a real receipt', async () => {
    const { service, prisma, assistantPermissions, whatsapp, quotes } = createHarness();
    const result: any = await service.execute('whatsapp-send-quote', {
      actor: wechatActor({ toolCallId: 'quote-send-1', messageId: 'owner-quote-send-1' }),
      input: {
        selectionToken: ALL_SELECTION_TOKENS['whatsapp-send-quote'],
        referenceNo: 'QT-20260718-ABC123',
      },
    }, verified);

    expect(assistantPermissions.evaluate.mock.calls.map((call: any[]) => call[2]))
      .toEqual(['crm.quote.send', 'crm.message.send']);
    expect(prisma.quote.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: {
        companyId: COMPANY_ID,
        leadId: LEAD_ID,
        referenceNo: 'QT-20260718-ABC123',
      },
      take: 2,
    }));
    expect(quotes.generatePiHtml).toHaveBeenCalledWith('quote-1', expect.objectContaining({ id: 'owner-user' }));
    expect(whatsapp.sendMediaOnly).toHaveBeenCalledWith(
      'wa-session-1',
      '8613800000000@s.whatsapp.net',
      expect.objectContaining({
        type: 'document',
        filename: 'QT-20260718-ABC123.pdf',
        mimeType: 'application/pdf',
        buffer: expect.any(Buffer),
      }),
      expect.objectContaining({ id: 'owner-user' }),
    );
    expect(result).toEqual(expect.objectContaining({
      status: 'COMPLETED',
      businessStatus: 'SUCCEEDED',
      result: expect.objectContaining({
        status: 'SUCCEEDED',
        quoteReferenceNo: 'QT-20260718-ABC123',
        providerMessageId: 'provider-quote-1',
        acceptedAt: '2026-07-18T10:00:00.000Z',
        delivered: true,
      }),
    }));
    expect(JSON.stringify(result)).not.toContain('8613800000000');
  });

  it('uses the unique connected server Baileys session when the trusted conversation came from Electron', async () => {
    const { service, prisma, whatsapp } = createHarness();
    prisma.whatsAppSession.findFirst.mockResolvedValue({
      id: 'electron-session-1',
      authStatePath: 'electron-account:ZGVmYXVsdA',
    });
    prisma.whatsAppSession.findMany.mockResolvedValue([{
      id: 'server-baileys-session-1',
      authStatePath: '/var/lib/vaysen-crm/whatsapp/server-session-1',
    }]);

    const result: any = await service.execute('whatsapp-send-text', {
      actor: wechatActor({ toolCallId: 'electron-origin-send-1', messageId: 'owner-send-1' }),
      input: {
        selectionToken: ALL_SELECTION_TOKENS['whatsapp-send-text'],
        text: 'Internal acceptance message',
      },
    }, verified);

    expect(prisma.whatsAppSession.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { companyId: COMPANY_ID, status: 'connected' },
    }));
    expect(whatsapp.sendMessage).toHaveBeenCalledWith(
      'server-baileys-session-1',
      {
        to: '8613800000000@s.whatsapp.net',
        text: 'Internal acceptance message',
      },
      expect.objectContaining({ id: 'owner-user' }),
    );
    expect(result).toEqual(expect.objectContaining({
      status: 'COMPLETED',
      businessStatus: 'SUCCEEDED',
      result: expect.objectContaining({
        status: 'SUCCEEDED',
        delivered: true,
      }),
    }));
  });

  it('blocks quote PDF delivery unless both quote and message send capabilities allow it', async () => {
    const { service, assistantPermissions, whatsapp, quotes } = createHarness();
    assistantPermissions.evaluate.mockResolvedValueOnce({
      decision: 'APPROVAL_REQUIRED',
      reason: 'PROFILE_POLICY',
    });
    const result: any = await service.execute('whatsapp-send-quote', {
      actor: wechatActor({ toolCallId: 'quote-send-blocked-1', messageId: 'owner-quote-blocked-1' }),
      input: {
        selectionToken: ALL_SELECTION_TOKENS['whatsapp-send-quote'],
        referenceNo: 'QT-20260718-ABC123',
      },
    }, verified);
    expect(result.businessStatus).toBe('BLOCKED');
    expect(result.result).toEqual(expect.objectContaining({
      status: 'APPROVAL_REQUIRED',
      delivered: false,
    }));
    expect(whatsapp.sendMediaOnly).not.toHaveBeenCalled();
    expect(quotes.generatePiHtml).not.toHaveBeenCalled();
  });

  it('keeps quote transport COMPLETED while persisting a BLOCKED business outcome', async () => {
    const { service, agent, prisma, getReceipt } = createHarness();
    agent.prepareQuoteDeliveryForOpenClaw.mockResolvedValue({
      id: 'blocked-quote-artifact',
      output: '未找到可交付的报价，未执行任何外发动作。',
      actionStatus: 'BLOCKED',
      actionProposal: {
        status: 'BLOCKED',
        quote: null,
        target: null,
      },
    });

    const result: any = await service.execute('prepare-quote-delivery', {
      actor: wechatActor({ toolCallId: 'quote-blocked-1' }),
      input: { selectionToken: QUOTE_SELECTION_TOKEN },
    }, verified);

    expect(result).toEqual(expect.objectContaining({
      status: 'COMPLETED',
      businessStatus: 'BLOCKED',
      result: expect.objectContaining({ status: 'BLOCKED' }),
    }));
    expect(getReceipt()).toEqual(expect.objectContaining({
      status: 'COMPLETED',
      businessStatus: 'BLOCKED',
    }));
    expect(prisma.agentRun.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        status: 'COMPLETED',
        result: expect.objectContaining({ businessStatus: 'BLOCKED' }),
      }),
    }));
    expect(prisma.agentTask.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        status: 'COMPLETED',
        result: expect.objectContaining({ businessStatus: 'BLOCKED' }),
      }),
    }));
  });

  it('reports a blocked research request as business BLOCKED without a transport failure', async () => {
    const { service, agent, getReceipt } = createHarness();
    agent.startBackgroundResearchForOpenClaw.mockResolvedValue({
      agentRunId: null,
      actionStatus: 'BLOCKED',
      responseKind: 'ACTION_BLOCKED',
      output: '客户身份不可信，未创建背调任务。',
    });

    const result: any = await service.execute('start-background-research', {
      actor: wechatActor({ toolCallId: 'research-blocked-1' }),
      input: { selectionToken: RESEARCH_SELECTION_TOKEN },
    }, verified);

    expect(result).toEqual(expect.objectContaining({
      status: 'COMPLETED',
      businessStatus: 'BLOCKED',
      result: expect.objectContaining({
        status: 'BLOCKED',
        responseKind: 'ACTION_BLOCKED',
      }),
    }));
    expect(getReceipt()).toEqual(expect.objectContaining({
      status: 'COMPLETED',
      businessStatus: 'BLOCKED',
    }));
  });

  it.each(['FAILED', 'CANCELLED']) (
    'reports a real research %s outcome as business FAILED, not a policy block',
    async (actionStatus) => {
      const { service, agent, prisma, getReceipt } = createHarness();
      agent.startBackgroundResearchForOpenClaw.mockResolvedValue({
        agentRunId: 'research-run-terminal',
        actionStatus,
        responseKind: 'TASK_STATUS',
        output: `research ${actionStatus.toLowerCase()}`,
      });

      const result: any = await service.execute('start-background-research', {
        actor: wechatActor({ toolCallId: `research-${actionStatus.toLowerCase()}-1` }),
        input: { selectionToken: RESEARCH_SELECTION_TOKEN },
      }, verified);

      expect(result).toEqual(expect.objectContaining({
        status: 'COMPLETED',
        businessStatus: 'FAILED',
        result: expect.objectContaining({ status: actionStatus }),
      }));
      expect(getReceipt()).toEqual(expect.objectContaining({
        status: 'COMPLETED',
        businessStatus: 'FAILED',
        errorCode: null,
      }));
      expect(prisma.agentRun.updateMany).toHaveBeenCalledWith(expect.objectContaining({
        data: expect.objectContaining({
          status: 'COMPLETED',
          result: expect.objectContaining({ businessStatus: 'FAILED' }),
        }),
      }));
    },
  );
});
