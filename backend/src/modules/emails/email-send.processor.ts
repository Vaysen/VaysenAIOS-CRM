import { Processor, WorkerHost } from '@nestjs/bullmq';
import { InjectQueue } from '@nestjs/bullmq';
import { Job, Queue } from 'bullmq';
import { Logger } from '@nestjs/common';
import * as nodemailer from 'nodemailer';
import { Resolver, resolveMx } from 'dns/promises';
import { PrismaService } from '../../common/prisma/prisma.service';
import { decrypt } from '../../common/utils/crypto.util';
import { FollowUpRemindersService } from '../follow-up-reminders/follow-up-reminders.service';
import { TimelineService } from '../timeline/timeline.service';
import { QUEUES } from '@/common/queues/queue-names';
import { findLegacyEmailBrandReference, validateEmailContent } from './email-content.guard';
import { prepareEmailForExternalDelivery } from './email-public-links';

type SendJob = {
  emailMessageId: string;
  aiPersonalize?: boolean;
};

const SENDABLE_EMAIL_VERIFICATION_STATUSES = new Set(['smtp_verified', 'official_page_verified', 'verified_public_source']);
const VALID_EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const AUTO_SEND_BUSINESS_MAILBOXES = new Set([
  'sourcing',
  'procurement',
  'purchasing',
  'buyer',
  'buyers',
  'buying',
  'vendor',
  'vendors',
  'supplier',
  'suppliers',
  'wholesale',
  'b2b',
  'business',
  'partnerships',
  'partner',
  'sales',
  'info',
  'contact',
  'hello',
  'office',
  'admin',
  'orders',
  'export',
  'import',
  'marketing',
  'merchandise',
  'gifts',
  'brand',
]);
const HARD_BLOCKED_MAILBOXES = new Set([
  'support',
  'service',
  'customer',
  'customerservice',
  'help',
  'returns',
  'privacy',
  'legal',
  'noreply',
  'no-reply',
  'donotreply',
  'do-not-reply',
  'press',
  'media',
  'pr',
  'career',
  'careers',
  'jobs',
  'hr',
]);
const HARD_BLOCKED_MAILBOX_FRAGMENTS = [
  'support',
  'service',
  'customerservice',
  'customercare',
  'help',
  'returns',
  'privacy',
  'legal',
  'noreply',
  'donotreply',
  'press',
  'media',
  'career',
  'jobs',
  'tax',
  'taxexemption',
  'billing',
  'invoice',
  'payable',
  'payables',
  'accounting',
  'finance',
  'webmaster',
];
const FREE_EMAIL_DOMAINS = new Set([
  'gmail.com',
  'outlook.com',
  'hotmail.com',
  'live.com',
  'yahoo.com',
  'icloud.com',
  'aol.com',
  'proton.me',
  'protonmail.com',
]);
const BLOCKED_AUTO_SEND_EMAIL_TLDS = ['.cn', '.com.cn', '.net.cn', '.org.cn', '.hk', '.com.hk', '.tw', '.com.tw'];
const BLOCKED_PLACEHOLDER_EMAIL_DOMAINS = new Set([
  'example.com',
  'example.org',
  'example.net',
  'domain.com',
  'test.com',
  'invalid.com',
]);
const BLOCKED_AUTO_SEND_COUNTRY_TERMS = [
  'china',
  'mainland china',
  'prc',
  'hong kong',
  'hongkong',
  'hk',
  'taiwan',
  'tw',
  '中国',
  '大陆',
  '香港',
  '台湾',
];
const AI_DRAFT_MARKER = '<!-- vaysen-crm:ai-draft -->';

@Processor(QUEUES.emailSend, { concurrency: Number(process.env.EMAIL_SEND_CONCURRENCY || 5) })
export class EmailSendProcessor extends WorkerHost {
  private readonly logger = new Logger(EmailSendProcessor.name);
  private readonly accountChains = new Map<string, Promise<any>>();

  constructor(
    private prisma: PrismaService,
    private followUpRemindersService: FollowUpRemindersService,
    private timelineService: TimelineService,
    @InjectQueue(QUEUES.emailCompose) private emailComposeQueue: Queue,
    @InjectQueue(QUEUES.emailSend) private emailSendQueue: Queue,
  ) {
    super();
  }

