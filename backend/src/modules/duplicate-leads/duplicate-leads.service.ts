import {
  Injectable,
  NotFoundException,
  ForbiddenException,
  BadRequestException,
} from '@nestjs/common';
import { PrismaService } from '../../common/prisma/prisma.service';
import { LeadScoresService } from '../lead-scores/lead-scores.service';
import { TimelineService } from '../timeline/timeline.service';
import { QueryDuplicateLeadsDto } from './dto/query-duplicate-leads.dto';
import { UpdateDuplicateStatusDto } from './dto/update-duplicate-status.dto';
import { MergeDuplicateLeadsDto } from './dto/merge-duplicate-leads.dto';

@Injectable()
export class DuplicateLeadsService {
  constructor(
    private prisma: PrismaService,
    private leadScoresService: LeadScoresService,
    private timelineService: TimelineService,
  ) {}

  async findAll(currentUser: any, query: QueryDuplicateLeadsDto) {
    const page = query.page || 1;
    const limit = query.limit || 20;
    const skip = (page - 1) * limit;

    const companyIds = currentUser.companies?.map((c: any) => c.id) || [];
    const isFullAccess = currentUser.companies?.some(
      (c: any) => ['super_admin', 'company_admin'].includes(c.role),
    );

    const where: any = { companyId: { in: companyIds } };

    if (!isFullAccess) {
      where.primaryLead = { ownerUserId: currentUser.id };
    }

    if (query.status) {
      where.status = query.status;
    }
    if (query.matchType) {
      where.matchType = query.matchType;
    }
    if (query.matchScoreMin) {
      where.matchScore = { gte: query.matchScoreMin };
    }
    if (query.leadId) {
      where.OR = [
        { primaryLeadId: query.leadId },
        { duplicateLeadId: query.leadId },
      ];
    }
    if (query.keyword) {
      where.OR = [
        ...(where.OR || []),
        {
          primaryLead: {
            companyName: { contains: query.keyword, mode: 'insensitive' },
          },
        },
        {
          duplicateLead: {
            companyName: { contains: query.keyword, mode: 'insensitive' },
          },
        },
        { matchReason: { contains: query.keyword, mode: 'insensitive' } },
      ];
    }

    const [data, total] = await Promise.all([
      this.prisma.duplicateLead.findMany({
        where,
        include: {
          primaryLead: {
            select: {
              id: true, companyName: true, contactName: true, contactEmail: true,
              country: true, website: true, status: true, leadGrade: true,
              owner: { select: { id: true, firstName: true, lastName: true, email: true } },
            },
          },
          duplicateLead: {
            select: {
              id: true, companyName: true, contactName: true, contactEmail: true,
              country: true, website: true, status: true, leadGrade: true,
              owner: { select: { id: true, firstName: true, lastName: true, email: true } },
            },
          },
        },
        skip,
        take: limit,
        orderBy: { createdAt: 'desc' },
      }),
      this.prisma.duplicateLead.count({ where }),
    ]);

    return {
      data,
      meta: { page, limit, total, totalPages: Math.ceil(total / limit) },
    };
  }

  async findOne(id: string, currentUser: any) {
    const record = await this.prisma.duplicateLead.findUnique({
      where: { id },
      include: {
        primaryLead: {
          include: {
            owner: { select: { id: true, firstName: true, lastName: true, email: true } },
            company: { select: { id: true, name: true, slug: true } },
          },
        },
        duplicateLead: {
          include: {
            owner: { select: { id: true, firstName: true, lastName: true, email: true } },
            company: { select: { id: true, name: true, slug: true } },
          },
        },
      },
    });

    if (!record) throw new NotFoundException('Duplicate lead record not found');
    await this.checkAccess(currentUser, record);
    return record;
  }

  async checkLead(leadId: string, currentUser: any) {
    const lead = await this.prisma.lead.findUnique({ where: { id: leadId } });
    if (!lead || lead.deletedAt) throw new NotFoundException('Lead not found');

    const isSuperAdmin = currentUser.companies?.some(
      (c: any) => c.role === 'super_admin',
    );
    if (!isSuperAdmin) {
      const companyIds = currentUser.companies?.map((c: any) => c.id) || [];
      if (!companyIds.includes(lead.companyId)) {
        throw new ForbiddenException('Cannot access leads from another company');
      }
    }

    return this.detectDuplicates(lead, currentUser);
  }

