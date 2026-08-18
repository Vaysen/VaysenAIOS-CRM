import { Processor, WorkerHost, InjectQueue } from '@nestjs/bullmq';
import { Job, Queue } from 'bullmq';
import { Logger } from '@nestjs/common';
import { v4 as uuidv4 } from 'uuid';
import { PrismaService } from '@/common/prisma/prisma.service';
import { createAiClient, getAiModel } from '@/common/ai/ai-client.util';
import { QUEUES } from '@/common/queues/queue-names';
import {
  ensureCompanyWebsite,
  findLegacyEmailBrandReference,
  replaceLegacyEmailBrandReferences,
  resolveEmailCompanyName,
  resolveEmailCompanyWebsite,
} from './email-content.guard';
import {
  appendPublicUnsubscribe,
  injectPublicTrackingPixel,
  replaceLinksWithPublicTracking,
} from './email-public-links';
import { safeDigest, safeErrorCategory, safeLogEvent } from '@/common/security/safe-logging';

type ComposeJob = {
  emailMessageId: string;
  productName?: string;
  customVariables?: Record<string, string>;
  sendDelayMs?: number;
  aiPersonalize?: boolean;
};

const SIGNATURE_PATTERN = /(?:Best regards|Sincerely|Warm regards|Kind regards|Cheers),?[\s\S]*$/i;
const AI_DRAFT_MARKER = '<!-- vaysen-crm:ai-draft -->';

@Processor(QUEUES.emailCompose, { concurrency: Number(process.env.EMAIL_COMPOSE_CONCURRENCY || 2) })
export class EmailComposeProcessor extends WorkerHost {
  private readonly logger = new Logger(EmailComposeProcessor.name);
  private readonly aiClient = createAiClient('email');

  constructor(
    private prisma: PrismaService,
    @InjectQueue(QUEUES.emailValidate) private emailValidateQueue: Queue,
  ) {
    super();
  }

  private logSafe(
    level: 'log' | 'warn' | 'error' | 'debug',
    eventCode: string,
    fields: Record<string, unknown> = {},
  ) {
    const message = safeLogEvent(eventCode, fields);
    if (level === 'error') this.logger.error(message);
    else if (level === 'warn') this.logger.warn(message);
    else if (level === 'debug') this.logger.debug(message);
    else this.logger.log(message);
  }

  private safeRef(value: unknown, domain: string) {
    return safeDigest(value, domain);
  }

