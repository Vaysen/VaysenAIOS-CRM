import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../common/prisma/prisma.service';
import { AiProviderService } from '../../common/ai/ai-provider.service';
import { ensureCompanyAccess, hasFullAccess, requireActiveCompany } from '../../common/utils/data-isolation';
import { LanguageService, LANGUAGE_NAMES } from '../../common/services/language.service';
import { normalizeLanguage, DEFAULT_FALLBACK_LANGUAGE } from '../../common/utils/language.util';

/** 批量操作动作白名单（R111 批次B：Foxmail 式邮件中心） */
export const MAIL_WORKBENCH_BATCH_ACTIONS = ['mark_read', 'mark_unread', 'star', 'unstar', 'archive', 'delete'] as const;
export type MailWorkbenchBatchAction = (typeof MAIL_WORKBENCH_BATCH_ACTIONS)[number];

/** 伪账号：sourceAccountId 为空（无 IMAP 账号归属）的收件消息归入「未分类」 */
export const UNCATEGORIZED_ACCOUNT_ID = 'uncategorized';

@Injectable()
export class MailWorkbenchService {
  constructor(
    private prisma: PrismaService,
    private ai: AiProviderService,
    private languageService: LanguageService,
  ) {}

  /**
   * Get mail folder tree with counts.
   *
   * - 不传 accountId：聚合全部账号（兼容现状），并返回 IMAP 已配置账号的分组文件夹树
   *   `{ folders, accounts, uncategorized }`
   * - 传 accountId：返回该账号（或 `uncategorized` 未分类）的独立文件夹树
   *   `{ account, folders }`
   */
  async getTree(currentUser: any, accountId?: string) {
    const companyId = requireActiveCompany(currentUser).id;
    const messageOwnerWhere = this.messageOwnerWhere(currentUser, companyId);
    const conversationOwnerWhere = this.conversationOwnerWhere(currentUser, companyId);

    const inboundBase = (extra: Record<string, unknown> = {}) => ({
      direction: 'inbound',
      isArchived: false,
      deletedAt: null,
      conversation: {
        companyId,
        channel: 'business_email',
        ...conversationOwnerWhere,
      },
      ...extra,
    });
    const folderCounts = async (messageWhere: Record<string, unknown>, emailWhere: Record<string, unknown>) => {
      const [inbox, starred, sent, drafts] = await Promise.all([
        this.prisma.communicationMessage.count({ where: inboundBase(messageWhere) }),
        this.prisma.communicationMessage.count({ where: inboundBase({ ...messageWhere, isStarred: true }) }),
        this.prisma.emailMessage.count({
          where: { companyId, status: { in: ['sent', 'Sent'] }, ...messageOwnerWhere, ...emailWhere },
        }),
        this.prisma.emailMessage.count({
          where: { companyId, status: { in: ['draft', 'Draft'] }, ...messageOwnerWhere, ...emailWhere },
        }),
      ]);
      return [
        { id: 'inbox', label: '收件箱', count: inbox },
        { id: 'sent', label: '已发送', count: sent },
        { id: 'drafts', label: '草稿', count: drafts },
        { id: 'starred', label: '星标', count: starred },
      ];
    };

    // 单账号（或未分类）独立文件夹树
    if (accountId) {
      if (accountId === UNCATEGORIZED_ACCOUNT_ID) {
        // 未分类仅指 sourceAccountId 为空的收件消息；已发送/草稿（EmailMessage）必有账号归属，计数为 0
        const folders = await folderCounts({ sourceAccountId: null }, { emailAccountId: UNCATEGORIZED_ACCOUNT_ID });
        return {
          account: { id: UNCATEGORIZED_ACCOUNT_ID, address: null, enabled: false, label: '未分类' },
          folders,
        };
      }
      const account = await this.prisma.emailAccount.findFirst({
        where: { id: accountId, companyId },
        select: { id: true, senderEmail: true, inboundEnabled: true },
      });
      if (!account) throw new NotFoundException('Email account not found in current company');
      const folders = await folderCounts({ sourceAccountId: accountId }, { emailAccountId: accountId });
      return {
        account: { id: account.id, address: account.senderEmail, enabled: account.inboundEnabled },
        folders,
      };
    }

    // 聚合视图：全部账号文件夹（现状兼容）+ 按邮箱账号分组（仅含 IMAP 已配置账号）+ 未分类
    const [folders, accounts, uncategorized] = await Promise.all([
      folderCounts({}, {}),
      this.prisma.emailAccount.findMany({
        where: { companyId, status: 'active', imapHost: { not: null }, imapUsername: { not: null } },
        select: { id: true, senderEmail: true, inboundEnabled: true },
        orderBy: { createdAt: 'asc' },
      }),
      this.prisma.communicationMessage.count({ where: inboundBase({ sourceAccountId: null }) }),
    ]);
    const accountGroups = await Promise.all(
      accounts.map(async (a) => ({
        id: a.id,
        address: a.senderEmail,
        enabled: a.inboundEnabled,
        folders: await folderCounts({ sourceAccountId: a.id }, { emailAccountId: a.id }),
      })),
    );
    return {
      folders,
      accounts: accountGroups,
      uncategorized: { id: UNCATEGORIZED_ACCOUNT_ID, label: '未分类', count: uncategorized },
    };
  }