  async updateStatus(id: string, dto: UpdateDuplicateStatusDto, currentUser: any) {
    const record = await this.prisma.duplicateLead.findUnique({ where: { id } });
    if (!record) throw new NotFoundException('Duplicate lead record not found');
    await this.checkAccess(currentUser, record);
    await this.checkWriteAccess(currentUser, record.companyId);

    const updated = await this.prisma.duplicateLead.update({
      where: { id },
      data: {
        status: dto.status,
        reviewedBy: currentUser.id,
        reviewedAt: new Date(),
        resolvedAt: dto.status === 'confirmed' || dto.status === 'not_duplicate' ? new Date() : undefined,
        resolvedBy: dto.status === 'confirmed' || dto.status === 'not_duplicate' ? currentUser.id : undefined,
      },
    });

    return updated;
  }

  async merge(id: string, dto: MergeDuplicateLeadsDto, currentUser: any) {
    const record = await this.prisma.duplicateLead.findUnique({
      where: { id },
      include: {
        primaryLead: true,
        duplicateLead: true,
      },
    });
    if (!record) throw new NotFoundException('Duplicate lead record not found');
    if (record.status === 'merged') throw new BadRequestException('Already merged');
    await this.checkAccess(currentUser, record);
    await this.checkWriteAccess(currentUser, record.companyId);

    const primary = record.primaryLead;
    const duplicate = record.duplicateLead;

    const mergeResult = await this.prisma.$transaction(async (tx) => {
      const updateData: any = {};

      const mergeableFields = [
        'companyName', 'leadName', 'website', 'websiteDomain', 'country', 'city',
        'industry', 'productCategory', 'businessType', 'contactName', 'contactTitle',
        'contactEmail', 'contactPhone', 'whatsapp', 'linkedinUrl', 'facebookUrl',
        'sourceUrl', 'sourceType', 'sourceKeyword', 'sourceCountry',
        'confidenceScore', 'leadScore', 'leadGrade',
      ];

      const fieldChoices = dto.fieldChoices || {};

      for (const field of mergeableFields) {
        const choice = fieldChoices[field];
        if (choice === duplicate.id) {
          updateData[field] = (duplicate as any)[field];
        }
      }

      // Merge notes
      if (dto.notes || duplicate.notes) {
        const parts: string[] = [];
        if (primary.notes) parts.push(primary.notes);
        if (duplicate.notes) parts.push(`[Merged from ${duplicate.companyName}]: ${duplicate.notes}`);
        if (dto.notes) parts.push(dto.notes);
        updateData.notes = parts.join('\n\n');
      }

      const updated = await tx.lead.update({
        where: { id: primary.id },
        data: updateData,
      });

      await tx.lead.update({
        where: { id: duplicate.id },
        data: { deletedAt: new Date() },
      });

      await tx.duplicateLead.update({
        where: { id: record.id },
        data: {
          status: 'merged',
          mergedAt: new Date(),
          mergedBy: currentUser.id,
          mergeResult: { fieldChoices: dto.fieldChoices, notes: dto.notes },
          resolvedAt: new Date(),
          resolvedBy: currentUser.id,
        },
      });

      // Also merge other pending duplicates involving the duplicate lead
      const otherDuplicates = await tx.duplicateLead.findMany({
        where: {
          OR: [
            { primaryLeadId: duplicate.id, status: { not: 'merged' } },
            { duplicateLeadId: duplicate.id, status: { not: 'merged' } },
          ],
        },
      });

      for (const dup of otherDuplicates) {
        await tx.duplicateLead.update({
          where: { id: dup.id },
          data: { status: 'merged', resolvedAt: new Date(), resolvedBy: currentUser.id },
        });
      }

      await tx.auditLog.create({
        data: {
          companyId: record.companyId,
          userId: currentUser.id,
          action: 'merge_lead',
          entityType: 'Lead',
          entityId: primary.id,
          newValue: {
            mergedFrom: duplicate.id,
            fieldChoices: dto.fieldChoices,
            mergedLeadName: duplicate.companyName,
          },
        },
      });

      return { mergedLead: updated, mergedFrom: duplicate.id };
    });

    // Auto-score the merged lead
    this.leadScoresService.autoScore(primary.id);

    // Log merge activity
    await this.timelineService.logActivity({
      companyId: record.companyId,
      leadId: primary.id,
      userId: currentUser.id,
      activityType: 'lead_merged',
      title: '合并了客户',
      description: `将 "${duplicate.companyName}" 合并入 "${primary.companyName}"`,
      metadata: { mergedLeadId: duplicate.id, fieldChoices: dto.fieldChoices },
    });

    return mergeResult;
  }

