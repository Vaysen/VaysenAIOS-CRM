import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../common/prisma/prisma.service';

@Injectable()
export class AnalyticsService {
  constructor(private prisma: PrismaService) {}

  private readonly sentStatuses = ['Sent', 'Opened', 'Clicked', 'Replied'];
  private readonly failedStatuses = ['Failed', 'DraftFailed', 'ValidationFailed', 'Bounced'];

  async getOverview(currentUser: any, query: any = {}) {
    const leadWhere = this.buildScopedWhere(currentUser, query);
    leadWhere.deletedAt = null;

    const now = new Date();
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
    const range = this.resolveDateRange(query);
    const rangeLeadWhere = { ...leadWhere, createdAt: { gte: range.start, lte: range.end } };
    const emailWhere = { ...this.buildEmailScopedWhere(currentUser, query), deletedAt: null };
    const rangeEmailWhere = { ...emailWhere, createdAt: { gte: range.start, lte: range.end } };
    const ownerScope = this.resolveOwnerScope(currentUser, query);

    const [
      totalLeads,
      newThisMonth,
      won,
      lost,
      scores,
      statusCounts,
      countryCounts,
      allGrades,
      emailStatusCounts,
      emailMessages,
      activeEmailAccounts,
      salespersonPerformance,
      availableSalesUsers,
    ] = await Promise.all([
      this.prisma.lead.count({ where: leadWhere }),
      this.prisma.lead.count({
        where: rangeLeadWhere,
      }),
      this.prisma.lead.count({ where: { ...leadWhere, status: 'won' } }),
      this.prisma.lead.count({ where: { ...leadWhere, status: 'lost' } }),
      this.prisma.lead.aggregate({
        where: { ...leadWhere, leadScore: { not: null } },
        _avg: { leadScore: true },
      }),
      this.prisma.lead.groupBy({
        by: ['status'],
        where: leadWhere,
        _count: true,
      }),
      this.prisma.lead.groupBy({
        by: ['country'],
        where: { ...leadWhere, country: { not: null } },
        _count: true,
      }),
      this.prisma.lead.findMany({
        where: leadWhere,
        select: { leadGrade: true },
      }),
      this.prisma.emailMessage.groupBy({
        by: ['status'],
        where: rangeEmailWhere,
        _count: true,
      }),
      this.prisma.emailMessage.findMany({
        where: rangeEmailWhere,
        select: { status: true, openedAt: true, clickedAt: true, sentAt: true, createdAt: true, toEmail: true },
      }),
      this.prisma.emailAccount.count({
        where: { ...this.buildAccountScopedWhere(currentUser, query), status: 'active' },
      }),
      this.getSalespersonPerformance(currentUser, range, ownerScope.ownerUserId),
      this.getAvailableSalesUsers(currentUser),
    ]);

    const conversionRate = (won + lost) > 0 ? Math.round((won / (won + lost)) * 100) : 0;
    const avgLeadScore = Math.round(scores._avg.leadScore || 0);

    const statusDistribution: Record<string, number> = {};
    for (const s of statusCounts) {
      statusDistribution[s.status] = s._count;
    }

    const scoreDistribution: Record<string, number> = { A: 0, B: 0, C: 0, D: 0, unscored: 0 };
    for (const l of allGrades) {
      if (l.leadGrade && scoreDistribution[l.leadGrade] !== undefined) {
        scoreDistribution[l.leadGrade]++;
      } else {
        scoreDistribution.unscored++;
      }
    }

    const countryDistribution = countryCounts
      .sort((a, b) => b._count - a._count)
      .slice(0, 10)
      .map((c) => ({ country: c.country, count: c._count }));

    const emailStatusDistribution: Record<string, number> = {};
    for (const item of emailStatusCounts) emailStatusDistribution[item.status] = item._count;
    const emailTotal = emailMessages.length;
    const emailSent = emailMessages.filter((m) => this.isSentMessage(m)).length;
    const emailOpened = emailMessages.filter((m) => !!m.openedAt).length;
    const emailClicked = emailMessages.filter((m) => !!m.clickedAt).length;
    const emailQueued = emailMessages.filter((m) => ['Queued', 'Sending'].includes(m.status)).length;
    const emailFailed = emailMessages.filter((m) => this.isFailedMessage(m)).length;
    const emailSkipped = emailMessages.filter((m) => m.status === 'Skipped').length;
    const uniqueRecipients = new Set(emailMessages.map((m) => m.toEmail).filter(Boolean)).size;

    return {
      totalLeads,
      newThisMonth,
      conversionRate,
      avgLeadScore,
      statusDistribution,
      scoreDistribution,
      countryDistribution,
      email: {
        total: emailTotal,
        sent: emailSent,
        queued: emailQueued,
        failed: emailFailed,
        skipped: emailSkipped,
        opened: emailOpened,
        clicked: emailClicked,
        uniqueRecipients,
        activeEmailAccounts,
        openRate: emailSent ? Math.round((emailOpened / emailSent) * 100) : 0,
        clickRate: emailSent ? Math.round((emailClicked / emailSent) * 100) : 0,
        statusDistribution: emailStatusDistribution,
      },
      salespersonPerformance,
      availableSalesUsers,
      canSelectOwner: ownerScope.canSelectOwner,
      selectedOwnerUserId: ownerScope.ownerUserId || null,
      range: { start: range.start.toISOString(), end: range.end.toISOString() },
    };
  }

