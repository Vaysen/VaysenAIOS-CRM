import {
  Injectable,
  NotFoundException,
  ForbiddenException,
  BadRequestException,
  ConflictException,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import OpenAI from 'openai';
import { v4 as uuidv4 } from 'uuid';
import { createHash } from 'crypto';
import { Resolver, resolveMx } from 'dns/promises';
import { PrismaService } from '../../common/prisma/prisma.service';
import { SendSingleDto } from './dto/send-single.dto';
import { SendBatchDto } from './dto/send-batch.dto';
import { QUEUES } from '@/common/queues/queue-names';
import { createAiClient, getAiModel } from '@/common/ai/ai-client.util';
import {
  DEFAULT_EMAIL_COMPANY_NAME,
  DEFAULT_EMAIL_COMPANY_WEBSITE,
  ensureCompanyWebsite,
  findLegacyEmailBrandReference,
  replaceLegacyEmailBrandReferences,
  resolveEmailCompanyName,
  resolveEmailCompanyWebsite,
} from './email-content.guard';
import {
  hasFullAccess,
  requireActiveCompany,
} from '../../common/utils/data-isolation';
import {
  appendPublicUnsubscribe,
  injectPublicTrackingPixel,
  replaceLinksWithPublicTracking,
} from './email-public-links';
import { resolveEmailSeedPolicy, type EmailSeedPolicy } from './email-seed-policy';
// TASK-102E: 入站邮件身份统一接入 EmailIdentityAdapter
import {
  EmailIdentityAdapter,
  type IngestEmailIdentityResult,
} from '../customer-identity/email-identity.adapter';
import { OutboundComplianceService } from '../outbound/outbound-compliance.service';
import { EmailAccountsService } from '../email-accounts/email-accounts.service';
import {
  writeEmailVerificationEvidence,
} from '../outbound/email-verification-evidence';
import { normalizeIdempotencyKey } from '../../common/security/idempotency-key';
import { safeDigest, safeErrorCategory, safeLogEvent } from '@/common/security/safe-logging';

const VALID_EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const AI_BATCH_LIMIT = 100;
const SENDABLE_EMAIL_VERIFICATION_STATUSES = new Set(['smtp_verified', 'official_page_verified', 'verified_public_source']);
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
const EMAIL_ACTIVE_ROUND_STATUSES = [
  'DraftPending',
  'Drafting',
  'DraftReady',
  'ValidationFailed',
  'QueuedToSend',
  'Queued',
  'Sending',
  'Sent',
  'Opened',
  'Clicked',
  'Replied',
];
const DEFAULT_VARS: Record<string, string> = {
  '{{contact_name}}': 'Contact Name',
  '{{company_name}}': 'Company Name',
  '{{country}}': 'Country',
  '{{product_name}}': 'Product Name',
  '{{sender_name}}': 'Sender Name',
  '{{sender_company}}': 'Sender Company',
  '{{website}}': 'Website',
  '{{pain_point}}': 'Pain Point',
  '{{last_email_date}}': 'Last Email Date',
  '{{unsubscribe_link}}': 'Unsubscribe Link',
};

type EmailDispatchJob = {
  queue: 'compose' | 'validate';
  name: string;
  jobId: string;
  data: Record<string, any>;
  options: Record<string, any>;
};

type EmailDispatchMessagePlan = {
  id: string;
  data: Record<string, any>;
  job?: EmailDispatchJob;
};

type EmailDispatchSeedLeadPlan = {
  id: string;
  data: Record<string, any>;
};

type EmailDispatchResult = {
  inputDigest: string;
  response: Record<string, any>;
  jobs: EmailDispatchJob[];
  projection: {
    templateUseCount?: {
      templateId: string;
      increment: number;
    };
    activities: Array<{
      id: string;
      companyId: string;
      leadId: string;
      userId: string;
      activityType: string;
      title: string;
      referenceType: string;
      referenceId: string | null;
    }>;
  };
};

type ReservedEmailDispatch = {
  request: {
    id: string;
    companyId: string;
    operatorUserId: string;
    kind: string;
    idempotencyKey: string;
    payloadDigest: string;
    status: string;
    result: unknown;
  };
  created: boolean;
};

@Injectable()
export class EmailsService {
  private readonly logger = new Logger(EmailsService.name);
  private aiClient?: OpenAI;

  constructor(
    private prisma: PrismaService,
    // TASK-102E: 入站邮件身份统一走 EmailIdentityAdapter (归一化 -> resolver -> 会话/消息)
    private emailIdentityAdapter: EmailIdentityAdapter,
    @InjectQueue(QUEUES.emailCompose) private emailComposeQueue: Queue,
    @InjectQueue(QUEUES.emailValidate) private emailValidateQueue: Queue,
    private outbound: OutboundComplianceService,
    // R111 批次A: 邮箱账户分级 → 营销动作强制校验（复用 assertMarketingRole）
    private emailAccounts: EmailAccountsService,
  ) {
    this.aiClient = createAiClient('email');
  }

  // ========== Inbound email identity (TASK-102E) ==========

  /**
   * 入站邮件身份接入: 调用 EmailIdentityAdapter.ingest()。
   * - 标准化邮箱 -> IdentityResolutionService.resolve
   * - EmailMessage(Conversation + CommunicationMessage)/ContactPoint 关系由 adapter 补齐
   * - review_required -> 邮件仍入库, 挂待关联状态 (leadId 为新建)
   * - 手工姓名不被覆盖 (adapter 委托 resolver, 不直接写 Contact)
   * - 同一 messageId 幂等, 不创建重复消息
   */
  async receiveInboundEmail(dto: {
    companyId: string;
    fromEmail: string;
    displayName?: string | null;
    messageId: string;
    subject?: string | null;
    bodyText?: string | null;
    receivedAt?: Date | null;
  }): Promise<IngestEmailIdentityResult> {
    return this.emailIdentityAdapter.ingest({
      companyId: dto.companyId,
      email: dto.fromEmail,
      displayNameCandidate: dto.displayName ?? undefined,
      messageId: dto.messageId,
      subject: dto.subject,
      bodyText: dto.bodyText,
      receivedAt: dto.receivedAt,
    });
  }

  // ========== Send Single ==========

  async sendSingle(
    dto: SendSingleDto,
    currentUser: any,
    rawIdempotencyKey: string,
  ) {
    const idempotencyKey = normalizeIdempotencyKey(rawIdempotencyKey);
    const company = this.getCompany(currentUser);
    this.checkWriteAccess(currentUser, company.id);
    const inputDigest = this.emailDispatchPayloadDigest({
      kind: 'SINGLE',
      operatorUserId: currentUser.id,
      dto,
    });
    const replay = await this.findEmailDispatchRequest({
      companyId: company.id,
      operatorUserId: currentUser.id,
      kind: 'SINGLE',
      idempotencyKey,
      inputDigest,
    });
    const [lead, emailAccount, template] = await Promise.all([
      this.prisma.lead.findFirst({
        where: { id: dto.leadId, companyId: company.id, deletedAt: null },
      }),
      this.prisma.emailAccount.findFirst({
        where: { id: dto.emailAccountId, companyId: company.id },
      }),
      this.prisma.emailTemplate.findFirst({
        where: { id: dto.emailTemplateId, companyId: company.id },
        include: { variables: true },
      }),
    ]);

    if (!lead || lead.deletedAt) throw new NotFoundException('Lead not found');
    if (lead.companyId !== company.id) throw new ForbiddenException('Lead does not belong to your company');
    if (!emailAccount || emailAccount.companyId !== company.id) throw new NotFoundException('Email account not found');
    if (!template || template.companyId !== company.id) throw new NotFoundException('Email template not found');

    await this.outbound.assertEmailAccountAccess(company.id, emailAccount.id, currentUser);
    // R111 批次A: 营销面板单发（source=marketing）强制仅允许 MARKETING 账号；不带 source 视为商务单发不限制
    if (dto.source === 'marketing') {
      this.emailAccounts.assertMarketingRole(emailAccount, '营销面板单发');
    }
    await this.checkLeadAccess(currentUser, lead);
    this.checkTemplateAccess(currentUser, template);

    if (replay) {
      await this.assertEmailDispatchReplayAccess(replay, currentUser);
      return this.completeEmailDispatchRequest(replay);
    }

    const eligibility = await this.checkSendEligibility(lead, emailAccount);
    const messageId = this.deterministicEmailDispatchId(
      'email-dispatch-message',
      company.id,
      'SINGLE',
      idempotencyKey,
      lead.id,
    );
    const payloadDigest = this.emailDispatchPayloadDigest({
      kind: 'SINGLE',
      operatorUserId: currentUser.id,
      dto,
      company: {
        id: company.id,
        name: company.name,
        website: company.website,
      },
      lead: {
        id: lead.id,
        ownerUserId: lead.ownerUserId,
        contactEmail: lead.contactEmail,
        contactName: lead.contactName,
        companyName: lead.companyName,
        country: lead.country,
        website: lead.website,
        mainProducts: lead.mainProducts,
      },
      emailAccount: {
        id: emailAccount.id,
        userId: emailAccount.userId,
        senderName: emailAccount.senderName,
        senderEmail: emailAccount.senderEmail,
      },
      template: {
        id: template.id,
        createdBy: template.createdBy,
        subject: template.subject,
        body: template.body,
        variables: template.variables,
      },
    });

    if (!eligibility.canSend) {
      const response = {
        success: false,
        message: eligibility.reason,
        emailMessageId: messageId,
        status: 'Skipped',
      };
      const reserved = await this.reserveEmailDispatchRequest({
        companyId: company.id,
        operatorUserId: currentUser.id,
        kind: 'SINGLE',
        idempotencyKey,
        inputDigest,
        payloadDigest,
        response,
        messages: [{
          id: messageId,
          data: {
          companyId: company.id,
          leadId: lead.id,
          emailAccountId: emailAccount.id,
          templateId: template.id,
          senderUserId: currentUser.id,
          toEmail: lead.contactEmail,
          subject: dto.subject || template.subject,
          bodyHtml: dto.body || template.body,
          trackingId: uuidv4(),
          unsubscribeToken: uuidv4(),
          status: 'Skipped',
          failedReason: eligibility.reason,
          },
        }],
        projection: {
          activities: [{
            id: this.deterministicEmailDispatchId(
              'email-dispatch-activity',
              company.id,
              idempotencyKey,
              lead.id,
              'email_skipped',
            ),
            companyId: company.id,
            leadId: lead.id,
            userId: currentUser.id,
            activityType: 'email_skipped',
            title: `Email skipped: ${eligibility.reason}`,
            referenceType: 'EmailMessage',
            referenceId: messageId,
          }],
        },
      });
      return this.completeEmailDispatchRequest(reserved.request);
    }

    const rendered = this.renderTemplate(template, lead, emailAccount, dto.productName, dto.customVariables, company);
    if (dto.subject) rendered.subject = dto.subject;
    if (dto.body) rendered.body = dto.body;

    const trackingId = uuidv4();
    const unsubscribeToken = uuidv4();
    const aiPersonalize = dto.aiPersonalize === true;
    const initialBody = aiPersonalize
      ? rendered.body
      : this.appendUnsubscribeLink(
          this.replaceLinksWithTracking(
            this.injectTrackingPixel(
              ensureCompanyWebsite(
                rendered.body,
                resolveEmailCompanyWebsite(company.website),
              ),
              trackingId,
            ),
            trackingId,
          ),
          unsubscribeToken,
        );
    const job: EmailDispatchJob = aiPersonalize
      ? {
          queue: 'compose',
          name: 'compose-email',
          jobId: `email-dispatch-${messageId}-compose`,
          data: {
            emailMessageId: messageId,
            productName: dto.productName,
            customVariables: dto.customVariables,
            sendDelayMs: 0,
            aiPersonalize: true,
          },
          options: {
            attempts: 3,
            backoff: { type: 'exponential', delay: 10000 },
            removeOnComplete: 100,
            removeOnFail: 100,
          },
        }
      : {
          queue: 'validate',
          name: 'validate-email',
          jobId: `email-dispatch-${messageId}-validate`,
          data: {
            emailMessageId: messageId,
            aiPersonalize: false,
            sendDelayMs: 0,
          },
          options: {
            attempts: 3,
            backoff: { type: 'exponential', delay: 10000 },
            removeOnComplete: 100,
            removeOnFail: 100,
          },
        };
    const response = {
      success: true,
      message: aiPersonalize
        ? 'AI draft queued. Email will only send after validation passes.'
        : 'Email queued for validation before sending',
      emailMessageId: messageId,
      status: aiPersonalize ? 'DraftPending' : 'DraftReady',
    };
    const reserved = await this.reserveEmailDispatchRequest({
      companyId: company.id,
      operatorUserId: currentUser.id,
      kind: 'SINGLE',
      idempotencyKey,
      inputDigest,
      payloadDigest,
      response,
      messages: [{
        id: messageId,
        data: {
        companyId: company.id,
        leadId: lead.id,
        emailAccountId: emailAccount.id,
        templateId: template.id,
        senderUserId: currentUser.id,
        toEmail: lead.contactEmail,
        subject: rendered.subject,
        bodyHtml: initialBody,
        renderedBody: initialBody,
        trackingId,
        unsubscribeToken,
        outreachRound: dto.outreachRound || 0,
        status: aiPersonalize ? 'DraftPending' : 'DraftReady',
        },
        job,
      }],
      projection: {
        templateUseCount: {
          templateId: template.id,
          increment: 1,
        },
        activities: [{
          id: this.deterministicEmailDispatchId(
            'email-dispatch-activity',
            company.id,
            idempotencyKey,
            lead.id,
            aiPersonalize ? 'email_draft_queued' : 'email_queued',
          ),
          companyId: company.id,
          leadId: lead.id,
          userId: currentUser.id,
          activityType: aiPersonalize ? 'email_draft_queued' : 'email_queued',
          title: aiPersonalize
            ? `AI email draft queued for ${lead.contactEmail}`
            : `Email queued for validation before sending to ${lead.contactEmail}`,
          referenceType: 'EmailMessage',
          referenceId: messageId,
        }],
      },
    });
    return this.completeEmailDispatchRequest(reserved.request);
  }

  // ========== Send Batch ==========

  async sendBatch(
    dto: SendBatchDto,
    currentUser: any,
    rawIdempotencyKey: string,
  ) {
    const idempotencyKey = normalizeIdempotencyKey(rawIdempotencyKey);
    const company = this.getCompany(currentUser);
    this.checkWriteAccess(currentUser, company.id);
    const inputDigest = this.emailDispatchPayloadDigest({
      kind: 'BATCH',
      operatorUserId: currentUser.id,
      dto,
    });
    const replay = await this.findEmailDispatchRequest({
      companyId: company.id,
      operatorUserId: currentUser.id,
      kind: 'BATCH',
      idempotencyKey,
      inputDigest,
    });
    const allowTemplateDirect = dto.allowTemplateDirect === true;
    if (allowTemplateDirect && !this.isFullAccess(currentUser, company.id)) {
      throw new ForbiddenException('Only administrators can send batch emails without AI personalization');
    }
    const effectiveAiPersonalize = allowTemplateDirect ? dto.aiPersonalize !== false : true;
    const effectiveDto: SendBatchDto = { ...dto, aiPersonalize: effectiveAiPersonalize };

    const [emailAccount, template] = await Promise.all([
      this.prisma.emailAccount.findFirst({
        where: { id: dto.emailAccountId, companyId: company.id },
      }),
      this.prisma.emailTemplate.findFirst({
        where: { id: dto.emailTemplateId, companyId: company.id },
        include: { variables: true },
      }),
    ]);

    if (!emailAccount || emailAccount.companyId !== company.id) throw new BadRequestException('请选择发件邮箱');
    if (!template || template.companyId !== company.id) throw new BadRequestException('请选择邮件模板');
    await this.outbound.assertEmailAccountAccess(company.id, emailAccount.id, currentUser);
    // R111 批次A: 批量/定时/AI 直发属营销动作，强制仅允许 MARKETING 账号（拒绝 CORE/SUPPORT）
    this.emailAccounts.assertMarketingRole(emailAccount, '营销批量发送');
    this.checkTemplateAccess(currentUser, template);
    if (replay) {
      await this.assertEmailDispatchReplayAccess(replay, currentUser);
      return this.completeEmailDispatchRequest(replay);
    }

    const batchFilters = {
      ...(dto.filters || {}),
      outreachRound: dto.filters?.outreachRound ?? dto.outreachRound,
      includeReplied: dto.includeReplied ?? dto.filters?.includeReplied,
    };
    const leadWhere: any = dto.selectAll
      ? this.buildLeadWhereForBatch(currentUser, company.id, batchFilters)
      : this.buildLeadWhereForBatch(currentUser, company.id, {
          ...batchFilters,
          includeReplied: batchFilters.includeReplied,
          leadIds: dto.leadIds || [],
        });

    const leads = (await this.prisma.lead.findMany({
      where: leadWhere,
      orderBy: { createdAt: 'desc' },
    })).sort((left: any, right: any) => String(left.id).localeCompare(String(right.id)));

    if (leads.length === 0) throw new NotFoundException('没有找到符合当前轮次和筛选条件的可发送客户');
    if (effectiveAiPersonalize && leads.length > AI_BATCH_LIMIT) {
      throw new BadRequestException(`AI personalized batch sending is limited to ${AI_BATCH_LIMIT} leads per batch`);
    }

    // Check access for each lead
    for (const lead of leads) {
      await this.checkLeadAccess(currentUser, lead);
    }

    const seedPolicy = resolveEmailSeedPolicy();
    const payloadDigest = this.emailDispatchPayloadDigest({
      kind: 'BATCH',
      operatorUserId: currentUser.id,
      dto,
      effectiveDto,
      batchFilters,
      seedPolicy,
      company: {
        id: company.id,
        name: company.name,
        website: company.website,
      },
      emailAccount: {
        id: emailAccount.id,
        userId: emailAccount.userId,
        senderName: emailAccount.senderName,
        senderEmail: emailAccount.senderEmail,
        sendIntervalSeconds: emailAccount.sendIntervalSeconds,
      },
      template: {
        id: template.id,
        createdBy: template.createdBy,
        subject: template.subject,
        body: template.body,
        variables: template.variables,
      },
      leads: leads.map((lead: any) => ({
        id: lead.id,
        ownerUserId: lead.ownerUserId,
        contactEmail: lead.contactEmail,
        contactName: lead.contactName,
        companyName: lead.companyName,
        country: lead.country,
        website: lead.website,
        mainProducts: lead.mainProducts,
        emailVerificationStatus: lead.emailVerificationStatus,
      })),
    });
    const messagePlans: EmailDispatchMessagePlan[] = [];
    const seedLeadPlans: EmailDispatchSeedLeadPlan[] = [];
    const results: Array<{ leadId: string; success: boolean; message: string; emailMessageId?: string }> = [];
    const skippedByReason: Record<string, number> = {};
    let sendableCount = 0;
    let seedCount = 0;

    for (const lead of leads) {
      const eligibility = await this.checkSendEligibility(lead, emailAccount);

      if (!eligibility.canSend) {
        const skipReason = eligibility.reason || 'Unknown reason';
        skippedByReason[skipReason] = (skippedByReason[skipReason] || 0) + 1;
        const messageId = this.deterministicEmailDispatchId(
          'email-dispatch-message',
          company.id,
          'BATCH',
          idempotencyKey,
          lead.id,
        );
        messagePlans.push({
          id: messageId,
          data: {
            companyId: company.id,
            leadId: lead.id,
            emailAccountId: emailAccount.id,
            templateId: template.id,
            senderUserId: currentUser.id,
            toEmail: lead.contactEmail,
            subject: dto.subject || template.subject,
            bodyHtml: dto.body || template.body,
            trackingId: uuidv4(),
            unsubscribeToken: uuidv4(),
            outreachRound: dto.outreachRound || 0,
            status: 'Skipped',
            failedReason: eligibility.reason,
          },
        });
        results.push({
          leadId: lead.id,
          success: false,
          message: skipReason,
          emailMessageId: messageId,
        });
        continue;
      }

      const intervalMs = (dto.sendIntervalSeconds || emailAccount.sendIntervalSeconds || 60) * 1000;
      const delay = sendableCount * intervalMs;

      const rendered = this.renderTemplate(
        template,
        lead,
        emailAccount,
        effectiveDto.productName,
        effectiveDto.customVariables,
        company,
      );
      if (effectiveDto.subject) rendered.subject = effectiveDto.subject;
      if (effectiveDto.body) rendered.body = effectiveDto.body;
      const trackingId = uuidv4();
      const unsubscribeToken = uuidv4();

      const initialBody = effectiveAiPersonalize
        ? rendered.body
        : this.appendUnsubscribeLink(
            this.replaceLinksWithTracking(
              this.injectTrackingPixel(
                ensureCompanyWebsite(rendered.body, resolveEmailCompanyWebsite(company.website)),
                trackingId,
              ),
              trackingId,
            ),
            unsubscribeToken,
          );

      const messageId = this.deterministicEmailDispatchId(
        'email-dispatch-message',
        company.id,
        'BATCH',
        idempotencyKey,
        lead.id,
      );
      const job: EmailDispatchJob = effectiveAiPersonalize
        ? {
            queue: 'compose',
            name: 'compose-email',
            jobId: `email-dispatch-${messageId}-compose`,
            data: {
              emailMessageId: messageId,
              productName: effectiveDto.productName,
              customVariables: effectiveDto.customVariables,
              sendDelayMs: delay,
              aiPersonalize: true,
            },
            options: {
              attempts: 3,
              backoff: { type: 'exponential', delay: 10000 },
              removeOnComplete: 100,
              removeOnFail: 100,
            },
          }
        : {
            queue: 'validate',
            name: 'validate-email',
            jobId: `email-dispatch-${messageId}-validate`,
            data: {
              emailMessageId: messageId,
              aiPersonalize: false,
              sendDelayMs: delay,
            },
            options: {
              attempts: 3,
              backoff: { type: 'exponential', delay: 10000 },
              removeOnComplete: 100,
              removeOnFail: 100,
            },
          };
      messagePlans.push({
        id: messageId,
        data: {
          companyId: company.id,
          leadId: lead.id,
          emailAccountId: emailAccount.id,
          templateId: template.id,
          senderUserId: currentUser.id,
          toEmail: lead.contactEmail,
          subject: rendered.subject,
          bodyHtml: initialBody,
          renderedBody: initialBody,
          trackingId,
          unsubscribeToken,
          outreachRound: effectiveDto.outreachRound || 0,
          status: effectiveAiPersonalize ? 'DraftPending' : 'DraftReady',
        },
        job,
      });

      results.push({
        leadId: lead.id,
        success: true,
        message: effectiveAiPersonalize ? 'AI draft queued' : 'Queued for validation',
        emailMessageId: messageId,
      });
      sendableCount++;

      if (this.shouldInsertSeedEmail(sendableCount, seedCount, seedPolicy)) {
        const seedDelay = delay + Math.max(30, Math.floor(intervalMs / 1000)) * 1000;
        const seed = await this.buildSeedTestEmailPlan({
          companyId: company.id,
          currentUserId: currentUser.id,
          idempotencyKey,
          emailAccount,
          template,
          dto: effectiveDto,
          sendDelayMs: seedDelay,
          seedIndex: seedCount + 1,
          seedPolicy,
        });
        if (seed.seedLead) seedLeadPlans.push(seed.seedLead);
        messagePlans.push(seed.plan);
        results.push(seed.result);
        seedCount++;
      }
    }

    const response = {
      precheck: {
        totalMatched: leads.length,
        accepted: sendableCount,
        skipped: results.length - sendableCount - seedCount,
        seedQueued: seedCount,
        outreachRound: Number(batchFilters.outreachRound ?? dto.outreachRound ?? 0),
        includeReplied: batchFilters.includeReplied === true || batchFilters.includeReplied === 'true',
        skippedByReason,
        filters: dto.selectAll ? batchFilters : undefined,
      },
      totalLeads: leads.length,
      queued: sendableCount,
      seedQueued: seedCount,
      skipped: results.length - sendableCount - seedCount,
      results,
    };
    const reserved = await this.reserveEmailDispatchRequest({
      companyId: company.id,
      operatorUserId: currentUser.id,
      kind: 'BATCH',
      idempotencyKey,
      inputDigest,
      payloadDigest,
      response,
      messages: messagePlans,
      seedLeads: seedLeadPlans,
      projection: {
        templateUseCount: {
          templateId: template.id,
          increment: sendableCount,
        },
        activities: leads[0]?.id
          ? [{
              id: this.deterministicEmailDispatchId(
                'email-dispatch-activity',
                company.id,
                idempotencyKey,
                leads[0].id,
                'email_batch_queued',
              ),
              companyId: company.id,
              leadId: leads[0].id,
              userId: currentUser.id,
              activityType: 'email_batch_queued',
              title: `Batch email: ${sendableCount} accepted into safe sending workflow, ${results.length - sendableCount} skipped`,
              referenceType: 'EmailMessage',
              referenceId: null,
            }]
          : [],
      },
    });
    return this.completeEmailDispatchRequest(reserved.request);
  }

  private shouldInsertSeedEmail(sendableCount: number, seedCount: number, policy: EmailSeedPolicy) {
    if (!policy.enabled || !policy.address || process.env.NODE_ENV === 'test') return false;
    if (sendableCount === 1 && seedCount === 0) return true;
    return sendableCount > 0 && sendableCount % policy.interval === 0;
  }

  private async buildSeedTestEmailPlan(params: {
    companyId: string;
    currentUserId: string;
    idempotencyKey: string;
    emailAccount: any;
    template: any;
    dto: SendBatchDto;
    sendDelayMs: number;
    seedIndex: number;
    seedPolicy: EmailSeedPolicy;
  }): Promise<{
    plan: EmailDispatchMessagePlan;
    result: { leadId: string; success: boolean; message: string; emailMessageId?: string };
    seedLead?: EmailDispatchSeedLeadPlan;
  }> {
    const seedEmail = params.seedPolicy.enabled ? params.seedPolicy.address : null;
    if (!seedEmail) {
      throw new BadRequestException('Seed email policy is not explicitly enabled and approved');
    }
    const seedLead = await this.planSeedTestLead(
      params.companyId,
      params.currentUserId,
      seedEmail,
      params.seedPolicy.interval,
    );
    const lead = seedLead.lead;
    const rendered = this.renderTemplate(
      params.template,
      lead,
      params.emailAccount,
      params.dto.productName,
      {
        ...(params.dto.customVariables || {}),
        company_name: lead.companyName ?? 'Seed Monitor Company',
        contact_name: lead.contactName || 'Seed Monitor',
        country: lead.country || 'China',
      },
      { name: DEFAULT_EMAIL_COMPANY_NAME, website: DEFAULT_EMAIL_COMPANY_WEBSITE },
    );
    if (params.dto.subject) rendered.subject = params.dto.subject;
    if (params.dto.body) rendered.body = params.dto.body;

    const trackingId = uuidv4();
    const unsubscribeToken = uuidv4();
    const initialBody = params.dto.aiPersonalize
      ? rendered.body
      : this.appendUnsubscribeLink(
          this.replaceLinksWithTracking(
            this.injectTrackingPixel(
              ensureCompanyWebsite(rendered.body, DEFAULT_EMAIL_COMPANY_WEBSITE),
              trackingId,
            ),
            trackingId,
          ),
          unsubscribeToken,
        );

    const messageId = this.deterministicEmailDispatchId(
      'email-dispatch-message',
      params.companyId,
      'BATCH',
      params.idempotencyKey,
      `seed-${params.seedIndex}`,
      lead.id,
    );
    const job: EmailDispatchJob = params.dto.aiPersonalize
      ? {
          queue: 'compose',
          name: 'compose-email',
          jobId: `email-dispatch-${messageId}-compose`,
          data: {
            emailMessageId: messageId,
            productName: params.dto.productName,
            customVariables: params.dto.customVariables,
            sendDelayMs: params.sendDelayMs,
            aiPersonalize: true,
          },
          options: {
            attempts: 3,
            backoff: { type: 'exponential', delay: 10000 },
            removeOnComplete: 100,
            removeOnFail: 100,
          },
        }
      : {
          queue: 'validate',
          name: 'validate-email',
          jobId: `email-dispatch-${messageId}-validate`,
          data: {
            emailMessageId: messageId,
            aiPersonalize: false,
            sendDelayMs: params.sendDelayMs,
          },
          options: {
            attempts: 3,
            backoff: { type: 'exponential', delay: 10000 },
            removeOnComplete: 100,
            removeOnFail: 100,
          },
        };
    const plan: EmailDispatchMessagePlan = {
      id: messageId,
      data: {
        companyId: params.companyId,
        leadId: lead.id,
        emailAccountId: params.emailAccount.id,
        templateId: params.template.id,
        senderUserId: params.currentUserId,
        toEmail: seedEmail,
        subject: rendered.subject,
        bodyHtml: initialBody,
        renderedBody: initialBody,
        trackingId,
        unsubscribeToken,
        outreachRound: params.dto.outreachRound || 0,
        status: params.dto.aiPersonalize ? 'DraftPending' : 'DraftReady',
        failedReason: `Seed test email #${params.seedIndex} for batch delivery monitoring`,
      },
      job,
    };

    return {
      plan,
      result: {
        leadId: lead.id,
        success: true,
        message: `Seed test email queued to approved address ${seedEmail}`,
        emailMessageId: messageId,
      },
      seedLead: seedLead.create,
    };
  }

  private async planSeedTestLead(
    companyId: string,
    ownerUserId: string,
    seedEmail: string,
    seedInterval: number,
  ) {
    const existing = await this.prisma.lead.findFirst({
      where: {
        companyId,
        contactEmail: seedEmail,
        sourceType: 'system_seed_test',
        deletedAt: null,
      },
    });
    if (existing) return { lead: existing };

    const id = this.deterministicEmailDispatchId(
      'email-seed-lead',
      companyId,
      seedEmail.trim().toLowerCase(),
    );
    const data = {
      companyId,
      companyName: 'Approved Mail Delivery Monitor',
      contactName: 'Seed Monitor',
      contactTitle: 'Internal deliverability test mailbox',
      contactEmail: seedEmail,
      mainProducts: 'Internal seed mailbox for Vaysen Trade OS email delivery monitoring',
      sourceType: 'system_seed_test',
      sourceUrl: 'system://email-seed-test',
      sourceKeyword: 'email delivery seed test',
      sourceCountry: 'China',
      country: 'China',
      emailVerificationStatus: 'official_page_verified',
      emailVerificationReason: 'Internal seed mailbox configured by system owner for delivery monitoring.',
      confidenceScore: 100,
      leadScore: 100,
      leadGrade: 'A',
      status: 'new',
      reviewStatus: 'approved',
      ownerUserId,
      notes: `Approved system seed mailbox. Every batch and each ${seedInterval} accepted recipients can include one controlled test email to verify real SMTP delivery.`,
    };
    return {
      lead: { id, ...data },
      create: { id, data },
    };
  }

  // ========== List / Detail ==========

  async generateAiDraft(dto: { leadId: string; emailAccountId?: string; emailTemplateId?: string; productName?: string }, currentUser: any) {
    const company = this.getCompany(currentUser);
    const [lead, emailAccount, template] = await Promise.all([
      this.prisma.lead.findFirst({
        where: { id: dto.leadId, companyId: company.id, deletedAt: null },
      }),
      dto.emailAccountId
        ? this.prisma.emailAccount.findFirst({
            where: { id: dto.emailAccountId, companyId: company.id },
          })
        : null,
      dto.emailTemplateId
        ? this.prisma.emailTemplate.findFirst({
            where: { id: dto.emailTemplateId, companyId: company.id },
            include: { variables: true },
          })
        : null,
    ]);

    if (!lead || lead.deletedAt) throw new NotFoundException('Lead not found');
    if (lead.companyId !== company.id) throw new ForbiddenException('Lead does not belong to your company');
    await this.checkLeadAccess(currentUser, lead);

    if (emailAccount && emailAccount.companyId !== company.id) throw new NotFoundException('Email account not found');
    if (template && template.companyId !== company.id) throw new NotFoundException('Email template not found');

    const account = emailAccount || { senderName: currentUser.firstName || `${company.name} Team`, senderEmail: currentUser.email };
    return this.generateAiDraftForLead(lead, account, template, company, currentUser, dto.productName);
  }

  async getQueueStatus(currentUser: any) {
    const queueScope = {
      ...this.buildCompanyWhere(currentUser),
      deletedAt: null,
    };
    const scoped = (where: Record<string, any>) => ({
      ...queueScope,
      ...where,
    });
    const pendingStatuses = ['DraftPending', 'Drafting', 'DraftReady', 'ValidationFailed', 'QueuedToSend', 'Queued'];
    const [draftPending, drafting, draftReady, validationFailed, queuedToSend, legacyQueued, sending, sentToday, failed, skipped] = await Promise.all([
      this.prisma.emailMessage.count({ where: scoped({ status: 'DraftPending' }) }),
      this.prisma.emailMessage.count({ where: scoped({ status: 'Drafting' }) }),
      this.prisma.emailMessage.count({ where: scoped({ status: 'DraftReady' }) }),
      this.prisma.emailMessage.count({ where: scoped({ status: 'ValidationFailed' }) }),
      this.prisma.emailMessage.count({ where: scoped({ status: 'QueuedToSend' }) }),
      this.prisma.emailMessage.count({ where: scoped({ status: 'Queued' }) }),
      this.prisma.emailMessage.count({ where: scoped({ status: 'Sending' }) }),
      this.prisma.emailMessage.count({
        where: scoped({
          status: 'Sent',
          sentAt: { gte: new Date(new Date().setHours(0, 0, 0, 0)) },
        }),
      }),
      this.prisma.emailMessage.count({
        where: scoped({
          status: { in: ['Failed', 'DraftFailed'] },
          createdAt: { gte: new Date(Date.now() - 3600000) },
        }),
      }),
      this.prisma.emailMessage.count({
        where: scoped({
          status: 'Skipped',
          createdAt: { gte: new Date(Date.now() - 3600000) },
        }),
      }),
    ]);
    const queued = draftPending + drafting + draftReady + validationFailed + queuedToSend + legacyQueued;

    // Group queued emails by sender user
    const byUser = await this.prisma.emailMessage.groupBy({
      by: ['senderUserId'],
      where: scoped({ status: { in: pendingStatuses } }),
      _count: true,
    });

    // Get user names
    const userIds = byUser.map(u => u.senderUserId).filter(Boolean) as string[];
    const users = userIds.length > 0 ? await this.prisma.user.findMany({
      where: {
        id: { in: userIds.filter(id => id !== null) },
        isActive: true,
        deletedAt: null,
        companies: {
          some: {
            companyId: queueScope.companyId,
            isActive: true,
            company: { is: { isActive: true } },
          },
        },
      },
      select: { id: true, firstName: true, lastName: true },
    }) : [];
    const userMap = new Map(users.map(u => [u.id, u]));

    const hourlyRate = 120; // ~120 emails per hour with serial queue
    const estimatedMinutes = queued > 0 ? Math.ceil(queued / hourlyRate * 60) : 0;

    return {
      data: {
        queued,
        draftPending,
        drafting,
        draftReady,
        validationFailed,
        queuedToSend,
        legacyQueued,
        sending,
        sentToday,
        failed,
        skipped,
        estimatedMinutes: queued > 0 ? estimatedMinutes : 0,
        sendingNow: sending > 0,
        perUser: byUser.map(u => {
          const uid = u.senderUserId || '';
          const user = uid ? userMap.get(uid) : undefined;
          return {
            userId: uid,
            name: user ? `${user.firstName} ${user.lastName}` : 'Unknown',
            queued: u._count,
          };
        }),
      },
    };
  }

  async getTeamStats(currentUser: any) {
    const companyId = requireActiveCompany(currentUser).id;
    const isFullAccess = this.isFullAccess(currentUser, companyId);
    if (!isFullAccess) return { data: [] };

    const today = new Date(); today.setHours(0,0,0,0);

    // Get all users in these companies
    const relations = await this.prisma.userCompanyRelation.findMany({
      where: { companyId, isActive: true },
      include: { user: { select: { id:true, firstName:true, lastName:true, email:true } }, role: { select: { name:true } } },
    });

    const stats = await Promise.all(relations.map(async (rel) => {
      const userId = rel.userId;
      const pendingStatuses = ['DraftPending', 'Drafting', 'DraftReady', 'ValidationFailed', 'QueuedToSend', 'Queued'];
      const [sent, sentToday, opened, clicked, queued, failed] = await Promise.all([
        this.prisma.emailMessage.count({ where: { senderUserId: userId, companyId, status: 'Sent' } }),
        this.prisma.emailMessage.count({ where: { senderUserId: userId, companyId, status: 'Sent', sentAt: { gte: today } } }),
        this.prisma.emailMessage.count({ where: { senderUserId: userId, companyId, status: 'Sent', openedAt: { not: null } } }),
        this.prisma.emailMessage.count({ where: { senderUserId: userId, companyId, status: 'Sent', clickedAt: { not: null } } }),
        this.prisma.emailMessage.count({ where: { senderUserId: userId, companyId, status: { in: pendingStatuses } } }),
        this.prisma.emailMessage.count({ where: { senderUserId: userId, companyId, status: { in: ['Failed', 'DraftFailed'] } } }),
      ]);

      // Check if user has active search tasks
      const prospectingTasks = await this.prisma.searchTask.findMany({
        where: {
          companyId,
          createdBy: userId,
          status: { in: ['running', 'pending'] },
        },
        orderBy: { createdAt: 'desc' }, take: 1,
        select: { status:true, targetCountry:true, keywords:true, totalFound:true }
      });

      return {
        userId,
        firstName: rel.user.firstName,
        lastName: rel.user.lastName,
        email: rel.user.email,
        role: rel.role.name,
        sent,
        sentToday,
        opened,
        clicked,
        queued,
        failed,
        openRate: sent > 0 ? Math.round(opened / sent * 100) : 0,
        clickRate: sent > 0 ? Math.round(clicked / sent * 100) : 0,
        prospecting: prospectingTasks.length > 0 ? {
          status: prospectingTasks[0].status,
          target: prospectingTasks[0].targetCountry,
          keywords: prospectingTasks[0].keywords?.join(', '),
          found: prospectingTasks[0].totalFound,
        } : null,
      };
    }));

    return { data: stats };
  }

  async findAll(currentUser: any, query: {
    page?: number; limit?: number; status?: string; leadId?: string;
    emailAccountId?: string; senderUserId?: string; dateFrom?: string; dateTo?: string;
  }) {
    const page = query.page || 1;
    const limit = query.limit || 20;
    const skip = (page - 1) * limit;

    const where: any = this.buildCompanyWhere(currentUser);
    if (query.status) where.status = query.status;
    if (query.leadId) where.leadId = query.leadId;
    if (query.emailAccountId) where.emailAccountId = query.emailAccountId;
    const companyId = requireActiveCompany(currentUser).id;
    const isFullAccess = this.isFullAccess(currentUser, companyId);
    if (query.senderUserId && isFullAccess) where.senderUserId = query.senderUserId;
    if (query.dateFrom || query.dateTo) {
      where.createdAt = {};
      if (query.dateFrom) where.createdAt.gte = new Date(query.dateFrom);
      if (query.dateTo) where.createdAt.lte = new Date(query.dateTo);
    }
    where.deletedAt = null;

    const [data, total] = await Promise.all([
      this.prisma.emailMessage.findMany({
        where,
        include: {
          lead: { select: { id: true, companyName: true, contactName: true, contactEmail: true } },
          emailAccount: { select: { id: true, senderName: true, senderEmail: true } },
          senderUser: { select: { id: true, firstName: true, lastName: true, email: true } },
          openEvents: { select: { openedAt: true, count: true }, orderBy: { openedAt: 'desc' }, take: 1 },
          clickEvents: { select: { clickedAt: true, originalUrl: true }, orderBy: { clickedAt: 'desc' }, take: 5 },
        },
        skip,
        take: limit,
        orderBy: { createdAt: 'desc' },
      }),
      this.prisma.emailMessage.count({ where }),
    ]);

    return { data, meta: { page, limit, total, totalPages: Math.ceil(total / limit) } };
  }

  async findOne(id: string, currentUser: any) {
    const msg = await this.prisma.emailMessage.findFirst({
      where: {
        id,
        ...this.buildCompanyWhere(currentUser),
        deletedAt: null,
      },
      include: {
        lead: { select: { id: true, companyName: true, contactName: true, contactEmail: true, status: true } },
        emailAccount: { select: { id: true, senderName: true, senderEmail: true } },
        senderUser: { select: { id: true, firstName: true, lastName: true, email: true } },
        openEvents: { orderBy: { openedAt: 'desc' } },
        clickEvents: { orderBy: { clickedAt: 'desc' } },
        bounceEvents: { orderBy: { bouncedAt: 'desc' } },
      },
    });
    if (!msg) throw new NotFoundException('Email message not found');
    return msg;
  }

  // ========== Resend ==========

  async resend(id: string, currentUser: any) {
    const company = this.getCompany(currentUser);
    this.checkWriteAccess(currentUser, company.id);
    const accessWhere = this.buildCompanyWhere(currentUser);

    const msg = await this.prisma.emailMessage.findFirst({
      where: {
        id,
        ...accessWhere,
        deletedAt: null,
      },
      include: { lead: true, emailAccount: true },
    });
    if (!msg) throw new NotFoundException('Email message not found');

    if (!['Failed', 'Bounced'].includes(msg.status)) {
      throw new BadRequestException(`Cannot resend email with status "${msg.status}". Only failed or bounced emails can be resent.`);
    }

    await this.checkLeadAccess(currentUser, msg.lead);
    await this.outbound.assertEmailAccountAccess(
      company.id,
      msg.emailAccountId,
      currentUser,
    );

    const eligibility = await this.checkSendEligibility(msg.lead, msg.emailAccount);
    if (!eligibility.canSend) {
      throw new BadRequestException(eligibility.reason);
    }

    const trackingId = uuidv4();
    const unsubscribeToken = uuidv4();
    const bodyWithTracking = this.injectTrackingPixel(
      ensureCompanyWebsite(msg.bodyHtml, resolveEmailCompanyWebsite(company.website)),
      trackingId,
    );
    const bodyWithLinks = this.replaceLinksWithTracking(bodyWithTracking, trackingId);
    const bodyWithUnsubscribe = this.appendUnsubscribeLink(bodyWithLinks, unsubscribeToken);

    const reserved = await this.prisma.emailMessage.updateMany({
      where: {
        id,
        ...accessWhere,
        deletedAt: null,
        status: { in: ['Failed', 'Bounced'] },
      },
      data: {
        trackingId,
        unsubscribeToken,
        renderedBody: bodyWithUnsubscribe,
        bodyHtml: bodyWithUnsubscribe,
        status: 'DraftReady',
        retryCount: { increment: 1 },
        failedAt: null,
        failedReason: null,
        errorMessage: null,
      },
    });
    if (reserved.count !== 1) {
      this.logger.warn(safeLogEvent('email.resend_reservation_conflict', {
        status: 'rejected',
        stage: 'reservation',
        count: reserved.count,
        messageRef: safeDigest(id, 'email-message'),
      }));
      throw new ConflictException(
        'Email message changed before the resend could be reserved',
      );
    }

    const queueJobId = `email-resend-${id}-${msg.retryCount + 1}`;
    try {
      await this.emailValidateQueue.add('validate-email', {
        emailMessageId: id,
        aiPersonalize: false,
        sendDelayMs: 0,
      }, {
        jobId: queueJobId,
        attempts: 3,
        backoff: { type: 'exponential', delay: 10000 },
        removeOnComplete: 100,
        removeOnFail: 100,
      });
    } catch (enqueueError) {
      this.logger.warn(safeLogEvent('email.resend_queue_write_failed', {
        status: 'failed',
        stage: 'dispatch',
        messageRef: safeDigest(id, 'email-message'),
        error: enqueueError,
        errorCategory: safeErrorCategory(enqueueError),
      }));
      // A queue write can fail after the server accepted the job. Resolve that
      // ambiguity by its deterministic id before changing the database state.
      try {
        const acceptedJob = await this.emailValidateQueue.getJob(queueJobId);
        if (acceptedJob) {
          this.logger.warn(safeLogEvent('email.resend_queue_ack_recovered', {
            status: 'accepted',
            stage: 'dispatch',
            accepted: true,
            messageRef: safeDigest(id, 'email-message'),
            error: enqueueError,
            errorCategory: safeErrorCategory(enqueueError),
          }));
          return {
            success: true,
            message: 'Email re-queued for validation before sending',
            messageRef: safeDigest(id, 'email-message'),
          };
        }
      } catch (lookupError) {
        this.logger.error(safeLogEvent('email.resend_queue_outcome_unknown', {
          status: 'unknown',
          stage: 'dispatch',
          messageRef: safeDigest(id, 'email-message'),
          error: lookupError,
          errorCategory: safeErrorCategory(lookupError),
        }));
        throw new ServiceUnavailableException(
          'Email resend queue outcome is unknown; the reservation was retained',
        );
      }

      let compensated = false;
      try {
        const rollback = await this.prisma.emailMessage.updateMany({
          where: {
            id,
            companyId: company.id,
            status: 'DraftReady',
            trackingId,
          },
          data: {
            trackingId: msg.trackingId,
            unsubscribeToken: msg.unsubscribeToken,
            renderedBody: msg.renderedBody,
            bodyHtml: msg.bodyHtml,
            status: msg.status,
            retryCount: msg.retryCount,
            failedAt: msg.failedAt,
            failedReason: msg.failedReason,
            errorMessage: msg.errorMessage,
          },
        });
        compensated = rollback.count === 1;
      } catch {
        compensated = false;
      }
      if (!compensated) {
        this.logger.error(safeLogEvent('email.resend_rollback_unknown', {
          status: 'unknown',
          stage: 'rollback',
          messageRef: safeDigest(id, 'email-message'),
          error: enqueueError,
          errorCategory: safeErrorCategory(enqueueError),
        }));
        throw new ServiceUnavailableException(
          'Email resend queue failed and the reservation outcome is unknown',
        );
      }
      this.logger.warn(safeLogEvent('email.resend_rolled_back', {
        status: 'failed',
        stage: 'rollback',
        messageRef: safeDigest(id, 'email-message'),
        error: enqueueError,
        errorCategory: safeErrorCategory(enqueueError),
      }));
      throw new ServiceUnavailableException(
        'Email resend could not be queued; the reservation was rolled back',
      );
    }

    this.logger.log(safeLogEvent('email.resend_queued', {
      status: 'accepted',
      stage: 'dispatch',
      accepted: true,
      messageRef: safeDigest(id, 'email-message'),
    }));
    return {
      success: true,
      message: 'Email re-queued for validation before sending',
      messageRef: safeDigest(id, 'email-message'),
    };
  }

  // ========== By Lead ==========

  async findByLead(leadId: string, currentUser: any) {
    const companyId = requireActiveCompany(currentUser).id;
    const lead = await this.prisma.lead.findFirst({
      where: { id: leadId, companyId, deletedAt: null },
    });
    if (!lead) throw new NotFoundException('Lead not found');
    this.checkCompanyAccess(currentUser, { companyId: lead.companyId });

    const messages = await this.prisma.emailMessage.findMany({
      where: {
        companyId,
        leadId,
        deletedAt: null,
        ...(this.isFullAccess(currentUser, companyId)
          ? {}
          : { senderUserId: currentUser.id }),
      },
      include: {
        emailAccount: { select: { id: true, senderName: true, senderEmail: true } },
        senderUser: { select: { id: true, firstName: true, lastName: true } },
        openEvents: { orderBy: { openedAt: 'desc' } },
        clickEvents: { orderBy: { clickedAt: 'desc' } },
      },
      orderBy: { createdAt: 'desc' },
    });

    return { data: messages };
  }

  // ========== Eligibility Check ==========

  private async checkSendEligibility(
    lead: any,
    emailAccount: any,
  ): Promise<{ canSend: boolean; reason?: string }> {
    // 1. Lead has contact email
    if (!lead.contactEmail || !lead.contactEmail.trim()) {
      return { canSend: false, reason: 'Lead has no contact email' };
    }

    // 2. Email format validation
    if (!VALID_EMAIL_REGEX.test(lead.contactEmail)) {
      return { canSend: false, reason: `Invalid email format: ${lead.contactEmail}` };
    }

    // 3. Lead status - Lost (includes DNC/unqualified)
    if (lead.status === 'lost') {
      return { canSend: false, reason: 'Lead is marked as lost/invalid' };
    }

    const blockedReviewStatuses = new Set(['pending', 'needs_enrichment', 'manual_review', 'rejected']);
    if (lead.status === 'manual_review' || blockedReviewStatuses.has(lead.reviewStatus)) {
      return {
        canSend: false,
        reason: `Lead profile review is not approved (${lead.reviewStatus || lead.status}). Approve the profile before auto sending.`,
      };
    }

    const verificationStatus = await this.ensureAutoEmailVerification(lead);
    if (!SENDABLE_EMAIL_VERIFICATION_STATUSES.has(verificationStatus)) {
      return {
        canSend: false,
        reason: `Email is not verified for auto sending (${verificationStatus}). ${lead.emailVerificationReason || 'Move it through email verification or manual review first.'}`,
      };
    }

    // 4. Lead is unsubscribed
    const unsubscribed = await this.prisma.unsubscribeRecord.findFirst({
      where: { leadId: lead.id },
    });
    if (unsubscribed) {
      return { canSend: false, reason: 'Lead has unsubscribed from marketing emails' };
    }

    // 5. Lead email is blacklisted
    const blacklisted = await this.prisma.blacklistRecord.findFirst({
      where: {
        OR: [
          { email: lead.contactEmail, isActive: true },
          { domain: lead.contactEmail.split('@')[1] || '', isActive: true },
        ],
      },
    });
    if (blacklisted) {
      return { canSend: false, reason: 'Email or domain is on the blacklist' };
    }

    // 6. Email account exists and is active
    if (!emailAccount || emailAccount.status !== 'active') {
      return { canSend: false, reason: 'Email account is not active' };
    }

    // 7. Daily send limit
    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);
    if (emailAccount.dailySentCount >= emailAccount.dailySendLimit) {
      return { canSend: false, reason: `Daily send limit (${emailAccount.dailySendLimit}) reached` };
    }

    // 8. Hourly send limit
    const hourStart = new Date();
    hourStart.setMinutes(0, 0, 0);
    if (emailAccount.hourlySentCount >= emailAccount.hourlySendLimit) {
      return { canSend: false, reason: `Hourly send limit (${emailAccount.hourlySendLimit}) reached` };
    }

    // Interval handled by serial queue (concurrency: 1) 鈥?always allow send
    return { canSend: true };
  }

  private async ensureAutoEmailVerification(lead: any): Promise<string> {
    const current = lead.emailVerificationStatus || 'unverified';
    if (SENDABLE_EMAIL_VERIFICATION_STATUSES.has(current)) return current;
    // Some older leads were marked rejected by previous stricter rules. Re-evaluate them
    // before sending so valid business domains are not permanently skipped.
    if (current === 'rejected') {
      lead.emailVerificationReason = 'Rechecking previously rejected email before sending.';
    }

    const email = String(lead.contactEmail || '').trim().toLowerCase();
    if (!VALID_EMAIL_REGEX.test(email)) return current;

    const [localPart, domain] = email.split('@');
    const mailbox = localPart.split(/[.+_-]/)[0];
    const normalizedDomain = domain.toLowerCase();

    if (FREE_EMAIL_DOMAINS.has(normalizedDomain)) {
      await this.updateLeadEmailVerification(lead.id, lead.contactEmail, 'rejected', 'Free mailbox is not allowed for automatic cold email sending.');
      return 'rejected';
    }

    if (HARD_BLOCKED_MAILBOXES.has(mailbox)) {
      await this.updateLeadEmailVerification(lead.id, lead.contactEmail, 'rejected', `Mailbox "${mailbox}" is not allowed for automatic sending.`);
      return 'rejected';
    }

    const hasMx = await this.hasMxRecord(normalizedDomain);
    if (!hasMx) {
      await this.updateLeadEmailVerification(lead.id, lead.contactEmail, 'rejected', 'Email domain has no MX record.');
      return 'rejected';
    }

    const websiteDomain = this.extractDomain(lead.websiteDomain || lead.website || lead.url || '');
    const domainMatchesWebsite = Boolean(websiteDomain && (normalizedDomain === websiteDomain || normalizedDomain.endsWith(`.${websiteDomain}`)));
    const isBusinessMailbox = AUTO_SEND_BUSINESS_MAILBOXES.has(mailbox);

    const reason = domainMatchesWebsite
      ? 'MX matches the user-supplied website, but trusted mailbox proof is still required.'
      : isBusinessMailbox
        ? `Business mailbox "${mailbox}" has MX, but trusted mailbox proof is still required.`
        : 'MX exists, but mailbox role/source requires manual review before automatic sending.';
    await this.updateLeadEmailVerification(lead.id, lead.contactEmail, 'mx_domain_verified', reason);
    lead.emailVerificationStatus = 'mx_domain_verified';
    lead.emailVerificationReason = reason;
    return 'mx_domain_verified';
  }

  private async updateLeadEmailVerification(
    leadId: string,
    expectedEmail: string,
    status: string,
    reason: string,
  ) {
    await writeEmailVerificationEvidence(this.prisma, {
      leadId,
      expectedEmail,
      status,
      reason,
      trustedEvidence: false,
    }).catch(() => undefined);
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

  // ========== Template Rendering ==========

  private async generateAiDraftForLead(
    lead: any,
    emailAccount: any,
    template: any,
    company: any,
    currentUser: any,
    productName?: string,
  ): Promise<{ subject: string; body: string }> {
    if (!this.aiClient) {
      throw new BadRequestException('AI API key is not configured');
    }

    const [history, materials] = await Promise.all([
      this.prisma.emailMessage.findMany({
        where: { leadId: lead.id, deletedAt: null },
        select: { subject: true, status: true, sentAt: true, createdAt: true, openedAt: true, clickedAt: true },
        orderBy: { createdAt: 'desc' },
        take: 5,
      }),
      this.prisma.product.findMany({
        where: { companyId: company.id, isActive: true },
        include: { category: { select: { name: true } } },
        orderBy: { updatedAt: 'desc' },
        take: 8,
      }),
    ]);

    const companyName = resolveEmailCompanyName(company?.name);
    const companyWebsite = resolveEmailCompanyWebsite(company?.website);
    const senderName = emailAccount?.senderName || currentUser.firstName || `${companyName} Team`;
    const companySettings = (company.settings as any) || {};
    const prompt = `
You are writing a B2B cold outreach email for ${companyName}, a custom packaging supplier.

Company facts to use only when relevant:
- Brand/company name: ${companyName}
- Official website: ${companyWebsite}
- Company description: ${company.description || 'not configured'}
- Selling points: ${companySettings.sellingPoints || 'not configured'}
- Product scope: ${companySettings.productScope || 'not configured'}
- Compliance / delivery notes: ${companySettings.certificates || 'not configured'}
- Outreach rules: ${companySettings.aiOutreachRules || 'not configured'}
- Contact: ${senderName}

SOP rules:
- Prioritize importers, distributors, retailers, ecommerce sellers, manufacturers, and brands that need custom packaging.
- Match packaging material, size, printing, sealing, and order options to the customer type and country. Avoid generic claims.
- The email must be specific to the customer, short, professional, and practical. Do not sound like spam.
- If previous emails exist, write the next-round follow-up and do not repeat the same opening.
- Do not invent ${companyName} facts. Do not include any physical address, office address, US address, phone number, fax number, registration number, or legal entity unless it is explicitly present in Company facts.
- Do not write "New York", "Los Angeles", "California", "United States", "USA office", "123 Main Street", or any similar address/footer detail.

Customer:
${JSON.stringify({
  companyName: lead.companyName,
  contactName: lead.contactName,
  contactEmail: lead.contactEmail,
  country: lead.country,
  website: lead.website,
  productCategory: lead.productCategory,
  businessType: lead.businessType,
  mainProducts: lead.mainProducts,
  sourceType: lead.sourceType,
  leadGrade: lead.leadGrade,
  leadScore: lead.leadScore,
  notes: lead.notes,
}, null, 2)}

Available material/product pool:
${JSON.stringify(materials.map((m) => ({
  name: m.name,
  sku: m.sku,
  category: m.category?.name,
  description: m.description,
  attributes: m.attributes,
  images: m.images,
})), null, 2)}

Previous email history:
${JSON.stringify(history, null, 2)}

Selected focus product/material: ${productName || 'choose the best match from customer profile and material pool'}
Template reference: ${template ? JSON.stringify({ name: template.name, subject: template.subject, body: template.body }) : 'none'}

Return only valid JSON:
{
  "subject": "plain English subject under 70 characters",
  "bodyText": "plain text fallback",
  "bodyHtml": "HTML email body or HTML fragment"
}

HTML requirements:
- Use UTF-8 safe English only.
- Use old-email-safe table layout and inline CSS only. No scripts, no external CSS, no background images.
- Width around 600px. Gmail and Outlook compatible.
- Include 3-5 short paragraphs or bullet rows, not a long essay.
- Include a clear but soft CTA asking whether they need custom packaging samples, a catalog, or a quotation.
- Do not invent customer facts.
- Do not include physical addresses or fake contact details.
- If the template body contains {{ai_body_html}}, return only an inner HTML fragment suitable for that slot, not a full document.
- CRITICAL: Do NOT include any email sign-off, signature, or closing salutation. No "Best regards", "Sincerely", "Warmly", "Cheers", sender name, company name, or any kind of signature. The email template already handles this. End with the CTA or the last paragraph directly. NO signature block at all.
`;

    const response = await this.aiClient.chat.completions.create({
      model: getAiModel('email'),
      messages: [
        { role: 'system', content: 'You write concise, deliverability-friendly B2B sales emails and return strict JSON only.' },
        { role: 'user', content: prompt },
      ],
      temperature: 0.45,
      max_tokens: 1800,
    });

    const content = response.choices[0]?.message?.content || '';
    const parsed = this.parseJsonDraft(content);
    const subject = String(parsed.subject || `Custom packaging options for ${lead.companyName || 'your team'}`).slice(0, 120);
    const bodyText = String(parsed.bodyText || '');
    const bodyHtml = String(parsed.bodyHtml || '');
    const effectiveBodyText = this.resolveAiBodyText(bodyText, bodyHtml, lead, productName);

    const fragment = this.cleanAiBodyFragment(this.normalizeEmailHtml(bodyHtml, effectiveBodyText), effectiveBodyText);
    return {
      subject,
      body: ensureCompanyWebsite(
        this.finalizeComposedBody(
          this.applyAiTemplate(
            template?.body,
            fragment,
            effectiveBodyText,
            senderName,
            companyName,
            companyWebsite,
          ),
        ),
        companyWebsite,
        companyWebsite.replace(/^https?:\/\//i, ''),
      ),
    };
  }

  private resolveAiBodyText(bodyText: string, bodyHtml: string, lead: any, productName?: string) {
    const direct = this.normalizePlainText(bodyText);
    if (this.isUsableAiBodyText(direct)) return direct;

    const visible = this.normalizePlainText(this.extractVisibleText(bodyHtml));
    if (this.isUsableAiBodyText(visible)) return visible;

    const company = lead?.companyName || 'your team';
    const category = productName || lead?.productCategory || lead?.mainProducts || 'custom packaging products';
    const opening = lead?.businessType || lead?.industry
      ? `I noticed ${company} is active in ${lead.businessType || lead.industry}.`
      : `I noticed ${company} may be a good fit for a custom packaging program.`;
    return [
      `Hi ${lead?.contactName || 'there'},`,
      `${opening} I wanted to introduce ${DEFAULT_EMAIL_COMPANY_NAME} as a manufacturing partner for ${category}.`,
      'We support custom sizes, materials, printing, logo options, samples, and practical trial orders so buyers can test packaging with a controlled first step.',
      'If you are evaluating packaging suppliers, would it be useful for me to send a short catalog and sample or quotation options for your review?',
    ].join('\n\n');
  }

  private normalizePlainText(value: string) {
    return (value || '')
      .replace(/&nbsp;/gi, ' ')
      .replace(/&amp;/gi, '&')
      .replace(/&lt;/gi, '<')
      .replace(/&gt;/gi, '>')
      .replace(/&quot;/gi, '"')
      .replace(/&#039;/gi, "'")
      .replace(/\s+\n/g, '\n')
      .replace(/\n\s+/g, '\n')
      .replace(/[ \t]{2,}/g, ' ')
      .trim();
  }

  private extractVisibleText(html: string) {
    return (html || '')
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/(?:p|div|tr|td|li|h[1-6])>/gi, '\n')
      .replace(/<[^>]+>/g, ' ')
      .split(/\n+/)
      .map((line) => line.trim())
      .filter((line) => line
        && !findLegacyEmailBrandReference(line)
        && !/^(Explore Our Collection|Visit Our Website|Unsubscribe)$/i.test(line))
      .join('\n\n');
  }

  private isUsableAiBodyText(value: string) {
    if (value.length < 180) return false;
    if (/<!doctype|<html|<table|<img|https:\/\/\/|logo\.png|product-collection|Explore Our Collection|Unsubscribe/i.test(value)) return false;
    return true;
  }

  private sanitizeAiEmailHtml(html: string) {
    return (html || '')
      .replace(/(?:\d{1,6}\s+[A-Za-z0-9.'#-]+(?:\s+[A-Za-z0-9.'#-]+){0,6}\s+(?:Street|St\.?|Avenue|Ave\.?|Road|Rd\.?|Boulevard|Blvd\.?|Drive|Dr\.?|Lane|Ln\.?|Way|Suite|Ste\.?|Floor|Fl\.?)[^<\n\r]*)/gi, '')
      .replace(/\b(?:New York|Los Angeles|San Francisco|California|CA\s+\d{5}|United States|USA office|U\.S\. office|US office)\b[^<\n\r]*/gi, '')
      .replace(/\b(?:Tel|Phone|Fax|Mobile)\s*[:：]\s*(?!\+?86)[+\d().\-\s]{6,}/gi, '')
      .replace(/<p\b[^>]*>\s*<\/p>/gi, '')
      .replace(/<tr\b[^>]*>\s*<td\b[^>]*>\s*<\/td>\s*<\/tr>/gi, '');
  }

  private applyAiTemplate(
    templateBody: string | undefined,
    aiHtml: string,
    bodyText: string,
    senderName: string,
    companyName: string,
    companyWebsite: string,
  ) {
    if (!templateBody || !templateBody.includes('{{ai_body_html}}')) return aiHtml;
    const fragment = this.cleanAiBodyFragment(this.extractEmailFragment(aiHtml, bodyText), bodyText);
    return replaceLegacyEmailBrandReferences(templateBody)
      .replace(/\{\{ai_body_html\}\}/g, fragment)
      .replace(/\{\{sender_name\}\}/g, this.escapeHtml(senderName))
      .replace(/\{\{sender_company\}\}/g, this.escapeHtml(companyName))
      .replace(/\{\{sender_website\}\}/g, this.escapeHtml(companyWebsite))
      .replace(/\{\{website\}\}/g, this.escapeHtml(companyWebsite))
      .replace(/\{\{whatsapp_cta_html\}\}/g, '')
      .replace(/\{\{whatsapp_url\}\}/g, '')
      .replace(/\{\{contact_name\}\}/g, '')
      .replace(/\{\{company_name\}\}/g, '')
      .replace(/\{\{country\}\}/g, '')
      .replace(/\{\{product_name\}\}/g, '')
      .replace(/\{\{pain_point\}\}/g, '')
      .replace(/\{\{last_email_date\}\}/g, '')
      .replace(/\{\{unsubscribe_link\}\}/g, '{{unsubscribe_link}}');
  }

  private extractEmailFragment(aiHtml: string, bodyText: string) {
    if (this.shouldPreferBodyText(aiHtml, bodyText)) {
      return this.bodyTextToHtml(bodyText);
    }
    const tdMatch = aiHtml.match(/<td[^>]*>([\s\S]*?)<\/td>/i);
    if (tdMatch?.[1]) return tdMatch[1].trim();
    if (/<p[\s>]/i.test(aiHtml) || /<ul[\s>]/i.test(aiHtml) || /<table[\s>]/i.test(aiHtml)) return aiHtml;
    return this.escapeHtml(bodyText || aiHtml).replace(/\n/g, '<br>');
  }

  private shouldPreferBodyText(aiHtml: string, bodyText: string) {
    const text = (bodyText || '').trim();
    if (text.length < 80) return false;
    return /<!doctype|<html|<body|<table|logo\.png|Your Company|https:\/\/\//i.test(aiHtml || '');
  }

  private bodyTextToHtml(bodyText: string) {
    return this.escapeHtml(bodyText)
      .split(/\n{2,}/)
      .map((p) => p.trim())
      .filter(Boolean)
      .map((p) => `<p style="margin:0 0 14px 0;line-height:1.55;color:#111827;font-size:14px;">${p.replace(/\n/g, '<br>')}</p>`)
      .join('');
  }

  private parseJsonDraft(content: string): any {
    try {
      return JSON.parse(content);
    } catch {
      const match = content.match(/\{[\s\S]*\}/);
      if (!match) return {};
      try {
        return JSON.parse(match[0]);
      } catch {
        return {};
      }
    }
  }

  private normalizeEmailHtml(bodyHtml: string, bodyText: string) {
    const cleanHtml = bodyHtml.trim();
    if (/<table[\s>]/i.test(cleanHtml) && /<\/table>/i.test(cleanHtml)) return cleanHtml;

    const escaped = this.escapeHtml(bodyText || cleanHtml.replace(/<[^>]*>/g, ''));
    const paragraphs = escaped
      .split(/\n{2,}/)
      .map((p) => p.trim())
      .filter(Boolean)
      .map((p) => `<p style="margin:0 0 14px 0;line-height:1.55;color:#111827;font-size:14px;">${p.replace(/\n/g, '<br>')}</p>`)
      .join('');

    return `
<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="width:100%;background:#ffffff;margin:0;padding:0;">
  <tr>
    <td align="center" style="padding:20px 12px;">
      <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="600" style="width:600px;max-width:100%;border:1px solid #e5e7eb;">
        <tr>
          <td style="padding:20px 24px;font-family:Arial,Helvetica,sans-serif;color:#111827;">
            ${paragraphs}
          </td>
        </tr>
      </table>
    </td>
  </tr>
</table>`.trim();
  }

  private escapeHtml(value: string) {
    return value
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
  }

  private renderTemplate(
    template: any,
    lead: any,
    emailAccount: any,
    productName?: string,
    customVars?: Record<string, string>,
    company?: { name?: string | null; website?: string | null },
  ): { subject: string; body: string } {
    const companyName = resolveEmailCompanyName(company?.name);
    const companyWebsite = resolveEmailCompanyWebsite(company?.website);
    const vars: Record<string, string> = {
      '{{contact_name}}': lead.contactName || '',
      '{{company_name}}': lead.companyName || '',
      '{{country}}': lead.country || '',
      '{{product_name}}': productName || lead.productCategory || '',
      '{{sender_name}}': emailAccount.senderName || '',
      '{{sender_company}}': companyName,
      '{{sender_website}}': companyWebsite,
      '{{website}}': companyWebsite,
      '{{pain_point}}': customVars?.pain_point || '',
      '{{last_email_date}}': customVars?.last_email_date || (lead.lastContactedAt ? new Date(lead.lastContactedAt).toISOString().split('T')[0] : ''),
      '{{unsubscribe_link}}': '', // placeholder, injected separately
      '{{unsubscribe_url}}': '', // legacy alias, injected separately
    };

    const whatsappUrl = customVars?.whatsapp_url || customVars?.whatsappUrl || '';
    vars['{{whatsapp_url}}'] = whatsappUrl;
    vars['{{whatsapp_cta_html}}'] = whatsappUrl
      ? `<tr><td style="padding:0 24px 22px 24px;"><a href="${this.escapeHtml(whatsappUrl)}" style="display:inline-block;background:#16a34a;color:#ffffff;text-decoration:none;border-radius:4px;padding:10px 14px;font-size:13px;font-weight:700;">WhatsApp ${this.escapeHtml(emailAccount.senderName || '')}</a></td></tr>`
      : '';

    if (customVars) {
      for (const [key, value] of Object.entries(customVars)) {
        vars[`{{${key}}}`] = value || '';
      }
    }

    let subject = replaceLegacyEmailBrandReferences(template.subject);
    let body = replaceLegacyEmailBrandReferences(template.body);

    for (const [key, value] of Object.entries(vars)) {
      const regex = new RegExp(key.replace(/[{}]/g, '\\$&'), 'g');
      subject = subject.replace(regex, value || '');
      body = body.replace(regex, value || '');
    }

    // Clean up remaining unreplaced variables
    subject = subject.replace(/\{\{\w+\}\}/g, '');
    body = this.removeOptionalTemplateRows(body).replace(/\{\{\w+\}\}/g, '');

    return { subject, body };
  }

  private removeOptionalTemplateRows(body: string) {
    return (body || '')
      .replace(/<tr\b[^>]*>\s*<td\b[^>]*>\s*\{\{whatsapp_cta_html\}\}\s*<\/td>\s*<\/tr>/gi, '')
      .replace(/<p\b[^>]*>\s*\{\{whatsapp_cta_html\}\}\s*<\/p>/gi, '')
      .replace(/\{\{whatsapp_cta_html\}\}/g, '')
      .replace(/\{\{whatsapp_url\}\}/g, '')
      .replace(/\{\{unsubscribe_url\}\}/g, '{{unsubscribe_link}}');
  }

  private cleanAiBodyFragment(html: string, bodyText?: string) {
    const source = html || bodyText || '';
    let fragment = replaceLegacyEmailBrandReferences(source)
      .replace(/<!doctype[\s\S]*?<body[^>]*>/i, '')
      .replace(/<\/body>[\s\S]*$/i, '')
      .replace(/<\/?html[^>]*>/gi, '')
      .replace(/<head[\s\S]*?<\/head>/gi, '')
      .replace(/<img[^>]+email-track\/open[^>]*>/gi, '')
      .replace(/<hr\s*\/?>[\s\S]*?unsubscribe[\s\S]*$/i, '')
      .replace(/\{\{[a-zA-Z0-9_]+\}\}/g, '')
      .replace(/(?:Best regards|Sincerely|Warm regards|Kind regards|Cheers),?[\s\S]*$/i, '')
      .replace(/<tr\b[^>]*>\s*<td\b[^>]*>\s*<\/td>\s*<\/tr>/gi, '')
      .replace(/<p\b[^>]*>\s*<\/p>/gi, '')
      .trim();

    if (!/<p[\s>]|<ul[\s>]|<ol[\s>]|<table[\s>]|<div[\s>]/i.test(fragment)) {
      fragment = this.escapeHtml(fragment).replace(/\n{2,}/g, '</p><p style="margin:0 0 14px 0;line-height:1.55;color:#111827;font-size:14px;">').replace(/\n/g, '<br>');
      fragment = `<p style="margin:0 0 14px 0;line-height:1.55;color:#111827;font-size:14px;">${fragment}</p>`;
    }
    return this.dedupeWebsiteBlocks(fragment);
  }

  private finalizeComposedBody(html: string) {
    return this.dedupeWebsiteBlocks(this.sanitizeAiEmailHtml(html));
  }

  private dedupeWebsiteBlocks(html: string) {
    let seenWebsite = false;
    return (html || '')
      .replace(/(<a\b[^>]*>\s*(?:Visit Our Website|(?:www\.)?vaysen\.com)\s*<\/a>)/gi, (match) => {
        if (seenWebsite) return '';
        seenWebsite = true;
        return match;
      })
      .replace(/<p\b[^>]*>\s*(?:https?:\/\/)?(?:www\.)?vaysen\.com\s*<\/p>/gi, (match) => {
        if (seenWebsite) return '';
        seenWebsite = true;
        return match;
      })
      .replace(/(<p\b[^>]*>\s*){2,}/gi, '<p ')
      .replace(/<p\b[^>]*>\s*<\/p>/gi, '')
      .replace(/<tr\b[^>]*>\s*<td\b[^>]*>\s*<\/td>\s*<\/tr>/gi, '');
  }

  // ========== Tracking Injection ==========

  private injectTrackingPixel(bodyHtml: string, trackingId: string): string {
    return injectPublicTrackingPixel(bodyHtml, trackingId);
  }

  private replaceLinksWithTracking(bodyHtml: string, trackingId: string): string {
    return replaceLinksWithPublicTracking(bodyHtml, trackingId);
  }

  private appendUnsubscribeLink(bodyHtml: string, token: string): string {
    return appendPublicUnsubscribe(bodyHtml, token);
  }

  private emailDispatchPayloadDigest(value: unknown) {
    return createHash('sha256')
      .update(JSON.stringify(this.canonicalizeEmailDispatchValue(value)))
      .digest('hex');
  }

  private canonicalizeEmailDispatchValue(value: unknown): unknown {
    if (value instanceof Date) return value.toISOString();
    if (Array.isArray(value)) {
      return value.map((item) => this.canonicalizeEmailDispatchValue(item));
    }
    if (value && typeof value === 'object') {
      return Object.keys(value as Record<string, unknown>)
        .sort()
        .reduce<Record<string, unknown>>((result, key) => {
          const item = (value as Record<string, unknown>)[key];
          if (item !== undefined) {
            result[key] = this.canonicalizeEmailDispatchValue(item);
          }
          return result;
        }, {});
    }
    return value;
  }

  private deterministicEmailDispatchId(...parts: string[]) {
    const hex = createHash('sha256')
      .update(JSON.stringify(parts))
      .digest('hex');
    return [
      hex.slice(0, 8),
      hex.slice(8, 12),
      `5${hex.slice(13, 16)}`,
      `${((parseInt(hex[16], 16) & 0x3) | 0x8).toString(16)}${hex.slice(17, 20)}`,
      hex.slice(20, 32),
    ].join('-');
  }

  private assertEmailDispatchReplay(
    request: any,
    expected: {
      companyId: string;
      operatorUserId: string;
      kind: string;
      idempotencyKey: string;
      inputDigest: string;
    },
  ) {
    const result = request.result as EmailDispatchResult | null;
    if (
      request.companyId !== expected.companyId
      || request.operatorUserId !== expected.operatorUserId
      || request.kind !== expected.kind
      || request.idempotencyKey !== expected.idempotencyKey
      || result?.inputDigest !== expected.inputDigest
    ) {
      throw new ConflictException({
        statusCode: 409,
        code: 'EMAIL_IDEMPOTENCY_PAYLOAD_CONFLICT',
        message: 'Idempotency-Key was already used with a different email request',
      });
    }
    if (
      !result
      || !result.response
      || !Array.isArray(result.jobs)
      || !result.projection
      || !Array.isArray(result.projection.activities)
    ) {
      throw new ConflictException(
        'Email dispatch request has no recoverable result snapshot',
      );
    }
    return request;
  }

  private async findEmailDispatchRequest(expected: {
    companyId: string;
    operatorUserId: string;
    kind: string;
    idempotencyKey: string;
    inputDigest: string;
  }) {
    const request = await this.prisma.emailDispatchRequest.findUnique({
      where: {
        companyId_idempotencyKey: {
          companyId: expected.companyId,
          idempotencyKey: expected.idempotencyKey,
        },
      },
    });
    return request
      ? this.assertEmailDispatchReplay(request, expected)
      : null;
  }

  private async reserveEmailDispatchRequest(params: {
    companyId: string;
    operatorUserId: string;
    kind: 'SINGLE' | 'BATCH';
    idempotencyKey: string;
    inputDigest: string;
    payloadDigest: string;
    response: Record<string, any>;
    messages: EmailDispatchMessagePlan[];
    seedLeads?: EmailDispatchSeedLeadPlan[];
    projection: EmailDispatchResult['projection'];
  }): Promise<ReservedEmailDispatch> {
    const expected = {
      companyId: params.companyId,
      operatorUserId: params.operatorUserId,
      kind: params.kind,
      idempotencyKey: params.idempotencyKey,
      inputDigest: params.inputDigest,
    };
    const existing = await this.findEmailDispatchRequest(expected);
    if (existing) return { request: existing, created: false };

    const result: EmailDispatchResult = JSON.parse(JSON.stringify({
      inputDigest: params.inputDigest,
      response: params.response,
      jobs: params.messages
        .map((message) => message.job)
        .filter(Boolean),
      projection: params.projection,
    }));
    const requestId = this.deterministicEmailDispatchId(
      'email-dispatch-request',
      params.companyId,
      params.idempotencyKey,
    );
    try {
      const request = await this.prisma.$transaction(async (tx: any) => {
        const createdRequest = await tx.emailDispatchRequest.create({
          data: {
            id: requestId,
            companyId: params.companyId,
            operatorUserId: params.operatorUserId,
            kind: params.kind,
            idempotencyKey: params.idempotencyKey,
            payloadDigest: params.payloadDigest,
            status: 'RESERVED',
            result,
          },
        });
        if (params.seedLeads?.length) {
          await tx.lead.createMany({
            data: params.seedLeads.map((lead) => ({
              id: lead.id,
              ...lead.data,
            })),
            skipDuplicates: true,
          });
        }
        for (const message of params.messages) {
          await tx.emailMessage.create({
            data: {
              id: message.id,
              ...message.data,
            },
          });
        }
        return createdRequest;
      });
      return { request, created: true };
    } catch (error) {
      const candidate = error as { code?: string };
      if (candidate?.code !== 'P2002') throw error;
      const raced = await this.findEmailDispatchRequest(expected);
      if (!raced) throw error;
      return { request: raced, created: false };
    }
  }

  private async ensureEmailDispatchJob(job: EmailDispatchJob) {
    const queue = job.queue === 'compose'
      ? this.emailComposeQueue
      : this.emailValidateQueue;
    try {
      await queue.add(job.name, job.data, {
        ...job.options,
        jobId: job.jobId,
      });
      return;
    } catch {
      try {
        const accepted = await queue.getJob(job.jobId);
        if (accepted) return;
      } catch {
        throw new ServiceUnavailableException(
          'Email queue acknowledgement is unknown; retry with the same Idempotency-Key',
        );
      }
      throw new ServiceUnavailableException(
        'Email could not be queued; retry with the same Idempotency-Key',
      );
    }
  }

  private async assertEmailDispatchReplayAccess(request: any, currentUser: any) {
    const response = (request.result as EmailDispatchResult | null)?.response as any;
    const messageIds = Array.from(new Set([
      response?.emailMessageId,
      ...(Array.isArray(response?.results)
        ? response.results.map((item: any) => item?.emailMessageId)
        : []),
    ].filter((value): value is string => typeof value === 'string' && value.length > 0)));
    if (messageIds.length === 0) return;

    const messages = await this.prisma.emailMessage.findMany({
      where: {
        id: { in: messageIds },
        companyId: request.companyId,
        deletedAt: null,
      },
      select: {
        id: true,
        lead: {
          select: {
            id: true,
            companyId: true,
            ownerUserId: true,
            deletedAt: true,
          },
        },
      },
    });
    if (messages.length !== messageIds.length) {
      throw new NotFoundException('Email dispatch request not found');
    }
    for (const message of messages) {
      if (!message.lead || message.lead.deletedAt) {
        throw new NotFoundException('Email dispatch request not found');
      }
      await this.checkLeadAccess(currentUser, message.lead);
    }
  }

  private async completeEmailDispatchRequest(request: any) {
    const result = request.result as EmailDispatchResult;
    if (request.status !== 'ENQUEUED') {
      for (const job of result.jobs) {
        await this.ensureEmailDispatchJob(job);
      }
      await this.prisma.$transaction(async (tx: any) => {
        const claimed = await tx.emailDispatchRequest.updateMany({
          where: {
            id: request.id,
            companyId: request.companyId,
            payloadDigest: request.payloadDigest,
            status: 'RESERVED',
          },
          data: { status: 'ENQUEUED' },
        });
        if (claimed.count !== 1) return;

        const templateProjection = result.projection.templateUseCount;
        if (templateProjection && templateProjection.increment > 0) {
          const template = await tx.emailTemplate.updateMany({
            where: {
              id: templateProjection.templateId,
              companyId: request.companyId,
            },
            data: {
              useCount: { increment: templateProjection.increment },
            },
          });
          if (template.count !== 1) {
            throw new ConflictException(
              'Email dispatch template projection target is missing',
            );
          }
        }
        for (const activity of result.projection.activities) {
          if (activity.companyId !== request.companyId) {
            throw new ConflictException(
              'Email dispatch activity projection tenant does not match',
            );
          }
          await tx.leadActivity.create({ data: activity });
        }
      });
    }
    return result.response;
  }

  // ========== Access Control ==========

  private getCompany(currentUser: any) {
    return requireActiveCompany(currentUser);
  }

  private buildCompanyWhere(currentUser: any): any {
    const company = requireActiveCompany(currentUser);
    const isFullAccess = this.isFullAccess(currentUser, company.id);

    const where: any = { companyId: company.id };
    if (!isFullAccess) {
      where.senderUserId = currentUser.id;
    }

    return where;
  }

  private buildLeadWhereForBatch(currentUser: any, companyId: string, filters: Record<string, any>) {
    const where: any = { companyId, deletedAt: null };
    const isFullAccess = this.isFullAccess(currentUser, companyId);
    if (!isFullAccess) where.ownerUserId = currentUser.id;
    if (filters.leadIds) {
      const leadIds = Array.isArray(filters.leadIds) ? filters.leadIds : String(filters.leadIds).split(',');
      where.id = { in: leadIds.filter(Boolean) };
    }

    if (filters.status) {
      const statuses = String(filters.status).split(',').filter(Boolean);
      where.status = statuses.length > 1 ? { in: statuses } : statuses[0];
    }
    if (filters.country) {
      const countries = String(filters.country).split(',').filter(Boolean);
      where.country = countries.length > 1 ? { in: countries } : countries[0];
    }
    if (filters.leadGrade) {
      const grades = String(filters.leadGrade).split(',').filter(Boolean);
      where.leadGrade = grades.length > 1 ? { in: grades } : grades[0];
    }
    if (filters.sourceType) {
      const sourceTypes = String(filters.sourceType).split(',').filter(Boolean);
      where.sourceType = sourceTypes.length > 1 ? { in: sourceTypes } : sourceTypes[0];
    }
    if (filters.emailVerificationStatus) {
      const verificationStatuses = String(filters.emailVerificationStatus).split(',').filter(Boolean);
      where.emailVerificationStatus = verificationStatuses.length > 1 ? { in: verificationStatuses } : verificationStatuses[0];
    }
    if (filters.ownerUserId && isFullAccess) where.ownerUserId = filters.ownerUserId;
    if (filters.productCategory) where.productCategory = filters.productCategory;
    const outreachRound = Number(filters.outreachRound ?? 0);
    const emailMessageClauses: any[] = [
      {
        emailMessages: {
          none: {
            outreachRound,
            status: { in: EMAIL_ACTIVE_ROUND_STATUSES },
            deletedAt: null,
          },
        },
      },
    ];

    if (outreachRound > 0) {
      emailMessageClauses.push({
        emailMessages: {
          some: {
            outreachRound: outreachRound - 1,
            status: { in: ['Sent', 'Opened', 'Clicked', 'Replied'] },
            deletedAt: null,
          },
        },
      });
    }

    const engagement = String(filters.engagement || '');
    if (engagement === 'opened') {
      emailMessageClauses.push({ emailMessages: { some: { openedAt: { not: null }, deletedAt: null } } });
    } else if (engagement === 'clicked') {
      emailMessageClauses.push({ emailMessages: { some: { clickedAt: { not: null }, deletedAt: null } } });
    } else if (engagement === 'replied') {
      emailMessageClauses.push({ emailMessages: { some: { status: 'Replied', deletedAt: null } } });
    }

    const includeReplied = filters.includeReplied === true || filters.includeReplied === 'true';
    if (!includeReplied) {
      emailMessageClauses.push({ emailMessages: { none: { status: 'Replied', deletedAt: null } } });
    }

    if (filters.hasEmailHistory === 'true') {
      emailMessageClauses.push({ emailMessages: { some: { deletedAt: null } } });
    }

    where.AND = [...(where.AND || []), ...emailMessageClauses];
    if (filters.search) {
      where.OR = [
        { companyName: { contains: filters.search, mode: 'insensitive' } },
        { contactEmail: { contains: filters.search, mode: 'insensitive' } },
        { website: { contains: filters.search, mode: 'insensitive' } },
        { contactName: { contains: filters.search, mode: 'insensitive' } },
      ];
    }
    return where;
  }

  private checkCompanyAccess(currentUser: any, resource: any) {
    const activeCompany = requireActiveCompany(currentUser);
    if (activeCompany.id !== resource.companyId) {
      throw new ForbiddenException('Cannot access resources from another company');
    }
  }

  private checkTemplateAccess(currentUser: any, template: any) {
    this.checkCompanyAccess(currentUser, template);
    const isFullAccess = this.isFullAccess(currentUser, template.companyId);
    if (!isFullAccess && template.createdBy && template.createdBy !== currentUser.id) {
      throw new ForbiddenException('You can only use your own email templates');
    }
  }

  private async checkLeadAccess(currentUser: any, lead: any) {
    const activeCompany = requireActiveCompany(currentUser);
    if (activeCompany.id !== lead.companyId) {
      throw new ForbiddenException('Cannot access lead from another company');
    }
    const isFullAccess = this.isFullAccess(currentUser, lead.companyId);
    if (isFullAccess) return;

    if (lead.ownerUserId && lead.ownerUserId !== currentUser.id) {
      throw new ForbiddenException('You can only send emails to your own leads');
    }
  }

  private checkWriteAccess(currentUser: any, companyId: string) {
    if (requireActiveCompany(currentUser).id !== companyId) {
      throw new ForbiddenException('Company is outside the active request context');
    }
    const isFullAccess = this.isFullAccess(currentUser, companyId);
    if (isFullAccess) return;

    const company = currentUser.companies?.find((c: any) => c.id === companyId);
    if (!company) throw new ForbiddenException('Not a member of this company');

    if (company.role === 'viewer') {
      throw new ForbiddenException('Viewer cannot send emails');
    }
  }

  private isFullAccess(currentUser: any, companyId: string) {
    return hasFullAccess(currentUser, companyId);
  }
}
