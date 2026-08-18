import { Injectable, ForbiddenException, NotFoundException, Logger } from '@nestjs/common';
import { PrismaService } from '../../common/prisma/prisma.service';
import { AiProviderService } from '../../common/ai/ai-provider.service';
import {
  ensureCompanyAccess,
  requireActiveCompany,
} from '../../common/utils/data-isolation';
import { getLanguageName, normalizeLanguage, DEFAULT_FALLBACK_LANGUAGE } from '../../common/utils/language.util';
import { LANGUAGE_NAMES } from '../../common/services/language.service';

@Injectable()
export class AiCommunicationsService {
  private readonly logger = new Logger(AiCommunicationsService.name);

  constructor(
    private prisma: PrismaService,
    private ai: AiProviderService,
  ) {}

  /** Translate a message — supports 8 languages; persists to translatedContent; default target zh (for operators) */
  async translateMessage(
    communicationMessageId: string,
    currentUser: any,
    targetLang: string = 'zh',
    sourceLanguage?: string,
  ) {
    const msg = await this.prisma.communicationMessage.findUnique({ where: { id: communicationMessageId } });
    if (!msg) throw new Error('Message not found');
    await this.checkMessageAccess(msg.conversationId, currentUser);

    // Resolve source language: explicit param > quick regex detection > default 'en'
    let sourceLang = sourceLanguage;
    if (!sourceLang) {
      if (/[\u4e00-\u9fff]/.test(msg.content)) sourceLang = 'zh';
      else if (/[\u3040-\u30ff]/.test(msg.content)) sourceLang = 'ja';
      else if (/[\uac00-\ud7af]/.test(msg.content)) sourceLang = 'ko';
      else sourceLang = 'en';
    }

    const sourceName = LANGUAGE_NAMES[sourceLang] || LANGUAGE_NAMES['en'];
    const targetName = LANGUAGE_NAMES[targetLang] || LANGUAGE_NAMES['zh'];
    const prompt = `Translate from ${sourceName} to ${targetName}. Return ONLY the translation, no explanations.`;

    const result = await this.ai.chat(prompt, msg.content, { task: 'translation' });

    // Persist translation to CommunicationMessage.translatedContent
    await this.prisma.communicationMessage.update({
      where: { id: communicationMessageId },
      data: { translatedContent: result.content },
    });

    const artifact = await this.prisma.aiArtifact.create({
      data: {
        companyId: (await this.getCompanyFromMessage(msg)),
        communicationMessageId,
        artifactType: 'translation',
        inputContent: msg.content,
        outputContent: result.content,
        provider: 'zhipu',
        model: result.model || this.ai.getModel(),
        status: 'generated',
      },
    });

    return {
      id: artifact.id,
      translation: result.content,
      sourceLanguage: sourceLang,
      targetLanguage: targetLang,
      direction: `${sourceLang}->${targetLang}`,
      aiEnabled: result.reason === 'success',
    };
  }

  /** Summarize a conversation */
  async summarizeConversation(conversationId: string, currentUser: any) {
    const conv = await this.prisma.conversation.findUnique({ where: { id: conversationId } });
    if (!conv) throw new Error('Conversation not found');
    this.ensureAccess(currentUser, conv.companyId);

    const messages = await this.prisma.communicationMessage.findMany({
      where: { conversationId }, orderBy: { createdAt: 'asc' },
    });
    if (!messages.length) throw new Error('No messages found');

    const transcript = messages.map(m => `[${m.direction}] ${m.content}`).join('\n\n');
    const result = await this.ai.chat(
      '你是一个外贸业务助手。请用中文简要总结以下客户沟通内容，包括：客户需求、关键问题、意向产品、紧急程度。150字以内。',
      transcript,
      { task: 'summary' },
    );

    const artifact = await this.prisma.aiArtifact.create({
      data: {
        companyId: conv.companyId, conversationId,
        artifactType: 'summary',
        inputContent: transcript.substring(0, 4000),
        outputContent: result.content,
        provider: 'zhipu', model: result.model || this.ai.getModel(),
        status: 'generated',
      },
    });

    return { id: artifact.id, summary: result.content, aiEnabled: result.reason === 'success' };
  }

