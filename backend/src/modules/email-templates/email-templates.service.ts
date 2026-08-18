import {
  Injectable,
  NotFoundException,
  ForbiddenException,
  BadRequestException,
} from '@nestjs/common';
import OpenAI from 'openai';
import { PrismaService } from '../../common/prisma/prisma.service';
import { CreateEmailTemplateDto } from './dto/create-email-template.dto';
import { UpdateEmailTemplateDto } from './dto/update-email-template.dto';
import {
  findLegacyEmailBrandReference,
  replaceLegacyEmailBrandReferences,
  resolveEmailCompanyName,
  resolveEmailCompanyWebsite,
} from '../emails/email-content.guard';
import {
  hasFullAccess,
  requireActiveCompany,
} from '../../common/utils/data-isolation';

const DEFAULT_COMPANY_WEBSITE = 'https://vaysen.com';

const DEFAULT_VARIABLES = [
  { variable: '{{contact_name}}', label: 'Contact Name', isRequired: false },
  { variable: '{{company_name}}', label: 'Company Name', isRequired: true },
  { variable: '{{country}}', label: 'Country', isRequired: false },
  { variable: '{{product_name}}', label: 'Product Name', isRequired: false },
  { variable: '{{sender_name}}', label: 'Sender Name', isRequired: true },
  { variable: '{{sender_company}}', label: 'Sender Company', isRequired: true },
  { variable: '{{website}}', label: 'Website', isRequired: false },
  { variable: '{{sender_website}}', label: 'Company Website', isRequired: true },
  { variable: '{{ai_body_html}}', label: 'AI customer-specific email body HTML', isRequired: true },
  { variable: '{{whatsapp_url}}', label: 'Optional WhatsApp URL', isRequired: false },
  { variable: '{{whatsapp_cta_html}}', label: 'Optional WhatsApp CTA HTML', isRequired: false },
  { variable: '{{pain_point}}', label: 'Pain Point', isRequired: false },
  { variable: '{{last_email_date}}', label: 'Last Email Date', isRequired: false },
  { variable: '{{unsubscribe_link}}', label: 'System unsubscribe link', isRequired: false },
];

@Injectable()
export class EmailTemplatesService {
  private aiClient?: OpenAI;

  constructor(private prisma: PrismaService) {
    const apiKey = process.env.ZHIPU_API_KEY || process.env.OPENAI_API_KEY;
    if (apiKey) {
      this.aiClient = new OpenAI({
        apiKey,
        baseURL: process.env.ZHIPU_BASE_URL || process.env.OPENAI_BASE_URL || 'https://open.bigmodel.cn/api/paas/v4',
      });
    }
  }

  async findAll(
    currentUser: any,
    query: {
      page?: number;
      limit?: number;
      category?: string;
      language?: string;
      productCategory?: string;
      isActive?: boolean;
      search?: string;
    },
  ) {
    const page = query.page || 1;
    const limit = query.limit || 20;
    const skip = (page - 1) * limit;

    const where: any = this.buildCompanyWhere(currentUser);

    if (query.category) where.category = query.category;
    if (query.language) where.language = query.language;
    if (query.productCategory) where.productCategory = query.productCategory;
    if (query.isActive !== undefined) where.isActive = query.isActive;

    if (query.search) {
      where.OR = [
        { name: { contains: query.search, mode: 'insensitive' } },
        { subject: { contains: query.search, mode: 'insensitive' } },
      ];
    }

    const [data, total] = await Promise.all([
      this.prisma.emailTemplate.findMany({
        where,
        include: { variables: { select: { variable: true, label: true, isRequired: true } } },
        skip,
        take: limit,
        orderBy: { updatedAt: 'desc' },
      }),
      this.prisma.emailTemplate.count({ where }),
    ]);

    return { data, meta: { page, limit, total, totalPages: Math.ceil(total / limit) } };
  }

  async findOne(id: string, currentUser: any) {
    const template = await this.prisma.emailTemplate.findUnique({
      where: { id },
      include: { variables: { select: { variable: true, label: true, isRequired: true } } },
    });
    if (!template) throw new NotFoundException('Email template not found');
    this.checkCompanyAccess(currentUser, template);
    return template;
  }