  async process(job: Job<SendJob>): Promise<any> {
    const message = await this.prisma.emailMessage.findUnique({
      where: { id: job.data.emailMessageId },
      select: { emailAccountId: true },
    });
    if (!message) return { success: false, reason: 'Email message not found' };

    const previous = this.accountChains.get(message.emailAccountId) || Promise.resolve();
    const current = previous
      .catch(() => undefined)
      .then(() => this.processLocked(job));
    this.accountChains.set(message.emailAccountId, current);
    try {
      return await current;
    } finally {
      if (this.accountChains.get(message.emailAccountId) === current) {
        this.accountChains.delete(message.emailAccountId);
      }
    }
  }

  private async processLocked(job: Job<SendJob>) {
    const { emailMessageId, aiPersonalize } = job.data;
    const msg = await this.prisma.emailMessage.findUnique({
      where: { id: emailMessageId },
      include: { lead: true, emailAccount: true, company: true },
    });
    if (!msg || msg.deletedAt) return { success: false, reason: 'Email message not found' };
    if (msg.status === 'Sent') return { success: true, reason: 'Already sent' };
    if (msg.status !== 'QueuedToSend') {
      const reason = `Unsafe send blocked: message status is ${msg.status}, expected QueuedToSend`;
      if (aiPersonalize && ['DraftPending', 'Drafting', 'DraftReady', 'ValidationFailed'].includes(msg.status)) {
        return this.requeueForComposeOrFail(msg, reason, true);
      }
      await this.markFailed(msg.id, reason);
      return { success: false, reason };
    }
    if (aiPersonalize && !String(msg.bodyHtml || '').includes(AI_DRAFT_MARKER)) {
      return this.requeueForComposeOrFail(msg, 'AI personalized email has no AI draft completion marker; requeueing compose before SMTP send', true);
    }

    const deliverableHtml = prepareEmailForExternalDelivery(msg.bodyHtml || '');
    const legacyEnvelope = findLegacyEmailBrandReference(
      msg.emailAccount?.senderName,
      msg.emailAccount?.senderEmail,
      msg.emailAccount?.replyToEmail,
    );
    if (legacyEnvelope) {
      return this.requeueForComposeOrFail(
        msg,
        `Email sender contains a retired brand or domain: ${legacyEnvelope}`,
        aiPersonalize,
      );
    }
    const content = validateEmailContent(msg.subject, deliverableHtml, msg.company?.website);
    if (!content.valid) {
      return this.requeueForComposeOrFail(msg, content.reason || 'Email content validation failed', aiPersonalize);
    }

    const eligibility = await this.checkSendEligibility(msg.lead, msg.emailAccount);
    if (!eligibility.canSend) {
      if (eligibility.delayMs && eligibility.delayMs > 0) {
        await this.prisma.emailMessage.update({
          where: { id: msg.id },
          data: { status: 'QueuedToSend', failedReason: eligibility.reason },
        });
        await this.emailSendQueue.add('send-email', { emailMessageId: msg.id, aiPersonalize }, {
          delay: eligibility.delayMs,
          attempts: 3,
          backoff: { type: 'exponential', delay: 10000 },
          removeOnComplete: 100,
          removeOnFail: 100,
        });
        return { success: false, delayed: true, reason: eligibility.reason };
      }

      await this.markSkipped(msg.id, eligibility.reason || 'Not eligible to send');
      return { success: false, reason: eligibility.reason };
    }

    // Safety: block send when EMAIL_SEND_ENABLED=false OR EMAIL_SEND_DISABLED=true
    if (process.env.EMAIL_SEND_DISABLED === 'true' || process.env.EMAIL_SEND_ENABLED === 'false') {
      await this.prisma.emailMessage.update({
        where: { id: msg.id },
        data: {
          status: 'Blocked',
          failedReason: 'EMAIL_SEND_DISABLED: Email sending blocked by server safety switch',
          errorMessage: 'EMAIL_SEND_DISABLED',
        },
      });
      return { success: false, status: 'BLOCKED', reason: 'EMAIL_SEND_DISABLED' };
    }

    this.logger.log(`Sending email ${msg.id} to ${msg.toEmail || msg.lead.contactEmail}`);
    await this.prisma.emailMessage.update({ where: { id: msg.id }, data: { status: 'Sending', failedReason: null } });

    try {
      const transporter = nodemailer.createTransport({
        host: msg.emailAccount.smtpHost,
        port: msg.emailAccount.smtpPort,
        secure: msg.emailAccount.smtpSecure,
        auth: {
          user: msg.emailAccount.smtpUsername,
          pass: decrypt(msg.emailAccount.smtpPasswordEncrypted),
        },
      });

      const recipient = msg.toEmail || msg.lead.contactEmail || '';
      const info = await transporter.sendMail({
        from: `"${msg.emailAccount.senderName}" <${msg.emailAccount.senderEmail}>`,
        replyTo: msg.emailAccount.replyToEmail || msg.emailAccount.senderEmail,
        to: recipient,
        subject: msg.subject,
        html: deliverableHtml,
      }) as any;

      await this.prisma.emailMessage.update({
        where: { id: msg.id },
        data: {
          bodyHtml: deliverableHtml,
          status: 'Sent',
          messageId: info.messageId,
          sentAt: new Date(),
          failedReason: null,
          errorMessage: null,
        },
      });

      await this.recordAccountSendSuccess(msg.emailAccountId);

      await this.timelineService.logActivity({
        companyId: msg.companyId,
        leadId: msg.leadId,
        activityType: 'email_sent',
        title: 'Email sent',
        description: `Email sent to ${msg.toEmail || msg.lead.contactEmail}: ${msg.subject}`,
        referenceType: 'EmailMessage',
        referenceId: msg.id,
      });

      this.followUpRemindersService.generateForEmail(msg.id).catch(() => undefined);
      return { success: true, messageId: info.messageId };
    } catch (err: any) {
      const retryCount = msg.retryCount + 1;
      const finalFailure = retryCount >= msg.maxRetries;
      await this.prisma.emailMessage.update({
        where: { id: msg.id },
        data: {
          retryCount,
          status: finalFailure ? 'Failed' : 'QueuedToSend',
          failedAt: finalFailure ? new Date() : null,
          failedReason: err.message,
          errorMessage: err.message,
        },
      });
      if (finalFailure) await this.logFailure(msg.id, err.message);
      throw err;
    }
  }

