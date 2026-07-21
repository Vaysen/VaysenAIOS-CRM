import {
  Injectable,
  NotFoundException,
  ForbiddenException,
} from '@nestjs/common';
import { PrismaService } from '../../common/prisma/prisma.service';
import { QueryTimelineDto } from './dto/query-timeline.dto';
import { CreateActivityDto } from './dto/create-activity.dto';
import { UpdateActivityDto } from './dto/update-activity.dto';

const MANUAL_TYPES = ['note_added', 'call_logged', 'whatsapp_logged', 'quote_logged', 'sample_logged'];

const ACTIVITY_TITLES: Record<string, string> = {
  lead_created: '创建了客户',
  lead_updated: '编辑了客户资料',
  lead_status_changed: '修改了客户状态',
  lead_deleted: '删除了客户',
  owner_changed: '修改了客户负责人',
  note_added: '添加了备注',
  call_logged: '记录了电话沟通',
  whatsapp_logged: '记录了 WhatsApp 沟通',
  email_sent: '发送了开发信',
  email_failed: '邮件发送失败',
  email_opened: '客户打开了邮件',
  email_clicked: '客户点击了邮件链接',
  unsubscribed: '客户退订了邮件',
  imported: '导入了客户',
  score_updated: '客户评分已更新',
  duplicate_detected: '发现了疑似重复客户',
  lead_merged: '合并了客户',
  reminder_created: '生成了跟进提醒',
  reminder_completed: '完成了跟进提醒',
  reminder_ignored: '忽略了跟进提醒',
  reminder_snoozed: '延期了跟进提醒',
  quote_logged: '记录了报价',
  sample_logged: '记录了样品',
  won: '客户成交',
  lost: '客户流失',
};

@Injectable()
export class TimelineService {
  constructor(private prisma: PrismaService) {}

  // ========== Shared: log activity from other modules ==========

  async logActivity(params: {
    companyId: string;
    leadId: string;
    userId?: string;
    activityType: string;
    title: string;
    description?: string;
    metadata?: any;
    referenceType?: string;
    referenceId?: string;
    occurredAt?: Date;
  }) {
    return this.prisma.leadActivity.create({
      data: {
        companyId: params.companyId,
        leadId: params.leadId,
        userId: params.userId || null,
        activityType: params.activityType,
        title: params.title,
        description: params.description || null,
        metadata: params.metadata || null,
        referenceType: params.referenceType || null,
        referenceId: params.referenceId || null,
        occurredAt: params.occurredAt || new Date(),
      },
    });
  }

  // ========== Timeline for a specific lead ==========

  async findTimeline(leadId: string, query: QueryTimelineDto, currentUser: any) {
    await this.checkLeadAccess(leadId, currentUser);

    const page = query.page || 1;
    const limit = query.limit || 20;
    const skip = (page - 1) * limit;

    const where: any = { leadId, deletedAt: null };
    if (query.activityType) {
      const types = query.activityType.split(',');
      where.activityType = types.length === 1 ? types[0] : { in: types };
    }
    if (query.dateFrom || query.dateTo) {
      where.occurredAt = {};
      if (query.dateFrom) where.occurredAt.gte = new Date(query.dateFrom);
      if (query.dateTo) where.occurredAt.lte = new Date(query.dateTo);
    }
    if (query.keyword) {
      where.OR = [
        { title: { contains: query.keyword, mode: 'insensitive' } },
        { description: { contains: query.keyword, mode: 'insensitive' } },
      ];
    }

    const [data, total] = await Promise.all([
      this.prisma.leadActivity.findMany({
        where,
        include: {
          user: { select: { id: true, firstName: true, lastName: true, email: true } },
        },
        skip,
        take: limit,
        orderBy: { occurredAt: 'desc' },
      }),
      this.prisma.leadActivity.count({ where }),
    ]);

    return { data, meta: { page, limit, total, totalPages: Math.ceil(total / limit) } };
  }

