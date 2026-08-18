/**
 * marketing-delivery.processor.ts
 *
 * R111 批次C：WhatsApp 批量营销执行器（BullMQ worker，队列 marketing-delivery，
 * 独立进程 worker-marketing-delivery）。
 *
 * 职责（任务包 36-r111-batchC）：
 * - 读取 MarketingDeliveryRun → campaign（channel=whatsapp）→ 快照成员（eligible）
 * - 按账号串行：sendIntervalSeconds 间隔 + 每小时/每日上限（超限暂停任务、延迟重入队）
 * - 逐成员：触点级十道闸复评（consent/suppression/frequency；killSwitch 等
 *   活动级闸门失败则整 run BLOCKED）→ 模板渲染（{name}/{company}/{product}）→
 *   确保会话锚点 → WhatsAppService.sendTextWithReceipt
 *   （幂等键 campaign:<runId>:<memberId>，复用 OutboundComplianceService 幂等+租约+回执）
 * - 单条失败重试 2 次，仍失败记 FAILED 不中断任务
 * - 状态机：PENDING→CLAIMED→SUCCEEDED / FAILED / BLOCKED / DEAD_LETTER
 * - 安全开关 WHATSAPP_BROADCAST_DISABLED=true（默认）→ 直接 BLOCKED 拒绝
 */

import { Processor, WorkerHost, InjectQueue } from '@nestjs/bullmq';
import { Job, Queue } from 'bullmq';
import { Logger } from '@nestjs/common';
import {
  ExternalActionStatus,
  MarketingDeliveryRunStatus,
  Prisma,
} from '@prisma/client';
import { PrismaService } from '../../common/prisma/prisma.service';
import { QUEUES } from '../../common/queues/queue-names';
import { isWhatsappBroadcastDisabled } from '../../common/queues/whatsapp-broadcast-switch';
import { WhatsAppService } from '../whatsapp/whatsapp.service';
import { MarketingCampaignsService } from './marketing-campaigns.service';
import { transitionDeliveryRunState } from './marketing-delivery-state-machine';

type DeliverJob = {
  runId: string;
  campaignId: string;
  companyId: string;
  whatsappSessionId: string;
  enqueuedByUserId: string;
};

type MemberOutcome =
  | { status: 'sent' }
  | { status: 'failed'; reason: string }
  | { status: 'blocked'; reason: string }
  | { status: 'skipped'; reason?: string };

/** 活动级闸门：任一失败 → 整 run BLOCKED（沿用十道闸语义） */
const CAMPAIGN_LEVEL_GATES = new Set([
  'migration',
  'executionEnabled',
  'nodeWhitelist',
  'accountReady',
  'killSwitch',
  'approval',
  'window',
]);
// 触点级闸门（consent/suppression/frequency）失败 → 成员记 blocked 继续（不中断任务），
// 由下方 failedChecks 分支统一处理：非活动级闸门失败即成员级拦截。

/** ExternalActionOutbox 有效发送状态（与 OutboundComplianceService.ACTIVE_STATES 一致） */
const ACTIVE_OUTBOX_STATES: ExternalActionStatus[] = [
  ExternalActionStatus.PENDING,
  ExternalActionStatus.EXECUTING,
  ExternalActionStatus.SUCCEEDED,
];

const MAX_MEMBER_RETRIES = 2; // 单条失败重试 2 次（共 3 次尝试）

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

/** 模板变量渲染：{name}/{company}/{product} ← Lead.leadName/companyName/productCategory */
function renderTemplate(
  body: string,
  lead: { leadName?: string | null; companyName?: string | null; productCategory?: string | null } | null | undefined,
): string {
  if (!body) return body;
  const vars: Record<string, string> = {
    name: lead?.leadName?.trim() || '',
    company: lead?.companyName?.trim() || '',
    product: lead?.productCategory?.trim() || '',
  };
  return body.replace(/\{(name|company|product)\}/g, (_match, key: string) => vars[key] ?? '');
}

@Processor(QUEUES.marketingDelivery, { concurrency: 1 })
export class MarketingDeliveryProcessor extends WorkerHost {
  private readonly logger = new Logger(MarketingDeliveryProcessor.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly whatsapp: WhatsAppService,
    private readonly campaigns: MarketingCampaignsService,
    @InjectQueue(QUEUES.marketingDelivery) private readonly deliveryQueue: Queue,
  ) {
    super();
  }

