import {
  Injectable,
  NotFoundException,
  Logger,
  BadRequestException,
  ForbiddenException,
  OnModuleInit,
  ServiceUnavailableException,
} from '@nestjs/common';
import { PrismaService } from '../../common/prisma/prisma.service';
import { WhatsAppAdapter } from './whatsapp-adapter';
import { EvolutionApiService } from './evolution-api.service';
import { RealtimeEventBus } from '../../common/realtime/realtime-event-bus';
// TASK-102D: 改用 IdentityResolutionService + 归一化纯函数,弃用截断国家码的 normalizePhone
import { IdentityResolutionService } from '../customer-identity/identity-resolution.service';
import { normalizePhoneIdentity } from '../customer-identity/domain/normalize-phone';
import { sanitizeContactNameCandidate } from '../customer-identity/domain/sanitize-display-text';
import { WhatsAppContactSnapshotDto } from './dto/electron-contacts.dto';
import { OwnerNotificationService } from '../owner-notifications/owner-notification.service';
import * as path from 'path';
import * as fs from 'fs';
import { createHash } from 'crypto';

const ELECTRON_AUTH_STATE_PREFIX = 'electron-account:';
const ELECTRON_ACCOUNT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/;

export interface WhatsAppProviderSendReceipt {
  success: true;
  provider: 'baileys';
  providerMessageId: string;
  /** Backwards-compatible alias used by the existing controller/UI. */
  messageId: string;
  status: 'accepted';
  acceptedAt: string;
}

@Injectable()
export class WhatsAppService implements OnModuleInit {
  private readonly logger = new Logger(WhatsAppService.name);
  private readonly authStateBaseDir = path.join(process.cwd(), '.whatsapp-sessions');

  constructor(
    private prisma: PrismaService,
    private adapter: WhatsAppAdapter,
    private evolutionApi: EvolutionApiService,
    private eventBus: RealtimeEventBus,
    private identityResolver: IdentityResolutionService,
    private ownerNotificationService: OwnerNotificationService,
  ) {}

  // ════════════════════════════════════════════════════════════
  // TASK-102D: 联系人 / 消息统一走 IdentityResolutionService
  // ════════════════════════════════════════════════════════════

  /**
   * 统一的 WhatsApp 身份解析入口。
   *
   * - phoneDigits 可靠时(从 JID 提取): normalizePhoneIdentity -> E.164 -> resolver 精确匹配
   * - 仅 LID/JID 无真实号码: normalizedValue=null + externalIdentity -> unresolved
   * - 不再截断国家码(移除旧 normalizePhone 删除 86 的行为),不再写入 "WhatsApp: <phone>" 公司名
   *
   * @returns contactPointId 在 linked/created 时可得;LID/未知 -> null,但消息仍可入库
   */
  private async resolveWhatsAppContact(params: {
    companyId: string;
    phoneDigits?: string | null;
    externalId?: string | null;
    displayNameCandidate?: string | null;
    countryIso2?: string | null;
    source: 'whatsapp_sync' | 'whatsapp_message';
  }): Promise<{
    contactPointId: string | null;
    leadId: string | null;
    action: 'linked' | 'created' | 'review_required' | 'unresolved';
    normalizedValue: string | null;
  }> {
    const phoneDigits =
      params.phoneDigits && /^\d{7,15}$/.test(params.phoneDigits) ? params.phoneDigits : null;

    const externalIdentity = params.externalId
      ? { provider: 'whatsapp', externalId: params.externalId }
      : undefined;

    let normalizedValue: string | null = null;
    if (phoneDigits) {
      const identity = normalizePhoneIdentity('+' + phoneDigits, (params.countryIso2 as any) || undefined);
      if (identity.status === 'resolved') {
        normalizedValue = identity.e164;
      }
      // needs_country / unresolved -> normalizedValue 保持 null -> 走 externalIdentity 的 unresolved 路径
    }

    // 无可信号码且无外部身份锚点时,resolver 会抛错;此处兜底返回 unresolved
    if (!normalizedValue && !externalIdentity) {
      return { contactPointId: null, leadId: null, action: 'unresolved', normalizedValue: null };
    }

    const result = await this.identityResolver.resolve({
      companyId: params.companyId,
      channel: 'whatsapp',
      normalizedValue,
      externalIdentity,
      contactNameCandidate: params.displayNameCandidate || undefined,
      countryIso2: params.countryIso2 ?? null,
      source: params.source,
    });

    if (result.action === 'linked' || result.action === 'created') {
      return {
        contactPointId: result.contactPointId,
        leadId: result.leadId,
        action: result.action,
        normalizedValue,
      };
    }
    if (result.action === 'review_required') {
      return { contactPointId: null, leadId: result.leadId, action: 'review_required', normalizedValue };
    }
    // unresolved: 仅记录外部身份,无 Lead / ContactPoint
    return { contactPointId: null, leadId: null, action: 'unresolved', normalizedValue };
  }

  /**
   * 联系人同步: 对每条 preload 快照调用 resolver。
   * - 群组 / self 在 preload 已过滤,此处再做防御性跳过
   * - phone_jid 且 phoneCandidate 可靠 -> 精确匹配/新建
   * - lid / unknown -> unresolved(仅锚定外部身份),消息仍可入库
   */
  async syncContactsFromSnapshots(
    companyId: string,
    accountId: string,
    snapshots: WhatsAppContactSnapshotDto[],
  ): Promise<{ synced: number; skipped: number }> {
    let synced = 0;
    let skipped = 0;

    for (const snap of snapshots) {
      try {
        // 防御性过滤: 群组 / 自己不采集
        if (snap.isGroup || snap.isSelf) {
          skipped++;
          continue;
        }

        const displayName = sanitizeContactNameCandidate(snap.displayNameCandidate || '');

        await this.resolveWhatsAppContact({
          companyId,
          phoneDigits: snap.externalIdKind === 'phone_jid' ? snap.phoneCandidate : null,
          externalId: snap.externalId,
          displayNameCandidate: displayName,
          source: 'whatsapp_sync',
        });
        synced++;
      } catch (err: any) {
        this.logger.warn(
          `[syncContacts] 跳过快照 ${snap.externalId}: ${err?.message}`,
        );
        skipped++;
      }
    }

    this.logger.log(
      `[syncContacts] companyId=${companyId} accountId=${accountId} synced=${synced} skipped=${skipped}`,
    );
    return { synced, skipped };
  }

  /**
   * 通过 accountId 查找 WhatsApp Session,严格限定在当前用户所属租户内。
   *
   * TASK-102D: 替代 controller 中 (this.whatsappService as any).prisma 的直接访问;
   * 移除"取第一个活跃 session"的跨租户 fallback。
   */
  async findSessionByAccountId(accountId: string, user: any, currentCompanyId: string) {
    const selectedCompanyId = this.requireSelectedCompany(user, currentCompanyId);
    const normalizedAccountId = this.normalizeElectronAccountId(accountId);

    // 请求只能命中当前明确选择的一个公司；“用户有权访问”不是 webhook
    // 会话归属的充分条件，不能在多个 companyId 中搜索同名账号。
    const tenantWhere = { companyId: selectedCompanyId };

    // 1. sessionId 精确匹配(租户内)
    let session = await this.prisma.whatsAppSession.findFirst({
      where: { sessionId: normalizedAccountId, ...tenantWhere },
    });

    // 2. Electron accountId 只命中显式、持久化的同租户映射。不能把
    // `default` 猜成“当前唯一活跃账号”，也不能用手机号模糊认领。
    if (!session) {
      session = await this.prisma.whatsAppSession.findFirst({
        where: {
          authStatePath: this.electronAuthStatePath(normalizedAccountId),
          ...tenantWhere,
        },
      });
    }

    return session;
  }

  /**
   * Establish or repair the durable Electron account -> tenant/session map.
   * The authenticated X-Company-Id is authoritative; accountId is only a
   * validated opaque local partition key and can never claim another tenant's
   * Baileys session.
   */
  async ensureElectronSessionMapping(
    accountId: string,
    user: any,
    currentCompanyId: string,
    status: 'connected' | 'waiting_scan' | 'reconnecting' | 'disconnected' = 'connected',
  ) {
    const companyId = this.requireSelectedCompany(user, currentCompanyId);
    const normalizedAccountId = this.normalizeElectronAccountId(accountId);
    const authStatePath = this.electronAuthStatePath(normalizedAccountId);
    const deterministicSessionId = this.electronSessionId(companyId, normalizedAccountId);

    let session = await this.prisma.whatsAppSession.findFirst({
      where: { companyId, authStatePath },
    });
    let auditAction: string | null = null;

    const stateData = {
      status,
      lastSeenAt: new Date(),
      ...(status === 'connected' ? { connectedAt: new Date(), disconnectedAt: null } : {}),
      ...(status === 'disconnected' ? { disconnectedAt: new Date() } : {}),
    };

    if (session) {
      if (session.sessionId !== deterministicSessionId) {
        const occupied = await this.prisma.whatsAppSession.findFirst({
          where: { sessionId: deterministicSessionId },
        });
        if (occupied && occupied.id !== session.id) {
          throw new BadRequestException(
            'Electron WhatsApp account mapping conflicts with an existing tenant session',
          );
        }
        auditAction = 'whatsapp.electron_mapping.repaired';
      }
      session = await this.prisma.whatsAppSession.update({
        where: { id: session.id },
        data: {
          ...stateData,
          ...(session.sessionId !== deterministicSessionId
            ? { sessionId: deterministicSessionId }
            : {}),
        },
      });
    } else {
      const occupied = await this.prisma.whatsAppSession.findFirst({
        where: { sessionId: deterministicSessionId },
      });
      if (occupied) {
        if (occupied.companyId !== companyId || occupied.authStatePath !== authStatePath) {
          throw new ForbiddenException(
            'Electron WhatsApp account mapping is already owned by another tenant or transport',
          );
        }
        session = await this.prisma.whatsAppSession.update({
          where: { id: occupied.id },
          data: stateData,
        });
      } else {
        auditAction = 'whatsapp.electron_mapping.created';
        try {
          session = await this.prisma.whatsAppSession.create({
            data: {
              companyId,
              accountName: `Electron WhatsApp (${normalizedAccountId})`,
              phoneNumber: null,
              sessionId: deterministicSessionId,
              authStatePath,
              ...stateData,
            },
          });
        } catch (error) {
          const candidate = error as { code?: string };
          if (candidate?.code !== 'P2002') throw error;
          const raced = await this.prisma.whatsAppSession.findFirst({
            where: { companyId, sessionId: deterministicSessionId, authStatePath },
          });
          if (!raced) throw error;
          session = raced;
          auditAction = 'whatsapp.electron_mapping.race_reused';
        }
      }
    }

    // The mapping row is the runtime authority; AuditLog provides a durable
    // operator trail without exposing Electron cookies or WhatsApp secrets.
    if (auditAction) {
      try {
        await this.prisma.auditLog.create({
          data: {
            companyId,
            userId: user?.id || null,
            action: auditAction,
            entityType: 'WhatsAppSession',
            entityId: session.id,
            newValue: {
              accountId: normalizedAccountId,
              sessionId: session.sessionId,
              transport: 'electron_dom',
              status,
            },
          },
        });
      } catch (error: any) {
        this.logger.error(
          `Failed to write Electron WhatsApp mapping audit for ${session.id}: ${error?.message}`,
        );
      }
    }

    return session;
  }