  /** List messages with grouping and filters */
  async getMessages(currentUser: any, query: {
    page?: number; limit?: number; folder?: string; search?: string;
    customerId?: string; ownerUserId?: string; source?: string; status?: string; q?: string;
    accountId?: string;
  }) {
    const companyId = requireActiveCompany(currentUser).id;
    const messageOwnerWhere = this.messageOwnerWhere(currentUser, companyId);
    const conversationOwnerWhere = this.conversationOwnerWhere(currentUser, companyId);
    const page = query.page || 1; const limit = query.limit || 20; const skip = (page - 1) * limit;

    // 收件箱/星标：CommunicationMessage 多账号聚合（Foxmail 时间线，按 receivedAt 倒序）
    const isInboundFolder = !query.folder || query.folder === 'inbox' || query.folder === 'starred';
    if (isInboundFolder) {
      const inboundWhere: any = {
        direction: 'inbound',
        isArchived: false,
        deletedAt: null,
        conversation: {
          companyId,
          channel: 'business_email',
          ...conversationOwnerWhere,
        },
      };
      if (query.accountId) {
        await this.assertAccountInCompany(companyId, query.accountId);
        inboundWhere.sourceAccountId = query.accountId === UNCATEGORIZED_ACCOUNT_ID ? null : query.accountId;
      }
      if (query.folder === 'starred') inboundWhere.isStarred = true;
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
          accountId: message.sourceAccountId ?? null,
          isStarred: Boolean(message.isStarred),
          isArchived: Boolean(message.isArchived),
        })),
        meta: { page, limit, total, totalPages: Math.ceil(total / limit) },
      };
    }

    // 已发送/草稿：EmailMessage（营销已发记录）
    const where: any = { companyId, ...messageOwnerWhere };
    if (query.folder === 'sent') where.status = { in: ['sent', 'Sent'] };
    else if (query.folder === 'drafts') where.status = { in: ['draft', 'Draft'] };
    else return { data: [], meta: { page, limit, total: 0, totalPages: 0 } };
    if (query.accountId) {
      await this.assertAccountInCompany(companyId, query.accountId);
      where.emailAccountId = query.accountId;
    }
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

  /**
   * 批量操作（R111 批次B）：mark_read / mark_unread / star / unstar / archive / delete。
   * - 仅限当前公司（且在本用户可见范围）的 inbound 消息，跨租户/越权 ids 整体拒绝（403）
   * - 事务批量更新，幂等：重复执行同一动作 updated 不重复计数
   * - 空 ids / 非法 action 拒绝（400）
   */
  async batchUpdate(currentUser: any, dto: { ids: string[]; action: string }) {
    const companyId = requireActiveCompany(currentUser).id;
    const rawIds = Array.isArray(dto?.ids) ? dto.ids.map((id: any) => String(id).trim()).filter(Boolean) : [];
    const action = String(dto?.action || '');
    if (rawIds.length === 0) throw new BadRequestException('ids must be a non-empty array');
    if (!(MAIL_WORKBENCH_BATCH_ACTIONS as readonly string[]).includes(action)) {
      throw new BadRequestException(`action must be one of: ${MAIL_WORKBENCH_BATCH_ACTIONS.join(', ')}`);
    }
    const ids = [...new Set(rawIds)];

    // 越权防护：ids 必须全部属于当前公司（且在本用户可见范围），缺一即整体拒绝
    const found = await this.prisma.communicationMessage.findMany({
      where: {
        id: { in: ids },
        direction: 'inbound',
        conversation: {
          companyId,
          channel: 'business_email',
          ...this.conversationOwnerWhere(currentUser, companyId),
        },
      },
      select: { id: true, conversationId: true },
    });
    if (found.length !== ids.length) {
      throw new ForbiddenException('Some messages are outside the current company scope');
    }
    const foundIds = found.map((m) => m.id);

    const actionWhere: Record<string, Record<string, unknown>> = {
      mark_read: { readAt: null },
      mark_unread: { readAt: { not: null } },
      star: { isStarred: false },
      unstar: { isStarred: true },
      archive: { isArchived: false },
      delete: { deletedAt: null },
    };
    const actionData: Record<string, Record<string, unknown>> = {
      mark_read: { readAt: new Date() },
      mark_unread: { readAt: null },
      star: { isStarred: true },
      unstar: { isStarred: false },
      archive: { isArchived: true },
      delete: { deletedAt: new Date() },
    };

    const updated = await this.prisma.$transaction(async (tx) => {
      const result = await tx.communicationMessage.updateMany({
        where: { id: { in: foundIds }, ...actionWhere[action] },
        data: actionData[action],
      });
      if (action === 'mark_read') {
        // 同步会话未读数，避免会话列表徽标漂移
        const conversationIds = [...new Set(found.map((m) => m.conversationId))];
        for (const conversationId of conversationIds) {
          const unread = await tx.communicationMessage.count({
            where: { conversationId, direction: 'inbound', readAt: null, deletedAt: null },
          });
          await tx.conversation.update({ where: { id: conversationId }, data: { unreadCount: unread } });
        }
      }
      return result.count;
    });
    return { updated };
  }

  /** Get single message with lead info */
  async getMessage(id: string, currentUser: any) {
    const companyId = requireActiveCompany(currentUser).id;
    if (id.startsWith('inbound:')) {
      const messageId = id.slice('inbound:'.length);
      const inbound = await this.prisma.communicationMessage.findFirst({
        where: {
          id: messageId,
          conversation: { companyId, ...this.conversationOwnerWhere(currentUser, companyId) },
        },
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
        accountId: inbound.sourceAccountId ?? null,
        isStarred: Boolean(inbound.isStarred),
        isArchived: Boolean(inbound.isArchived),
      };
    }

    const msg = await this.prisma.emailMessage.findFirst({
      where: { id, companyId, ...this.messageOwnerWhere(currentUser, companyId) },
      include: { lead: { select: { id: true, companyName: true, contactName: true, country: true, language: true } } },
    });
    if (!msg) throw new NotFoundException('Message not found');
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
    const companyId = requireActiveCompany(currentUser).id;
    const messageOwnerWhere = this.messageOwnerWhere(currentUser, companyId);
    const conversationOwnerWhere = this.conversationOwnerWhere(currentUser, companyId);
    const where = { companyId, ...messageOwnerWhere };
    const [inbox, sent, drafts, total, unread] = await Promise.all([
      this.prisma.communicationMessage.count({
        where: {
          direction: 'inbound',
          isArchived: false,
          deletedAt: null,
          conversation: {
            companyId,
            channel: 'business_email',
            ...conversationOwnerWhere,
          },
        },
      }),
      this.prisma.emailMessage.count({ where: { ...where, status: { in: ['sent', 'Sent'] } } }),
      this.prisma.emailMessage.count({ where: { ...where, status: { in: ['draft', 'Draft'] } } }),
      this.prisma.emailMessage.count({ where }),
      this.prisma.communicationMessage.count({
        where: {
          direction: 'inbound',
          isArchived: false,
          deletedAt: null,
          readAt: null,
          conversation: {
            companyId,
            channel: 'business_email',
            ...conversationOwnerWhere,
          },
        },
      }),
    ]);
    return { inbox, sent, drafts, total, unread };
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

  private messageOwnerWhere(currentUser: any, companyId: string) {
    return hasFullAccess(currentUser, companyId)
      ? {}
      : { senderUserId: currentUser.id };
  }

  private conversationOwnerWhere(currentUser: any, companyId: string) {
    return hasFullAccess(currentUser, companyId)
      ? {}
      : {
          OR: [
            { assignedUserId: currentUser.id },
            { lead: { ownerUserId: currentUser.id } },
          ],
        };
  }

  /** accountId 过滤必须属于当前公司；`uncategorized` 为内置伪账号（sourceAccountId 为空） */
  private async assertAccountInCompany(companyId: string, accountId: string) {
    if (accountId === UNCATEGORIZED_ACCOUNT_ID) return;
    const account = await this.prisma.emailAccount.findFirst({
      where: { id: accountId, companyId },
      select: { id: true },
    });
    if (!account) throw new NotFoundException('Email account not found in current company');
  }
}
