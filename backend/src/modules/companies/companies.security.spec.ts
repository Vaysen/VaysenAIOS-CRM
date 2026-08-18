import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
} from '@nestjs/common';
import { CompaniesService } from './companies.service';

const companyAdmin = {
  id: 'admin-a',
  activeCompanyId: 'A',
  activeCompany: { id: 'A', role: 'company_admin' },
  companies: [{ id: 'A', role: 'company_admin' }],
};

function concurrentSuperMembershipRemovalStore() {
  let version = 0;
  let arrivals = 0;
  let release!: () => void;
  const ready = new Promise<void>((resolve) => {
    release = resolve;
  });
  const memberships = new Map([
    ['root-1', { id: 'relation-root-1', userId: 'root-1' }],
    ['root-2', { id: 'relation-root-2', userId: 'root-2' }],
  ]);
  const prisma: any = {};
  prisma.$transaction = jest.fn(async (callback: any) => {
    const startVersion = version;
    const snapshot = new Map(memberships);
    const tx: any = {
      userCompanyRelation: {
        findUnique: jest.fn(({ where }: any) => {
          const relation = snapshot.get(where.userId_companyId.userId);
          return Promise.resolve(relation ? {
            ...relation,
            companyId: 'A',
            isActive: true,
            role: { name: 'super_admin' },
          } : null);
        }),
        findFirst: jest.fn(({ where }: any) => {
          const relation = snapshot.get(where.userId);
          return Promise.resolve(relation ? { id: relation.id } : null);
        }),
        findMany: jest.fn(({ where }: any) => Promise.resolve(
          [...snapshot.values()]
            .filter((relation) => relation.id !== where.id.not)
            .slice(0, 1)
            .map((relation) => ({ userId: relation.userId })),
        )),
        delete: jest.fn(async ({ where }: any) => {
          for (const [userId, relation] of snapshot) {
            if (relation.id === where.id) snapshot.delete(userId);
          }
          arrivals += 1;
          if (arrivals === 2) release();
          await ready;
          return {};
        }),
      },
      auditLog: { create: jest.fn().mockResolvedValue({}) },
    };
    const result = await callback(tx);
    if (version !== startVersion) {
      throw Object.assign(new Error('serializable conflict'), { code: 'P2034' });
    }
    memberships.clear();
    for (const [userId, relation] of snapshot) {
      memberships.set(userId, relation);
    }
    version += 1;
    return result;
  });
  return { prisma, memberships };
}