  // ========== Manual activity CRUD ==========

  async createActivity(leadId: string, dto: CreateActivityDto, currentUser: any) {
    const lead = await this.prisma.lead.findUnique({ where: { id: leadId } });
    if (!lead || lead.deletedAt) throw new NotFoundException('Lead not found');
    this.checkCompanyAccess(currentUser, lead.companyId);
    this.checkWriteAccess(currentUser, lead.companyId);

    const activity = await this.prisma.leadActivity.create({
      data: {
        companyId: lead.companyId,
        leadId,
        userId: currentUser.id,
        activityType: dto.activityType,
        title: dto.title,
        description: dto.description || null,
        metadata: dto.metadata || undefined,
        occurredAt: dto.occurredAt ? new Date(dto.occurredAt) : new Date(),
      },
      include: { user: { select: { id: true, firstName: true, lastName: true, email: true } } },
    });

    return activity;
  }

  async findOneActivity(leadId: string, activityId: string, currentUser: any) {
    await this.checkLeadAccess(leadId, currentUser);

    const activity = await this.prisma.leadActivity.findFirst({
      where: { id: activityId, leadId, deletedAt: null },
      include: { user: { select: { id: true, firstName: true, lastName: true, email: true } } },
    });
    if (!activity) throw new NotFoundException('Activity not found');
    return activity;
  }

  async updateActivity(leadId: string, activityId: string, dto: UpdateActivityDto, currentUser: any) {
    const activity = await this.prisma.leadActivity.findFirst({
      where: { id: activityId, leadId, deletedAt: null },
    });
    if (!activity) throw new NotFoundException('Activity not found');

    if (!MANUAL_TYPES.includes(activity.activityType)) {
      throw new ForbiddenException('Only manually created activities can be edited');
    }

    this.checkCompanyAccess(currentUser, activity.companyId);
    this.checkWriteAccess(currentUser, activity.companyId);

    const data: any = {};
    if (dto.title !== undefined) data.title = dto.title;
    if (dto.description !== undefined) data.description = dto.description;
    if (dto.occurredAt !== undefined) data.occurredAt = new Date(dto.occurredAt);
    if (dto.metadata !== undefined) data.metadata = dto.metadata;

    return this.prisma.leadActivity.update({
      where: { id: activityId },
      data,
      include: { user: { select: { id: true, firstName: true, lastName: true, email: true } } },
    });
  }

  async deleteActivity(leadId: string, activityId: string, currentUser: any) {
    const activity = await this.prisma.leadActivity.findFirst({
      where: { id: activityId, leadId, deletedAt: null },
    });
    if (!activity) throw new NotFoundException('Activity not found');

    if (!MANUAL_TYPES.includes(activity.activityType)) {
      throw new ForbiddenException('Only manually created activities can be deleted');
    }

    this.checkCompanyAccess(currentUser, activity.companyId);
    this.checkWriteAccess(currentUser, activity.companyId);

    return this.prisma.leadActivity.update({
      where: { id: activityId },
      data: { deletedAt: new Date() },
    });
  }

  // ========== Export CSV ==========

