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
    },
    userCompanyRelation: { findFirst: jest.fn() },
  };
  let service: AssistantPermissionService;

  beforeEach(() => {
    jest.clearAllMocks();
    prisma.assistantPermissionProfile.findUnique.mockResolvedValue(null);
    prisma.assistantTemporaryGrant.findMany.mockResolvedValue([]);
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
});
