/**
 * sales-delivery.service.ts
 *
 * wesley-ai-crm 批次3：报价交付回执链（核心闭环）。
 * - renderQuote：quote 内容快照哈希 → 复用 quotes 模块 PDF 渲染 → 落 QuoteRenderJob
 * - dispatchOutbound：创建 OutboundRequest（DISPATCHING）→ 人工审批 → 发送
 * - recordProviderReceipt：receiptKey 幂等写回执 → 更新 OutboundRequest 状态
 * - reconcile：UNKNOWN 按最新回执终结（SUCCEEDED/FAILED）
 *
 * 安全约定：
 * - 所有写操作租户隔离（requireActiveCompany + companyId 过滤）
 * - 审批禁止自我审批（requesterId === 决策者 → Forbidden）
 * - 状态转移用乐观并发（revision）避免并发覆盖
 */

import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  Prisma,
  SalesDeliveryApprovalStatus,
  SalesDeliveryChannel,
  SalesDeliveryOutboundStatus,
  SalesDeliveryReceiptOutcome,
  SalesDeliveryRenderJobStatus,
} from '@prisma/client';
import { PrismaService } from '../../common/prisma/prisma.service';
import {
  CurrentUser,
  requireActiveCompany,
} from '../../common/utils/data-isolation';
import { QuotesService } from '../quotes/quotes.service';
import { SalesDeliveryAdapterRegistry } from './sales-delivery-adapters';
import { DispatchOutboundDto } from './dto/dispatch-outbound.dto';
import { CreateApprovalRequestDto } from './dto/approval-request.dto';
import { ApprovalDecisionDto } from './dto/approval-decision.dto';

const RENDER_LEASE_MS = 5 * 60 * 1000;
const RENDER_RETRY_BACKOFF_MS = 60 * 1000;
const OUTBOUND_RETRY_BACKOFF_MS = 2 * 60 * 1000;
const APPROVAL_TTL_MS = 24 * 60 * 60 * 1000;
const RECONCILE_WINDOW_MS = 15 * 60 * 1000;
const RECONCILE_HARD_TTL_MS = 60 * 60 * 1000;
const MAX_RECONCILE_SCAN = 200;

function truncate(value: string, max = 1000): string {
  return value.length > max ? `${value.slice(0, max)}…` : value;
}

/** 归一化渠道：'email'|'whatsapp'|'meta' 或枚举名 EMAIL/WHATSAPP/META */
export function toSalesDeliveryChannel(
  value: string | SalesDeliveryChannel,
): SalesDeliveryChannel {
  const normalized = String(value).toUpperCase();
  if (normalized === 'EMAIL') return SalesDeliveryChannel.EMAIL;
  if (normalized === 'WHATSAPP') return SalesDeliveryChannel.WHATSAPP;
  if (normalized === 'META') return SalesDeliveryChannel.META;
  throw new BadRequestException(`Unsupported delivery channel: ${value}`);
}

/** 供应商回执 → 渠道投递结果枚举 */
export function mapReceiptOutcome(
  payload: Record<string, any>,
): SalesDeliveryReceiptOutcome {
  const raw = String(
    payload?.status ?? payload?.event ?? payload?.deliveryStatus ?? '',
  ).toLowerCase();
  if (raw.includes('read')) return SalesDeliveryReceiptOutcome.READ;
  if (raw.includes('deliver')) return SalesDeliveryReceiptOutcome.DELIVERED;
  if (raw.includes('sent') || raw.includes('queue') || raw.includes('send')) {
    return SalesDeliveryReceiptOutcome.SENT;
  }
  if (
    raw.includes('fail')
    || raw.includes('bounce')
    || raw.includes('reject')
    || raw.includes('error')
  ) {
    return SalesDeliveryReceiptOutcome.FAILED;
  }
  if (raw.includes('defer') || raw.includes('pending') || raw.includes('retry')) {
    return SalesDeliveryReceiptOutcome.DEFERRED;
  }
  return SalesDeliveryReceiptOutcome.UNKNOWN;
}

/** 回执 outcome → 终结态（DEFERRED/UNKNOWN 不终结） */
function terminateStatusForOutcome(
  outcome: SalesDeliveryReceiptOutcome,
): SalesDeliveryOutboundStatus | null {
  if (outcome === SalesDeliveryReceiptOutcome.DELIVERED
    || outcome === SalesDeliveryReceiptOutcome.READ
    || outcome === SalesDeliveryReceiptOutcome.SENT) {
    return SalesDeliveryOutboundStatus.SUCCEEDED;
  }
  if (outcome === SalesDeliveryReceiptOutcome.FAILED
    || outcome === SalesDeliveryReceiptOutcome.REJECTED) {
    return SalesDeliveryOutboundStatus.FAILED;
  }
  return null;
}

