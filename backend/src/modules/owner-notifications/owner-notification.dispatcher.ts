import {
  Inject,
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
  Optional,
} from '@nestjs/common';
import { OwnerNotificationStatus } from '@prisma/client';
import { PrismaService } from '../../common/prisma/prisma.service';
import {
  OWNER_NOTIFICATION_SENDER,
  OwnerInboundEventType,
  OwnerNotificationSender,
} from './owner-notification.types';
import { redactOwnerNotificationText } from './owner-notification.service';

const DEFAULT_INTERVAL_MS = 15_000;
const DEFAULT_LEASE_MS = 5 * 60_000;
const DEFAULT_RETRY_MS = 30_000;

@Injectable()
export class OwnerNotificationDispatcher implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(OwnerNotificationDispatcher.name);
  private timer?: NodeJS.Timeout;

  constructor(
    private readonly prisma: PrismaService,
    @Optional()
    @Inject(OWNER_NOTIFICATION_SENDER)
    private readonly sender?: OwnerNotificationSender,
  ) {}

  onModuleInit() {
    if (!this.sender || process.env.NODE_ENV === 'test') {
      this.logger.log('Owner notification dispatcher is idle: no delivery adapter is registered');
      return;
    }
    const intervalMs = this.readPositiveInt(
      process.env.OWNER_NOTIFICATION_DISPATCH_INTERVAL_MS,
      DEFAULT_INTERVAL_MS,
      1_000,
      5 * 60_000,
    );
    this.timer = setInterval(() => {
      this.dispatchDue().catch((error: any) => {
        this.logger.error(`Owner notification dispatch cycle failed: ${this.safeError(error)}`);
      });
    }, intervalMs);
    this.timer.unref?.();
    void this.dispatchDue();
  }

  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  async dispatchDue(limit = 20, now = new Date()) {
    await this.recoverStaleClaims(now);
    await this.failExpired(now);
    if (!this.sender) {
      return { claimed: 0, sent: 0, failed: 0, reason: 'NO_DELIVERY_ADAPTER' };
    }

    const candidates = await this.prisma.ownerNotificationOutbox.findMany({
      where: {
        status: { in: [OwnerNotificationStatus.PENDING, OwnerNotificationStatus.FAILED] },
        nextAttemptAt: { lte: now },
        expiresAt: { gt: now },
      },
      orderBy: [{ nextAttemptAt: 'asc' }, { createdAt: 'asc' }],
      take: Math.max(1, Math.min(100, Math.trunc(limit))),
    });

    let claimed = 0;
    let sent = 0;
    let failed = 0;
    for (const candidate of candidates) {
      if (candidate.attempts >= candidate.maxAttempts) {
        await this.prisma.ownerNotificationOutbox.updateMany({
          where: { id: candidate.id, status: candidate.status },
          data: {
            status: OwnerNotificationStatus.FAILED,
            nextAttemptAt: null,
            failedAt: now,
            lastError: 'MAX_ATTEMPTS_EXHAUSTED',
          },
        });
        continue;
      }

      const claim = await this.prisma.ownerNotificationOutbox.updateMany({
        where: {
          id: candidate.id,
          status: candidate.status,
          attempts: candidate.attempts,
          nextAttemptAt: { lte: now },
          expiresAt: { gt: now },
        },
        data: {
          status: OwnerNotificationStatus.SENDING,
          attempts: { increment: 1 },
          claimedAt: now,
          failedAt: null,
          lastError: null,
        },
      });
      if (claim.count !== 1) continue;
      claimed += 1;
      const attempt = candidate.attempts + 1;

      try {
        const receipt = await this.sender.send({
          id: candidate.id,
          companyId: candidate.companyId,
          eventType: candidate.eventType as OwnerInboundEventType,
          destination: 'OWNER_WECHAT',
          subject: candidate.subject,
          preview: candidate.preview,
          sourceType: candidate.sourceType,
          sourceId: candidate.sourceId,
          conversationId: candidate.conversationId,
          leadId: candidate.leadId,
        });
        const provider = String(receipt?.provider || '').trim().slice(0, 64);
        const receiptId = String(receipt?.receiptId || '').trim().slice(0, 160);
        if (!provider || !receiptId) throw new Error('MISSING_DELIVERY_RECEIPT');

        const completed = await this.prisma.ownerNotificationOutbox.updateMany({
          where: { id: candidate.id, status: OwnerNotificationStatus.SENDING },
          data: {
            status: OwnerNotificationStatus.SENT,
            provider,
            providerReceiptId: receiptId,
            sentAt: new Date(),
            nextAttemptAt: null,
            lastError: null,
          },
        });
        if (completed.count === 1) sent += 1;
      } catch (error: any) {
        failed += 1;
        const expired = candidate.expiresAt <= now;
        const exhausted = attempt >= candidate.maxAttempts;
        const retryAt = expired || exhausted
          ? null
          : new Date(now.getTime() + this.retryDelayMs(attempt));
        await this.prisma.ownerNotificationOutbox.updateMany({
          where: { id: candidate.id, status: OwnerNotificationStatus.SENDING },
          data: {
            status: OwnerNotificationStatus.FAILED,
            nextAttemptAt: retryAt,
            failedAt: expired || exhausted ? new Date() : null,
            lastError: this.safeError(error),
          },
        });
      }
    }

    return { claimed, sent, failed };
  }

  private async recoverStaleClaims(now: Date) {
    const leaseMs = this.readPositiveInt(
      process.env.OWNER_NOTIFICATION_CLAIM_LEASE_MS,
      DEFAULT_LEASE_MS,
      30_000,
      30 * 60_000,
    );
    await this.prisma.ownerNotificationOutbox.updateMany({
      where: {
        status: OwnerNotificationStatus.SENDING,
        claimedAt: { lt: new Date(now.getTime() - leaseMs) },
        expiresAt: { gt: now },
      },
      data: {
        status: OwnerNotificationStatus.FAILED,
        nextAttemptAt: now,
        lastError: 'DISPATCH_LEASE_EXPIRED',
      },
    });
  }

  private async failExpired(now: Date) {
    await this.prisma.ownerNotificationOutbox.updateMany({
      where: {
        status: { in: [OwnerNotificationStatus.PENDING, OwnerNotificationStatus.FAILED] },
        expiresAt: { lte: now },
      },
      data: {
        status: OwnerNotificationStatus.FAILED,
        nextAttemptAt: null,
        failedAt: now,
        lastError: 'NOTIFICATION_TTL_EXPIRED',
      },
    });
  }

  private retryDelayMs(attempt: number) {
    const base = this.readPositiveInt(
      process.env.OWNER_NOTIFICATION_RETRY_BASE_MS,
      DEFAULT_RETRY_MS,
      1_000,
      10 * 60_000,
    );
    return Math.min(60 * 60_000, base * (2 ** Math.max(0, attempt - 1)));
  }

  private safeError(error: any) {
    return redactOwnerNotificationText(error?.message || String(error || 'UNKNOWN_ERROR'), 240);
  }

  private readPositiveInt(raw: string | undefined, fallback: number, min: number, max: number) {
    const value = Number.parseInt(String(raw || ''), 10);
    return Number.isFinite(value) ? Math.max(min, Math.min(max, value)) : fallback;
  }
}
