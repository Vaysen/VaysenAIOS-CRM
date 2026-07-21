import { Injectable, NotFoundException, ForbiddenException, Logger, BadRequestException } from '@nestjs/common';
import { PrismaService } from '../../common/prisma/prisma.service';
import { QueryConversationsDto } from './dto/query-conversations.dto';
import { CreateWebsiteInquiryDto } from './dto/create-website-inquiry.dto';
import { CreateMessageDto } from './dto/create-message.dto';
import { WhatsAppService } from '../whatsapp/whatsapp.service';
import { RealtimeEventBus } from '../../common/realtime/realtime-event-bus';
// TASK-102E: 复用 customer-identity 归一化纯函数, 移除截断国家码的本地 normalizePhone
import type { CountryCode } from 'libphonenumber-js';
import { normalizeEmailIdentity } from '../customer-identity/domain/normalize-email';
import { normalizePhoneIdentity } from '../customer-identity/domain/normalize-phone';
import { resolveSafeUploadPath } from './attachment-security';

@Injectable()
export class CommunicationsService {
  private readonly logger = new Logger(CommunicationsService.name);

  constructor(
    private prisma: PrismaService,
    private whatsappService: WhatsAppService,
    private eventBus: RealtimeEventBus,
  ) {}

  // ========== Conversation list ==========

  async findConversations(query: QueryConversationsDto, currentUser: any) {
    const page = query.page || 1;
    const limit = query.limit || 20;
    const skip = (page - 1) * limit;

    const where: any = this.buildCompanyWhere(currentUser);

    if (query.channel) where.channel = query.channel;
    if (query.status) where.status = query.status;
    if (query.leadId) where.leadId = query.leadId;
    if (query.assignedUserId) where.assignedUserId = query.assignedUserId;
    if (query.keyword) {
      where.OR = [
        { subject: { contains: query.keyword, mode: 'insensitive' } },
        { lastMessagePreview: { contains: query.keyword, mode: 'insensitive' } },
      ];
    }

    const [data, total] = await Promise.all([
      this.prisma.conversation.findMany({
        where,
        include: {
          lead: { select: { id: true, companyName: true, contactName: true, contactEmail: true, contactPhone: true, whatsapp: true, country: true, language: true, status: true, leadGrade: true, sourceType: true, website: true, nextFollowUpAt: true, lastContactedAt: true, updatedAt: true, createdAt: true, tags: { include: { tag: true } }, pins: { where: { userId: currentUser.id }, select: { id: true } } } },
          contactPoint: { select: { id: true, type: true, originalValue: true, normalizedValue: true, avatarUrl: true } },
          assignedUser: { select: { id: true, firstName: true, lastName: true } },
          _count: { select: { messages: true } },
        },
        skip,
        take: limit,
        orderBy: { lastMessageAt: { sort: 'desc', nulls: 'last' } },
      }),
      this.prisma.conversation.count({ where }),
    ]);

    const now = new Date();
    const mapped = data.map((c: any) => ({
      ...c,
      isPinned: c.lead?.pins?.length > 0,
      hasPendingFollowUp: c.lead?.nextFollowUpAt ? new Date(c.lead.nextFollowUpAt) <= now : false,
      lead: c.lead ? { ...c.lead, pins: undefined } : null,
    }));

    return { data: mapped, meta: { page, limit, total, totalPages: Math.ceil(total / limit) } };
  }

  // ========== Create conversation (WhatsApp auto-archiving) ==========

