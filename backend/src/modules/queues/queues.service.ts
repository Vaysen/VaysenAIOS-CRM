import { Injectable } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { PrismaService } from '@/common/prisma/prisma.service';
import { QUEUES } from '@/common/queues/queue-names';
import {
  hasFullAccess,
  requireActiveCompany,
} from '@/common/utils/data-isolation';

const EMAIL_PENDING_STATUSES = ['DraftPending', 'Drafting', 'DraftReady', 'ValidationFailed', 'QueuedToSend', 'Queued'];

@Injectable()
export class QueuesService {
  constructor(
    private prisma: PrismaService,
    @InjectQueue(QUEUES.emailCompose) private emailComposeQueue: Queue,
    @InjectQueue(QUEUES.emailValidate) private emailValidateQueue: Queue,
    @InjectQueue(QUEUES.emailSend) private emailSendQueue: Queue,
    @InjectQueue(QUEUES.prospectSearch) private prospectSearchQueue: Queue,
    @InjectQueue(QUEUES.deepResearch) private deepResearchQueue: Queue,
    @InjectQueue(QUEUES.maintenance) private maintenanceQueue: Queue,
  ) {}

  async getStatus(currentUser?: any) {
    const companyId = requireActiveCompany(currentUser).id;
    const isFullAccess = hasFullAccess(currentUser, companyId);
    const emailWhere: any = {
      deletedAt: null,
      companyId,
      ...(!isFullAccess && currentUser?.id ? { senderUserId: currentUser.id } : {}),
    };
    const searchWhere: any = {
      companyId,
      ...(!isFullAccess && currentUser?.id ? { createdBy: currentUser.id } : {}),
    };
    const researchWhere: any = {
      companyId,
      ...(!isFullAccess && currentUser?.id ? { createdBy: currentUser.id } : {}),
    };
    const queues = [
      this.emailComposeQueue,
      this.emailValidateQueue,
      this.emailSendQueue,
      this.prospectSearchQueue,
      this.deepResearchQueue,
      this.maintenanceQueue,
    ];

    const [queueStats, emailStatusCounts, recentFailures] = await Promise.all([
      Promise.all(queues.map((queue) => this.getQueueStats(queue))),
      this.prisma.emailMessage.groupBy({
        by: ['status'],
        where: emailWhere,
        _count: true,
      }),
      this.prisma.emailMessage.findMany({
        where: {
          ...emailWhere,
          status: { in: ['Failed', 'DraftFailed', 'Skipped', 'ValidationFailed'] },
          failedReason: { not: null },
          createdAt: { gte: new Date(Date.now() - 24 * 60 * 60 * 1000) },
        },
        select: {
          id: true,
          status: true,
          failedReason: true,
          toEmail: true,
          subject: true,
          createdAt: true,
          senderUser: { select: { id: true, firstName: true, lastName: true, email: true } },
        },
        orderBy: { updatedAt: 'desc' },
        take: 20,
      }),
    ]);
    const [recentSearchFailures, recentResearchIssues] = await Promise.all([
      this.prisma.searchTask.findMany({
        where: {
          ...searchWhere,
          status: { in: ['failed', 'cancelled'] },
          updatedAt: { gte: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000) },
        },
        select: { id: true, status: true, errorMessage: true, keywords: true, targetCountry: true, maxResults: true, totalFound: true, completedAt: true, updatedAt: true, createdAt: true },
        orderBy: { updatedAt: 'desc' },
        take: 15,
      }),
      this.prisma.deepResearchReport.findMany({
        where: {
          ...researchWhere,
          createdAt: { gte: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000) },
        },
        select: { id: true, type: true, title: true, createdAt: true, lead: { select: { companyName: true } }, jsonData: true },
        orderBy: { createdAt: 'desc' },
        take: 20,
      }),
    ]);

    const emailCounts = Object.fromEntries(emailStatusCounts.map((item) => [item.status, item._count]));
    const pendingEmailCount = EMAIL_PENDING_STATUSES.reduce((sum, status) => sum + (emailCounts[status] || 0), 0);

    return {
      data: {
        queues: queueStats,
        emailWorkflow: {
          pending: pendingEmailCount,
          draftPending: emailCounts.DraftPending || 0,
          drafting: emailCounts.Drafting || 0,
          draftReady: emailCounts.DraftReady || 0,
          validationFailed: emailCounts.ValidationFailed || 0,
          queuedToSend: emailCounts.QueuedToSend || 0,
          legacyQueued: emailCounts.Queued || 0,
          sending: emailCounts.Sending || 0,
          sent: emailCounts.Sent || 0,
          failed: (emailCounts.Failed || 0) + (emailCounts.DraftFailed || 0),
          skipped: emailCounts.Skipped || 0,
        },
        recentFailures: [
          ...recentFailures,
          ...recentSearchFailures.map((item) => ({
            id: item.id,
            status: `Search${item.status.charAt(0).toUpperCase() + item.status.slice(1)}`,
            failedReason: item.errorMessage
              || (item.status === 'cancelled' ? '任务已被手动取消' : `AI获客任务${item.status}（无详细错误记录）`),
            subject: `AI获客 - ${item.targetCountry} - ${(item.keywords || []).slice(0, 2).join(', ')}`,
            createdAt: (item.completedAt || item.updatedAt || item.createdAt).toISOString(),
          })),
          ...recentResearchIssues.map((item) => ({
            id: item.id,
            status: (item.jsonData as any)?.error ? 'DeepResearchFailed' : 'DeepResearchDone',
            failedReason: (item.jsonData as any)?.error || (item.jsonData as any)?.reason || item.title || '报告已生成',
            subject: `AI深度背调 - ${item.lead?.companyName || item.type || '未知客户'}`,
            createdAt: item.createdAt.toISOString(),
          })),
        ].slice(0, 40),
      },
    };
  }

  private async getQueueStats(queue: Queue) {
    const counts = await queue.getJobCounts('waiting', 'active', 'completed', 'failed', 'delayed', 'paused');
    return {
      name: queue.name,
      waiting: counts.waiting || 0,
      active: counts.active || 0,
      completed: counts.completed || 0,
      failed: counts.failed || 0,
      delayed: counts.delayed || 0,
      paused: counts.paused || 0,
    };
  }
}
