import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  HttpException,
  Inject,
  Injectable,
  ServiceUnavailableException,
  forwardRef,
} from '@nestjs/common';
import {
  AgentRunKind,
  AgentRunSource,
  AgentRunStatus,
  AgentTaskStatus,
  OpenClawBindingStatus,
  OpenClawBusinessStatus,
  OpenClawCrmExecutionStatus,
  OpenClawReceiptStatus,
  Prisma,
} from '@prisma/client';
import { createHash, timingSafeEqual } from 'crypto';
import { PrismaService } from '../../common/prisma/prisma.service';
import { AgentService, type AuthenticatedUser } from '../agent/agent.service';
import { digestAgentInput, redactForExternalAi } from '../agent/agent-security';
import { AssistantPermissionService } from '../agent/assistant-permission.service';
import { BusinessMailService } from '../business-mail/business-mail.service';
import { WhatsAppService } from '../whatsapp/whatsapp.service';
import { isTrustedDirectWhatsappConversation } from '../whatsapp/whatsapp-conversation-trust';
import { QuotesService } from '../quotes/quotes.service';
import type { OpenClawActorDto } from './dto/openclaw-tool.dto';
import type { VerifiedOpenClawRequest } from './openclaw.types';
import { OpenClawCrmSessionService } from './openclaw-crm-session.service';
import {
  OpenClawSelectionService,
  type OpenClawSelectionContext,
} from './openclaw-selection.service';

export type OpenClawToolName =
  | 'work-brief'
  | 'customer-search'
  | 'prepare-quote-delivery'
  | 'start-background-research'
  | 'customer-get'
  | 'customer-add-note'
  | 'customer-update'
  | 'customer-set-stage'
  | 'task-create'
  | 'order-list'
  | 'order-create-draft'
  | 'order-update-stage'
  | 'quote-list'
  | 'quote-create-draft'
  | 'product-search'
  | 'whatsapp-messages-read'
  | 'whatsapp-send-text'
  | 'whatsapp-send-quote'
  | 'email-messages-read'
  | 'email-send'
  | 'email-reply';

type OpenClawSelectionToolName = Exclude<
  OpenClawToolName,
  'work-brief' | 'customer-search' | 'product-search'
>;

type BrokerPayload = {
  actor: OpenClawActorDto;
  input?: object;
};

type OwnerContext = {
  companyId: string;
  operatorUserId: string;
  user: AuthenticatedUser;
};

type TrustedActorContext = OwnerContext & {
  channel: 'openclaw-weixin' | 'vaysen-crm';
  senderDigest: string;
  accountDigest: string;
  requiresWechatBinding: boolean;
  crmSessionDigest: string | null;
  crmExecutionLeaseToken: string | null;
};

const PROCESSING_RECEIPT_STALE_MS = 5 * 60_000;
const STALE_RECEIPT_ERROR_CODE = 'OPENCLAW_STALE_PROCESSING';
const SESSION_RECEIPT_LIMIT = 8;
const WECHAT_RECEIPT_WINDOW_MS = 60_000;
const MUTATING_INPUT_DEDUPE_WINDOW_MS = 90_000;
const SELECTION_TOOL_NAMES: readonly OpenClawSelectionToolName[] = [
  'prepare-quote-delivery',
  'start-background-research',
  'customer-get',
  'customer-add-note',
  'customer-update',
  'customer-set-stage',
  'task-create',
  'order-list',
  'order-create-draft',
  'order-update-stage',
  'quote-list',
  'quote-create-draft',
  'whatsapp-messages-read',
  'whatsapp-send-text',
  'whatsapp-send-quote',
  'email-messages-read',
  'email-send',
  'email-reply',
];

function isActionTool(
  toolName: OpenClawToolName,
): toolName is OpenClawSelectionToolName {
  return SELECTION_TOOL_NAMES.includes(toolName as OpenClawSelectionToolName);
}

@Injectable()
export class OpenClawToolBrokerService {
  constructor(
    private readonly prisma: PrismaService,
    @Inject(forwardRef(() => AgentService)) private readonly agent: AgentService,
    private readonly crmSessions: OpenClawCrmSessionService,
    private readonly selections: OpenClawSelectionService,
    @Inject(forwardRef(() => AssistantPermissionService))
    private readonly assistantPermissions: AssistantPermissionService,
    private readonly whatsapp: WhatsAppService,
    private readonly businessMail: BusinessMailService,
    private readonly quotes: QuotesService,
  ) {}