  async process(job: Job<ComposeJob>): Promise<any> {
    const { emailMessageId, productName, customVariables, sendDelayMs } = job.data;
    const msg = await this.prisma.emailMessage.findUnique({
      where: { id: emailMessageId },
      include: {
        lead: true,
        emailAccount: true,
        company: true,
        senderUser: true,
      },
    });

    if (!msg || msg.deletedAt) return { success: false, reason: 'Email message not found' };
    if (msg.status === 'Sent') return { success: true, reason: 'Already sent' };

    const drafting = await this.prisma.emailMessage.updateMany({
      where: { id: msg.id, deletedAt: null },
      data: { status: 'Drafting', failedReason: null, errorMessage: null },
    });
    if (drafting.count === 0) {
      return { success: false, reason: 'Email message disappeared before drafting' };
    }

    try {
      const template = msg.templateId
        ? await this.prisma.emailTemplate.findUnique({
            where: { id: msg.templateId },
            include: { variables: true },
          })
        : null;
      const rendered = await this.generateDraft(msg, template, productName, customVariables);
      const trackingId = msg.trackingId || uuidv4();
      const unsubscribeToken = msg.unsubscribeToken || uuidv4();
      this.logSafe('log', 'email.compose.body_rendered', {
        eventType: 'body_rendered',
        bytes: rendered.body.length,
        stage: 'projection',
      });
      const bodyWithTracking = this.prepareForDelivery(`${AI_DRAFT_MARKER}\n${rendered.body}`, trackingId, unsubscribeToken);
      this.logSafe('log', 'email.compose.delivery_body_prepared', {
        eventType: 'delivery_body_prepared',
        bytes: bodyWithTracking.length,
        stage: 'dispatch',
      });

      const saved = await this.prisma.emailMessage.updateMany({
        where: { id: msg.id, deletedAt: null },
        data: {
          subject: rendered.subject,
          bodyHtml: bodyWithTracking,
          renderedBody: bodyWithTracking,
          trackingId,
          unsubscribeToken,
          status: 'DraftReady',
          failedReason: null,
          errorMessage: null,
        },
      });
      if (saved.count === 0) {
        return { success: false, reason: 'Email message disappeared before saving draft' };
      }

      await this.emailValidateQueue.add(
        'validate-email',
        { emailMessageId: msg.id, aiPersonalize: true, sendDelayMs: sendDelayMs || 0 },
        {
          attempts: 3,
          backoff: { type: 'exponential', delay: 10000 },
          removeOnComplete: 100,
          removeOnFail: 100,
        },
      );

      return { success: true, emailMessageId: msg.id };
    } catch (error: any) {
      const retryCount = msg.retryCount + 1;
      const finalFailure = retryCount >= msg.maxRetries;
      await this.prisma.emailMessage.updateMany({
        where: { id: msg.id, deletedAt: null },
        data: {
          retryCount,
          status: finalFailure ? 'DraftFailed' : 'DraftPending',
          failedAt: finalFailure ? new Date() : null,
          failedReason: 'AI draft generation failed',
          errorMessage: 'AI draft generation failed',
        },
      });
      this.logSafe('warn', 'email.compose.draft_failed', {
        eventType: 'draft_failed',
        messageRef: this.safeRef(msg.id, 'email-message'),
        errorCategory: safeErrorCategory(error),
        stage: 'projection',
      });
      throw error;
    }
  }

