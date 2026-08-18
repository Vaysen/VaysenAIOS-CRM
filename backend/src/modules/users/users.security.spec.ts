import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { UsersService } from './users.service';
import * as bcrypt from 'bcrypt';

const activeAdmin = {
  id: 'admin',
  activeCompanyId: 'A',
  activeCompany: { id: 'A', name: 'A', role: 'company_admin' },
  companies: [
    { id: 'A', name: 'A', role: 'company_admin' },
    { id: 'B', name: 'B', role: 'viewer' },
  ],
};

function concurrentAdminStore() {
  let version = 0;
  let mutationArrivals = 0;
  let releaseMutations!: () => void;
  const mutationsReady = new Promise<void>((resolve) => {
    releaseMutations = resolve;
  });
  const memberships = new Map([
    ['admin-1', { roleId: 'admin-role', roleName: 'company_admin', isActive: true }],
    ['admin-2', { roleId: 'admin-role', roleName: 'company_admin', isActive: true }],
  ]);

  const prisma: any = {
    user: {
      findUnique: jest.fn(({ where }: any) => Promise.resolve({
        id: where.id,
        deletedAt: null,
        companies: [{ company: { id: 'A' } }],
      })),
    },
  };
  prisma.$transaction = jest.fn(async (callback: any) => {
    const startVersion = version;
    const snapshot = new Map(
      [...memberships].map(([id, membership]) => [id, { ...membership }]),
    );
    const tx: any = {
      userCompanyRelation: {
        findUnique: jest.fn(({ where }: any) => {
          const userId = where.userId_companyId?.userId;
          const membership = snapshot.get(userId);
          return Promise.resolve(membership ? {
            id: `relation-${userId}`,
            roleId: membership.roleId,
            isActive: membership.isActive,
            role: { name: membership.roleName },
          } : null);
        }),
        count: jest.fn(() => Promise.resolve(
          [...snapshot.values()].filter(
            (membership) =>
              membership.isActive
              && membership.roleName === 'company_admin',
          ).length,
        )),
        update: jest.fn(async ({ where, data }: any) => {
          const userId = String(where.id).replace('relation-', '');
          const membership = snapshot.get(userId)!;
          if (data.roleId) {
            membership.roleId = data.roleId;
            membership.roleName = data.roleId === 'admin-role'
              ? 'company_admin'
              : 'sales_user';
          }
          if (data.isActive !== undefined) membership.isActive = data.isActive;
          mutationArrivals += 1;
          if (mutationArrivals === 2) releaseMutations();
          await mutationsReady;
          return {};
        }),
      },
      role: {
        findUnique: jest.fn(({ where }: any) => Promise.resolve({
          id: where.id,
          name: where.id === 'admin-role' ? 'company_admin' : 'sales_user',
        })),
      },
      auditLog: { create: jest.fn().mockResolvedValue({}) },
    };

    const result = await callback(tx);
    if (version !== startVersion) {
      throw Object.assign(new Error('serializable write conflict'), {
        code: 'P2034',
      });
    }
    memberships.clear();
    for (const [id, membership] of snapshot) {
      memberships.set(id, membership);
    }
    version += 1;
    return result;
  });

  return { prisma, memberships };
}