  async execute(
    toolName: OpenClawToolName,
    payload: BrokerPayload,
    verified: VerifiedOpenClawRequest | undefined,
  ) {
    if (!verified) throw new ForbiddenException('OpenClaw signature context is missing');
    const actor = payload.actor;
    const suppliedToolInput = payload.input && !Array.isArray(payload.input)
      ? payload.input as Record<string, unknown>
      : {};
    const suppliedAcceptanceMarker = suppliedToolInput.acceptanceMarker;
    if (suppliedAcceptanceMarker !== undefined && toolName !== 'work-brief') {
      throw new BadRequestException('OpenClaw acceptance marker is allowed only for work brief');
    }
    if (
      toolName === 'work-brief'
      && Object.keys(suppliedToolInput).some((key) => key !== 'acceptanceMarker')
    ) {
      throw new BadRequestException('OpenClaw work brief input contains an unsupported field');
    }
    const acceptanceMarkerDigest = suppliedAcceptanceMarker === undefined
      ? null
      : typeof suppliedAcceptanceMarker === 'string'
        && /^JYACC_OWNER_[a-f0-9]{16}$/.test(suppliedAcceptanceMarker)
        ? this.sha256(suppliedAcceptanceMarker)
        : (() => {
            throw new BadRequestException('OpenClaw acceptance marker format is invalid');
          })();
    const trusted = await this.resolveTrustedActor(actor);
    const owner: OwnerContext = trusted;
    const senderDigest = trusted.senderDigest;
    const sessionDigest = this.sha256(actor.sessionKey);
    // messageId is optional because the official tool context does not
    // guarantee it. Read-only calls retain execute(toolCallId, ...) identity;
    // mutating calls without messageId additionally use the canonical,
    // database-locked business input digest below.
    const messageDigest = this.sha256(actor.messageId || 'not-provided');
    const accountDigest = trusted.accountDigest;
    const toolCallDigest = this.sha256(actor.toolCallId);
    const selectionContext: OpenClawSelectionContext = {
      companyId: owner.companyId,
      operatorUserId: owner.operatorUserId,
      channel: trusted.channel,
      senderDigest,
      accountDigest,
      sessionDigest,
      messageDigest,
    };
    // Action targets never come from a model-provided UUID. A unique customer
    // search issues a tool-scoped one-use capability; consuming it derives the
    // trusted lead UUID and optional direct-conversation UUID from PostgreSQL before reservation or side
    // effects are possible.
    const actionSelection = isActionTool(toolName)
      ? await this.selections.consume(
            String(suppliedToolInput.selectionToken || ''),
            toolName,
            selectionContext,
          )
      : null;
    const { selectionToken: _selectionToken, ...actionInput } = suppliedToolInput;
    const toolInput: Record<string, unknown> = actionSelection
      ? {
          ...actionInput,
          leadId: actionSelection.leadId,
          conversationId: actionSelection.conversationId,
        }
      : toolName === 'work-brief'
        ? {}
        : suppliedToolInput;
    const businessInputDigest = trusted.channel === 'openclaw-weixin'
      && !actor.messageId
      && isActionTool(toolName)
      ? digestAgentInput({
          companyId: owner.companyId,
          operatorUserId: owner.operatorUserId,
          channel: trusted.channel,
          accountDigest,
          sessionDigest,
          toolName,
          input: toolInput,
        })
      : null;
    // A production acceptance marker is an explicit, one-scenario replay key.
    // It must survive a fresh model/toolCallId so the second phone delivery
    // proves backend idempotency instead of merely hoping the model skips the
    // tool. Only its SHA-256 digest is retained or used for correlation.
    const acceptanceReplayDigest = trusted.channel === 'openclaw-weixin'
      && toolName === 'work-brief'
      && acceptanceMarkerDigest
      ? digestAgentInput({
          channel: trusted.channel,
          senderDigest,
          sessionDigest,
          accountDigest,
          toolName,
          acceptanceMarkerDigest,
        })
      : null;
    // CRM sessions are request-scoped by the authenticated frontend requestId.
    // A model may regenerate a different toolCallId while retrying the exact
    // same tool/input, so its business idempotency key must not depend on that
    // model-local identifier (or on the HMAC body which contains it). WeChat
    // keeps toolCallId anchoring because its session is intentionally stable.
    const requestKey = acceptanceReplayDigest
      || (trusted.channel === 'vaysen-crm'
      ? digestAgentInput({
          channel: trusted.channel,
          senderDigest,
          sessionDigest,
          accountDigest,
          toolName,
          input: toolInput,
        })
      : digestAgentInput({
          channel: trusted.channel,
          senderDigest,
          sessionDigest,
          messageDigest,
          toolCallDigest,
          accountDigest,
        }));
    const inputDigest = acceptanceReplayDigest
      ? digestAgentInput({ acceptanceReplayDigest, toolName })
      : businessInputDigest
      ? digestAgentInput({ businessInputDigest, senderDigest })
      : trusted.channel === 'vaysen-crm'
      ? digestAgentInput({ requestKey, toolName, input: toolInput })
      : digestAgentInput({
          requestKey,
          toolName,
          input: toolInput,
          signedBodyDigest: verified.bodyDigest,
        });
    // Capacity is bounded per assistant execution, never over the lifetime of
    // a stable owner-WeChat peer session. Official callbacks usually expose a
    // messageId. The current owner-WeChat adapter does not expose a reliable
    // per-turn id, so missing messageId falls back to a short rolling window
    // over the stable peer session rather than an unbounded per-toolCall scope.
    const receiptBoundaryDigest = trusted.channel === 'vaysen-crm'
      ? sessionDigest
      : actor.messageId
        ? messageDigest
        : sessionDigest;

    const reservation = await this.reserve({
      toolName,
      requestKey,
      inputDigest,
      senderDigest,
      sessionDigest,
      messageDigest,
      owner,
      channel: trusted.channel,
      requiresWechatBinding: trusted.requiresWechatBinding,
      crmSessionDigest: trusted.crmSessionDigest,
      crmExecutionLeaseToken: trusted.crmExecutionLeaseToken,
      receiptBoundaryDigest,
      hasMessageBoundary: trusted.channel === 'openclaw-weixin' && !!actor.messageId,
      businessInputDigest,
      selectionReplay: actionSelection?.replay === true,
      acceptanceMarkerDigest,
    });
    if (!reservation.created) return this.responseFromReceipt(reservation.receipt);

    try {
      const rawResult = await this.invokeAllowlistedTool(
        toolName,
        toolInput,
        requestKey,
        sessionDigest,
        owner,
        trusted.channel,
        selectionContext,
      );
      // Canonicalize before both persistence and return. Customer selection
      // capabilities are the sole transient exception: return them only on the
      // successful search call, while durable receipt/run/task JSON records
      // only that actions require a selection and never stores raw tokens.
      const minimizedResult = this.minimizeToolResult(toolName, rawResult);
      const businessStatus = this.businessStatusForToolResult(toolName, minimizedResult);
      const durableMinimizedResult = toolName === 'customer-search'
        ? { ...this.asRecord(minimizedResult), selection: null }
        : minimizedResult;
      const result = this.toJsonValue(durableMinimizedResult);
      const transientResult = this.toJsonValue(minimizedResult);
      // AgentRun/AgentTask status is the technical transport lifecycle. Persist
      // the independent business outcome in their result so API consumers do
      // not render a safely-blocked action as a successful business action just
      // because the wrapper transport reached COMPLETED.
      const wrapperResult = this.toJsonValue({
        ...this.asRecord(durableMinimizedResult),
        businessStatus,
      });
      const completedAt = new Date();
      const finalized = await this.runTerminalTransaction(trusted, async (tx) => {
        // The receipt is the authority for the wrapper run/task terminal state.
        // Claim it first so stale recovery and a late tool completion cannot
        // both publish a terminal result. Every other write in this transaction
        // is conditional on this PROCESSING -> COMPLETED compare-and-set.
        const claimed = await tx.openClawToolReceipt.updateMany({
          where: {
            id: reservation.receipt.id,
            status: OpenClawReceiptStatus.PROCESSING,
          },
          data: {
            status: OpenClawReceiptStatus.COMPLETED,
            businessStatus,
            result,
            completedAt,
          },
        });
        if (claimed.count !== 1) {
          const existing = await tx.openClawToolReceipt.findUnique({
            where: { id: reservation.receipt.id },
          });
          if (!existing) {
            throw new ConflictException('OpenClaw receipt disappeared during completion');
          }
          return { claimed: false, receipt: existing };
        }
        await tx.agentTask.updateMany({
          where: { runId: reservation.runId, status: AgentTaskStatus.RUNNING },
          data: { status: AgentTaskStatus.COMPLETED, result: wrapperResult, completedAt },
        });
        await tx.agentRun.updateMany({
          where: { id: reservation.runId, status: AgentRunStatus.RUNNING },
          data: { status: AgentRunStatus.COMPLETED, result: wrapperResult, completedAt },
        });
        await tx.agentAuditLog.create({
          data: {
            companyId: owner.companyId,
            runId: reservation.runId,
            actorUserId: owner.operatorUserId,
            eventType: 'OPENCLAW_TOOL_COMPLETED',
            inputDigest,
            metadata: {
              toolName,
              businessStatus,
              automaticExternalSend: ['whatsapp-send-text', 'whatsapp-send-quote', 'email-send', 'email-reply'].includes(toolName),
            },
          },
        });
        const receipt = await tx.openClawToolReceipt.findUnique({
          where: { id: reservation.receipt.id },
        });
        if (!receipt) {
          throw new ConflictException('OpenClaw receipt disappeared after completion');
        }
        return { claimed: true, receipt };
      });
      return this.responseFromReceipt(
        finalized.claimed
          ? { ...finalized.receipt, result: transientResult }
          : finalized.receipt,
      );
    } catch (error) {
      const completedAt = new Date();
      const errorCode = error instanceof HttpException
        ? `TOOL_REJECTED_${error.getStatus()}`
        : 'OPENCLAW_TOOL_FAILED';
      const finalized = await this.runTerminalTransaction(trusted, async (tx) => {
        // A stale-recovery transaction may already have failed this receipt
        // while the underlying tool was still running. Losing this CAS means
        // the existing terminal receipt wins; do not overwrite its error or
        // mutate the already-terminal wrapper run/task.
        const claimed = await tx.openClawToolReceipt.updateMany({
          where: {
            id: reservation.receipt.id,
            status: OpenClawReceiptStatus.PROCESSING,
          },
          data: {
            status: OpenClawReceiptStatus.FAILED,
            businessStatus: OpenClawBusinessStatus.FAILED,
            errorCode,
            completedAt,
          },
        });
        if (claimed.count !== 1) {
          const existing = await tx.openClawToolReceipt.findUnique({
            where: { id: reservation.receipt.id },
          });
          if (!existing) {
            throw new ConflictException('OpenClaw receipt disappeared during failure handling');
          }
          return { claimed: false, receipt: existing };
        }
        await tx.agentTask.updateMany({
          where: { runId: reservation.runId, status: AgentTaskStatus.RUNNING },
          data: { status: AgentTaskStatus.FAILED, errorCode, completedAt },
        });
        await tx.agentRun.updateMany({
          where: { id: reservation.runId, status: AgentRunStatus.RUNNING },
          data: { status: AgentRunStatus.FAILED, errorCode, completedAt },
        });
        await tx.agentAuditLog.create({
          data: {
            companyId: owner.companyId,
            runId: reservation.runId,
            actorUserId: owner.operatorUserId,
            eventType: 'OPENCLAW_TOOL_FAILED',
            inputDigest,
            metadata: { toolName, errorCode },
          },
        });
        const receipt = await tx.openClawToolReceipt.findUnique({
          where: { id: reservation.receipt.id },
        });
        if (!receipt) {
          throw new ConflictException('OpenClaw receipt disappeared after failure handling');
        }
        return { claimed: true, receipt };
      });
      if (!finalized.claimed) return this.responseFromReceipt(finalized.receipt);
      throw error;
    }
  }

