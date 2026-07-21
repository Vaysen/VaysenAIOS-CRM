import {
  Injectable,
  NotFoundException,
  ForbiddenException,
  BadRequestException,
  Inject,
  forwardRef,
  Logger,
} from '@nestjs/common';
import { promises as fs } from 'fs';
import { resolveMx, Resolver } from 'dns/promises';
import { PrismaService } from '../../common/prisma/prisma.service';
import { CreateLeadDto } from './dto/create-lead.dto';
import { UpdateLeadDto } from './dto/update-lead.dto';
import { UpdateLeadStatusDto } from './dto/update-lead-status.dto';
import { BatchOperationDto } from './dto/batch-operation.dto';
import { DuplicateLeadsService } from '../duplicate-leads/duplicate-leads.service';
import { LeadScoresService } from '../lead-scores/lead-scores.service';
import { FollowUpRemindersService } from '../follow-up-reminders/follow-up-reminders.service';
import {
  CurrentUser,
  hasFullAccess,
  checkResourceAccess,
  applyDataIsolation,
  getAccessibleCompanyIds,
} from '../../common/utils/data-isolation';
import * as XLSX from 'xlsx';
import OpenAI from 'openai';
import { TagsService } from '../tags/tags.service';
import { LanguageService } from '../../common/services/language.service';
import { resolveBusinessContext } from '../../common/business-context';

const VALID_EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const VERIFY_FREE_DOMAINS = new Set([
  'gmail.com', 'outlook.com', 'hotmail.com', 'live.com', 'yahoo.com',
  'icloud.com', 'aol.com', 'proton.me', 'protonmail.com',
  'qq.com', '163.com', '126.com', 'sina.com', 'sohu.com', 'foxmail.com',
]);
const VERIFY_BLOCKED_MAILBOXES = new Set([
  'support', 'service', 'customer', 'customerservice', 'help', 'returns',
  'privacy', 'legal', 'noreply', 'no-reply', 'donotreply', 'do-not-reply',
  'press', 'media', 'pr', 'career', 'careers', 'jobs', 'hr',
]);
const VERIFY_BUSINESS_MAILBOXES = new Set([
  'sourcing', 'procurement', 'purchasing', 'buyer', 'buyers', 'buying',
  'vendor', 'vendors', 'supplier', 'suppliers', 'wholesale', 'b2b',
  'business', 'partnerships', 'partner', 'sales', 'info', 'contact',
  'hello', 'office', 'admin', 'orders', 'export', 'import', 'marketing',
  'merchandise', 'gifts', 'packaging', 'brand',
]);
const VERIFY_PLACEHOLDER_DOMAINS = new Set(['example.com', 'example.org', 'example.net', 'test.com']);
const VERIFY_PLACEHOLDER_LOCALS = new Set(['example', 'sample', 'demo', 'test', 'user', 'firstname', 'lastname', 'first.last', 'john', 'jane', 'john.doe', 'jane.doe']);
const EXTERNAL_POOL_SOURCE_TYPES = ['external_agent_markdown', 'continuous-prospect', 'customs_importyeti', 'AI搜索', 'AI鎼滅储'];
const VERIFIED_EMAIL_STATUSES = new Set(['smtp_verified', 'official_page_verified', 'verified_public_source']);
const REVIEW_EMAIL_STATUSES = new Set(['mx_domain_verified', 'unverified']);
const FAILED_EMAIL_STATUSES = new Set(['rejected', 'failed', 'invalid', 'no_mx', 'blocked', 'free_mailbox']);
const LEAD_ACTIVE_ROUND_STATUSES = [
  'DraftPending',
  'Drafting',
  'DraftReady',
  'ValidationFailed',
  'QueuedToSend',
  'Queued',
  'Sending',
  'Sent',
  'Opened',
  'Clicked',
  'Replied',
];
const LEAD_PREVIOUS_ROUND_STATUSES = ['Sent', 'Opened', 'Clicked', 'Replied'];
@Injectable()
export class LeadsService {
  private readonly logger = new Logger(LeadsService.name);
  private readonly zhipu = new OpenAI({
    apiKey: process.env.ZHIPU_API_KEY || process.env.OPENAI_API_KEY || 'sk-placeholder',
    baseURL: process.env.ZHIPU_BASE_URL || process.env.OPENAI_BASE_URL || 'https://open.bigmodel.cn/api/paas/v4',
  });

  constructor(
    private prisma: PrismaService,
    @Inject(forwardRef(() => DuplicateLeadsService))
    private duplicateLeadsService: DuplicateLeadsService,
    private leadScoresService: LeadScoresService,
    private followUpRemindersService: FollowUpRemindersService,
    private tagsService: TagsService,
    private languageService: LanguageService,
  ) {}

  async syncExternalMarkdownLeads(currentUser: any) {
    const companyId = this.getDefaultCompanyId(currentUser);
    await this.checkManagerAccess(currentUser, companyId);

    const archiveEnabled = /^(?:1|true|yes|on)$/i.test(String(process.env.EXTERNAL_LEAD_ARCHIVE_ENABLED || 'false'));
    if (!archiveEnabled) {
      throw new BadRequestException(
        'External lead archive import is disabled. Set EXTERNAL_LEAD_ARCHIVE_ENABLED=true and mount an explicit EXTERNAL_LEAD_ARCHIVE_PATH to enable it.',
      );
    }
    const filePath = String(process.env.EXTERNAL_LEAD_ARCHIVE_PATH || '').trim();
    if (!filePath) {
      throw new BadRequestException(
        'External lead archive is enabled but EXTERNAL_LEAD_ARCHIVE_PATH is not configured.',
      );
    }
    const fileStat = await fs.stat(filePath).catch(() => null);
    if (!fileStat) throw new NotFoundException(`External lead archive not found: ${filePath}`);

    const content = await fs.readFile(filePath, 'utf8');
    const parsed = this.parseExternalLeadMarkdown(content);
    const now = new Date();
    let created = 0;
    let updated = 0;
    let skipped = 0;
    const leadIds: string[] = [];

    for (const item of parsed) {
      if (!item.companyName || item.status?.toLowerCase() === 'removed') {
        skipped++;
        continue;
      }

      const where: any = item.contactEmail
        ? { companyId, contactEmail: item.contactEmail, deletedAt: null }
        : { companyId, companyName: item.companyName, country: item.country || undefined, deletedAt: null };
      const existing = await this.prisma.lead.findFirst({ where, select: { id: true, ownerUserId: true, notes: true, collectedAt: true } });
      const notes = this.buildExternalLeadNotes(item, filePath, now);

      if (existing) {
        const lead = await this.prisma.lead.update({
          where: { id: existing.id },
          data: {
            contactName: item.contactName || undefined,
            contactTitle: item.contactTitle || undefined,
            contactEmail: item.contactEmail || undefined,
            country: item.country || undefined,
            emailVerificationStatus: item.emailVerificationStatus,
            emailVerificationReason: item.emailVerificationReason,
            leadGrade: item.leadGrade,
            sourceType: 'external_agent_markdown',
            sourceUrl: filePath,
            sourceCountry: item.country || undefined,
            collectedAt: now,
            notes: this.mergeExternalLeadNotes(existing.notes, notes),
          },
          select: { id: true },
        });
        leadIds.push(lead.id);
        updated++;
      } else {
        const lead = await this.prisma.lead.create({
          data: {
            companyId,
            companyName: item.companyName,
            contactName: item.contactName || null,
            contactTitle: item.contactTitle || null,
            contactEmail: item.contactEmail || null,
            country: item.country || null,
            mainProducts: item.mainProducts || null,
            sourceType: 'external_agent_markdown',
            sourceUrl: filePath,
            sourceKeyword: '客户主档案.md',
            sourceCountry: item.country || null,
            collectedAt: now,
            emailVerificationStatus: item.emailVerificationStatus,
            emailVerificationReason: item.emailVerificationReason,
            confidenceScore: item.confidenceScore,
            leadScore: item.confidenceScore,
            leadGrade: item.leadGrade,
            status: 'new',
            reviewStatus: item.contactEmail ? 'approved' : 'pending',
            ownerUserId: null,
            notes,
          },
          select: { id: true },
        });
        leadIds.push(lead.id);
        created++;
      }
    }

    await this.prisma.auditLog.create({
      data: {
        companyId,
        userId: currentUser.id,
        action: 'external_leads_synced',
        entityType: 'Lead',
        newValue: { filePath, fileModifiedAt: fileStat.mtime, parsed: parsed.length, created, updated, skipped, leadIds },
      },
    });

    return { filePath, fileModifiedAt: fileStat.mtime, parsed: parsed.length, created, updated, skipped, importedAt: now };
  }

