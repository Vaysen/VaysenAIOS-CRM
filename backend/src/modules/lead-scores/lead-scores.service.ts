import {
  Injectable,
  NotFoundException,
  ForbiddenException,
} from '@nestjs/common';
import { PrismaService } from '../../common/prisma/prisma.service';
import { LeadScoringService } from './lead-scoring.service';
import { TimelineService } from '../timeline/timeline.service';

@Injectable()
export class LeadScoresService {
  constructor(
    private prisma: PrismaService,
    private scoringService: LeadScoringService,
    private timelineService: TimelineService,
  ) {}

  async calculateAndSave(leadId: string, currentUser: any) {
    const lead = await this.prisma.lead.findUnique({ where: { id: leadId } });
    if (!lead || lead.deletedAt) throw new NotFoundException('Lead not found');

    await this.checkWriteAccess(currentUser, lead);

    const result = this.scoringService.calculateScore(lead);

    // Save score record
    const scoreRecord = await this.prisma.leadScore.create({
      data: {
        companyId: lead.companyId,
        leadId: lead.id,
        totalScore: result.score,
        grade: result.grade,
        scoreReason: result.scoreReason,
        breakdown: result.breakdown as any,
        calculatedBy: currentUser.id,
      },
    });

    // Update lead's cached score fields
    await this.prisma.lead.update({
      where: { id: lead.id },
      data: { leadScore: result.score, leadGrade: result.grade },
    });

    await this.timelineService.logActivity({
      companyId: lead.companyId,
      leadId: lead.id,
      userId: currentUser.id,
      activityType: 'score_updated',
      title: '客户评分已更新',
      description: `评分: ${result.score} (${result.grade})`,
      metadata: { score: result.score, grade: result.grade },
    }).catch(() => {});

    return { ...scoreRecord, breakdown: result.breakdown };
  }

  async calculateAllForCompany(currentUser: any) {
    const companyId = currentUser.companies?.[0]?.id;
    if (!companyId) throw new ForbiddenException('No company associated');

    await this.checkWriteAccessForCompany(currentUser, companyId);

    const leads = await this.prisma.lead.findMany({
      where: { companyId, deletedAt: null },
    });

    // Sales User can only score their own leads
    const isOnlySalesUser = this.isSalesUser(currentUser);
    const filteredLeads = isOnlySalesUser
      ? leads.filter((l) => l.ownerUserId === currentUser.id)
      : leads;

    const results: any[] = [];
    for (const lead of filteredLeads) {
      try {
        const result = this.scoringService.calculateScore(lead);

        const scoreRecord = await this.prisma.leadScore.create({
          data: {
            companyId: lead.companyId,
            leadId: lead.id,
            totalScore: result.score,
            grade: result.grade,
            scoreReason: result.scoreReason,
            breakdown: result.breakdown as any,
            calculatedBy: currentUser.id,
          },
        });

        await this.prisma.lead.update({
          where: { id: lead.id },
          data: { leadScore: result.score, leadGrade: result.grade },
        });

        await this.timelineService.logActivity({
          companyId: lead.companyId,
          leadId: lead.id,
          userId: currentUser.id,
          activityType: 'score_updated',
          title: '客户评分已更新',
          description: `评分: ${result.score} (${result.grade})`,
          metadata: { score: result.score, grade: result.grade },
        }).catch(() => {});

        results.push({ ...scoreRecord, breakdown: result.breakdown });
      } catch {
        // Skip failed calculations
      }
    }

    return {
      message: `Scored ${results.length} leads`,
      totalProcessed: results.length,
      totalLeads: filteredLeads.length,
      results,
    };
  }

  async recalculateAfterLeadChange(lead: any) {
    const result = this.scoringService.calculateScore(lead);

    const scoreRecord = await this.prisma.leadScore.create({
      data: {
        companyId: lead.companyId,
        leadId: lead.id,
        totalScore: result.score,
        grade: result.grade,
        scoreReason: result.scoreReason,
        breakdown: result.breakdown as any,
        calculatedBy: null,
      },
    });

    await this.prisma.lead.update({
      where: { id: lead.id },
      data: { leadScore: result.score, leadGrade: result.grade },
    });

    return scoreRecord;
  }

  async getScoreForLead(leadId: string, currentUser: any) {
    const lead = await this.prisma.lead.findUnique({ where: { id: leadId } });
    if (!lead || lead.deletedAt) throw new NotFoundException('Lead not found');

    await this.checkReadAccess(currentUser, lead);

    const scores = await this.prisma.leadScore.findMany({
      where: { leadId },
      orderBy: { calculatedAt: 'desc' },
      take: 10,
    });

    const latest = scores[0] || null;

    return {
      leadId,
      companyName: lead.companyName,
      currentScore: lead.leadScore,
      currentGrade: lead.leadGrade,
      latest,
      history: scores,
    };
  }

