import { Injectable, NotFoundException, BadRequestException } from '@nestjs/common';
import { PrismaService } from '../../common/prisma/prisma.service';
import { TimelineService } from '../timeline/timeline.service';

@Injectable()
export class UnsubscribeService {
  constructor(
    private prisma: PrismaService,
    private timelineService: TimelineService,
  ) {}

  async getByToken(token: string) {
    const msg = await this.prisma.emailMessage.findUnique({
      where: { unsubscribeToken: token },
      include: {
        lead: { select: { id: true, companyName: true, contactEmail: true, status: true } },
      },
    });

    if (!msg) {
      throw new NotFoundException('Invalid unsubscribe token');
    }

    const already = await this.prisma.unsubscribeRecord.findFirst({
      where: { leadId: msg.leadId },
    });

    return {
      token,
      lead: msg.lead
        ? {
            companyName: msg.lead.companyName,
            contactEmail: msg.lead.contactEmail,
          }
        : null,
      alreadyUnsubscribed: !!already,
      emailSubject: msg.subject,
    };
  }

  async confirmUnsubscribe(token: string, ipAddress?: string, reason?: string) {
    const msg = await this.prisma.emailMessage.findUnique({
      where: { unsubscribeToken: token },
      include: { lead: true },
    });

    if (!msg) {
      throw new NotFoundException('Invalid unsubscribe token');
    }

    if (!msg.lead) {
      throw new NotFoundException('Associated lead not found');
    }

    // Check if already unsubscribed
    const existing = await this.prisma.unsubscribeRecord.findFirst({
      where: { leadId: msg.leadId },
    });

    if (existing) {
      return { success: true, message: 'Already unsubscribed', alreadyUnsubscribed: true };
    }

    // Create unsubscribe record
    await this.prisma.unsubscribeRecord.create({
      data: {
        companyId: msg.companyId,
        leadId: msg.leadId,
        email: msg.lead.contactEmail || msg.toEmail || '',
        token,
        unsubscribedAt: new Date(),
        ipAddress: ipAddress || null,
        reason: reason || null,
      },
    });

    const oldStatus = msg.lead.status;

    // Mark lead as lost
    await this.prisma.lead.update({
      where: { id: msg.leadId },
      data: { status: 'lost' },
    });

    // Create unsubscribe activity
    await this.timelineService.logActivity({
      companyId: msg.companyId,
      leadId: msg.leadId,
      activityType: 'unsubscribed',
      title: '客户退订了邮件',
      description: `通过邮件退订: ${msg.subject}`,
      referenceType: 'UnsubscribeRecord',
      referenceId: msg.leadId,
    });

    // Create status change activity
    await this.timelineService.logActivity({
      companyId: msg.companyId,
      leadId: msg.leadId,
      activityType: 'lead_status_changed',
      title: '修改了客户状态',
      description: `Status changed from "${oldStatus}" to "lost" (unsubscribed)`,
      metadata: { oldStatus, newStatus: 'lost' },
      referenceType: 'Lead',
      referenceId: msg.leadId,
    });

    return { success: true, message: 'Successfully unsubscribed' };
  }
}