function concurrentGlobalDisableStore() {
  let version = 0;
  let arrivals = 0;
  let release!: () => void;
  const ready = new Promise<void>((resolve) => {
    release = resolve;
  });
  const activeUsers = new Map([
    ['admin-1', true],
    ['admin-2', true],
  ]);
  const prisma: any = {
    user: {
      findUnique: jest.fn(({ where }: any) => Promise.resolve({
        id: where.id,
        isActive: true,
        deletedAt: null,
        companies: [{ company: { id: 'A' } }],
      })),
    },
  };
  prisma.$transaction = jest.fn(async (callback: any) => {
    const startVersion = version;
    const snapshot = new Map(activeUsers);
    const tx: any = {
      userCompanyRelation: {
        findMany: jest.fn().mockResolvedValue([{ companyId: 'A' }]),
        findUnique: jest.fn().mockResolvedValue({
          isActive: true,
          role: { name: 'company_admin' },
        }),
        findFirst: jest.fn(({ where }: any) => Promise.resolve(
          where.userId === 'root-admin' && where.companyId === 'A'
            ? { id: 'actor-super-a' }
            : null,
        )),
        count: jest.fn(() => Promise.resolve(
          [...snapshot.values()].filter(Boolean).length,
        )),
      },
      user: {
        findFirst: jest.fn().mockResolvedValue({ id: 'root-admin' }),
        update: jest.fn(async ({ where, data }: any) => {
          snapshot.set(where.id, data.isActive);
          arrivals += 1;
          if (arrivals === 2) release();
          await ready;
          return {};
        }),
      },
      company: {
        findFirst: jest.fn().mockResolvedValue({ id: 'A' }),
      },
      auditLog: { create: jest.fn().mockResolvedValue({}) },
    };
    const result = await callback(tx);
    if (version !== startVersion) {
      throw Object.assign(new Error('serializable conflict'), { code: 'P2034' });
    }
    activeUsers.clear();
    for (const [id, active] of snapshot) activeUsers.set(id, active);
    version += 1;
    return result;
  });
  return { prisma, activeUsers };
}

const adminUser = (id: string) => ({
  id,
  activeCompanyId: 'A',
  activeCompany: { id: 'A', name: 'A', role: 'company_admin' },
  companies: [{ id: 'A', name: 'A', role: 'company_admin' }],
});
const globalSuperAdmin = {
  id: 'root-admin',
  activeCompanyId: 'A',
  activeCompany: { id: 'A', name: 'A', role: 'super_admin' },
  companies: [{ id: 'A', name: 'A', role: 'super_admin' }],
};

