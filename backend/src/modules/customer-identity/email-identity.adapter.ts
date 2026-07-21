/**
 * TASK-102E: 邮件身份统一接入适配器
 *
 * 接入点: 所有入站邮件身份通过 EmailIdentityAdapter.ingest() 进入统一身份体系。
 *
 * 流程:
 * 1. 幂等: 按 messageId (externalMessageId) 查重, 命中则直接返回已有 lead, 不重复入库。
 * 2. 归一化邮箱: normalizeEmailIdentity (trim + toLowerCase + 结构校验)。
 * 3. 无效邮箱 -> 不调用 resolve, 邮件仍入库 (Conversation.leadId=null 挂待关联)。
 * 4. 净化显示名候选: sanitizeContactNameCandidate (系统文案 -> null)。
 * 5. 调用 IdentityResolutionService.resolve (channel='email', source='email_message')。
 * 6. 映射结果: linked/created/review_required -> 持久化会话 + 消息。
 *
 * 关系补齐: Conversation(leadId, contactPointId) + CommunicationMessage(inbound)。
 *   入站消息走 CommunicationMessage (EmailMessage.leadId 非空且绑定出站邮件账号,
 *   无法表达 leadId=null 的"挂待关联"状态; Conversation.leadId 可空)。
 *
 * 手工姓名保护: adapter 仅把 displayNameCandidate 作为 candidate 传递给 resolver,
 *   绝不直接更新 Contact; resolver 的 linked 路径不修改 manual_confirmed 字段。
 */
import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../common/prisma/prisma.service';
import { IdentityResolutionService } from './identity-resolution.service';
import { normalizeEmailIdentity } from './domain/normalize-email';
import { sanitizeContactNameCandidate } from './domain/sanitize-display-text';

/** 入站邮件身份接入命令 */
export interface IngestEmailIdentityCommand {
  /** 租户 ID (必填, 确保租户隔离) */
  companyId: string;
  /** 发件人原始邮箱 (将被归一化) */
  email: string;
  /** 发件人显示名候选 (邮件 From 头的 displayName, 经净化后作为 contactNameCandidate) */
  displayNameCandidate?: string;
  /** 邮件 Message-ID / IMAP UID, 用于幂等去重 */
  messageId: string;
  /** 邮件主题 */
  subject?: string | null;
  /** 邮件纯文本正文 (用于会话预览) */
  bodyText?: string | null;
  /** 邮件接收时间 */
  receivedAt?: Date | null;
}

/** 入站邮件身份接入结果 */
export interface IngestEmailIdentityResult {
  /** 关联到的 Lead ID (无效邮箱 / unresolved 时为 null) */
  leadId: string | null;
  /** 关联到的 ContactPoint ID (review_required / unresolved 时为 null) */
  contactPointId: string | null;
  /** 关联到的 Contact ID (review_required / unresolved 时为 null) */
  contactId: string | null;
  /** 接入动作: linked | created | review_required | unresolved */
  action: 'linked' | 'created' | 'review_required' | 'unresolved';
  /** 入库的 CommunicationMessage ID (幂等重入时返回已有消息 ID) */
  emailMessageId: string | null;
}

/** 入站邮件会话渠道标识 */
const INBOUND_EMAIL_CHANNEL = 'business_email';

@Injectable()
export class EmailIdentityAdapter {
  private readonly logger = new Logger(EmailIdentityAdapter.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly resolver: IdentityResolutionService,
  ) {}