  private async reserve(input: {
    toolName: OpenClawToolName;
    requestKey: string;
    inputDigest: string;
    senderDigest: string;
    sessionDigest: string;
    messageDigest: string;
    owner: OwnerContext;
    channel: 'openclaw-weixin' | 'vaysen-crm';
    requiresWechatBinding: boolean;
    crmSessionDigest: string | null;
    crmExecutionLeaseToken: string | null;
    receiptBoundaryDigest: string;
    hasMessageBoundary: boolean;
    businessInputDigest: string | null;
    selectionReplay: boolean;
    acceptanceMarkerDigest: string | null;
  }, retryBindingRace = true): Promise<{ created: boolean; runId: string; receipt: any }> {
    try {
      return await this.prisma.$transaction(async (tx) => {
        const now = new Date();
        if (input.channel === 'vaysen-crm') {
          // This lock is shared with settle/release. Whichever transaction
          // wins defines the ordering: a terminal execution rejects the late
          // callback, while a reserved PROCESSING receipt prevents the caller
          // from ending the execution underneath a running business tool.
          const executionLockKey = `openclaw-crm-execution:${input.crmSessionDigest || 'invalid'}`;
          await tx.$queryRaw<Array<{ locked: string }>>`
            SELECT pg_advisory_xact_lock(hashtextextended(${executionLockKey}, 0))::text AS locked
          `;
          const execution = input.crmSessionDigest
            ? await tx.openClawCrmSession.findUnique({
                where: { sessionDigest: input.crmSessionDigest },
              })
            : null;
          if (
            !execution
            || execution.companyId !== input.owner.companyId
            || execution.operatorUserId !== input.owner.operatorUserId
            || execution.expiresAt <= now
            || execution.executionStatus !== OpenClawCrmExecutionStatus.RUNNING
            || !execution.executionLeaseToken
            || execution.executionLeaseToken !== input.crmExecutionLeaseToken
            || !execution.executionLeaseExpiresAt
            || execution.executionLeaseExpiresAt <= now
          ) {
            throw new ForbiddenException('OpenClaw CRM execution lease is not active');
          }
        }
        if (input.requiresWechatBinding) {
          const ownerBindingLockKey = `openclaw-weixin-owner-binding:${input.owner.companyId}:${input.owner.operatorUserId}`;
          await tx.$queryRaw<Array<{ locked: string }>>`
            SELECT pg_advisory_xact_lock(hashtextextended(${ownerBindingLockKey}, 0))::text AS locked
          `;
          const activeBinding = await tx.openClawOperatorBinding.findFirst({
            where: {
              companyId: input.owner.companyId,
              operatorUserId: input.owner.operatorUserId,
              channel: 'openclaw-weixin',
              status: OpenClawBindingStatus.ACTIVE,
            },
            orderBy: [{ lastSeenAt: 'desc' }, { boundAt: 'desc' }, { id: 'desc' }],
            select: { senderDigest: true },
          });
          if (activeBinding && activeBinding.senderDigest !== input.senderDigest) {
            throw new ForbiddenException('OpenClaw owner binding changed before tool execution');
          }
          const now = new Date();
          await tx.openClawOperatorBinding.updateMany({
            where: {
              companyId: input.owner.companyId,
              operatorUserId: input.owner.operatorUserId,
              channel: 'openclaw-weixin',
              status: OpenClawBindingStatus.ACTIVE,
              senderDigest: { not: input.senderDigest },
            },
            data: { status: OpenClawBindingStatus.REVOKED, revokedAt: now },
          });
          const binding = await tx.openClawOperatorBinding.upsert({
            where: {
              channel_senderDigest: {
                channel: 'openclaw-weixin',
                senderDigest: input.senderDigest,
              },
            },
            create: {
              companyId: input.owner.companyId,
              operatorUserId: input.owner.operatorUserId,
              channel: 'openclaw-weixin',
              senderDigest: input.senderDigest,
              displayName: '负责人微信',
              status: OpenClawBindingStatus.ACTIVE,
              boundAt: now,
              lastSeenAt: now,
            },
            update: { lastSeenAt: now },
          });
          if (
            binding.status !== OpenClawBindingStatus.ACTIVE
            || binding.companyId !== input.owner.companyId
            || binding.operatorUserId !== input.owner.operatorUserId
          ) {
            throw new ForbiddenException('OpenClaw owner binding conflicts with the active CRM operator');
          }
        }

        if (input.businessInputDigest) {
          // The official Weixin adapter may omit messageId. Serialize the
          // canonical business input across model-generated toolCallIds so a
          // retry cannot create a second proposal/research job. This is a
          // database lock, therefore it also protects concurrent replicas.
          const businessLockKey = `openclaw-business-input:${input.businessInputDigest}`;
          await tx.$queryRaw<Array<{ locked: string }>>`
            SELECT pg_advisory_xact_lock(hashtextextended(${businessLockKey}, 0))::text AS locked
          `;
        }

        // Serialize capacity checks for one assistant execution inside
        // PostgreSQL. A plain count-then-create check is racy: concurrent
        // eighth and ninth requests could both observe seven receipts. The
        // transaction-scoped advisory lock makes the later transaction wait;
        // under READ COMMITTED its subsequent count sees the earlier commit.
        // Hash collisions only over-serialize unrelated sessions and cannot
        // weaken the limit.
        const capacityLockKey = [
          'openclaw-execution-receipts',
          input.owner.companyId,
          input.owner.operatorUserId,
          input.sessionDigest,
          input.receiptBoundaryDigest,
        ].join(':');
        await tx.$queryRaw<Array<{ locked: string }>>`
          SELECT pg_advisory_xact_lock(hashtextextended(${capacityLockKey}, 0))::text AS locked
        `;

        const existing = await tx.openClawToolReceipt.findUnique({
          where: { requestKey: input.requestKey },
        });
        if (existing) {
          this.assertReceiptContext(existing, input);
          const createdAt = existing.createdAt instanceof Date
            ? existing.createdAt.getTime()
            : Date.parse(String(existing.createdAt || ''));
          const staleBefore = new Date(now.getTime() - PROCESSING_RECEIPT_STALE_MS);
          if (
            existing.status === OpenClawReceiptStatus.PROCESSING
            && Number.isFinite(createdAt)
            && createdAt <= staleBefore.getTime()
          ) {
            // A crashed process must not leave an idempotency key permanently
            // PROCESSING. Claim the stale receipt once, mark its wrapper run
            // failed, and never replay the original tool automatically. The
            // operator may explicitly issue a fresh tool call with a new id.
            const claimed = await tx.openClawToolReceipt.updateMany({
              where: {
                id: existing.id,
                status: OpenClawReceiptStatus.PROCESSING,
                createdAt: { lte: staleBefore },
              },
              data: {
                status: OpenClawReceiptStatus.FAILED,
                businessStatus: OpenClawBusinessStatus.FAILED,
                errorCode: STALE_RECEIPT_ERROR_CODE,
                completedAt: now,
              },
            });
            if (claimed.count === 1) {
              await tx.agentTask.updateMany({
                where: { runId: existing.runId, status: AgentTaskStatus.RUNNING },
                data: {
                  status: AgentTaskStatus.FAILED,
                  errorCode: STALE_RECEIPT_ERROR_CODE,
                  completedAt: now,
                },
              });
              await tx.agentRun.updateMany({
                where: { id: existing.runId, status: AgentRunStatus.RUNNING },
                data: {
                  status: AgentRunStatus.FAILED,
                  errorCode: STALE_RECEIPT_ERROR_CODE,
                  completedAt: now,
                },
              });
              await tx.agentAuditLog.create({
                data: {
                  companyId: input.owner.companyId,
                  runId: existing.runId,
                  actorUserId: input.owner.operatorUserId,
                  eventType: 'OPENCLAW_TOOL_STALE_FAILED',
                  inputDigest: input.inputDigest,
                  metadata: {
                    toolName: input.toolName,
                    errorCode: STALE_RECEIPT_ERROR_CODE,
                    automaticRetry: false,
                  },
                },
              });
              if (input.channel === 'vaysen-crm') {
                if (!input.crmSessionDigest || !input.crmExecutionLeaseToken) {
                  throw new ForbiddenException('OpenClaw CRM execution lease context is incomplete');
                }
                const reconciled = await this.crmSessions.reconcileLockedToolExecutionAfterReceipt(
                  tx,
                  input.crmSessionDigest,
                  input.crmExecutionLeaseToken,
                );
                if (!reconciled) {
                  throw new ConflictException('OpenClaw stale callback does not own the active CRM execution lease');
                }
              }
            }
            const failedReceipt = await tx.openClawToolReceipt.findUnique({
              where: { requestKey: input.requestKey },
            });
            if (!failedReceipt) {
              throw new ConflictException('OpenClaw stale receipt disappeared during recovery');
            }
            return { created: false, runId: failedReceipt.runId, receipt: failedReceipt };
          }
          if (input.acceptanceMarkerDigest) {
            await tx.agentAuditLog.create({
              data: {
                companyId: input.owner.companyId,
                runId: existing.runId,
                actorUserId: input.owner.operatorUserId,
                eventType: 'OPENCLAW_ACCEPTANCE_REPLAY_DEDUPLICATED',
                inputDigest: input.inputDigest,
                metadata: {
                  toolName: input.toolName,
                  reusedRequestKey: true,
                },
              },
            });
          }
          return { created: false, runId: existing.runId, receipt: existing };
        }

        if (input.businessInputDigest) {
          const recentBusinessReceipt = await tx.openClawToolReceipt.findFirst({
            where: {
              companyId: input.owner.companyId,
              operatorUserId: input.owner.operatorUserId,
              senderDigest: input.senderDigest,
              sessionDigest: input.sessionDigest,
              toolName: input.toolName,
              businessInputDigest: input.businessInputDigest,
              createdAt: { gte: new Date(now.getTime() - MUTATING_INPUT_DEDUPE_WINDOW_MS) },
            },
            orderBy: { createdAt: 'desc' },
          });
          if (recentBusinessReceipt) {
            this.assertReceiptContext(recentBusinessReceipt, input);
            return {
              created: false,
              runId: recentBusinessReceipt.runId,
              receipt: recentBusinessReceipt,
            };
          }
        }

        // A consumed token is useful only as a retry pointer. If no exact or
        // canonical business receipt exists, fail closed: the gap may mean the
        // first process died after consuming the token but before reservation.
        // A new customer-search is required; never turn replay into creation.
        if (input.selectionReplay) {
          throw new ConflictException('OpenClaw customer selection replay has no active receipt');
        }

        const executionReceiptCount = await tx.openClawToolReceipt.count({
          where: {
            companyId: input.owner.companyId,
            operatorUserId: input.owner.operatorUserId,
            ...(input.channel === 'vaysen-crm'
              ? { sessionDigest: input.sessionDigest }
              : input.hasMessageBoundary
                ? {
                    sessionDigest: input.sessionDigest,
                    messageDigest: input.receiptBoundaryDigest,
                  }
                : {
                    sessionDigest: input.sessionDigest,
                    createdAt: { gte: new Date(now.getTime() - WECHAT_RECEIPT_WINDOW_MS) },
                  }),
          },
        });
        if (executionReceiptCount >= SESSION_RECEIPT_LIMIT) {
          throw new ConflictException('OpenClaw execution receipt capacity exceeded');
        }

        const run = await tx.agentRun.create({
          data: {
            requestKey: `openclaw:${input.requestKey}`,
            companyId: input.owner.companyId,
            operatorUserId: input.owner.operatorUserId,
            kind: AgentRunKind.OPENCLAW_TOOL,
            source: input.channel === 'openclaw-weixin'
              ? AgentRunSource.WECHAT_OWNER
              : AgentRunSource.CRM,
            status: AgentRunStatus.RUNNING,
            inputDigest: input.inputDigest,
            subjectType: 'openclaw_tool',
            // Irreversible execution correlation for production E2E and
            // incident audits. It scopes duplicate detection to one CRM
            // assistant request without storing the raw Gateway session key.
            subjectId: input.sessionDigest,
            startedAt: now,
            tasks: {
              create: {
                companyId: input.owner.companyId,
                toolName: `openclaw.${input.toolName}`,
                status: AgentTaskStatus.RUNNING,
                inputDigest: input.inputDigest,
                startedAt: now,
              },
            },
          },
        });
        await tx.agentAuditLog.create({
          data: {
            companyId: input.owner.companyId,
            runId: run.id,
            actorUserId: input.owner.operatorUserId,
            eventType: 'OPENCLAW_TOOL_STARTED',
            inputDigest: input.inputDigest,
            metadata: {
              toolName: input.toolName,
              channel: input.channel,
              senderVerifiedAsOwner: true,
            },
          },
        });
        const receipt = await tx.openClawToolReceipt.create({
          data: {
            requestKey: input.requestKey,
            companyId: input.owner.companyId,
            operatorUserId: input.owner.operatorUserId,
            runId: run.id,
            toolName: input.toolName,
            inputDigest: input.inputDigest,
            senderDigest: input.senderDigest,
            sessionDigest: input.sessionDigest,
            messageDigest: input.messageDigest,
            businessInputDigest: input.businessInputDigest,
            acceptanceMarkerDigest: input.acceptanceMarkerDigest,
            status: OpenClawReceiptStatus.PROCESSING,
            businessStatus: OpenClawBusinessStatus.PROCESSING,
          },
        });
        return { created: true, runId: run.id, receipt };
      });
    } catch (error) {
      if (!this.isUniqueViolation(error)) throw error;
      const receipt = await this.prisma.openClawToolReceipt.findUnique({
        where: { requestKey: input.requestKey },
      });
      // The first two owner commands can race on the binding upsert before
      // either transaction creates its receipt. Retry once so a harmless
      // first-binding race does not surface as a false request conflict.
      if (!receipt && retryBindingRace) return this.reserve(input, false);
      if (!receipt) throw new ConflictException('OpenClaw request reservation conflicted');
      this.assertReceiptContext(receipt, input);
      return { created: false, runId: receipt.runId, receipt };
    }
  }

