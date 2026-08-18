import { AgentRunKind, AgentRunStatus } from '@prisma/client';
import { Logger } from '@nestjs/common';
import { DeepResearchProcessor } from './deep-research.processor';

const jobData = {
  companyId: 'company-1',
  agentRunId: 'run-1',
  leadId: 'lead-1',
  userId: 'user-1',
  type: 'full' as const,
};

function createPrismaMock() {
  const prisma: any = {
    agentRun: { findFirst: jest.fn(), findUnique: jest.fn(), updateMany: jest.fn(), update: jest.fn() },
    agentTask: { updateMany: jest.fn() },
    agentAuditLog: { create: jest.fn() },
    userCompanyRelation: { findFirst: jest.fn() },
    lead: { findFirst: jest.fn() },
    deepResearchReport: { findUnique: jest.fn(), deleteMany: jest.fn().mockResolvedValue({ count: 0 }) },
  };
  prisma.$transaction = jest.fn(async (input: any) => {
    if (typeof input === 'function') return input(prisma);
    return Promise.all(input);
  });
  return prisma;
}

function createProcessor() {
  const prisma = createPrismaMock();
  const background: any = { research: jest.fn() };
  const contacts: any = { discover: jest.fn() };
  const market: any = { analyze: jest.fn() };
  const processor = new DeepResearchProcessor(prisma, background, contacts, market);
  return { processor, prisma, background, contacts, market };
}

function validRun(status: AgentRunStatus = AgentRunStatus.PENDING) {
  return {
    id: 'run-1', companyId: 'company-1', operatorUserId: 'user-1',
    kind: AgentRunKind.BACKGROUND_RESEARCH, status, result: null, errorCode: null,
    executionClaimId: null, executionLeaseExpiresAt: null,
    tasks: [{ id: 'task-1', companyId: 'company-1', toolName: 'research.background_check' }],
  };
}

