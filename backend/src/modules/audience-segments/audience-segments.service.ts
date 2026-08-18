/**
 * audience-segments.service.ts
 *
 * R111 批次A 客群系统：持久化受众分段。
 * - 客群 CRUD + 条件筛选（criteriaJson → Prisma where，见 criteria-parser.ts）
 * - 成员计算：创建/更新/手动刷新时重算；增量更新（新命中加入 matched_criteria，
 *   不再命中标记 status='skipped' 不物理删除，手动成员 addedReason='manual' 保留）
 * - memberCount 维护：重算/增删成员后写回
 * - 自动刷新：setInterval 轮询 autoRefreshEnabled 的客群（沿用现有模块定时器模式，
 *   如 imap-inbound / owner-notification.dispatcher）
 * - 所有查询租户隔离：where companyId = 当前租户（沿用 marketing-campaigns 写法）
 */
import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../common/prisma/prisma.service';
import {
  CurrentUser,
  hasFullAccess,
  requireActiveCompany,
} from '../../common/utils/data-isolation';
import { CreateAudienceSegmentDto } from './dto/create-audience-segment.dto';
import { UpdateAudienceSegmentDto } from './dto/update-audience-segment.dto';
import { AddMembersDto } from './dto/add-members.dto';
import { QueryAudienceSegmentsDto } from './dto/query-audience-segments.dto';
import { buildLeadCriteriaWhere, extractCriteriaLimit } from './criteria-parser';

const MANAGER_ROLES = new Set(['super_admin', 'company_admin', 'sales_manager']);

const DEFAULT_AUTO_REFRESH_CYCLE_MS = 15 * 60_000;

/** 手动成员在条件重算中保留（不被标记 skipped） */
const MANUAL_ADDED_REASON = 'manual';
const MATCHED_ADDED_REASON = 'matched_criteria';

export interface RefreshResult {
  segmentId: string;
  memberCount: number;
  added: number;
  reactivated: number;
  skipped: number;
}

