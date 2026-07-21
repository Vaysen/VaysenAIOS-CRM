import { OwnerNotificationService, redactOwnerNotificationText } from './owner-notification.service';

describe('OwnerNotificationService', () => {
  let prisma: any;
  let service: OwnerNotificationService;

  beforeEach(() => {
    prisma = {
      ownerNotificationOutbox: {
        create: jest.fn(),
        findUnique: jest.fn(),
      },
    };
    service = new OwnerNotificationService(prisma);
  });

  it('creates a short redacted inbound-only notification with a digest event key', async () => {
    prisma.ownerNotificationOutbox.create.mockImplementation(async ({ data }: any) => ({
      id: 'notification-1',
      ...data,
    }));

    const result = await service.enqueueInbound({
      companyId: 'company-1',
      eventType: 'EMAIL_INBOUND',
      sourceMessageKey: '<provider-message-id@example.net>',
      sourceType: 'brevo_inbound_email',
      sourceId: 'message-1',
      subject: 'Reply from buyer@example.net',
      preview: 'Call +1 (816) 579-6304. API key: very-secret-value https://private.example/path',
    });

    const stored = prisma.ownerNotificationOutbox.create.mock.calls[0][0].data;
    expect(result.created).toBe(true);
    expect(stored.eventKey).toMatch(/^[a-f0-9]{64}$/);
    expect(stored.eventKey).not.toContain('provider-message-id');
    expect(stored.subject).toBe('Reply from b***@example.net');
    expect(stored.preview).toContain('181****04');
    expect(stored.preview).toContain('key=[已脱敏]');
    expect(stored.preview).toContain('[链接]');
    expect(stored.preview).not.toContain('very-secret-value');
    expect(stored.destination).toBe('OWNER_WECHAT');
    expect(stored.status).toBe('PENDING');
  });

  it('returns the existing record when the unique event key is replayed', async () => {
    prisma.ownerNotificationOutbox.create.mockRejectedValue({ code: 'P2002' });
    prisma.ownerNotificationOutbox.findUnique.mockResolvedValue({ id: 'existing-1' });

    const result = await service.enqueueInbound({
      companyId: 'company-1',
      eventType: 'WHATSAPP_INBOUND',
      sourceMessageKey: 'wamid-1',
      sourceType: 'whatsapp_message',
      preview: 'Hello',
    });

    expect(result).toEqual({ created: false, record: { id: 'existing-1' } });
    expect(prisma.ownerNotificationOutbox.findUnique).toHaveBeenCalledWith({
      where: { eventKey: expect.stringMatching(/^[a-f0-9]{64}$/) },
    });
  });

  it('rejects outbound events and invalid internal references', async () => {
    await expect(service.enqueueInbound({
      companyId: 'company-1',
      eventType: 'WHATSAPP_OUTBOUND' as any,
      sourceMessageKey: 'message-1',
      sourceType: 'whatsapp_message',
      preview: 'Hello',
    })).rejects.toThrow(/non-inbound/i);

    await expect(service.enqueueInbound({
      companyId: 'company-1',
      eventType: 'WHATSAPP_INBOUND',
      sourceMessageKey: 'message-1',
      sourceType: 'whatsapp_message',
      sourceId: 'raw phone +1 816 579 6304',
      preview: 'Hello',
    })).rejects.toThrow(/invalid internal reference/i);
    expect(prisma.ownerNotificationOutbox.create).not.toHaveBeenCalled();
  });

  it('bounds preview length even after redaction', () => {
    expect(redactOwnerNotificationText('x'.repeat(500), 40)).toHaveLength(40);
  });
});
