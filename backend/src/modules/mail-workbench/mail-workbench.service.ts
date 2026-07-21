import { Injectable, NotFoundException, ForbiddenException } from '@nestjs/common';
import { PrismaService } from '../../common/prisma/prisma.service';
import { AiProviderService } from '../../common/ai/ai-provider.service';
import { ensureCompanyAccess } from '../../common/utils/data-isolation';
import { LanguageService, LANGUAGE_NAMES } from '../../common/services/language.service';
import { normalizeLanguage, DEFAULT_FALLBACK_LANGUAGE } from '../../common/utils/language.util';

@Injectable()
export class MailWorkbenchService {
  constructor(
    private prisma: PrismaService,
    private ai: AiProviderService,
    private languageService: LanguageService,
  ) {}

  /** Get mail folder tree with counts */
  async getTree(currentUser: any) {
    const companyIds = (currentUser as any)?.companies?.map((c: any) => c.id) || [];
    if (companyIds.length === 0) return [];
    const [inbox, sent, drafts] = await Promise.all([
      this.prisma.communicationMessage.count({
        where: {
          direction: 'inbound',
          conversation: { companyId: { in: companyIds }, channel: 'business_email' },
        },
      }),
      this.prisma.emailMessage.count({
        where: { companyId: { in: companyIds }, status: { in: ['sent', 'Sent'] } },
      }),
      this.prisma.emailMessage.count({
        where: { companyId: { in: companyIds }, status: { in: ['draft', 'Draft'] } },
      }),
    ]);
    return [
      { id: 'inbox', label: '收件箱', count: inbox },
      { id: 'sent', label: '已发送', count: sent },
      { id: 'drafts', label: '草稿', count: drafts },
      { id: 'starred', label: '星标', count: 0 },
    ];
  }

  /** List messages with grouping and filters */
  async getMessages(currentUser: any, query: {
    page?: number; limit?: number; folder?: string; search?: string;
    customerId?: string; ownerUserId?: string; source?: string; status?: string; q?: string;
  }) {
    const companyIds = (currentUser as any)?.companies?.map((c: any) => c.id) || [];
    if (companyIds.length === 0) return { data: [], meta: { total: 0 } };
    const page = query.page || 1; const limit = query.limit || 20; const skip = (page - 1) * limit;

    if (!query.folder || query.folder === 'inbox') {
      const inboundWhere: any = {
        direction: 'inbound',
        conversation: {
          companyId: { in: companyIds },
          channel: 'business_email',
        },
      };
      const search = query.search || query.q;
      if (search) {
        inboundWhere.OR = [
          { subject: { contains: search, mode: 'insensitive' } },
          { content: { contains: search, mode: 'insensitive' } },
          { fromAddress: { contains: search, mode: 'insensitive' } },
        ];
      }
      if (query.customerId) inboundWhere.conversation.leadId = query.customerId;

      const [messages, total] = await Promise.all([
        this.prisma.communicationMessage.findMany({
          where: inboundWhere,
          skip,
          take: limit,
          orderBy: [{ receivedAt: 'desc' }, { createdAt: 'desc' }],
          include: {
            conversation: {
              include: {
                lead: {
                  select: {
                    id: true,
                    companyName: true,
                    contactName: true,
                    contactEmail: true,
                    country: true,
                    language: true,
                    leadGrade: true,
                  },
                },
              },
            },
          },
        }),
        this.prisma.communicationMessage.count({ where: inboundWhere }),
      ]);

      return {
        data: messages.map((message) => ({
          id: `inbound:${message.id}`,
          subject: message.subject,
          fromEmail: message.fromAddress,
          toEmail: message.toAddress,
          bodyPreview: message.content.slice(0, 160),
          bodyText: message.content,
          status: message.readAt ? 'Read' : 'Received',
          createdAt: message.receivedAt || message.createdAt,
          leadId: message.conversation.leadId,
          lead: message.conversation.lead,
          attachmentsMeta: message.attachmentsMeta,
        })),
        meta: { page, limit, total, totalPages: Math.ceil(total / limit) },
      };
    }

    const where: any = { companyId: { in: companyIds } };
    if (query.folder === 'sent') where.status = { in: ['sent', 'Sent'] };
    else if (query.folder === 'drafts') where.status = { in: ['draft', 'Draft'] };
    else if (query.folder === 'starred') return { data: [], meta: { page, limit, total: 0, totalPages: 0 } };
    if (query.search) where.subject = { contains: query.search, mode: 'insensitive' };
    if (query.status) where.status = query.status;
    if (query.customerId) where.leadId = query.customerId;
    if (query.ownerUserId) where.lead = { assignedUserId: query.ownerUserId };
    if (query.source) where.lead = { ...where.lead, sourceType: query.source };
    if (query.q) {
      where.OR = [
        { subject: { contains: query.q, mode: 'insensitive' } },
        { bodyText: { contains: query.q, mode: 'insensitive' } },
        { toEmail: { contains: query.q, mode: 'insensitive' } },
      ];
    }
    const [data, total] = await Promise.all([
      this.prisma.emailMessage.findMany({ where, skip, take: limit, orderBy: { createdAt: 'desc' },
        select: { id: true, subject: true, toEmail: true, status: true, sentAt: true, createdAt: true, leadId: true } }),
      this.prisma.emailMessage.count({ where }),
    ]);
    return { data, meta: { page, limit, total, totalPages: Math.ceil(total / limit) } };
  }

