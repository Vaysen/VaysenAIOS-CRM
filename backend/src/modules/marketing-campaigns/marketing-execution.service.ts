/**
 * marketing-execution.service.ts
 *
 * wesley-ai-crm 批次2：投放执行侧。
 * - capabilities：执行能力清单（十道闸 + 渠道 + 状态机）
 * - preview-gate：对一次拟投放做十道闸预览（不落库、不实际发送）
 * - preview-recovery：对 FAILED/BLOCKED 的 DeliveryRun 给出放行缺口与恢复建议
 *
 * R111 批次C：真实发送由 marketing-delivery 队列（worker-marketing-delivery）执行
 * （channel=whatsapp 时经 WhatsAppService.sendTextWithReceipt 走合规链），
 * 本服务仍负责闸门评估/预览/恢复与 DeliveryRun 状态机能力。
 */

import { createHash } from 'node:crypto';
import { Injectable, NotFoundException } from '@nestjs/common';
import { MarketingDeliveryRunStatus, Prisma } from '@prisma/client';
import { PrismaService } from '../../common/prisma/prisma.service';
import {
  CurrentUser,
  requireActiveCompany,
} from '../../common/utils/data-isolation';
import { MarketingCampaignsService } from './marketing-campaigns.service';
import { MARKETING_EXECUTION_GATES } from './marketing-execution.contract';
import {
  TERMINAL_DELIVERY_STATES,
  RETRYABLE_DELIVERY_STATES,
  InvalidDeliveryTransitionError,
  transitionDeliveryRunState,
} from './marketing-delivery-state-machine';
import {
  materializeMarketingScheduleIntent,
  evaluateMarketingScheduleAt,
} from './marketing-scheduling.service';
import { PreviewGateDto, PreviewRecoveryDto } from './dto/preview-gate.dto';

const RECOVERY_ADVICE: Record<string, string> = {
  migration: '等待 marketing-campaigns 迁移部署后重试',
  executionEnabled: '在环境中开启 MARKETING_EXECUTION_ENABLED 后重试',
  nodeWhitelist: '将当前节点加入 MARKETING_EXECUTION_NODE_WHITELIST 白名单',
  accountReady: '为对应渠道配置就绪的发送账号（email 渠道需 active 且 accountRole=MARKETING 的营销邮箱；WhatsApp 需 connected 会话）',
  consent: '为该触点+渠道补录 GRANTED 同意（/marketing-preferences/consents）',
  suppression: '该触点/Lead 处于退订或抑制名单，需解除抑制后重试',
  killSwitch: '合规 kill-switch 已激活，先停用（/marketing-safety/kill-switches）',
  approval: '活动需先进入 APPROVED_PLAN 状态（/marketing-campaigns/:id/transitions approve）',
  frequency: '频控已超限（maxPerContact），请等待窗口重置或提高频控上限',
  window: '当前不在排程窗口内，请等待窗口打开后重试',
};

