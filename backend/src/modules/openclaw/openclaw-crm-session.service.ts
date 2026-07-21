import { ConflictException, ForbiddenException, Injectable } from '@nestjs/common';
import { OpenClawCrmExecutionStatus, Prisma } from '@prisma/client';
import { createHash, randomUUID } from 'crypto';
import { PrismaService } from '../../common/prisma/prisma.service';
import type { AuthenticatedUser } from '../agent/agent.service';

const CRM_EXECUTION_LEASE_MS = 60_000;

@Injectable()
export class OpenClawCrmSessionService {
  constructor(private readonly prisma: PrismaService) {}

  async register(
    sessionDigest: string,
    companyId: string,
    user: AuthenticatedUser,
  ): Promise<void> {
    if (!/^[a-f0-9]{64}$/.test(sessionDigest)) throw new ForbiddenException('Invalid CRM session digest');
    const relation = await this.prisma.userCompanyRelation.findFirst({
      where: {
        userId: user.id,
        companyId,
        isActive: true,
        user: { isActive: true, deletedAt: null },
        company: { isActive: true },
      },
      include: { role: true },
    });
    if (!relation || !['company_admin', 'super_admin'].includes(relation.role.name)) {
      throw new ForbiddenException('Only an active company administrator may open an OpenClaw CRM session');
    }
    const existing = await this.prisma.openClawCrmSession.findUnique({ where: { sessionDigest } });
    if (
      existing
      && (existing.companyId !== companyId || existing.operatorUserId !== user.id)
    ) {
      throw new ConflictException('CRM session digest is already bound to another operator');
    }
    await this.prisma.openClawCrmSession.upsert({
      where: { sessionDigest },
      create: {
        sessionDigest,
        companyId,
        operatorUserId: user.id,
        expiresAt: new Date(Date.now() + 24 * 60 * 60_000),
        lastSeenAt: new Date(),
      },
      update: {
        expiresAt: new Date(Date.now() + 24 * 60 * 60_000),
        lastSeenAt: new Date(),
      },
    });
  }

  async resolve(sessionKey: string): Promise<{
    companyId: string;
    operatorUserId: string;
    user: AuthenticatedUser;
    executionLeaseToken: string;
  }> {
    const match = /^vaysen-crm:([a-f0-9]{64})$/.exec(sessionKey);
    if (!match) throw new ForbiddenException('Invalid OpenClaw CRM session key');
    const sessionDigest = match[1];
    const now = new Date();
    const session = await this.prisma.openClawCrmSession.findUnique({ where: { sessionDigest } });
    if (!session || session.expiresAt <= now) {
      throw new ForbiddenException('OpenClaw CRM session is expired or unknown');
    }
    // A registered reverse mapping is not itself permission to execute a
    // tool. Only the request that currently owns the short-lived execution
    // lease may enter the CRM broker. This rejects callbacks that arrive
    // after the assistant turn settled/released, or after its lease expired.
    if (
      session.executionStatus !== OpenClawCrmExecutionStatus.RUNNING
      || !session.executionLeaseToken
      || !session.executionLeaseExpiresAt
      || session.executionLeaseExpiresAt <= now
    ) {
      throw new ForbiddenException('OpenClaw CRM execution lease is not active');
    }
    const relation = await this.prisma.userCompanyRelation.findFirst({
      where: {
        userId: session.operatorUserId,
        companyId: session.companyId,
        isActive: true,
        user: { isActive: true, deletedAt: null },
        company: { isActive: true },
      },
      include: { role: true, user: { select: { email: true } } },
    });
    if (!relation || !['company_admin', 'super_admin'].includes(relation.role.name)) {
      throw new ForbiddenException('OpenClaw CRM administrator membership is no longer active');
    }
    await this.prisma.openClawCrmSession.update({
      where: { id: session.id },
      data: { lastSeenAt: new Date() },
    });
    return {
      companyId: session.companyId,
      operatorUserId: session.operatorUserId,
      user: {
        id: session.operatorUserId,
        email: relation.user.email,
        companies: [{ id: session.companyId, role: relation.role.name }],
      },
      executionLeaseToken: session.executionLeaseToken,
    };
  }

