import { OpenClawOwnerNotificationSender } from './openclaw-owner-notification.sender';

describe('OpenClawOwnerNotificationSender', () => {
  const prisma = {
    openClawOperatorBinding: { findMany: jest.fn() },
  } as any;
  const gateway = { notifyOwner: jest.fn() } as any;
  const notification = {
    id: 'notification-1',
    companyId: 'company-1',
    eventType: 'WHATSAPP_INBOUND' as const,
    destination: 'OWNER_WECHAT' as const,
    subject: 'AcmeCorp',
    preview: 'Can you send a quotation?',
    sourceType: 'BAILEYS',
    sourceId: 'provider-1',
    conversationId: 'conversation-1',
    leadId: 'lead-1',
  };

  beforeEach(() => jest.resetAllMocks());

  it('delivers only through the unique active owner digest and returns the real receipt', async () => {
    prisma.openClawOperatorBinding.findMany.mockResolvedValue([
      { senderDigest: 'a'.repeat(64) },
    ]);
    gateway.notifyOwner.mockResolvedValue({
      success: true,
      reason: 'success',
      messageId: 'wechat-provider-1',
    });
    const sender = new OpenClawOwnerNotificationSender(prisma, gateway);

    await expect(sender.send(notification)).resolves.toEqual({
      provider: 'openclaw-weixin',
      receiptId: 'wechat-provider-1',
    });
    expect(gateway.notifyOwner).toHaveBeenCalledWith(expect.objectContaining({
      ownerDigest: 'a'.repeat(64),
      eventKey: 'notification-1',
      text: expect.stringContaining('Can you send a quotation?'),
    }));
  });

  const invalidBindingSets: Array<{ bindings: Array<{ senderDigest: string }> }> = [
    { bindings: [] },
    { bindings: [{ senderDigest: 'a'.repeat(64) }, { senderDigest: 'b'.repeat(64) }] },
  ];

  it.each(invalidBindingSets)(
    'fails closed when the active owner binding is absent or ambiguous',
    async ({ bindings }) => {
      prisma.openClawOperatorBinding.findMany.mockResolvedValue(bindings);
      const sender = new OpenClawOwnerNotificationSender(prisma, gateway);
      await expect(sender.send(notification)).rejects.toThrow(/OWNER_WECHAT/);
      expect(gateway.notifyOwner).not.toHaveBeenCalled();
    },
  );

  it('does not fabricate delivery when the gateway lacks a provider receipt', async () => {
    prisma.openClawOperatorBinding.findMany.mockResolvedValue([
      { senderDigest: 'a'.repeat(64) },
    ]);
    gateway.notifyOwner.mockResolvedValue({ success: false, reason: 'gateway_error' });
    const sender = new OpenClawOwnerNotificationSender(prisma, gateway);
    await expect(sender.send(notification)).rejects.toThrow('OWNER_WECHAT_GATEWAY_ERROR');
  });
});