  async create(dto: CreateEmailTemplateDto, currentUser: any) {
    const company = this.getCompany(currentUser);
    this.checkWriteAccess(currentUser, company.id);
    const companyWebsite = this.companyWebsite(company);
    this.assertNoRetiredBranding(dto.subject, dto.body);
    const body = this.sanitizeTemplateHtml(this.normalizeOptionalTemplateBlocks(this.ensureMandatoryWebsite(dto.body, companyWebsite, this.websiteDisplay(companyWebsite))));

    const template = await this.prisma.emailTemplate.create({
      data: {
        companyId: company.id,
        createdBy: currentUser.id,
        name: dto.name,
        category: dto.category,
        subject: dto.subject,
        body,
        language: dto.language || 'en',
        productCategory: dto.productCategory,
        isActive: dto.isActive ?? true,
        variables: dto.variables?.length
          ? {
              create: dto.variables.map((v) => ({
                variable: v.variable,
                label: v.label,
                isRequired: v.isRequired ?? false,
              })),
            }
          : undefined,
      },
      include: { variables: { select: { variable: true, label: true, isRequired: true } } },
    });

    await this.prisma.auditLog.create({
      data: {
        companyId: company.id,
        userId: currentUser.id,
        action: 'create_email_template',
        entityType: 'EmailTemplate',
        entityId: template.id,
        newValue: { name: dto.name, category: dto.category },
      },
    });

    return template;
  }

