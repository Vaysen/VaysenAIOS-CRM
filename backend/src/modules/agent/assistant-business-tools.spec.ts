import { AgentService, type AuthenticatedUser } from './agent.service';

const COMPANY_ID = '11111111-1111-4111-8111-111111111111';
const CONVERSATION_ID = '22222222-2222-4222-8222-222222222222';
const LEAD_ID = '33333333-3333-4333-8333-333333333333';

function createHarness(decision: 'ALLOW' | 'APPROVAL_REQUIRED' | 'DENY' = 'ALLOW') {
  const lead = {
    id: LEAD_ID,
    companyId: COMPANY_ID,
    companyName: 'Verified Buyer Ltd',
    leadName: null,
    contactName: 'Buyer',
    contactEmail: 'buyer@example.com',
    whatsapp: '+14155550100',
    country: 'US',
    productCategory: 'Packaging',
    status: 'contacted',
    leadGrade: 'B',
    ownerUserId: 'owner-user',
    nextFollowUpAt: null,
    updatedAt: new Date('2026-07-17T00:00:00.000Z'),
    deletedAt: null,
    isMerged: false,
  };
  const prisma: any = {
    conversation: {
      findFirst: jest.fn().mockResolvedValue({
        id: CONVERSATION_ID,
        companyId: COMPANY_ID,
        channel: 'whatsapp',
        status: 'active',
        isGroup: false,
        assignedUserId: 'owner-user',
        lead,
      }),
    },
    assistantBusinessAction: {
      findUnique: jest.fn().mockResolvedValue(null),
      create: jest.fn().mockResolvedValue({ id: 'action-1' }),
      update: jest.fn().mockResolvedValue({ id: 'action-1' }),
    },
    leadActivity: {
      create: jest.fn().mockResolvedValue({ id: 'activity-1' }),
    },
    lead: {
      findFirst: jest.fn().mockResolvedValue({
        ...lead,
        conversations: [{
          id: CONVERSATION_ID,
          assignedUserId: 'owner-user',
          updatedAt: new Date('2026-07-17T00:00:00.000Z'),
        }],
      }),
      update: jest.fn().mockImplementation(async ({ data }: any) => ({
        ...lead,
        ...data,
        updatedAt: new Date('2026-07-18T02:00:00.000Z'),
      })),
    },
    quote: {
      create: jest.fn().mockImplementation(async ({ data }: any) => ({
        id: 'quote-1',
        ...data,
        subtotal: { toString: () => String(data.subtotal) },
        totalAmount: { toString: () => String(data.totalAmount) },
      })),
    },
    $transaction: jest.fn(async (input: any) => (
      typeof input === 'function' ? input(prisma) : Promise.all(input)
    )),
  };
  const permissions: any = {
    evaluate: jest.fn().mockResolvedValue({
      decision,
      reason: decision === 'ALLOW' ? 'PRESET_ALLOW' : 'POLICY_REQUIRES_APPROVAL',
      profile: {
        preset: 'SUPERVISOR',
        thresholds: { highValueUsd: 10_000, maxAutoDiscountPercent: 5 },
      },
      grantId: null,
    }),
    getProfile: jest.fn().mockResolvedValue({
      thresholds: { highValueUsd: 10_000, maxAutoDiscountPercent: 5 },
    }),
  };
  const service = new AgentService(
    prisma,
    {} as any,
    {} as any,
    undefined,
    undefined,
    permissions,
  );
  const user: AuthenticatedUser = {
    id: 'owner-user',
    companies: [{ id: COMPANY_ID, role: 'company_admin' }],
  };
  return { service, prisma, permissions, user };
}

