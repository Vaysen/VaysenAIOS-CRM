/**
 * TASK-102C: 多租户统一身份解析引擎
 *
 * 状态机:
 * 1. 外部身份精确匹配 -> linked
 * 2. 精确 ContactPoint 匹配 (companyId + type + normalizedValue) -> linked
 * 3. 无精确匹配 + 尾号匹配 -> review_required
 * 4. 无精确匹配 + 无尾号匹配 -> created
 * 5. 只有 LID/JID、无可信号码 -> unresolved
 * 6. P2002 唯一约束冲突 -> 原事务回滚后在新事务重读 -> linked
 *
 * 事务边界: 正常解析使用单事务；唯一冲突恢复使用新的独立事务
 * 租户隔离: 所有查询均携带 companyId
 * 手工保护: linked 不修改 Lead/Contact 字段 (外部来源不得覆盖 manual_confirmed)
 */
import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../common/prisma/prisma.service';
import {
  ResolveIdentityCommand,
  ResolveIdentityResult,
} from './customer-identity.types';
import { scoreIdentityMatch } from './domain/match-score';
import { sanitizeContactNameCandidate } from './domain/sanitize-display-text';

/** 电话号码尾号长度 (用于 review 候选, 非自动合并) */
const PHONE_SUFFIX_LENGTH = 10;

type ContactPointWithRelations = Prisma.ContactPointGetPayload<{
  include: { lead: true; contact: true };
}>;

type ResolvedIdentityCommand = Omit<
  ResolveIdentityCommand,
  'normalizedValue'
> & {
  normalizedValue: string;
};

/**
 * 将渠道映射为 ContactPoint.type
 */
function mapChannelToType(
  channel: ResolveIdentityCommand['channel'],
): 'email' | 'whatsapp' | 'phone' {
  if (channel === 'email') return 'email';
  if (channel === 'whatsapp') return 'whatsapp';
  return 'phone';
}

/**
 * 提取电话号码尾号 (最后 10 位数字)
 * 用于尾号相似度比较, 但不用于自动合并
 */
function extractPhoneSuffix(value: string): string {
  const digits = value.replace(/\D/g, '');
  return digits.slice(-PHONE_SUFFIX_LENGTH);
}

/**
 * 判断是否为 Prisma 唯一约束冲突错误 (P2002)
 * 使用 duck-typing, 避免 any
 */
function isPrismaUniqueConstraintError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code: string }).code === 'P2002'
  );
}

