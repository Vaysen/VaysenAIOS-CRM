import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../common/prisma/prisma.service';
import { FollowUpRemindersService } from '../follow-up-reminders/follow-up-reminders.service';
import { TimelineService } from '../timeline/timeline.service';

@Injectable()
export class EmailTrackService {
  private readonly logger = new Logger(EmailTrackService.name);

  // 1x1 transparent GIF
  private readonly PIXEL = Buffer.from(
    'R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7',
    'base64',
  );

  constructor(
    private prisma: PrismaService,
    private followUpRemindersService: FollowUpRemindersService,
    private timelineService: TimelineService,
  ) {}

  async trackOpen(trackingId: string, ipAddress?: string, userAgent?: string) {
    try {
      const msg = await this.prisma.emailMessage.findUnique({
        where: { trackingId },
        include: { lead: true },
      });

      if (!msg) {
        this.logger.warn(`Tracking pixel hit for unknown trackingId: ${trackingId}`);
        return this.PIXEL;
      }

      // Record open event
      await this.prisma.emailOpenEvent.create({
        data: {
          emailId: msg.id,
          leadId: msg.leadId,
          campaignId: msg.campaignId,
          openedAt: new Date(),
          ipAddress: ipAddress || null,
          userAgent: userAgent || null,
        },
      });

      // Update email message opened_at if first time
      if (!msg.openedAt) {
        await this.prisma.emailMessage.update({
          where: { id: msg.id },
          data: { openedAt: new Date(), status: 'Opened' },
        });
      }

      // Log email open activity (no longer auto-changes lead stage)
      if (msg.lead) {
        if (msg.lead.status === 'prospect_pool') {
          await this.prisma.lead.update({
            where: { id: msg.leadId },
            data: {
              status: 'contacted',
              lastContactedAt: new Date(),
              nextFollowUpAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
            },
          });
        }

        await this.timelineService.logActivity({
          companyId: msg.companyId,
          leadId: msg.leadId,
          activityType: 'email_opened',
          title: '客户打开了邮件',
          description: `邮件 "${msg.subject}" 已被打开`,
          referenceType: 'EmailMessage',
          referenceId: msg.id,
        });
      }

      // Auto-generate follow-up reminders after open
      this.followUpRemindersService.generateForLead(msg.leadId).catch(() => {});
      // Auto-tag: Email Opened
      this.addEngagementTag(msg.leadId, msg.companyId, 'Email Opened').catch(() => {});
    } catch (err: any) {
      this.logger.error(`Error tracking open for ${trackingId}: ${err.message}`);
    }

    // Always return the pixel, even on error
    return this.PIXEL;
  }

  async trackClick(trackingId: string, originalUrl: string, ipAddress?: string, userAgent?: string) {
    try {
      // Validate URL to prevent open redirect attacks
      let parsedUrl: URL;
      try {
        parsedUrl = new URL(originalUrl);
      } catch {
        this.logger.warn(`Invalid URL in click tracking: ${originalUrl}`);
        return '/';
      }

      // Only allow http/https protocols
      if (!['http:', 'https:'].includes(parsedUrl.protocol)) {
        this.logger.warn(`Non-HTTP protocol in click tracking: ${parsedUrl.protocol}`);
        return '/';
      }

      const msg = await this.prisma.emailMessage.findUnique({
        where: { trackingId },
        include: { lead: true },
      });

      if (!msg) {
        this.logger.warn(`Click tracking hit for unknown trackingId: ${trackingId}`);
        return originalUrl;
      }

      // Record click event
      await this.prisma.emailClickEvent.create({
        data: {
          emailId: msg.id,
          leadId: msg.leadId,
          campaignId: msg.campaignId,
          originalUrl,
          clickedAt: new Date(),
          ipAddress: ipAddress || null,
          userAgent: userAgent || null,
        },
      });

      // Update email message clicked_at if first time
      if (!msg.clickedAt) {
        await this.prisma.emailMessage.update({
          where: { id: msg.id },
          data: { clickedAt: new Date(), status: 'Clicked' },
        });
      }

      // Update lastContactedAt on click (no longer auto-changes lead stage)
      if (msg.lead) {
        await this.prisma.lead.update({
          where: { id: msg.leadId },
          data: {
            status: msg.lead.status === 'prospect_pool' || msg.lead.status === 'contacted'
              ? 'interested'
              : msg.lead.status,
            lastContactedAt: new Date(),
            nextFollowUpAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
          },
        });

        await this.timelineService.logActivity({
          companyId: msg.companyId,
          leadId: msg.leadId,
          activityType: 'email_clicked',
          title: '客户点击了邮件链接',
          description: `邮件 "${msg.subject}" 中的链接被点击: ${originalUrl}`,
          referenceType: 'EmailMessage',
          referenceId: msg.id,
        });
      }

      // Auto-generate follow-up reminders after click
      this.followUpRemindersService.generateForLead(msg.leadId).catch(() => {});
      // Auto-tag: Email Clicked (upgrades from Email Opened)
      this.addEngagementTag(msg.leadId, msg.companyId, 'Email Clicked').catch(() => {});
    } catch (err: any) {
      this.logger.error(`Error tracking click for ${trackingId}: ${err.message}`);
    }

    return originalUrl;
  }

  private async addEngagementTag(leadId: string, companyId: string, tagName: string) {
    try {
      const tag = await this.prisma.tag.findFirst({
        where: { companyId, name: tagName, category: 'engagement' },
      });
      if (!tag) return;
      await this.prisma.leadTag.create({
        data: { leadId, tagId: tag.id, createdBy: 'system' },
      }).catch(() => {}); // Ignore duplicate
      // Remove Email Opened when Email Clicked is added
      if (tagName === 'Email Clicked') {
        const openedTag = await this.prisma.tag.findFirst({
          where: { companyId, name: 'Email Opened', category: 'engagement' },
        });
        if (openedTag) {
          await this.prisma.leadTag.deleteMany({
            where: { leadId, tagId: openedTag.id },
          });
        }
      }
    } catch (err: any) {
      this.logger?.error?.('Engagement tag addition failed: ' + (err?.message || err), err?.stack);
    }
  }
}
