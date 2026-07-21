import { BadRequestException } from '@nestjs/common';
import { CommunicationsService } from './communications.service';

describe('CommunicationsService WhatsApp provider boundary', () => {
  function makeService(overrides: Record<string, any> = {}) {
    const conversation = {
      id: 'conversation-1',
      companyId: 'company-1',
      leadId: null,
      channel: 'whatsapp',
      whatsappSessionId: 'session-db-1',
      externalThreadId: '8613800001234@s.whatsapp.net',
      unreadCount: 0,
      lead: null,
      contactPoint: null,
      ...overrides,
    };
    const prisma: any = {
      conversation: {
        findUnique: jest.fn().mockResolvedValue(conversation),
        update: jest.fn().mockResolvedValue(conversation),
      },
      communicationMessage: {
        create: jest.fn().mockResolvedValue({ id: 'message-1' }),
        findUnique: jest.fn(),
      },
      leadActivity: { create: jest.fn() },
    };
    const whatsapp: any = {
      sendTextOnly: jest.fn(),
      sendMediaOnly: jest.fn(),
      buildMessageIngestionKey: jest.fn().mockReturnValue('a'.repeat(64)),
    };
    const eventBus = { emit: jest.fn() } as any;
    const service = new CommunicationsService(prisma, whatsapp, eventBus);
    return { service, prisma, whatsapp, conversation };
  }

  const currentUser = { companies: [{ id: 'company-1' }] };

  it('does not persist an outbound row when the provider send rejects', async () => {
    const { service, prisma, whatsapp } = makeService();
    whatsapp.sendTextOnly.mockRejectedValue(new Error('Baileys socket closed'));

    await expect(service.addMessage('conversation-1', {
      direction: 'outbound',
      content: 'hello',
      contentType: 'text',
    } as any, currentUser)).rejects.toThrow('Baileys socket closed');

    expect(prisma.communicationMessage.create).not.toHaveBeenCalled();
  });

  it('rejects a WhatsApp outbound write when no sending session is bound', async () => {
    const { service, prisma, whatsapp } = makeService({ whatsappSessionId: null });

    await expect(service.addMessage('conversation-1', {
      direction: 'outbound',
      content: 'hello',
      contentType: 'text',
    } as any, currentUser)).rejects.toBeInstanceOf(BadRequestException);

    expect(whatsapp.sendTextOnly).not.toHaveBeenCalled();
    expect(prisma.communicationMessage.create).not.toHaveBeenCalled();
  });

  it('persists the real provider id and scoped ingestion key after acceptance', async () => {
    const { service, prisma, whatsapp } = makeService();
    whatsapp.sendTextOnly.mockResolvedValue({
      success: true,
      provider: 'baileys',
      providerMessageId: 'provider-123',
      messageId: 'provider-123',
      status: 'accepted',
      acceptedAt: '2026-07-18T10:00:00.000Z',
    });

    await service.addMessage('conversation-1', {
      direction: 'outbound',
      content: 'hello',
      contentType: 'text',
    } as any, currentUser);

    expect(whatsapp.buildMessageIngestionKey).toHaveBeenCalledWith(
      'company-1',
      'session-db-1',
      'provider-123',
    );
    expect(prisma.communicationMessage.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        direction: 'outbound',
        externalMessageId: 'provider-123',
        ingestionKey: 'a'.repeat(64),
        deliveryStatus: 'sent',
        sentAt: new Date('2026-07-18T10:00:00.000Z'),
      }),
    });
  });
});
