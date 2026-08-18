import {
  Injectable,
  NotFoundException,
  ForbiddenException,
} from '@nestjs/common';
import { PrismaService } from '../../common/prisma/prisma.service';
import { TimelineService } from '../timeline/timeline.service';
import { QueryFollowUpRemindersDto } from './dto/query-follow-up-reminders.dto';
import { GenerateRemindersDto } from './dto/generate-reminders.dto';
import { SnoozeReminderDto } from './dto/snooze-reminder.dto';
import { Prisma } from '@prisma/client';
import {
  hasFullAccess,
  requireActiveCompany,
} from '../../common/utils/data-isolation';

const REMINDER_CONFIGS: Record<string, { title: string; reason: string; priority: string; dueDays: number }> = {
  EMAIL_SENT_NO_OPEN: {
    title: '开发信已发送3天未打开',
    reason: '开发信已发送3天未打开，建议更换标题或换角度重新开发。',
    priority: 'Medium',
    dueDays: 0,
  },
  OPENED_NO_REPLY: {
    title: '邮件打开后2天未回复',
    reason: '客户打开过邮件但未回复，建议轻跟进，不要立刻强推报价。',
    priority: 'Medium',
    dueDays: 0,
  },
  CLICKED_NO_REPLY: {
    title: '邮件点击后1天未回复',
    reason: '客户点击过产品链接，说明有一定兴趣，建议优先跟进产品细节或交期。',
    priority: 'High',
    dueDays: 0,
  },
  QUOTE_NO_REPLY: {
    title: '报价后5天未回复',
    reason: '报价已发出5天未回复，可以询问客户是否需要调整配置、交期或付款方式。',
    priority: 'High',
    dueDays: 0,
  },
  LONG_TIME_NO_CONTACT: {
    title: '超过30天未联系',
    reason: '该客户超过30天没有联系，建议重新唤醒或判断是否降低优先级。',
    priority: 'Medium',
    dueDays: 0,
  },
  HIGH_INTENT_FOLLOW_UP: {
    title: '高意向客户待跟进',
    reason: '该客户有明显兴趣（已打开/点击/回复/洽谈中），建议优先跟进。',
    priority: 'Urgent',
    dueDays: 0,
  },
  REPLIED_STATUS_NOT_UPDATED: {
    title: '客户已回复但状态未更新',
    reason: '客户已有回复，请及时更新客户状态。',
    priority: 'High',
    dueDays: 0,
  },
};

type ReminderLead = {
  id: string;
  companyId: string;
  companyName: string | null;
  status: string;
  ownerUserId: string | null;
  lastContactedAt: Date | null;
  nextFollowUpAt: Date | null;
  createdAt: Date;
};

@Injectable()
export class FollowUpRemindersService {
  constructor(
    private prisma: PrismaService,
    private timelineService: TimelineService,
  ) {}

  async findAll(currentUser: any, query: QueryFollowUpRemindersDto) {
    const page = query.page || 1;
    const limit = query.limit || 20;
    const skip = (page - 1) * limit;

    const where: any = this.buildCompanyWhere(currentUser);

    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);

    if (query.status) {
      if (query.status === 'Overdue') {
        where.status = 'Pending';
        where.dueAt = { lt: todayStart };
      } else {
        const statuses = query.status.split(',');
        where.status = statuses.length === 1 ? statuses[0] : { in: statuses };
      }
    }
    if (query.reminderType) {
      const types = query.reminderType.split(',');
      where.reminderType = types.length === 1 ? types[0] : { in: types };
    }
    if (query.priority) {
      const priorities = query.priority.split(',');
      where.priority = priorities.length === 1 ? priorities[0] : { in: priorities };
    }
    if (query.leadId) {
      where.leadId = query.leadId;
    }
    if (query.userId) {
      where.userId = query.userId;
    }
    if (query.dueFrom || query.dueTo) {
      where.dueAt = {};
      if (query.dueFrom) where.dueAt.gte = new Date(query.dueFrom);
      if (query.dueTo) where.dueAt.lte = new Date(query.dueTo);
    }
    if (query.overdue) {
      where.status = 'Pending';
      where.dueAt = { lt: todayStart };
    }
    if (query.search) {
      where.OR = [
        { title: { contains: query.search, mode: 'insensitive' } },
        { reason: { contains: query.search, mode: 'insensitive' } },
      ];
    }