  async getExternalMarkdownPool(currentUser: any, query: { date?: string; assigned?: string; dateRange?: string; emailVerificationBucket?: string }) {
    const companyId = this.getDefaultCompanyId(currentUser);
    await this.checkManagerAccess(currentUser, companyId);
    const range = this.resolveExternalPoolRange(query.dateRange, query.date);
    const assigned = query.assigned || 'unassigned';
    const verificationCondition = this.buildExternalVerificationCondition(query.emailVerificationBucket || 'all');
    const where: any = {
      companyId,
      deletedAt: null,
      sourceType: { in: EXTERNAL_POOL_SOURCE_TYPES },
      contactEmail: { not: null },
    };
    if (range.filter) where.collectedAt = range.filter;
    if (assigned === 'unassigned') where.ownerUserId = null;
    if (assigned === 'assigned') where.ownerUserId = { not: null };
    if (verificationCondition) where.AND = [...(where.AND || []), verificationCondition];

    const poolWhere = {
      companyId,
      deletedAt: null,
      sourceType: { in: EXTERNAL_POOL_SOURCE_TYPES },
      contactEmail: { not: null },
      ...(range.filter ? { collectedAt: range.filter } : {}),
    };

    const [leads, total, unassigned, assignedCount, withEmail, verifiedReady, reviewNeeded, invalid, salesUsers] = await Promise.all([
      this.prisma.lead.findMany({
        where,
        include: { owner: { select: { id: true, firstName: true, lastName: true, email: true } } },
        orderBy: [{ collectedAt: 'desc' }, { createdAt: 'desc' }],
        take: 500,
      }),
      this.prisma.lead.count({ where: poolWhere }),
      this.prisma.lead.count({ where: { ...poolWhere, ownerUserId: null } }),
      this.prisma.lead.count({ where: { ...poolWhere, ownerUserId: { not: null } } }),
      this.prisma.lead.count({ where: { ...poolWhere, contactEmail: { not: null } } }),
      this.prisma.lead.count({ where: { ...poolWhere, emailVerificationStatus: { in: [...VERIFIED_EMAIL_STATUSES] } } }),
      this.prisma.lead.count({ where: { ...poolWhere, emailVerificationStatus: { in: [...REVIEW_EMAIL_STATUSES] } } }),
      this.prisma.lead.count({ where: { ...poolWhere, emailVerificationStatus: { in: [...FAILED_EMAIL_STATUSES] } } }),
      this.getSalesUsers(companyId),
    ]);

    return {
      date: range.date,
      dateRange: range.dateRange,
      total,
      unassigned,
      assigned: assignedCount,
      withEmail,
      verifiedReady,
      reviewNeeded,
      invalid,
      salesUsers,
      data: leads,
    };
  }

  async distributeExternalMarkdownLeads(currentUser: any, dto: { date?: string; dateRange?: string; userIds?: string[] }) {
    const companyId = this.getDefaultCompanyId(currentUser);
    await this.checkManagerAccess(currentUser, companyId);
    const range = this.resolveExternalPoolRange(dto.dateRange, dto.date);
    const salesUsers = await this.getSalesUsers(companyId, dto.userIds);
    if (!salesUsers.length) throw new BadRequestException('No active sales users selected for distribution');

    const leads = await this.prisma.lead.findMany({
      where: {
        companyId,
        deletedAt: null,
        sourceType: { in: EXTERNAL_POOL_SOURCE_TYPES },
        contactEmail: { not: null },
        emailVerificationStatus: { in: [...VERIFIED_EMAIL_STATUSES] },
        ...(range.filter ? { collectedAt: range.filter } : {}),
        ownerUserId: null,
      },
      select: { id: true, reviewStatus: true },
      orderBy: [{ collectedAt: 'asc' }, { createdAt: 'asc' }],
    });
    if (!leads.length) return { date: range.date, distributed: 0, users: salesUsers.map((u) => ({ ...u, count: 0 })) };

    const counts = new Map<string, number>();
    await this.prisma.$transaction(async (tx) => {
      for (let index = 0; index < leads.length; index++) {
        const user = salesUsers[index % salesUsers.length];
        counts.set(user.id, (counts.get(user.id) || 0) + 1);
        const updateData: any = { ownerUserId: user.id, status: 'prospect_pool' };
        const leadReviewStatus = leads[index].reviewStatus;
        if (!leadReviewStatus || leadReviewStatus === 'pending' || leadReviewStatus === 'needs_enrichment') {
          updateData.reviewStatus = 'approved';
        }
        await tx.lead.update({ where: { id: leads[index].id }, data: updateData });
      }

      for (const user of salesUsers) {
        const count = counts.get(user.id) || 0;
        if (!count) continue;
        await tx.auditLog.create({
          data: {
            companyId,
            userId: currentUser.id,
            action: 'external_leads_assigned',
            entityType: 'User',
            entityId: user.id,
            newValue: { count, date: range.date, dateRange: range.dateRange, mode: 'equal_distribution', movedToProspectPool: true },
          },
        });
      }
    });

    return {
      date: range.date,
      distributed: leads.length,
      users: salesUsers.map((user) => ({ ...user, count: counts.get(user.id) || 0 })),
    };
  }

  async assignExternalMarkdownLeads(currentUser: any, dto: { leadIds: string[]; ownerUserId: string }) {
    const companyId = this.getDefaultCompanyId(currentUser);
    await this.checkManagerAccess(currentUser, companyId);
    if (!dto.leadIds?.length) throw new BadRequestException('No leads selected');
    const [owner] = await this.getSalesUsers(companyId, [dto.ownerUserId]);
    if (!owner) throw new BadRequestException('Target owner is not an active sales user');

    const leads = await this.prisma.lead.findMany({
      where: {
        id: { in: dto.leadIds },
        companyId,
        deletedAt: null,
        sourceType: { in: EXTERNAL_POOL_SOURCE_TYPES },
        ownerUserId: null,
        contactEmail: { not: null },
        emailVerificationStatus: { in: [...VERIFIED_EMAIL_STATUSES] },
      },
      select: { id: true, reviewStatus: true },
    });
    if (!leads.length) throw new BadRequestException('没有可分配客户：只有 SMTP 已验证、官网来源确认或官方页面确认的邮箱才能分配。请先批量验证邮箱，失败或仅 MX 有效的客户会留在复核/失败池。');

    await this.prisma.$transaction(async (tx) => {
      for (const lead of leads) {
        const updateData: any = { ownerUserId: owner.id, status: 'prospect_pool' };
        if (!lead.reviewStatus || lead.reviewStatus === 'pending' || lead.reviewStatus === 'needs_enrichment') {
          updateData.reviewStatus = 'approved';
        }
        await tx.lead.update({ where: { id: lead.id }, data: updateData });
      }
      await tx.auditLog.create({
        data: {
          companyId,
          userId: currentUser.id,
          action: 'external_leads_assigned',
          entityType: 'User',
          entityId: owner.id,
          newValue: { count: leads.length, mode: 'manual_assignment', leadIds: leads.map((lead) => lead.id), movedToProspectPool: true },
        },
      });
    });

    return { assigned: leads.length, owner };
  }

  async getAssignmentNotices(currentUser: any) {
    const companyId = this.getDefaultCompanyId(currentUser);
    const settingKey = `leadAssignmentNoticeReadAt.${currentUser.id}`;
    const setting = await this.prisma.systemSetting.findUnique({
      where: { companyId_key: { companyId, key: settingKey } },
    });
    const readAt = setting?.value ? new Date(setting.value) : new Date(0);
    const logs = await this.prisma.auditLog.findMany({
      where: {
        companyId,
        entityType: 'User',
        entityId: currentUser.id,
        action: 'external_leads_assigned',
        createdAt: { gt: readAt },
      },
      orderBy: { createdAt: 'desc' },
      take: 20,
    });
    const total = logs.reduce((sum, log) => sum + Number((log.newValue as any)?.count || 0), 0);
    return { total, notices: logs.map((log) => ({ id: log.id, count: Number((log.newValue as any)?.count || 0), createdAt: log.createdAt, metadata: log.newValue })) };
  }

  async markAssignmentNoticesRead(currentUser: any) {
    const companyId = this.getDefaultCompanyId(currentUser);
    const settingKey = `leadAssignmentNoticeReadAt.${currentUser.id}`;
    const now = new Date();
    await this.prisma.systemSetting.upsert({
      where: { companyId_key: { companyId, key: settingKey } },
      create: { companyId, key: settingKey, value: now.toISOString(), group: 'notifications', updatedBy: currentUser.id },
      update: { value: now.toISOString(), updatedBy: currentUser.id },
    });
    return { readAt: now };
  }

  async findAll(currentUser: any, query: {
    page?: number;
    limit?: number;
    status?: string;
    reviewStatus?: string;
    country?: string;
    productCategory?: string;
    ownerUserId?: string;
    leadGrade?: string;
    search?: string;
    sortBy?: string;
    sentFrom?: string;
    sentTo?: string;
    hasEmailHistory?: string;
    sourceType?: string;
    tagId?: string;
    emailVerificationStatus?: string;
    outreachRound?: string;
    engagement?: string;
    includeReplied?: string;
    createdAfter?: string;
    createdBefore?: string;
  }) {
    const page = query.page || 1;
    const limit = query.limit || 20;
    const skip = (page - 1) * limit;

    const where = this.buildWhereClause(currentUser, query);

    let orderBy: any = { createdAt: 'desc' };
    if (query.sortBy === 'score') {
      orderBy = { leadScore: 'desc' };
    } else if (query.sortBy === 'score_asc') {
      orderBy = { leadScore: 'asc' };
    } else if (query.sortBy === 'name') {
      orderBy = { companyName: 'asc' };
    }

    const [leads, total] = await Promise.all([
      this.prisma.lead.findMany({
        where,
        include: {
          owner: { select: { id: true, firstName: true, lastName: true, email: true } },
          tags: { include: { tag: true } },
          pins: { where: { userId: currentUser.id }, select: { id: true } },
          contactPoints: {
            where: { type: 'whatsapp', isVerified: true },
            select: {
              id: true,
              type: true,
              normalizedValue: true,
              originalValue: true,
              isVerified: true,
              isPrimary: true,
            },
          },
        },
        skip,
        take: limit,
        orderBy,
      }),
      this.prisma.lead.count({ where }),
    ]);

    // Compute email stats and follow-up status for each lead
    const leadIds = leads.map((l) => l.id);
    const [emailStats, followUpStatuses] = await Promise.all([
      this.computeEmailStats(leadIds),
      this.computeFollowUpStatuses(leads),
    ]);

    const data = leads.map((lead) => ({
      ...lead,
      isPinned: (lead as any).pins?.length > 0,
      pins: undefined, // Don't leak raw pins to frontend
      emailStats: emailStats[lead.id] || { sent: 0, opened: 0, clicked: 0, replied: 0, bounced: 0 },
      followUpStatus: followUpStatuses[lead.id] || 'normal',
    }));

    return {
      data,
      meta: { page, limit, total, totalPages: Math.ceil(total / limit) },
    };
  }