  async process(job: Job<DeliverJob>): Promise<any> {
    const { runId } = job.data;
    const run = await this.prisma.marketingDeliveryRun.findUnique({
      where: { id: runId },
      include: {
        campaign: {
          include: {
            channelPlans: true,
            contentVersions: {
              where: { isActive: true },
              orderBy: { version: 'desc' },
              take: 1,
            },
            audienceSnapshot: {
              include: {
                members: {
                  where: { status: 'eligible' },
                  include: { lead: true, contactPoint: true },
                },
              },
            },
          },
        },
      },
    });
    if (!run) {
      return { success: false, reason: 'Delivery run not found' };
    }
    if (
      run.status === MarketingDeliveryRunStatus.SUCCEEDED
      || run.status === MarketingDeliveryRunStatus.DEAD_LETTER
      || run.status === MarketingDeliveryRunStatus.BLOCKED
    ) {
      return { success: true, reason: `Run is already terminal/blocked: ${run.status}` };
    }

    try {
      return await this.executeDelivery(job, run as any);
    } catch (err) {
      const message = errorMessage(err);
      // 保留 BullMQ 重试语义：未达尝试上限 → run 保持 CLAIMED，抛出让队列重试（恢复时跳过已发成员）；
      // 已达上限 → DEAD_LETTER 终态。
      const attemptsLeft = (job.opts.attempts ?? 3) - job.attemptsMade - 1;
      if (attemptsLeft <= 0) {
        await this.transitionRun(
          run.id,
          run.companyId,
          MarketingDeliveryRunStatus.DEAD_LETTER,
          { lastError: `DEAD_LETTER: ${message}`, executedAt: new Date() },
        ).catch(() => undefined);
        return { success: false, status: 'DEAD_LETTER', reason: message };
      }
      await this.prisma.marketingDeliveryRun.updateMany({
        where: { id: run.id, companyId: run.companyId },
        data: { lastError: `retryable: ${message}` },
      }).catch(() => undefined);
      throw err;
    }
  }