  private async generateDraft(
    msg: any,
    template: any,
    productName?: string,
    customVariables?: Record<string, string>,
  ): Promise<{ subject: string; body: string }> {
    const [history, materials] = await Promise.all([
      this.prisma.emailMessage.findMany({
        where: { leadId: msg.leadId, deletedAt: null, id: { not: msg.id } },
        select: { subject: true, status: true, sentAt: true, createdAt: true, openedAt: true, clickedAt: true },
        orderBy: { createdAt: 'desc' },
        take: 5,
      }),
      this.prisma.product.findMany({
        where: { companyId: msg.companyId, isActive: true },
        include: { category: { select: { name: true } } },
        orderBy: { updatedAt: 'desc' },
        take: 8,
      }),
    ]);

    const companyName = resolveEmailCompanyName(msg.company?.name);
    const companyWebsite = resolveEmailCompanyWebsite(msg.company?.website);
    const senderName = msg.emailAccount?.senderName || msg.senderUser?.firstName || `${companyName} Team`;
    const companySettings = (msg.company?.settings as any) || {};
    const productFocus =
      companySettings.defaultProductFocus ||
      companySettings.productFocus ||
      companySettings.mainProducts ||
      template?.productCategory ||
      'custom B2B supply solutions';
    const defaultCta =
      companySettings.defaultEmailCta ||
      `ask whether they are evaluating ${productFocus}, want a catalog, or need sample/quote options`;
    const prompt = `
Write one personalized B2B cold outreach email for ${companyName}.

Strict rules:
- Return only valid JSON with keys: subject, bodyText, bodyHtml.
- Use English only.
- Use old-email-safe HTML: table layout or simple inline styled HTML, no scripts, no external CSS.
- Do not invent customer facts. If a fact is unknown, avoid mentioning it.
- Do not invent ${companyName} facts. Do not include any physical address, office address, phone number, fax number, registration number, or legal entity unless it is explicitly present in Our company facts or Sender.
- Do not write "New York", "Los Angeles", "California", "United States", "USA office", "123 Main Street", or any similar address/footer detail.
- Must mention ${companyWebsite} naturally.
- Must not include markdown fences, raw JSON in bodyHtml, or template variables like {{company_name}}.
- Keep it concise and practical: 120-220 words.
- The CTA should ${defaultCta}.
- Do not include unsubscribe text; the system adds that.
- Do not include a fake phone number.
- Do not include a signature block. The selected template handles sender name and company website.

Our company facts:
${JSON.stringify({
  name: companyName,
  website: companyWebsite,
  description: msg.company?.description,
  settings: companySettings,
}, null, 2)}

Sender:
${JSON.stringify({
  name: senderName,
  email: msg.emailAccount?.senderEmail,
  company: msg.emailAccount?.senderCompany || companyName,
}, null, 2)}

Customer:
${JSON.stringify({
  companyName: msg.lead?.companyName,
  contactName: msg.lead?.contactName,
  contactEmail: msg.lead?.contactEmail,
  country: msg.lead?.country,
  website: msg.lead?.website,
  productCategory: msg.lead?.productCategory,
  businessType: msg.lead?.businessType,
  mainProducts: msg.lead?.mainProducts,
  leadGrade: msg.lead?.leadGrade,
  leadScore: msg.lead?.leadScore,
  notes: msg.lead?.notes,
}, null, 2)}

Template reference:
${JSON.stringify({
  subject: msg.subject,
  body: msg.bodyHtml,
  category: template?.category,
  productCategory: template?.productCategory,
}, null, 2)}

Available materials:
${JSON.stringify(materials.map((m) => ({
  name: m.name,
  sku: m.sku,
  category: m.category?.name,
  description: m.description,
  attributes: m.attributes,
})), null, 2)}

Previous email history:
${JSON.stringify(history, null, 2)}

Selected product focus: ${productName || 'choose based on the customer profile'}
Custom variables: ${JSON.stringify(customVariables || {}, null, 2)}
`;

    const response = await this.aiClient.chat.completions.create({
      model: getAiModel('email'),
      messages: [
        { role: 'system', content: 'You write safe, specific, concise B2B cold emails and output strict JSON only.' },
        { role: 'user', content: prompt },
      ],
      temperature: 0.35,
      max_tokens: 1800,
    });

    const content = response.choices[0]?.message?.content || '';
    this.logSafe('log', 'email.compose.ai_response_received', {
      eventType: 'ai_response_received',
      bytes: content.length,
      stage: 'projection',
    });
    const parsed = this.parseJsonDraft(content);
    this.logSafe('log', 'email.compose.ai_response_parsed', {
      eventType: 'ai_response_parsed',
      bytes: String(parsed.bodyHtml || '').length,
      count: String(parsed.bodyText || '').length,
      stage: 'projection',
    });
    const subject = String(parsed.subject || `Cooperation options for ${msg.lead?.companyName || 'your team'}`)
      .replace(/\{\{[a-zA-Z0-9_]+\}\}/g, '')
      .slice(0, 120)
      .trim();
    const bodyText = String(parsed.bodyText || '');
    const bodyHtml = String(parsed.bodyHtml || '');
    const effectiveBodyText = this.resolveAiBodyText(bodyText, bodyHtml, msg.lead, productName);
    this.logSafe('log', 'email.compose.draft_normalized', {
      eventType: 'draft_normalized',
      bytes: bodyHtml.length,
      count: bodyText.length,
      stage: 'projection',
    });

    const normalized = this.cleanAiBodyFragment(this.normalizeEmailHtml(bodyHtml, effectiveBodyText), effectiveBodyText);
    this.logSafe('log', 'email.compose.body_cleaned', {
      eventType: 'body_cleaned',
      bytes: normalized.length,
      stage: 'projection',
    });

    const templateBody = template?.body || msg.bodyHtml;
    const withTemplate = this.applyAiTemplate(templateBody, normalized, effectiveBodyText, senderName, companyName, companyWebsite);
    this.logSafe('log', 'email.compose.template_applied', {
      eventType: 'template_applied',
      bytes: withTemplate.length,
      stage: 'projection',
    });

    const templated = this.finalizeComposedBody(withTemplate);
    this.logSafe('log', 'email.compose.body_finalized', {
      eventType: 'body_finalized',
      bytes: templated.length,
      stage: 'projection',
    });

    return { subject, body: ensureCompanyWebsite(templated, companyWebsite, companyWebsite.replace(/^https?:\/\//i, '')) };
  }

  private resolveAiBodyText(bodyText: string, bodyHtml: string, lead: any, productName?: string) {
    const direct = this.normalizePlainText(bodyText);
    if (this.isUsableAiBodyText(direct)) return direct;

    const visible = this.normalizePlainText(this.extractVisibleText(bodyHtml));
    if (this.isUsableAiBodyText(visible)) return visible;

    const company = lead?.companyName || 'your team';
    const category = productName || lead?.productCategory || lead?.mainProducts || 'custom B2B supply solutions';
    const opening = lead?.businessType || lead?.industry
      ? `I noticed ${company} is active in ${lead.businessType || lead.industry}.`
      : `I noticed ${company} may be a good fit for a practical supplier program.`;
    return [
      `Hi ${lead?.contactName || 'there'},`,
      `${opening} I wanted to introduce our team as a practical supplier for ${category}.`,
      'We support customized recommendations, suitable product matching, sampling, and long-term supply support so buyers can test cooperation with a controlled first step.',
      'If you are evaluating suppliers, would it be useful for me to send a short catalog and sample or quote options for your review?',
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
    if (/<!doctype|<html|<table|<img|https:\/\/\/|logo\.png|Unsubscribe/i.test(value)) return false;
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

  private prepareForDelivery(bodyHtml: string, trackingId: string, unsubscribeToken: string) {
    const normalizedBody = this.cleanupTemplateVariablesBeforeDelivery(bodyHtml);
    const tracked = this.replaceLinksWithTracking(this.injectTrackingPixel(normalizedBody, trackingId), trackingId);
    return this.appendUnsubscribeLink(tracked, unsubscribeToken);
  }

  private cleanupTemplateVariablesBeforeDelivery(bodyHtml: string) {
    return (bodyHtml || '')
      .replace(/\{\{unsubscribe_url\}\}/g, '{{unsubscribe_link}}')
      .replace(/<tr\b[^>]*>\s*<td\b[^>]*>\s*\{\{whatsapp_cta_html\}\}\s*<\/td>\s*<\/tr>/gi, '')
      .replace(/<p\b[^>]*>\s*\{\{whatsapp_cta_html\}\}\s*<\/p>/gi, '')
      .replace(/\{\{whatsapp_cta_html\}\}/g, '')
      .replace(/\{\{whatsapp_url\}\}/g, '')
      .replace(/\{\{contact_name\}\}/g, '')
      .replace(/\{\{company_name\}\}/g, '')
      .replace(/\{\{country\}\}/g, '')
      .replace(/\{\{product_name\}\}/g, '')
      .replace(/\{\{pain_point\}\}/g, '')
      .replace(/\{\{last_email_date\}\}/g, '');
  }

  private injectTrackingPixel(bodyHtml: string, trackingId: string): string {
    return injectPublicTrackingPixel(bodyHtml, trackingId);
  }

  private replaceLinksWithTracking(bodyHtml: string, trackingId: string): string {
    return replaceLinksWithPublicTracking(bodyHtml, trackingId);
  }

  private appendUnsubscribeLink(bodyHtml: string, token: string): string {
    return appendPublicUnsubscribe(bodyHtml, token);
  }

  private applyAiTemplate(templateBody: string | undefined, aiHtml: string, bodyText: string, senderName: string, companyName: string, companyWebsite: string) {
    if (!templateBody || !templateBody.includes('{{ai_body_html}}')) return aiHtml;
    return replaceLegacyEmailBrandReferences(templateBody)
      .replace(/\{\{ai_body_html\}\}/g, this.cleanAiBodyFragment(this.extractEmailFragment(aiHtml, bodyText), bodyText))
      .replace(/\{\{sender_name\}\}/g, this.escapeHtml(senderName))
      .replace(/\{\{sender_company\}\}/g, this.escapeHtml(companyName))
      .replace(/\{\{sender_website\}\}/g, this.escapeHtml(companyWebsite))
      .replace(/\{\{website\}\}/g, this.escapeHtml(companyWebsite))
      .replace(/<tr\b[^>]*>\s*<td\b[^>]*>\s*\{\{whatsapp_cta_html\}\}\s*<\/td>\s*<\/tr>/gi, '')
      .replace(/<p\b[^>]*>\s*\{\{whatsapp_cta_html\}\}\s*<\/p>/gi, '')
      .replace(/\{\{whatsapp_cta_html\}\}/g, '')
      .replace(/\{\{whatsapp_url\}\}/g, '')
      .replace(/\{\{contact_name\}\}/g, '')
      .replace(/\{\{company_name\}\}/g, '')
      .replace(/\{\{country\}\}/g, '')
      .replace(/\{\{product_name\}\}/g, '')
      .replace(/\{\{pain_point\}\}/g, '')
      .replace(/\{\{last_email_date\}\}/g, '')
      .replace(/\{\{unsubscribe_url\}\}/g, '{{unsubscribe_link}}');
  }

  private extractEmailFragment(aiHtml: string, bodyText: string) {
    if (this.shouldPreferBodyText(aiHtml, bodyText)) {
      return this.bodyTextToHtml(bodyText);
    }
    const bodyMatch = aiHtml.match(/<body[^>]*>([\s\S]*?)<\/body>/i);
    if (bodyMatch?.[1]) return bodyMatch[1].trim();
    const tdMatch = aiHtml.match(/<td[^>]*>([\s\S]*?)<\/td>/i);
    if (tdMatch?.[1]) return tdMatch[1].trim();
    if (/<p[\s>]/i.test(aiHtml) || /<table[\s>]/i.test(aiHtml) || /<ul[\s>]/i.test(aiHtml)) return aiHtml;
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
      .replace(SIGNATURE_PATTERN, '')
      .replace(/<tr\b[^>]*>\s*<td\b[^>]*>\s*<\/td>\s*<\/tr>/gi, '')
      .replace(/<p\b[^>]*>\s*<\/p>/gi, '')
      .trim();

    if (!/<p[\s>]|<ul[\s>]|<ol[\s>]|<table[\s>]|<div[\s>]/i.test(fragment)) {
      fragment = `<p style="margin:0 0 14px 0;line-height:1.55;color:#111827;font-size:14px;">${this.escapeHtml(fragment).replace(/\n/g, '<br>')}</p>`;
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
      .replace(/<p\b[^>]*>\s*<\/p>/gi, '')
      .replace(/<tr\b[^>]*>\s*<td\b[^>]*>\s*<\/td>\s*<\/tr>/gi, '');
  }

  private parseJsonDraft(content: string): any {
    const clean = content.replace(/```json\s*/gi, '').replace(/```\s*/g, '').trim();
    try {
      return JSON.parse(clean);
    } catch {
      const match = clean.match(/\{[\s\S]*\}/);
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
    if (/<table[\s>]/i.test(cleanHtml) || /<p[\s>]/i.test(cleanHtml)) return cleanHtml;

    const text = this.escapeHtml(bodyText || cleanHtml.replace(/<[^>]*>/g, ''));
    const paragraphs = text
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
}