describe('UsersService tenant and privilege boundaries', () => {
  it('uses one tenant-scoped lookup and one not-found response for foreign UUIDs', async () => {
    const prisma: any = {
      user: { findUnique: jest.fn().mockResolvedValue(null) },
    };
    const service = new UsersService(prisma);

    await expect(service.findOne('foreign-user', activeAdmin))
      .rejects.toBeInstanceOf(NotFoundException);
    expect(prisma.user.findUnique).toHaveBeenCalledTimes(1);
    expect(prisma.user.findUnique.mock.calls[0][0].where).toEqual({
      id: 'foreign-user',
      deletedAt: null,
      companies: {
        some: {
          companyId: 'A',
          isActive: true,
          company: { isActive: true },
        },
      },
    });
  });

  it.each([
    ['status', (service: UsersService) =>
      service.updateStatus('target-user', false, globalSuperAdmin)],
    ['role', (service: UsersService) =>
      service.updateRole(
        'target-user',
        'viewer-role',
        'A',
        globalSuperAdmin,
      )],
    ['admin update', (service: UsersService) =>
      service.adminUpdate(
        'target-user',
        { isActive: false },
        globalSuperAdmin,
      )],
    ['remove', (service: UsersService) =>
      service.remove('target-user', globalSuperAdmin)],
  ])(
    'rejects stale global superadmin actor inside the serializable %s mutation',
    async (_name, run) => {
      const target = {
        id: 'target-user',
        email: 'target@example.test',
        firstName: 'Target',
        lastName: 'User',
        isActive: true,
        deletedAt: null,
        companies: [{
          id: 'target-relation',
          company: { id: 'A' },
          role: { id: 'admin-role', name: 'company_admin' },
        }],
      };
      const tx: any = {
        user: {
          findFirst: jest.fn().mockResolvedValue(null),
          update: jest.fn(),
        },
        company: {
          findFirst: jest.fn().mockResolvedValue({ id: 'A' }),
        },
        userCompanyRelation: {
          findUnique: jest.fn(),
          findMany: jest.fn(),
          findFirst: jest.fn().mockResolvedValue(null),
          update: jest.fn(),
        },
        role: { findUnique: jest.fn() },
        refreshToken: { updateMany: jest.fn() },
        auditLog: { create: jest.fn() },
      };
      const prisma: any = {
        user: { findUnique: jest.fn().mockResolvedValue(target) },
        $transaction: jest.fn((callback: any) => callback(tx)),
      };
      const service = new UsersService(prisma);

      await expect(run(service)).rejects.toBeInstanceOf(ForbiddenException);
      expect(tx.userCompanyRelation.findFirst).toHaveBeenCalledWith({
        where: {
          userId: 'root-admin',
          companyId: 'A',
          isActive: true,
          role: { name: 'super_admin' },
          user: { isActive: true, deletedAt: null },
          company: { isActive: true },
        },
        select: { id: true },
      });
      expect(tx.user.update).not.toHaveBeenCalled();
      expect(tx.userCompanyRelation.update).not.toHaveBeenCalled();
    },
  );

  it('does not accept a superadmin membership from another company for the active-company recheck', async () => {
    const target = {
      id: 'target-user',
      isActive: true,
      deletedAt: null,
      companies: [{ company: { id: 'A' } }],
    };
    const tx: any = {
      userCompanyRelation: {
        findFirst: jest.fn(({ where }: any) => Promise.resolve(
          where.userId === 'root-admin' && where.companyId === 'B'
            ? { id: 'super-b' }
            : null,
        )),
      },
      user: { update: jest.fn() },
      auditLog: { create: jest.fn() },
    };
    const prisma: any = {
      user: { findUnique: jest.fn().mockResolvedValue(target) },
      $transaction: jest.fn((callback: any) => callback(tx)),
    };
    const service = new UsersService(prisma);

    await expect(service.updateStatus(
      'target-user',
      true,
      globalSuperAdmin,
    )).rejects.toBeInstanceOf(ForbiddenException);
    expect(tx.userCompanyRelation.findFirst).toHaveBeenCalledTimes(1);
    expect(tx.user.update).not.toHaveBeenCalled();
  });

  it('denies ordinary users from modifying another global profile', async () => {
    const prisma = { user: { findUnique: jest.fn() } };
    const service = new UsersService(prisma as any);
    const viewer = {
      id: 'viewer',
      activeCompanyId: 'A',
      activeCompany: { id: 'A', name: 'A', role: 'viewer' },
      companies: [{ id: 'A', name: 'A', role: 'viewer' }],
    };

    await expect(service.update(
      'victim',
      { firstName: 'Changed' },
      viewer,
    )).rejects.toBeInstanceOf(ForbiddenException);
    expect(prisma.user.findUnique).not.toHaveBeenCalled();
  });

  it('does not reveal whether a global email exists to a non-admin caller', async () => {
    const prisma: any = {
      user: { findUnique: jest.fn() },
      role: { findUnique: jest.fn() },
    };
    const service = new UsersService(prisma);
    const viewer = {
      id: 'viewer',
      activeCompanyId: 'A',
      activeCompany: { id: 'A', role: 'viewer' },
      companies: [{ id: 'A', role: 'viewer' }],
    };

    await expect(service.create({
      email: 'existing@example.test',
      password: 'long-password-123',
      firstName: 'No',
      lastName: 'Access',
      companyId: 'A',
      roleId: 'viewer-role',
    }, viewer)).rejects.toBeInstanceOf(ForbiddenException);
    expect(prisma.user.findUnique).not.toHaveBeenCalled();
    expect(prisma.role.findUnique).not.toHaveBeenCalled();
  });

  it.each([
    ['status', (service: UsersService, user: any) =>
      service.updateStatus('target-user', false, user)],
    ['role', (service: UsersService, user: any) =>
      service.updateRole('target-user', 'viewer-role', 'A', user)],
    ['admin update', (service: UsersService, user: any) =>
      service.adminUpdate('target-user', { roleId: 'viewer-role' }, user)],
    ['remove', (service: UsersService, user: any) =>
      service.remove('target-user', user)],
  ])('rejects non-admin target %s lookup before Prisma access', async (_name, run) => {
    const prisma: any = { user: { findUnique: jest.fn() } };
    const service = new UsersService(prisma);
    const sales = {
      id: 'sales',
      activeCompanyId: 'A',
      activeCompany: { id: 'A', role: 'sales_user' },
      companies: [{ id: 'A', role: 'sales_user' }],
    };

    await expect(run(service, sales)).rejects.toBeInstanceOf(ForbiddenException);
    expect(prisma.user.findUnique).not.toHaveBeenCalled();
  });

  it.each([
    ['status', (service: UsersService) =>
      service.updateStatus('target-admin', false, globalSuperAdmin)],
    ['admin update', (service: UsersService) =>
      service.adminUpdate(
        'target-admin',
        { isActive: false },
        globalSuperAdmin,
      )],
    ['remove', (service: UsersService) =>
      service.remove('target-admin', globalSuperAdmin)],
  ])('keeps every tenant last-admin invariant for global %s', async (_name, run) => {
    const target = {
      id: 'target-admin',
      email: 'target@example.test',
      firstName: 'Target',
      lastName: 'Admin',
      isActive: true,
      deletedAt: null,
      companies: [
        {
          id: 'relation-a',
          company: { id: 'A' },
          role: { id: 'admin-role', name: 'company_admin' },
        },
        {
          id: 'relation-b',
          company: { id: 'B' },
          role: { id: 'admin-role', name: 'company_admin' },
        },
      ],
    };
    const tx: any = {
      user: {
        findFirst: jest.fn().mockResolvedValue({ id: 'root-admin' }),
        update: jest.fn(),
      },
      company: {
        findFirst: jest.fn().mockResolvedValue({ id: 'A' }),
      },
      refreshToken: { updateMany: jest.fn() },
      auditLog: { create: jest.fn() },
      userCompanyRelation: {
        findMany: jest.fn().mockResolvedValue([
          { companyId: 'A' },
          { companyId: 'B' },
        ]),
        findFirst: jest.fn(({ where }: any) => Promise.resolve(
          where.userId === 'root-admin' && where.companyId === 'A'
            ? { id: 'actor-super-a' }
            : null,
        )),
        findUnique: jest.fn(({ where }: any) => Promise.resolve({
          id: `relation-${where.userId_companyId.companyId}`,
          isActive: true,
          role: { name: 'company_admin' },
        })),
        count: jest.fn()
          .mockResolvedValueOnce(2)
          .mockResolvedValueOnce(1),
      },
    };
    const prisma: any = {
      user: { findUnique: jest.fn().mockResolvedValue(target) },
      $transaction: jest.fn((callback: any) => callback(tx)),
    };
    const service = new UsersService(prisma);

    await expect(run(service)).rejects.toBeInstanceOf(BadRequestException);
    expect(tx.user.update).not.toHaveBeenCalled();
    expect(prisma.$transaction.mock.calls[0][1]).toEqual({
      isolationLevel: 'Serializable',
    });
  });

  it('does not let the sole global super administrator self-demote', async () => {
    const tx: any = {
      user: {
        findFirst: jest.fn().mockResolvedValue({ id: 'root-admin' }),
      },
      company: {
        findFirst: jest.fn().mockResolvedValue({ id: 'A' }),
      },
      userCompanyRelation: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'super-relation',
          roleId: 'super-role',
          isActive: true,
          role: { name: 'super_admin' },
        }),
        findFirst: jest.fn(({ where }: any) => Promise.resolve(
          where.userId === 'root-admin' && where.companyId === 'A'
            ? { id: 'actor-super-a' }
            : null,
        )),
        update: jest.fn(),
      },
      role: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'admin-role',
          name: 'company_admin',
        }),
      },
      auditLog: { create: jest.fn() },
    };
    const prisma: any = {
      user: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'root-admin',
          deletedAt: null,
        }),
      },
      $transaction: jest.fn((callback: any) => callback(tx)),
    };
    const service = new UsersService(prisma);

    await expect(service.updateRole(
      'root-admin',
      'admin-role',
      'A',
      globalSuperAdmin,
    )).rejects.toBeInstanceOf(BadRequestException);
    expect(tx.userCompanyRelation.update).not.toHaveBeenCalled();
  });

  it.each([
    ['disable', (service: UsersService) =>
      service.updateStatus('target-root', false, globalSuperAdmin)],
    ['delete', (service: UsersService) =>
      service.remove('target-root', globalSuperAdmin)],
  ])(
    'does not count two memberships of the same sole superadmin user for global %s',
    async (_name, run) => {
      const target = {
        id: 'target-root',
        email: 'target-root@example.test',
        firstName: 'Target',
        lastName: 'Root',
        isActive: true,
        deletedAt: null,
        companies: [
          {
            id: 'super-a',
            company: { id: 'A' },
            role: { id: 'super-role', name: 'super_admin' },
          },
          {
            id: 'super-b',
            company: { id: 'B' },
            role: { id: 'super-role', name: 'super_admin' },
          },
        ],
      };
      const tx: any = {
        userCompanyRelation: {
          findMany: jest.fn().mockResolvedValue([]),
          findFirst: jest.fn(({ where }: any) => {
            if (where.userId === 'root-admin' && where.companyId === 'A') {
              return Promise.resolve({ id: 'actor-super-a' });
            }
            if (where.userId === 'target-root') {
              return Promise.resolve({ id: 'super-a' });
            }
            return Promise.resolve(null);
          }),
        },
        user: {
          findFirst: jest.fn().mockResolvedValue({ id: 'root-admin' }),
          update: jest.fn(),
        },
        company: {
          findFirst: jest.fn().mockResolvedValue({ id: 'A' }),
        },
        refreshToken: { updateMany: jest.fn() },
        auditLog: { create: jest.fn() },
      };
      const prisma: any = {
        user: { findUnique: jest.fn().mockResolvedValue(target) },
        $transaction: jest.fn((callback: any) => callback(tx)),
      };
      const service = new UsersService(prisma);

      await expect(run(service)).rejects.toBeInstanceOf(BadRequestException);
      expect(tx.userCompanyRelation.findFirst).toHaveBeenNthCalledWith(3, {
        where: {
          userId: { not: 'target-root' },
          isActive: true,
          role: { name: 'super_admin' },
          user: { isActive: true, deletedAt: null },
          company: { isActive: true },
        },
        select: { userId: true },
      });
      expect(tx.user.update).not.toHaveBeenCalled();
    },
  );

  it('allows one superadmin relation demotion when another active relation remains', async () => {
    const tx: any = {
      user: {
        findFirst: jest.fn().mockResolvedValue({ id: 'root-admin' }),
      },
      company: {
        findFirst: jest.fn().mockResolvedValue({ id: 'A' }),
      },
      userCompanyRelation: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'super-a',
          roleId: 'super-role',
          isActive: true,
          role: { name: 'super_admin' },
        }),
        findFirst: jest.fn(({ where }: any) => Promise.resolve(
          where.userId === 'root-admin' && where.companyId === 'A'
            ? { id: 'actor-super-a' }
            : { id: 'super-b', userId: 'root-admin' },
        )),
        update: jest.fn().mockResolvedValue({}),
      },
      role: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'admin-role',
          name: 'company_admin',
        }),
      },
      auditLog: { create: jest.fn().mockResolvedValue({}) },
    };
    const prisma: any = {
      user: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'root-admin',
          deletedAt: null,
        }),
      },
      $transaction: jest.fn((callback: any) => callback(tx)),
    };
    const service = new UsersService(prisma);
    jest.spyOn(service, 'findOne').mockResolvedValue({} as any);

    await expect(service.updateRole(
      'root-admin',
      'admin-role',
      'A',
      globalSuperAdmin,
    )).resolves.toEqual({});
    expect(tx.userCompanyRelation.findFirst).toHaveBeenCalledWith({
      where: {
        id: { not: 'super-a' },
        isActive: true,
        role: { name: 'super_admin' },
        user: { isActive: true, deletedAt: null },
        company: { isActive: true },
      },
      select: { id: true },
    });
    expect(tx.userCompanyRelation.update).toHaveBeenCalledWith({
      where: { id: 'super-a' },
      data: { roleId: 'admin-role' },
    });
  });

  it('maps a concurrent global disable conflict and preserves one company admin', async () => {
    const { prisma, activeUsers } = concurrentGlobalDisableStore();
    const service = new UsersService(prisma);
    jest.spyOn(service, 'findOne').mockResolvedValue({} as any);

    const results = await Promise.allSettled([
      service.updateStatus('admin-1', false, globalSuperAdmin),
      service.updateStatus('admin-2', false, globalSuperAdmin),
    ]);

    expect(results.filter((result) => result.status === 'fulfilled'))
      .toHaveLength(1);
    const rejected = results.find(
      (result) => result.status === 'rejected',
    ) as PromiseRejectedResult;
    expect(rejected.reason).toBeInstanceOf(ConflictException);
    expect([...activeUsers.values()].filter(Boolean)).toHaveLength(1);
  });

  it('prevents a company administrator from granting super_admin', async () => {
    const prisma: any = {
      user: {
        findUnique: jest.fn().mockResolvedValue({ id: 'target', deletedAt: null }),
      },
      userCompanyRelation: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'relation',
          roleId: 'viewer-role',
          role: { name: 'viewer' },
        }),
        update: jest.fn(),
      },
      role: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'super-role',
          name: 'super_admin',
        }),
      },
      auditLog: { create: jest.fn() },
    };
    prisma.$transaction = jest.fn((callback: any) => callback(prisma));
    const service = new UsersService(prisma);

    await expect(service.updateRole(
      'target',
      'super-role',
      'A',
      activeAdmin,
    )).rejects.toBeInstanceOf(ForbiddenException);
    expect(prisma.userCompanyRelation.update).not.toHaveBeenCalled();
  });

  it('prevents a company administrator from resetting a shared global account', async () => {
    const prisma: any = {
      user: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'shared-user',
          email: 'shared@example.test',
          deletedAt: null,
          companies: [
            {
              id: 'relation-a',
              company: { id: 'A' },
              role: { id: 'viewer-role', name: 'viewer' },
            },
            {
              id: 'relation-b',
              company: { id: 'B' },
              role: { id: 'admin-role', name: 'company_admin' },
            },
          ],
        }),
      },
    };
    const service = new UsersService(prisma);

    await expect(service.adminUpdate(
      'shared-user',
      { password: 'new-long-password' },
      activeAdmin,
    )).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('changes only the active tenant membership status for a shared user', async () => {
    const prisma: any = {
      user: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'shared-user',
          deletedAt: null,
          companies: [
            { company: { id: 'A' } },
            { company: { id: 'B' } },
          ],
        }),
        update: jest.fn(),
      },
      userCompanyRelation: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'relation-a',
          isActive: true,
          role: { name: 'sales_user' },
        }),
        update: jest.fn().mockResolvedValue({}),
      },
      auditLog: { create: jest.fn().mockResolvedValue({}) },
    };
    prisma.$transaction = jest.fn((callback: any) => callback(prisma));
    const service = new UsersService(prisma);

    const result = await service.updateStatus(
      'shared-user',
      false,
      activeAdmin,
    );

    expect(prisma.user.update).not.toHaveBeenCalled();
    expect(prisma.userCompanyRelation.update).toHaveBeenCalledWith({
      where: { id: 'relation-a' },
      data: { isActive: false },
    });
    expect(result).toEqual(expect.objectContaining({
      companyId: 'A',
      isActive: false,
    }));
  });

  it('prevents removal of the last active company administrator', async () => {
    const prisma: any = {
      user: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'last-admin',
          deletedAt: null,
          companies: [{ company: { id: 'A' } }],
        }),
      },
      userCompanyRelation: {
        findUnique: jest.fn()
          .mockResolvedValueOnce({
            id: 'relation-a',
            isActive: true,
            role: { name: 'company_admin' },
          })
          .mockResolvedValueOnce({
            id: 'relation-a',
            isActive: true,
            role: { name: 'company_admin' },
          }),
        count: jest.fn().mockResolvedValue(1),
        update: jest.fn(),
      },
      auditLog: { create: jest.fn() },
    };
    prisma.$transaction = jest.fn((callback: any) => callback(prisma));
    const service = new UsersService(prisma);

    await expect(service.remove('last-admin', activeAdmin))
      .rejects.toBeInstanceOf(BadRequestException);
    expect(prisma.userCompanyRelation.update).not.toHaveBeenCalled();
  });

  it('revokes every active refresh session after a password change', async () => {
    const tx: any = {
      user: { update: jest.fn().mockResolvedValue({}) },
      refreshToken: { updateMany: jest.fn().mockResolvedValue({ count: 2 }) },
    };
    const prisma: any = {
      user: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'shared-user',
          passwordHash: bcrypt.hashSync('old-password', 4),
          deletedAt: null,
        }),
      },
      $transaction: jest.fn((callback: any) => callback(tx)),
    };

    await new UsersService(prisma).changePassword('shared-user', {
      currentPassword: 'old-password',
      newPassword: 'new-password-long',
    });

    expect(tx.refreshToken.updateMany).toHaveBeenCalledWith({
      where: { userId: 'shared-user', revokedAt: null },
      data: { revokedAt: expect.any(Date) },
    });
  });

  it('lets a serializable conflict prevent concurrent demotions from removing every admin', async () => {
    const { prisma, memberships } = concurrentAdminStore();
    const service = new UsersService(prisma);
    jest.spyOn(service, 'findOne').mockResolvedValue({} as any);

    const results = await Promise.allSettled([
      service.updateRole('admin-2', 'sales-role', 'A', adminUser('admin-1')),
      service.updateRole('admin-1', 'sales-role', 'A', adminUser('admin-2')),
    ]);

    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    const rejected = results.find((result) => result.status === 'rejected') as PromiseRejectedResult;
    expect(rejected.reason).toBeInstanceOf(ConflictException);
    expect([...memberships.values()].filter(
      (membership) =>
        membership.isActive && membership.roleName === 'company_admin',
    )).toHaveLength(1);
    for (const call of prisma.$transaction.mock.calls) {
      expect(call[1]).toEqual({ isolationLevel: 'Serializable' });
    }
  });

  it('lets a serializable conflict prevent concurrent removals from removing every admin', async () => {
    const { prisma, memberships } = concurrentAdminStore();
    const service = new UsersService(prisma);

    const results = await Promise.allSettled([
      service.remove('admin-2', adminUser('admin-1')),
      service.remove('admin-1', adminUser('admin-2')),
    ]);

    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    const rejected = results.find((result) => result.status === 'rejected') as PromiseRejectedResult;
    expect(rejected.reason).toBeInstanceOf(ConflictException);
    expect([...memberships.values()].filter(
      (membership) =>
        membership.isActive && membership.roleName === 'company_admin',
    )).toHaveLength(1);
    for (const call of prisma.$transaction.mock.calls) {
      expect(call[1]).toEqual({ isolationLevel: 'Serializable' });
    }
  });
});
