/**
 * WhatsApp Adapter — 基于 @whiskeysockets/baileys 的扫码登录适配器
 * 负责：QR码生成、连接管理、消息收发
 *
 * 代理支持：设置环境变量 WHATSAPP_PROXY 即可走代理连接 WhatsApp 服务器
 *   例: WHATSAPP_PROXY=http://127.0.0.1:7890
 *       WHATSAPP_PROXY=socks5://127.0.0.1:1080
 */
import { Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import type { WASocket } from '@whiskeysockets/baileys';
import { Boom } from '@hapi/boom';
import QRCode from 'qrcode';
import { EventEmitter } from 'events';
import * as fs from 'fs';
import { loadBaileys } from './baileys-loader';
import { safeDigest, safeErrorCategory, safeLogEvent } from '../../common/security/safe-logging';

export interface WhatsAppConnectionState {
  status: 'pending_qr' | 'waiting_scan' | 'connected' | 'disconnected';
  qrCode?: string;
  phoneNumber?: string;
}

export type WhatsAppMessageDirection = 'inbound' | 'outbound';

/**
 * Forward every message in a Baileys upsert batch. Baileys may deliver more
 * than one item per event and `fromMe` is the provider acknowledgement/write
 * back for messages sent by this account, not noise that may be discarded.
 */
export function forwardBaileysMessageBatch(
  eventEmitter: EventEmitter,
  sessionId: string,
  batch: { messages?: any[] } | null | undefined,
): number {
  let forwarded = 0;
  for (const msg of batch?.messages || []) {
    if (!msg?.message) continue;
    const direction: WhatsAppMessageDirection = msg.key?.fromMe
      ? 'outbound'
      : 'inbound';
    eventEmitter.emit('message', { msg, sessionId, direction });
    forwarded += 1;
  }
  return forwarded;
}

/** Map Baileys' numeric WAMessageStatus to the CRM delivery vocabulary. */
export function normalizeBaileysMessageStatus(status: unknown): string | null {
  if (status === null || status === undefined) return null;
  if (typeof status === 'string') {
    const normalized = status.trim().toLowerCase();
    if (['failed', 'pending', 'sent', 'delivered', 'read'].includes(normalized)) {
      return normalized;
    }
  }
  switch (Number(status)) {
    case 0: return 'failed';
    case 1: return 'pending';
    case 2: return 'sent';
    case 3: return 'delivered';
    case 4:
    case 5: return 'read';
    default: return null;
  }
}

/** Forward each usable provider status update independently. */
export function forwardBaileysMessageUpdates(
  eventEmitter: EventEmitter,
  sessionId: string,
  updates: any[] | null | undefined,
): number {
  let forwarded = 0;
  for (const item of updates || []) {
    const messageId = item?.key?.id?.trim?.();
    const status = normalizeBaileysMessageStatus(item?.update?.status);
    if (!messageId || !status) continue;
    eventEmitter.emit('message-status', { sessionId, messageId, status });
    forwarded += 1;
  }
  return forwarded;
}

/** Never expose proxy credentials in logs or diagnostics. */
export function describeProxyEndpoint(proxyUrl: string): string {
  try {
    const url = new URL(proxyUrl);
    return `${url.protocol}//${url.hostname}${url.port ? `:${url.port}` : ''}`;
  } catch {
    return 'invalid-proxy-url';
  }
}

@Injectable()
export class WhatsAppAdapter {
  private readonly logger = new Logger(WhatsAppAdapter.name);
  private sockets = new Map<string, WASocket>();
  private stateEvents = new Map<string, EventEmitter>();
  private authStateDirs = new Map<string, string>();
  private inFlightOutbound = new Map<string, Promise<unknown>>();

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

  private async withBoundedTimeout<T>(
    operation: () => Promise<T> | T,
    timeoutMs: number,
  ): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const providerOperation = Promise.resolve().then(operation);
      return await Promise.race([
        providerOperation,
        new Promise<T>((_resolve, reject) => {
          timer = setTimeout(() => {
            reject(new Error(`Provider operation timeout after ${timeoutMs}ms`));
          }, timeoutMs);
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  private async runQuarantinedSend<T>(
    sessionId: string,
    signal: AbortSignal | undefined,
    operation: () => Promise<T>,
  ): Promise<T> {
    if (signal?.aborted) {
      const rejected: any = new ServiceUnavailableException(
        'WhatsApp dispatch was cancelled before provider I/O',
      );
      rejected.providerDeliveryOutcome = 'REJECTED';
      rejected.providerAccepted = false;
      throw rejected;
    }
    if (this.inFlightOutbound.has(sessionId)) {
      const rejected: any = new ServiceUnavailableException(
        'WhatsApp session has an unresolved in-flight provider operation',
      );
      rejected.providerDeliveryOutcome = 'REJECTED';
      rejected.providerAccepted = false;
      throw rejected;
    }

    const providerOperation = Promise.resolve().then(operation);
    this.inFlightOutbound.set(sessionId, providerOperation);
    providerOperation.finally(() => {
      if (this.inFlightOutbound.get(sessionId) === providerOperation) {
        this.inFlightOutbound.delete(sessionId);
      }
    }).catch(() => undefined);

    if (!signal) return providerOperation;
    let abortListener: (() => void) | undefined;
    const aborted = new Promise<never>((_resolve, reject) => {
      abortListener = () => {
        const error: any = new ServiceUnavailableException(
          'WhatsApp provider operation exceeded its bounded window',
        );
        error.code = 'PROVIDER_DISPATCH_ABORTED';
        reject(error);
      };
      signal.addEventListener('abort', abortListener, { once: true });
    });
    try {
      return await Promise.race([providerOperation, aborted]);
    } finally {
      if (abortListener) signal.removeEventListener('abort', abortListener);
    }
  }

  /**
   * 构建代理 Agent（如果配置了 WHATSAPP_PROXY 环境变量）
   */
  private getProxyAgent(): any | undefined {
    const proxyUrl = process.env.WHATSAPP_PROXY || process.env.HTTPS_PROXY || process.env.HTTP_PROXY;
    if (!proxyUrl) return undefined;

    try {
      if (proxyUrl.startsWith('socks')) {
        const { SocksProxyAgent } = require('socks-proxy-agent');
        this.logSafe('log', 'whatsapp.adapter.proxy_configured', {
          eventType: 'proxy_configured',
          status: 'connected',
        });
        return new SocksProxyAgent(proxyUrl);
      } else {
        const { HttpsProxyAgent } = require('https-proxy-agent');
        this.logSafe('log', 'whatsapp.adapter.proxy_configured', {
          eventType: 'proxy_configured',
          status: 'connected',
        });
        return new HttpsProxyAgent(proxyUrl);
      }
    } catch (err: any) {
      this.logSafe('warn', 'whatsapp.adapter.proxy_failed', {
        eventType: 'proxy_failed',
        errorCategory: safeErrorCategory(err),
      });
      return undefined;
    }
  }

  /**
   * 获取或创建 session 的 EventEmitter（持久化，重连不丢失）
   */
  private getOrCreateEmitter(sessionId: string): EventEmitter {
    if (!this.stateEvents.has(sessionId)) {
      this.stateEvents.set(sessionId, new EventEmitter());
    }
    return this.stateEvents.get(sessionId)!;
  }

  /**
   * 公共方法：确保 EventEmitter 已创建
   * 用于在 initSession 之前绑定事件监听器
   */
  ensureEmitter(sessionId: string): EventEmitter {
    return this.getOrCreateEmitter(sessionId);
  }

  /**
   * 初始化一个 WhatsApp 连接 session
   */
  async initSession(
    sessionId: string,
    authStateDir: string,
  ): Promise<{ qrCode: string; status: string }> {
    const {
      makeWASocket,
      DisconnectReason,
      useMultiFileAuthState,
    } = await loadBaileys();

    // 确保目录存在
    if (!fs.existsSync(authStateDir)) {
      fs.mkdirSync(authStateDir, { recursive: true });
    }

    // 记录 authStateDir 用于重连
    this.authStateDirs.set(sessionId, authStateDir);

    const { state, saveCreds } = await useMultiFileAuthState(authStateDir);

    // 使用持久化 EventEmitter，重连时不创建新的
    const eventEmitter = this.getOrCreateEmitter(sessionId);

    let latestQr: string | null = null;

    const proxyAgent = this.getProxyAgent();
    const socketConfig: any = {
      auth: state,
      printQRInTerminal: false,
      browser: ['Vaysen CRM', 'Chrome', '1.0.0'],
      connectTimeoutMs: 30_000,
      defaultQueryTimeoutMs: 60_000,
    };

    if (proxyAgent) {
      socketConfig.agent = proxyAgent;
      socketConfig.fetchAgent = proxyAgent;
    }

    this.logSafe('log', 'whatsapp.adapter.session_initializing', {
      eventType: 'session_initializing',
      sessionRef: this.safeRef(sessionId, 'whatsapp-session'),
      status: 'connecting',
      accepted: !!proxyAgent,
    });

    const sock = makeWASocket(socketConfig);
    this.sockets.set(sessionId, sock);

    // QR 码更新事件
    sock.ev.on('connection.update', async (update) => {
      const { connection, lastDisconnect, qr } = update;

      if (qr) {
        // 生成 base64 QR 图片
        latestQr = await QRCode.toDataURL(qr, { width: 256 });
        eventEmitter.emit('qr', { qrCode: latestQr, status: 'waiting_scan' });
        this.logSafe('log', 'whatsapp.adapter.qr_generated', {
          eventType: 'qr_generated',
          sessionRef: this.safeRef(sessionId, 'whatsapp-session'),
          status: 'pending',
        });
      }

      if (connection === 'open') {
        const phoneNumber = sock.user?.id?.split(':')[0] || '';
        this.logSafe('log', 'whatsapp.adapter.connected', {
          eventType: 'connected',
          sessionRef: this.safeRef(sessionId, 'whatsapp-session'),
          phoneRef: this.safeRef(phoneNumber, 'whatsapp-phone'),
          status: 'connected',
        });
        // 发出 connected 事件，所有监听器都会收到
        eventEmitter.emit('connected', { phoneNumber, status: 'connected' });
      }

      if (connection === 'close') {
        const statusCode = (lastDisconnect?.error as Boom)?.output?.statusCode;
        const shouldReconnect = statusCode !== DisconnectReason.loggedOut;

        if (shouldReconnect) {
          this.logSafe('warn', 'whatsapp.adapter.connection_reconnecting', {
            eventType: 'connection_reconnecting',
            sessionRef: this.safeRef(sessionId, 'whatsapp-session'),
            status: 'reconnecting',
            errorCategory: safeErrorCategory(lastDisconnect?.error),
          });
          // 清理旧 socket
          this.sockets.delete(sessionId);
          // 通知前端正在重连
          eventEmitter.emit('reconnecting', { status: 'reconnecting' });
          // 延迟后重新初始化（复用同一个 EventEmitter）
          setTimeout(() => {
            const dir = this.authStateDirs.get(sessionId) || authStateDir;
            this.initSession(sessionId, dir).catch((err) => {
              this.logSafe('error', 'whatsapp.adapter.reconnect_failed', {
                eventType: 'reconnect_failed',
                sessionRef: this.safeRef(sessionId, 'whatsapp-session'),
                errorCategory: safeErrorCategory(err),
              });
              // 重连失败 — 发射 disconnected 事件让 service 层处理
              eventEmitter.emit('disconnected', { status: 'disconnected' });
            });
          }, 3000);
        } else {
          // 登出 — 删除旧认证文件，下次 initSession 会生成新 QR 码
          this.logSafe('log', 'whatsapp.adapter.session_logged_out', {
            eventType: 'session_logged_out',
            sessionRef: this.safeRef(sessionId, 'whatsapp-session'),
            status: 'disconnected',
          });
          try {
            if (fs.existsSync(authStateDir)) {
              fs.rmSync(authStateDir, { recursive: true, force: true });
              this.logSafe('log', 'whatsapp.adapter.auth_state_deleted', {
                eventType: 'auth_state_deleted',
                sessionRef: this.safeRef(sessionId, 'whatsapp-session'),
                status: 'disconnected',
              });
            }
          } catch (err: any) {
            this.logSafe('error', 'whatsapp.adapter.auth_state_delete_failed', {
              eventType: 'auth_state_delete_failed',
              sessionRef: this.safeRef(sessionId, 'whatsapp-session'),
              errorCategory: safeErrorCategory(err),
            });
          }
          eventEmitter.emit('disconnected', { status: 'disconnected' });
          this.cleanup(sessionId);
        }
      }
    });

    // 保存认证状态
    sock.ev.on('creds.update', saveCreds);

    // 消息接收事件
    sock.ev.on('messages.upsert', (batch) => {
      forwardBaileysMessageBatch(eventEmitter, sessionId, batch);
    });

    // Provider delivery receipts are separate from message upserts. Persist
    // them through the service layer so UI state reflects WhatsApp, not an
    // optimistic local assumption.
    sock.ev.on('messages.update', (updates) => {
      forwardBaileysMessageUpdates(eventEmitter, sessionId, updates);
    });

    // 等待 QR 码生成（最多 60 秒）
    const qrTimeoutMs = parseInt(process.env.WHATSAPP_QR_TIMEOUT_MS || '60000', 10);

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        if (latestQr) {
          resolve({ qrCode: latestQr, status: 'waiting_scan' });
        } else {
          const hint = !process.env.WHATSAPP_PROXY && !process.env.HTTPS_PROXY
            ? ' (提示：在中国网络环境下需要设置代理，请配置 WHATSAPP_PROXY 环境变量，例如 http://127.0.0.1:7890)'
            : '';
          reject(new Error(`QR code generation timeout after ${qrTimeoutMs / 1000}s${hint}`));
        }
      }, qrTimeoutMs);

      // 使用 once 只用于 Promise 解析，不影响其他 on 监听器
      const onQr = ({ qrCode }: { qrCode: string }) => {
        clearTimeout(timeout);
        resolve({ qrCode, status: 'waiting_scan' });
        eventEmitter.off('qr', onQr);
        eventEmitter.off('connected', onConnected);
      };

      const onConnected = () => {
        clearTimeout(timeout);
        resolve({ qrCode: '', status: 'connected' });
        eventEmitter.off('qr', onQr);
        eventEmitter.off('connected', onConnected);
      };

      eventEmitter.on('qr', onQr);
      eventEmitter.on('connected', onConnected);
    });
  }

  /**
   * 获取 session 的 EventEmitter（用于 SSE 订阅和事件监听）
   */
  getEventEmitter(sessionId: string): EventEmitter | undefined {
    return this.stateEvents.get(sessionId);
  }

  /**
   * 发送文本消息
   */
  async sendTextMessage(
    sessionId: string,
    jid: string,
    text: string,
    signal?: AbortSignal,
  ): Promise<{
    success: boolean;
    messageId?: string;
    error?: string;
    deliveryOutcome?: 'REJECTED';
    providerAccepted?: false;
  }> {
    const sock = this.sockets.get(sessionId);
    if (!sock) {
      return {
        success: false,
        error: 'Session not found or not connected',
        deliveryOutcome: 'REJECTED',
        providerAccepted: false,
      };
    }

    try {
      const result = await this.runQuarantinedSend(
        sessionId,
        signal,
        () => sock.sendMessage(jid, { text }),
      );
      return {
        success: true,
        messageId: result?.key?.id || undefined,
      };
    } catch (err: any) {
      this.logSafe('error', 'whatsapp.adapter.send_text_failed', {
        eventType: 'send_text_failed',
        sessionRef: this.safeRef(sessionId, 'whatsapp-session'),
        jidRef: this.safeRef(jid, 'whatsapp-jid'),
        contentType: 'text',
        errorCategory: safeErrorCategory(err),
      });
      // Once sock.sendMessage starts, timeout/reset/provider errors cannot
      // prove non-delivery. Preserve the exception so the Outbox records UNKNOWN.
      throw err;
    }
  }

  /**
   * 发送媒体消息（图片/文档/视频/音频）
   * Baileys 支持通过 Buffer 或 URL 发送媒体
   */
  async sendMediaMessage(
    sessionId: string,
    jid: string,
    options: {
      type: 'image' | 'document' | 'video' | 'audio';
      buffer?: Buffer;
      url?: string;
      filename?: string;
      caption?: string;
      mimeType?: string;
    },
    signal?: AbortSignal,
  ): Promise<{
    success: boolean;
    messageId?: string;
    error?: string;
    deliveryOutcome?: 'REJECTED';
    providerAccepted?: false;
  }> {
    const sock = this.sockets.get(sessionId);
    if (!sock) {
      return {
        success: false,
        error: 'Session not found or not connected',
        deliveryOutcome: 'REJECTED',
        providerAccepted: false,
      };
    }

    try {
      let messageContent: any = {};

      if (options.type === 'image') {
        messageContent = options.buffer
          ? { image: options.buffer, caption: options.caption }
          : { image: { url: options.url }, caption: options.caption };
      } else if (options.type === 'document') {
        messageContent = options.buffer
          ? { document: options.buffer, fileName: options.filename || 'file', caption: options.caption, mimetype: options.mimeType }
          : { document: { url: options.url }, fileName: options.filename || 'file', caption: options.caption, mimetype: options.mimeType };
      } else if (options.type === 'video') {
        messageContent = options.buffer
          ? { video: options.buffer, caption: options.caption }
          : { video: { url: options.url }, caption: options.caption };
      } else if (options.type === 'audio') {
        messageContent = options.buffer
          ? { audio: options.buffer, mimetype: options.mimeType || 'audio/mpeg', ptt: false }
          : { audio: { url: options.url }, mimetype: options.mimeType || 'audio/mpeg', ptt: false };
      }

      const result = await this.runQuarantinedSend(
        sessionId,
        signal,
        () => sock.sendMessage(jid, messageContent),
      );
      return {
        success: true,
        messageId: result?.key?.id || undefined,
      };
    } catch (err: any) {
      this.logSafe('error', 'whatsapp.adapter.send_media_failed', {
        eventType: 'send_media_failed',
        sessionRef: this.safeRef(sessionId, 'whatsapp-session'),
        jidRef: this.safeRef(jid, 'whatsapp-jid'),
        contentType: options.type,
        errorCategory: safeErrorCategory(err),
      });
      throw err;
    }
  }
  isConnected(sessionId: string): boolean {
    const sock = this.sockets.get(sessionId);
    return !!sock?.user;
  }

  /**
   * 仅移除 socket（保留 EventEmitter），用于 reconnect 场景
   * 避免触发 cleanup 导致 emitter 被销毁
   */
  removeSocket(sessionId: string): void {
    const sock = this.sockets.get(sessionId);
    if (sock) {
      try {
        sock.end(undefined);
      } catch {
        // ignore
      }
    }
    this.sockets.delete(sessionId);
    this.logSafe('log', 'whatsapp.adapter.socket_removed', {
      eventType: 'socket_removed',
      sessionRef: this.safeRef(sessionId, 'whatsapp-session'),
      status: 'disconnected',
    });
  }

  /**
   * 获取 WhatsApp 用户的头像 URL
   * Baileys 通过 profilePictureUrl 方法获取，返回 WhatsApp CDN 上的图片地址
   * 如果用户没设置头像或隐私设置不允许，返回 null
   */
  async getProfilePictureUrl(
    sessionId: string,
    jid: string,
  ): Promise<string | null> {
    const sock = this.sockets.get(sessionId);
    if (!sock) {
      return null;
    }

    try {
      // Baileys profilePictureUrl 可能挂起，加 8 秒超时
      const url = await this.withBoundedTimeout(
        () => sock.profilePictureUrl(jid, 'preview'),
        8000,
      );
      return url || null;
    } catch {
      // 用户没头像或隐私设置不允许获取，或超时
      return null;
    }
  }

  /**
   * 下载 WhatsApp 媒体文件（图片/视频/语音/文档）
   * 使用 Baileys 的 downloadMediaMessage API
   * 返回 Buffer + MIME 类型 + 文件扩展名
   */
  async downloadMedia(
    sessionId: string,
    msg: any,
  ): Promise<{ data: Buffer; mimeType: string; ext: string } | null> {
    const sock = this.sockets.get(sessionId);
    if (!sock) {
      return null;
    }

    try {
      const { downloadMediaMessage } = await loadBaileys();

      // Baileys downloadMediaMessage 需要传入原始消息对象
      // 它会自动识别消息类型并下载对应的媒体
      const buffer = await this.withBoundedTimeout(
        () => downloadMediaMessage(msg, 'buffer', {}),
        30000,
      );

      if (!buffer || buffer.length === 0) {
        return null;
      }

      // 从消息中提取 MIME 类型和扩展名
      const m = msg.message;
      let mimeType = '';
      let ext = '';

      if (m?.imageMessage) {
        mimeType = m.imageMessage.mimetype || 'image/jpeg';
        ext = mimeType.includes('png') ? '.png' : mimeType.includes('webp') ? '.webp' : '.jpg';
      } else if (m?.videoMessage) {
        mimeType = m.videoMessage.mimetype || 'video/mp4';
        ext = '.mp4';
      } else if (m?.audioMessage) {
        mimeType = m.audioMessage.mimetype || 'audio/ogg';
        ext = mimeType.includes('mp3') ? '.mp3' : '.ogg';
      } else if (m?.documentMessage) {
        mimeType = m.documentMessage.mimetype || 'application/octet-stream';
        ext = mimeType.includes('pdf') ? '.pdf' : mimeType.includes('word') ? '.docx' :
              mimeType.includes('sheet') ? '.xlsx' : mimeType.includes('presentation') ? '.pptx' :
              mimeType.includes('zip') ? '.zip' : '';
      } else if (m?.stickerMessage) {
        mimeType = m.stickerMessage.mimetype || 'image/webp';
        ext = '.webp';
      }

      return { data: buffer, mimeType, ext };
    } catch (err: any) {
      this.logSafe('error', 'whatsapp.adapter.media_download_failed', {
        eventType: 'media_download_failed',
        sessionRef: this.safeRef(sessionId, 'whatsapp-session'),
        contentType: 'document',
        errorCategory: safeErrorCategory(err),
      });
      return null;
    }
  }

  /**
   * 断开连接
   */
  async disconnect(sessionId: string): Promise<void> {
    const sock = this.sockets.get(sessionId);
    if (sock) {
      try {
        await sock.logout();
      } catch {
        // ignore
      }
    }
    this.cleanup(sessionId);
  }

  /**
   * 清理 session 资源
   */
  private cleanup(sessionId: string) {
    this.sockets.delete(sessionId);
    this.authStateDirs.delete(sessionId);
    const emitter = this.stateEvents.get(sessionId);
    if (emitter) {
      emitter.removeAllListeners();
      this.stateEvents.delete(sessionId);
    }
  }

  /**
   * 从手机号或 JID 构建 WhatsApp JID
   * - 如果输入已包含 @（如 234977878868136@lid），直接返回（已是完整 JID）
   * - 否则接受 7-15 位纯数字号码，构建 @s.whatsapp.net JID
   * 支持 WhatsApp 的 LID 隐私格式、群组 JID 等非标准地址
   */
  buildJid(phoneOrJid: string): string {
    const cleaned = phoneOrJid.trim();
    // 如果已经是完整 JID 格式（包含 @），直接使用
    if (cleaned.includes('@')) {
      return cleaned;
    }
    const digitsOnly = cleaned.replace(/[\s\-\(\)\+\.]/g, '').replace(/^00/, '');
    // 校验：必须是 7-15 位纯数字（国际手机号格式）
    if (!/^\d{7,15}$/.test(digitsOnly)) {
      throw new Error(`Invalid phone number for JID: "${phoneOrJid}" (cleaned: "${digitsOnly}"). Expected 7-15 digits or a JID with @.`);
    }
    return `${digitsOnly}@s.whatsapp.net`;
  }
}