@Injectable()
export class MarketingExecutionService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly campaigns: MarketingCampaignsService,
  ) {}

  async capabilities(user: CurrentUser) {
    requireActiveCompany(user);
    return {
      gates: MARKETING_EXECUTION_GATES,
      channels: ['email', 'whatsapp'],
      deliveryStateMachine: {
        states: Object.values(MarketingDeliveryRunStatus),
        terminal: [...TERMINAL_DELIVERY_STATES],
        retryable: [...RETRYABLE_DELIVERY_STATES],
        transitions: 'PENDING → WAITING/AWAITING_APPROVAL/READY/CLAIMED/UNKNOWN → SUCCEEDED/FAILED/BLOCKED/DEAD_LETTER',
      },
      scheduling: {
        materialize: 'materializeMarketingScheduleIntent',
        evaluate: 'evaluateMarketingScheduleAt',
      },
      queueWorker: {
        // R111 批次C：channel=whatsapp 由 marketing-delivery 队列执行器消费
        marketingDelivery: true,
        email: false, // email 渠道暂无执行器（沿用批次2：仅闸门评估）
      },
    };
  }

  /** 拟投放预览：跑十道闸（不落库） */
  async previewGate(dto: PreviewGateDto, user: CurrentUser) {
    const { ctx, result } = await this.campaigns.evaluateGate(dto.campaignId, user, {
      contactRef: dto.contactRef,
      channel: dto.channel,
      leadId: dto.leadId,
      contactPointId: dto.contactPointId,
      channelPlanId: dto.channelPlanId,
    });
    return {
      campaignId: dto.campaignId,
      contactRef: ctx.contactRef,
      channel: ctx.channel,
      passed: result.passed,
      failedGates: result.failedGates,
      checks: result.checks,
      campaignStatus: ctx.campaignStatus,
    };
  }

  /** 恢复预览：针对 FAILED/BLOCKED 投放运行给出缺口与恢复建议 */
  async previewRecovery(dto: PreviewRecoveryDto, user: CurrentUser) {
    const company = requireActiveCompany(user);
    let runContactRef = dto.contactRef;
    let runChannel = dto.channel;
    let runStatus: MarketingDeliveryRunStatus | null = null;

    if (dto.deliveryRunId) {
      const run = await this.prisma.marketingDeliveryRun.findFirst({
        where: { id: dto.deliveryRunId, companyId: company.id },
        select: { status: true, contactRef: true, channel: true, campaignId: true },
      });
      if (!run) {
        return {
          campaignId: dto.campaignId,
          error: 'Delivery run not found',
        };
      }
      runStatus = run.status;
      runContactRef = runContactRef ?? run.contactRef;
      runChannel = runChannel ?? run.channel;
    }

    const { ctx, result } = await this.campaigns.evaluateGate(dto.campaignId, user, {
      contactRef: runContactRef,
      channel: runChannel,
      leadId: dto.leadId,
      contactPointId: dto.contactPointId,
      channelPlanId: dto.channelPlanId,
    });

    const recovery = result.checks
      .filter((c) => !c.passed)
      .map((c) => ({
        gate: c.gate,
        blockedReason: c.blockedReason,
        advice: RECOVERY_ADVICE[c.gate] ?? '人工核查后重试',
      }));

    let nextAction = 'none';
    if (result.passed) {
      nextAction = 'release';
    } else if (runStatus && RETRYABLE_DELIVERY_STATES.has(runStatus)) {
      nextAction = 'retry_after_fix';
    }

    return {
      campaignId: dto.campaignId,
      deliveryRunId: dto.deliveryRunId ?? null,
      deliveryRunStatus: runStatus,
      passed: result.passed,
      failedGates: result.failedGates,
      recovery,
      nextAction,
    };
  }

  /**
   * 创建 DeliveryRun（供排程器/人工触发）：状态机 PENDING 起步，写入 payloadHash 证据。
   * 属内部辅助：本模块不注册 worker，仅提供状态机能力。
   */
  async createDeliveryRun(
    campaignId: string,
    user: CurrentUser,
    input: {
      contactRef: string;
      channel: string;
      leadId?: string | null;
      contactPointId?: string | null;
      channelPlanId?: string | null;
      payload?: Record<string, unknown>;
      scheduledFor?: Date;
    },
  ) {
    const company = requireActiveCompany(user);
    const campaign = await this.prisma.marketingCampaign.findFirst({
      where: { id: campaignId, companyId: company.id },
      select: { id: true },
    });
    if (!campaign) {
      throw new NotFoundException('Marketing campaign not found');
    }
    const payloadHash = input.payload
      ? `sha256:${createHash('sha256').update(JSON.stringify(input.payload)).digest('hex')}`
      : null;
    return this.prisma.marketingDeliveryRun.create({
      data: {
        companyId: company.id,
        campaignId,
        channelPlanId: input.channelPlanId ?? null,
        leadId: input.leadId ?? null,
        contactPointId: input.contactPointId ?? null,
        contactRef: input.contactRef,
        channel: input.channel.toLowerCase(),
        status: MarketingDeliveryRunStatus.PENDING,
        payloadJson:
          input.payload == null
            ? Prisma.DbNull
            : (input.payload as Prisma.InputJsonValue),
        payloadHash,
        scheduledFor: input.scheduledFor ?? null,
      },
    });
  }

  /**
   * DeliveryRun 状态转移（乐观并发 + 状态机校验）。
   */
  async transitionDeliveryRun(runId: string, to: MarketingDeliveryRunStatus, user: CurrentUser) {
    const company = requireActiveCompany(user);
    const run = await this.prisma.marketingDeliveryRun.findFirst({
      where: { id: runId, companyId: company.id },
    });
    if (!run) {
      throw new NotFoundException('Delivery run not found');
    }
    const next = transitionDeliveryRunState(run.status, to);
    const updated = await this.prisma.marketingDeliveryRun.updateMany({
      where: { id: runId, companyId: company.id, status: run.status },
      data: { status: next, attemptCount: to === MarketingDeliveryRunStatus.FAILED ? { increment: 1 } : undefined },
    });
    if (updated.count !== 1) {
      throw new InvalidDeliveryTransitionError(run.status, to);
    }
    return this.prisma.marketingDeliveryRun.findUniqueOrThrow({ where: { id: runId } });
  }

  /** 排程窗口预览：给定意图的窗口与此刻评估 */
  schedulePreview(user: CurrentUser, intent: { channel: string; windowStart?: string; windowEnd?: string; windowSeconds?: number; maxPerContact?: number }) {
    requireActiveCompany(user);
    const materialized = materializeMarketingScheduleIntent({
      channel: intent.channel,
      windowStart: intent.windowStart ?? null,
      windowEnd: intent.windowEnd ?? null,
      windowSeconds: intent.windowSeconds ?? 0,
      maxPerContact: intent.maxPerContact ?? 1,
    });
    const evaluation = evaluateMarketingScheduleAt({ intent: materialized });
    return {
      window: {
        start: materialized.window.start.toISOString(),
        end: materialized.window.end.toISOString(),
      },
      windowSeconds: materialized.windowSeconds,
      maxPerContact: materialized.maxPerContact,
      slotCount: materialized.slots.length,
      evaluation,
    };
  }

  /**
   * R111 批次D：投放运行列表（数据看板）。
   * Query：limit（默认 20）、campaignId（可选）、status（可选）。
   * 返回 runs 列表（join 活动名）+ statusDistribution（全量非分页，按 status groupBy）。
   */
  async getDeliveryRuns(user: CurrentUser, query: { limit?: string | number; campaignId?: string; status?: string } = {}) {
    const company = requireActiveCompany(user);
    const limit = Math.max(1, Math.min(100, Number(query?.limit || 20) || 20));
    const where: any = { companyId: company.id };
    if (query?.campaignId) where.campaignId = query.campaignId;
    if (query?.status) where.status = query.status;

    const [runs, statusGroups] = await Promise.all([
      this.prisma.marketingDeliveryRun.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        take: limit,
        select: {
          id: true,
          campaignId: true,
          channel: true,
          status: true,
          totalCount: true,
          processedCount: true,
          lastError: true,
          executedAt: true,
          createdAt: true,
          campaign: { select: { name: true } },
        },
      }),
      this.prisma.marketingDeliveryRun.groupBy({
        by: ['status'],
        where: { companyId: company.id },
        _count: true,
      }),
    ]);

    return {
      runs: runs.map((run) => ({
        id: run.id,
        campaignId: run.campaignId,
        campaignName: run.campaign?.name ?? null,
        channel: run.channel,
        status: run.status,
        totalCount: run.totalCount,
        processedCount: run.processedCount,
        lastError: run.lastError,
        executedAt: run.executedAt,
        createdAt: run.createdAt,
      })),
      statusDistribution: statusGroups.map((g) => ({ status: g.status, count: g._count })),
    };
  }
}