  private requireSelectedCompany(user: any, currentCompanyId: string): string {
    const companyIds: string[] =
      (user?.companies?.map((company: any) => company.id) as string[]) || [];
    const selectedCompanyId = currentCompanyId?.trim();
    if (!selectedCompanyId) {
      throw new BadRequestException('X-Company-Id is required for Electron WhatsApp ingestion');
    }
    if (!companyIds.includes(selectedCompanyId)) {
      throw new ForbiddenException('Selected company is not available to the current user');
    }
    return selectedCompanyId;
  }

  private normalizeElectronAccountId(accountId: string): string {
    const normalized = accountId?.trim();
    if (!ELECTRON_ACCOUNT_ID_PATTERN.test(normalized || '')) {
      throw new BadRequestException('Electron WhatsApp accountId is invalid');
    }
    return normalized;
  }

  private electronAuthStatePath(accountId: string): string {
    return `${ELECTRON_AUTH_STATE_PREFIX}${Buffer.from(accountId, 'utf8').toString('base64url')}`;
  }

  private electronSessionId(companyId: string, accountId: string): string {
    const digest = createHash('sha256')
      .update(JSON.stringify([companyId, accountId, 'electron_dom']))
      .digest('hex')
      .slice(0, 32);
    return `electron-${digest}`;
  }

  private isElectronManagedSession(session: { authStatePath?: string | null }): boolean {
    return session.authStatePath?.startsWith(ELECTRON_AUTH_STATE_PREFIX) === true;
  }

  buildMessageIngestionKey(
    companyId: string,
    sessionDbId: string,
    providerMessageId: string,
  ): string {
    const normalizedMessageId = providerMessageId?.trim();
    if (!companyId || !sessionDbId || !normalizedMessageId) {
      throw new BadRequestException('A tenant, WhatsApp session, and provider message id are required');
    }
    return createHash('sha256')
      .update(JSON.stringify([companyId, sessionDbId, normalizedMessageId]))
      .digest('hex');
  }

  private async enqueueOwnerWhatsappInbound(params: {
    companyId: string;
    sourceMessageKey: string;
    sourceType: 'whatsapp_baileys' | 'whatsapp_evolution' | 'whatsapp_electron';
    sourceId?: string | null;
    conversationId?: string | null;
    leadId?: string | null;
    subject?: string | null;
    preview?: string | null;
  }): Promise<void> {
    try {
      await this.ownerNotificationService.enqueueInbound({
        companyId: params.companyId,
        eventType: 'WHATSAPP_INBOUND',
        sourceMessageKey: params.sourceMessageKey,
        sourceType: params.sourceType,
        sourceId: params.sourceId,
        conversationId: params.conversationId,
        leadId: params.leadId,
        subject: params.subject,
        preview: params.preview,
      });
    } catch (error: any) {
      // Message ingestion is authoritative and must not be rolled back by a
      // secondary notification outage. Keep this log metadata-only: never log
      // provider ids, customer addresses, previews, or exception text.
      this.logger.error(
        `Owner WhatsApp notification enqueue failed ` +
        `(company=${params.companyId}, source=${params.sourceType}, ` +
        `error=${error?.name || error?.code || 'unknown'})`,
      );
    }
  }

  /**
   * 服务器启动时自动恢复所有已连接/等待扫码的 WhatsApp 会话
   * 解决：后端重启后连接丢失，用户需要重新扫码的问题
   */
  async onModuleInit() {
    // A read-only/candidate backend may share the production database for
    // contract tests, but it must never restore or mutate live WhatsApp
    // sessions. Fail closed unless the production runtime explicitly opts in;
    // a missing or misspelled value must never touch live session state.
    if (process.env.WHATSAPP_RESTORE_SESSIONS !== 'true') {
      this.logger.log('WhatsApp session restore is disabled for this backend instance');
      return;
    }
    // 延迟 3 秒启动，等待其他模块初始化完成
    setTimeout(() => this.restoreSessions(), 3000);
  }

  private async restoreSessions() {
    try {
      const sessions = await this.prisma.whatsAppSession.findMany({
        where: {
          status: { in: ['connected', 'waiting_scan', 'pending_qr', 'reconnecting'] },
        },
      });

      if (sessions.length === 0) {
        this.logger.log('No WhatsApp sessions to restore');
        return;
      }

      this.logger.log(`Restoring ${sessions.length} WhatsApp session(s)...`);

      for (const session of sessions) {
        try {
          if (this.isElectronManagedSession(session)) {
            this.logger.log(
              `Skipping Electron-managed WhatsApp mapping ${session.sessionId} during Baileys restore`,
            );
            continue;
          }
          // 检查 auth state 目录是否存在
          const authDir = session.authStatePath || path.join(this.authStateBaseDir, session.sessionId);
          const fs = require('fs');
          if (!fs.existsSync(authDir)) {
            this.logger.warn(`Auth state dir not found for session ${session.sessionId}, skipping`);
            await this.prisma.whatsAppSession.update({
              where: { id: session.id },
              data: { status: 'disconnected' },
            });
            continue;
          }

          // 绑定事件监听器
          this.bindSessionEvents(session.id, session.sessionId, session.companyId);

          // 使用已保存的 auth state 重新初始化连接
          // 如果 auth state 有效，Baileys 会直接连接，不需要扫码
          const result = await this.adapter.initSession(session.sessionId, authDir);

          await this.prisma.whatsAppSession.update({
            where: { id: session.id },
            data: {
              qrCode: result.qrCode || null,
              qrCodeExpireAt: result.qrCode ? new Date(Date.now() + 60_000) : null,
              status: result.status,
            },
          });

          this.logger.log(
            `Session ${session.sessionId} restored: status=${result.status}` +
            (result.qrCode ? ' (needs QR scan)' : ' (connected automatically)'),
          );
        } catch (err: any) {
          this.logger.error(
            `Failed to restore session ${session.sessionId}: ${err?.message}`,
            err?.stack,
          );
          // 标记为断开，用户可以手动重连
          await this.prisma.whatsAppSession.update({
            where: { id: session.id },
            data: { status: 'disconnected' },
          }).catch(() => {});
        }
      }
    } catch (err: any) {
      this.logger.error(`restoreSessions failed: ${err?.message}`, err?.stack);
    }
  }

  /** Record a WhatsApp click from website and match/create lead */
  async recordClick(params: {
    whatsappNumber: string;
    companySlug?: string;
    companyId?: string;
    contactName?: string;
    companyName?: string;
    country?: string;
    sourceUrl?: string;
    utmSource?: string;
  }) {
    let company = null;
    if (params.companyId) {
      company = await this.prisma.company.findUnique({ where: { id: params.companyId } });
    } else if (params.companySlug) {
      company = await this.prisma.company.findUnique({ where: { slug: params.companySlug } });
    }
    if (!company) {
      company = await this.prisma.company.findFirst({ where: { isActive: true }, orderBy: { createdAt: 'asc' } });
    }
    if (!company) throw new NotFoundException('No active company');

    const phoneDigits = (params.whatsappNumber || '').replace(/\D/g, '');

    // TASK-102D: 走 IdentityResolutionService,不再截断国家码、不再写入 "WhatsApp: <phone>" 公司名
    const resolved = await this.resolveWhatsAppContact({
      companyId: company.id,
      phoneDigits,
      externalId: phoneDigits ? `${phoneDigits}@s.whatsapp.net` : params.whatsappNumber,
      displayNameCandidate: params.contactName || null,
      countryIso2: params.country || null,
      source: 'whatsapp_sync',
    });

    let leadId = resolved.leadId;
    let contactPointId = resolved.contactPointId;
    const isNew = resolved.action === 'created' || resolved.action === 'review_required';

    // 网站提供的真实公司名(非 "WhatsApp: <phone>" 占位)回写到新建 Lead
    if (leadId && params.companyName && isNew) {
      await this.prisma.lead
        .update({ where: { id: leadId }, data: { companyName: params.companyName } })
        .catch(() => {});
    }

    if (!leadId || !contactPointId) {
      // 号码无法解析为有效身份时,仅记录点击活动,不创建会话
      this.logger.warn(
        `[recordClick] whatsappNumber=${params.whatsappNumber} 无法解析为身份(action=${resolved.action}),仅记录点击`,
      );
      return { leadId: leadId || null, contactPointId: contactPointId || null, isNew };
    }

    const existingConv = await this.prisma.conversation.findFirst({
      where: { leadId, channel: 'whatsapp', status: 'active' },
    });
    if (!existingConv) {
      await this.prisma.conversation.create({
        data: {
          companyId: company.id,
          leadId,
          contactPointId,
          channel: 'whatsapp',
          status: 'active',
          lastMessageAt: new Date(),
          lastMessagePreview: `WhatsApp click from ${params.sourceUrl || 'website'}`,
        },
      });
    }

    await this.prisma.leadActivity.create({
      data: {
        companyId: company.id,
        leadId,
        activityType: 'whatsapp_logged',
        title: `WhatsApp click recorded`,
        description: `From: ${params.sourceUrl || 'website'}${params.utmSource ? ` | UTM: ${params.utmSource}` : ''}`,
        occurredAt: new Date(),
      },
    });

    return { leadId, contactPointId, isNew };
  }