  async generateAiTemplate(
    dto: {
      holiday?: string;
      market?: string;
      style?: string;
      colorTheme?: string;
      layout?: string;
      description?: string;
      category?: string;
      productCategory?: string;
      whatsapp?: string;
    },
    currentUser: any,
  ) {
    if (!this.aiClient) {
      throw new BadRequestException('Zhipu API key is not configured');
    }

    const company = this.getCompany(currentUser);
    this.checkWriteAccess(currentUser, company.id);
    const companyName = resolveEmailCompanyName(company.name);

    const senderName = [currentUser.firstName, currentUser.lastName].filter(Boolean).join(' ') || currentUser.email?.split('@')[0] || 'Chris';
    const savedWhatsapp = await this.getUserSetting(company.id, this.whatsappKey(currentUser.id));
    const whatsapp = dto.whatsapp || savedWhatsapp || '';
    const whatsappUrl = this.buildWhatsAppUrl(whatsapp);
    const category = dto.holiday && dto.holiday !== 'None' ? 'Holiday Greeting' : (dto.category || 'First Outreach');
    const companyWebsite = this.companyWebsite(company);
    const websiteDisplay = this.websiteDisplay(companyWebsite);
    const productCategory =
      dto.productCategory ||
      (company.settings as any)?.defaultProductFocus ||
      (company.settings as any)?.productFocus ||
      'Custom Packaging';
    const companySettings = (company.settings as any) || {};

    const prompt = `
You are designing a reusable B2B HTML email template shell for ${companyName}, a custom packaging supplier.

CRITICAL — Template Description Reference:
The user has provided a description of what they want the template to look like. You MUST follow this description closely.
It is the PRIMARY design reference. Match its requested style, colors, sections, layout, and tone exactly.

Important:
- Generate a TEMPLATE SHELL only. Do not write the customer-specific sales copy.
- The actual email copy will be generated later and inserted into {{ai_body_html}}.
- The template must force include ${companyWebsite} / ${websiteDisplay}.
- The sender name in visible signature must be {{sender_name}} and should represent the logged-in salesperson: ${senderName}.
- If a WhatsApp CTA is available, include {{whatsapp_cta_html}} as an optional block. If not, keep the layout clean without an empty button.
- Do not include any physical address, US address, office address, phone number, fax number, legal registration number, or invented contact detail.
- Do not write "New York", "Los Angeles", "California", "United States", "USA office", "123 Main Street", or any similar footer/address detail.
- The footer may contain only: {{sender_name}}, {{sender_company}}, ${websiteDisplay}, optional WhatsApp CTA, and {{unsubscribe_link}} if an unsubscribe placeholder is needed.
- Use {{unsubscribe_link}} only. Never use {{unsubscribe_url}} or any other unsubscribe variable name.
- Use old-email-safe HTML: table layout, inline CSS, no script, no external CSS, no web fonts, no background images.
- Keep width around 600px and compatible with Gmail, Outlook and older mail clients.
- Use English placeholder labels only where a placeholder is needed. No Chinese in the outbound email template.
- The template body must contain exactly one main copy placeholder: {{ai_body_html}}.
- Do not expose JSON, markdown fences, or comments in the HTML.

Company facts:
${JSON.stringify({
  name: companyName,
  website: companyWebsite,
  description: company.description,
  settings: companySettings,
}, null, 2)}

Template options:
${JSON.stringify({
  holiday: dto.holiday || 'None',
  market: dto.market || 'USA',
  style: dto.style || 'Professional B2B',
  colorTheme: dto.colorTheme || 'Clean Blue',
  layout: dto.layout || 'Text Only',
  category,
  productCategory,
  description: dto.description || '',
  hasWhatsapp: !!whatsappUrl,
}, null, 2)}

Return strict JSON only:
{
  "name": "template name",
  "category": "${category}",
  "language": "en",
  "productCategory": "${productCategory}",
  "subject": "subject with {{company_name}}",
  "body": "complete HTML document or email-safe HTML fragment",
  "variables": [
    {"variable":"{{ai_body_html}}","label":"AI customer-specific email body HTML","isRequired":true}
  ]
}`;

    const response = await this.aiClient.chat.completions.create({
      model: process.env.ZHIPU_MODEL || 'glm-4-flash-250414',
      messages: [
        {
          role: 'system',
          content: 'You create email-safe B2B HTML templates and return strict JSON only.',
        },
        { role: 'user', content: prompt },
      ],
      temperature: 0.35,
      max_tokens: 3000,
    });

    const parsed = this.parseJsonObject(response.choices[0]?.message?.content || '{}');
    const fallback = this.buildFallbackAiTemplate({
      ...dto,
      category,
      productCategory,
      senderName,
      whatsappUrl,
      companyName,
      companyWebsite,
      websiteDisplay,
    });

    let body = this.ensureMandatoryWebsite(
      typeof parsed.body === 'string'
        && parsed.body.includes('{{ai_body_html}}')
        && !findLegacyEmailBrandReference(parsed.body)
        ? parsed.body
        : fallback.body,
      companyWebsite,
      websiteDisplay,
    );

    // Inject WhatsApp CTA if user provided a number
    if (whatsappUrl) {
      const waBlock = `<tr><td style="padding:0 24px 22px 24px;"><a href="${whatsappUrl}" style="display:inline-block;background:#16a34a;color:#ffffff;text-decoration:none;border-radius:4px;padding:10px 14px;font-size:13px;font-weight:700;">💬 WhatsApp ${senderName}</a></td></tr>`;
      body = body.replace(/\{\{whatsapp_cta_html\}\}/g, waBlock);
      body = body.replace(/<tr>\s*<td[^>]*>\s*\{\{whatsapp_cta_html\}\}\s*<\/td>\s*<\/tr>/gi, waBlock);
    }

    body = this.sanitizeTemplateHtml(this.normalizeOptionalTemplateBlocks(body, { whatsappUrl, senderName }));

    return {
      name: String(parsed.name || fallback.name).slice(0, 160),
      category: String(parsed.category || category),
      language: String(parsed.language || 'en'),
      productCategory: String(parsed.productCategory || productCategory),
      subject: String(
        typeof parsed.subject === 'string' && !findLegacyEmailBrandReference(parsed.subject)
          ? parsed.subject
          : fallback.subject,
      ).slice(0, 160),
      body,
      variables: this.mergeDefaultVariables(Array.isArray(parsed.variables) ? parsed.variables : []),
    };
  }