  async createConversation(body: { channel?: string; leadId?: string; contactPhone?: string; subject?: string; status?: string }, currentUser: any) {
    const companyId = currentUser.companies?.[0]?.id;
    if (!companyId) {
      throw new ForbiddenException('No company associated with user');
    }
    const channel = body.channel || 'whatsapp';
    const status = body.status || 'active';
    const subject = body.subject || body.contactPhone || 'WhatsApp Conversation';

    // WhatsApp auto-archiving must leave a durable, exact identity anchor.
    // Ambiguous local numbers are rejected instead of being guessed/merged.
    const phoneIdentity = body.contactPhone
      ? normalizePhoneIdentity(body.contactPhone)
      : null;
    if (body.contactPhone && phoneIdentity?.status !== 'resolved') {
      throw new BadRequestException('WhatsApp contactPhone must be a valid E.164 number');
    }
    const normalizedPhone = phoneIdentity?.status === 'resolved' ? phoneIdentity.e164 : null;

    // Check if conversation already exists for this lead + channel
    if (body.leadId) {
      const existing = await this.prisma.conversation.findFirst({
        where: { leadId: body.leadId, channel, companyId },
      });
      if (existing) {
        if (normalizedPhone) {
          await this.prisma.$transaction(async (tx) => {
            const contactPointId = await this.ensureWhatsAppContactPoint(
              tx,
              companyId,
              body.leadId!,
              body.contactPhone!,
              normalizedPhone,
            );
            await tx.conversation.update({
              where: { id: existing.id },
              data: { contactPointId, externalThreadId: normalizedPhone },
            });
          });
        }
        // Return existing conversation with lead info
        return this.findConversation(existing.id, currentUser);
      }
    }

    const conv = await this.prisma.$transaction(async (tx) => {
      let contactPointId: string | null = null;
      if (normalizedPhone) {
        contactPointId = await this.ensureWhatsAppContactPoint(
          tx,
          companyId,
          body.leadId || null,
          body.contactPhone!,
          normalizedPhone,
        );
      }

      return tx.conversation.create({
        data: {
          companyId,
          leadId: body.leadId || null,
          contactPointId,
          channel,
          subject,
          status,
          externalThreadId: normalizedPhone,
        },
      });
    });

    // Return full conversation detail (same shape as findConversation)
    return this.findConversation(conv.id, currentUser);
  }

  private async ensureWhatsAppContactPoint(
    tx: any,
    companyId: string,
    leadId: string | null,
    originalPhone: string,
    normalizedPhone: string,
  ): Promise<string> {
    const point = await tx.contactPoint.upsert({
      where: {
        companyId_type_normalizedValue: {
          companyId,
          type: 'whatsapp',
          normalizedValue: normalizedPhone,
        },
      },
      create: {
        companyId,
        leadId,
        type: 'whatsapp',
        originalValue: originalPhone,
        normalizedValue: normalizedPhone,
        isVerified: true,
        verificationMethod: 'whatsapp_jid',
        verifiedAt: new Date(),
      },
      update: {},
      select: { id: true, leadId: true },
    });

    if (point.leadId && leadId && point.leadId !== leadId) {
      throw new BadRequestException('WhatsApp number is already linked to another customer; manual review required');
    }
    if (!point.leadId && leadId) {
      await tx.contactPoint.update({ where: { id: point.id }, data: { leadId } });
    }
    return point.id;
  }

  // ========== Conversation detail ==========

  async findConversation(id: string, currentUser: any) {
    const conv = await this.prisma.conversation.findUnique({
      where: { id },
      include: {
        lead: { select: { id: true, companyName: true, contactName: true, contactEmail: true, contactPhone: true, country: true, status: true, leadGrade: true, tags: { include: { tag: true } }, pins: { where: { userId: currentUser.id }, select: { id: true } } } },
        assignedUser: { select: { id: true, firstName: true, lastName: true } },
        contactPoint: true,
        messages: {
          orderBy: { createdAt: 'asc' },
        },
        aiArtifacts: {
          where: { status: { not: 'rejected' } },
          orderBy: { createdAt: 'desc' },
        },
      },
    });

    if (!conv) throw new NotFoundException('Conversation not found');
    this.checkCompanyAccess(currentUser, conv.companyId);

    const leadData: any = conv.lead || {};
    const isPinned = Array.isArray(leadData.pins) && leadData.pins.length > 0;
    const { pins: _pins, ...cleanLead } = leadData;
    return { ...conv, isPinned, lead: conv.lead ? cleanLead : null };
  }

  // ========== Website inquiry ==========