  private async executeDelivery(job: Job<DeliverJob>, run: any): Promise<any> {
    const { campaignId, companyId, enqueuedByUserId } = job.data;
    const campaign = run.campaign;

    // 安全开关：worker 侧再次兜底（入队侧已拦截；防止配置热变更/直投）
    if (this.broadcastDisabled()) {
      await this.transitionRun(run.id, companyId, MarketingDeliveryRunStatus.BLOCKED, {
        lastError: 'WHATSAPP_BROADCAST_DISABLED',
        executedAt: new Date(),
      });
      return { success: false, status: 'BLOCKED', reason: 'WHATSAPP_BROADCAST_DISABLED' };
    }

    if (!campaign || campaign.channel !== 'whatsapp') {
      await this.transitionRun(run.id, companyId, MarketingDeliveryRunStatus.FAILED, {
        lastError: 'CAMPAIGN_NOT_WHATSAPP',
        executedAt: new Date(),
      });
      return { success: false, status: 'FAILED', reason: 'campaign is not whatsapp' };
    }

    // 认领：PENDING/WAITING/READY/CLAIMED → CLAIMED（乐观并发，同状态视为幂等重入）
    const claim = await this.prisma.marketingDeliveryRun.updateMany({
      where: {
        id: run.id,
        companyId,
        status: {
          in: [
            MarketingDeliveryRunStatus.PENDING,
            MarketingDeliveryRunStatus.WAITING,
            MarketingDeliveryRunStatus.READY,
            MarketingDeliveryRunStatus.CLAIMED,
          ],
        },
      },
      data: {
        status: MarketingDeliveryRunStatus.CLAIMED,
        claimedAt: new Date(),
        attemptCount: { increment: 1 },
      },
    });
    if (claim.count !== 1) {
      return { success: false, reason: 'Run could not be claimed (already terminal or claimed elsewhere)' };
    }

    // 账号：优先 job 指定的会话，其次公司任意 connected 会话
    let session = await this.prisma.whatsAppSession.findFirst({
      where: { id: job.data.whatsappSessionId, companyId, status: 'connected' },
    });
    if (!session) {
      session = await this.prisma.whatsAppSession.findFirst({
        where: { companyId, status: 'connected' },
        orderBy: { createdAt: 'asc' },
      });
    }
    if (!session) {
      await this.transitionRun(run.id, companyId, MarketingDeliveryRunStatus.BLOCKED, {
        lastError: 'ACCOUNT_NOT_READY: no connected whatsapp account',
        executedAt: new Date(),
      });
      return { success: false, status: 'BLOCKED', reason: 'no connected whatsapp account' };
    }

    const content = campaign.contentVersions?.[0];
    if (!content || !String(content.body || '').trim()) {
      await this.transitionRun(run.id, companyId, MarketingDeliveryRunStatus.FAILED, {
        lastError: 'NO_ACTIVE_CONTENT_VERSION',
        executedAt: new Date(),
      });
      return { success: false, status: 'FAILED', reason: 'no active content version' };
    }

    const members = campaign.audienceSnapshot?.members ?? [];
    if (members.length === 0) {
      await this.transitionRun(run.id, companyId, MarketingDeliveryRunStatus.SUCCEEDED, {
        lastError: 'NO_ELIGIBLE_MEMBERS',
        executedAt: new Date(),
        processedCount: 0,
      });
      return { success: true, status: 'SUCCEEDED', summary: { sent: 0, failed: 0, blocked: 0 } };
    }

    // 幂等恢复：跳过本 run 已成功发送的成员（ExternalActionOutbox 已落 SUCCEEDED）
    const existingOutbox = await this.prisma.externalActionOutbox.findMany({
      where: {
        companyId,
        idempotencyKey: { startsWith: `campaign:${run.id}:` },
      },
      select: { idempotencyKey: true, status: true },
    });
    const sentMemberIds = new Set(
      existingOutbox
        .filter((row) => row.status === ExternalActionStatus.SUCCEEDED)
        .map((row) => row.idempotencyKey.split(':').pop() || ''),
    );

    const operatorUser = {
      id: enqueuedByUserId,
      activeCompanyId: companyId,
      activeCompany: { id: companyId },
    };

    const account = {
      id: session.id,
      sendLimitPerHour: session.sendLimitPerHour ?? 60,
      sendLimitDaily: session.sendLimitDaily ?? 300,
      sendIntervalSeconds: session.sendIntervalSeconds ?? 8,
    };

    const basePayload = (run.payloadJson ?? {}) as Record<string, unknown>;
    const summary: { sent: number; failed: number; blocked: number; skipped: number; byMember: Record<string, MemberOutcome> } = {
      sent: 0,
      failed: 0,
      blocked: 0,
      skipped: 0,
      byMember: {},
    };
    let processed = 0;
    let lastSentAtMs = session.lastSentAt ? new Date(session.lastSentAt).getTime() : 0;

    for (const member of members) {
      if (sentMemberIds.has(member.id)) {
        summary.skipped += 1;
        summary.byMember[member.id] = { status: 'skipped', reason: 'already sent (idempotent resume)' };
        processed += 1;
        await this.writeProgress(run.id, processed, basePayload, summary);
        continue;
      }

      // ---- 每账号限速：每小时/每日上限（超限 → 暂停任务，延迟到窗口重置后重入队）----
      const usage = await this.accountUsage(companyId, session.id);
      if (usage.hourly >= account.sendLimitPerHour || usage.daily >= account.sendLimitDaily) {
        const delayMs = this.nextWindowDelayMs(usage, account.sendLimitPerHour, account.sendLimitDaily);
        await this.writeProgress(run.id, processed, basePayload, summary);
        this.logger.warn(
          `marketing-delivery rate-limited: run=${run.id} account=${session.id} ` +
          `hourly=${usage.hourly}/${account.sendLimitPerHour} daily=${usage.daily}/${account.sendLimitDaily} ` +
          `pauseMs=${delayMs}`,
        );
        await this.deliveryQueue.add(
          'deliver',
          job.data,
          {
            delay: delayMs,
            attempts: 3,
            backoff: { type: 'exponential', delay: 15000 },
            removeOnComplete: 100,
            removeOnFail: 100,
          },
        );
        return {
          success: false,
          paused: true,
          reason: `rate-limited (hourly=${usage.hourly}/${account.sendLimitPerHour}, daily=${usage.daily}/${account.sendLimitDaily})`,
          retryInMs: delayMs,
        };
      }

      // ---- 每账号串行 + sendIntervalSeconds 间隔 ----
      const nowMs = Date.now();
      const nextAllowedMs = lastSentAtMs + account.sendIntervalSeconds * 1000;
      if (nextAllowedMs > nowMs) {
        await sleep(nextAllowedMs - nowMs);
      }

      // ---- 触点级十道闸复评（consent/suppression/frequency；killSwitch 等活动级 → 整 run BLOCKED）----
      const gate = await this.campaigns.evaluateGate(campaignId, operatorUser as any, {
        channel: 'whatsapp',
        contactRef: member.contactRef,
        leadId: member.leadId ?? undefined,
        contactPointId: member.contactPointId ?? undefined,
      });
      const failedChecks = gate.result.checks.filter((check) => !check.passed);
      const campaignLevelFailure = failedChecks.find((check) => CAMPAIGN_LEVEL_GATES.has(check.gate));
      if (campaignLevelFailure) {
        await this.transitionRun(run.id, companyId, MarketingDeliveryRunStatus.BLOCKED, {
          lastError: `GATE_BLOCKED:${campaignLevelFailure.gate}: ${campaignLevelFailure.blockedReason ?? ''}`,
          executedAt: new Date(),
        });
        return {
          success: false,
          status: 'BLOCKED',
          reason: `gate:${campaignLevelFailure.gate}: ${campaignLevelFailure.blockedReason ?? ''}`,
        };
      }
      if (failedChecks.length > 0) {
        summary.blocked += 1;
        summary.byMember[member.id] = {
          status: 'blocked',
          reason: failedChecks.map((c) => `${c.gate}:${c.blockedReason ?? ''}`).join('; '),
        };
        processed += 1;
        await this.writeProgress(run.id, processed, basePayload, summary);
        continue;
      }

      // ---- 模板渲染 ----
      const body = renderTemplate(String(content.body || ''), member.lead);

      // ---- 确保会话锚点（threadKey 与入站/人工发送一致；随后由合规链校验，不绕过）----
      let conversationId: string;
      try {
        const conv = await this.whatsapp.ensureOutboundConversation({
          companyId,
          whatsappSessionId: session.id,
          leadId: member.leadId,
          contactPointId: member.contactPointId,
          phone: member.contactRef,
        });
        conversationId = conv.conversationId;
      } catch (err) {
        summary.failed += 1;
        summary.byMember[member.id] = { status: 'failed', reason: `conversation: ${errorMessage(err)}` };
        processed += 1;
        await this.writeProgress(run.id, processed, basePayload, summary);
        continue;
      }

      // ---- 发送：复用 sendTextWithReceipt（OutboundComplianceService 幂等+租约+回执），单条重试 2 次 ----
      let sent = false;
      let lastError: string | null = null;
      for (let attempt = 0; attempt <= MAX_MEMBER_RETRIES; attempt += 1) {
        try {
          await this.whatsapp.sendTextWithReceipt(session.id, member.contactRef, body, operatorUser, {
            idempotencyKey: `campaign:${run.id}:${member.id}`,
            leadId: member.leadId || '',
            conversationId,
            actorType: 'HUMAN',
            actionType: 'WHATSAPP_TEXT',
          });
          sent = true;
          break;
        } catch (err) {
          lastError = errorMessage(err);
          if (attempt < MAX_MEMBER_RETRIES) {
            await sleep(2000 * (attempt + 1));
          }
        }
      }

      if (sent) {
        summary.sent += 1;
        summary.byMember[member.id] = { status: 'sent' };
        lastSentAtMs = Date.now();
        await this.prisma.whatsAppSession.update({
          where: { id: session.id },
          data: { lastSentAt: new Date(lastSentAtMs) },
        }).catch(() => undefined);
      } else {
        summary.failed += 1;
        summary.byMember[member.id] = { status: 'failed', reason: lastError ?? 'unknown send failure' };
      }
      processed += 1;
      await this.writeProgress(run.id, processed, basePayload, summary);
    }

    // ---- 完成 ----
    await this.transitionRun(run.id, companyId, MarketingDeliveryRunStatus.SUCCEEDED, {
      lastError: summary.failed > 0
        ? `${summary.failed} member(s) failed, ${summary.blocked} member(s) blocked`
        : summary.blocked > 0
          ? `${summary.blocked} member(s) blocked`
          : null,
      executedAt: new Date(),
      processedCount: processed,
    });
    await this.writeProgress(run.id, processed, basePayload, summary);
    return { success: true, status: 'SUCCEEDED', summary: { sent: summary.sent, failed: summary.failed, blocked: summary.blocked, skipped: summary.skipped } };
  }

