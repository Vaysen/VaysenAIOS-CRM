import { AgentRunStatus, OpenClawReceiptStatus } from '@prisma/client';
import { AgentService } from '../agent/agent.service';
import { OpenClawCrmSessionService } from './openclaw-crm-session.service';
import { OpenClawToolBrokerService } from './openclaw-tool-broker.service';

const COMPANY_ID = '11111111-1111-4111-8111-111111111111';
const ADMIN = {
  id: 'admin-1',
  email: 'admin@example.com',
  companies: [{ id: COMPANY_ID, role: 'company_admin' }],
};

describe('OpenClaw admin chat to CRM tool receipt chain', () => {
  it('requires an admin chat registration before the CRM Gateway can obtain a receipt', async () => {
    let sessionStore: any = null;
    let receiptStore: any = null;
    const prisma: any = {
      lead: { findMany: jest.fn().mockResolvedValue([]) },
      followUpReminder: { findMany: jest.fn().mockResolvedValue([]) },
      quote: { findMany: jest.fn().mockResolvedValue([]) },
      aiArtifact: {
        findUnique: jest.fn().mockResolvedValue(null),
        findMany: jest.fn().mockResolvedValue([]),
        upsert: jest.fn(async ({ create }: any) => ({
          id: 'assistant-artifact-1',
          createdAt: new Date(),
          acceptedAt: null,
          ...create,
        })),
      },
      userCompanyRelation: {
        findFirst: jest.fn().mockResolvedValue({
          role: { name: 'company_admin' },
          user: { email: ADMIN.email },
        }),
      },
      openClawCrmSession: {
        findUnique: jest.fn(async ({ where }: any) => (
          sessionStore?.sessionDigest === where.sessionDigest ? sessionStore : null
        )),
        upsert: jest.fn(async ({ create, update }: any) => {
          sessionStore = sessionStore
            ? { ...sessionStore, ...update }
            : { id: 'crm-session-1', ...create };
          return sessionStore;
        }),
        update: jest.fn(async ({ data }: any) => {
          sessionStore = { ...sessionStore, ...data };
          return sessionStore;
        }),
        updateMany: jest.fn(async ({ data }: any) => {
          sessionStore = { ...sessionStore, ...data };
          return { count: 1 };
        }),
      },
      openClawOperatorBinding: { upsert: jest.fn() },
      openClawToolReceipt: {
        count: jest.fn(async ({ where }: any = {}) => (
          receiptStore && (!where?.status || receiptStore.status === where.status) ? 1 : 0
        )),
        findMany: jest.fn(async () => (
          receiptStore ? [receiptStore] : []
        )),
        findUnique: jest.fn(async ({ where }: any) => (
          receiptStore
          && (receiptStore.requestKey === where.requestKey || receiptStore.id === where.id)
            ? receiptStore
            : null
        )),
        create: jest.fn(async ({ data }: any) => {
          receiptStore = { id: 'receipt-row-1', ...data };
          return receiptStore;
        }),
        update: jest.fn(async ({ data }: any) => {
          receiptStore = { ...receiptStore, ...data };
          return receiptStore;
        }),
        updateMany: jest.fn(async ({ where, data }: any) => {
          if (
            receiptStore
            && receiptStore.id === where.id
            && receiptStore.status === where.status
          ) {
            receiptStore = { ...receiptStore, ...data };
            return { count: 1 };
          }
          return { count: 0 };
        }),
      },
      agentRun: {
        findMany: jest.fn().mockResolvedValue([]),
        create: jest.fn().mockResolvedValue({ id: '20000000-0000-4000-8000-000000000031' }),
        update: jest.fn().mockResolvedValue({
          id: '20000000-0000-4000-8000-000000000031',
          status: AgentRunStatus.COMPLETED,
        }),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      agentTask: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
      agentAuditLog: { create: jest.fn().mockResolvedValue({ id: 'audit-1' }) },
    };
    prisma.$queryRaw = jest.fn().mockResolvedValue([{ locked: '' }]);
    prisma.$transaction = jest.fn(async (callback: any) => callback(prisma));

    const sessions = new OpenClawCrmSessionService(prisma);
    let assistant!: AgentService;
    const brokerAgent = {
      getBrief: (...args: any[]) => (assistant.getBrief as any)(...args),
    };
    const broker = new OpenClawToolBrokerService(prisma, brokerAgent as any, sessions, {
      issueForUniqueSearch: jest.fn().mockResolvedValue(null),
      consume: jest.fn().mockRejectedValue(new Error('selection not used by work brief')),
    } as any, {
      evaluate: jest.fn().mockResolvedValue({ decision: 'ALLOW', reason: 'PROFILE_POLICY' }),
    } as any, {
      sendMessage: jest.fn(),
    } as any, {
      sendMail: jest.fn(),
    } as any, {
      generatePiHtml: jest.fn(),
      htmlToPdf: jest.fn(),
    } as any);
    const gateway = {
      isEnabled: jest.fn().mockReturnValue(true),
      chat: jest.fn(async (_system: string, _user: string, sessionDigest: string) => {
        // A random Gateway session would fail in crmSessions.resolve. The only
        // mapping available here was created by the authenticated admin chat.
        expect(sessionStore).toEqual(expect.objectContaining({
          sessionDigest,
          companyId: COMPANY_ID,
          operatorUserId: ADMIN.id,
        }));
        const receipt: any = await broker.execute('work-brief', {
          actor: {
            channel: 'vaysen-crm',
            source: 'vaysen-crm',
            senderIsOwner: true,
            agentId: 'vaysen-crm',
            sessionKey: `vaysen-crm:${sessionDigest}`,
            toolCallId: 'chain-tool-call-1',
          },
        }, {
          bodyDigest: 'b'.repeat(64),
          nonceDigest: 'c'.repeat(64),
          keyId: 'crm-key-1',
          canonicalPath: '/api/internal/openclaw/tools/work-brief',
        });
        return {
          success: true,
          content: `真实工具回执 ${receipt.requestId} ${receipt.status}`,
          model: 'openclaw/vaysen-crm',
          reason: 'success',
        };
      }),
    };
    const ai = {
      chat: jest.fn(),
      getModel: jest.fn().mockReturnValue('glm-4.5-air'),
      isEnabled: jest.fn().mockReturnValue(true),
      hasKey: jest.fn().mockReturnValue(true),
    };
    assistant = new AgentService(
      prisma,
      ai as any,
      { enqueueForLead: jest.fn() } as any,
      gateway as any,
      sessions,
    );

    await expect(sessions.resolve(`vaysen-crm:${'f'.repeat(64)}`))
      .rejects.toThrow(/expired or unknown/i);

    const turn: any = await assistant.chat({
      requestId: '10000000-0000-4000-8000-000000000010',
      companyId: COMPANY_ID,
      message: '总结一下今天的工作重点',
      threadId: 'admin-chain',
    }, ADMIN);

    expect(turn.output).toContain('真实工具回执');
    expect(receiptStore).toEqual(expect.objectContaining({
      status: OpenClawReceiptStatus.COMPLETED,
      runId: '20000000-0000-4000-8000-000000000031',
      operatorUserId: ADMIN.id,
      companyId: COMPANY_ID,
      result: expect.objectContaining({ metrics: expect.any(Object) }),
    }));
    expect(prisma.openClawOperatorBinding.upsert).not.toHaveBeenCalled();
    expect(prisma.agentAuditLog.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ eventType: 'OPENCLAW_TOOL_COMPLETED' }),
    }));
    expect(prisma.aiArtifact.upsert.mock.calls[0][0].create).toEqual(expect.objectContaining({
      provider: 'openclaw',
      model: 'openclaw/vaysen-crm',
    }));
    expect(
      prisma.aiArtifact.upsert.mock.calls[0][0].create.extraData.executionSessionDigest,
    ).toBe(receiptStore.sessionDigest);
    expect(JSON.stringify(sessionStore)).not.toContain('admin-chain');
    expect(ai.chat).not.toHaveBeenCalled();
  });
});
