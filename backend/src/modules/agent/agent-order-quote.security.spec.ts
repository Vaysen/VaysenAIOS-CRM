import { AgentService } from './agent.service';

const actor: any = {
  id: 'user-a',
  activeCompanyId: 'tenant-a',
  activeCompany: { id: 'tenant-a', role: 'sales_user' },
  companies: [{ id: 'tenant-a', role: 'sales_user' }],
};

function makeService() {
  const service: any = Object.create(AgentService.prototype);
  service.resolveOpenClawCustomer = jest.fn().mockResolvedValue({
    lead: { id: 'lead-a', ownerUserId: 'user-a' },
  });
  service.prisma = {
    quote: { findFirst: jest.fn() },
    order: {
      create: jest.fn(({ data }: any) =>
        Promise.resolve({ id: 'order-a', orderNo: data.orderNo, ...data })),
    },
  };
  service.assistantPermissions = {
    getProfile: jest.fn().mockResolvedValue({
      thresholds: { highValueUsd: 10_000 },
    }),
  };
  service.runOpenClawBusinessAction = jest.fn(
    async ({ execute }: { execute: () => Promise<unknown> }) => execute(),
  );
  return service;
}

describe('AgentService quote-backed order boundary', () => {
  it('fails closed on a quote reference even with amount and currency overrides', async () => {
    const service = makeService();

    await expect(service.createOrderDraftForOpenClaw(
      'tenant-a',
      'conversation-a',
      {
        quoteReferenceNo: 'QT-1',
        totalAmount: 0.01,
        currency: 'EUR',
      },
      'request-1',
      actor,
    )).resolves.toEqual({
      status: 'BLOCKED',
      reason:
        'Quote-backed orders require the controlled quote conversion endpoint',
    });
    expect(service.prisma.quote.findFirst).not.toHaveBeenCalled();
    expect(service.prisma.order.create).not.toHaveBeenCalled();
    expect(service.runOpenClawBusinessAction).not.toHaveBeenCalled();
  });

  it('does not create a quote-linked order on repeated quote requests', async () => {
    const service = makeService();

    const attempts = await Promise.allSettled([
      service.createOrderDraftForOpenClaw(
        'tenant-a',
        'conversation-a',
        { quoteReferenceNo: 'QT-1' },
        'request-1',
        actor,
      ),
      service.createOrderDraftForOpenClaw(
        'tenant-a',
        'conversation-a',
        { quoteReferenceNo: 'QT-1' },
        'request-2',
        actor,
      ),
    ]);

    expect(attempts.every(
      (result) =>
        result.status === 'fulfilled'
        && result.value.status === 'BLOCKED',
    )).toBe(true);
    expect(service.prisma.order.create).not.toHaveBeenCalled();
  });

  it('blocks an explicitly supplied empty quote reference before authorization or writes', async () => {
    const service = makeService();

    await expect(service.createOrderDraftForOpenClaw(
      'tenant-a',
      'conversation-a',
      { quoteReferenceNo: '' },
      'request-empty',
      actor,
    )).resolves.toEqual(expect.objectContaining({ status: 'BLOCKED' }));
    expect(service.assistantPermissions.getProfile).not.toHaveBeenCalled();
    expect(service.runOpenClawBusinessAction).not.toHaveBeenCalled();
    expect(service.prisma.order.create).not.toHaveBeenCalled();
  });

  it('still creates a normal quote-free order draft', async () => {
    const service = makeService();

    await expect(service.createOrderDraftForOpenClaw(
      'tenant-a',
      'conversation-a',
      { totalAmount: 25, currency: 'USD' },
      'request-1',
      actor,
    )).resolves.toEqual(expect.objectContaining({
      status: 'SUCCEEDED',
      totalAmount: '25',
    }));
    expect(service.prisma.order.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        companyId: 'tenant-a',
        leadId: 'lead-a',
        quoteId: null,
        assignedUserId: 'user-a',
        currency: 'USD',
        totalAmount: 25,
      }),
    });
  });
});