  async createWebsiteInquiry(dto: CreateWebsiteInquiryDto) {
    // 1. Find or derive companyId (use first active company as default for inquiries)
    const company = await this.prisma.company.findFirst({
      where: { isActive: true },
      orderBy: { createdAt: 'asc' },
    });
    if (!company) throw new NotFoundException('No active company found');
    const companyId = company.id;

    const normalizedEmail = normalizeEmailIdentity(dto.email) ?? dto.email.toLowerCase().trim();
    // TASK-102E: 复用 normalizePhoneIdentity (保留国家码 E.164), 不再截断 86 前缀
    const phoneIdentity = dto.phone
      ? normalizePhoneIdentity(dto.phone, dto.country as CountryCode | undefined)
      : null;
    const normalizedPhone =
      phoneIdentity && phoneIdentity.status === 'resolved'
        ? phoneIdentity.e164
        : phoneIdentity && phoneIdentity.status === 'needs_country'
          ? phoneIdentity.rawDigits
          : null;

    // 2. Find or create ContactPoint for email
    let emailContactPoint = await this.prisma.contactPoint.findFirst({
      where: { companyId, type: 'email', normalizedValue: normalizedEmail },
    });
    if (!emailContactPoint) {
      emailContactPoint = await this.prisma.contactPoint.create({
        data: {
          companyId,
          type: 'email',
          originalValue: dto.email,
          normalizedValue: normalizedEmail,
          isVerified: false,
        },
      });
    }

    // 3. Find or create ContactPoint for phone (if provided)
    let phoneContactPoint = null;
    if (normalizedPhone) {
      phoneContactPoint = await this.prisma.contactPoint.findFirst({
        where: { companyId, type: 'phone', normalizedValue: normalizedPhone },
      });
      if (!phoneContactPoint) {
        phoneContactPoint = await this.prisma.contactPoint.create({
          data: {
            companyId,
            type: 'phone',
            originalValue: dto.phone!,
            normalizedValue: normalizedPhone,
            isVerified: false,
          },
        });
      }
    }

    // 4. Match existing lead — priority: email ContactPoint.leadId → phone ContactPoint.leadId → Lead by normalized email
    let lead = emailContactPoint.leadId
      ? await this.prisma.lead.findFirst({
          where: { id: emailContactPoint.leadId, companyId, deletedAt: null },
        })
      : null;

    if (!lead && phoneContactPoint?.leadId) {
      lead = await this.prisma.lead.findFirst({
        where: { id: phoneContactPoint.leadId, companyId, deletedAt: null },
      });
    }

    if (!lead) {
      // Search by normalized email (case-insensitive) rather than exact match
      lead = await this.prisma.lead.findFirst({
        where: {
          companyId,
          contactEmail: { equals: normalizedEmail, mode: 'insensitive' },
          deletedAt: null,
        },
      });
    }

    // 5. Create lead if still not found
    const isNewLead = !lead;
    if (!lead) {
      lead = await this.prisma.lead.create({
        data: {
          companyId,
          companyName: dto.companyName || dto.contactName,
          contactName: dto.contactName,
          contactEmail: dto.email,
          contactPhone: dto.phone || null,
          country: dto.country || null,
          sourceType: 'website_inquiry',
          sourceUrl: dto.pageUrl || null,
          status: 'new',
          reviewStatus: 'pending',
          notes: `Inquiry via ${dto.source}: ${dto.subject}`,
        },
      });
    }

    // 6. Backfill ContactPoint → Lead links
    if (!emailContactPoint.leadId) {
      await this.prisma.contactPoint.update({
        where: { id: emailContactPoint.id },
        data: { leadId: lead.id },
      });
    }
    if (phoneContactPoint && !phoneContactPoint.leadId) {
      await this.prisma.contactPoint.update({
        where: { id: phoneContactPoint.id },
        data: { leadId: lead.id },
      });
    }

    // 7. Log lead creation if new
    if (isNewLead) {
      await this.logTimelineEvent(companyId, lead.id, null, 'lead_created',
        `New lead from ${dto.source}`, dto.pageUrl);
    }

    // 8. Create conversation
    const conversation = await this.prisma.conversation.create({
      data: {
        companyId,
        leadId: lead.id,
        contactPointId: emailContactPoint.id,
        channel: 'website_inquiry',
        subject: dto.subject,
        lastMessageAt: new Date(),
        lastMessagePreview: dto.message.substring(0, 200),
        unreadCount: 1,
      },
    });

    // 9. Create first message
    const message = await this.prisma.communicationMessage.create({
      data: {
        conversationId: conversation.id,
        direction: 'inbound',
        content: dto.message,
        contentType: 'text',
        fromAddress: dto.email,
        subject: dto.subject,
        attachmentsMeta: dto.attachments ?? undefined,
        receivedAt: new Date(),
      },
    });

    // 10. Log timeline event (reuse or new lead)
    await this.logTimelineEvent(companyId, lead.id, message.id, 'website_inquiry',
      `Website inquiry: ${dto.subject}`, dto.pageUrl,
      { source: dto.source, utmSource: dto.utmSource, utmMedium: dto.utmMedium, isNewLead });

    // 11. Return full conversation
    return this.prisma.conversation.findUnique({
      where: { id: conversation.id },
      include: {
        lead: { select: { id: true, companyName: true, contactName: true, contactEmail: true, country: true } },
        messages: true,
      },
    });
  }

