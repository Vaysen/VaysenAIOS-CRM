import { ForbiddenException } from '@nestjs/common';
import { EmailsService } from '../modules/emails/emails.service';
import { EmailAccountsService } from '../modules/email-accounts/email-accounts.service';
import { EmailTemplatesService } from '../modules/email-templates/email-templates.service';
import { ImportsService } from '../modules/imports/imports.service';
import { LeadScoresService } from '../modules/lead-scores/lead-scores.service';
import { DuplicateLeadsService } from '../modules/duplicate-leads/duplicate-leads.service';
import { TimelineService } from '../modules/timeline/timeline.service';
import { QueuesService } from '../modules/queues/queues.service';

function matrixUser(
  activeId: string,
  roles: Record<string, string>,
) {
  return {
    id: 'operator',
    activeCompanyId: activeId,
    activeCompany: { id: activeId, name: activeId, role: roles[activeId] },
    companies: Object.entries(roles).map(([id, role]) => ({
      id,
      name: id,
      role,
    })),
  };
}

function instance<T>(type: new (...args: any[]) => T): T {
  return Object.create(type.prototype);
}

describe('two-tenant role matrix for hand-written authorization', () => {
  it('A admin / B viewer stays isolated while B is active', async () => {
    const operator = matrixUser('B', {
      A: 'company_admin',
      B: 'viewer',
    });

    expect((instance(EmailsService) as any).buildCompanyWhere(operator)).toEqual({
      companyId: 'B',
      senderUserId: 'operator',
    });
    expect((instance(EmailAccountsService) as any).buildCompanyWhere(operator, 'B', 'viewer'))
      .toEqual({
        companyId: 'B',
        OR: [{ userId: 'operator' }, { userId: null }],
      });
    expect((instance(EmailTemplatesService) as any).buildCompanyWhere(operator))
      .toEqual({ companyId: 'B', createdBy: 'operator' });
    expect((instance(TimelineService) as any).buildCompanyWhere(operator))
      .toEqual({
        companyId: 'B',
        deletedAt: null,
        userId: 'operator',
      });

    const importPrisma = {
      importTask: {
        findMany: jest.fn().mockResolvedValue([]),
        count: jest.fn().mockResolvedValue(0),
      },
    };
    const imports = instance(ImportsService) as any;
    imports.prisma = importPrisma;
    await imports.findAll(operator, {});
    expect(importPrisma.importTask.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { companyId: 'B', createdBy: 'operator' },
      }),
    );

    const duplicatePrisma = {
      duplicateLead: {
        findMany: jest.fn().mockResolvedValue([]),
        count: jest.fn().mockResolvedValue(0),
      },
    };
    const duplicates = instance(DuplicateLeadsService) as any;
    duplicates.prisma = duplicatePrisma;
    await duplicates.findAll(operator, {} as any);
    expect(duplicatePrisma.duplicateLead.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          companyId: 'B',
          primaryLead: { ownerUserId: 'operator' },
        },
      }),
    );
  });

  it('A sales / B admin cannot use the B role inside an active A request', async () => {
    const operator = matrixUser('A', {
      A: 'sales_user',
      B: 'company_admin',
    });
    const checks: Array<() => unknown | Promise<unknown>> = [
      () => (instance(EmailsService) as any).checkWriteAccess(operator, 'B'),
      () => (instance(EmailAccountsService) as any).assertActiveMembership(operator, 'B'),
      () => (instance(EmailTemplatesService) as any).checkWriteAccess(operator, 'B'),
      () => (instance(ImportsService) as any).checkWriteAccess(operator, 'B'),
      () => (instance(LeadScoresService) as any).checkWriteAccessForCompany(operator, 'B'),
      () => (instance(DuplicateLeadsService) as any).checkWriteAccess(operator, 'B'),
      () => (instance(TimelineService) as any).checkWriteAccess(operator, 'B'),
    ];

    for (const check of checks) {
      await expect(Promise.resolve().then(check))
        .rejects.toBeInstanceOf(ForbiddenException);
    }
  });

  it('queue monitoring is scoped to the active role, not an admin role elsewhere', async () => {
    const operator = matrixUser('A', {
      A: 'sales_user',
      B: 'company_admin',
    });
    const prisma: any = {
      emailMessage: {
        groupBy: jest.fn().mockResolvedValue([]),
        findMany: jest.fn().mockResolvedValue([]),
      },
      searchTask: { findMany: jest.fn().mockResolvedValue([]) },
      deepResearchReport: { findMany: jest.fn().mockResolvedValue([]) },
    };
    const queue = {
      name: 'test',
      getJobCounts: jest.fn().mockResolvedValue({}),
    };
    const queues = instance(QueuesService) as any;
    queues.prisma = prisma;
    queues.emailComposeQueue = queue;
    queues.emailValidateQueue = queue;
    queues.emailSendQueue = queue;
    queues.prospectSearchQueue = queue;
    queues.deepResearchQueue = queue;
    queues.maintenanceQueue = queue;

    await queues.getStatus(operator);

    expect(prisma.emailMessage.groupBy).toHaveBeenCalledWith({
      by: ['status'],
      where: {
        deletedAt: null,
        companyId: 'A',
        senderUserId: 'operator',
      },
      _count: true,
    });
    expect(prisma.searchTask.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          companyId: 'A',
          createdBy: 'operator',
        }),
      }),
    );
  });

  it('isolates viewer lead scores to leads owned in the active tenant', async () => {
    const operator = matrixUser('B', {
      A: 'company_admin',
      B: 'viewer',
    });
    const prisma: any = {
      leadScore: {
        findMany: jest.fn().mockResolvedValue([]),
        count: jest.fn().mockResolvedValue(0),
        groupBy: jest.fn().mockResolvedValue([]),
      },
      lead: { findMany: jest.fn().mockResolvedValue([]) },
    };
    const scores = instance(LeadScoresService) as any;
    scores.prisma = prisma;

    await scores.findAll(operator, {});

    expect(prisma.leadScore.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          companyId: 'B',
          lead: { ownerUserId: 'operator' },
        },
      }),
    );
  });
});