  private async computeEmailStats(leadIds: string[]) {
    const messages = await this.prisma.emailMessage.findMany({
      where: { leadId: { in: leadIds } },
      select: {
        leadId: true,
        status: true,
        subject: true,
        toEmail: true,
        sentAt: true,
        createdAt: true,
        openedAt: true,
        clickedAt: true,
      },
      orderBy: { createdAt: 'asc' },
    });

    const stats: Record<string, {
      sent: number;
      opened: number;
      clicked: number;
      replied: number;
      bounced: number;
      firstSentAt?: Date;
      lastSentAt?: Date;
      lastSubject?: string;
      lastToEmail?: string;
    }> = {};
    for (const lid of leadIds) {
      stats[lid] = { sent: 0, opened: 0, clicked: 0, replied: 0, bounced: 0 };
    }

    for (const m of messages) {
      const s = stats[m.leadId];
      if (!s) continue;
      s.sent++;
      const activityAt = m.sentAt || m.createdAt;
      if (!s.firstSentAt || activityAt < s.firstSentAt) s.firstSentAt = activityAt;
      if (!s.lastSentAt || activityAt > s.lastSentAt) {
        s.lastSentAt = activityAt;
        s.lastSubject = m.subject || '';
        s.lastToEmail = m.toEmail || '';
      }
      if (m.openedAt) s.opened++;
      if (m.clickedAt) s.clicked++;
      if (m.status === 'replied') s.replied++;
      if (m.status === 'bounced') s.bounced++;
    }

    return stats;
  }

  private computeFollowUpStatuses(leads: any[]): Record<string, string> {
    const now = new Date();
    const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const todayEnd = new Date(todayStart.getTime() + 86400000);
    const sevenDaysAgo = new Date(todayStart.getTime() - 7 * 86400000);

    const result: Record<string, string> = {};
    for (const lead of leads) {
      const nextFollowUp = lead.nextFollowUpAt ? new Date(lead.nextFollowUpAt) : null;
      const lastContacted = lead.lastContactedAt ? new Date(lead.lastContactedAt) : null;

      if (nextFollowUp && nextFollowUp < todayStart) {
        result[lead.id] = 'overdue';
      } else if (nextFollowUp && nextFollowUp >= todayStart && nextFollowUp < todayEnd) {
        result[lead.id] = 'due_today';
      } else if (!nextFollowUp && (!lastContacted || lastContacted < sevenDaysAgo)) {
        result[lead.id] = 'long_time_no_contact';
      } else {
        result[lead.id] = 'normal';
      }
    }
    return result;
  }

  async findOne(id: string, currentUser: any) {
    const lead = await this.prisma.lead.findUnique({
      where: { id },
      include: {
        owner: { select: { id: true, firstName: true, lastName: true, email: true } },
        company: { select: { id: true, name: true, slug: true } },
        contacts: { orderBy: [{ isPrimary: 'desc' }, { createdAt: 'desc' }] },
        tags: { include: { tag: true } },
        pins: { where: { userId: currentUser.id }, select: { id: true } },
        scores: { select: { totalScore: true, grade: true, breakdown: true, calculatedAt: true }, orderBy: { calculatedAt: 'desc' }, take: 1 },
        sources: { orderBy: { collectedAt: 'desc' } },
        contactPoints: { orderBy: [{ isPrimary: 'desc' }, { createdAt: 'desc' }] },
        conversations: {
          orderBy: { lastMessageAt: { sort: 'desc', nulls: 'last' } },
          include: { contactPoint: true, _count: { select: { messages: true } } },
        },
        externalIdentities: { orderBy: { updatedAt: 'desc' } },
        quotes: { orderBy: { createdAt: 'desc' }, include: { lineItems: true } },
        orders: { orderBy: { createdAt: 'desc' } },
      },
    });

    if (!lead || lead.deletedAt) {
      throw new NotFoundException('Lead not found');
    }

    await this.checkLeadAccess(currentUser, lead);

    // Add email stats to detail
    const [emailStats, latestResearch] = await Promise.all([
      this.computeEmailStats([lead.id]),
      this.prisma.leadActivity.findFirst({
        where: { leadId: lead.id, activityType: 'ai_deep_research', deletedAt: null },
        orderBy: { occurredAt: 'desc' },
        select: { id: true, title: true, description: true, metadata: true, occurredAt: true },
      }),
    ]);
    return {
      ...lead,
      emailStats: emailStats[lead.id] || { sent: 0, opened: 0, clicked: 0, replied: 0, bounced: 0 },
      latestDeepResearch: latestResearch,
      profileSummary: {
        hasTrustedIdentity: lead.contactPoints.some((point) => point.isVerified) || lead.externalIdentities.some((identity) => identity.identityStatus === 'resolved'),
        conversationCount: lead.conversations.length,
        messageCount: lead.conversations.reduce((sum, conversation) => sum + conversation._count.messages, 0),
        quoteCount: lead.quotes.length,
        orderCount: lead.orders.length,
        sourceCount: lead.sources.length,
      },
    };
  }

  async create(dto: CreateLeadDto, currentUser: any) {
    const companyId = dto.companyId || currentUser.companies[0]?.id;
    if (!companyId) {
      throw new ForbiddenException('No company associated');
    }

    await this.checkWriteAccess(currentUser, companyId);

    // 自动检测客户语言（如果未手动指定）
    let language = (dto as any).language as string | undefined;
    if (!language) {
      language = await this.languageService.detectLanguage({
        country: dto.country || dto.sourceCountry,
        messageText: dto.notes || dto.productCategory,
      });
    }

    const lead = await this.prisma.$transaction(async (tx) => {
      const l = await tx.lead.create({
        data: {
          companyId,
          leadName: dto.leadName,
          companyName: dto.companyName,
          companyNameSource: 'manual_confirmed',
          companyNameConfidence: 'high',
          website: dto.website,
          websiteDomain: dto.websiteDomain || (dto.website ? this.extractDomain(dto.website) : null),
          country: dto.country,
          city: dto.city,
          industry: dto.industry,
          productCategory: dto.productCategory,
          businessType: dto.businessType,
          contactName: dto.contactName,
          contactTitle: dto.contactTitle,
          contactEmail: dto.contactEmail,
          contactPhone: dto.contactPhone,
          whatsapp: dto.whatsapp,
          linkedinUrl: dto.linkedinUrl,
          facebookUrl: dto.facebookUrl,
          sourceUrl: dto.sourceUrl,
          sourceType: dto.sourceType || 'manual',
          sourceKeyword: dto.sourceKeyword,
          sourceCountry: dto.sourceCountry,
          language,
          status: dto.status || 'new',
          reviewStatus: dto.reviewStatus || 'pending',
          confidenceScore: dto.confidenceScore,
          leadScore: dto.leadScore,
          leadGrade: dto.leadGrade,
          ownerUserId: dto.ownerUserId || currentUser.id,
          lastContactedAt: dto.lastContactedAt ? new Date(dto.lastContactedAt) : null,
          nextFollowUpAt: dto.nextFollowUpAt ? new Date(dto.nextFollowUpAt) : null,
          notes: dto.notes,
          isUncertain: dto.isUncertain ?? false,
          uncertainFields: dto.uncertainFields || [],
        },
      });

      await tx.leadActivity.create({
        data: {
          companyId,
          leadId: l.id,
          userId: currentUser.id,
          activityType: 'lead_created',
          title: 'Lead created',
          description: `Created lead "${dto.companyName}"`,
        },
      });

      await tx.auditLog.create({
        data: {
          companyId,
          userId: currentUser.id,
          action: 'create_lead',
          entityType: 'Lead',
          entityId: l.id,
          newValue: { companyName: dto.companyName, contactEmail: dto.contactEmail },
        },
      });

      return tx.lead.findUnique({
        where: { id: l.id },
        include: {
          owner: { select: { id: true, firstName: true, lastName: true, email: true } },
          company: { select: { id: true, name: true, slug: true } },
          scores: { select: { totalScore: true, grade: true, breakdown: true, calculatedAt: true }, orderBy: { calculatedAt: 'desc' }, take: 1 },
        },
      });
    });

    if (!lead) {
      throw new BadRequestException('Lead creation failed');
    }

    // Auto-verify email (don't block creation)
    if (lead.contactEmail) {
      this.verifyNewLeadEmail(lead.id, lead.contactEmail, lead.website || undefined).catch(err =>
        console.error('Email verification failed for lead ' + lead.id + ':', err.message),
      );
    }

    // Run duplicate detection (don't block creation)
    let duplicateWarning = null;
    try {
      const result = await this.duplicateLeadsService.detectDuplicates(lead, currentUser);
      if (result.hasDuplicates) {
        duplicateWarning = {
          message: `Found ${result.duplicates.length} potential duplicate lead(s)`,
          duplicateCount: result.duplicates.length,
          reviewUrl: '/duplicate-leads',
        };
      }
    } catch {
      // Silently ignore detection errors
    }

    // Auto-score the new lead
    if (lead) {
      try {
        const scoreResult = await this.leadScoresService.calculateAndSave(lead.id, currentUser);
        lead.leadScore = scoreResult.totalScore;
        lead.leadGrade = scoreResult.grade;
      } catch {
        // Silently ignore scoring errors
      }
    }

    return { ...lead, isPinned: (lead as any).pins?.length > 0, duplicateWarning };
  }