  private async requeueForComposeOrFail(msg: any, reason: string, aiPersonalize?: boolean) {
    const retryCount = msg.retryCount + 1;
    if (aiPersonalize && retryCount <= msg.maxRetries && msg.templateId) {
      await this.prisma.emailMessage.update({
        where: { id: msg.id },
        data: { status: 'ValidationFailed', retryCount, failedReason: reason },
      });
      await this.emailComposeQueue.add('compose-email', {
        emailMessageId: msg.id,
        leadId: msg.leadId,
        emailAccountId: msg.emailAccountId,
        templateId: msg.templateId,
        aiPersonalize: true,
      }, { delay: 5000, attempts: 3, removeOnComplete: 100, removeOnFail: 100 });
      return { success: false, requeued: true, reason };
    }

    await this.markFailed(msg.id, reason);
    return { success: false, reason };
  }

  private async checkSendEligibility(lead: any, account: any): Promise<{ canSend: boolean; reason?: string; delayMs?: number }> {
    if (!lead?.contactEmail || !VALID_EMAIL_REGEX.test(lead.contactEmail)) {
      return { canSend: false, reason: 'Lead has no valid contact email' };
    }
    const recipientSafety = this.checkRecipientSafety(lead);
    if (!recipientSafety.canSend) return recipientSafety;
    if (lead.status === 'lost') return { canSend: false, reason: 'Lead is marked as lost/invalid' };
    if (lead.status === 'manual_review' || lead.reviewStatus === 'manual_review') {
      return { canSend: false, reason: 'Lead is waiting for manual email review' };
    }
    const verificationStatus = await this.ensureAutoEmailVerification(lead);
    if (!SENDABLE_EMAIL_VERIFICATION_STATUSES.has(verificationStatus)) {
      return {
        canSend: false,
        reason: `Email is not verified for auto sending (${verificationStatus}). ${lead.emailVerificationReason || 'Verify it or move it through manual review first.'}`,
      };
    }
    if (!account || account.status !== 'active') return { canSend: false, reason: 'Email account is not active' };

    const unsubscribed = await this.prisma.unsubscribeRecord.findFirst({ where: { leadId: lead.id } });
    if (unsubscribed) return { canSend: false, reason: 'Lead has unsubscribed from marketing emails' };

    const domain = lead.contactEmail.split('@')[1] || '';
    const blacklisted = await this.prisma.blacklistRecord.findFirst({
      where: { OR: [{ email: lead.contactEmail, isActive: true }, { domain, isActive: true }] },
    });
    if (blacklisted) return { canSend: false, reason: 'Email or domain is on the blacklist' };

    const quotaAccount = await this.getQuotaAccount(account);
    const now = new Date();
    if (quotaAccount.lastSentAt) {
      const hoursSinceLastSend = (now.getTime() - new Date(quotaAccount.lastSentAt).getTime()) / 3600000;
      const resetData: Record<string, number> = {};
      if (hoursSinceLastSend >= 1 && quotaAccount.hourlySentCount > 0) {
        resetData.hourlySentCount = 0;
        quotaAccount.hourlySentCount = 0;
      }
      if (hoursSinceLastSend >= 24 && quotaAccount.dailySentCount > 0) {
        resetData.dailySentCount = 0;
        quotaAccount.dailySentCount = 0;
      }
      if (Object.keys(resetData).length > 0) {
        await this.resetAccountCounters(account.id, resetData);
      }
    }

    if (quotaAccount.dailySentCount >= quotaAccount.dailySendLimit) {
      const tomorrow = new Date();
      tomorrow.setDate(tomorrow.getDate() + 1);
      tomorrow.setHours(0, 5, 0, 0);
      return { canSend: false, reason: `Daily send limit (${quotaAccount.dailySendLimit}) reached`, delayMs: Math.max(60000, tomorrow.getTime() - Date.now()) };
    }
    if (quotaAccount.hourlySentCount >= quotaAccount.hourlySendLimit) {
      const nextHour = new Date();
      nextHour.setHours(nextHour.getHours() + 1, 1, 0, 0);
      return { canSend: false, reason: `Hourly send limit (${quotaAccount.hourlySendLimit}) reached`, delayMs: Math.max(60000, nextHour.getTime() - Date.now()) };
    }
    if (quotaAccount.lastSentAt) {
      const intervalMs = Math.max(30, quotaAccount.sendIntervalSeconds || 30) * 1000;
      const waitMs = new Date(quotaAccount.lastSentAt).getTime() + intervalMs - Date.now();
      if (waitMs > 0) return { canSend: false, reason: `Waiting for sender interval (${quotaAccount.sendIntervalSeconds || 30}s)`, delayMs: waitMs };
    }

    return { canSend: true };
  }

