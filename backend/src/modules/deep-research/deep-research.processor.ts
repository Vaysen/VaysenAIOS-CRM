import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Job } from 'bullmq';
import { Logger } from '@nestjs/common';
import {
  AgentRunKind,
  AgentRunStatus,
  AgentTaskStatus,
  Prisma,
} from '@prisma/client';
import { PrismaService } from '@/common/prisma/prisma.service';
import { QUEUES } from '@/common/queues/queue-names';
import { safeDigest, safeErrorCategory, safeLogEvent } from '@/common/security/safe-logging';
import { BackgroundCheckAgent } from './background-check.agent';
import { ContactDiscoveryAgent } from './contact-discovery.agent';
import { MarketAnalysisAgent } from './market-analysis.agent';
import { DeepResearchJobData } from './deep-research-run.service';
import { ResearchAgentResult } from './research-agent.types';
import { assessResearchSubject } from './research-subject-policy';

const DEEP_RESEARCH_LOCK_MS = Number(process.env.DEEP_RESEARCH_LOCK_MS || 60 * 60 * 1000);

type ResearchClaim =
  | {
      claimed: true;
      status: AgentRunStatus;
      claimId: string;
      leaseExpiresAt: Date;
    }
  | {
      claimed: false;
      status: AgentRunStatus | undefined;
      claimId: string | null;
      leaseExpiresAt: Date | null;
    };

@Processor(QUEUES.deepResearch, {
  concurrency: Number(process.env.DEEP_RESEARCH_CONCURRENCY || 1),
  lockDuration: DEEP_RESEARCH_LOCK_MS,
  stalledInterval: Number(process.env.DEEP_RESEARCH_STALLED_INTERVAL_MS || 60 * 1000),
  maxStalledCount: Number(process.env.DEEP_RESEARCH_MAX_STALLED || 2),
})
export class DeepResearchProcessor extends WorkerHost {
  private readonly logger = new Logger(DeepResearchProcessor.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly backgroundAgent: BackgroundCheckAgent,
    private readonly contactAgent: ContactDiscoveryAgent,
    private readonly marketAgent: MarketAnalysisAgent,
  ) {
    super();
  }