  async detectDuplicates(lead: any, currentUser?: any) {
    const companyId = lead.companyId;
    const results: any[] = [];
    const seenIds = new Set<string>();

    // Find other leads in same company (not deleted, not this lead)
    const otherLeads = await this.prisma.lead.findMany({
      where: {
        companyId,
        deletedAt: null,
        id: { not: lead.id },
      },
    });

    for (const other of otherLeads) {
      const matches = this.findMatches(lead, other);
      if (matches.length > 0) {
        // Check for existing record first (one record per lead pair)
        const existing = await this.prisma.duplicateLead.findFirst({
          where: {
            OR: [
              { primaryLeadId: lead.id, duplicateLeadId: other.id },
              { primaryLeadId: other.id, duplicateLeadId: lead.id },
            ],
          },
        });

        if (existing) {
          if (!seenIds.has(existing.id)) {
            results.push(existing);
            seenIds.add(existing.id);
          }
        } else {
          // Use the highest-score match for the new record
          matches.sort((a, b) => b.score - a.score);
          const bestMatch = matches[0];
          const created = await this.prisma.duplicateLead.create({
            data: {
              companyId,
              primaryLeadId: lead.id,
              duplicateLeadId: other.id,
              matchType: bestMatch.type,
              matchScore: bestMatch.score,
              matchReason: bestMatch.reason,
              matchFields: bestMatch.fields,
            },
          });
          results.push(created);
          seenIds.add(created.id);

          await this.timelineService.logActivity({
            companyId,
            leadId: lead.id,
            activityType: 'duplicate_detected',
            title: '发现了疑似重复客户',
            description: `发现疑似重复: "${other.companyName}" - ${bestMatch.reason}`,
            referenceType: 'DuplicateLead',
            referenceId: created.id,
            metadata: { matchScore: bestMatch.score, duplicateLeadId: other.id },
          }).catch(() => {});
        }
      }
    }

    return { duplicates: results, hasDuplicates: results.length > 0 };
  }

  private findMatches(lead: any, other: any): Array<{ type: string; score: number; reason: string; fields: any }> {
    const matches: Array<{ type: string; score: number; reason: string; fields: any }> = [];

    // 1. Email exact match
    if (lead.contactEmail && other.contactEmail &&
        lead.contactEmail.toLowerCase() === other.contactEmail.toLowerCase()) {
      matches.push({
        type: 'EMAIL_EXACT',
        score: 100,
        reason: `Same contact email: ${lead.contactEmail}`,
        fields: { email: lead.contactEmail },
      });
    }

    // 2. Domain exact match
    if (lead.websiteDomain && other.websiteDomain &&
        lead.websiteDomain.toLowerCase() === other.websiteDomain.toLowerCase()) {
      matches.push({
        type: 'DOMAIN_EXACT',
        score: 90,
        reason: `Same website domain: ${lead.websiteDomain}`,
        fields: { domain: lead.websiteDomain },
      });
    }

    // 3. Phone exact match
    if (lead.contactPhone && other.contactPhone &&
        lead.contactPhone.replace(/[\s\-\(\)]/g, '') === other.contactPhone.replace(/[\s\-\(\)]/g, '')) {
      matches.push({
        type: 'PHONE_EXACT',
        score: 85,
        reason: `Same phone: ${lead.contactPhone}`,
        fields: { phone: lead.contactPhone },
      });
    }

    // 3b. WhatsApp match
    if (lead.whatsapp && other.whatsapp &&
        lead.whatsapp.replace(/[\s\-\(\)]/g, '') === other.whatsapp.replace(/[\s\-\(\)]/g, '')) {
      matches.push({
        type: 'PHONE_EXACT',
        score: 85,
        reason: `Same WhatsApp: ${lead.whatsapp}`,
        fields: { whatsapp: lead.whatsapp },
      });
    }

    // 4. LinkedIn URL exact match
    if (lead.linkedinUrl && other.linkedinUrl &&
        lead.linkedinUrl.toLowerCase() === other.linkedinUrl.toLowerCase()) {
      matches.push({
        type: 'LINKEDIN_EXACT',
        score: 90,
        reason: `Same LinkedIn URL: ${lead.linkedinUrl}`,
        fields: { linkedinUrl: lead.linkedinUrl },
      });
    }

    // 5. Company name similarity
    if (lead.companyName && other.companyName) {
      const similarity = this.calculateSimilarity(lead.companyName, other.companyName);
      if (similarity >= 0.75) {
        const score = Math.round(similarity * 100);
        matches.push({
          type: 'COMPANY_NAME_SIMILAR',
          score,
          reason: `Similar company names: "${lead.companyName}" ↔ "${other.companyName}" (${Math.round(similarity * 100)}%)`,
          fields: { companyNameSimilarity: similarity },
        });
      }
    }

    // 6. Contact name + company name similar
    if (lead.contactName && other.contactName && lead.companyName && other.companyName) {
      const nameSim = this.calculateSimilarity(lead.contactName, other.contactName);
      const companySim = this.calculateSimilarity(lead.companyName, other.companyName);
      if (nameSim >= 0.6 && companySim >= 0.6) {
        const score = Math.round(((nameSim + companySim) / 2) * 100);
        matches.push({
          type: 'CONTACT_COMPANY_SIMILAR',
          score,
          reason: `Similar contact (${Math.round(nameSim * 100)}%) and company (${Math.round(companySim * 100)}%): "${lead.contactName}" / "${lead.companyName}"`,
          fields: { contactNameSimilarity: nameSim, companyNameSimilarity: companySim },
        });
      }
    }

    return matches;
  }

