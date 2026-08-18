import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  InternalServerErrorException,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { createHmac, timingSafeEqual } from 'crypto';
import * as path from 'path';
import { PrismaService } from '../../common/prisma/prisma.service';
import { QueryConversationsDto } from './dto/query-conversations.dto';
import { CreateWebsiteInquiryDto } from './dto/create-website-inquiry.dto';
import { CreateMessageDto } from './dto/create-message.dto';
import {
  CONVERSATION_STATUSES,
  CreateConversationDto,
  USER_CREATABLE_CONVERSATION_CHANNELS,
} from './dto/create-conversation.dto';
import { WhatsAppService } from '../whatsapp/whatsapp.service';
import { RealtimeEventBus } from '../../common/realtime/realtime-event-bus';
// TASK-102E: 复用 customer-identity 归一化纯函数, 移除截断国家码的本地 normalizePhone
import type { CountryCode } from 'libphonenumber-js';
import { normalizeEmailIdentity } from '../customer-identity/domain/normalize-email';
import { normalizePhoneIdentity } from '../customer-identity/domain/normalize-phone';
import {
  getUploadsRoot,
  resolveSafeUploadPath,
  resolveScopedCommunicationUploadPath,
} from './attachment-security';
import {
  assertFixedWindowRateLimit,
  envLimit,
} from '../../common/security/request-security';
import { safeLogEvent } from '../../common/security/safe-logging';

function pathRelativeForUploadUrl(root: string, filePath: string): string {
  return path.relative(path.resolve(root), filePath).split(path.sep).join('/');
}

@Injectable()
export class CommunicationsService {
  private readonly logger = new Logger(CommunicationsService.name);

  constructor(
    private prisma: PrismaService,
    private whatsappService: WhatsAppService,
    private eventBus: RealtimeEventBus,
  ) {}

  private normalizeConversationPhone(input: string): string | null {
    const raw = String(input ?? '').trim();
    if (!raw) return null;
    const identity = normalizePhoneIdentity(raw);
    if (identity.status === 'resolved') return identity.e164;
    if (identity.kind === 'jid' || identity.kind === 'lid') {
      return raw.toLowerCase();
    }
    return null;
  }

  private appendConversationIdentityFilters(
    where: Record<string, any>,
    query: QueryConversationsDto,
  ) {
    if (query.leadId !== undefined) where.leadId = query.leadId;
    if (query.channel !== undefined) where.channel = query.channel;
    if (query.sessionId !== undefined) where.whatsappSessionId = query.sessionId;

    if (query.phone !== undefined) {
      const normalizedPhone = this.normalizeConversationPhone(query.phone);
      const and = Array.isArray(where.AND) ? [...where.AND] : [];
      if (!normalizedPhone) {
        and.push({ id: '__no_matching_conversation__' });
      } else {
        and.push({
          OR: [
            { contactPoint: { is: { normalizedValue: normalizedPhone } } },
            { lead: { is: { contactPhone: normalizedPhone } } },
            { lead: { is: { whatsapp: normalizedPhone } } },
          ],
        });
      }
      where.AND = and;
    }
  }

  // ========== Conversation list ==========