  /** Get single message with lead info */
  async getMessage(id: string, currentUser: any) {
    if (id.startsWith('inbound:')) {
      const messageId = id.slice('inbound:'.length);
      const inbound = await this.prisma.communicationMessage.findUnique({
        where: { id: messageId },
        include: {
          conversation: {
            include: {
              lead: {
                select: {
                  id: true,
                  companyName: true,
                  contactName: true,
                  contactEmail: true,
                  country: true,
                  language: true,
                  leadGrade: true,
                },
              },
            },
          },
        },
      });
      if (!inbound) throw new NotFoundException('Message not found');
      const companyIds = (currentUser as any)?.companies?.map((c: any) => c.id) || [];
      if (!companyIds.includes(inbound.conversation.companyId)) {
        throw new ForbiddenException('Access denied');
      }
      return {
        id,
        companyId: inbound.conversation.companyId,
        subject: inbound.subject,
        fromEmail: inbound.fromAddress,
        toEmail: inbound.toAddress,
        bodyText: inbound.content,
        bodyHtml: null,
        status: inbound.readAt ? 'Read' : 'Received',
        createdAt: inbound.receivedAt || inbound.createdAt,
        attachmentsMeta: inbound.attachmentsMeta,
        lead: inbound.conversation.lead,
      };
    }

    const msg = await this.prisma.emailMessage.findUnique({ where: { id }, include: { lead: { select: { id: true, companyName: true, contactName: true, country: true, language: true } } } });
    if (!msg) throw new NotFoundException('Message not found');
    const companyIds = (currentUser as any)?.companies?.map((c: any) => c.id) || [];
    if (companyIds.length === 0 || !companyIds.includes(msg.companyId)) throw new ForbiddenException('Access denied');
    return msg;
  }

  /** AI summarize message */
  async summarize(id: string, currentUser: any) {
    const msg = await this.getMessage(id, currentUser);
    const result = await this.ai.chat('Summarize this B2B email in Chinese. Include: customer intent, required action, key details. Under 100 words.', this.getMessageContent(msg, 2000), { task: 'summary' });
    return { summary: result.content, aiEnabled: result.reason === 'success' };
  }