  async update(id: string, dto: UpdateLeadDto, currentUser: any) {
    const lead = await this.prisma.lead.findUnique({ where: { id } });
    if (!lead || lead.deletedAt) {
      throw new NotFoundException('Lead not found');
    }

    await this.checkLeadAccess(currentUser, lead);
    await this.checkWriteAccess(currentUser, lead.companyId);

    const updateData: any = { ...dto };
    if (dto.companyName !== undefined) {
      updateData.companyNameSource = 'manual_confirmed';
      updateData.companyNameConfidence = 'high';
    }
    if (dto.website !== undefined && !dto.websiteDomain) {
      updateData.websiteDomain = dto.website ? this.extractDomain(dto.website) : null;
    }
    if (dto.lastContactedAt !== undefined) {
      updateData.lastContactedAt = dto.lastContactedAt ? new Date(dto.lastContactedAt) : null;
    }
    if (dto.nextFollowUpAt !== undefined) {
      updateData.nextFollowUpAt = dto.nextFollowUpAt ? new Date(dto.nextFollowUpAt) : null;
    }

    const updated = await this.prisma.$transaction(async (tx) => {
      const l = await tx.lead.update({ where: { id }, data: updateData });

      const ownerChanged = dto.ownerUserId !== undefined && dto.ownerUserId !== lead.ownerUserId;

      await tx.leadActivity.create({
        data: {
          companyId: lead.companyId,
          leadId: id,
          userId: currentUser.id,
          activityType: ownerChanged ? 'owner_changed' : 'lead_updated',
          title: ownerChanged ? 'Lead owner changed' : 'Lead updated',
          description: ownerChanged
            ? `Changed owner for "${l.companyName}"`
            : `Updated lead "${l.companyName}"`,
        },
      });

      await tx.auditLog.create({
        data: {
          companyId: lead.companyId,
          userId: currentUser.id,
          action: 'update_lead',
          entityType: 'Lead',
          entityId: id,
          oldValue: { companyName: lead.companyName, status: lead.status },
          newValue: { companyName: l.companyName, status: l.status },
        },
      });

      return l;
    });

    // Run duplicate detection after update
    let duplicateWarning: any = null;
    try {
      const detection = await this.duplicateLeadsService.detectDuplicates(updated, currentUser);
      if (detection.hasDuplicates) {
        duplicateWarning = {
          message: `Found ${detection.duplicates.length} potential duplicate lead(s)`,
          duplicateCount: detection.duplicates.length,
          reviewUrl: '/duplicate-leads',
        };
      }
    } catch {
      // Silently ignore detection errors
    }

    // Auto-score after update
    try {
      await this.leadScoresService.autoScore(updated.id);
    } catch {
      // Silently ignore
    }

    // Auto-generate follow-up reminders
    this.followUpRemindersService.generateForLead(updated.id).catch(() => {});

    const result = await this.findOne(updated.id, currentUser);
    if (duplicateWarning) {
      (result as any).duplicateWarning = duplicateWarning;
    }
    return result;
  }

  /** 手动更新客户语言 */
  async updateLanguage(id: string, language: string, currentUser: any) {
    const lead = await this.prisma.lead.findUnique({ where: { id } });
    if (!lead || lead.deletedAt) {
      throw new NotFoundException('Lead not found');
    }
    await this.checkLeadAccess(currentUser, lead);
    await this.checkWriteAccess(currentUser, lead.companyId);

    const updated = await this.prisma.lead.update({
      where: { id },
      data: { language },
      select: { id: true, language: true, companyName: true },
    });

    this.logger.log(`Language updated for lead "${updated.companyName}": ${language}`);
    return updated;
  }

  async remove(id: string, currentUser: any) {
    const lead = await this.prisma.lead.findUnique({ where: { id } });
    if (!lead || lead.deletedAt) {
      throw new NotFoundException('Lead not found');
    }

    await this.checkLeadAccess(currentUser, lead);
    await this.checkWriteAccess(currentUser, lead.companyId);

    await this.prisma.$transaction(async (tx) => {
      await tx.lead.update({
        where: { id },
        data: { deletedAt: new Date() },
      });

      await tx.leadActivity.create({
        data: {
          companyId: lead.companyId,
          leadId: id,
          userId: currentUser.id,
          activityType: 'lead_deleted',
          title: 'Lead deleted',
          description: `Deleted lead "${lead.companyName}"`,
        },
      });

      await tx.auditLog.create({
        data: {
          companyId: lead.companyId,
          userId: currentUser.id,
          action: 'delete_lead',
          entityType: 'Lead',
          entityId: id,
        },
      });
    });

    return { message: 'Lead deleted successfully' };
  }

  async updateStatus(id: string, dto: UpdateLeadStatusDto, currentUser: any) {
    const lead = await this.prisma.lead.findUnique({ where: { id } });
    if (!lead || lead.deletedAt) {
      throw new NotFoundException('Lead not found');
    }

    await this.checkLeadAccess(currentUser, lead);
    await this.checkWriteAccess(currentUser, lead.companyId);

    const oldStatus = lead.status;

    const updated = await this.prisma.$transaction(async (tx) => {
      const l = await tx.lead.update({
        where: { id },
        data: { status: dto.status },
      });

      const isWon = dto.status === 'won';
      const isLost = dto.status === 'lost';
      let activityType = 'lead_status_changed';
      let title = 'Lead stage changed';
      if (isWon) { activityType = 'won'; title = '客户成交'; }
      else if (isLost) { activityType = 'lost'; title = 'Lead marked as lost'; }

      await tx.leadActivity.create({
        data: {
          companyId: lead.companyId,
          leadId: id,
          userId: currentUser.id,
          activityType,
          title,
          description: `Stage changed from "${oldStatus}" to "${dto.status}"`,
          metadata: { oldStatus, newStatus: dto.status },
        },
      });

      await tx.auditLog.create({
        data: {
          companyId: lead.companyId,
          userId: currentUser.id,
          action: 'update_lead_status',
          entityType: 'Lead',
          entityId: id,
          oldValue: { status: oldStatus },
          newValue: { status: dto.status },
        },
      });

      return l;
    });

    // Auto-score after status change
    try {
      await this.leadScoresService.autoScore(updated.id);
    } catch {
      // Silently ignore
    }

    // Auto-generate follow-up reminders after status change
    this.followUpRemindersService.generateForLead(updated.id).catch(() => {});

    const result = await this.findOne(updated.id, currentUser);
    return result;
  }