  /** Generate reply suggestions */
  async suggestReplies(communicationMessageId: string, currentUser: any, targetLanguage?: string) {
    const msg = await this.prisma.communicationMessage.findUnique({ where: { id: communicationMessageId } });
    if (!msg) throw new Error('Message not found');
    await this.checkMessageAccess(msg.conversationId, currentUser);

    // Resolve target language: explicit param > Lead.language > fallback (en)
    const conv = await this.prisma.conversation.findUnique({
      where: { id: msg.conversationId },
      include: { lead: { select: { language: true } } },
    });
    const resolvedLang = normalizeLanguage(targetLanguage || conv?.lead?.language);
    const targetLanguageName = getLanguageName(resolvedLang);

    const systemPrompt =
      `你是一个专业外贸客服。请用 ${targetLanguageName} 生成 3 条回复建议。\n` +
      `每条回复要专业、礼貌、符合商务沟通习惯。\n` +
      `同时用中文为每条回复写一句话摘要说明其策略。\n\n` +
      `返回 JSON 格式：\n` +
      `{\n  "replies": [\n    {"content": "${targetLanguageName}回复内容", "summary": "中文摘要说明策略"}\n  ]\n}`;
    const userPrompt = `客户消息：${msg.content}\n\n请生成 3 条回复建议，返回 JSON。`;

    const result = await this.ai.chat(systemPrompt, userPrompt, { task: 'reply_suggestion' });

    // Parse JSON response; fall back to line-based parsing then raw content
    const { replies, summaries } = this.parseReplySuggestions(result.content, resolvedLang);

    const artifact = await this.prisma.aiArtifact.create({
      data: {
        companyId: conv?.companyId || '',
        communicationMessageId, conversationId: msg.conversationId,
        artifactType: 'reply_suggestion',
        inputContent: msg.content,
        outputContent: JSON.stringify({ replies, summaries, language: resolvedLang }),
        extraData: { replies, summaries, language: resolvedLang },
        provider: 'zhipu', model: result.model || this.ai.getModel(),
        status: 'generated',
      },
    });

    return {
      id: artifact.id,
      replies,
      summaries,
      language: resolvedLang,
      aiEnabled: result.reason === 'success',
    };
  }