  async process(job: Job<DeepResearchJobData>, token?: string) {
    const { companyId, agentRunId, leadId, userId, type } = job.data;
    if (!companyId || !agentRunId || !leadId || !userId) {
      throw new Error('Invalid deep-research job scope');
    }

    const run = await this.prisma.agentRun.findFirst({
      where: {
        id: agentRunId,
        companyId,
        operatorUserId: userId,
        kind: AgentRunKind.BACKGROUND_RESEARCH,
        subjectType: 'lead',
        subjectId: leadId,
      },
      include: { tasks: true },
    });
    if (!run) throw new Error('Agent run scope mismatch');
    if (run.status === AgentRunStatus.COMPLETED) return run.result;
    if (run.status === AgentRunStatus.CANCELLED) {
      // Covers a crash after an agent archived its report but before
      // completeRun observed cancellation. A replay must clean that orphan
      // instead of returning while a cancelled report remains visible.
      await this.deleteRunReport(run.id, companyId);
      return { success: false, reason: 'cancelled' };
    }
    const isSameJobRetry = run.status === AgentRunStatus.RUNNING
      && job.attemptsMade > 0
      && Number(job.stalledCounter || 0) === 0
      && !!run.executionClaimId?.startsWith(`${String(job.id)}:`);
    if (
      run.status === AgentRunStatus.RUNNING
      && run.executionLeaseExpiresAt
      && run.executionLeaseExpiresAt > new Date()
      && !isSameJobRetry
    ) {
      // Returning normally would make BullMQ discard a duplicate/stalled job
      // as successful. Throw while the existing lease is live; a genuinely
      // stalled replay can reclaim only after the durable lease expires.
      throw new Error('Deep research execution lease is still active');
    }
    if (
      run.status === AgentRunStatus.FAILED
      && !['RESEARCH_EXECUTION_FAILED', 'RESEARCH_PARTIAL_FAILED'].includes(run.errorCode || '')
    ) {
      return { success: false, reason: 'run is not retryable' };
    }

    const expectedTool = type === 'contacts'
      ? 'research.discover_contacts'
      : type === 'market'
        ? 'research.market_analysis'
        : 'research.background_check';
    if (!run.tasks.some((task) => task.companyId === companyId && task.toolName === expectedTool)) {
      await this.failRun(run.id, companyId, 'RESEARCH_TASK_SCOPE_MISMATCH');
      return { success: false, reason: 'task scope mismatch' };
    }

    const membership = await this.prisma.userCompanyRelation.findFirst({
      where: { userId, companyId, isActive: true },
      include: { role: { select: { name: true } } },
    });
    if (!membership) {
      await this.failRun(run.id, companyId, 'OPERATOR_MEMBERSHIP_REVOKED');
      return { success: false, reason: 'operator membership revoked' };
    }
    const isAdmin = ['company_admin', 'super_admin'].includes(membership.role.name);
    const lead = await this.prisma.lead.findFirst({
      where: {
        id: leadId,
        companyId,
        deletedAt: null,
        ...(isAdmin ? {} : { ownerUserId: userId }),
      },
      include: { contacts: true },
    });
    const subject = lead ? assessResearchSubject(lead) : null;
    if (!lead || !subject?.trusted) {
      await this.failRun(run.id, companyId, 'CUSTOMER_SCOPE_INVALID');
      return { success: false, reason: 'customer scope invalid' };
    }

    const claim = await this.claimRun({
      runId: run.id,
      companyId,
      userId,
      expectedTool,
      jobId: String(job.id),
      attempt: job.attemptsMade + 1,
      type,
      claimId: `${String(job.id)}:${token || `attempt-${job.attemptsMade + 1}`}`,
      allowLiveSameJobRetry: isSameJobRetry,
    });
    if (!claim.claimed) {
      return {
        success: false,
        reason: claim.status === AgentRunStatus.CANCELLED ? 'cancelled' : 'run no longer claimable',
      };
    }

    try {
      const existingReport = await this.prisma.deepResearchReport.findUnique({
        where: { agentRunId },
        select: { id: true, leadId: true, companyId: true, type: true, title: true, jsonData: true },
      });
      if (existingReport) {
        if (existingReport.companyId !== companyId || existingReport.leadId !== leadId) {
          throw new Error('Research report scope mismatch');
        }
        return await this.completeRun(run.id, companyId, claim.claimId, {
          reportId: existingReport.id,
          leadId,
          type: existingReport.type,
          title: existingReport.title,
          partialFailure: this.isPartialFailure(existingReport.jsonData),
        });
      }

      this.logger.log(safeLogEvent('deep_research.execution_started', {
        status: 'active',
        stage: 'dispatch',
        eventType: `research.${type || 'full'}`,
        runRef: safeDigest(agentRunId, 'agent-run'),
      }));
      const options = { agentRunId };
      let research: ResearchAgentResult;
      switch (type) {
        case 'contacts':
          research = await this.contactAgent.discover(lead, userId, options);
          break;
        case 'market':
          research = await this.marketAgent.analyze(lead, userId, options);
          break;
        default:
          research = await this.backgroundAgent.research(lead, userId, options);
      }
      return await this.completeRun(run.id, companyId, claim.claimId, {
        reportId: research.reportId,
        leadId,
        type: type || 'full',
        title: research.title,
        partialFailure: this.isPartialFailure(research.json),
      });
    } catch (error) {
      this.logger.error(safeLogEvent('deep_research.execution_failed', {
        status: 'failed',
        stage: 'dispatch',
        eventType: `research.${type || 'full'}`,
        runRef: safeDigest(run.id, 'agent-run'),
        error,
        errorCategory: safeErrorCategory(error),
      }));
      await this.deleteRunReport(run.id, companyId, claim.claimId);
      await this.failRun(run.id, companyId, 'RESEARCH_EXECUTION_FAILED', undefined, claim.claimId);
      throw error;
    }
  }

