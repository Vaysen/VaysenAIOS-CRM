/**
 * sales-delivery-recovery.service.ts
 *
 * wesley-ai-crm 批次3：交付恢复服务。
 * - recoverStaleRenderLeases：PROCESSING 且 lease 过期 → 重排 QUEUED（超限 → DEAD_LETTER）
 * - retryFailedRenderJobs：FAILED 到期（nextRetryAt ≤ now）→ QUEUED（≤ maxAttempts），超限 DEAD_LETTER
 * - retryFailedOutbounds：FAILED 到期 → DISPATCHING（≤ maxAttempts），超限保持 FAILED（dead）
 * - heartbeat / listHeartbeats / sweepStaleWorkers：worker 心跳
 * - run()：一键恢复入口（重排后直接复用核心 service 重试发送）
 */

import { Injectable, Logger } from '@nestjs/common';
import {
  SalesDeliveryOutboundStatus,
  SalesDeliveryRenderJobStatus,
} from '@prisma/client';
import { PrismaService } from '../../common/prisma/prisma.service';
import {
  CurrentUser,
  requireActiveCompany,
} from '../../common/utils/data-isolation';
import { SalesDeliveryService } from './sales-delivery.service';

const RENDER_LEASE_STALE_MS = 5 * 60 * 1000;
const WORKER_STALE_MS = 5 * 60 * 1000;
const SCAN_LIMIT = 200;

@Injectable()
export class SalesDeliveryRecoveryService {
  private readonly logger = new Logger(SalesDeliveryRecoveryService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly core: SalesDeliveryService,
  ) {}

  /** 恢复过期 lease：PROCESSING 超时 → 重排 QUEUED；attempt 超限 → DEAD_LETTER */
  async recoverStaleRenderLeases(now: Date = new Date()) {
    const stale = await this.prisma.quoteRenderJob.findMany({
      where: {
        status: SalesDeliveryRenderJobStatus.PROCESSING,
        leaseExpiresAt: { lt: now },
      },
      take: SCAN_LIMIT,
    });
    let requeued = 0;
    let deadLettered = 0;
    for (const job of stale) {
      const exhausted = job.attempt >= job.maxAttempts;
      const updated = await this.prisma.quoteRenderJob.updateMany({
        where: { id: job.id, status: SalesDeliveryRenderJobStatus.PROCESSING, leaseId: job.leaseId },
        data: exhausted
          ? {
              status: SalesDeliveryRenderJobStatus.DEAD_LETTER,
              leaseId: null,
              leaseExpiresAt: null,
              error: 'dead letter: render lease expired beyond max attempts',
            }
          : {
              status: SalesDeliveryRenderJobStatus.QUEUED,
              leaseId: null,
              leaseExpiresAt: null,
              error: 'requeued: render lease expired',
            },
      });
      if (updated.count === 1) {
        if (exhausted) deadLettered += 1;
        else requeued += 1;
      }
    }
    return { scanned: stale.length, requeued, deadLettered };
  }

  /** FAILED 渲染任务到期重试（≤ maxAttempts）；超限 → DEAD_LETTER */
  async retryFailedRenderJobs(now: Date = new Date()) {
    const due = await this.prisma.quoteRenderJob.findMany({
      where: {
        status: SalesDeliveryRenderJobStatus.FAILED,
        nextRetryAt: { lte: now },
      },
      take: SCAN_LIMIT,
    });
    let requeued = 0;
    let deadLettered = 0;
    for (const job of due) {
      const exhausted = job.attempt >= job.maxAttempts;
      const updated = await this.prisma.quoteRenderJob.updateMany({
        where: { id: job.id, status: SalesDeliveryRenderJobStatus.FAILED },
        data: exhausted
          ? {
              status: SalesDeliveryRenderJobStatus.DEAD_LETTER,
              error: 'dead letter: max attempts exceeded',
            }
          : {
              status: SalesDeliveryRenderJobStatus.QUEUED,
              nextRetryAt: null,
              error: null,
            },
      });
      if (updated.count === 1) {
        if (exhausted) deadLettered += 1;
        else requeued += 1;
      }
    }
    return { scanned: due.length, requeued, deadLettered };
  }