  // ========== Account Management (WhatsAppSession) ==========

  async listAccounts(currentUser: any) {
    const companyIds = currentUser?.companies?.map((c: any) => c.id) || [];
    if (companyIds.length === 0) return [];
    return this.prisma.whatsAppSession.findMany({
      where: { companyId: { in: companyIds } },
      orderBy: { createdAt: 'desc' },
    });
  }

  async createAccount(dto: { name: string; phone?: string }, currentUser: any) {
    const companyIds = currentUser?.companies?.map((c: any) => c.id) || [];
    if (companyIds.length === 0) throw new BadRequestException('No company access');

    const companyId = companyIds[0];
    const sessionId = `wa-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const authStateDir = path.join(this.authStateBaseDir, sessionId);

    // 创建数据库记录
    const session = await this.prisma.whatsAppSession.create({
      data: {
        companyId,
        accountName: dto.name,
        phoneNumber: dto.phone || null,
        sessionId,
        status: 'pending_qr',
        authStatePath: authStateDir,
      },
    });

    // 先绑定事件监听器，再初始化 session（避免竞争条件）
    this.bindSessionEvents(session.id, sessionId, companyId);

    // 初始化 Baileys session 并获取 QR 码
    try {
      const result = await this.adapter.initSession(sessionId, authStateDir);

      await this.prisma.whatsAppSession.update({
        where: { id: session.id },
        data: {
          qrCode: result.qrCode || null,
          qrCodeExpireAt: new Date(Date.now() + 60_000),
          status: result.status,
        },
      });

      return {
        ...session,
        qrCode: result.qrCode,
        status: result.status,
      };
    } catch (err: any) {
      this.logger.error(`Failed to init WhatsApp session: ${err?.message}`);
      await this.prisma.whatsAppSession.update({
        where: { id: session.id },
        data: { status: 'disconnected' },
      });
      throw new BadRequestException(`WhatsApp session init failed: ${err?.message}`);
    }
  }

  async getQrCode(accountId: string, currentUser: any) {
    const session = await this.getAccountOrFail(accountId, currentUser);
    if (session.status === 'connected') {
      return { status: 'connected', qrCode: null, phoneNumber: session.phoneNumber };
    }

    // 如果 QR 过期，尝试获取最新的
    const isExpired =
      !session.qrCodeExpireAt || session.qrCodeExpireAt < new Date();

    if (isExpired) {
      // 从 adapter 的 emitter 获取最新 QR
      const emitter = this.adapter.getEventEmitter(session.sessionId);
      if (emitter) {
        // 触发重新生成（Baileys 会自动刷新）
        return {
          status: session.status,
          qrCode: session.qrCode,
          expireAt: session.qrCodeExpireAt,
          message: 'QR code refreshing...',
        };
      }
    }

    return {
      status: session.status,
      qrCode: session.qrCode,
      expireAt: session.qrCodeExpireAt,
    };
  }

  async getStatus(accountId: string, currentUser: any) {
    const session = await this.getAccountOrFail(accountId, currentUser);
    return {
      id: session.id,
      status: session.status,
      phoneNumber: session.phoneNumber,
      accountName: session.accountName,
      connectedAt: session.connectedAt,
      lastSeenAt: session.lastSeenAt,
    };
  }

  async reconnect(accountId: string, currentUser: any) {
    const session = await this.getAccountOrFail(accountId, currentUser);

    // 仅移除旧 socket，保留 EventEmitter（避免竞争条件）
    this.adapter.removeSocket(session.sessionId);

    // 先绑定事件监听器，再初始化 session（与 createAccount 保持一致）
    this.bindSessionEvents(session.id, session.sessionId, session.companyId);

    // 重新初始化
    const result = await this.adapter.initSession(
      session.sessionId,
      session.authStatePath || path.join(this.authStateBaseDir, session.sessionId),
    );

    await this.prisma.whatsAppSession.update({
      where: { id: session.id },
      data: {
        qrCode: result.qrCode || null,
        qrCodeExpireAt: new Date(Date.now() + 60_000),
        status: result.status,
      },
    });

    return {
      qrCode: result.qrCode,
      status: result.status,
    };
  }

  async disconnect(accountId: string, currentUser: any) {
    const session = await this.getAccountOrFail(accountId, currentUser);
    await this.adapter.disconnect(session.sessionId);
    await this.prisma.whatsAppSession.update({
      where: { id: session.id },
      data: {
        status: 'disconnected',
        disconnectedAt: new Date(),
      },
    });
    return { success: true };
  }

  async removeAccount(accountId: string, currentUser: any) {
    const session = await this.getAccountOrFail(accountId, currentUser);
    await this.adapter.disconnect(session.sessionId);
    return this.prisma.whatsAppSession.delete({ where: { id: accountId } });
  }

  async sendMessage(
    accountId: string,
    dto: { to: string; text: string },
    currentUser: any,
  ) {
    const session = await this.getAccountOrFail(accountId, currentUser);
    const jid = this.buildRecipientJid(dto.to);
    const receipt = await this.sendTextForSession(session, jid, dto.text);

    // Persist through the same idempotent provider-ingestion path used by
    // Baileys `fromMe` writeback. If the socket echoes this message later, the
    // provider id dedupe acknowledges it instead of creating a duplicate row.
    const isGroup = jid.toLowerCase().endsWith('@g.us');
    await this.handleEvolutionMessage({
      instanceName: session.sessionId,
      fromPhone: jid.split('@')[0],
      isGroup,
      ...(isGroup ? { groupJid: jid } : {}),
      messageContent: dto.text,
      messageId: receipt.providerMessageId,
      timestamp: receipt.acceptedAt,
      pushName: '',
      externalId: jid,
      phoneCandidate: !isGroup && /^\d{7,15}$/.test(jid.split('@')[0])
        ? jid.split('@')[0]
        : null,
      groupStatusSource: 'baileys_jid',
      transportSource: 'baileys_socket',
      direction: 'outbound',
    }, session.companyId);

    return receipt;
  }

  /**
   * Public provider contract for controller/OpenClaw integration. A resolved
   * promise always contains a real Baileys provider message id; every missing
   * socket, provider failure, or malformed receipt rejects instead.
   */
  async sendTextWithReceipt(
    accountId: string,
    to: string,
    text: string,
    currentUser: any,
  ): Promise<WhatsAppProviderSendReceipt> {
    const session = await this.getAccountOrFail(accountId, currentUser);
    const jid = this.buildRecipientJid(to);
    return this.sendTextForSession(session, jid, text);
  }

  private buildRecipientJid(to: string): string {
    try {
      return this.adapter.buildJid(to);
    } catch (error: any) {
      throw new BadRequestException(
        `Invalid WhatsApp recipient: ${error?.message || 'expected an E.164 number or provider JID'}`,
      );
    }
  }

  private async sendTextForSession(
    session: any,
    jid: string,
    text: string,
  ): Promise<WhatsAppProviderSendReceipt> {
    if (session.status !== 'connected' || !this.adapter.isConnected(session.sessionId)) {
      throw new ServiceUnavailableException('WhatsApp account is not connected');
    }
    if (!text?.trim()) {
      throw new BadRequestException('WhatsApp message text is required');
    }

    const result = await this.adapter.sendTextMessage(session.sessionId, jid, text);
    const providerMessageId = result.success ? result.messageId?.trim() : '';
    if (!result.success || !providerMessageId) {
      throw new ServiceUnavailableException(
        `WhatsApp provider rejected the message: ${result.error || 'missing provider message id'}`,
      );
    }
    const acceptedAt = new Date().toISOString();
    return {
      success: true,
      provider: 'baileys',
      providerMessageId,
      messageId: providerMessageId,
      status: 'accepted',
      acceptedAt,
    };
  }

  /**
   * 仅通过 WhatsApp 发送消息，不保存到数据库
   * 用于 CommunicationsService.addMessage 场景，避免双重保存
   */
  async sendTextOnly(
    accountId: string,
    to: string,
    text: string,
    currentUser: any,
  ): Promise<WhatsAppProviderSendReceipt> {
    return this.sendTextWithReceipt(accountId, to, text, currentUser);
  }

  /**
   * 仅通过 WhatsApp 发送媒体消息，不保存到数据库
   * 用于 CommunicationsService.addMessage 场景
   */
  async sendMediaOnly(
    accountId: string,
    to: string,
    options: {
      type: 'image' | 'document' | 'video' | 'audio';
      buffer?: Buffer;
      url?: string;
      filename?: string;
      caption?: string;
      mimeType?: string;
    },
    currentUser: any,
  ): Promise<WhatsAppProviderSendReceipt> {
    const session = await this.getAccountOrFail(accountId, currentUser);
    if (session.status !== 'connected' || !this.adapter.isConnected(session.sessionId)) {
      throw new ServiceUnavailableException('WhatsApp account is not connected');
    }
    const jid = this.buildRecipientJid(to);
    const result = await this.adapter.sendMediaMessage(session.sessionId, jid, options);
    const providerMessageId = result.success ? result.messageId?.trim() : '';
    if (!result.success || !providerMessageId) {
      throw new ServiceUnavailableException(
        `WhatsApp provider rejected the media message: ${result.error || 'missing provider message id'}`,
      );
    }
    const acceptedAt = new Date().toISOString();
    return {
      success: true,
      provider: 'baileys',
      providerMessageId,
      messageId: providerMessageId,
      status: 'accepted',
      acceptedAt,
    };
  }

  // ========== Private helpers ==========

  private async getAccountOrFail(accountId: string, currentUser: any) {
    const session = await this.prisma.whatsAppSession.findUnique({
      where: { id: accountId },
    });
    if (!session) throw new NotFoundException('WhatsApp account not found');
    const companyIds = currentUser?.companies?.map((c: any) => c.id) || [];
    if (!companyIds.includes(session.companyId)) {
      throw new NotFoundException('WhatsApp account not found');
    }
    return session;
  }

  private async handleConnected(sessionId: string, phoneNumber: string) {
    await this.prisma.whatsAppSession.update({
      where: { id: sessionId },
      data: {
        status: 'connected',
        phoneNumber,
        connectedAt: new Date(),
        qrCode: null,
        qrCodeExpireAt: null,
        lastSeenAt: new Date(),
      },
    });
    this.logger.log(`WhatsApp session ${sessionId} connected: ${phoneNumber}`);
  }

  private async handleDisconnected(sessionDbId: string) {
    await this.prisma.whatsAppSession.update({
      where: { id: sessionDbId },
      data: {
        status: 'disconnected',
        disconnectedAt: new Date(),
      },
    });
    this.logger.log(`WhatsApp session ${sessionDbId} disconnected, attempting auto-reconnect in 5s...`);

    // 自动重连 — 5秒后尝试重新连接
    setTimeout(async () => {
      try {
        const session = await this.prisma.whatsAppSession.findUnique({
          where: { id: sessionDbId },
        });
        if (!session || session.status === 'connected') {
          this.logger.log(`Session ${sessionDbId} already connected or removed, skipping reconnect`);
          return;
        }

        this.logger.log(`Auto-reconnecting session ${sessionDbId}...`);

        // 标记为重连中
        await this.prisma.whatsAppSession.update({
          where: { id: sessionDbId },
          data: { status: 'reconnecting' },
        });

        // 移除旧 socket 但保留 EventEmitter
        this.adapter.removeSocket(session.sessionId);

        // 重新绑定事件（确保监听器存在）
        this.bindSessionEvents(session.id, session.sessionId, session.companyId);

        // 重新初始化
        const result = await this.adapter.initSession(
          session.sessionId,
          session.authStatePath || path.join(this.authStateBaseDir, session.sessionId),
        );

        await this.prisma.whatsAppSession.update({
          where: { id: sessionDbId },
          data: {
            qrCode: result.qrCode || null,
            qrCodeExpireAt: result.qrCode ? new Date(Date.now() + 60_000) : null,
            status: result.status,
          },
        });

        this.logger.log(
          `Auto-reconnect result for ${sessionDbId}: status=${result.status}` +
          (result.qrCode ? ' (needs QR scan)' : ' (connected automatically)'),
        );
      } catch (err: any) {
        this.logger.error(`Auto-reconnect failed for ${sessionDbId}: ${err?.message}`, err?.stack);
        // 标记为断开，用户可以手动重连
        await this.prisma.whatsAppSession.update({
          where: { id: sessionDbId },
          data: { status: 'disconnected' },
        }).catch(() => {});
      }
    }, 5000);
  }

  private async handleIncomingMessage(
    companyId: string,
    sessionDbId: string,
    sessionId: string,
    msg: any,
    eventDirection?: 'inbound' | 'outbound',
  ) {
    try {
      const direction: 'inbound' | 'outbound' = eventDirection
        || (msg.key?.fromMe ? 'outbound' : 'inbound');
      const externalMessageId = msg.key?.id?.trim?.();
      if (!externalMessageId) {
        throw new BadRequestException('Baileys message id is required for reliable ingestion');
      }
      const ingestionKey = this.buildMessageIngestionKey(
        companyId,
        sessionDbId,
        externalMessageId,
      );
      const duplicate = await this.prisma.communicationMessage.findUnique({
        where: { ingestionKey },
        select: {
          id: true,
          content: true,
          conversationId: true,
          conversation: { select: { leadId: true } },
        },
      });
      if (duplicate) {
        this.logger.log(`[Baileys] Duplicate message acknowledged: ${externalMessageId}`);
        if (direction === 'inbound') {
          await this.enqueueOwnerWhatsappInbound({
            companyId,
            sourceMessageKey: externalMessageId,
            sourceType: 'whatsapp_baileys',
            sourceId: duplicate.id,
            conversationId: duplicate.conversationId,
            leadId: duplicate.conversation?.leadId || null,
            subject: msg.pushName || 'WhatsApp 新消息',
            preview: duplicate.content,
          });
        }
        return;
      }

      // [DEBUG] 确认新代码在运行 — 验证 Baileys socket 生命周期
      this.logger.log(
        `[DEBUG] handleIncomingMessage ACTIVE — companyId=${companyId}, ` +
        `sessionDbId=${sessionDbId}, msgId=${msg.key?.id || ''}, ` +
        `time=${new Date().toISOString()}`,
      );

      // 提取发送者号码 — 处理多种 JID 格式
      const rawJid = msg.key?.remoteJid || '';
      const jidDomain = rawJid.split('@')[1] || ''; // s.whatsapp.net | g.us | lid | broadcast | newsletter
      const isGroupChat = rawJid.includes('@g.us');
      let fromPhone = rawJid.split('@')[0] || '';
      // 保存完整的原始 JID，用于回复消息（LID/群组等非标准格式需要用原始 JID 回复）
      let originalJid = rawJid;

      // 如果是广播消息 (@broadcast)，跳过
      if (rawJid.includes('@broadcast')) {
        this.logger.log('Skipping broadcast message');
        return;
      }

      // 如果是群消息 (@g.us)，必须从 participant 获取真实发送方号码
      if (isGroupChat) {
        const participant = msg.key?.participant || msg.participant || '';
        if (participant) {
          fromPhone = participant.split('@')[0] || '';
          originalJid = participant; // 群消息回复用 participant 的 JID
        } else {
          // 群消息无 participant — 无法确定发送者，跳过避免群ID被当手机号
          this.logger.warn(
            `Group message without participant from ${rawJid}, skipping to prevent group ID being stored as phone number`
          );
          return;
        }
      }

      // WhatsApp LID 隐私格式 (@lid) — 客户开启了"隐藏手机号"
      // LID 不是真实手机号，不能用 @s.whatsapp.net 回复，必须用原始 @lid JID
      const isLid = jidDomain === 'lid';
      if (isLid) {
        this.logger.log(
          `LID privacy format detected: ${rawJid}. Will use original JID for replies. ` +
          `Storing LID prefix as identifier (not a real phone number).`
        );
        // fromPhone 保留 LID 前缀作为标识符，但标记为 LID 格式
        // 后续发消息时需要用 originalJid 而非 buildJid(fromPhone)
      }

      // 详细日志：记录原始 JID 用于排查号码问题
      this.logger.log(
        `Incoming WhatsApp message: rawJid=${rawJid}, fromPhone=${fromPhone}, ` +
        `pushName=${msg.pushName || ''}, msgId=${msg.key?.id || ''}, ` +
        `type=${Object.keys(msg.message || {})[0] || 'unknown'}`
      );

      // 手机号合法性校验 — 必须是纯数字且符合国际号码格式
      // WhatsApp 个人 JID 格式: 国家码+号码 (如 8613365923697), 长度 7-15 位
      // 群 ID 通常以非标准前缀开头或超过 15 位
      // LID 格式 (@lid) 跳过此校验 — 用 originalJid 回复
      if (!isLid && !/^\d{7,15}$/.test(fromPhone)) {
        this.logger.warn(
          `Invalid phone number: "${fromPhone}" from JID "${rawJid}". ` +
          `Does not match international phone format (7-15 digits). Skipping.`
        );
        // 最后尝试从 participant 获取
        const participant = msg.key?.participant || msg.participant || '';
        if (participant) {
          const altPhone = participant.split('@')[0] || '';
          if (/^\d{7,15}$/.test(altPhone)) {
            this.logger.log(`Using participant phone instead: ${altPhone}`);
            fromPhone = altPhone;
          } else {
            this.logger.warn(`Participant phone also invalid: "${altPhone}", skipping message`);
            return;
          }
        } else {
          return;
        }
      }
      // 提取消息内容 — 支持多种 WhatsApp 消息类型
      const m = msg.message;
      let messageContent = '';
      let contentType = 'text';

      if (m?.conversation) {
        messageContent = m.conversation;
      } else if (m?.extendedTextMessage?.text) {
        messageContent = m.extendedTextMessage.text;
      } else if (m?.imageMessage) {
        messageContent = m.imageMessage.caption || '[图片]';
        contentType = 'image';
      } else if (m?.videoMessage) {
        messageContent = m.videoMessage.caption || '[视频]';
        contentType = 'video';
      } else if (m?.audioMessage) {
        // 语音消息 — PTT (Push To Talk) 或普通音频
        const isPtt = (m.audioMessage as any)?.ptt === true;
        messageContent = isPtt ? '[语音消息]' : '[音频]';
        contentType = 'audio';
      } else if (m?.documentMessage) {
        const docName = m.documentMessage.fileName || '文档';
        messageContent = `[文档] ${docName}`;
        contentType = 'document';
      } else if (m?.stickerMessage) {
        messageContent = '[贴纸]';
        contentType = 'sticker';
      } else if (m?.contactMessage) {
        const contactName = m.contactMessage.displayName || '联系人';
        messageContent = `[联系人] ${contactName}`;
        contentType = 'contact';
      } else if (m?.locationMessage) {
        const lat = m.locationMessage.degreesLatitude;
        const lng = m.locationMessage.degreesLongitude;
        messageContent = `[位置] ${lat},${lng}`;
        contentType = 'location';
      } else if (m?.liveLocationMessage) {
        messageContent = '[实时位置]';
        contentType = 'location';
      } else if (m?.reactionMessage) {
        const reaction = m.reactionMessage.text || '';
        messageContent = `[表情回应] ${reaction}`;
        contentType = 'reaction';
      } else if (m?.viewOnceMessage?.message) {
        // 阅后即焚消息
        const inner = m.viewOnceMessage.message;
        if (inner.imageMessage) { messageContent = '[阅后即焚图片]'; contentType = 'image'; }
        else if (inner.videoMessage) { messageContent = '[阅后即焚视频]'; contentType = 'video'; }
        else { messageContent = '[阅后即焚消息]'; }
      } else if (m?.viewOnceMessageV2?.message) {
        const inner = m.viewOnceMessageV2.message;
        if (inner.imageMessage) { messageContent = '[阅后即焚图片]'; contentType = 'image'; }
        else if (inner.videoMessage) { messageContent = '[阅后即焚视频]'; contentType = 'video'; }
        else { messageContent = '[阅后即焚消息]'; }
      } else if (m?.protocolMessage) {
        // 系统消息（如撤回、加密通知等）
        messageContent = '[系统消息]';
        contentType = 'system';
      } else {
        messageContent = '[不支持的消息类型]';
        this.logger.warn(`Unsupported message type: ${JSON.stringify(Object.keys(m || {}))}`);
      }

      // 下载媒体文件（图片/视频/语音/文档）— 保存到 uploads/whatsapp/ 目录
      let attachmentsMeta: any = null;
      if (['image', 'video', 'audio', 'document', 'sticker'].includes(contentType)) {
        try {
          const mediaBuffer = await this.adapter.downloadMedia(sessionId, msg);
          if (mediaBuffer && mediaBuffer.data) {
            // 确保上传目录存在
            const uploadDir = path.join(process.cwd(), 'uploads', 'whatsapp');
            if (!fs.existsSync(uploadDir)) {
              fs.mkdirSync(uploadDir, { recursive: true });
            }

            // 生成文件名
            const ext = mediaBuffer.ext || '';
            const filename = `wa-${ingestionKey.slice(0, 32)}${ext}`;
            const filePath = path.join(uploadDir, filename);
            fs.writeFileSync(filePath, mediaBuffer.data);

            const mediaUrl = `/uploads/whatsapp/${filename}`;
            attachmentsMeta = {
              url: mediaUrl,
              originalName: contentType === 'document' ? (m?.documentMessage?.fileName || filename) : filename,
              mimeType: mediaBuffer.mimeType || '',
              size: mediaBuffer.data.length,
            };

            this.logger.log(`Media downloaded: ${contentType} -> ${mediaUrl} (${mediaBuffer.data.length} bytes)`);
          }
        } catch (mediaErr: any) {
          this.logger.error(`Failed to download media: ${mediaErr?.message}`);
        }
      }

      // 获取接待账号信息（WhatsAppSession）
      const waSession = await this.prisma.whatsAppSession.findUnique({
        where: { id: sessionDbId },
        select: { phoneNumber: true, accountName: true },
      });
      const receiverPhone = waSession?.phoneNumber || '';
      const receiverName = waSession?.accountName || '';

      // TASK-102D: 走 IdentityResolutionService 统一解析
      // - phone JID: phoneDigits -> E.164 -> 精确匹配/新建/待审
      // - LID 无真实号码: normalizedValue=null -> unresolved(仅锚定外部身份),消息仍入库
      // 不再截断国家码、不再跨渠道尾号查找、不再写入 "WhatsApp: <phone>" 公司名
      const phoneDigits = isLid ? null : (fromPhone || '').replace(/\D/g, '');
      // 群聊没有唯一客户主体。参与者号码只用于消息展示，不能触发客户自动建档，
      // 否则同一个群会把成员误建成一批孤立客户。
      const resolved = isGroupChat
        ? {
            contactPointId: null,
            leadId: null,
            action: 'unresolved' as const,
            normalizedValue: null,
          }
        : await this.resolveWhatsAppContact({
            companyId,
            phoneDigits,
            externalId: originalJid,
            displayNameCandidate: direction === 'inbound' ? (msg.pushName || null) : null,
            source: 'whatsapp_message',
          });

      const leadId = resolved.leadId;
      const contactPointId = resolved.contactPointId;

      // 拉取已解析的 Lead / ContactPoint 用于显示与会话关联(unresolved 时为 null)
      const lead = leadId
        ? await this.prisma.lead.findFirst({ where: { id: leadId, deletedAt: null } })
        : null;
      const cp = contactPointId
        ? await this.prisma.contactPoint.findUnique({ where: { id: contactPointId } })
        : null;

      // 对于 LID 消息，客户地址优先使用 ContactPoint 的 normalizedValue（真实手机号）。
      // 如果没有真实手机号，则存储完整 LID JID（而非仅前缀）。
      let customerAddress = fromPhone;
      if (isLid) {
        const realPhone = (cp?.normalizedValue && !cp.normalizedValue.includes('@') && /^\d{7,15}$/.test(cp.normalizedValue.replace('+', ''))
          ? cp.normalizedValue
          : null) ||
          (lead?.whatsapp && !lead.whatsapp.includes('@') ? lead.whatsapp : null);
        customerAddress = realPhone || originalJid;
      }

      // 以租户 + 接待 session + provider JID 形成稳定线程锚点；会话、
      // 消息、预览和入站活动作为一个原子单元提交。
      const externalThreadId = isGroupChat ? rawJid : originalJid;
      const occurredAt = new Date();
      let persisted: { conversation: any; messageId: string };
      try {
        persisted = await this.prisma.$transaction(async (tx) => {
          const persistedConversation = await this.upsertWhatsappConversation(tx, {
            companyId,
            sessionDbId,
            externalThreadId,
            isGroup: isGroupChat,
            groupStatusSource: 'baileys_jid',
            leadId: leadId || null,
            contactPointId: contactPointId || null,
            customerIdentityTrusted: !isGroupChat,
            subject: receiverName ? `WhatsApp接待: ${receiverName}` : 'WhatsApp 会话',
          });

          const persistedMessage = await tx.communicationMessage.create({
            data: {
              conversationId: persistedConversation.id,
              direction,
              content: messageContent,
              contentType,
              externalMessageId,
              ingestionKey,
              fromAddress: direction === 'outbound'
                ? (receiverPhone || receiverName || null)
                : customerAddress,
              toAddress: direction === 'outbound'
                ? customerAddress
                : (receiverPhone || receiverName || null),
              deliveryStatus: direction === 'outbound' ? 'sent' : null,
              ...(direction === 'outbound'
                ? { sentAt: occurredAt }
                : { receivedAt: occurredAt }),
              ...(attachmentsMeta ? { attachmentsMeta } : {}),
            },
          });

          await tx.conversation.updateMany({
            where: {
              id: persistedConversation.id,
              OR: [
                { lastMessageAt: null },
                { lastMessageAt: { lte: occurredAt } },
              ],
            },
            data: {
              lastMessageAt: occurredAt,
              lastMessagePreview: messageContent.slice(0, 200),
              ...(direction === 'inbound' ? { unreadCount: { increment: 1 } } : {}),
            },
          });

          if (direction === 'inbound' && leadId) {
            await tx.leadActivity.create({
              data: {
                companyId,
                leadId,
                activityType: 'whatsapp_message',
                title: `WhatsApp 消息接收${receiverName ? ` (${receiverName})` : ''}`,
                description: messageContent.slice(0, 500),
                occurredAt,
              },
            });
          }
          return {
            conversation: persistedConversation,
            messageId: persistedMessage.id,
          };
        });
      } catch (error) {
        const candidate = error as { code?: string; meta?: { target?: unknown } };
        if (candidate?.code === 'P2002' && String(candidate.meta?.target || '').includes('ingestionKey')) {
          this.logger.log(`[Baileys] Concurrent duplicate acknowledged: ${externalMessageId}`);
          if (direction === 'inbound') {
            const winner = await this.prisma.communicationMessage.findUnique({
              where: { ingestionKey },
              select: {
                id: true,
                content: true,
                conversationId: true,
                conversation: { select: { leadId: true } },
              },
            });
            if (winner) {
              await this.enqueueOwnerWhatsappInbound({
                companyId,
                sourceMessageKey: externalMessageId,
                sourceType: 'whatsapp_baileys',
                sourceId: winner.id,
                conversationId: winner.conversationId,
                leadId: winner.conversation?.leadId || null,
                subject: msg.pushName || 'WhatsApp 新消息',
                preview: winner.content,
              });
            }
          }
          return;
        }
        throw error;
      }

      const conversation = persisted.conversation;
      if (direction === 'inbound') {
        await this.enqueueOwnerWhatsappInbound({
          companyId,
          sourceMessageKey: externalMessageId,
          sourceType: 'whatsapp_baileys',
          sourceId: persisted.messageId,
          conversationId: conversation.id,
          leadId: leadId || null,
          subject: msg.pushName || 'WhatsApp 新消息',
          preview: messageContent,
        });
      }

      this.logger.log(
        `WhatsApp ${direction} message for ${customerAddress}: ${messageContent.slice(0, 50)}`,
      );

      // 主动获取客户头像 — 异步执行，不阻塞消息处理
      // 如果 ContactPoint 已缓存头像则直接使用，否则从 Baileys 获取并缓存
      let cachedAvatarUrl = cp?.avatarUrl || null;
      if (!cachedAvatarUrl && contactPointId) {
        // 异步获取头像（fire-and-forget），不阻塞 SSE 事件发射
        this.fetchAndCacheAvatar(conversation.id, sessionDbId, customerAddress, originalJid, contactPointId)
          .catch(() => {});
      }

      // 发射实时事件 — 推送给前端 SSE
      // fromPhone 使用真实手机号（LID 消息用 displayFromAddress），避免前端显示 LID 前缀
      this.eventBus.emit('whatsapp.message', {
        companyId,
        conversationId: conversation.id,
        leadId: leadId || null,
        leadName: lead?.companyName || null,
        fromPhone: customerAddress,
        receiverPhone,
        receiverName,
        messagePreview: messageContent.slice(0, 200),
        contentType,
        attachmentsMeta,
        avatarUrl: cachedAvatarUrl,
        timestamp: occurredAt.toISOString(),
        direction,
      });
    } catch (err: any) {
      this.logger.error(`Failed to handle incoming WhatsApp message: ${err?.message}`, err?.stack);
      throw err;
    }
  }

  private bindSessionEvents(sessionDbId: string, sessionId: string, companyId: string) {
    // 使用 ensureEmitter 确保 EventEmitter 已创建
    // 即使 initSession 还没调用，也能先绑定事件监听器
    const emitter = this.adapter.ensureEmitter(sessionId);

    // 避免重复绑定 — 只移除 service 层的监听器（以 __svcBound 标识）
    // 不使用 removeAllListeners()，因为这会清除所有监听器，
    // 导致 adapter 内部自动重连后消息事件监听器丢失
    const eventNames = [
      'connected',
      'disconnected',
      'qr',
      'message',
      'message-status',
      'reconnecting',
      'error',
    ];
    for (const evt of eventNames) {
      const listeners = emitter.listeners(evt);
      for (const listener of listeners) {
        if ((listener as any).__svcBound) {
          emitter.off(evt, listener as (...args: any[]) => void);
        }
      }
    }

    const onConnected = async ({ phoneNumber }: any) => {
      this.logger.log(`Connected event received for session ${sessionDbId}, phone: ${phoneNumber}`);
      try {
        await this.handleConnected(sessionDbId, phoneNumber);
      } catch (err: any) {
        this.logger.error(`handleConnected failed: ${err?.message}`, err?.stack);
      }
    };
    (onConnected as any).__svcBound = true;
    emitter.on('connected', onConnected);

    const onDisconnected = async () => {
      this.logger.log(`Disconnected event received for session ${sessionDbId}`);
      try {
        await this.handleDisconnected(sessionDbId);
      } catch (err: any) {
        this.logger.error(`handleDisconnected failed: ${err?.message}`, err?.stack);
      }
    };
    (onDisconnected as any).__svcBound = true;
    emitter.on('disconnected', onDisconnected);

    const onQr = async ({ qrCode }: any) => {
      this.logger.log(`QR refresh event received for session ${sessionDbId}`);
      try {
        // 检查当前会话状态 — 只有在未连接状态下才更新 QR 码
        // 避免重连过程中生成的 QR 码覆盖已连接状态
        const current = await this.prisma.whatsAppSession.findUnique({
          where: { id: sessionDbId },
          select: { status: true },
        });

        if (current?.status === 'connected') {
          this.logger.log(
            `Session ${sessionDbId} is connected, ignoring QR refresh ` +
            `(likely generated during auto-reconnect, will resolve automatically)`,
          );
          return;
        }

        await this.prisma.whatsAppSession.update({
          where: { id: sessionDbId },
          data: {
            qrCode,
            qrCodeExpireAt: new Date(Date.now() + 60_000),
            status: 'waiting_scan',
          },
        });
      } catch (err: any) {
        this.logger.error(`QR update failed: ${err?.message}`, err?.stack);
      }
    };
    (onQr as any).__svcBound = true;
    emitter.on('qr', onQr);

    const onMessage = async ({ msg, direction }: any) => {
      try {
        await this.handleIncomingMessage(companyId, sessionDbId, sessionId, msg, direction);
      } catch (err: any) {
        this.logger.error(`handleIncomingMessage failed: ${err?.message}`, err?.stack);
      }
    };
    (onMessage as any).__svcBound = true;
    emitter.on('message', onMessage);

    const onMessageStatus = async ({ messageId, status }: any) => {
      try {
        await this.updateMessageStatus(sessionId, messageId, status);
      } catch (err: any) {
        this.logger.error(`updateMessageStatus failed: ${err?.message}`, err?.stack);
      }
    };
    (onMessageStatus as any).__svcBound = true;
    emitter.on('message-status', onMessageStatus);

    const onReconnecting = async () => {
      this.logger.log(`Session ${sessionDbId} reconnecting...`);
      try {
        // 标记为重连中，前端可以显示"重连中"状态
        // 不清除 qrCode，避免前端闪烁
        await this.prisma.whatsAppSession.update({
          where: { id: sessionDbId },
          data: {
            status: 'reconnecting',
          },
        });
      } catch (err: any) {
        this.logger.error(`Failed to update reconnecting status: ${err?.message}`);
      }
    };
    (onReconnecting as any).__svcBound = true;
    emitter.on('reconnecting', onReconnecting);

    const onError = ({ message }: { message: string }) => {
      this.logger.error(`Session ${sessionDbId} error: ${message}`);
    };
    (onError as any).__svcBound = true;
    emitter.on('error', onError);

    this.logger.log(`Service-layer event listeners bound for session ${sessionDbId} (sessionId: ${sessionId})`);
  }

  private async findOrCreateConversation(
    companyId: string,
    phone: string,
    whatsappSessionId?: string,
    receiverPhone?: string,
    receiverName?: string,
  ) {
    // TASK-102D: 走 IdentityResolutionService,移除截断国家码的 normalizePhone、
    // 跨渠道尾号查找与 "WhatsApp: <phone>" 占位公司名
    const phoneDigits = (phone || '').replace(/\D/g, '');
    const resolved = await this.resolveWhatsAppContact({
      companyId,
      phoneDigits,
      externalId: phoneDigits ? `${phoneDigits}@s.whatsapp.net` : phone,
      source: 'whatsapp_message',
    });

    const leadId = resolved.leadId;
    const contactPointId = resolved.contactPointId;

    // 按 whatsappSessionId 隔离不同接待账号的会话。
    // 有 leadId 时按 Lead 关联;unresolved 时按 externalThreadId(phone) 聚合,
    // contactPointId 可为 null,消息仍可入库。
    if (!whatsappSessionId) {
      throw new BadRequestException(
        'WhatsApp session id is required to create a stable conversation thread',
      );
    }

    // Outbound and inbound paths share the same database race boundary. A
    // Lead id is mutable CRM data and therefore cannot be the thread identity;
    // the provider JID plus receiving session is stable across concurrent
    // workers and later contact linking.
    const externalThreadId = phoneDigits
      ? `${phoneDigits}@s.whatsapp.net`
      : phone;
    const hasTrustedPhone = /^\d{7,15}$/.test(phoneDigits);
    return this.upsertWhatsappConversation(this.prisma, {
      companyId,
      sessionDbId: whatsappSessionId,
      externalThreadId,
      isGroup: false,
      groupStatusSource: 'baileys_jid',
      leadId: leadId || null,
      contactPointId: contactPointId || null,
      customerIdentityTrusted: hasTrustedPhone,
      ...(receiverName ? { subject: `WhatsApp接待: ${receiverName}` } : {}),
    });
  }

  // ========== Evolution API 集成方法 ==========

  /**
   * 创建 Evolution API 实例（替代原有的 createAccount 中的 Baileys 直连）
   * 使用 Evolution API 管理连接，Webhook 接收消息
   */
  async createEvolutionInstance(dto: { name: string; phone?: string }, currentUser: any) {
    // Fail before creating a database row when the optional service is disabled
    // or incompletely configured.
    const webhookUrl = this.evolutionApi.getWebhookUrl();
    const companyIds = currentUser?.companies?.map((c: any) => c.id) || [];
    if (companyIds.length === 0) throw new BadRequestException('No company access');

    const companyId = companyIds[0];
    const instanceName = `jyml-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

    // 创建数据库记录
    const session = await this.prisma.whatsAppSession.create({
      data: {
        companyId,
        accountName: dto.name,
        phoneNumber: dto.phone || null,
        sessionId: instanceName,
        status: 'pending_qr',
        authStatePath: `evolution-api:${instanceName}`,
      },
    });

    try {
      // 调用 Evolution API 创建实例
      const result = await this.evolutionApi.createInstance(instanceName, webhookUrl);

      const qrCode = result?.qrcode?.base64 || '';
      const status = result?.instance?.status || 'waiting_scan';

      await this.prisma.whatsAppSession.update({
        where: { id: session.id },
        data: {
          qrCode,
          qrCodeExpireAt: qrCode ? new Date(Date.now() + 60_000) : null,
          status,
        },
      });

      this.logger.log(
        `Evolution instance created: ${instanceName} (status: ${status})`,
      );

      return {
        ...session,
        qrCode,
        status,
      };
    } catch (err: any) {
      this.logger.error(`Failed to create Evolution instance: ${err?.message}`);
      await this.prisma.whatsAppSession.update({
        where: { id: session.id },
        data: { status: 'disconnected' },
      });
      throw new BadRequestException(`Evolution instance creation failed: ${err?.message}`);
    }
  }

