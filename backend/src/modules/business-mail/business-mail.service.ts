import {
  BadRequestException,
  Injectable,
  NotFoundException,
  ForbiddenException,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import * as nodemailer from 'nodemailer';
import { PrismaService } from '../../common/prisma/prisma.service';
import { encrypt, decrypt } from '../../common/utils/crypto.util';
import { ensureCompanyAccess } from '../../common/utils/data-isolation';
import { SendMailDto } from './dto/send-mail.dto';
import {
  ensureCompanyWebsite,
  findLegacyEmailBrandReference,
  resolveEmailCompanyWebsite,
  validateEmailContent,
} from '../emails/email-content.guard';
import { prepareEmailForExternalDelivery } from '../emails/email-public-links';

@Injectable()
export class BusinessMailService {
  private readonly logger = new Logger(BusinessMailService.name);

  constructor(private prisma: PrismaService) {}

  // ========== SMTP: Send one-to-one email ==========

  async sendMail(dto: SendMailDto, currentUser: any) {
    const account = await this.prisma.emailAccount.findUnique({
      where: { id: dto.emailAccountId },
      include: { company: true },
    });
    if (!account) throw new NotFoundException('Email account not found');
    this.ensureAccess(currentUser, account.companyId);

    // Verify leadId and conversationId belong to same company
    if (dto.leadId) {
      const lead = await this.prisma.lead.findUnique({ where: { id: dto.leadId } });
      if (!lead || lead.companyId !== account.companyId) throw new ForbiddenException('Lead does not belong to this company');
    }
    if (dto.conversationId) {
      const conv = await this.prisma.conversation.findUnique({ where: { id: dto.conversationId } });
      if (!conv || conv.companyId !== account.companyId) throw new ForbiddenException('Conversation does not belong to this company');
    }

    if (dto.attachments?.some((attachment) => Boolean((attachment as any).path))) {
      throw new BadRequestException('Attachment filesystem paths are not accepted; upload content through an approved file flow');
    }

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

    // Do not even open an SMTP connection while the safety switch is active.
    if (process.env.EMAIL_SEND_ENABLED === 'false' || process.env.EMAIL_SEND_DISABLED === 'true') {
      this.logger.warn('Email sending disabled - SMTP delivery blocked by safety switch');
      throw new ServiceUnavailableException({
        status: 'BLOCKED',
        code: 'EMAIL_SEND_DISABLED',
        message: 'Email delivery is blocked by the server safety switch',
      });
    }

    const password = decrypt(account.smtpPasswordEncrypted);

    const transporter = nodemailer.createTransport({
      host: account.smtpHost,
      port: account.smtpPort,
      secure: account.smtpSecure,
      auth: { user: account.smtpUsername, pass: password },
    });

    // Verify connection
    try {
      await transporter.verify();
    } catch (err: any) {
      this.logger.error(`SMTP verify failed for ${account.senderEmail}: ${err.message}`);
      throw new Error(`SMTP connection failed: ${err.message}`);
    }

    const info = await transporter.sendMail({
      from: `"${account.senderName}" <${account.senderEmail}>`,
      replyTo: account.replyToEmail || account.senderEmail,
      to: dto.to,
      subject: dto.subject,
      html: deliverableHtml,
      attachments: dto.attachments?.map((a) => ({
        filename: a.filename,
        content: a.content,
      })),
    });

    // Find or create conversation
    let conversationId = dto.conversationId;
    if (!conversationId && dto.leadId) {
      const conversation = await this.prisma.conversation.create({
        data: {
          companyId: account.companyId,
          leadId: dto.leadId,
          channel: 'business_email',
          subject: dto.subject,
          lastMessageAt: new Date(),
          lastMessagePreview: deliverableHtml.replace(/<[^>]*>/g, '').substring(0, 200) || '',
        },
      });
      conversationId = conversation.id;
    }

    // Save to CommunicationMessage
    if (conversationId) {
      await this.prisma.communicationMessage.create({
        data: {
          conversationId,
          direction: 'outbound',
          content: deliverableHtml || dto.subject,
          contentType: 'html',
          externalMessageId: info.messageId,
          fromAddress: account.senderEmail,
          toAddress: dto.to,
          subject: dto.subject,
          sentAt: new Date(),
        },
      });

      // Update conversation
      await this.prisma.conversation.update({
        where: { id: conversationId },
        data: {
          lastMessageAt: new Date(),
          lastMessagePreview: dto.subject,
        },
      });
    }

    this.logger.log(`Email sent: ${info.messageId} to ${dto.to}`);
    return { messageId: info.messageId, accepted: info.accepted, response: info.response };
  }

  // ========== SMTP: Test connection ==========

  async testSmtp(accountId: string, currentUser: any) {
    const account = await this.prisma.emailAccount.findUnique({
      where: { id: accountId },
    });
    if (!account) throw new NotFoundException('Email account not found');
    this.ensureAccess(currentUser, account.companyId);

    const password = decrypt(account.smtpPasswordEncrypted);

    const transporter = nodemailer.createTransport({
      host: account.smtpHost,
      port: account.smtpPort,
      secure: account.smtpSecure,
      auth: { user: account.smtpUsername, pass: password },
    });

    try {
      await transporter.verify();
      return { success: true, message: `SMTP connection to ${account.smtpHost}:${account.smtpPort} successful` };
    } catch (err: any) {
      return { success: false, message: err.message };
    }
  }

  // ========== Access Control ==========

  private ensureAccess(currentUser: any, companyId: string) {
    try {
      ensureCompanyAccess(currentUser, companyId);
    } catch (err: any) {
      throw new ForbiddenException(err.message?.replace('FORBIDDEN: ', '') || 'Access denied');
    }
  }
}
