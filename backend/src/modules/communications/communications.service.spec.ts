import {
  BadRequestException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { CommunicationsService } from './communications.service';

describe('CommunicationsService trusted conversation identity boundary', () => {
  const prisma: any = {
    conversation: {
      findFirst: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
    },
    lead: { findFirst: jest.fn() },
    contactPoint: { upsert: jest.fn(), update: jest.fn() },
    userCompanyRelation: { findFirst: jest.fn() },
    $transaction: jest.fn(async (callback: any) => callback(prisma)),
  };
  const service = new CommunicationsService(prisma, {} as any, {} as any);
  const user = {
    id: 'user-1',
    activeCompanyId: 'company-1',
    activeCompany: { id: 'company-1', name: 'company-1', role: 'sales_user' },
    companies: [{ id: 'company-2' }, { id: 'company-1' }],
  };

  beforeEach(() => {
    jest.clearAllMocks();
    prisma.userCompanyRelation.findFirst.mockResolvedValue({
      id: 'membership-1',
      role: { name: 'sales_user' },
    });
    prisma.lead.findFirst.mockResolvedValue({ id: 'lead-1' });
    prisma.conversation.findFirst.mockResolvedValue(null);
    prisma.lead.findFirst.mockResolvedValue({
      id: 'lead-1',
      ownerUserId: 'user-1',
    });
    prisma.conversation.create.mockResolvedValue({ id: 'conversation-1' });
    jest.spyOn(service, 'findConversation').mockResolvedValue({ id: 'conversation-1' } as any);
  });

  it('rejects an arbitrary E.164 number without creating a verified identity', async () => {
    await expect(service.createConversation({
      channel: 'whatsapp',
      leadId: 'lead-1',
      contactPhone: '+8615306000000',
      subject: 'Customer',
    }, user)).rejects.toThrow('Manual WhatsApp identity binding is unavailable');

    expect(prisma.contactPoint.upsert).not.toHaveBeenCalled();
    expect(prisma.contactPoint.update).not.toHaveBeenCalled();
    expect(prisma.conversation.create).not.toHaveBeenCalled();
  });

  it('rejects every user-supplied phone rather than guessing an identity', async () => {
    await expect(service.createConversation({
      channel: 'whatsapp',
      leadId: 'lead-1',
      contactPhone: '15306000000',
    }, user)).rejects.toBeInstanceOf(BadRequestException);

    expect(prisma.contactPoint.upsert).not.toHaveBeenCalled();
  });

  it('rejects provider binding fields even when called outside ValidationPipe', async () => {
    await expect(service.createConversation({
      channel: 'whatsapp',
      leadId: 'lead-1',
      externalThreadId: 'forged@s.whatsapp.net',
      whatsappSessionId: 'foreign-session',
    } as any, user)).rejects.toThrow(
      'Conversation field is not accepted: externalThreadId',
    );

    expect(prisma.conversation.create).not.toHaveBeenCalled();
  });

  it('returns an existing conversation without rebinding its provider thread', async () => {
    prisma.conversation.findFirst.mockResolvedValue({
      id: 'conversation-existing',
      externalThreadId: 'trusted@s.whatsapp.net',
      whatsappSessionId: 'trusted-session',
      contactPointId: 'trusted-point',
    });

    await service.createConversation({
      channel: 'whatsapp',
      leadId: 'lead-1',
    }, user);

    expect(prisma.conversation.findFirst).toHaveBeenCalledWith({
      where: expect.objectContaining({
        leadId: 'lead-1',
        channel: 'whatsapp',
        companyId: 'company-1',
        assignedUserId: 'user-1',
      }),
    });
    expect(prisma.conversation.update).not.toHaveBeenCalled();
    expect(prisma.contactPoint.update).not.toHaveBeenCalled();
    expect(prisma.conversation.create).not.toHaveBeenCalled();
  });

  it('uses the explicit active company instead of another JWT membership', async () => {
    await service.createConversation({
      channel: 'whatsapp',
      leadId: 'lead-1',
    }, user);

    expect(prisma.userCompanyRelation.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          userId: 'user-1',
          companyId: 'company-1',
          isActive: true,
          user: { is: { isActive: true, deletedAt: null } },
          company: { is: { isActive: true } },
        }),
      }),
    );
    expect(prisma.lead.findFirst).toHaveBeenCalledWith({
      where: { id: 'lead-1', companyId: 'company-1', deletedAt: null },
      select: { id: true, ownerUserId: true },
    });
  });

  it('rejects a missing explicit active company even when JWT memberships exist', async () => {
    await expect(service.createConversation({
      channel: 'whatsapp',
      leadId: 'lead-1',
      contactPhone: '+8615306000000',
    }, {
      id: 'user-1',
      companies: [{ id: 'company-1' }],
    })).rejects.toBeInstanceOf(ForbiddenException);

    expect(prisma.userCompanyRelation.findFirst).not.toHaveBeenCalled();
    expect(prisma.contactPoint.upsert).not.toHaveBeenCalled();
  });

  it('rejects stale or inactive database membership before tenant data access', async () => {
    prisma.userCompanyRelation.findFirst.mockResolvedValue(null);

    await expect(service.createConversation({
      channel: 'whatsapp',
      leadId: 'lead-1',
      contactPhone: '+8615306000000',
    }, user)).rejects.toBeInstanceOf(ForbiddenException);

    expect(prisma.lead.findFirst).not.toHaveBeenCalled();
    expect(prisma.conversation.findFirst).not.toHaveBeenCalled();
    expect(prisma.contactPoint.upsert).not.toHaveBeenCalled();
  });

  it('rejects a lead from another tenant before contact or conversation writes', async () => {
    prisma.lead.findFirst.mockResolvedValue(null);

    await expect(service.createConversation({
      channel: 'whatsapp',
      leadId: 'foreign-lead',
    }, user)).rejects.toBeInstanceOf(NotFoundException);

    expect(prisma.lead.findFirst).toHaveBeenCalledWith({
      where: { id: 'foreign-lead', companyId: 'company-1', deletedAt: null },
      select: { id: true, ownerUserId: true },
    });
    expect(prisma.contactPoint.upsert).not.toHaveBeenCalled();
    expect(prisma.conversation.create).not.toHaveBeenCalled();
  });

  it('scopes conversation and contact-point reads to the exact active tenant', async () => {
    jest.restoreAllMocks();
    prisma.conversation.findFirst.mockResolvedValue(null);

    await expect(service.findConversation('foreign-conversation', user))
      .rejects.toBeInstanceOf(NotFoundException);

    expect(prisma.conversation.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          id: 'foreign-conversation',
          companyId: 'company-1',
          assignedUserId: 'user-1',
          AND: [
            {
              OR: [
                { leadId: null },
                { lead: { is: { companyId: 'company-1', deletedAt: null } } },
              ],
            },
            {
              OR: [
                { contactPointId: null },
                { contactPoint: { is: { companyId: 'company-1' } } },
              ],
            },
          ],
        },
      }),
    );
  });
});
