import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { MailWorkbenchService } from './mail-workbench.service';

describe('MailWorkbenchService real inbound mailbox', () => {
  const prisma = {
    communicationMessage: {
      findMany: jest.fn(),
      findUnique: jest.fn(),
      findFirst: jest.fn(),
      count: jest.fn(),
      updateMany: jest.fn(),
    },
    emailMessage: {
      findMany: jest.fn(),
      findUnique: jest.fn(),
      count: jest.fn(),
    },
    emailAccount: {
      findMany: jest.fn(),
      findFirst: jest.fn(),
    },
    conversation: {
      update: jest.fn(),
    },
    $transaction: jest.fn(async (callback: any) => callback(prisma)),
  } as any;
  const ai = { chat: jest.fn() } as any;
  const languageService = { getLanguageName: jest.fn() } as any;
  const user = {
    id: 'operator-1',
    activeCompanyId: 'company-1',
    activeCompany: { id: 'company-1', name: 'company-1', role: 'sales_user' },
    companies: [{ id: 'company-1', name: 'company-1', role: 'sales_user' }],
  };
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
      sourceAccountId: 'account-1',
      isStarred: true,
      isArchived: false,
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
          isArchived: false,
          deletedAt: null,
          conversation: expect.objectContaining({
            companyId: 'company-1',
            channel: 'business_email',
            OR: [
              { assignedUserId: 'operator-1' },
              { lead: { ownerUserId: 'operator-1' } },
            ],
          }),
        }),
      }),
    );
    expect(result).toMatchObject({
      data: [{ id: 'inbound:message-1', status: 'Received', leadId: 'lead-1', accountId: 'account-1', isStarred: true, isArchived: false }],
      meta: { total: 1 },
    });
  });

  it('rejects opening an inbound message owned by another company', async () => {
    prisma.communicationMessage.findFirst.mockResolvedValue(null);

    await expect(service.getMessage('inbound:message-2', user))
      .rejects.toBeInstanceOf(NotFoundException);
    expect(prisma.communicationMessage.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          id: 'message-2',
          conversation: {
            companyId: 'company-1',
            OR: [
              { assignedUserId: 'operator-1' },
              { lead: { ownerUserId: 'operator-1' } },
            ],
          },
        },
      }),
    );
  });

  it('applies the same owner boundary to folder tree and summary counts', async () => {
    prisma.communicationMessage.count.mockResolvedValue(0);
    prisma.emailMessage.count.mockResolvedValue(0);
    prisma.emailAccount.findMany.mockResolvedValue([]);

    await service.getTree(user);
    await service.getSummary(user);

    expect(prisma.emailMessage.count).toHaveBeenCalledWith({
      where: expect.objectContaining({
        companyId: 'company-1',
        senderUserId: 'operator-1',
      }),
    });
    expect(prisma.communicationMessage.count).toHaveBeenCalledWith({
      where: expect.objectContaining({
        conversation: expect.objectContaining({
          companyId: 'company-1',
          OR: [
            { assignedUserId: 'operator-1' },
            { lead: { ownerUserId: 'operator-1' } },
          ],
        }),
      }),
    });
  });

  describe('tree account dimension (R111 批次B)', () => {
    it('groups the aggregate tree by IMAP-configured accounts and exposes uncategorized', async () => {
      prisma.communicationMessage.count.mockResolvedValue(0);
      prisma.emailMessage.count.mockResolvedValue(0);
      prisma.emailAccount.findMany.mockResolvedValue([
        { id: 'a1', senderEmail: 'sales@example.com', inboundEnabled: true },
      ]);

      const result = await service.getTree(user);

      expect(prisma.emailAccount.findMany).toHaveBeenCalledWith(expect.objectContaining({
        where: { companyId: 'company-1', status: 'active', imapHost: { not: null }, imapUsername: { not: null } },
      }));
      expect(result).toMatchObject({
        folders: [{ id: 'inbox' }, { id: 'sent' }, { id: 'drafts' }, { id: 'starred' }],
        accounts: [{ id: 'a1', address: 'sales@example.com', enabled: true }],
        uncategorized: { id: 'uncategorized', count: 0 },
      });
    });

    it('scopes the folder tree to a single account when accountId is passed', async () => {
      prisma.emailAccount.findFirst.mockResolvedValue({ id: 'account-1', senderEmail: 'sales@example.com', inboundEnabled: true });
      prisma.communicationMessage.count.mockResolvedValue(3);
      prisma.emailMessage.count.mockResolvedValue(2);

      const result = await service.getTree(user, 'account-1');

      expect(prisma.emailAccount.findFirst).toHaveBeenCalledWith({
        where: { id: 'account-1', companyId: 'company-1' },
        select: { id: true, senderEmail: true, inboundEnabled: true },
      });
      expect(prisma.communicationMessage.count).toHaveBeenCalledWith(expect.objectContaining({
        where: expect.objectContaining({ sourceAccountId: 'account-1', isArchived: false, deletedAt: null }),
      }));
      expect(result).toMatchObject({
        account: { id: 'account-1', address: 'sales@example.com', enabled: true },
        folders: [
          { id: 'inbox', count: 3 },
          { id: 'sent', count: 2 },
          { id: 'drafts', count: 2 },
          { id: 'starred', count: 3 },
        ],
      });
    });

    it('rejects an accountId outside the current company', async () => {
      prisma.emailAccount.findFirst.mockResolvedValue(null);

      await expect(service.getTree(user, 'foreign-account')).rejects.toBeInstanceOf(NotFoundException);
      await expect(service.getMessages(user, { folder: 'inbox', accountId: 'foreign-account' })).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe('messages accountId filter (R111 批次B)', () => {
    it('filters inbound messages by sourceAccountId and by uncategorized (null)', async () => {
      prisma.communicationMessage.findMany.mockResolvedValue([]);
      prisma.communicationMessage.count.mockResolvedValue(0);
      prisma.emailAccount.findFirst.mockResolvedValue({ id: 'account-1' });

      await service.getMessages(user, { folder: 'inbox', accountId: 'account-1' });
      expect(prisma.communicationMessage.findMany).toHaveBeenLastCalledWith(expect.objectContaining({
        where: expect.objectContaining({ sourceAccountId: 'account-1' }),
      }));

      await service.getMessages(user, { folder: 'inbox', accountId: 'uncategorized' });
      expect(prisma.communicationMessage.findMany).toHaveBeenLastCalledWith(expect.objectContaining({
        where: expect.objectContaining({ sourceAccountId: null }),
      }));
    });

    it('supports the starred folder over inbound messages', async () => {
      prisma.communicationMessage.findMany.mockResolvedValue([]);
      prisma.communicationMessage.count.mockResolvedValue(0);

      await service.getMessages(user, { folder: 'starred' });

      expect(prisma.communicationMessage.findMany).toHaveBeenCalledWith(expect.objectContaining({
        where: expect.objectContaining({ direction: 'inbound', isStarred: true, isArchived: false, deletedAt: null }),
      }));
    });
  });

  describe('batch update (R111 批次B)', () => {
    it('rejects empty ids and invalid actions', async () => {
      await expect(service.batchUpdate(user, { ids: [], action: 'archive' })).rejects.toBeInstanceOf(BadRequestException);
      await expect(service.batchUpdate(user, { ids: [''], action: 'archive' })).rejects.toBeInstanceOf(BadRequestException);
      await expect(service.batchUpdate(user, { ids: ['m1'], action: 'explode' })).rejects.toBeInstanceOf(BadRequestException);
      expect(prisma.communicationMessage.findMany).not.toHaveBeenCalled();
    });

    it('rejects cross-tenant ids (越权防护)', async () => {
      // 请求 2 个 id，只查到 1 个属于本公司 → 整体拒绝
      prisma.communicationMessage.findMany.mockResolvedValue([{ id: 'm1', conversationId: 'c1' }]);

      await expect(service.batchUpdate(user, { ids: ['m1', 'm2'], action: 'archive' }))
        .rejects.toBeInstanceOf(ForbiddenException);
      expect(prisma.communicationMessage.findMany).toHaveBeenCalledWith(expect.objectContaining({
        where: expect.objectContaining({
          id: { in: ['m1', 'm2'] },
          direction: 'inbound',
          conversation: expect.objectContaining({ companyId: 'company-1', channel: 'business_email' }),
        }),
      }));
    });

    it('archives messages in a transaction and is idempotent', async () => {
      prisma.communicationMessage.findMany.mockResolvedValue([
        { id: 'm1', conversationId: 'c1' },
        { id: 'm2', conversationId: 'c1' },
      ]);
      const updateMany = jest.fn(async () => ({ count: 2 }));
      prisma.$transaction = jest.fn(async (cb: any) => cb({
        communicationMessage: { updateMany, count: jest.fn() },
        conversation: { update: jest.fn() },
      }));

      const first = await service.batchUpdate(user, { ids: ['m1', 'm2'], action: 'archive' });
      expect(first).toEqual({ updated: 2 });
      expect(updateMany).toHaveBeenCalledWith({
        where: { id: { in: ['m1', 'm2'] }, isArchived: false },
        data: { isArchived: true },
      });

      // 幂等：再次归档（已全部归档）不再计数
      updateMany.mockResolvedValue({ count: 0 });
      const second = await service.batchUpdate(user, { ids: ['m1', 'm2'], action: 'archive' });
      expect(second).toEqual({ updated: 0 });
    });

    it('recomputes conversation unreadCount on mark_read', async () => {
      prisma.communicationMessage.findMany.mockResolvedValue([
        { id: 'm1', conversationId: 'c1' },
        { id: 'm2', conversationId: 'c1' },
      ]);
      const updateMany = jest.fn(async () => ({ count: 2 }));
      const count = jest.fn().mockResolvedValue(0);
      const convUpdate = jest.fn(async () => ({}));
      prisma.$transaction = jest.fn(async (cb: any) => cb({
        communicationMessage: { updateMany, count },
        conversation: { update: convUpdate },
      }));

      await service.batchUpdate(user, { ids: ['m1', 'm2'], action: 'mark_read' });

      expect(updateMany).toHaveBeenCalledWith({
        where: { id: { in: ['m1', 'm2'] }, readAt: null },
        data: { readAt: expect.any(Date) },
      });
      expect(count).toHaveBeenCalledWith({
        where: { conversationId: 'c1', direction: 'inbound', readAt: null, deletedAt: null },
      });
      expect(convUpdate).toHaveBeenCalledWith({ where: { id: 'c1' }, data: { unreadCount: 0 } });
    });
  });
});