  /**
   * 获取客户 WhatsApp 头像 URL
   * 前端通过此接口获取头像，用于在聊天界面显示
   */
  async getCustomerAvatar(conversationId: string, currentUser: any): Promise<{ avatarUrl: string | null }> {
    const conversation = await this.prisma.conversation.findUnique({
      where: { id: conversationId },
      include: {
        contactPoint: true,
        lead: { select: { whatsapp: true } },
      },
    });
    if (!conversation) {
      throw new NotFoundException('Conversation not found');
    }

    // 权限检查
    const companyIds = currentUser?.companies?.map((c: any) => c.id) || [];
    if (!companyIds.includes(conversation.companyId)) {
      throw new BadRequestException('No access to this conversation');
    }

    // 如果 ContactPoint 已缓存头像，直接返回
    if (conversation.contactPoint?.avatarUrl) {
      return { avatarUrl: conversation.contactPoint.avatarUrl };
    }

    // 获取 WhatsAppSession 以取得 sessionId
    const sessionId = conversation.whatsappSessionId;
    if (!sessionId) {
      return { avatarUrl: null };
    }

    const session = await this.prisma.whatsAppSession.findUnique({
      where: { id: sessionId },
    });
    if (!session || session.status !== 'connected') {
      return { avatarUrl: null };
    }

    // 构建候选 JID 列表 — 优先使用真实手机号 JID，其次 LID JID
    const jids: string[] = [];
    const realPhone = conversation.lead?.whatsapp || conversation.contactPoint?.normalizedValue || '';
    if (realPhone && !realPhone.includes('@') && /^\d{7,15}$/.test(realPhone.replace('+', ''))) {
      jids.push(`${realPhone.replace('+', '')}@s.whatsapp.net`);
    }
    const lidJid = conversation.externalThreadId || conversation.contactPoint?.originalValue || '';
    if (lidJid && !jids.includes(lidJid)) {
      jids.push(lidJid);
    }
    if (jids.length === 0) {
      return { avatarUrl: null };
    }

    // 逐个尝试获取头像
    let avatarUrl: string | null = null;
    for (const jid of jids) {
      avatarUrl = await this.adapter.getProfilePictureUrl(session.sessionId, jid);
      if (avatarUrl) break;
    }

    // 缓存头像 URL 到 ContactPoint
    if (avatarUrl && conversation.contactPoint) {
      await this.prisma.contactPoint.update({
        where: { id: conversation.contactPoint.id },
        data: { avatarUrl },
      }).catch(() => {});
    }

    return { avatarUrl };
  }