  async getTrends(currentUser: any) {
    const leadWhere = this.buildScopedWhere(currentUser);
    leadWhere.deletedAt = null;

    const now = new Date();
    const twelveMonthsAgo = new Date(now.getFullYear(), now.getMonth() - 11, 1);

    const leads = await this.prisma.lead.findMany({
      where: { ...leadWhere, createdAt: { gte: twelveMonthsAgo } },
      select: { createdAt: true },
    });

    const monthlyMap: Record<string, number> = {};
    for (let i = 11; i >= 0; i--) {
      const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
      const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
      monthlyMap[key] = 0;
    }

    for (const l of leads) {
      const d = new Date(l.createdAt);
      const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
      if (monthlyMap[key] !== undefined) monthlyMap[key]++;
    }

    const monthlyTrend = Object.entries(monthlyMap).map(([month, count]) => ({
      month,
      count,
    }));

    return { monthlyTrend };
  }

  async getEmailTrends(currentUser: any, query: any = {}) {
    const range = this.resolveDateRange(query);
    const now = range.end;
    const days = Math.max(1, Math.min(120, Math.ceil((range.end.getTime() - range.start.getTime()) / 86400000) + 1));
    const messages = await this.prisma.emailMessage.findMany({
      where: { ...this.buildEmailScopedWhere(currentUser, query), deletedAt: null, createdAt: { gte: range.start, lte: range.end } },
      select: { createdAt: true, sentAt: true, openedAt: true, clickedAt: true, status: true },
    });
    const daily: Record<string, { date: string; queued: number; sent: number; opened: number; clicked: number; failed: number; skipped: number }> = {};
    for (let i = days - 1; i >= 0; i--) {
      const d = new Date(now.getTime() - i * 86400000);
      const key = d.toISOString().slice(0, 10);
      daily[key] = { date: key, queued: 0, sent: 0, opened: 0, clicked: 0, failed: 0, skipped: 0 };
    }
    for (const m of messages) {
      const key = (m.sentAt || m.createdAt).toISOString().slice(0, 10);
      if (!daily[key]) continue;
      daily[key].queued++;
      if (this.isSentMessage(m)) daily[key].sent++;
      if (m.openedAt) daily[key].opened++;
      if (m.clickedAt) daily[key].clicked++;
      if (this.isFailedMessage(m)) daily[key].failed++;
      if (m.status === 'Skipped') daily[key].skipped++;
    }
    return { dailyEmailTrend: Object.values(daily) };
  }

  private resolveDateRange(query: any) {
    const now = new Date();
    const end = query?.endDate ? new Date(query.endDate) : now;
    end.setHours(23, 59, 59, 999);

    let start: Date;
    if (query?.startDate) {
      start = new Date(query.startDate);
    } else {
      const days = Math.max(1, Math.min(120, Number(query?.days || 30)));
      start = new Date(end.getTime() - (days - 1) * 86400000);
    }
    start.setHours(0, 0, 0, 0);
    return { start, end };
  }

  private isFullAccess(currentUser: any) {
    return currentUser.companies?.some((c: any) => ['super_admin', 'company_admin'].includes(c.role));
  }