  /** 每账号用量：ExternalActionOutbox（channel=WHATSAPP + providerScope=whatsapp:<sessionId>）滚动窗口计数 */
  private async accountUsage(
    companyId: string,
    sessionId: string,
  ): Promise<{
    hourly: number;
    daily: number;
    oldestHourlyAt: number;
    oldestDailyAt: number;
  }> {
    const hourStart = new Date(Date.now() - 60 * 60 * 1000);
    const dayStart = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const baseWhere = {
      companyId,
      channel: 'WHATSAPP' as const,
      providerScope: `whatsapp:${sessionId}`,
      status: { in: ACTIVE_OUTBOX_STATES },
    };
    const [hourly, daily, oldestHourly, oldestDaily] = await Promise.all([
      this.prisma.externalActionOutbox.count({
        where: { ...baseWhere, createdAt: { gte: hourStart } },
      }),
      this.prisma.externalActionOutbox.count({
        where: { ...baseWhere, createdAt: { gte: dayStart } },
      }),
      this.prisma.externalActionOutbox.findFirst({
        where: { ...baseWhere, createdAt: { gte: hourStart } },
        orderBy: { createdAt: 'asc' },
        select: { createdAt: true },
      }),
      this.prisma.externalActionOutbox.findFirst({
        where: { ...baseWhere, createdAt: { gte: dayStart } },
        orderBy: { createdAt: 'asc' },
        select: { createdAt: true },
      }),
    ]);
    return {
      hourly,
      daily,
      oldestHourlyAt: oldestHourly?.createdAt?.getTime() ?? 0,
      oldestDailyAt: oldestDaily?.createdAt?.getTime() ?? 0,
    };
  }