  /**
   * 主动获取并缓存客户头像 — 在收到新消息时异步调用
   * 避免前端等待头像加载，收消息时预先缓存
   */
  private async fetchAndCacheAvatar(
    conversationId: string,
    sessionDbId: string,
    displayFromAddress: string,
    originalJid: string,
    contactPointId: string,
  ): Promise<void> {
    try {
      const session = await this.prisma.whatsAppSession.findUnique({
        where: { id: sessionDbId },
      });
      if (!session || session.status !== 'connected') return;

      // 构建候选 JID 列表 — 优先真实手机号 JID
      const jids: string[] = [];
      const realPhone = displayFromAddress?.replace('+', '') || '';
      if (realPhone && !realPhone.includes('@') && /^\d{7,15}$/.test(realPhone)) {
        jids.push(`${realPhone}@s.whatsapp.net`);
      }
      if (originalJid && !jids.includes(originalJid)) {
        jids.push(originalJid);
      }
      if (jids.length === 0) return;

      // 逐个尝试获取头像
      for (const jid of jids) {
        const avatarUrl = await this.adapter.getProfilePictureUrl(session.sessionId, jid);
        if (avatarUrl) {
          // 缓存到 ContactPoint
          await this.prisma.contactPoint.update({
            where: { id: contactPointId },
            data: { avatarUrl },
          }).catch(() => {});
          this.logger.log(`Avatar cached for conversation ${conversationId}: ${avatarUrl.substring(0, 60)}...`);
          return;
        }
      }
      this.logger.debug(`No avatar found for conversation ${conversationId} (tried ${jids.length} JIDs)`);
    } catch (err: any) {
      this.logger.debug(`fetchAndCacheAvatar failed: ${err?.message}`);
    }
  }