  private async claimRun(input: {
    runId: string;
    companyId: string;
    userId: string;
    expectedTool: string;
    jobId: string;
    attempt: number;
    type: string;
    claimId: string;
    allowLiveSameJobRetry: boolean;
  }): Promise<ResearchClaim> {
    const startedAt = new Date();
    const leaseExpiresAt = new Date(startedAt.getTime() + DEEP_RESEARCH_LOCK_MS);
    return this.prisma.$transaction(async (tx) => {
      const claimed = await tx.agentRun.updateMany({
        where: {
          id: input.runId,
          companyId: input.companyId,
          OR: [
            { status: AgentRunStatus.PENDING },
            {
              status: AgentRunStatus.FAILED,
              errorCode: { in: ['RESEARCH_EXECUTION_FAILED', 'RESEARCH_PARTIAL_FAILED'] },
            },
            {
              status: AgentRunStatus.RUNNING,
              OR: [
                { executionLeaseExpiresAt: null },
                { executionLeaseExpiresAt: { lte: startedAt } },
                ...(input.allowLiveSameJobRetry
                  ? [{ executionClaimId: { startsWith: `${input.jobId}:` } }]
                  : []),
              ],
            },
          ],
        },
        data: {
          status: AgentRunStatus.RUNNING,
          errorCode: null,
          completedAt: null,
          startedAt,
          executionClaimId: input.claimId,
          executionLeaseExpiresAt: leaseExpiresAt,
        },
      });
      if (claimed.count !== 1) {
        const current = await tx.agentRun.findUnique({
          where: { id: input.runId },
          select: { status: true, executionClaimId: true, executionLeaseExpiresAt: true },
        });
        return {
          claimed: false,
          status: current?.status,
          claimId: current?.executionClaimId || null,
          leaseExpiresAt: current?.executionLeaseExpiresAt || null,
        } as const;
      }
      const task = await tx.agentTask.updateMany({
        where: {
          runId: input.runId,
          companyId: input.companyId,
          toolName: input.expectedTool,
          status: { in: [AgentTaskStatus.PENDING, AgentTaskStatus.RUNNING, AgentTaskStatus.FAILED] },
        },
        data: {
          status: AgentTaskStatus.RUNNING,
          errorCode: null,
          completedAt: null,
          startedAt,
        },
      });
      if (task.count !== 1) {
        throw new Error('Deep research task was not claimable');
      }
      await tx.agentAuditLog.create({
        data: {
          companyId: input.companyId,
          runId: input.runId,
          actorUserId: input.userId,
          eventType: 'RUN_STARTED',
          metadata: {
            jobId: input.jobId,
            attempt: input.attempt,
            type: input.type,
            executionClaimId: input.claimId,
            leaseExpiresAt: leaseExpiresAt.toISOString(),
          },
        },
      });
      return {
        claimed: true,
        status: AgentRunStatus.RUNNING,
        claimId: input.claimId,
        leaseExpiresAt,
      } as const;
    });
  }