  private async getSalespersonPerformance(currentUser: any, range: { start: Date; end: Date }, ownerUserId?: string) {
    const companyId = currentUser.companies?.[0]?.id;
    if (!companyId) return [];
    const fullAccess = this.isFullAccess(currentUser);
    const relations = fullAccess
      ? await this.prisma.userCompanyRelation.findMany({
          where: { companyId, isActive: true, ...(ownerUserId ? { userId: ownerUserId } : {}) },
          include: { user: { select: { id: true, firstName: true, lastName: true, email: true } } },
        })
      : await this.prisma.userCompanyRelation.findMany({
          where: { companyId, userId: currentUser.id, isActive: true },
          include: { user: { select: { id: true, firstName: true, lastName: true, email: true } } },
        });

    const uniqueUsers = Array.from(new Map(relations.map((r) => [r.user.id, r.user])).values());
    return Promise.all(uniqueUsers.map(async (user) => {
      const leadBase = { companyId, ownerUserId: user.id, deletedAt: null };
      const emailBase = { companyId, senderUserId: user.id, deletedAt: null, createdAt: { gte: range.start, lte: range.end } };
      const [totalLeads, newThisMonth, activeLeads, prospectPool, assignedLeads, avg, messages] = await Promise.all([
        this.prisma.lead.count({ where: leadBase }),
        this.prisma.lead.count({ where: { ...leadBase, createdAt: { gte: range.start, lte: range.end } } }),
        this.prisma.lead.count({ where: { ...leadBase, status: { notIn: ['won', 'lost', 'converted'] } } }),
        this.prisma.lead.count({ where: { ...leadBase, status: 'prospect_pool' } }),
        this.prisma.lead.count({ where: leadBase }),
        this.prisma.lead.aggregate({ where: { ...leadBase, leadScore: { not: null } }, _avg: { leadScore: true } }),
        this.prisma.emailMessage.findMany({
          where: emailBase,
          select: { status: true, sentAt: true, openedAt: true, clickedAt: true, outreachRound: true },
        }),
      ]);
      const sent = messages.filter((m) => this.isSentMessage(m)).length;
      const opened = messages.filter((m) => !!m.openedAt).length;
      const clicked = messages.filter((m) => !!m.clickedAt).length;
      const failed = messages.filter((m) => this.isFailedMessage(m)).length;
      const skipped = messages.filter((m) => m.status === 'Skipped').length;
      const currentRoundSent = messages.filter((m) => this.isSentMessage(m) && m.outreachRound > 0).length;
      return {
        userId: user.id,
        name: `${user.firstName || ''} ${user.lastName || ''}`.trim() || user.email,
        email: user.email,
        totalLeads,
        newThisMonth,
        activeLeads,
        prospectPool,
        assignedLeads,
        sent,
        currentRoundSent,
        opened,
        clicked,
        failed,
        skipped,
        openRate: sent ? Math.round((opened / sent) * 100) : 0,
        clickRate: sent ? Math.round((clicked / sent) * 100) : 0,
        avgScore: Math.round(avg._avg.leadScore || 0),
      };
    }));
  }

  private buildScopedWhere(currentUser: any, query: any = {}): any {
    const where: any = {};
    const companyId = currentUser.companies?.[0]?.id;

    if (!companyId) return where;

    // Super admin sees all, company admin sees all in company, others isolated
    const isFullAccess = currentUser.companies?.some(
      (c: any) => ['super_admin', 'company_admin'].includes(c.role),
    );

    where.companyId = companyId;

    const ownerUserId = isFullAccess ? query?.ownerUserId : currentUser.id;
    if (ownerUserId) where.ownerUserId = ownerUserId;

    return where;
  }

  private buildEmailScopedWhere(currentUser: any, query: any = {}): any {
    const isFullAccess = currentUser.companies?.some(
      (c: any) => ['super_admin', 'company_admin'].includes(c.role),
    );
    const companyId = currentUser.companies?.[0]?.id;
    const where: any = companyId ? { companyId } : {};

    const ownerUserId = isFullAccess ? query?.ownerUserId : currentUser.id;
    if (ownerUserId) where.senderUserId = ownerUserId;

    return where;
  }

  private buildAccountScopedWhere(currentUser: any, query: any = {}): any {
    const companyId = currentUser.companies?.[0]?.id;
    const where: any = companyId ? { companyId } : {};
    const ownerScope = this.resolveOwnerScope(currentUser, query);
    if (ownerScope.ownerUserId) where.userId = ownerScope.ownerUserId;
    return where;
  }

  private resolveOwnerScope(currentUser: any, query: any = {}) {
    const canSelectOwner = this.isFullAccess(currentUser);
    return {
      canSelectOwner,
      ownerUserId: canSelectOwner ? query?.ownerUserId || undefined : currentUser.id,
    };
  }

  private async getAvailableSalesUsers(currentUser: any) {
    const companyId = currentUser.companies?.[0]?.id;
    if (!companyId || !this.isFullAccess(currentUser)) return [];
    const relations = await this.prisma.userCompanyRelation.findMany({
      where: { companyId, isActive: true, user: { isActive: true, deletedAt: null } },
      include: { user: { select: { id: true, firstName: true, lastName: true, email: true } } },
      orderBy: { joinedAt: 'asc' },
    });
    return relations.map((relation) => ({
      id: relation.user.id,
      firstName: relation.user.firstName,
      lastName: relation.user.lastName,
      email: relation.user.email,
      name: `${relation.user.firstName || ''} ${relation.user.lastName || ''}`.trim() || relation.user.email,
    }));
  }

  private isSentMessage(message: { status: string; sentAt?: Date | null }) {
    return !!message.sentAt || this.sentStatuses.includes(message.status);
  }

  private isFailedMessage(message: { status: string }) {
    return this.failedStatuses.includes(message.status);
  }
}