  async deepResearch(id: string, currentUser: any) {
    const lead = await this.prisma.lead.findUnique({
      where: { id },
      include: {
        company: true,
        owner: { select: { id: true, firstName: true, lastName: true, email: true } },
        contacts: { orderBy: [{ isPrimary: 'desc' }, { createdAt: 'desc' }] },
        emailMessages: {
          select: {
            subject: true,
            toEmail: true,
            status: true,
            sentAt: true,
            openedAt: true,
            clickedAt: true,
            createdAt: true,
          },
          orderBy: { createdAt: 'desc' },
          take: 20,
        },
        activities: {
          select: { activityType: true, title: true, description: true, occurredAt: true },
          orderBy: { occurredAt: 'desc' },
          take: 20,
        },
      },
    });
    if (!lead || lead.deletedAt) throw new NotFoundException('Lead not found');
    await this.checkLeadAccess(currentUser, lead);

    const userPreference = await this.prisma.systemSetting.findUnique({
      where: {
        companyId_key: {
          companyId: lead.companyId,
          key: `user.aiPreference.${currentUser.id}`,
        },
      },
    });

    const business = resolveBusinessContext(process.env, (lead.company.settings as Record<string, unknown>) || {});
    const prompt = `You are a B2B foreign trade research analyst for ${business.brandName}. Create a comprehensive evidence-first background investigation report for this prospect.

## OUR BUSINESS FOCUS
Products: ${business.productFocus}
Ideal buyers: ${business.targetCustomerProfile}

## OUR COMPANY (${business.brandName})
${JSON.stringify({
  name: business.brandName,
  website: lead.company.website,
  industry: lead.company.industry,
  description: lead.company.description,
  settings: lead.company.settings,
}, null, 2)}

## PROSPECT TO RESEARCH
${JSON.stringify({
  companyName: lead.companyName,
  website: lead.website,
  country: lead.country,
  city: lead.city,
  industry: lead.industry,
  mainProducts: lead.mainProducts,
  contactName: lead.contactName,
  contactTitle: lead.contactTitle,
  contactEmail: lead.contactEmail,
  contacts: lead.contacts,
  emailHistory: lead.emailMessages,
  recentActivities: lead.activities,
  notes: lead.notes,
  linkedinUrl: lead.linkedinUrl,
  facebookUrl: lead.facebookUrl,
  instagramUrl: lead.instagramUrl,
  whatsapp: lead.whatsapp,
  yearEstablished: lead.yearEstablished,
  employeeCount: lead.employeeCount,
}, null, 2)}

## SALES PREFERENCE
${userPreference?.value || 'No additional preference.'}

## INSTRUCTIONS
Create a comprehensive B2B prospect report in 9 sections. For each section:
- If information is available, provide detailed analysis
- If information is NOT available, explicitly state "未确认" (unconfirmed) and suggest how to verify
- NEVER invent facts. Mark all uncertain information clearly.
- Use the prospect's website, social media links, and any available data to research
- Provide actionable recommendations for each section

Return strict JSON with this exact structure:

{
  "executiveSummary": "One paragraph summary of key findings and recommendation",
  "companyBasicInfo": {
    "legalName": "",
    "country": "",
    "founded": "",
    "website": "",
    "industry": "",
    "employeeCount": "",
    "annualRevenue": "",
    "registrationStatus": "",
    "registrationSource": "",
    "confidence": "confirmed/unconfirmed"
  },
  "businessAddressAnalysis": {
    "registeredAddress": "",
    "operatingAddress": "",
    "addressType": "office/warehouse/home/virtual",
    "isRealOffice": true,
    "analysis": ""
  },
  "marketAnalysis": {
    "targetMarkets": [],
    "targetCustomerProfile": "",
    "brandPositioning": "",
    "priceRange": "",
    "stylePreference": "",
    "mainProductLines": []
  },
  "socialMediaAudit": {
    "platforms": [
      {"platform": "", "handle": "", "followers": 0, "engagement": "", "notes": ""}
    ],
    "overallAssessment": ""
  },
  "websiteAnalysis": {
    "platform": "",
    "isShopify": false,
    "trafficEstimate": "",
    "seoScore": "",
    "hasOnlineStore": true,
    "notes": ""
  },
  "salesEstimate": {
    "monthlyTraffic": 0,
    "conversionRate": "",
    "estimatedMonthlySales": "",
    "estimatedAnnualRevenue": "",
    "scenarios": {
      "conservative": "",
      "moderate": "",
      "optimistic": ""
    }
  },
  "keyContacts": {
    "confirmed": [
      {"name": "", "title": "", "email": "", "phone": "", "source": ""}
    ],
    "unconfirmed": [
      {"name": "", "title": "", "email": "", "howToVerify": ""}
    ],
    "backgroundAnalysis": ""
  },
  "riskAssessment": {
    "companyLegitimacy": {"score": 0, "maxScore": 5, "notes": ""},
    "brandMaturity": {"score": 0, "maxScore": 5, "notes": ""},
    "procurementPotential": {"score": 0, "maxScore": 5, "notes": ""},
    "creditRisk": {"score": 0, "maxScore": 5, "notes": ""},
    "overallScore": 0,
    "overallGrade": "",
    "recommendation": ""
  },
  "cooperationStrategy": {
    "shortTerm": "",
    "midTerm": "",
    "longTerm": "",
    "recommendedProducts": [],
    "emailAngles": [],
    "nextActions": []
  },
  "dataSources": []
}`;

    const response = await this.zhipu.chat.completions.create({
      model: process.env.ZHIPU_MODEL || 'glm-4-flash-250414',
      messages: [
        {
          role: 'system',
          content: `You are a B2B foreign trade research analyst for ${business.brandName}. Return strict JSON only.
Rules:
- Do NOT invent unverifiable facts. Mark uncertain items as "未确认" (unconfirmed).
- Every factual claim must have a data source noted.
- Provide actionable, sales-useful recommendations.
- Score each risk dimension 1-5 with justification.
- Focus on what matters for a packaging manufacturer offering ${business.productFocus} to this prospect.`,
        },
        { role: 'user', content: prompt },
      ],
      temperature: 0.3,
      max_tokens: 8000,
    });

    const report = this.parseJsonObject(response.choices[0]?.message?.content || '{}');
    const confirmedContacts = Array.isArray(report?.keyContacts?.confirmed) ? report.keyContacts.confirmed : [];
    const primaryContact = confirmedContacts.find((contact: any) => contact?.email) || confirmedContacts[0] || {};

    await this.prisma.$transaction(async (tx) => {
      await tx.lead.update({
        where: { id: lead.id },
        data: {
          country: lead.country || report?.companyBasicInfo?.country || undefined,
          industry: lead.industry || report?.companyBasicInfo?.industry || undefined,
          employeeCount: lead.employeeCount || report?.companyBasicInfo?.employeeCount || undefined,
          annualRevenue: lead.annualRevenue || report?.companyBasicInfo?.annualRevenue || undefined,
          yearEstablished: lead.yearEstablished || this.parseYear(report?.companyBasicInfo?.founded),
          mainProducts: lead.mainProducts || (Array.isArray(report?.marketAnalysis?.mainProductLines) ? report.marketAnalysis.mainProductLines.join(', ') : undefined),
          contactName: lead.contactName || primaryContact.name || undefined,
          contactTitle: lead.contactTitle || primaryContact.title || undefined,
          contactEmail: lead.contactEmail || primaryContact.email || undefined,
          notes: this.mergeResearchSummaryIntoNotes(lead.notes, report),
        },
      });

      for (const contact of confirmedContacts) {
        const email = typeof contact.email === 'string' ? contact.email.trim().toLowerCase() : '';
        if (!email) continue;
        const [firstName, ...lastParts] = String(contact.name || '').trim().split(/\s+/).filter(Boolean);
        const existing = await tx.contact.findFirst({ where: { companyId: lead.companyId, leadId: lead.id, email } });
        const contactData = {
          firstName: firstName || contact.name || 'Unknown',
          lastName: lastParts.join(' '),
          title: contact.title || undefined,
          phone: contact.phone || undefined,
          notes: contact.source ? `AI deep research source: ${contact.source}` : 'AI deep research contact',
        };
        if (existing) {
          await tx.contact.update({ where: { id: existing.id }, data: contactData });
        } else {
          await tx.contact.create({
            data: {
              companyId: lead.companyId,
              leadId: lead.id,
              email,
              isPrimary: !lead.contactEmail && email === primaryContact.email,
              ...contactData,
            },
          });
        }
      }

      await tx.leadActivity.create({
        data: {
          companyId: lead.companyId,
          leadId: lead.id,
          userId: currentUser.id,
          activityType: 'ai_deep_research',
          title: 'AI 客户深度背调报告',
          description: report.executiveSummary || report.summaryForSalesperson || 'AI generated a comprehensive customer background report.',
          metadata: { report, reportType: 'J_ORIGIN_PACKAGING_EVIDENCE_REPORT', generatedAt: new Date().toISOString() },
        },
      });
    });

    return report;
  }

  async batchOperation(dto: BatchOperationDto, currentUser: any) {
    const targetIds = dto.selectAll
      ? (await this.prisma.lead.findMany({
          where: this.buildWhereClause(currentUser, dto.filters || {}),
          select: { id: true },
        })).map((lead) => lead.id)
      : (dto.ids || []);
    const processed = targetIds.length;
    const succeeded: string[] = [];
    const failures: { id: string; reason: string }[] = [];

    const leads = await this.prisma.lead.findMany({
      where: { id: { in: targetIds }, deletedAt: null },
    });

    for (const id of targetIds) {
      try {
        const lead = leads.find((l) => l.id === id);
        if (!lead) {
          failures.push({ id, reason: 'Lead not found or already deleted' });
          continue;
        }

        await this.checkLeadAccess(currentUser, lead);
        await this.checkWriteAccess(currentUser, lead.companyId);

        if (dto.action === 'delete') {
          await this.prisma.$transaction(async (tx) => {
            await tx.lead.update({ where: { id }, data: { deletedAt: new Date() } });
            await tx.leadActivity.create({
              data: {
                companyId: lead.companyId,
                leadId: id,
                userId: currentUser.id,
                activityType: 'lead_deleted',
                title: 'Batch deleted lead',
                description: `Batch deleted lead "${lead.companyName}"`,
              },
            });
            await tx.auditLog.create({
              data: {
                companyId: lead.companyId,
                userId: currentUser.id,
                action: 'delete_lead',
                entityType: 'Lead',
                entityId: id,
              },
            });
          });
          succeeded.push(id);
        } else if (dto.action === 'updateStatus') {
          const newStatus = dto.data?.status;
          if (!newStatus) {
            failures.push({ id, reason: 'No status provided for updateStatus action' });
            continue;
          }
          const oldStatus = lead.status;
          await this.prisma.$transaction(async (tx) => {
            await tx.lead.update({ where: { id }, data: { status: newStatus } });

            const isWon = newStatus === 'won';
            const isLost = newStatus === 'lost';
            let activityType = 'lead_status_changed';
            let title = 'Batch changed lead stage';
            if (isWon) { activityType = 'won'; title = '客户成交（批量）'; }
            else if (isLost) { activityType = 'lost'; title = 'Lead marked as lost (batch)'; }

            await tx.leadActivity.create({
              data: {
                companyId: lead.companyId,
                leadId: id,
                userId: currentUser.id,
                activityType,
                title,
                description: `Stage changed from "${oldStatus}" to "${newStatus}" (batch)`,
                metadata: { oldStatus, newStatus },
              },
            });
            await tx.auditLog.create({
              data: {
                companyId: lead.companyId,
                userId: currentUser.id,
                action: 'update_lead_status',
                entityType: 'Lead',
                entityId: id,
                oldValue: { status: oldStatus },
                newValue: { status: newStatus },
              },
            });
          });
          succeeded.push(id);
        } else if (dto.action === 'assignOwner') {
          const ownerUserId = dto.data?.ownerUserId;
          if (!ownerUserId) {
            failures.push({ id, reason: 'No ownerUserId provided for assignOwner action' });
            continue;
          }
          await this.checkManagerAccess(currentUser, lead.companyId);
          const ownerRelation = await this.prisma.userCompanyRelation.findFirst({
            where: { userId: ownerUserId, companyId: lead.companyId, isActive: true },
          });
          if (!ownerRelation) {
            failures.push({ id, reason: 'Target owner is not an active member of this company' });
            continue;
          }
          const oldOwnerUserId = lead.ownerUserId;
          await this.prisma.$transaction(async (tx) => {
            await tx.lead.update({ where: { id }, data: { ownerUserId } });
            await tx.leadActivity.create({
              data: {
                companyId: lead.companyId,
                leadId: id,
                userId: currentUser.id,
                activityType: 'owner_changed',
                title: 'Batch assigned lead owner',
                description: `Owner changed from "${oldOwnerUserId || 'unassigned'}" to "${ownerUserId}" (batch)`,
                metadata: { oldOwnerUserId, ownerUserId },
              },
            });
            await tx.auditLog.create({
              data: {
                companyId: lead.companyId,
                userId: currentUser.id,
                action: 'assign_lead_owner',
                entityType: 'Lead',
                entityId: id,
                oldValue: { ownerUserId: oldOwnerUserId },
                newValue: { ownerUserId },
              },
            });
          });
          succeeded.push(id);
        }
      } catch (err: any) {
        failures.push({ id, reason: err.message || 'Unknown error' });
      }
    }

    return { processed, succeeded: succeeded.length, failed: failures.length, failures };
  }