  /**
   * 获取 Evolution 实例的 QR 码或连接状态
   */
  async getEvolutionQrCode(accountId: string, currentUser: any) {
    this.evolutionApi.assertEnabled();
    const session = await this.getAccountOrFail(accountId, currentUser);

    if (session.status === 'connected') {
      return { status: 'connected', qrCode: null, phoneNumber: session.phoneNumber };
    }

    // 调用 Evolution API 获取连接状态和 QR 码
    const result = await this.evolutionApi.connectInstance(session.sessionId);

    const qrCode = result?.qrcode?.base64 || '';
    const status = result?.instance?.status || 'waiting_scan';

    if (qrCode) {
      await this.prisma.whatsAppSession.update({
        where: { id: session.id },
        data: {
          qrCode,
          qrCodeExpireAt: new Date(Date.now() + 60_000),
          status,
        },
      });
    }

    return {
      status,
      qrCode,
      expireAt: session.qrCodeExpireAt,
    };
  }

  /**
   * 通过 Evolution API 发送文本消息
   */
  async sendEvolutionText(
    accountId: string,
    to: string,
    text: string,
    currentUser: any,
  ) {
    this.evolutionApi.assertEnabled();
    const session = await this.getAccountOrFail(accountId, currentUser);

    const result = await this.evolutionApi.sendTextMessage(
      session.sessionId,
      to,
      text,
    );

    if (!result.success) {
      throw new BadRequestException(`Send failed: ${result.error}`);
    }

    return result;
  }

