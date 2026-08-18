jest.mock('./whatsapp-adapter', () => ({
  WhatsAppAdapter: class MockWhatsAppAdapter {},
}));
jest.mock('./evolution-api.service', () => ({
  EvolutionApiService: class MockEvolutionApiService {},
}));

import { Logger } from '@nestjs/common';
import { EventEmitter } from 'events';
import { WhatsAppService } from './whatsapp.service';

describe('WhatsAppService safe lifecycle and incoming logs', () => {
  const sentinel = 'provider-error-sentinel@example.com +8613800012345 8613800012345@s.whatsapp.net token=secret C:\\customer\\message.txt';

  function createHarness() {
    const prisma: any = {
      whatsAppSession: {
        create: jest.fn(),
        update: jest.fn().mockResolvedValue({}),
        findUnique: jest.fn(),
      },
      communicationMessage: {
        findUnique: jest.fn(),
      },
      conversation: {
        findFirst: jest.fn(),
      },
      contactPoint: {
        update: jest.fn().mockResolvedValue({}),
      },
      userCompanyRelation: {
        findFirst: jest.fn().mockResolvedValue({ role: { name: 'company_admin' } }),
      },
    };
    const emitter = new EventEmitter();
    const adapter: any = {
      ensureEmitter: jest.fn().mockReturnValue(emitter),
      initSession: jest.fn(),
      getProfilePictureUrl: jest.fn(),
    };
    const evolutionApi: any = {};
    const eventBus: any = { emit: jest.fn() };
    const resolver: any = { resolve: jest.fn() };
    const ownerNotifications: any = { enqueueInbound: jest.fn() };
    const outbound: any = { execute: jest.fn() };
    const service = new WhatsAppService(
      prisma,
      adapter,
      evolutionApi,
      eventBus,
      resolver,
      ownerNotifications,
      outbound,
    );
    return { service, prisma, adapter, eventBus };
  }

  function loggerText(log: any, warn: any, error: any) {
    return [...log.mock.calls, ...warn.mock.calls, ...error.mock.calls]
      .flat()
      .map(String)
      .join('\n');
  }

  afterEach(() => {
    jest.restoreAllMocks();
    jest.useRealTimers();
  });

  it('keeps session lifecycle, incoming failure, and init failure logs metadata-only', async () => {
    const { service, prisma, adapter, eventBus } = createHarness();
    const log = jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const error = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'debug').mockImplementation(() => undefined);

    await (service as any).handleConnected('session-db-sentinel', '+8613800012345');
    jest.useFakeTimers();
    await (service as any).handleDisconnected('session-db-sentinel');
    jest.clearAllTimers();

    prisma.communicationMessage.findUnique.mockRejectedValueOnce(new Error(sentinel));
    await expect((service as any).handleIncomingMessage(
      'company-sentinel',
      'session-db-sentinel',
      'account-sentinel',
      {
        key: {
          id: 'message-sentinel',
          remoteJid: '8613800012345@s.whatsapp.net',
        },
        message: { conversation: 'SENTINEL_MESSAGE_BODY' },
      },
      'inbound',
    )).rejects.toThrow(sentinel);

    prisma.whatsAppSession.create.mockResolvedValue({
      id: 'session-row-sentinel',
      companyId: 'company-sentinel',
      sessionId: 'session-sentinel',
      status: 'pending_qr',
    });
    adapter.initSession.mockRejectedValueOnce(new Error(sentinel));
    await expect(service.createAccount(
      { name: 'SENTINEL_ACCOUNT_NAME' },
      {
        id: 'operator-sentinel',
        activeCompanyId: 'company-sentinel',
        companies: [{ id: 'company-sentinel', role: 'company_admin' }],
      },
    )).rejects.toThrow('WhatsApp session initialization failed');

    expect(prisma.whatsAppSession.update).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ status: 'connected' }),
    }));
    expect(prisma.whatsAppSession.update).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ status: 'disconnected' }),
    }));
    expect(eventBus.emit).not.toHaveBeenCalled();

    const output = loggerText(log, warn, error);
    for (const value of [
      sentinel,
      'session-db-sentinel',
      'company-sentinel',
      'operator-sentinel',
      'SENTINEL_MESSAGE_BODY',
      'SENTINEL_ACCOUNT_NAME',
      'at ',
    ]) {
      expect(output).not.toContain(value);
    }
    expect(output).toContain('whatsapp.session.connected');
    expect(output).toContain('whatsapp.session.disconnected');
    expect(output).toContain('whatsapp.incoming.failed');
    expect(output).toContain('whatsapp.session.init_failed');
    expect(output).toContain('errorCategory');
  });

  it('does not log avatar URL, phone, JID, or provider error details', async () => {
    const { service, prisma, adapter } = createHarness();
    const log = jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'debug').mockImplementation(() => undefined);
    const sentinelUrl = 'https://avatar.sentinel.invalid/customer?token=avatar-secret';
    const sentinelPhone = '+8613900099999';
    const sentinelJid = '8613900099999@s.whatsapp.net';
    const sentinelConversation = 'conversation-avatar-sentinel';
    prisma.whatsAppSession.findUnique.mockResolvedValue({
      id: 'session-avatar-sentinel',
      sessionId: 'provider-instance-avatar-sentinel',
      status: 'connected',
    });
    adapter.getProfilePictureUrl.mockResolvedValue(sentinelUrl);

    await (service as any).fetchAndCacheAvatar(
      sentinelConversation,
      'session-avatar-sentinel',
      sentinelPhone,
      sentinelJid,
      'contact-point-avatar-sentinel',
    );

    const output = loggerText(log, Logger.prototype.warn as any, Logger.prototype.error as any);
    for (const value of [sentinelUrl, sentinelPhone, sentinelJid, sentinelConversation]) {
      expect(output).not.toContain(value);
    }
    expect(output).toContain('whatsapp.avatar.cached');
  });
});
