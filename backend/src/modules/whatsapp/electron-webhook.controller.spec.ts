import { ServiceUnavailableException } from '@nestjs/common';
import { ElectronWebhookController } from './electron-webhook.controller';

describe('ElectronWebhookController WhatsApp identity sanitization', () => {
  function makeController() {
    const whatsappService = {
      findSessionByAccountId: jest.fn().mockResolvedValue({ sessionId: 'session-1' }),
      ensureElectronSessionMapping: jest.fn().mockResolvedValue({
        id: 'session-db-1',
        sessionId: 'session-1',
        companyId: 'company-1',
      }),
      handleEvolutionMessage: jest.fn().mockResolvedValue(undefined),
      updateConnectionStatus: jest.fn().mockResolvedValue(undefined),
      syncContactsFromSnapshots: jest.fn().mockResolvedValue({ synced: 1, skipped: 0 }),
    };
    const eventBus = { emit: jest.fn() };
    const controller = new ElectronWebhookController(
      whatsappService as any,
      eventBus as any,
    );
    return { controller, whatsappService };
  }

  const basePayload = {
    accountId: 'account-1',
    id: 'message-1',
    text: 'hello',
    isOutgoing: false,
    timestamp: '2026-07-12T00:00:00.000Z',
    type: 'text' as const,
    chatPhone: '',
    isGroup: false,
  };
  const currentUser = { companies: [{ id: 'company-1' }] };

  it('不把“最后上线于…”转交为姓名候选', async () => {
    const { controller, whatsappService } = makeController();

    await controller.handleNewMessage(
      {
        ...basePayload,
        chatName: '最后上线于2026年6月26日06:05',
        displayNameCandidate: '最后上线于2026年6月26日06:05',
      },
      currentUser,
      'company-1',
    );

    expect(whatsappService.handleEvolutionMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        pushName: '',
        displayNameCandidate: undefined,
      }),
      'company-1',
    );
  });

  it('保留真实联系人名称', async () => {
    const { controller, whatsappService } = makeController();

    await controller.handleNewMessage(
      { ...basePayload, chatName: 'Sample Buyer' },
      currentUser,
      'company-1',
    );

    expect(whatsappService.handleEvolutionMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        pushName: 'Sample Buyer',
        displayNameCandidate: 'Sample Buyer',
        isGroup: null,
        groupStatusSource: undefined,
        phoneCandidate: null,
      }),
      'company-1',
    );
    expect(whatsappService.ensureElectronSessionMapping).toHaveBeenCalledWith(
      'account-1',
      currentUser,
      'company-1',
      'connected',
    );
  });

  it('缺少当前公司请求头时 fail-closed，不在用户的多个公司中猜测 session', async () => {
    const { controller, whatsappService } = makeController();

    const action = controller.handleNewMessage(
      { ...basePayload, chatName: 'Sample Buyer' },
      { companies: [{ id: 'company-1' }, { id: 'company-2' }] },
      undefined,
    );

    await expect(action).rejects.toMatchObject({
      status: 503,
      response: { message: expect.stringContaining('X-Company-Id is required') },
    });
    expect(whatsappService.ensureElectronSessionMapping).not.toHaveBeenCalled();
  });

  it('拒绝持久化 outbox 绑定公司与当前请求头不一致的消息', async () => {
    const { controller, whatsappService } = makeController();

    const action = controller.handleNewMessage(
      {
        ...basePayload,
        chatName: 'Sample Buyer',
        selectedCompanyId: 'company-2',
      },
      { companies: [{ id: 'company-1' }, { id: 'company-2' }] },
      'company-1',
    );

    await expect(action).rejects.toMatchObject({
      status: 503,
      response: { message: expect.stringContaining('company binding does not match') },
    });
    expect(whatsappService.ensureElectronSessionMapping).not.toHaveBeenCalled();
  });

  it('只有 DOM JID 才能把 Electron 消息确认为私聊并派生号码', async () => {
    const { controller, whatsappService } = makeController();

    await controller.handleNewMessage(
      {
        ...basePayload,
        chatName: 'Sample Buyer',
        fromPhone: '19999999999',
        phoneCandidate: '18888888888',
        externalId: '8613800001234@c.us',
      },
      currentUser,
      'company-1',
    );

    expect(whatsappService.handleEvolutionMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        isGroup: false,
        externalId: '8613800001234@c.us',
        phoneCandidate: '8613800001234',
        groupStatusSource: 'electron_dom_jid',
      }),
      'company-1',
    );
  });

  it('把 WhatsApp message-out 按出站方向交给同一持久化处理链', async () => {
    const { controller, whatsappService } = makeController();

    await controller.handleNewMessage(
      {
        ...basePayload,
        isOutgoing: true,
        chatName: 'Sample Buyer',
        chatPhone: '8613800001234',
        externalId: '8613800001234@c.us',
      },
      currentUser,
      'company-1',
    );

    expect(whatsappService.handleEvolutionMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        direction: 'outbound',
        fromPhone: '8613800001234',
        externalId: '8613800001234@c.us',
      }),
      'company-1',
    );
  });

  it('忽略 self chat，不能把自己的消息建成客户会话', async () => {
    const { controller, whatsappService } = makeController();

    await expect(controller.handleNewMessage(
      { ...basePayload, chatName: 'Myself', isSelf: true, isOutgoing: true },
      currentUser,
      'company-1',
    )).resolves.toEqual({ status: 'ignored', reason: 'self_chat' });

    expect(whatsappService.handleEvolutionMessage).not.toHaveBeenCalled();
  });

  it('即使 renderer 声称私聊，也会把 @g.us 外部标识按群聊处理', async () => {
    const { controller, whatsappService } = makeController();

    await controller.handleNewMessage(
      {
        ...basePayload,
        chatName: 'Buyer group',
        isGroup: false,
        externalId: '120363000000000@g.us',
      },
      currentUser,
      'company-1',
    );

    expect(whatsappService.handleEvolutionMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        isGroup: true,
        groupJid: '120363000000000@g.us',
      }),
      'company-1',
    );
  });

  it('renderer 只给群聊布尔值但没有 @g.us 时降为 unknown 隔离而非 poison 重试', async () => {
    const { controller, whatsappService } = makeController();

    await controller.handleNewMessage(
      { ...basePayload, chatName: 'Unknown group', isGroup: true, chatPhone: '8613800000000' },
      currentUser,
      'company-1',
    );

    expect(whatsappService.handleEvolutionMessage).toHaveBeenCalledWith(
      expect.objectContaining({ isGroup: null, groupJid: undefined }),
      'company-1',
    );
  });

  it('消息处理失败时返回非 2xx 异常，允许 Electron outbox 重试', async () => {
    const { controller, whatsappService } = makeController();
    whatsappService.handleEvolutionMessage.mockRejectedValueOnce(
      new Error('database unavailable'),
    );

    const action = controller.handleNewMessage(
      { ...basePayload, chatName: 'Sample Buyer' },
      currentUser,
      'company-1',
    );

    await expect(action).rejects.toBeInstanceOf(ServiceUnavailableException);
    await expect(action).rejects.toMatchObject({
      status: 503,
      response: {
        status: 'error',
        message: 'database unavailable',
      },
    });
  });

  it('Electron session 映射创建失败时不得 200 丢弃消息', async () => {
    const { controller, whatsappService } = makeController();
    whatsappService.ensureElectronSessionMapping.mockRejectedValueOnce(
      new Error('mapping database unavailable'),
    );

    const action = controller.handleNewMessage(
      { ...basePayload, chatName: 'Sample Buyer' },
      currentUser,
      'company-1',
    );

    await expect(action).rejects.toBeInstanceOf(ServiceUnavailableException);
    await expect(action).rejects.toMatchObject({
      status: 503,
      response: {
        status: 'error',
        message: 'mapping database unavailable',
      },
    });
    expect(whatsappService.handleEvolutionMessage).not.toHaveBeenCalled();
  });

  it('状态回调会创建或修复同租户 Electron 映射', async () => {
    const { controller, whatsappService } = makeController();

    await controller.handleStatusUpdate(
      { accountId: 'account-1', status: 'logged_in', timestamp: Date.now() },
      currentUser,
      'company-1',
    );

    expect(whatsappService.ensureElectronSessionMapping).toHaveBeenCalledWith(
      'account-1',
      currentUser,
      'company-1',
      'connected',
    );
  });

  it('永久拒绝没有幂等回执的旧 sent 回调入口', async () => {
    const { controller } = makeController();

    await expect(controller.handleMessageSent({
      accountId: 'account-1',
      toPhone: '8613800001234',
      text: 'legacy',
      success: true,
      messageId: 'legacy-1',
    }, { companyId: 'company-1' })).rejects.toMatchObject({ status: 410 });
  });
});
