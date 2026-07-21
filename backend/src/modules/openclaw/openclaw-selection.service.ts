import {
  ConflictException,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import { OpenClawReceiptStatus } from '@prisma/client';
import { createHash, randomBytes } from 'crypto';
import { PrismaService } from '../../common/prisma/prisma.service';
import type { OpenClawToolName } from './openclaw-tool-broker.service';

export type OpenClawSelectionContext = {
  companyId: string;
  operatorUserId: string;
  channel: 'openclaw-weixin' | 'vaysen-crm';
  senderDigest: string;
  accountDigest: string;
  sessionDigest: string;
  messageDigest: string;
};

type ActionToolName = Extract<
  OpenClawToolName,
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
  | 'whatsapp-messages-read'
  | 'whatsapp-send-text'
  | 'whatsapp-send-quote'
  | 'email-messages-read'
  | 'email-send'
  | 'email-reply'
>;

const SELECTION_TTL_MS = 2 * 60_000;
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ACTION_TOOLS: readonly ActionToolName[] = [
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

/**
 * Issues and consumes the short-lived capability that bridges a unique CRM
 * search result to a mutating action. The model never gets to choose a CRM
 * UUID: the broker derives it exclusively from the consumed database row.
 */
@Injectable()
export class OpenClawSelectionService {
  constructor(private readonly prisma: PrismaService) {}

  async issueForUniqueSearch(
    context: OpenClawSelectionContext,
    searchRequestKey: string,
    searchResult: unknown,
  ): Promise<{
    expiresAt: string;
    tokens: Record<ActionToolName, string>;
  } | null> {
    const result = this.asRecord(searchResult);
    const customers = Array.isArray(result.customers) ? result.customers : [];
    const declaredCount = Number(result.count);
    // `count === 1` can merely mean "one displayed row" when the caller used
    // limit=1. A capability is issued only when the database query explicitly
    // proved lead uniqueness. The WhatsApp conversation is optional: customer,
    // order and email tools remain usable for a lead without WhatsApp, while
    // WhatsApp tools independently require one trusted direct conversation.
    if (
      result.uniqueMatch !== true
      || result.hasMore !== false
      || declaredCount !== 1
      || customers.length !== 1
    ) return null;

    const customer = this.asRecord(customers[0]);
    const leadId = typeof customer.trustedLeadId === 'string'
      ? customer.trustedLeadId.trim()
      : '';
    const conversationId = typeof customer.whatsappConversationId === 'string'
      ? customer.whatsappConversationId.trim()
      : '';
    if (!UUID_PATTERN.test(leadId)) return null;
    if (conversationId && !UUID_PATTERN.test(conversationId)) return null;

    const expiresAt = new Date(Date.now() + SELECTION_TTL_MS);
    const rawTokens = Object.fromEntries(
      ACTION_TOOLS.map((targetTool) => [targetTool, randomBytes(32).toString('base64url')]),
    ) as Record<ActionToolName, string>;

    await this.prisma.$transaction(async (tx) => {
      const lockKey = `openclaw-selection-issue:${searchRequestKey}`;
      await tx.$queryRaw<Array<{ locked: string }>>`
        SELECT pg_advisory_xact_lock(hashtextextended(${lockKey}, 0))::text AS locked
      `;
      await tx.openClawSelectionToken.createMany({
        data: ACTION_TOOLS.map((targetTool) => ({
          tokenDigest: this.sha256(rawTokens[targetTool]),
          companyId: context.companyId,
          operatorUserId: context.operatorUserId,
          channel: context.channel,
          senderDigest: context.senderDigest,
          accountDigest: context.accountDigest,
          sessionDigest: context.sessionDigest,
          messageDigest: context.messageDigest,
          searchRequestKey,
          targetTool,
          leadId,
          conversationId: conversationId || null,
          expiresAt,
        })),
      });
    });

    return { expiresAt: expiresAt.toISOString(), tokens: rawTokens };
  }

  async consume(
    rawToken: string,
    targetTool: ActionToolName,
    context: OpenClawSelectionContext,
  ): Promise<{ leadId: string; conversationId: string | null; replay: boolean }> {
    const token = typeof rawToken === 'string' ? rawToken.trim() : '';
    if (!TOKEN_PATTERN.test(token)) {
      throw new ForbiddenException('OpenClaw customer selection is missing or invalid');
    }
    const tokenDigest = this.sha256(token);

    return this.prisma.$transaction(async (tx) => {
      const lockKey = `openclaw-selection-consume:${tokenDigest}`;
      await tx.$queryRaw<Array<{ locked: string }>>`
        SELECT pg_advisory_xact_lock(hashtextextended(${lockKey}, 0))::text AS locked
      `;
      const now = new Date();
      const selection = await tx.openClawSelectionToken.findUnique({
        where: { tokenDigest },
      });
      // Deliberately use one generic denial for missing, expired, replayed and
      // cross-context tokens. Callers must not be able to probe token metadata.
      if (
        !selection
        || selection.expiresAt <= now
        || selection.companyId !== context.companyId
        || selection.operatorUserId !== context.operatorUserId
        || selection.channel !== context.channel
        || selection.senderDigest !== context.senderDigest
        || selection.accountDigest !== context.accountDigest
        || selection.sessionDigest !== context.sessionDigest
        || selection.messageDigest !== context.messageDigest
        || selection.targetTool !== targetTool
        || !UUID_PATTERN.test(selection.leadId)
        || (selection.conversationId !== null && !UUID_PATTERN.test(selection.conversationId))
      ) {
        throw new ForbiddenException('OpenClaw customer selection is not active for this request');
      }

      if (selection.consumedAt) {
        // This does not authorize another side effect. It only carries enough
        // trusted context for the broker to look up an already-reserved receipt
        // under its business advisory lock. A replay without such a receipt is
        // rejected before creation.
        return {
          leadId: selection.leadId,
          conversationId: selection.conversationId || null,
          replay: true,
        };
      }

      const searchReceipt = await tx.openClawToolReceipt.findUnique({
        where: { requestKey: selection.searchRequestKey },
      });
      if (
        !searchReceipt
        || searchReceipt.status !== OpenClawReceiptStatus.COMPLETED
        || searchReceipt.toolName !== 'customer-search'
        || searchReceipt.companyId !== context.companyId
        || searchReceipt.operatorUserId !== context.operatorUserId
        || searchReceipt.senderDigest !== context.senderDigest
        || searchReceipt.sessionDigest !== context.sessionDigest
        || searchReceipt.messageDigest !== context.messageDigest
      ) {
        throw new ForbiddenException('OpenClaw customer selection source is not complete');
      }

      const consumed = await tx.openClawSelectionToken.updateMany({
        where: {
          id: selection.id,
          consumedAt: null,
          expiresAt: { gt: now },
        },
        data: { consumedAt: now },
      });
      if (consumed.count !== 1) {
        throw new ConflictException('OpenClaw customer selection was already consumed');
      }
      return {
        leadId: selection.leadId,
        conversationId: selection.conversationId || null,
        replay: false,
      };
    });
  }

  private asRecord(value: unknown): Record<string, any> {
    return value && typeof value === 'object' && !Array.isArray(value)
      ? value as Record<string, any>
      : {};
  }

  private sha256(value: string): string {
    return createHash('sha256').update(value, 'utf8').digest('hex');
  }
}
