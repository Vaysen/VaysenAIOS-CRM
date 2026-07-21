import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
  OnModuleDestroy,
  OnModuleInit,
  ServiceUnavailableException,
} from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import {
  AgentRunKind,
  AgentRunStatus,
  AgentTaskStatus,
  Prisma,
} from '@prisma/client';
import { Queue } from 'bullmq';
import { PrismaService } from '@/common/prisma/prisma.service';
import { QUEUES } from '@/common/queues/queue-names';
import { digestAgentInput } from '@/modules/agent/agent-security';
import { assessResearchSubject } from './research-subject-policy';

export type DeepResearchType = 'full' | 'contacts' | 'market';

export type DeepResearchJobData = {
  companyId: string;
  agentRunId: string;
  leadId: string;
  userId: string;
  type: DeepResearchType;
};

export type DeepResearchOperator = {
  id: string;
  companies?: Array<{ id: string; role: string }>;
};

type QueueResearchInput = {
  companyId: string;
  leadId: string;
  type?: DeepResearchType;
  source: 'assistant_chat' | 'lead_detail';
  conversationId?: string;
  requestKey: string;
};

@Injectable()
export class DeepResearchRunService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(DeepResearchRunService.name);
  private reconciliationTimer?: NodeJS.Timeout;

  constructor(
    private readonly prisma: PrismaService,
    @InjectQueue(QUEUES.deepResearch) private readonly deepResearchQueue: Queue<DeepResearchJobData>,
  ) {}

  onModuleInit() {
    // Reconciliation writes both PostgreSQL audit rows and BullMQ jobs. Only
    // the explicitly approved production API instance may perform it; an
    // isolated candidate or a malformed environment remains inert.
    if (process.env.DEEP_RESEARCH_RECONCILE_ENABLED !== 'true') return;
    const intervalMs = Math.max(
      5_000,
      Number(process.env.DEEP_RESEARCH_RECONCILE_INTERVAL_MS || 30_000),
    );
    void this.reconcilePendingRuns().catch((error) => {
      this.logger.error(
        'Initial deep-research queue reconciliation failed',
        error instanceof Error ? error.stack : String(error),
      );
    });
    this.reconciliationTimer = setInterval(() => {
      void this.reconcilePendingRuns().catch((error) => {
        this.logger.error(
          'Deep-research queue reconciliation failed',
          error instanceof Error ? error.stack : String(error),
        );
      });
    }, intervalMs);
    this.reconciliationTimer.unref?.();
  }

  onModuleDestroy() {
    if (this.reconciliationTimer) clearInterval(this.reconciliationTimer);
  }

  async enqueueForLead(input: QueueResearchInput, user: DeepResearchOperator) {
    this.assertCompanyMembership(user, input.companyId);
    if (!input.requestKey?.trim() || input.requestKey.length > 300) {
      throw new BadRequestException('A valid idempotency request key is required');
    }
    const type = input.type || 'full';
    const isAdmin = this.isCompanyAdmin(user, input.companyId);
    const lead = await this.prisma.lead.findFirst({
      where: {
        id: input.leadId,
        companyId: input.companyId,
        deletedAt: null,
        ...(isAdmin ? {} : { ownerUserId: user.id }),
      },
      select: {
        id: true,
        companyId: true,
        companyName: true,
        companyNameSource: true,
        companyNameConfidence: true,
        ownerUserId: true,
      },
    });
    if (!lead) throw new NotFoundException('Customer is unavailable or not assigned to this operator');
    const subject = assessResearchSubject(lead);
    if (!subject.trusted) {
      throw new BadRequestException(
        subject.code === 'MISSING_COMPANY_NAME'
          ? 'A customer company name must be confirmed before background research'
          : 'The customer company name is not a high-confidence reviewed identity',
      );
    }

    const inputDigest = digestAgentInput({
      companyId: input.companyId,
      kind: AgentRunKind.BACKGROUND_RESEARCH,
      leadId: lead.id,
      type,
      source: input.source,
      conversationId: input.conversationId || null,
    });
    const toolName = type === 'contacts'
      ? 'research.discover_contacts'
      : type === 'market'
        ? 'research.market_analysis'
        : 'research.background_check';

    const { run, created } = await this.createOrGetRun({
      input,
      user,
      leadId: lead.id,
      inputDigest,
      toolName,
    });

    if (!created && run.status !== AgentRunStatus.PENDING) {
      return this.findRun(run.id);
    }

    try {
      const job = await this.addQueueJob({
        companyId: input.companyId,
        agentRunId: run.id,
        leadId: lead.id,
        userId: user.id,
        type,
      });
      // RUN_CREATED is the durable source of truth and is written atomically
      // with AgentRun. A telemetry/audit append failure after BullMQ accepted
      // the job must never turn an actually queued task into a 503/FAILED run.
      if (created) {
        try {
          await this.prisma.agentAuditLog.create({
            data: {
              companyId: input.companyId,
              runId: run.id,
              actorUserId: user.id,
              eventType: 'RUN_QUEUED',
              inputDigest,
              metadata: { jobId: String(job.id), queue: QUEUES.deepResearch, type },
            },
          });
        } catch (auditError) {
          this.logger.error(
            `Deep research ${run.id} was queued but RUN_QUEUED audit append failed`,
            auditError instanceof Error ? auditError.stack : String(auditError),
          );
        }
      }
    } catch (error) {
      if (!created) {
        throw new ServiceUnavailableException('Background research queue is unavailable');
      }
      const completedAt = new Date();
      await this.prisma.$transaction(async (tx) => {
        const claimed = await tx.agentRun.updateMany({
          where: { id: run.id, companyId: input.companyId, status: AgentRunStatus.PENDING },
          data: {
            status: AgentRunStatus.FAILED,
            errorCode: 'RESEARCH_QUEUE_UNAVAILABLE',
            completedAt,
          },
        });
        if (claimed.count !== 1) return;
        await tx.agentTask.updateMany({
          where: { runId: run.id, status: AgentTaskStatus.PENDING },
          data: {
            status: AgentTaskStatus.FAILED,
            errorCode: 'RESEARCH_QUEUE_UNAVAILABLE',
            completedAt,
          },
        });
        await tx.agentAuditLog.create({
          data: {
            companyId: input.companyId,
            runId: run.id,
            actorUserId: user.id,
            eventType: 'RUN_FAILED',
            inputDigest,
            metadata: { errorCode: 'RESEARCH_QUEUE_UNAVAILABLE' },
          },
        });
      });
      throw new ServiceUnavailableException('Background research queue is unavailable');
    }

    return this.findRun(run.id);
  }

  /**
   * Repairs the narrow crash window after RUN_CREATED committed but before
   * BullMQ accepted the stable job. The database remains the source of truth;
   * re-adding the same job id is idempotent and the worker still revalidates
   * tenant, ownership and the reviewed customer identity before execution.
   */
  async reconcilePendingRuns(limit = 100) {
    const minAgeMs = Math.max(
      5_000,
      Number(process.env.DEEP_RESEARCH_RECONCILE_MIN_AGE_MS || 15_000),
    );
    const now = new Date();
    const candidates = await this.prisma.agentRun.findMany({
      where: {
        kind: AgentRunKind.BACKGROUND_RESEARCH,
        subjectType: 'lead',
        OR: [
          {
            status: AgentRunStatus.PENDING,
            createdAt: { lte: new Date(now.getTime() - minAgeMs) },
          },
          {
            status: AgentRunStatus.RUNNING,
            OR: [
              { executionLeaseExpiresAt: null },
              { executionLeaseExpiresAt: { lte: now } },
            ],
          },
        ],
      },
      select: {
        id: true,
        companyId: true,
        operatorUserId: true,
        subjectId: true,
        status: true,
        tasks: {
          where: {
            status: {
              in: [AgentTaskStatus.PENDING, AgentTaskStatus.RUNNING, AgentTaskStatus.FAILED],
            },
          },
          select: { toolName: true },
          take: 1,
        },
      },
      orderBy: { createdAt: 'asc' },
      take: Math.min(Math.max(limit, 1), 500),
    });

    let repaired = 0;
    for (const run of candidates) {
      if (!run.subjectId) continue;
      const type = this.typeFromTool(run.tasks[0]?.toolName);
      if (!type) {
        this.logger.error(`Pending deep-research run ${run.id} has no recognized task`);
        continue;
      }
      const jobId = `agent-run-${run.id}`;
      const existing = await this.deepResearchQueue.getJob(jobId);
      if (existing) {
        const state = await existing.getState();
        if (['waiting', 'active', 'delayed', 'prioritized', 'waiting-children'].includes(state)) {
          continue;
        }
        // BullMQ intentionally retains a bounded set of terminal jobs. A
        // failed/finished queue record must not permanently mask a durable
        // PENDING run or an expired RUNNING lease.
        await existing.remove();
      }
      await this.addQueueJob({
        companyId: run.companyId,
        agentRunId: run.id,
        leadId: run.subjectId,
        userId: run.operatorUserId,
        type,
      });
      repaired += 1;
      try {
        await this.prisma.agentAuditLog.create({
          data: {
            companyId: run.companyId,
            runId: run.id,
            actorUserId: run.operatorUserId,
            eventType: 'RUN_REQUEUED',
            metadata: {
              jobId,
              queue: QUEUES.deepResearch,
              reason: run.status === AgentRunStatus.RUNNING
                ? 'expired_execution_lease_reconciliation'
                : 'pending_run_reconciliation',
            },
          },
        });
      } catch (auditError) {
        this.logger.error(
          `Requeued deep research ${run.id} but RUN_REQUEUED audit append failed`,
          auditError instanceof Error ? auditError.stack : String(auditError),
        );
      }
    }
    return repaired;
  }

  private addQueueJob(data: DeepResearchJobData) {
    return this.deepResearchQueue.add('deep-research', data, {
      jobId: `agent-run-${data.agentRunId}`,
      attempts: 2,
      backoff: { type: 'exponential', delay: 30000 },
      removeOnComplete: 100,
      removeOnFail: 100,
    });
  }

  private typeFromTool(toolName: string | undefined): DeepResearchType | null {
    if (toolName === 'research.discover_contacts') return 'contacts';
    if (toolName === 'research.market_analysis') return 'market';
    if (toolName === 'research.background_check') return 'full';
    return null;
  }

  private async createOrGetRun(args: {
    input: QueueResearchInput;
    user: DeepResearchOperator;
    leadId: string;
    inputDigest: string;
    toolName: string;
  }) {
    const { input, user, leadId, inputDigest, toolName } = args;
    try {
      const run = await this.prisma.$transaction(async (tx) => {
        const created = await tx.agentRun.create({
          data: {
            requestKey: input.requestKey,
            companyId: input.companyId,
            operatorUserId: user.id,
            kind: AgentRunKind.BACKGROUND_RESEARCH,
            inputDigest,
            subjectType: 'lead',
            subjectId: leadId,
            tasks: {
              create: {
                companyId: input.companyId,
                toolName,
                inputDigest,
              },
            },
          },
        });
        await tx.agentAuditLog.create({
          data: {
            companyId: input.companyId,
            runId: created.id,
            actorUserId: user.id,
            eventType: 'RUN_CREATED',
            inputDigest,
            metadata: {
              kind: AgentRunKind.BACKGROUND_RESEARCH,
              toolName,
              source: input.source,
              conversationId: input.conversationId || null,
              externalSideEffect: false,
            },
          },
        });
        return created;
      });
      return { run, created: true };
    } catch (error) {
      if (!this.isRequestKeyConflict(error)) throw error;
      const existing = await this.prisma.agentRun.findUnique({
        where: { requestKey: input.requestKey },
      });
      if (!existing) throw error;
      if (
        existing.companyId !== input.companyId
        || existing.operatorUserId !== user.id
        || existing.kind !== AgentRunKind.BACKGROUND_RESEARCH
        || existing.subjectType !== 'lead'
        || existing.subjectId !== leadId
        || existing.inputDigest !== inputDigest
      ) {
        throw new ConflictException('Idempotency key was already used for a different request');
      }
      return { run: existing, created: false };
    }
  }

  private findRun(id: string) {
    return this.prisma.agentRun.findUniqueOrThrow({
      where: { id },
      include: {
        tasks: true,
        authorizations: {
          select: {
            id: true,
            actionType: true,
            status: true,
            expiresAt: true,
            confirmedAt: true,
            consumedAt: true,
            createdAt: true,
          },
        },
      },
    });
  }

  private isRequestKeyConflict(error: unknown) {
    if (!(error instanceof Prisma.PrismaClientKnownRequestError) && !(error && typeof error === 'object')) {
      return false;
    }
    const candidate = error as { code?: string; meta?: { target?: unknown } };
    if (candidate.code !== 'P2002') return false;
    const target = candidate.meta?.target;
    return !target || String(target).includes('requestKey');
  }

  private assertCompanyMembership(user: DeepResearchOperator, companyId: string) {
    if (!user?.id || !user.companies?.some((company) => company.id === companyId)) {
      throw new ForbiddenException('No access to this company');
    }
  }

  private isCompanyAdmin(user: DeepResearchOperator, companyId: string) {
    return user.companies?.some(
      (company) => company.id === companyId && ['company_admin', 'super_admin'].includes(company.role),
    ) ?? false;
  }
}