  private async invokeAllowlistedTool(
    toolName: OpenClawToolName,
    input: Record<string, unknown>,
    requestKey: string,
    sessionDigest: string,
    owner: OwnerContext,
    channel: TrustedActorContext['channel'],
    selectionContext: OpenClawSelectionContext,
  ): Promise<unknown> {
    switch (toolName) {
      case 'work-brief': {
        const brief = await this.agent.getBrief(owner.companyId, owner.user);
        return this.minimizeWorkBrief(brief);
      }
      case 'customer-search': {
        const rawResult = await this.agent.searchCustomersForOpenClaw(
          owner.companyId,
          String(input.query || ''),
          Number(input.limit || 5),
          owner.user,
        );
        const selection = await this.selections.issueForUniqueSearch(
          selectionContext,
          requestKey,
          rawResult,
        );
        const minimized = this.minimizeCustomerSearch(rawResult, true);
        return {
          count: minimized.count,
          hasMore: minimized.hasMore,
          uniqueMatch: minimized.uniqueMatch,
          customers: minimized.customers.map((customer: Record<string, unknown>) => {
            const { whatsappConversationId: _trustedId, ...externalCustomer } = customer;
            return externalCustomer;
          }),
          selection,
          selectionRequiredForActions: true,
        };
      }
      case 'prepare-quote-delivery': {
        const turn: any = await this.agent.prepareQuoteDeliveryForOpenClaw(
          owner.companyId,
          String(input.leadId || ''),
          requestKey,
          sessionDigest,
          owner.user,
          channel === 'openclaw-weixin' ? 'WECHAT_OWNER' : 'CRM',
        );
        const proposal = turn.actionProposal || {};
        return {
          status: proposal.status || turn.actionStatus,
          quote: proposal.quote
            ? {
                referenceNo: proposal.quote.referenceNo,
                status: proposal.quote.status,
                totalAmount: proposal.quote.totalAmount,
                currency: proposal.quote.currency,
              }
            : null,
          targetName: proposal.target?.name || null,
          automaticSend: false,
          requiresHumanConfirmation: true,
          requiresManualWhatsappSend: true,
          message: turn.output,
        };
      }
      case 'start-background-research': {
        const turn: any = await this.agent.startBackgroundResearchForOpenClaw(
          owner.companyId,
          String(input.leadId || ''),
          requestKey,
          sessionDigest,
          owner.user,
          channel === 'openclaw-weixin' ? 'WECHAT_OWNER' : 'CRM',
        );
        return {
          status: turn.actionStatus,
          responseKind: turn.responseKind,
          message: turn.output,
          reportReady: turn.actionStatus === 'COMPLETED',
        };
      }
      case 'customer-get':
        return this.agent.getCustomerForOpenClaw(
          owner.companyId,
          String(input.leadId || ''),
          owner.user,
        );
      case 'customer-add-note':
        return this.agent.addCustomerNoteForOpenClaw(
          owner.companyId,
          String(input.leadId || ''),
          String(input.note || ''),
          requestKey,
          owner.user,
        );
      case 'customer-set-stage':
        return this.agent.setCustomerStageForOpenClaw(
          owner.companyId,
          String(input.leadId || ''),
          String(input.stage || ''),
          requestKey,
          owner.user,
        );
      case 'customer-update':
        return this.agent.updateCustomerForOpenClaw(
          owner.companyId,
          String(input.leadId || ''),
          {
            companyName: typeof input.companyName === 'string' ? input.companyName : undefined,
            contactName: typeof input.contactName === 'string' ? input.contactName : undefined,
            country: typeof input.country === 'string' ? input.country : undefined,
            city: typeof input.city === 'string' ? input.city : undefined,
            industry: typeof input.industry === 'string' ? input.industry : undefined,
            productCategory: typeof input.productCategory === 'string' ? input.productCategory : undefined,
            language: typeof input.language === 'string' ? input.language : undefined,
          },
          requestKey,
          owner.user,
        );
      case 'task-create':
        return this.agent.createTaskForOpenClaw(
          owner.companyId,
          String(input.leadId || ''),
          {
            title: String(input.title || ''),
            dueAt: String(input.dueAt || ''),
            priority: typeof input.priority === 'string' ? input.priority : undefined,
            reason: typeof input.reason === 'string' ? input.reason : undefined,
          },
          requestKey,
          owner.user,
        );
      case 'order-list':
        return this.agent.listOrdersForOpenClaw(
          owner.companyId,
          String(input.leadId || ''),
          owner.user,
        );
      case 'order-create-draft':
        return this.agent.createOrderDraftForOpenClaw(
          owner.companyId,
          String(input.leadId || ''),
          {
            currency: typeof input.currency === 'string' ? input.currency : undefined,
            totalAmount: typeof input.totalAmount === 'number' ? input.totalAmount : undefined,
            quoteReferenceNo: typeof input.quoteReferenceNo === 'string' ? input.quoteReferenceNo : undefined,
            deliveryDate: typeof input.deliveryDate === 'string' ? input.deliveryDate : undefined,
            shippingTerms: typeof input.shippingTerms === 'string' ? input.shippingTerms : undefined,
            notes: typeof input.notes === 'string' ? input.notes : undefined,
          },
          requestKey,
          owner.user,
        );
      case 'order-update-stage':
        return this.agent.updateOrderStageForOpenClaw(
          owner.companyId,
          String(input.leadId || ''),
          String(input.orderNo || ''),
          String(input.stage || ''),
          requestKey,
          owner.user,
        );
      case 'quote-list':
        return this.agent.listQuotesForOpenClaw(
          owner.companyId,
          String(input.leadId || ''),
          owner.user,
        );
      case 'quote-create-draft':
        return this.agent.createQuoteDraftForOpenClaw(
          owner.companyId,
          String(input.leadId || ''),
          {
            lineItems: Array.isArray(input.lineItems)
              ? input.lineItems.map((entry) => {
                  const item = this.asRecord(entry);
                  return {
                    catalogItemId: String(item.catalogItemId || ''),
                    quantity: Number(item.quantity || 0),
                    notes: typeof item.notes === 'string' ? item.notes : undefined,
                  };
                })
              : [],
            documentType: input.documentType === 'pi' ? 'pi' : 'quote',
            currency: typeof input.currency === 'string' ? input.currency : undefined,
            tradeTerms: typeof input.tradeTerms === 'string' ? input.tradeTerms : undefined,
            paymentTerms: typeof input.paymentTerms === 'string' ? input.paymentTerms : undefined,
            deliveryTime: typeof input.deliveryTime === 'string' ? input.deliveryTime : undefined,
            discount: typeof input.discount === 'number' ? input.discount : undefined,
            notes: typeof input.notes === 'string' ? input.notes : undefined,
          },
          requestKey,
          owner.user,
        );
      case 'product-search':
        return this.agent.searchProductsForOpenClaw(
          owner.companyId,
          String(input.query || ''),
          Number(input.limit || 10),
          owner.user,
        );
      case 'whatsapp-messages-read':
        return this.readWhatsappMessages(
          owner,
          String(input.leadId || ''),
          String(input.conversationId || ''),
          Number(input.limit || 20),
        );
      case 'whatsapp-send-text':
        return this.sendWhatsappText(
          owner,
          String(input.leadId || ''),
          String(input.conversationId || ''),
          String(input.text || ''),
          requestKey,
        );
      case 'whatsapp-send-quote':
        return this.sendWhatsappQuote(
          owner,
          String(input.leadId || ''),
          String(input.conversationId || ''),
          String(input.referenceNo || ''),
          requestKey,
        );
      case 'email-messages-read':
        return this.readEmailMessages(
          owner,
          String(input.leadId || ''),
          Number(input.limit || 20),
        );
      case 'email-send':
        return this.sendEmail(
          owner,
          String(input.leadId || ''),
          String(input.subject || ''),
          String(input.body || ''),
          requestKey,
        );
      case 'email-reply':
        return this.replyEmail(
          owner,
          String(input.leadId || ''),
          typeof input.subject === 'string' ? input.subject : undefined,
          String(input.body || ''),
          requestKey,
        );
    }
  }

  private async resolveSelectedLead(owner: OwnerContext, leadId: string) {
    const lead = await this.prisma.lead.findFirst({
      where: {
        id: leadId,
        companyId: owner.companyId,
        deletedAt: null,
        isMerged: false,
      },
      include: {
        contactPoints: {
          where: { type: 'email' },
          orderBy: [{ isPrimary: 'desc' }, { isVerified: 'desc' }, { updatedAt: 'desc' }],
          take: 10,
        },
        conversations: {
          where: { status: 'active' },
          select: { assignedUserId: true },
          take: 20,
        },
      },
    });
    if (!lead) {
      throw new ConflictException('The selected CRM customer is no longer active');
    }
    const memberships = owner.user.companies || [];
    if (
      !memberships.some((company) => company.id === owner.companyId)
      || (
        !memberships.some(
          (company) => company.id === owner.companyId
            && ['company_admin', 'super_admin'].includes(company.role),
        )
        && lead.ownerUserId !== owner.operatorUserId
        && !lead.conversations.some((conversation) => conversation.assignedUserId === owner.operatorUserId)
      )
    ) {
      throw new ForbiddenException('The selected customer is outside the operator scope');
    }
    return lead;
  }