describe('CompaniesService privilege boundaries', () => {
  it('does not let a tenant administrator create a new tenant', async () => {
    const prisma: any = { company: { create: jest.fn() } };
    const service = new CompaniesService(prisma);

    await expect(service.create({ name: 'New tenant' } as any, companyAdmin))
      .rejects.toBeInstanceOf(ForbiddenException);
    expect(prisma.company.create).not.toHaveBeenCalled();
  });

  it('does not let a tenant administrator grant super_admin membership', async () => {
    const prisma: any = {
      role: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'super-role',
          name: 'super_admin',
        }),
      },
      userCompanyRelation: { create: jest.fn() },
    };
    const service = new CompaniesService(prisma);

    await expect(service.addUser(
      'A',
      { userId: 'target', roleId: 'super-role' },
      companyAdmin,
    )).rejects.toBeInstanceOf(ForbiddenException);
    expect(prisma.userCompanyRelation.create).not.toHaveBeenCalled();
  });

  it('checks and removes the last administrator in one serializable transaction', async () => {
    const tx: any = {
      userCompanyRelation: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'relation-last',
          isActive: true,
          role: { name: 'company_admin' },
        }),
        count: jest.fn().mockResolvedValue(1),
        delete: jest.fn(),
      },
      auditLog: { create: jest.fn() },
    };
    const prisma: any = {
      $transaction: jest.fn((callback: any) => callback(tx)),
    };
    const service = new CompaniesService(prisma);

    await expect(service.removeUser('A', 'last-admin', companyAdmin))
      .rejects.toBeInstanceOf(BadRequestException);
    expect(prisma.$transaction).toHaveBeenCalledWith(
      expect.any(Function),
      { isolationLevel: 'Serializable' },
    );
    expect(tx.userCompanyRelation.delete).not.toHaveBeenCalled();
  });

  it('requires a super administrator to select the deletion target as active', async () => {
    const prisma: any = {
      company: {
        findUnique: jest.fn(),
        update: jest.fn(),
      },
    };
    const service = new CompaniesService(prisma);
    const superAdmin = {
      id: 'root',
      activeCompanyId: 'A',
      activeCompany: { id: 'A', role: 'super_admin' },
      companies: [
        { id: 'A', role: 'super_admin' },
        { id: 'B', role: 'company_admin' },
      ],
    };

    await expect(service.remove('B', superAdmin))
      .rejects.toBeInstanceOf(ForbiddenException);
    expect(prisma.company.findUnique).not.toHaveBeenCalled();
    expect(prisma.company.update).not.toHaveBeenCalled();
  });

  it('does not deactivate the company hosting the last global super administrator', async () => {
    const tx: any = {
      userCompanyRelation: {
        findFirst: jest.fn()
          .mockResolvedValueOnce({ id: 'super-a' })
          .mockResolvedValueOnce(null),
      },
      company: { update: jest.fn() },
      auditLog: { create: jest.fn() },
    };
    const prisma: any = {
      company: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'A',
          isActive: true,
        }),
      },
      $transaction: jest.fn((callback: any) => callback(tx)),
    };
    const service = new CompaniesService(prisma);
    const root = {
      id: 'root',
      activeCompanyId: 'A',
      activeCompany: { id: 'A', role: 'super_admin' },
      companies: [{ id: 'A', role: 'super_admin' }],
    };

    await expect(service.remove('A', root))
      .rejects.toBeInstanceOf(BadRequestException);
    expect(tx.company.update).not.toHaveBeenCalled();
    expect(prisma.$transaction.mock.calls[0][1]).toEqual({
      isolationLevel: 'Serializable',
    });
  });

  it('allows company deactivation when the same superadmin has another active membership', async () => {
    const tx: any = {
      userCompanyRelation: {
        findFirst: jest.fn()
          .mockResolvedValueOnce({ id: 'super-a', userId: 'root' })
          .mockResolvedValueOnce({ id: 'super-b', userId: 'root' }),
      },
      company: { update: jest.fn().mockResolvedValue({}) },
      auditLog: { create: jest.fn().mockResolvedValue({}) },
    };
    const prisma: any = {
      company: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'A',
          isActive: true,
        }),
      },
      $transaction: jest.fn((callback: any) => callback(tx)),
    };
    const service = new CompaniesService(prisma);
    const root = {
      id: 'root',
      activeCompanyId: 'A',
      activeCompany: { id: 'A', role: 'super_admin' },
      companies: [
        { id: 'A', role: 'super_admin' },
        { id: 'B', role: 'super_admin' },
      ],
    };

    await expect(service.remove('A', root)).resolves.toEqual({
      message: 'Company deleted successfully',
    });
    expect(tx.userCompanyRelation.findFirst).toHaveBeenNthCalledWith(2, {
      where: {
        companyId: { not: 'A' },
        isActive: true,
        role: { name: 'super_admin' },
        user: { isActive: true, deletedAt: null },
        company: { isActive: true },
      },
      select: { id: true },
    });
    expect(tx.company.update).toHaveBeenCalledWith({
      where: { id: 'A' },
      data: { isActive: false },
    });
  });

  it.each([
    ['only has a superadmin membership in another company', true],
    ['has a revoked membership in the target company', false],
  ])(
    'rejects an actor who %s inside membership removal transaction',
    async (_description, hasOtherCompanyMembership) => {
    const tx: any = {
      userCompanyRelation: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'target-super',
          isActive: true,
          role: { name: 'super_admin' },
        }),
        findFirst: jest.fn(({ where }: any) => Promise.resolve(
          hasOtherCompanyMembership && where.companyId === 'B'
            ? { id: 'stale-root-super-b' }
            : null,
        )),
        findMany: jest.fn(),
        delete: jest.fn(),
      },
    };
    const prisma: any = {
      $transaction: jest.fn((callback: any) => callback(tx)),
    };
    const service = new CompaniesService(prisma);
    const staleRoot = {
      id: 'stale-root',
      activeCompanyId: 'A',
      activeCompany: { id: 'A', role: 'super_admin' },
      companies: [{ id: 'A', role: 'super_admin' }],
    };

    await expect(service.removeUser('A', 'target-root', staleRoot))
      .rejects.toBeInstanceOf(ForbiddenException);
    expect(tx.userCompanyRelation.findFirst).toHaveBeenCalledWith({
      where: {
        userId: 'stale-root',
        companyId: 'A',
        isActive: true,
        role: { name: 'super_admin' },
        user: { isActive: true, deletedAt: null },
        company: { isActive: true },
      },
      select: { id: true },
    });
    expect(tx.userCompanyRelation.findMany).not.toHaveBeenCalled();
    expect(tx.userCompanyRelation.delete).not.toHaveBeenCalled();
    },
  );

  it('serializes two clients removing each other and preserves one distinct superadmin user', async () => {
    const { prisma, memberships } = concurrentSuperMembershipRemovalStore();
    const service = new CompaniesService(prisma);
    const root = (id: string) => ({
      id,
      activeCompanyId: 'A',
      activeCompany: { id: 'A', role: 'super_admin' },
      companies: [{ id: 'A', role: 'super_admin' }],
    });

    const results = await Promise.allSettled([
      service.removeUser('A', 'root-2', root('root-1')),
      service.removeUser('A', 'root-1', root('root-2')),
    ]);

    expect(results.filter((result) => result.status === 'fulfilled'))
      .toHaveLength(1);
    const rejected = results.find(
      (result) => result.status === 'rejected',
    ) as PromiseRejectedResult;
    expect(rejected.reason).toBeInstanceOf(ConflictException);
    expect(memberships.size).toBe(1);
  });
});
