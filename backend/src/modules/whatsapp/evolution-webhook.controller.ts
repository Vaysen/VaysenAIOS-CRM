/**
 * Evolution API Webhook Controller
 * 接收 Evolution API 推送的 WhatsApp 事件（消息、连接状态、QR码等）
 * 替代原有的 Baileys 事件监听器方案
 *
 * 核心优势：Evolution API 已正确处理群组消息的 participant 提取，
 * 我们只需接收处理后的结构化数据，不再需要自己处理 @g.us JID。
 */
import { Controller, Post, Body, Header, Headers, HttpCode, Logger } from '@nestjs/common';
import { WhatsAppService } from './whatsapp.service';
import { RealtimeEventBus } from '../../common/realtime/realtime-event-bus';
import { EvolutionApiService } from './evolution-api.service';
import { Public } from '../../common/decorators/public.decorator';

@Controller('whatsapp/evolution-webhook')
export class EvolutionWebhookController {
  private readonly logger = new Logger(EvolutionWebhookController.name);

  constructor(
    private readonly whatsappService: WhatsAppService,
    private readonly eventBus: RealtimeEventBus,
    private readonly evolutionApi: EvolutionApiService,
  ) {}

  /**
   * 接收 Evolution API 的 Webhook 事件
   * 事件类型: qrcode.updated, connection.update, messages.upsert, messages.update
   */
  @Post()
  @Public()
  @HttpCode(200)
  @Header('Content-Type', 'application/json')
  async handleWebhook(
    @Body() payload: any,
    @Headers('x-evolution-webhook-secret') webhookSecret?: string,
  ) {
    // Authenticate before parsing or touching any database/event state. The
    // endpoint is unavailable by default because Evolution is not deployed in
    // the LAN release.
    this.evolutionApi.assertWebhookAuthorized(webhookSecret);
    try {
      const event = payload?.event || payload?.type;
      const instanceName = payload?.instance || payload?.instanceName;

      this.logger.log(
        `[Webhook] event=${event}, instance=${instanceName}`,
      );

      switch (event) {
        case 'qrcode.updated':
          await this.handleQrCodeUpdated(instanceName, payload);
          break;

        case 'connection.update':
          await this.handleConnectionUpdate(instanceName, payload);
          break;

        case 'messages.upsert':
          await this.handleMessageUpsert(instanceName, payload);
          break;

        case 'messages.update':
          await this.handleMessageUpdate(instanceName, payload);
          break;

        default:
          this.logger.debug(`[Webhook] Unhandled event: ${event}`);
      }

      return { status: 'ok' };
    } catch (err: any) {
      // Evolution retries only when the webhook answers with a non-success
      // status. Never turn a database/processing failure into HTTP 200, or the
      // upstream event can be lost permanently.
      this.logger.error(`[Webhook] Error: ${err?.message}`, err?.stack);
      throw err;
    }
  }

  /**
   * QR 码更新 — 更新数据库中的 QR 码
   */
  private async handleQrCodeUpdated(instanceName: string, payload: any) {
    const qrcode = payload?.data?.qrcode || payload?.qrcode;
    if (!qrcode) return;

    await this.whatsappService.updateQrCode(instanceName, qrcode);
    this.logger.log(`[Webhook] QR code updated for ${instanceName}`);
  }

  /**
   * 连接状态更新 — 更新 WhatsAppSession 状态
   */
  private async handleConnectionUpdate(instanceName: string, payload: any) {
    const status = payload?.data?.status || payload?.status;

    let dbStatus: string;
    let phoneNumber: string | undefined;

    switch (status) {
      case 'open':
      case 'connected':
        dbStatus = 'connected';
        // 从 payload 中提取电话号码
        phoneNumber = payload?.data?.number || payload?.number;
        break;
      case 'connecting':
        dbStatus = 'reconnecting';
        break;
      case 'close':
      case 'disconnected':
        dbStatus = 'disconnected';
        break;
      default:
        dbStatus = status || 'unknown';
    }

    await this.whatsappService.updateConnectionStatus(
      instanceName,
      dbStatus,
      phoneNumber,
    );

    this.logger.log(
      `[Webhook] Connection update: ${instanceName} → ${dbStatus}` +
      (phoneNumber ? ` (phone: ${phoneNumber})` : ''),
    );
  }

