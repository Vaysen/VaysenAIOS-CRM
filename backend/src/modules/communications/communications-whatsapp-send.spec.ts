import { BadRequestException, InternalServerErrorException } from '@nestjs/common';
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
        findFirst: jest.fn().mockResolvedValue(conversation),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        update: jest.fn().mockResolvedValue(conversation),
      },
      communicationMessage: {
        create: jest.fn().mockResolvedValue({ id: 'message-1' }),
        findFirst: jest.fn(),
      },
      leadActivity: { create: jest.fn() },
      userCompanyRelation: {
        findFirst: jest.fn().mockResolvedValue({
          id: 'membership-1',
          role: { name: 'sales_user' },
        }),
      },
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

  const currentUser = {
    id: 'user-1',
    activeCompanyId: 'company-1',
    activeCompany: { id: 'company-1', name: 'company-1', role: 'sales_user' },
    companies: [{ id: 'company-1', name: 'company-1', role: 'sales_user' }],
  };

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

  it('dispatches an Evolution-bound session to Evolution and never calls Baileys', async () => {
    const { service, prisma, whatsapp } = makeService();
    whatsapp.isEvolutionSession = jest.fn().mockResolvedValue(true);
    whatsapp.sendEvolutionText = jest.fn().mockResolvedValue({
      success: true, provider: 'evolution', providerMessageId: 'evo-text-1',
      messageId: 'evo-text-1', status: 'accepted', acceptedAt: '2026-07-30T10:00:00.000Z',
    });
    await service.addMessage('conversation-1', {
      direction: 'outbound', content: 'Evolution hello', contentType: 'text', idempotencyKey: 'evo-key-1',
    } as any, currentUser);
    expect(whatsapp.sendEvolutionText).toHaveBeenCalledWith(
      'session-db-1', '8613800001234@s.whatsapp.net', 'Evolution hello', currentUser,
      expect.objectContaining({ idempotencyKey: 'evo-key-1', conversationId: 'conversation-1' }),
    );
    expect(whatsapp.sendTextOnly).not.toHaveBeenCalled();
    expect(prisma.communicationMessage.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ externalMessageId: 'evo-text-1', deliveryStatus: 'sent' }),
    });
  });

  it('dispatches Evolution-bound PDF media through the Evolution method', async () => {
    const fs = require('fs');
    const path = require('path');
    const crypto = require('crypto');
    const root = path.resolve(process.env.UPLOADS_DIR || path.join(process.cwd(), 'uploads'));
    const tenant = crypto.createHash('sha256').update('company-1').digest('hex').slice(0, 24);
    const user = crypto.createHash('sha256').update('user-1').digest('hex').slice(0, 24);
    const dir = path.join(root, 'communications', tenant, user);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'quote.pdf'), Buffer.from('%PDF-local-fixture'));
    const { service, whatsapp } = makeService();
    whatsapp.isEvolutionSession = jest.fn().mockResolvedValue(true);
    whatsapp.sendEvolutionMedia = jest.fn().mockResolvedValue({
      success: true, provider: 'evolution', providerMessageId: 'evo-pdf-1',
      messageId: 'evo-pdf-1', status: 'accepted', acceptedAt: '2026-07-30T10:00:00.000Z',
    });
    await service.addMessage('conversation-1', {
      direction: 'outbound', content: 'Quote', contentType: 'document',
      attachmentsMeta: { url: `/uploads/communications/${tenant}/${user}/quote.pdf`, originalName: 'quote.pdf', mimeType: 'application/pdf' },
    } as any, currentUser);
    expect(whatsapp.sendEvolutionMedia).toHaveBeenCalledWith(
      'session-db-1', '8613800001234@s.whatsapp.net',
      expect.objectContaining({ type: 'document', filename: 'quote.pdf', buffer: expect.any(Buffer) }),
      currentUser, expect.any(Object),
    );
    expect(whatsapp.sendMediaOnly).not.toHaveBeenCalled();
  });

  it('returns a stable attachment error without exposing path, URL, or filename', async () => {
    const { service, prisma, whatsapp } = makeService();
    const crypto = require('crypto');
    const tenant = crypto.createHash('sha256').update('company-1').digest('hex').slice(0, 24);
    const user = crypto.createHash('sha256').update('user-1').digest('hex').slice(0, 24);
    const sentinel = 'C:\\Users\\customer\\sentinel-quote.pdf';
    const tokenUrl = `/uploads/communications/${tenant}/${user}/missing.pdf`;

    const error = await service.addMessage('conversation-1', {
      direction: 'outbound',
      content: 'Quote',
      contentType: 'document',
      attachmentsMeta: {
        url: tokenUrl,
        originalName: `${sentinel}?token=secret-token`,
        mimeType: 'application/pdf',
      },
    } as any, currentUser).catch((failure) => failure);

    expect(error).toBeInstanceOf(InternalServerErrorException);
    expect(error).toMatchObject({
      status: 500,
      response: {
        status: 'error',
        code: 'COMMUNICATION_ATTACHMENT_NOT_FOUND',
        message: 'Attachment file could not be read',
      },
    });
    expect(JSON.stringify(error.getResponse())).not.toContain(sentinel);
    expect(JSON.stringify(error.getResponse())).not.toContain(tokenUrl);
    expect(JSON.stringify(error.getResponse())).not.toContain('secret-token');
    expect(whatsapp.sendTextOnly).not.toHaveBeenCalled();
    expect(whatsapp.sendMediaOnly).not.toHaveBeenCalled();
    expect(prisma.communicationMessage.create).not.toHaveBeenCalled();
  });

  it('returns a stable 400 for an invalid attachment reference', async () => {
    const { service, prisma, whatsapp } = makeService();
    const sentinelUrl = '/uploads/communications/invalid?token=secret-token';
    const error = await service.addMessage('conversation-1', {
      direction: 'outbound',
      content: 'Quote',
      contentType: 'document',
      attachmentsMeta: {
        url: sentinelUrl,
        originalName: 'sentinel-invalid.pdf',
        mimeType: 'application/pdf',
      },
    } as any, currentUser).catch((failure) => failure);

    expect(error).toBeInstanceOf(BadRequestException);
    expect(error).toMatchObject({
      status: 400,
      response: {
        status: 'error',
        code: 'COMMUNICATION_ATTACHMENT_INVALID',
        message: 'Attachment reference is invalid',
      },
    });
    expect(JSON.stringify(error.getResponse())).not.toContain(sentinelUrl);
    expect(JSON.stringify(error.getResponse())).not.toContain('secret-token');
    expect(whatsapp.sendMediaOnly).not.toHaveBeenCalled();
    expect(prisma.communicationMessage.create).not.toHaveBeenCalled();
  });
});
