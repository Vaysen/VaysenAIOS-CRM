import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../common/prisma/prisma.service';
import { hasFullAccess, requireActiveCompany } from '../../common/utils/data-isolation';

@Injectable()
export class DashboardService {
  constructor(private prisma: PrismaService) {}

  async getOverview(currentUser: any) {
    const companyId = requireActiveCompany(currentUser).id;
    const isolated = !hasFullAccess(currentUser, companyId);
    const leadWhere: any = {
      companyId,
      deletedAt: null,
      ...(isolated ? { ownerUserId: currentUser.id } : {}),
    };
    const reminderWhere: any = {
      companyId,
      status: 'Pending',
      ...(isolated ? { userId: currentUser.id } : {}),
    };
    const conversationWhere: any = {
      companyId,
      ...(isolated
        ? {
            OR: [
              { assignedUserId: currentUser.id },
              { lead: { ownerUserId: currentUser.id } },
            ],
          }
        : {}),
    };
    const quoteWhere: any = {
      companyId,
      artifactType: 'quote_extraction',
      status: 'generated',
      ...(isolated
        ? {
            OR: [
              { assistantOperatorUserId: currentUser.id },
              { lead: { ownerUserId: currentUser.id } },
            ],
          }
        : {}),
    };

    const [leads, reminders, conversations, quotes] = await Promise.all([
      this.prisma.lead.count({ where: leadWhere }),
      this.prisma.followUpReminder.count({ where: reminderWhere }),
      this.prisma.conversation.count({ where: conversationWhere }),
      this.prisma.aiArtifact.count({ where: quoteWhere }),
    ]);

    const today = new Date(); today.setHours(0,0,0,0);
    const weekAgo = new Date(today.getTime() - 7*86400000);
    const overdueFollowUps = await this.prisma.followUpReminder.findMany({
      where: { ...reminderWhere, dueAt: { lt: today } },
      take: 10, orderBy: { dueAt: 'asc' },
      include: { lead: { select: { companyName: true } } },
    });

    const inactiveLeads = await this.prisma.lead.findMany({
      where: { ...leadWhere, lastContactedAt: { lt: weekAgo } },
      take: 10, select: { id: true, companyName: true, lastContactedAt: true },
    });

    const topLeads = await this.prisma.lead.findMany({
      where: { ...leadWhere, leadGrade: 'A' },
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
