import { ForbiddenException } from '@nestjs/common';
import { OwnerNotificationStatus } from '@prisma/client';
import { OwnerNotificationsController } from './owner-notifications.controller';

describe('OwnerNotificationsController', () => {
  const prisma = {
    openClawOperatorBinding: { count: jest.fn() },
    ownerNotificationOutbox: {
      count: jest.fn(),
      findFirst: jest.fn(),
    },
  } as any;
  const gateway = { probe: jest.fn() } as any;
  const user = { companies: [{ id: 'company-1', role: 'company_admin' }] };

  beforeEach(() => jest.resetAllMocks());

  it('returns tenant-scoped queue counts and the true connected state without message content', async () => {
    prisma.openClawOperatorBinding.count.mockResolvedValue(1);
    prisma.ownerNotificationOutbox.count
      .mockResolvedValueOnce(2)
      .mockResolvedValueOnce(1)
      .mockResolvedValueOnce(9)
      .mockResolvedValueOnce(3);
    prisma.ownerNotificationOutbox.findFirst.mockResolvedValue({
      status: OwnerNotificationStatus.SENT,
      eventType: 'WHATSAPP_INBOUND',
      createdAt: new Date('2026-07-18T09:00:00.000Z'),
      sentAt: new Date('2026-07-18T09:00:02.000Z'),
      lastError: null,
      preview: 'must not leak',
    });
    gateway.probe.mockResolvedValue({
      enabled: true,
      wechatOwnerChannel: { status: 'CONNECTED' },
    });
    const controller = new OwnerNotificationsController(prisma, gateway);

    const result = await controller.status('company-1', user);

    expect(result).toEqual(expect.objectContaining({
      enabled: true,
      channel: 'openclaw-weixin',
      channelStatus: 'CONNECTED',
      counts: { pending: 2, sending: 1, sent: 9, failed: 3 },
      lastDelivery: expect.objectContaining({
        status: OwnerNotificationStatus.SENT,
        eventType: 'WHATSAPP_INBOUND',
        errorCode: null,
      }),
    }));
    expect(JSON.stringify(result)).not.toContain('must not leak');
  });

  it('reports unbound instead of treating a running Gateway as a notification receipt', async () => {
    prisma.openClawOperatorBinding.count.mockResolvedValue(0);
    prisma.ownerNotificationOutbox.count.mockResolvedValue(0);
    prisma.ownerNotificationOutbox.findFirst.mockResolvedValue(null);
    gateway.probe.mockResolvedValue({
      enabled: true,
      wechatOwnerChannel: { status: 'CONNECTED' },
    });
    const controller = new OwnerNotificationsController(prisma, gateway);
    await expect(controller.status('company-1', user)).resolves.toEqual(expect.objectContaining({
      enabled: false,
      channelStatus: 'UNBOUND',
    }));
  });

  it('rejects cross-company status reads before touching notification data', async () => {
    const controller = new OwnerNotificationsController(prisma, gateway);
    await expect(controller.status('company-2', user)).rejects.toBeInstanceOf(ForbiddenException);
    expect(prisma.ownerNotificationOutbox.count).not.toHaveBeenCalled();
  });
});
