import {
  ForbiddenException,
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { timingSafeEqual } from 'crypto';
import { PrismaService } from '../../common/prisma/prisma.service';
import { EmailIdentityAdapter } from '../customer-identity/email-identity.adapter';
import { OwnerNotificationService } from '../owner-notifications/owner-notification.service';

interface BrevoMailbox {
  Address?: string;
  Name?: string;
}

interface BrevoAttachment {
  Name?: string;
  ContentType?: string;
  ContentLength?: number;
  DownloadToken?: string;
}

interface BrevoInboundItem {
  MessageId?: string;
  From?: BrevoMailbox;
  To?: BrevoMailbox[];
  Recipients?: Array<BrevoMailbox | string>;
  SentAtDate?: string;
  Subject?: string;
  RawHtmlBody?: string;
  RawTextBody?: string;
  ExtractedMarkdownMessage?: string;
  Attachments?: BrevoAttachment[];
}

@Injectable()
export class BrevoInboundService {
  private readonly logger = new Logger(BrevoInboundService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly emailIdentityAdapter: EmailIdentityAdapter,
    private readonly ownerNotificationService: OwnerNotificationService,
  ) {}

  getStatus() {
    const inboundDomain = this.getInboundDomain();
    return {
      provider: 'brevo',
      enabled: Boolean(this.getWebhookToken() && inboundDomain),
      webhookReady: Boolean(this.getWebhookToken()),
      inboundDomain: inboundDomain || null,
      smtpHost: 'smtp-relay.brevo.com',
      smtpPort: 587,
      freeDailyLimit: 300,
    };
  }

  assertAuthorized(authorization?: string) {
    const expected = this.getWebhookToken();
    if (!expected) {
      throw new ServiceUnavailableException('Brevo inbound email is not configured');
    }

    const actual = authorization?.replace(/^Bearer\s+/i, '').trim() || '';
    const expectedBuffer = Buffer.from(expected);
    const actualBuffer = Buffer.from(actual);
    if (
      actualBuffer.length !== expectedBuffer.length ||
      !timingSafeEqual(actualBuffer, expectedBuffer)
    ) {
      throw new ForbiddenException('Invalid Brevo webhook token');
    }
  }

  async ingest(payload: { items?: BrevoInboundItem[] } | BrevoInboundItem) {
    const items = Array.isArray((payload as any)?.items)
      ? (payload as { items: BrevoInboundItem[] }).items
      : [payload as BrevoInboundItem];

    const results: Array<Record<string, unknown>> = [];
    for (const item of items.slice(0, 100)) {
      const fromEmail = item?.From?.Address?.trim().toLowerCase();
      const recipients = this.collectRecipients(item);
      const messageId = item?.MessageId?.trim();
      if (!fromEmail || !messageId || recipients.length === 0) {
        results.push({ status: 'skipped', reason: 'missing_identity' });
        continue;
      }

      const accounts = await this.prisma.emailAccount.findMany({
        where: {
          status: 'active',
          OR: [
            { replyToEmail: { in: recipients, mode: 'insensitive' } },
            { senderEmail: { in: recipients, mode: 'insensitive' } },
          ],
        },
        select: { id: true, companyId: true, replyToEmail: true, senderEmail: true },
        take: 2,
      });

      if (accounts.length === 0) {
        this.logger.warn(`No active email account matches Brevo recipients: ${recipients.join(', ')}`);
        results.push({ status: 'skipped', reason: 'unknown_recipient', messageId });
        continue;
      }
      if (accounts.length > 1) {
        this.logger.error(`Ambiguous Brevo recipient mapping: ${recipients.join(', ')}`);
        results.push({ status: 'skipped', reason: 'ambiguous_recipient', messageId });
        continue;
      }
      const account = accounts[0];

      const bodyText =
        item.ExtractedMarkdownMessage?.trim() ||
        item.RawTextBody?.trim() ||
        this.htmlToText(item.RawHtmlBody || '');
      const receivedAt = item.SentAtDate ? new Date(item.SentAtDate) : new Date();
      const ingestResult = await this.emailIdentityAdapter.ingest({
        companyId: account.companyId,
        email: fromEmail,
        displayNameCandidate: item.From?.Name,
        messageId,
        subject: item.Subject || null,
        bodyText,
        receivedAt: Number.isNaN(receivedAt.getTime()) ? new Date() : receivedAt,
      });

      let conversationId: string | null = null;
      if (ingestResult.emailMessageId) {
        const message = await this.prisma.communicationMessage.update({
          where: { id: ingestResult.emailMessageId },
          data: {
            toAddress: recipients[0],
            attachmentsMeta: (item.Attachments || []).map((attachment) => ({
              filename: attachment.Name || 'attachment',
              size: attachment.ContentLength || 0,
              mimeType: attachment.ContentType || 'application/octet-stream',
              provider: 'brevo',
              downloadToken: attachment.DownloadToken || null,
            })),
          },
        });
        conversationId = message.conversationId || null;
      }

      await this.ownerNotificationService.enqueueInbound({
        companyId: account.companyId,
        eventType: 'EMAIL_INBOUND',
        sourceMessageKey: messageId,
        sourceType: 'brevo_inbound_email',
        sourceId: ingestResult.emailMessageId || null,
        conversationId,
        leadId: ingestResult.leadId || null,
        subject: item.Subject || '新邮件',
        preview: bodyText,
      });

      results.push({
        status: 'received',
        accountId: account.id,
        messageId,
        ...ingestResult,
      });
    }

    return {
      status: 'ok',
      received: results.filter((result) => result.status === 'received').length,
      skipped: results.filter((result) => result.status === 'skipped').length,
      results,
    };
  }

  private getWebhookToken() {
    const token = process.env.BREVO_INBOUND_WEBHOOK_TOKEN?.trim();
    if (!token || token.length < 32 || /^(change|replace|example)/i.test(token)) return '';
    return token;
  }

  private getInboundDomain() {
    const domain = process.env.BREVO_INBOUND_DOMAIN?.trim().toLowerCase() || '';
    if (!domain || /(^|\.)example\.(com|net|org)$/i.test(domain)) return '';
    return /^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?\.[a-z]{2,}$/i.test(domain) ? domain : '';
  }

  private collectRecipients(item: BrevoInboundItem) {
    const values = [
      ...(item.To || []).map((mailbox) => mailbox.Address),
      ...(item.Recipients || []).map((recipient) =>
        typeof recipient === 'string' ? recipient : recipient.Address,
      ),
    ];
    return Array.from(
      new Set(
        values
          .filter((value): value is string => Boolean(value))
          .map((value) => value.trim().toLowerCase())
          .filter((value) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(value)),
      ),
    );
  }

  private htmlToText(html: string) {
    return html
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/p>/gi, '\n')
      .replace(/<[^>]+>/g, ' ')
      .replace(/&nbsp;/gi, ' ')
      .replace(/&amp;/gi, '&')
      .replace(/&lt;/gi, '<')
      .replace(/&gt;/gi, '>')
      .replace(/[ \t]+/g, ' ')
      .replace(/\n\s+/g, '\n')
      .trim();
  }
}