  /** AI translate message — supports 8 languages; default target is 'zh' (for operators) */
  async translate(
    id: string,
    currentUser: any,
    targetLanguage?: string,
    mode?: 'bilingual' | 'target_only' | 'source_only',
    sourceLanguage?: string,
  ) {
    const msg = await this.getMessage(id, currentUser);
    const text = this.getMessageContent(msg, 2000);

    // Default target language: zh (operators read Chinese)
    const targetLang = targetLanguage || 'zh';
    const translateMode = mode || 'target_only';

    // Resolve source language: explicit param > quick regex detection > default 'en'
    let sourceLang = sourceLanguage;
    if (!sourceLang) {
      if (/[\u4e00-\u9fff]/.test(text)) sourceLang = 'zh';
      else if (/[\u3040-\u30ff]/.test(text)) sourceLang = 'ja';
      else if (/[\uac00-\ud7af]/.test(text)) sourceLang = 'ko';
      else sourceLang = 'en';
    }

    const sourceName = LANGUAGE_NAMES[sourceLang] || LANGUAGE_NAMES['en'];
    const targetName = LANGUAGE_NAMES[targetLang] || LANGUAGE_NAMES['zh'];
    const prompt = `Translate from ${sourceName} to ${targetName}. Return ONLY the translation, no explanations.`;

    if (translateMode === 'bilingual') {
      // Split text into paragraphs and translate each
      const paragraphs = text.split(/\n+/).filter((p: string) => p.trim());
      const segments: { source: string; target: string }[] = [];
      for (const para of paragraphs.slice(0, 10)) {
        const result = await this.ai.chat(prompt, para, { task: 'translation' });
        segments.push({ source: para, target: result.content });
      }
      return {
        mode: 'bilingual',
        segments,
        fullSource: text,
        fullTarget: segments.map((s) => s.target).join('\n'),
        sourceLanguage: sourceLang,
        targetLanguage: targetLang,
        aiEnabled: segments.length > 0,
      };
    }

    const result = await this.ai.chat(prompt, text, { task: 'translation' });
    return {
      original: text.substring(0, 500),
      translated: result.content,
      mode: translateMode,
      sourceLanguage: sourceLang,
      targetLanguage: targetLang,
      aiEnabled: result.reason === 'success',
    };
  }

  /** Get summary counts for all folders */
  async getSummary(currentUser: any) {
    const companyIds = (currentUser as any)?.companies?.map((c: any) => c.id) || [];
    if (companyIds.length === 0) return {};
    const where = { companyId: { in: companyIds } };
    const [inbox, sent, drafts, total] = await Promise.all([
      this.prisma.communicationMessage.count({
        where: {
          direction: 'inbound',
          conversation: { companyId: { in: companyIds }, channel: 'business_email' },
        },
      }),
      this.prisma.emailMessage.count({ where: { ...where, status: { in: ['sent', 'Sent'] } } }),
      this.prisma.emailMessage.count({ where: { ...where, status: { in: ['draft', 'Draft'] } } }),
      this.prisma.emailMessage.count({ where }),
    ]);
    return { inbox, sent, drafts, total, unread: 0 };
  }

  /** Generate scenario-based reply draft for specific business context */
  async scenarioDraft(id: string, scenario: string, currentUser: any, targetLanguage?: string) {
    const validScenarios = ['confirm-shipment','payment-reminder','decline-price','supplement-quote','confirm-sample'];
    if (!validScenarios.includes(scenario)) throw new ForbiddenException(`Invalid scenario: ${scenario}`);
    const msg = await this.getMessage(id, currentUser);
    const text = this.getMessageContent(msg, 1500);
    const prompts: Record<string,string> = { 'confirm-shipment':'确认发货通知','payment-reminder':'催款提醒','decline-price':'委婉拒绝价格','supplement-quote':'补充报价资料','confirm-sample':'确认样品需求' };

    const resolvedLang = normalizeLanguage(targetLanguage || (msg.lead as any)?.language);
    const targetLanguageName = this.languageService.getLanguageName(resolvedLang);

    const systemPrompt =
      `Write a B2B reply draft for "${prompts[scenario]}" based on the email. ` +
      `Write the draft in ${targetLanguageName}. Keep it under 3 sentences. ` +
      `Do NOT commit to price/delivery/certifications. ` +
      `Also provide a one-sentence Chinese summary (draftSummary) describing the strategy. ` +
      `Return JSON: {"draft":"${targetLanguageName} content","draftSummary":"中文摘要"}`;
    const result = await this.ai.chat(systemPrompt, text, { task: 'reply_suggestion' });

    const { draft, draftSummary } = this.parseDraftResult(result.content);
    return {
      draft,
      draftSummary,
      scenario,
      language: resolvedLang,
      aiEnabled: result.reason === 'success',
    };
  }