  /**
   * Atomically reserves the one Gateway execution allowed for this
   * request-scoped session. A concurrent renderer retry receives null and
   * must not call OpenClaw. An expired lease may be reclaimed after receipt
   * reconciliation, which closes a backend-crash window without replaying a
   * tool that already has a durable receipt.
   */
  async claimExecution(
    sessionDigest: string,
    companyId: string,
    user: AuthenticatedUser,
  ): Promise<string | null> {
    if (!/^[a-f0-9]{64}$/.test(sessionDigest)) throw new ForbiddenException('Invalid CRM session digest');
    const now = new Date();
    const token = randomUUID();
    const claimed = await this.prisma.openClawCrmSession.updateMany({
      where: {
        sessionDigest,
        companyId,
        operatorUserId: user.id,
        expiresAt: { gt: now },
        OR: [
          { executionStatus: OpenClawCrmExecutionStatus.READY },
          {
            executionStatus: OpenClawCrmExecutionStatus.RUNNING,
            executionLeaseExpiresAt: { lte: now },
          },
        ],
      },
      data: {
        executionStatus: OpenClawCrmExecutionStatus.RUNNING,
        executionLeaseToken: token,
        executionLeaseExpiresAt: new Date(now.getTime() + CRM_EXECUTION_LEASE_MS),
        executionCompletedAt: null,
      },
    });
    if (claimed.count === 1) return token;

    const existing = await this.prisma.openClawCrmSession.findUnique({ where: { sessionDigest } });
    if (
      !existing
      || existing.companyId !== companyId
      || existing.operatorUserId !== user.id
      || existing.expiresAt <= now
    ) {
      throw new ConflictException('CRM execution session is missing, expired, or belongs to another operator');
    }
    return null;
  }

  async settleExecution(sessionDigest: string, leaseToken: string): Promise<boolean> {
    return this.finishExecution(sessionDigest, leaseToken, OpenClawCrmExecutionStatus.SETTLED);
  }

  async releaseExecution(sessionDigest: string, leaseToken: string): Promise<boolean> {
    return this.finishExecution(sessionDigest, leaseToken, OpenClawCrmExecutionStatus.READY);
  }

  /**
   * Runs a CRM tool's terminal receipt transition under the same execution
   * advisory lock used by reserve and finishExecution. The callback performs
   * the PROCESSING -> terminal receipt CAS first; only the exact lease that
   * reserved that callback may then close RUNNING/DRAINING. A late callback
   * that lost its receipt CAS is allowed to return the already-terminal
   * receipt, but it can never close a newer lease.
   */
  async runToolTerminalTransaction<T extends { claimed: boolean }>(
    sessionDigest: string,
    leaseToken: string,
    terminalTransition: (tx: Prisma.TransactionClient) => Promise<T>,
  ): Promise<T> {
    return this.prisma.$transaction(async (tx) => {
      await this.lockExecution(tx, sessionDigest);
      const result = await terminalTransition(tx);
      if (!result.claimed) return result;

      const reconciled = await this.reconcileLockedToolExecutionAfterReceipt(
        tx,
        sessionDigest,
        leaseToken,
      );
      if (!reconciled) {
        throw new ConflictException('OpenClaw terminal callback does not own the active CRM execution lease');
      }
      return result;
    });
  }