@Injectable()
export class IdentityResolutionService {
  private readonly logger = new Logger(IdentityResolutionService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * 解析身份: 根据渠道和归一化值, 在事务中查找或创建客户记录
   *
   * @param command 解析命令 (companyId, channel, normalizedValue, ...)
   * @returns 解析结果 (linked / created / review_required)
   */
  async resolve(
    command: ResolveIdentityCommand,
  ): Promise<ResolveIdentityResult> {
    const normalizedValue = command.normalizedValue?.trim();
    if (!normalizedValue) {
      return this.persistUnresolvedExternalIdentity(command);
    }

    const resolvedCommand: ResolvedIdentityCommand = {
      ...command,
      normalizedValue,
    };
    const type = mapChannelToType(command.channel);

    try {
      return await this.prisma.$transaction((tx) =>
        this.resolveInTransaction(tx, resolvedCommand, type),
      );
    } catch (error: unknown) {
      if (!isPrismaUniqueConstraintError(error)) {
        throw error;
      }

      this.logger.warn(
        `P2002 while resolving identity; retrying in a fresh transaction: companyId=${resolvedCommand.companyId}, type=${type}`,
      );

      return this.prisma.$transaction(async (tx) => {
        const racePoint = await tx.contactPoint.findFirst({
          where: {
            companyId: resolvedCommand.companyId,
            type,
            normalizedValue: resolvedCommand.normalizedValue,
          },
          include: { lead: true, contact: true },
        });
        if (!racePoint) {
          throw error;
        }

        const linked = await this.ensureContactPointLinks(
          tx,
          resolvedCommand,
          racePoint,
        );
        await this.linkExternalIdentity(
          tx,
          resolvedCommand,
          linked.leadId,
          linked.contactId,
          racePoint.id,
        );
        return {
          action: 'linked',
          leadId: linked.leadId,
          contactId: linked.contactId,
          contactPointId: racePoint.id,
        };
      });
    }
  }

  private async resolveInTransaction(
    tx: Prisma.TransactionClient,
    command: ResolvedIdentityCommand,
    type: 'email' | 'whatsapp' | 'phone',
  ): Promise<ResolveIdentityResult> {
    const isPhoneChannel =
      command.channel === 'whatsapp' || command.channel === 'phone';

    if (command.externalIdentity) {
      const external = await tx.externalIdentity.findUnique({
        where: {
          companyId_provider_externalId: {
            companyId: command.companyId,
            provider: command.externalIdentity.provider,
            externalId: command.externalIdentity.externalId,
          },
        },
      });
      if (external?.leadId && external.contactId && external.contactPointId) {
        await this.linkExternalIdentity(
          tx,
          command,
          external.leadId,
          external.contactId,
          external.contactPointId,
        );
        return {
          action: 'linked',
          leadId: external.leadId,
          contactId: external.contactId,
          contactPointId: external.contactPointId,
        };
      }
    }

    // ---- Step 1: 精确匹配查询 (必须携带 companyId — 租户隔离) ----
    const existing = await tx.contactPoint.findFirst({
      where: {
        companyId: command.companyId,
        type,
        normalizedValue: command.normalizedValue,
      },
      include: { lead: true, contact: true },
    });

    if (existing) {
      const linked = await this.ensureContactPointLinks(tx, command, existing);

      // 更新 ExternalIdentity (如果有) — 关联到已有 lead/contact
      await this.linkExternalIdentity(
        tx,
        command,
        linked.leadId,
        linked.contactId,
        existing.id,
      );

      // 手工字段保护: linked 不修改 Lead/Contact (外部来源不得覆盖 manual_confirmed)
      return {
        action: 'linked' as const,
        leadId: linked.leadId,
        contactId: linked.contactId,
        contactPointId: existing.id,
      };
    }

    // ---- Step 2: 无精确匹配 — 对于电话渠道, 检查尾号候选 ----
    // 禁止使用 contains/endsWith 自动合并; 仅用 findMany + in-code 比较
    if (isPhoneChannel) {
      const candidates = await tx.contactPoint.findMany({
        where: {
          companyId: command.companyId,
          type,
        },
      });

      const newSuffix = extractPhoneSuffix(command.normalizedValue);
      const suffixMatch = candidates.find(
        (c) =>
          c.normalizedValue !== command.normalizedValue &&
          extractPhoneSuffix(c.normalizedValue) === newSuffix,
      );

      if (suffixMatch && suffixMatch.leadId) {
        // 尾号匹配 -> 创建新记录 + IdentityMatchCandidate (不自动合并)
        return this.createWithReviewCandidate(
          tx,
          command,
          type,
          suffixMatch.leadId,
        );
      }
    }

    // ---- Step 3: 无精确匹配, 无尾号匹配 -> 创建新客户 ----
    return this.createNewCustomer(tx, command, type);
  }

  private async persistUnresolvedExternalIdentity(
    command: ResolveIdentityCommand,
  ): Promise<ResolveIdentityResult> {
    if (!command.externalIdentity) {
      throw new Error(
        'normalizedValue or externalIdentity is required to resolve identity',
      );
    }

    const existing = await this.prisma.externalIdentity.findUnique({
      where: {
        companyId_provider_externalId: {
          companyId: command.companyId,
          provider: command.externalIdentity.provider,
          externalId: command.externalIdentity.externalId,
        },
      },
    });
    if (existing?.leadId && existing.contactId && existing.contactPointId) {
      return {
        action: 'linked',
        leadId: existing.leadId,
        contactId: existing.contactId,
        contactPointId: existing.contactPointId,
      };
    }

    const external = await this.prisma.externalIdentity.upsert({
      where: {
        companyId_provider_externalId: {
          companyId: command.companyId,
          provider: command.externalIdentity.provider,
          externalId: command.externalIdentity.externalId,
        },
      },
      create: {
        companyId: command.companyId,
        provider: command.externalIdentity.provider,
        externalId: command.externalIdentity.externalId,
        rawDisplayName: command.externalIdentity.rawDisplayName,
        identityStatus: 'unresolved',
      },
      update: {
        rawDisplayName: command.externalIdentity.rawDisplayName,
        identityStatus: 'unresolved',
      },
    });

    return {
      action: 'unresolved',
      externalIdentityId: external.id,
      reason: 'missing_normalized_identity',
    };
  }

  private buildLeadCreateData(
    command: ResolvedIdentityCommand,
  ): Prisma.LeadUncheckedCreateInput {
    return {
      companyId: command.companyId,
      companyName: null,
      ...(command.countryIso2 ? { country: command.countryIso2 } : {}),
    };
  }

  private buildContactCreateData(
    command: ResolvedIdentityCommand,
    leadId: string,
  ): Prisma.ContactUncheckedCreateInput {
    const displayName = command.contactNameCandidate
      ? sanitizeContactNameCandidate(command.contactNameCandidate)
      : null;
    return {
      companyId: command.companyId,
      leadId,
      firstName: null,
      lastName: null,
      ...(displayName
        ? {
            displayName,
            nameSource: command.source,
            nameConfidence: 'low',
          }
        : {}),
    };
  }

  private async ensureContactPointLinks(
    tx: Prisma.TransactionClient,
    command: ResolvedIdentityCommand,
    point: ContactPointWithRelations,
  ): Promise<{ leadId: string; contactId: string }> {
    let leadId = point.leadId ?? point.contact?.leadId ?? null;
    let contactId = point.contactId;

    if (!leadId) {
      const lead = await tx.lead.create({
        data: this.buildLeadCreateData(command),
      });
      leadId = lead.id;
    }

    if (!contactId) {
      const contact = await tx.contact.create({
        data: this.buildContactCreateData(command, leadId),
      });
      contactId = contact.id;
    } else if (point.contact && point.contact.leadId !== leadId) {
      await tx.contact.update({
        where: { id: contactId },
        data: { leadId },
      });
    }

    if (point.leadId !== leadId || point.contactId !== contactId) {
      await tx.contactPoint.update({
        where: { id: point.id },
        data: { leadId, contactId },
      });
    }

    return { leadId, contactId };
  }

  /**
   * 创建新客户 + IdentityMatchCandidate (review_required 路径)
   * 先检查排除记录, 如果有排除则不创建候选 (返回 created)
   */
  private async createWithReviewCandidate(
    tx: Prisma.TransactionClient,
    command: ResolvedIdentityCommand,
    type: 'email' | 'whatsapp' | 'phone',
    targetLeadId: string,
  ): Promise<ResolveIdentityResult> {
    // 创建新 Lead (companyName=null) + Contact (firstName=null) + ContactPoint
    const newLead = await tx.lead.create({
      data: this.buildLeadCreateData(command),
    });
    const newContact = await tx.contact.create({
      data: this.buildContactCreateData(command, newLead.id),
    });
    const newPoint = await tx.contactPoint.create({
      data: {
        companyId: command.companyId,
        type,
        originalValue: command.normalizedValue,
        normalizedValue: command.normalizedValue,
        leadId: newLead.id,
        contactId: newContact.id,
      },
    });

    // 检查排除记录 — 如果已有排除, 不创建候选
    const exclusion = await tx.identityExclusion.findFirst({
      where: {
        companyId: command.companyId,
        OR: [
          { leftLeadId: newLead.id, rightLeadId: targetLeadId },
          { leftLeadId: targetLeadId, rightLeadId: newLead.id },
        ],
      },
    });

    if (!exclusion) {
      // 创建 IdentityMatchCandidate (score=30, phoneSuffixOnly)
      const score = scoreIdentityMatch({
        phoneSuffixOnly: true,
        sameTenant: true,
        excluded: false,
      });
      const candidate = await tx.identityMatchCandidate.upsert({
        where: {
          companyId_sourceLeadId_targetLeadId: {
            companyId: command.companyId,
            sourceLeadId: newLead.id,
            targetLeadId,
          },
        },
        create: {
          companyId: command.companyId,
          sourceLeadId: newLead.id,
          targetLeadId,
          score,
          reasons: { phoneSuffixOnly: true, suffixLength: PHONE_SUFFIX_LENGTH },
        },
        update: {
          score,
          reasons: { phoneSuffixOnly: true, suffixLength: PHONE_SUFFIX_LENGTH },
        },
      });

      await this.linkExternalIdentity(
        tx,
        command,
        newLead.id,
        newContact.id,
        newPoint.id,
      );

      return {
        action: 'review_required' as const,
        candidateId: candidate.id,
        leadId: newLead.id,
      };
    }

    // 有排除记录 -> 创建了新客户但不建议合并
    await this.linkExternalIdentity(
      tx,
      command,
      newLead.id,
      newContact.id,
      newPoint.id,
    );
    return {
      action: 'created' as const,
      leadId: newLead.id,
      contactId: newContact.id,
      contactPointId: newPoint.id,
    };
  }

  /**
   * 创建新客户 (created 路径)
   * 处理 P2002 竞态: 重新读取已存在的 ContactPoint -> linked
   */
  private async createNewCustomer(
    tx: Prisma.TransactionClient,
    command: ResolvedIdentityCommand,
    type: 'email' | 'whatsapp' | 'phone',
  ): Promise<ResolveIdentityResult> {
    const lead = await tx.lead.create({
      data: this.buildLeadCreateData(command),
    });
    const contact = await tx.contact.create({
      data: this.buildContactCreateData(command, lead.id),
    });

    const contactPoint = await tx.contactPoint.create({
      data: {
        companyId: command.companyId,
        type,
        originalValue: command.normalizedValue,
        normalizedValue: command.normalizedValue,
        leadId: lead.id,
        contactId: contact.id,
      },
    });

    await this.linkExternalIdentity(
      tx,
      command,
      lead.id,
      contact.id,
      contactPoint.id,
    );

    return {
      action: 'created' as const,
      leadId: lead.id,
      contactId: contact.id,
      contactPointId: contactPoint.id,
    };
  }

  /**
   * 将外部身份 (如 WhatsApp WA_ID) 关联到指定的 lead/contact/contactPoint
   * 使用 upsert 避免唯一约束冲突
   */
  private async linkExternalIdentity(
    tx: Prisma.TransactionClient,
    command: ResolvedIdentityCommand,
    leadId: string,
    contactId: string,
    contactPointId: string,
  ): Promise<void> {
    if (!command.externalIdentity) return;
    await tx.externalIdentity.upsert({
      where: {
        companyId_provider_externalId: {
          companyId: command.companyId,
          provider: command.externalIdentity.provider,
          externalId: command.externalIdentity.externalId,
        },
      },
      create: {
        companyId: command.companyId,
        provider: command.externalIdentity.provider,
        externalId: command.externalIdentity.externalId,
        rawDisplayName: command.externalIdentity.rawDisplayName,
        identityStatus: 'resolved',
        leadId,
        contactId,
        contactPointId,
      },
      update: {
        identityStatus: 'resolved',
        rawDisplayName: command.externalIdentity.rawDisplayName,
        leadId,
        contactId,
        contactPointId,
      },
    });
  }
}