  /** Generate 3 reply drafts */
  async replyDrafts(id: string, currentUser: any, targetLanguage?: string) {
    const msg = await this.getMessage(id, currentUser);
    const text = this.getMessageContent(msg, 1500);

    const resolvedLang = normalizeLanguage(targetLanguage || (msg.lead as any)?.language);
    const targetLanguageName = this.languageService.getLanguageName(resolvedLang);

    const systemPrompt =
      `Generate 3 reply drafts for this B2B packaging email. ` +
      `Write each draft in ${targetLanguageName}. Styles: formal, friendly, concise. ` +
      `Each under 3 sentences. Do NOT commit to price/delivery/certifications. ` +
      `Also provide a one-sentence Chinese summary (draftSummary) for each draft describing its strategy. ` +
      `Return JSON: {"drafts":[{"content":"${targetLanguageName} content","summary":"中文摘要"}]}`;
    const result = await this.ai.chat(systemPrompt, text, { task: 'reply_suggestion' });

    const { drafts, draftSummaries } = this.parseReplyDraftsResult(result.content);
    return {
      drafts,
      draftSummaries,
      draftSummary: draftSummaries[0] || '',
      language: resolvedLang,
      aiEnabled: result.reason === 'success',
    };
  }

  /**
   * Parse AI scenario-draft output into { draft, draftSummary }.
   * Supports JSON object, JSON-with-markdown-fences, and raw-text fallback.
   */
  private parseDraftResult(raw: string): { draft: string; draftSummary: string } {
    // 1. Try JSON parse (strip markdown code fences if present)
    try {
      const cleaned = raw.replace(/```json\s*/gi, '').replace(/```\s*$/g, '').trim();
      const parsed = JSON.parse(cleaned);
      if (parsed && typeof parsed === 'object') {
        const draft = String(parsed.draft || '').trim();
        const draftSummary = String(parsed.draftSummary || '').trim();
        if (draft) return { draft, draftSummary };
      }
    } catch {
      // not JSON — continue to fallback
    }

    // 2. Fallback: use raw content as draft, empty summary
    return { draft: raw.trim(), draftSummary: '' };
  }

  /**
   * Parse a multi-draft AI result (replyDrafts) into drafts + draftSummaries.
   * Supports JSON array and line-based fallback.
   */
  private parseReplyDraftsResult(raw: string): { drafts: string[]; draftSummaries: string[] } {
    try {
      const cleaned = raw.replace(/```json\s*/gi, '').replace(/```\s*$/g, '').trim();
      const parsed = JSON.parse(cleaned);
      if (parsed && Array.isArray(parsed.drafts) && parsed.drafts.length > 0) {
        const drafts: string[] = [];
        const draftSummaries: string[] = [];
        for (const item of parsed.drafts) {
          if (typeof item === 'string') {
            drafts.push(item);
            draftSummaries.push('');
          } else if (item && typeof item === 'object') {
            drafts.push(String(item.content || item.draft || '').trim());
            draftSummaries.push(String(item.summary || item.draftSummary || '').trim());
          }
        }
        const filtered = drafts.filter((d) => d.length > 0);
        if (filtered.length > 0) return { drafts: filtered, draftSummaries };
      }
    } catch {
      // not JSON — fall through
    }

    // Line-based fallback (legacy format: "1. ...")
    const lines = raw
      .split('\n')
      .filter((l: string) => /^[123][.)、]/.test(l.trim()))
      .map((l: string) => l.replace(/^[123][.)、]\s*/, '').trim());
    if (lines.length > 0) {
      return { drafts: lines, draftSummaries: lines.map(() => '') };
    }

    return { drafts: [raw || ''], draftSummaries: [''] };
  }

  private getMessageContent(message: any, maxLength: number) {
    const body = message.bodyText || String(message.bodyHtml || '').replace(/<[^>]*>/g, '');
    return `${message.subject || ''}\n${body}`.substring(0, maxLength);
  }
}
