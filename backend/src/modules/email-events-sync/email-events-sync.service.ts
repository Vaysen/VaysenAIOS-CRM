import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../common/prisma/prisma.service';

@Injectable()
export class EmailEventsSyncService {
  private readonly logger = new Logger(EmailEventsSyncService.name);

  constructor(private prisma: PrismaService) {}

  /** Sync all unsynced email events to LeadActivity timeline for a company */
  async syncAll(companyId: string): Promise<{ synced: number }> {
    let synced = 0;

    // 1. Sent events → timeline
    const sentEmails = await this.prisma.emailMessage.findMany({
      where: { companyId, sentAt: { not: null }, deletedAt: null },
    });
    for (const email of sentEmails) {
      const exists = await this.prisma.leadActivity.findFirst({
        where: { leadId: email.leadId, activityType: 'email_sent', referenceId: email.id },
      });
      if (!exists && email.sentAt) {
        await this.prisma.leadActivity.create({
          data: {
            companyId,
            leadId: email.leadId,
            activityType: 'email_sent',
            title: `Sent marketing email: ${email.subject}`,
            referenceType: 'email_message',
            referenceId: email.id,
            occurredAt: email.sentAt,
          },
        });
        synced++;
      }
    }

    // 2. Open events
    const openEvents = await this.prisma.emailOpenEvent.findMany({
      where: { email: { companyId } },
      include: { email: true },
    });
    for (const ev of openEvents) {
      const exists = await this.prisma.leadActivity.findFirst({
        where: { leadId: ev.leadId, activityType: 'email_opened', referenceId: ev.emailId },
      });
      if (!exists) {
        await this.prisma.leadActivity.create({
          data: {
            companyId,
            leadId: ev.leadId,
            activityType: 'email_opened',
            title: `Email opened: ${ev.email?.subject || 'unknown'}`,
            description: `Opened ${ev.count} time(s)`,
            referenceType: 'email_message',
            referenceId: ev.emailId,
            occurredAt: ev.openedAt,
          },
        });
        synced++;
      }
    }

    // 3. Click events
    const clickEvents = await this.prisma.emailClickEvent.findMany({
      where: { email: { companyId } },
      include: { email: true },
    });
    for (const ev of clickEvents) {
      const exists = await this.prisma.leadActivity.findFirst({
        where: { leadId: ev.leadId, activityType: 'email_clicked', referenceId: ev.emailId },
      });
      if (!exists) {
        await this.prisma.leadActivity.create({
          data: {
            companyId,
            leadId: ev.leadId,
            activityType: 'email_clicked',
            title: `Email link clicked: ${ev.email?.subject || 'unknown'}`,
            description: `Clicked: ${ev.originalUrl}`,
            referenceType: 'email_message',
            referenceId: ev.emailId,
            occurredAt: ev.clickedAt,
          },
        });
        synced++;
      }
    }

    // 4. Bounce events
    const bounceEvents = await this.prisma.emailBounceEvent.findMany({
      where: { email: { companyId } },
      include: { email: true },
    });
    for (const ev of bounceEvents) {
      const exists = await this.prisma.leadActivity.findFirst({
        where: { leadId: ev.leadId, activityType: 'email_failed', referenceId: ev.emailId },
      });
      if (!exists) {
        await this.prisma.leadActivity.create({
          data: {
            companyId,
            leadId: ev.leadId,
            activityType: 'email_failed',
            title: `Email bounced: ${ev.email?.subject || 'unknown'}`,
            description: `${ev.bounceType}: ${ev.reason || 'No reason'}`,
            referenceType: 'email_message',
            referenceId: ev.emailId,
            occurredAt: ev.bouncedAt,
          },
        });
        synced++;
      }
    }

    // 5. Unsubscribe events
    const unsubs = await this.prisma.unsubscribeRecord.findMany({
      where: { companyId },
    });
    for (const record of unsubs) {
      const exists = await this.prisma.leadActivity.findFirst({
        where: { leadId: record.leadId, activityType: 'unsubscribed', referenceId: record.id },
      });
      if (!exists) {
        await this.prisma.leadActivity.create({
          data: {
            companyId,
            leadId: record.leadId,
            activityType: 'unsubscribed',
            title: `Unsubscribed: ${record.email}`,
            description: record.reason || 'No reason given',
            referenceType: 'unsubscribe_record',
            referenceId: record.id,
            occurredAt: record.unsubscribedAt,
          },
        });
        synced++;
      }
    }

    this.logger.log(`Synced ${synced} events for company ${companyId}`);
    return { synced };
  }
}