  async update(id: string, dto: UpdateEmailTemplateDto, currentUser: any) {
    const existing = await this.prisma.emailTemplate.findFirst({
      where: { id, companyId: requireActiveCompany(currentUser).id },
    });
    if (!existing) throw new NotFoundException('Email template not found');
    this.checkCompanyAccess(currentUser, existing);
    this.checkWriteAccess(currentUser, existing.companyId);

    const data: any = {};
    const company = currentUser.companies?.find((entry: any) => entry.id === existing.companyId);
    const companyWebsite = this.companyWebsite(company);
    this.assertNoRetiredBranding(dto.subject ?? existing.subject, dto.body ?? existing.body);
    if (dto.name !== undefined) data.name = dto.name;
    if (dto.category !== undefined) data.category = dto.category;
    if (dto.subject !== undefined) data.subject = dto.subject;
    if (dto.body !== undefined) {
      data.body = this.sanitizeTemplateHtml(
        this.normalizeOptionalTemplateBlocks(
          this.ensureMandatoryWebsite(dto.body, companyWebsite, this.websiteDisplay(companyWebsite)),
        ),
      );
    }
    if (dto.language !== undefined) data.language = dto.language;
    if (dto.productCategory !== undefined) data.productCategory = dto.productCategory;
    if (dto.isActive !== undefined) data.isActive = dto.isActive;

    // Update variables: delete existing, create new
    if (dto.variables !== undefined) {
      await this.prisma.emailTemplateVariable.deleteMany({ where: { templateId: id } });

      if (dto.variables.length > 0) {
        data.variables = {
          create: dto.variables.map((v) => ({
            variable: v.variable,
            label: v.label,
            isRequired: v.isRequired ?? false,
          })),
        };
      }
    }

    const template = await this.prisma.emailTemplate.update({
      where: { id },
      data,
      include: { variables: { select: { variable: true, label: true, isRequired: true } } },
    });

    await this.prisma.auditLog.create({
      data: {
        companyId: existing.companyId,
        userId: currentUser.id,
        action: 'update_email_template',
        entityType: 'EmailTemplate',
        entityId: template.id,
        newValue: { name: template.name },
      },
    });

    return template;
  }

  async remove(id: string, currentUser: any) {
    const existing = await this.prisma.emailTemplate.findFirst({
      where: { id, companyId: requireActiveCompany(currentUser).id },
    });
    if (!existing) throw new NotFoundException('Email template not found');
    this.checkCompanyAccess(currentUser, existing);
    this.checkWriteAccess(currentUser, existing.companyId);

    // Hard delete
    const template = await this.prisma.emailTemplate.delete({
      where: { id },
      include: { variables: { select: { variable: true, label: true, isRequired: true } } },
    });

    await this.prisma.auditLog.create({
      data: {
        companyId: existing.companyId,
        userId: currentUser.id,
        action: 'delete_email_template',
        entityType: 'EmailTemplate',
        entityId: id,
        oldValue: { name: existing.name },
      },
    });

    return template;
  }

  async updateStatus(id: string, isActive: boolean, currentUser: any) {
    const existing = await this.prisma.emailTemplate.findFirst({
      where: { id, companyId: requireActiveCompany(currentUser).id },
    });
    if (!existing) throw new NotFoundException('Email template not found');
    this.checkCompanyAccess(currentUser, existing);
    this.checkWriteAccess(currentUser, existing.companyId);

    const template = await this.prisma.emailTemplate.update({
      where: { id },
      data: { isActive },
      include: { variables: { select: { variable: true, label: true, isRequired: true } } },
    });

    await this.prisma.auditLog.create({
      data: {
        companyId: existing.companyId,
        userId: currentUser.id,
        action: 'update_email_template_status',
        entityType: 'EmailTemplate',
        entityId: id,
        oldValue: { isActive: existing.isActive },
        newValue: { isActive },
      },
    });

    return template;
  }

