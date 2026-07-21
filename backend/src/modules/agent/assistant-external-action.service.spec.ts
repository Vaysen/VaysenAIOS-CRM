import { AssistantActionState, AssistantGrantStatus } from '@prisma/client';
import { AssistantExternalActionService } from './assistant-external-action.service';

const COMPANY_ID = '11111111-1111-4111-8111-111111111111';
const CONVERSATION_ID = '22222222-2222-4222-8222-222222222222';
const REQUEST_ID = '33333333-3333-4333-8333-333333333333';

function harness() {
  const actionRows = new Map<string, any>();
  const prisma: any = {
    assistantBusinessAction: {
      findUnique: jest.fn(({ where }: any) => {
        if (where.requestKey) return [...actionRows.values()].find((row) => row.requestKey === where.requestKey) || null;
        return actionRows.get(where.id) || null;
      }),
      count: jest.fn().mockResolvedValue(0),
      create: jest.fn(({ data }: any) => {
        const row = { id: 'action-1', ...data };
        actionRows.set(row.id, row);
        return row;
      }),
      updateMany: jest.fn(({ where, data }: any) => {
        const row = actionRows.get(where.id);
        if (!row || row.state !== where.state) return { count: 0 };
        Object.assign(row, data);
        return { count: 1 };
      }),
      findUniqueOrThrow: jest.fn(({ where }: any) => actionRows.get(where.id)),
    },
    assistantTemporaryGrant: {
      create: jest.fn(({ data }: any) => ({ id: 'grant-1', ...data })),
    },
    conversation: {
      findFirst: jest.fn().mockResolvedValue({
        id: CONVERSATION_ID,
        externalThreadId: '14155550100@c.us',
        contactPoint: { normalizedValue: '+14155550100' },
      }),
    },
    $transaction: jest.fn((callback: any) => callback(prisma)),
  };
  const permissions: any = {
    getProfile: jest.fn().mockResolvedValue({
      preset: 'SUPERVISOR',
      thresholds: { maxDailyExternalSends: 50 },
    }),
  };
  const service = new AssistantExternalActionService(prisma, permissions);
  const user: any = {
    id: 'admin-1',
    companies: [{ id: COMPANY_ID, role: 'company_admin' }],
  };
  return { service, prisma, user, actionRows };
}

const request = {
  companyId: COMPANY_ID,
  conversationId: CONVERSATION_ID,
  requestId: REQUEST_ID,
  targetPhone: '+1 (415) 555-0100',
  text: 'Hello verified buyer',
  confirmed: true,
};

describe('AssistantExternalActionService', () => {
  it('atomically consumes an exact one-use grant before returning a send permit', async () => {
    const { service, prisma, user } = harness();

    const result = await service.authorizeWhatsappTextSend(request, user);

    expect(result).toEqual(expect.objectContaining({
      status: 'CLAIMED',
      actionId: 'action-1',
      targetPhone: '14155550100',
      textDigest: expect.stringMatching(/^[a-f0-9]{64}$/),
    }));
    expect(prisma.assistantTemporaryGrant.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        capability: 'crm.message.send',
        status: AssistantGrantStatus.CONSUMED,
        maxUses: 1,
        useCount: 1,
        consumedAt: expect.any(Date),
      }),
    });
    expect(prisma.assistantBusinessAction.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        state: AssistantActionState.CLAIMED,
        targetId: CONVERSATION_ID,
        approvalId: 'grant-1',
      }),
    });
  });

  it('rejects a renderer phone that differs from the CRM conversation identity', async () => {
    const { service, prisma, user } = harness();
    await expect(service.authorizeWhatsappTextSend({
      ...request,
      targetPhone: '+1 415 555 0199',
    }, user)).rejects.toThrow('does not match');
    expect(prisma.assistantTemporaryGrant.create).not.toHaveBeenCalled();
  });

  it('requires an administrator and an explicit confirmation', async () => {
    const { service, user } = harness();
    await expect(service.authorizeWhatsappTextSend({ ...request, confirmed: false }, user))
      .rejects.toThrow('Explicit human confirmation');
    await expect(service.authorizeWhatsappTextSend(request, {
      ...user,
      companies: [{ id: COMPANY_ID, role: 'sales_user' }],
    })).rejects.toThrow('administrator confirmation');
  });

  it('records a claimed desktop send exactly once and never reopens it', async () => {
    const { service, user } = harness();
    const permit = await service.authorizeWhatsappTextSend(request, user);

    const completed: any = await service.completeWhatsappTextSend(
      permit.actionId,
      { outcome: 'SUCCEEDED', code: 'CLICK_DISPATCHED' },
      user,
    );
    expect(completed.state).toBe(AssistantActionState.SUCCEEDED);
    expect(completed.receipt).toEqual(expect.objectContaining({
      source: 'electron-whatsapp-preload',
      code: 'CLICK_DISPATCHED',
    }));

    const retry: any = await service.completeWhatsappTextSend(
      permit.actionId,
      { outcome: 'SUCCEEDED', code: 'CLICK_DISPATCHED' },
      user,
    );
    expect(retry.state).toBe(AssistantActionState.SUCCEEDED);
  });
});