  private isSharedMailboxPool() {
    return process.env.EMAIL_ACCOUNT_SHARED_POOL === 'true';
  }

  private async getQuotaAccount(account: any) {
    if (!this.isSharedMailboxPool()) return account;
    const rows = await this.prisma.$queryRawUnsafe<any[]>(
      'SELECT id, "dailySentCount", "hourlySentCount", "dailySendLimit", "hourlySendLimit", "sendIntervalSeconds", "lastSentAt" FROM public."EmailAccount" WHERE id = $1 LIMIT 1',
      account.id,
    );
    return rows[0] || account;
  }

  private async resetAccountCounters(accountId: string, resetData: Record<string, number>) {
    await this.prisma.emailAccount.update({ where: { id: accountId }, data: resetData }).catch(() => undefined);
    if (!this.isSharedMailboxPool()) return;
    const sets: string[] = [];
    const values: any[] = [];
    if (resetData.hourlySentCount !== undefined) {
      values.push(resetData.hourlySentCount);
      sets.push(`"hourlySentCount" = $${values.length}`);
    }
    if (resetData.dailySentCount !== undefined) {
      values.push(resetData.dailySentCount);
      sets.push(`"dailySentCount" = $${values.length}`);
    }
    if (!sets.length) return;
    values.push(accountId);
    await this.prisma.$executeRawUnsafe(
      `UPDATE public."EmailAccount" SET ${sets.join(', ')}, "updatedAt" = now() WHERE id = $${values.length}`,
      ...values,
    );
  }