  async preview(id: string, variables: Record<string, string>, currentUser: any) {
    const template = await this.prisma.emailTemplate.findUnique({
      where: { id },
      include: { variables: true },
    });
    if (!template) throw new NotFoundException('Email template not found');
    this.checkCompanyAccess(currentUser, template);

    let subject = replaceLegacyEmailBrandReferences(template.subject);
    let body = this.normalizeOptionalTemplateBlocks(replaceLegacyEmailBrandReferences(template.body), {
      whatsappUrl: variables.whatsapp_url,
      senderName: variables.sender_name,
    });

    for (const [key, value] of Object.entries(variables)) {
      const pattern = new RegExp(`\\{\\{${key}\\}\\}`, 'g');
      subject = subject.replace(pattern, value || `{{${key}}}`);
      body = body.replace(pattern, value || `{{${key}}}`);
    }

    return {
      templateId: id,
      templateName: template.name,
      originalSubject: template.subject,
      originalBody: template.body,
      renderedSubject: subject,
      renderedBody: body,
      variablesUsed: template.variables.map((v) => v.variable),
      defaultVariables: DEFAULT_VARIABLES,
    };
  }

  private buildFallbackAiTemplate(options: {
    holiday?: string;
    market?: string;
    style?: string;
    colorTheme?: string;
    layout?: string;
    category: string;
    productCategory: string;
    senderName: string;
    whatsappUrl?: string;
    companyName?: string;
    companyWebsite?: string;
    websiteDisplay?: string;
  }) {
    const theme = this.resolveTheme(options.colorTheme);
    const name = `${options.category} - ${options.market || 'Global'} ${options.productCategory} - ${options.style || 'Professional B2B'}`;
    const companyName = options.companyName || 'Vaysen Packaging';
    const companyWebsite = options.companyWebsite || DEFAULT_COMPANY_WEBSITE;
    const websiteDisplay = options.websiteDisplay || this.websiteDisplay(companyWebsite);
    const whatsappBlock = options.whatsappUrl
      ? `<tr><td style="padding:0 24px 22px 24px;"><a href="${options.whatsappUrl}" style="display:inline-block;background:#16a34a;color:#ffffff;text-decoration:none;border-radius:4px;padding:10px 14px;font-size:13px;font-weight:700;">💬 WhatsApp ${options.senderName || 'Contact Us'}</a></td></tr>`
      : '';

    const body = `<!doctype html>
<html>
  <body style="margin:0;padding:0;background:${theme.bg};font-family:Arial,Helvetica,sans-serif;color:#111827;">
    <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="width:100%;background:${theme.bg};margin:0;padding:24px 0;">
      <tr>
        <td align="center" style="padding:0 12px;">
          <table role="presentation" width="600" cellspacing="0" cellpadding="0" border="0" style="width:600px;max-width:100%;background:#ffffff;border:1px solid #e5e7eb;">
            <tr>
              <td style="padding:18px 24px;background:${theme.primary};font-family:Arial,Helvetica,sans-serif;color:#ffffff;">
                <div style="font-size:13px;line-height:18px;">${this.escapeHtml(companyName)} B2B Supply Solution</div>
                <div style="font-size:20px;line-height:28px;font-weight:700;margin-top:4px;">{{company_name}}</div>
              </td>
            </tr>
            <tr>
              <td style="padding:24px;font-family:Arial,Helvetica,sans-serif;font-size:14px;line-height:22px;color:#1f2937;">
                {{ai_body_html}}
              </td>
            </tr>
            <tr>
              <td style="padding:0 24px 20px 24px;">
                <a href="${companyWebsite}" style="display:inline-block;background:${theme.primary};color:#ffffff;text-decoration:none;border-radius:4px;padding:11px 16px;font-size:14px;font-weight:700;">${websiteDisplay}</a>
              </td>
            </tr>
            ${whatsappBlock}
            <tr>
              <td style="padding:16px 24px;border-top:1px solid #e5e7eb;background:#f9fafb;font-family:Arial,Helvetica,sans-serif;font-size:13px;line-height:20px;color:#374151;">
                Best regards,<br>{{sender_name}}<br>{{sender_company}}<br>
                <a href="${companyWebsite}" style="color:${theme.primary};text-decoration:underline;">${websiteDisplay}</a>
              </td>
            </tr>
          </table>
        </td>
      </tr>
    </table>
  </body>
</html>`;

    return {
      name,
      subject: `Cooperation Opportunity - {{company_name}}`,
      body,
    };
  }