  /**
   * 新消息接收 — 核心处理逻辑
   * Evolution API 已正确提取 participant，我们直接使用
   */
  private async handleMessageUpsert(instanceName: string, payload: any) {
    const data = payload?.data || payload;
    // Evolution commonly emits the envelope as data.key + data.message, while
    // some adapters wrap that envelope once more under data.message. Support
    // both shapes without accidentally replacing the envelope (and its key)
    // with the inner WhatsApp message body.
    const message = data?.key ? data : (data?.message || data);

    if (!message?.key) {
      this.logger.warn('[Webhook] Message without key');
      return;
    }

    // 跳过自己发的消息
    if (message.key.fromMe) return;

    const rawJid = message.key.remoteJid || '';
    const jidDomain = rawJid.split('@')[1]?.toLowerCase() || '';
    const isGroup = jidDomain === 'g.us';
    const isLid = jidDomain === 'lid';
    const isPhoneJid = ['s.whatsapp.net', 'c.us'].includes(jidDomain);

    if (!isGroup && !isLid && !isPhoneJid) {
      this.logger.warn(`[Webhook] Unsupported WhatsApp JID domain: ${rawJid}`);
      return;
    }

    // ★ 关键修复：Evolution API 已正确提供 participant 字段
    // 群消息: key.remoteJid = 群JID (@g.us), key.participant = 发送者号码
    // 个人消息: key.remoteJid = 发送者号码 (@s.whatsapp.net)
    const fromJid = isGroup
      ? (message.key.participant || message.participant || '')
      : rawJid;

    // LID is a privacy identifier, not a phone number. Preserve the full JID
    // and never feed its numeric-looking prefix to phone normalization.
    const fromPhone = isLid ? '' : (fromJid.split('@')[0] || '');

    if (!isLid && (!fromPhone || !/^\d{7,15}$/.test(fromPhone))) {
      this.logger.warn(
        `[Webhook] Invalid fromPhone: "${fromPhone}", isGroup=${isGroup}, ` +
        `rawJid=${rawJid}, participant=${message.key.participant || 'N/A'}`,
      );
      return;
    }

    // 提取消息内容
    const messageContent = this.extractMessageContent(message.message);
    if (!messageContent) {
      this.logger.debug('[Webhook] Empty message content, skipping');
      return;
    }

    // 提取媒体信息
    const mediaInfo = this.extractMediaInfo(message.message);

    this.logger.log(
      `[Webhook] Message from ${fromPhone} (group=${isGroup}): ` +
      `${messageContent.substring(0, 100)}${messageContent.length > 100 ? '...' : ''}`,
    );

    // 调用 WhatsAppService 处理消息入库 + SSE 推送
    await this.whatsappService.handleEvolutionMessage({
      instanceName,
      fromPhone,
      isGroup,
      groupJid: isGroup ? rawJid : undefined,
      groupStatusSource: 'evolution_webhook_jid',
      transportSource: 'evolution_webhook',
      externalId: rawJid,
      externalIdKind: isLid ? 'lid' : isPhoneJid ? 'phone_jid' : 'unknown',
      phoneCandidate: isLid || isGroup ? null : fromPhone,
      messageContent,
      mediaInfo,
      messageId: message.key.id,
      timestamp: message.messageTimestamp
        ? new Date(parseInt(message.messageTimestamp) * 1000).toISOString()
        : new Date().toISOString(),
      pushName: message.pushName || '',
    });
  }

  /**
   * 消息状态更新（已读、已送达等）
   */
  private async handleMessageUpdate(instanceName: string, payload: any) {
    const data = payload?.data || payload;
    const statuses = data?.statuses || [];

    for (const status of statuses) {
      const messageId = status?.id || status?.key?.id;
      const statusValue = status?.status;

      if (messageId && statusValue) {
        this.logger.debug(
          `[Webhook] Message status: ${messageId} → ${statusValue}`,
        );
        // 更新消息状态到数据库
        await this.whatsappService.updateMessageStatus(
          instanceName,
          messageId,
          statusValue,
        );
      }
    }
  }

  /**
   * 从 Baileys 消息对象中提取文本内容
   */
  private extractMessageContent(msg: any): string {
    if (!msg) return '';

    if (msg.conversation) return msg.conversation;
    if (msg.extendedTextMessage?.text) return msg.extendedTextMessage.text;
    if (msg.imageMessage?.caption) return msg.imageMessage.caption;
    if (msg.videoMessage?.caption) return msg.videoMessage.caption;
    if (msg.documentMessage?.caption) return msg.documentMessage.caption;
    if (msg.buttonsResponseMessage?.selectedButtonId)
      return msg.buttonsResponseMessage.selectedButtonId;
    if (msg.listResponseMessage?.singleSelectReply?.selectedRowId)
      return msg.listResponseMessage.singleSelectReply.selectedRowId;

    // 媒体消息但无文字
    if (msg.imageMessage) return '[图片]';
    if (msg.videoMessage) return '[视频]';
    if (msg.audioMessage) return '[语音]';
    if (msg.documentMessage) return '[文件]';
    if (msg.stickerMessage) return '[贴纸]';

    return JSON.stringify(msg).substring(0, 200);
  }

  /**
   * 提取媒体信息
   */
  private extractMediaInfo(msg: any): any {
    if (!msg) return null;

    if (msg.imageMessage) {
      return {
        type: 'image',
        mimeType: msg.imageMessage.mimetype || 'image/jpeg',
        caption: msg.imageMessage.caption || '',
      };
    }
    if (msg.videoMessage) {
      return {
        type: 'video',
        mimeType: msg.videoMessage.mimetype || 'video/mp4',
        caption: msg.videoMessage.caption || '',
      };
    }
    if (msg.audioMessage) {
      return {
        type: 'audio',
        mimeType: msg.audioMessage.mimetype || 'audio/mpeg',
      };
    }
    if (msg.documentMessage) {
      return {
        type: 'document',
        mimeType: msg.documentMessage.mimetype || 'application/octet-stream',
        fileName: msg.documentMessage.fileName || 'file',
        caption: msg.documentMessage.caption || '',
      };
    }
    if (msg.stickerMessage) {
      return {
        type: 'sticker',
        mimeType: msg.stickerMessage.mimetype || 'image/webp',
      };
    }

    return null;
  }
}