  // ========== Add message to conversation ==========

  async addMessage(conversationId: string, dto: CreateMessageDto, currentUser: any) {
    const conversation = await this.prisma.conversation.findUnique({
      where: { id: conversationId },
      include: {
        lead: { select: { id: true, whatsapp: true, contactPhone: true } },
        contactPoint: { select: { id: true, type: true, originalValue: true, normalizedValue: true } },
      },
    });
    if (!conversation) throw new NotFoundException('Conversation not found');
    this.checkCompanyAccess(currentUser, conversation.companyId);
    let providerIngestionKey: string | null = null;

    // 如果是 WhatsApp 渠道的出站消息，通过 WhatsApp 实际发送
    if (conversation.channel === 'whatsapp' && dto.direction === 'outbound') {
      if (!conversation.whatsappSessionId) {
        throw new BadRequestException(
          'WhatsApp conversation is not bound to a sending account',
        );
      }
      // 获取客户 WhatsApp 地址 — 优先用 externalThreadId（完整 JID，支持 LID 隐私格式）
      // externalThreadId 包含 @lid / @s.whatsapp.net / @g.us 等完整后缀
      // 如果没有 externalThreadId，回退到 contactPoint.originalValue 或 lead.whatsapp
      const customerAddress =
        conversation.externalThreadId ||
        conversation.contactPoint?.originalValue ||
        conversation.lead?.whatsapp ||
        conversation.lead?.contactPhone ||
        '';

      if (!customerAddress) {
        throw new BadRequestException(
          `No customer WhatsApp address found for conversation ${conversationId}`,
        );
      }
      try {
          // 判断是文本消息还是媒体消息
          const isMediaMessage = dto.contentType === 'image' || dto.contentType === 'document' || dto.contentType === 'video' || dto.contentType === 'audio';
          const attachments = dto.attachmentsMeta as any;

          if (isMediaMessage && attachments) {
            // 媒体消息 — 通过 sendMediaOnly 发送
            this.logger.log(`Sending WhatsApp media (${dto.contentType}) to ${customerAddress}`);

            // 从附件中获取文件路径，读取为 Buffer 传给 Baileys
            const fileUrl = attachments.url || attachments.path || '';
            const fs = require('fs');
            const filePath = resolveSafeUploadPath(fileUrl);

            let mediaBuffer: Buffer | undefined;
            try {
              if (fs.existsSync(filePath)) {
                mediaBuffer = fs.readFileSync(filePath);
                this.logger.log(`Loaded validated media file (${mediaBuffer!.length} bytes)`);
              } else {
                this.logger.error(`Media file not found: ${filePath}`);
                throw new Error(`附件文件不存在: ${attachments.originalName || fileUrl}`);
              }
            } catch (err: any) {
              this.logger.error(`Failed to read media file: ${err?.message}`);
              throw new Error(`无法读取附件文件: ${err?.message}`);
            }

            const result = await this.whatsappService.sendMediaOnly(
              conversation.whatsappSessionId,
              customerAddress,
              {
                type: dto.contentType as 'image' | 'document' | 'video' | 'audio',
                buffer: mediaBuffer,
                filename: attachments.originalName || attachments.filename || 'file',
                caption: dto.content || undefined,
                mimeType: attachments.mimeType,
              },
              currentUser,
            );

            this.logger.log(`WhatsApp media sent successfully: ${result.messageId}`);
            dto.externalMessageId = result.providerMessageId;
            providerIngestionKey = this.whatsappService.buildMessageIngestionKey(
              conversation.companyId,
              conversation.whatsappSessionId,
              result.providerMessageId,
            );
            dto.fromAddress = dto.fromAddress || 'whatsapp-session';
            dto.sentAt = result.acceptedAt;
          } else {
            // 文本消息 — 通过 sendTextOnly 发送
            this.logger.log(`Sending WhatsApp message to ${customerAddress} via session ${conversation.whatsappSessionId}`);
            const result = await this.whatsappService.sendTextOnly(
              conversation.whatsappSessionId,
              customerAddress,
              dto.content,
              currentUser,
            );

            this.logger.log(`WhatsApp message sent successfully: ${result.messageId}`);
            dto.externalMessageId = result.providerMessageId;
            providerIngestionKey = this.whatsappService.buildMessageIngestionKey(
              conversation.companyId,
              conversation.whatsappSessionId,
              result.providerMessageId,
            );
            dto.fromAddress = dto.fromAddress || 'whatsapp-session';
            dto.sentAt = result.acceptedAt;
          }
        } catch (err: any) {
          this.logger.error(`Failed to send WhatsApp message: ${err?.message}`, err?.stack);
          // Never write an outbound CRM row when the provider call failed.
          throw err;
        }
    }

    let message: any;
    try {
      message = await this.prisma.communicationMessage.create({
        data: {
          conversationId,
          direction: dto.direction,
          content: dto.content,
          contentType: dto.contentType || 'text',
          externalMessageId: dto.externalMessageId || null,
          ingestionKey: providerIngestionKey,
          fromAddress: dto.fromAddress || null,
          toAddress: dto.toAddress || null,
          subject: dto.subject || null,
          attachmentsMeta: dto.attachmentsMeta ?? undefined,
          deliveryStatus: providerIngestionKey ? 'sent' : null,
          sentAt: dto.sentAt ? new Date(dto.sentAt) : null,
          receivedAt: dto.receivedAt ? new Date(dto.receivedAt) : null,
        },
      });
    } catch (error) {
      const candidate = error as { code?: string; meta?: { target?: unknown } };
      if (
        providerIngestionKey
        && candidate?.code === 'P2002'
        && String(candidate.meta?.target || '').includes('ingestionKey')
      ) {
        const existing = await this.prisma.communicationMessage.findUnique({
          where: { ingestionKey: providerIngestionKey },
        });
        if (existing) return existing;
      }
      throw error;
    }

    // Update conversation
    const isMediaOutbound = dto.direction === 'outbound' && ['image', 'video', 'audio', 'document'].includes(dto.contentType || '');
    let previewText = dto.content;
    if (isMediaOutbound && (!previewText || !previewText.trim())) {
      const typeLabels: Record<string, string> = {
        image: '[图片]',
        video: '[视频]',
        audio: '[语音消息]',
        document: '[文档]',
      };
      previewText = typeLabels[dto.contentType!] || '[附件]';
    }
    await this.prisma.conversation.update({
      where: { id: conversationId },
      data: {
        lastMessageAt: new Date(),
        lastMessagePreview: previewText.substring(0, 200),
        unreadCount: dto.direction === 'inbound'
          ? { increment: 1 }
          : conversation.unreadCount,
      },
    });

    // 发射实时事件 — 推送给前端 SSE
    this.eventBus.emit('conversation.update', {
      companyId: conversation.companyId,
      conversationId,
      leadId: conversation.leadId,
      direction: dto.direction,
      messagePreview: previewText.substring(0, 200),
      timestamp: new Date().toISOString(),
    });

    // Log timeline if linked to lead
    if (conversation.leadId) {
      const activityType = dto.direction === 'inbound' ? 'message_received' : 'message_sent';
      await this.logTimelineEvent(
        conversation.companyId,
        conversation.leadId,
        message.id,
        activityType,
        `${dto.direction === 'inbound' ? 'Received' : 'Sent'} message`,
        dto.content.substring(0, 200),
      );
    }

    return message;
  }

