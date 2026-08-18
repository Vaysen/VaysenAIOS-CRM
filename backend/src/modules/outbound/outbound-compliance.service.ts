import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  ServiceUnavailableException,
} from '@nestjs/common';
import {
  ExternalActionChannel,
  ExternalActionStatus,
  Prisma,
} from '@prisma/client';
import { createHash, randomUUID } from 'crypto';
import { PrismaService } from '../../common/prisma/prisma.service';
import { AssistantPermissionService } from '../agent/assistant-permission.service';
import { emailAddressEvidenceHash } from './email-verification-evidence';
import { safeDigest, safeErrorCategory } from '../../common/security/safe-logging';

const ACTIVE_STATES: ExternalActionStatus[] = [
  ExternalActionStatus.PENDING,
  ExternalActionStatus.EXECUTING,
  ExternalActionStatus.SUCCEEDED,
  ExternalActionStatus.UNKNOWN,
];
const VERIFIED_EMAIL_STATUSES = new Set([
  'smtp_verified',
  'official_page_verified',
  'verified_public_source',
]);
const IDEMPOTENCY_RE = /^[A-Za-z0-9][A-Za-z0-9._:/-]{7,199}$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const EXECUTION_LEASE_MS = 60_000;
const PROVIDER_TIMEOUT_MS = 45_000;
const CONTACTABLE_LEAD_STATUSES = new Set([
  'new',
  'prospect_pool',
  'contacted',
  'replied',
  'interested',
  'qualified',
  'proposal',
  'quoted',
  'sampling',
  'quoting',
  'negotiation',
  'negotiating',
  'won',
]);
const TRUSTED_WHATSAPP_VERIFICATION_METHODS = new Set([
  'baileys_inbound',
  'evolution_webhook',
  'whatsapp_provider_inbound',
  'admin_verified',
]);

export type OutboundActorType = 'HUMAN' | 'AGENT' | 'WORKER';

export type OutboundArtifact = {
  sourceId: string;
  bytes: Buffer;
  mimeType: string;
  filename?: string;
};

export type OutboundRequest = {
  companyId: string;
  operatorUser: any;
  actorType: OutboundActorType;
  channel: 'EMAIL' | 'WHATSAPP';
  actionType: string;
  idempotencyKey: string;
  leadId: string;
  targetAddress: string;
  emailAccountId?: string;
  whatsappSessionId?: string;
  conversationId?: string;
  subject?: string;
  body: string;
  contentType?: string;
  artifacts?: OutboundArtifact[];
  requireAdmin?: boolean;
  maxAttempts?: number;
};

export type ProviderReceipt = {
  provider: string;
  receiptId: string;
  acceptedAt?: string | Date;
  metadata?: Record<string, unknown>;
};

export type CanonicalOutboundEnvelope = {
  targetAddress: string;
  subject?: string;
  body: string;
  contentType: string;
  artifacts: readonly OutboundArtifact[];
  signal: AbortSignal;
};

export type OutboundAdminProjection = {
  id: string | null;
  actionIdDigest: string | null;
  idempotencyKeyDigest: string | null;
  targetIdDigest: string | null;
  targetAddressDigest: string | null;
  targetDomainDigest: string | null;
  payloadDigest: string | null;
  targetType: string | null;
  channel: string | null;
  actionType: string | null;
  status: string | null;
  actorType: string | null;
  operatorRole: string | null;
  provider: string | null;
  providerReceiptPresent: boolean;
  providerReceiptIdDigest: string | null;
  approvalPresent: boolean;
  artifactCount: number;
  artifactBytes: number;
  artifactMimeTypes: string[];
  attemptCount: number;
  attemptVersion: number;
  maxAttempts: number;
  lastErrorCode: string | null;
  lastErrorCategory: string | null;
  createdAt: string | null;
  updatedAt: string | null;
  nextAttemptAt: string | null;
  claimedAt: string | null;
  leaseExpiresAt: string | null;
  acceptedAt: string | null;
  completedAt: string | null;
  cancelledAt: string | null;
  expiresAt: string | null;
};