@Injectable()
export class AudienceSegmentsService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(AudienceSegmentsService.name);
  private timer?: NodeJS.Timeout;
  private cycleRunning = false;

  constructor(private readonly prisma: PrismaService) {}

  // ------------------------------------------------------------ 生命周期

  onModuleInit() {
    if (process.env.NODE_ENV === 'test') {
      this.logger.log('Audience segment auto-refresh is idle in test environment');
      return;
    }
    const intervalMs = this.readPositiveInt(
      process.env.AUDIENCE_SEGMENT_AUTO_REFRESH_INTERVAL_MS,
      DEFAULT_AUTO_REFRESH_CYCLE_MS,
      60_000,
      24 * 60 * 60_000,
    );
    this.timer = setInterval(() => {
      this.autoRefreshCycle().catch((error: any) => {
        this.logger.error(`Audience segment auto-refresh cycle failed: ${error?.message || error}`);
      });
    }, intervalMs);
    this.timer.unref?.();
    void this.autoRefreshCycle().catch((error: any) => {
      this.logger.error(`Audience segment initial auto-refresh failed: ${error?.message || error}`);
    });
  }

  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  // ------------------------------------------------------------- 权限/作用域

  private assertManager(user: CurrentUser, companyId: string) {
    requireActiveCompany(user);
    if (!hasFullAccess(user, companyId) && !MANAGER_ROLES.has(user.activeCompany?.role || '')) {
      throw new ForbiddenException('Audience segment management requires a manager role');
    }
  }

  private accessibleWhere(
    user: CurrentUser,
    companyId: string,
  ): Prisma.AudienceSegmentWhereInput {
    const base: Prisma.AudienceSegmentWhereInput = { companyId };
    return hasFullAccess(user, companyId)
      ? base
      : { ...base, createdById: user.id };
  }

  private async findSegment(id: string, companyId: string) {
    const segment = await this.prisma.audienceSegment.findFirst({
      where: { id, companyId },
    });
    if (!segment) throw new NotFoundException('Audience segment not found');
    return segment;
  }

  // ---------------------------------------------------------------- 列表/详情

  async list(user: CurrentUser, query: QueryAudienceSegmentsDto) {
    const company = requireActiveCompany(user);
    const page = query.page ?? 1;
    const pageSize = query.pageSize ?? 20;
    const where: Prisma.AudienceSegmentWhereInput = {
      ...this.accessibleWhere(user, company.id),
      ...(query.status ? { status: query.status } : {}),
      ...(query.search
        ? { name: { contains: query.search, mode: 'insensitive' as const } }
        : {}),
    };
    const [items, total] = await this.prisma.$transaction([
      this.prisma.audienceSegment.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      this.prisma.audienceSegment.count({ where }),
    ]);
    return {
      items,
      total,
      page,
      pageSize,
      totalPages: Math.ceil(total / pageSize),
    };
  }

  async get(
    id: string,
    user: CurrentUser,
    opts: { includeMembers?: boolean; page?: number; pageSize?: number } = {},
  ) {
    const company = requireActiveCompany(user);
    const segment = await this.findSegment(id, company.id);
    if (!hasFullAccess(user, company.id) && segment.createdById !== user.id) {
      throw new ForbiddenException('No access to this audience segment');
    }
    if (!opts.includeMembers) {
      return { ...segment, members: [], totalMembers: segment.memberCount };
    }
    const page = Math.max(1, opts.page ?? 1);
    const pageSize = Math.min(100, Math.max(1, opts.pageSize ?? 20));
    const [members, totalMembers] = await this.prisma.$transaction([
      this.prisma.audienceSegmentMember.findMany({
        where: { segmentId: id, status: 'eligible' },
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
        include: {
          lead: {
            select: {
              id: true,
              leadName: true,
              companyName: true,
              country: true,
              status: true,
              leadGrade: true,
              contactEmail: true,
              lastContactedAt: true,
            },
          },
        },
      }),
      this.prisma.audienceSegmentMember.count({
        where: { segmentId: id, status: 'eligible' },
      }),
    ]);
    return { ...segment, members, totalMembers, page, pageSize };
  }

  // ------------------------------------------------------------------ 创建

  async create(dto: CreateAudienceSegmentDto, user: CurrentUser) {
    const company = requireActiveCompany(user);
    this.assertManager(user, company.id);
    const name = dto.name.trim();
    if (!name) throw new BadRequestException('name is required');

    const criteria = (dto.criteriaJson ?? {}) as Record<string, unknown>;
    // 先校验条件（非法类型直接抛 BadRequestException），再计算命中成员
    const leadWhere = buildLeadCriteriaWhere(company.id, criteria);
    const limit = extractCriteriaLimit(criteria);
    const matchedLeads = await this.prisma.lead.findMany({
      where: leadWhere,
      select: { id: true },
      orderBy: { createdAt: 'desc' },
      ...(limit ? { take: limit } : {}),
    });

    const criteriaJson = criteria as Prisma.InputJsonValue;
    const segment = await this.prisma.$transaction(async (tx) => {
      const created = await tx.audienceSegment.create({
        data: {
          companyId: company.id,
          name,
          description: dto.description?.trim() || null,
          criteriaJson,
          memberCount: matchedLeads.length,
          autoRefreshEnabled: dto.autoRefreshEnabled ?? false,
          autoRefreshIntervalHours: dto.autoRefreshIntervalHours ?? 24,
          lastRefreshedAt: new Date(),
          status: dto.status ?? 'active',
          createdById: user.id,
        },
      });
      if (matchedLeads.length > 0) {
        await tx.audienceSegmentMember.createMany({
          data: matchedLeads.map((lead) => ({
            segmentId: created.id,
            leadId: lead.id,
            status: 'eligible',
            addedReason: MATCHED_ADDED_REASON,
          })),
          skipDuplicates: true,
        });
      }
      return created;
    });
    return this.get(segment.id, user);
  }

  // ------------------------------------------------------------------ 更新

  async update(id: string, dto: UpdateAudienceSegmentDto, user: CurrentUser) {
    const company = requireActiveCompany(user);
    this.assertManager(user, company.id);
    const segment = await this.findSegment(id, company.id);

    const data: Prisma.AudienceSegmentUpdateInput = {
      name: dto.name ? dto.name.trim() : undefined,
      description:
        dto.description === undefined
          ? undefined
          : dto.description?.trim() || null,
      autoRefreshEnabled: dto.autoRefreshEnabled,
      autoRefreshIntervalHours: dto.autoRefreshIntervalHours,
      status: dto.status,
    };

    let refreshResult: RefreshResult | null = null;
    if (dto.criteriaJson !== undefined) {
      const criteria = dto.criteriaJson as Record<string, unknown>;
      buildLeadCriteriaWhere(company.id, criteria); // 校验
      data.criteriaJson = criteria as Prisma.InputJsonValue;
      // 条件变化 → 同步重算成员
      refreshResult = await this.applyCriteriaRefresh(segment.id, company.id, criteria);
    }

    if (Object.keys(data).length > 0) {
      await this.prisma.audienceSegment.update({ where: { id }, data });
    }
    const updated = await this.get(id, user);
    return refreshResult ? { ...updated, refresh: refreshResult } : updated;
  }

  // ------------------------------------------------------------------ 删除

  async remove(id: string, user: CurrentUser) {
    const company = requireActiveCompany(user);
    this.assertManager(user, company.id);
    await this.findSegment(id, company.id);
    await this.prisma.audienceSegment.delete({ where: { id } }); // 成员级联删除
    return { id, deleted: true };
  }

  // ------------------------------------------------------------- 手动刷新

  async refresh(id: string, user: CurrentUser): Promise<RefreshResult> {
    const company = requireActiveCompany(user);
    this.assertManager(user, company.id);
    const segment = await this.findSegment(id, company.id);
    return this.applyCriteriaRefresh(
      segment.id,
      company.id,
      (segment.criteriaJson ?? {}) as Record<string, unknown>,
    );
  }

  // ------------------------------------------------------ 手动成员增删

  async addMembers(id: string, dto: AddMembersDto, user: CurrentUser) {
    const company = requireActiveCompany(user);
    this.assertManager(user, company.id);
    const segment = await this.findSegment(id, company.id);

    const leadIds = [...new Set(dto.leadIds.map((v) => v.trim()).filter(Boolean))];
    if (leadIds.length === 0) {
      throw new BadRequestException('leadIds must contain at least one non-empty id');
    }
    const found = await this.prisma.lead.findMany({
      where: { id: { in: leadIds }, companyId: company.id, deletedAt: null },
      select: { id: true },
    });
    if (found.length !== leadIds.length) {
      throw new BadRequestException(
        'Some leadIds do not exist in this company or are deleted',
      );
    }

    const result = await this.prisma.$transaction(async (tx) => {
      const created = await tx.audienceSegmentMember.createMany({
        data: leadIds.map((leadId) => ({
          segmentId: segment.id,
          leadId,
          status: 'eligible',
          addedReason: MANUAL_ADDED_REASON,
        })),
        skipDuplicates: true,
      });
      const memberCount = await tx.audienceSegmentMember.count({
        where: { segmentId: segment.id, status: 'eligible' },
      });
      await tx.audienceSegment.update({
        where: { id: segment.id },
        data: { memberCount },
      });
      return { created: created.count, memberCount };
    });
    return { segmentId: id, ...result };
  }

  async removeMember(id: string, memberId: string, user: CurrentUser) {
    const company = requireActiveCompany(user);
    this.assertManager(user, company.id);
    await this.findSegment(id, company.id);
    const existing = await this.prisma.audienceSegmentMember.findFirst({
      where: { id: memberId, segmentId: id },
      select: { id: true },
    });
    if (!existing) throw new NotFoundException('Audience segment member not found');
    await this.prisma.$transaction(async (tx) => {
      await tx.audienceSegmentMember.delete({ where: { id: memberId } });
      const memberCount = await tx.audienceSegmentMember.count({
        where: { segmentId: id, status: 'eligible' },
      });
      await tx.audienceSegment.update({
        where: { id },
        data: { memberCount },
      });
    });
    return { id: memberId, removed: true };
  }

  // ----------------------------------------------------------- 预览/导出

  async previewCount(id: string, user: CurrentUser) {
    const company = requireActiveCompany(user);
    const segment = await this.findSegment(id, company.id);
    const criteria = (segment.criteriaJson ?? {}) as Record<string, unknown>;
    const leadWhere = buildLeadCriteriaWhere(company.id, criteria);
    const limit = extractCriteriaLimit(criteria);
    const memberCount = await this.prisma.lead.count({ where: leadWhere });
    return {
      segmentId: id,
      memberCount: limit !== undefined ? Math.min(memberCount, limit) : memberCount,
      limited: limit !== undefined,
      limit: limit ?? null,
      criteria: segment.criteriaJson,
    };
  }

  async export(id: string, user: CurrentUser) {
    const company = requireActiveCompany(user);
    const segment = await this.findSegment(id, company.id);
    const members = await this.prisma.audienceSegmentMember.findMany({
      where: { segmentId: id, status: 'eligible' },
      select: { leadId: true },
      orderBy: { createdAt: 'desc' },
    });
    return {
      segmentId: id,
      name: segment.name,
      memberCount: members.length,
      leadIds: members.map((m) => m.leadId),
    };
  }

  // ------------------------------------------------------------ 内部实现

  /**
   * 按条件重算成员（增量更新）：
   * - 新命中 → create（addedReason='matched_criteria'）
   * - skipped 且重新命中 → 恢复 eligible（addedReason='matched_criteria'）
   * - 原 matched_criteria 成员不再命中 → status='skipped'（不物理删除）
   * - 手动成员（addedReason='manual'）在重算中保留，不因条件变化被跳过
   * - memberCount = eligible 成员数，lastRefreshedAt 写回
   */
  private async applyCriteriaRefresh(
    segmentId: string,
    companyId: string,
    criteria: Record<string, unknown>,
  ): Promise<RefreshResult> {
    const leadWhere = buildLeadCriteriaWhere(companyId, criteria);
    const limit = extractCriteriaLimit(criteria);
    const matchedLeads = await this.prisma.lead.findMany({
      where: leadWhere,
      select: { id: true },
      orderBy: { createdAt: 'desc' },
      ...(limit ? { take: limit } : {}),
    });
    const matchedIds = new Set(matchedLeads.map((lead) => lead.id));

    return this.prisma.$transaction(async (tx) => {
      const existing = await tx.audienceSegmentMember.findMany({
        where: { segmentId },
        select: { id: true, leadId: true, status: true, addedReason: true },
      });
      const byLead = new Map(existing.map((member) => [member.leadId, member]));

      const toCreate: string[] = [];
      const toReactivate: string[] = [];
      const toSkip: string[] = [];

      for (const leadId of matchedIds) {
        const member = byLead.get(leadId);
        if (!member) {
          toCreate.push(leadId);
        } else if (member.status === 'skipped') {
          toReactivate.push(member.id);
        }
      }
      for (const member of existing) {
        if (
          !matchedIds.has(member.leadId)
          && member.addedReason === MATCHED_ADDED_REASON
          && member.status === 'eligible'
        ) {
          toSkip.push(member.id);
        }
      }

      if (toCreate.length > 0) {
        await tx.audienceSegmentMember.createMany({
          data: toCreate.map((leadId) => ({
            segmentId,
            leadId,
            status: 'eligible',
            addedReason: MATCHED_ADDED_REASON,
          })),
          skipDuplicates: true,
        });
      }
      if (toReactivate.length > 0) {
        await tx.audienceSegmentMember.updateMany({
          where: { id: { in: toReactivate } },
          data: { status: 'eligible', addedReason: MATCHED_ADDED_REASON },
        });
      }
      if (toSkip.length > 0) {
        await tx.audienceSegmentMember.updateMany({
          where: { id: { in: toSkip } },
          data: { status: 'skipped' },
        });
      }

      const memberCount = await tx.audienceSegmentMember.count({
        where: { segmentId, status: 'eligible' },
      });
      await tx.audienceSegment.update({
        where: { id: segmentId },
        data: { memberCount, lastRefreshedAt: new Date() },
      });

      return {
        segmentId,
        memberCount,
        added: toCreate.length,
        reactivated: toReactivate.length,
        skipped: toSkip.length,
      };
    });
  }

  /** 自动刷新：轮询 autoRefreshEnabled + active 且到期的客群，逐个重算 */
  private async autoRefreshCycle() {
    if (this.cycleRunning) return;
    this.cycleRunning = true;
    const now = Date.now();
    try {
      const candidates = await this.prisma.audienceSegment.findMany({
        where: { autoRefreshEnabled: true, status: 'active' },
        select: {
          id: true,
          companyId: true,
          lastRefreshedAt: true,
          autoRefreshIntervalHours: true,
          criteriaJson: true,
        },
      });
      const due = candidates.filter((segment) => {
        const intervalHours = Math.max(1, segment.autoRefreshIntervalHours || 24);
        const nextAt = segment.lastRefreshedAt
          ? segment.lastRefreshedAt.getTime() + intervalHours * 60 * 60 * 1000
          : 0;
        return nextAt <= now;
      });
      for (const segment of due) {
        try {
          const result = await this.applyCriteriaRefresh(
            segment.id,
            segment.companyId,
            (segment.criteriaJson ?? {}) as Record<string, unknown>,
          );
          this.logger.log(
            `Auto-refreshed audience segment ${segment.id}: memberCount=${result.memberCount}`,
          );
        } catch (error: any) {
          this.logger.error(
            `Auto-refresh failed for audience segment ${segment.id}: ${error?.message || error}`,
          );
        }
      }
    } finally {
      this.cycleRunning = false;
    }
  }

  private readPositiveInt(raw: string | undefined, fallback: number, min: number, max: number) {
    const value = Number.parseInt(String(raw || ''), 10);
    return Number.isFinite(value) ? Math.max(min, Math.min(max, value)) : fallback;
  }
}