  async findConversations(query: QueryConversationsDto, currentUser: any) {
    const page = query.page || 1;
    const limit = query.limit || 20;
    const skip = (page - 1) * limit;

    const { companyId, role } = await this.resolveActiveCompany(currentUser);
    const where: any = this.scopedConversationWhere(
      companyId,
      undefined,
      role,
      currentUser.id,
    );

    if (query.channel) where.channel = query.channel;
    if (query.status) where.status = query.status;
    this.appendConversationIdentityFilters(where, query);
    if (query.assignedUserId) where.assignedUserId = query.assignedUserId;
    if (query.keyword) {
      const and = Array.isArray(where.AND) ? [...where.AND] : [];
      and.push({
        OR: [
          { subject: { contains: query.keyword, mode: 'insensitive' } },
          { lastMessagePreview: { contains: query.keyword, mode: 'insensitive' } },
        ],
      });
      where.AND = and;
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

  async createConversation(body: CreateConversationDto, currentUser: any) {
    const { companyId, role } = await this.resolveActiveCompany(currentUser);
    if (role === 'viewer') {
      throw new ForbiddenException('Viewer accounts cannot create conversations');
    }
    const allowedFields = new Set([
      'channel',
      'leadId',
      'contactPhone',
      'subject',
      'status',
    ]);
    const unexpectedField = Object.keys(body).find(
      (field) => !allowedFields.has(field),
    );
    if (unexpectedField) {
      throw new BadRequestException(
        `Conversation field is not accepted: ${unexpectedField}`,
      );
    }
    if (body.contactPhone !== undefined) {
      throw new BadRequestException(
        'Manual WhatsApp identity binding is unavailable; use trusted provider ingestion',
      );
    }
    const channel = body.channel || 'whatsapp';
    const status = body.status || 'active';
    if (!USER_CREATABLE_CONVERSATION_CHANNELS.includes(channel as any)) {
      throw new BadRequestException('Unsupported conversation channel');
    }
    if (!CONVERSATION_STATUSES.includes(status as any)) {
      throw new BadRequestException('Unsupported conversation status');
    }
    const subject = body.subject || 'WhatsApp Conversation';

    let lead: { id: string; ownerUserId: string | null } | null = null;
    if (body.leadId) {
      lead = await this.prisma.lead.findFirst({
        where: { id: body.leadId, companyId, deletedAt: null },
        select: { id: true, ownerUserId: true },
      });
      if (!lead) throw new NotFoundException('Lead not found');
    }
    const isolated = !this.isFullAccessRole(role);
    if (isolated && (!lead || lead.ownerUserId !== currentUser.id)) {
      throw new ForbiddenException(
        'Isolated users can create conversations only for their assigned leads',
      );
    }

    // Check if conversation already exists for this lead + channel
    if (body.leadId) {
      const lead = await this.prisma.lead.findFirst({
        where: { id: body.leadId, companyId, deletedAt: null },
        select: { id: true },
      });
      if (!lead) {
        throw new NotFoundException('Customer not found in the active company');
      }
      const existing = await this.prisma.conversation.findFirst({
        where: {
          ...this.scopedConversationWhere(
            companyId,
            undefined,
            role,
            currentUser.id,
          ),
          leadId: body.leadId,
          channel,
        },
      });
      if (existing) {
        // Provider-owned contact, thread and session bindings are immutable here.
        return this.findConversation(existing.id, currentUser);
      }
    }

    const conv = await this.prisma.conversation.create({
      data: {
        companyId,
        leadId: body.leadId || null,
        contactPointId: null,
        channel,
        subject,
        status,
        externalThreadId: null,
        whatsappSessionId: null,
        assignedUserId: isolated ? currentUser.id : null,
      },
    });

    // Return full conversation detail (same shape as findConversation)
    return this.findConversation(conv.id, currentUser);
  }

  // ========== Conversation detail ==========

  async findConversation(
    id: string,
    currentUser: any,
    query: QueryConversationsDto = {},
  ) {
    const { companyId, role } = await this.resolveActiveCompany(currentUser);
    const where: Record<string, any> = {
      ...this.scopedConversationWhere(companyId, id, role, currentUser.id),
    };
    this.appendConversationIdentityFilters(where, query);
    const conv = await this.prisma.conversation.findFirst({
      where,
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
    const leadData: any = conv.lead || {};
    const isPinned = Array.isArray(leadData.pins) && leadData.pins.length > 0;
    const { pins: _pins, ...cleanLead } = leadData;
    return { ...conv, isPinned, lead: conv.lead ? cleanLead : null };
  }

  // ========== Website inquiry ==========

  async createWebsiteInquiry(
    dto: CreateWebsiteInquiryDto,
    requestOrigin: string,
  ) {
    const source = this.verifyWebsiteInquirySource(dto, requestOrigin);
    assertFixedWindowRateLimit(
      'communications.website-inquiry.source',
      dto.sourceKey,
      envLimit('WEBSITE_INQUIRY_RATE_LIMIT', 20, 1, 500) * 5,
      15 * 60 * 1000,
    );
    const company = await this.prisma.company.findFirst({
      where: { id: source.companyId, isActive: true },
      select: { id: true },
    });
    if (!company) {
      throw new ServiceUnavailableException(
        'Website inquiry destination is unavailable',
      );
    }
    const companyId = company.id;
    await this.prisma.publicRequestNonce.deleteMany({
      where: { expiresAt: { lt: new Date() } },
    });
    try {
      await this.prisma.publicRequestNonce.create({
        data: {
          sourceKey: dto.sourceKey,
          nonce: dto.nonce,
          expiresAt: new Date(Date.now() + 10 * 60 * 1000),
        },
      });
    } catch (error) {
      if ((error as { code?: string })?.code === 'P2002') {
        throw new BadRequestException('Duplicate website inquiry request');
      }
      throw error;
    }

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
        where: { id: emailContactPoint.id, companyId },
        data: { leadId: lead.id },
      });
    }
    if (phoneContactPoint && !phoneContactPoint.leadId) {
      await this.prisma.contactPoint.update({
        where: { id: phoneContactPoint.id, companyId },
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

    return { accepted: true };
  }

  // ========== Add message to conversation ==========

  async addMessage(conversationId: string, dto: CreateMessageDto, currentUser: any) {
    const { companyId, role } = await this.resolveActiveCompany(currentUser);
    if (role === 'viewer') {
      throw new ForbiddenException('Viewer accounts cannot write messages');
    }
    if (
      dto.direction === 'inbound'
      && !['super_admin', 'company_admin', 'sales_manager'].includes(
        role,
      )
    ) {
      throw new ForbiddenException(
        'Only trusted tenant managers can record inbound messages',
      );
    }
    const conversation = await this.prisma.conversation.findFirst({
      where: this.scopedConversationWhere(
        companyId,
        conversationId,
        role,
        currentUser.id,
      ),
      include: {
        lead: { select: { id: true, whatsapp: true, contactPhone: true } },
        contactPoint: { select: { id: true, type: true, originalValue: true, normalizedValue: true } },
      },
    });
    if (!conversation) throw new NotFoundException('Conversation not found');
    let providerIngestionKey: string | null = null;
    let scopedAttachmentPath: string | null = null;
    if (dto.attachmentsMeta) {
      const attachments = dto.attachmentsMeta as Record<string, unknown>;
      try {
        scopedAttachmentPath = resolveScopedCommunicationUploadPath(
          attachments.url,
          companyId,
          currentUser.id,
        );
      } catch (error) {
        if (error instanceof BadRequestException) {
          throw new BadRequestException({
            status: 'error',
            code: 'COMMUNICATION_ATTACHMENT_INVALID',
            message: 'Attachment reference is invalid',
          });
        }
        throw new InternalServerErrorException({
          status: 'error',
          code: 'COMMUNICATION_ATTACHMENT_NOT_FOUND',
          message: 'Attachment file could not be read',
        });
      }
    }

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
      const isEvolutionSession = typeof (this.whatsappService as any).isEvolutionSession === 'function'
        ? await this.whatsappService.isEvolutionSession(
          conversation.whatsappSessionId,
          currentUser,
        )
        : false;
      try {
          // 判断是文本消息还是媒体消息
          const isMediaMessage = dto.contentType === 'image' || dto.contentType === 'document' || dto.contentType === 'video' || dto.contentType === 'audio';
          const attachments = dto.attachmentsMeta as any;

          if (isMediaMessage && attachments) {
            // 媒体消息 — 通过 sendMediaOnly 发送
            this.logger.log(safeLogEvent('communications.whatsapp.media_send_started', {
              customerAddress,
              contentType: dto.contentType,
            }));

            // 从附件中获取文件路径，读取为 Buffer 传给 Baileys
            const fs = require('fs');
            const filePath = scopedAttachmentPath!;

            let mediaBuffer: Buffer | undefined;
            try {
              if (fs.existsSync(filePath)) {
                mediaBuffer = fs.readFileSync(filePath);
                this.logger.log(safeLogEvent('communications.whatsapp.media_loaded', {
                  bytes: mediaBuffer!.length,
                  contentType: dto.contentType,
                }));
              } else {
                this.logger.error(safeLogEvent('communications.whatsapp.media_missing', {
                  filePath,
                  contentType: dto.contentType,
                }));
                throw new InternalServerErrorException({
                  status: 'error',
                  code: 'COMMUNICATION_ATTACHMENT_NOT_FOUND',
                  message: 'Attachment file could not be read',
                });
              }
            } catch (err: any) {
              this.logger.error(safeLogEvent('communications.whatsapp.media_read_failed', {
                error: err,
                contentType: dto.contentType,
              }));
              if (err instanceof InternalServerErrorException) throw err;
              throw new InternalServerErrorException({
                status: 'error',
                code: 'COMMUNICATION_ATTACHMENT_READ_FAILED',
                message: 'Attachment file could not be read',
              });
            }

            const compliance = {
              idempotencyKey: dto.idempotencyKey || '',
              leadId: conversation.lead?.id || '',
              conversationId: conversation.id,
            };
            const mediaOptions = {
              type: dto.contentType as 'image' | 'document' | 'video' | 'audio',
              buffer: mediaBuffer,
              filename: attachments.originalName || attachments.filename || 'file',
              caption: dto.content || undefined,
              mimeType: attachments.mimeType,
            };
            const result: any = isEvolutionSession
              ? await this.whatsappService.sendEvolutionMedia(
                conversation.whatsappSessionId,
                customerAddress,
                mediaOptions,
                currentUser,
                compliance,
              )
              : await this.whatsappService.sendMediaOnly(
                conversation.whatsappSessionId,
                customerAddress,
                mediaOptions,
                currentUser,
                compliance,
              );

            this.logger.log(safeLogEvent('communications.whatsapp.media_sent', {
              messageId: result.messageId,
              status: 'accepted',
              contentType: dto.contentType,
            }));
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
            this.logger.log(safeLogEvent('communications.whatsapp.text_send_started', {
              customerAddress,
              sessionId: conversation.whatsappSessionId,
              contentType: dto.contentType,
            }));
            const compliance = {
              idempotencyKey: dto.idempotencyKey || '',
              leadId: conversation.lead?.id || '',
              conversationId: conversation.id,
            };
            const result: any = isEvolutionSession
              ? await this.whatsappService.sendEvolutionText(
                conversation.whatsappSessionId,
                customerAddress,
                dto.content,
                currentUser,
                compliance,
              )
              : await this.whatsappService.sendTextOnly(
                conversation.whatsappSessionId,
                customerAddress,
                dto.content,
                currentUser,
                compliance,
              );

            this.logger.log(safeLogEvent('communications.whatsapp.text_sent', {
              messageId: result.messageId,
              status: 'accepted',
              contentType: dto.contentType,
            }));
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
          this.logger.error(safeLogEvent('communications.whatsapp.send_failed', { error: err }));
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
        const existing = await this.prisma.communicationMessage.findFirst({
          where: {
            ingestionKey: providerIngestionKey,
            conversation: { companyId },
          },
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
    const conversationUpdate = await this.prisma.conversation.updateMany({
      where: this.scopedConversationWhere(
        companyId,
        conversationId,
        role,
        currentUser.id,
      ),
      data: {
        lastMessageAt: new Date(),
        lastMessagePreview: previewText.substring(0, 200),
        unreadCount: dto.direction === 'inbound'
          ? { increment: 1 }
          : conversation.unreadCount,
      },
    });
    if (conversationUpdate.count !== 1) {
      throw new NotFoundException('Conversation not found');
    }

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

  private verifyWebsiteInquirySource(
    dto: CreateWebsiteInquiryDto,
    requestOrigin: string,
  ): { companyId: string } {
    let parsed: unknown;
    try {
      parsed = JSON.parse(process.env.WHATSAPP_CLICK_SOURCES || '[]');
    } catch {
      throw new ServiceUnavailableException(
        'Website inquiry sources are not securely configured',
      );
    }
    if (!Array.isArray(parsed)) {
      throw new ServiceUnavailableException(
        'Website inquiry sources are not securely configured',
      );
    }
    const sources = parsed.map((candidate: any) => ({
      sourceKey: String(candidate?.sourceKey || ''),
      companyId: String(candidate?.companyId || ''),
      secret: String(candidate?.secret || ''),
      allowedOrigins: Array.isArray(candidate?.allowedOrigins)
        ? candidate.allowedOrigins.map((value: unknown) => {
            try {
              return new URL(String(value)).origin;
            } catch {
              return '';
            }
          }).filter(Boolean)
        : [],
    }));
    const sourceKeys = new Set(sources.map((candidate) => candidate.sourceKey));
    const valid = sources.length > 0
      && sourceKeys.size === sources.length
      && sources.every((candidate) =>
        /^[A-Za-z0-9._-]{3,64}$/.test(candidate.sourceKey)
        && /^[A-Za-z0-9._:-]{1,128}$/.test(candidate.companyId)
        && candidate.secret.length >= 32
        && !/change-me|replace-with|example|placeholder/i.test(
          candidate.secret,
        )
        && candidate.allowedOrigins.length > 0,
      );
    if (!valid) {
      throw new ServiceUnavailableException(
        'Website inquiry sources are not securely configured',
      );
    }
    const source = sources.find(
      (candidate) => candidate.sourceKey === dto.sourceKey,
    );
    if (!source) {
      throw new ForbiddenException('Untrusted website inquiry request');
    }

    let normalizedOrigin: string;
    try {
      normalizedOrigin = new URL(requestOrigin).origin;
    } catch {
      throw new ForbiddenException('A trusted website origin is required');
    }
    if (!source.allowedOrigins.includes(normalizedOrigin)) {
      throw new ForbiddenException('Untrusted website origin');
    }
    const nowSeconds = Math.floor(Date.now() / 1000);
    if (
      !Number.isSafeInteger(dto.timestamp)
      || Math.abs(nowSeconds - dto.timestamp) > 300
    ) {
      throw new BadRequestException('Website inquiry signature has expired');
    }

    const canonical = JSON.stringify([
      'v2',
      'website-inquiry',
      dto.sourceKey,
      dto.timestamp,
      dto.nonce,
      dto.source,
      dto.contactName,
      dto.email,
      dto.phone || '',
      dto.companyName || '',
      dto.country || '',
      dto.subject,
      dto.message,
      dto.productInterest || '',
      dto.pageUrl || '',
      dto.utmSource || '',
      dto.utmMedium || '',
      dto.utmCampaign || '',
      dto.attachments || [],
    ]);
    const expected = createHmac('sha256', source.secret)
      .update(canonical, 'utf8')
      .digest();
    const supplied = Buffer.from(dto.signature, 'hex');
    if (
      supplied.length !== expected.length
      || !timingSafeEqual(expected, supplied)
    ) {
      throw new ForbiddenException('Untrusted website inquiry request');
    }
    return { companyId: source.companyId };
  }

  // normalizePhone (截断 86 前缀) 已移除 — TASK-102E: 复用 customer-identity/domain/normalize-phone

  // ========== File upload ==========

  async uploadAttachment(file: Express.Multer.File, currentUser: any) {
    const { role } = await this.resolveActiveCompany(currentUser);
    if (role === 'viewer') {
      throw new ForbiddenException('Viewer accounts cannot upload attachments');
    }
    if (!file) throw new NotFoundException('No file provided');
    const safePath = resolveSafeUploadPath(file.path);
    const relativePath = pathRelativeForUploadUrl(getUploadsRoot(), safePath);
    const url = `/uploads/${relativePath}`;
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
    const { companyId, role } = await this.resolveActiveCompany(currentUser);
    const conv = await this.prisma.conversation.findFirst({
      where: this.scopedConversationWhere(companyId, id, role, currentUser.id),
    });
    if (!conv) throw new NotFoundException('Conversation not found');

    if (!['active', 'archived', 'closed'].includes(status)) {
      throw new NotFoundException('Invalid status. Use active, archived, or closed.');
    }

    if (role === 'viewer') {
      throw new ForbiddenException('Viewer role cannot change conversation status');
    }

    const updated = await this.prisma.conversation.updateMany({
      where: this.scopedConversationWhere(companyId, id, role, currentUser.id),
      data: { status },
    });
    if (updated.count !== 1) {
      throw new NotFoundException('Conversation not found');
    }

    return this.prisma.conversation.findFirst({
      where: this.scopedConversationWhere(companyId, id, role, currentUser.id),
    });
  }

  // ========== Read receipts ==========

  async markConversationRead(id: string, currentUser: any) {
    const { companyId, role } = await this.resolveActiveCompany(currentUser);
    const accessWhere = this.scopedConversationWhere(
      companyId,
      id,
      role,
      currentUser.id,
    );
    const conv = await this.prisma.conversation.findFirst({
      where: accessWhere,
      select: { id: true },
    });
    if (!conv) throw new NotFoundException('Conversation not found');

    await this.prisma.communicationMessage.updateMany({
      where: {
        conversationId: id,
        conversation: accessWhere,
        direction: 'inbound',
        readAt: null,
      },
      data: { readAt: new Date() },
    });

    const updated = await this.prisma.conversation.updateMany({
      where: accessWhere,
      data: { unreadCount: 0 },
    });
    if (updated.count !== 1) {
      throw new NotFoundException('Conversation not found');
    }

    return { success: true };
  }

  // ========== Assignment ==========

  async assignConversation(id: string, assignedUserId: string | null, currentUser: any) {
    const { companyId, role } = await this.resolveActiveCompany(currentUser);
    if (!this.isFullAccessRole(role)) {
      throw new ForbiddenException(
        'Only tenant administrators can assign conversations',
      );
    }
    const conv = await this.prisma.conversation.findFirst({
      where: this.scopedConversationWhere(companyId, id),
    });
    if (!conv) throw new NotFoundException('Conversation not found');
    if (assignedUserId) {
      const membership = await this.prisma.userCompanyRelation.findFirst({
        where: {
          userId: assignedUserId,
          companyId,
          isActive: true,
          user: { is: { isActive: true, deletedAt: null } },
          company: { is: { isActive: true } },
        },
        select: { id: true },
      });
      if (!membership) {
        throw new BadRequestException(
          'Assigned user is not active in the current company',
        );
      }
    }

    const result = await this.prisma.conversation.updateMany({
      where: this.scopedConversationWhere(companyId, id),
      data: { assignedUserId: assignedUserId || null },
    });
    if (result.count !== 1) throw new NotFoundException('Conversation not found');
    return this.prisma.conversation.findFirst({
      where: this.scopedConversationWhere(companyId, id),
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

  async resolveActiveCompanyId(currentUser: any): Promise<string> {
    const { companyId } = await this.resolveActiveCompany(currentUser);
    return companyId;
  }

  private async resolveActiveCompany(currentUser: any) {
    const companyId = String(currentUser?.activeCompanyId || '').trim();
    if (
      !currentUser?.id
      || !companyId
      || (currentUser?.activeCompany?.id && currentUser.activeCompany.id !== companyId)
    ) {
      throw new ForbiddenException('An explicit authenticated active company is required');
    }
    const relation = await this.prisma.userCompanyRelation.findFirst({
      where: {
        userId: currentUser.id,
        companyId,
        isActive: true,
        user: { is: { isActive: true, deletedAt: null } },
        company: { is: { isActive: true } },
      },
      include: { role: { select: { name: true } } },
    });
    const role = String(relation?.role?.name || '').trim();
    if (!role) {
      throw new ForbiddenException('Active company membership or role is no longer valid');
    }
    return { companyId, role };
  }

  private isFullAccessRole(role: string): boolean {
    return role === 'super_admin' || role === 'company_admin';
  }

  private scopedConversationWhere(
    companyId: string,
    id?: string,
    role?: string,
    operatorUserId?: string,
  ) {
    return {
      ...(id ? { id } : {}),
      companyId,
      ...(
        role && operatorUserId && !this.isFullAccessRole(role)
          ? { assignedUserId: operatorUserId }
          : {}
      ),
      AND: [
        {
          OR: [
            { leadId: null },
            { lead: { is: { companyId, deletedAt: null } } },
          ],
        },
        {
          OR: [
            { contactPointId: null },
            { contactPoint: { is: { companyId } } },
          ],
        },
      ],
    };
  }
}
