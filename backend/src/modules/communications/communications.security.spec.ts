import { createHmac } from 'crypto';
import {
  BadRequestException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { CommunicationsService } from './communications.service';

const secret = 'communications-public-secret-1234567890';
const tenantUser = (role = 'sales_user') => ({
  id: 'user-a',
  activeCompanyId: 'tenant-a',
  activeCompany: { id: 'tenant-a', role },
  companies: [{ id: 'tenant-a', role }],
});

type MembershipFixture = {
  userId: string;
  companyId: string;
  role: string;
  isActive: boolean;
  userActive: boolean;
  userDeletedAt: Date | null;
  companyActive: boolean;
};

const membershipFixture = (
  user: any,
  overrides: Partial<MembershipFixture> = {},
): MembershipFixture => ({
  userId: user.id,
  companyId: user.activeCompanyId,
  role: user.activeCompany?.role || '',
  isActive: true,
  userActive: true,
  userDeletedAt: null,
  companyActive: true,
  ...overrides,
});

const withMembership = (
  prisma: any,
  userOrRole: any,
  overrides: Partial<MembershipFixture> = {},
) => {
  const user = typeof userOrRole === 'string' ? tenantUser(userOrRole) : userOrRole;
  const fixture = membershipFixture(user, overrides);
  return {
    ...prisma,
    userCompanyRelation: {
      ...(prisma.userCompanyRelation || {}),
      findFirst: jest.fn(async ({ where }: any = {}) => {
        if (
          !where
          || where.userId !== fixture.userId
          || where.companyId !== fixture.companyId
          || (where.isActive === true && !fixture.isActive)
          || (where.user?.is?.isActive === true && !fixture.userActive)
          || (where.user?.is?.deletedAt === null && fixture.userDeletedAt !== null)
          || (where.company?.is?.isActive === true && !fixture.companyActive)
        ) {
          return null;
        }
        return {
          id: `${fixture.companyId}:${fixture.userId}`,
          role: { name: fixture.role },
        };
      }),
    },
  };
};

const signedInquiry = (overrides: Record<string, unknown> = {}) => {
  const dto: any = {
    sourceKey: 'website-main',
    timestamp: Math.floor(Date.now() / 1000),
    nonce: 'nonce_1234567890abcdef',
    source: 'contact_form',
    contactName: 'Buyer',
    email: 'buyer@example.test',
    subject: 'Quote',
    message: 'Please quote this product.',
    ...overrides,
  };
  const canonical = JSON.stringify([
    'v2', 'website-inquiry', dto.sourceKey, dto.timestamp, dto.nonce,
    dto.source, dto.contactName, dto.email, '', '', '', dto.subject,
    dto.message, '', '', '', '', '', [],
  ]);
  dto.signature = createHmac('sha256', secret)
    .update(canonical, 'utf8')
    .digest('hex');
  return dto;
};

describe('CommunicationsService security boundaries', () => {
  beforeEach(() => {
    process.env.WHATSAPP_CLICK_SOURCES = JSON.stringify([{
      sourceKey: 'website-main',
      companyId: 'tenant-a',
      secret,
      allowedOrigins: ['https://www.example.test'],
    }]);
  });

  it('rejects unsigned public inquiries before selecting or writing a tenant', async () => {
    const prisma: any = {
      company: { findFirst: jest.fn() },
      lead: { create: jest.fn() },
    };
    const service = new CommunicationsService(prisma, {} as any, {} as any);

    await expect(service.createWebsiteInquiry(
      { ...signedInquiry(), signature: '0'.repeat(64) },
      'https://www.example.test',
    )).rejects.toBeInstanceOf(ForbiddenException);
    expect(prisma.company.findFirst).not.toHaveBeenCalled();
    expect(prisma.lead.create).not.toHaveBeenCalled();
  });

  it('rejects an unknown public inquiry source', async () => {
    const prisma: any = { company: { findFirst: jest.fn() } };
    const service = new CommunicationsService(prisma, {} as any, {} as any);

    await expect(service.createWebsiteInquiry(
      signedInquiry({ sourceKey: 'unknown-source' }),
      'https://www.example.test',
    )).rejects.toBeInstanceOf(ForbiddenException);
    expect(prisma.company.findFirst).not.toHaveBeenCalled();
  });

  it('rejects a valid signature from the wrong Origin', async () => {
    const prisma: any = { company: { findFirst: jest.fn() } };
    const service = new CommunicationsService(prisma, {} as any, {} as any);

    await expect(service.createWebsiteInquiry(
      signedInquiry(),
      'https://evil.example',
    )).rejects.toBeInstanceOf(ForbiddenException);
    expect(prisma.company.findFirst).not.toHaveBeenCalled();
  });

  it('rejects newline field re-segmentation under the v2 canonical format', async () => {
    const prisma: any = { company: { findFirst: jest.fn() } };
    const service = new CommunicationsService(prisma, {} as any, {} as any);
    const signed = signedInquiry({
      source: 'contact\nBuyer',
      contactName: 'Name',
    });
    signed.source = 'contact';
    signed.contactName = 'Buyer\nName';

    await expect(service.createWebsiteInquiry(
      signed,
      'https://www.example.test',
    )).rejects.toThrow('Untrusted website inquiry request');
    expect(prisma.company.findFirst).not.toHaveBeenCalled();
  });

  it.each([
    ['expired', -301],
    ['future', 301],
  ])('rejects a %s inquiry timestamp', async (_label, offsetSeconds) => {
    const prisma: any = { company: { findFirst: jest.fn() } };
    const service = new CommunicationsService(prisma, {} as any, {} as any);

    await expect(service.createWebsiteInquiry(
      signedInquiry({
        timestamp: Math.floor(Date.now() / 1000) + offsetSeconds,
      }),
      'https://www.example.test',
    )).rejects.toThrow('Website inquiry signature has expired');
    expect(prisma.company.findFirst).not.toHaveBeenCalled();
  });

  it('binds a signed inquiry to its configured tenant and returns no lead data', async () => {
    const prisma: any = {
      company: {
        findFirst: jest.fn().mockResolvedValue({ id: 'tenant-a' }),
      },
      publicRequestNonce: {
        deleteMany: jest.fn(),
        create: jest.fn(),
      },
      contactPoint: {
        findFirst: jest.fn().mockResolvedValue({
          id: 'email-point',
          leadId: 'lead-a',
        }),
        create: jest.fn(),
        update: jest.fn(),
      },
      lead: {
        findFirst: jest.fn().mockResolvedValue({
          id: 'lead-a',
          companyId: 'tenant-a',
        }),
        create: jest.fn(),
      },
      conversation: {
        create: jest.fn().mockResolvedValue({ id: 'conversation-a' }),
      },
      communicationMessage: {
        create: jest.fn().mockResolvedValue({ id: 'message-a' }),
      },
      leadActivity: { create: jest.fn() },
    };
    const service = new CommunicationsService(prisma, {} as any, {} as any);

    const result = await service.createWebsiteInquiry(
      signedInquiry(),
      'https://www.example.test/path',
    );

    expect(result).toEqual({ accepted: true });
    expect(prisma.company.findFirst).toHaveBeenCalledWith({
      where: { id: 'tenant-a', isActive: true },
      select: { id: true },
    });
    expect(result).not.toHaveProperty('lead');
    expect(result).not.toHaveProperty('companyName');
  });

  it('rejects a replayed nonce through two real verification attempts', async () => {
    const nonces = new Set<string>();
    const prisma: any = {
      company: {
        findFirst: jest.fn().mockResolvedValue({ id: 'tenant-a' }),
      },
      publicRequestNonce: {
        deleteMany: jest.fn(),
        create: jest.fn(async ({ data }: any) => {
          const key = `${data.sourceKey}:${data.nonce}`;
          if (nonces.has(key)) {
            throw Object.assign(new Error('unique nonce'), { code: 'P2002' });
          }
          nonces.add(key);
          return { id: key };
        }),
      },
      contactPoint: {
        findFirst: jest.fn().mockResolvedValue({
          id: 'email-point',
          leadId: 'lead-a',
        }),
        create: jest.fn(),
        update: jest.fn(),
      },
      lead: {
        findFirst: jest.fn().mockResolvedValue({
          id: 'lead-a',
          companyId: 'tenant-a',
        }),
      },
      conversation: {
        create: jest.fn().mockResolvedValue({ id: 'conversation-a' }),
      },
      communicationMessage: {
        create: jest.fn().mockResolvedValue({ id: 'message-a' }),
      },
      leadActivity: { create: jest.fn() },
    };
    const service = new CommunicationsService(prisma, {} as any, {} as any);
    const inquiry = signedInquiry();

    await expect(service.createWebsiteInquiry(
      inquiry,
      'https://www.example.test',
    )).resolves.toEqual({ accepted: true });
    await expect(service.createWebsiteInquiry(
      inquiry,
      'https://www.example.test',
    )).rejects.toThrow('Duplicate website inquiry request');
    expect(nonces.size).toBe(1);
  });

  it('does not create a conversation for a foreign lead id', async () => {
    const prisma: any = {
      lead: { findFirst: jest.fn().mockResolvedValue(null) },
      conversation: { findFirst: jest.fn() },
      $transaction: jest.fn(),
    };
    const service = new CommunicationsService(withMembership(prisma, 'sales_user'), {} as any, {} as any);

    await expect(service.createConversation(
      { leadId: 'tenant-b-lead', channel: 'email' },
      tenantUser(),
    )).rejects.toBeInstanceOf(NotFoundException);
    expect(prisma.lead.findFirst).toHaveBeenCalledWith({
      where: {
        id: 'tenant-b-lead',
        companyId: 'tenant-a',
        deletedAt: null,
      },
      select: { id: true, ownerUserId: true },
    });
    expect(prisma.conversation.findFirst).not.toHaveBeenCalled();
  });

  it('does not let a viewer create a conversation', async () => {
    const prisma: any = {
      lead: { findFirst: jest.fn() },
      conversation: { create: jest.fn() },
    };
    const service = new CommunicationsService(withMembership(prisma, 'viewer'), {} as any, {} as any);

    await expect(service.createConversation(
      { channel: 'email' },
      tenantUser('viewer'),
    )).rejects.toBeInstanceOf(ForbiddenException);
    expect(prisma.lead.findFirst).not.toHaveBeenCalled();
    expect(prisma.conversation.create).not.toHaveBeenCalled();
  });

  it.each([
    ['cross-tenant membership', { companyId: 'tenant-b' }],
    ['inactive company', { companyActive: false }],
    ['inactive membership', { isActive: false }],
  ])(
    'rejects an actor with %s before reading conversations',
    async (_label: string, overrides: Partial<MembershipFixture>) => {
      const prisma: any = {
        conversation: {
          findMany: jest.fn(),
          count: jest.fn(),
        },
      };
      const user = tenantUser('company_admin');
      const service = new CommunicationsService(
        withMembership(prisma, user, overrides),
        {} as any,
        {} as any,
      );

      await expect(service.findConversations({}, user)).rejects.toBeInstanceOf(ForbiddenException);
      expect(prisma.conversation.findMany).not.toHaveBeenCalled();
      expect(prisma.conversation.count).not.toHaveBeenCalled();
    },
  );

  it.each(['sales_user', 'sales_manager'])(
    'does not let isolated role %s create a conversation for another owner lead',
    async (role) => {
      const prisma: any = {
        lead: {
          findFirst: jest.fn().mockResolvedValue({
            id: 'other-lead',
            ownerUserId: 'other-sales',
          }),
        },
        conversation: { create: jest.fn() },
      };
      const service = new CommunicationsService(withMembership(prisma, role), {} as any, {} as any);

      await expect(service.createConversation(
        { channel: 'email', leadId: 'other-lead' },
        tenantUser(role),
      )).rejects.toBeInstanceOf(ForbiddenException);
      expect(prisma.conversation.create).not.toHaveBeenCalled();
    },
  );

  it.each(['sales_user', 'sales_manager', 'viewer'])(
    'scopes %s conversation lists to the current assignee',
    async (role) => {
      const prisma: any = {
        conversation: {
          findMany: jest.fn().mockResolvedValue([]),
          count: jest.fn().mockResolvedValue(0),
        },
      };
      const service = new CommunicationsService(withMembership(prisma, role), {} as any, {} as any);

      await service.findConversations({}, tenantUser(role));

      expect(prisma.conversation.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
          where: expect.objectContaining({
            companyId: 'tenant-a',
            assignedUserId: 'user-a',
          }),
        }),
      );
      expect(prisma.conversation.count).toHaveBeenCalledWith({
        where: expect.objectContaining({
          companyId: 'tenant-a',
          assignedUserId: 'user-a',
        }),
      });
    },
  );

  it('does not return another salesperson conversation detail', async () => {
    const prisma: any = {
      conversation: { findFirst: jest.fn().mockResolvedValue(null) },
    };
    const service = new CommunicationsService(withMembership(prisma, 'sales_user'), {} as any, {} as any);

    await expect(service.findConversation(
      'other-conversation',
      tenantUser('sales_user'),
    )).rejects.toBeInstanceOf(NotFoundException);
    expect(prisma.conversation.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          id: 'other-conversation',
          companyId: 'tenant-a',
          assignedUserId: 'user-a',
        }),
      }),
    );
  });

  it('filters a deep-link list by every supplied identity dimension', async () => {
    const prisma: any = {
      conversation: {
        findMany: jest.fn().mockResolvedValue([]),
        count: jest.fn().mockResolvedValue(0),
      },
    };
    const securedPrisma = withMembership(prisma, tenantUser('company_admin'));
    const service = new CommunicationsService(
      securedPrisma,
      {} as any,
      {} as any,
    );

    await service.findConversations({
      leadId: 'lead-target',
      phone: '+86 138 0000 1234',
      channel: 'whatsapp',
      sessionId: 'session-target',
    }, tenantUser('company_admin'));

    const where = prisma.conversation.findMany.mock.calls[0][0].where;
    expect(where).toEqual(expect.objectContaining({
      companyId: 'tenant-a',
      leadId: 'lead-target',
      channel: 'whatsapp',
      whatsappSessionId: 'session-target',
    }));
    expect(where.AND).toContainEqual({
      OR: [
        { contactPoint: { is: { normalizedValue: '+8613800001234' } } },
        { lead: { is: { contactPhone: '+8613800001234' } } },
        { lead: { is: { whatsapp: '+8613800001234' } } },
      ],
    });
  });

  it('fails closed for an invalid phone filter instead of falling back to the lead list', async () => {
    const prisma: any = {
      conversation: {
        findMany: jest.fn().mockResolvedValue([]),
        count: jest.fn().mockResolvedValue(0),
      },
    };
    const service = new CommunicationsService(
      withMembership(prisma, tenantUser('company_admin')),
      {} as any,
      {} as any,
    );

    await service.findConversations({ leadId: 'lead-target', phone: 'not-a-phone' }, tenantUser('company_admin'));

    expect(prisma.conversation.findMany.mock.calls[0][0].where.AND).toContainEqual({
      id: '__no_matching_conversation__',
    });
  });

  it('applies all supplied identity dimensions to a session detail lookup', async () => {
    const prisma: any = {
      conversation: { findFirst: jest.fn().mockResolvedValue(null) },
    };
    const service = new CommunicationsService(
      withMembership(prisma, tenantUser('company_admin')),
      {} as any,
      {} as any,
    );

    await expect(service.findConversation('session-conversation', tenantUser('company_admin'), {
      leadId: 'lead-target',
      phone: '+8613800001234',
      channel: 'whatsapp',
      sessionId: 'session-target',
    })).rejects.toBeInstanceOf(NotFoundException);

    const where = prisma.conversation.findFirst.mock.calls[0][0].where;
    expect(where).toEqual(expect.objectContaining({
      id: 'session-conversation',
      companyId: 'tenant-a',
      leadId: 'lead-target',
      channel: 'whatsapp',
      whatsappSessionId: 'session-target',
    }));
    expect(where.AND).toContainEqual(expect.objectContaining({
      OR: expect.arrayContaining([
        { contactPoint: { is: { normalizedValue: '+8613800001234' } } },
      ]),
    }));
  });

  it('does not let a salesperson send to another assignee conversation', async () => {
    const prisma: any = {
      conversation: {
        findFirst: jest.fn().mockResolvedValue(null),
        updateMany: jest.fn(),
      },
      communicationMessage: { create: jest.fn() },
    };
    const whatsapp: any = {
      sendTextOnly: jest.fn(),
      sendMediaOnly: jest.fn(),
    };
    const service = new CommunicationsService(withMembership(prisma, 'sales_user'), whatsapp, {} as any);

    await expect(service.addMessage(
      'other-conversation',
      { direction: 'outbound', content: 'send' },
      tenantUser('sales_user'),
    )).rejects.toBeInstanceOf(NotFoundException);
    expect(prisma.conversation.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          id: 'other-conversation',
          companyId: 'tenant-a',
          assignedUserId: 'user-a',
        }),
      }),
    );
    expect(whatsapp.sendTextOnly).not.toHaveBeenCalled();
    expect(prisma.communicationMessage.create).not.toHaveBeenCalled();
  });

  it('does not let a viewer write outbound messages', async () => {
    const prisma: any = {
      conversation: { findFirst: jest.fn() },
      communicationMessage: { create: jest.fn() },
    };
    const service = new CommunicationsService(withMembership(prisma, 'viewer'), {} as any, {} as any);

    await expect(service.addMessage(
      'conversation-a',
      { direction: 'outbound', content: 'send' },
      tenantUser('viewer'),
    )).rejects.toBeInstanceOf(ForbiddenException);
    expect(prisma.conversation.findFirst).not.toHaveBeenCalled();
    expect(prisma.communicationMessage.create).not.toHaveBeenCalled();
  });

  it('does not let a viewer persist an uploaded attachment', async () => {
    const prisma: any = {
    };
    const service = new CommunicationsService(
      withMembership(prisma, tenantUser('viewer')),
      {} as any,
      {} as any,
    );
    await expect(service.uploadAttachment(
      {} as Express.Multer.File,
      tenantUser('viewer'),
    )).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('does not let a viewer change conversation status', async () => {
    const prisma: any = {
      conversation: {
        updateMany: jest.fn(),
        findFirst: jest.fn().mockResolvedValue({ id: 'conversation-a' }),
      },
    };
    const service = new CommunicationsService(withMembership(prisma, 'viewer'), {} as any, {} as any);

    await expect(service.updateConversationStatus(
      'conversation-a',
      'closed',
      tenantUser('viewer'),
    )).rejects.toBeInstanceOf(ForbiddenException);
    expect(prisma.conversation.updateMany).not.toHaveBeenCalled();
  });

  it('does not change the status of a conversation in another tenant', async () => {
    const prisma: any = {
      conversation: {
        updateMany: jest.fn().mockResolvedValue({ count: 0 }),
        findFirst: jest.fn(),
      },
    };
    const service = new CommunicationsService(withMembership(prisma, 'sales_user'), {} as any, {} as any);

    await expect(service.updateConversationStatus(
      'tenant-b-conversation',
      'archived',
      tenantUser('sales_user'),
    )).rejects.toBeInstanceOf(NotFoundException);
    expect(prisma.conversation.findFirst).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({
        id: 'tenant-b-conversation',
        companyId: 'tenant-a',
        assignedUserId: 'user-a',
      }),
    }));
    expect(prisma.conversation.updateMany).not.toHaveBeenCalled();
  });

  it('binds personal read updates to the active tenant', async () => {
    const prisma: any = {
      conversation: {
        findFirst: jest.fn().mockResolvedValue({ id: 'conversation-a' }),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      communicationMessage: {
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
    };
    const service = new CommunicationsService(withMembership(prisma, 'viewer'), {} as any, {} as any);

    await expect(service.markConversationRead(
      'conversation-a',
      tenantUser('viewer'),
    )).resolves.toEqual({ success: true });
    expect(prisma.conversation.findFirst).toHaveBeenCalledWith({
      where: expect.objectContaining({
        id: 'conversation-a',
        companyId: 'tenant-a',
        assignedUserId: 'user-a',
      }),
      select: { id: true },
    });
    expect(prisma.communicationMessage.updateMany).toHaveBeenCalledWith({
      where: {
        conversationId: 'conversation-a',
        conversation: expect.objectContaining({
          companyId: 'tenant-a',
          assignedUserId: 'user-a',
        }),
        direction: 'inbound',
        readAt: null,
      },
      data: { readAt: expect.any(Date) },
    });
    expect(prisma.conversation.updateMany).toHaveBeenCalledWith({
      where: expect.objectContaining({
        id: 'conversation-a',
        companyId: 'tenant-a',
        assignedUserId: 'user-a',
      }),
      data: { unreadCount: 0 },
    });
  });

  it('does not mark another salesperson conversation as read', async () => {
    const prisma: any = {
      conversation: {
        findFirst: jest.fn().mockResolvedValue(null),
        updateMany: jest.fn(),
      },
      communicationMessage: { updateMany: jest.fn() },
    };
    const service = new CommunicationsService(withMembership(prisma, 'sales_user'), {} as any, {} as any);

    await expect(service.markConversationRead(
      'other-sales-conversation',
      tenantUser('sales_user'),
    )).rejects.toBeInstanceOf(NotFoundException);
    expect(prisma.conversation.findFirst).toHaveBeenCalledWith({
      where: expect.objectContaining({
        id: 'other-sales-conversation',
        companyId: 'tenant-a',
        assignedUserId: 'user-a',
      }),
      select: { id: true },
    });
    expect(prisma.communicationMessage.updateMany).not.toHaveBeenCalled();
    expect(prisma.conversation.updateMany).not.toHaveBeenCalled();
  });

  it('does not assign a conversation to a user outside the active tenant', async () => {
    const prisma: any = {
      conversation: {
        findFirst: jest.fn().mockResolvedValue({
          id: 'conversation-a',
          companyId: 'tenant-a',
        }),
        updateMany: jest.fn(),
      },
    };
    const securedPrisma = withMembership(prisma, tenantUser('company_admin'));
    const service = new CommunicationsService(
      securedPrisma,
      {} as any,
      {} as any,
    );

    await expect(service.assignConversation(
      'conversation-a',
      'tenant-b-user',
      tenantUser('company_admin'),
    )).rejects.toBeInstanceOf(BadRequestException);
    expect(securedPrisma.userCompanyRelation.findFirst).toHaveBeenNthCalledWith(2, expect.objectContaining({
      where: expect.objectContaining({
        userId: 'tenant-b-user',
        companyId: 'tenant-a',
        isActive: true,
        user: { is: expect.objectContaining({ isActive: true, deletedAt: null }) },
      }),
      select: { id: true },
    }));
    expect(prisma.conversation.updateMany).not.toHaveBeenCalled();
  });
});