function isValidEmail(value: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

function isValidPhone(value: string): boolean {
  return /^\+?[0-9]{6,15}$/.test(value.replace(/[\s-]/g, ''));
}

@Injectable()
export class SalesDeliveryService {
  private readonly logger = new Logger(SalesDeliveryService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly quotes: QuotesService,
    private readonly adapters: SalesDeliveryAdapterRegistry,
  ) {}

  // ========== 报价渲染 ==========

  /**
   * 渲染报价 PDF：校验 quote 版本快照 → 调我方 PDF 渲染 → 存结果 → 返回 render job。
   * 幂等：同 quoteHash 已有任务直接复用；forceRefresh 强制新建版本。
   */
  async renderQuote(
    quoteId: string,
    user: CurrentUser,
    opts: { forceRefresh?: boolean } = {},
  ) {
    const company = requireActiveCompany(user);
    const quote = await this.prisma.quote.findFirst({
      where: { id: quoteId, companyId: company.id },
      include: { lineItems: { orderBy: { sortOrder: 'asc' } } },
    });
    if (!quote) throw new NotFoundException('Quote not found');

    const quoteHash = this.quoteSnapshotHash(quote as any);

    let job = await this.prisma.quoteRenderJob.findFirst({
      where: { quoteId, quoteHash },
      orderBy: { quoteVersion: 'desc' },
    });
    if (job && !opts.forceRefresh) {
      if (
        job.status === SalesDeliveryRenderJobStatus.COMPLETED
        || job.status === SalesDeliveryRenderJobStatus.PROCESSING
        || job.status === SalesDeliveryRenderJobStatus.QUEUED
      ) {
        return job;
      }
      // FAILED/DEAD_LETTER：允许重试（复用同一行，attempt 计数延续）
    }

    if (!job) {
      const nextVersion = await this.nextQuoteVersion(quoteId);
      job = await this.prisma.quoteRenderJob.create({
        data: {
          companyId: company.id,
          quoteId,
          quoteVersion: nextVersion,
          quoteHash,
          createdById: user.id,
        },
      });
    }

    return this.executeRenderJob(job.id, company.id, quoteId, user);
  }

  /** 领取 lease 并同步渲染（QUEUED/FAILED/DEAD_LETTER → PROCESSING → COMPLETED/FAILED） */
  private async executeRenderJob(
    jobId: string,
    companyId: string,
    quoteId: string,
    user: CurrentUser,
  ) {
    const leaseId = randomUUID();
    const leaseExpiresAt = new Date(Date.now() + RENDER_LEASE_MS);
    const claimed = await this.prisma.quoteRenderJob.updateMany({
      where: {
        id: jobId,
        companyId,
        status: {
          in: [
            SalesDeliveryRenderJobStatus.QUEUED,
            SalesDeliveryRenderJobStatus.FAILED,
            SalesDeliveryRenderJobStatus.DEAD_LETTER,
          ],
        },
      },
      data: {
        status: SalesDeliveryRenderJobStatus.PROCESSING,
        leaseId,
        leaseExpiresAt,
        attempt: { increment: 1 },
      },
    });
    if (claimed.count !== 1) {
      // 已被其他执行者抢占 → 返回当前状态
      return this.prisma.quoteRenderJob.findUniqueOrThrow({ where: { id: jobId } });
    }

    try {
      const html = await this.quotes.generatePiHtml(quoteId, user);
      const pdfBuffer = await this.quotes.htmlToPdf(html);
      const { assetPath, assetUrl } = this.persistPdf(companyId, quoteId, jobId, pdfBuffer);
      await this.prisma.quoteRenderJob.updateMany({
        where: { id: jobId, companyId, leaseId },
        data: {
          status: SalesDeliveryRenderJobStatus.COMPLETED,
          assetPath,
          assetUrl,
          leaseId: null,
          leaseExpiresAt: null,
          error: null,
          completedAt: new Date(),
        },
      });
    } catch (err: any) {
      const message = truncate(String(err?.message ?? 'render failed'));
      const job = await this.prisma.quoteRenderJob.findUniqueOrThrow({ where: { id: jobId } });
      await this.prisma.quoteRenderJob.updateMany({
        where: { id: jobId, companyId, leaseId },
        data: {
          status: SalesDeliveryRenderJobStatus.FAILED,
          error: message,
          leaseId: null,
          leaseExpiresAt: null,
          nextRetryAt: new Date(
            Date.now() + RENDER_RETRY_BACKOFF_MS * Math.max(1, job.attempt),
          ),
        },
      });
    }

    return this.prisma.quoteRenderJob.findUniqueOrThrow({ where: { id: jobId } });
  }

  async getRenderJob(quoteId: string, jobId: string, user: CurrentUser) {
    const company = requireActiveCompany(user);
    const job = await this.prisma.quoteRenderJob.findFirst({
      where: { id: jobId, quoteId, companyId: company.id },
    });
    if (!job) throw new NotFoundException('Render job not found');
    return job;
  }

  async listRenderJobs(quoteId: string, user: CurrentUser) {
    const company = requireActiveCompany(user);
    return this.prisma.quoteRenderJob.findMany({
      where: { quoteId, companyId: company.id },
      orderBy: { createdAt: 'desc' },
    });
  }

  // ========== 外发 ==========

  /** 创建 OutboundRequest → 人工审批（PENDING）→ 等待决策后发送 */
  async dispatchOutbound(quoteId: string, dto: DispatchOutboundDto, user: CurrentUser) {
    const company = requireActiveCompany(user);
    const quote = await this.prisma.quote.findFirst({
      where: { id: quoteId, companyId: company.id },
      select: { id: true },
    });
    if (!quote) throw new NotFoundException('Quote not found');

    const channel = toSalesDeliveryChannel(dto.channel);
    if (!this.isValidTarget(channel, dto.target)) {
      throw new BadRequestException(
        `Invalid target for channel ${channel}: ${dto.target}`,
      );
    }

    // 前置：报价必须已有 COMPLETED 渲染结果（必要时自动渲染一次）
    let renderJob = await this.prisma.quoteRenderJob.findFirst({
      where: { quoteId, status: SalesDeliveryRenderJobStatus.COMPLETED },
      orderBy: { quoteVersion: 'desc' },
    });
    if (!renderJob) {
      const rendered = await this.renderQuote(quoteId, user);
      if (rendered.status !== SalesDeliveryRenderJobStatus.COMPLETED) {
        throw new BadRequestException(
          `Quote has no completed render job (current: ${rendered.status}); POST /sales-delivery/quotes/${quoteId}/render-jobs first`,
        );
      }
      renderJob = rendered;
    }

    let binding = null;
    if (dto.connectionBindingId) {
      binding = await this.prisma.deliveryConnectionBinding.findFirst({
        where: { id: dto.connectionBindingId, companyId: company.id, provider: channel },
      });
      if (!binding) {
        throw new NotFoundException('Delivery connection binding not found for this channel');
      }
    } else {
      binding = await this.prisma.deliveryConnectionBinding.findFirst({
        where: { companyId: company.id, provider: channel, active: true },
      });
    }

    const payloadHash = createHash('sha256')
      .update(JSON.stringify({ quoteId, channel, target: dto.target, renderJobId: renderJob.id }))
      .digest('hex');

    const outbound = await this.prisma.outboundRequest.create({
      data: {
        companyId: company.id,
        quoteId,
        renderJobId: renderJob.id,
        channel,
        target: dto.target,
        subject: dto.subject ?? null,
        body: dto.body ?? null,
        status: SalesDeliveryOutboundStatus.DISPATCHING,
        connectionBindingId: binding?.id ?? null,
        payloadHash,
        createdById: user.id,
      },
    });

    const approval = await this.prisma.outboundApprovalRequest.create({
      data: {
        companyId: company.id,
        quoteId,
        outboundRequestId: outbound.id,
        requesterId: user.id,
        status: SalesDeliveryApprovalStatus.PENDING,
        expiresAt: new Date(Date.now() + APPROVAL_TTL_MS),
      },
    });

    return { outboundRequest: outbound, approvalRequest: approval };
  }

  async getOutbound(outboundId: string, user: CurrentUser) {
    const company = requireActiveCompany(user);
    const outbound = await this.findOutbound(outboundId, company.id);
    const [receipts, approvals, renderJob, quote, binding] = await Promise.all([
      this.prisma.outboundProviderReceipt.findMany({
        where: { outboundRequestId: outbound.id },
        orderBy: { createdAt: 'desc' },
        take: 50,
      }),
      this.prisma.outboundApprovalRequest.findMany({
        where: { outboundRequestId: outbound.id },
        orderBy: { createdAt: 'desc' },
      }),
      outbound.renderJobId
        ? this.prisma.quoteRenderJob.findUnique({ where: { id: outbound.renderJobId } })
        : null,
      this.prisma.quote.findUnique({
        where: { id: outbound.quoteId },
        select: { id: true, referenceNo: true, status: true, currency: true, totalAmount: true },
      }),
      outbound.connectionBindingId
        ? this.prisma.deliveryConnectionBinding.findUnique({ where: { id: outbound.connectionBindingId } })
        : null,
    ]);
    return { ...outbound, quote, renderJob, receipts, approvals, connectionBinding: binding };
  }

  /** 发送前检查：报价/渲染/目标/绑定/审批/渠道开关 */
  async preflight(outboundId: string, user: CurrentUser) {
    const company = requireActiveCompany(user);
    const outbound = await this.findOutbound(outboundId, company.id);

    const quote = await this.prisma.quote.findUnique({ where: { id: outbound.quoteId } });
    const renderJob = outbound.renderJobId
      ? await this.prisma.quoteRenderJob.findUnique({ where: { id: outbound.renderJobId } })
      : null;
    const binding = outbound.connectionBindingId
      ? await this.prisma.deliveryConnectionBinding.findFirst({
          where: { id: outbound.connectionBindingId, companyId: company.id },
        })
      : await this.prisma.deliveryConnectionBinding.findFirst({
          where: { companyId: company.id, provider: outbound.channel, active: true },
        });
    const pendingApproval = await this.prisma.outboundApprovalRequest.findFirst({
      where: { outboundRequestId: outbound.id, status: SalesDeliveryApprovalStatus.PENDING },
      orderBy: { createdAt: 'desc' },
    });
    const channelEnabled =
      (process.env[`SALES_DELIVERY_CHANNEL_${outbound.channel}_ENABLED`] ?? 'true')
        .trim()
        .toLowerCase() !== 'false';

    const checks = [
      {
        gate: 'quote',
        passed: !!quote && quote.companyId === company.id,
        detail: quote ? 'quote exists' : 'quote missing',
      },
      {
        gate: 'render',
        passed: renderJob?.status === SalesDeliveryRenderJobStatus.COMPLETED,
        detail: renderJob ? `render status=${renderJob.status}` : 'no render job',
      },
      {
        gate: 'target',
        passed: this.isValidTarget(outbound.channel, outbound.target),
        detail: outbound.target,
      },
      {
        gate: 'binding',
        passed: !!binding?.active,
        detail: binding ? `binding=${binding.connectionId} active=${binding.active}` : 'no active binding',
      },
      {
        gate: 'approval',
        passed: pendingApproval !== null,
        detail: pendingApproval ? `pending approval ${pendingApproval.id}` : 'no pending approval',
      },
      { gate: 'channel-enabled', passed: channelEnabled, detail: String(outbound.channel) },
    ];
    return {
      outboundId: outbound.id,
      status: outbound.status,
      passed: checks.every((c) => c.passed),
      checks,
    };
  }

  /** 取消外发（仅非终态） */
  async cancel(outboundId: string, user: CurrentUser) {
    const company = requireActiveCompany(user);
    const outbound = await this.findOutbound(outboundId, company.id);
    if (
      outbound.status === SalesDeliveryOutboundStatus.SUCCEEDED
      || outbound.status === SalesDeliveryOutboundStatus.FAILED
      || outbound.status === SalesDeliveryOutboundStatus.CANCELLED
    ) {
      throw new ConflictException(`Cannot cancel outbound in ${outbound.status} state`);
    }
    const updated = await this.prisma.outboundRequest.updateMany({
      where: { id: outbound.id, companyId: company.id, revision: outbound.revision },
      data: {
        status: SalesDeliveryOutboundStatus.CANCELLED,
        cancelledAt: new Date(),
        nextRetryAt: null,
        revision: { increment: 1 },
      },
    });
    if (updated.count !== 1) {
      throw new ConflictException('Outbound request changed concurrently');
    }
    await this.prisma.outboundApprovalRequest.updateMany({
      where: { outboundRequestId: outbound.id, status: SalesDeliveryApprovalStatus.PENDING },
      data: { status: SalesDeliveryApprovalStatus.CANCELLED, reason: 'outbound cancelled' },
    });
    return this.prisma.outboundRequest.findUniqueOrThrow({ where: { id: outbound.id } });
  }

  /** 手动触发发送（仅 DISPATCHING/FAILED；存在 PENDING 审批时拒绝） */
  async dispatchOutboundById(outboundId: string, user: CurrentUser) {
    const company = requireActiveCompany(user);
    const outbound = await this.findOutbound(outboundId, company.id);
    if (
      outbound.status !== SalesDeliveryOutboundStatus.DISPATCHING
      && outbound.status !== SalesDeliveryOutboundStatus.FAILED
    ) {
      throw new ConflictException(`Cannot dispatch outbound in ${outbound.status} state`);
    }
    const pending = await this.prisma.outboundApprovalRequest.findFirst({
      where: { outboundRequestId: outbound.id, status: SalesDeliveryApprovalStatus.PENDING },
    });
    if (pending) {
      throw new ConflictException(
        'Outbound is awaiting human approval; decide the pending approval request first',
      );
    }
    return this.dispatchOutboundRequest(outbound.id, company.id);
  }

  // ========== 人工审批 ==========

  /** 报价级审批请求（可挂到具体外发） */
  async createApprovalRequest(
    quoteId: string,
    dto: CreateApprovalRequestDto,
    user: CurrentUser,
  ) {
    const company = requireActiveCompany(user);
    const quote = await this.prisma.quote.findFirst({
      where: { id: quoteId, companyId: company.id },
      select: { id: true },
    });
    if (!quote) throw new NotFoundException('Quote not found');

    let outboundRequestId: string | null = dto.outboundRequestId ?? null;
    if (outboundRequestId) {
      const outbound = await this.findOutbound(outboundRequestId, company.id);
      if (outbound.quoteId !== quoteId) {
        throw new BadRequestException('Outbound request does not belong to this quote');
      }
      const pending = await this.prisma.outboundApprovalRequest.findFirst({
        where: { outboundRequestId, status: SalesDeliveryApprovalStatus.PENDING },
      });
      if (pending) return pending;
    }

    return this.prisma.outboundApprovalRequest.create({
      data: {
        companyId: company.id,
        quoteId,
        outboundRequestId,
        requesterId: user.id,
        status: SalesDeliveryApprovalStatus.PENDING,
        expiresAt: new Date(Date.now() + APPROVAL_TTL_MS),
      },
    });
  }

  /** 外发级审批请求 */
  async createOutboundApprovalRequest(outboundId: string, user: CurrentUser) {
    const company = requireActiveCompany(user);
    const outbound = await this.findOutbound(outboundId, company.id);
    const pending = await this.prisma.outboundApprovalRequest.findFirst({
      where: { outboundRequestId: outbound.id, status: SalesDeliveryApprovalStatus.PENDING },
    });
    if (pending) return pending;
    return this.prisma.outboundApprovalRequest.create({
      data: {
        companyId: company.id,
        quoteId: outbound.quoteId,
        outboundRequestId: outbound.id,
        requesterId: user.id,
        status: SalesDeliveryApprovalStatus.PENDING,
        expiresAt: new Date(Date.now() + APPROVAL_TTL_MS),
      },
    });
  }

  /** 报价级审批决策 */
  async decideApproval(
    quoteId: string,
    approvalId: string,
    dto: ApprovalDecisionDto,
    user: CurrentUser,
  ) {
    const company = requireActiveCompany(user);
    const approval = await this.prisma.outboundApprovalRequest.findFirst({
      where: { id: approvalId, companyId: company.id },
    });
    if (!approval) throw new NotFoundException('Approval request not found');
    if (approval.quoteId && approval.quoteId !== quoteId) {
      throw new ForbiddenException('Approval request does not belong to this quote');
    }
    return this.decideApprovalInternal(approval, dto, user, company.id);
  }

  /** 外发级审批决策（approvalId 缺省取最新 PENDING） */
  async decideOutboundApproval(
    outboundId: string,
    dto: ApprovalDecisionDto,
    user: CurrentUser,
  ) {
    const company = requireActiveCompany(user);
    const outbound = await this.findOutbound(outboundId, company.id);
    let approvalId = dto.approvalId;
    if (!approvalId) {
      const pending = await this.prisma.outboundApprovalRequest.findFirst({
        where: { outboundRequestId: outbound.id, status: SalesDeliveryApprovalStatus.PENDING },
        orderBy: { createdAt: 'desc' },
      });
      approvalId = pending?.id;
    }
    if (!approvalId) {
      throw new NotFoundException('No pending approval request for this outbound');
    }
    const approval = await this.prisma.outboundApprovalRequest.findFirst({
      where: { id: approvalId, companyId: company.id, outboundRequestId: outbound.id },
    });
    if (!approval) throw new NotFoundException('Approval request not found');
    return this.decideApprovalInternal(approval, dto, user, company.id);
  }

  private async decideApprovalInternal(
    approval: {
      id: string;
      companyId: string;
      quoteId: string | null;
      outboundRequestId: string | null;
      requesterId: string;
      status: SalesDeliveryApprovalStatus;
    },
    dto: ApprovalDecisionDto,
    user: CurrentUser,
    companyId: string,
  ) {
    // 禁止自我审批
    if (approval.requesterId === user.id) {
      throw new ForbiddenException('Self-approval is not allowed');
    }
    if (approval.status !== SalesDeliveryApprovalStatus.PENDING) {
      throw new ConflictException('Approval already decided');
    }
    const now = new Date();
    const updated = await this.prisma.outboundApprovalRequest.updateMany({
      where: {
        id: approval.id,
        companyId,
        status: SalesDeliveryApprovalStatus.PENDING,
      },
      data: {
        status:
          dto.decision === 'approve'
            ? SalesDeliveryApprovalStatus.APPROVED
            : SalesDeliveryApprovalStatus.REJECTED,
        decision: dto.decision,
        reason: dto.reason ?? null,
        approverId: user.id,
        decidedAt: now,
      },
    });
    if (updated.count !== 1) {
      throw new ConflictException('Approval already decided');
    }
    const decided = await this.prisma.outboundApprovalRequest.findUniqueOrThrow({
      where: { id: approval.id },
    });

    if (dto.decision === 'approve' && approval.outboundRequestId) {
      await this.dispatchOutboundRequest(approval.outboundRequestId, companyId);
    }
    if (dto.decision === 'reject' && approval.outboundRequestId) {
      await this.cancelOutboundRecord(
        approval.outboundRequestId,
        companyId,
        'Approval rejected',
      );
    }
    return decided;
  }

  // ========== 回执 ==========

  /**
   * 供应商回执（Webhook 已做 HMAC 校验）：receiptKey 幂等 → 更新 OutboundRequest。
   * 返回 { ok, duplicate, applied, receipt }。
   */
  async recordProviderReceipt(
    provider: string | SalesDeliveryChannel,
    payload: Record<string, any>,
    connectionId: string,
  ) {
    const channel = toSalesDeliveryChannel(provider);
    const receiptKey = String(
      payload?.receiptKey ?? payload?.messageId ?? payload?.id ?? '',
    ).trim();
    if (!receiptKey) {
      throw new BadRequestException(
        'Receipt missing receiptKey/messageId/id — cannot deduplicate',
      );
    }

    // 通过连接绑定解析租户
    const binding = await this.prisma.deliveryConnectionBinding.findFirst({
      where: { provider: channel, connectionId, active: true },
    });
    if (!binding) {
      this.logger.warn(
        `receipt ignored: no active binding provider=${channel} connectionId=${connectionId}`,
      );
      return {
        ok: false,
        reason: 'no active connection binding for provider+connectionId',
        receiptKey,
      };
    }
    const companyId = binding.companyId;

    // 幂等：receiptKey 已存在 → 直接返回
    const existing = await this.prisma.outboundProviderReceipt.findUnique({
      where: { provider_receiptKey: { provider: channel, receiptKey } },
    });
    if (existing) {
      return { ok: true, duplicate: true, applied: existing.processed, receipt: existing };
    }

    // 解析外发请求：显式 outboundRequestId 优先，否则按 providerMessageId 反查
    let outboundRequestId: string | null =
      String(payload?.outboundRequestId ?? '').trim() || null;
    if (!outboundRequestId) {
      const messageId = String(
        payload?.messageId ?? payload?.providerMessageId ?? '',
      ).trim();
      if (messageId) {
        const matched = await this.prisma.outboundRequest.findFirst({
          where: { companyId, providerMessageId: messageId },
          select: { id: true },
        });
        outboundRequestId = matched?.id ?? null;
      }
    }

    const outcome = mapReceiptOutcome(payload);
    const receipt = await this.prisma.outboundProviderReceipt.create({
      data: {
        companyId,
        outboundRequestId,
        provider: channel,
        receiptKey,
        outcome,
        raw: payload as Prisma.InputJsonValue,
        processed: false,
      },
    });

    let applied = false;
    if (outboundRequestId) {
      applied = await this.applyReceiptToOutbound(outboundRequestId, companyId, receipt);
    }
    return { ok: true, duplicate: false, applied, receipt };
  }

  /** 把回执应用到外发请求（乐观并发 revision；终态不回退） */
  private async applyReceiptToOutbound(
    outboundRequestId: string,
    companyId: string,
    receipt: { id: string; outcome: SalesDeliveryReceiptOutcome; raw: Prisma.JsonValue },
  ): Promise<boolean> {
    const outbound = await this.prisma.outboundRequest.findFirst({
      where: { id: outboundRequestId, companyId },
    });
    if (!outbound) return false;
    if (
      outbound.status === SalesDeliveryOutboundStatus.SUCCEEDED
      || outbound.status === SalesDeliveryOutboundStatus.FAILED
      || outbound.status === SalesDeliveryOutboundStatus.CANCELLED
    ) {
      await this.prisma.outboundProviderReceipt.updateMany({
        where: { id: receipt.id },
        data: { processed: true, processedAt: new Date() },
      });
      return false;
    }

    const now = new Date();
    const data: Prisma.OutboundRequestUpdateManyMutationInput = {
      revision: { increment: 1 },
    };
    switch (receipt.outcome) {
      case SalesDeliveryReceiptOutcome.DELIVERED:
      case SalesDeliveryReceiptOutcome.READ:
      case SalesDeliveryReceiptOutcome.SENT:
        data.status = SalesDeliveryOutboundStatus.SUCCEEDED;
        data.succeededAt = now;
        data.nextRetryAt = null;
        data.lastError = null;
        break;
      case SalesDeliveryReceiptOutcome.FAILED:
      case SalesDeliveryReceiptOutcome.REJECTED:
        data.status = SalesDeliveryOutboundStatus.FAILED;
        data.failedAt = now;
        data.nextRetryAt = null;
        data.lastError = truncate(
          String((receipt.raw as any)?.error ?? (receipt.raw as any)?.reason ?? 'provider reported failure'),
        );
        break;
      case SalesDeliveryReceiptOutcome.DEFERRED:
        data.status = SalesDeliveryOutboundStatus.UNKNOWN;
        data.nextRetryAt = new Date(Date.now() + OUTBOUND_RETRY_BACKOFF_MS);
        break;
      default:
        data.status = SalesDeliveryOutboundStatus.UNKNOWN;
    }

    const updated = await this.prisma.outboundRequest.updateMany({
      where: { id: outbound.id, companyId, revision: outbound.revision },
      data,
    });
    const applied = updated.count === 1;
    await this.prisma.outboundProviderReceipt.updateMany({
      where: { id: receipt.id },
      data: { processed: true, processedAt: new Date() },
    });
    return applied;
  }

  // ========== 对账 ==========

  /** 单个外发：UNKNOWN 按最新回执终结 */
  async reconcileOne(outboundId: string, user: CurrentUser) {
    const company = requireActiveCompany(user);
    return this.reconcileOutbound(outboundId, company.id);
  }

  /** 批量对账：UNKNOWN 超窗口的外发按最新回执终结 */
  async reconcile(user: CurrentUser) {
    const company = requireActiveCompany(user);
    const stale = await this.prisma.outboundRequest.findMany({
      where: {
        companyId: company.id,
        status: SalesDeliveryOutboundStatus.UNKNOWN,
        updatedAt: { lt: new Date(Date.now() - RECONCILE_WINDOW_MS) },
      },
      take: MAX_RECONCILE_SCAN,
      select: { id: true },
    });
    const results = [];
    for (const item of stale) {
      results.push(await this.reconcileOutbound(item.id, company.id));
    }
    return { scanned: stale.length, results };
  }

  private async reconcileOutbound(outboundId: string, companyId: string) {
    const outbound = await this.prisma.outboundRequest.findFirst({
      where: { id: outboundId, companyId },
    });
    if (!outbound) return { outboundId, reconciled: false, reason: 'not found' };
    if (outbound.status !== SalesDeliveryOutboundStatus.UNKNOWN) {
      return { outboundId, reconciled: false, reason: `status=${outbound.status}` };
    }
    const latest = await this.prisma.outboundProviderReceipt.findFirst({
      where: { outboundRequestId: outbound.id },
      orderBy: { createdAt: 'desc' },
    });

    let target: SalesDeliveryOutboundStatus | null = null;
    let reason = '';
    if (latest) {
      target = terminateStatusForOutcome(latest.outcome);
      reason = `latest receipt outcome=${latest.outcome}`;
    } else if (outbound.updatedAt < new Date(Date.now() - RECONCILE_HARD_TTL_MS)) {
      target = SalesDeliveryOutboundStatus.FAILED;
      reason = 'reconcile: no receipt within hard TTL';
    }

    if (!target) {
      return { outboundId, reconciled: false, reason: reason || 'still UNKNOWN' };
    }

    const now = new Date();
    const data: Prisma.OutboundRequestUpdateManyMutationInput = {
      status: target,
      revision: { increment: 1 },
      nextRetryAt: null,
    };
    if (target === SalesDeliveryOutboundStatus.SUCCEEDED) data.succeededAt = now;
    if (target === SalesDeliveryOutboundStatus.FAILED) {
      data.failedAt = now;
      data.lastError = reason;
    }
    const updated = await this.prisma.outboundRequest.updateMany({
      where: { id: outbound.id, companyId, revision: outbound.revision },
      data,
    });
    return {
      outboundId,
      reconciled: updated.count === 1,
      reason,
      status: target,
    };
  }

  // ========== 连接绑定（回执解析租户用） ==========

  async createConnectionBinding(
    dto: { provider: string; connectionId: string; label?: string; active?: boolean },
    user: CurrentUser,
  ) {
    const company = requireActiveCompany(user);
    const channel = toSalesDeliveryChannel(dto.provider);
    const existing = await this.prisma.deliveryConnectionBinding.findUnique({
      where: {
        companyId_provider_connectionId: {
          companyId: company.id,
          provider: channel,
          connectionId: dto.connectionId,
        },
      },
    });
    if (existing) return existing;
    return this.prisma.deliveryConnectionBinding.create({
      data: {
        companyId: company.id,
        provider: channel,
        connectionId: dto.connectionId,
        label: dto.label ?? null,
        active: dto.active ?? true,
        createdById: user.id,
      },
    });
  }

  async listConnectionBindings(user: CurrentUser) {
    const company = requireActiveCompany(user);
    return this.prisma.deliveryConnectionBinding.findMany({
      where: { companyId: company.id },
      orderBy: { createdAt: 'desc' },
    });
  }

  // ========== 内部工具 ==========

  private async findOutbound(outboundId: string, companyId: string) {
    const outbound = await this.prisma.outboundRequest.findFirst({
      where: { id: outboundId, companyId },
    });
    if (!outbound) throw new NotFoundException('Outbound request not found');
    return outbound;
  }

  private async cancelOutboundRecord(
    outboundId: string,
    companyId: string,
    reason: string,
  ) {
    const outbound = await this.prisma.outboundRequest.findFirst({
      where: { id: outboundId, companyId },
    });
    if (!outbound) return;
    if (outbound.status === SalesDeliveryOutboundStatus.CANCELLED) return;
    await this.prisma.outboundRequest.updateMany({
      where: { id: outbound.id, companyId, revision: outbound.revision },
      data: {
        status: SalesDeliveryOutboundStatus.CANCELLED,
        cancelledAt: new Date(),
        lastError: reason,
        nextRetryAt: null,
        revision: { increment: 1 },
      },
    });
  }

  /** 实际发送：适配器 → SENT/UNKNOWN（乐观并发 revision） */
  private async dispatchOutboundRequest(outboundId: string, companyId: string) {
    const outbound = await this.findOutbound(outboundId, companyId);
    if (
      outbound.status === SalesDeliveryOutboundStatus.SUCCEEDED
      || outbound.status === SalesDeliveryOutboundStatus.CANCELLED
      || outbound.status === SalesDeliveryOutboundStatus.SENT
    ) {
      return outbound;
    }
    if (
      outbound.status === SalesDeliveryOutboundStatus.FAILED
      && outbound.attemptCount >= outbound.maxAttempts
    ) {
      return outbound;
    }

    const adapter = this.adapters.get(outbound.channel);
    const renderJob = outbound.renderJobId
      ? await this.prisma.quoteRenderJob.findUnique({ where: { id: outbound.renderJobId } })
      : null;

    let attachment = null;
    if (renderJob?.assetPath && existsSync(renderJob.assetPath)) {
      attachment = {
        filename: `${outbound.quoteId}-quote.pdf`,
        buffer: readFileSync(renderJob.assetPath),
        contentType: renderJob.mimeType ?? 'application/pdf',
      };
    }

    const result = await adapter.send({
      to: outbound.target,
      subject: outbound.subject ?? `Quote ${outbound.quoteId} — delivery`,
      body: outbound.body ?? undefined,
      attachment,
    });

    const now = new Date();
    const nextStatus =
      result.outcome === 'SENT'
        ? SalesDeliveryOutboundStatus.SENT
        : SalesDeliveryOutboundStatus.UNKNOWN;
    const updated = await this.prisma.outboundRequest.updateMany({
      where: {
        id: outbound.id,
        companyId,
        revision: outbound.revision,
        status: outbound.status,
      },
      data: {
        status: nextStatus,
        revision: { increment: 1 },
        attemptCount: { increment: 1 },
        providerMessageId: result.providerMessageId,
        sentAt: nextStatus === SalesDeliveryOutboundStatus.SENT ? now : null,
        lastError:
          result.outcome === 'DEFERRED'
            ? truncate(result.detail ?? 'provider deferred')
            : null,
        nextRetryAt:
          nextStatus === SalesDeliveryOutboundStatus.UNKNOWN
            ? new Date(Date.now() + OUTBOUND_RETRY_BACKOFF_MS)
            : null,
      },
    });
    if (updated.count !== 1) {
      throw new ConflictException('Outbound request changed concurrently');
    }
    return this.prisma.outboundRequest.findUniqueOrThrow({ where: { id: outbound.id } });
  }

  private isValidTarget(channel: SalesDeliveryChannel, target: string): boolean {
    const value = String(target ?? '').trim();
    if (channel === SalesDeliveryChannel.EMAIL) return isValidEmail(value);
    if (channel === SalesDeliveryChannel.WHATSAPP) return isValidPhone(value);
    return value.length > 0 && value.length <= 512;
  }

  private async nextQuoteVersion(quoteId: string): Promise<number> {
    const agg = await this.prisma.quoteRenderJob.aggregate({
      where: { quoteId },
      _max: { quoteVersion: true },
    });
    return (agg._max.quoteVersion ?? 0) + 1;
  }

  /** quote + lineItems 规范化快照哈希（排除易变字段） */
  private quoteSnapshotHash(quote: any): string {
    const canonical = JSON.stringify({
      referenceNo: quote.referenceNo,
      type: quote.type,
      status: quote.status,
      currency: quote.currency,
      tradeTerms: quote.tradeTerms,
      paymentTerms: quote.paymentTerms,
      deliveryTime: quote.deliveryTime,
      sampleFee: quote.sampleFee ?? null,
      moldFee: quote.moldFee ?? null,
      discount: quote.discount ?? 0,
      taxRate: quote.taxRate ?? null,
      subtotal: quote.subtotal ?? 0,
      taxAmount: quote.taxAmount ?? 0,
      totalAmount: quote.totalAmount ?? 0,
      notes: quote.notes ?? null,
      validUntil: quote.validUntil ?? null,
      lineItems: (quote.lineItems ?? []).map((item: any) => ({
        productCode: item.productCode ?? null,
        productName: item.productName,
        material: item.material ?? null,
        size: item.size ?? null,
        thickness: item.thickness ?? null,
        color: item.color ?? null,
        printing: item.printing ?? null,
        quantity: item.quantity,
        unit: item.unit ?? null,
        unitPrice: item.unitPrice ?? null,
        totalPrice: item.totalPrice ?? null,
        notes: item.notes ?? null,
        sortOrder: item.sortOrder ?? 0,
      })),
    });
    return `sha256:${createHash('sha256').update(canonical).digest('hex')}`;
  }

  /** PDF 落盘：SALES_DELIVERY_ASSET_DIR（默认 os.tmpdir()/sales-delivery） */
  private persistPdf(
    companyId: string,
    quoteId: string,
    jobId: string,
    buffer: Buffer,
  ): { assetPath: string; assetUrl: string } {
    const root =
      (process.env.SALES_DELIVERY_ASSET_DIR || '').trim()
      || path.join(os.tmpdir(), 'sales-delivery');
    const dir = path.join(root, companyId, quoteId);
    mkdirSync(dir, { recursive: true });
    const filename = `${jobId}.pdf`;
    const filePath = path.join(dir, filename);
    writeFileSync(filePath, buffer);
    const baseUrl = (process.env.SALES_DELIVERY_ASSET_BASE_URL || '').trim();
    const assetUrl = baseUrl
      ? `${baseUrl.replace(/\/$/, '')}/sales-delivery/${companyId}/${quoteId}/${filename}`
      : `file://${filePath}`;
    return { assetPath: filePath, assetUrl };
  }
}