  // ========== Helpers ==========

  // normalizePhone (截断 86 前缀) 已移除 — TASK-102E: 复用 customer-identity/domain/normalize-phone

  // ========== File upload ==========

  uploadAttachment(file: Express.Multer.File) {
    if (!file) throw new NotFoundException('No file provided');
    const url = `/uploads/${file.filename}`;
    // 判断媒体类型
    let mediaType = 'document';
    if (file.mimetype.startsWith('image/')) mediaType = 'image';
    else if (file.mimetype.startsWith('video/')) mediaType = 'video';
    else if (file.mimetype.startsWith('audio/')) mediaType = 'audio';

    return {
      url,
      originalName: file.originalname,
      filename: file.filename,
      mimeType: file.mimetype,
      mediaType,
      size: file.size,
    };
  }

  // ========== Status management ==========

  async updateConversationStatus(id: string, status: string, currentUser: any) {
    const conv = await this.prisma.conversation.findUnique({ where: { id } });
    if (!conv) throw new NotFoundException('Conversation not found');
    this.checkCompanyAccess(currentUser, conv.companyId);

    if (!['active', 'archived', 'closed'].includes(status)) {
      throw new NotFoundException('Invalid status. Use active, archived, or closed.');
    }

    return this.prisma.conversation.update({
      where: { id },
      data: { status },
    });
  }