  private async resolveSelectedMessagingCustomer(
    owner: OwnerContext,
    leadId: string,
    conversationId: string,
  ) {
    const lead = await this.resolveSelectedLead(owner, leadId);
    const conversation = await this.prisma.conversation.findFirst({
      where: {
        id: conversationId,
        companyId: owner.companyId,
        leadId: lead.id,
        channel: 'whatsapp',
        status: 'active',
      },
      include: {
        contactPoint: {
          select: {
            type: true,
            originalValue: true,
            normalizedValue: true,
            isVerified: true,
          },
        },
      },
    });
    if (!conversation || !isTrustedDirectWhatsappConversation(conversation)) {
      throw new ConflictException('The selected customer has no unique trusted direct WhatsApp conversation');
    }
    return { conversation, lead };
  }

  private async requireMessagingCapability(
    owner: OwnerContext,
    capability: 'crm.message.read' | 'crm.message.send' | 'crm.email.read' | 'crm.email.send' | 'crm.quote.send',
    customerId: string,
  ): Promise<{ status: 'BLOCKED' | 'APPROVAL_REQUIRED'; reason: string } | null> {
    const evaluation = await this.assistantPermissions.evaluate(
      owner.companyId,
      owner.user,
      capability,
      { customerId },
    );
    if (evaluation.decision === 'ALLOW') return null;
    return {
      status: evaluation.decision === 'APPROVAL_REQUIRED' ? 'APPROVAL_REQUIRED' : 'BLOCKED',
      reason: evaluation.reason,
    };
  }

  private async readWhatsappMessages(
    owner: OwnerContext,
    leadId: string,
    conversationId: string,
    requestedLimit: number,
  ) {
    const { conversation, lead } = await this.resolveSelectedMessagingCustomer(owner, leadId, conversationId);
    const blocked = await this.requireMessagingCapability(owner, 'crm.message.read', lead.id);
    if (blocked) return blocked;
    const limit = this.safeMessageLimit(requestedLimit);
    const messages = await this.prisma.communicationMessage.findMany({
      where: { conversationId: conversation.id },
      select: {
        direction: true,
        content: true,
        translatedContent: true,
        contentType: true,
        deliveryStatus: true,
        sentAt: true,
        receivedAt: true,
        createdAt: true,
      },
      orderBy: { createdAt: 'desc' },
      take: limit,
    });
    return {
      status: 'SUCCEEDED',
      channel: 'whatsapp',
      customerName: lead.companyName || lead.leadName || lead.contactName || 'Unnamed customer',
      messages: messages.reverse(),
    };
  }

  private async sendWhatsappText(
    owner: OwnerContext,
    leadId: string,
    conversationId: string,
    rawText: string,
    requestKey: string,
  ) {
    const { conversation, lead } = await this.resolveSelectedMessagingCustomer(owner, leadId, conversationId);
    const blocked = await this.requireMessagingCapability(owner, 'crm.message.send', lead.id);
    if (blocked) return blocked;
    const text = rawText.trim();
    if (!text || text.length > 4000) throw new BadRequestException('WhatsApp text is invalid');
    const target = String(conversation.externalThreadId || '').trim();
    if (!this.isDirectWhatsappTarget(target)) {
      throw new ConflictException('The selected customer has no trusted direct WhatsApp target');
    }
    const session = await this.resolveBaileysSession(owner.companyId, conversation.whatsappSessionId);
    const result = await this.whatsapp.sendMessage(
      session.id,
      { to: target, text },
      owner.user,
      {
        idempotencyKey: `openclaw:${requestKey}`,
        leadId: lead.id,
        conversationId: conversation.id,
        actorType: 'AGENT',
        actionType: 'OPENCLAW_WHATSAPP_TEXT',
      },
    );
    const messageId = typeof result?.messageId === 'string' ? result.messageId.trim() : '';
    if (result?.success !== true || !messageId) {
      throw new ServiceUnavailableException('WhatsApp provider did not return a delivery receipt');
    }
    return {
      status: 'SUCCEEDED',
      channel: 'whatsapp',
      customerName: lead.companyName || lead.leadName || lead.contactName || 'Unnamed customer',
      providerReceipt: this.sha256(messageId),
    };
  }

  private async sendWhatsappQuote(
    owner: OwnerContext,
    leadId: string,
    conversationId: string,
    rawReferenceNo: string,
    requestKey: string,
  ) {
    const { conversation, lead } = await this.resolveSelectedMessagingCustomer(owner, leadId, conversationId);
    const quoteBlocked = await this.requireMessagingCapability(owner, 'crm.quote.send', lead.id);
    if (quoteBlocked) return quoteBlocked;
    const messageBlocked = await this.requireMessagingCapability(owner, 'crm.message.send', lead.id);
    if (messageBlocked) return messageBlocked;
    const referenceNo = rawReferenceNo.trim().toUpperCase();
    if (!/^(?:QT|PI)-[A-Z0-9-]{6,64}$/.test(referenceNo)) {
      throw new BadRequestException('Quote reference is invalid');
    }
    const matches = await this.prisma.quote.findMany({
      where: {
        companyId: owner.companyId,
        leadId: lead.id,
        referenceNo,
      },
      select: { id: true, referenceNo: true, status: true },
      take: 2,
    });
    if (matches.length !== 1) {
      throw new ConflictException('The selected customer has no unique matching quote');
    }
    const quote = matches[0];
    if (quote.status !== 'approved') {
      return {
        status: 'BLOCKED',
        reason: 'QUOTE_NOT_APPROVED_FOR_DELIVERY',
        quoteReferenceNo: quote.referenceNo,
      };
    }
    const target = String(conversation.externalThreadId || '').trim();
    if (!this.isDirectWhatsappTarget(target)) {
      throw new ConflictException('The selected customer has no trusted direct WhatsApp target');
    }
    const session = await this.resolveBaileysSession(owner.companyId, conversation.whatsappSessionId);
    const html = await this.quotes.generatePiHtml(quote.id, owner.user);
    const pdf = await this.quotes.htmlToPdf(html);
    if (!Buffer.isBuffer(pdf) || pdf.length < 5 || pdf.subarray(0, 4).toString('ascii') !== '%PDF') {
      throw new ServiceUnavailableException('Quote PDF generation did not return a valid PDF');
    }
    const result = await this.whatsapp.sendMediaOnly(
      session.id,
      target,
      {
        type: 'document',
        buffer: pdf,
        filename: `${quote.referenceNo}.pdf`,
        mimeType: 'application/pdf',
        caption: `Quotation ${quote.referenceNo}`,
      },
      owner.user,
      {
        idempotencyKey: `openclaw:${requestKey}`,
        leadId: lead.id,
        conversationId: conversation.id,
        actorType: 'AGENT',
        actionType: 'OPENCLAW_WHATSAPP_QUOTE',
        artifactSourceId: `quote:${quote.id}`,
      },
    );
    const providerMessageId = typeof result?.providerMessageId === 'string'
      ? result.providerMessageId.trim()
      : typeof result?.messageId === 'string'
        ? result.messageId.trim()
        : '';
    const acceptedAt = typeof result?.acceptedAt === 'string' ? result.acceptedAt.trim() : '';
    if (result?.success !== true || !providerMessageId || !acceptedAt) {
      throw new ServiceUnavailableException('WhatsApp provider did not return a quote delivery receipt');
    }
    return {
      status: 'SUCCEEDED',
      channel: 'whatsapp',
      customerName: lead.companyName || lead.leadName || lead.contactName || 'Unnamed customer',
      quoteReferenceNo: quote.referenceNo,
      providerReceipt: this.sha256(providerMessageId),
      providerMessageId,
      acceptedAt,
    };
  }

  private async readEmailMessages(owner: OwnerContext, leadId: string, requestedLimit: number) {
    const lead = await this.resolveSelectedLead(owner, leadId);
    const blocked = await this.requireMessagingCapability(owner, 'crm.email.read', lead.id);
    if (blocked) return blocked;
    const messages = await this.prisma.communicationMessage.findMany({
      where: {
        conversation: {
          companyId: owner.companyId,
          leadId: lead.id,
          channel: 'business_email',
        },
      },
      select: {
        direction: true,
        subject: true,
        content: true,
        contentType: true,
        deliveryStatus: true,
        sentAt: true,
        receivedAt: true,
        createdAt: true,
      },
      orderBy: { createdAt: 'desc' },
      take: this.safeMessageLimit(requestedLimit),
    });
    return {
      status: 'SUCCEEDED',
      channel: 'email',
      customerName: lead.companyName || lead.leadName || lead.contactName || 'Unnamed customer',
      messages: messages.reverse(),
    };
  }

  private async sendEmail(
    owner: OwnerContext,
    leadId: string,
    rawSubject: string,
    rawBody: string,
    requestKey: string,
  ) {
    const lead = await this.resolveSelectedLead(owner, leadId);
    const blocked = await this.requireMessagingCapability(owner, 'crm.email.send', lead.id);
    if (blocked) return blocked;
    const subject = rawSubject.trim();
    const body = rawBody.trim();
    if (!subject || subject.length > 240 || !body || body.length > 12000) {
      throw new BadRequestException('Email subject or body is invalid');
    }
    const recipient = this.resolveTrustedLeadEmail(lead);
    const account = await this.resolveEmailAccount(owner);
    const result = await this.businessMail.sendMail({
      emailAccountId: account.id,
      to: recipient,
      subject,
      html: this.plainTextEmailHtml(body),
      leadId: lead.id,
      idempotencyKey: `openclaw:${requestKey}`,
      actorType: 'AGENT',
      actionType: 'OPENCLAW_EMAIL_SEND',
    }, owner.user);
    return this.requireEmailReceipt(result, lead, subject);
  }

