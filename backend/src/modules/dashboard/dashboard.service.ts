import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../common/prisma/prisma.service';

@Injectable()
export class DashboardService {
  constructor(private prisma: PrismaService) {}

  async getOverview(currentUser: any) {
    const companyIds = (currentUser as any)?.companies?.map((c: any) => c.id) || [];
    if (companyIds.length === 0) return {};

    const [leads, reminders, conversations, quotes] = await Promise.all([
      this.prisma.lead.count({ where: { companyId: { in: companyIds }, deletedAt: null } }),
      this.prisma.followUpReminder.count({ where: { companyId: { in: companyIds }, status: 'Pending' } }),
      this.prisma.conversation.count({ where: { companyId: { in: companyIds } } }),
      this.prisma.aiArtifact.count({ where: { companyId: { in: companyIds }, artifactType: 'quote_extraction', status: 'generated' } }),
    ]);

    const today = new Date(); today.setHours(0,0,0,0);
    const weekAgo = new Date(today.getTime() - 7*86400000);
    const overdueFollowUps = await this.prisma.followUpReminder.findMany({
      where: { companyId: { in: companyIds }, status: 'Pending', dueAt: { lt: today } },
      take: 10, orderBy: { dueAt: 'asc' },
      include: { lead: { select: { companyName: true } } },
    });

    const inactiveLeads = await this.prisma.lead.findMany({
      where: { companyId: { in: companyIds }, deletedAt: null, lastContactedAt: { lt: weekAgo } },
      take: 10, select: { id: true, companyName: true, lastContactedAt: true },
    });

    const topLeads = await this.prisma.lead.findMany({
      where: { companyId: { in: companyIds }, deletedAt: null, leadGrade: 'A' },
      take: 10, select: { id: true, companyName: true, country: true, leadGrade: true },
    });

    return {
      kpis: { leads, pendingFollowUps: reminders, conversations, pendingQuotes: quotes },
      overdueFollowUps: overdueFollowUps.map(r => ({ id: r.id, title: r.title, leadName: (r as any).lead?.companyName, dueAt: r.dueAt })),
      inactiveLeads: inactiveLeads.map(l => ({ id: l.id, companyName: l.companyName, lastContactedAt: l.lastContactedAt })),
      topLeads: topLeads.map(l => ({ id: l.id, companyName: l.companyName, country: l.country })),
    };
  }
}
