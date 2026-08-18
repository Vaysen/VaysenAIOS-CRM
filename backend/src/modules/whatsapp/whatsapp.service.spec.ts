/**
 * TASK-102D: WhatsAppService 聚焦测试
 *
 * 覆盖场景:
 * 1. 联系人同步调用 IdentityResolutionService.resolve
 * 2. 群组 / self 被排除
 * 3. LID 无真实号码保持 unresolved(不创建 ContactPoint)
 * 4. session 查询限租户(无跨租户 fallback)
 * 5. 不再存储 "WhatsApp: <phone>" 公司名(Lead.create 不被 service 直接调用)
 * 6. unresolved(LID)消息仍入库(communicationMessage.create 被调用,contactPointId=null)
 */
// Mock whatsapp-adapter 以避免加载 baileys(ESM, Jest 无法解析)
jest.mock('./whatsapp-adapter', () => ({
  WhatsAppAdapter: class MockWhatsAppAdapter {},
}));
jest.mock('./evolution-api.service', () => ({
  EvolutionApiService: class MockEvolutionApiService {},
}));

import { Logger } from '@nestjs/common';
import { EventEmitter } from 'events';
import { WhatsAppService } from './whatsapp.service';
import { IdentityResolutionService } from '../customer-identity/identity-resolution.service';
import type { ResolveIdentityResult } from '../customer-identity/customer-identity.types';
import type { WhatsAppContactSnapshotDto } from './dto/electron-contacts.dto';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

function deepMock() {
  const target: Record<PropertyKey, any> = {};
  return new Proxy(
    target,
    {
      get: (state, property) => {
        if (!state[property]) {
          const fn: any = jest.fn();
          fn.mockReturnValue(fn);
          state[property] = fn;
        }
        return state[property];
      },
    },
  ) as any;
}

function createMockPrisma() {
  const prisma = {
    whatsAppSession: {
      findFirst: jest.fn(), findMany: jest.fn(), findUnique: jest.fn(),
      create: jest.fn(), update: jest.fn(), delete: jest.fn(),
    },
    conversation: {
      findFirst: jest.fn(), create: jest.fn(), update: jest.fn(), updateMany: jest.fn(),
      upsert: jest.fn(),
    },
    communicationMessage: {
      findUnique: jest.fn(), findFirst: jest.fn(), create: jest.fn(), update: jest.fn(),
      groupBy: jest.fn().mockResolvedValue([]),
    },
    lead: { findFirst: jest.fn(), create: jest.fn(), update: jest.fn() },
    contactPoint: {
      findUnique: jest.fn(), findFirst: jest.fn(), create: jest.fn(),
      update: jest.fn(), updateMany: jest.fn().mockResolvedValue({ count: 0 }),
    },
    externalIdentity: {
      findFirst: jest.fn().mockResolvedValue(null),
    },
    leadActivity: { create: jest.fn() },
    auditLog: { create: jest.fn() },
    userCompanyRelation: {
      findFirst: jest.fn(({ where }: any) => Promise.resolve({
        role: { name: where.userId === 'viewer-1' ? 'viewer' : 'company_admin' },
      })),
    },
  } as any;
  prisma.conversation.upsert.mockImplementation(async ({ create, update }: any) => {
    const existing = await prisma.conversation.findFirst();
    if (existing) {
      return prisma.conversation.update({ where: { id: existing.id }, data: update });
    }
    return prisma.conversation.create({ data: create });
  });
  prisma.communicationMessage.create.mockResolvedValue({ id: 'message-default' });
  prisma.$transaction = jest.fn(async (operation: (tx: typeof prisma) => unknown) => operation(prisma));
  return prisma;
}

function createService(overrides: { prisma?: any; resolver?: any } = {}) {
  const prisma = overrides.prisma ?? createMockPrisma();
  const resolver =
    overrides.resolver ??
    ({
      resolve: jest.fn(),
    } as unknown as IdentityResolutionService);
  const adapter = deepMock();
  const evolutionApi = deepMock();
  const eventBus = { emit: jest.fn() } as any;
  const ownerNotifications = {
    enqueueInbound: jest.fn().mockResolvedValue({ created: true, record: { id: 'notice-1' } }),
  } as any;
  const outbound = {
    execute: jest.fn(async (_request: any, provider: any) => ({
      outboxId: 'outbox-1',
      deduplicated: false,
      receipt: await provider(_request.artifacts || [], {
        targetAddress: String(_request.targetAddress || '').replace(/^\+/, '').replace(/@s\.whatsapp\.net$/i, ''),
        subject: String(_request.subject || '').trim(),
        body: String(_request.body || '').trim(),
        contentType: _request.contentType || 'text',
        artifacts: _request.artifacts || [],
        signal: new AbortController().signal,
      }),
    })),
  } as any;
  const service = new WhatsAppService(
    prisma,
    adapter,
    evolutionApi,
    eventBus,
    resolver,
    ownerNotifications,
    outbound,
  );
  // 抑制日志噪音
  jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
  jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
  jest.spyOn(Logger.prototype, 'debug').mockImplementation(() => undefined);
  return {
    service,
    prisma,
    resolver,
    adapter,
    evolutionApi,
    eventBus,
    ownerNotifications,
    outbound,
  };
}

function snapshot(partial: Partial<WhatsAppContactSnapshotDto>): WhatsAppContactSnapshotDto {
  return {
    externalId: '8613800001234@c.us',
    externalIdKind: 'phone_jid',
    phoneCandidate: '8613800001234',
    displayNameCandidate: 'Alice',
    isGroup: false,
    isSelf: false,
    observedAt: Date.now(),
    ...partial,
  };
}

