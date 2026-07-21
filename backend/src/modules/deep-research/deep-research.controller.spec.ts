import { NotFoundException } from '@nestjs/common';
import { AgentRunStatus } from '@prisma/client';
import { DeepResearchController } from './deep-research.controller';

const companyId = 'company-1';
const operator = { id: 'user-1', companies: [{ id: companyId, role: 'sales_user' }] };

describe('DeepResearchController tenant scope', () => {
  it('does not enqueue a lead outside the operator company/owner scope', async () => {
    const prisma: any = {
      lead: { findFirst: jest.fn().mockResolvedValue(null) },
      deepResearchReport: { findMany: jest.fn(), findFirst: jest.fn(), deleteMany: jest.fn() },
    };
    const runs: any = { enqueueForLead: jest.fn() };
    const controller = new DeepResearchController(prisma, runs);

    await expect(controller.deepResearch('other-lead', {
      type: 'full',
      requestId: '00000000-0000-4000-8000-000000000001',
    }, operator))
      .rejects.toBeInstanceOf(NotFoundException);
    expect(prisma.lead.findFirst).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({
        id: 'other-lead',
        OR: [{ companyId, ownerUserId: operator.id }],
      }),
    }));
    expect(runs.enqueueForLead).not.toHaveBeenCalled();
  });

  it('scopes report reads by both lead and company', async () => {
    const prisma: any = {
      lead: { findFirst: jest.fn().mockResolvedValue({ id: 'lead-1', companyId }) },
      deepResearchReport: { findMany: jest.fn().mockResolvedValue([]) },
    };
    const controller = new DeepResearchController(prisma, { enqueueForLead: jest.fn() } as any);

    await controller.listReports('lead-1', operator);

    expect(prisma.deepResearchReport.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({
        leadId: 'lead-1',
        companyId,
        OR: [
          { agentRunId: null },
          { agentRun: { is: { status: AgentRunStatus.COMPLETED } } },
        ],
      }),
    }));
  });

  it('does not expose an assistant report until its run completed', async () => {
    const prisma: any = {
      lead: { findFirst: jest.fn().mockResolvedValue({ id: 'lead-1', companyId }) },
      deepResearchReport: { findFirst: jest.fn().mockResolvedValue(null) },
    };
    const controller = new DeepResearchController(prisma, { enqueueForLead: jest.fn() } as any);

    await expect(controller.getReport('lead-1', 'report-running', operator))
      .rejects.toBeInstanceOf(NotFoundException);
    expect(prisma.deepResearchReport.findFirst).toHaveBeenCalledWith({
      where: expect.objectContaining({
        id: 'report-running',
        OR: expect.arrayContaining([
          { agentRun: { is: { status: AgentRunStatus.COMPLETED } } },
        ]),
      }),
    });
  });

  it.each([
    [AgentRunStatus.PENDING, true],
    [AgentRunStatus.RUNNING, false],
    [AgentRunStatus.COMPLETED, false],
    [AgentRunStatus.FAILED, false],
  ])('reports %s idempotency status without claiming every response was queued', async (status, queued) => {
    const prisma: any = {
      lead: { findFirst: jest.fn().mockResolvedValue({ id: 'lead-1', companyId }) },
      deepResearchReport: { findMany: jest.fn(), findFirst: jest.fn(), deleteMany: jest.fn() },
    };
    const runs: any = {
      enqueueForLead: jest.fn().mockResolvedValue({ id: 'run-1', status }),
    };
    const controller = new DeepResearchController(prisma, runs);

    const result = await controller.deepResearch('lead-1', {
      type: 'full', requestId: '00000000-0000-4000-8000-000000000001',
    }, operator);

    expect(result.queued).toBe(queued);
    expect(result.status).toBe(status);
    if (status === AgentRunStatus.FAILED) expect(result.message).toContain('failed');
  });
});
