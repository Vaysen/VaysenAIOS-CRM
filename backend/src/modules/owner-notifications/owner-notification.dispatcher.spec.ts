import { OwnerNotificationStatus } from '@prisma/client';
import { OwnerNotificationDispatcher } from './owner-notification.dispatcher';

describe('OwnerNotificationDispatcher', () => {
  const now = new Date('2026-07-18T08:00:00.000Z');
  const candidate = {
    id: 'notification-1',
    companyId: 'company-1',
    eventType: 'EMAIL_INBOUND',
    destination: 'OWNER_WECHAT',
    sourceType: 'brevo_inbound_email',
    sourceId: 'message-1',
    conversationId: 'conversation-1',
    leadId: 'lead-1',
    subject: 'New customer reply',
    preview: 'Please update the quotation.',
    status: OwnerNotificationStatus.PENDING,
    attempts: 0,
    maxAttempts: 3,
    nextAttemptAt: now,
    expiresAt: new Date('2026-07-19T08:00:00.000Z'),
    claimedAt: null,
    createdAt: new Date('2026-07-18T07:59:00.000Z'),
  };

  let prisma: any;

  beforeEach(() => {
    prisma = {
      ownerNotificationOutbox: {
        updateMany: jest.fn(),
        findMany: jest.fn().mockResolvedValue([candidate]),
      },
    };
  });

  it('does not claim or fake SENT when no delivery adapter is registered', async () => {
    prisma.ownerNotificationOutbox.updateMany.mockResolvedValue({ count: 0 });
    const dispatcher = new OwnerNotificationDispatcher(prisma, undefined);

    await expect(dispatcher.dispatchDue(20, now)).resolves.toEqual({
      claimed: 0,
      sent: 0,
      failed: 0,
      reason: 'NO_DELIVERY_ADAPTER',
    });
    expect(prisma.ownerNotificationOutbox.findMany).not.toHaveBeenCalled();
    expect(prisma.ownerNotificationOutbox.updateMany).toHaveBeenCalledTimes(2);
  });

  it('marks SENT only after a concrete provider receipt is returned', async () => {
    prisma.ownerNotificationOutbox.updateMany
      .mockResolvedValueOnce({ count: 0 })
      .mockResolvedValueOnce({ count: 0 })
      .mockResolvedValueOnce({ count: 1 })
      .mockResolvedValueOnce({ count: 1 });
    const sender = {
      send: jest.fn().mockResolvedValue({ provider: 'openclaw-weixin', receiptId: 'receipt-1' }),
    };
    const dispatcher = new OwnerNotificationDispatcher(prisma, sender);

    await expect(dispatcher.dispatchDue(20, now)).resolves.toEqual({
      claimed: 1,
      sent: 1,
      failed: 0,
    });
    expect(sender.send).toHaveBeenCalledWith(expect.objectContaining({
      id: 'notification-1',
      companyId: 'company-1',
      destination: 'OWNER_WECHAT',
      preview: 'Please update the quotation.',
    }));
    expect(prisma.ownerNotificationOutbox.updateMany).toHaveBeenLastCalledWith({
      where: { id: 'notification-1', status: OwnerNotificationStatus.SENDING },
      data: expect.objectContaining({
        status: OwnerNotificationStatus.SENT,
        provider: 'openclaw-weixin',
        providerReceiptId: 'receipt-1',
      }),
    });
  });

  it('persists FAILED with a retry time when the adapter fails', async () => {
    prisma.ownerNotificationOutbox.updateMany
      .mockResolvedValueOnce({ count: 0 })
      .mockResolvedValueOnce({ count: 0 })
      .mockResolvedValueOnce({ count: 1 })
      .mockResolvedValueOnce({ count: 1 });
    const sender = { send: jest.fn().mockRejectedValue(new Error('gateway token=secret-value failed')) };
    const dispatcher = new OwnerNotificationDispatcher(prisma, sender);

    await expect(dispatcher.dispatchDue(20, now)).resolves.toEqual({
      claimed: 1,
      sent: 0,
      failed: 1,
    });
    expect(prisma.ownerNotificationOutbox.updateMany).toHaveBeenLastCalledWith({
      where: { id: 'notification-1', status: OwnerNotificationStatus.SENDING },
      data: expect.objectContaining({
        status: OwnerNotificationStatus.FAILED,
        nextAttemptAt: new Date('2026-07-18T08:00:30.000Z'),
        lastError: expect.not.stringContaining('secret-value'),
      }),
    });
  });
});