  // ========== Read receipts ==========

  async markConversationRead(id: string, currentUser: any) {
    const conv = await this.prisma.conversation.findUnique({ where: { id } });
    if (!conv) throw new NotFoundException('Conversation not found');
    this.checkCompanyAccess(currentUser, conv.companyId);

    await this.prisma.communicationMessage.updateMany({
      where: { conversationId: id, direction: 'inbound', readAt: null },
      data: { readAt: new Date() },
    });

    await this.prisma.conversation.update({
      where: { id },
      data: { unreadCount: 0 },
    });

    return { success: true };
  }

  // ========== Assignment ==========

  async assignConversation(id: string, assignedUserId: string | null, currentUser: any) {
    const conv = await this.prisma.conversation.findUnique({ where: { id } });
    if (!conv) throw new NotFoundException('Conversation not found');
    this.checkCompanyAccess(currentUser, conv.companyId);

    return this.prisma.conversation.update({
      where: { id },
      data: { assignedUserId: assignedUserId || null },
      include: {
        assignedUser: { select: { id: true, firstName: true, lastName: true } },
      },
    });
  }

  private async logTimelineEvent(
    companyId: string,
    leadId: string,
    communicationMessageId: string | null,
    activityType: string,
    title: string,
    description?: string | null,
    metadata?: Record<string, any>,
  ) {
    await this.prisma.leadActivity.create({
      data: {
        companyId,
        leadId,
        communicationMessageId,
        activityType,
        title,
        description: description || null,
        metadata: metadata ?? undefined,
        occurredAt: new Date(),
      },
    });
  }

  private buildCompanyWhere(currentUser: any): any {
    const companyIds = (currentUser as any)?.companies?.map((c: any) => c.id) || [];
    if (companyIds.length === 0) return { companyId: '' };
    return { companyId: { in: companyIds } };
  }

  private checkCompanyAccess(currentUser: any, companyId: string) {
    const companyIds = (currentUser as any)?.companies?.map((c: any) => c.id) || [];
    if (companyIds.length === 0 || !companyIds.includes(companyId)) {
      throw new NotFoundException('Conversation not found in your companies');
    }
  }
}
