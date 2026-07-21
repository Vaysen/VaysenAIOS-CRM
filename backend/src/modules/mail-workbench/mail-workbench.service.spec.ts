import { ForbiddenException } from '@nestjs/common';
import { MailWorkbenchService } from './mail-workbench.service';

describe('MailWorkbenchService real inbound mailbox', () => {
  const prisma = {
    communicationMessage: {
      findMany: jest.fn(),
      findUnique: jest.fn(),
      count: jest.fn(),
    },
    emailMessage: {
      findMany: jest.fn(),
      findUnique: jest.fn(),
      count: jest.fn(),
    },
  } as any;
  const ai = { chat: jest.fn() } as any;
  const languageService = { getLanguageName: jest.fn() } as any;
  const user = { companies: [{ id: 'company-1' }] };
  let service: MailWorkbenchService;

  beforeEach(() => {
    jest.clearAllMocks();
    service = new MailWorkbenchService(prisma, ai, languageService);
  });

  it('lists only real inbound business-email messages scoped to the JWT company', async () => {
    prisma.communicationMessage.findMany.mockResolvedValue([{
      id: 'message-1',
      subject: 'Re: quotation',
      fromAddress: 'buyer@example.com',
      toAddress: 'sales@reply.example.com',
      content: 'Please revise the price.',
      readAt: null,
      receivedAt: new Date('2026-07-13T08:00:00.000Z'),
      createdAt: new Date('2026-07-13T08:00:00.000Z'),
      attachmentsMeta: [],
      conversation: {
        companyId: 'company-1',
        leadId: 'lead-1',
        lead: { id: 'lead-1', contactEmail: 'buyer@example.com' },
      },
    }]);
    prisma.communicationMessage.count.mockResolvedValue(1);

    const result = await service.getMessages(user, { folder: 'inbox' });

    expect(prisma.communicationMessage.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          direction: 'inbound',
          conversation: expect.objectContaining({
            companyId: { in: ['company-1'] },
            channel: 'business_email',
          }),
        }),
      }),
    );
    expect(result).toMatchObject({
      data: [{ id: 'inbound:message-1', status: 'Received', leadId: 'lead-1' }],
      meta: { total: 1 },
    });
  });

  it('rejects opening an inbound message owned by another company', async () => {
    prisma.communicationMessage.findUnique.mockResolvedValue({
      id: 'message-2',
      content: 'private',
      conversation: { companyId: 'company-2', lead: null },
    });

    await expect(service.getMessage('inbound:message-2', user))
      .rejects.toBeInstanceOf(ForbiddenException);
  });
});
