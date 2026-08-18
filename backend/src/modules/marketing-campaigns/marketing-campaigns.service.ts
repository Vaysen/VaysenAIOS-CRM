/**
 * marketing-campaigns.service.ts
 *
 * wesley-ai-crm 批次2：营销活动管理。
 * - 活动 CRUD + 状态机（DRAFT→PLANNING→IN_REVIEW→APPROVED_PLAN，非终态可 PAUSED）
 * - ChannelPlan 管理、受众快照、内容版本、preflight 运行、归因
 * - 所有写操作租户隔离（requireActiveCompany + hasFullAccess + 角色校验）
 */

import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { createHash } from 'node:crypto';
import { hostname } from 'node:os';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import {
  ContactPoint,
  MarketingCampaignStatus,
  MarketingCampaignEventKind,
  MarketingDeliveryRunStatus,
  MarketingPreflightStatus,
  Prisma,
} from '@prisma/client';
import { PrismaService } from '../../common/prisma/prisma.service';
import { QUEUES } from '../../common/queues/queue-names';
import { isWhatsappBroadcastDisabled } from '../../common/queues/whatsapp-broadcast-switch';
import {
  CurrentUser,
  hasFullAccess,
  requireActiveCompany,
} from '../../common/utils/data-isolation';
import { AiProviderService } from '../../common/ai/ai-provider.service';
import { EmailAccountsService } from '../email-accounts/email-accounts.service';
import {
  materializeMarketingScheduleIntent,
  evaluateMarketingScheduleAt,
} from './marketing-scheduling.service';
import {
  MarketingExecutionContext,
  evaluateMarketingExecutionContract,
} from './marketing-execution.contract';
import { CreateMarketingCampaignDto } from './dto/create-marketing-campaign.dto';
import { UpdateMarketingCampaignDto } from './dto/update-marketing-campaign.dto';
import {
  CAMPAIGN_TRANSITION_ACTIONS,
  CampaignTransitionAction,
  CampaignTransitionDto,
} from './dto/campaign-transition.dto';
import { ChannelPlanDto, UpdateChannelPlanDto } from './dto/channel-plan.dto';
import { LinkCampaignSegmentDto } from './dto/campaign-segment.dto';
import { AudienceSnapshotDto } from './dto/audience-snapshot.dto';
import { CreateContentVersionDto } from './dto/content-version.dto';
import { RecordAttributionDto } from './dto/attribution.dto';

const MANAGER_ROLES = new Set(['super_admin', 'company_admin', 'sales_manager']);

/** 可空 Json 字段：undefined 不写；null → SQL NULL（Prisma.DbNull）；对象 → 原样 */
function toNullableJson(
  value: Record<string, unknown> | null | undefined,
): Prisma.InputJsonValue | Prisma.NullableJsonNullValueInput | undefined {
  if (value === undefined) return undefined;
  return value === null ? Prisma.DbNull : (value as Prisma.InputJsonValue);
}

/** 活动状态机（action → 允许的起始状态 → 目标状态） */
export const CAMPAIGN_ACTIONS: Record<
  CampaignTransitionAction,
  { from: MarketingCampaignStatus[]; to: MarketingCampaignStatus; event: MarketingCampaignEventKind }
> = {
  start_planning: {
    from: [MarketingCampaignStatus.DRAFT],
    to: MarketingCampaignStatus.PLANNING,
    event: MarketingCampaignEventKind.STATUS_CHANGED,
  },
  submit_review: {
    from: [MarketingCampaignStatus.PLANNING, MarketingCampaignStatus.PAUSED],
    to: MarketingCampaignStatus.IN_REVIEW,
    event: MarketingCampaignEventKind.STATUS_CHANGED,
  },
  request_changes: {
    from: [MarketingCampaignStatus.IN_REVIEW],
    to: MarketingCampaignStatus.PLANNING,
    event: MarketingCampaignEventKind.STATUS_CHANGED,
  },
  approve: {
    from: [MarketingCampaignStatus.IN_REVIEW, MarketingCampaignStatus.PAUSED],
    to: MarketingCampaignStatus.APPROVED_PLAN,
    event: MarketingCampaignEventKind.CAMPAIGN_APPROVED,
  },
  // R111 批次C：显式「开始执行」— APPROVED_PLAN 保持状态，触发投放入队（channel=whatsapp 走 marketing-delivery 队列；
  // 事件在入队侧以 DELIVERY_RUN_CREATED 记录 runId，此处用 STATUS_CHANGED 记录动作本身）
  execute: {
    from: [MarketingCampaignStatus.APPROVED_PLAN],
    to: MarketingCampaignStatus.APPROVED_PLAN,
    event: MarketingCampaignEventKind.STATUS_CHANGED,
  },
  pause: {
    from: [
      MarketingCampaignStatus.PLANNING,
      MarketingCampaignStatus.IN_REVIEW,
      MarketingCampaignStatus.APPROVED_PLAN,
    ],
    to: MarketingCampaignStatus.PAUSED,
    event: MarketingCampaignEventKind.CAMPAIGN_PAUSED,
  },
  resume: {
    from: [MarketingCampaignStatus.PAUSED],
    to: MarketingCampaignStatus.PLANNING,
    event: MarketingCampaignEventKind.STATUS_CHANGED,
  },
  cancel: {
    from: [
      MarketingCampaignStatus.DRAFT,
      MarketingCampaignStatus.PLANNING,
      MarketingCampaignStatus.IN_REVIEW,
      MarketingCampaignStatus.APPROVED_PLAN,
      MarketingCampaignStatus.PAUSED,
    ],
    to: MarketingCampaignStatus.CANCELLED,
    event: MarketingCampaignEventKind.CAMPAIGN_CANCELLED,
  },
  archive: {
    from: [
      MarketingCampaignStatus.DRAFT,
      MarketingCampaignStatus.PLANNING,
      MarketingCampaignStatus.IN_REVIEW,
      MarketingCampaignStatus.APPROVED_PLAN,
      MarketingCampaignStatus.PAUSED,
      MarketingCampaignStatus.CANCELLED,
    ],
    to: MarketingCampaignStatus.ARCHIVED,
    event: MarketingCampaignEventKind.CAMPAIGN_ARCHIVED,
  },
};

export type CampaignAction = CampaignTransitionAction;

const EDITABLE_STATUSES = new Set<MarketingCampaignStatus>([
  MarketingCampaignStatus.DRAFT,
  MarketingCampaignStatus.PLANNING,
  MarketingCampaignStatus.PAUSED,
]);

function digest(value: unknown): string {
  return `sha256:${createHash('sha256').update(JSON.stringify(value)).digest('hex')}`;
}

function normalizeChannel(channel: string): string {
  const normalized = channel.trim().toLowerCase();
  if (!normalized) throw new BadRequestException('channel is required');
  return normalized;
}

