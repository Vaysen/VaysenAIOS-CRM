import { Injectable, Logger, OnApplicationBootstrap, OnApplicationShutdown } from '@nestjs/common';
import { PrismaService } from '../../common/prisma/prisma.service';

const NONCE_CLEANUP_INTERVAL_MS = 60 * 60_000;
// Selection rows contain the trusted conversation binding used by a
// short-lived capability. Keep expired rows briefly for replay diagnosis, but
// do not retain that customer linkage indefinitely.
const SELECTION_TOKEN_RETENTION_MS = 24 * 60 * 60_000;

@Injectable()
export class OpenClawMaintenanceService implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger(OpenClawMaintenanceService.name);
  private timer: NodeJS.Timeout | null = null;

  constructor(private readonly prisma: PrismaService) {}

  async onApplicationBootstrap(): Promise<void> {
    await this.runCleanupSafely();
    this.timer = setInterval(() => {
      void this.runCleanupSafely();
    }, NONCE_CLEANUP_INTERVAL_MS);
    this.timer.unref?.();
  }

  onApplicationShutdown(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async cleanupExpiredNonces(now = new Date()): Promise<{
    nonces: number;
    sessions: number;
    selectionTokens: number;
  }> {
    const selectionTokenCutoff = new Date(now.getTime() - SELECTION_TOKEN_RETENTION_MS);
    const [deletedNonces, deletedSessions, deletedSelectionTokens] = await Promise.all([
      this.prisma.openClawRequestNonce.deleteMany({
        where: { expiresAt: { lt: now } },
      }),
      this.prisma.openClawCrmSession.deleteMany({
        where: { expiresAt: { lt: now } },
      }),
      // The cutoff intentionally ignores consumedAt: both consumed and
      // unconsumed capabilities are unusable after expiry and receive the
      // same bounded retention.
      this.prisma.openClawSelectionToken.deleteMany({
        where: { expiresAt: { lt: selectionTokenCutoff } },
      }),
    ]);
    return {
      nonces: deletedNonces.count,
      sessions: deletedSessions.count,
      selectionTokens: deletedSelectionTokens.count,
    };
  }

  private async runCleanupSafely(): Promise<void> {
    try {
      const counts = await this.cleanupExpiredNonces();
      if (counts.nonces > 0 || counts.sessions > 0 || counts.selectionTokens > 0) {
        this.logger.log(
          `Removed ${counts.nonces} expired OpenClaw request nonces, ${counts.sessions} expired CRM sessions, and ${counts.selectionTokens} expired selection tokens past retention`,
        );
      }
    } catch (error) {
      // A cleanup outage must not stop the maintenance worker or weaken HMAC
      // replay protection. Expired rows remain harmless and are retried later.
      this.logger.error(
        'Failed to remove expired OpenClaw request nonces, CRM sessions, or retained selection tokens',
        error instanceof Error ? error.stack : undefined,
      );
    }
  }
}