  private async replyEmail(
    owner: OwnerContext,
    leadId: string,
    requestedSubject: string | undefined,
    rawBody: string,
    requestKey: string,
  ) {
    const lead = await this.resolveSelectedLead(owner, leadId);
    const blocked = await this.requireMessagingCapability(owner, 'crm.email.send', lead.id);
    if (blocked) return blocked;
    const recipient = this.resolveTrustedLeadEmail(lead);
    const account = await this.resolveEmailAccount(owner);
    const thread = await this.prisma.conversation.findFirst({
      where: {
        companyId: owner.companyId,
        leadId: lead.id,
        channel: 'business_email',
        status: 'active',
      },
      select: { id: true, subject: true },
      orderBy: [{ lastMessageAt: 'desc' }, { updatedAt: 'desc' }],
    });
    if (!thread) throw new ConflictException('The selected customer has no email thread to reply to');
    const body = rawBody.trim();
    if (!body || body.length > 12000) throw new BadRequestException('Email body is invalid');
    const sourceSubject = (requestedSubject || thread.subject || 'Follow-up').trim();
    const subject = /^re\s*:/i.test(sourceSubject) ? sourceSubject : `Re: ${sourceSubject}`;
    if (subject.length > 240) throw new BadRequestException('Email subject is too long');
    const result = await this.businessMail.sendMail({
      emailAccountId: account.id,
      to: recipient,
      subject,
      html: this.plainTextEmailHtml(body),
      conversationId: thread.id,
      leadId: lead.id,
      idempotencyKey: `openclaw:${requestKey}`,
      actorType: 'AGENT',
      actionType: 'OPENCLAW_EMAIL_REPLY',
    }, owner.user);
    return this.requireEmailReceipt(result, lead, subject);
  }

  private requireEmailReceipt(result: any, lead: any, subject: string) {
    const messageId = typeof result?.messageId === 'string' ? result.messageId.trim() : '';
    if (!messageId) {
      throw new ServiceUnavailableException('SMTP provider did not return a delivery receipt');
    }
    return {
      status: 'SUCCEEDED',
      channel: 'email',
      customerName: lead.companyName || lead.leadName || lead.contactName || 'Unnamed customer',
      subject,
      providerReceipt: this.sha256(messageId),
    };
  }

  private resolveTrustedLeadEmail(lead: any): string {
    const candidates = new Map<string, { primary: boolean; verified: boolean }>();
    for (const point of Array.isArray(lead.contactPoints) ? lead.contactPoints : []) {
      const value = String(point.normalizedValue || '').trim().toLowerCase();
      if (!this.isEmail(value)) continue;
      const current = candidates.get(value) || { primary: false, verified: false };
      candidates.set(value, {
        primary: current.primary || point.isPrimary === true,
        verified: current.verified || point.isVerified === true,
      });
    }
    const leadEmail = String(lead.contactEmail || '').trim().toLowerCase();
    if (this.isEmail(leadEmail)) {
      const current = candidates.get(leadEmail) || { primary: false, verified: false };
      candidates.set(leadEmail, {
        primary: current.primary || candidates.size === 0,
        verified: current.verified || ['smtp_verified', 'official_page_verified', 'verified_public_source'].includes(
          String(lead.emailVerificationStatus || ''),
        ),
      });
    }
    if (candidates.size === 1) return [...candidates.keys()][0];
    const primary = [...candidates.entries()].filter(([, metadata]) => metadata.primary);
    if (primary.length === 1) return primary[0][0];
    const verified = [...candidates.entries()].filter(([, metadata]) => metadata.verified);
    if (verified.length === 1) return verified[0][0];
    throw new ConflictException('The selected customer has no unique stored email address');
  }

  private async resolveEmailAccount(owner: OwnerContext): Promise<{ id: string }> {
    const accounts = await this.prisma.emailAccount.findMany({
      where: {
        companyId: owner.companyId,
        status: 'active',
        OR: [{ userId: owner.operatorUserId }, { userId: null }],
      },
      select: { id: true, userId: true },
      orderBy: [{ userId: 'desc' }, { updatedAt: 'desc' }],
      take: 10,
    });
    const owned = accounts.filter((account) => account.userId === owner.operatorUserId);
    const shared = accounts.filter((account) => account.userId === null);
    const eligible = owned.length ? owned : shared;
    if (eligible.length !== 1) {
      throw new ConflictException('The company must have exactly one active email account for this operator');
    }
    return { id: eligible[0].id };
  }

  private async resolveBaileysSession(companyId: string, selectedSessionId: string | null) {
    if (!selectedSessionId) {
      throw new ConflictException(
        'The selected WhatsApp conversation has no trusted server session binding',
      );
    }
    const selected = await this.prisma.whatsAppSession.findFirst({
      where: { id: selectedSessionId, companyId, status: 'connected' },
      select: { id: true, authStatePath: true },
    });
    if (selected && this.isServerBaileysSession(selected)) return selected;
    throw new ConflictException(
      'Electron or Evolution conversations cannot fall back to an unrelated Baileys session',
    );
  }

  private isServerBaileysSession(session: { authStatePath?: string | null } | null): boolean {
    const authStatePath = String(session?.authStatePath || '');
    return Boolean(session)
      && !authStatePath.startsWith('evolution-api:')
      && !authStatePath.startsWith('electron-account:');
  }

  private safeMessageLimit(value: number): number {
    const parsed = Number.isFinite(value) ? Math.trunc(value) : 20;
    return Math.max(1, Math.min(30, parsed));
  }

  private isDirectWhatsappTarget(value: string): boolean {
    return /^\d{7,15}$/.test(value)
      || /^\d{7,20}(?::\d+)?@(?:s\.whatsapp\.net|lid)$/i.test(value);
  }

