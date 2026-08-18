import {
  BadRequestException,
  Injectable,
  NotFoundException,
  ForbiddenException,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { createHash } from 'crypto';
import { PrismaService } from '../../common/prisma/prisma.service';
import { encrypt, decrypt } from '../../common/utils/crypto.util';
import { SendMailDto } from './dto/send-mail.dto';
import {
  ensureCompanyWebsite,
  findLegacyEmailBrandReference,
  resolveEmailCompanyWebsite,
  validateEmailContent,
} from '../emails/email-content.guard';
import { prepareEmailForExternalDelivery } from '../emails/email-public-links';
import { OutboundComplianceService } from '../outbound/outbound-compliance.service';
import { resolveSmtpEgress } from '../email-accounts/smtp-egress.policy';
import {
  assertSmtpAcceptedTarget,
  createAbortableSmtpTransport,
} from '../email-accounts/smtp-delivery';
import { requireActiveCompany } from '../../common/utils/data-isolation';
import { safeLogEvent } from '../../common/security/safe-logging';

type InternalSendMailDto = SendMailDto & {
  actorType?: 'HUMAN' | 'AGENT';
  actionType?: 'RAW_SMTP' | 'OPENCLAW_EMAIL_SEND' | 'OPENCLAW_EMAIL_REPLY';
};

@Injectable()
export class BusinessMailService {
  private readonly logger = new Logger(BusinessMailService.name);

  constructor(
    private prisma: PrismaService,
    private readonly outbound: OutboundComplianceService,
  ) {}

  // ========== SMTP: Send one-to-one email ==========

  async sendMail(dto: InternalSendMailDto, currentUser: any) {
    const companyId = requireActiveCompany(currentUser).id;
    const account = await this.prisma.emailAccount.findFirst({
      where: { id: dto.emailAccountId, companyId },
      include: { company: true },
    });
    if (!account) throw new NotFoundException('Email account not found');
    await this.assertActiveAdmin(currentUser, companyId);

    if (!dto.leadId) {
      throw new BadRequestException('A tenant-scoped lead binding is required for raw SMTP delivery');
    }
    const lead = await this.prisma.lead.findFirst({
      where: {
        id: dto.leadId,
        companyId: account.companyId,
        deletedAt: null,
      },
      select: { id: true },
    });
    if (!lead) {
      throw new ForbiddenException('Lead does not belong to this company');
    }

    // Every caller-supplied conversation binding is fully authorized before
    // OutboundCompliance can invoke SMTP. No predictable CRM validation may
    // happen after a durable provider side effect.
    let conversation = dto.conversationId
      ? await this.prisma.conversation.findFirst({
          where: {
            id: dto.conversationId,
            companyId: account.companyId,
            leadId: dto.leadId,
            channel: 'business_email',
            status: 'active',
          },
          select: { id: true },
        })
      : await this.prisma.conversation.findFirst({
          where: {
            companyId: account.companyId,
            leadId: dto.leadId,
            channel: 'business_email',
            status: 'active',
          },
          orderBy: [{ updatedAt: 'desc' }, { id: 'asc' }],
          select: { id: true },
        });
    if (dto.conversationId && !conversation) {
      throw new ForbiddenException(
        'Conversation is not an active email thread for this lead',
      );
    }

    if (dto.attachments?.some((attachment) => Boolean((attachment as any).path))) {
      throw new BadRequestException('Attachment filesystem paths are not accepted; upload content through an approved file flow');
    }
    const preparedAttachments = (dto.attachments || []).map((attachment, index) => {
      const content = Buffer.from(String(attachment.content || ''));
      const mimeType = this.detectAttachmentMime(content, attachment.filename);
      if (
        attachment.mimeType
        && attachment.mimeType !== 'application/octet-stream'
        && attachment.mimeType.toLowerCase() !== mimeType
      ) {
        throw new BadRequestException(`Attachment MIME does not match its bytes: ${attachment.filename}`);
      }
      return {
        filename: attachment.filename,
        content,
        mimeType,
        sourceId: dto.actorType === 'AGENT' && attachment.sourceId
          ? attachment.sourceId
          : `smtp-upload:${index}`,
      };
    });

    const legacyEnvelope = findLegacyEmailBrandReference(
      account.senderName,
      account.senderEmail,
      account.replyToEmail,
    );
    if (legacyEnvelope) {
      throw new BadRequestException(`Email sender contains a retired brand or domain: ${legacyEnvelope}`);
    }

    const companyWebsite = resolveEmailCompanyWebsite(account.company?.website);
    const deliverableHtml = prepareEmailForExternalDelivery(
      ensureCompanyWebsite(dto.html, companyWebsite, companyWebsite.replace(/^https?:\/\//i, '')),
    );
    const validation = validateEmailContent(dto.subject, deliverableHtml, companyWebsite);
    if (!validation.valid) {
      throw new BadRequestException(validation.reason || 'Email content validation failed');
    }

    // Do not even reserve an action while the safety switch is active.
    if (process.env.EMAIL_SEND_ENABLED === 'false' || process.env.EMAIL_SEND_DISABLED === 'true') {
      this.logger.warn('Email sending disabled - SMTP delivery blocked by safety switch');
      throw new ServiceUnavailableException({
        status: 'BLOCKED',
        code: 'EMAIL_SEND_DISABLED',
        message: 'Email delivery is blocked by the server safety switch',
      });
    }

    const execution = await this.outbound.execute({
      companyId: account.companyId,
      operatorUser: currentUser,
      actorType: dto.actorType === 'AGENT' ? 'AGENT' : 'HUMAN',
      channel: 'EMAIL',
      actionType: dto.actionType || 'RAW_SMTP',
      idempotencyKey: dto.idempotencyKey || '',
      leadId: dto.leadId,
      targetAddress: dto.to,
      emailAccountId: account.id,
      conversationId: dto.conversationId,
      subject: dto.subject,
      body: deliverableHtml,
      contentType: 'html',
      artifacts: preparedAttachments.map((attachment) => ({
        sourceId: attachment.sourceId,
        bytes: attachment.content,
        mimeType: attachment.mimeType,
        filename: attachment.filename,
      })),
      requireAdmin: true,
    }, async (outboundArtifacts, envelope) => {
      const password = decrypt(account.smtpPasswordEncrypted);
      const egress = await resolveSmtpEgress(account);
      const { transporter, close } = createAbortableSmtpTransport(
        egress,
        { user: account.smtpUsername, pass: password },
        envelope.signal,
      );
      try {
        await transporter.verify();
      } catch (err: any) {
        close();
        this.logger.error(safeLogEvent('business_mail.smtp_verify_failed', {
          accountId: account.id,
          error: err,
        }));
        const rejection: any = new ServiceUnavailableException(
          {
            status: 'error',
            code: 'SMTP_VERIFY_FAILED',
            message: 'SMTP connection failed before message dispatch',
          },
        );
        rejection.providerDeliveryOutcome = 'REJECTED';
        rejection.providerAccepted = false;
        throw rejection;
      }
      let info: any;
      try {
        info = await transporter.sendMail({
          from: `"${account.senderName}" <${account.senderEmail}>`,
          replyTo: account.replyToEmail || account.senderEmail,
          to: envelope.targetAddress,
          subject: envelope.subject,
          html: envelope.body,
          attachments: preparedAttachments.length
            ? preparedAttachments.map((a, index) => ({
                filename: a.filename,
                content: outboundArtifacts[index].bytes,
                contentType: a.mimeType,
              }))
            : undefined,
        });
      } finally {
        close();
      }
      const messageId = String(info.messageId || '').trim();
      if (!messageId) throw new ServiceUnavailableException('SMTP provider returned no message id');
      const accepted = assertSmtpAcceptedTarget(info, envelope.targetAddress);
      return {
        provider: 'smtp',
        receiptId: messageId,
        acceptedAt: new Date(),
        metadata: {
          acceptedCount: accepted.length,
          rejectedCount: Array.isArray(info.rejected) ? info.rejected.length : 0,
        },
      };
    });
    const info = {
      messageId: execution.receipt.receiptId,
      accepted: [dto.to.trim().toLowerCase()],
      response: execution.deduplicated ? 'idempotent replay' : 'accepted',
    };

    // Always project the durable Outbox success. An idempotent replay repairs
    // a crash between provider receipt persistence and CRM projection without
    // issuing a second provider call.
    if (!conversation) {
      conversation = await this.prisma.conversation.create({
        data: {
          companyId: account.companyId,
          leadId: dto.leadId,
          channel: 'business_email',
          subject: dto.subject,
          lastMessageAt: new Date(),
          lastMessagePreview: deliverableHtml.replace(/<[^>]*>/g, '').substring(0, 200) || '',
        },
      });
    }

    const projectionKey = createHash('sha256')
      .update(JSON.stringify(['external-action-projection', execution.outboxId]))
      .digest('hex');
    const projectedAt = new Date(execution.receipt.acceptedAt || new Date());
    await this.prisma.communicationMessage.upsert({
      where: { ingestionKey: projectionKey },
      create: {
          conversationId: conversation.id,
          direction: 'outbound',
          content: deliverableHtml || dto.subject,
          contentType: 'html',
          externalMessageId: info.messageId,
          ingestionKey: projectionKey,
          fromAddress: account.senderEmail,
          toAddress: dto.to.trim().toLowerCase(),
          subject: dto.subject,
          deliveryStatus: 'sent',
          sentAt: projectedAt,
      },
      update: {
        deliveryStatus: 'sent',
        externalMessageId: info.messageId,
        sentAt: projectedAt,
      },
    });
    await this.prisma.conversation.updateMany({
      where: {
        id: conversation.id,
        companyId: account.companyId,
        leadId: dto.leadId,
        channel: 'business_email',
        status: 'active',
      },
      data: {
        lastMessageAt: new Date(),
        lastMessagePreview: dto.subject,
      },
    });

    this.logger.log(safeLogEvent('business_mail.email_sent', {
      messageId: info.messageId,
      recipientEmail: dto.to,
      status: 'accepted',
    }));
    return {
      messageId: info.messageId,
      accepted: info.accepted,
      response: info.response,
      outboxId: execution.outboxId,
      deduplicated: execution.deduplicated,
    };
  }

  private detectAttachmentMime(bytes: Buffer, filename: string) {
    if (bytes.subarray(0, 5).toString('ascii') === '%PDF-') return 'application/pdf';
    if (bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return 'image/png';
    if (bytes.subarray(0, 3).equals(Buffer.from([255, 216, 255]))) return 'image/jpeg';
    if (['GIF87a', 'GIF89a'].includes(bytes.subarray(0, 6).toString('ascii'))) return 'image/gif';
    if (
      bytes.subarray(0, 4).toString('ascii') === 'RIFF'
      && bytes.subarray(8, 12).toString('ascii') === 'WEBP'
    ) return 'image/webp';
    if (/\.txt$/i.test(filename)) return 'text/plain';
    if (/\.csv$/i.test(filename)) return 'text/csv';
    return 'application/octet-stream';
  }

  // ========== SMTP: Test connection ==========

  async testSmtp(accountId: string, currentUser: any) {
    const companyId = requireActiveCompany(currentUser).id;
    const account = await this.prisma.emailAccount.findFirst({
      where: { id: accountId, companyId },
    });
    if (!account) throw new NotFoundException('Email account not found');
    await this.assertActiveAdmin(currentUser, companyId);

    const password = decrypt(account.smtpPasswordEncrypted);
    const egress = await resolveSmtpEgress(account);
    const controller = new AbortController();
    const deadline = setTimeout(() => controller.abort(), 10_000);
    const { transporter, close } = createAbortableSmtpTransport(
      egress,
      { user: account.smtpUsername, pass: password },
      controller.signal,
    );

    try {
      await transporter.verify();
      return { success: true, code: 'SMTP_CONNECTION_OK', message: 'SMTP connection successful' };
    } catch (err: any) {
      return { success: false, code: 'SMTP_CONNECTION_FAILED', message: 'SMTP connection failed' };
    } finally {
      clearTimeout(deadline);
      close();
    }
  }

  // ========== Access Control ==========

  private async assertActiveAdmin(currentUser: any, companyId: string) {
    const activeCompanyId = String(currentUser?.activeCompanyId || '').trim();
    if (
      !activeCompanyId
      || activeCompanyId !== companyId
      || (currentUser?.activeCompany?.id && currentUser.activeCompany.id !== activeCompanyId)
      || !currentUser?.id
    ) {
      throw new ForbiddenException('Target company is not the authenticated active company');
    }
    const relation = await this.prisma.userCompanyRelation.findFirst({
      where: {
        userId: currentUser.id,
        companyId,
        isActive: true,
        user: {
          is: {
            isActive: true,
            deletedAt: null,
          },
        },
        company: {
          is: {
            isActive: true,
          },
        },
      },
      include: { role: { select: { name: true } } },
    });
    if (!['super_admin', 'company_admin'].includes(String(relation?.role?.name || ''))) {
      throw new ForbiddenException('Company administrator role is required for raw SMTP operations');
    }
  }
}
