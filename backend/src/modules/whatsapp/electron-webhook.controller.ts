/**
 * Electron Webhook Controller
 * 接收来自 Electron 桌面客户端推送的 WhatsApp Web 消息
 *
 * 架构变化：
 * 旧架构：Baileys → 事件监听器 → whatsapp.service.ts
 * 新架构：Electron WhatsApp Web Preload → IPC → HTTP Webhook → whatsapp.service.ts
 *
 * Electron 客户端通过 MutationObserver 监听 WhatsApp Web DOM 变化，
 * 提取消息后通过 HTTP POST 推送到此端点。
 */

import {
  Controller,
  Post,
  Body,
  Header,
  Headers,
  HttpCode,
  GoneException,
  Logger,
  ServiceUnavailableException,
  UseGuards,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { WhatsAppService } from './whatsapp.service';
import { RealtimeEventBus } from '../../common/realtime/realtime-event-bus';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { ContactsSyncDto } from './dto/electron-contacts.dto';
import { sanitizeContactNameCandidate } from '../customer-identity/domain/sanitize-display-text';

@ApiTags('WhatsApp Electron')
@Controller('whatsapp/electron-webhook')
export class ElectronWebhookController {
  private readonly logger = new Logger(ElectronWebhookController.name);

  constructor(
    private readonly whatsappService: WhatsAppService,
    private readonly eventBus: RealtimeEventBus,
  ) {}

  /**
   * 接收 Electron 客户端推送的新消息
   *
   * 消息来源：Electron wa-preload.ts → MutationObserver → IPC → HTTP POST
   *
   * 消息类型支持：
   * - text: 纯文本消息
   * - image: 图片消息（含 blob URL）
   * - file: 文件消息
   * - audio: 语音消息
   * - video: 视频消息
   * - system: 系统消息
   */
  @Post('message')
  @HttpCode(200)
  @Header('Content-Type', 'application/json')
  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard)
  @ApiOperation({ summary: '接收 Electron 推送的 WhatsApp 新消息' })
  async handleNewMessage(
    @Body() payload: ElectronMessagePayload,
    @CurrentUser() user: any,
    @Headers('x-company-id') requestedCompanyId?: string,
  ) {
    try {
      const currentCompanyId = this.requireCurrentCompanyId(requestedCompanyId, user);
      if (
        payload.selectedCompanyId
        && payload.selectedCompanyId !== currentCompanyId
      ) {
        throw new Error('Electron message company binding does not match X-Company-Id');
      }
      const chatName = sanitizeContactNameCandidate(
        payload.chatName || payload.displayNameCandidate || '',
      );
      const senderName = sanitizeContactNameCandidate(payload.sender || '');

      this.logger.log(
        `[Electron Webhook] 消息来自 ${payload.fromPhone || chatName || 'unknown'}: ` +
        `${(payload.text || `[${payload.type}]`).substring(0, 100)}`,
      );

      // Authenticated tenant + validated accountId establishes a durable,
      // auditable Electron mapping. A real message proves the partition is
      // logged in; no arbitrary active Baileys session is auto-claimed.
      const session = await this.whatsappService.ensureElectronSessionMapping(
        payload.accountId,
        user,
        currentCompanyId,
        'connected',
      );
      if (payload.isSelf === true) {
        this.logger.log(`[Electron Webhook] 忽略 self chat 消息: ${payload.id}`);
        return { status: 'ignored', reason: 'self_chat' };
      }

      // 复用现有的消息处理逻辑。Electron/DOM 快照不是独立信任源；
      // 群聊只能由 @g.us 形态的外部标识佐证，renderer 的布尔值只能提高风险等级，
      // 不能把 @g.us 会话降级成私聊。
      // 后端通过 IdentityResolutionService.resolve 关联 contactPointId;
      // 即便 LID 无法解析为真实号码(unresolved),消息仍会入库。
      const externalIdCandidate = payload.externalId?.trim() || undefined;
      const externalId = externalIdCandidate
        && /^\d+@(?:g\.us|c\.us|s\.whatsapp\.net|lid)$/i.test(externalIdCandidate)
        ? externalIdCandidate
        : undefined;
      const groupJid = externalId?.toLowerCase().endsWith('@g.us') ? externalId : undefined;
      const privateJid = externalId && /@(?:c\.us|s\.whatsapp\.net|lid)$/i.test(externalId)
        ? externalId
        : undefined;
      // A renderer boolean is only a risk hint, never a stable thread identity.
      // Without a trusted DOM JID the status remains unknown and the service
      // stores an unlinked/quarantined conversation. This also prevents one
      // poison outbox item from retrying forever while waiting for a JID that
      // cannot be added to the immutable captured payload.
      const isGroup = groupJid ? true : privateJid ? false : null;
      if (payload.isGroup === true && !groupJid) {
        this.logger.warn(
          `[Electron Webhook] renderer 标记群聊但缺少可信 @g.us，按 unknown 隔离: ${payload.id}`,
        );
      }
      const jidPhone = privateJid && !privateJid.toLowerCase().endsWith('@lid')
        ? privateJid.split('@')[0]
        : null;
      const counterpartPhone = jidPhone || payload.fromPhone || payload.chatPhone || '';
      await this.whatsappService.handleEvolutionMessage({
        instanceName: session.sessionId,
        fromPhone: counterpartPhone,
        isGroup,
        groupJid,
        messageContent: payload.text || this.getMediaTypeLabel(payload.type),
        mediaInfo: this.buildMediaInfo(payload),
        messageId: payload.id,
        timestamp: payload.timestamp || new Date().toISOString(),
        pushName: senderName || chatName || '',
        externalId,
        externalIdKind: payload.externalIdKind,
        phoneCandidate: jidPhone && /^\d{7,15}$/.test(jidPhone) ? jidPhone : null,
        displayNameCandidate: chatName || undefined,
        groupStatusSource: externalId ? 'electron_dom_jid' : undefined,
        transportSource: 'electron_dom',
        direction: payload.isOutgoing === true ? 'outbound' : 'inbound',
      }, currentCompanyId);

      return { status: 'ok' };
    } catch (err: any) {
      this.logger.error(`[Electron Webhook] 消息处理失败: ${err?.message}`, err?.stack);
      throw new ServiceUnavailableException({
        status: 'error',
        message: err?.message || 'Electron WhatsApp message processing failed',
      });
    }
  }

  /**
   * 接收 Electron 客户端推送的登录状态变化
   *
   * 状态类型：
   * - logged_in: WhatsApp Web 已登录
   * - waiting_scan: 等待扫码
   * - reconnecting: 断线重连中
   * - selector_warning: 选择器失效告警
   * - unread_update: 未读消息计数更新
   */
  @Post('status')
  @HttpCode(200)
  @Header('Content-Type', 'application/json')
  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard)
  @ApiOperation({ summary: '接收 Electron 推送的 WhatsApp 状态更新' })
  async handleStatusUpdate(
    @Body() payload: ElectronStatusPayload,
    @CurrentUser() user: any,
    @Headers('x-company-id') requestedCompanyId?: string,
  ) {
    try {
      const currentCompanyId = this.requireCurrentCompanyId(requestedCompanyId, user);
      this.logger.log(
        `[Electron Webhook] 状态更新: accountId=${payload.accountId}, status=${payload.status}`,
      );

      // 映射状态
      let dbStatus: 'connected' | 'waiting_scan' | 'reconnecting' | 'disconnected';
      switch (payload.status) {
        case 'logged_in':
          dbStatus = 'connected';
          break;
        case 'waiting_scan':
          dbStatus = 'waiting_scan';
          break;
        case 'reconnecting':
          dbStatus = 'reconnecting';
          break;
        case 'selector_warning':
          this.logger.warn(
            `[Electron Webhook] 选择器告警: ${payload.group} - ${payload.message}`,
          );
          return { status: 'ok' };
        case 'unread_update':
          // 未读计数更新，无需修改 session 状态
          this.eventBus.emit('whatsapp.unread', {
            accountId: payload.accountId,
            unreadCount: payload.unreadCount,
            timestamp: payload.timestamp,
          });
          return { status: 'ok' };
        case 'logged_out':
        case 'disconnected':
          dbStatus = 'disconnected';
          break;
        default:
          throw new Error(`Unsupported Electron WhatsApp status: ${payload.status}`);
      }

      await this.whatsappService.ensureElectronSessionMapping(
        payload.accountId,
        user,
        currentCompanyId,
        dbStatus,
      );

      return { status: 'ok' };
    } catch (err: any) {
      this.logger.error(`[Electron Webhook] 状态处理失败: ${err?.message}`, err?.stack);
      throw new ServiceUnavailableException({
        status: 'error',
        message: err?.message || 'Electron WhatsApp status processing failed',
      });
    }
  }

  /**
   * 接收 Electron 客户端推送的联系人列表
   * 用于同步 WhatsApp Web 中的聊天列表到后端
   */
  @Post('contacts')
  @HttpCode(200)
  @Header('Content-Type', 'application/json')
  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard)
  @ApiOperation({ summary: '接收 Electron 推送的 WhatsApp 联系人列表' })
  async handleContactsSync(
    @Body() dto: ContactsSyncDto,
    @CurrentUser() user: any,
    @Headers('x-company-id') requestedCompanyId?: string,
  ) {
    try {
      const currentCompanyId = this.requireCurrentCompanyId(requestedCompanyId, user);
      this.logger.log(
        `[Electron Webhook] 联系人同步: accountId=${dto.accountId}, count=${dto.contacts?.length || 0}`,
      );

      if (!dto.contacts || dto.contacts.length === 0) {
        return { status: 'ok', message: 'no contacts' };
      }

      // 通过 eventBus 推送到前端（实时更新联系人列表）
      this.eventBus.emit('whatsapp.contacts', {
        accountId: dto.accountId,
        contacts: dto.contacts,
        timestamp: dto.timestamp,
      });

      // 持久化: 通过 IdentityResolutionService 逐条解析,关联/创建 ContactPoint (TASK-102D)
      const session = await this.whatsappService.ensureElectronSessionMapping(
        dto.accountId,
        user,
        currentCompanyId,
        'connected',
      );
      const result = await this.whatsappService.syncContactsFromSnapshots(
        session.companyId,
        dto.accountId,
        dto.contacts,
      );
      const synced = result.synced;
      const skipped = result.skipped;

      return { status: 'ok', synced, skipped };
    } catch (err: any) {
      this.logger.error(`[Electron Webhook] 联系人同步失败: ${err?.message}`, err?.stack);
      throw new ServiceUnavailableException({
        status: 'error',
        message: err?.message || 'Electron WhatsApp contacts sync failed',
      });
    }
  }

  /**
   * 发送消息回调 — Electron 发送消息后通知后端记录
   *
   * Electron 客户端通过 WhatsApp Web DOM 注入文本并点击发送按钮，
   * 发送成功后回调此端点记录到数据库。
   */
  @Post('sent')
  @HttpCode(200)
  @Header('Content-Type', 'application/json')
  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard)
  @ApiOperation({ summary: 'Electron 发送消息后回调记录' })
  async handleMessageSent(
    @Body() _payload: ElectronSentPayload,
    @CurrentUser() _user: any,
  ) {
    throw new GoneException(
      'Legacy sent callback is disabled; outgoing DOM messages use the durable message outbox',
    );
  }

  // === 私有方法 ===

  private requireCurrentCompanyId(requestedCompanyId: string | undefined, user: any): string {
    const companyId = requestedCompanyId?.trim();
    if (!companyId) {
      throw new Error('X-Company-Id is required for Electron WhatsApp webhook requests');
    }
    const companyIds = (user?.companies || []).map((company: any) => company?.id);
    if (!companyIds.includes(companyId)) {
      throw new Error('X-Company-Id is not available to the current user');
    }
    return companyId;
  }

  /**
   * 获取媒体类型的文字标签
   */
  private getMediaTypeLabel(type: string): string {
    switch (type) {
      case 'image': return '[图片]';
      case 'file': return '[文件]';
      case 'audio': return '[语音]';
      case 'video': return '[视频]';
      case 'system': return '[系统消息]';
      default: return '';
    }
  }

  /**
   * 构建媒体信息对象
   */
  private buildMediaInfo(payload: ElectronMessagePayload): any {
    if (payload.type === 'text' || !payload.type) return null;

    return {
      type: payload.type === 'file' ? 'document' : payload.type,
      mimeType: 'application/octet-stream',
      caption: payload.text || '',
      fileName: payload.mediaName || '',
      url: payload.mediaUrl || '',
    };
  }
}