    const [data, total] = await Promise.all([
      this.prisma.followUpReminder.findMany({
        where,
        include: {
          lead: { select: { id: true, companyName: true, status: true, contactEmail: true } },
          user: { select: { id: true, firstName: true, lastName: true, email: true } },
          emailMessage: { select: { id: true, subject: true, status: true, sentAt: true } },
        },
        skip,
        take: limit,
        orderBy: [{ priority: 'desc' }, { dueAt: 'asc' }],
      }),
      this.prisma.followUpReminder.count({ where }),
    ]);

    const priorityOrder: Record<string, number> = { Urgent: 0, High: 1, Medium: 2, Low: 3 };
    const sorted = data.sort((a, b) => {
      const pa = priorityOrder[a.priority] ?? 3;
      const pb = priorityOrder[b.priority] ?? 3;
      if (pa !== pb) return pa - pb;
      return new Date(a.dueAt).getTime() - new Date(b.dueAt).getTime();
    });

    return { data: sorted, meta: { page, limit, total, totalPages: Math.ceil(total / limit) } };
  }

  async findOne(id: string, currentUser: any) {
    const reminder = await this.prisma.followUpReminder.findUnique({
      where: { id },
      include: {
        lead: {
          select: {
            id: true, companyName: true, status: true, contactEmail: true,
            contactName: true, country: true, website: true, leadScore: true, leadGrade: true,
            lastContactedAt: true, nextFollowUpAt: true, ownerUserId: true,
          },
        },
        user: { select: { id: true, firstName: true, lastName: true, email: true } },
        emailMessage: {
          select: {
            id: true, subject: true, status: true, sentAt: true, openedAt: true,
            clickedAt: true, trackingId: true,
          },
        },
      },
    });
    if (!reminder || reminder.deletedAt) {
      throw new NotFoundException('Follow-up reminder not found');
    }
    this.checkCompanyAccess(currentUser, reminder);
    return reminder;
  }

  async findByLead(leadId: string, currentUser: any) {
    const lead = await this.prisma.lead.findUnique({ where: { id: leadId } });
    if (!lead || lead.deletedAt) throw new NotFoundException('Lead not found');

    const currentCompanyId = requireActiveCompany(currentUser).id;
    if (lead.companyId !== currentCompanyId) {
      throw new ForbiddenException('Cannot access leads from another company');
    }

    return this.prisma.followUpReminder.findMany({
      where: { leadId, deletedAt: null },
      include: {
        user: { select: { id: true, firstName: true, lastName: true, email: true } },
        emailMessage: { select: { id: true, subject: true, status: true, sentAt: true } },
      },
      orderBy: { createdAt: 'desc' },
    });
  }

  async getStats(currentUser: any) {
    const where: any = this.buildCompanyWhere(currentUser);
    const baseWhere = { ...where, deletedAt: null };

    const now = new Date();
    const todayEnd = new Date(now);
    todayEnd.setHours(23, 59, 59, 999);
    const todayStart = new Date(now);
    todayStart.setHours(0, 0, 0, 0);

    const [pendingToday, overdue, highPriority, clickedNoReply, quoteNoReply, longTimeNoContact] =
      await Promise.all([
        this.prisma.followUpReminder.count({
          where: { ...baseWhere, status: 'Pending', dueAt: { lte: todayEnd } },
        }),
        this.prisma.followUpReminder.count({
          where: { ...baseWhere, status: 'Pending', dueAt: { lt: todayStart } },
        }),
        this.prisma.followUpReminder.count({
          where: { ...baseWhere, status: 'Pending', priority: { in: ['High', 'Urgent'] } },
        }),
        this.prisma.followUpReminder.count({
          where: { ...baseWhere, status: 'Pending', reminderType: 'CLICKED_NO_REPLY' },
        }),
        this.prisma.followUpReminder.count({
          where: { ...baseWhere, status: 'Pending', reminderType: 'QUOTE_NO_REPLY' },
        }),
        this.prisma.followUpReminder.count({
          where: { ...baseWhere, status: 'Pending', reminderType: 'LONG_TIME_NO_CONTACT' },
        }),
      ]);

    return {
      pendingToday,
      overdue,
      highPriority,
      clickedNoReply,
      quoteNoReply,
      longTimeNoContact,
    };
  }

  async generateReminders(currentUser: any, dto?: GenerateRemindersDto) {
    const companyIds = this.getCompanyIds(currentUser);
    const now = new Date();

    const leadWhere: any = {
      companyId: { in: companyIds },
      deletedAt: null,
      status: { notIn: ['won', 'lost'] },
    };

    if (dto?.leadId) leadWhere.id = dto.leadId;
    if (dto?.userId) leadWhere.ownerUserId = dto.userId;

    const leads = await this.prisma.lead.findMany({
      where: leadWhere,
      select: {
        id: true, companyId: true, companyName: true, status: true,
        ownerUserId: true, lastContactedAt: true, nextFollowUpAt: true, createdAt: true,
      },
    });

    let created = 0;
    let skipped = 0;

    for (const lead of leads) {
      const count = await this.processLeadReminders(lead, dto?.reminderType);
      created += count.created;
      skipped += count.skipped;
    }

    return { message: `Generated ${created} reminder(s), skipped ${skipped} duplicate(s)`, created, skipped };
  }

  async generateForLead(leadId: string) {
    const lead = await this.prisma.lead.findUnique({
      where: { id: leadId, deletedAt: null },
      select: {
        id: true, companyId: true, companyName: true, status: true,
        ownerUserId: true, lastContactedAt: true, nextFollowUpAt: true, createdAt: true,
      },
    });
    if (!lead) return { created: 0, skipped: 0 };

    // Cancel pending reminders for Won/Lost leads
    if (['won', 'lost'].includes(lead.status)) {
      await this.prisma.followUpReminder.updateMany({
        where: { leadId, status: 'Pending', deletedAt: null },
        data: { status: 'Cancelled' },
      });
    }

    return this.processLeadReminders(lead);
  }

  async generateForEmail(emailMessageId: string) {
    const msg = await this.prisma.emailMessage.findUnique({
      where: { id: emailMessageId },
      select: { leadId: true },
    });
    if (!msg) return { created: 0, skipped: 0 };
    return this.generateForLead(msg.leadId);
  }

  async complete(id: string, currentUser: any) {
    const reminder = await this.prisma.followUpReminder.findUnique({ where: { id } });
    if (!reminder || reminder.deletedAt) throw new NotFoundException('Follow-up reminder not found');
    this.checkCompanyAccess(currentUser, reminder);
    this.checkWriteAccess(currentUser, reminder.companyId);

    const updated = await this.prisma.followUpReminder.update({
      where: { id },
      data: { status: 'Completed', completedAt: new Date(), completedBy: currentUser.id },
    });

    await this.timelineService.logActivity({
      companyId: reminder.companyId,
      leadId: reminder.leadId,
      userId: currentUser.id,
      activityType: 'reminder_completed',
      title: '完成了跟进提醒',
      description: `完成了提醒: "${reminder.title}"`,
    });

    return updated;
  }

  async ignore(id: string, currentUser: any) {
    const reminder = await this.prisma.followUpReminder.findUnique({ where: { id } });
    if (!reminder || reminder.deletedAt) throw new NotFoundException('Follow-up reminder not found');
    this.checkCompanyAccess(currentUser, reminder);
    this.checkWriteAccess(currentUser, reminder.companyId);

    const updated = await this.prisma.followUpReminder.update({
      where: { id },
      data: { status: 'Ignored', ignoredAt: new Date(), ignoredBy: currentUser.id },
    });

    await this.timelineService.logActivity({
      companyId: reminder.companyId,
      leadId: reminder.leadId,
      userId: currentUser.id,
      activityType: 'reminder_ignored',
      title: '忽略了跟进提醒',
      description: `忽略了提醒: "${reminder.title}"`,
    });

    return updated;
  }

  async snooze(id: string, dto: SnoozeReminderDto, currentUser: any) {
    const reminder = await this.prisma.followUpReminder.findUnique({ where: { id } });
    if (!reminder || reminder.deletedAt) throw new NotFoundException('Follow-up reminder not found');
    this.checkCompanyAccess(currentUser, reminder);
    this.checkWriteAccess(currentUser, reminder.companyId);

    const updated = await this.prisma.followUpReminder.update({
      where: { id },
      data: { status: 'Snoozed', snoozedUntil: new Date(dto.snoozedUntil) },
    });

    await this.timelineService.logActivity({
      companyId: reminder.companyId,
      leadId: reminder.leadId,
      userId: currentUser.id,
      activityType: 'reminder_snoozed',
      title: '延期了跟进提醒',
      description: `将提醒 "${reminder.title}" 延期至 ${dto.snoozedUntil}`,
    });

    return updated;
  }

  // ========== Core Generation Logic ==========

  private async processLeadReminders(lead: ReminderLead, filterType?: string) {
    let created = 0;
    let skipped = 0;

    const rules = filterType ? [filterType] : Object.keys(REMINDER_CONFIGS);

    for (const reminderType of rules) {
      const config = REMINDER_CONFIGS[reminderType];
      if (!config) continue;

      const match = await this.checkRule(lead, reminderType);
      if (!match) continue;

      const exists = await this.checkDuplicate(lead.id, reminderType, match.emailMessageId);
      if (exists) { skipped++; continue; }

      await this.prisma.followUpReminder.create({
        data: {
          companyId: lead.companyId,
          leadId: lead.id,
          userId: lead.ownerUserId || '',
          emailMessageId: match.emailMessageId,
          reminderType,
          title: config.title,
          reason: config.reason,
          priority: config.priority,
          dueAt: match.dueAt || new Date(),
          status: 'Pending',
        },
      });

      await this.timelineService.logActivity({
        companyId: lead.companyId,
        leadId: lead.id,
        userId: lead.ownerUserId || '',
        activityType: 'reminder_created',
        title: '生成了跟进提醒',
        description: `自动生成提醒: ${config.title}`,
      });

      created++;
    }

    return { created, skipped };
  }

  private async checkRule(lead: ReminderLead, reminderType: string): Promise<{ dueAt: Date; emailMessageId?: string } | null> {
    const now = new Date();

    switch (reminderType) {
      case 'EMAIL_SENT_NO_OPEN': {
        const threeDaysAgo = new Date(now.getTime() - 3 * 24 * 60 * 60 * 1000);
        const msg = await this.prisma.emailMessage.findFirst({
          where: {
            leadId: lead.id,
            status: 'Sent',
            sentAt: { lte: threeDaysAgo },
          },
          orderBy: { sentAt: 'desc' },
        });
        if (!msg) return null;
        const hasOpen = await this.prisma.emailOpenEvent.findFirst({ where: { emailId: msg.id } });
        const hasClick = await this.prisma.emailClickEvent.findFirst({ where: { emailId: msg.id } });
        if (hasOpen || hasClick) return null;
        const hasReply = await this.prisma.emailMessage.findFirst({
          where: { leadId: lead.id, status: 'Replied' },
        });
        if (hasReply) return null;
        return { dueAt: now, emailMessageId: msg.id };
      }

      case 'OPENED_NO_REPLY': {
        const twoDaysAgo = new Date(now.getTime() - 2 * 24 * 60 * 60 * 1000);
        const msg = await this.prisma.emailMessage.findFirst({
          where: {
            leadId: lead.id,
            openedAt: { lte: twoDaysAgo },
          },
          orderBy: { openedAt: 'desc' },
        });
        if (!msg) return null;
        const hasReply = await this.prisma.emailMessage.findFirst({
          where: { leadId: lead.id, status: 'Replied' },
        });
        if (hasReply) return null;
        return { dueAt: now, emailMessageId: msg.id };
      }

      case 'CLICKED_NO_REPLY': {
        const oneDayAgo = new Date(now.getTime() - 1 * 24 * 60 * 60 * 1000);
        const msg = await this.prisma.emailMessage.findFirst({
          where: {
            leadId: lead.id,
            clickedAt: { lte: oneDayAgo },
          },
          orderBy: { clickedAt: 'desc' },
        });
        if (!msg) return null;
        const hasReply = await this.prisma.emailMessage.findFirst({
          where: { leadId: lead.id, status: 'Replied' },
        });
        if (hasReply) return null;
        return { dueAt: now, emailMessageId: msg.id };
      }

      case 'QUOTE_NO_REPLY': {
        if (lead.status !== 'quoted') return null;
        const fiveDaysAgo = new Date(now.getTime() - 5 * 24 * 60 * 60 * 1000);
        const recentActivity = await this.prisma.leadActivity.findFirst({
          where: {
            leadId: lead.id,
            createdAt: { gte: fiveDaysAgo },
            activityType: { in: ['status_changed', 'updated', 'email_sent'] },
          },
        });
        if (recentActivity) return null;
        if (lead.lastContactedAt && lead.lastContactedAt > fiveDaysAgo) return null;
        return { dueAt: now };
      }

      case 'LONG_TIME_NO_CONTACT': {
        const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
        if (lead.lastContactedAt && lead.lastContactedAt > thirtyDaysAgo) return null;
        if (!lead.lastContactedAt && lead.createdAt > thirtyDaysAgo) return null;
        return { dueAt: now };
      }

      case 'HIGH_INTENT_FOLLOW_UP': {
        if (!['replied', 'interested'].includes(lead.status)) return null;
        if (lead.nextFollowUpAt && lead.nextFollowUpAt > now) return null;
        return { dueAt: lead.nextFollowUpAt || now };
      }

      case 'REPLIED_STATUS_NOT_UPDATED': {
        const repliedMsg = await this.prisma.emailMessage.findFirst({
          where: { leadId: lead.id, status: 'Replied' },
        });
        if (!repliedMsg) return null;
        if (['replied', 'interested', 'quoted', 'won', 'lost'].includes(lead.status)) return null;
        return { dueAt: now, emailMessageId: repliedMsg.id };
      }

      default:
        return null;
    }
  }

  private async checkDuplicate(leadId: string, reminderType: string, emailMessageId?: string): Promise<boolean> {
    const where: any = {
      leadId,
      reminderType,
      status: { in: ['Pending', 'Snoozed'] },
      deletedAt: null,
    };
    if (emailMessageId) {
      where.emailMessageId = emailMessageId;
    }
    const existing = await this.prisma.followUpReminder.findFirst({ where });
    return !!existing;
  }

  // ========== Access Control ==========

  private buildCompanyWhere(currentUser: any): any {
    const companyId = requireActiveCompany(currentUser).id;
    const isFullAccess = hasFullAccess(currentUser, companyId);

    const where: any = { companyId, deletedAt: null };

    if (!isFullAccess) {
      where.userId = currentUser.id;
    }

    return where;
  }

  private getCompanyIds(currentUser: any): string[] {
    return [requireActiveCompany(currentUser).id];
  }

  private checkCompanyAccess(currentUser: any, record: any) {
    const currentCompanyId = requireActiveCompany(currentUser).id;
    const isFullAccess = hasFullAccess(currentUser, currentCompanyId);
    if (record.companyId !== currentCompanyId) {
      throw new ForbiddenException('Cannot access reminders from another company');
    }

    if (!isFullAccess && record.userId && record.userId !== currentUser.id) {
      throw new ForbiddenException('You can only access your own reminders');
    }
  }

  private checkWriteAccess(currentUser: any, companyId: string) {
    const activeCompanyId = requireActiveCompany(currentUser).id;
    if (companyId !== activeCompanyId) {
      throw new ForbiddenException('Cannot modify reminders from another company');
    }
    if (hasFullAccess(currentUser, activeCompanyId)) return;

    const company = currentUser.companies?.find((c: any) => c.id === activeCompanyId);
    if (!company) throw new ForbiddenException('Not a member of this company');

    if (company.role === 'viewer') {
      throw new ForbiddenException('Viewer cannot modify reminders');
    }
  }

}