  private async recordAccountSendSuccess(accountId: string) {
    const data = {
      dailySentCount: { increment: 1 },
      hourlySentCount: { increment: 1 },
      lastSentAt: new Date(),
      failureCount: 0,
    };
    await this.prisma.emailAccount.update({ where: { id: accountId }, data });
    if (!this.isSharedMailboxPool()) return;
    await this.prisma.$executeRawUnsafe(
      'UPDATE public."EmailAccount" SET "dailySentCount" = "dailySentCount" + 1, "hourlySentCount" = "hourlySentCount" + 1, "lastSentAt" = now(), "failureCount" = 0, "updatedAt" = now() WHERE id = $1',
      accountId,
    );
  }

  private async ensureAutoEmailVerification(lead: any): Promise<string> {
    const current = lead.emailVerificationStatus || 'unverified';
    if (SENDABLE_EMAIL_VERIFICATION_STATUSES.has(current)) return current;
    // 之前被标记为 rejected 的邮箱重新评估一次（白名单可能已更新）
    if (current === 'rejected') {
      // 继续走下面的检查逻辑，不直接短路
    }

    const email = String(lead.contactEmail || '').trim().toLowerCase();
    if (!VALID_EMAIL_REGEX.test(email)) return current;

    const [localPart, domain] = email.split('@');
    const mailbox = localPart.split(/[.+_-]/)[0];
    const normalizedDomain = domain.toLowerCase();

    if (FREE_EMAIL_DOMAINS.has(normalizedDomain)) {
      await this.updateLeadEmailVerification(lead.id, 'rejected', 'Free mailbox is not allowed for automatic cold email sending.');
      return 'rejected';
    }

    if (HARD_BLOCKED_MAILBOXES.has(mailbox)) {
      await this.updateLeadEmailVerification(lead.id, 'rejected', `Mailbox "${mailbox}" is not allowed for automatic sending.`);
      return 'rejected';
    }

    const hasMx = await this.hasMxRecord(normalizedDomain);
    if (!hasMx) {
      await this.updateLeadEmailVerification(lead.id, 'rejected', 'Email domain has no MX record.');
      return 'rejected';
    }

    const websiteDomain = this.extractDomain(lead.websiteDomain || lead.website || lead.url || '');
    const domainMatchesWebsite = Boolean(websiteDomain && (normalizedDomain === websiteDomain || normalizedDomain.endsWith(`.${websiteDomain}`)));
    const isBusinessMailbox = AUTO_SEND_BUSINESS_MAILBOXES.has(mailbox);

    if (domainMatchesWebsite || isBusinessMailbox) {
      const reason = domainMatchesWebsite
        ? 'Auto verified before sending: email domain matches lead website and MX exists.'
        : `Auto verified before sending: business mailbox "${mailbox}" and MX exists.`;
      await this.updateLeadEmailVerification(lead.id, 'official_page_verified', reason);
      lead.emailVerificationStatus = 'official_page_verified';
      lead.emailVerificationReason = reason;
      return 'official_page_verified';
    }

    const reason = 'MX exists, but mailbox role/source requires manual review before automatic sending.';
    await this.updateLeadEmailVerification(lead.id, 'mx_domain_verified', reason);
    lead.emailVerificationStatus = 'mx_domain_verified';
    lead.emailVerificationReason = reason;
    return 'mx_domain_verified';
  }

  private async updateLeadEmailVerification(leadId: string, status: string, reason: string) {
    await this.prisma.lead.update({
      where: { id: leadId },
      data: { emailVerificationStatus: status, emailVerificationReason: reason },
    }).catch(() => undefined);
  }

