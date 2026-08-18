/**
 * TASK-102F: 可逆差异化客户合并服务
 *
 * 设计要点:
 * - 两种合并模式: trusted_defaults (按字段优先级自动选胜) 与 field_choices (人工逐字段选择)。
 * - 字段优先级: manual_confirmed(5) > verified_import(4) > exact_channel(3) > inferred(2) > untrusted_display(1) > null(0)。
 * - 关系迁移: Contact / ContactPoint / Conversation / LeadActivity / EmailMessage / Quote / Order / FollowUpReminder
 *   全部仅迁移 leadId (updateMany), 严禁删除。不同号码/邮箱的 ContactPoint 都保留。
 *   ContactPoint 的 @@unique([companyId, type, normalizedValue]) 保证两 Lead 不会持有同一规范化值,
 *   因此 leadId 迁移不会产生唯一冲突, 也不会静默删除任何渠道。
 * - 单一事务: 快照 -> 迁移 -> 合并字段 -> 主联系人去重 -> 软删除 source -> 审计 -> 候选置 merged,
 *   任一步失败整体回滚, 不留半合并状态。
 * - 软删除: source Lead 置 status='merged' / isMerged=true / mergedToId=target / deletedAt=now,
 *   旧 ID 经 mergedToId 别名解析到 target。绝不硬删除。
 * - 审计: beforeState / afterState / fieldChoices / actorId / targetVersion 持久化到 CustomerMergeAudit。
 * - 排除: rejectCandidate 保存双向 IdentityExclusion (left/right 互换), 引擎对同一对不再重复提示。
 * - 撤销: undoMerge 在目标未变化 (target.updatedAt === audit.targetVersion) 时恢复; 目标已变化则拒绝 (不安全)。
 *
 * 撤销范围说明 (失败补偿):
 *   undoMerge 还原 target 字段、source Lead 状态, 并将合并时迁移的 Contact / ContactPoint / Conversation
 *   按 beforeState 记录的 ID 迁回 source。合并期间迁移的 LeadActivity / EmailMessage / Quote / Order /
 *   FollowUpReminder 未在 beforeState 中记录 ID, 撤销后仍保留在 target (设计取舍); 如需回拨可据
 *   CustomerMergeAudit 的 beforeState 与时间窗手工 re-associate。
 */