  private resolveTheme(colorTheme?: string) {
    const themes: Record<string, { primary: string; bg: string }> = {
      'Clean Blue': { primary: '#1d4ed8', bg: '#f8fafc' },
      'Premium Black': { primary: '#111827', bg: '#f9fafb' },
      'Outdoor Green': { primary: '#166534', bg: '#f7fee7' },
      'Warm Gold': { primary: '#92400e', bg: '#fffbeb' },
      'Retail Red': { primary: '#b91c1c', bg: '#fff7ed' },
    };
    return themes[colorTheme || ''] || themes['Clean Blue'];
  }

  private ensureMandatoryWebsite(body: string, website: string = DEFAULT_COMPANY_WEBSITE, display?: string) {
    const html = body || '';
    const host = this.websiteHost(website);
    if (new RegExp(host.replace(/\./g, '\\.'), 'i').test(html)) return html;
    const websiteBlock = `<p style="margin:16px 0 0 0;font-family:Arial,Helvetica,sans-serif;font-size:13px;line-height:20px;color:#374151;">Website: <a href="${website}" style="color:#1d4ed8;text-decoration:underline;">${display || this.websiteDisplay(website)}</a></p>`;
    if (/<\/body>/i.test(html)) return html.replace(/<\/body>/i, `${websiteBlock}</body>`);
    return `${html}${websiteBlock}`;
  }

  private companyWebsite(company: any) {
    return resolveEmailCompanyWebsite(company?.website);
  }

  private assertNoRetiredBranding(subject: string, body: string) {
    const legacyReference = findLegacyEmailBrandReference(subject, body);
    if (legacyReference) {
      throw new BadRequestException(`Email template contains a retired brand or domain: ${legacyReference}`);
    }
  }

