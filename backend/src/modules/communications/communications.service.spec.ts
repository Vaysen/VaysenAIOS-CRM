import { BadRequestException } from '@nestjs/common';
import { CommunicationsService } from './communications.service';

describe('CommunicationsService WhatsApp auto-archive identity', () => {
  const prisma: any = {
    conversation: {
      findFirst: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
    },
    contactPoint: { upsert: jest.fn(), update: jest.fn() },
    $transaction: jest.fn(async (callback: any) => callback(prisma)),
  };
  const service = new CommunicationsService(prisma, {} as any, {} as any);
  const user = { id: 'user-1', companies: [{ id: 'company-1' }] };

  beforeEach(() => {
    jest.clearAllMocks();
    prisma.conversation.findFirst.mockResolvedValue(null);
    prisma.contactPoint.upsert.mockResolvedValue({ id: 'point-1' });
    prisma.contactPoint.update.mockResolvedValue({ id: 'point-1', leadId: 'lead-1' });
    prisma.conversation.create.mockResolvedValue({ id: 'conversation-1' });
    prisma.conversation.update.mockResolvedValue({ id: 'conversation-1' });
    jest.spyOn(service, 'findConversation').mockResolvedValue({ id: 'conversation-1' } as any);
  });

  it('creates a verified WhatsApp ContactPoint for a validated E.164 number', async () => {
    await service.createConversation({
      channel: 'whatsapp',
      leadId: 'lead-1',
      contactPhone: '+8615306000000',
      subject: 'Customer',
    }, user);

    expect(prisma.contactPoint.upsert).toHaveBeenCalledWith(expect.objectContaining({
      where: {
        companyId_type_normalizedValue: {
          companyId: 'company-1',
          type: 'whatsapp',
          normalizedValue: '+8615306000000',
        },
      },
      create: expect.objectContaining({
        leadId: 'lead-1',
        normalizedValue: '+8615306000000',
        isVerified: true,
        verificationMethod: 'whatsapp_jid',
      }),
    }));
    expect(prisma.conversation.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        contactPointId: 'point-1',
        externalThreadId: '+8615306000000',
      }),
    });
  });

  it('rejects an ambiguous local number instead of guessing an identity', async () => {
    await expect(service.createConversation({
      channel: 'whatsapp',
      leadId: 'lead-1',
      contactPhone: '15306000000',
    }, user)).rejects.toBeInstanceOf(BadRequestException);

    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(prisma.contactPoint.upsert).not.toHaveBeenCalled();
  });

  it('does not move an exact phone identity between two customer records', async () => {
    prisma.contactPoint.upsert.mockResolvedValue({ id: 'point-1', leadId: 'other-lead' });

    await expect(service.createConversation({
      channel: 'whatsapp',
      leadId: 'lead-1',
      contactPhone: '+8615306000000',
    }, user)).rejects.toThrow('manual review required');

    expect(prisma.contactPoint.update).not.toHaveBeenCalled();
    expect(prisma.conversation.create).not.toHaveBeenCalled();
  });

  it('backfills an exact identity anchor onto an existing empty conversation', async () => {
    prisma.conversation.findFirst.mockResolvedValue({ id: 'conversation-existing' });
    prisma.contactPoint.upsert.mockResolvedValue({ id: 'point-1', leadId: 'lead-1' });

    await service.createConversation({
      channel: 'whatsapp',
      leadId: 'lead-1',
      contactPhone: '+8615306000000',
    }, user);

    expect(prisma.conversation.update).toHaveBeenCalledWith({
      where: { id: 'conversation-existing' },
      data: {
        contactPointId: 'point-1',
        externalThreadId: '+8615306000000',
      },
    });
    expect(prisma.conversation.create).not.toHaveBeenCalled();
  });
});