  private calculateSimilarity(a: string, b: string): number {
    const s1 = a.toLowerCase().replace(/[^a-z0-9\s]/g, '').trim();
    const s2 = b.toLowerCase().replace(/[^a-z0-9\s]/g, '').trim();
    if (s1 === s2) return 1.0;
    if (s1.length === 0 || s2.length === 0) return 0;

    const longer = s1.length > s2.length ? s1 : s2;
    const shorter = s1.length > s2.length ? s2 : s1;

    if (longer.length === 0) return 0;

    const distance = this.levenshteinDistance(longer, shorter);
    return 1 - distance / longer.length;
  }

  private levenshteinDistance(a: string, b: string): number {
    const matrix: number[][] = [];
    for (let i = 0; i <= a.length; i++) {
      matrix[i] = [i];
    }
    for (let j = 0; j <= b.length; j++) {
      matrix[0][j] = j;
    }
    for (let i = 1; i <= a.length; i++) {
      for (let j = 1; j <= b.length; j++) {
        if (a[i - 1] === b[j - 1]) {
          matrix[i][j] = matrix[i - 1][j - 1];
        } else {
          matrix[i][j] = Math.min(
            matrix[i - 1][j - 1] + 1,
            matrix[i][j - 1] + 1,
            matrix[i - 1][j] + 1,
          );
        }
      }
    }
    return matrix[a.length][b.length];
  }

  async findByLead(leadId: string, currentUser: any) {
    const records = await this.prisma.duplicateLead.findMany({
      where: {
        OR: [
          { primaryLeadId: leadId },
          { duplicateLeadId: leadId },
        ],
        status: { not: 'merged' },
      },
      include: {
        primaryLead: {
          select: {
            id: true, companyName: true, contactName: true, contactEmail: true,
            country: true, status: true, leadGrade: true,
          },
        },
        duplicateLead: {
          select: {
            id: true, companyName: true, contactName: true, contactEmail: true,
            country: true, status: true, leadGrade: true,
          },
        },
      },
      orderBy: { createdAt: 'desc' },
    });

    // Filter by access
    const filtered: any[] = [];
    for (const r of records) {
      try {
        await this.checkAccess(currentUser, r);
        filtered.push(r);
      } catch {
        // Skip inaccessible records
      }
    }

    return { data: filtered, total: filtered.length };
  }

  private async checkAccess(currentUser: any, record: any) {
    const isFullAccess = currentUser.companies?.some(
      (c: any) => ['super_admin', 'company_admin'].includes(c.role),
    );
    if (isFullAccess) return;

    const companyIds = currentUser.companies?.map((c: any) => c.id) || [];
    if (!companyIds.includes(record.companyId)) {
      throw new ForbiddenException('Cannot access duplicate leads from another company');
    }

    // Isolated users: check lead ownership
    const lead = await this.prisma.lead.findUnique({ where: { id: record.primaryLeadId } });
    if (!lead || lead.ownerUserId !== currentUser.id) {
      throw new ForbiddenException('You can only access duplicates for your own leads');
    }
  }

  private async checkWriteAccess(currentUser: any, companyId: string) {
    const isFullAccess = currentUser.companies?.some(
      (c: any) => ['super_admin', 'company_admin'].includes(c.role),
    );
    if (isFullAccess) return;

    const company = currentUser.companies?.find((c: any) => c.id === companyId);
    if (!company) throw new ForbiddenException('Not a member of this company');

    const allowedRoles = ['company_admin', 'sales_manager', 'sales_user'];
    if (!allowedRoles.includes(company.role)) {
      throw new ForbiddenException('Viewer cannot modify duplicate leads');
    }
  }
}