  /**
   * Reconciles the execution after one tool receipt became terminal. RUNNING
   * remains open because one Gateway turn may invoke another allowlisted tool.
   * DRAINING closes only after the last PROCESSING receipt ends. The caller
   * must already hold this session's transaction-scoped execution advisory
   * lock. DRAINING deliberately ignores the old lease deadline: every pending
   * callback was admitted while RUNNING under this exact token.
   */
  async reconcileLockedToolExecutionAfterReceipt(
    tx: Prisma.TransactionClient,
    sessionDigest: string,
    leaseToken: string,
  ): Promise<boolean> {
    const execution = await tx.openClawCrmSession.findUnique({
      where: { sessionDigest },
    });
    if (
      !execution
      || execution.executionLeaseToken !== leaseToken
      || (
        execution.executionStatus !== OpenClawCrmExecutionStatus.RUNNING
        && execution.executionStatus !== OpenClawCrmExecutionStatus.DRAINING
      )
    ) {
      return false;
    }
    if (execution.executionStatus === OpenClawCrmExecutionStatus.RUNNING) {
      return true;
    }

    const receiptSessionDigest = createHash('sha256')
      .update(`vaysen-crm:${sessionDigest}`, 'utf8')
      .digest('hex');
    const processingReceipts = await tx.openClawToolReceipt.count({
      where: {
        sessionDigest: receiptSessionDigest,
        status: 'PROCESSING',
      },
    });
    if (processingReceipts > 0) return true;

    const settled = await tx.openClawCrmSession.updateMany({
      where: {
        sessionDigest,
        executionLeaseToken: leaseToken,
        executionStatus: OpenClawCrmExecutionStatus.DRAINING,
      },
      data: {
        executionStatus: OpenClawCrmExecutionStatus.SETTLED,
        executionLeaseToken: null,
        executionLeaseExpiresAt: null,
        executionCompletedAt: new Date(),
      },
    });
    return settled.count === 1;
  }

  /**
   * A callback that has already reserved a PROCESSING receipt is still part of
   * the live assistant execution. Serializing terminal transitions with the
   * broker reservation closes the reserve-then-settle race: either finish wins
   * first and the callback is rejected, or reserve wins first and RUNNING is
   * atomically sealed as DRAINING. DRAINING accepts no new resolve/claim, while
   * the already-reserved callback retains the exact token needed to settle it.
   */
  private async finishExecution(
    sessionDigest: string,
    leaseToken: string,
    target: 'SETTLED' | 'READY',
  ): Promise<boolean> {
    const receiptSessionDigest = createHash('sha256')
      .update(`vaysen-crm:${sessionDigest}`, 'utf8')
      .digest('hex');
    return this.prisma.$transaction(async (tx) => {
      await this.lockExecution(tx, sessionDigest);
      const processingReceipts = await tx.openClawToolReceipt.count({
        where: {
          sessionDigest: receiptSessionDigest,
          status: 'PROCESSING',
        },
      });
      if (processingReceipts > 0) {
        const draining = await tx.openClawCrmSession.updateMany({
          where: {
            sessionDigest,
            executionStatus: OpenClawCrmExecutionStatus.RUNNING,
            executionLeaseToken: leaseToken,
          },
          data: {
            executionStatus: OpenClawCrmExecutionStatus.DRAINING,
            executionCompletedAt: null,
          },
        });
        return draining.count === 1;
      }

      const finished = await tx.openClawCrmSession.updateMany({
        where: {
          sessionDigest,
          executionStatus: OpenClawCrmExecutionStatus.RUNNING,
          executionLeaseToken: leaseToken,
        },
        data: {
          executionStatus: target,
          executionLeaseToken: null,
          executionLeaseExpiresAt: null,
          executionCompletedAt: target === OpenClawCrmExecutionStatus.SETTLED ? new Date() : null,
        },
      });
      return finished.count === 1;
    });
  }

  private async lockExecution(
    tx: Prisma.TransactionClient,
    sessionDigest: string,
  ): Promise<void> {
    const executionLockKey = `openclaw-crm-execution:${sessionDigest}`;
    await tx.$queryRaw<Array<{ locked: string }>>`
      SELECT pg_advisory_xact_lock(hashtextextended(${executionLockKey}, 0))::text AS locked
    `;
  }
}