  /** FAILED 外发到期重试（≤ maxAttempts）→ DISPATCHING；超限保持 FAILED */
  async retryFailedOutbounds(companyId: string, now: Date = new Date()) {
    const due = await this.prisma.outboundRequest.findMany({
      where: {
        companyId,
        status: SalesDeliveryOutboundStatus.FAILED,
        nextRetryAt: { lte: now },
      },
      take: SCAN_LIMIT,
    });
    const requeued: Array<{ id: string }> = [];
    let dead = 0;
    for (const outbound of due) {
      if (outbound.attemptCount >= outbound.maxAttempts) {
        const updated = await this.prisma.outboundRequest.updateMany({
          where: { id: outbound.id, companyId, status: SalesDeliveryOutboundStatus.FAILED },
          data: {
            lastError: outbound.lastError
              ? `${outbound.lastError} | dead letter: max attempts exceeded`
              : 'dead letter: max attempts exceeded',
          },
        });
        if (updated.count === 1) dead += 1;
        continue;
      }
      const updated = await this.prisma.outboundRequest.updateMany({
        where: { id: outbound.id, companyId, status: SalesDeliveryOutboundStatus.FAILED },
        data: {
          status: SalesDeliveryOutboundStatus.DISPATCHING,
          nextRetryAt: null,
          revision: { increment: 1 },
        },
      });
      if (updated.count === 1) requeued.push({ id: outbound.id });
    }
    return { scanned: due.length, requeued, dead };
  }

  /** 一键恢复：租户内 lease/重试/心跳，并对重排后的外发直接重试发送 */
  async run(user: CurrentUser) {
    const company = requireActiveCompany(user);
    const leases = await this.recoverStaleRenderLeases();
    const renderRetries = await this.retryFailedRenderJobs();
    const outboundRetries = await this.retryFailedOutbounds(company.id);

    const dispatched: any[] = [];
    for (const item of outboundRetries.requeued) {
      try {
        dispatched.push(await this.core.dispatchOutboundById(item.id, user));
      } catch (err: any) {
        this.logger.warn(
          `recovery dispatch failed for outbound ${item.id}: ${err?.message ?? 'unknown'}`,
        );
      }
    }

    const staleWorkers = await this.sweepStaleWorkers();

    return {
      render: { leases, retries: renderRetries },
      outbound: outboundRetries,
      dispatched: dispatched.length,
      staleWorkers,
    };
  }

  /** worker 心跳（upsert） */
  async heartbeat(
    workerId: string,
    nodeId?: string,
    companyId?: string | null,
  ) {
    const now = new Date();
    return this.prisma.salesDeliveryWorkerHeartbeat.upsert({
      where: { workerId },
      create: {
        workerId,
        nodeId: nodeId ?? null,
        companyId: companyId ?? null,
        status: 'alive',
        lastHeartbeatAt: now,
      },
      update: {
        nodeId: nodeId ?? undefined,
        companyId: companyId ?? undefined,
        status: 'alive',
        lastHeartbeatAt: now,
      },
    });
  }

  /** 心跳列表（当前租户） */
  async listHeartbeats(user: CurrentUser) {
    const company = requireActiveCompany(user);
    return this.prisma.salesDeliveryWorkerHeartbeat.findMany({
      where: { companyId: company.id },
      orderBy: { lastHeartbeatAt: 'desc' },
      take: 100,
    });
  }

  /** 心跳过期标记 dead */
  async sweepStaleWorkers(now: Date = new Date()) {
    const cutoff = new Date(now.getTime() - WORKER_STALE_MS);
    const updated = await this.prisma.salesDeliveryWorkerHeartbeat.updateMany({
      where: { status: 'alive', lastHeartbeatAt: { lt: cutoff } },
      data: { status: 'dead' },
    });
    return updated.count;
  }
}