  /**
   * Parse AI reply-suggestion output into replies + summaries.
   * Supports JSON object, JSON-with-markdown-fences, and line-based fallback.
   * On failure, falls back to English with empty summaries.
   */
  private parseReplySuggestions(
    raw: string,
    resolvedLang: string,
  ): { replies: string[]; summaries: string[] } {
    const fallbackLang = DEFAULT_FALLBACK_LANGUAGE;

    // 1. Try JSON parse (strip markdown code fences if present)
    try {
      const cleaned = raw.replace(/```json\s*/gi, '').replace(/```\s*$/g, '').trim();
      const parsed = JSON.parse(cleaned);
      if (parsed && Array.isArray(parsed.replies) && parsed.replies.length > 0) {
        const replies: string[] = [];
        const summaries: string[] = [];
        for (const item of parsed.replies) {
          if (typeof item === 'string') {
            replies.push(item);
            summaries.push('');
          } else if (item && typeof item === 'object') {
            replies.push(String(item.content || '').trim());
            summaries.push(String(item.summary || '').trim());
          }
        }
        const filtered = replies.filter((r) => r.length > 0);
        if (filtered.length > 0) {
          return { replies: filtered, summaries };
        }
      }
    } catch {
      // not JSON — continue to fallback
    }

    // 2. Line-based fallback (legacy format: "1. ...")
    const lines = raw
      .split('\n')
      .filter((l: string) => /^[123][.)、]\s*/.test(l.trim()))
      .map((l: string) => l.replace(/^[123][.)、]\s*/, '').trim());
    if (lines.length > 0) {
      return { replies: lines, summaries: lines.map(() => '') };
    }

    // 3. Last resort: raw content as single reply (fallback to English if AI errored)
    this.logger.warn(
      `suggestReplies: failed to parse structured response, using raw content (fallback lang=${fallbackLang})`,
    );
    return { replies: [raw || ''], summaries: [''] };
  }

  /** Extract quote fields from conversation */
  async extractQuoteFields(conversationId: string, currentUser: any) {
    const conv = await this.prisma.conversation.findUnique({ where: { id: conversationId } });
    if (!conv) throw new Error('Conversation not found');
    this.ensureAccess(currentUser, conv.companyId);

    const messages = await this.prisma.communicationMessage.findMany({
      where: { conversationId }, orderBy: { createdAt: 'asc' },
    });
    if (!messages.length) throw new Error('No messages');

    const transcript = messages.map(m => m.content).join('\n\n');
    const result = await this.ai.chat(
      '提取包装外贸报价字段。只返回 JSON 对象，key 用英文，值为 null 表示未提及。不要输出任何解释。',
      `从以下对话提取：productName, material, size, thickness, color, printing, quantity, unitPrice, sampleFee, deliveryTime, tradeTerms, paymentTerms\n\n${transcript.substring(0, 3000)}`,
      { task: 'quote_extraction', temperature: 0.1 },
    );

    let fields = {};
    try { fields = JSON.parse(result.content); } catch { fields = { raw: result.content }; }

    const artifact = await this.prisma.aiArtifact.create({
      data: {
        companyId: conv.companyId, conversationId,
        artifactType: 'quote_extraction',
        inputContent: transcript.substring(0, 3000),
        outputContent: JSON.stringify(fields),
        extraData: fields,
        provider: 'zhipu', model: result.model || this.ai.getModel(),
        status: 'generated',
      },
    });

    return { id: artifact.id, fields, aiEnabled: result.reason === 'success' };
  }

  /** AI generate full quote with pricing calculation */
  async generateQuote(conversationId: string, currentUser: any, type: string = 'quote') {
    const conv = await this.prisma.conversation.findUnique({
      where: { id: conversationId },
      include: {
        lead: { select: { id: true, companyName: true, contactName: true, country: true, contactEmail: true } },
        messages: { orderBy: { createdAt: 'asc' }, select: { id: true, direction: true, content: true, fromAddress: true } },
      },
    });
    if (!conv) throw new NotFoundException('Conversation not found');
    this.ensureAccess(currentUser, conv.companyId);

    const transcript = conv.messages.map(m => `[${m.direction === 'inbound' ? '客户' : '我'}]${m.fromAddress ? ` (${m.fromAddress})` : ''}: ${m.content}`).join('\n');

    const pricingPrompt = `你是Vaysen包装(Vaysen Packaging)的AI报价助手。根据客户对话提取报价字段并计算合理价格。

## 产品定价参考 (USD)
- 快递袋标准: $0.009-0.15/pc, MOQ 100
- 快递袋全彩定制: $0.034-0.125/pc, MOQ 5,000-30,000
- 牛皮纸袋开窗: $0.036-0.24/pc, MOQ 6,000
- 牛皮纸袋密封/拉链: $0.066-0.223/pc, MOQ 6,000
- 咖啡袋自立: $0.17-0.48/pc, MOQ 6,000
- 垃圾袋标准: $0.006-0.10/pc, MOQ 20,000
- 垃圾袋特大号: $0.10-0.38/pc, MOQ 20,000
- 保鲜袋PE食品: $1.15-1.50/盒, MOQ 5,000
- 防臭袋Mylar: $0.10-1.00/pc, MOQ 1,000
- 铜版模具费: $50/色 (一次性)
- 定色费: $50/色
- 打样费: 免费(无印刷) / $50(含印刷)
- 样品运费: $20 (DHL/FedEx)
- 交期: 15-20天
- 量越大价越低，大批量可享阶梯折扣

## 规则
1. 根据对话中提及的品类/材质/尺寸，匹配最接近的价格区间
2. unitPrice 取价格区间中值，quantity 大时取低值
3. totalAmount = unitPrice × quantity
4. 如客户未提印刷要求，printing=null, moldFee=0
5. 如客户未提供足够信息，相关字段设为null并在notes中说明
6. tradeTerms默认FOB Shenzhen
7. paymentTerms默认T/T 30% deposit, 70% before shipment
8. currency固定USD`;

    const result = await this.ai.chat(
      pricingPrompt,
      `对话类型: ${type === 'sample' ? '样品单' : type === 'pi' ? 'PI形式发票' : '报价单'}\n对话记录:\n${transcript}\n\n请提取并计算报价信息，返回JSON对象(不要markdown包裹):`,
      { task: 'quote_extraction', temperature: 0.1 },
    );

    let fields: any = {};
    try {
      fields = JSON.parse(result.content || '{}');
    } catch { fields = { raw: result.content?.substring(0, 1000) }; }

    // Save as AI artifact
    const artifact = await this.prisma.aiArtifact.create({
      data: {
        companyId: conv.companyId, conversationId,
        artifactType: 'quote_extraction',
        inputContent: transcript.substring(0, 3000),
        outputContent: JSON.stringify(fields),
        extraData: { ...fields, type, aiSuggested: true, pricingBasis: 'pricing-reference.md v2026-06' },
        provider: 'zhipu', model: result.model || this.ai.getModel(),
        status: 'generated',
      },
    });

    return {
      id: artifact.id,
      fields: { ...fields, aiSuggested: true, pricingBasis: 'pricing-reference.md v2026-06' },
      lead: conv.lead,
      type,
      aiEnabled: result.reason === 'success',
    };
  }

  /**
   * Translate an operator-entered draft into the customer's language.
   * Replaces the former translateChineseToEnglish (kept as alias for compat).
   */
  async translateDraft(text: string, _currentUser: any, targetLanguage: string = DEFAULT_FALLBACK_LANGUAGE) {
    const resolvedLang = normalizeLanguage(targetLanguage);
    const targetLanguageName = getLanguageName(resolvedLang);

    // Cache identity must include both company and target language. The old
    // input-only lookup could return a previous Chinese translation for a new
    // English request (and could even reuse another company's artifact).
    const cacheKey = text.trim().slice(0, 500);
    const companyId = requireActiveCompany(_currentUser).id;
    const existing = await this.prisma.aiArtifact.findFirst({
      where: {
        companyId,
        artifactType: 'translation',
        inputContent: cacheKey,
        outputContent: { not: '' },
        extraData: { path: ['targetLanguage'], equals: resolvedLang },
      },
      orderBy: { createdAt: 'desc' },
      take: 1,
    });
    if (existing) {
      return { draft: existing.outputContent, language: resolvedLang, aiEnabled: true, cached: true };
    }

    const result = await this.ai.chat(
      `Translate the following text to ${targetLanguageName}. Return ONLY the translation.`,
      text,
      { task: 'translation' },
    );

    // ── 持久化翻译结果到 AiArtifact 表 ──
    try {
      if (companyId) await this.prisma.aiArtifact.create({
        data: {
          companyId,
          artifactType: 'translation',
          inputContent: cacheKey,
          outputContent: result.content,
          provider: 'zhipu',
          model: result.model || this.ai.getModel(),
          status: 'generated',
          extraData: { targetLanguage: resolvedLang },
        },
      });
    } catch (e) {
      this.logger.warn(`Failed to persist translation: ${e}`);
    }

    return { draft: result.content, language: resolvedLang, aiEnabled: result.reason === 'success' };
  }

  /** @deprecated Use translateDraft instead. Kept for backward compatibility. */
  async translateChineseToEnglish(text: string, currentUser: any) {
    return this.translateDraft(text, currentUser, DEFAULT_FALLBACK_LANGUAGE);
  }

  /** Generate a follow-up record and write to timeline */
  async generateFollowUpRecord(conversationId: string, currentUser: any) {
    const conv = await this.prisma.conversation.findUnique({ where: { id: conversationId } });
    if (!conv) throw new Error('Conversation not found');
    this.ensureAccess(currentUser, conv.companyId);

    if (!conv.leadId) throw new Error('No lead linked to this conversation');

    const messages = await this.prisma.communicationMessage.findMany({
      where: { conversationId }, orderBy: { createdAt: 'asc' }, take: 20,
    });

    const transcript = messages.map(m => `[${m.direction}] ${m.content}`).join('\n\n');
    const result = await this.ai.chat(
      '你是一个外贸业务助理。根据客户沟通记录，生成一条简洁的跟进记录（50字以内，中文）。只返回跟进记录文本，不加解释。',
      transcript,
      { task: 'summary'},
    );

    const record = result.content || '已记录跟进';

    await this.prisma.leadActivity.create({
      data: {
        companyId: conv.companyId,
        leadId: conv.leadId,
        activityType: 'note_added',
        title: `AI 跟进记录: ${record.substring(0, 50)}`,
        description: record,
        metadata: { generatedBy: 'ai', conversationId },
        occurredAt: new Date(),
      },
    });

    return { recorded: true, content: record };
  }

  /** Resolve a WhatsApp phone number to a CRM lead id (for the WA sidebar customer analysis panel).
   *  Normalizes E.164 digits so +86/0086/leading-zeros variants match the stored `whatsapp` value. */
  async resolveLeadByWhatsAppPhone(phone: string, currentUser: any) {
    if (!phone) throw new NotFoundException('phone is required');
    const digits = phone.replace(/[^\d]/g, '');
    if (!digits) throw new NotFoundException('phone must contain digits');
    const tail = digits.slice(-10);

    const lead = await this.prisma.lead.findFirst({
      where: {
        whatsapp: {
          not: null,
        },
        OR: [
          { whatsapp: phone },
          { whatsapp: `+${digits}` },
          { whatsapp: `+${tail}` },
        ],
      },
    });
    if (!lead) return { found: false, phone };
    this.ensureAccess(currentUser, lead.companyId);
    return {
      found: true,
      leadId: lead.id,
      companyName: lead.companyName,
      contactName: lead.contactName,
      country: lead.country,
    };
  }

  /** Build a company knowledge context (brand, products, description) for AI-assisted replies. */
  async getKnowledgeContext(currentUser: any) {
    const company = await this.prisma.company.findFirst({
      where: { id: currentUser.companyId },
      include: { products: { take: 20, orderBy: { createdAt: 'asc' } } },
    });
    if (!company) return { companyName: '', industry: '', description: '', products: [] };
    return {
      companyName: company.name,
      website: company.website,
      industry: company.industry,
      country: company.country,
      description: company.description,
      products: (company.products || []).map((p: any) => ({
        sku: p.sku,
        name: p.name,
        description: p.description,
      })),
    };
  }

  /** Generate a reception draft (AI welcome/reply) grounded in the company knowledge base.
   *  The knowledge context + customer message are passed through; output is a draft only. */
  async generateReceptionDraft(
    customerMessage: string,
    currentUser: any,
    targetLanguage: string = 'en',
  ) {
    const kb = await this.getKnowledgeContext(currentUser);
    const resolvedLang = normalizeLanguage(targetLanguage);
    const targetLanguageName = getLanguageName(resolvedLang);
    const productLines = (kb.products || [])
      .slice(0, 10)
      .map((p: any) => `- ${p.name}${p.sku ? ` (${p.sku})` : ''}${p.description ? `: ${p.description}` : ''}`)
      .join('\n');

    const systemPrompt =
      `You are the B2B customer service assistant for "${kb.companyName || 'the company'}" (${kb.industry || ''}, ${kb.country || ''}). ` +
      `Reply to the customer's message in ${targetLanguageName}. Use the company knowledge below when relevant. ` +
      `Stay professional and concise (2-4 sentences). Never invent facts that are not in the knowledge base. Return strict JSON only:\n` +
      `{"draft": "your reply", "confidence": "high|medium|low", "needsHuman": true|false}`;

    const userPrompt =
      `Company knowledge:\nCompany: ${kb.companyName || 'N/A'}\nIndustry: ${kb.industry || 'N/A'}\nDescription: ${kb.description || 'N/A'}\n` +
      `Products:\n${productLines || '- none listed'}\n\n` +
      `Customer message:\n${customerMessage || '(no message yet)'}\n\n` +
      `Generate the reception draft reply in ${targetLanguageName}.`;

    const result = await this.ai.chat(systemPrompt, userPrompt, { task: 'reception_draft', maxTokens: 500 });

    let draft = '';
    let confidence = 'low';
    let needsHuman = false;
    try {
      const cleaned = result.content.replace(/```json\s*/gi, '').replace(/```\s*$/g, '').trim();
      const parsed = JSON.parse(cleaned);
      draft = String(parsed.draft || '').trim();
      confidence = ['high', 'medium', 'low'].includes(parsed.confidence) ? parsed.confidence : 'low';
      needsHuman = parsed.needsHuman === true;
    } catch {
      draft = result.content.trim();
      needsHuman = true;
    }

    return { draft, confidence, needsHuman, language: resolvedLang, aiEnabled: result.reason === 'success', knowledge: { companyName: kb.companyName, productCount: (kb.products || []).length } };
  }

  /** Generate structured customer background analysis */
  async generateCustomerAnalysis(leadId: string, currentUser: any) {
    const lead = await this.prisma.lead.findUnique({ where: { id: leadId } });
    if (!lead) throw new Error('Lead not found');
    this.ensureAccess(currentUser, lead.companyId);

    // 读取该 lead 全部会话消息（含 createdAt + direction），用于计算真实回复质检时序数据
    const conversations = await this.prisma.conversation.findMany({
      where: { leadId },
      include: {
        messages: {
          orderBy: { createdAt: 'asc' },
          select: { id: true, direction: true, content: true, createdAt: true },
        },
      },
    });
    const allMessages = conversations.flatMap(c => c.messages);
    const replyTiming = this.computeReplyTiming(allMessages);

    // 将真实时序数据合并进 replyQuality，并把 nextSteps 统一为结构化对象
    // （缓存结果可能是本版本之前的旧结构，同样需要兜底）
    const applyTimingToAnalysis = (a: any) => {
      if (a && typeof a === 'object') {
        a.replyQuality = {
          ...(a.replyQuality && typeof a.replyQuality === 'object' ? a.replyQuality : {}),
          ...replyTiming,
        };
        a.nextSteps = this.normalizeNextSteps(a.nextSteps);
      }
      return a;
    };

    // Check cache — return existing analysis if recent (<24h)
    const cached = await this.prisma.aiArtifact.findFirst({
      where: { leadId, artifactType: 'customer_analysis', createdAt: { gte: new Date(Date.now() - 86400000) } },
      orderBy: { createdAt: 'desc' },
    });
    if (cached) {
      return {
        id: cached.id,
        analysis: applyTimingToAnalysis(JSON.parse(cached.outputContent || '{}')),
        cached: true,
      };
    }

    // 最近10条（新→旧）作为 AI 沟通摘要
    const activitySummary = conversations
      .flatMap(c => c.messages.slice(-10).reverse())
      .map(m => m.content)
      .join('\n')
      .substring(0, 2000);

    const prompt = `分析以下B2B包装行业客户，返回JSON（不要其他文字）：
{
  "summary":"一句话判断(中文)",
  "matchScore":"高/中/低",
  "mainProducts":"主营产品",
  "estimatedScale":"规模判断",
  "contactInfo":"联系人职位信息",
  "businessMatch":"与我方业务匹配度说明",
  "recommendation":"下一步建议",
  "confidence":"可信度: 基于已有数据/待核实",
  "probability":0,
  "intent":"客户意图(如采购意向/询价/观望/无明确意向)",
  "nextSteps":[{"title":"下一步行动1","description":"具体行动说明，含 deadline 提示"},{"title":"下一步行动2","description":"具体行动说明，含 deadline 提示"},{"title":"下一步行动3","description":"具体行动说明，含 deadline 提示"}],
  "tags":["客户标签1","客户标签2","客户标签3"],
  "replyVariants":{"standard":"标准回复","brief":"简短回复","detailed":"详细回复","chinese":"中文对照回复"},
  "replyQuality":{"score":0,"status":"待回复/已回复","summary":"一句话总结","currentAction":"当前待处理事项","dimensions":{"responseSpeed":0,"needRecognition":0,"professionalism":0,"conversionAction":0,"riskControl":0},"strengths":["做得好的1","做得好的2"],"improvements":["需改进的1","需改进的2"],"recommendation":"改进建议","repliedCount":0,"averageResponseMinutes":0,"longestResponseMinutes":0,"currentWaitMinutes":0,"timedOut":false,"replyPolicy":{"targetMinutes":60,"overdueMinutes":1440}}
}
客户: ${lead.companyName}, ${lead.country||''}, ${lead.industry||''}, ${lead.contactName||''}
沟通摘要: ${activitySummary || '无沟通记录'}
回复质检时序数据(真实计算, 直接采用, 不得修改): ${JSON.stringify(replyTiming)}
网站: ${lead.website||'无'}`;

    const result = await this.ai.chat('你是B2B包装外贸客户分析专家。只返回JSON。无法确认的信息标注"待核实"。', prompt, { task: 'summary', maxTokens: 800 });

    let analysis: any = {};
    try {
      const cleaned = result.content.replace(/```json\s*/gi, '').replace(/```\s*$/g, '').trim();
      analysis = JSON.parse(cleaned);
    } catch {
      analysis = { summary: result.content, confidence: '无法解析' };
    }

    // 用真实时序数据覆盖 AI 生成的 replyQuality 时序字段，并归一化 nextSteps 结构
    applyTimingToAnalysis(analysis);

    // AI 自动分析客户标签并落库（Lead ↔ Tag 关联），避免手动添加
    const aiTags = Array.isArray((analysis as any).tags)
      ? (analysis as any).tags.filter((t: unknown) => typeof t === 'string' && t.trim().length <= 40).slice(0, 8)
      : [];
    if (aiTags.length > 0) {
      try {
        for (const label of aiTags) {
          const trimmed = label.trim();
          if (!trimmed) continue;
          let tag = await this.prisma.tag.findFirst({
            where: { companyId: lead.companyId, name: trimmed },
          });
          if (!tag) {
            tag = await this.prisma.tag.create({
              data: { companyId: lead.companyId, name: trimmed, displayName: trimmed, color: '#6366f1' },
            });
          }
          const existing = await this.prisma.leadTag.findUnique({
            where: { leadId_tagId: { leadId: lead.id, tagId: tag.id } },
          });
          if (!existing) {
            await this.prisma.leadTag.create({
              data: { leadId: lead.id, tagId: tag.id, createdBy: currentUser.id },
            });
          }
        }
      } catch (e) {
        // 标签落库失败不阻断分析返回
      }
    }

    const artifact = await this.prisma.aiArtifact.create({
      data: {
        companyId: lead.companyId, leadId,
        artifactType: 'customer_analysis',
        inputContent: prompt, outputContent: JSON.stringify(analysis),
        extraData: { leadName: lead.companyName, generatedBy: 'zhipu' },
        provider: 'zhipu', model: this.ai.getModel(), status: 'generated',
      },
    });

    return { id: artifact.id, analysis };
  }

  /** Generate reply suggestions from raw chat context (WhatsApp integration, no DB message required)
   *  返回 4 变体（标准/简短/详细/中文对照），并保留 replies 数组以兼容现有调用方。 */
  async generateReplyFromContext(context: string, currentUser: any, targetLanguage: string = 'en') {
    const resolvedLang = normalizeLanguage(targetLanguage);
    const targetLanguageName = getLanguageName(resolvedLang);

    const systemPrompt =
      `You are a professional foreign trade (export) customer service assistant. ` +
      `Based on the recent chat context, generate 4 reply variants in strict JSON:\n` +
      `- "standard": a standard professional reply in ${targetLanguageName}\n` +
      `- "brief": a short and concise reply in ${targetLanguageName}\n` +
      `- "detailed": a more detailed reply in ${targetLanguageName}\n` +
      `- "chinese": the Chinese translation of the standard reply (for the operator's reference)\n` +
      `Each reply should be professional, polite, and appropriate for business communication. ` +
      `Keep replies concise (1-3 sentences). Return JSON only, e.g.:\n` +
      `{"standard":"...","brief":"...","detailed":"...","chinese":"..."}`;

    const userPrompt = `Recent chat context:\n${context}\n\nGenerate the 4 reply variants (standard/brief/detailed/chinese). Return JSON only.`;

    const result = await this.ai.chat(systemPrompt, userPrompt, { task: 'reply_suggestion_wa' });

    const variants = this.parseReplyVariants(result.content);

    return {
      variants,
      replies: [variants.standard, variants.brief, variants.detailed, variants.chinese],
      language: resolvedLang,
      aiEnabled: result.reason === 'success',
    };
  }

  /** 解析 AI 回复变体输出为 {standard, brief, detailed, chinese}。
   *  兼容新格式 {variants:{...}} / {standard,brief,detailed,chinese} 与旧格式 {replies:[...]}。 */
  private parseReplyVariants(raw: string): Record<'standard' | 'brief' | 'detailed' | 'chinese', string> {
    const keys = ['standard', 'brief', 'detailed', 'chinese'] as const;
    const variants: Record<string, string> = {};
    const pick = (obj: any) => {
      for (const key of keys) {
        if (!variants[key] && typeof obj?.[key] === 'string' && obj[key].trim()) {
          variants[key] = obj[key].trim();
        }
      }
    };

    try {
      const cleaned = raw.replace(/```json\s*/gi, '').replace(/```\s*$/g, '').trim();
      const parsed = JSON.parse(cleaned);
      if (parsed && typeof parsed === 'object') {
        pick(parsed.variants && typeof parsed.variants === 'object' ? parsed.variants : parsed);
        if (Object.keys(variants).length === 0 && Array.isArray(parsed.replies)) {
          const list = parsed.replies.filter((r: any) => typeof r === 'string' && r.trim().length > 0);
          ['standard', 'brief', 'detailed'].forEach((key, idx) => {
            if (list[idx]) variants[key] = String(list[idx]).trim();
          });
        }
      }
    } catch {
      // fall through to line-based parsing
    }

    if (Object.keys(variants).length === 0) {
      const lines = raw.split('\n')
        .filter((l: string) => /^[1234][.)、]\s*/.test(l.trim()))
        .map((l: string) => l.replace(/^[1234][.)、]\s*/, '').trim());
      ['standard', 'brief', 'detailed'].forEach((key, idx) => { if (lines[idx]) variants[key] = lines[idx]; });
    }

    const defaults: Record<string, string> = {
      standard: 'Thank you for your message. I will get back to you shortly.',
      brief: 'Thanks for your message! I will get back to you soon.',
      detailed: 'Thank you for reaching out. We have received your inquiry and will get back to you shortly with the details you requested.',
      chinese: '（中文对照）谢谢您的留言，我们会尽快回复。',
    };
    for (const key of keys) {
      if (!variants[key]) variants[key] = defaults[key];
    }

    return { standard: variants.standard, brief: variants.brief, detailed: variants.detailed, chinese: variants.chinese };
  }

  /** 计算回复质检的真实时序数据（由 conversation.messages 的 createdAt + direction 推导，不依赖 AI） */
  private computeReplyTiming(
    messages: { direction: string; createdAt: Date }[],
  ): {
    repliedCount: number;
    averageResponseMinutes: number;
    longestResponseMinutes: number;
    currentWaitMinutes: number;
    timedOut: boolean;
    replyPolicy: { targetMinutes: number; overdueMinutes: number };
  } {
    const replyPolicy = { targetMinutes: 60, overdueMinutes: 1440 };
    const sorted = [...messages].sort(
      (a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime(),
    );
    const isOutbound = (d: string) => d === 'outbound' || d === 'outgoing';
    const isInbound = (d: string) => d === 'inbound' || d === 'incoming';

    // 业务员（direction=outbound/outgoing）回复条数
    const repliedCount = sorted.filter(m => isOutbound(m.direction)).length;

    // 响应间隔：买家消息 -> 下一条业务员消息 的间隔分钟
    const intervals: number[] = [];
    for (let i = 0; i < sorted.length; i++) {
      if (!isInbound(sorted[i].direction)) continue;
      for (let j = i + 1; j < sorted.length; j++) {
        if (isOutbound(sorted[j].direction)) {
          const mins = (new Date(sorted[j].createdAt).getTime() - new Date(sorted[i].createdAt).getTime()) / 60000;
          if (mins >= 0) intervals.push(mins);
          break;
        }
      }
    }

    const averageResponseMinutes = intervals.length
      ? Math.round((intervals.reduce((s, v) => s + v, 0) / intervals.length) * 10) / 10
      : 0;
    const longestResponseMinutes = intervals.length
      ? Math.round(Math.max(...intervals) * 10) / 10
      : 0;

    // 当前已等待时长：最后一条消息若为买家（inbound/incoming）则为至今分钟数，否则 0
    const last = sorted[sorted.length - 1];
    const currentWaitMinutes = last && isInbound(last.direction)
      ? Math.max(0, Math.round((Date.now() - new Date(last.createdAt).getTime()) / 60000))
      : 0;

    const timedOut = currentWaitMinutes >= replyPolicy.overdueMinutes;

    return { repliedCount, averageResponseMinutes, longestResponseMinutes, currentWaitMinutes, timedOut, replyPolicy };
  }

  /** 将 nextSteps 归一化为结构化对象数组 [{title, description}]（兼容旧字符串数组） */
  private normalizeNextSteps(value: any): { title: string; description: string }[] {
    if (!Array.isArray(value)) return [];
    return value
      .map((s: any) => {
        if (typeof s === 'string') return { title: s, description: '' };
        if (s && typeof s === 'object' && typeof s.title === 'string') {
          return { title: s.title, description: typeof s.description === 'string' ? s.description : '' };
        }
        return null;
      })
      .filter((x: any): x is { title: string; description: string } => x !== null && x.title.trim().length > 0);
  }

  /** 记录业务员发送回复事件到 lead timeline（activityType=whatsapp_reply_sent） */
  async logReplySent(
    body: { conversationId: string; content: string; channel?: string },
    currentUser: any,
  ) {
    if (!body?.conversationId) throw new NotFoundException('conversationId is required');

    const conv = await this.prisma.conversation.findUnique({ where: { id: body.conversationId } });
    if (!conv) throw new NotFoundException('Conversation not found');
    this.ensureAccess(currentUser, conv.companyId);
    if (!conv.leadId) throw new NotFoundException('No lead linked to this conversation');

    const channel = body.channel || 'whatsapp';
    const content = (body.content || '').trim();
    const title = `发送回复: ${content.substring(0, 50)}`;

    const activity = await this.prisma.leadActivity.create({
      data: {
        companyId: conv.companyId,
        leadId: conv.leadId,
        userId: currentUser.id,
        activityType: 'whatsapp_reply_sent',
        title,
        description: content ? content.substring(0, 500) : null,
        metadata: { channel, generatedBy: 'salesperson' },
        occurredAt: new Date(),
      },
    });

    return {
      recorded: true,
      activityId: activity.id,
      activityType: activity.activityType,
      title,
      metadata: { channel, generatedBy: 'salesperson' },
    };
  }

  /** Accept or reject an AI artifact */
  async updateArtifactStatus(artifactId: string, status: string, currentUser: any, modifiedOutput?: string) {
    const VALID_STATUSES = ['generated', 'accepted', 'rejected', 'modified'];
    if (!VALID_STATUSES.includes(status)) throw new ForbiddenException(`Invalid status: ${status}`);

    const artifact = await this.prisma.aiArtifact.findUnique({ where: { id: artifactId } });
    if (!artifact) throw new Error('Artifact not found');
    this.ensureAccess(currentUser, artifact.companyId);

    const data: any = { status };
    if (status === 'accepted') { data.acceptedBy = currentUser.id; data.acceptedAt = new Date(); }
    if (status === 'rejected') { data.rejectedBy = currentUser.id; data.rejectedAt = new Date(); }
    if (modifiedOutput) data.modifiedOutput = modifiedOutput;

    return this.prisma.aiArtifact.update({ where: { id: artifactId }, data });
  }

  // ========== Access Control ==========

  private async checkMessageAccess(conversationId: string, currentUser: any) {
    const conv = await this.prisma.conversation.findUnique({ where: { id: conversationId } });
    if (!conv) throw new Error('Conversation not found');
    this.ensureAccess(currentUser, conv.companyId);
  }

  private ensureAccess(currentUser: any, companyId: string) {
    try { ensureCompanyAccess(currentUser, companyId); }
    catch (err: any) { throw new ForbiddenException(err.message?.replace('FORBIDDEN: ', '') || 'Access denied'); }
  }

  private async getCompanyFromMessage(msg: any): Promise<string> {
    const conv = await this.prisma.conversation.findUnique({ where: { id: msg.conversationId } });
    return conv?.companyId || '';
  }
}