import { Injectable, NotFoundException, ConflictException, BadRequestException, ForbiddenException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../common/prisma/prisma.service';
import { requireActiveCompany } from '../../common/utils/data-isolation';
import type { CurrentUser } from '../../common/utils/data-isolation';
import type {
  MergeCustomerCommand,
  MergePreview,
  MergeFieldChoice,
  MergeableField,
  UndoMergeCommand,
} from './dto/merge-customer.dto';
import type { RejectCandidateCommand } from './dto/reject-candidate.dto';

// ---------------------------------------------------------------------------
// 字段优先级
// ---------------------------------------------------------------------------

type Provenance =
  | 'manual_confirmed'
  | 'verified_import'
  | 'exact_channel'
  | 'inferred'
  | 'untrusted_display'
  | null;

const FIELD_PRIORITY: Record<Exclude<Provenance, null>, number> = {
  manual_confirmed: 5,
  verified_import: 4,
  exact_channel: 3,
  inferred: 2,
  untrusted_display: 1,
};

const KNOWN_PROVENANCES: readonly string[] = [
  'manual_confirmed',
  'verified_import',
  'exact_channel',
  'inferred',
  'untrusted_display',
];

const MERGE_FIELDS: readonly MergeableField[] = [
  'companyName',
  'country',
  'website',
  'industry',
];

function priorityOf(provenance: Provenance): number {
  return provenance ? (FIELD_PRIORITY[provenance] ?? 0) : 0;
}

function normalizeProvenance(raw: string | null): Provenance {
  if (!raw) return null;
  return KNOWN_PROVENANCES.includes(raw) ? (raw as Exclude<Provenance, null>) : null;
}

/** 参与 (差异比较/合并) 的 Lead 字段视图。 */
interface MergeLeadView {
  companyName: string | null;
  companyNameSource: string | null;
  companyNameConfidence: string | null;
  country: string | null;
  website: string | null;
  industry: string | null;
}

function readField(lead: MergeLeadView, field: MergeableField): string | null {
  switch (field) {
    case 'companyName':
      return lead.companyName;
    case 'country':
      return lead.country;
    case 'website':
      return lead.website;
    case 'industry':
      return lead.industry;
  }
}

function getFieldProvenance(lead: MergeLeadView, field: MergeableField): Provenance {
  if (field === 'companyName') return normalizeProvenance(lead.companyNameSource);
  // country/website/industry 无独立来源字段: 有值视为 exact_channel, 无值视为 null
  return readField(lead, field) !== null ? 'exact_channel' : null;
}

function suggestWinner(
  source: MergeLeadView,
  target: MergeLeadView,
  field: MergeableField,
): { winner: 'source' | 'target'; reason: string } {
  const sp = priorityOf(getFieldProvenance(source, field));
  const tp = priorityOf(getFieldProvenance(target, field));
  if (sp > tp) return { winner: 'source', reason: `source provenance priority ${sp} > ${tp}` };
  if (tp > sp) return { winner: 'target', reason: `target provenance priority ${tp} > ${sp}` };
  return { winner: 'target', reason: 'equal provenance, keep target' };
}

interface MergedFields {
  companyName: string | null;
  country: string | null;
  website: string | null;
  industry: string | null;
  companyNameFromSource: boolean;
}

function computeMergedFields(
  source: MergeLeadView,
  target: MergeLeadView,
  mode: MergeCustomerCommand['mode'],
  fieldChoices: MergeFieldChoice[],
): MergedFields {
  const result: MergedFields = {
    companyName: target.companyName,
    country: target.country,
    website: target.website,
    industry: target.industry,
    companyNameFromSource: false,
  };
  for (const field of MERGE_FIELDS) {
    let winner: 'source' | 'target';
    if (mode === 'field_choices') {
      const choice = fieldChoices.find((c) => c.field === field);
      winner = choice ? choice.winner : 'target';
    } else {
      const sp = priorityOf(getFieldProvenance(source, field));
      const tp = priorityOf(getFieldProvenance(target, field));
      winner = sp > tp ? 'source' : 'target';
    }
    result[field] = winner === 'source' ? readField(source, field) : readField(target, field);
    if (field === 'companyName') result.companyNameFromSource = winner === 'source';
  }
  return result;
}

// ---------------------------------------------------------------------------
// 审计快照类型
// ---------------------------------------------------------------------------

interface SourceLeadSnapshot extends MergeLeadView {
  id: string;
  status: string;
  isMerged: boolean;
  mergedToId: string | null;
  deletedAt: Date | null;
}

interface TargetLeadSnapshot extends MergeLeadView {
  id: string;
}

interface MergeBeforeState {
  sourceLead: SourceLeadSnapshot;
  targetLead: TargetLeadSnapshot;
  sourceContactIds: string[];
  targetContactIds: string[];
  sourceContactPointIds: string[];
  sourceConversationIds: string[];
  /** Optional for backwards compatibility with audits written before full rollback support. */
  sourceActivityIds?: string[];
  sourceEmailMessageIds?: string[];
  sourceQuoteIds?: string[];
  sourceOrderIds?: string[];
  sourceReminderIds?: string[];
  contactPrimaryMap: Record<string, boolean>;
}

interface MergeAfterState {
  targetLead: {
    id: string;
    companyName: string | null;
    country: string | null;
    website: string | null;
    industry: string | null;
    companyNameSource: string | null;
  };
  sourceLead: {
    id: string;
    status: string;
    isMerged: boolean;
    mergedToId: string | null;
    deletedAt: string | null;
  };
}

interface MinimalLead extends MergeLeadView {
  id: string;
  status: string;
  isMerged: boolean;
  mergedToId: string | null;
  deletedAt: Date | null;
  updatedAt: Date;
}

function toSourceSnapshot(lead: MinimalLead): SourceLeadSnapshot {
  return {
    id: lead.id,
    companyName: lead.companyName,
    companyNameSource: lead.companyNameSource,
    companyNameConfidence: lead.companyNameConfidence,
    country: lead.country,
    website: lead.website,
    industry: lead.industry,
    status: lead.status,
    isMerged: lead.isMerged,
    mergedToId: lead.mergedToId,
    deletedAt: lead.deletedAt,
  };
}

function toTargetSnapshot(lead: MinimalLead): TargetLeadSnapshot {
  return {
    id: lead.id,
    companyName: lead.companyName,
    companyNameSource: lead.companyNameSource,
    companyNameConfidence: lead.companyNameConfidence,
    country: lead.country,
    website: lead.website,
    industry: lead.industry,
  };
}

interface MinimalContact {
  id: string;
  leadId: string | null;
  isPrimary: boolean;
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

@Injectable()
export class CustomerMergeService {
  constructor(private readonly prisma: PrismaService) {}

  private async assertAuthorizedCandidate(
    companyId: string,
    candidateId: string,
    user: CurrentUser,
  ) {
    const activeCompany = requireActiveCompany(user);
    if (activeCompany.id !== companyId) {
      throw new ForbiddenException('No access to this company');
    }
    const membership = user?.companies?.find((company) => company.id === activeCompany.id);
    if (!user?.id || !membership) throw new ForbiddenException('No access to this company');
    const candidate = await this.prisma.identityMatchCandidate.findUnique({
      where: { id: candidateId, companyId },
      include: {
        sourceLead: true,
        targetLead: true,
      },
    });
    if (
      !candidate
      || candidate.companyId !== companyId
      || candidate.sourceLead.companyId !== companyId
      || candidate.targetLead.companyId !== companyId
    ) {
      throw new NotFoundException('identity match candidate not found');
    }
    const isAdmin = ['company_admin', 'super_admin'].includes(membership.role);
    if (
      !isAdmin
      && (candidate.sourceLead.ownerUserId !== user.id || candidate.targetLead.ownerUserId !== user.id)
    ) {
      throw new ForbiddenException('Both customers must belong to the current operator');
    }
    return candidate;
  }

  async mergeAuthorized(
    command: Omit<MergeCustomerCommand, 'actorId'>,
    user: CurrentUser,
  ): Promise<{ auditId: string; targetLeadId: string }> {
    await this.assertAuthorizedCandidate(command.companyId, command.candidateId, user);
    return this.merge({ ...command, actorId: user.id });
  }

  async previewAuthorized(companyId: string, candidateId: string, user: CurrentUser): Promise<MergePreview> {
    await this.assertAuthorizedCandidate(companyId, candidateId, user);
    return this.previewMerge({ companyId, candidateId });
  }

  async rejectAuthorized(command: RejectCandidateCommand, user: CurrentUser): Promise<void> {
    await this.assertAuthorizedCandidate(command.companyId, command.candidateId, user);
    return this.rejectCandidate({ ...command, actorId: user.id });
  }

  private async assertAuthorizedAudit(command: UndoMergeCommand, user: CurrentUser) {
    const activeCompany = requireActiveCompany(user);
    if (activeCompany.id !== command.companyId) {
      throw new ForbiddenException('No access to this company');
    }
    const membership = user?.companies?.find((company) => company.id === activeCompany.id);
    if (!user?.id || !membership) throw new ForbiddenException('No access to this company');
    const audit = await this.prisma.customerMergeAudit.findUnique({
      where: { id: command.auditId, companyId: command.companyId },
    });
    if (!audit || audit.companyId !== command.companyId) {
      throw new NotFoundException('merge audit not found');
    }
    const [sourceLead, targetLead] = await Promise.all([
      this.prisma.lead.findUnique({ where: { id: audit.sourceLeadId, companyId: command.companyId } }),
      this.prisma.lead.findUnique({ where: { id: audit.targetLeadId, companyId: command.companyId } }),
    ]);
    if (!sourceLead || !targetLead) throw new NotFoundException('merge audit leads not found');
    const isAdmin = ['company_admin', 'super_admin'].includes(membership.role);
    if (!isAdmin && (sourceLead.ownerUserId !== user.id || targetLead.ownerUserId !== user.id)) {
      throw new ForbiddenException('Both customers must belong to the current operator');
    }
    return audit;
  }

  async undoAuthorized(command: UndoMergeCommand, user: CurrentUser): Promise<void> {
    await this.assertAuthorizedAudit(command, user);
    return this.undoMerge({ ...command, actorId: user.id });
  }

  /**
   * 预览合并差异。只返回 source/target 不一致的字段, 并统计关系迁移规模。
   */
  async previewMerge(command: {
    companyId: string;
    candidateId: string;
  }): Promise<MergePreview> {
    const candidate = await this.prisma.identityMatchCandidate.findUnique({
      where: { id: command.candidateId, companyId: command.companyId },
      include: { sourceLead: true, targetLead: true },
    });
    if (!candidate || candidate.companyId !== command.companyId) {
      throw new NotFoundException('identity match candidate not found');
    }
    const source = candidate.sourceLead;
    const target = candidate.targetLead;

    const fieldDiffs: MergePreview['fieldDiffs'] = [];
    for (const field of MERGE_FIELDS) {
      const sourceValue = readField(source, field);
      const targetValue = readField(target, field);
      if (sourceValue !== targetValue) {
        const suggestion = suggestWinner(source, target, field);
        fieldDiffs.push({
          field,
          sourceValue,
          targetValue,
          suggestedWinner: suggestion.winner,
          reason: suggestion.reason,
        });
      }
    }

    const companyId = command.companyId;
    const [contactCount, contactPointCount, conversationCount] = await Promise.all([
      Promise.all([
        this.prisma.contact.count({ where: { companyId, leadId: source.id } }),
        this.prisma.contact.count({ where: { companyId, leadId: target.id } }),
      ]),
      Promise.all([
        this.prisma.contactPoint.count({ where: { companyId, leadId: source.id } }),
        this.prisma.contactPoint.count({ where: { companyId, leadId: target.id } }),
      ]),
      Promise.all([
        this.prisma.conversation.count({ where: { companyId, leadId: source.id } }),
        this.prisma.conversation.count({ where: { companyId, leadId: target.id } }),
      ]),
    ]);

    return {
      targetUpdatedAt: target.updatedAt.toISOString(),
      fieldDiffs,
      contactCount: { source: contactCount[0], target: contactCount[1] },
      contactPointCount: { source: contactPointCount[0], target: contactPointCount[1] },
      conversationCount: { source: conversationCount[0], target: conversationCount[1] },
    };
  }

  /**
   * 执行差异化合并。乐观锁检查 -> 单一事务 (快照/迁移/合并/去重/软删除/审计/候选)。
   */
  async merge(
    command: MergeCustomerCommand,
  ): Promise<{ auditId: string; targetLeadId: string }> {
    // 1. 加载候选 + source/target Lead (事务外, 用于乐观锁校验)
    const candidate = await this.prisma.identityMatchCandidate.findUnique({
      where: { id: command.candidateId, companyId: command.companyId },
      include: { sourceLead: true, targetLead: true },
    });
    if (!candidate || candidate.companyId !== command.companyId) {
      throw new NotFoundException('identity match candidate not found');
    }
    if (candidate.status !== 'pending') {
      throw new ConflictException(
        `candidate not actionable: status=${candidate.status}`,
      );
    }
    const sourceLead = candidate.sourceLead;
    const targetLead = candidate.targetLead;
    const sourceLeadId = candidate.sourceLeadId;
    const targetLeadId = candidate.targetLeadId;

    // 2. 乐观锁: 调用方提供的 targetUpdatedAt 必须与目标当前版本一致
    if (targetLead.updatedAt.toISOString() !== command.targetUpdatedAt) {
      throw new ConflictException(
        'optimistic_lock_conflict: target updatedAt mismatch',
      );
    }

    const merged = computeMergedFields(
      sourceLead,
      targetLead,
      command.mode,
      command.fieldChoices,
    );
    const companyId = command.companyId;
    const actorId = command.actorId;

    // 3. 单一事务
    return this.prisma.$transaction(async (tx) => {
      // Claim both the pending candidate and the previewed target version in
      // the same transaction. A second concurrent request observes count=0.
      const claimedCandidate = await tx.identityMatchCandidate.updateMany({
        where: { id: candidate.id, companyId, status: 'pending' },
        data: { status: 'merging' },
      });
      if (claimedCandidate.count !== 1) {
        throw new ConflictException('candidate not actionable: it was consumed concurrently');
      }
      const claimedTarget = await tx.lead.updateMany({
        where: { id: targetLeadId, companyId, updatedAt: targetLead.updatedAt },
        data: { updatedAt: new Date() },
      });
      if (claimedTarget.count !== 1) {
        throw new ConflictException('optimistic_lock_conflict: target changed during merge');
      }

      // a. 快照 (事务内读取, 保证一致性)
      const [
        sourceContacts,
        targetContacts,
        sourceContactPoints,
        sourceConversations,
        sourceActivities,
        sourceEmailMessages,
        sourceQuotes,
        sourceOrders,
        sourceReminders,
      ] =
        await Promise.all([
          tx.contact.findMany({ where: { companyId, leadId: sourceLeadId } }),
          tx.contact.findMany({ where: { companyId, leadId: targetLeadId } }),
          tx.contactPoint.findMany({ where: { companyId, leadId: sourceLeadId } }),
          tx.conversation.findMany({ where: { companyId, leadId: sourceLeadId } }),
          tx.leadActivity.findMany({ where: { companyId, leadId: sourceLeadId }, select: { id: true } }),
          tx.emailMessage.findMany({ where: { companyId, leadId: sourceLeadId }, select: { id: true } }),
          tx.quote.findMany({ where: { companyId, leadId: sourceLeadId }, select: { id: true } }),
          tx.order.findMany({ where: { companyId, leadId: sourceLeadId }, select: { id: true } }),
          tx.followUpReminder.findMany({ where: { companyId, leadId: sourceLeadId }, select: { id: true } }),
        ]);

      const contactPrimaryMap: Record<string, boolean> = {};
      for (const c of [...sourceContacts, ...targetContacts]) {
        contactPrimaryMap[c.id] = c.isPrimary;
      }

      const beforeState: MergeBeforeState = {
        sourceLead: toSourceSnapshot(sourceLead),
        targetLead: toTargetSnapshot(targetLead),
        sourceContactIds: sourceContacts.map((c) => c.id),
        targetContactIds: targetContacts.map((c) => c.id),
        sourceContactPointIds: sourceContactPoints.map((cp) => cp.id),
        sourceConversationIds: sourceConversations.map((cv) => cv.id),
        sourceActivityIds: sourceActivities.map((item) => item.id),
        sourceEmailMessageIds: sourceEmailMessages.map((item) => item.id),
        sourceQuoteIds: sourceQuotes.map((item) => item.id),
        sourceOrderIds: sourceOrders.map((item) => item.id),
        sourceReminderIds: sourceReminders.map((item) => item.id),
        contactPrimaryMap,
      };

      // b. 迁移关系: 仅改 leadId, 不删除
      await tx.contact.updateMany({
        where: { companyId, leadId: sourceLeadId },
        data: { leadId: targetLeadId },
      });
      await tx.contactPoint.updateMany({
        where: { companyId, leadId: sourceLeadId },
        data: { leadId: targetLeadId },
      });
      await tx.conversation.updateMany({
        where: { companyId, leadId: sourceLeadId },
        data: { leadId: targetLeadId },
      });
      await tx.leadActivity.updateMany({
        where: { companyId, leadId: sourceLeadId },
        data: { leadId: targetLeadId },
      });
      await tx.emailMessage.updateMany({
        where: { companyId, leadId: sourceLeadId },
        data: { leadId: targetLeadId },
      });
      await tx.quote.updateMany({
        where: { companyId, leadId: sourceLeadId },
        data: { leadId: targetLeadId },
      });
      await tx.order.updateMany({
        where: { companyId, leadId: sourceLeadId },
        data: { leadId: targetLeadId },
      });
      await tx.followUpReminder.updateMany({
        where: { companyId, leadId: sourceLeadId },
        data: { leadId: targetLeadId },
      });

      // c. 合并字段到 target (trusted_defaults / field_choices)
      const targetUpdateData: Prisma.LeadUncheckedUpdateInput = {
        companyName: merged.companyName,
        country: merged.country,
        website: merged.website,
        industry: merged.industry,
      };
      if (merged.companyNameFromSource) {
        targetUpdateData.companyNameSource = sourceLead.companyNameSource;
        targetUpdateData.companyNameConfidence = sourceLead.companyNameConfidence;
      }
      const updatedTarget = await tx.lead.update({
        where: { id: targetLeadId, companyId },
        data: targetUpdateData,
      });

      // d. 主联系人去重: 合并后 target 最多一个 isPrimary=true
      const allContacts: MinimalContact[] = [
        ...targetContacts,
        ...sourceContacts,
      ];
      const primaries = allContacts.filter((c) => c.isPrimary);
      if (primaries.length > 1) {
        const targetPrimary = targetContacts.find((c) => c.isPrimary);
        const keepId = targetPrimary ? targetPrimary.id : primaries[0].id;
        const demoteIds = primaries.filter((c) => c.id !== keepId).map((c) => c.id);
        if (demoteIds.length > 0) {
          await tx.contact.updateMany({
            where: { companyId, id: { in: demoteIds } },
            data: { isPrimary: false },
          });
        }
      }

      // e. 软删除 source (绝不硬删除); 旧 ID 经 mergedToId 解析到 target
      const now = new Date();
      await tx.lead.update({
        where: { id: sourceLeadId, companyId },
        data: {
          status: 'merged',
          isMerged: true,
          mergedToId: targetLeadId,
          deletedAt: now,
        },
      });

      // f. 审计
      const afterState: MergeAfterState = {
        targetLead: {
          id: targetLeadId,
          companyName: merged.companyName,
          country: merged.country,
          website: merged.website,
          industry: merged.industry,
          companyNameSource: merged.companyNameFromSource
            ? sourceLead.companyNameSource
            : targetLead.companyNameSource,
        },
        sourceLead: {
          id: sourceLeadId,
          status: 'merged',
          isMerged: true,
          mergedToId: targetLeadId,
          deletedAt: now.toISOString(),
        },
      };
      const audit = await tx.customerMergeAudit.create({
        data: {
          companyId,
          sourceLeadId,
          targetLeadId,
          actorId,
          beforeState: beforeState as unknown as Prisma.InputJsonValue,
          afterState: afterState as unknown as Prisma.InputJsonValue,
          fieldChoices: command.fieldChoices as unknown as Prisma.InputJsonValue,
          status: 'completed',
          targetVersion: updatedTarget.updatedAt,
        },
      });

      // g. 候选置 merged
      await tx.identityMatchCandidate.update({
        where: { id: candidate.id, companyId, status: 'merging' },
        data: { status: 'merged' },
      });

      return { auditId: audit.id, targetLeadId };
    });
  }

  /**
   * 拒绝匹配候选: 保存双向 IdentityExclusion (对称), 候选标记 rejected。
   * 引擎对同一对 (任一方向) 不再重复提示。
   */
  async rejectCandidate(command: RejectCandidateCommand): Promise<void> {
    const candidate = await this.prisma.identityMatchCandidate.findUnique({
      where: { id: command.candidateId, companyId: command.companyId },
    });
    if (!candidate || candidate.companyId !== command.companyId) {
      throw new NotFoundException('identity match candidate not found');
    }
    if (candidate.status !== 'pending') {
      throw new ConflictException(
        `candidate not actionable: status=${candidate.status}`,
      );
    }
    const sourceLeadId = candidate.sourceLeadId;
    const targetLeadId = candidate.targetLeadId;
    const { companyId, actorId, reason } = command;

    await this.prisma.$transaction(async (tx) => {
      // 幂等: 若已存在任一方向的排除则跳过创建
      const existing = await tx.identityExclusion.findFirst({
        where: {
          companyId,
          OR: [
            { leftLeadId: sourceLeadId, rightLeadId: targetLeadId },
            { leftLeadId: targetLeadId, rightLeadId: sourceLeadId },
          ],
        },
      });
      if (!existing) {
        await tx.identityExclusion.create({
          data: {
            companyId,
            leftLeadId: sourceLeadId,
            rightLeadId: targetLeadId,
            reason: reason ?? null,
            createdById: actorId,
          },
        });
        await tx.identityExclusion.create({
          data: {
            companyId,
            leftLeadId: targetLeadId,
            rightLeadId: sourceLeadId,
            reason: reason ?? null,
            createdById: actorId,
          },
        });
      }
      await tx.identityMatchCandidate.update({
        where: { id: candidate.id, companyId },
        data: { status: 'rejected' },
      });
    });
  }

  /**
   * 撤销合并。目标未变化 (target.updatedAt === audit.targetVersion) 时恢复:
   * 还原 target 字段、source Lead 状态, 将合并时迁移的 Contact/ContactPoint/Conversation 迁回 source。
   * 目标已变化则拒绝 (不安全撤销)。
   */
  async undoMerge(command: UndoMergeCommand): Promise<void> {
    const audit = await this.prisma.customerMergeAudit.findUnique({
      where: { id: command.auditId, companyId: command.companyId },
    });
    if (!audit || audit.companyId !== command.companyId) {
      throw new NotFoundException('merge audit not found');
    }
    await this.prisma.$transaction(async (tx) => {
      // Claim the audit state before reading/restoring anything. The status,
      // tenant and merge version are one conditional write, so two undo
      // requests cannot both enter the restore path.
      const claimedAudit = await tx.customerMergeAudit.updateMany({
        where: {
          id: audit.id,
          companyId: command.companyId,
          status: 'completed',
          undoneAt: null,
          targetVersion: audit.targetVersion,
        },
        data: { status: 'undoing' },
      });
      if (claimedAudit.count !== 1) {
        throw new ConflictException('undo_conflict: merge already claimed or undone');
      }

      const targetLead = await tx.lead.findUnique({
        where: { id: audit.targetLeadId, companyId: command.companyId },
      });
      if (!targetLead) {
        throw new NotFoundException('target lead not found');
      }
      if (targetLead.updatedAt.getTime() > audit.targetVersion.getTime()) {
        throw new ConflictException('unsafe_undo: target changed since merge');
      }
      const claimedTarget = await tx.lead.updateMany({
        where: {
          id: audit.targetLeadId,
          companyId: command.companyId,
          updatedAt: audit.targetVersion,
        },
        data: { updatedAt: new Date() },
      });
      if (claimedTarget.count !== 1) {
        throw new ConflictException('unsafe_undo: target changed since merge');
      }

      const before = audit.beforeState as unknown as MergeBeforeState;
      const sourceLeadId = audit.sourceLeadId;
      const targetLeadId = audit.targetLeadId;

      // a. 还原 target 字段
      await tx.lead.update({
        where: { id: targetLeadId, companyId: command.companyId },
        data: {
          companyName: before.targetLead.companyName,
          country: before.targetLead.country,
          website: before.targetLead.website,
          industry: before.targetLead.industry,
          companyNameSource: before.targetLead.companyNameSource,
          companyNameConfidence: before.targetLead.companyNameConfidence,
        },
      });

      // b. 迁回合并时迁移的 Contact / ContactPoint / Conversation (按记录的 ID)
      if (before.sourceContactIds.length > 0) {
        await tx.contact.updateMany({
          where: { companyId: command.companyId, id: { in: before.sourceContactIds } },
          data: { leadId: sourceLeadId },
        });
      }
      if (before.sourceContactPointIds.length > 0) {
        await tx.contactPoint.updateMany({
          where: { companyId: command.companyId, id: { in: before.sourceContactPointIds } },
          data: { leadId: sourceLeadId },
        });
      }
      if (before.sourceConversationIds.length > 0) {
        await tx.conversation.updateMany({
          where: { companyId: command.companyId, id: { in: before.sourceConversationIds } },
          data: { leadId: sourceLeadId },
        });
      }
      const restoreRelationIds: Array<{
        model: any;
        ids: string[];
      }> = [
        { model: tx.leadActivity, ids: before.sourceActivityIds ?? [] },
        { model: tx.emailMessage, ids: before.sourceEmailMessageIds ?? [] },
        { model: tx.quote, ids: before.sourceQuoteIds ?? [] },
        { model: tx.order, ids: before.sourceOrderIds ?? [] },
        { model: tx.followUpReminder, ids: before.sourceReminderIds ?? [] },
      ];
      for (const relation of restoreRelationIds) {
        if (relation.ids.length > 0) {
          await relation.model.updateMany({
            where: { companyId: command.companyId, id: { in: relation.ids } },
            data: { leadId: sourceLeadId },
          });
        }
      }

      // 还原 Contact 的 isPrimary (仅对快照中记录的联系人)
      const trueIds = Object.entries(before.contactPrimaryMap)
        .filter(([, v]) => v)
        .map(([k]) => k);
      const falseIds = Object.entries(before.contactPrimaryMap)
        .filter(([, v]) => !v)
        .map(([k]) => k);
      if (trueIds.length > 0) {
        await tx.contact.updateMany({
          where: { companyId: command.companyId, id: { in: trueIds } },
          data: { isPrimary: true },
        });
      }
      if (falseIds.length > 0) {
        await tx.contact.updateMany({
          where: { companyId: command.companyId, id: { in: falseIds } },
          data: { isPrimary: false },
        });
      }

      // c. 恢复 source Lead
      await tx.lead.update({
        where: { id: sourceLeadId, companyId: command.companyId },
        data: {
          companyName: before.sourceLead.companyName,
          country: before.sourceLead.country,
          website: before.sourceLead.website,
          industry: before.sourceLead.industry,
          companyNameSource: before.sourceLead.companyNameSource,
          companyNameConfidence: before.sourceLead.companyNameConfidence,
          status: before.sourceLead.status,
          isMerged: before.sourceLead.isMerged,
          mergedToId: before.sourceLead.mergedToId,
          deletedAt: before.sourceLead.deletedAt,
        },
      });

      // d. 标记审计已撤销
      await tx.customerMergeAudit.update({
        where: { id: audit.id, companyId: command.companyId },
        data: {
          status: 'undone',
          undoneAt: new Date(),
          undoneById: command.actorId,
        },
      });
    });
  }
}
