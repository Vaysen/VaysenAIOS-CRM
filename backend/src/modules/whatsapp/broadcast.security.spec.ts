import {
  BadRequestException,
  ForbiddenException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { BroadcastController } from './broadcast.controller';

const tenantAUser = (role = 'sales_user', id = 'user-a') => ({
  id,
  activeCompanyId: 'tenant-a',
  activeCompany: { id: 'tenant-a', role },
  companies: [{ id: 'tenant-a', role }],
});

type MembershipFixture = {
  userId: string;
  companyId: string;
  role: string;
  isActive: boolean;
  userActive: boolean;
  userDeletedAt: Date | null;
  companyActive: boolean;
};

const membershipFixture = (
  user: any,
  overrides: Partial<MembershipFixture> = {},
): MembershipFixture => ({
  userId: user.id,
  companyId: user.activeCompanyId,
  role: user.activeCompany?.role || '',
  isActive: true,
  userActive: true,
  userDeletedAt: null,
  companyActive: true,
  ...overrides,
});

const withMembership = (
  prisma: any,
  user: any,
  overrides: Partial<MembershipFixture> = {},
) => {
  const fixture = membershipFixture(user, overrides);
  return {
    ...prisma,
    userCompanyRelation: {
      ...(prisma.userCompanyRelation || {}),
      findFirst: jest.fn(async ({ where }: any = {}) => {
        if (
          !where
          || where.userId !== fixture.userId
          || where.companyId !== fixture.companyId
          || (where.isActive === true && !fixture.isActive)
          || (where.user?.is?.isActive === true && !fixture.userActive)
          || (where.user?.is?.deletedAt === null && fixture.userDeletedAt !== null)
          || (where.company?.is?.isActive === true && !fixture.companyActive)
        ) {
          return null;
        }
        return {
          id: `${fixture.companyId}:${fixture.userId}`,
          role: { name: fixture.role },
        };
      }),
    },
  };
};

describe('BroadcastController tenant and role isolation', () => {
  it('rejects a body-supplied foreign tenant when creating a task', async () => {
    const prisma: any = {
      whatsAppBroadcastTask: { create: jest.fn() },
    };
    const user = tenantAUser('company_admin');
    const controller = new BroadcastController(withMembership(prisma, user));

    await expect(controller.createTask({
      companyId: 'tenant-b',
      accountId: 'default',
      template: 'hello',
      recipients: [{ phone: '15550000001' }],
    }, user)).rejects.toBeInstanceOf(BadRequestException);
    expect(prisma.whatsAppBroadcastTask.create).not.toHaveBeenCalled();
  });

  it.each([
    ['viewer', ForbiddenException],
    ['sales_user', ForbiddenException],
    ['company_admin', ServiceUnavailableException],
  ])(
    'enforces the %s role before broadcast creation reaches the disabled outbox',
    async (role: string, expectedException) => {
      const prisma: any = {
        whatsAppBroadcastTask: { create: jest.fn() },
      };
      const user = tenantAUser(role as string);
      const controller = new BroadcastController(withMembership(prisma, user));

      await expect(controller.createTask({
        accountId: 'default',
        template: 'hello',
        recipients: [{ phone: '15550000001' }],
      }, user)).rejects.toBeInstanceOf(expectedException);
      expect(prisma.whatsAppBroadcastTask.create).not.toHaveBeenCalled();
    },
  );

  it.each([
    ['cross-tenant membership', { companyId: 'tenant-b' }],
    ['inactive company', { companyActive: false }],
    ['inactive membership', { isActive: false }],
  ])(
    'rejects an actor with %s before reading broadcast tasks',
    async (_label: string, overrides: Partial<MembershipFixture>) => {
      const prisma: any = {
        whatsAppBroadcastTask: {
          findMany: jest.fn(),
          count: jest.fn(),
        },
      };
      const user = tenantAUser('company_admin');
      const controller = new BroadcastController(withMembership(prisma, user, overrides));

      await expect(controller.getTasks(user)).rejects.toBeInstanceOf(ForbiddenException);
      expect(prisma.whatsAppBroadcastTask.findMany).not.toHaveBeenCalled();
      expect(prisma.whatsAppBroadcastTask.count).not.toHaveBeenCalled();
    },
  );

  it('always lists tasks with an explicit active-company predicate', async () => {
    const prisma: any = {
      whatsAppBroadcastTask: {
        findMany: jest.fn().mockResolvedValue([]),
        count: jest.fn().mockResolvedValue(0),
      },
    };
    const user = tenantAUser('company_admin');
    const controller = new BroadcastController(withMembership(prisma, user));
    jest.spyOn(controller as any, 'isOutboxBroadcastAvailable').mockReturnValue(true);

    await controller.getTasks(user);

    expect(prisma.whatsAppBroadcastTask.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { companyId: 'tenant-a' } }),
    );
    expect(prisma.whatsAppBroadcastTask.count).toHaveBeenCalledWith({
      where: { companyId: 'tenant-a' },
    });
  });

  it.each([
    ['detail', (controller: BroadcastController) =>
      controller.getTaskDetail(
        'tenant-b-task',
        tenantAUser('company_admin', 'admin-a'),
      )],
    ['cancel', (controller: BroadcastController) =>
      controller.cancelTask(
        'tenant-b-task',
        tenantAUser('company_admin', 'admin-a'),
      )],
  ])('fails closed for a foreign task id during %s', async (_name, invoke) => {
    const prisma: any = {
      whatsAppBroadcastTask: {
        findFirst: jest.fn().mockResolvedValue(null),
        updateMany: jest.fn(),
      },
    };
    const user = tenantAUser('company_admin', 'admin-a');
    const controller = new BroadcastController(withMembership(prisma, user));
    jest.spyOn(controller as any, 'isOutboxBroadcastAvailable').mockReturnValue(true);

    await expect(invoke(controller)).resolves.toEqual(
      expect.objectContaining({ success: false }),
    );
    expect(prisma.whatsAppBroadcastTask.findFirst).toHaveBeenCalledWith({
      where: { id: 'tenant-b-task', companyId: 'tenant-a' },
    });
    expect(prisma.whatsAppBroadcastTask.updateMany).not.toHaveBeenCalled();
  });

  it.each(['viewer', 'sales_user'])(
    'does not let %s cancel a broadcast',
    async (role) => {
      const prisma: any = {
        whatsAppBroadcastTask: {
          findFirst: jest.fn(),
          updateMany: jest.fn(),
        },
      };
      const user = tenantAUser(role);
      const controller = new BroadcastController(withMembership(prisma, user));

      await expect(controller.cancelTask(
        'task-a',
        user,
      )).rejects.toBeInstanceOf(ForbiddenException);
      expect(prisma.whatsAppBroadcastTask.findFirst).not.toHaveBeenCalled();
      expect(prisma.whatsAppBroadcastTask.updateMany).not.toHaveBeenCalled();
    },
  );

  it('does not let a sales manager cancel another creator task', async () => {
      const prisma: any = {
        whatsAppBroadcastTask: {
        findFirst: jest.fn().mockResolvedValue({
          id: 'task-a',
          companyId: 'tenant-a',
          createdBy: 'different-manager',
          status: 'pending',
        }),
        updateMany: jest.fn(),
        },
      };
    const user = tenantAUser('sales_manager', 'manager-a');
    const controller = new BroadcastController(withMembership(prisma, user));

    await expect(controller.cancelTask(
      'task-a',
      user,
    )).rejects.toBeInstanceOf(ForbiddenException);
    expect(prisma.whatsAppBroadcastTask.updateMany).not.toHaveBeenCalled();
  });

  it('rejects forged client progress without querying or updating a task', async () => {
      const prisma: any = {
        whatsAppBroadcastTask: {
        findFirst: jest.fn(),
        updateMany: jest.fn(),
        },
      };
    const user = tenantAUser('company_admin');
    const controller = new BroadcastController(withMembership(prisma, user));

    await expect(controller.updateProgress(
      'tenant-b-task',
      { sentCount: 50, failedCount: 0, status: 'completed' },
      user,
    )).rejects.toBeInstanceOf(ServiceUnavailableException);
    expect(prisma.whatsAppBroadcastTask.findFirst).not.toHaveBeenCalled();
    expect(prisma.whatsAppBroadcastTask.updateMany).not.toHaveBeenCalled();
  });
});