// === DTO 接口定义 ===

interface ElectronMessagePayload {
  accountId: string;
  id: string;
  text: string;
  isOutgoing: boolean;
  timestamp: string;
  type: 'text' | 'image' | 'file' | 'audio' | 'video' | 'system';
  mediaUrl?: string;
  mediaName?: string;
  sender?: string;
  chatName: string;
  chatPhone: string;
  isGroup: boolean;
  fromPhone?: string;
  // TASK-102D: 可信 JID/LID/号码候选(preload 从 data-id 提取,非状态文本猜测)
  externalId?: string;
  externalIdKind?: 'phone_jid' | 'lid' | 'unknown';
  phoneCandidate?: string | null;
  displayNameCandidate?: string | null;
  isSelf?: boolean;
  // Main-process durable outbox captures the selected tenant at observation
  // time. It is compared with the authenticated request header, never trusted
  // as an authorization source.
  selectedCompanyId?: string;
}

interface ElectronStatusPayload {
  accountId: string;
  status: 'logged_in' | 'waiting_scan' | 'reconnecting' | 'selector_warning' | 'unread_update' | string;
  timestamp: number;
  group?: string;
  message?: string;
  unreadCount?: number;
}

interface ElectronSentPayload {
  accountId: string;
  toPhone: string;
  text: string;
  success: boolean;
  messageId?: string;
  error?: string;
}
