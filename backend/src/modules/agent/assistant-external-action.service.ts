import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  AssistantActionState,
  AssistantGrantStatus,
  AssistantPolicyDecision,
  Prisma,
} from '@prisma/client';
import { PrismaService } from '../../common/prisma/prisma.service';
import { digestAgentInput } from './agent-security';
import type { AuthenticatedUser } from './agent.service';
import { AssistantPermissionService } from './assistant-permission.service';
import {
  AuthorizeWhatsappTextSendDto,
  CompleteWhatsappTextSendDto,
} from './dto/assistant-external-action.dto';

const WHATSAPP_SEND_PERMIT_TTL_MS = 30_000;

@Injectable()
export class AssistantExternalActionService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly permissions: AssistantPermissionService,
  ) {}

  async authorizeWhatsappTextSend(
    dto: AuthorizeWhatsappTextSendDto,
    user: AuthenticatedUser,
  ) {
    this.assertCompanyAdmin(user, dto.companyId);
    if (dto.confirmed !== true) {
      throw new BadRequestException('Explicit human confirmation is required');
    }
    const text = this.normalizeText(dto.text);
    const targetPhone = this.normalizePhone(dto.targetPhone);
    if (!targetPhone) throw new BadRequestException('A trusted WhatsApp phone is required');
    const textDigest = digestAgentInput({ text });
    const scope = {
      channel: 'whatsapp',
      conversationId: dto.conversationId,
      targetPhone,
      textDigest,
    };
    const scopeDigest = digestAgentInput(scope);
    const requestKey = `assistant-whatsapp-send:${dto.companyId}:${user.id}:${dto.requestId}`;
    const contextDigest = digestAgentInput({
      companyId: dto.companyId,
      operatorUserId: user.id,
      capability: 'crm.message.send',
      scope,
    });
    const payloadDigest = digestAgentInput({ textDigest });
    const profile = await this.permissions.getProfile(dto.companyId, user);
    const dailyLimit = Number(profile.thresholds?.maxDailyExternalSends || 50);
    const now = new Date();
    const permitExpiresAt = new Date(now.getTime() + WHATSAPP_SEND_PERMIT_TTL_MS);

    return this.prisma.$transaction(async (tx) => {
      const existing = await tx.assistantBusinessAction.findUnique({ where: { requestKey } });
      if (existing) {
        if (
          existing.contextDigest !== contextDigest
          || existing.payloadDigest !== payloadDigest
          || existing.targetId !== dto.conversationId
        ) {
          throw new ConflictException('External-send request id was reused in another context');
        }
        if (existing.state !== AssistantActionState.CLAIMED) {
          throw new ConflictException(`External-send request is terminal: ${existing.state}`);
        }
        const snapshot = this.readObject(existing.policySnapshot);
        const existingExpiry = new Date(String(snapshot.permitExpiresAt || '')).getTime();
        if (!Number.isFinite(existingExpiry) || existingExpiry <= now.getTime()) {
          throw new ConflictException('External-send permit expired; create a new confirmation');
        }
        return this.permitResponse(existing.id, dto, targetPhone, textDigest, new Date(existingExpiry));
      }

      const conversation = await tx.conversation.findFirst({
        where: {
          id: dto.conversationId,
          companyId: dto.companyId,
          channel: 'whatsapp',
          isGroup: { not: true },
        },
        select: {
          id: true,
          externalThreadId: true,
          contactPoint: { select: { normalizedValue: true } },
        },
      });
      if (!conversation) {
        throw new NotFoundException('Verified direct WhatsApp conversation not found');
      }
      const trustedPhones = [
        conversation.contactPoint?.normalizedValue,
        conversation.externalThreadId,
      ].map((value) => this.normalizePhone(value || '')).filter(Boolean);
      if (!trustedPhones.includes(targetPhone)) {
        throw new ForbiddenException('WhatsApp target does not match the CRM conversation identity');
      }

      const dayStart = new Date(now);
      dayStart.setHours(0, 0, 0, 0);
      const usedToday = await tx.assistantBusinessAction.count({
        where: {
          companyId: dto.companyId,
          operatorUserId: user.id,
          capability: 'crm.message.send',
          state: { in: [
            AssistantActionState.CLAIMED,
            AssistantActionState.EXECUTING,
            AssistantActionState.SUCCEEDED,
            AssistantActionState.UNKNOWN,
          ] },
          createdAt: { gte: dayStart },
        },
      });
      if (usedToday >= dailyLimit) {
        throw new ForbiddenException('Daily assistant external-send limit reached');
      }

      const grant = await tx.assistantTemporaryGrant.create({
        data: {
          companyId: dto.companyId,
          operatorUserId: user.id,
          createdByUserId: user.id,
          capability: 'crm.message.send',
          scopeDigest,
          scope: scope as Prisma.InputJsonValue,
          status: AssistantGrantStatus.CONSUMED,
          expiresAt: permitExpiresAt,
          maxUses: 1,
          useCount: 1,
          consumedAt: now,
        },
      });
      const action = await tx.assistantBusinessAction.create({
        data: {
          requestKey,
          idempotencyKey: digestAgentInput({ requestKey, contextDigest, payloadDigest }),
          companyId: dto.companyId,
          operatorUserId: user.id,
          capability: 'crm.message.send',
          state: AssistantActionState.CLAIMED,
          decision: AssistantPolicyDecision.ALLOW,
          contextDigest,
          payloadDigest,
          targetType: 'conversation',
          targetId: dto.conversationId,
          approvalId: grant.id,
          startedAt: now,
          policySnapshot: {
            preset: profile.preset,
            approval: 'EXPLICIT_ADMIN_ONE_TIME_GRANT',
            grantId: grant.id,
            permitExpiresAt: permitExpiresAt.toISOString(),
            targetPhone,
            textDigest,
          } as Prisma.InputJsonValue,
        },
      });
      return this.permitResponse(action.id, dto, targetPhone, textDigest, permitExpiresAt);
    });
  }

  async completeWhatsappTextSend(
    id: string,
    dto: CompleteWhatsappTextSendDto,
    user: AuthenticatedUser,
  ) {
    const action = await this.prisma.assistantBusinessAction.findUnique({ where: { id } });
    if (!action || action.capability !== 'crm.message.send') {
      throw new NotFoundException('External-send action not found');
    }
    this.assertCompanyMembership(user, action.companyId);
    if (action.operatorUserId !== user.id) {
      throw new ForbiddenException('Only the operator who claimed this send may complete it');
    }
    const terminalState = dto.outcome === 'SUCCEEDED'
      ? AssistantActionState.SUCCEEDED
      : dto.outcome === 'FAILED'
        ? AssistantActionState.FAILED
        : AssistantActionState.UNKNOWN;
    if (action.state !== AssistantActionState.CLAIMED) {
      if (action.state === terminalState) return action;
      throw new ConflictException(`External-send action is terminal: ${action.state}`);
    }
    const result = await this.prisma.assistantBusinessAction.updateMany({
      where: { id, state: AssistantActionState.CLAIMED, operatorUserId: user.id },
      data: {
        state: terminalState,
        result: { outcome: dto.outcome } as Prisma.InputJsonValue,
        receipt: {
          source: 'electron-whatsapp-preload',
          code: dto.code,
          recordedAt: new Date().toISOString(),
        } as Prisma.InputJsonValue,
        ...(dto.outcome === 'FAILED' ? { errorCode: dto.code } : {}),
        completedAt: new Date(),
      },
    });
    if (result.count !== 1) throw new ConflictException('External-send action completed concurrently');
    return this.prisma.assistantBusinessAction.findUniqueOrThrow({ where: { id } });
  }

  private permitResponse(
    actionId: string,
    dto: AuthorizeWhatsappTextSendDto,
    targetPhone: string,
    textDigest: string,
    expiresAt: Date,
  ) {
    return {
      status: 'CLAIMED',
      actionId,
      requestId: dto.requestId,
      conversationId: dto.conversationId,
      targetPhone,
      textDigest,
      expiresAt: expiresAt.toISOString(),
    };
  }

  private normalizeText(value: string) {
    const text = value.trim();
    if (!text || text.length > 4_000 || /[\u0000\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(text)) {
      throw new BadRequestException('WhatsApp text is empty, too long, or contains control characters');
    }
    return text;
  }

  private normalizePhone(value: string) {
    const digits = value.replace(/\D/g, '');
    return /^\d{7,15}$/.test(digits) ? digits : '';
  }

  private readObject(value: Prisma.JsonValue | null | undefined) {
    return value && typeof value === 'object' && !Array.isArray(value)
      ? value as Record<string, Prisma.JsonValue>
      : {};
  }

  private assertCompanyMembership(user: AuthenticatedUser, companyId: string) {
    if (!user.companies?.some((company) => company.id === companyId)) {
      throw new ForbiddenException('No access to this company');
    }
  }

  private assertCompanyAdmin(user: AuthenticatedUser, companyId: string) {
    this.assertCompanyMembership(user, companyId);
    if (!user.companies?.some(
      (company) => company.id === companyId && ['company_admin', 'super_admin'].includes(company.role),
    )) {
      throw new ForbiddenException('Company administrator confirmation is required');
    }
  }
}