  /**
   * 通过 Evolution API 发送媒体消息
   */
  async sendEvolutionMedia(
    accountId: string,
    to: string,
    options: {
      type: 'image' | 'document' | 'video' | 'audio';
      url?: string;
      filename?: string;
      caption?: string;
      mimeType?: string;
    },
    currentUser: any,
  ) {
    this.evolutionApi.assertEnabled();
    const session = await this.getAccountOrFail(accountId, currentUser);

    const result = await this.evolutionApi.sendMediaMessage(
      session.sessionId,
      to,
      options,
    );

    if (!result.success) {
      throw new BadRequestException(`Send media failed: ${result.error}`);
    }

    return result;
  }

  /**
   * 断开 Evolution 实例
   */
  async disconnectEvolution(accountId: string, currentUser: any) {
    this.evolutionApi.assertEnabled();
    const session = await this.getAccountOrFail(accountId, currentUser);

    await this.evolutionApi.logoutInstance(session.sessionId);

    await this.prisma.whatsAppSession.update({
      where: { id: session.id },
      data: { status: 'disconnected' },
    });

    this.logger.log(`Evolution instance ${session.sessionId} disconnected`);
  }

  /**
   * All WhatsApp transports share this atomic conversation boundary. The
   * database unique key is deliberately independent from a Lead link because
   * one customer may expose multiple provider JIDs and one JID must never
   * create two active CRM threads during concurrent ingestion.
   */
  private async upsertWhatsappConversation(
    db: any,
    params: {
      companyId: string;
      sessionDbId: string;
      externalThreadId: string;
      isGroup: boolean | null;
      groupStatusSource: string | null;
      leadId: string | null;
      contactPointId: string | null;
      customerIdentityTrusted: boolean;
      subject?: string;
    },
  ) {
    const canonicalThreadKey =
      `whatsapp:${params.sessionDbId}:${params.externalThreadId}`;
    const customerLinkAllowed = params.isGroup === false
      && params.customerIdentityTrusted;
    const update = params.isGroup === true
      ? {
          isGroup: true,
          groupStatusSource: params.groupStatusSource,
          leadId: null,
          contactPointId: null,
          status: 'active',
        }
      : customerLinkAllowed
        ? {
            isGroup: false,
            groupStatusSource: params.groupStatusSource,
            status: 'active',
            ...(params.leadId ? { leadId: params.leadId } : {}),
            ...(params.contactPointId ? { contactPointId: params.contactPointId } : {}),
          }
        : { status: 'active' };

    return db.conversation.upsert({
      where: {
        companyId_channel_threadKey: {
          companyId: params.companyId,
          channel: 'whatsapp',
          threadKey: canonicalThreadKey,
        },
      },
      create: {
        companyId: params.companyId,
        leadId: customerLinkAllowed ? (params.leadId || null) : null,
        contactPointId: customerLinkAllowed ? (params.contactPointId || null) : null,
        channel: 'whatsapp',
        isGroup: params.isGroup,
        groupStatusSource: params.groupStatusSource,
        status: 'active',
        whatsappSessionId: params.sessionDbId,
        externalThreadId: params.externalThreadId,
        threadKey: canonicalThreadKey,
        ...(params.subject ? { subject: params.subject } : {}),
      },
      update,
    });
  }

  // ========== Webhook 回调方法（供 EvolutionWebhookController 调用） ==========

  /**
   * Webhook: QR 码更新
   */
  async updateQrCode(instanceName: string, qrCode: string) {
    const session = await this.prisma.whatsAppSession.findFirst({
      where: { sessionId: instanceName },
    });

    if (!session) return;

    await this.prisma.whatsAppSession.update({
      where: { id: session.id },
      data: {
        qrCode,
        qrCodeExpireAt: new Date(Date.now() + 60_000),
        status: 'waiting_scan',
      },
    });

    this.logger.log(`QR code updated via webhook for ${instanceName}`);
  }

  /**
   * Webhook: 连接状态更新
   */
  async updateConnectionStatus(
    instanceName: string,
    status: string,
    phoneNumber?: string,
  ) {
    const session = await this.prisma.whatsAppSession.findFirst({
      where: { sessionId: instanceName },
    });

    if (!session) return;

    await this.prisma.whatsAppSession.update({
      where: { id: session.id },
      data: {
        status,
        ...(phoneNumber ? { phoneNumber } : {}),
        ...(status === 'connected'
          ? { connectedAt: new Date(), lastSeenAt: new Date() }
          : {}),
      },
    });

    this.logger.log(
      `Connection status updated via webhook: ${instanceName} → ${status}`,
    );
  }