  private isEmail(value: string): boolean {
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value) && value.length <= 320;
  }

  private plainTextEmailHtml(value: string): string {
    const escaped = value
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
    return escaped.split(/\r?\n/).map((line) => line || '&nbsp;').join('<br>');
  }

  private async resolveTrustedActor(actor: OpenClawActorDto): Promise<TrustedActorContext> {
    if (actor.senderIsOwner !== true || actor.channel !== actor.source) {
      throw new ForbiddenException('OpenClaw actor source is not trusted');
    }
    if (actor.channel === 'openclaw-weixin') {
      if (!actor.requesterSenderId || !actor.agentAccountId || actor.agentId) {
        throw new ForbiddenException('Incomplete owner WeChat actor context');
      }
      const senderDigest = this.sha256(actor.requesterSenderId);
      const owner = await this.resolveOwner();
      await this.assertOwnerSender(senderDigest, owner);
      return {
        ...owner,
        channel: 'openclaw-weixin',
        senderDigest,
        accountDigest: this.sha256(actor.agentAccountId),
        requiresWechatBinding: true,
        crmSessionDigest: null,
        crmExecutionLeaseToken: null,
      };
    }
    if (
      actor.channel !== 'vaysen-crm'
      || actor.agentId !== 'vaysen-crm'
      || actor.requesterSenderId
      || actor.agentAccountId
      || !actor.sessionKey.startsWith('vaysen-crm:')
    ) {
      throw new ForbiddenException('Incomplete CRM OpenClaw actor context');
    }
    const owner = await this.crmSessions.resolve(actor.sessionKey);
    const crmSessionDigest = actor.sessionKey.slice('vaysen-crm:'.length);
    return {
      ...owner,
      channel: 'vaysen-crm',
      senderDigest: this.sha256(`vaysen-crm\n${actor.sessionKey}`),
      accountDigest: this.sha256('vaysen-crm'),
      requiresWechatBinding: false,
      crmSessionDigest,
      crmExecutionLeaseToken: owner.executionLeaseToken,
    };
  }

  private runTerminalTransaction<T extends { claimed: boolean }>(
    trusted: TrustedActorContext,
    terminalTransition: (tx: Prisma.TransactionClient) => Promise<T>,
  ): Promise<T> {
    if (trusted.channel !== 'vaysen-crm') {
      return this.prisma.$transaction(terminalTransition);
    }
    if (!trusted.crmSessionDigest || !trusted.crmExecutionLeaseToken) {
      throw new ForbiddenException('OpenClaw CRM execution lease context is incomplete');
    }
    return this.crmSessions.runToolTerminalTransaction(
      trusted.crmSessionDigest,
      trusted.crmExecutionLeaseToken,
      terminalTransition,
    );
  }

  private async resolveOwner(): Promise<OwnerContext> {
    const email = (process.env.OPENCLAW_OWNER_EMAIL || '').trim().toLowerCase();
    const companySlug = (process.env.OPENCLAW_OWNER_COMPANY_SLUG || '').trim();
    if (!email || !/^\S+@\S+\.\S+$/.test(email) || !companySlug) {
      throw new ServiceUnavailableException('OpenClaw owner is not configured');
    }
    const user = await this.prisma.user.findFirst({
      where: {
        email: { equals: email, mode: 'insensitive' },
        isActive: true,
        deletedAt: null,
      },
      include: {
        companies: {
          where: {
            isActive: true,
            company: {
              isActive: true,
              slug: companySlug,
            },
          },
          include: { company: true, role: true },
        },
      },
    });
    if (!user || user.companies.length !== 1) {
      throw new ServiceUnavailableException('OpenClaw owner must resolve to exactly one active company');
    }
    // The database query above is scoped by the configured company slug and
    // the exact-one check prevents any ambiguous first-membership fallback.
    const [relation] = user.companies;
    if (!['company_admin', 'super_admin'].includes(relation.role.name)) {
      throw new ForbiddenException('OpenClaw owner must be a company administrator');
    }
    return {
      companyId: relation.companyId,
      operatorUserId: user.id,
      user: {
        id: user.id,
        email: user.email,
        activeCompanyId: relation.companyId,
        activeCompany: { id: relation.companyId, role: relation.role.name },
        companies: [{ id: relation.companyId, role: relation.role.name }],
      },
    };
  }

  private async assertOwnerSender(actualDigest: string, owner: OwnerContext) {
    const binding = await this.prisma.openClawOperatorBinding.findFirst({
      where: {
        companyId: owner.companyId,
        operatorUserId: owner.operatorUserId,
        channel: 'openclaw-weixin',
        status: OpenClawBindingStatus.ACTIVE,
      },
      orderBy: [{ lastSeenAt: 'desc' }, { boundAt: 'desc' }, { id: 'desc' }],
      select: { senderDigest: true },
    });
    if (binding) {
      const expected = /^[a-f0-9]{64}$/.test(binding.senderDigest)
        ? Buffer.from(binding.senderDigest, 'hex')
        : Buffer.alloc(0);
      const actual = Buffer.from(actualDigest, 'hex');
      if (expected.length === actual.length && expected.length > 0 && timingSafeEqual(expected, actual)) return;
      throw new ForbiddenException('Unknown OpenClaw WeChat sender');
    }
    const expectedDigest = (process.env.OPENCLAW_WECHAT_OWNER_PEER_SHA256 || '').trim().toLowerCase();
    if (/^[a-f0-9]{64}$/.test(expectedDigest)) {
      const expected = Buffer.from(expectedDigest, 'hex');
      const actual = Buffer.from(actualDigest, 'hex');
      if (expected.length === actual.length && timingSafeEqual(expected, actual)) return;
    }
    throw new ForbiddenException('Unknown OpenClaw WeChat sender');
  }

  private assertReceiptContext(receipt: any, input: {
    inputDigest: string;
    toolName: string;
    owner: OwnerContext;
    senderDigest: string;
    acceptanceMarkerDigest: string | null;
  }) {
    if (
      receipt.inputDigest !== input.inputDigest
      || receipt.toolName !== input.toolName
      || receipt.companyId !== input.owner.companyId
      || receipt.operatorUserId !== input.owner.operatorUserId
      || receipt.senderDigest !== input.senderDigest
      || (receipt.acceptanceMarkerDigest || null) !== input.acceptanceMarkerDigest
    ) {
      throw new ConflictException('OpenClaw request id was reused with different context');
    }
  }

  private responseFromReceipt(receipt: any) {
    return {
      schemaVersion: 1 as const,
      requestId: receipt.requestKey,
      toolName: receipt.toolName,
      status: receipt.status,
      businessStatus: this.businessStatusForReceipt(receipt),
      result: receipt.result
        ? this.minimizeToolResult(receipt.toolName, receipt.result)
        : null,
      errorCode: receipt.errorCode || null,
    };
  }

  private toJsonValue(value: unknown): Prisma.InputJsonValue {
    return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
  }

  private minimizeWorkBrief(value: unknown) {
    const brief = this.asRecord(value);
    const metrics = this.asRecord(brief.metrics);
    const statusCounts = Object.fromEntries(
      Object.entries(this.asRecord(brief.leadStatusCounts))
        .filter(([key, count]) => /^[a-z0-9_-]{1,40}$/i.test(key) && Number.isFinite(Number(count)))
        .map(([key, count]) => [key, Math.max(0, Math.trunc(Number(count)))]),
    );
    const reminders = Array.isArray(brief.reminders) ? brief.reminders : [];
    const quotes = Array.isArray(brief.quotes) ? brief.quotes : [];
    const runs = Array.isArray(brief.runs) ? brief.runs : [];
    return {
      generatedAt: this.safeIsoText(brief.generatedAt),
      metrics: Object.fromEntries(
        Object.entries(metrics)
          .filter(([key, count]) => /^[a-z][a-z0-9]{0,39}$/i.test(key) && Number.isFinite(Number(count)))
          .map(([key, count]) => [key, Math.max(0, Math.trunc(Number(count)))]),
      ),
      leadStatusCounts: statusCounts,
      reminders: reminders.slice(0, 12).map((entry) => {
        const item = this.asRecord(entry);
        return {
          title: this.safeExternalText(item.title, 180),
          reason: this.safeExternalText(item.reason, 240) || null,
          priority: this.safeCodeText(item.priority, 32),
          dueAt: this.safeIsoText(item.dueAt),
        };
      }),
      quotes: quotes.slice(0, 8).map((entry) => {
        const item = this.asRecord(entry);
        const amount = String(item.totalAmount ?? '');
        const currency = String(item.currency || '').trim().toUpperCase();
        return {
          referenceNo: this.safeBusinessReference(item.referenceNo),
          status: this.safeCodeText(item.status, 40),
          totalAmount: /^-?\d{1,12}(?:\.\d{1,6})?$/.test(amount) ? amount : null,
          currency: /^[A-Z]{3}$/.test(currency) ? currency : null,
        };
      }),
      runs: runs.slice(0, 20).map((entry) => {
        const item = this.asRecord(entry);
        const result = this.asRecord(item.result);
        const businessReference = [
          item.businessReference,
          result.businessReference,
          result.referenceNo,
          result.quoteReferenceNo,
          result.reportNo,
          result.taskNo,
        ].map((candidate) => this.safeBusinessReference(candidate)).find(Boolean) || null;
        return {
          kind: this.safeCodeText(item.kind, 48),
          status: this.safeCodeText(item.status, 48),
          businessReference,
        };
      }),
    };
  }

  private minimizeToolResult(toolName: string, value: unknown): unknown {
    switch (toolName) {
      case 'work-brief':
        return this.minimizeWorkBrief(value);
      case 'customer-search':
        return this.minimizeCustomerSearch(value);
      case 'prepare-quote-delivery': {
        const result = this.asRecord(value);
        const quote = this.asRecord(result.quote);
        const totalAmount = String(quote.totalAmount ?? '');
        const currency = String(quote.currency || '').trim().toUpperCase();
        const targetName = this.safeExternalText(result.targetName, 160);
        return {
          status: this.safeCodeText(result.status, 48),
          quote: Object.keys(quote).length
            ? {
                referenceNo: this.safeBusinessReference(quote.referenceNo),
                status: this.safeCodeText(quote.status, 40),
                totalAmount: /^-?\d{1,12}(?:\.\d{1,6})?$/.test(totalAmount) ? totalAmount : null,
                currency: /^[A-Z]{3}$/.test(currency) ? currency : null,
              }
            : null,
          targetName: targetName || null,
          automaticSend: false,
          requiresHumanConfirmation: true,
          requiresManualWhatsappSend: true,
          message: this.safeExternalText(result.message, 600),
        };
      }
      case 'start-background-research': {
        const result = this.asRecord(value);
        const status = this.safeCodeText(result.status, 48);
        return {
          status,
          responseKind: this.safeCodeText(result.responseKind, 48),
          message: this.safeExternalText(result.message, 600),
          reportReady: status === 'COMPLETED' && result.reportReady === true,
        };
      }
      case 'customer-get': {
        const result = this.asRecord(value);
        const customer = this.asRecord(result.customer);
        return {
          status: this.safeCodeText(result.status, 48),
          reason: this.safeCodeText(result.reason, 80) || null,
          customer: Object.keys(customer).length ? {
            name: this.safeExternalText(customer.name, 240),
            country: this.safeExternalText(customer.country, 100) || null,
            productCategory: this.safeExternalText(customer.productCategory, 180) || null,
            stage: this.safeCodeText(customer.stage, 40),
            grade: this.safeCodeText(customer.grade, 24),
            hasEmail: customer.hasEmail === true,
            hasWhatsapp: customer.hasWhatsapp === true,
            nextFollowUpAt: this.safeIsoText(customer.nextFollowUpAt),
            updatedAt: this.safeIsoText(customer.updatedAt),
          } : null,
        };
      }
      case 'customer-add-note':
      case 'customer-update':
      case 'customer-set-stage':
      case 'task-create':
      case 'order-create-draft':
      case 'order-update-stage':
      case 'quote-create-draft':
        return this.minimizeMutationResult(value);
      case 'order-list':
        return this.minimizeListResult(value, 'orders', ['orderNo', 'stage', 'currency', 'totalAmount', 'paidAmount', 'deliveryDate', 'updatedAt']);
      case 'quote-list':
        return this.minimizeListResult(value, 'quotes', ['referenceNo', 'type', 'status', 'currency', 'totalAmount', 'updatedAt']);
      case 'product-search':
        return this.minimizeProductSearch(value);
      case 'whatsapp-messages-read':
      case 'email-messages-read':
        return this.minimizeCommunicationMessages(value);
      case 'whatsapp-send-text':
      case 'whatsapp-send-quote':
      case 'email-send':
      case 'email-reply':
        return this.minimizeExternalSendResult(value);
      default:
        return {};
    }
  }

  private businessStatusForToolResult(
    toolName: string,
    value: unknown,
  ): OpenClawBusinessStatus {
    if (toolName === 'work-brief' || toolName === 'customer-search' || toolName === 'product-search') {
      return OpenClawBusinessStatus.SUCCEEDED;
    }
    const result = this.asRecord(value);
    const status = String(result.status || '').toUpperCase();
    if (
      status === 'BLOCKED'
      || status === 'APPROVAL_REQUIRED'
      || String(result.responseKind || '').toUpperCase() === 'ACTION_BLOCKED'
    ) {
      return OpenClawBusinessStatus.BLOCKED;
    }
    if (toolName === 'prepare-quote-delivery') {
      return status === 'REQUIRES_CONFIRMATION'
        ? OpenClawBusinessStatus.SUCCEEDED
        : OpenClawBusinessStatus.BLOCKED;
    }
    if (toolName === 'start-background-research') {
      if (['QUEUED', 'RUNNING', 'COMPLETED'].includes(status)) {
        return OpenClawBusinessStatus.SUCCEEDED;
      }
      // BLOCKED means the safety/permission/input checks intentionally did
      // not execute a job. A real worker failure (or an explicitly cancelled
      // historical request) is not a policy block and must remain FAILED.
      if (status === 'BLOCKED') return OpenClawBusinessStatus.BLOCKED;
      if (status === 'FAILED' || status === 'CANCELLED') {
        return OpenClawBusinessStatus.FAILED;
      }
      return OpenClawBusinessStatus.FAILED;
    }
    return status === 'SUCCEEDED'
      ? OpenClawBusinessStatus.SUCCEEDED
      : OpenClawBusinessStatus.FAILED;
  }

  private businessStatusForReceipt(receipt: any): OpenClawBusinessStatus {
    if (receipt.status === OpenClawReceiptStatus.PROCESSING) {
      return OpenClawBusinessStatus.PROCESSING;
    }
    if (receipt.status === OpenClawReceiptStatus.FAILED) {
      return OpenClawBusinessStatus.FAILED;
    }
    if (receipt.status !== OpenClawReceiptStatus.COMPLETED) {
      return OpenClawBusinessStatus.FAILED;
    }
    // Derive again from the canonical result. This prevents a malformed or
    // historical stored flag from turning result.status=BLOCKED into success.
    return this.businessStatusForToolResult(receipt.toolName, receipt.result);
  }

  private minimizeCustomerSearch(value: unknown, includeConversationId = false) {
    const result = this.asRecord(value);
    const customers = Array.isArray(result.customers) ? result.customers : [];
    const minimizedCustomers = customers.slice(0, 10).map((entry) => {
      const item = this.asRecord(entry);
      const conversationId = typeof item.whatsappConversationId === 'string'
        && /^\b[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b$/i.test(item.whatsappConversationId)
        ? item.whatsappConversationId
        : null;
      const externalCustomer: Record<string, unknown> = {
        customerName: this.safeExternalText(item.customerName, 240),
        country: this.safeExternalText(item.country, 100) || null,
        productCategory: this.safeExternalText(item.productCategory, 180) || null,
        status: this.safeCodeText(item.status, 40),
        leadGrade: this.safeCodeText(item.leadGrade, 24),
        updatedAt: this.safeIsoText(item.updatedAt),
      };
      if (includeConversationId) externalCustomer.whatsappConversationId = conversationId;
      return externalCustomer;
    });
    const selection = this.asRecord(result.selection);
    const tokens = this.asRecord(selection.tokens);
    const safeTokens = Object.fromEntries(SELECTION_TOOL_NAMES.flatMap((toolName) => {
      const token = tokens[toolName];
      return typeof token === 'string' && /^[A-Za-z0-9_-]{43}$/.test(token)
        ? [[toolName, token]]
        : [];
    }));
    const expiresAt = this.safeIsoText(selection.expiresAt);
    const hasMore = result.hasMore === true;
    const uniqueMatch = result.uniqueMatch === true
      && !hasMore
      && minimizedCustomers.length === 1;
    return {
      count: minimizedCustomers.length,
      hasMore,
      uniqueMatch,
      customers: minimizedCustomers,
      selection: Object.keys(safeTokens).length === SELECTION_TOOL_NAMES.length && expiresAt
        ? {
            expiresAt,
            tokens: safeTokens,
          }
        : null,
      selectionRequiredForActions: true,
    };
  }

  private minimizeMutationResult(value: unknown) {
    const result = this.asRecord(value);
    const decimal = (candidate: unknown) => {
      const text = String(candidate ?? '');
      return /^-?\d{1,12}(?:\.\d{1,6})?$/.test(text) ? text : null;
    };
    return {
      status: this.safeCodeText(result.status, 48),
      reason: this.safeCodeText(result.reason, 80) || null,
      customerName: this.safeExternalText(result.customerName, 240) || null,
      title: this.safeExternalText(result.title, 180) || null,
      dueAt: this.safeIsoText(result.dueAt),
      referenceNo: this.safeBusinessReference(result.referenceNo),
      orderNo: this.safeBusinessReference(result.orderNo),
      quoteStatus: this.safeCodeText(result.quoteStatus, 40) || null,
      previousStage: this.safeCodeText(result.previousStage, 40) || null,
      stage: this.safeCodeText(result.stage, 40) || null,
      currency: /^[A-Z]{3}$/.test(String(result.currency || '')) ? String(result.currency) : null,
      subtotal: decimal(result.subtotal),
      totalAmount: decimal(result.totalAmount),
      priceVersion: this.safeCodeText(result.priceVersion, 80) || null,
    };
  }

  private minimizeCommunicationMessages(value: unknown) {
    const result = this.asRecord(value);
    const messages = Array.isArray(result.messages) ? result.messages : [];
    return {
      status: this.safeCodeText(result.status, 48),
      reason: this.safeCodeText(result.reason, 80) || null,
      channel: ['whatsapp', 'email'].includes(String(result.channel || ''))
        ? String(result.channel)
        : null,
      customerName: this.safeExternalText(result.customerName, 240) || null,
      messages: messages.slice(0, 30).map((entry) => {
        const item = this.asRecord(entry);
        const rawContent = String(item.translatedContent || item.content || '')
          .replace(/<[^>]{0,500}>/g, ' ')
          .replace(/\s+/g, ' ');
        return {
          direction: ['inbound', 'outbound'].includes(String(item.direction || ''))
            ? String(item.direction)
            : null,
          subject: this.safeExternalText(item.subject, 240) || null,
          content: this.safeExternalText(rawContent, 1200),
          contentType: this.safeCodeText(item.contentType, 32) || null,
          deliveryStatus: this.safeCodeText(item.deliveryStatus, 32) || null,
          occurredAt: this.safeIsoText(item.receivedAt || item.sentAt || item.createdAt),
        };
      }),
    };
  }

  private minimizeExternalSendResult(value: unknown) {
    const result = this.asRecord(value);
    const receipt = this.safeCodeText(result.providerReceipt, 64);
    const providerMessageId = this.safeExternalText(result.providerMessageId, 256);
    const acceptedAt = this.safeIsoText(result.acceptedAt);
    const quoteReferenceNo = this.safeBusinessReference(result.quoteReferenceNo);
    const hasReceipt = !!(receipt && /^[a-f0-9]{64}$/.test(receipt));
    return {
      status: this.safeCodeText(result.status, 48),
      reason: this.safeCodeText(result.reason, 80) || null,
      channel: ['whatsapp', 'email'].includes(String(result.channel || ''))
        ? String(result.channel)
        : null,
      customerName: this.safeExternalText(result.customerName, 240) || null,
      subject: this.safeExternalText(result.subject, 240) || null,
      quoteReferenceNo: quoteReferenceNo || null,
      providerReceipt: hasReceipt ? receipt : null,
      providerMessageId: providerMessageId || null,
      acceptedAt,
      delivered: String(result.status || '').toUpperCase() === 'SUCCEEDED'
        && hasReceipt
        && (quoteReferenceNo ? !!providerMessageId && !!acceptedAt : true),
    };
  }

  private minimizeListResult(value: unknown, field: 'orders' | 'quotes', allowedFields: readonly string[]) {
    const result = this.asRecord(value);
    const entries = Array.isArray(result[field]) ? result[field] : [];
    return {
      status: this.safeCodeText(result.status, 48),
      reason: this.safeCodeText(result.reason, 80) || null,
      [field]: entries.slice(0, 12).map((entry) => {
        const item = this.asRecord(entry);
        const output: Record<string, unknown> = {};
        for (const key of allowedFields) {
          const candidate = item[key];
          if (key.endsWith('At') || key === 'deliveryDate') output[key] = this.safeIsoText(candidate);
          else if (key === 'orderNo' || key === 'referenceNo') output[key] = this.safeBusinessReference(candidate);
          else if (key === 'totalAmount' || key === 'paidAmount') {
            const text = String(candidate ?? '');
            output[key] = /^-?\d{1,12}(?:\.\d{1,6})?$/.test(text) ? text : null;
          } else output[key] = this.safeCodeText(candidate, 48) || null;
        }
        return output;
      }),
    };
  }

  private minimizeProductSearch(value: unknown) {
    const result = this.asRecord(value);
    const products = Array.isArray(result.products) ? result.products : [];
    return {
      status: this.safeCodeText(result.status, 48),
      reason: this.safeCodeText(result.reason, 80) || null,
      priceVersion: this.safeCodeText(result.priceVersion, 80) || null,
      currency: String(result.currency || '') === 'USD' ? 'USD' : null,
      requiresHumanApproval: result.requiresHumanApproval === true,
      products: products.slice(0, 20).map((entry) => {
        const item = this.asRecord(entry);
        const saleUsd = Number(item.saleUsd);
        return {
          catalogItemId: /^JYM-\d{4}$/.test(String(item.catalogItemId || '')) ? item.catalogItemId : null,
          name: this.safeExternalText(item.name, 180),
          size: this.safeExternalText(item.size, 100) || null,
          thickness: this.safeExternalText(item.thickness, 100) || null,
          unit: this.safeCodeText(item.unit, 24) || null,
          saleUsd: Number.isFinite(saleUsd) && saleUsd >= 0 ? saleUsd : null,
        };
      }),
    };
  }

  private safeExternalText(value: unknown, maxLength: number): string {
    if (typeof value !== 'string') return '';
    return redactForExternalAi(value)
      .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/gi, '[ID_REDACTED]')
      .replace(/[\u0000-\u001f\u007f]/g, '')
      .trim()
      .slice(0, maxLength);
  }

  /**
   * Business references are identifiers such as QT-20260714-1001, not prose.
   * Running the generic phone redactor over them corrupts the numeric portion,
   * while accepting arbitrary strings could leak UUIDs, email addresses, keys,
   * or free-form database output. Keep only a narrow, structured alphabet.
   */
  private safeBusinessReference(value: unknown): string | null {
    if (typeof value !== 'string') return null;
    const text = value
      .replace(/[\u0000-\u001f\u007f]/g, '')
      .trim()
      .slice(0, 80);
    if (!text) return null;
    if (/\b[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/i.test(text)) {
      return null;
    }
    if (/[@\s]/.test(text) || /(?:secret|password|api[_-]?key|bearer|token)/i.test(text)) {
      return null;
    }
    return /^[A-Z][A-Z0-9]{0,15}(?:-[A-Z0-9]{1,24}){1,5}$/i.test(text)
      ? text
      : null;
  }

  private safeCodeText(value: unknown, maxLength: number): string | null {
    if (typeof value !== 'string') return null;
    const text = value.trim().slice(0, maxLength);
    return /^[A-Za-z0-9_.-]+$/.test(text) ? text : null;
  }

  private safeIsoText(value: unknown): string | null {
    const timestamp = value instanceof Date ? value.getTime() : Date.parse(String(value || ''));
    return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : null;
  }

  private asRecord(value: unknown): Record<string, any> {
    return value && typeof value === 'object' && !Array.isArray(value)
      ? value as Record<string, any>
      : {};
  }

  private sha256(value: string): string {
    return createHash('sha256').update(value, 'utf8').digest('hex');
  }

  private isUniqueViolation(error: unknown): boolean {
    return !!error && typeof error === 'object' && (error as { code?: string }).code === 'P2002';
  }
}