  async findAll(currentUser: any, query: {
    page?: number;
    limit?: number;
    grade?: string;
    companyId?: string;
  }) {
    const page = query.page || 1;
    const limit = query.limit || 20;
    const skip = (page - 1) * limit;

    const where: any = {};
    const isSuperAdmin = currentUser.companies?.some(
      (c: any) => c.role === 'super_admin',
    );

    if (!isSuperAdmin) {
      const companyIds = currentUser.companies?.map((c: any) => c.id) || [];
      where.companyId = { in: companyIds };

      const isOnlySalesUser = this.isSalesUser(currentUser);
      if (isOnlySalesUser) {
        where.lead = { ownerUserId: currentUser.id };
      }
    }

    if (query.grade) {
      where.grade = query.grade;
    }
    if (query.companyId && isSuperAdmin) {
      where.companyId = query.companyId;
    }

    const [data, total] = await Promise.all([
      this.prisma.leadScore.findMany({
        where,
        include: {
          lead: {
            select: {
              companyName: true, contactName: true, contactEmail: true,
              country: true, status: true,
              owner: { select: { id: true, firstName: true, lastName: true, email: true } },
            },
          },
        },
        skip,
        take: limit,
        orderBy: { calculatedAt: 'desc' },
      }),
      this.prisma.leadScore.count({ where }),
    ]);

    // Get grade distribution
    const gradeDistribution = await this.getGradeDistribution(currentUser, isSuperAdmin);

    return {
      data,
      meta: { page, limit, total, totalPages: Math.ceil(total / limit) },
      gradeDistribution,
    };
  }

  private async getGradeDistribution(currentUser: any, isSuperAdmin: boolean) {
    const companyWhere: any = {};
    if (!isSuperAdmin) {
      const companyIds = currentUser.companies?.map((c: any) => c.id) || [];
      companyWhere.companyId = { in: companyIds };
    }

    const isOnlySalesUser = this.isSalesUser(currentUser);

    // Get all leads with scores in the accessible scope
    const leadWhere: any = { ...companyWhere, deletedAt: null };
    if (isOnlySalesUser) {
      leadWhere.ownerUserId = currentUser.id;
    }

    const leads = await this.prisma.lead.findMany({
      where: leadWhere,
      select: { leadGrade: true },
    });

    const distribution: Record<string, number> = { A: 0, B: 0, C: 0, D: 0, unscored: 0 };
    for (const l of leads) {
      if (l.leadGrade && distribution[l.leadGrade] !== undefined) {
        distribution[l.leadGrade]++;
      } else {
        distribution.unscored++;
      }
    }

    return distribution;
  }

  // Auto-trigger: called after lead create/update/status change
  async autoScore(leadId: string) {
    try {
      const lead = await this.prisma.lead.findUnique({ where: { id: leadId } });
      if (!lead || lead.deletedAt) return;

      const result = this.scoringService.calculateScore(lead);

      await this.prisma.leadScore.create({
        data: {
          companyId: lead.companyId,
          leadId: lead.id,
          totalScore: result.score,
          grade: result.grade,
          scoreReason: result.scoreReason,
          breakdown: result.breakdown as any,
        },
      });

      await this.prisma.lead.update({
        where: { id: lead.id },
        data: { leadScore: result.score, leadGrade: result.grade },
      });

      await this.timelineService.logActivity({
        companyId: lead.companyId,
        leadId: lead.id,
        activityType: 'score_updated',
        title: '客户评分已更新',
        description: `评分: ${result.score} (${result.grade})`,
        metadata: { score: result.score, grade: result.grade },
      }).catch(() => {});
    } catch {
      // Silently ignore auto-scoring errors
    }
  }

  private async checkWriteAccess(currentUser: any, lead: any) {
    const isSuperAdmin = currentUser.companies?.some(
      (c: any) => c.role === 'super_admin',
    );
    if (isSuperAdmin) return;

    const company = currentUser.companies?.find((c: any) => c.id === lead.companyId);
    if (!company) throw new ForbiddenException('Not a member of this company');

    const allowedRoles = ['company_admin', 'sales_manager', 'sales_user'];
    if (!allowedRoles.includes(company.role)) {
      throw new ForbiddenException('Viewer cannot calculate scores');
    }

    // Sales User can only score own leads
    if (company.role === 'sales_user' && lead.ownerUserId !== currentUser.id) {
      throw new ForbiddenException('You can only score your own leads');
    }
  }

  private async checkWriteAccessForCompany(currentUser: any, companyId: string) {
    const isSuperAdmin = currentUser.companies?.some(
      (c: any) => c.role === 'super_admin',
    );
    if (isSuperAdmin) return;

    const company = currentUser.companies?.find((c: any) => c.id === companyId);
    if (!company) throw new ForbiddenException('Not a member of this company');

    const allowedRoles = ['company_admin', 'sales_manager', 'sales_user'];
    if (!allowedRoles.includes(company.role)) {
      throw new ForbiddenException('Viewer cannot calculate scores');
    }
  }

  private async checkReadAccess(currentUser: any, lead: any) {
    const isSuperAdmin = currentUser.companies?.some(
      (c: any) => c.role === 'super_admin',
    );
    if (isSuperAdmin) return;

    const companyIds = currentUser.companies?.map((c: any) => c.id) || [];
    if (!companyIds.includes(lead.companyId)) {
      throw new ForbiddenException('Cannot access leads from another company');
    }

    if (this.isSalesUser(currentUser) && lead.ownerUserId !== currentUser.id) {
      throw new ForbiddenException('You can only view scores for your own leads');
    }
  }

  private isSalesUser(currentUser: any): boolean {
    const roles = currentUser.companies?.map((c: any) => c.role) || [];
    return roles.length > 0 && roles.every((r: string) => r === 'sales_user' || r === 'viewer') &&
      roles.some((r: string) => r === 'sales_user');
  }
}