  async exportTimelineCSV(leadId: string, query: QueryTimelineDto, currentUser: any) {
    await this.checkLeadAccess(leadId, currentUser);

    const where: any = { leadId, deletedAt: null };
    if (query.activityType) {
      const types = query.activityType.split(',');
      where.activityType = types.length === 1 ? types[0] : { in: types };
    }
    if (query.dateFrom || query.dateTo) {
      where.occurredAt = {};
      if (query.dateFrom) where.occurredAt.gte = new Date(query.dateFrom);
      if (query.dateTo) where.occurredAt.lte = new Date(query.dateTo);
    }

    const data = await this.prisma.leadActivity.findMany({
      where,
      include: { user: { select: { id: true, firstName: true, lastName: true } } },
      orderBy: { occurredAt: 'desc' },
    });

    const header = 'Time,Type,Title,Description,User,Related\n';
    const rows = data.map((a) => {
      const user = a.user ? `${a.user.firstName} ${a.user.lastName}` : 'System';
      const time = a.occurredAt.toISOString();
      const desc = (a.description || '').replace(/"/g, '""');
      return `${time},"${a.activityType}","${a.title}","${desc}","${user}","${a.referenceType || ''}"`;
    }).join('\n');

    return header + rows;
  }

  // ========== Global Activity List ==========

  async findAllActivities(query: QueryTimelineDto, currentUser: any) {
    const page = query.page || 1;
    const limit = query.limit || 20;
    const skip = (page - 1) * limit;

    const where: any = this.buildCompanyWhere(currentUser);

    if (query.leadId) where.leadId = query.leadId;
    if (query.userId) where.userId = query.userId;
    if (query.activityType) {
      const types = query.activityType.split(',');
      where.activityType = types.length === 1 ? types[0] : { in: types };
    }
    if (query.dateFrom || query.dateTo) {
      where.occurredAt = {};
      if (query.dateFrom) where.occurredAt.gte = new Date(query.dateFrom);
      if (query.dateTo) where.occurredAt.lte = new Date(query.dateTo);
    }
    if (query.keyword) {
      where.OR = [
        { title: { contains: query.keyword, mode: 'insensitive' } },
        { description: { contains: query.keyword, mode: 'insensitive' } },
      ];
    }

    const [data, total] = await Promise.all([
      this.prisma.leadActivity.findMany({
        where,
        include: {
          lead: { select: { id: true, companyName: true, status: true } },
          user: { select: { id: true, firstName: true, lastName: true, email: true } },
        },
        skip,
        take: limit,
        orderBy: { occurredAt: 'desc' },
      }),
      this.prisma.leadActivity.count({ where }),
    ]);

    return { data, meta: { page, limit, total, totalPages: Math.ceil(total / limit) } };
  }

  // ========== Access Control ==========

  private async checkLeadAccess(leadId: string, currentUser: any) {
    const lead = await this.prisma.lead.findUnique({ where: { id: leadId } });
    if (!lead || lead.deletedAt) throw new NotFoundException('Lead not found');
    this.checkCompanyAccess(currentUser, lead.companyId);

    const isOnlySalesUser = currentUser.companies?.every(
      (c: any) => c.role === 'sales_user',
    );
    if (isOnlySalesUser && lead.ownerUserId !== currentUser.id) {
      throw new ForbiddenException('You can only access your own leads');
    }
  }

  private buildCompanyWhere(currentUser: any): any {
    const companyIds = currentUser.companies?.map((c: any) => c.id) || [];
    const isFullAccess = currentUser.companies?.some(
      (c: any) => ['super_admin', 'company_admin'].includes(c.role),
    );

    const where: any = { companyId: { in: companyIds }, deletedAt: null };

    if (!isFullAccess) {
      where.userId = currentUser.id;
    }

    return where;
  }

  private checkCompanyAccess(currentUser: any, companyId: string) {
    const isFullAccess = currentUser.companies?.some(
      (c: any) => ['super_admin', 'company_admin'].includes(c.role),
    );
    if (isFullAccess) return;

    const userCompanyIds = currentUser.companies?.map((c: any) => c.id) || [];
    if (!userCompanyIds.includes(companyId)) {
      throw new ForbiddenException('Cannot access activities from another company');
    }
  }

  private checkWriteAccess(currentUser: any, companyId: string) {
    const isFullAccess = currentUser.companies?.some(
      (c: any) => ['super_admin', 'company_admin'].includes(c.role),
    );
    if (isFullAccess) return;

    const company = currentUser.companies?.find((c: any) => c.id === companyId);
    if (!company) throw new ForbiddenException('Not a member of this company');

    if (company.role === 'viewer') {
      throw new ForbiddenException('Viewer cannot modify activities');
    }
  }
}