describe('AgentService OpenClaw business tools', () => {
  it('writes a real customer note and records a terminal audited business action', async () => {
    const { service, prisma, user } = createHarness();
    const result = await service.addCustomerNoteForOpenClaw(
      COMPANY_ID,
      LEAD_ID,
      'Confirmed MOQ and requested artwork.',
      'request-note-1',
      user,
    );

    expect(result).toEqual(expect.objectContaining({
      status: 'SUCCEEDED',
      activityId: 'activity-1',
      customerName: 'Verified Buyer Ltd',
    }));
    expect(prisma.leadActivity.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        companyId: COMPANY_ID,
        leadId: LEAD_ID,
        userId: 'owner-user',
        description: 'Confirmed MOQ and requested artwork.',
      }),
    }));
    expect(prisma.assistantBusinessAction.update).toHaveBeenLastCalledWith(expect.objectContaining({
      data: expect.objectContaining({ state: 'SUCCEEDED', completedAt: expect.any(Date) }),
    }));
  });

  it('does not mutate CRM data when policy requires approval', async () => {
    const { service, prisma, user } = createHarness('APPROVAL_REQUIRED');
    await expect(service.addCustomerNoteForOpenClaw(
      COMPANY_ID,
      LEAD_ID,
      'Do not write this yet.',
      'request-note-approval',
      user,
    )).resolves.toEqual({
      status: 'APPROVAL_REQUIRED',
      reason: 'POLICY_REQUIRES_APPROVAL',
    });
    expect(prisma.leadActivity.create).not.toHaveBeenCalled();
  });

  it('updates allowlisted customer profile fields and records an audit activity', async () => {
    const { service, prisma, permissions, user } = createHarness();
    const result = await service.updateCustomerForOpenClaw(
      COMPANY_ID,
      LEAD_ID,
      {
        companyName: 'Verified Buyer Group',
        country: 'CA',
        language: 'en-CA',
      },
      'request-customer-update-1',
      user,
    );

    expect(result).toEqual(expect.objectContaining({
      status: 'SUCCEEDED',
      customerName: 'Verified Buyer Group',
      updatedFields: ['companyName', 'country', 'language'],
    }));
    expect(permissions.evaluate).toHaveBeenCalledWith(
      COMPANY_ID,
      user,
      'crm.customer.update',
      { customerId: LEAD_ID },
    );
    expect(prisma.lead.update).toHaveBeenCalledWith({
      where: { id: LEAD_ID },
      data: {
        companyName: 'Verified Buyer Group',
        companyNameSource: 'manual_confirmed',
        companyNameConfidence: 'high',
        country: 'CA',
        language: 'en-CA',
      },
    });
    expect(prisma.leadActivity.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        companyId: COMPANY_ID,
        leadId: LEAD_ID,
        activityType: 'assistant_customer_update',
        metadata: {
          fields: ['companyName', 'country', 'language'],
          source: 'openclaw',
        },
      }),
    }));
    expect(JSON.stringify(prisma.lead.update.mock.calls[0][0].data)).not.toMatch(
      /contactEmail|contactPhone|whatsapp/,
    );
  });

  it('creates a USD quote from the versioned catalog price instead of accepting a model price', async () => {
    const { service, prisma, user } = createHarness();
    const result = await service.createQuoteDraftForOpenClaw(
      COMPANY_ID,
      LEAD_ID,
      {
        lineItems: [{ catalogItemId: 'JYM-0001', quantity: 1000 }],
        currency: 'USD',
      },
      'request-quote-1',
      user,
    );

    expect(result).toEqual(expect.objectContaining({
      status: 'SUCCEEDED',
      currency: 'USD',
      subtotal: '10',
      totalAmount: '10',
      priceVersion: 'jym-usd-2026-05-31-v1',
    }));
    const quoteData = prisma.quote.create.mock.calls[0][0].data;
    expect(quoteData.currency).toBe('USD');
    expect(quoteData.lineItems.create[0]).toEqual(expect.objectContaining({
      catalogItemId: 'JYM-0001',
      quantity: 1000,
      unitPrice: 0.01,
      totalPrice: 10,
      priceVersion: 'jym-usd-2026-05-31-v1',
    }));
    expect(JSON.stringify(quoteData)).not.toContain('unitPriceOverride');
  });

  it('creates a PI draft through the same audited USD catalog tool', async () => {
    const { service, prisma, user } = createHarness();
    const result = await service.createQuoteDraftForOpenClaw(
      COMPANY_ID,
      LEAD_ID,
      {
        documentType: 'pi',
        lineItems: [{ catalogItemId: 'JYM-0001', quantity: 500 }],
        currency: 'USD',
      },
      'request-pi-1',
      user,
    );

    expect(result).toEqual(expect.objectContaining({
      status: 'SUCCEEDED',
      documentType: 'pi',
      referenceNo: expect.stringMatching(/^PI-/),
    }));
    expect(prisma.quote.create.mock.calls[0][0].data).toEqual(expect.objectContaining({
      type: 'pi',
      referenceNo: expect.stringMatching(/^PI-/),
    }));
  });
});