  /**
   * Webhook: 处理 Evolution API 推送的新消息
   * Evolution API 已正确提取 participant，不再需要自己处理 @g.us
   */
  async handleEvolutionMessage(data: {
    instanceName: string;
    fromPhone: string;
    isGroup: boolean | null;
    groupJid?: string;
    messageContent: string;
    mediaInfo?: any;
    messageId: string;
    timestamp: string;
    pushName: string;
    // TASK-102D: 可信 JID/LID/号码候选(Electron 路径从 data-id 提取,非状态文本猜测)
    externalId?: string;
    externalIdKind?: 'phone_jid' | 'lid' | 'unknown';
    phoneCandidate?: string | null;
    displayNameCandidate?: string;
    groupStatusSource?: 'electron_dom_jid' | 'evolution_webhook_jid' | 'baileys_jid';
    transportSource?: 'electron_dom' | 'evolution_webhook' | 'baileys_socket';
    direction?: 'inbound' | 'outbound';
  }, expectedCompanyId?: string) {
    const session = await this.prisma.whatsAppSession.findFirst({
      where: {
        sessionId: data.instanceName,
        ...(expectedCompanyId ? { companyId: expectedCompanyId } : {}),
      },
    });

    if (!session) {
      this.logger.warn(`No session found for instance: ${data.instanceName}`);
      if (expectedCompanyId) {
        throw new BadRequestException(
          `WhatsApp session ${data.instanceName} is not bound to selected company ${expectedCompanyId}`,
        );
      }
      return;
    }

    const companyId = session.companyId;
    const externalMessageId = data.messageId?.trim();
    if (!externalMessageId) {
      throw new BadRequestException('WhatsApp message id is required for reliable ingestion');
    }
    const occurredAt = new Date(data.timestamp);
    if (!Number.isFinite(occurredAt.getTime())) {
      throw new BadRequestException('WhatsApp message timestamp is invalid');
    }
    const ingestionKey = this.buildMessageIngestionKey(
      companyId,
      session.id,
      externalMessageId,
    );
    const direction = data.direction === 'outbound' ? 'outbound' : 'inbound';
    const notificationSourceType = data.transportSource === 'electron_dom'
      ? 'whatsapp_electron'
      : 'whatsapp_evolution';

    // Normal outbox replay is rejected before identity resolution or any CRM
    // side effect. The unique key below remains the final race-safe boundary.
    const alreadyIngested = await this.prisma.communicationMessage.findUnique({
      where: { ingestionKey },
      select: {
        id: true,
        content: true,
        conversationId: true,
        conversation: { select: { leadId: true } },
      },
    });
    if (alreadyIngested) {
      this.logger.log(`[Evolution] Duplicate message acknowledged: ${externalMessageId}`);
      if (direction === 'inbound') {
        await this.enqueueOwnerWhatsappInbound({
          companyId,
          sourceMessageKey: externalMessageId,
          sourceType: notificationSourceType,
          sourceId: alreadyIngested.id,
          conversationId: alreadyIngested.conversationId,
          leadId: alreadyIngested.conversation?.leadId || null,
          subject: data.displayNameCandidate || data.pushName || 'WhatsApp new message',
          preview: alreadyIngested.content,
        });
      }
      return;
    }

    // 获取接待号码和名称
    const receiverPhone = session.phoneNumber || '';
    const receiverName = session.accountName || '';

    this.logger.log(
      `[Evolution] Processing message from ${data.fromPhone}` +
      (data.isGroup ? ` (group: ${data.groupJid})` : '') +
      `: ${data.messageContent.substring(0, 100)}`,
    );

    if (data.isGroup === true && !data.groupJid?.includes('@g.us')) {
      throw new BadRequestException(
        'WhatsApp group message requires a trusted @g.us group JID; retry after identity refresh',
      );
    }

    // TASK-102D: 私聊走 IdentityResolutionService 统一解析
    // - phoneCandidate 优先(Electron 从 JID 提取);否则回退 fromPhone(Evolution 提取)
    // - LID 无真实号码 -> unresolved,消息仍入库,contactPointId 为 null
    const isElectronDomSource = data.transportSource === 'electron_dom';
    const externalId = data.externalId
      || (!isElectronDomSource && data.fromPhone ? `${data.fromPhone}@s.whatsapp.net` : undefined);
    const isLidIdentity = externalId?.toLowerCase().endsWith('@lid') === true;
    const phoneDigits = isLidIdentity
      ? null
      : (data.phoneCandidate && /^\d{7,15}$/.test(data.phoneCandidate) ? data.phoneCandidate : null)
        || (!isElectronDomSource && data.fromPhone && /^\d{7,15}$/.test(data.fromPhone)
          ? data.fromPhone
          : null);
    const trustedPrivateJid = data.isGroup === false
      && !!externalId
      && /@(?:c\.us|s\.whatsapp\.net|lid)$/i.test(externalId);
    const privateIdentityAllowed = data.isGroup === false && trustedPrivateJid;

    // 与 Baileys 路径保持一致：群聊只入库群会话和消息，不自动创建群成员客户。
    const resolved = !privateIdentityAllowed
      ? {
          contactPointId: null,
          leadId: null,
          action: 'unresolved' as const,
          normalizedValue: null,
        }
      : await this.resolveWhatsAppContact({
          companyId,
          phoneDigits,
          externalId,
          displayNameCandidate: data.displayNameCandidate || data.pushName || null,
          source: 'whatsapp_message',
        });

    const leadId = resolved.leadId;
    const contactPointId = resolved.contactPointId;
    const threadKey = data.isGroup === true
      ? data.groupJid!
      : externalId || `electron-unknown:${session.id}:${data.messageId}`;
    const groupStatusSource = data.isGroup === null
      ? null
      : data.groupStatusSource || 'evolution_webhook_jid';

    // Persist the complete CRM ingestion unit atomically. Once ingestionKey
    // exists, conversation and lead side effects are guaranteed committed too.
    let persisted: { conversationId: string; messageId: string };
    try {
      persisted = await this.prisma.$transaction(async (tx) => {
    // 群消息按可信 groupJid 聚合且不关联 Lead；私聊有 leadId 时按 Lead 关联，
    // unresolved(LID) 时按 externalThreadId 聚合，contactPointId 可为 null。
        // Atomic upsert is the database-level race boundary. Two workers that
        // ingest different messages for a brand-new JID can no longer both
        // pass findFirst and create duplicate Conversation rows.
        const conversation = await this.upsertWhatsappConversation(tx, {
          companyId,
          sessionDbId: session.id,
          externalThreadId: threadKey,
          isGroup: data.isGroup,
          groupStatusSource,
          leadId: leadId || null,
          contactPointId: contactPointId || null,
          customerIdentityTrusted: privateIdentityAllowed,
          ...(receiverName ? { subject: `WhatsApp接待: ${receiverName}` } : {}),
        });

    // 保存消息到数据库 — unresolved 时仍入库 (TASK-102D)
    const persistedMessage = await tx.communicationMessage.create({
        data: {
          conversationId: conversation.id,
            direction,
            content: data.messageContent,
            contentType: data.mediaInfo ? data.mediaInfo.type : 'text',
            fromAddress: direction === 'outbound'
              ? (receiverPhone || data.instanceName)
              : data.fromPhone,
            toAddress: direction === 'outbound'
              ? data.fromPhone
              : (receiverPhone || data.instanceName),
            externalMessageId,
            ingestionKey,
            ...(direction === 'outbound'
              ? { sentAt: occurredAt }
              : { receivedAt: occurredAt }),
        },
      });

    // 更新会话最后消息
    await tx.conversation.updateMany({
      where: {
        id: conversation.id,
        OR: [
          { lastMessageAt: null },
          { lastMessageAt: { lte: occurredAt } },
        ],
      },
      data: {
        lastMessageAt: occurredAt,
        lastMessagePreview: data.messageContent.substring(0, 200),
      },
    });

    // 更新 Lead 的 pushName（如果有的话）— unresolved 时无 Lead,跳过
    if (direction === 'inbound' && data.pushName && leadId) {
      const lead = await tx.lead.findFirst({
        where: { id: leadId },
      });
      if (lead && !lead.contactName) {
        await tx.lead.update({
          where: { id: lead.id },
          data: { contactName: data.pushName },
        });
      }
    }

    // 发射 SSE 事件 — 推送到前端
        return {
          conversationId: conversation.id,
          messageId: persistedMessage.id,
        };
      });
    } catch (error) {
      const candidate = error as { code?: string; meta?: { target?: unknown } };
      if (candidate?.code === 'P2002' && String(candidate.meta?.target || '').includes('ingestionKey')) {
        this.logger.log(`[Evolution] Concurrent duplicate acknowledged: ${externalMessageId}`);
        if (direction === 'inbound') {
          const winner = await this.prisma.communicationMessage.findUnique({
            where: { ingestionKey },
            select: {
              id: true,
              content: true,
              conversationId: true,
              conversation: { select: { leadId: true } },
            },
          });
          if (winner) {
            await this.enqueueOwnerWhatsappInbound({
              companyId,
              sourceMessageKey: externalMessageId,
              sourceType: notificationSourceType,
              sourceId: winner.id,
              conversationId: winner.conversationId,
              leadId: winner.conversation?.leadId || null,
              subject: data.displayNameCandidate || data.pushName || 'WhatsApp new message',
              preview: winner.content,
            });
          }
        }
        return;
      }
      throw error;
    }

    if (direction === 'inbound') {
      await this.enqueueOwnerWhatsappInbound({
        companyId,
        sourceMessageKey: externalMessageId,
        sourceType: notificationSourceType,
        sourceId: persisted.messageId,
        conversationId: persisted.conversationId,
        leadId: leadId || null,
        subject: data.displayNameCandidate || data.pushName || 'WhatsApp new message',
        preview: data.messageContent,
      });
    }

    this.eventBus.emit('whatsapp.message', {
      companyId,
      conversationId: persisted.conversationId,
      leadId: leadId || null,
      fromPhone: data.fromPhone,
      receiverPhone,
      receiverName,
      messagePreview: data.messageContent.substring(0, 200),
      timestamp: data.timestamp,
      direction,
    });

    this.logger.log(
      `[Evolution] Message saved and SSE emitted: conversation=${persisted.conversationId}`,
    );
  }

  /**
   * Webhook: 更新消息状态（已读、已送达等）
   */
  async updateMessageStatus(
    instanceName: string,
    messageId: string,
    status: string,
  ) {
    const session = await this.prisma.whatsAppSession.findFirst({
      where: { sessionId: instanceName },
      select: { id: true, companyId: true },
    });
    if (!session) return;
    const ingestionKey = this.buildMessageIngestionKey(
      session.companyId,
      session.id,
      messageId,
    );

    // 更新数据库中消息的送达状态
    const message = await this.prisma.communicationMessage.findFirst({
      where: {
        OR: [
          { ingestionKey },
          {
            externalMessageId: messageId,
            conversation: {
              is: { companyId: session.companyId, whatsappSessionId: session.id },
            },
          },
        ],
      },
    });

    if (!message) return;

    // 将 WhatsApp 状态映射为我们的状态
    let deliveryStatus: string;
    switch (status) {
      case 'delivered':
        deliveryStatus = 'delivered';
        break;
      case 'read':
        deliveryStatus = 'read';
        break;
      case 'pending':
        deliveryStatus = 'pending';
        break;
      default:
        deliveryStatus = status;
    }

    await this.prisma.communicationMessage.update({
      where: { id: message.id },
      data: { deliveryStatus },
    });

    this.logger.debug(
      `Message status updated: ${messageId} → ${deliveryStatus}`,
    );
  }

  /**
   * 记录 Electron 客户端发送的消息
   * Electron 通过 WhatsApp Web DOM 注入文本并发送后，回调此方法记录到数据库
   */
  async recordOutboundMessage(data: {
    sessionId: string;
    companyId: string;
    toPhone: string;
    text: string;
    receiverPhone: string;
    receiverName: string;
    messageId?: string;
  }) {
    void data;
    throw new BadRequestException(
      'Legacy outbound recorder is disabled; use handleEvolutionMessage with direction=outbound',
    );
  }
}