  async exportLeads(currentUser: any, query: any, format: 'csv' | 'xlsx') {
    const where = this.buildWhereClause(currentUser, query);

    const leads = await this.prisma.lead.findMany({
      where,
      include: { owner: { select: { firstName: true, lastName: true, email: true } } },
      orderBy: { createdAt: 'desc' },
    });

    const headers = [
      'Company Name', 'Lead Name', 'Contact Name', 'Contact Email',
      'Contact Phone', 'WhatsApp', 'Country', 'City', 'Industry',
      'Product Category', 'Business Type', 'Website', 'Stage',
      'Review Status', 'Lead Grade', 'Lead Score', 'Confidence Score',
      'Owner', 'Source Type', 'Notes', 'Created At',
    ];

    const rows = leads.map((l) => [
      l.companyName, l.leadName || '', l.contactName || '', l.contactEmail || '',
      l.contactPhone || '', l.whatsapp || '', l.country || '', l.city || '',
      l.industry || '', l.productCategory || '', l.businessType || '', l.website || '',
      l.status, l.reviewStatus || '', l.leadGrade || '', l.leadScore ?? '',
      l.confidenceScore ?? '',
      l.owner ? `${l.owner.firstName} ${l.owner.lastName}` : '',
      l.sourceType || '', l.notes || '',
      l.createdAt ? new Date(l.createdAt).toISOString().split('T')[0] : '',
    ]);

    const ws = XLSX.utils.aoa_to_sheet([headers, ...rows]);

    if (format === 'csv') {
      const csv = '\uFEFF' + XLSX.utils.sheet_to_csv(ws);
      return { data: csv, contentType: 'text/csv; charset=utf-8', filename: 'leads_export.csv' };
    } else {
      const wb = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(wb, ws, 'Leads');
      const buffer = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
      return { data: buffer, contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', filename: 'leads_export.xlsx' };
    }
  }

  private buildWhereClause(currentUser: CurrentUser, query: any) {
    const where: any = { deletedAt: null };

    // Company scope: always use the active workspace. Admins can see all users inside
    // that workspace, but should not see other industry workspaces by default.
    const companyIds = getAccessibleCompanyIds(currentUser);
    where.companyId = { in: companyIds };

    // Sub-account isolation: non-admin sees only own leads
    where.ownerUserId = hasFullAccess(currentUser)
      ? (query.ownerUserId || undefined)
      : currentUser.id;

    // Filters
    if (query.status) {
      const statuses = query.status.split(',');
      where.status = statuses.length === 1 ? statuses[0] : { in: statuses };
    }
    if (query.reviewStatus) {
      const reviewStatuses = query.reviewStatus.split(',');
      where.reviewStatus = reviewStatuses.length === 1 ? reviewStatuses[0] : { in: reviewStatuses };
    }
    if (query.country) {
      const countries = query.country.split(',');
      where.country = countries.length === 1 ? countries[0] : { in: countries };
    }
    if (query.productCategory) {
      const categories = query.productCategory.split(',');
      where.productCategory = categories.length === 1 ? categories[0] : { in: categories };
    }
    if (query.tagId) {
      where.tags = { some: { tagId: query.tagId } };
    }
    if (query.createdAfter) {
      where.createdAt = { ...(where.createdAt || {}), gte: new Date(query.createdAfter) };
    }
    if (query.createdBefore) {
      where.createdAt = { ...(where.createdAt || {}), lte: new Date(query.createdBefore) };
    }
    if (query.sourceType) {
      where.sourceType = query.sourceType;
    }
    if (query.emailVerificationStatus) {
      const statuses = query.emailVerificationStatus.split(',');
      where.emailVerificationStatus = statuses.length === 1 ? statuses[0] : { in: statuses };
    }
    if (query.leadGrade) {
      const grades = query.leadGrade.split(',');
      where.leadGrade = grades.length === 1 ? grades[0] : { in: grades };
    }
    if (query.search) {
      where.OR = [
        { companyName: { contains: query.search, mode: 'insensitive' } },
        { contactEmail: { contains: query.search, mode: 'insensitive' } },
        { website: { contains: query.search, mode: 'insensitive' } },
        { contactName: { contains: query.search, mode: 'insensitive' } },
        { contactPhone: { contains: query.search, mode: 'insensitive' } },
        { whatsapp: { contains: query.search, mode: 'insensitive' } },
        {
          contactPoints: {
            some: {
              type: 'whatsapp',
              isVerified: true,
              OR: [
                { normalizedValue: { contains: query.search, mode: 'insensitive' } },
                { originalValue: { contains: query.search, mode: 'insensitive' } },
              ],
            },
          },
        },
      ];
    }
    if (query.hasEmailHistory === 'true' || query.sentFrom || query.sentTo) {
      const dateFilter: any = {};
      if (query.sentFrom) dateFilter.gte = new Date(query.sentFrom);
      if (query.sentTo) dateFilter.lte = new Date(query.sentTo);
      where.AND = [
        ...(where.AND || []),
        {
          emailMessages: {
            some: {
              deletedAt: null,
              ...(query.sentFrom || query.sentTo
                ? { OR: [{ sentAt: dateFilter }, { createdAt: dateFilter }] }
                : {}),
            },
          },
        },
      ];
    }

    this.applyEmailRoundFilters(where, query);

    return where;
  }

  private applyEmailRoundFilters(where: any, query: any) {
    const hasRound = query.outreachRound !== undefined && query.outreachRound !== null && String(query.outreachRound) !== '';
    const engagement = String(query.engagement || '').trim();
    const shouldExcludeReplied = query.includeReplied !== 'true';
    const conditions: any[] = [];

    if (hasRound) {
      const parsedRound = Number(query.outreachRound);
      const outreachRound = Number.isFinite(parsedRound) && parsedRound >= 0 ? parsedRound : 0;
      conditions.push({
        emailMessages: {
          none: {
            outreachRound,
            status: { in: LEAD_ACTIVE_ROUND_STATUSES },
            deletedAt: null,
          },
        },
      });
      if (outreachRound > 0) {
        conditions.push({
          emailMessages: {
            some: {
              outreachRound: outreachRound - 1,
              status: { in: LEAD_PREVIOUS_ROUND_STATUSES },
              deletedAt: null,
            },
          },
        });
      }
    }

    if (shouldExcludeReplied) {
      conditions.push({
        emailMessages: {
          none: {
            status: 'Replied',
            deletedAt: null,
          },
        },
      });
    }

    if (engagement === 'opened') {
      conditions.push({
        emailMessages: {
          some: {
            openedAt: { not: null },
            deletedAt: null,
          },
        },
      });
    } else if (engagement === 'clicked') {
      conditions.push({
        emailMessages: {
          some: {
            clickedAt: { not: null },
            deletedAt: null,
          },
        },
      });
    } else if (engagement === 'replied') {
      conditions.push({
        emailMessages: {
          some: {
            status: 'Replied',
            deletedAt: null,
          },
        },
      });
    }

    if (conditions.length) {
      where.AND = [...(where.AND || []), ...conditions];
    }
  }

  private getDefaultCompanyId(currentUser: CurrentUser) {
    const companyId = currentUser.companies?.[0]?.id;
    if (!companyId) throw new ForbiddenException('No company context found');
    return companyId;
  }

  private parseExternalLeadMarkdown(content: string) {
    const rows = content
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.startsWith('|') && !/^\|\s*-+/.test(line));

    const leads: Array<{
      rowNo?: string;
      companyName: string;
      country?: string;
      contactName?: string;
      contactTitle?: string;
      contactEmail?: string;
      confidence?: string;
      status?: string;
      emailVerificationStatus: string;
      emailVerificationReason: string;
      confidenceScore: number;
      leadGrade: string;
      mainProducts?: string;
    }> = [];

    for (const row of rows) {
      const cells = row.split('|').slice(1, -1).map((cell) => this.cleanMarkdownCell(cell));
      if (cells.length < 7) continue;
      const [rowNo, rawCompany, country, contactName, contactTitle, emailCell, confidence, status] = cells;
      if (!rowNo || rowNo === '#' || /品牌|鍝佺墝/i.test(rawCompany)) continue;
      const companyName = rawCompany.replace(/^~~|~~$/g, '').trim();
      if (!companyName || /removed/i.test(status) || /~~/.test(rawCompany)) continue;
      const contactEmail = this.extractEmail(emailCell);
      const confidenceText = confidence || emailCell || '';
      const confidenceScore = /high/i.test(confidenceText) ? 85 : /medium/i.test(confidenceText) ? 65 : /low/i.test(confidenceText) ? 35 : 50;
      const emailVerificationStatus = contactEmail
        ? confidenceScore >= 80
          ? 'verified_public_source'
          : confidenceScore >= 60
            ? 'mx_domain_verified'
            : 'unverified'
        : 'unverified';

      leads.push({
        rowNo,
        companyName,
        country: country || undefined,
        contactName: this.emptyToUndefined(contactName),
        contactTitle: this.emptyToUndefined(contactTitle),
        contactEmail,
        confidence,
        status,
        emailVerificationStatus,
        emailVerificationReason: `Imported from external agent markdown. Confidence: ${confidence || 'unknown'}`,
        confidenceScore,
        leadGrade: confidenceScore >= 80 ? 'A' : confidenceScore >= 60 ? 'B' : 'C',
        mainProducts: resolveBusinessContext().productFocus,
      });
    }

    return leads;
  }