describe('DeepResearchProcessor', () => {
  it('revalidates company, operator, lead and run before completing the tracked task', async () => {
    const { processor, prisma, background } = createProcessor();
    const loggerLog = jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    const loggerError = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    prisma.agentRun.findFirst.mockResolvedValue(validRun());
    prisma.userCompanyRelation.findFirst.mockResolvedValue({ role: { name: 'sales_user' } });
    prisma.lead.findFirst.mockResolvedValue({
      id: 'lead-1', companyId: 'company-1', companyName: 'Buyer Ltd', ownerUserId: 'user-1', contacts: [],
      companyNameSource: 'manual_confirmed', companyNameConfidence: 'high',
    });
    prisma.deepResearchReport.findUnique.mockResolvedValue(null);
    prisma.agentRun.updateMany.mockResolvedValue({ count: 1 });
    prisma.agentRun.findUnique.mockResolvedValue({
      status: AgentRunStatus.RUNNING,
      executionClaimId: 'job-1:attempt-1',
    });
    prisma.agentTask.updateMany.mockResolvedValue({ count: 1 });
    prisma.agentAuditLog.create.mockResolvedValue({});
    background.research.mockResolvedValue({
      reportId: 'report-1', title: 'Buyer Ltd report', html: '<p>ok</p>', json: { status: 'ok' },
    });

    const result: any = await processor.process({ data: jobData, id: 'agent-run-run-1', attemptsMade: 0 } as any);

    expect(result.success).toBe(true);
    expect(prisma.lead.findFirst).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ id: 'lead-1', companyId: 'company-1', ownerUserId: 'user-1' }),
    }));
    expect(background.research).toHaveBeenCalledWith(expect.objectContaining({ id: 'lead-1' }), 'user-1', {
      agentRunId: 'run-1',
    });
    expect(prisma.agentRun.updateMany).toHaveBeenLastCalledWith(expect.objectContaining({
      data: expect.objectContaining({ status: AgentRunStatus.COMPLETED }),
    }));
    const output = JSON.stringify([
      ...loggerLog.mock.calls,
      ...loggerError.mock.calls,
    ]);
    expect(output).toContain('deep_research.execution_started');
    expect(output).not.toContain('Buyer Ltd');
    expect(output).not.toContain('company-1');
    expect(output).not.toContain('user-1');
    expect(output).not.toContain('run-1');
    expect(output).not.toContain('lead-1');
  });

  it('uses the report bound to agentRunId on retry and does not repeat research', async () => {
    const { processor, prisma, background } = createProcessor();
    prisma.agentRun.findFirst.mockResolvedValue({
      ...validRun(AgentRunStatus.FAILED),
      errorCode: 'RESEARCH_EXECUTION_FAILED',
    });
    prisma.userCompanyRelation.findFirst.mockResolvedValue({ role: { name: 'company_admin' } });
    prisma.lead.findFirst.mockResolvedValue({
      id: 'lead-1', companyId: 'company-1', companyName: 'Buyer Ltd', contacts: [],
      companyNameSource: 'manual_confirmed', companyNameConfidence: 'high',
    });
    prisma.deepResearchReport.findUnique.mockResolvedValue({
      id: 'report-1', agentRunId: 'run-1', leadId: 'lead-1', companyId: 'company-1',
      type: 'full', title: 'Existing report', jsonData: { status: 'ok' },
    });
    prisma.agentRun.updateMany.mockResolvedValue({ count: 1 });
    prisma.agentTask.updateMany.mockResolvedValue({ count: 1 });
    prisma.agentAuditLog.create.mockResolvedValue({});

    const result: any = await processor.process({ data: jobData, id: 'agent-run-run-1', attemptsMade: 1 } as any);

    expect(result.success).toBe(true);
    expect(result.reportId).toBe('report-1');
    expect(background.research).not.toHaveBeenCalled();
  });

  it('does not overwrite a run cancelled while research was executing', async () => {
    const { processor, prisma, background } = createProcessor();
    const loggerLog = jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    const loggerError = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    prisma.agentRun.findFirst.mockResolvedValue(validRun());
    prisma.userCompanyRelation.findFirst.mockResolvedValue({ role: { name: 'sales_user' } });
    prisma.lead.findFirst.mockResolvedValue({
      id: 'lead-1', companyId: 'company-1', companyName: 'Buyer Ltd', ownerUserId: 'user-1', contacts: [],
      companyNameSource: 'manual_confirmed', companyNameConfidence: 'high',
    });
    prisma.deepResearchReport.findUnique.mockResolvedValue(null);
    prisma.agentRun.updateMany
      .mockResolvedValueOnce({ count: 1 })
      .mockResolvedValueOnce({ count: 0 });
    prisma.agentRun.findUnique.mockResolvedValue({ status: AgentRunStatus.CANCELLED });
    prisma.agentTask.updateMany.mockResolvedValue({ count: 1 });
    prisma.agentAuditLog.create.mockResolvedValue({});
    background.research.mockResolvedValue({
      reportId: 'report-1', title: 'Buyer Ltd report', html: '<p>ok</p>', json: { status: 'ok' },
    });

    const result: any = await processor.process({ data: jobData, id: 'agent-run-run-1', attemptsMade: 0 } as any);

    expect(result.success).toBe(false);
    expect(result.reason).toBe('cancelled');
    expect(prisma.deepResearchReport.deleteMany).toHaveBeenCalledWith({
      where: { agentRunId: 'run-1', companyId: 'company-1' },
    });
    expect(prisma.agentAuditLog.create).not.toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ eventType: 'RUN_COMPLETED' }),
    }));
    expect(prisma.agentTask.updateMany).toHaveBeenCalledTimes(1);
    const output = JSON.stringify([
      ...loggerLog.mock.calls,
      ...loggerError.mock.calls,
    ]);
    expect(output).not.toContain('Buyer Ltd');
    expect(output).not.toContain('company-1');
    expect(output).not.toContain('run-1');
  });

  it('rejects a job whose agentRunId does not match all scoped identifiers', async () => {
    const { processor, prisma, background } = createProcessor();
    prisma.agentRun.findFirst.mockResolvedValue(null);

    await expect(processor.process({ data: jobData, id: 'forged', attemptsMade: 0 } as any))
      .rejects.toThrow('Agent run scope mismatch');
    expect(background.research).not.toHaveBeenCalled();
    expect(prisma.lead.findFirst).not.toHaveBeenCalled();
  });

  it('does not execute research when the atomic RUNNING claim loses to cancellation', async () => {
    const { processor, prisma, background } = createProcessor();
    prisma.agentRun.findFirst.mockResolvedValue(validRun());
    prisma.userCompanyRelation.findFirst.mockResolvedValue({ role: { name: 'sales_user' } });
    prisma.lead.findFirst.mockResolvedValue({
      id: 'lead-1', companyId: 'company-1', companyName: 'Buyer Ltd', ownerUserId: 'user-1', contacts: [],
      companyNameSource: 'manual_confirmed', companyNameConfidence: 'high',
    });
    prisma.agentRun.updateMany.mockResolvedValue({ count: 0 });
    prisma.agentRun.findUnique.mockResolvedValue({ status: AgentRunStatus.CANCELLED });

    const result: any = await processor.process({ data: jobData, id: 'job-1', attemptsMade: 0 } as any);

    expect(result).toEqual(expect.objectContaining({ success: false, reason: 'cancelled' }));
    expect(background.research).not.toHaveBeenCalled();
    expect(prisma.deepResearchReport.findUnique).not.toHaveBeenCalled();
  });

  it('throws partial evidence so BullMQ retries and removes the bound failed report', async () => {
    const { processor, prisma, background } = createProcessor();
    const loggerError = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    prisma.agentRun.findFirst.mockResolvedValue(validRun());
    prisma.userCompanyRelation.findFirst.mockResolvedValue({ role: { name: 'sales_user' } });
    prisma.lead.findFirst.mockResolvedValue({
      id: 'lead-1', companyId: 'company-1', companyName: 'Buyer Ltd', ownerUserId: 'user-1', contacts: [],
      companyNameSource: 'manual_confirmed', companyNameConfidence: 'high',
    });
    prisma.deepResearchReport.findUnique.mockResolvedValue(null);
    prisma.agentRun.updateMany.mockResolvedValue({ count: 1 });
    prisma.agentRun.findUnique.mockResolvedValue({
      status: AgentRunStatus.RUNNING,
      executionClaimId: 'job-1:attempt-1',
    });
    prisma.agentTask.updateMany.mockResolvedValue({ count: 1 });
    prisma.agentAuditLog.create.mockResolvedValue({});
    background.research.mockResolvedValue({
      reportId: 'report-partial', title: 'Incomplete', html: '<p>partial</p>',
      json: { status: 'PartialFailed' },
    });

    await expect(processor.process({ data: jobData, id: 'job-1', attemptsMade: 0 } as any))
      .rejects.toThrow('Deep research returned partial evidence');
    expect(prisma.deepResearchReport.deleteMany).toHaveBeenCalledWith({
      where: { agentRunId: 'run-1', companyId: 'company-1' },
    });
    expect(prisma.agentRun.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ status: AgentRunStatus.FAILED }),
    }));
    const output = JSON.stringify(loggerError.mock.calls);
    expect(output).toContain('deep_research.execution_failed');
    expect(output).not.toContain('Buyer Ltd');
    expect(output).not.toContain('run-1');
    expect(output).not.toContain('report-partial');
  });

  it('rethrows provider failure and keeps its text out of processor logs', async () => {
    const { processor, prisma, background } = createProcessor();
    const loggerError = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    const providerError = 'provider-sentinel@example.com response https://provider.example/?token=secret';
    prisma.agentRun.findFirst.mockResolvedValue(validRun());
    prisma.userCompanyRelation.findFirst.mockResolvedValue({ role: { name: 'sales_user' } });
    prisma.lead.findFirst.mockResolvedValue({
      id: 'lead-1', companyId: 'company-1', companyName: 'Buyer Ltd', ownerUserId: 'user-1', contacts: [],
      companyNameSource: 'manual_confirmed', companyNameConfidence: 'high',
    });
    prisma.deepResearchReport.findUnique.mockResolvedValue(null);
    prisma.agentRun.updateMany.mockResolvedValue({ count: 1 });
    prisma.agentRun.findUnique.mockResolvedValue({
      status: AgentRunStatus.RUNNING,
      executionClaimId: 'job-1:attempt-1',
    });
    prisma.agentTask.updateMany.mockResolvedValue({ count: 1 });
    prisma.agentAuditLog.create.mockResolvedValue({});
    background.research.mockRejectedValue(new Error(providerError));

    await expect(processor.process({ data: jobData, id: 'job-1', attemptsMade: 0 } as any))
      .rejects.toThrow(providerError);
    expect(prisma.agentRun.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ status: AgentRunStatus.FAILED, errorCode: 'RESEARCH_EXECUTION_FAILED' }),
    }));
    const output = JSON.stringify(loggerError.mock.calls);
    expect(output).toContain('deep_research.execution_failed');
    expect(output).not.toContain(providerError);
    expect(output).not.toContain('Buyer Ltd');
    expect(output).not.toContain('run-1');
    expect(output).not.toContain('lead-1');
  });

  it('reclaims an expired RUNNING lease after a stalled BullMQ worker and completes with the new token', async () => {
    const { processor, prisma, background } = createProcessor();
    const loggerLog = jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    prisma.agentRun.findFirst.mockResolvedValue({
      ...validRun(AgentRunStatus.RUNNING),
      executionClaimId: 'job-1:old-token',
      executionLeaseExpiresAt: new Date(Date.now() - 1_000),
    });
    prisma.userCompanyRelation.findFirst.mockResolvedValue({ role: { name: 'sales_user' } });
    prisma.lead.findFirst.mockResolvedValue({
      id: 'lead-1', companyId: 'company-1', companyName: 'Buyer Ltd', ownerUserId: 'user-1', contacts: [],
      companyNameSource: 'manual_confirmed', companyNameConfidence: 'high',
    });
    prisma.deepResearchReport.findUnique.mockResolvedValue(null);
    prisma.agentRun.updateMany.mockResolvedValue({ count: 1 });
    prisma.agentTask.updateMany.mockResolvedValue({ count: 1 });
    prisma.agentAuditLog.create.mockResolvedValue({});
    background.research.mockResolvedValue({
      reportId: 'report-recovered', title: 'Recovered', html: '<p>ok</p>', json: { status: 'ok' },
    });

    const result: any = await processor.process(
      { data: jobData, id: 'job-1', attemptsMade: 1 } as any,
      'new-token',
    );

    expect(result.success).toBe(true);
    expect(prisma.agentRun.updateMany.mock.calls[0][0]).toEqual(expect.objectContaining({
      where: expect.objectContaining({
        OR: expect.arrayContaining([
          expect.objectContaining({ status: AgentRunStatus.RUNNING }),
        ]),
      }),
      data: expect.objectContaining({
        status: AgentRunStatus.RUNNING,
        executionClaimId: 'job-1:new-token',
        executionLeaseExpiresAt: expect.any(Date),
      }),
    }));
    const output = JSON.stringify(loggerLog.mock.calls);
    expect(output).toContain('deep_research.execution_started');
    expect(output).not.toContain('Buyer Ltd');
    expect(output).not.toContain('run-1');
    expect(output).not.toContain('job-1');
  });

  it('does not run a duplicate worker while the current durable lease is active', async () => {
    const { processor, prisma, background } = createProcessor();
    prisma.agentRun.findFirst.mockResolvedValue({
      ...validRun(AgentRunStatus.RUNNING),
      executionClaimId: 'job-1:active-token',
      executionLeaseExpiresAt: new Date(Date.now() + 60_000),
    });

    await expect(processor.process(
      { data: jobData, id: 'job-1', attemptsMade: 0 } as any,
      'duplicate-token',
    )).rejects.toThrow('execution lease is still active');
    expect(background.research).not.toHaveBeenCalled();
    expect(prisma.agentRun.updateMany).not.toHaveBeenCalled();
  });

  it('lets a BullMQ thrown-error retry reclaim the same live durable lease', async () => {
    const { processor, prisma, background } = createProcessor();
    prisma.agentRun.findFirst.mockResolvedValue({
      ...validRun(AgentRunStatus.RUNNING),
      executionClaimId: 'job-1:first-token',
      executionLeaseExpiresAt: new Date(Date.now() + 60_000),
    });
    prisma.userCompanyRelation.findFirst.mockResolvedValue({ role: { name: 'sales_user' } });
    prisma.lead.findFirst.mockResolvedValue({
      id: 'lead-1', companyId: 'company-1', companyName: 'Buyer Ltd', ownerUserId: 'user-1', contacts: [],
      companyNameSource: 'manual_confirmed', companyNameConfidence: 'high',
    });
    prisma.deepResearchReport.findUnique.mockResolvedValue(null);
    prisma.agentRun.updateMany.mockResolvedValue({ count: 1 });
    prisma.agentTask.updateMany.mockResolvedValue({ count: 1 });
    prisma.agentAuditLog.create.mockResolvedValue({});
    background.research.mockResolvedValue({
      reportId: 'report-retried', title: 'Retried', html: '<p>ok</p>', json: { status: 'ok' },
    });

    const result: any = await processor.process({
      data: jobData, id: 'job-1', attemptsMade: 1, stalledCounter: 0,
    } as any, 'retry-token');

    expect(result.success).toBe(true);
    expect(prisma.agentRun.updateMany.mock.calls[0][0].where).toEqual(expect.objectContaining({
      OR: expect.arrayContaining([
        expect.objectContaining({
          status: AgentRunStatus.RUNNING,
          OR: expect.arrayContaining([
            { executionClaimId: { startsWith: 'job-1:' } },
          ]),
        }),
      ]),
    }));
  });

  it('does not reclaim a live lease for a BullMQ stalled duplicate', async () => {
    const { processor, prisma, background } = createProcessor();
    prisma.agentRun.findFirst.mockResolvedValue({
      ...validRun(AgentRunStatus.RUNNING),
      executionClaimId: 'job-1:first-token',
      executionLeaseExpiresAt: new Date(Date.now() + 60_000),
    });

    await expect(processor.process({
      data: jobData, id: 'job-1', attemptsMade: 1, stalledCounter: 1,
    } as any, 'stalled-token')).rejects.toThrow('execution lease is still active');
    expect(background.research).not.toHaveBeenCalled();
    expect(prisma.agentRun.updateMany).not.toHaveBeenCalled();
  });

  it('removes a report left behind by a crash when a cancelled run is replayed', async () => {
    const { processor, prisma, background } = createProcessor();
    prisma.agentRun.findFirst.mockResolvedValue(validRun(AgentRunStatus.CANCELLED));
    prisma.deepResearchReport.deleteMany.mockResolvedValue({ count: 1 });

    const result = await processor.process({
      data: jobData, id: 'job-cancelled-replay', attemptsMade: 1,
    } as any);

    expect(result).toEqual({ success: false, reason: 'cancelled' });
    expect(prisma.deepResearchReport.deleteMany).toHaveBeenCalledWith({
      where: { agentRunId: 'run-1', companyId: 'company-1' },
    });
    expect(background.research).not.toHaveBeenCalled();
  });

  it('revalidates the reviewed company identity immediately before execution', async () => {
    const { processor, prisma, background } = createProcessor();
    prisma.agentRun.findFirst.mockResolvedValue(validRun());
    prisma.userCompanyRelation.findFirst.mockResolvedValue({ role: { name: 'sales_user' } });
    prisma.lead.findFirst.mockResolvedValue({
      id: 'lead-1', companyId: 'company-1', companyName: 'AcmeCorp', ownerUserId: 'user-1', contacts: [],
      companyNameSource: 'untrusted_display', companyNameConfidence: 'low',
    });
    prisma.agentRun.updateMany.mockResolvedValue({ count: 1 });
    prisma.agentTask.updateMany.mockResolvedValue({ count: 1 });
    prisma.agentAuditLog.create.mockResolvedValue({});

    const result = await processor.process({ data: jobData, id: 'job-untrusted', attemptsMade: 0 } as any);

    expect(result).toEqual({ success: false, reason: 'customer scope invalid' });
    expect(prisma.deepResearchReport.deleteMany).toHaveBeenCalledWith({
      where: { agentRunId: 'run-1', companyId: 'company-1' },
    });
    expect(background.research).not.toHaveBeenCalled();
  });

  it('removes any crash-left report when operator membership is revoked before execution', async () => {
    const { processor, prisma, background } = createProcessor();
    prisma.agentRun.findFirst.mockResolvedValue(validRun());
    prisma.userCompanyRelation.findFirst.mockResolvedValue(null);
    prisma.agentRun.updateMany.mockResolvedValue({ count: 1 });
    prisma.agentTask.updateMany.mockResolvedValue({ count: 1 });
    prisma.agentAuditLog.create.mockResolvedValue({});

    const result = await processor.process({ data: jobData, id: 'job-revoked', attemptsMade: 0 } as any);

    expect(result).toEqual({ success: false, reason: 'operator membership revoked' });
    expect(prisma.deepResearchReport.deleteMany).toHaveBeenCalledWith({
      where: { agentRunId: 'run-1', companyId: 'company-1' },
    });
    expect(background.research).not.toHaveBeenCalled();
  });
});
