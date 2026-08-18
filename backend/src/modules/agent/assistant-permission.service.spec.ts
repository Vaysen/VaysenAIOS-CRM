import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { AssistantPermissionService } from './assistant-permission.service';

const companyId = '11111111-1111-4111-8111-111111111111';
const admin = { id: 'admin-1', companies: [{ id: companyId, role: 'company_admin' }] };
const member = { id: 'member-1', companies: [{ id: companyId, role: 'sales_user' }] };

describe('AssistantPermissionService', () => {
  const prisma: any = {
    assistantPermissionProfile: {
      findUnique: jest.fn(),
      upsert: jest.fn(),
    },
    assistantTemporaryGrant: {
      create: jest.fn(),
      findMany: jest.fn(),
      findUnique: jest.fn(),
      update: jest.fn(),
      updateMany: jest.fn(),
    },
    assistantGrantConsumption: {
      findUnique: jest.fn(),
      create: jest.fn(),
    },
    userCompanyRelation: { findFirst: jest.fn() },
    $transaction: jest.fn(),
  };
  let service: AssistantPermissionService;

  beforeEach(() => {
    jest.clearAllMocks();
    prisma.assistantPermissionProfile.findUnique.mockResolvedValue(null);
    prisma.assistantTemporaryGrant.findMany.mockResolvedValue([]);
    prisma.assistantGrantConsumption.findUnique.mockResolvedValue(null);
    prisma.$transaction.mockImplementation((operation: any) => operation(prisma));
    service = new AssistantPermissionService(prisma);
  });

  it('uses advisory fail-closed defaults until an admin persists a profile', async () => {
    const profile = await service.getProfile(companyId, admin);
    expect(profile.preset).toBe('ADVISORY');
    expect(profile.persisted).toBe(false);
    expect(profile.capabilities.find((item) => item.id === 'crm.customer.read')?.decision).toBe('ALLOW');
    expect(profile.capabilities.find((item) => item.id === 'crm.customer.update')?.decision).toBe('DENY');
  });

  it('prevents a normal member from changing the company profile', async () => {
    await expect(service.updateProfile({ companyId, preset: 'SUPERVISOR' }, member))
      .rejects.toBeInstanceOf(ForbiddenException);
    expect(prisma.assistantPermissionProfile.upsert).not.toHaveBeenCalled();
  });

  it('normalizes permanent forbidden and critical overrides on update', async () => {
    prisma.assistantPermissionProfile.upsert.mockResolvedValue({});
    prisma.assistantPermissionProfile.findUnique.mockResolvedValue({
      preset: 'SUPERVISOR',
      overrides: {
        'infrastructure.shell': 'DENY',
        'crm.customer.delete': 'APPROVAL_REQUIRED',
      },
      thresholds: {
        highValueUsd: 10000,
        maxAutoDiscountPercent: 5,
        maxAutoPaymentTermDays: 30,
        maxDailyExternalSends: 50,
      },
      updatedAt: new Date(),
    });
    await service.updateProfile({
      companyId,
      preset: 'SUPERVISOR',
      overrides: {
        'infrastructure.shell': 'ALLOW',
        'crm.customer.delete': 'ALLOW',
      },
    }, admin);
    const data = prisma.assistantPermissionProfile.upsert.mock.calls[0][0].create;
    expect(data.overrides).toEqual({
      'infrastructure.shell': 'DENY',
      'crm.customer.delete': 'APPROVAL_REQUIRED',
    });
  });

  it('creates only scoped, short-lived grants for grantable external actions', async () => {
    prisma.userCompanyRelation.findFirst.mockResolvedValue({ id: 'relation-1' });
    prisma.assistantTemporaryGrant.create.mockImplementation(({ data }: any) => ({ id: 'grant-1', ...data }));
    const grant: any = await service.createTemporaryGrant({
      companyId,
      capability: 'crm.message.send',
      scope: { channel: 'whatsapp', customerId: 'lead-1' },
      ttlMinutes: 30,
      maxUses: 5,
    }, admin);
    expect(grant.capability).toBe('crm.message.send');
    expect(grant.scopeDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(grant.maxUses).toBe(5);

    await expect(service.createTemporaryGrant({
      companyId,
      capability: 'crm.customer.delete',
      scope: { customerId: 'lead-1' },
      ttlMinutes: 30,
    }, admin)).rejects.toBeInstanceOf(BadRequestException);
  });

  it('turns an approval into allow only when a matching live grant exists', async () => {
    prisma.assistantPermissionProfile.findUnique.mockResolvedValue({
      preset: 'SUPERVISOR',
      overrides: {},
      thresholds: {},
      updatedAt: new Date(),
    });
    prisma.assistantTemporaryGrant.findMany.mockResolvedValue([{ id: 'grant-1', useCount: 0, maxUses: 1 }]);
    const result = await service.evaluate(companyId, admin, 'crm.message.send', {
      channel: 'whatsapp',
      customerId: 'lead-1',
    });
    expect(result.decision).toBe('ALLOW');
    expect(result.reason).toBe('TEMPORARY_GRANT');
    expect(result.grantId).toBe('grant-1');
  });

  it('atomically consumes maxUses=1 and replays only the same canonical key', async () => {
    prisma.assistantPermissionProfile.findUnique.mockResolvedValue({
      preset: 'EXECUTOR',
      overrides: {},
      thresholds: {},
      updatedAt: new Date(),
    });
    let useCount = 0;
    let transactionChain = Promise.resolve();
    prisma.$transaction.mockImplementation((operation: any) => {
      const result = transactionChain.then(() => operation(prisma));
      transactionChain = result.then(() => undefined, () => undefined);
      return result;
    });
    const consumptions = new Map<string, any>();
    prisma.assistantTemporaryGrant.findMany.mockImplementation(async () => (
      useCount < 1
        ? [{ id: 'grant-1', useCount, maxUses: 1 }]
        : []
    ));
    prisma.assistantTemporaryGrant.updateMany.mockImplementation(async ({ where }: any) => {
      if (where.useCount !== useCount || useCount >= 1) return { count: 0 };
      useCount += 1;
      return { count: 1 };
    });
    prisma.assistantGrantConsumption.findUnique.mockImplementation(async ({ where }: any) => (
      consumptions.get(where.companyId_operatorUserId_idempotencyKey.idempotencyKey) || null
    ));
    prisma.assistantGrantConsumption.create.mockImplementation(async ({ data }: any) => {
      if (consumptions.has(data.idempotencyKey)) {
        const error: any = new Error('unique');
        error.code = 'P2002';
        throw error;
      }
      const row = { id: `consumption-${consumptions.size + 1}`, ...data };
      consumptions.set(data.idempotencyKey, row);
      return row;
    });

    const scope = { channel: 'whatsapp', customerId: 'lead-1' };
    const [first, sameKey] = await Promise.all([
      service.evaluate(companyId, admin, 'crm.message.send', scope, {
        consumeGrant: true,
        idempotencyKey: 'send:canonical-1',
      }),
      service.evaluate(companyId, admin, 'crm.message.send', scope, {
        consumeGrant: true,
        idempotencyKey: 'send:canonical-1',
      }),
    ]);
    expect(first.decision).toBe('ALLOW');
    expect(sameKey.decision).toBe('ALLOW');
    expect(first.grantId).toBe('grant-1');
    expect(sameKey.grantId).toBe('grant-1');
    expect(useCount).toBe(1);

    const differentKey = await service.evaluate(companyId, admin, 'crm.message.send', scope, {
      consumeGrant: true,
      idempotencyKey: 'send:canonical-2',
    });
    expect(differentKey.decision).toBe('APPROVAL_REQUIRED');
    expect(useCount).toBe(1);
  });

  it('reads the permission profile from the caller transaction snapshot', async () => {
    prisma.assistantPermissionProfile.findUnique.mockRejectedValue(
      new Error('root Prisma must not be used'),
    );
    const tx: any = {
      assistantPermissionProfile: {
        findUnique: jest.fn().mockResolvedValue({
          preset: 'SUPERVISOR',
          overrides: {},
          thresholds: { maxDailyExternalSends: 5 },
          updatedAt: new Date(),
        }),
      },
      assistantGrantConsumption: { findUnique: jest.fn().mockResolvedValue(null) },
      assistantTemporaryGrant: { findMany: jest.fn().mockResolvedValue([]) },
    };

    await expect(service.evaluate(companyId, admin, 'crm.email.send', {
      customerId: 'lead-1',
    }, { tx })).resolves.toMatchObject({
      decision: 'ALLOW',
      profile: { preset: 'SUPERVISOR' },
    });
    expect(tx.assistantPermissionProfile.findUnique).toHaveBeenCalled();
    expect(prisma.assistantPermissionProfile.findUnique).not.toHaveBeenCalled();
  });

  it('denies before grant consumption when the atomic daily Agent limit is reached', async () => {
    prisma.assistantPermissionProfile.findUnique.mockResolvedValue({
      preset: 'EXECUTOR',
      overrides: {},
      thresholds: { maxDailyExternalSends: 1 },
      updatedAt: new Date(),
    });
    prisma.assistantTemporaryGrant.findMany.mockResolvedValue([
      { id: 'grant-1', useCount: 0, maxUses: 1 },
    ]);

    await expect(service.evaluate(companyId, admin, 'crm.email.send', {
      customerId: 'lead-1',
    }, {
      consumeGrant: true,
      idempotencyKey: 'agent:daily-limit-1',
      dailyExternalSendCount: 1,
    })).resolves.toMatchObject({
      decision: 'DENY',
      reason: 'DAILY_EXTERNAL_SEND_LIMIT',
    });
    expect(prisma.assistantTemporaryGrant.updateMany).not.toHaveBeenCalled();
    expect(prisma.assistantGrantConsumption.create).not.toHaveBeenCalled();
  });
});
