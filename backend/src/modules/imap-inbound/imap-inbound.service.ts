import { BadRequestException, ForbiddenException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { ImapFlow } from 'imapflow';
import { createHash } from 'crypto';
import { simpleParser } from 'mailparser';
import { PrismaService } from '../../common/prisma/prisma.service';
import { encrypt, decrypt } from '../../common/utils/crypto.util';
import { safeErrorCategory, safeLogEvent } from '../../common/security/safe-logging';

export type ImapMessage = {
  uid: number;
  source: Buffer | string;
};

export type ImapClient = {
  mailbox?: { uidValidity?: bigint | number };
  connect(): Promise<void>;
  logout(): Promise<void>;
  getMailboxLock(mailbox: string): Promise<{ release(): void }>;
  fetch(range: string, query: Record<string, unknown>, options?: Record<string, unknown>): AsyncIterable<ImapMessage>;
};

export type ImapFactory = (config: { host: string; port: number; secure: boolean; user: string; password: string }) => ImapClient;

export function normalizeEmail(value: string | null | undefined) {
  return String(value || '').trim().toLowerCase().replace(/^<|>$/g, '');
}

export async function parseRfc822(source: Buffer | string) {
  const mail = await simpleParser(Buffer.isBuffer(source) ? source : Buffer.from(source));
  const addresses = (field: any) => (field?.value || []).map((entry: any) => normalizeEmail(entry.address)).filter(Boolean);
  const from = normalizeEmail(mail.from?.value?.[0]?.address);
  const text = String(mail.text || '').slice(0, 200_000);
  const html = typeof mail.html === 'string' ? mail.html.slice(0, 500_000) : null;
  return {
    from, to: addresses(mail.to)[0] || null, cc: addresses(mail.cc),
    subject: String(mail.subject || '(no subject)'), date: mail.date || new Date(),
    messageId: normalizeEmail(mail.messageId) || null, html,
    text, rawHeaders: Object.fromEntries([...mail.headers.entries()].map(([k, v]) => [k, String(v)])),
    attachments: mail.attachments.map((a: any) => ({
      filename: String(a.filename || 'attachment').slice(0, 255), mimeType: String(a.contentType || 'application/octet-stream').slice(0, 127),
      size: Math.min(Number(a.size || a.content?.length || 0), 25 * 1024 * 1024),
    })),
  };
}

const defaultFactory: ImapFactory = (config) => new ImapFlow({
  host: config.host, port: config.port, secure: config.secure,
  auth: { user: config.user, pass: config.password },
  logger: false,
}) as unknown as ImapClient;

const IMAP_ERROR_CODES: Record<string, string> = {
  timeout: 'IMAP_TIMEOUT',
  network: 'IMAP_NETWORK_ERROR',
  provider_failure: 'IMAP_PROVIDER_ERROR',
  rejected: 'IMAP_REJECTED',
  internal_error: 'IMAP_INTERNAL_ERROR',
};
const STABLE_IMAP_ERROR_CODES = new Set(['IMAP_ERROR', ...Object.values(IMAP_ERROR_CODES)]);

/** 每小时总 IMAP 连接数上限（env IMAP_INBOUND_PER_HOUR_LIMIT，默认 120） */
const IMAP_INBOUND_PER_HOUR_LIMIT_DEFAULT = 120;
/** 滑动窗口宽度：1 小时 */
const IMAP_HOURLY_WINDOW_MS = 3_600_000;

@Injectable()
export class ImapInboundService {
  private readonly logger = new Logger(ImapInboundService.name);
  private factory: ImapFactory = defaultFactory;
  private poller?: NodeJS.Timeout;
  /** 最近 1 小时内的 IMAP 连接时间戳（滑动窗口，用于每小时总连接数限额） */
  private readonly hourlySyncTimestamps: number[] = [];

  constructor(private readonly prisma: PrismaService) {}

  onModuleInit() {
    this.poller = setInterval(() => void this.pollDue(), 60_000);
    this.poller.unref();
  }

  onModuleDestroy() { if (this.poller) clearInterval(this.poller); }

  private companyId(user: any) {
    const id = String(user?.activeCompanyId || user?.activeCompany?.id || '').trim();
    if (!id) throw new BadRequestException('No active company selected');
    return id;
  }

  async getConfig(user: any, accountId: string) {
    const account = await this.account(user, accountId);
    return this.publicAccount(account);
  }

  async updateConfig(user: any, accountId: string, dto: any) {
    this.requireAdmin(user);
    const account = await this.account(user, accountId);
    const data: any = {
      imapHost: dto.host?.trim() || null, imapPort: dto.port == null ? null : Number(dto.port),
      imapSecure: dto.tls !== false, imapUsername: dto.username?.trim() || null,
      inboundEnabled: Boolean(dto.enabled),
      inboundPollIntervalSeconds: Math.max(60, Number(dto.pollIntervalSeconds || 300)),
    };
    if (dto.secret) data.imapPasswordEncrypted = encrypt(String(dto.secret));
    const updated = await this.prisma.emailAccount.update({ where: { id: account.id }, data, select: this.select() });
    return this.publicAccount(updated);
  }

  async testConnection(user: any, accountId: string) {
    this.requireAdmin(user);
    const account = await this.account(user, accountId);
    const cfg = this.credentials(account);
    if (!cfg) return { ok: false, configured: false, message: 'IMAP is not configured' };
    const client = this.factory(cfg);
    try { await client.connect(); await client.logout();
      await this.prisma.emailAccount.update({ where: { id: account.id }, data: { inboundLastSyncStatus: 'connection_ok', inboundLastSyncError: null } });
      return { ok: true, configured: true };
    } catch (error) {
      const message = this.safeError(error);
      this.logger.warn(safeLogEvent('imap.connection_test_failed', {
        status: 'error', accountId: account.id, error,
      }));
      await this.prisma.emailAccount.update({ where: { id: account.id }, data: { inboundLastSyncStatus: 'connection_error', inboundLastSyncError: message } });
      return { ok: false, configured: true, message };
    }
  }

  async sync(user: any, accountId: string) { return this.syncAccount((await this.account(user, accountId)).id); }

  /**
   * 立即同步当前公司全部已启用 IMAP 账号（R111 批次B：Foxmail 式批量收信）。
   * 逐账号 try/catch 隔离，单个账号失败不影响其余账号。
   */
  async syncAll(user: any) {
    const companyId = this.companyId(user);
    const accounts = await this.prisma.emailAccount.findMany({
      where: { companyId, inboundEnabled: true, imapHost: { not: null }, imapUsername: { not: null } },
      select: this.select(),
    });
    const results: Array<{ accountId: string; senderEmail: string; status: string; fetched: number; error: string | null }> = [];
    for (const account of accounts) {
      try {
        const result = await this.syncAccount(account.id);
        const r = result as { status: string; received?: number; message?: string };
        results.push({
          accountId: account.id,
          senderEmail: account.senderEmail,
          status: r.status,
          fetched: r.received || 0,
          error: r.message || null,
        });
      } catch (error) {
        results.push({
          accountId: account.id,
          senderEmail: account.senderEmail,
          status: 'error',
          fetched: 0,
          error: this.safeError(error),
        });
      }
    }
    return results;
  }

  async listReviews(user: any) {
    const companyId = this.companyId(user);
    return this.prisma.emailInboundReview.findMany({ where: { companyId, status: 'pending' }, orderBy: { createdAt: 'asc' }, include: { communicationMessage: true } });
  }

  async resolveReview(user: any, reviewId: string, leadId: string) {
    this.requireAdmin(user);
    const companyId = this.companyId(user);
    const review = await this.prisma.emailInboundReview.findFirst({ where: { id: reviewId, companyId, status: 'pending' }, include: { communicationMessage: true } });
    if (!review) throw new NotFoundException('Inbound review not found');
    const candidateIds = Array.isArray(review.candidateLeadIds) ? review.candidateLeadIds.map(String) : [];
    const lead = await this.prisma.lead.findFirst({ where: { id: leadId, companyId, deletedAt: null, mergedToId: null } });
    if (!lead) throw new NotFoundException('Customer not found in active company');
    if (candidateIds.length && !candidateIds.includes(leadId)) throw new BadRequestException('Selected customer is not a review candidate');
    await this.prisma.$transaction(async (tx) => {
      await tx.conversation.update({ where: { id: review.communicationMessage.conversationId }, data: { leadId } });
      await tx.leadActivity.create({ data: { companyId, leadId, activityType: 'email_inbound_manual_link', title: 'Inbound email manually linked', description: review.communicationMessage.subject || 'Email', referenceType: 'communication_message', referenceId: review.communicationMessageId, communicationMessageId: review.communicationMessageId, metadata: { reviewId, fromEmail: review.fromEmail }, occurredAt: new Date() } });
      await tx.emailInboundReview.update({ where: { id: reviewId }, data: { status: 'resolved', resolvedLeadId: leadId, resolvedById: user.id, resolvedAt: new Date() } });
    });
    return { status: 'resolved', reviewId, leadId };
  }

  async syncAccount(accountId: string) {
    const account = await this.prisma.emailAccount.findUnique({ where: { id: accountId }, select: this.select() });
    if (!account) throw new NotFoundException('Email account not found');
    const cfg = this.credentials(account);
    if (!cfg) return { status: 'not_configured', accountId, received: 0 };
    // 计入每小时总连接数（滑动窗口；手动/轮询同步都会消耗配额，轮询超限时跳过本轮）
    this.recordSyncTick();
    const client = this.factory(cfg);
    let lock: { release(): void } | undefined;
    try {
      await client.connect(); lock = await client.getMailboxLock('INBOX');
      const uidValidity = BigInt((client.mailbox as any)?.uidValidity || 0);
      const cursor = account.inboundUidValidity === uidValidity ? account.inboundUidCursor : null;
      const range = cursor ? `${cursor + 1n}:*` : '1:*';
      let received = 0;
      let highestUid = cursor || 0n;
      for await (const item of client.fetch(range, { source: true }, { uid: true })) {
        if (cursor !== null && BigInt(item.uid) <= cursor) continue;
        highestUid = BigInt(Math.max(Number(highestUid), item.uid));
        const parsed = await parseRfc822(item.source);
        const sourceHash = createHash('sha256').update(item.source).digest('hex');
        const ingestionKey = parsed.messageId ? `imap:${account.id}:message:${parsed.messageId}` : `imap:${account.id}:raw:${sourceHash}`;
        try {
          const created = await this.store(account, item.uid, uidValidity, parsed, ingestionKey);
          if (created) received++;
        } catch (error: any) {
          if (error?.code !== 'P2002') throw error;
          // Another poller won the unique ingestion key race; its transaction is authoritative.
        }
      }
      await this.prisma.emailAccount.update({ where: { id: account.id }, data: { inboundLastSyncAt: new Date(), inboundLastSyncStatus: 'ok', inboundLastSyncError: null, inboundUidValidity: uidValidity, inboundUidCursor: highestUid } });
      return { status: 'ok', accountId, received };
    } catch (error) {
      const message = this.safeError(error);
      this.logger.warn(safeLogEvent('imap.sync_failed', {
        status: 'error', accountId: account.id, error,
      }));
      await this.prisma.emailAccount.update({ where: { id: account.id }, data: { inboundLastSyncAt: new Date(), inboundLastSyncStatus: 'error', inboundLastSyncError: message } });
      return { status: 'error', accountId, received: 0, message };
    } finally { try { lock?.release(); } catch {} try { await client.logout(); } catch {} }
  }

  private async store(account: any, uid: number, uidValidity: bigint, parsed: Awaited<ReturnType<typeof parseRfc822>>, ingestionKey: string) {
    const matches = parsed.from ? await this.prisma.contactPoint.findMany({ where: { companyId: account.companyId, type: 'email', normalizedValue: normalizeEmail(parsed.from), leadId: { not: null }, lead: { is: { deletedAt: null, mergedToId: null } } }, select: { leadId: true } }) : [];
    const leadIds = [...new Set(matches.map((m) => m.leadId).filter(Boolean) as string[])];
    const linkedLeadId = leadIds.length === 1 ? leadIds[0] : null;
    await this.prisma.$transaction(async (tx: any) => {
      const conversation = await tx.conversation.upsert({ where: { companyId_channel_threadKey: { companyId: account.companyId, channel: 'business_email', threadKey: ingestionKey } }, update: {}, create: { companyId: account.companyId, leadId: linkedLeadId, channel: 'business_email', subject: parsed.subject, externalThreadId: parsed.messageId, threadKey: ingestionKey, lastMessageAt: parsed.date, lastMessagePreview: parsed.text.slice(0, 240), unreadCount: 1 } });
      const message = await tx.communicationMessage.create({ data: { conversationId: conversation.id, direction: 'inbound', content: parsed.text, htmlContent: parsed.html, contentType: parsed.html ? 'html' : 'text', externalMessageId: String(uid), ingestionKey, fromAddress: parsed.from, toAddress: parsed.to, ccAddresses: parsed.cc, subject: parsed.subject, rawMessageId: parsed.messageId, sourceAccountId: account.id, imapUid: BigInt(uid), imapUidValidity: uidValidity, attachmentsMeta: parsed.attachments, receivedAt: Number.isNaN(parsed.date.getTime()) ? new Date() : parsed.date, deliveryStatus: 'received' } });
      if (linkedLeadId) {
        await tx.leadActivity.create({
          data: { companyId: account.companyId, leadId: linkedLeadId, activityType: 'email_inbound', title: parsed.subject, description: parsed.text.slice(0, 500), referenceType: 'communication_message', referenceId: message.id, communicationMessageId: message.id, metadata: { tag: 'email_inbound', fromEmail: parsed.from } },
        });
      } else {
        await tx.emailInboundReview.create({
          data: { companyId: account.companyId, communicationMessageId: message.id, fromEmail: parsed.from || '', reason: leadIds.length ? 'multiple_customer_matches' : 'no_customer_match', candidateLeadIds: leadIds },
        });
      }
    });
    return true;
  }

  /**
   * 轮询（60s 全局 tick）：
   * - 错峰：按账号各自到期时间排序执行，下一轮先处理到期最早的账号；
   *   首次同步（inboundLastSyncAt 为空）按账号 ID hash 偏移错开，避免多账号同时打 IMAP 服务器。
   * - 限额：IMAP_INBOUND_PER_HOUR_LIMIT（默认 120）限制每小时总 IMAP 连接数，
   *   触及上限跳过本轮（剩余账号记录日志）。
   */
  private async pollDue() {
    try {
      const accounts = await this.prisma.emailAccount.findMany({ where: { inboundEnabled: true, imapHost: { not: null }, imapUsername: { not: null } }, select: { id: true, inboundLastSyncAt: true, inboundPollIntervalSeconds: true } });
      if (accounts.length === 0) return;
      const now = Date.now();
      if (this.hourlyUsed(now) >= this.perHourLimit) {
        this.logger.warn(safeLogEvent('imap.poll_skipped_hour_limit', { status: 'warning', used: this.hourlyUsed(now), limit: this.perHourLimit, skippedAccounts: accounts.length }));
        return;
      }
      const due = accounts
        .map((a) => ({ account: a, nextDueAt: this.nextDueAt(a, now) }))
        .filter((x) => x.nextDueAt <= now)
        .sort((x, y) => x.nextDueAt - y.nextDueAt);
      if (due.length === 0) return;
      for (let i = 0; i < due.length; i++) {
        if (this.hourlyUsed(now) >= this.perHourLimit) {
          const skippedAccounts = due.slice(i).map((x) => x.account.id);
          this.logger.warn(safeLogEvent('imap.poll_skipped_hour_limit', { status: 'warning', used: this.hourlyUsed(now), limit: this.perHourLimit, skippedAccounts }));
          break;
        }
        await this.syncAccount(due[i].account.id);
      }
    } catch (error) {
      this.logger.warn(safeLogEvent('imap.poll_failed', { status: 'warning', error }));
    }
  }

  /** 账号下一轮到期时间：已同步过 = 上次同步 + 轮询间隔；从未同步 = now + ID hash 相位偏移（错峰） */
  private nextDueAt(account: { id: string; inboundLastSyncAt: Date | null; inboundPollIntervalSeconds: number }, now: number) {
    const intervalMs = Math.max(60, account.inboundPollIntervalSeconds || 300) * 1000;
    if (account.inboundLastSyncAt) return account.inboundLastSyncAt.getTime() + intervalMs;
    return now + this.phaseOffsetMs(account.id, intervalMs);
  }

  /** 按账号 ID hash 生成 [0, intervalMs) 相位偏移，per-account 轮询时间错开 */
  private phaseOffsetMs(accountId: string, intervalMs: number) {
    const digest = createHash('sha256').update(accountId).digest();
    return digest.readUInt32BE(0) % intervalMs;
  }

  /** 每小时总 IMAP 连接数上限（env IMAP_INBOUND_PER_HOUR_LIMIT，默认 120） */
  private get perHourLimit() {
    const raw = Number(process.env.IMAP_INBOUND_PER_HOUR_LIMIT);
    return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : IMAP_INBOUND_PER_HOUR_LIMIT_DEFAULT;
  }

  private recordSyncTick(now = Date.now()) {
    this.hourlySyncTimestamps.push(now);
    this.pruneHourly(now);
  }

  private hourlyUsed(now = Date.now()) {
    this.pruneHourly(now);
    return this.hourlySyncTimestamps.length;
  }

  private pruneHourly(now: number) {
    while (this.hourlySyncTimestamps.length > 0 && now - this.hourlySyncTimestamps[0] >= IMAP_HOURLY_WINDOW_MS) {
      this.hourlySyncTimestamps.shift();
    }
  }

  private credentials(account: any) { if (!account.imapHost || !account.imapUsername || !account.imapPasswordEncrypted) return null; return { host: account.imapHost, port: account.imapPort || 993, secure: account.imapSecure !== false, user: account.imapUsername, password: decrypt(account.imapPasswordEncrypted) }; }
  private async account(user: any, id: string) { const account = await this.prisma.emailAccount.findFirst({ where: { id, companyId: this.companyId(user) }, select: this.select() }); if (!account) throw new NotFoundException('Email account not found'); return account; }
  private select() { return { id: true, companyId: true, senderEmail: true, imapHost: true, imapPort: true, imapSecure: true, imapUsername: true, imapPasswordEncrypted: true, inboundEnabled: true, inboundPollIntervalSeconds: true, inboundLastSyncAt: true, inboundLastSyncStatus: true, inboundLastSyncError: true, inboundUidValidity: true, inboundUidCursor: true } as const; }
  private publicAccount(account: any) { return { id: account.id, companyId: account.companyId, address: account.senderEmail, configured: Boolean(account.imapHost && account.imapUsername && account.imapPasswordEncrypted), host: account.imapHost, port: account.imapPort, tls: account.imapSecure, username: account.imapUsername, enabled: account.inboundEnabled, pollIntervalSeconds: account.inboundPollIntervalSeconds, lastSyncAt: account.inboundLastSyncAt, lastSyncStatus: account.inboundLastSyncStatus, lastSyncError: this.publicErrorCode(account.inboundLastSyncError) }; }
  private safeError(error: unknown) { return IMAP_ERROR_CODES[safeErrorCategory(error)] || 'IMAP_ERROR'; }
  private publicErrorCode(value: unknown) { return value == null || value === '' ? null : STABLE_IMAP_ERROR_CODES.has(String(value)) ? String(value) : 'IMAP_ERROR'; }
  private requireAdmin(user: any) {
    const role = String(user?.activeCompany?.role || user?.role || '');
    if (!['super_admin', 'company_admin'].includes(role)) throw new ForbiddenException('Company administrator role is required');
  }
}