  private websiteHost(website: string) {
    return (website || DEFAULT_COMPANY_WEBSITE)
      .replace(/^https?:\/\//i, '')
      .replace(/^www\./i, '')
      .replace(/\/.*$/, '')
      .toLowerCase();
  }

  private websiteDisplay(website: string) {
    const host = this.websiteHost(website);
    return host.startsWith('www.') ? host : `www.${host}`;
  }

  private normalizeOptionalTemplateBlocks(body: string, options?: { whatsappUrl?: string; senderName?: string }) {
    let html = body || '';
    const whatsappUrl = options?.whatsappUrl?.trim();

    if (whatsappUrl) {
      const senderName = options?.senderName?.trim() || 'Contact Us';
      const waBlock = `<tr><td style="padding:0 24px 22px 24px;"><a href="${this.escapeHtml(whatsappUrl)}" style="display:inline-block;background:#16a34a;color:#ffffff;text-decoration:none;border-radius:4px;padding:10px 14px;font-size:13px;font-weight:700;">WhatsApp ${this.escapeHtml(senderName)}</a></td></tr>`;
      return html
        .replace(/<tr\b[^>]*>\s*<td\b[^>]*>\s*\{\{whatsapp_cta_html\}\}\s*<\/td>\s*<\/tr>/gi, waBlock)
        .replace(/\{\{whatsapp_cta_html\}\}/g, waBlock)
        .replace(/\{\{whatsapp_url\}\}/g, this.escapeHtml(whatsappUrl));
    }

    return html
      .replace(/<tr\b[^>]*>\s*<td\b[^>]*>\s*\{\{whatsapp_cta_html\}\}\s*<\/td>\s*<\/tr>/gi, '')
      .replace(/<p\b[^>]*>\s*\{\{whatsapp_cta_html\}\}\s*<\/p>/gi, '')
      .replace(/\{\{whatsapp_cta_html\}\}/g, '')
      .replace(/\{\{whatsapp_url\}\}/g, '')
      .replace(/\{\{unsubscribe_url\}\}/g, '{{unsubscribe_link}}');
  }

  private sanitizeTemplateHtml(html: string) {
    return (html || '')
      .replace(/(?:\d{1,6}\s+[A-Za-z0-9.'#-]+(?:\s+[A-Za-z0-9.'#-]+){0,6}\s+(?:Street|St\.?|Avenue|Ave\.?|Road|Rd\.?|Boulevard|Blvd\.?|Drive|Dr\.?|Lane|Ln\.?|Way|Suite|Ste\.?|Floor|Fl\.?)[^<\n\r]*)/gi, '')
      .replace(/\b(?:New York|Los Angeles|San Francisco|California|CA\s+\d{5}|United States|USA office|U\.S\. office|US office)\b[^<\n\r]*/gi, '')
      .replace(/\b(?:Tel|Phone|Fax|Mobile)\s*[:：]\s*(?!\+?86)[+\d().\-\s]{6,}/gi, '')
      .replace(/<p\b[^>]*>\s*<\/p>/gi, '')
      .replace(/<tr\b[^>]*>\s*<td\b[^>]*>\s*<\/td>\s*<\/tr>/gi, '');
  }

  private escapeHtml(value: string) {
    return value
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
  }

  private mergeDefaultVariables(input: any[]) {
    const merged = new Map<string, { variable: string; label: string; isRequired: boolean }>();
    for (const entry of DEFAULT_VARIABLES) {
      merged.set(entry.variable, { ...entry });
    }
    for (const raw of input) {
      const variable = typeof raw?.variable === 'string' ? raw.variable.trim() : '';
      if (!variable.startsWith('{{') || !variable.endsWith('}}')) continue;
      merged.set(variable, {
        variable,
        label: typeof raw.label === 'string' ? raw.label : variable,
        isRequired: !!raw.isRequired,
      });
    }
    return Array.from(merged.values());
  }

  private parseJsonObject(content: string): any {
    const clean = content.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
    try {
      const parsed = JSON.parse(clean);
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
    } catch {
      const match = clean.match(/\{[\s\S]*\}/);
      if (!match) return {};
      try {
        const parsed = JSON.parse(match[0]);
        return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
      } catch {
        return {};
      }
    }
  }

  private async getUserSetting(companyId: string, key: string) {
    const setting = await this.prisma.systemSetting.findUnique({
      where: { companyId_key: { companyId, key } },
    });
    return setting?.value || '';
  }

  private whatsappKey(userId: string) {
    return `user.whatsapp.${userId}`;
  }

  private buildWhatsAppUrl(value: string) {
    const digits = (value || '').replace(/[^\d]/g, '');
    if (!digits) return '';
    const text = encodeURIComponent('Hi, I would like to learn more about your products and cooperation options.');
    return `https://api.whatsapp.com/send?phone=${digits}&text=${text}`;
  }

  // ========== Access Control ==========

  private getCompany(currentUser: any) {
    return requireActiveCompany(currentUser);
  }

  private buildCompanyWhere(currentUser: any): any {
    const activeCompany = requireActiveCompany(currentUser);
    const currentCompanyId = activeCompany.id;
    if (!hasFullAccess(currentUser, currentCompanyId)) {
      return { createdBy: currentUser.id, companyId: currentCompanyId };
    }

    return { companyId: currentCompanyId };
  }

  private checkCompanyAccess(currentUser: any, template: any) {
    const activeCompany = requireActiveCompany(currentUser);
    if (activeCompany.id !== template.companyId) {
      throw new ForbiddenException('Cannot access templates from another company');
    }

    const isFullAccess = hasFullAccess(currentUser, template.companyId);
    if (!isFullAccess && template.createdBy && template.createdBy !== currentUser.id) {
      throw new ForbiddenException('You can only access your own email templates');
    }
  }

  private checkWriteAccess(currentUser: any, companyId: string) {
    if (requireActiveCompany(currentUser).id !== companyId) {
      throw new ForbiddenException('Company is outside the active request context');
    }
    if (hasFullAccess(currentUser, companyId)) return;

    const company = currentUser.companies?.find((c: any) => c.id === companyId);
    if (!company) throw new ForbiddenException('Not a member of this company');

    const allowedRoles = ['company_admin', 'sales_manager', 'sales_user'];
    if (!allowedRoles.includes(company.role)) {
      throw new ForbiddenException('Viewer cannot modify email templates');
    }
  }
}
