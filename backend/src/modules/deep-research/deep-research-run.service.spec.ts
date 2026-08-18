import { ForbiddenException, Logger, ServiceUnavailableException } from '@nestjs/common';
import { AgentRunKind, AgentRunStatus } from '@prisma/client';
import { DeepResearchRunService } from './deep-research-run.service';

const companyId = '11111111-1111-4111-8111-111111111111';
const operator = {
  id: 'user-1',
  activeCompanyId: companyId,
  activeCompany: { id: companyId, role: 'sales_user' },
  companies: [{ id: companyId, role: 'sales_user' }],
};

function createPrismaMock() {
  const prisma: any = {
    lead: { findFirst: jest.fn() },
    agentRun: {
      create: jest.fn(),
      updateMany: jest.fn(),
      findUnique: jest.fn(),
      findUniqueOrThrow: jest.fn(),
      findMany: jest.fn(),
    },
    agentTask: { updateMany: jest.fn() },
    agentAuditLog: { create: jest.fn() },
  };
  prisma.$transaction = jest.fn(async (input: any) => {
    if (typeof input === 'function') return input(prisma);
    return Promise.all(input);
  });
  return prisma;
}

describe('DeepResearchRunService', () => {
  describe('startup reconciliation guard', () => {
    const originalSetting = process.env.DEEP_RESEARCH_RECONCILE_ENABLED;
    const originalIntervalSetting = process.env.DEEP_RESEARCH_RECONCILE_INTERVAL_MS;

    afterEach(() => {
      if (originalSetting === undefined) {
        delete process.env.DEEP_RESEARCH_RECONCILE_ENABLED;
      } else {
        process.env.DEEP_RESEARCH_RECONCILE_ENABLED = originalSetting;
      }
      if (originalIntervalSetting === undefined) {
        delete process.env.DEEP_RESEARCH_RECONCILE_INTERVAL_MS;
      } else {
        process.env.DEEP_RESEARCH_RECONCILE_INTERVAL_MS = originalIntervalSetting;
      }
      jest.useRealTimers();
      jest.restoreAllMocks();
    });

    it('does not reconcile when the setting is missing or malformed', () => {
      const prisma = createPrismaMock();
      const queue: any = { add: jest.fn() };
      const service = new DeepResearchRunService(prisma, queue);
      const reconcile = jest.spyOn(service, 'reconcilePendingRuns').mockResolvedValue(0);

      delete process.env.DEEP_RESEARCH_RECONCILE_ENABLED;
      service.onModuleInit();
      process.env.DEEP_RESEARCH_RECONCILE_ENABLED = 'TRUE';
      service.onModuleInit();

      expect(reconcile).not.toHaveBeenCalled();
      expect((service as any).reconciliationTimer).toBeUndefined();
    });

    it('reconciles only after an explicit production opt-in', () => {
      process.env.DEEP_RESEARCH_RECONCILE_ENABLED = 'true';
      const prisma = createPrismaMock();
      const queue: any = { add: jest.fn() };
      const service = new DeepResearchRunService(prisma, queue);
      const reconcile = jest.spyOn(service, 'reconcilePendingRuns').mockResolvedValue(0);

      service.onModuleInit();

      expect(reconcile).toHaveBeenCalledTimes(1);
      expect((service as any).reconciliationTimer).toBeDefined();
      service.onModuleDestroy();
    });

    it('sanitizes startup and interval reconciliation failures', async () => {
      jest.useFakeTimers();
      const originalInterval = process.env.DEEP_RESEARCH_RECONCILE_INTERVAL_MS;
      process.env.DEEP_RESEARCH_RECONCILE_ENABLED = 'true';
      process.env.DEEP_RESEARCH_RECONCILE_INTERVAL_MS = '5000';
      const prisma = createPrismaMock();
      const queue: any = { add: jest.fn() };
      const service = new DeepResearchRunService(prisma, queue);
      const loggerError = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
      const providerError = 'startup-sentinel@example.com Error.stack /opt/app?token=secret';
      const reconcile = jest.spyOn(service, 'reconcilePendingRuns')
        .mockRejectedValueOnce(new Error(providerError))
        .mockRejectedValueOnce({
          message: providerError,
          response: { data: providerError },
          cause: providerError,
        });

      service.onModuleInit();
      await Promise.resolve();
      await Promise.resolve();
      jest.advanceTimersByTime(5000);
      await Promise.resolve();
      await Promise.resolve();
      service.onModuleDestroy();

      expect(reconcile).toHaveBeenCalledTimes(2);
      const output = JSON.stringify(loggerError.mock.calls);
      expect(output).toContain('deep_research.reconcile_startup_failed');
      expect(output).toContain('deep_research.reconcile_interval_failed');
      expect(output).not.toContain(providerError);
      expect(output).not.toContain('Error.stack');
      if (originalInterval === undefined) delete process.env.DEEP_RESEARCH_RECONCILE_INTERVAL_MS;
      else process.env.DEEP_RESEARCH_RECONCILE_INTERVAL_MS = originalInterval;
    });
  });

  it('creates an AgentRun and queues only server-scoped identifiers with a stable job id', async () => {
    const prisma = createPrismaMock();
    const queue: any = { add: jest.fn().mockResolvedValue({ id: 'agent-run-run-1' }) };
    const service = new DeepResearchRunService(prisma, queue);
    prisma.lead.findFirst.mockResolvedValue({
      id: 'lead-1', companyId, companyName: 'Buyer Ltd', ownerUserId: operator.id,
      companyNameSource: 'manual_confirmed', companyNameConfidence: 'high',
    });
    prisma.agentRun.create.mockResolvedValue({ id: 'run-1' });
    prisma.agentAuditLog.create.mockResolvedValue({});
    prisma.agentRun.findUniqueOrThrow.mockResolvedValue({
      id: 'run-1', kind: AgentRunKind.BACKGROUND_RESEARCH, status: AgentRunStatus.PENDING,
      tasks: [], authorizations: [],
    });

    const run: any = await service.enqueueForLead({
      companyId, leadId: 'lead-1', type: 'full', source: 'assistant_chat', conversationId: 'conversation-1',
      requestKey: 'assistant-chat:test-request-1',
    }, operator);

    expect(run.id).toBe('run-1');
    expect(prisma.lead.findFirst).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ companyId, ownerUserId: operator.id, deletedAt: null }),
    }));
    expect(queue.add).toHaveBeenCalledWith('deep-research', {
      companyId,
      agentRunId: 'run-1',
      leadId: 'lead-1',
      userId: operator.id,
      type: 'full',
    }, expect.objectContaining({ jobId: 'agent-run-run-1' }));
  });

  it('rejects an arbitrary company before reading any lead', async () => {
    const prisma = createPrismaMock();
    const queue: any = { add: jest.fn() };
    const service = new DeepResearchRunService(prisma, queue);

    await expect(service.enqueueForLead({
      companyId: '22222222-2222-4222-8222-222222222222',
      leadId: 'lead-1', source: 'lead_detail',
      requestKey: 'lead-detail:test-request-2',
    }, operator)).rejects.toBeInstanceOf(ForbiddenException);
    expect(prisma.lead.findFirst).not.toHaveBeenCalled();
    expect(queue.add).not.toHaveBeenCalled();
  });

  it('marks the run failed when BullMQ cannot accept the job', async () => {
    const prisma = createPrismaMock();
    const loggerError = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    const providerError = 'redis-sentinel@example.com https://redis.example/?token=secret';
    const queue: any = { add: jest.fn().mockRejectedValue(new Error(providerError)) };
    const service = new DeepResearchRunService(prisma, queue);
    prisma.lead.findFirst.mockResolvedValue({
      id: 'lead-1', companyId, companyName: 'Buyer Ltd', ownerUserId: operator.id,
      companyNameSource: 'manual_confirmed', companyNameConfidence: 'high',
    });
    prisma.agentRun.create.mockResolvedValue({ id: 'run-1' });
    prisma.agentRun.updateMany.mockResolvedValue({ count: 1 });
    prisma.agentTask.updateMany.mockResolvedValue({ count: 1 });
    prisma.agentAuditLog.create.mockResolvedValue({});

    await expect(service.enqueueForLead({
      companyId, leadId: 'lead-1', source: 'assistant_chat',
      requestKey: 'assistant-chat:test-request-3',
    }, operator)).rejects.toBeInstanceOf(ServiceUnavailableException);
    expect(prisma.agentRun.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ status: AgentRunStatus.FAILED, errorCode: 'RESEARCH_QUEUE_UNAVAILABLE' }),
    }));
    const output = JSON.stringify(loggerError.mock.calls);
    expect(output).toContain('deep_research.queue_enqueue_failed');
    expect(output).not.toContain(providerError);
    expect(output).not.toContain('run-1');
    expect(output).not.toContain(companyId);
  });

  it('does not fail or return 503 after BullMQ accepted the job when RUN_QUEUED audit append fails', async () => {
    const prisma = createPrismaMock();
    const loggerError = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    const providerError = 'audit-sentinel@example.com stack /var/app?token=secret';
    const queue: any = { add: jest.fn().mockResolvedValue({ id: 'agent-run-run-1' }) };
    const service = new DeepResearchRunService(prisma, queue);
    prisma.lead.findFirst.mockResolvedValue({
      id: 'lead-1', companyId, companyName: 'Buyer Ltd', ownerUserId: operator.id,
      companyNameSource: 'manual_confirmed', companyNameConfidence: 'high',
    });
    prisma.agentRun.create.mockResolvedValue({
      id: 'run-1', requestKey: 'assistant-chat:audit-failure', status: AgentRunStatus.PENDING,
    });
    prisma.agentAuditLog.create
      .mockResolvedValueOnce({})
      .mockRejectedValueOnce(new Error(providerError));
    prisma.agentRun.findUniqueOrThrow.mockResolvedValue({
      id: 'run-1', kind: AgentRunKind.BACKGROUND_RESEARCH, status: AgentRunStatus.PENDING,
      tasks: [], authorizations: [],
    });

    await expect(service.enqueueForLead({
      companyId, leadId: 'lead-1', source: 'assistant_chat',
      requestKey: 'assistant-chat:audit-failure',
    }, operator)).resolves.toEqual(expect.objectContaining({ id: 'run-1' }));
    expect(queue.add).toHaveBeenCalledTimes(1);
    expect(prisma.agentRun.updateMany).not.toHaveBeenCalled();
    const output = JSON.stringify(loggerError.mock.calls);
    expect(output).toContain('deep_research.run_queued_audit_failed');
    expect(output).not.toContain(providerError);
    expect(output).not.toContain('run-1');
    expect(output).not.toContain('agent-run-run-1');
  });

  it('reuses the same run and stable BullMQ job id for the same request key', async () => {
    const prisma = createPrismaMock();
    const queue: any = { add: jest.fn().mockResolvedValue({ id: 'agent-run-run-1' }) };
    const service = new DeepResearchRunService(prisma, queue);
    prisma.lead.findFirst.mockResolvedValue({
      id: 'lead-1', companyId, companyName: 'Buyer Ltd', ownerUserId: operator.id,
      companyNameSource: 'manual_confirmed', companyNameConfidence: 'high',
    });
    const existing = {
      id: 'run-1', requestKey: 'assistant-chat:same-request', companyId,
      operatorUserId: operator.id, kind: AgentRunKind.BACKGROUND_RESEARCH,
      subjectType: 'lead', subjectId: 'lead-1', status: AgentRunStatus.PENDING,
    };
    prisma.agentRun.create
      .mockResolvedValueOnce(existing)
      .mockRejectedValueOnce({ code: 'P2002', meta: { target: ['requestKey'] } });
    prisma.agentRun.findUnique.mockImplementation(async ({ where }: any) => (
      where.requestKey ? { ...existing, inputDigest: prisma.agentRun.create.mock.calls[0][0].data.inputDigest } : null
    ));
    prisma.agentAuditLog.create.mockResolvedValue({});
    prisma.agentRun.findUniqueOrThrow.mockResolvedValue({ ...existing, tasks: [], authorizations: [] });
    const input = {
      companyId, leadId: 'lead-1', source: 'assistant_chat' as const,
      requestKey: 'assistant-chat:same-request',
    };

    const first = await service.enqueueForLead(input, operator);
    const second = await service.enqueueForLead(input, operator);

    expect(first.id).toBe('run-1');
    expect(second.id).toBe('run-1');
    expect(new Set(queue.add.mock.calls.map((call: any[]) => call[2].jobId))).toEqual(
      new Set(['agent-run-run-1']),
    );
  });

  it('reconciles a durable PENDING run when the process died before queue.add', async () => {
    const prisma = createPrismaMock();
    const queue: any = {
      getJob: jest.fn().mockResolvedValue(null),
      add: jest.fn().mockResolvedValue({ id: 'agent-run-run-orphan' }),
    };
    const service = new DeepResearchRunService(prisma, queue);
    prisma.agentRun.findMany.mockResolvedValue([{
      id: 'run-orphan', companyId, operatorUserId: operator.id,
      subjectId: 'lead-1', status: AgentRunStatus.PENDING,
      tasks: [{ toolName: 'research.background_check' }],
    }]);
    prisma.agentAuditLog.create.mockResolvedValue({});

    await expect(service.reconcilePendingRuns()).resolves.toBe(1);
    expect(queue.getJob).toHaveBeenCalledWith('agent-run-run-orphan');
    expect(queue.add).toHaveBeenCalledWith('deep-research', {
      companyId,
      agentRunId: 'run-orphan',
      leadId: 'lead-1',
      userId: operator.id,
      type: 'full',
    }, expect.objectContaining({ jobId: 'agent-run-run-orphan' }));
    expect(prisma.agentAuditLog.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ eventType: 'RUN_REQUEUED', runId: 'run-orphan' }),
    }));
  });

  it('does not duplicate a reconciled BullMQ job with the same stable id', async () => {
    const prisma = createPrismaMock();
    const queue: any = {
      getJob: jest.fn().mockResolvedValue({
        id: 'agent-run-run-existing', getState: jest.fn().mockResolvedValue('waiting'),
      }),
      add: jest.fn(),
    };
    const service = new DeepResearchRunService(prisma, queue);
    prisma.agentRun.findMany.mockResolvedValue([{
      id: 'run-existing', companyId, operatorUserId: operator.id,
      subjectId: 'lead-1', status: AgentRunStatus.PENDING,
      tasks: [{ toolName: 'research.background_check' }],
    }]);

    await expect(service.reconcilePendingRuns()).resolves.toBe(0);
    expect(queue.add).not.toHaveBeenCalled();
  });

  it('replaces a retained failed job instead of masking a durable PENDING run forever', async () => {
    const prisma = createPrismaMock();
    const retained = {
      id: 'agent-run-run-failed',
      getState: jest.fn().mockResolvedValue('failed'),
      remove: jest.fn().mockResolvedValue(undefined),
    };
    const queue: any = {
      getJob: jest.fn().mockResolvedValue(retained),
      add: jest.fn().mockResolvedValue({ id: retained.id }),
    };
    const service = new DeepResearchRunService(prisma, queue);
    prisma.agentRun.findMany.mockResolvedValue([{
      id: 'run-failed', companyId, operatorUserId: operator.id,
      subjectId: 'lead-1', status: AgentRunStatus.PENDING,
      tasks: [{ toolName: 'research.background_check' }],
    }]);
    prisma.agentAuditLog.create.mockResolvedValue({});

    await expect(service.reconcilePendingRuns()).resolves.toBe(1);
    expect(retained.remove).toHaveBeenCalledTimes(1);
    expect(queue.add).toHaveBeenCalledWith(
      'deep-research',
      expect.objectContaining({ agentRunId: 'run-failed' }),
      expect.objectContaining({ jobId: 'agent-run-run-failed' }),
    );
  });

  it('requeues an expired RUNNING lease after a crashed worker lost its job', async () => {
    const prisma = createPrismaMock();
    const queue: any = {
      getJob: jest.fn().mockResolvedValue(null),
      add: jest.fn().mockResolvedValue({ id: 'agent-run-run-expired' }),
    };
    const service = new DeepResearchRunService(prisma, queue);
    prisma.agentRun.findMany.mockResolvedValue([{
      id: 'run-expired', companyId, operatorUserId: operator.id,
      subjectId: 'lead-1', status: AgentRunStatus.RUNNING,
      tasks: [{ toolName: 'research.background_check' }],
    }]);
    prisma.agentAuditLog.create.mockResolvedValue({});

    await expect(service.reconcilePendingRuns()).resolves.toBe(1);
    expect(queue.add).toHaveBeenCalledWith(
      'deep-research',
      expect.objectContaining({ agentRunId: 'run-expired' }),
      expect.objectContaining({ jobId: 'agent-run-run-expired' }),
    );
    expect(prisma.agentAuditLog.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        eventType: 'RUN_REQUEUED',
        metadata: expect.objectContaining({ reason: 'expired_execution_lease_reconciliation' }),
      }),
    }));
  });

  it('sanitizes a non-Error reconcile queue failure while preserving rejection', async () => {
    const prisma = createPrismaMock();
    const providerError = 'reconcile-sentinel@example.com provider response /srv/app?token=secret';
    const queue: any = {
      getJob: jest.fn().mockResolvedValue(null),
      add: jest.fn().mockRejectedValue({
        message: providerError,
        response: { data: providerError },
        cause: providerError,
      }),
    };
    const service = new DeepResearchRunService(prisma, queue);
    const loggerError = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    prisma.agentRun.findMany.mockResolvedValue([{
      id: 'run-reconcile-sentinel', companyId, operatorUserId: operator.id,
      subjectId: 'lead-reconcile-sentinel', status: AgentRunStatus.PENDING,
      tasks: [{ toolName: 'research.background_check' }],
    }]);

    await expect(service.reconcilePendingRuns()).rejects.toMatchObject({ message: providerError });
    const output = JSON.stringify(loggerError.mock.calls);
    expect(output).toContain('deep_research.reconcile_enqueue_failed');
    expect(output).not.toContain(providerError);
    expect(output).not.toContain('run-reconcile-sentinel');
    expect(output).not.toContain('lead-reconcile-sentinel');
  });

  it('sanitizes a reconcile audit failure without changing the repaired count', async () => {
    const prisma = createPrismaMock();
    const providerError = 'reconcile-audit-sentinel@example.com stack /srv/app?token=secret';
    const queue: any = {
      getJob: jest.fn().mockResolvedValue(null),
      add: jest.fn().mockResolvedValue({ id: 'agent-run-audit-sentinel' }),
    };
    const service = new DeepResearchRunService(prisma, queue);
    const loggerError = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    prisma.agentRun.findMany.mockResolvedValue([{
      id: 'run-audit-sentinel', companyId, operatorUserId: operator.id,
      subjectId: 'lead-audit-sentinel', status: AgentRunStatus.RUNNING,
      tasks: [{ toolName: 'research.background_check' }],
    }]);
    prisma.agentAuditLog.create.mockRejectedValue({
      message: providerError,
      response: { data: providerError },
      cause: providerError,
    });

    await expect(service.reconcilePendingRuns()).resolves.toBe(1);
    const output = JSON.stringify(loggerError.mock.calls);
    expect(output).toContain('deep_research.run_requeued_audit_failed');
    expect(output).not.toContain(providerError);
    expect(output).not.toContain('run-audit-sentinel');
  });

  it('uses a safe event for a pending run with no recognized task', async () => {
    const prisma = createPrismaMock();
    const queue: any = { getJob: jest.fn(), add: jest.fn() };
    const service = new DeepResearchRunService(prisma, queue);
    const loggerError = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    prisma.agentRun.findMany.mockResolvedValue([{
      id: 'run-missing-task-sentinel', companyId, operatorUserId: operator.id,
      subjectId: 'lead-missing-task-sentinel', status: AgentRunStatus.PENDING,
      tasks: [{ toolName: 'research.unknown' }],
    }]);

    await expect(service.reconcilePendingRuns()).resolves.toBe(0);
    const output = JSON.stringify(loggerError.mock.calls);
    expect(output).toContain('deep_research.reconcile_task_missing');
    expect(output).not.toContain('run-missing-task-sentinel');
    expect(queue.getJob).not.toHaveBeenCalled();
  });
});