  private checkRecipientSafety(lead: any): { canSend: boolean; reason?: string } {
    const email = String(lead.contactEmail || '').trim().toLowerCase();
    const [localPart, domain = ''] = email.split('@');
    const compactLocal = localPart.replace(/[^a-z0-9]/g, '');
    const compactLetters = localPart.replace(/[^a-z]/g, '');
    const countryText = [
      lead.country,
      lead.sourceCountry,
      lead.websiteDomain,
      lead.website,
      lead.sourceUrl,
    ].filter(Boolean).join(' ').toLowerCase();

    if (/\d{3}[\s.-]?\d{3}[\s.-]?\d{4}/.test(localPart) || (compactLocal.match(/\d/g) || []).length >= 7) {
      return { canSend: false, reason: 'Recipient email looks like a phone-number extraction artifact' };
    }

    if (BLOCKED_PLACEHOLDER_EMAIL_DOMAINS.has(domain) || ['example', 'test', 'demo', 'sample'].includes(localPart)) {
      return { canSend: false, reason: 'Recipient email is a placeholder/test address' };
    }

    if (HARD_BLOCKED_MAILBOX_FRAGMENTS.some((fragment) => compactLetters.includes(fragment))) {
      return { canSend: false, reason: 'Recipient mailbox is a blocked role mailbox for automatic cold email sending' };
    }

    if (BLOCKED_AUTO_SEND_EMAIL_TLDS.some((suffix) => domain === suffix.slice(1) || domain.endsWith(suffix))) {
      return { canSend: false, reason: 'China/HK/Taiwan recipient domains are blocked for this auto-send task' };
    }

    if (BLOCKED_AUTO_SEND_COUNTRY_TERMS.some((term) => countryText.includes(term))) {
      return { canSend: false, reason: 'China/HK/Taiwan leads are blocked for this auto-send task' };
    }

    return { canSend: true };
  }

  private async hasMxRecord(domain: string): Promise<boolean> {
    try {
      const records = await resolveMx(domain);
      return records.length > 0;
    } catch (error: any) {
      if (!['ECONNREFUSED', 'ETIMEOUT', 'EAI_AGAIN', 'ENOTFOUND'].includes(error?.code)) {
        return false;
      }
      for (const server of ['223.5.5.5', '114.114.114.114', '8.8.8.8', '1.1.1.1']) {
        try {
          const resolver = new Resolver();
          resolver.setServers([server]);
          const records = await resolver.resolveMx(domain);
          if (records.length > 0) return true;
        } catch (err: any) {
          this.logger?.error?.('MX record DNS fallback lookup failed: ' + (err?.message || err), err?.stack);
        }
      }
      return false;
    }
  }

  private extractDomain(value?: string): string {
    const raw = String(value || '').trim().toLowerCase();
    if (!raw) return '';
    try {
      return new URL(raw.startsWith('http') ? raw : `https://${raw}`).hostname.replace(/^www\./, '');
    } catch {
      return raw.replace(/^https?:\/\//, '').replace(/^www\./, '').split('/')[0];
    }
  }

  private async markSkipped(emailMessageId: string, reason: string) {
    await this.prisma.emailMessage.update({
      where: { id: emailMessageId },
      data: { status: 'Skipped', failedReason: reason, errorMessage: reason },
    });
  }

  private async markFailed(emailMessageId: string, reason: string) {
    await this.prisma.emailMessage.update({
      where: { id: emailMessageId },
      data: { status: 'Failed', failedAt: new Date(), failedReason: reason, errorMessage: reason },
    });
    await this.logFailure(emailMessageId, reason);
  }

  private async logFailure(emailMessageId: string, reason: string) {
    const msg = await this.prisma.emailMessage.findUnique({ where: { id: emailMessageId } });
    if (!msg) return;
    await this.timelineService.logActivity({
      companyId: msg.companyId,
      leadId: msg.leadId,
      activityType: 'email_failed',
      title: 'Email failed',
      description: `Email failed: ${reason}`,
      referenceType: 'EmailMessage',
      referenceId: emailMessageId,
    }).catch(() => undefined);
  }
}
