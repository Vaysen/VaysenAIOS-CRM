import { ForbiddenException } from '@nestjs/common';
import { OpenClawRuntimeService } from './openclaw-runtime.service';

const COMPANY_ID = '11111111-1111-4111-8111-111111111111';
const baseProbe: any = {
  enabled: true,
  gatewayReady: true,
  adapterReady: true,
  modelReady: true,
  starting: false,
  release: '2026.7.1',
  lastHeartbeatAt: '2026-07-14T12:00:00.000Z',
  errorCode: null,
  wechatOwnerChannel: {
    status: 'CONNECTED',
    pluginReady: true,
    pairingExpiresAt: null,
    binding: null,
    errorCode: null,
  },
};

describe('OpenClawRuntimeService', () => {
  let gateway: any;
  let prisma: any;
  let service: OpenClawRuntimeService;

  beforeEach(() => {
    process.env.OPENCLAW_OWNER_EMAIL = 'owner@example.com';
    process.env.OPENCLAW_OWNER_COMPANY_SLUG = 'vaysen-crm';
    process.env.OPENCLAW_WECHAT_OWNER_PEER_SHA256 = 'a'.repeat(64);
    gateway = {
      probe: jest.fn().mockResolvedValue(baseProbe),
      startWechatPairing: jest.fn(),
      waitWechatPairing: jest.fn(),
    };
    prisma = {
      $queryRaw: jest.fn().mockResolvedValue([{ locked: '1' }]),
      $transaction: jest.fn(async (callback: (tx: any) => Promise<unknown>) => callback(prisma)),
      openClawOperatorBinding: {
        findFirst: jest.fn().mockResolvedValue({
          id: 'binding-1',
          senderDigest: 'a'.repeat(64),
          displayName: 'Owner WeChat',
          boundAt: new Date('2026-07-14T11:00:00.000Z'),
          lastSeenAt: new Date('2026-07-14T12:00:00.000Z'),
        }),
        findUnique: jest.fn().mockResolvedValue(null),
        updateMany: jest.fn().mockResolvedValue({ count: 0 }),
        upsert: jest.fn().mockResolvedValue({ id: 'binding-enrolled' }),
      },
      userCompanyRelation: {
        findFirst: jest.fn().mockResolvedValue({
          role: { name: 'company_admin' },
          company: { slug: 'vaysen-crm' },
        }),
      },
    };
    service = new OpenClawRuntimeService(gateway, prisma);
  });

  afterEach(() => {
    delete process.env.OPENCLAW_OWNER_EMAIL;
    delete process.env.OPENCLAW_OWNER_COMPANY_SLUG;
    delete process.env.OPENCLAW_WECHAT_OWNER_PEER_SHA256;
  });

  it('returns the schema-v1 sanitized snapshot only to an active company member', async () => {
    const result = await service.getSnapshot(COMPANY_ID, {
      id: 'admin-1',
      email: 'owner@example.com',
      companies: [{ id: COMPANY_ID, role: 'company_admin' }],
    });
    expect(result).toEqual(expect.objectContaining({
      schemaVersion: 1,
      runtime: expect.objectContaining({ status: 'READY', gatewayReady: true }),
      permissions: {
        canUseAssistant: true,
        canIssueWechatCommands: true,
        canAdminApprove: true,
        canManageChannel: true,
      },
    }));
    const serialized = JSON.stringify(result);
    expect(serialized).not.toMatch(/token|gatewayUrl|requesterSenderId|peerDigest|qrCode|docker|\/opt\//i);
  });

  it('rejects a company outside the JWT and a revoked database membership', async () => {
    await expect(service.getSnapshot(COMPANY_ID, {
      id: 'admin-1',
      companies: [{ id: '22222222-2222-4222-8222-222222222222', role: 'company_admin' }],
    })).rejects.toBeInstanceOf(ForbiddenException);
    expect(gateway.probe).not.toHaveBeenCalled();

    prisma.userCompanyRelation.findFirst.mockResolvedValue(null);
    await expect(service.getSnapshot(COMPANY_ID, {
      id: 'admin-1',
      companies: [{ id: COMPANY_ID, role: 'company_admin' }],
    })).rejects.toThrow('No active access');
  });

  it('does not grant owner commands after role downgrade or in another company slug', async () => {
    prisma.userCompanyRelation.findFirst.mockResolvedValue({
      role: { name: 'sales_user' },
      company: { slug: 'vaysen-crm' },
    });
    let result = await service.getSnapshot(COMPANY_ID, {
      id: 'owner-1',
      email: 'owner@example.com',
      companies: [{ id: COMPANY_ID, role: 'company_admin' }],
    });
    expect(result.permissions.canIssueWechatCommands).toBe(false);
    expect(result.capabilities.find((item) => item.id === 'crm.work_brief')?.status).toBe('DISABLED');

    prisma.userCompanyRelation.findFirst.mockResolvedValue({
      role: { name: 'company_admin' },
      company: { slug: 'other-company' },
    });
    result = await service.getSnapshot(COMPANY_ID, {
      id: 'owner-1',
      email: 'owner@example.com',
      companies: [{ id: COMPANY_ID, role: 'company_admin' }],
    });
    expect(result.permissions.canIssueWechatCommands).toBe(false);
    expect(result.permissions.canManageChannel).toBe(false);
    expect(result.wechatOwnerChannel.status).toBe('DISCONNECTED');
    expect('binding' in result.wechatOwnerChannel).toBe(false);
    expect(result.capabilities.find((item) => item.id === 'openclaw.crm_chat')?.status).toBe('ENABLED');
    expect(result.capabilities.find((item) => item.id === 'crm.work_brief')?.status).toBe('ENABLED');
    expect(result.capabilities.find((item) => item.id === 'crm.prepare_quote_delivery')?.status)
      .toBe('APPROVAL_REQUIRED');
    expect(result.capabilities.find((item) => item.id === 'wechat.owner_control')?.status).toBe('DISABLED');
  });

  it('hides the global connected channel and binding from a non-owner member', async () => {
    prisma.userCompanyRelation.findFirst.mockResolvedValue({
      role: { name: 'sales_user' },
      company: { slug: 'vaysen-crm' },
    });
    gateway.probe.mockResolvedValue({
      ...baseProbe,
      wechatOwnerChannel: {
        ...baseProbe.wechatOwnerChannel,
        binding: {
          displayName: '负责人微信',
          maskedAccount: 'wx***01',
          boundAt: '2026-07-14T11:00:00.000Z',
          lastSeenAt: null,
        },
      },
    });
    const result = await service.getSnapshot(COMPANY_ID, {
      id: 'member-1',
      email: 'member@example.com',
      companies: [{ id: COMPANY_ID, role: 'sales_user' }],
    });
    expect(result.wechatOwnerChannel).toEqual(expect.objectContaining({
      status: 'DISCONNECTED',
      pluginReady: false,
      pairingExpiresAt: null,
      errorCode: 'CHANNEL_NOT_AUTHORIZED',
    }));
    expect('binding' in result.wechatOwnerChannel).toBe(false);
    expect(result.permissions.canIssueWechatCommands).toBe(false);
    expect(result.permissions.canManageChannel).toBe(false);
    expect(result.capabilities.every((item) => item.status === 'DISABLED')).toBe(true);
  });

  it('keeps the owner transport connected while the execution model is degraded', async () => {
    gateway.probe.mockResolvedValue({ ...baseProbe, modelReady: false });
    const result = await service.getSnapshot(COMPANY_ID, {
      id: 'owner-1',
      email: 'owner@example.com',
      companies: [{ id: COMPANY_ID, role: 'company_admin' }],
    });
    expect(result.runtime.status).toBe('DEGRADED');
    expect(result.wechatOwnerChannel.status).toBe('CONNECTED');
    expect(result.permissions.canIssueWechatCommands).toBe(false);
  });

  it('uses an active in-app QR binding when the legacy owner peer env digest is missing', async () => {
    delete process.env.OPENCLAW_WECHAT_OWNER_PEER_SHA256;
    const result = await service.getSnapshot(COMPANY_ID, {
      id: 'owner-1',
      email: 'owner@example.com',
      companies: [{ id: COMPANY_ID, role: 'company_admin' }],
    });
    expect(result.wechatOwnerChannel.status).toBe('CONNECTED');
    expect(result.wechatOwnerChannel.errorCode).toBeNull();
    expect(result.permissions.canManageChannel).toBe(true);
    expect(result.permissions.canIssueWechatCommands).toBe(true);
    expect(result.capabilities.find((item) => item.id === 'wechat.owner_control')?.status).toBe('ENABLED');
  });

  it('does not show connected or grant commands before a matching owner message establishes the binding', async () => {
    prisma.openClawOperatorBinding.findFirst.mockResolvedValue(null);
    const result = await service.getSnapshot(COMPANY_ID, {
      id: 'owner-1',
      email: 'owner@example.com',
      companies: [{ id: COMPANY_ID, role: 'company_admin' }],
    });
    expect(result.wechatOwnerChannel.status).toBe('UNBOUND');
    expect(result.wechatOwnerChannel.errorCode).toBe('OWNER_BINDING_NOT_ESTABLISHED');
    expect(result.permissions.canManageChannel).toBe(true);
    expect(result.permissions.canIssueWechatCommands).toBe(false);
  });

  it('prefers the active in-app QR binding over a stale legacy env digest', async () => {
    prisma.openClawOperatorBinding.findFirst.mockResolvedValueOnce(null).mockResolvedValueOnce({
      id: 'binding-stale',
      senderDigest: 'b'.repeat(64),
      displayName: 'Stale WeChat',
      boundAt: new Date('2026-07-13T11:00:00.000Z'),
      lastSeenAt: new Date('2026-07-13T12:00:00.000Z'),
    });
    const result = await service.getSnapshot(COMPANY_ID, {
      id: 'owner-1',
      email: 'owner@example.com',
      companies: [{ id: COMPANY_ID, role: 'company_admin' }],
    });
    expect(result.wechatOwnerChannel.status).toBe('CONNECTED');
    expect(result.wechatOwnerChannel.errorCode).toBeNull();
    expect(result.wechatOwnerChannel.binding).toEqual(expect.objectContaining({ displayName: 'Stale WeChat' }));
    expect(result.permissions.canIssueWechatCommands).toBe(true);
  });

  it('uses the latest ACTIVE database binding instead of the legacy configured digest', async () => {
    const current = {
      id: 'binding-current',
      senderDigest: 'a'.repeat(64),
      displayName: 'Current WeChat',
      boundAt: new Date('2026-07-15T11:00:00.000Z'),
      lastSeenAt: new Date('2026-07-15T12:00:00.000Z'),
    };
    prisma.openClawOperatorBinding.findFirst
      .mockResolvedValueOnce(current)
      .mockResolvedValueOnce({
        id: 'binding-latest',
        senderDigest: 'b'.repeat(64),
        displayName: 'Latest QR binding',
        boundAt: new Date('2026-07-16T11:00:00.000Z'),
        lastSeenAt: new Date('2026-07-16T12:00:00.000Z'),
      });
    const result = await service.getSnapshot(COMPANY_ID, {
      id: 'owner-1',
      email: 'owner@example.com',
      companies: [{ id: COMPANY_ID, role: 'company_admin' }],
    });
    expect(prisma.openClawOperatorBinding.findFirst).toHaveBeenNthCalledWith(1, expect.objectContaining({
      where: expect.objectContaining({ senderDigest: 'a'.repeat(64) }),
    }));
    expect(result.wechatOwnerChannel.status).toBe('CONNECTED');
    expect(result.wechatOwnerChannel.binding).toEqual(expect.objectContaining({
      displayName: 'Latest QR binding',
    }));
    expect(result.permissions.canIssueWechatCommands).toBe(true);
  });

  it('does not treat another channel binding as the owner WeChat binding', async () => {
    prisma.openClawOperatorBinding.findFirst.mockResolvedValue(null);
    const result = await service.getSnapshot(COMPANY_ID, {
      id: 'admin-1',
      email: 'different-admin@example.com',
      companies: [{ id: COMPANY_ID, role: 'company_admin' }],
    });
    expect(prisma.openClawOperatorBinding.findFirst).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ channel: 'openclaw-weixin' }),
    }));
    expect(result.permissions.canManageChannel).toBe(false);
    expect(result.permissions.canIssueWechatCommands).toBe(false);
  });

  it('does not let an old administrator retain owner access through a matching stale binding', async () => {
    const result = await service.getSnapshot(COMPANY_ID, {
      id: 'old-admin-1',
      email: 'old-owner@example.com',
      companies: [{ id: COMPANY_ID, role: 'company_admin' }],
    });
    expect(result.wechatOwnerChannel.status).toBe('DISCONNECTED');
    expect(result.wechatOwnerChannel.errorCode).toBe('CHANNEL_NOT_AUTHORIZED');
    expect('binding' in result.wechatOwnerChannel).toBe(false);
    expect(result.permissions.canManageChannel).toBe(false);
    expect(result.permissions.canIssueWechatCommands).toBe(false);
  });

  it('persists the scanned owner digest before exposing the in-page QR session as connected', async () => {
    delete process.env.OPENCLAW_WECHAT_OWNER_PEER_SHA256;
    const ownerPeerDigest = 'b'.repeat(64);
    prisma.openClawOperatorBinding.findFirst.mockResolvedValue(null);
    gateway.startWechatPairing.mockResolvedValue({
      connected: false,
      qrDataUrl: 'data:image/png;base64,aGVsbG8=',
      message: null,
      sessionKey: 'opaque-owner-session-key',
      ownerPeerDigest: null,
    });
    gateway.waitWechatPairing.mockResolvedValue({
      connected: true,
      qrDataUrl: null,
      message: null,
      sessionKey: null,
      ownerPeerDigest,
    });
    const user = {
      id: 'owner-1',
      email: 'owner@example.com',
      companies: [{ id: COMPANY_ID, role: 'company_admin' }],
    };

    const started = await service.startWechatPairing(COMPANY_ID, user);
    expect(started).toEqual(expect.objectContaining({
      status: 'WAITING_SCAN',
      qrDataUrl: 'data:image/png;base64,aGVsbG8=',
    }));
    let waited = await service.waitWechatPairing(COMPANY_ID, started.pairingId, user);
    for (let attempt = 0; !['CONNECTED_PENDING_MESSAGE', 'EXPIRED'].includes(waited.status) && attempt < 10; attempt += 1) {
      await new Promise((resolve) => setImmediate(resolve));
      waited = await service.waitWechatPairing(COMPANY_ID, started.pairingId, user);
    }
    expect(waited.status).toBe('CONNECTED_PENDING_MESSAGE');
    expect(gateway.waitWechatPairing).toHaveBeenCalledWith('opaque-owner-session-key');
    expect(prisma.openClawOperatorBinding.upsert).toHaveBeenCalledWith(expect.objectContaining({
      create: expect.objectContaining({
        companyId: COMPANY_ID,
        operatorUserId: 'owner-1',
        senderDigest: ownerPeerDigest,
        status: 'ACTIVE',
      }),
    }));
    expect(JSON.stringify(prisma.openClawOperatorBinding.upsert.mock.calls)).not.toMatch(/@im\.wechat/i);
  });

  it('treats a completed wait without a connection as an expired terminal QR session', async () => {
    prisma.openClawOperatorBinding.findFirst.mockResolvedValue(null);
    gateway.startWechatPairing.mockResolvedValue({
      connected: false,
      qrDataUrl: 'data:image/png;base64,aGVsbG8=',
      message: null,
      sessionKey: 'opaque-owner-session-key',
      ownerPeerDigest: null,
    });
    gateway.waitWechatPairing.mockResolvedValue({
      connected: false,
      qrDataUrl: null,
      message: '登录超时，请重试。',
      sessionKey: null,
      ownerPeerDigest: null,
    });
    const user = {
      id: 'owner-1',
      email: 'owner@example.com',
      companies: [{ id: COMPANY_ID, role: 'company_admin' }],
    };

    const started = await service.startWechatPairing(COMPANY_ID, user);
    await expect(service.waitWechatPairing(COMPANY_ID, started.pairingId, user)).resolves.toMatchObject({
      status: 'EXPIRED',
    });
  });

  it('fails closed when the gateway reports connected without a sanitized owner digest', async () => {
    delete process.env.OPENCLAW_WECHAT_OWNER_PEER_SHA256;
    prisma.openClawOperatorBinding.findFirst.mockResolvedValue(null);
    gateway.startWechatPairing.mockResolvedValue({
      connected: false,
      qrDataUrl: 'data:image/png;base64,aGVsbG8=',
      message: null,
      sessionKey: 'opaque-owner-session-key',
      ownerPeerDigest: null,
    });
    gateway.waitWechatPairing.mockResolvedValue({
      connected: true,
      qrDataUrl: null,
      message: 'connected',
      sessionKey: null,
      ownerPeerDigest: null,
    });
    const user = {
      id: 'owner-1',
      email: 'owner@example.com',
      companies: [{ id: COMPANY_ID, role: 'company_admin' }],
    };

    const started = await service.startWechatPairing(COMPANY_ID, user);
    await new Promise((resolve) => setImmediate(resolve));
    await expect(service.waitWechatPairing(COMPANY_ID, started.pairingId, user)).resolves.toMatchObject({
      status: 'EXPIRED',
    });
    expect(prisma.openClawOperatorBinding.upsert).not.toHaveBeenCalled();
  });

  it('persists an in-app database binding as canonical over a stale legacy digest', async () => {
    gateway.startWechatPairing.mockResolvedValue({
      connected: true,
      qrDataUrl: null,
      message: 'already connected',
      sessionKey: null,
      ownerPeerDigest: 'b'.repeat(64),
    });
    const user = {
      id: 'owner-1',
      email: 'owner@example.com',
      companies: [{ id: COMPANY_ID, role: 'company_admin' }],
    };

    await expect(service.startWechatPairing(COMPANY_ID, user)).resolves.toMatchObject({
      status: 'CONNECTED_PENDING_MESSAGE',
    });
    expect(prisma.openClawOperatorBinding.upsert).toHaveBeenCalledWith(expect.objectContaining({
      create: expect.objectContaining({ senderDigest: 'b'.repeat(64) }),
    }));
  });

  it('revalidates the configured owner inside the persistence transaction', async () => {
    delete process.env.OPENCLAW_WECHAT_OWNER_PEER_SHA256;
    prisma.userCompanyRelation.findFirst
      .mockResolvedValueOnce({ role: { name: 'company_admin' }, company: { slug: 'vaysen-crm' } })
      .mockResolvedValueOnce(null);
    gateway.startWechatPairing.mockResolvedValue({
      connected: true,
      qrDataUrl: null,
      message: 'connected',
      sessionKey: null,
      ownerPeerDigest: 'c'.repeat(64),
    });
    const user = {
      id: 'owner-1',
      email: 'owner@example.com',
      companies: [{ id: COMPANY_ID, role: 'company_admin' }],
    };

    await expect(service.startWechatPairing(COMPANY_ID, user)).rejects.toThrow(
      'lost permission during WeChat pairing',
    );
    expect(prisma.openClawOperatorBinding.upsert).not.toHaveBeenCalled();
  });

  it('reports AUTHENTICATING while the durable binding transaction is in flight', async () => {
    delete process.env.OPENCLAW_WECHAT_OWNER_PEER_SHA256;
    let releaseTransaction!: () => void;
    const transactionGate = new Promise<void>((resolve) => { releaseTransaction = resolve; });
    prisma.$transaction.mockImplementationOnce(async (callback: (tx: any) => Promise<unknown>) => {
      await transactionGate;
      return callback(prisma);
    });
    gateway.startWechatPairing.mockResolvedValue({
      connected: false,
      qrDataUrl: 'data:image/png;base64,aGVsbG8=',
      message: null,
      sessionKey: 'opaque-owner-session-key',
      ownerPeerDigest: null,
    });
    gateway.waitWechatPairing.mockResolvedValue({
      connected: true,
      qrDataUrl: null,
      message: 'connected',
      sessionKey: null,
      ownerPeerDigest: 'd'.repeat(64),
    });
    const user = {
      id: 'owner-1',
      email: 'owner@example.com',
      companies: [{ id: COMPANY_ID, role: 'company_admin' }],
    };

    const started = await service.startWechatPairing(COMPANY_ID, user);
    await new Promise((resolve) => setImmediate(resolve));
    await expect(service.waitWechatPairing(COMPANY_ID, started.pairingId, user)).resolves.toMatchObject({
      status: 'AUTHENTICATING',
    });
    releaseTransaction();
    await new Promise((resolve) => setImmediate(resolve));
    await expect(service.waitWechatPairing(COMPANY_ID, started.pairingId, user)).resolves.toMatchObject({
      status: 'CONNECTED_PENDING_MESSAGE',
    });
  });

  it('allows only one active in-page pairing per configured owner', async () => {
    delete process.env.OPENCLAW_WECHAT_OWNER_PEER_SHA256;
    gateway.startWechatPairing.mockResolvedValue({
      connected: false,
      qrDataUrl: 'data:image/png;base64,aGVsbG8=',
      message: null,
      sessionKey: 'opaque-owner-session-key',
      ownerPeerDigest: null,
    });
    gateway.waitWechatPairing.mockImplementation(() => new Promise(() => undefined));
    const user = {
      id: 'owner-1',
      email: 'owner@example.com',
      companies: [{ id: COMPANY_ID, role: 'company_admin' }],
    };

    await service.startWechatPairing(COMPANY_ID, user);
    await expect(service.startWechatPairing(COMPANY_ID, user)).rejects.toThrow(
      'already active for this owner',
    );
    expect(gateway.startWechatPairing).toHaveBeenCalledTimes(1);
  });
});