  /**
   * 超限后最早可重试时刻：滚动窗口内最老一条记录滑出窗口（oldestAt + 窗口）即可能降到上限以下；
   * 加 30s 缓冲，最小 60s。
   */
  private nextWindowDelayMs(
    usage: { hourly: number; daily: number; oldestHourlyAt: number; oldestDailyAt: number },
    hourlyLimit: number,
    dailyLimit: number,
  ): number {
    const now = Date.now();
    let resetAt = 0;
    if (usage.hourly >= hourlyLimit && usage.oldestHourlyAt > 0) {
      resetAt = Math.max(resetAt, usage.oldestHourlyAt + 60 * 60 * 1000);
    }
    if (usage.daily >= dailyLimit && usage.oldestDailyAt > 0) {
      resetAt = Math.max(resetAt, usage.oldestDailyAt + 24 * 60 * 60 * 1000);
    }
    if (resetAt === 0) resetAt = now;
    return Math.max(60_000, resetAt - now + 30_000);
  }

  private async writeProgress(runId: string, processed: number, basePayload: Record<string, unknown>, summary: any) {
    await this.prisma.marketingDeliveryRun.update({
      where: { id: runId },
      data: {
        processedCount: processed,
        payloadJson: {
          ...basePayload,
          summary,
          updatedAt: new Date().toISOString(),
        } as Prisma.InputJsonValue,
      },
    }).catch(() => undefined);
  }

  /** 状态机转移（校验合法转移；同状态幂等 no-op） */
  private async transitionRun(
    runId: string,
    companyId: string,
    to: MarketingDeliveryRunStatus,
    extra: { lastError?: string | null; executedAt?: Date; processedCount?: number } = {},
  ) {
    const current = await this.prisma.marketingDeliveryRun.findFirst({
      where: { id: runId, companyId },
      select: { status: true },
    });
    if (!current) return;
    const next = transitionDeliveryRunState(current.status, to);
    await this.prisma.marketingDeliveryRun.updateMany({
      where: { id: runId, companyId, status: current.status },
      data: {
        status: next,
        ...(extra.lastError !== undefined ? { lastError: extra.lastError } : {}),
        ...(extra.executedAt ? { executedAt: extra.executedAt } : {}),
        ...(extra.processedCount !== undefined ? { processedCount: extra.processedCount } : {}),
      },
    });
  }

  private broadcastDisabled(): boolean {
    return isWhatsappBroadcastDisabled();
  }
}