function activeUser(companyId: string, otherCompanyIds: string[] = [], id = 'user-1') {
  const companies = [companyId, ...otherCompanyIds].map((company) => ({
    id: company,
    name: company,
    role: 'sales_user',
  }));
  return {
    id,
    activeCompanyId: companyId,
    activeCompany: companies[0],
    companies,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('WhatsAppService — TASK-102D', () => {
  afterEach(() => jest.restoreAllMocks());

  describe('startup session restore guard', () => {
    const originalRestoreSetting = process.env.WHATSAPP_RESTORE_SESSIONS;

    beforeEach(() => jest.useFakeTimers());

    afterEach(() => {
      if (originalRestoreSetting === undefined) {
        delete process.env.WHATSAPP_RESTORE_SESSIONS;
      } else {
        process.env.WHATSAPP_RESTORE_SESSIONS = originalRestoreSetting;
      }
      jest.useRealTimers();
    });

    it('does not schedule or query session restoration when explicitly disabled', async () => {
      process.env.WHATSAPP_RESTORE_SESSIONS = 'false';
      const { service } = createService();
      const restore = jest.spyOn(service as any, 'restoreSessions').mockResolvedValue(undefined);

      await service.onModuleInit();
      jest.advanceTimersByTime(3000);

      expect(restore).not.toHaveBeenCalled();
      expect(jest.getTimerCount()).toBe(0);
    });

    it('fails closed when the restore setting is missing', async () => {
      delete process.env.WHATSAPP_RESTORE_SESSIONS;
      const { service } = createService();
      const restore = jest.spyOn(service as any, 'restoreSessions').mockResolvedValue(undefined);

      await service.onModuleInit();
      jest.advanceTimersByTime(3000);

      expect(restore).not.toHaveBeenCalled();
      expect(jest.getTimerCount()).toBe(0);
    });

    it('restores sessions only after an explicit production opt-in', async () => {
      process.env.WHATSAPP_RESTORE_SESSIONS = 'true';
      const { service } = createService();
      const restore = jest.spyOn(service as any, 'restoreSessions').mockResolvedValue(undefined);

      await service.onModuleInit();
      jest.advanceTimersByTime(3000);

      expect(restore).toHaveBeenCalledTimes(1);
      expect(jest.getTimerCount()).toBe(0);
    });

    it('never starts a Baileys socket for an Electron-managed mapping', async () => {
      const { service, prisma, adapter } = createService();
      prisma.whatsAppSession.findMany.mockResolvedValue([{
        id: 'electron-row-1',
        companyId: 'co-1',
        sessionId: 'electron-abc',
        status: 'connected',
        authStatePath: 'electron-account:ZGVmYXVsdA',
      }]);

      await (service as any).restoreSessions();

      expect(adapter.initSession).not.toHaveBeenCalled();
      expect(prisma.whatsAppSession.update).not.toHaveBeenCalled();
    });
  });

  // 1. 联系人同步调用 resolver
  describe('syncContactsFromSnapshots', () => {
    it('对每条非群组/非 self 快照调用 IdentityResolutionService.resolve', async () => {
      const { service, resolver } = createService();
      (resolver.resolve as jest.Mock).mockResolvedValue({
        action: 'created',
        leadId: 'lead-1',
        contactId: 'contact-1',
        contactPointId: 'cp-1',
        externalIdentityId: 'ei-1',
        reason: 'new',
      } as ResolveIdentityResult);

      const snaps = [
        snapshot({ externalId: '8613800001111@c.us', phoneCandidate: '8613800001111' }),
        snapshot({ externalId: '8613800002222@c.us', phoneCandidate: '8613800002222' }),
      ];

      const result = await service.syncContactsFromSnapshots('co-1', 'acct-1', snaps);

      expect(resolver.resolve).toHaveBeenCalledTimes(2);
      expect(result.synced).toBe(2);
      expect(result.skipped).toBe(0);

      // 校验传给 resolver 的命令 — normalizedValue 应为 E.164(不再截断 86)
      const firstCall = (resolver.resolve as jest.Mock).mock.calls[0][0];
      expect(firstCall.channel).toBe('whatsapp');
      expect(firstCall.companyId).toBe('co-1');
      expect(firstCall.normalizedValue).toBe('+8613800001111');
      expect(firstCall.externalIdentity).toEqual({
        provider: 'whatsapp',
        externalId: '8613800001111@c.us',
      });
      expect(firstCall.source).toBe('whatsapp_sync');
    });

    // 2. 群组 / self 被排除
    it('跳过群组与 self 快照,不调用 resolver', async () => {
      const { service, resolver } = createService();
      (resolver.resolve as jest.Mock).mockResolvedValue({
        action: 'unresolved',
        externalIdentityId: 'ei-x',
        reason: 'no_normalized_value',
      } as ResolveIdentityResult);

      const snaps = [
        snapshot({ externalId: '120363xxx@g.us', isGroup: true, externalIdKind: 'unknown', phoneCandidate: null }),
        snapshot({ externalId: '8613800001234@c.us', isSelf: true }),
        snapshot({ externalId: '8613800009999@c.us', phoneCandidate: '8613800009999' }),
      ];

      const result = await service.syncContactsFromSnapshots('co-1', 'acct-1', snaps);

      expect(resolver.resolve).toHaveBeenCalledTimes(1);
      expect(result.skipped).toBe(2);
      expect(result.synced).toBe(1);
    });

    // 3. LID 保持 unresolved
    it('LID 快照: normalizedValue=null,结果 unresolved,不创建 ContactPoint/Lead', async () => {
      const { service, resolver, prisma } = createService();
      (resolver.resolve as jest.Mock).mockResolvedValue({
        action: 'unresolved',
        externalIdentityId: 'ei-lid',
        reason: 'no_normalized_value',
      } as ResolveIdentityResult);

      const lidSnap = snapshot({
        externalId: '234977878868136@lid',
        externalIdKind: 'lid',
        phoneCandidate: null,
        displayNameCandidate: 'LID User',
      });

      await service.syncContactsFromSnapshots('co-1', 'acct-1', [lidSnap]);

      const call = (resolver.resolve as jest.Mock).mock.calls[0][0];
      expect(call.normalizedValue).toBeNull();
      expect(call.externalIdentity).toEqual({
        provider: 'whatsapp',
        externalId: '234977878868136@lid',
      });
      // service 自身不直接创建 ContactPoint / Lead(resolver 已 mock 返回 unresolved)
      expect(prisma.contactPoint.create).not.toHaveBeenCalled();
      expect(prisma.lead.create).not.toHaveBeenCalled();
    });
  });

  // 4. session 查询限租户
  describe('findSessionByAccountId', () => {
    it('仅在用户所属租户内查询,不跨租户 fallback', async () => {
      const { service, prisma } = createService();
      prisma.whatsAppSession.findFirst.mockResolvedValue(null);

      const user = activeUser('co-B', ['co-A']);
      const result = await service.findSessionByAccountId('acct-1', user, 'co-B');

      expect(result).toBeNull();
      // 第一次: sessionId 匹配,只限定当前明确选择的 co-B
      const firstWhere = prisma.whatsAppSession.findFirst.mock.calls[0][0].where;
      expect(firstWhere.sessionId).toBe('acct-1');
      expect(firstWhere.companyId).toBe('co-B');
      // 第二次: Electron accountId 显式映射,仍只限 co-B
      const secondWhere = prisma.whatsAppSession.findFirst.mock.calls[1][0].where;
      expect(secondWhere.authStatePath).toMatch(/^electron-account:/);
      expect(secondWhere.companyId).toBe('co-B');
      // 只查询 2 次,无第三次"取第一个活跃 session"的跨租户 fallback
      expect(prisma.whatsAppSession.findFirst).toHaveBeenCalledTimes(2);
    });

    it('用户无租户时拒绝访问且不查询数据库', async () => {
      const { service, prisma } = createService();
      prisma.whatsAppSession.findFirst.mockResolvedValue(null);
      await expect(
        service.findSessionByAccountId('acct-1', { companies: [] }, 'co-A'),
      ).rejects.toThrow('An authenticated active company is required');
      expect(prisma.whatsAppSession.findFirst).not.toHaveBeenCalled();
    });

    it('does not guess that Electron default means the sole active Baileys session', async () => {
      const { service, prisma } = createService();
      prisma.whatsAppSession.findFirst.mockResolvedValue(null);
      prisma.whatsAppSession.findMany.mockResolvedValue([
        { sessionId: 'company-a-primary', companyId: 'co-A', status: 'connected' },
      ]);

      await expect(service.findSessionByAccountId(
        'default',
        activeUser('co-A'),
        'co-A',
      )).resolves.toBeNull();
      expect(prisma.whatsAppSession.findMany).not.toHaveBeenCalled();
    });

    it('resolves only an explicit Electron mapping in the selected tenant', async () => {
      const { service, prisma } = createService();
      prisma.whatsAppSession.findFirst
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce({
          sessionId: 'electron-explicit',
          companyId: 'co-A',
          authStatePath: 'electron-account:ZGVmYXVsdA',
        });

      await expect(service.findSessionByAccountId(
        'default',
        activeUser('co-A'),
        'co-A',
      )).resolves.toEqual(expect.objectContaining({ sessionId: 'electron-explicit' }));
    });

    it('creates a deterministic audited Electron mapping for exactly one tenant', async () => {
      const { service, prisma } = createService();
      prisma.whatsAppSession.findFirst.mockResolvedValue(null);
      prisma.whatsAppSession.create.mockImplementation(async ({ data }: any) => ({
        id: 'electron-row-1',
        ...data,
      }));
      prisma.auditLog.create.mockResolvedValue({ id: 'audit-1' });

      const result = await service.ensureElectronSessionMapping(
        'default',
        activeUser('co-B', ['co-A']),
        'co-B',
        'connected',
      );

      expect(result).toEqual(expect.objectContaining({
        companyId: 'co-B',
        sessionId: expect.stringMatching(/^electron-[a-f0-9]{32}$/),
        authStatePath: 'electron-account:ZGVmYXVsdA',
      }));
      expect(prisma.whatsAppSession.create).toHaveBeenCalledWith({
        data: expect.objectContaining({ companyId: 'co-B', status: 'connected' }),
      });
      expect(prisma.auditLog.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          companyId: 'co-B',
          userId: 'user-1',
          action: 'whatsapp.electron_mapping.created',
          entityId: 'electron-row-1',
        }),
      });
    });

    it('repairs a same-tenant legacy Electron mapping without claiming another session', async () => {
      const { service, prisma } = createService();
      prisma.whatsAppSession.findFirst
        .mockResolvedValueOnce({
          id: 'legacy-row',
          companyId: 'co-A',
          sessionId: 'legacy-local-id',
          authStatePath: 'electron-account:ZGVmYXVsdA',
        })
        .mockResolvedValueOnce(null);
      prisma.whatsAppSession.update.mockImplementation(async ({ data }: any) => ({
        id: 'legacy-row',
        companyId: 'co-A',
        authStatePath: 'electron-account:ZGVmYXVsdA',
        ...data,
      }));

      const result = await service.ensureElectronSessionMapping(
        'default',
        activeUser('co-A'),
        'co-A',
      );

      expect(result.sessionId).toMatch(/^electron-[a-f0-9]{32}$/);
      expect(prisma.whatsAppSession.update).toHaveBeenCalledWith({
        where: { id: 'legacy-row' },
        data: expect.objectContaining({
          sessionId: expect.stringMatching(/^electron-[a-f0-9]{32}$/),
        }),
      });
      expect(prisma.auditLog.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          action: 'whatsapp.electron_mapping.repaired',
          entityId: 'legacy-row',
        }),
      });
    });

    it('rejects unsafe Electron account ids before touching the database', async () => {
      const { service, prisma } = createService();

      await expect(service.ensureElectronSessionMapping(
        '../other-tenant',
        activeUser('co-A'),
        'co-A',
      )).rejects.toThrow('accountId is invalid');

      expect(prisma.whatsAppSession.findFirst).not.toHaveBeenCalled();
    });
  });

  // 5 & 6. handleEvolutionMessage
  describe('handleEvolutionMessage', () => {
    const baseSession = {
      id: 'sess-1',
      sessionId: 'wa-inst-1',
      companyId: 'co-1',
      phoneNumber: '8613900001111',
      accountName: 'Vaysen',
    };

    it('resolved(已链接)消息: 关联 contactPointId,不入库 WhatsApp: <phone> 公司名', async () => {
      const { service, resolver, prisma } = createService();
      prisma.whatsAppSession.findFirst.mockResolvedValue(baseSession);
      (resolver.resolve as jest.Mock).mockResolvedValue({
        action: 'linked',
        leadId: 'lead-1',
        contactId: 'contact-1',
        contactPointId: 'cp-1',
        externalIdentityId: 'ei-1',
        confidence: 'high',
        reason: 'exact_match',
      } as ResolveIdentityResult);
      prisma.conversation.findFirst.mockResolvedValue(null);
      prisma.conversation.create.mockResolvedValue({ id: 'conv-1' });
      prisma.lead.findFirst.mockResolvedValue({ id: 'lead-1', contactName: 'Alice' });

      await service.handleEvolutionMessage({
        instanceName: 'wa-inst-1',
        fromPhone: '8613800001234',
        isGroup: false,
        messageContent: 'Hello',
        messageId: 'm-1',
        timestamp: new Date().toISOString(),
        pushName: 'Alice',
        externalId: '8613800001234@c.us',
        externalIdKind: 'phone_jid',
        phoneCandidate: '8613800001234',
        displayNameCandidate: 'Alice',
      });

      // resolver 被调用,normalizedValue 为 E.164
      const call = (resolver.resolve as jest.Mock).mock.calls[0][0];
      expect(call.normalizedValue).toBe('+8613800001234');
      // 会话创建时带 contactPointId
      const createData = prisma.conversation.create.mock.calls[0][0].data;
      expect(createData.contactPointId).toBe('cp-1');
      expect(createData.leadId).toBe('lead-1');
      expect(createData.isGroup).toBe(false);
      expect(createData.groupStatusSource).toBe('evolution_webhook_jid');
      // service 不直接创建 Lead(由 resolver 负责),因此不会写入 WhatsApp: <phone>
      expect(prisma.lead.create).not.toHaveBeenCalled();
    });

    it('writes a valid private Evolution pushName when contactName is empty', async () => {
      const { service, resolver, prisma } = createService();
      prisma.whatsAppSession.findFirst.mockResolvedValue(baseSession);
      (resolver.resolve as jest.Mock).mockResolvedValue({
        action: 'linked', leadId: 'lead-valid-name', contactId: 'contact-1', contactPointId: 'cp-1',
        externalIdentityId: 'ei-valid-name', reason: 'exact_match',
      } as ResolveIdentityResult);
      prisma.conversation.findFirst.mockResolvedValue(null);
      prisma.conversation.create.mockResolvedValue({ id: 'conv-valid-name' });
      prisma.lead.findFirst.mockResolvedValue({ id: 'lead-valid-name', companyId: 'co-1', contactName: null });

      await service.handleEvolutionMessage({
        instanceName: 'wa-inst-1', fromPhone: '8613800001234', isGroup: false,
        messageContent: 'Hello from a private chat', messageId: 'm-valid-name',
        timestamp: new Date().toISOString(), pushName: 'Private buyer',
        externalId: '8613800001234@s.whatsapp.net', externalIdKind: 'phone_jid', phoneCandidate: '8613800001234',
      });

      expect(prisma.lead.update).toHaveBeenCalledWith({
        where: { id: 'lead-valid-name', companyId: 'co-1' },
        data: { contactName: 'Private buyer' },
      });
    });

    it('never writes a technical Evolution pushName such as last seen into contactName', async () => {
      const { service, resolver, prisma } = createService();
      prisma.whatsAppSession.findFirst.mockResolvedValue(baseSession);
      (resolver.resolve as jest.Mock).mockResolvedValue({
        action: 'linked', leadId: 'lead-status-name', contactId: 'contact-1', contactPointId: 'cp-1',
        externalIdentityId: 'ei-status-name', reason: 'exact_match',
      } as ResolveIdentityResult);
      prisma.conversation.findFirst.mockResolvedValue(null);
      prisma.conversation.create.mockResolvedValue({ id: 'conv-status-name' });
      prisma.lead.findFirst.mockResolvedValue({ id: 'lead-status-name', companyId: 'co-1', contactName: null });

      await service.handleEvolutionMessage({
        instanceName: 'wa-inst-1', fromPhone: '8613800001234', isGroup: false,
        messageContent: 'Status text must not become a name', messageId: 'm-status-name',
        timestamp: new Date().toISOString(), pushName: 'Last seen today at 10:30',
        externalId: '8613800001234@s.whatsapp.net', externalIdKind: 'phone_jid', phoneCandidate: '8613800001234',
      });

      expect((resolver.resolve as jest.Mock).mock.calls[0][0].contactNameCandidate).toBeUndefined();
      expect(prisma.lead.update).not.toHaveBeenCalledWith(expect.objectContaining({ data: { contactName: expect.anything() } }));
    });

    it('unresolved(LID)消息: contactPointId=null,但消息仍入库', async () => {
      const { service, resolver, prisma, eventBus } = createService();
      prisma.whatsAppSession.findFirst.mockResolvedValue(baseSession);
      (resolver.resolve as jest.Mock).mockResolvedValue({
        action: 'unresolved',
        externalIdentityId: 'ei-lid',
        reason: 'no_normalized_value',
      } as ResolveIdentityResult);
      prisma.conversation.findFirst.mockResolvedValue(null);
      prisma.conversation.create.mockResolvedValue({ id: 'conv-lid' });

      await service.handleEvolutionMessage({
        instanceName: 'wa-inst-1',
        fromPhone: '',
        isGroup: false,
        messageContent: 'LID message',
        messageId: 'm-lid',
        timestamp: new Date().toISOString(),
        pushName: 'LID User',
        externalId: '234977878868136@lid',
        externalIdKind: 'lid',
        phoneCandidate: null,
        displayNameCandidate: 'LID User',
      });

      // resolver 被调用,normalizedValue 为 null
      const call = (resolver.resolve as jest.Mock).mock.calls[0][0];
      expect(call.normalizedValue).toBeNull();
      expect(call.externalIdentity.externalId).toBe('234977878868136@lid');

      // 会话创建时 contactPointId 与 leadId 均为 null,但 externalThreadId 锚定 LID
      const createData = prisma.conversation.create.mock.calls[0][0].data;
      expect(createData.contactPointId).toBeNull();
      expect(createData.leadId).toBeNull();
      expect(createData.externalThreadId).toBe('234977878868136@lid');
      expect(createData.isGroup).toBe(false);
      expect(createData.groupStatusSource).toBe('evolution_webhook_jid');

      // 消息仍入库
      expect(prisma.communicationMessage.create).toHaveBeenCalledTimes(1);
      const msgData = prisma.communicationMessage.create.mock.calls[0][0].data;
      expect(msgData.conversationId).toBe('conv-lid');
      expect(msgData.content).toBe('LID message');

      // SSE 仍发射,leadId=null
      const ssePayload = (eventBus.emit as jest.Mock).mock.calls[0][1];
      expect(ssePayload.leadId).toBeNull();
    });

    it('Electron LID 即使携带数字 fromPhone 也绝不当作电话号码', async () => {
      const { service, resolver, prisma } = createService();
      prisma.whatsAppSession.findFirst.mockResolvedValue(baseSession);
      (resolver.resolve as jest.Mock).mockResolvedValue({
        action: 'unresolved', externalIdentityId: 'ei-lid-electron', reason: 'no_normalized_value',
      } as ResolveIdentityResult);
      prisma.conversation.findFirst.mockResolvedValue(null);
      prisma.conversation.create.mockResolvedValue({ id: 'conv-lid-electron' });

      await service.handleEvolutionMessage({
        instanceName: 'wa-inst-1',
        fromPhone: '234977878868136',
        isGroup: false,
        messageContent: 'LID privacy message',
        messageId: 'm-lid-electron',
        timestamp: new Date().toISOString(),
        pushName: 'Private user',
        externalId: '234977878868136@lid',
        externalIdKind: 'lid',
        phoneCandidate: null,
        transportSource: 'electron_dom',
        groupStatusSource: 'electron_dom_jid',
      });

      const command = (resolver.resolve as jest.Mock).mock.calls[0][0];
      expect(command.normalizedValue).toBeNull();
      expect(command.externalIdentity.externalId).toBe('234977878868136@lid');
    });

    it('Electron 缺少 DOM JID 时保持群聊属性未知且不解析或自动建档', async () => {
      const { service, resolver, prisma } = createService();
      prisma.whatsAppSession.findFirst.mockResolvedValue(baseSession);
      prisma.conversation.findFirst.mockResolvedValue(null);
      prisma.conversation.create.mockResolvedValue({ id: 'conv-unknown', isGroup: null });

      await service.handleEvolutionMessage({
        instanceName: 'wa-inst-1',
        fromPhone: '8613800009999',
        isGroup: null,
        messageContent: 'Untrusted DOM message',
        messageId: 'm-unknown',
        timestamp: new Date().toISOString(),
        pushName: 'Display only',
        transportSource: 'electron_dom',
      });

      expect(resolver.resolve).not.toHaveBeenCalled();
      expect(prisma.conversation.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          where: {
            companyId_channel_threadKey: {
              companyId: 'co-1',
              channel: 'whatsapp',
              threadKey: 'whatsapp:sess-1:electron-unknown:sess-1:m-unknown',
            },
          },
        }),
      );
      expect(prisma.conversation.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          isGroup: null,
          groupStatusSource: null,
          leadId: null,
          contactPointId: null,
        }),
      });
    });

    it('不为可解析号码写入 "WhatsApp: <phone>" 公司名(Lead.create 不被直接调用)', async () => {
      const { service, resolver, prisma } = createService();
      prisma.whatsAppSession.findFirst.mockResolvedValue(baseSession);
      (resolver.resolve as jest.Mock).mockResolvedValue({
        action: 'created',
        leadId: 'lead-new',
        contactId: 'contact-new',
        contactPointId: 'cp-new',
        externalIdentityId: 'ei-new',
        reason: 'new',
      } as ResolveIdentityResult);
      prisma.conversation.findFirst.mockResolvedValue(null);
      prisma.conversation.create.mockResolvedValue({ id: 'conv-new' });

      await service.handleEvolutionMessage({
        instanceName: 'wa-inst-1',
        fromPhone: '8613800005678',
        isGroup: false,
        messageContent: 'new contact',
        messageId: 'm-new',
        timestamp: new Date().toISOString(),
        pushName: 'New',
        externalId: '8613800005678@c.us',
        externalIdKind: 'phone_jid',
        phoneCandidate: '8613800005678',
      });

      expect(prisma.lead.create).not.toHaveBeenCalled();
      // 没有任何调用包含 "WhatsApp: " 公司名
      const allCreateCalls = prisma.lead.create.mock.calls as any[];
      expect(
        allCreateCalls.every((c) => !String(c?.[0]?.data?.companyName || '').startsWith('WhatsApp: ')),
      ).toBe(true);
    });

    it('stores the trusted Evolution groupJid on a server-marked group conversation', async () => {
      const { service, resolver, prisma } = createService();
      prisma.whatsAppSession.findFirst.mockResolvedValue(baseSession);
      (resolver.resolve as jest.Mock).mockResolvedValue({
        action: 'linked', leadId: 'participant-lead', contactId: 'participant-contact', contactPointId: 'participant-cp',
        externalIdentityId: 'ei-group-participant', reason: 'exact_match',
      } as ResolveIdentityResult);
      prisma.conversation.findFirst.mockResolvedValue(null);
      prisma.conversation.create.mockResolvedValue({ id: 'conv-group', isGroup: true });

      await service.handleEvolutionMessage({
        instanceName: 'wa-inst-1',
        fromPhone: '8613800001234',
        isGroup: true,
        groupJid: '120363000000000@g.us',
        messageContent: 'Group hello',
        messageId: 'm-group',
        timestamp: new Date().toISOString(),
        pushName: 'Alice',
      });

      expect(prisma.conversation.upsert.mock.calls[0][0].where).toEqual({
        companyId_channel_threadKey: {
          companyId: 'co-1',
          channel: 'whatsapp',
          threadKey: 'whatsapp:sess-1:120363000000000@g.us',
        },
      });
      const createData = prisma.conversation.create.mock.calls[0][0].data;
      expect(createData).toEqual(expect.objectContaining({
        isGroup: true,
        groupStatusSource: 'evolution_webhook_jid',
        externalThreadId: '120363000000000@g.us',
        leadId: null,
        contactPointId: null,
      }));
      expect(resolver.resolve).not.toHaveBeenCalled();
    });

    it('拒绝 isGroup=true 但缺少可信 @g.us 的服务端事件，绝不 200 静默丢失', async () => {
      const { service, prisma, resolver, eventBus } = createService();
      prisma.whatsAppSession.findFirst.mockResolvedValue(baseSession);

      await expect(service.handleEvolutionMessage({
        instanceName: 'wa-inst-1',
        fromPhone: '8613800001234',
        isGroup: true,
        messageContent: 'Untrusted group event',
        messageId: 'm-group-without-jid',
        timestamp: new Date().toISOString(),
        pushName: 'Alice',
      }, 'co-1')).rejects.toThrow('requires a trusted @g.us group JID');

      expect(prisma.whatsAppSession.findFirst).toHaveBeenCalledWith({
        where: { sessionId: 'wa-inst-1', companyId: 'co-1' },
      });
      expect(resolver.resolve).not.toHaveBeenCalled();
      expect(prisma.$transaction).not.toHaveBeenCalled();
      expect(prisma.communicationMessage.create).not.toHaveBeenCalled();
      expect(eventBus.emit).not.toHaveBeenCalled();
    });

    it('并发新消息使用同一个数据库线程唯一键，不执行 findFirst→create', async () => {
      const { service, resolver, prisma } = createService();
      prisma.whatsAppSession.findFirst.mockResolvedValue(baseSession);
      prisma.communicationMessage.findUnique.mockResolvedValue(null);
      (resolver.resolve as jest.Mock).mockResolvedValue({
        action: 'linked', leadId: 'lead-1', contactId: 'contact-1',
        contactPointId: 'cp-1', reason: 'exact_match',
      } as ResolveIdentityResult);
      prisma.conversation.upsert.mockImplementation(async () => ({
        id: 'conv-canonical', isGroup: false,
      }));
      prisma.communicationMessage.create.mockResolvedValue({ id: 'message-created' });

      const base = {
        instanceName: 'wa-inst-1',
        fromPhone: '8613800001234',
        isGroup: false as const,
        messageContent: 'concurrent',
        timestamp: new Date().toISOString(),
        pushName: 'Alice',
        externalId: '8613800001234@c.us',
        phoneCandidate: '8613800001234',
      };
      await Promise.all([
        service.handleEvolutionMessage({ ...base, messageId: 'm-concurrent-1' }),
        service.handleEvolutionMessage({ ...base, messageId: 'm-concurrent-2' }),
      ]);

      expect(prisma.conversation.upsert).toHaveBeenCalledTimes(2);
      for (const [args] of prisma.conversation.upsert.mock.calls) {
        expect(args.where).toEqual({
          companyId_channel_threadKey: {
            companyId: 'co-1',
            channel: 'whatsapp',
            threadKey: 'whatsapp:sess-1:8613800001234@c.us',
          },
        });
      }
      expect(prisma.conversation.create).not.toHaveBeenCalled();
      expect(prisma.communicationMessage.create).toHaveBeenCalledTimes(2);
    });

    it('Baileys 入站复用相同的 session+JID 唯一线程 upsert 形状', async () => {
      const { service, prisma } = createService();
      prisma.conversation.upsert.mockResolvedValue({ id: 'conv-baileys' });

      await (service as any).upsertWhatsappConversation(prisma, {
        companyId: 'co-1',
        sessionDbId: 'sess-1',
        externalThreadId: '8613800001234@s.whatsapp.net',
        isGroup: false,
        groupStatusSource: 'baileys_jid',
        leadId: 'lead-1',
        contactPointId: 'cp-1',
        customerIdentityTrusted: true,
        subject: 'WhatsApp接待: Vaysen',
      });

      expect(prisma.conversation.upsert).toHaveBeenCalledWith({
        where: {
          companyId_channel_threadKey: {
            companyId: 'co-1',
            channel: 'whatsapp',
            threadKey: 'whatsapp:sess-1:8613800001234@s.whatsapp.net',
          },
        },
        create: expect.objectContaining({
          threadKey: 'whatsapp:sess-1:8613800001234@s.whatsapp.net',
          externalThreadId: '8613800001234@s.whatsapp.net',
          groupStatusSource: 'baileys_jid',
          leadId: 'lead-1',
          contactPointId: 'cp-1',
        }),
        update: expect.objectContaining({
          groupStatusSource: 'baileys_jid',
          leadId: 'lead-1',
          contactPointId: 'cp-1',
        }),
      });
      expect(prisma.conversation.findFirst).not.toHaveBeenCalled();
      expect(prisma.conversation.create).not.toHaveBeenCalled();
    });

    it('outbound conversation creation also uses the session+JID atomic upsert', async () => {
      const { service, resolver, prisma } = createService();
      (resolver.resolve as jest.Mock).mockResolvedValue({
        action: 'linked', leadId: 'lead-1', contactId: 'contact-1',
        contactPointId: 'cp-1', reason: 'exact_match',
      } as ResolveIdentityResult);
      prisma.conversation.upsert.mockResolvedValue({ id: 'conv-outbound' });

      await (service as any).findOrCreateConversation(
        'co-1',
        '+86 138 0000 1234',
        'sess-1',
        '+86 153 0000 5678',
        'Vaysen',
      );

      expect(prisma.conversation.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          where: {
            companyId_channel_threadKey: {
              companyId: 'co-1',
              channel: 'whatsapp',
              threadKey: 'whatsapp:sess-1:8613800001234@s.whatsapp.net',
            },
          },
        }),
      );
      expect(prisma.conversation.findFirst).not.toHaveBeenCalled();
      expect(prisma.conversation.create).not.toHaveBeenCalled();
    });

    it('reclassifies only the exact canonical thread after a trusted new private message', async () => {
      const { service, resolver, prisma } = createService();
      prisma.whatsAppSession.findFirst.mockResolvedValue(baseSession);
      (resolver.resolve as jest.Mock).mockResolvedValue({
        action: 'linked',
        leadId: 'lead-1',
        contactId: 'contact-1',
        contactPointId: 'cp-1',
        externalIdentityId: 'ei-1',
        reason: 'exact_match',
      } as ResolveIdentityResult);
      prisma.conversation.findFirst.mockResolvedValue({
        id: 'legacy-conversation',
        externalThreadId: '8613800001234@c.us',
        isGroup: null,
      });
      prisma.conversation.update.mockResolvedValue({
        id: 'legacy-conversation',
        externalThreadId: '8613800001234@c.us',
        isGroup: false,
      });

      await service.handleEvolutionMessage({
        instanceName: 'wa-inst-1',
        fromPhone: '8613800001234',
        isGroup: false,
        messageContent: 'Trusted new message',
        messageId: 'm-private-refresh',
        timestamp: new Date().toISOString(),
        pushName: 'Alice',
        externalId: '8613800001234@c.us',
        externalIdKind: 'phone_jid',
        phoneCandidate: '8613800001234',
        groupStatusSource: 'electron_dom_jid',
      });

      expect(prisma.conversation.upsert.mock.calls[0][0].where).toEqual({
        companyId_channel_threadKey: {
          companyId: 'co-1',
          channel: 'whatsapp',
          threadKey: 'whatsapp:sess-1:8613800001234@c.us',
        },
      });
      expect(prisma.conversation.update).toHaveBeenCalledWith({
        where: { id: 'legacy-conversation' },
        data: expect.objectContaining({
          isGroup: false,
          groupStatusSource: 'electron_dom_jid',
          leadId: 'lead-1',
          contactPointId: 'cp-1',
        }),
      });
    });

    it.each([
      ['Evolution', 'evolution_webhook', 'whatsapp_evolution'],
      ['Electron', 'electron_dom', 'whatsapp_electron'],
    ] as const)(
      'enqueues an owner notification after a persisted %s inbound message',
      async (_label, transportSource, sourceType) => {
        const { service, resolver, prisma, ownerNotifications } = createService();
        prisma.whatsAppSession.findFirst.mockResolvedValue(baseSession);
        prisma.communicationMessage.findUnique.mockResolvedValue(null);
        (resolver.resolve as jest.Mock).mockResolvedValue({
          action: 'linked', leadId: 'lead-notify', contactId: 'contact-notify',
          contactPointId: 'cp-notify', reason: 'exact_match',
        } as ResolveIdentityResult);
        prisma.conversation.findFirst.mockResolvedValue(null);
        prisma.conversation.create.mockResolvedValue({ id: 'conv-notify', isGroup: false });
        prisma.communicationMessage.create.mockResolvedValue({ id: 'message-notify' });
        prisma.lead.findFirst.mockResolvedValue({ id: 'lead-notify', contactName: 'Alice' });

        await service.handleEvolutionMessage({
          instanceName: 'wa-inst-1',
          fromPhone: '8613800001234',
          isGroup: false,
          messageContent: 'Need a quotation',
          messageId: `provider-${transportSource}`,
          timestamp: '2026-07-18T10:00:00.000Z',
          pushName: 'Alice',
          displayNameCandidate: 'Alice',
          externalId: '8613800001234@c.us',
          phoneCandidate: '8613800001234',
          transportSource,
          direction: 'inbound',
        });

        expect(ownerNotifications.enqueueInbound).toHaveBeenCalledWith({
          companyId: 'co-1',
          eventType: 'WHATSAPP_INBOUND',
          sourceMessageKey: `provider-${transportSource}`,
          sourceType,
          sourceId: 'message-notify',
          conversationId: 'conv-notify',
          leadId: 'lead-notify',
          subject: 'Alice',
          preview: 'Need a quotation',
        });
      },
    );

    it('keeps the real Evolution persistence and SSE contract while logs stay metadata-only', async () => {
      const { service, resolver, prisma, eventBus } = createService();
      prisma.whatsAppSession.findFirst.mockResolvedValue(baseSession);
      prisma.communicationMessage.findUnique.mockResolvedValue(null);
      (resolver.resolve as jest.Mock).mockResolvedValue({
        action: 'linked', leadId: 'lead-success', contactId: 'contact-success',
        contactPointId: 'cp-success', reason: 'exact_match',
      } as ResolveIdentityResult);
      prisma.conversation.findFirst.mockResolvedValue(null);
      prisma.conversation.create.mockResolvedValue({ id: 'conv-success', isGroup: false });
      prisma.communicationMessage.create.mockResolvedValue({ id: 'message-success' });
      prisma.lead.findFirst.mockResolvedValue({ id: 'lead-success', companyId: 'co-1', contactName: null });

      const sentinelBody = 'SENTINEL_EVOLUTION_MESSAGE_BODY';
      const sentinelEmail = 'sentinel-evolution@example.com';
      const sentinelPhone = '+8613900099999';
      const sentinelJid = '8613900099999@s.whatsapp.net';
      const sentinelProviderId = 'provider-sentinel-evolution-1';
      await service.handleEvolutionMessage({
        instanceName: 'wa-inst-1',
        fromPhone: sentinelPhone,
        isGroup: false,
        messageContent: `${sentinelBody} ${sentinelEmail}`,
        messageId: sentinelProviderId,
        timestamp: '2026-07-18T10:03:00.000Z',
        pushName: 'Sentinel Buyer',
        externalId: sentinelJid,
        phoneCandidate: sentinelPhone.slice(1),
        direction: 'inbound',
      });

      expect(eventBus.emit).toHaveBeenCalledWith('whatsapp.message', {
        companyId: 'co-1',
        conversationId: 'conv-success',
        leadId: 'lead-success',
        fromPhone: sentinelPhone,
        receiverPhone: baseSession.phoneNumber,
        receiverName: baseSession.accountName,
        messagePreview: `${sentinelBody} ${sentinelEmail}`,
        timestamp: '2026-07-18T10:03:00.000Z',
        direction: 'inbound',
      });

      const logOutput = (Logger.prototype.log as jest.Mock).mock.calls
        .flat()
        .map(String)
        .join('\n');
      expect(logOutput).not.toContain(sentinelBody);
      expect(logOutput).not.toContain(sentinelEmail);
      expect(logOutput).not.toContain(sentinelPhone);
      expect(logOutput).not.toContain(sentinelJid);
      expect(logOutput).not.toContain(sentinelProviderId);
      expect(logOutput).toContain('whatsapp.evolution.message_persisted');
    });

    it('uses the same owner-notification source key when an inbound webhook is replayed', async () => {
      const { service, resolver, prisma, ownerNotifications, eventBus } = createService();
      prisma.whatsAppSession.findFirst.mockResolvedValue(baseSession);
      prisma.communicationMessage.findUnique
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce({
          id: 'message-replay',
          content: 'Replay-safe message',
          conversationId: 'conv-replay',
          conversation: { leadId: 'lead-replay' },
        });
      (resolver.resolve as jest.Mock).mockResolvedValue({
        action: 'linked', leadId: 'lead-replay', contactId: 'contact-replay',
        contactPointId: 'cp-replay', reason: 'exact_match',
      } as ResolveIdentityResult);
      prisma.conversation.findFirst.mockResolvedValue(null);
      prisma.conversation.create.mockResolvedValue({ id: 'conv-replay', isGroup: false });
      prisma.communicationMessage.create.mockResolvedValue({ id: 'message-replay' });
      prisma.lead.findFirst.mockResolvedValue({ id: 'lead-replay', contactName: 'Alice' });

      const payload = {
        instanceName: 'wa-inst-1',
        fromPhone: '8613800001234',
        isGroup: false as const,
        messageContent: 'Replay-safe message',
        messageId: 'provider-replay-1',
        timestamp: '2026-07-18T10:01:00.000Z',
        pushName: 'Alice',
        externalId: '8613800001234@c.us',
        phoneCandidate: '8613800001234',
        direction: 'inbound' as const,
      };
      await service.handleEvolutionMessage(payload);
      await service.handleEvolutionMessage(payload);

      expect(prisma.communicationMessage.create).toHaveBeenCalledTimes(1);
      expect(eventBus.emit).toHaveBeenCalledTimes(1);
      expect(ownerNotifications.enqueueInbound).toHaveBeenCalledTimes(2);
      expect(ownerNotifications.enqueueInbound.mock.calls.map((call: any[]) => call[0].sourceMessageKey))
        .toEqual(['provider-replay-1', 'provider-replay-1']);
      expect(ownerNotifications.enqueueInbound.mock.calls[1][0]).toEqual(expect.objectContaining({
        sourceId: 'message-replay',
        conversationId: 'conv-replay',
        leadId: 'lead-replay',
        preview: 'Replay-safe message',
      }));
    });

    it('keeps the inbound message committed when owner notification enqueue fails', async () => {
      const { service, resolver, prisma, ownerNotifications, eventBus } = createService();
      prisma.whatsAppSession.findFirst.mockResolvedValue(baseSession);
      prisma.communicationMessage.findUnique.mockResolvedValue(null);
      (resolver.resolve as jest.Mock).mockResolvedValue({
        action: 'linked', leadId: 'lead-notify-fail', contactId: 'contact-notify-fail',
        contactPointId: 'cp-notify-fail', reason: 'exact_match',
      } as ResolveIdentityResult);
      prisma.conversation.findFirst.mockResolvedValue(null);
      prisma.conversation.create.mockResolvedValue({ id: 'conv-notify-fail', isGroup: false });
      prisma.communicationMessage.create.mockResolvedValue({ id: 'message-notify-fail' });
      prisma.lead.findFirst.mockResolvedValue({ id: 'lead-notify-fail', contactName: 'Alice' });
      ownerNotifications.enqueueInbound.mockRejectedValueOnce(new Error('notification transport offline'));

      await expect(service.handleEvolutionMessage({
        instanceName: 'wa-inst-1',
        fromPhone: '8613800001234',
        isGroup: false,
        messageContent: 'Persist me first',
        messageId: 'provider-notification-failure',
        timestamp: '2026-07-18T10:02:00.000Z',
        pushName: 'Alice',
        externalId: '8613800001234@c.us',
        phoneCandidate: '8613800001234',
        direction: 'inbound',
      })).resolves.toBeUndefined();

      expect(prisma.communicationMessage.create).toHaveBeenCalledTimes(1);
      expect(eventBus.emit).toHaveBeenCalledWith(
        'whatsapp.message',
        expect.objectContaining({ conversationId: 'conv-notify-fail', direction: 'inbound' }),
      );
    });

    it('records a manual WhatsApp message-out as outbound without overwriting the customer name', async () => {
      const { service, resolver, prisma, eventBus, ownerNotifications } = createService();
      prisma.whatsAppSession.findFirst.mockResolvedValue(baseSession);
      (resolver.resolve as jest.Mock).mockResolvedValue({
        action: 'linked', leadId: 'lead-1', contactId: 'contact-1',
        contactPointId: 'cp-1', reason: 'exact_match',
      } as ResolveIdentityResult);
      prisma.conversation.findFirst.mockResolvedValue({ id: 'conv-out', isGroup: false });
      prisma.conversation.update.mockResolvedValue({ id: 'conv-out', isGroup: false });
      prisma.communicationMessage.create.mockResolvedValue({ id: 'message-out' });

      await service.handleEvolutionMessage({
        instanceName: 'wa-inst-1',
        fromPhone: '8613800001234',
        isGroup: false,
        messageContent: 'Manual reply',
        messageId: 'm-outbound',
        timestamp: '2026-07-14T09:00:00.000Z',
        pushName: 'Vaysen',
        externalId: '8613800001234@c.us',
        phoneCandidate: '8613800001234',
        direction: 'outbound',
      });

      expect(prisma.communicationMessage.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          direction: 'outbound',
          fromAddress: '8613900001111',
          toAddress: '8613800001234',
          sentAt: new Date('2026-07-14T09:00:00.000Z'),
          ingestionKey: expect.stringMatching(/^[a-f0-9]{64}$/),
        }),
      });
      expect(prisma.communicationMessage.create.mock.calls[0][0].data.receivedAt).toBeUndefined();
      expect(prisma.lead.findFirst).not.toHaveBeenCalled();
      expect(eventBus.emit).toHaveBeenCalledWith('whatsapp.message', expect.objectContaining({
        direction: 'outbound',
        conversationId: 'conv-out',
      }));
      expect(ownerNotifications.enqueueInbound).not.toHaveBeenCalled();
    });

    it('acknowledges an outbox replay before repeating CRM or SSE side effects', async () => {
      const { service, resolver, prisma, eventBus, ownerNotifications } = createService();
      prisma.whatsAppSession.findFirst.mockResolvedValue(baseSession);
      prisma.communicationMessage.findUnique.mockResolvedValue({ id: 'message-existing' });

      await service.handleEvolutionMessage({
        instanceName: 'wa-inst-1',
        fromPhone: '8613800001234',
        isGroup: false,
        messageContent: 'same message',
        messageId: 'm-outbox-replay',
        timestamp: new Date().toISOString(),
        pushName: 'Alice',
        externalId: '8613800001234@c.us',
        phoneCandidate: '8613800001234',
        direction: 'outbound',
      });

      expect(resolver.resolve).not.toHaveBeenCalled();
      expect(prisma.conversation.findFirst).not.toHaveBeenCalled();
      expect(prisma.communicationMessage.create).not.toHaveBeenCalled();
      expect(eventBus.emit).not.toHaveBeenCalled();
      expect(ownerNotifications.enqueueInbound).not.toHaveBeenCalled();
    });

    it('uses a scoped unique ingestion key to close concurrent replay races', async () => {
      const { service, resolver, prisma, eventBus } = createService();
      prisma.whatsAppSession.findFirst.mockResolvedValue(baseSession);
      prisma.communicationMessage.findUnique.mockResolvedValue(null);
      (resolver.resolve as jest.Mock).mockResolvedValue({
        action: 'linked', leadId: 'lead-1', contactId: 'contact-1',
        contactPointId: 'cp-1', reason: 'exact_match',
      } as ResolveIdentityResult);
      prisma.conversation.findFirst.mockResolvedValue({ id: 'conv-1', isGroup: false });
      prisma.conversation.update.mockResolvedValue({ id: 'conv-1', isGroup: false });
      prisma.communicationMessage.create.mockRejectedValue({
        code: 'P2002', meta: { target: ['ingestionKey'] },
      });

      await expect(service.handleEvolutionMessage({
        instanceName: 'wa-inst-1',
        fromPhone: '8613800001234',
        isGroup: false,
        messageContent: 'racing message',
        messageId: 'm-race',
        timestamp: new Date().toISOString(),
        pushName: 'Alice',
        externalId: '8613800001234@c.us',
        phoneCandidate: '8613800001234',
      })).resolves.toBeUndefined();

      expect(prisma.communicationMessage.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          conversationId: 'conv-1',
          externalMessageId: 'm-race',
          ingestionKey: expect.stringMatching(/^[a-f0-9]{64}$/),
        }),
      });
      expect(prisma.$transaction).toHaveBeenCalledTimes(1);
      expect(eventBus.emit).not.toHaveBeenCalled();
    });

    it('does not emit a successful event when the atomic CRM ingestion unit fails', async () => {
      const { service, resolver, prisma, eventBus } = createService();
      prisma.whatsAppSession.findFirst.mockResolvedValue(baseSession);
      prisma.communicationMessage.findUnique.mockResolvedValue(null);
      (resolver.resolve as jest.Mock).mockResolvedValue({
        action: 'linked', leadId: 'lead-1', contactId: 'contact-1',
        contactPointId: 'cp-1', reason: 'exact_match',
      } as ResolveIdentityResult);
      prisma.conversation.findFirst.mockResolvedValue({ id: 'conv-atomic', isGroup: false });
      prisma.conversation.update.mockResolvedValue({ id: 'conv-atomic', isGroup: false });
      prisma.conversation.updateMany.mockRejectedValueOnce(new Error('preview update failed'));
      prisma.communicationMessage.create.mockResolvedValue({ id: 'message-atomic' });

      await expect(service.handleEvolutionMessage({
        instanceName: 'wa-inst-1',
        fromPhone: '8613800001234',
        isGroup: false,
        messageContent: 'atomic message',
        messageId: 'm-atomic',
        timestamp: new Date().toISOString(),
        pushName: 'Alice',
        externalId: '8613800001234@c.us',
        phoneCandidate: '8613800001234',
      })).rejects.toThrow('preview update failed');

      expect(prisma.$transaction).toHaveBeenCalledTimes(1);
      expect(eventBus.emit).not.toHaveBeenCalled();
    });

    it('does not move the conversation preview backwards when an older outbox item arrives later', async () => {
      const { service, resolver, prisma } = createService();
      prisma.whatsAppSession.findFirst.mockResolvedValue(baseSession);
      prisma.communicationMessage.findUnique.mockResolvedValue(null);
      (resolver.resolve as jest.Mock).mockResolvedValue({
        action: 'linked', leadId: 'lead-1', contactId: 'contact-1',
        contactPointId: 'cp-1', reason: 'exact_match',
      } as ResolveIdentityResult);
      prisma.conversation.findFirst.mockResolvedValue({ id: 'conv-order', isGroup: false });
      prisma.conversation.update.mockResolvedValue({ id: 'conv-order', isGroup: false });
      prisma.communicationMessage.create.mockResolvedValue({ id: 'message-order' });
      let lastMessageAt: Date | null = null;
      let lastMessagePreview: string | null = null;
      prisma.conversation.updateMany.mockImplementation(async ({ where, data }: any) => {
        const cutoff = where.OR[1].lastMessageAt.lte as Date;
        if (!lastMessageAt || lastMessageAt.getTime() <= cutoff.getTime()) {
          lastMessageAt = data.lastMessageAt;
          lastMessagePreview = data.lastMessagePreview;
          return { count: 1 };
        }
        return { count: 0 };
      });

      const base = {
        instanceName: 'wa-inst-1',
        fromPhone: '8613800001234',
        isGroup: false as const,
        pushName: 'Alice',
        externalId: '8613800001234@c.us',
        phoneCandidate: '8613800001234',
      };
      await service.handleEvolutionMessage({
        ...base,
        messageContent: 'newer message',
        messageId: 'm-newer',
        timestamp: '2026-07-14T10:05:00.000Z',
      });
      await service.handleEvolutionMessage({
        ...base,
        messageContent: 'older message',
        messageId: 'm-older',
        timestamp: '2026-07-14T10:00:00.000Z',
      });

      expect(lastMessageAt).toEqual(new Date('2026-07-14T10:05:00.000Z'));
      expect(lastMessagePreview).toBe('newer message');
      expect(prisma.communicationMessage.create).toHaveBeenCalledTimes(2);
    });

    it('rejects an invalid provider timestamp before starting an ingestion transaction', async () => {
      const { service, prisma } = createService();
      prisma.whatsAppSession.findFirst.mockResolvedValue(baseSession);

      await expect(service.handleEvolutionMessage({
        instanceName: 'wa-inst-1',
        fromPhone: '8613800001234',
        isGroup: false,
        messageContent: 'bad timestamp',
        messageId: 'm-invalid-time',
        timestamp: 'not-a-date',
        pushName: 'Alice',
        externalId: '8613800001234@c.us',
        phoneCandidate: '8613800001234',
      })).rejects.toThrow('timestamp is invalid');

      expect(prisma.$transaction).not.toHaveBeenCalled();
    });
  });

  it('uses the Baileys provider id as the stable owner-notification key across replay', async () => {
    const { service, resolver, prisma, ownerNotifications, eventBus } = createService();
    prisma.communicationMessage.findUnique
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({
        id: 'message-baileys',
        content: 'Baileys inbound',
        conversationId: 'conv-baileys',
        conversation: { leadId: 'lead-baileys' },
      });
    prisma.whatsAppSession.findFirst.mockResolvedValue({
      phoneNumber: '8613900001111',
      accountName: 'Vaysen',
    });
    (resolver.resolve as jest.Mock).mockResolvedValue({
      action: 'linked',
      leadId: 'lead-baileys',
      contactId: 'contact-baileys',
      contactPointId: 'cp-baileys',
      reason: 'exact_match',
    } as ResolveIdentityResult);
    prisma.lead.findFirst.mockResolvedValue({
      id: 'lead-baileys',
      companyName: 'Buyer Ltd',
      whatsapp: '+8613800001234',
    });
    prisma.contactPoint.findUnique.mockResolvedValue({
      id: 'cp-baileys',
      normalizedValue: '+8613800001234',
      avatarUrl: 'https://example.test/avatar.jpg',
    });
    prisma.conversation.upsert.mockResolvedValue({ id: 'conv-baileys', leadId: 'lead-baileys' });
    prisma.communicationMessage.create.mockResolvedValue({ id: 'message-baileys' });

    const message = {
      key: {
        id: 'baileys-provider-1',
        remoteJid: '8613800001234@s.whatsapp.net',
        fromMe: false,
      },
      pushName: 'Alice',
      message: { conversation: 'Baileys inbound' },
    };
    await (service as any).handleIncomingMessage(
      'co-1', 'session-db-1', 'baileys-session-1', message, 'inbound',
    );
    await (service as any).handleIncomingMessage(
      'co-1', 'session-db-1', 'baileys-session-1', message, 'inbound',
    );

    expect(prisma.communicationMessage.create).toHaveBeenCalledTimes(1);
    expect(eventBus.emit).toHaveBeenCalledTimes(1);
    expect(ownerNotifications.enqueueInbound).toHaveBeenCalledTimes(2);
    expect(ownerNotifications.enqueueInbound.mock.calls.map((call: any[]) => call[0].sourceMessageKey))
      .toEqual(['baileys-provider-1', 'baileys-provider-1']);
    expect(ownerNotifications.enqueueInbound.mock.calls[0][0]).toEqual(expect.objectContaining({
      eventType: 'WHATSAPP_INBOUND',
      sourceType: 'whatsapp_baileys',
      sourceId: 'message-baileys',
      conversationId: 'conv-baileys',
      leadId: 'lead-baileys',
      preview: 'Baileys inbound',
    }));
  });

  describe('provider send receipt contract', () => {
    const connectedSession = {
      id: 'session-db-1',
      companyId: 'co-1',
      sessionId: 'baileys-1',
      status: 'connected',
    };

    it('fails closed instead of falling back from an Electron mapping to Baileys', async () => {
      const { service, adapter } = createService();
      adapter.isConnected.mockReturnValue(true);

      await expect((service as any).sendTextForSession(
        {
          ...connectedSession,
          authStatePath: 'electron-account:dW5ib3VuZA',
        },
        '8613800001234@s.whatsapp.net',
        'hello',
      )).rejects.toThrow(/cannot fall back/i);
      expect(adapter.sendTextMessage).not.toHaveBeenCalled();
    });

    it('resolves only with the real Baileys provider message id', async () => {
      const { service, prisma, adapter } = createService();
      prisma.whatsAppSession.findFirst.mockResolvedValue(connectedSession);
      adapter.isConnected.mockReturnValue(true);
      adapter.buildJid.mockReturnValue('8613800001234@s.whatsapp.net');
      adapter.sendTextMessage.mockResolvedValue({ success: true, messageId: 'provider-123' });

      await expect(service.sendTextWithReceipt(
        'session-db-1',
        '+8613800001234',
        'hello',
        activeUser('co-1'),
      )).resolves.toEqual(expect.objectContaining({
        success: true,
        provider: 'baileys',
        providerMessageId: 'provider-123',
        messageId: 'provider-123',
        status: 'accepted',
      }));
    });

    it('throws when Baileys fails or omits a provider message id', async () => {
      const { service, prisma, adapter } = createService();
      prisma.whatsAppSession.findFirst.mockResolvedValue(connectedSession);
      adapter.isConnected.mockReturnValue(true);
      adapter.buildJid.mockReturnValue('8613800001234@s.whatsapp.net');
      adapter.sendTextMessage.mockResolvedValue({ success: false, error: 'socket closed' });

      await expect(service.sendTextWithReceipt(
        'session-db-1',
        '+8613800001234',
        'hello',
        activeUser('co-1'),
      )).rejects.toMatchObject({
        response: expect.objectContaining({ message: expect.stringMatching(/outcome is unknown/i) }),
      });
    });

    it.each([
      ['Baileys text', 'sendTextWithReceipt', 'sendTextMessage'],
      ['Baileys media', 'sendMediaOnly', 'sendMediaMessage'],
    ])('preserves ambiguous and explicit rejection semantics for %s', async (
      _label,
      serviceMethod,
      adapterMethod,
    ) => {
      const { service, prisma, adapter } = createService();
      prisma.whatsAppSession.findFirst.mockResolvedValue(connectedSession);
      adapter.isConnected.mockReturnValue(true);
      adapter.buildJid.mockReturnValue('8613800001234@s.whatsapp.net');
      const args = serviceMethod === 'sendTextWithReceipt'
        ? ['session-db-1', '+8613800001234', 'hello', activeUser('co-1')]
        : [
            'session-db-1',
            '+8613800001234',
            {
              type: 'document',
              buffer: Buffer.from('%PDF-quote'),
              filename: 'quote.pdf',
              mimeType: 'application/pdf',
            },
            activeUser('co-1'),
          ];

      adapter[adapterMethod].mockResolvedValueOnce({
        success: false,
        error: 'response lost',
      });
      const ambiguous = await (service as any)[serviceMethod](...args).catch((error: any) => error);
      expect(ambiguous.providerAccepted).toBeUndefined();

      adapter[adapterMethod].mockResolvedValueOnce({
        success: false,
        error: 'invalid target',
        deliveryOutcome: 'REJECTED',
        providerAccepted: false,
      });
      const rejected = await (service as any)[serviceMethod](...args).catch((error: any) => error);
      expect(rejected).toMatchObject({
        providerDeliveryOutcome: 'REJECTED',
        providerAccepted: false,
      });
    });

    it('preserves ambiguous versus explicit Evolution text rejection semantics', async () => {
      const { service, prisma, evolutionApi } = createService();
      prisma.whatsAppSession.findFirst.mockResolvedValue({
        ...connectedSession,
        sessionId: 'evolution-instance-1',
      });
      evolutionApi.sendTextMessage.mockResolvedValueOnce({
        success: false,
        error: 'HTTP 503 response lost',
      });
      const args = [
        'session-db-1',
        '+8613800001234',
        'hello',
        activeUser('co-1'),
      ];
      const ambiguous = await (service as any).sendEvolutionText(...args)
        .catch((error: any) => error);
      expect(ambiguous.providerAccepted).toBeUndefined();

      evolutionApi.sendTextMessage.mockResolvedValueOnce({
        success: false,
        error: 'VALIDATION_ERROR',
        deliveryOutcome: 'REJECTED',
        providerAccepted: false,
      });
      const rejected = await (service as any).sendEvolutionText(...args)
        .catch((error: any) => error);
      expect(rejected).toMatchObject({
        providerDeliveryOutcome: 'REJECTED',
        providerAccepted: false,
      });
    });

    it('requires a real provider id for media such as quotation PDFs', async () => {
      const { service, prisma, adapter } = createService();
      prisma.whatsAppSession.findFirst.mockResolvedValue(connectedSession);
      adapter.isConnected.mockReturnValue(true);
      adapter.buildJid.mockReturnValue('8613800001234@s.whatsapp.net');
      adapter.sendMediaMessage.mockResolvedValue({ success: true, messageId: undefined });

      await expect(service.sendMediaOnly(
        'session-db-1',
        '+8613800001234',
        {
          type: 'document',
          buffer: Buffer.from('quote'),
          filename: 'quote.pdf',
          mimeType: 'application/pdf',
        },
        activeUser('co-1'),
      )).rejects.toThrow('no durable message id');
    });

    it('uses the same server-copied media bytes for the digest input and provider dispatch', async () => {
      const { service, prisma, adapter, outbound } = createService();
      prisma.whatsAppSession.findFirst.mockResolvedValue(connectedSession);
      adapter.isConnected.mockReturnValue(true);
      adapter.buildJid.mockReturnValue('8613800001234@s.whatsapp.net');
      adapter.sendMediaMessage.mockResolvedValue({ success: true, messageId: 'provider-media-1' });
      const original = Buffer.from('%PDF-original quote');
      let snapshottedBytes: Buffer | undefined;
      outbound.execute.mockImplementation(async (request: any, provider: any) => {
        snapshottedBytes = request.artifacts[0].bytes;
        original.fill(0);
        return {
          outboxId: 'outbox-1',
          deduplicated: false,
          receipt: await provider(request.artifacts || [], {
            targetAddress: '8613800001234',
            subject: '',
            body: request.body.trim(),
            contentType: request.contentType,
            artifacts: request.artifacts || [],
            signal: new AbortController().signal,
          }),
        };
      });

      await service.sendMediaOnly(
        'session-db-1',
        '+8613800001234',
        {
          type: 'document',
          buffer: original,
          filename: 'quote.pdf',
          mimeType: 'application/pdf',
        },
        activeUser('co-1'),
      );

      const providerOptions = adapter.sendMediaMessage.mock.calls[0][2];
      expect(providerOptions.buffer).toBe(snapshottedBytes);
      expect(providerOptions.buffer.toString()).toBe('%PDF-original quote');
      expect(providerOptions.url).toBeUndefined();
    });

    it('rejects media MIME metadata that conflicts with the actual bytes', async () => {
      const { service, prisma, adapter, outbound } = createService();
      prisma.whatsAppSession.findFirst.mockResolvedValue(connectedSession);
      adapter.isConnected.mockReturnValue(true);

      await expect(service.sendMediaOnly(
        'session-db-1',
        '+8613800001234',
        {
          type: 'image',
          buffer: Buffer.from('%PDF-not-an-image'),
          filename: 'quote.png',
          mimeType: 'image/png',
        },
        activeUser('co-1'),
      )).rejects.toThrow(/MIME does not match its bytes/i);
      expect(outbound.execute).not.toHaveBeenCalled();
      expect(adapter.sendMediaMessage).not.toHaveBeenCalled();
    });

    it('fails closed for Evolution media URLs and never asks the provider to fetch them', async () => {
      const { service, evolutionApi, outbound } = createService();
      await expect(service.sendEvolutionMedia(
        'session-db-1',
        '+8613800001234',
        {
          type: 'document',
          url: 'http://169.254.169.254/latest/meta-data',
          filename: 'quote.pdf',
          mimeType: 'application/pdf',
        },
        activeUser('co-1'),
      )).rejects.toThrow(/disabled until a trusted byte-upload transport/i);
      expect(evolutionApi.sendMediaMessage).not.toHaveBeenCalled();
      expect(outbound.execute).not.toHaveBeenCalled();
    });
  });

  it('binds Baileys fromMe and provider-status events to the persistence handlers', async () => {
    const { service, adapter } = createService();
    const emitter = new EventEmitter();
    adapter.ensureEmitter.mockReturnValue(emitter);
    const ingest = jest.spyOn(service as any, 'handleIncomingMessage').mockResolvedValue(undefined);
    const updateStatus = jest.spyOn(service, 'updateMessageStatus').mockResolvedValue(undefined);

    (service as any).bindSessionEvents('session-db-1', 'baileys-1', 'co-1');
    emitter.emit('message', {
      msg: { key: { id: 'provider-1', fromMe: true }, message: { conversation: 'sent' } },
      direction: 'outbound',
    });
    emitter.emit('message-status', { messageId: 'provider-1', status: 'delivered' });
    await new Promise((resolve) => setImmediate(resolve));

    expect(ingest).toHaveBeenCalledWith(
      'co-1',
      'session-db-1',
      'baileys-1',
      expect.objectContaining({ key: expect.objectContaining({ id: 'provider-1' }) }),
      'outbound',
    );
    expect(updateStatus).toHaveBeenCalledWith('baileys-1', 'provider-1', 'delivered');
  });

  it('scopes delivery-status updates to the exact WhatsApp session', async () => {
    const { service, prisma } = createService();
    prisma.whatsAppSession.findFirst.mockResolvedValue({
      id: 'session-a', companyId: 'company-a', sessionId: 'instance-a',
    });
    prisma.communicationMessage.findFirst.mockResolvedValue({ id: 'message-a' });
    prisma.communicationMessage.update.mockResolvedValue({ id: 'message-a' });

    await service.updateMessageStatus('instance-a', 'same-provider-id', 'delivered');

    expect(prisma.communicationMessage.findFirst).toHaveBeenCalledWith({
      where: {
        OR: [
          { ingestionKey: expect.stringMatching(/^[a-f0-9]{64}$/) },
          {
            externalMessageId: 'same-provider-id',
            conversation: {
              is: { companyId: 'company-a', whatsappSessionId: 'session-a' },
            },
          },
        ],
      },
    });
    expect(prisma.communicationMessage.update).toHaveBeenCalledWith({
      where: { id: 'message-a' },
      data: { deliveryStatus: 'delivered' },
    });
    const debugOutput = (Logger.prototype.debug as jest.Mock).mock.calls
      .flat()
      .map(String)
      .join('\n');
    expect(debugOutput).not.toContain('same-provider-id');
    expect(debugOutput).toContain('whatsapp.evolution.message_status_updated');
  });

  it('denies viewer account disconnect and deletion in the service layer', async () => {
    const { service, prisma, adapter } = createService();
    prisma.whatsAppSession.findFirst.mockResolvedValue({
      id: 'session-1',
      companyId: 'company-1',
      sessionId: 'provider-session-1',
    });
    const viewer = {
      id: 'viewer-1',
      activeCompanyId: 'company-1',
      companies: [{ id: 'company-1', role: 'viewer' }],
    };
    await expect(service.disconnect('session-1', viewer)).rejects.toThrow(/administrator role/i);
    await expect(service.removeAccount('session-1', viewer)).rejects.toThrow(/administrator role/i);
    expect(adapter.disconnect).not.toHaveBeenCalled();
    expect(prisma.whatsAppSession.delete).not.toHaveBeenCalled();
  });

  it('lists only safe account fields for an exact active-company administrator', async () => {
    const { service, prisma } = createService();
    const safeRow = {
      id: 'session-1',
      accountName: 'Sales WhatsApp',
      phoneNumber: '+12025550123',
      status: 'connected',
      connectedAt: new Date(),
      disconnectedAt: null,
      lastSeenAt: new Date(),
      sendLimitPerHour: 60,
      sendLimitDaily: 300,
      sendIntervalSeconds: 8,
      lastSentAt: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    prisma.whatsAppSession.findMany.mockResolvedValue([safeRow]);
    prisma.communicationMessage.groupBy.mockResolvedValue([]);
    const activeAdmin = {
      id: 'admin-1',
      activeCompanyId: 'company-1',
      activeCompany: { id: 'company-1', role: 'company_admin' },
      companies: [
        { id: 'company-1', role: 'company_admin' },
        { id: 'company-2', role: 'company_admin' },
      ],
    };

    await expect(service.listAccounts(activeAdmin)).resolves.toEqual([
      { ...safeRow, todaySentCount: 0 },
    ]);
    const query = prisma.whatsAppSession.findMany.mock.calls[0][0];
    expect(query.where).toEqual({ companyId: 'company-1' });
    expect(query.select).not.toHaveProperty('qrCode');
    expect(query.select).not.toHaveProperty('authStatePath');
    expect(query.select).not.toHaveProperty('sessionId');
    expect(query.select).toHaveProperty('sendLimitPerHour');
    expect(query.select).toHaveProperty('sendLimitDaily');
    expect(query.select).toHaveProperty('sendIntervalSeconds');
    expect(query.select).toHaveProperty('lastSentAt');
  });

  it('rejects viewer account listing and never falls back to companies[0]', async () => {
    const { service, prisma } = createService();
    await expect(service.listAccounts({
      id: 'viewer-1',
      activeCompanyId: 'company-1',
      companies: [{ id: 'company-1', role: 'viewer' }],
    })).rejects.toThrow(/administrator role/i);
    await expect(service.listAccounts({
      id: 'admin-1',
      companies: [{ id: 'company-1', role: 'company_admin' }],
    })).rejects.toThrow(/active company/i);
    expect(prisma.whatsAppSession.findMany).not.toHaveBeenCalled();
  });

  it('keeps Evolution creation BadRequest stable when the provider exposes an error', async () => {
    const { service, prisma, evolutionApi } = createService();
    const providerSentinel = 'SMTP/provider raw error sentinel https://provider.invalid/token';
    evolutionApi.getWebhookUrl.mockReturnValue('https://crm.invalid/webhook');
    evolutionApi.createInstance.mockRejectedValue(new Error(providerSentinel));
    prisma.whatsAppSession.create.mockResolvedValue({
      id: 'session-create-failure',
      companyId: 'co-1',
      sessionId: 'instance-create-failure',
      status: 'pending_qr',
    });

    const error = await service.createEvolutionInstance(
      { name: 'Sentinel account' },
      activeUser('co-1'),
    ).catch((caught: any) => caught);

    expect(error).toBeInstanceOf(Error);
    expect(error.getStatus()).toBe(400);
    expect(error.message).toBe('Evolution instance creation failed');
    expect(error.message).not.toContain(providerSentinel);
  });

  it('marks only an exact authenticated direct provider inbound identity as trusted', async () => {
    const { service, prisma } = createService();
    prisma.whatsAppSession.findFirst.mockResolvedValue({ id: 'session-1' });
    prisma.externalIdentity.findFirst.mockResolvedValue({ id: 'identity-1' });
    prisma.contactPoint.updateMany.mockResolvedValue({ count: 1 });

    await (service as any).markTrustedInboundIdentity(prisma, {
      companyId: 'company-1',
      sessionDbId: 'session-1',
      leadId: 'lead-1',
      contactPointId: 'point-1',
      externalId: '12025550123@s.whatsapp.net',
      direction: 'inbound',
      isDirect: true,
      verificationMethod: 'baileys_inbound',
    });
    expect(prisma.contactPoint.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({
        id: 'point-1',
        companyId: 'company-1',
        leadId: 'lead-1',
      }),
      data: expect.objectContaining({
        isVerified: true,
        verificationMethod: 'baileys_inbound',
        verifiedAt: expect.any(Date),
      }),
    }));

    prisma.contactPoint.updateMany.mockClear();
    await (service as any).markTrustedInboundIdentity(prisma, {
      companyId: 'company-1',
      sessionDbId: 'session-1',
      leadId: 'lead-1',
      contactPointId: 'point-1',
      externalId: '12025550123@s.whatsapp.net',
      direction: 'inbound',
      isDirect: false,
      verificationMethod: 'evolution_webhook',
    });
    expect(prisma.contactPoint.updateMany).not.toHaveBeenCalled();
  });

  it('denies viewer account creation, QR access and reconnect before provider mutation', async () => {
    const { service, prisma, adapter, evolutionApi } = createService();
    prisma.whatsAppSession.findFirst.mockResolvedValue({
      id: 'session-1',
      companyId: 'company-1',
      sessionId: 'provider-session-1',
      status: 'pending_qr',
    });
    const viewer = {
      id: 'viewer-1',
      activeCompanyId: 'company-1',
      companies: [{ id: 'company-1', role: 'viewer' }],
    };

    await expect(service.createAccount({ name: 'Blocked' }, viewer))
      .rejects.toThrow(/administrator role/i);
    await expect(service.getQrCode('session-1', viewer))
      .rejects.toThrow(/administrator role/i);
    await expect(service.reconnect('session-1', viewer))
      .rejects.toThrow(/administrator role/i);
    await expect(service.createEvolutionInstance({ name: 'Blocked' }, viewer))
      .rejects.toThrow(/administrator role/i);

    expect(prisma.whatsAppSession.create).not.toHaveBeenCalled();
    expect(adapter.initSession).not.toHaveBeenCalled();
    expect(adapter.removeSocket).not.toHaveBeenCalled();
    expect(evolutionApi.getWebhookUrl).not.toHaveBeenCalled();
    expect(evolutionApi.createInstance).not.toHaveBeenCalled();
  });

  it('denies a non-active tenant even when the operator is an admin member of both', async () => {
    const { service, prisma, adapter } = createService();
    prisma.whatsAppSession.findUnique.mockResolvedValue({
      id: 'session-1',
      companyId: 'company-1',
      sessionId: 'provider-session-1',
    });
    prisma.userCompanyRelation.findFirst.mockResolvedValue({
      role: { name: 'company_admin' },
    });
    const admin = {
      id: 'admin-1',
      activeCompanyId: 'company-2',
      companies: [
        { id: 'company-1', role: 'company_admin' },
        { id: 'company-2', role: 'company_admin' },
      ],
    };

    await expect(service.disconnect('session-1', admin))
      .rejects.toThrow(/account not found/i);
    expect(adapter.disconnect).not.toHaveBeenCalled();
  });

  it('keeps the trusted-channel fail-closed contract for invalid group or broadcast JIDs', async () => {
    const { service, prisma } = createService();
    prisma.whatsAppSession.findFirst.mockResolvedValue({
      id: 'session-1', companyId: 'co-1', sessionId: 'sess-1', status: 'connected',
      phoneNumber: null, accountName: null,
    });

    await expect(service.handleEvolutionMessage({
      instanceName: 'wa-inst-1',
      fromPhone: '8613800001234',
      isGroup: true,
      groupJid: 'not-a-channel-jid',
      messageContent: 'invalid group',
      messageId: 'm-invalid-group',
      timestamp: new Date().toISOString(),
      pushName: 'Invalid Group',
    })).rejects.toThrow(/trusted channel JID/i);
  });
});
