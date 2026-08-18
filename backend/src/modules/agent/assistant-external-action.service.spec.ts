import { ServiceUnavailableException } from '@nestjs/common';
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
  const service = new AssistantExternalActionService();
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
  it('fails closed before creating a desktop permit until execution uses ExternalActionOutbox', async () => {
    const { service, prisma, user } = harness();

    await expect(service.authorizeWhatsappTextSend(request, user))
      .rejects.toBeInstanceOf(ServiceUnavailableException);
    expect(prisma.assistantTemporaryGrant.create).not.toHaveBeenCalled();
    expect(prisma.assistantBusinessAction.create).not.toHaveBeenCalled();
    await expect(service.completeWhatsappTextSend(
      'legacy-action-1',
      { outcome: 'SUCCEEDED', code: 'CLICK_DISPATCHED' },
      user,
    )).rejects.toBeInstanceOf(ServiceUnavailableException);
    expect(prisma.assistantBusinessAction.updateMany).not.toHaveBeenCalled();
  });
});