  private async completeRun(
    runId: string,
    companyId: string,
    claimId: string,
    result: {
      reportId: string;
      leadId: string;
      type: string;
      title: string;
      partialFailure: boolean;
    },
  ) {
    if (result.partialFailure) {
      await this.deleteRunReport(runId, companyId, claimId);
      await this.failRun(
        runId,
        companyId,
        'RESEARCH_PARTIAL_FAILED',
        result as unknown as Prisma.InputJsonValue,
        claimId,
      );
      throw new Error('Deep research returned partial evidence');
    }
    const completedAt = new Date();
    const jsonResult = result as unknown as Prisma.InputJsonValue;
    const transition = await this.prisma.$transaction(async (tx) => {
      const claimed = await tx.agentRun.updateMany({
        where: {
          id: runId,
          companyId,
          status: AgentRunStatus.RUNNING,
          executionClaimId: claimId,
        },
        data: {
          status: AgentRunStatus.COMPLETED,
          result: jsonResult,
          errorCode: null,
          completedAt,
          executionClaimId: null,
          executionLeaseExpiresAt: null,
        },
      });
      if (claimed.count !== 1) {
        const current = await tx.agentRun.findUnique({
          where: { id: runId },
          select: { status: true, executionClaimId: true },
        });
        return { claimed: false, status: current?.status };
      }
      await tx.agentTask.updateMany({
        where: {
          runId,
          companyId,
          status: { in: [AgentTaskStatus.PENDING, AgentTaskStatus.RUNNING] },
        },
        data: { status: AgentTaskStatus.COMPLETED, result: jsonResult, completedAt },
      });
      await tx.agentAuditLog.create({
        data: {
          companyId,
          runId,
          eventType: 'RUN_COMPLETED',
          metadata: { reportId: result.reportId, type: result.type, externalSideEffect: false },
        },
      });
      return { claimed: true, status: AgentRunStatus.COMPLETED };
    });
    if (!transition.claimed) {
      if (transition.status === AgentRunStatus.CANCELLED) {
        await this.deleteRunReport(runId, companyId, claimId);
      }
      return {
        success: false,
        reason: transition.status === AgentRunStatus.CANCELLED ? 'cancelled' : 'run no longer executable',
        ...result,
      };
    }
    return { success: true, ...result };
  }

  private async failRun(
    runId: string,
    companyId: string,
    errorCode: string,
    result?: Prisma.InputJsonValue,
    claimId?: string,
  ) {
    const completedAt = new Date();
    await this.prisma.$transaction(async (tx) => {
      const claimed = await tx.agentRun.updateMany({
        where: {
          id: runId,
          companyId,
          ...(claimId
            ? { status: AgentRunStatus.RUNNING, executionClaimId: claimId }
            : {
                OR: [
                  { status: AgentRunStatus.PENDING },
                  {
                    status: AgentRunStatus.RUNNING,
                    OR: [
                      { executionLeaseExpiresAt: null },
                      { executionLeaseExpiresAt: { lte: completedAt } },
                    ],
                  },
                ],
              }),
        },
        data: {
          status: AgentRunStatus.FAILED,
          errorCode,
          result,
          completedAt,
          executionClaimId: null,
          executionLeaseExpiresAt: null,
        },
      });
      if (claimed.count !== 1) return false;
      // A worker may crash after an agent archived a report but before the run
      // reached COMPLETED. Every transition to FAILED removes that scoped
      // report in the same transaction, so revoked access or an invalidated
      // customer identity cannot leave publishable research data behind.
      await tx.deepResearchReport.deleteMany({
        where: { agentRunId: runId, companyId },
      });
      await tx.agentTask.updateMany({
        where: {
          runId,
          companyId,
          status: { in: [AgentTaskStatus.PENDING, AgentTaskStatus.RUNNING] },
        },
        data: { status: AgentTaskStatus.FAILED, errorCode, result, completedAt },
      });
      await tx.agentAuditLog.create({
        data: { companyId, runId, eventType: 'RUN_FAILED', metadata: { errorCode } },
      });
      return true;
    });
  }

  private async deleteRunReport(runId: string, companyId: string, claimId?: string) {
    if (claimId) {
      const current = await this.prisma.agentRun.findUnique({
        where: { id: runId },
        select: { status: true, executionClaimId: true },
      });
      if (
        current?.status !== AgentRunStatus.CANCELLED
        && current?.executionClaimId !== claimId
      ) {
        return;
      }
    }
    await this.prisma.deepResearchReport.deleteMany({
      where: { agentRunId: runId, companyId },
    });
  }

  private isPartialFailure(value: unknown) {
    return !!value
      && typeof value === 'object'
      && (value as Record<string, unknown>).status === 'PartialFailed';
  }
}