  /**
   * 入站邮件身份接入: 归一化 -> 解析 -> 持久化会话/消息。
   * 幂等: 同一 messageId 重复调用不会创建重复消息。
   */
  async ingest(
    command: IngestEmailIdentityCommand,
  ): Promise<IngestEmailIdentityResult> {
    // ---- 1. 幂等: 按 messageId 查重 ----
    if (command.messageId) {
      const existing = await this.prisma.communicationMessage.findFirst({
        where: {
          externalMessageId: command.messageId,
          conversation: { companyId: command.companyId },
        },
        include: { conversation: true },
      });
      if (existing) {
        this.logger.debug(
          `Idempotent re-ingest for messageId=${command.messageId}; reusing leadId=${existing.conversation?.leadId ?? null}`,
        );
        return {
          leadId: existing.conversation?.leadId ?? null,
          contactPointId: existing.conversation?.contactPointId ?? null,
          contactId: null,
          action: 'linked',
          emailMessageId: existing.id,
        };
      }
    }

    // ---- 2. 归一化邮箱 ----
    const normalizedEmail = normalizeEmailIdentity(command.email);

    // ---- 3. 无效邮箱: 邮件仍入库, 但不解析身份 (leadId=null 挂待关联) ----
    if (!normalizedEmail) {
      this.logger.warn(
        `Invalid email identity; persisting message without lead: messageId=${command.messageId}`,
      );
      const msgId = await this.persistInboundMessage(
        command,
        /* leadId */ null,
        /* contactPointId */ null,
      );
      return {
        leadId: null,
        contactPointId: null,
        contactId: null,
        action: 'unresolved',
        emailMessageId: msgId,
      };
    }

    // ---- 4. 净化显示名候选 (系统文案 -> null) ----
    const sanitizedName = command.displayNameCandidate
      ? sanitizeContactNameCandidate(command.displayNameCandidate) ?? undefined
      : undefined;

    // ---- 5. 统一身份解析 ----
    const result = await this.resolver.resolve({
      companyId: command.companyId,
      channel: 'email',
      normalizedValue: normalizedEmail,
      contactNameCandidate: sanitizedName,
      source: 'email_message',
    });

    // ---- 6. 映射解析结果 ----
    let leadId: string | null = null;
    let contactPointId: string | null = null;
    let contactId: string | null = null;
    let action: IngestEmailIdentityResult['action'] = 'unresolved';

    if (result.action === 'linked' || result.action === 'created') {
      leadId = result.leadId;
      contactId = result.contactId;
      contactPointId = result.contactPointId;
      action = result.action;
    } else if (result.action === 'review_required') {
      // review_required: 新建了 Lead (挂待关联), 但 ContactPoint 不回填
      leadId = result.leadId;
      contactPointId = null;
      contactId = null;
      action = 'review_required';
    } else {
      // unresolved: 仅有外部身份无可信号码/邮箱 — 此处 normalizedEmail 非空, 理论不达
      leadId = null;
      contactPointId = null;
      contactId = null;
      action = 'unresolved';
    }

    // ---- 7. 持久化会话 + 消息 (review_required / linked / created 均入库) ----
    const emailMessageId = await this.persistInboundMessage(
      command,
      leadId,
      contactPointId,
    );

    return { leadId, contactPointId, contactId, action, emailMessageId };
  }

  /**
   * 持久化入站邮件: 创建 Conversation (关联 lead/contactPoint) + CommunicationMessage。
   * review_required / 无效邮箱时 leadId 可为 null, 会话挂待关联状态。
   */
  private async persistInboundMessage(
    command: IngestEmailIdentityCommand,
    leadId: string | null,
    contactPointId: string | null,
  ): Promise<string> {
    const receivedAt = command.receivedAt ?? new Date();
    const preview = (command.bodyText ?? '').substring(0, 200) || null;

    const conversation = await this.prisma.conversation.create({
      data: {
        companyId: command.companyId,
        leadId,
        contactPointId,
        channel: INBOUND_EMAIL_CHANNEL,
        subject: command.subject ?? null,
        externalThreadId: command.messageId ?? null,
        lastMessageAt: receivedAt,
        lastMessagePreview: preview,
        unreadCount: 1,
      },
    });

    const message = await this.prisma.communicationMessage.create({
      data: {
        conversationId: conversation.id,
        direction: 'inbound',
        content: command.bodyText ?? '',
        contentType: 'text',
        externalMessageId: command.messageId ?? null,
        fromAddress: command.email ?? null,
        subject: command.subject ?? null,
        receivedAt,
      },
    });

    return message.id;
  }
}