/** 按渠道解析主触点：isVerified 优先，其次 isPrimary，最后任意；无可用触点返回 null */
function pickChannelContactPoint(
  points: ContactPoint[],
  channel: string,
): { id: string; normalizedValue: string } | null {
  const candidates = points
    .filter((cp) => cp.type.toLowerCase() === channel && cp.normalizedValue)
    .slice()
    .sort(
      (a, b) =>
        Number(b.isVerified) - Number(a.isVerified) ||
        Number(b.isPrimary) - Number(a.isPrimary),
    );
  const point = candidates[0];
  return point ? { id: point.id, normalizedValue: point.normalizedValue } : null;
}

@Injectable()
export class MarketingCampaignsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly ai: AiProviderService,
    // R111 批次A: 活动账号角色校验（复用 assertMarketingRole）
    private readonly emailAccounts: EmailAccountsService,
    // R111 批次C: whatsapp 活动投放入队（worker-marketing-delivery 消费）
    @InjectQueue(QUEUES.marketingDelivery) private readonly marketingDeliveryQueue: Queue,
  ) {}

  private assertManager(user: CurrentUser, companyId: string) {
    requireActiveCompany(user);
    if (!hasFullAccess(user, companyId) && !MANAGER_ROLES.has(user.activeCompany?.role || '')) {
      throw new ForbiddenException('Marketing campaign management requires a manager role');
    }
  }

  private async findCampaign(id: string, companyId: string) {
    const campaign = await this.prisma.marketingCampaign.findFirst({
      where: { id, companyId },
      include: {
        channelPlans: true,
        contentVersions: { orderBy: { version: 'desc' }, take: 5 },
        // R111 批次C：详情返回最新投放运行（状态机回读）
        deliveryRuns: { orderBy: { createdAt: 'desc' }, take: 5 },
        audienceSnapshot: { select: { id: true, memberCount: true } },
        _count: { select: { events: true, deliveryRuns: true } },
      },
    });
    if (!campaign) throw new NotFoundException('Marketing campaign not found');
    return campaign;
  }

  /**
   * R111 批次A: 活动指定发件账号（senderAccountId）时强制校验角色为 MARKETING。
   * 未指定则跳过（由 resolveExecutionContext 渠道就绪检查兜底：仅 MARKETING 账号视为就绪）。
   */
  private async assertCampaignSenderAccount(companyId: string, senderAccountId?: string | null) {
    if (!senderAccountId) return;
    const account = await this.prisma.emailAccount.findFirst({
      where: { id: senderAccountId, companyId },
      select: { id: true, senderEmail: true, accountRole: true, status: true },
    });
    if (!account) {
      throw new BadRequestException(
        `营销活动指定的发件邮箱账号不存在或不属于当前公司（senderAccountId=${senderAccountId}）`,
      );
    }
    this.emailAccounts.assertMarketingRole(account, '营销活动');
  }

  private async recordEvent(
    tx: Prisma.TransactionClient,
    companyId: string,
    campaignId: string,
    revision: number,
    kind: MarketingCampaignEventKind,
    payload: Prisma.InputJsonValue,
    createdById?: string,
  ) {
    const payloadHash = digest(payload);
    return tx.marketingCampaignEvent.create({
      data: { companyId, campaignId, revision, kind, payload, payloadHash, createdById },
    });
  }

  // ---------------------------------------------------------------- CRUD

  async list(user: CurrentUser) {
    const company = requireActiveCompany(user);
    const baseWhere = { companyId: company.id };
    const where = hasFullAccess(user, company.id)
      ? baseWhere
      : { ...baseWhere, ownerUserId: user.id };
    return this.prisma.marketingCampaign.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      include: {
        channelPlans: true,
        audienceSnapshot: { select: { id: true, memberCount: true } },
        // R111 批次C：列表返回最新投放运行状态
        deliveryRuns: { orderBy: { createdAt: 'desc' }, take: 1 },
        _count: { select: { events: true, contentVersions: true, deliveryRuns: true } },
      },
    });
  }

  /**
   * R111 批次D：活动级互动合表（数据看板）。
   * Query：limit（默认 20）、channel（可选）。
   * 口径：MarketingCampaign 列表 + audienceSnapshot.memberCount +
   * EmailMessage 按 campaignId 聚合（sent/delivered/opened/clicked/replied，
   * 率口径同 /analytics/engagement-trends，保留 1 位小数）；无 EmailMessage 的活动 sent=0 正常返回。
   */
  async getEngagement(user: CurrentUser, query: { limit?: string | number; channel?: string } = {}) {
    const company = requireActiveCompany(user);
    const limit = Math.max(1, Math.min(100, Number(query?.limit || 20) || 20));
    const where: any = { companyId: company.id };
    if (query?.channel) where.channel = query.channel;

    const campaigns = await this.prisma.marketingCampaign.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      take: limit,
      select: {
        id: true,
        name: true,
        channel: true,
        status: true,
        audienceSnapshot: { select: { memberCount: true } },
      },
    });
    const campaignIds = campaigns.map((c) => c.id);

    // EmailMessage.campaignId 为字符串外键（同一 id 空间），按活动聚合互动指标
    const emailMessages = campaignIds.length
      ? await this.prisma.emailMessage.findMany({
          where: { companyId: company.id, deletedAt: null, campaignId: { in: campaignIds } },
          select: { campaignId: true, status: true, deliveredAt: true, openedAt: true, clickedAt: true },
        })
      : [];
    const aggByCampaign = new Map<string, { sent: number; delivered: number; opened: number; clicked: number; replied: number }>();
    const SENT_STATUSES = new Set(['Sent', 'Opened', 'Clicked', 'Replied']);
    for (const m of emailMessages) {
      if (!m.campaignId || !SENT_STATUSES.has(m.status)) continue;
      const agg = aggByCampaign.get(m.campaignId) || { sent: 0, delivered: 0, opened: 0, clicked: 0, replied: 0 };
      agg.sent++;
      if (m.deliveredAt) agg.delivered++;
      if (m.openedAt) agg.opened++;
      if (m.clickedAt) agg.clicked++;
      if (m.status === 'Replied') agg.replied++;
      aggByCampaign.set(m.campaignId, agg);
    }

    const rate = (part: number, total: number) => (total && part > 0 ? Math.round((part / total) * 1000) / 10 : 0);
    return {
      campaigns: campaigns.map((c) => {
        const agg = aggByCampaign.get(c.id) || { sent: 0, delivered: 0, opened: 0, clicked: 0, replied: 0 };
        return {
          id: c.id,
          name: c.name,
          channel: c.channel ?? null,
          status: c.status,
          memberCount: c.audienceSnapshot?.memberCount ?? 0,
          sent: agg.sent,
          delivered: agg.delivered,
          opened: agg.opened,
          clicked: agg.clicked,
          replied: agg.replied,
          openRate: rate(agg.opened, agg.sent),
          clickRate: rate(agg.clicked, agg.sent),
          replyRate: rate(agg.replied, agg.sent),
        };
      }),
    };
  }

  async get(id: string, user: CurrentUser) {
    const company = requireActiveCompany(user);
    const campaign = await this.findCampaign(id, company.id);
    if (!hasFullAccess(user, company.id) && campaign.ownerUserId !== user.id) {
      throw new ForbiddenException('No access to this marketing campaign');
    }
    return campaign;
  }

  async create(dto: CreateMarketingCampaignDto, user: CurrentUser) {
    const company = requireActiveCompany(user);
    this.assertManager(user, company.id);
    // R111 批次A: 指定发件账号时强制 MARKETING 角色
    await this.assertCampaignSenderAccount(company.id, dto.senderAccountId);
    const name = dto.name.trim();
    if (!name) throw new BadRequestException('name is required');
    const campaign = await this.prisma.$transaction(async (tx) => {
      const created = await tx.marketingCampaign.create({
        data: {
          companyId: company.id,
          ownerUserId: user.id,
          createdById: user.id,
          name,
          description: dto.description?.trim() || null,
          channel: dto.channel?.trim().toLowerCase() || null,
          scheduleIntent: toNullableJson(dto.scheduleIntent),
          windowStart: dto.windowStart ? new Date(dto.windowStart) : null,
          windowEnd: dto.windowEnd ? new Date(dto.windowEnd) : null,
        },
      });
      await this.recordEvent(
        tx,
        company.id,
        created.id,
        created.revision,
        MarketingCampaignEventKind.CAMPAIGN_CREATED,
        { name },
        user.id,
      );
      return created;
    });
    return this.get(campaign.id, user);
  }

  async update(id: string, dto: UpdateMarketingCampaignDto, user: CurrentUser) {
    const company = requireActiveCompany(user);
    this.assertManager(user, company.id);
    // R111 批次A: 指定发件账号时强制 MARKETING 角色
    await this.assertCampaignSenderAccount(company.id, dto.senderAccountId);
    const current = await this.findCampaign(id, company.id);
    if (!EDITABLE_STATUSES.has(current.status)) {
      throw new ConflictException(`Campaign cannot be edited in status ${current.status}`);
    }
    return this.prisma.$transaction(async (tx) => {
      const updated = await tx.marketingCampaign.update({
        where: { id },
        data: {
          revision: { increment: 1 },
          name: dto.name ? dto.name.trim() : undefined,
          description: dto.description === undefined ? undefined : dto.description?.trim() || null,
          channel: dto.channel === undefined ? undefined : dto.channel?.trim().toLowerCase() || null,
          scheduleIntent: toNullableJson(dto.scheduleIntent),
          windowStart: dto.windowStart === undefined ? undefined : dto.windowStart ? new Date(dto.windowStart) : null,
          windowEnd: dto.windowEnd === undefined ? undefined : dto.windowEnd ? new Date(dto.windowEnd) : null,
        },
      });
      await this.recordEvent(
        tx,
        company.id,
        id,
        updated.revision,
        MarketingCampaignEventKind.CAMPAIGN_UPDATED,
        { name: updated.name },
        user.id,
      );
      return updated;
    });
  }

  // ------------------------------------------------------------- 状态机

  async transition(id: string, action: CampaignAction, dto: CampaignTransitionDto, user: CurrentUser) {
    const company = requireActiveCompany(user);
    this.assertManager(user, company.id);
    const rule = CAMPAIGN_ACTIONS[action];
    if (!rule) {
      throw new BadRequestException(
        `Unknown transition action; expected one of: ${CAMPAIGN_TRANSITION_ACTIONS.join(', ')}`,
      );
    }
    const current = await this.prisma.marketingCampaign.findFirst({
      where: { id, companyId: company.id },
      select: { id: true, status: true, revision: true },
    });
    if (!current) throw new NotFoundException('Marketing campaign not found');
    if (!rule.from.includes(current.status)) {
      throw new ConflictException(
        `Cannot ${action} campaign in status ${current.status}`,
      );
    }
    const result = await this.prisma.$transaction(async (tx) => {
      const updated = await tx.marketingCampaign.updateMany({
        where: {
          id,
          companyId: company.id,
          revision: current.revision,
          status: current.status,
        },
        data: { status: rule.to, revision: { increment: 1 } },
      });
      if (updated.count !== 1) {
        throw new ConflictException('Campaign changed concurrently; reload and retry');
      }
      const next = await tx.marketingCampaign.findUniqueOrThrow({
        where: { id },
        select: { id: true, revision: true, status: true },
      });
      await this.recordEvent(
        tx,
        company.id,
        id,
        next.revision,
        rule.event,
        { action, from: current.status, to: next.status },
        user.id,
      );
      return next;
    });
    // R111 批次C：显式「开始执行」→ whatsapp 活动入队（BLOCKED 拦截也在入队侧落 run）
    if (action === 'execute') {
      await this.enqueueWhatsappDelivery(id, user);
    }
    return this.get(result.id, user);
  }

  /**
   * R111 批次C：whatsapp 活动投放「入队执行」。
   * - 入队条件：channel=whatsapp、无进行中运行、十道闸活动级闸门已过、快照有 eligible 成员
   * - 安全开关 WHATSAPP_BROADCAST_DISABLED=true（默认）→ 直接落 BLOCKED 运行拒绝
   * - 活动级闸门（killSwitch/accountReady/approval/window 等）未过 → BLOCKED 运行
   * - 通过 → 创建 PENDING MarketingDeliveryRun 并入队 marketing-delivery 队列
   * - 逐成员 consent/suppression 等触点级闸门由执行器在 worker 内按成员复评
   */
  async enqueueWhatsappDelivery(campaignId: string, user: CurrentUser) {
    const company = requireActiveCompany(user);
    const campaign = await this.findCampaign(campaignId, company.id);
    const channel = campaign.channel?.trim().toLowerCase() || null;
    if (channel !== 'whatsapp') {
      throw new ConflictException(
        `execute 仅支持 channel=whatsapp 的活动（当前 channel=${channel ?? '未设置'}）`,
      );
    }
    // 幂等：存在进行中运行（PENDING/WAITING/READY/CLAIMED/UNKNOWN）则拒绝重复入队
    const inFlight = await this.prisma.marketingDeliveryRun.findFirst({
      where: {
        campaignId,
        companyId: company.id,
        status: {
          in: [
            MarketingDeliveryRunStatus.PENDING,
            MarketingDeliveryRunStatus.WAITING,
            MarketingDeliveryRunStatus.READY,
            MarketingDeliveryRunStatus.CLAIMED,
            MarketingDeliveryRunStatus.UNKNOWN,
          ],
        },
      },
      select: { id: true, status: true },
      orderBy: { createdAt: 'desc' },
    });
    if (inFlight) {
      throw new ConflictException(
        `活动已有进行中的投放运行（runId=${inFlight.id}, status=${inFlight.status}）；完成后可再次执行`,
      );
    }

    const snapshot = campaign.audienceSnapshot;
    const eligibleCount = snapshot
      ? await this.prisma.marketingAudienceMember.count({
          where: { snapshotId: snapshot.id, status: 'eligible' },
        })
      : 0;

    const createBlockedRun = async (
      reason: string,
      detail: Record<string, unknown>,
    ) => {
      const run = await this.prisma.$transaction(async (tx) => {
        const created = await tx.marketingDeliveryRun.create({
          data: {
            companyId: company.id,
            campaignId,
            channelPlanId: campaign.channelPlans[0]?.id ?? null,
            contactRef: `campaign:${campaignId}`,
            channel: 'whatsapp',
            status: MarketingDeliveryRunStatus.BLOCKED,
            lastError: reason,
            totalCount: eligibleCount,
            processedCount: 0,
            payloadJson: {
              ...detail,
              blockedReason: reason,
              enqueuedByUserId: user.id,
            } as Prisma.InputJsonValue,
            payloadHash: digest({ ...detail, blockedReason: reason }),
            executedAt: new Date(),
          },
        });
        await this.recordEvent(
          tx,
          company.id,
          campaignId,
          campaign.revision,
          MarketingCampaignEventKind.DELIVERY_RUN_CREATED,
          { runId: created.id, status: 'BLOCKED', reason, detail } as Prisma.InputJsonValue,
          user.id,
        );
        return created;
      });
      return run;
    };

    // 安全开关：默认 true（生产安全），开启广播限制时执行器直接 BLOCKED 拒绝
    if (this.whatsappBroadcastDisabled()) {
      return createBlockedRun('WHATSAPP_BROADCAST_DISABLED', {
        gate: 'executionEnabled',
        message: 'WhatsApp broadcast is disabled by server safety switch WHATSAPP_BROADCAST_DISABLED=true',
      });
    }
    if (eligibleCount === 0) {
      return createBlockedRun('NO_ELIGIBLE_MEMBERS', {
        gate: 'accountReady',
        message: '活动快照没有 eligible 状态的 whatsapp 成员',
      });
    }

    // 预检十道闸（复用 resolveExecutionContext 的 evaluateGate；触点级闸门留待 worker 按成员复评）
    const { ctx, result } = await this.evaluateGate(campaignId, user, { channel });
    const campaignLevelFailures = result.checks.filter(
      (check) =>
        !check.passed
        && ['migration', 'executionEnabled', 'nodeWhitelist', 'accountReady', 'killSwitch', 'approval', 'window']
          .includes(check.gate),
    );
    if (campaignLevelFailures.length > 0) {
      return createBlockedRun(
        `PRECONDITION_FAILED: ${campaignLevelFailures.map((c) => c.gate).join(',')}`,
        {
          gate: campaignLevelFailures[0].gate,
          failedGates: campaignLevelFailures.map((c) => c.gate),
          checks: result.checks,
          message: campaignLevelFailures.map((c) => c.blockedReason).filter(Boolean).join('; '),
        },
      );
    }

    const session = await this.prisma.whatsAppSession.findFirst({
      where: { companyId: company.id, status: 'connected' },
      select: { id: true },
      orderBy: { createdAt: 'asc' },
    });
    if (!session) {
      return createBlockedRun('NO_CONNECTED_WHATSAPP_ACCOUNT', {
        gate: 'accountReady',
        message: '未找到已连接的 WhatsApp 发送账号（status=connected）',
      });
    }

    const run = await this.prisma.$transaction(async (tx) => {
      const created = await tx.marketingDeliveryRun.create({
        data: {
          companyId: company.id,
          campaignId,
          channelPlanId: ctx.channelPlan?.id ?? null,
          contactRef: `campaign:${campaignId}`,
          channel: 'whatsapp',
          status: MarketingDeliveryRunStatus.PENDING,
          totalCount: eligibleCount,
          processedCount: 0,
          payloadJson: {
            campaignId,
            whatsappSessionId: session.id,
            enqueuedByUserId: user.id,
            memberCount: eligibleCount,
          } as Prisma.InputJsonValue,
          payloadHash: digest({
            campaignId,
            whatsappSessionId: session.id,
            memberCount: eligibleCount,
          }),
        },
      });
      await this.recordEvent(
        tx,
        company.id,
        campaignId,
        campaign.revision,
        MarketingCampaignEventKind.DELIVERY_RUN_CREATED,
        { runId: created.id, status: 'PENDING', channel: 'whatsapp' },
        user.id,
      );
      return created;
    });

    try {
      await this.marketingDeliveryQueue.add(
        'deliver',
        {
          runId: run.id,
          campaignId,
          companyId: company.id,
          whatsappSessionId: session.id,
          enqueuedByUserId: user.id,
        },
        {
          attempts: 3,
          backoff: { type: 'exponential', delay: 15000 },
          removeOnComplete: 100,
          removeOnFail: 100,
        },
      );
    } catch (err: any) {
      await this.prisma.marketingDeliveryRun.updateMany({
        where: { id: run.id, companyId: company.id },
        data: {
          status: MarketingDeliveryRunStatus.FAILED,
          lastError: `ENQUEUE_FAILED: ${String(err?.message || err)}`,
          executedAt: new Date(),
        },
      });
      throw new BadRequestException(`投放入队失败（runId=${run.id}）：${String(err?.message || err)}`);
    }
    return run;
  }

  /** WHATSAPP_BROADCAST_DISABLED 默认 true（生产安全开关）→ 禁止广播执行 */
  private whatsappBroadcastDisabled(): boolean {
    return isWhatsappBroadcastDisabled();
  }

  async events(id: string, user: CurrentUser) {
    const company = requireActiveCompany(user);
    await this.findCampaign(id, company.id);
    return this.prisma.marketingCampaignEvent.findMany({
      where: { campaignId: id, companyId: company.id },
      orderBy: { createdAt: 'desc' },
      take: 200,
    });
  }

  // ----------------------------------------------------------- ChannelPlan

  async listChannelPlans(campaignId: string, user: CurrentUser) {
    const company = requireActiveCompany(user);
    await this.findCampaign(campaignId, company.id);
    return this.prisma.marketingChannelPlan.findMany({
      where: { campaignId, companyId: company.id },
      orderBy: { createdAt: 'asc' },
    });
  }

  async addChannelPlan(campaignId: string, dto: ChannelPlanDto, user: CurrentUser) {
    const company = requireActiveCompany(user);
    this.assertManager(user, company.id);
    const campaign = await this.findCampaign(campaignId, company.id);
    if (!EDITABLE_STATUSES.has(campaign.status)) {
      throw new ConflictException(`Cannot add channel plan in status ${campaign.status}`);
    }
    const channel = normalizeChannel(dto.channel);
    // 固定渠道：计划渠道必须等于活动固定渠道；活动已有其他渠道 plan 则拒绝新增
    if (campaign.channel) {
      const fixed = campaign.channel.trim().toLowerCase();
      if (channel !== fixed) {
        throw new ConflictException(
          `Campaign channel is fixed to ${fixed}; channel plan channel must be ${fixed}`,
        );
      }
      const otherChannelPlans = await this.prisma.marketingChannelPlan.count({
        where: { campaignId, companyId: company.id, channel: { not: fixed } },
      });
      if (otherChannelPlans > 0) {
        throw new ConflictException(
          'Campaign already has channel plans on other channels; remove them before adding a new plan',
        );
      }
    }
    return this.prisma.$transaction(async (tx) => {
      const plan = await tx.marketingChannelPlan.create({
        data: {
          companyId: company.id,
          campaignId,
          channel,
          windowSeconds: dto.windowSeconds ?? 0,
          maxPerContact: dto.maxPerContact ?? 1,
          scheduleJson: toNullableJson(dto.scheduleJson),
          enabled: dto.enabled ?? true,
        },
      });
      await this.recordEvent(
        tx,
        company.id,
        campaignId,
        campaign.revision,
        MarketingCampaignEventKind.CHANNEL_PLAN_ADDED,
        { channelPlanId: plan.id, channel },
        user.id,
      );
      return plan;
    });
  }

  async updateChannelPlan(campaignId: string, planId: string, dto: UpdateChannelPlanDto, user: CurrentUser) {
    const company = requireActiveCompany(user);
    this.assertManager(user, company.id);
    const campaign = await this.findCampaign(campaignId, company.id);
    if (!EDITABLE_STATUSES.has(campaign.status)) {
      throw new ConflictException(`Cannot update channel plan in status ${campaign.status}`);
    }
    const existing = await this.prisma.marketingChannelPlan.findFirst({
      where: { id: planId, campaignId, companyId: company.id },
    });
    if (!existing) throw new NotFoundException('Channel plan not found');
    // 固定渠道：不允许把计划渠道改成与活动固定渠道不一致
    if (dto.channel !== undefined && campaign.channel) {
      const fixed = campaign.channel.trim().toLowerCase();
      if (normalizeChannel(dto.channel) !== fixed) {
        throw new ConflictException(
          `Campaign channel is fixed to ${fixed}; channel plan channel cannot be changed to a different channel`,
        );
      }
    }
    return this.prisma.$transaction(async (tx) => {
      const plan = await tx.marketingChannelPlan.update({
        where: { id: planId },
        data: {
          version: { increment: 1 },
          channel: dto.channel === undefined ? undefined : normalizeChannel(dto.channel),
          windowSeconds: dto.windowSeconds,
          maxPerContact: dto.maxPerContact,
          scheduleJson: toNullableJson(dto.scheduleJson),
          enabled: dto.enabled,
          status: dto.status,
        },
      });
      await this.recordEvent(
        tx,
        company.id,
        campaignId,
        campaign.revision,
        MarketingCampaignEventKind.CHANNEL_PLAN_UPDATED,
        { channelPlanId: planId, channel: plan.channel },
        user.id,
      );
      return plan;
    });
  }

  async removeChannelPlan(campaignId: string, planId: string, user: CurrentUser) {
    const company = requireActiveCompany(user);
    this.assertManager(user, company.id);
    const campaign = await this.findCampaign(campaignId, company.id);
    const existing = await this.prisma.marketingChannelPlan.findFirst({
      where: { id: planId, campaignId, companyId: company.id },
    });
    if (!existing) throw new NotFoundException('Channel plan not found');
    await this.prisma.marketingChannelPlan.delete({ where: { id: planId } });
    await this.prisma.marketingCampaignEvent.create({
      data: {
        companyId: company.id,
        campaignId,
        revision: campaign.revision,
        kind: MarketingCampaignEventKind.CHANNEL_PLAN_REMOVED,
        payload: { channelPlanId: planId, channel: existing.channel } as Prisma.InputJsonValue,
        payloadHash: digest({ channelPlanId: planId, channel: existing.channel }),
        createdById: user.id,
      },
    });
    return { id: planId, removed: true };
  }

  // ------------------------------------------------------------- 受众快照

  async snapshotAudience(campaignId: string, dto: AudienceSnapshotDto, user: CurrentUser) {
    const company = requireActiveCompany(user);
    this.assertManager(user, company.id);
    const campaign = await this.findCampaign(campaignId, company.id);
    if (!EDITABLE_STATUSES.has(campaign.status)) {
      throw new ConflictException(`Cannot snapshot audience in status ${campaign.status}`);
    }
    // 固定渠道：snapshot 前必须已定渠道（email | whatsapp），只取该渠道触点成员
    const channel = campaign.channel?.trim().toLowerCase() || null;
    if (!channel) {
      throw new ConflictException(
        'Campaign has no fixed channel; set channel (email|whatsapp) before snapshotting audience',
      );
    }
    const limit = Math.min(Math.max(dto.limit ?? 5000, 1), 50000);

    let members: Array<{
      companyId: string;
      leadId: string;
      contactPointId?: string;
      contactRef: string;
      channel: string;
      status: string;
    }> = [];
    let criteria: Record<string, unknown>;

    if (dto.segmentId) {
      // 客群驱动：从 AudienceSegmentMember（status='eligible'）取成员 leadIds
      const segment = await this.prisma.audienceSegment.findFirst({
        where: { id: dto.segmentId, companyId: company.id },
        select: { id: true, name: true },
      });
      if (!segment) throw new NotFoundException('Audience segment not found');
      const link = await this.prisma.marketingCampaignSegment.findFirst({
        where: { campaignId, segmentId: dto.segmentId, companyId: company.id },
        select: { id: true },
      });
      if (!link) {
        throw new ConflictException(
          'Segment is not linked to this campaign; link it first via POST /marketing-campaigns/:id/segments',
        );
      }
      const segmentMembers = await this.prisma.audienceSegmentMember.findMany({
        where: { segmentId: dto.segmentId, status: 'eligible' },
        select: { leadId: true },
        orderBy: { createdAt: 'asc' },
        take: limit,
      });
      const leads = await this.prisma.lead.findMany({
        where: {
          id: { in: segmentMembers.map((m) => m.leadId) },
          companyId: company.id,
          deletedAt: null,
        },
        include: { contactPoints: { where: { type: channel } } },
      });
      members = leads.map((lead) => {
        const point = pickChannelContactPoint(lead.contactPoints, channel);
        return point
          ? {
              companyId: company.id,
              leadId: lead.id,
              contactPointId: point.id,
              contactRef: point.normalizedValue,
              channel,
              status: 'eligible',
            }
          : {
              companyId: company.id,
              leadId: lead.id,
              contactRef: lead.id,
              channel,
              status: 'skipped',
            };
      });
      criteria = {
        source: 'segment',
        segmentId: dto.segmentId,
        segmentName: segment.name,
        channel,
        limit,
        memberCount: members.length,
      };
    } else {
      // 兼容：criteriaJson 方式（leadStatuses + 固定渠道触点）
      const leadStatuses = dto.leadStatuses?.length ? dto.leadStatuses : ['new', 'prospect_pool'];
      const channels = [channel];
      const leads = await this.prisma.lead.findMany({
        where: {
          companyId: company.id,
          deletedAt: null,
          status: { in: leadStatuses },
        },
        take: limit,
        include: { contactPoints: { where: { type: { in: channels } } } },
      });
      for (const lead of leads) {
        const points = lead.contactPoints.filter(
          (cp) => channels.includes(cp.type.toLowerCase()) && cp.normalizedValue,
        );
        if (points.length === 0) continue;
        for (const cp of points) {
          members.push({
            companyId: company.id,
            leadId: lead.id,
            contactPointId: cp.id,
            contactRef: cp.normalizedValue,
            channel: cp.type.toLowerCase(),
            status: 'eligible',
          });
          if (members.length >= limit) break;
        }
        if (members.length >= limit) break;
      }
      criteria = { leadStatuses, channels, channel, limit, memberCount: members.length };
    }

    return this.prisma.$transaction(async (tx) => {
      await tx.marketingAudienceMember.deleteMany({ where: { snapshot: { campaignId } } });
      await tx.marketingAudienceSnapshot.deleteMany({ where: { campaignId } });
      const snapshot = await tx.marketingAudienceSnapshot.create({
        data: {
          companyId: company.id,
          campaignId,
          criteriaJson: criteria as Prisma.InputJsonValue,
          memberCount: members.length,
          createdById: user.id,
          members: { create: members },
        },
        include: { members: true },
      });
      await this.recordEvent(
        tx,
        company.id,
        campaignId,
        campaign.revision,
        MarketingCampaignEventKind.AUDIENCE_SNAPSHOTTED,
        {
          snapshotId: snapshot.id,
          memberCount: members.length,
          source: dto.segmentId ? 'segment' : 'criteria',
          channel,
        },
        user.id,
      );
      return snapshot;
    });
  }

  async listAudience(campaignId: string, user: CurrentUser) {
    const company = requireActiveCompany(user);
    await this.findCampaign(campaignId, company.id);
    const snapshot = await this.prisma.marketingAudienceSnapshot.findFirst({
      where: { campaignId, companyId: company.id },
      include: { members: { take: 500 } },
    });
    return snapshot ?? { campaignId, memberCount: 0, members: [] };
  }

  // --------------------------------------------------- 活动 ↔ 客群关联

  async listSegments(campaignId: string, user: CurrentUser) {
    const company = requireActiveCompany(user);
    await this.findCampaign(campaignId, company.id);
    const links = await this.prisma.marketingCampaignSegment.findMany({
      where: { campaignId, companyId: company.id },
      orderBy: { createdAt: 'asc' },
    });
    if (links.length === 0) return [];
    const segments = await this.prisma.audienceSegment.findMany({
      where: { id: { in: links.map((link) => link.segmentId) }, companyId: company.id },
      select: { id: true, name: true, memberCount: true },
    });
    const byId = new Map(segments.map((segment) => [segment.id, segment]));
    return links.map((link) => ({
      id: link.id,
      campaignId: link.campaignId,
      segmentId: link.segmentId,
      segmentName: byId.get(link.segmentId)?.name ?? null,
      memberCount: byId.get(link.segmentId)?.memberCount ?? 0,
      createdAt: link.createdAt,
    }));
  }

  async linkSegment(campaignId: string, dto: LinkCampaignSegmentDto, user: CurrentUser) {
    const company = requireActiveCompany(user);
    this.assertManager(user, company.id);
    const campaign = await this.findCampaign(campaignId, company.id);
    if (!EDITABLE_STATUSES.has(campaign.status)) {
      throw new ConflictException(`Cannot link segment in status ${campaign.status}`);
    }
    const segment = await this.prisma.audienceSegment.findFirst({
      where: { id: dto.segmentId, companyId: company.id },
      select: { id: true },
    });
    if (!segment) throw new NotFoundException('Audience segment not found');
    const existing = await this.prisma.marketingCampaignSegment.findFirst({
      where: { campaignId, segmentId: dto.segmentId, companyId: company.id },
      select: { id: true },
    });
    if (existing) throw new ConflictException('Segment is already linked to this campaign');
    return this.prisma.marketingCampaignSegment.create({
      data: { companyId: company.id, campaignId, segmentId: dto.segmentId },
    });
  }

  async unlinkSegment(campaignId: string, segmentId: string, user: CurrentUser) {
    const company = requireActiveCompany(user);
    this.assertManager(user, company.id);
    const campaign = await this.findCampaign(campaignId, company.id);
    if (!EDITABLE_STATUSES.has(campaign.status)) {
      throw new ConflictException(`Cannot unlink segment in status ${campaign.status}`);
    }
    const existing = await this.prisma.marketingCampaignSegment.findFirst({
      where: { campaignId, segmentId, companyId: company.id },
      select: { id: true },
    });
    if (!existing) throw new NotFoundException('Campaign segment link not found');
    await this.prisma.marketingCampaignSegment.delete({ where: { id: existing.id } });
    return { id: existing.id, campaignId, segmentId, removed: true };
  }

  // ----------------------------------------------------------- 内容版本

  async listContentVersions(campaignId: string, user: CurrentUser) {
    const company = requireActiveCompany(user);
    await this.findCampaign(campaignId, company.id);
    return this.prisma.marketingContentVersion.findMany({
      where: { campaignId, companyId: company.id },
      orderBy: { version: 'desc' },
    });
  }

  async createContentVersion(campaignId: string, dto: CreateContentVersionDto, user: CurrentUser) {
    const company = requireActiveCompany(user);
    this.assertManager(user, company.id);
    const campaign = await this.findCampaign(campaignId, company.id);

    let title = dto.title?.trim() ?? null;
    let subject = dto.subject?.trim() ?? null;
    let body = dto.body?.trim() ?? '';

    // AI 草拟：复用我方 AiProviderService（DeepSeek/GLM 优先，未启用时返回 mock）
    if (!body && dto.aiPrompt) {
      const result = await this.ai.chat(
        '你是一名 B2B 外贸营销文案助手。根据要求输出 JSON：{"subject":"...","body":"..."}，只输出 JSON。',
        dto.aiPrompt,
        { task: 'marketing_content_draft', temperature: 0.7, maxTokens: 800 },
      );
      if (result.success) {
        try {
          const parsed = JSON.parse(result.content);
          subject = parsed.subject ?? subject;
          body = parsed.body ?? body;
        } catch {
          body = result.content.trim();
        }
      }
    }
    if (!body) throw new BadRequestException('body or aiPrompt is required');

    const maxVersion = await this.prisma.marketingContentVersion.aggregate({
      where: { campaignId, companyId: company.id },
      _max: { version: true },
    });
    const version = (maxVersion._max.version ?? 0) + 1;
    const payload = { title, subject, body, channel: dto.channel ?? null, version };
    const digestValue = digest(payload);

    return this.prisma.$transaction(async (tx) => {
      const created = await tx.marketingContentVersion.create({
        data: {
          companyId: company.id,
          campaignId,
          version,
          title,
          subject,
          body,
          channel: dto.channel?.trim().toLowerCase() || null,
          digest: digestValue,
          isActive: version === 1,
          createdById: user.id,
        },
      });
      await this.recordEvent(
        tx,
        company.id,
        campaignId,
        campaign.revision,
        MarketingCampaignEventKind.CONTENT_VERSION_CREATED,
        { contentVersionId: created.id, version, digest: digestValue },
        user.id,
      );
      // AI 直发：autoActivate=true 时创建后立即激活（跳过人工激活步骤，发送流程不变）
      let content = created;
      if (dto.autoActivate === true) {
        await tx.marketingContentVersion.updateMany({
          where: { campaignId, companyId: company.id, isActive: true },
          data: { isActive: false },
        });
        content = await tx.marketingContentVersion.update({
          where: { id: created.id },
          data: { isActive: true },
        });
        await this.recordEvent(
          tx,
          company.id,
          campaignId,
          campaign.revision,
          MarketingCampaignEventKind.CONTENT_VERSION_ACTIVATED,
          { contentVersionId: created.id, version },
          user.id,
        );
      }
      return content;
    });
  }

  async activateContentVersion(campaignId: string, versionId: string, user: CurrentUser) {
    const company = requireActiveCompany(user);
    this.assertManager(user, company.id);
    const campaign = await this.findCampaign(campaignId, company.id);
    const target = await this.prisma.marketingContentVersion.findFirst({
      where: { id: versionId, campaignId, companyId: company.id },
    });
    if (!target) throw new NotFoundException('Content version not found');
    return this.prisma.$transaction(async (tx) => {
      await tx.marketingContentVersion.updateMany({
        where: { campaignId, companyId: company.id, isActive: true },
        data: { isActive: false },
      });
      const activated = await tx.marketingContentVersion.update({
        where: { id: versionId },
        data: { isActive: true },
      });
      await this.recordEvent(
        tx,
        company.id,
        campaignId,
        campaign.revision,
        MarketingCampaignEventKind.CONTENT_VERSION_ACTIVATED,
        { contentVersionId: versionId, version: target.version },
        user.id,
      );
      return activated;
    });
  }

  // ------------------------------------------------------------- Preflight

  private async resolveExecutionContext(
    companyId: string,
    campaignId: string,
    opts: { contactRef?: string | null; channel?: string | null; leadId?: string | null; contactPointId?: string | null; channelPlanId?: string | null },
  ): Promise<MarketingExecutionContext> {
    const campaign = await this.prisma.marketingCampaign.findFirst({
      where: { id: campaignId, companyId },
      include: { channelPlans: true, audienceSnapshot: { include: { members: true } } },
    });
    const channel = (opts.channel ?? campaign?.channelPlans[0]?.channel ?? 'email').toLowerCase();
    const channelPlan = opts.channelPlanId
      ? (campaign?.channelPlans.find((p) => p.id === opts.channelPlanId) ?? null)
      : (campaign?.channelPlans.find((p) => p.channel === channel) ?? null);
    const contactRef = opts.contactRef ?? null;

    // 1. migration：营销表是否已建
    let migrationApplied = true;
    try {
      const rows = await this.prisma.$queryRaw<Array<{ applied: boolean }>>(
        Prisma.sql`SELECT to_regclass('public."MarketingCampaign"') IS NOT NULL AS applied`,
      );
      migrationApplied = rows[0]?.applied === true;
    } catch {
      migrationApplied = false;
    }

    // 2. executionEnabled：环境开关（默认开启）
    const executionEnabled = process.env.MARKETING_EXECUTION_ENABLED !== 'false';

    // 3. nodeWhitelist：环境白名单（缺省放行）
    const whitelist = (process.env.MARKETING_EXECUTION_NODE_WHITELIST || '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    const nodeWhitelisted = whitelist.length === 0 || whitelist.includes(hostname());

    // 4. accountReady：按渠道查就绪账号
    // R111 批次A: email 渠道仅 MARKETING 角色账号视为就绪（核心/客服账号不可用于营销投放）
    let accountReady = false;
    let accountReadyReason: string | null = null;
    if (channel === 'email') {
      const account = await this.prisma.emailAccount.findFirst({
        where: { companyId, status: 'active', accountRole: 'MARKETING' },
        select: { id: true, senderEmail: true, accountRole: true },
      });
      accountReady = Boolean(account);
      if (!accountReady) {
        accountReadyReason =
          '未找到已激活的营销邮箱账号（accountRole=MARKETING），营销活动仅允许使用营销邮箱，请先在邮箱账户中标注/添加 MARKETING 角色账号';
      }
    } else if (channel === 'whatsapp') {
      const session = await this.prisma.whatsAppSession.findFirst({
        where: { companyId, status: 'connected' },
        select: { id: true },
      });
      accountReady = Boolean(session);
      if (!accountReady) {
        accountReadyReason = '未找到已连接的 WhatsApp 发送账号（status=connected）';
      }
    } else {
      accountReady = true; // 未知渠道不拦截账号闸
    }

    // 5. consent（fail-closed）
    let consentStatus: 'GRANTED' | 'DENIED' | 'UNKNOWN' | null = null;
    if (contactRef) {
      const consent = await this.prisma.marketingConsent.findFirst({
        where: {
          companyId,
          channel,
          contactRef,
          OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }],
        },
        orderBy: { updatedAt: 'desc' },
        select: { status: true },
      });
      consentStatus = consent?.status ?? null;
    } else if (opts.leadId) {
      const consent = await this.prisma.marketingConsent.findFirst({
        where: {
          companyId,
          channel,
          leadId: opts.leadId,
          OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }],
        },
        orderBy: { updatedAt: 'desc' },
        select: { status: true },
      });
      consentStatus = consent?.status ?? null;
    }

    // 6. suppression
    const suppressed = contactRef
      ? Boolean(await this.prisma.marketingSuppression.findFirst({
          where: {
            companyId,
            active: true,
            contactRef,
            AND: [
              { OR: [{ channel }, { channel: null }] },
              { OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }] },
            ],
          },
          select: { id: true },
        }))
      : false;

    // 7. killSwitch
    const killSwitch = await this.prisma.marketingKillSwitch.findFirst({
      where: { companyId, active: true },
      select: { scope: true, channel: true },
      orderBy: { activatedAt: 'desc' },
    });
    const killSwitchActive = Boolean(killSwitch);
    const killSwitchScope = killSwitch
      ? killSwitch.scope === 'GLOBAL'
        ? 'GLOBAL'
        : `CHANNEL:${(killSwitch.channel ?? '').toUpperCase()}`
      : null;

    // 8. approval：APPROVED_PLAN 之外一律视为需审批且未审批；PAUSED 亦拦截
    const approvalRequired = campaign ? campaign.status !== MarketingCampaignStatus.APPROVED_PLAN : true;
    const approvalGranted = campaign?.status === MarketingCampaignStatus.APPROVED_PLAN;

    // 9/10. frequency + window：用排程纯函数评估
    const materialized = materializeMarketingScheduleIntent({
      channel,
      windowStart: campaign?.windowStart?.toISOString() ?? null,
      windowEnd: campaign?.windowEnd?.toISOString() ?? null,
      windowSeconds: channelPlan?.windowSeconds ?? 0,
      maxPerContact: channelPlan?.maxPerContact ?? 1,
    });
    let recentDeliveries = 0;
    if (contactRef) {
      recentDeliveries = await this.prisma.marketingDeliveryRun.count({
        where: {
          companyId,
          campaignId,
          channel,
          contactRef,
          status: { in: ['SUCCEEDED', 'CLAIMED', 'UNKNOWN'] },
          createdAt: { gte: materialized.window.start },
        },
      });
    }
    const scheduleEval = evaluateMarketingScheduleAt({
      intent: materialized,
      previousDeliveries: Array.from({ length: recentDeliveries }, () => ({ at: materialized.window.start })),
    });

    return {
      companyId,
      channel,
      contactRef,
      leadId: opts.leadId ?? null,
      contactPointId: opts.contactPointId ?? null,
      campaignId,
      campaignStatus: campaign?.status ?? null,
      channelPlan: channelPlan
        ? {
            id: channelPlan.id,
            channel: channelPlan.channel,
            enabled: channelPlan.enabled,
            windowSeconds: channelPlan.windowSeconds,
            maxPerContact: channelPlan.maxPerContact,
          }
        : null,
      migrationApplied,
      executionEnabled,
      nodeWhitelisted,
      accountReady,
      accountReadyReason,
      consentStatus,
      suppressed,
      killSwitchActive,
      killSwitchScope,
      approvalRequired,
      approvalGranted,
      recentDeliveries,
      windowOpen: scheduleEval.withinWindow && scheduleEval.eligible,
    };
  }

  async runPreflight(campaignId: string, user: CurrentUser) {
    const company = requireActiveCompany(user);
    const campaign = await this.findCampaign(campaignId, company.id);
    const ctx = await this.resolveExecutionContext(company.id, campaignId, {});
    const result = evaluateMarketingExecutionContract(ctx);

    return this.prisma.$transaction(async (tx) => {
      const run = await tx.marketingPreflightRun.create({
        data: {
          companyId: company.id,
          campaignId,
          status: result.passed
            ? MarketingPreflightStatus.PASSED
            : MarketingPreflightStatus.FAILED,
          summary: {
            passed: result.passed,
            failedGates: result.failedGates,
            checkedAt: new Date().toISOString(),
          } as Prisma.InputJsonValue,
          createdById: user.id,
          finishedAt: new Date(),
        },
      });
      await tx.marketingPreflightAttempt.createMany({
        data: result.checks.map((check) => ({
          companyId: company.id,
          preflightRunId: run.id,
          gate: check.gate,
          passed: check.passed,
          detail:
            check.detail == null
              ? Prisma.DbNull
              : (check.detail as Prisma.InputJsonValue),
        })),
      });
      const withAttempts = await tx.marketingPreflightRun.findUniqueOrThrow({
        where: { id: run.id },
        include: { attempts: true },
      });
      await this.recordEvent(
        tx,
        company.id,
        campaignId,
        campaign.revision,
        MarketingCampaignEventKind.PREFLIGHT_RUN,
        {
          preflightRunId: run.id,
          passed: result.passed,
          failedGates: result.failedGates,
        } as Prisma.InputJsonValue,
        user.id,
      );
      return withAttempts;
    });
  }

  async listPreflightRuns(campaignId: string, user: CurrentUser) {
    const company = requireActiveCompany(user);
    await this.findCampaign(campaignId, company.id);
    return this.prisma.marketingPreflightRun.findMany({
      where: { campaignId, companyId: company.id },
      orderBy: { createdAt: 'desc' },
      include: { attempts: true },
      take: 50,
    });
  }

  // -------------------------------------------------------------- 归因

  async recordAttribution(campaignId: string, dto: RecordAttributionDto, user: CurrentUser) {
    const company = requireActiveCompany(user);
    const campaign = await this.findCampaign(campaignId, company.id);
    const channel = normalizeChannel(dto.channel);
    const attribution = await this.prisma.marketingAttribution.create({
      data: {
        companyId: company.id,
        campaignId,
        channelPlanId: dto.channelPlanId ?? null,
        leadId: dto.leadId ?? null,
        contactPointId: dto.contactPointId ?? null,
        contactRef: dto.contactRef ?? null,
        channel,
        source: dto.source ?? null,
        meta: toNullableJson(dto.meta),
        attributedAt: dto.attributedAt ? new Date(dto.attributedAt) : new Date(),
      },
    });
    await this.prisma.marketingCampaignEvent.create({
      data: {
        companyId: company.id,
        campaignId,
        revision: campaign.revision,
        kind: MarketingCampaignEventKind.ATTRIBUTION_RECORDED,
        payload: { attributionId: attribution.id, channel, source: dto.source ?? null } as Prisma.InputJsonValue,
        payloadHash: digest({ attributionId: attribution.id, channel }),
        createdById: user.id,
      },
    });
    return attribution;
  }

  async listAttributions(campaignId: string, user: CurrentUser) {
    const company = requireActiveCompany(user);
    await this.findCampaign(campaignId, company.id);
    return this.prisma.marketingAttribution.findMany({
      where: { campaignId, companyId: company.id },
      orderBy: { attributedAt: 'desc' },
      take: 500,
    });
  }

  /**
   * 供执行侧（preview-gate / preview-recovery / 真实投放）复用的十道闸评估。
   * 解析 DB 实况后执行 marketing-execution.contract 纯函数契约。
   */
  async evaluateGate(
    campaignId: string,
    user: CurrentUser,
    opts: {
      contactRef?: string | null;
      channel?: string | null;
      leadId?: string | null;
      contactPointId?: string | null;
      channelPlanId?: string | null;
    } = {},
  ) {
    const company = requireActiveCompany(user);
    await this.findCampaign(campaignId, company.id);
    const ctx = await this.resolveExecutionContext(company.id, campaignId, opts);
    const result = evaluateMarketingExecutionContract(ctx);
    return { ctx, result };
  }

  // -------------------------------------------------------------- 排程

  async materializeSchedule(campaignId: string, user: CurrentUser) {
    const company = requireActiveCompany(user);
    const campaign = await this.findCampaign(campaignId, company.id);
    const materialized = materializeMarketingScheduleIntent({
      channel: campaign.channelPlans[0]?.channel ?? 'email',
      windowStart: campaign.windowStart?.toISOString() ?? null,
      windowEnd: campaign.windowEnd?.toISOString() ?? null,
      windowSeconds: campaign.channelPlans[0]?.windowSeconds ?? 0,
      maxPerContact: campaign.channelPlans[0]?.maxPerContact ?? 1,
    });
    const evaluation = evaluateMarketingScheduleAt({ intent: materialized });
    return {
      campaignId,
      materialized: {
        channel: materialized.channel,
        window: {
          start: materialized.window.start.toISOString(),
          end: materialized.window.end.toISOString(),
        },
        windowSeconds: materialized.windowSeconds,
        maxPerContact: materialized.maxPerContact,
        slotCount: materialized.slots.length,
      },
      evaluation,
    };
  }
}