  private cleanMarkdownCell(value: string) {
    return (value || '')
      .replace(/<br\s*\/?>/gi, ' ')
      .replace(/\*\*/g, '')
      .replace(/`/g, '')
      .replace(/&nbsp;/gi, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  private extractEmail(value: string) {
    const match = String(value || '').match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i);
    return match ? match[0].toLowerCase() : undefined;
  }

  private emptyToUndefined(value?: string) {
    const text = (value || '').trim();
    if (!text || ['-', '—', '–', '鈥?', '未找到', 'None'].includes(text)) return undefined;
    if (/LinkedIn|Instagram|DM|未找到|需要/i.test(text)) return undefined;
    return text;
  }

  private buildExternalLeadNotes(item: any, filePath: string, importedAt: Date) {
    return [
      `[外部Agent同步] ${importedAt.toISOString()}`,
      `来源文件: ${filePath}`,
      item.rowNo ? `档案序号: ${item.rowNo}` : '',
      item.confidence ? `可信度: ${item.confidence}` : '',
      item.status ? `原始状态: ${item.status}` : '',
      item.emailVerificationReason || '',
    ].filter(Boolean).join('\n');
  }

  private mergeExternalLeadNotes(existing: string | null | undefined, incoming: string) {
    const current = existing || '';
    const marker = incoming.split('\n')[0];
    if (marker && current.includes(marker)) return current;
    return `${incoming}${current ? `\n\n${current}` : ''}`.slice(0, 10000);
  }

  private resolveDayRange(date?: string) {
    const base = date ? new Date(`${date}T00:00:00`) : new Date();
    const start = new Date(base.getFullYear(), base.getMonth(), base.getDate());
    const end = new Date(start.getTime() + 24 * 60 * 60 * 1000);
    const yyyy = start.getFullYear();
    const mm = String(start.getMonth() + 1).padStart(2, '0');
    const dd = String(start.getDate()).padStart(2, '0');
    return { start, end, date: `${yyyy}-${mm}-${dd}` };
  }

  private resolveExternalPoolRange(dateRange?: string, date?: string) {
    const mode = dateRange || (date ? 'custom' : 'all');
    if (mode === 'all') return { dateRange: 'all', date: null as string | null, filter: null as any };
    if (mode === '7d' || mode === '30d') {
      const days = mode === '7d' ? 7 : 30;
      const now = new Date();
      const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
      return {
        dateRange: mode,
        date: null as string | null,
        filter: { gte: new Date(todayStart.getTime() - (days - 1) * 24 * 60 * 60 * 1000) },
      };
    }
    const range = this.resolveDayRange(mode === 'today' ? undefined : date);
    return { dateRange: mode === 'custom' ? 'custom' : 'today', date: range.date, filter: { gte: range.start, lt: range.end } };
  }

  private buildExternalVerificationCondition(bucket?: string) {
    if (!bucket || bucket === 'all') return null;
    if (bucket === 'ready') return { emailVerificationStatus: { in: [...VERIFIED_EMAIL_STATUSES] } };
    if (bucket === 'failed') return { emailVerificationStatus: { in: [...FAILED_EMAIL_STATUSES] } };
    if (bucket === 'review') return { emailVerificationStatus: { in: [...REVIEW_EMAIL_STATUSES] } };
    return null;
  }

  private async getSalesUsers(companyId: string, selectedUserIds?: string[]) {
    const relations = await this.prisma.userCompanyRelation.findMany({
      where: {
        companyId,
        isActive: true,
        ...(selectedUserIds?.length ? { userId: { in: selectedUserIds } } : {}),
        role: { name: { in: ['sales_user'] } },
        user: { isActive: true, deletedAt: null },
      },
      include: { user: { select: { id: true, firstName: true, lastName: true, email: true } }, role: true },
      orderBy: { joinedAt: 'asc' },
    });
    return relations.map((relation) => ({
      id: relation.user.id,
      firstName: relation.user.firstName,
      lastName: relation.user.lastName,
      email: relation.user.email,
      role: relation.role.name,
    }));
  }

  private async checkLeadAccess(currentUser: CurrentUser, lead: any) {
    if (hasFullAccess(currentUser)) return;

    // Company scope check
    const userCompanyIds = getAccessibleCompanyIds(currentUser);
    if (!userCompanyIds.includes(lead.companyId)) {
      throw new ForbiddenException('Cannot access leads from another company');
    }

    // Sub-account isolation: non-admin can only access own leads
    if (lead.ownerUserId && lead.ownerUserId !== currentUser.id) {
      throw new ForbiddenException('You can only access your own leads');
    }
  }

  private async checkWriteAccess(currentUser: CurrentUser, companyId: string) {
    if (hasFullAccess(currentUser)) return;

    const company = currentUser.companies?.find((c: any) => c.id === companyId);
    if (!company) {
      throw new ForbiddenException('Not a member of this company');
    }

    if (company.role === 'viewer') {
      throw new ForbiddenException('Viewer cannot modify leads');
    }
  }

  private async checkManagerAccess(currentUser: CurrentUser, companyId: string) {
    if (hasFullAccess(currentUser)) return;

    const company = currentUser.companies?.find((c: any) => c.id === companyId);
    if (!company) {
      throw new ForbiddenException('Not a member of this company');
    }

    const allowedRoles = ['company_admin', 'sales_manager'];
    if (!allowedRoles.includes(company.role)) {
      throw new ForbiddenException('Only managers can assign leads');
    }
  }


  // ========== Email Verification ==========

  async verifyLeadEmail(currentUser: any, leadId: string) {
    const lead = await this.prisma.lead.findUnique({ where: { id: leadId } });
    if (!lead || lead.deletedAt) throw new NotFoundException('Lead not found');
    await this.checkWriteAccess(currentUser, lead.companyId);
    await this.verifyNewLeadEmail(lead.id, lead.contactEmail || '', lead.website || lead.websiteDomain || undefined);
    const updated = await this.prisma.lead.findUnique({
      where: { id: lead.id },
      select: { id: true, emailVerificationStatus: true, emailVerificationReason: true },
    });
    return updated;
  }

  async verifyLeadEmails(currentUser: any, dto: {
    leadIds?: string[];
    assigned?: string;
    date?: string;
    dateRange?: string;
    sourceTypes?: string[];
  }) {
    const companyId = this.getDefaultCompanyId(currentUser);
    await this.checkManagerAccess(currentUser, companyId);
    const range = this.resolveExternalPoolRange(dto.dateRange, dto.date);
    const sourceTypes = dto.sourceTypes?.length ? dto.sourceTypes : EXTERNAL_POOL_SOURCE_TYPES;
    const where: any = {
      companyId,
      deletedAt: null,
      sourceType: { in: sourceTypes },
      ...(range.filter ? { collectedAt: range.filter } : {}),
    };
    if (dto.leadIds?.length) where.id = { in: dto.leadIds };
    if (!dto.leadIds?.length) {
      const assigned = dto.assigned || 'unassigned';
      if (assigned === 'unassigned') where.ownerUserId = null;
      if (assigned === 'assigned') where.ownerUserId = { not: null };
    }

    const leads = await this.prisma.lead.findMany({
      where,
      select: {
        id: true,
        contactEmail: true,
        website: true,
        websiteDomain: true,
        emailVerificationStatus: true,
      },
      take: 1000,
      orderBy: [{ collectedAt: 'desc' }, { createdAt: 'desc' }],
    });

    let queued = 0;
    let skipped = 0;
    let alreadyVerified = 0;
    let invalid = 0;
    const results: Array<{ id: string; status: string; reason?: string | null }> = [];

    for (const lead of leads) {
      if (!lead.contactEmail || !VALID_EMAIL_REGEX.test(lead.contactEmail)) {
        skipped += 1;
        invalid += 1;
        if (lead.contactEmail) {
          await this.prisma.lead.update({
            where: { id: lead.id },
            data: { emailVerificationStatus: 'rejected', emailVerificationReason: 'Invalid email format' },
          });
        }
        continue;
      }
      if (VERIFIED_EMAIL_STATUSES.has(lead.emailVerificationStatus)) {
        alreadyVerified += 1;
        results.push({ id: lead.id, status: lead.emailVerificationStatus });
        continue;
      }
      await this.verifyNewLeadEmail(lead.id, lead.contactEmail, lead.website || lead.websiteDomain || undefined);
      queued += 1;
      const updated = await this.prisma.lead.findUnique({
        where: { id: lead.id },
        select: { id: true, emailVerificationStatus: true, emailVerificationReason: true },
      });
      if (updated?.emailVerificationStatus === 'rejected') invalid += 1;
      results.push({ id: lead.id, status: updated?.emailVerificationStatus || 'unverified', reason: updated?.emailVerificationReason });
    }

    return { queued, skipped, alreadyVerified, invalid, total: leads.length, results };
  }

  async verifyNewLeadEmail(leadId: string, contactEmail: string, website?: string): Promise<void> {
    if (!contactEmail || !VALID_EMAIL_REGEX.test(contactEmail)) return;

    const [localPart, domain] = contactEmail.toLowerCase().split('@');
    const mailbox = localPart.split(/[.+_-]/)[0];
    if (VERIFY_PLACEHOLDER_DOMAINS.has(domain) || VERIFY_PLACEHOLDER_LOCALS.has(localPart) || /^(john|jane)([._-]?doe)?\d*$/.test(localPart) || /^test\d*$/.test(localPart)) {
      await this.prisma.lead.update({
        where: { id: leadId },
        data: { emailVerificationStatus: 'rejected', emailVerificationReason: 'Placeholder email is not a real customer mailbox' },
      });
      return;
    }

    const reacherResult = await this.verifyWithReacher(contactEmail.toLowerCase());
    if (reacherResult === true) {
      await this.prisma.lead.update({
        where: { id: leadId },
        data: { emailVerificationStatus: 'smtp_verified', emailVerificationReason: 'Reacher accepted the mailbox as reachable' },
      });
      return;
    }
    if (reacherResult === false) {
      await this.prisma.lead.update({
        where: { id: leadId },
        data: { emailVerificationStatus: 'rejected', emailVerificationReason: 'Reacher rejected the mailbox' },
      });
      return;
    }

    if (VERIFY_FREE_DOMAINS.has(domain)) {
      await this.prisma.lead.update({
        where: { id: leadId },
        data: { emailVerificationStatus: 'rejected', emailVerificationReason: 'Free mailbox not allowed for cold outreach' },
      });
      return;
    }

    if (VERIFY_BLOCKED_MAILBOXES.has(mailbox)) {
      await this.prisma.lead.update({
        where: { id: leadId },
        data: { emailVerificationStatus: 'rejected', emailVerificationReason: `Blocked mailbox "${mailbox}" is not suitable for cold outreach` },
      });
      return;
    }

    const hasMx = await this.hasMxRecord(domain);
    if (!hasMx) {
      await this.prisma.lead.update({
        where: { id: leadId },
        data: { emailVerificationStatus: 'rejected', emailVerificationReason: 'Email domain has no MX record' },
      });
      return;
    }

    const websiteDomain = this.extractDomain(website || '');
    const domainMatches = websiteDomain && (domain === websiteDomain || domain.endsWith('.' + websiteDomain));
    const isBusinessMailbox = VERIFY_BUSINESS_MAILBOXES.has(mailbox);

    const status = domainMatches || isBusinessMailbox ? 'official_page_verified' : 'mx_domain_verified';
    const reason = domainMatches
      ? 'Auto verified: email domain matches lead website and MX exists'
      : isBusinessMailbox
        ? `Auto verified: business mailbox "${mailbox}" with valid MX`
        : 'Auto verified: MX exists, mailbox role needs manual review';

    await this.prisma.lead.update({
      where: { id: leadId },
      data: { emailVerificationStatus: status, emailVerificationReason: reason },
    });
  }

  private async verifyWithReacher(email: string): Promise<boolean | null> {
    const apiUrl = process.env.REACHER_API_URL;
    if (!apiUrl) return null;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10000);
    try {
      const baseUrl = apiUrl.replace(/\/$/, '');
      const endpoints = baseUrl.endsWith('/check_email')
        ? [baseUrl]
        : [`${baseUrl}/v0/check_email`, `${baseUrl}/v1/check_email`];
      for (const endpoint of endpoints) {
        try {
          const response = await fetch(endpoint, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ to_email: email }),
            signal: controller.signal,
          });
          if (!response.ok) continue;
          const data: any = await response.json().catch(() => null);
          const status = String(data?.is_reachable || data?.status || data?.result || '').toLowerCase();
          if (data?.is_reachable === 'safe' || data?.is_reachable === true || status === 'safe' || status === 'valid' || status === 'reachable') return true;
          if (data?.is_reachable === 'invalid' || data?.is_reachable === false || status === 'invalid' || status === 'rejected' || status === 'unreachable') return false;
        } catch (err: any) {
          this.logger?.error?.('Email verification API call failed: ' + (err?.message || err), err?.stack);
        }
      }
      return null;
    } catch {
      return null;
    } finally {
      clearTimeout(timer);
    }
  }

  private async hasMxRecord(domain: string): Promise<boolean> {
    const timeoutMs = Number(process.env.EMAIL_VERIFY_DNS_TIMEOUT_MS || 5000);
    const withTimeout = <T>(promise: Promise<T>) => Promise.race([
      promise,
      new Promise<T>((_, reject) => setTimeout(() => reject(Object.assign(new Error(`MX lookup timeout after ${timeoutMs}ms`), { code: 'ETIMEOUT' })), timeoutMs)),
    ]);
    try {
      const records = await withTimeout(resolveMx(domain));
      return records.length > 0;
    } catch (error: any) {
      if (!['ECONNREFUSED', 'ETIMEOUT', 'EAI_AGAIN', 'ENOTFOUND'].includes(error?.code)) {
        return false;
      }
      for (const server of ['223.5.5.5', '114.114.114.114', '8.8.8.8', '1.1.1.1']) {
        try {
          const resolver = new Resolver();
          resolver.setServers([server]);
          const records = await withTimeout(resolver.resolveMx(domain));
          if (records.length > 0) return true;
        } catch (err: any) {
          this.logger?.error?.('MX record DNS fallback lookup failed: ' + (err?.message || err), err?.stack);
        }
      }
      return false;
    }
  }

  private extractDomain(url: string): string {
    try {
      const u = new URL(url);
      return u.hostname.replace(/^www\./, '');
    } catch {
      return url;
    }
  }

  private parseYear(value: any): number | undefined {
    const match = String(value || '').match(/\b(19|20)\d{2}\b/);
    return match ? Number(match[0]) : undefined;
  }

  private mergeResearchSummaryIntoNotes(notes: string | null | undefined, report: any): string {
    const summary = [
      'AI Deep Research Summary',
      report?.executiveSummary || '',
      report?.riskAssessment?.recommendation ? `Recommendation: ${report.riskAssessment.recommendation}` : '',
      Array.isArray(report?.cooperationStrategy?.nextActions) ? `Next actions: ${report.cooperationStrategy.nextActions.join('; ')}` : '',
    ].filter(Boolean).join('\n');
    const existing = notes || '';
    if (!summary || existing.includes('AI Deep Research Summary')) return existing || summary;
    return `${existing}${existing ? '\n\n' : ''}${summary}`.slice(0, 10000);
  }

    // ========== Tag Management ==========

  async addTagsToLead(leadId: string, tagIds: string[], userId: string) {
    const lead = await this.prisma.lead.findUnique({ where: { id: leadId } });
    if (!lead || lead.deletedAt) throw new NotFoundException('Lead not found');
    return this.tagsService.addTagsToLead(leadId, tagIds, userId);
  }

  async removeTagFromLead(leadId: string, tagId: string, currentUser: any) {
    const lead = await this.prisma.lead.findUnique({ where: { id: leadId } });
    if (!lead || lead.deletedAt) throw new NotFoundException('Lead not found');
    if (!hasFullAccess(currentUser) && lead.ownerUserId !== currentUser.id) {
      throw new ForbiddenException('You can only modify tags on your own leads');
    }
    return this.tagsService.removeTagFromLead(leadId, tagId);
  }

  async pinLead(leadId: string, currentUser: any) {
    const lead = await this.prisma.lead.findUnique({ where: { id: leadId } });
    if (!lead || lead.deletedAt) throw new NotFoundException('Lead not found');
    await this.checkLeadAccess(currentUser, lead);

    await this.prisma.leadPin.upsert({
      where: { leadId_userId: { leadId, userId: currentUser.id } },
      update: {},
      create: { companyId: lead.companyId, leadId, userId: currentUser.id },
    });
    return { pinned: true };
  }

  async unpinLead(leadId: string, currentUser: any) {
    await this.prisma.leadPin.deleteMany({ where: { leadId, userId: currentUser.id } });
    return { pinned: false };
  }

  async autoTagFromAiAnalysis(leadId: string, aiAnalysis: any, searchTaskCustomerType?: string, userId?: string) {
    const companyId = (await this.prisma.lead.findUnique({ where: { id: leadId }, select: { companyId: true } }))?.companyId;
    if (!companyId) return;
    const allTags = await this.prisma.tag.findMany({ where: { companyId } });
    const tagIds: string[] = [];
    const category = aiAnalysis?.industryCategory || searchTaskCustomerType || '';
    for (const tag of allTags) {
      if (tag.name.toLowerCase().includes(category.toLowerCase()) || category.toLowerCase().includes(tag.name.toLowerCase())) {
        tagIds.push(tag.id);
      }
    }
    if ((aiAnalysis?.confidenceScore || 0) > 80) {
      const highConf = allTags.find(t => t.name === 'High Confidence');
      if (highConf) tagIds.push(highConf.id);
    }
    if (tagIds.length > 0 && userId) {
      await this.tagsService.addTagsToLead(leadId, [...new Set(tagIds)], userId);
    }
  }

  private parseJsonObject(content: string): any {
    const clean = content.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
    try {
      const parsed = JSON.parse(clean);
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
    } catch {
      const match = clean.match(/\{[\s\S]*\}/);
      if (!match) return {};
      try {
        const parsed = JSON.parse(match[0]);
        return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
      } catch {
        return {};
      }
    }
  }
}