@Injectable()
export class OutboundComplianceService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly permissions: AssistantPermissionService,
  ) {}

  async assertEmailAccountAccess(
    companyId: string,
    emailAccountId: string,
    user: any,
    actorType: OutboundActorType = 'HUMAN',
    db: any = this.prisma,
  ) {
    const membership = await this.validateOperator(db, companyId, user, actorType);
    this.assertDatabaseRole(membership.role, false);
    const account = await db.emailAccount.findFirst({
      where: { id: emailAccountId, companyId, status: 'active' },
      select: {
        id: true,
        companyId: true,
        userId: true,
        senderEmail: true,
        dailySendLimit: true,
        hourlySendLimit: true,
      },
    });
    if (!account) throw new ForbiddenException('Email sender account is outside the active tenant');
    const mayUseAssignedAccount = ['company_admin', 'super_admin']
      .includes(membership.role);
    if (account.userId && account.userId !== user.id && !mayUseAssignedAccount) {
      throw new ForbiddenException('Email sender account is assigned to another tenant member');
    }
    return account;
  }

  async execute<T extends ProviderReceipt>(
    request: OutboundRequest,
    providerCall: (
      artifacts: readonly OutboundArtifact[],
      envelope: CanonicalOutboundEnvelope,
    ) => Promise<T>,
  ): Promise<{ outboxId: string; deduplicated: boolean; receipt: ProviderReceipt }> {
    const preparedRequest: OutboundRequest = {
      ...request,
      artifacts: (request.artifacts || []).map((artifact) => ({
        ...artifact,
        bytes: Buffer.from(artifact.bytes),
      })),
    };
    const canonical = this.normalizeRequest(
      preparedRequest,
      this.normalizeIdempotencyKey(preparedRequest.idempotencyKey),
    );
    preparedRequest.targetAddress = canonical.channel === ExternalActionChannel.EMAIL
      ? canonical.targetAddress.toLowerCase()
      : canonical.targetAddress;
    preparedRequest.subject = canonical.subject;
    preparedRequest.body = canonical.body;
    preparedRequest.contentType = canonical.contentType || 'text';
    const reserved = await this.reserve(preparedRequest);
    if (reserved.status === ExternalActionStatus.SUCCEEDED) {
      return {
        outboxId: reserved.id,
        deduplicated: true,
        receipt: this.receiptFromRow(reserved),
      };
    }
    if (reserved.status === ExternalActionStatus.UNKNOWN) {
      const error: any = new ConflictException(
        'Previous provider outcome is unknown; reconcile before retrying',
      );
      error.outboundActionStatus = ExternalActionStatus.UNKNOWN;
      error.outboxId = reserved.id;
      throw error;
    }
    if (
      reserved.status === ExternalActionStatus.CANCELLED
      || reserved.status === ExternalActionStatus.EXPIRED
    ) {
      throw new ConflictException(`External action is terminal: ${reserved.status}`);
    }
    if (reserved.attemptCount >= reserved.maxAttempts) {
      await this.prisma.externalActionOutbox.updateMany({
        where: {
          id: reserved.id,
          status: ExternalActionStatus.FAILED,
          attemptCount: { gte: reserved.maxAttempts },
        },
        data: {
          nextAttemptAt: null,
          completedAt: reserved.completedAt || new Date(),
          lastErrorCode: 'MAX_ATTEMPTS_EXHAUSTED',
        },
      });
      throw new ConflictException('External action exhausted its provider attempts');
    }
    if (
      reserved.status === ExternalActionStatus.FAILED
      && (!reserved.nextAttemptAt || reserved.nextAttemptAt > new Date())
    ) {
      throw new ConflictException(
        reserved.nextAttemptAt
          ? 'External action retry is not due yet'
          : 'External action failed terminally and cannot be retried',
      );
    }

    const now = new Date();
    const leaseToken = randomUUID();
    const attemptVersion = Number(reserved.attemptVersion || 0) + 1;
    const claimed = await this.prisma.$transaction(async (tx) => {
      const membership = await this.validateOperator(
        tx,
        preparedRequest.companyId,
        preparedRequest.operatorUser,
        preparedRequest.actorType,
      );
      this.assertReplayIdentity(reserved, this.normalizeRequest(
        preparedRequest,
        this.normalizeIdempotencyKey(preparedRequest.idempotencyKey),
      ), membership.role);
      const claimRequest = this.normalizeRequest(
        preparedRequest,
        this.normalizeIdempotencyKey(preparedRequest.idempotencyKey),
      );
      this.assertDatabaseRole(
        membership.role,
        claimRequest.requireAdmin === true || claimRequest.actionType === 'RAW_SMTP',
      );
      const target = claimRequest.channel === ExternalActionChannel.EMAIL
        ? await this.validateEmailTarget(tx, claimRequest)
        : await this.validateWhatsappTarget(tx, claimRequest);
      await this.enforceRateLimits(tx, claimRequest, target, reserved.id);
      return tx.externalActionOutbox.updateMany({
        where: {
          id: reserved.id,
          operatorUserId: preparedRequest.operatorUser.id,
          actorType: preparedRequest.actorType,
          operatorRole: membership.role,
          OR: [
            { status: ExternalActionStatus.PENDING },
            {
              status: ExternalActionStatus.FAILED,
              nextAttemptAt: { lte: now },
            },
          ],
          attemptCount: { lt: reserved.maxAttempts },
          attemptVersion: reserved.attemptVersion,
          expiresAt: { gt: now },
        },
        data: {
          status: ExternalActionStatus.EXECUTING,
          attemptCount: { increment: 1 },
          claimedAt: now,
          leaseExpiresAt: new Date(now.getTime() + EXECUTION_LEASE_MS),
          leaseToken,
          attemptVersion,
          lastError: null,
          lastErrorCode: null,
        },
      });
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
    if (claimed.count !== 1) {
      const current = await this.prisma.externalActionOutbox.findUniqueOrThrow({
        where: { id: reserved.id },
      });
      if (current.status === ExternalActionStatus.SUCCEEDED) {
        return {
          outboxId: current.id,
          deduplicated: true,
          receipt: this.receiptFromRow(current),
        };
      }
      if (
        (
          current.status === ExternalActionStatus.PENDING
          || current.status === ExternalActionStatus.FAILED
        )
        && current.expiresAt <= new Date()
      ) {
        await this.prisma.externalActionOutbox.updateMany({
          where: {
            id: current.id,
            status: { in: [ExternalActionStatus.PENDING, ExternalActionStatus.FAILED] },
          },
          data: {
            status: ExternalActionStatus.EXPIRED,
            completedAt: new Date(),
          },
        });
        throw new ConflictException('External action is terminal: EXPIRED');
      }
      throw new ConflictException(`External action is already claimed or terminal: ${current.status}`);
    }

    let dispatchStarted = false;
    try {
      // All local validation, durable reservation and claim fencing complete
      // before this point. Once dispatch starts, generic thrown errors cannot
      // prove the provider did not accept the action.
      dispatchStarted = true;
      const abortController = new AbortController();
      let timeout: NodeJS.Timeout | undefined;
      const timeoutPromise = new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => {
          abortController.abort();
          const error: any = new ServiceUnavailableException(
            'Provider dispatch exceeded the bounded execution window',
          );
          error.code = 'PROVIDER_DISPATCH_TIMEOUT';
          reject(error);
        }, PROVIDER_TIMEOUT_MS);
      });
      const envelope: CanonicalOutboundEnvelope = {
        targetAddress: preparedRequest.targetAddress,
        subject: preparedRequest.subject,
        body: preparedRequest.body,
        contentType: preparedRequest.contentType || 'text',
        artifacts: preparedRequest.artifacts || [],
        signal: abortController.signal,
      };
      const receipt = await Promise.race([
        providerCall(envelope.artifacts, envelope),
        timeoutPromise,
      ]).finally(() => {
        if (timeout) clearTimeout(timeout);
      });
      const provider = String(receipt?.provider || '').trim().toLowerCase();
      const receiptId = String(receipt?.receiptId || '').trim();
      if (!provider || !receiptId) {
        const missingReceipt: any = new ServiceUnavailableException('Provider did not return a durable receipt');
        missingReceipt.code = 'PROVIDER_RECEIPT_MISSING';
        throw missingReceipt;
      }
      const acceptedAt = receipt.acceptedAt ? new Date(receipt.acceptedAt) : new Date();
      const completed = await this.prisma.externalActionOutbox.updateMany({
        where: {
          id: reserved.id,
          status: ExternalActionStatus.EXECUTING,
          leaseToken,
          attemptVersion,
        },
        data: {
          status: ExternalActionStatus.SUCCEEDED,
          provider,
          providerReceiptId: receiptId,
          providerReceipt: this.json({ metadata: receipt.metadata || {}, recordedAt: new Date().toISOString() }),
          acceptedAt,
          completedAt: new Date(),
          leaseExpiresAt: null,
          leaseToken: null,
        },
      });
      if (completed.count !== 1) {
        throw new ConflictException('Provider receipt arrived after the action lost its execution claim');
      }
      return { outboxId: reserved.id, deduplicated: false, receipt };
    } catch (error: any) {
      const ambiguous = dispatchStarted && !this.isExplicitProviderRejection(error);
      const exhausted = !ambiguous && attemptVersion >= reserved.maxAttempts;
      const outcomeStatus = ambiguous
        ? ExternalActionStatus.UNKNOWN
        : ExternalActionStatus.FAILED;
      await this.prisma.externalActionOutbox.updateMany({
        where: {
          id: reserved.id,
          status: ExternalActionStatus.EXECUTING,
          leaseToken,
          attemptVersion,
        },
        data: {
          status: outcomeStatus,
          lastErrorCode: exhausted ? 'MAX_ATTEMPTS_EXHAUSTED' : this.errorCode(error),
          lastError: this.safeError(error),
          nextAttemptAt: ambiguous || exhausted ? null : new Date(Date.now() + 5_000),
          completedAt: ambiguous || exhausted ? new Date() : null,
          leaseExpiresAt: null,
          leaseToken: null,
        },
      });
      if (error && typeof error === 'object') {
        error.outboundActionStatus = outcomeStatus;
        error.outboxId = reserved.id;
      }
      throw error;
    }
  }

  async cancel(companyId: string, idempotencyKey: string, user: any) {
    const membership = await this.validateOperator(this.prisma, companyId, user, 'HUMAN');
    this.assertDatabaseRole(membership.role, true);
    const normalizedKey = this.normalizeIdempotencyKey(idempotencyKey);
    const result = await this.prisma.externalActionOutbox.updateMany({
      where: {
        companyId,
        idempotencyKey: normalizedKey,
        status: { in: [ExternalActionStatus.PENDING, ExternalActionStatus.FAILED] },
      },
      data: {
        status: ExternalActionStatus.CANCELLED,
        cancelledAt: new Date(),
        completedAt: new Date(),
      },
    });
    if (result.count !== 1) throw new ConflictException('Only pending or failed external actions can be cancelled');
    const action = await this.prisma.externalActionOutbox.findUniqueOrThrow({
      where: { companyId_idempotencyKey: { companyId, idempotencyKey: normalizedKey } },
    });
    return this.toOutboundAdminProjection(action);
  }

  async recoverStaleExecuting(companyId: string, user: any) {
    const membership = await this.validateOperator(this.prisma, companyId, user, 'HUMAN');
    this.assertDatabaseRole(membership.role, true);
    const now = new Date();
    const result = await this.prisma.externalActionOutbox.updateMany({
      where: {
        companyId,
        status: ExternalActionStatus.EXECUTING,
        leaseExpiresAt: { lt: now },
      },
      data: {
        status: ExternalActionStatus.UNKNOWN,
        lastErrorCode: 'EXECUTION_LEASE_EXPIRED',
        lastError: 'Execution lease expired before a durable provider receipt was recorded',
        completedAt: now,
        leaseExpiresAt: null,
        leaseToken: null,
      },
    });
    return { recoveredToUnknown: result.count };
  }

  async listActions(
    companyId: string,
    user: any,
    options: { status?: ExternalActionStatus; limit?: number; cursor?: string } = {},
  ) {
    const membership = await this.validateOperator(this.prisma, companyId, user, 'HUMAN');
    this.assertDatabaseRole(membership.role, true);
    const limit = Math.min(Math.max(Number(options.limit || 50), 1), 100);
    const cursor = options.cursor ? this.decodeListCursor(options.cursor) : null;
    const where: any = {
      companyId,
      ...(options.status ? { status: options.status } : {}),
      ...(cursor ? {
        OR: [
          { createdAt: { lt: cursor.createdAt } },
          { createdAt: cursor.createdAt, id: { lt: cursor.id } },
        ],
      } : {}),
    };
    const [rows, unknownTotal] = await Promise.all([
      this.prisma.externalActionOutbox.findMany({
        where,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: limit + 1,
      }),
      this.prisma.externalActionOutbox.count({
        where: { companyId, status: ExternalActionStatus.UNKNOWN },
      }),
    ]);
    const hasMore = rows.length > limit;
    const visibleRows = rows.slice(0, limit);
    const data = visibleRows.map((row) => this.toOutboundAdminProjection(row));
    const last = visibleRows[visibleRows.length - 1];
    return {
      data,
      hasMore,
      nextCursor: hasMore && last
        ? this.encodeListCursor(last.createdAt, last.id)
        : null,
      unknownTotal,
    };
  }

  async getAction(companyId: string, id: string, user: any) {
    const membership = await this.validateOperator(this.prisma, companyId, user, 'HUMAN');
    this.assertDatabaseRole(membership.role, true);
    const action = await this.prisma.externalActionOutbox.findFirst({
      where: { id, companyId },
    });
    if (!action) throw new BadRequestException('External action not found');
    return this.toOutboundAdminProjection(action);
  }

  async getActionByKey(companyId: string, idempotencyKey: string, user: any) {
    const membership = await this.validateOperator(this.prisma, companyId, user, 'HUMAN');
    this.assertDatabaseRole(membership.role, true);
    const action = await this.prisma.externalActionOutbox.findUnique({
      where: {
        companyId_idempotencyKey: {
          companyId,
          idempotencyKey: this.normalizeIdempotencyKey(idempotencyKey),
        },
      },
    });
    if (!action) throw new BadRequestException('External action not found');
    return this.toOutboundAdminProjection(action);
  }

  async reconcileUnknown(
    companyId: string,
    id: string,
    outcome: 'SUCCEEDED' | 'FAILED' | 'CANCELLED',
    user: any,
    audit: { reason: string; evidenceReference?: string },
    receipt?: ProviderReceipt,
  ) {
    const reason = String(audit?.reason || '').trim();
    const evidenceReference = String(audit?.evidenceReference || '').trim() || null;
    if (!reason) throw new BadRequestException('A non-blank reconciliation reason is required');
    const normalizedProvider = String(receipt?.provider || '').trim().toLowerCase();
    const normalizedReceiptId = String(receipt?.receiptId || '').trim();
    if (outcome === 'SUCCEEDED' && (!normalizedProvider || !normalizedReceiptId)) {
      throw new BadRequestException('A non-blank provider receipt is required to reconcile success');
    }
    try {
      return await this.prisma.$transaction(async (tx) => {
        const membership = await this.validateOperator(tx, companyId, user, 'HUMAN');
        this.assertDatabaseRole(membership.role, true);
        const action = await tx.externalActionOutbox.findFirst({
          where: { id, companyId },
        });
        if (!action) throw new BadRequestException('External action not found');
        if (action.status !== ExternalActionStatus.UNKNOWN) {
          throw new ConflictException('Only UNKNOWN external actions can be reconciled');
        }
        const reconciled = await tx.externalActionOutbox.updateMany({
          where: { id, companyId, status: ExternalActionStatus.UNKNOWN },
          data: outcome === 'SUCCEEDED'
            ? {
                status: ExternalActionStatus.SUCCEEDED,
                provider: normalizedProvider,
                providerReceiptId: normalizedReceiptId,
                providerReceipt: this.json({
                  metadata: receipt!.metadata || {},
                  reconciliation: {
                    outcome,
                    reason,
                    evidenceReference,
                    reconciledByUserId: user.id,
                    reconciledAt: new Date().toISOString(),
                  },
                }),
                acceptedAt: receipt!.acceptedAt ? new Date(receipt!.acceptedAt) : new Date(),
                completedAt: new Date(),
              }
            : outcome === 'FAILED'
              ? {
                  status: ExternalActionStatus.FAILED,
                  lastErrorCode: 'MANUALLY_RECONCILED_FAILED',
                  lastError: reason,
                  nextAttemptAt: null,
                  providerReceipt: this.json({
                    reconciliation: {
                      outcome,
                      reason,
                      evidenceReference,
                      reconciledByUserId: user.id,
                      reconciledAt: new Date().toISOString(),
                    },
                  }),
                  completedAt: new Date(),
                }
              : {
                  status: ExternalActionStatus.CANCELLED,
                  providerReceipt: this.json({
                    reconciliation: {
                      outcome,
                      reason,
                      evidenceReference,
                      reconciledByUserId: user.id,
                      reconciledAt: new Date().toISOString(),
                    },
                  }),
                  cancelledAt: new Date(),
                  completedAt: new Date(),
                },
        });
        if (reconciled.count !== 1) {
          throw new ConflictException('External action changed while it was being reconciled');
        }
        const updated = await tx.externalActionOutbox.findUniqueOrThrow({ where: { id } });
        await this.projectReconciledAction(tx, updated, outcome);
        return this.toOutboundAdminProjection(updated);
      }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
    } catch (error: any) {
      if (error?.code === 'P2002') {
        throw new ConflictException('Provider receipt is already bound within this sender scope');
      }
      throw error;
    }
  }

  private async projectReconciledAction(
    tx: any,
    action: any,
    outcome: 'SUCCEEDED' | 'FAILED' | 'CANCELLED',
  ) {
    const projectionKey = this.digest(['external-action-projection', action.id]);
    const terminalReason = outcome === 'FAILED'
      ? 'OUTBOUND_MANUALLY_RECONCILED_FAILED'
      : 'OUTBOUND_CANCELLED_AFTER_UNKNOWN';
    if (
      action.channel === ExternalActionChannel.EMAIL
      && action.actionType === 'MARKETING_EMAIL'
    ) {
      const match = String(action.idempotencyKey || '').match(/^email-message:([A-Za-z0-9-]+)$/);
      if (!match) throw new ConflictException('Queued email action has no canonical message projection key');
      const projection = await tx.emailMessage.updateMany({
        where: { id: match[1], companyId: action.companyId },
        data: outcome === 'SUCCEEDED'
          ? {
              status: 'Sent',
              messageId: action.providerReceiptId,
              sentAt: action.acceptedAt || new Date(),
              failedReason: null,
              errorMessage: null,
            }
          : {
              status: 'Blocked',
              failedReason: terminalReason,
              errorMessage: terminalReason,
          },
      });
      if (projection.count !== 1) {
        throw new ConflictException(
          'Queued email reconciliation target is missing or outside the tenant',
        );
      }
      return;
    }

    const target = (action.targetSnapshot || {}) as Record<string, any>;
    const content = (action.contentSnapshot || {}) as Record<string, any>;
    if (
      action.channel === ExternalActionChannel.EMAIL
      && ['RAW_SMTP', 'OPENCLAW_EMAIL_SEND', 'OPENCLAW_EMAIL_REPLY'].includes(action.actionType)
    ) {
      if (outcome !== 'SUCCEEDED') {
        await tx.communicationMessage.updateMany({
          where: { ingestionKey: projectionKey },
          data: { deliveryStatus: 'failed' },
        });
        return;
      }
      const account = await tx.emailAccount.findFirst({
        where: { id: target.emailAccountId, companyId: action.companyId },
        select: { senderEmail: true },
      });
      if (!account || !target.leadId || !target.normalizedTarget) {
        throw new ConflictException('Email reconciliation snapshot cannot be projected safely');
      }
      let conversation = target.conversationId
        ? await tx.conversation.findFirst({
            where: {
              id: target.conversationId,
              companyId: action.companyId,
              leadId: target.leadId,
              channel: 'business_email',
              status: 'active',
            },
            select: { id: true },
          })
        : await tx.conversation.findFirst({
            where: {
              companyId: action.companyId,
              leadId: target.leadId,
              channel: 'business_email',
              status: 'active',
            },
            orderBy: [{ updatedAt: 'desc' }, { id: 'asc' }],
            select: { id: true },
          });
      if (!conversation) {
        conversation = await tx.conversation.create({
          data: {
            companyId: action.companyId,
            leadId: target.leadId,
            channel: 'business_email',
            subject: content.subject || null,
          },
          select: { id: true },
        });
      }
      await tx.communicationMessage.upsert({
        where: { ingestionKey: projectionKey },
        create: {
          conversationId: conversation.id,
          direction: 'outbound',
          content: String(content.body || content.subject || ''),
          contentType: String(content.contentType || 'html'),
          externalMessageId: action.providerReceiptId,
          ingestionKey: projectionKey,
          fromAddress: account.senderEmail,
          toAddress: target.normalizedTarget,
          subject: content.subject || null,
          deliveryStatus: 'sent',
          sentAt: action.acceptedAt || new Date(),
        },
        update: {
          externalMessageId: action.providerReceiptId,
          deliveryStatus: 'sent',
          sentAt: action.acceptedAt || new Date(),
        },
      });
      await tx.conversation.updateMany({
        where: {
          id: conversation.id,
          companyId: action.companyId,
          leadId: target.leadId,
          channel: 'business_email',
          status: 'active',
        },
        data: {
          lastMessageAt: action.acceptedAt || new Date(),
          lastMessagePreview: String(content.subject || '').slice(0, 200),
        },
      });
      return;
    }

    if (action.channel === ExternalActionChannel.WHATSAPP) {
      if (outcome !== 'SUCCEEDED') {
        await tx.communicationMessage.updateMany({
          where: { ingestionKey: projectionKey },
          data: { deliveryStatus: 'failed' },
        });
        return;
      }
      const conversation = await tx.conversation.findFirst({
        where: {
          id: target.conversationId,
          companyId: action.companyId,
          leadId: target.leadId,
          channel: 'whatsapp',
          status: 'active',
          whatsappSessionId: target.whatsappSessionId,
        },
        select: { id: true },
      });
      if (!conversation || !target.normalizedTarget) {
        throw new ConflictException('WhatsApp reconciliation snapshot cannot be projected safely');
      }
      await tx.communicationMessage.upsert({
        where: { ingestionKey: projectionKey },
        create: {
          conversationId: conversation.id,
          direction: 'outbound',
          content: String(content.body || ''),
          contentType: String(content.contentType || 'text'),
          externalMessageId: action.providerReceiptId,
          ingestionKey: projectionKey,
          toAddress: target.normalizedTarget,
          deliveryStatus: 'sent',
          sentAt: action.acceptedAt || new Date(),
        },
        update: {
          externalMessageId: action.providerReceiptId,
          deliveryStatus: 'sent',
          sentAt: action.acceptedAt || new Date(),
        },
      });
    }
  }

  private async reserve(request: OutboundRequest, retryCount = 0): Promise<any> {
    const idempotencyKey = this.normalizeIdempotencyKey(request.idempotencyKey);
    const normalized = this.normalizeRequest(request, idempotencyKey);
    const payloadDigest = this.digest({
      channel: normalized.channel,
      actionType: normalized.actionType,
      leadId: normalized.leadId,
      targetAddress: normalized.targetAddress,
      emailAccountId: normalized.emailAccountId || null,
      whatsappSessionId: normalized.whatsappSessionId || null,
      conversationId: normalized.conversationId || null,
      subject: normalized.subject || null,
      body: normalized.body,
      contentType: normalized.contentType || 'text',
      artifacts: normalized.artifacts,
    });
    const providerScope = normalized.channel === ExternalActionChannel.EMAIL
      ? `email:${normalized.emailAccountId}`
      : `whatsapp:${normalized.whatsappSessionId}`;

    try {
      return await this.prisma.$transaction(async (tx) => {
      const membership = await this.validateOperator(
        tx,
        normalized.companyId,
        normalized.operatorUser,
        normalized.actorType,
      );
      const existing = await tx.externalActionOutbox.findUnique({
        where: {
          companyId_idempotencyKey: {
            companyId: normalized.companyId,
            idempotencyKey,
          },
        },
      });
      if (existing) {
        this.assertReplayIdentity(existing, normalized, membership.role);
        if (
          existing.payloadDigest !== payloadDigest
          || existing.channel !== normalized.channel
          || existing.actionType !== normalized.actionType
        ) {
          throw new ConflictException('Idempotency key was reused for another external action');
        }
        if (
          existing.status === ExternalActionStatus.EXECUTING
          && (
            !existing.leaseExpiresAt
            || existing.leaseExpiresAt <= new Date()
          )
        ) {
          return tx.externalActionOutbox.update({
            where: { id: existing.id },
            data: {
              status: ExternalActionStatus.UNKNOWN,
              lastErrorCode: 'EXECUTION_LEASE_EXPIRED',
              lastError: 'Execution lease expired before a durable provider receipt was recorded',
              completedAt: new Date(),
              leaseExpiresAt: null,
              leaseToken: null,
            },
          });
        }
        if (
          (
            existing.status === ExternalActionStatus.PENDING
            || existing.status === ExternalActionStatus.FAILED
          )
          && existing.expiresAt <= new Date()
        ) {
          return tx.externalActionOutbox.update({
            where: { id: existing.id },
            data: {
              status: ExternalActionStatus.EXPIRED,
              completedAt: new Date(),
            },
          });
        }
        if (
          existing.status === ExternalActionStatus.PENDING
          || existing.status === ExternalActionStatus.FAILED
        ) {
          this.assertDatabaseRole(
            membership.role,
            normalized.requireAdmin === true || normalized.actionType === 'RAW_SMTP',
          );
          const target = normalized.channel === ExternalActionChannel.EMAIL
            ? await this.validateEmailTarget(tx, normalized)
            : await this.validateWhatsappTarget(tx, normalized);
          await this.enforceRateLimits(tx, normalized, target, existing.id);
        }
        return existing;
      }

      this.assertDatabaseRole(
        membership.role,
        normalized.requireAdmin === true || normalized.actionType === 'RAW_SMTP',
      );
      const target = normalized.channel === ExternalActionChannel.EMAIL
        ? await this.validateEmailTarget(tx, normalized)
        : await this.validateWhatsappTarget(tx, normalized);
      const unresolvedEquivalent = await tx.externalActionOutbox.findFirst({
        where: {
          companyId: normalized.companyId,
          channel: normalized.channel,
          actionType: normalized.actionType,
          targetAddressHash: target.targetAddressHash,
          providerScope,
          payloadDigest,
          status: {
            in: [
              ExternalActionStatus.PENDING,
              ExternalActionStatus.EXECUTING,
              ExternalActionStatus.UNKNOWN,
            ],
          },
        },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      });
      if (unresolvedEquivalent) {
        if (unresolvedEquivalent.idempotencyKey === idempotencyKey) {
          this.assertReplayIdentity(unresolvedEquivalent, normalized, membership.role);
          return unresolvedEquivalent;
        }
        throw new ConflictException({
          code: 'UNRESOLVED_EQUIVALENT_ACTION',
          message: 'An equivalent external action is unresolved and must be completed or reconciled first',
          outboxId: unresolvedEquivalent.id,
        });
      }
      await this.enforceRateLimits(tx, normalized, target);

      let approvalId: string | null = null;
      let authorizationSnapshot: Record<string, unknown> = {
        actorType: normalized.actorType,
        role: membership.role,
      };
      if (normalized.actorType === 'AGENT') {
        const capabilities = this.requiredAgentCapabilities(normalized);
        const now = new Date();
        const utcDayStart = new Date(Date.UTC(
          now.getUTCFullYear(),
          now.getUTCMonth(),
          now.getUTCDate(),
        ));
        // This predicate read and the ExternalActionOutbox insert occur in the
        // same SERIALIZABLE transaction. Concurrent reservations crossing the
        // threshold conflict and the outer P2034 retry re-evaluates the count.
        const dailyExternalSendCount = await tx.externalActionOutbox.count({
          where: {
            companyId: normalized.companyId,
            actorType: 'AGENT',
            createdAt: { gte: utcDayStart },
          },
        });
        const evaluations = [];
        for (const capability of capabilities) {
          const evaluation = await this.permissions.evaluate(
            normalized.companyId,
            normalized.operatorUser,
            capability,
            { customerId: normalized.leadId },
            {
              idempotencyKey: this.digest({ idempotencyKey, capability }),
              consumeGrant: true,
              tx,
              dailyExternalSendCount,
            },
          );
          if (evaluation.decision !== 'ALLOW') {
            throw new ForbiddenException(`External action authorization denied: ${capability}:${evaluation.reason}`);
          }
          evaluations.push({
            capability,
            decision: evaluation.decision,
            reason: evaluation.reason,
            scopeDigest: evaluation.scopeDigest,
            grantId: evaluation.grantId || null,
            grantConsumptionId: evaluation.grantConsumptionId || null,
          });
        }
        approvalId = evaluations
          .map((evaluation) => evaluation.grantConsumptionId || evaluation.grantId)
          .filter(Boolean)
          .join(',') || null;
        authorizationSnapshot = {
          ...authorizationSnapshot,
          evaluations,
          customerId: normalized.leadId,
        };
      }

      return tx.externalActionOutbox.create({
        data: {
          companyId: normalized.companyId,
          operatorUserId: normalized.operatorUser.id,
          actorType: normalized.actorType,
          operatorRole: membership.role,
          idempotencyKey,
          channel: normalized.channel,
          actionType: normalized.actionType,
          targetType: target.targetType,
          targetId: target.targetId,
          targetAddressHash: target.targetAddressHash,
          targetDomain: target.targetDomain,
          targetSnapshot: this.json(target.snapshot),
          payloadDigest,
          contentSnapshot: this.json({
            subject: normalized.subject || null,
            body: normalized.body,
            contentType: normalized.contentType || 'text',
            artifacts: normalized.artifacts,
          }),
          policySnapshot: this.json({
            authorization: authorizationSnapshot,
            checks: target.checks,
            limits: target.limits,
            evaluatedAt: new Date().toISOString(),
          }),
          approvalId,
          providerScope,
          maxAttempts: Math.min(Math.max(normalized.maxAttempts || 3, 1), 5),
          expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
        },
      });
      }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
    } catch (error: any) {
      if (error?.code === 'P2034' && retryCount < 2) {
        return this.reserve(request, retryCount + 1);
      }
      if (error?.code === 'P2002') {
        const replay = await this.prisma.externalActionOutbox.findUnique({
          where: {
            companyId_idempotencyKey: {
              companyId: normalized.companyId,
              idempotencyKey,
            },
          },
        });
        if (
          replay
          && replay.payloadDigest === payloadDigest
          && replay.channel === normalized.channel
          && replay.actionType === normalized.actionType
        ) {
          const membership = await this.validateOperator(
            this.prisma,
            normalized.companyId,
            normalized.operatorUser,
            normalized.actorType,
          );
          this.assertReplayIdentity(replay, normalized, membership.role);
          return replay;
        }
        // A concurrent grant-consumption insert can also surface as P2002.
        // Its enclosing serializable transaction has rolled back, so retry the
        // whole reservation and let the canonical consumption replay.
        if (retryCount < 2) return this.reserve(request, retryCount + 1);
      }
      throw error;
    }
  }

  private async validateEmailTarget(tx: Prisma.TransactionClient, request: ReturnType<OutboundComplianceService['normalizeRequest']>) {
    const email = request.targetAddress.toLowerCase();
    if (!EMAIL_RE.test(email)) throw new BadRequestException('A valid target email is required');
    if (!request.emailAccountId) throw new BadRequestException('Email account binding is required');
    const [lead, account] = await Promise.all([
      tx.lead.findFirst({
        where: { id: request.leadId, companyId: request.companyId, deletedAt: null },
        select: {
          id: true,
          companyId: true,
          contactEmail: true,
          emailVerificationStatus: true,
          emailVerifiedAddressHash: true,
          status: true,
          reviewStatus: true,
          ownerUserId: true,
        },
      }),
      this.assertEmailAccountAccess(
        request.companyId,
        request.emailAccountId,
        request.operatorUser,
        request.actorType,
        tx,
      ),
    ]);
    if (!lead || !account) throw new ForbiddenException('Email sender or target is outside the tenant');
    if (String(lead.contactEmail || '').trim().toLowerCase() !== email) {
      throw new ForbiddenException('Target email does not match the tenant-scoped lead');
    }
    if (!VERIFIED_EMAIL_STATUSES.has(lead.emailVerificationStatus)) {
      throw new ForbiddenException(`Target email is not verified (${lead.emailVerificationStatus})`);
    }
    if (lead.emailVerifiedAddressHash !== emailAddressEvidenceHash(email)) {
      throw new ForbiddenException('Target email verification evidence does not match the current address');
    }
    if (
      lead.reviewStatus !== 'approved'
      || !CONTACTABLE_LEAD_STATUSES.has(String(lead.status || '').toLowerCase())
    ) {
      throw new ForbiddenException('Target lead is not approved and contactable');
    }
    const emailMembership = await this.validateOperator(
      tx,
      request.companyId,
      request.operatorUser,
      request.actorType,
    );
    if (
      !['company_admin', 'super_admin'].includes(emailMembership.role)
      && lead.ownerUserId !== request.operatorUser.id
    ) {
      throw new ForbiddenException('Target lead is assigned to another tenant member');
    }
    const domain = email.split('@')[1];
    const targetAddressHash = this.digest(email);
    const [unsubscribed, blacklisted, suppressed] = await Promise.all([
      tx.unsubscribeRecord.findFirst({
        where: {
          companyId: request.companyId,
          OR: [{ leadId: lead.id }, { email: { equals: email, mode: 'insensitive' } }],
        },
        select: { id: true },
      }),
      tx.blacklistRecord.findFirst({
        where: {
          isActive: true,
          OR: [
            { companyId: request.companyId, email: { equals: email, mode: 'insensitive' } },
            { companyId: request.companyId, domain: { equals: domain, mode: 'insensitive' } },
            { isGlobal: true, email: { equals: email, mode: 'insensitive' } },
            { isGlobal: true, domain: { equals: domain, mode: 'insensitive' } },
          ],
        },
        select: { id: true },
      }),
      tx.externalSuppression.findFirst({
        where: {
          companyId: request.companyId,
          channel: ExternalActionChannel.EMAIL,
          isActive: true,
          OR: [{ leadId: lead.id }, { targetAddressHash }],
          AND: [{ OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }] }],
        },
        select: { id: true },
      }),
    ]);
    if (unsubscribed) throw new ForbiddenException('Target has unsubscribed');
    if (blacklisted) throw new ForbiddenException('Target email or domain is blacklisted');
    if (suppressed) throw new ForbiddenException('Target email or lead is suppressed');
    this.validateContent(request);
    return {
      targetType: 'lead',
      targetId: lead.id,
      targetAddressHash,
      targetDomain: domain,
      snapshot: {
        leadId: lead.id,
        emailAccountId: account.id,
        conversationId: request.conversationId || null,
        normalizedTarget: email,
        verificationStatus: lead.emailVerificationStatus,
      },
      checks: ['tenant', 'role', 'lead_binding', 'verification', 'unsubscribe', 'blacklist', 'content', 'idempotency'],
      limits: { hourly: account.hourlySendLimit, daily: account.dailySendLimit, contactDaily: 5, domainDaily: 100 },
    };
  }

  private async validateWhatsappTarget(tx: Prisma.TransactionClient, request: ReturnType<OutboundComplianceService['normalizeRequest']>) {
    if (!request.whatsappSessionId || !request.conversationId) {
      throw new BadRequestException('WhatsApp session and conversation bindings are required');
    }
    const normalizedTarget = this.normalizeOutboundPhone(request.targetAddress);
    if (!normalizedTarget) throw new BadRequestException('A direct WhatsApp target is required');
    const conversation = await tx.conversation.findFirst({
      where: {
        id: request.conversationId,
        companyId: request.companyId,
        leadId: request.leadId,
        channel: 'whatsapp',
        status: 'active',
        isGroup: { not: true },
        whatsappSessionId: request.whatsappSessionId,
        lead: {
          is: {
            deletedAt: null,
            isMerged: false,
            mergedToId: null,
          },
        },
      },
      include: {
        lead: {
          select: {
            id: true,
            status: true,
            reviewStatus: true,
            isMerged: true,
            mergedToId: true,
            deletedAt: true,
            whatsapp: true,
            contactPhone: true,
            ownerUserId: true,
          },
        },
        contactPoint: {
          select: {
            id: true,
            leadId: true,
            normalizedValue: true,
            isVerified: true,
            verificationMethod: true,
            type: true,
          },
        },
      },
    });
    const session = await tx.whatsAppSession.findFirst({
      where: { id: request.whatsappSessionId, companyId: request.companyId, status: 'connected' },
      select: { id: true, sessionId: true, authStatePath: true },
    });
    if (!conversation || !session || !conversation.lead) {
      throw new ForbiddenException('WhatsApp sender, conversation, or target is outside the tenant');
    }
    if (session.authStatePath?.startsWith('electron-account:')) {
      throw new ForbiddenException(
        'Electron-managed WhatsApp sessions require a trusted provider binding before outbound use',
      );
    }
    const candidates = [
      conversation.externalThreadId,
      conversation.contactPoint?.normalizedValue,
      conversation.lead.whatsapp,
      conversation.lead.contactPhone,
    ].map((value) => this.normalizePhone(String(value || ''))).filter(Boolean);
    if (!candidates.includes(normalizedTarget)) {
      throw new ForbiddenException('WhatsApp target does not match the tenant-scoped conversation');
    }
    const verifiedContactTarget = this.normalizePhone(
      String(conversation.contactPoint?.normalizedValue || ''),
    );
    if (
      !conversation.contactPoint
      || conversation.contactPoint.type !== 'whatsapp'
      || conversation.contactPoint.isVerified !== true
      || !TRUSTED_WHATSAPP_VERIFICATION_METHODS.has(
        String(conversation.contactPoint.verificationMethod || '').toLowerCase(),
      )
      || verifiedContactTarget !== normalizedTarget
    ) {
      throw new ForbiddenException('WhatsApp target does not match a verified contact point');
    }
    const externalIdentity = await tx.externalIdentity.findFirst({
      where: {
        companyId: request.companyId,
        provider: 'whatsapp',
        identityStatus: 'resolved',
        leadId: conversation.lead.id,
        contactPointId: conversation.contactPoint.id,
        externalId: String(conversation.externalThreadId || ''),
      },
      select: { id: true },
    });
    const expectedThreadKey =
      `whatsapp:${session.id}:${String(conversation.externalThreadId || '')}`;
    if (
      !externalIdentity
      || conversation.contactPoint.leadId !== conversation.lead.id
      || conversation.threadKey !== expectedThreadKey
    ) {
      throw new ForbiddenException(
        'WhatsApp target identity, session, and conversation thread are not consistently bound',
      );
    }
    if (
      conversation.lead.deletedAt
      || conversation.lead.isMerged
      || conversation.lead.mergedToId
      || conversation.lead.reviewStatus !== 'approved'
      || !CONTACTABLE_LEAD_STATUSES.has(String(conversation.lead.status || '').toLowerCase())
    ) {
      throw new ForbiddenException('Target lead is deleted, merged, suppressed, or not approved for contact');
    }
    const whatsappMembership = await this.validateOperator(
      tx,
      request.companyId,
      request.operatorUser,
      request.actorType,
    );
    if (
      !['company_admin', 'super_admin'].includes(whatsappMembership.role)
      && conversation.assignedUserId !== request.operatorUser.id
      && conversation.lead.ownerUserId !== request.operatorUser.id
    ) {
      throw new ForbiddenException(
        'WhatsApp conversation and lead are assigned to another tenant member',
      );
    }
    const [unsubscribed, suppressed] = await Promise.all([
      tx.unsubscribeRecord.findFirst({
        where: { companyId: request.companyId, leadId: conversation.lead.id },
        select: { id: true },
      }),
      tx.externalSuppression.findFirst({
        where: {
          companyId: request.companyId,
          channel: ExternalActionChannel.WHATSAPP,
          isActive: true,
          OR: [
            { leadId: conversation.lead.id },
            { targetAddressHash: this.digest(normalizedTarget) },
          ],
          AND: [
            { OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }] },
          ],
        },
        select: { id: true },
      }),
    ]);
    if (unsubscribed) throw new ForbiddenException('Target lead has unsubscribed');
    if (suppressed) throw new ForbiddenException('WhatsApp target or lead is suppressed');
    this.validateContent(request);
    return {
      targetType: 'conversation',
      targetId: conversation.id,
      targetAddressHash: this.digest(normalizedTarget),
      targetDomain: null,
      snapshot: {
        leadId: conversation.lead.id,
        conversationId: conversation.id,
        whatsappSessionId: session.id,
        normalizedTarget,
        direct: true,
      },
      checks: ['tenant', 'role', 'conversation_binding', 'direct_target', 'verification', 'unsubscribe', 'suppression', 'content', 'idempotency'],
      limits: { hourly: 30, daily: 100, contactDaily: 10, domainDaily: null },
    };
  }

  private async enforceRateLimits(
    tx: Prisma.TransactionClient,
    request: ReturnType<OutboundComplianceService['normalizeRequest']>,
    target: { targetAddressHash: string; targetDomain: string | null; limits: any },
    excludeActionId?: string,
  ) {
    const now = new Date();
    const hourStart = new Date(now.getTime() - 60 * 60 * 1000);
    const dayStart = new Date(now.getTime() - 24 * 60 * 60 * 1000);
    const [hourly, daily, contactDaily, domainDaily] = await Promise.all([
      tx.externalActionOutbox.count({
        where: { companyId: request.companyId, channel: request.channel, status: { in: ACTIVE_STATES }, createdAt: { gte: hourStart }, ...(excludeActionId ? { id: { not: excludeActionId } } : {}) },
      }),
      tx.externalActionOutbox.count({
        where: { companyId: request.companyId, channel: request.channel, status: { in: ACTIVE_STATES }, createdAt: { gte: dayStart }, ...(excludeActionId ? { id: { not: excludeActionId } } : {}) },
      }),
      tx.externalActionOutbox.count({
        where: { companyId: request.companyId, targetAddressHash: target.targetAddressHash, status: { in: ACTIVE_STATES }, createdAt: { gte: dayStart }, ...(excludeActionId ? { id: { not: excludeActionId } } : {}) },
      }),
      target.targetDomain
        ? tx.externalActionOutbox.count({
            where: { companyId: request.companyId, targetDomain: target.targetDomain, status: { in: ACTIVE_STATES }, createdAt: { gte: dayStart }, ...(excludeActionId ? { id: { not: excludeActionId } } : {}) },
          })
        : Promise.resolve(0),
    ]);
    if (hourly >= target.limits.hourly) throw new ForbiddenException('Hourly outbound limit reached');
    if (daily >= target.limits.daily) throw new ForbiddenException('Daily outbound limit reached');
    if (contactDaily >= target.limits.contactDaily) throw new ForbiddenException('Per-contact outbound limit reached');
    if (target.limits.domainDaily && domainDaily >= target.limits.domainDaily) {
      throw new ForbiddenException('Per-domain outbound limit reached');
    }
  }

  private validateContent(request: ReturnType<OutboundComplianceService['normalizeRequest']>) {
    if (!request.body || request.body.length > (request.channel === ExternalActionChannel.EMAIL ? 100_000 : 4_000)) {
      throw new BadRequestException('Outbound content is empty or too long');
    }
    if (/[\u0000\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(request.body)) {
      throw new BadRequestException('Outbound content contains control characters');
    }
    if (request.channel === ExternalActionChannel.EMAIL && (
      !request.subject
      || request.subject.length > 240
    )) {
      throw new BadRequestException('Email subject is empty or too long');
    }
  }

  private normalizeRequest(request: OutboundRequest, idempotencyKey: string) {
    if (!['HUMAN', 'AGENT', 'WORKER'].includes(request.actorType)) {
      throw new BadRequestException('Invalid outbound actor type');
    }
    const artifacts = (request.artifacts || []).map((artifact) => {
      if (!Buffer.isBuffer(artifact.bytes)) {
        throw new BadRequestException('Outbound artifact bytes are required');
      }
      const bytes = artifact.bytes;
      const normalized = {
        sourceId: String(artifact.sourceId || '').trim(),
        sha256: createHash('sha256').update(bytes).digest('hex'),
        size: bytes.length,
        mimeType: String(artifact.mimeType || '').trim().toLowerCase(),
        filename: artifact.filename ? String(artifact.filename).trim() : undefined,
      };
      if (
        !normalized.sourceId
        || normalized.size > 25 * 1024 * 1024
        || !/^[a-z0-9][a-z0-9.+-]*\/[a-z0-9][a-z0-9.+-]*$/.test(normalized.mimeType)
      ) {
        throw new BadRequestException('Invalid outbound artifact metadata');
      }
      return normalized;
    }).sort((a, b) => (
      `${a.sourceId}:${a.sha256}`.localeCompare(`${b.sourceId}:${b.sha256}`)
    ));
    return {
      ...request,
      idempotencyKey,
      channel: request.channel === 'EMAIL' ? ExternalActionChannel.EMAIL : ExternalActionChannel.WHATSAPP,
      companyId: String(request.companyId || '').trim(),
      leadId: String(request.leadId || '').trim(),
      targetAddress: String(request.targetAddress || '').trim(),
      subject: request.subject?.trim(),
      body: String(request.body || '').trim(),
      actionType: String(request.actionType || '').trim().toUpperCase(),
      artifacts,
    };
  }

  private normalizeIdempotencyKey(value: string) {
    const key = String(value || '').trim();
    if (!IDEMPOTENCY_RE.test(key)) throw new BadRequestException('A canonical Idempotency-Key is required');
    return key;
  }

  private encodeListCursor(createdAt: Date, id: string) {
    return Buffer.from(JSON.stringify({
      createdAt: new Date(createdAt).toISOString(),
      id,
    }), 'utf8').toString('base64url');
  }

  private decodeListCursor(value: string) {
    try {
      const parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8'));
      const createdAt = new Date(parsed?.createdAt);
      const id = String(parsed?.id || '').trim();
      if (!id || Number.isNaN(createdAt.getTime())) throw new Error('invalid');
      return { createdAt, id };
    } catch {
      throw new BadRequestException('Invalid outbound action cursor');
    }
  }

  private async validateOperator(
    db: any,
    companyId: string,
    user: any,
    actorType: OutboundActorType,
  ) {
    const activeCompanyId = String(user?.activeCompanyId || '').trim();
    if (
      !activeCompanyId
      || activeCompanyId !== companyId
      || (user?.activeCompany?.id && user.activeCompany.id !== activeCompanyId)
    ) {
      throw new ForbiddenException('Target company is not the authenticated active company');
    }
    if (!user?.id) throw new ForbiddenException('No active access to this company');
    const relation = await db.userCompanyRelation.findFirst({
      where: {
        userId: user.id,
        companyId,
        isActive: true,
        user: {
          is: {
            isActive: true,
            deletedAt: null,
          },
        },
        company: {
          is: {
            isActive: true,
          },
        },
      },
      include: { role: { select: { name: true } } },
    });
    const databaseRole = String(relation?.role?.name || '').trim();
    if (!databaseRole) {
      throw new ForbiddenException('Tenant membership or role is no longer active');
    }
    return { role: databaseRole };
  }

  private assertReplayIdentity(row: any, request: ReturnType<OutboundComplianceService['normalizeRequest']>, role: string) {
    if (
      row.operatorUserId !== request.operatorUser.id
      || row.actorType !== request.actorType
      || row.operatorRole !== role
    ) {
      throw new ForbiddenException('Idempotent external action belongs to another actor or role');
    }
  }

  private assertDatabaseRole(role: string, requireAdmin: boolean) {
    const allowed = requireAdmin
      ? ['company_admin', 'super_admin']
      : ['company_admin', 'super_admin', 'sales_manager', 'sales_user'];
    if (!allowed.includes(role)) {
      throw new ForbiddenException(requireAdmin
        ? 'Company administrator role is required for this external action'
        : 'The current tenant role cannot perform external actions');
    }
  }

  private requiredAgentCapabilities(request: ReturnType<OutboundComplianceService['normalizeRequest']>) {
    if (
      request.channel === ExternalActionChannel.WHATSAPP
      && request.actionType === 'OPENCLAW_WHATSAPP_QUOTE'
    ) {
      return ['crm.quote.send', 'crm.message.send'];
    }
    if (
      request.channel === ExternalActionChannel.WHATSAPP
      && request.actionType === 'OPENCLAW_WHATSAPP_TEXT'
    ) {
      return ['crm.message.send'];
    }
    if (
      request.channel === ExternalActionChannel.EMAIL
      && ['OPENCLAW_EMAIL_SEND', 'OPENCLAW_EMAIL_REPLY', 'RAW_SMTP'].includes(request.actionType)
    ) {
      return ['crm.email.send'];
    }
    throw new ForbiddenException('Agent action is not bound to an approved outbound capability');
  }

  private normalizePhone(value: string) {
    const raw = value.trim().replace(/@(?:s\.whatsapp\.net|c\.us)$/i, '');
    const digits = raw.replace(/\D/g, '');
    return /^\d{7,15}$/.test(digits) ? digits : '';
  }

  private normalizeOutboundPhone(value: string) {
    const target = String(value || '').trim();
    if (
      target.includes('@')
      && !/^\d{7,15}@(s\.whatsapp\.net|c\.us)$/i.test(target)
    ) {
      throw new BadRequestException('Only a canonical direct WhatsApp JID is allowed');
    }
    if (!target.includes('@') && !/^\+\d{7,15}$/.test(target)) {
      throw new BadRequestException('A canonical E.164 WhatsApp target is required');
    }
    return this.normalizePhone(target);
  }

  private receiptFromRow(row: any): ProviderReceipt {
    if (!row.provider || !row.providerReceiptId) {
      throw new ConflictException('Succeeded external action has no provider receipt');
    }
    return {
      provider: row.provider,
      receiptId: row.providerReceiptId,
      acceptedAt: row.acceptedAt || row.completedAt,
      metadata: this.readObject(row.providerReceipt),
    };
  }

  private isExplicitProviderRejection(error: any) {
    return error?.providerDeliveryOutcome === 'REJECTED'
      && error?.providerAccepted === false;
  }

  private errorCode(error: any) {
    return String(error?.code || error?.response?.code || error?.name || 'PROVIDER_ERROR').slice(0, 80);
  }

  private safeError(error: any) {
    return String(error?.message || 'Provider call failed').replace(/[\r\n]+/g, ' ').slice(0, 500);
  }

  private toOutboundAdminProjection(row: any): OutboundAdminProjection {
    const content = this.readObject(row?.contentSnapshot);
    const artifacts = Array.isArray(content.artifacts) ? content.artifacts : [];
    const artifactMimeTypes = Array.from(new Set(
      artifacts
        .map((artifact) => this.safeOperationalLabel((artifact as any)?.mimeType, ''))
        .filter((value): value is string => Boolean(value)),
    )).sort();
    const artifactBytes = artifacts.reduce((total, artifact) => {
      const size = Number((artifact as any)?.size);
      return total + (Number.isFinite(size) && size >= 0 ? Math.trunc(size) : 0);
    }, 0);
    const lastErrorCode = this.safeErrorCode(row?.lastErrorCode);
    const hasLastError = Boolean(row?.lastErrorCode || row?.lastError);
    const targetAddressSource = row?.targetAddressHash
      || this.readObject(row?.targetSnapshot).normalizedTarget;

    return {
      // The tenant-scoped action id remains usable by the existing GET/reconcile
      // routes. All other identifiers are opaque, domain-separated digests.
      id: row?.id ? String(row.id) : null,
      actionIdDigest: this.adminDigest(row?.id, 'outbound-action'),
      idempotencyKeyDigest: this.adminDigest(row?.idempotencyKey, 'outbound-idempotency'),
      targetIdDigest: this.adminDigest(row?.targetId, 'outbound-target'),
      targetAddressDigest: this.adminDigest(targetAddressSource, 'outbound-target-address'),
      targetDomainDigest: this.adminDigest(row?.targetDomain, 'outbound-target-domain'),
      payloadDigest: this.adminDigest(row?.payloadDigest, 'outbound-payload'),
      targetType: this.safeOperationalLabel(row?.targetType, null),
      channel: this.safeOperationalLabel(row?.channel, null),
      actionType: this.safeOperationalLabel(row?.actionType, null),
      status: this.safeOperationalLabel(row?.status, null),
      actorType: this.safeOperationalLabel(row?.actorType, null),
      operatorRole: this.safeOperationalLabel(row?.operatorRole, null),
      provider: this.safeOperationalLabel(row?.provider, null),
      providerReceiptPresent: Boolean(row?.providerReceiptId || row?.providerReceipt),
      providerReceiptIdDigest: this.adminDigest(row?.providerReceiptId, 'outbound-provider-receipt'),
      approvalPresent: Boolean(row?.approvalId),
      artifactCount: artifacts.length,
      artifactBytes,
      artifactMimeTypes,
      attemptCount: this.safeNonNegativeInteger(row?.attemptCount),
      attemptVersion: this.safeNonNegativeInteger(row?.attemptVersion),
      maxAttempts: this.safeNonNegativeInteger(row?.maxAttempts),
      lastErrorCode,
      lastErrorCategory: hasLastError
        ? safeErrorCategory({ code: lastErrorCode || undefined, message: row?.lastError })
        : null,
      createdAt: this.safeIso(row?.createdAt),
      updatedAt: this.safeIso(row?.updatedAt),
      nextAttemptAt: this.safeIso(row?.nextAttemptAt),
      claimedAt: this.safeIso(row?.claimedAt),
      leaseExpiresAt: this.safeIso(row?.leaseExpiresAt),
      acceptedAt: this.safeIso(row?.acceptedAt),
      completedAt: this.safeIso(row?.completedAt),
      cancelledAt: this.safeIso(row?.cancelledAt),
      expiresAt: this.safeIso(row?.expiresAt),
    };
  }

  private adminDigest(value: unknown, domain: string): string | null {
    if (value === undefined || value === null || String(value).trim() === '') return null;
    return safeDigest(value, domain);
  }

  private safeOperationalLabel(value: unknown, fallback: string | null): string | null {
    const candidate = String(value ?? '').trim();
    return /^[A-Za-z][A-Za-z0-9_.:-]{0,79}$/.test(candidate) ? candidate : fallback;
  }

  private safeErrorCode(value: unknown): string | null {
    const candidate = String(value ?? '').trim();
    return /^[A-Za-z][A-Za-z0-9_.:-]{0,79}$/.test(candidate) ? candidate : (candidate ? 'OUTBOUND_ERROR' : null);
  }

  private safeNonNegativeInteger(value: unknown): number {
    const candidate = Number(value);
    return Number.isFinite(candidate) && candidate >= 0 ? Math.trunc(candidate) : 0;
  }

  private safeIso(value: unknown): string | null {
    if (value === undefined || value === null || value === '') return null;
    const date = new Date(value as string | number | Date);
    return Number.isNaN(date.getTime()) ? null : date.toISOString();
  }

  private digest(value: unknown) {
    const input = typeof value === 'string' ? value : JSON.stringify(value);
    return createHash('sha256').update(input).digest('hex');
  }

  private json(value: unknown) {
    return value as Prisma.InputJsonValue;
  }

  private readObject(value: Prisma.JsonValue | null | undefined) {
    return value && typeof value === 'object' && !Array.isArray(value)
      ? value as Record<string, unknown>
      : {};
  }
}
