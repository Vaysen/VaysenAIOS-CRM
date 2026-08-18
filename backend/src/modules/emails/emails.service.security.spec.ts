import {
  ConflictException,
  ForbiddenException,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { EmailsController } from './emails.controller';
import { EmailsService } from './emails.service';

describe('EmailsService tenant, owner, and resend boundaries', () => {
  const salesUser = {
    id: 'sales-a',
    activeCompanyId: 'company-a',
    activeCompany: {
      id: 'company-a',
      name: 'Company A',
      role: 'sales_user',
      website: 'https://company-a.example',
    },
    companies: [
      { id: 'company-a', role: 'sales_user' },
      { id: 'company-b', role: 'company_admin' },
    ],
  };
  const adminUser = {
    id: 'admin-a',
    activeCompanyId: 'company-a',
    activeCompany: {
      id: 'company-a',
      name: 'Company A',
      role: 'company_admin',
      website: 'https://company-a.example',
    },
    companies: [{ id: 'company-a', role: 'company_admin' }],
  };

  function resendMessage(overrides: Record<string, unknown> = {}) {
    return {
      id: 'email-1',
      companyId: 'company-a',
      leadId: 'lead-a',
      emailAccountId: 'account-a',
      senderUserId: 'sales-a',
      status: 'Failed',
      subject: 'Packaging quotation follow-up',
      bodyHtml: '<p>Your packaging quotation is ready.</p>',
      renderedBody: '<p>Previously rendered body.</p>',
      trackingId: 'old-tracking-id',
      unsubscribeToken: 'old-unsubscribe-token',
      retryCount: 0,
      failedAt: new Date('2026-07-28T00:00:00.000Z'),
      failedReason: 'temporary failure',
      errorMessage: 'temporary failure',
      lead: {
        id: 'lead-a',
        companyId: 'company-a',
        ownerUserId: 'sales-a',
        contactEmail: 'buyer@customer.example',
        status: 'contacted',
        reviewStatus: 'approved',
        emailVerificationStatus: 'smtp_verified',
      },
      emailAccount: {
        id: 'account-a',
        companyId: 'company-a',
        userId: 'sales-a',
        status: 'active',
        dailySentCount: 0,
        dailySendLimit: 100,
        hourlySentCount: 0,
        hourlySendLimit: 20,
      },
      ...overrides,
    };
  }

  function harness() {
    const prisma: any = {
      emailMessage: {
        count: jest.fn().mockResolvedValue(0),
        groupBy: jest.fn().mockResolvedValue([]),
        findFirst: jest.fn(),
        findMany: jest.fn().mockResolvedValue([]),
        updateMany: jest.fn(),
      },
      user: { findMany: jest.fn().mockResolvedValue([]) },
      userCompanyRelation: { findMany: jest.fn().mockResolvedValue([]) },
      searchTask: { findMany: jest.fn().mockResolvedValue([]) },
      unsubscribeRecord: { findFirst: jest.fn().mockResolvedValue(null) },
      blacklistRecord: { findFirst: jest.fn().mockResolvedValue(null) },
    };
    const composeQueue = { add: jest.fn() };
    const validateQueue = {
      add: jest.fn().mockResolvedValue({ id: 'job-1' }),
      getJob: jest.fn().mockResolvedValue(null),
    };
    const outbound = {
      assertEmailAccountAccess: jest.fn().mockResolvedValue({
        id: 'account-a',
        companyId: 'company-a',
      }),
    };
    const service = new EmailsService(
      prisma,
      { ingest: jest.fn() } as any,
      composeQueue as any,
      validateQueue as any,
      outbound as any,
      { assertMarketingRole: jest.fn() } as any,
    );
    return {
      prisma,
      composeQueue,
      validateQueue,
      outbound,
      service,
    };
  }

  it('passes the authenticated user from the queue-status controller entry', async () => {
    const emailsService = {
      getQueueStatus: jest.fn().mockResolvedValue({ data: { queued: 0 } }),
    };
    const controller = new EmailsController(emailsService as any);

    await controller.getQueueStatus(salesUser);

    expect(emailsService.getQueueStatus).toHaveBeenCalledWith(salesUser);
  });

  it('scopes every queue aggregate and user-name lookup to the active tenant and sales owner', async () => {
    const { prisma, service } = harness();
    prisma.emailMessage.groupBy.mockResolvedValue([
      { senderUserId: 'sales-a', _count: 2 },
    ]);

    await service.getQueueStatus(salesUser);

    expect(prisma.emailMessage.count).toHaveBeenCalledTimes(10);
    for (const [{ where }] of prisma.emailMessage.count.mock.calls) {
      expect(where).toEqual(expect.objectContaining({
        companyId: 'company-a',
        senderUserId: 'sales-a',
        deletedAt: null,
      }));
    }
    expect(prisma.emailMessage.groupBy).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          companyId: 'company-a',
          senderUserId: 'sales-a',
          deletedAt: null,
        }),
      }),
    );
    expect(prisma.user.findMany).toHaveBeenCalledWith({
      where: {
        id: { in: ['sales-a'] },
        isActive: true,
        deletedAt: null,
        companies: {
          some: {
            companyId: 'company-a',
            isActive: true,
            company: { is: { isActive: true } },
          },
        },
      },
      select: { id: true, firstName: true, lastName: true },
    });
  });

  it('allows an active-company administrator tenant-wide queue aggregates without crossing tenants', async () => {
    const { prisma, service } = harness();

    await service.getQueueStatus(adminUser);

    for (const [{ where }] of prisma.emailMessage.count.mock.calls) {
      expect(where.companyId).toBe('company-a');
      expect(where.deletedAt).toBeNull();
      expect(where).not.toHaveProperty('senderUserId');
    }
    const groupWhere = prisma.emailMessage.groupBy.mock.calls[0][0].where;
    expect(groupWhere.companyId).toBe('company-a');
    expect(groupWhere).not.toHaveProperty('senderUserId');
  });

  it('keeps team prospecting details inside the active company', async () => {
    const { prisma, service } = harness();
    prisma.userCompanyRelation.findMany.mockResolvedValue([{
      userId: 'sales-a',
      user: {
        id: 'sales-a',
        firstName: 'Sales',
        lastName: 'A',
        email: 'sales-a@example.com',
      },
      role: { name: 'sales_user' },
    }]);

    await service.getTeamStats(adminUser);

    expect(prisma.searchTask.findMany).toHaveBeenCalledWith({
      where: {
        companyId: 'company-a',
        createdBy: 'sales-a',
        status: { in: ['running', 'pending'] },
      },
      orderBy: { createdAt: 'desc' },
      take: 1,
      select: {
        status: true,
        targetCountry: true,
        keywords: true,
        totalFound: true,
      },
    });
  });

  it.each(['peer-email-id', 'foreign-email-id'])(
    'returns the same NotFound boundary for inaccessible detail %s',
    async (id) => {
      const { prisma, service } = harness();
      prisma.emailMessage.findFirst.mockResolvedValue(null);

      await expect(service.findOne(id, salesUser))
        .rejects.toBeInstanceOf(NotFoundException);

      expect(prisma.emailMessage.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({
          where: {
            id,
            companyId: 'company-a',
            senderUserId: 'sales-a',
            deletedAt: null,
          },
        }),
      );
    },
  );

  it('lets an administrator read only a detail in the active tenant', async () => {
    const { prisma, service } = harness();
    prisma.emailMessage.findFirst.mockResolvedValue({
      ...resendMessage(),
      senderUserId: 'sales-b',
    });

    await expect(service.findOne('email-1', adminUser))
      .resolves.toMatchObject({ id: 'email-1' });

    const where = prisma.emailMessage.findFirst.mock.calls[0][0].where;
    expect(where).toEqual({
      id: 'email-1',
      companyId: 'company-a',
      deletedAt: null,
    });
  });

  it('rejects a peer resend before account authorization, mutation, or enqueue', async () => {
    const { prisma, outbound, service, validateQueue } = harness();
    prisma.emailMessage.findFirst.mockResolvedValue(null);

    await expect(service.resend('peer-email-id', salesUser))
      .rejects.toBeInstanceOf(NotFoundException);

    expect(prisma.emailMessage.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          id: 'peer-email-id',
          companyId: 'company-a',
          senderUserId: 'sales-a',
          deletedAt: null,
        },
      }),
    );
    expect(outbound.assertEmailAccountAccess).not.toHaveBeenCalled();
    expect(prisma.emailMessage.updateMany).not.toHaveBeenCalled();
    expect(validateQueue.add).not.toHaveBeenCalled();
  });

  it('rejects an account assigned to another member before the resend CAS', async () => {
    const { prisma, outbound, service, validateQueue } = harness();
    prisma.emailMessage.findFirst.mockResolvedValue(resendMessage());
    outbound.assertEmailAccountAccess.mockRejectedValue(
      new ForbiddenException(
        'Email sender account is assigned to another tenant member',
      ),
    );

    await expect(service.resend('email-1', salesUser))
      .rejects.toBeInstanceOf(ForbiddenException);

    expect(outbound.assertEmailAccountAccess).toHaveBeenCalledWith(
      'company-a',
      'account-a',
      salesUser,
    );
    expect(prisma.emailMessage.updateMany).not.toHaveBeenCalled();
    expect(validateQueue.add).not.toHaveBeenCalled();
  });

  it('uses a tenant-owner-status CAS so concurrent resend attempts enqueue once', async () => {
    const { prisma, service, validateQueue } = harness();
    const loggerLog = jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    const loggerWarn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    prisma.emailMessage.findFirst.mockResolvedValue(resendMessage());
    prisma.emailMessage.updateMany
      .mockResolvedValueOnce({ count: 1 })
      .mockResolvedValueOnce({ count: 0 });

    const first = await service.resend('email-1', salesUser);
    expect(first).toMatchObject({ success: true, messageRef: expect.stringMatching(/^sha256:email-message:/) });
    expect(first).not.toHaveProperty('emailMessageId');
    await expect(service.resend('email-1', salesUser))
      .rejects.toBeInstanceOf(ConflictException);

    expect(validateQueue.add).toHaveBeenCalledTimes(1);
    expect(prisma.emailMessage.updateMany.mock.calls[0][0].where).toEqual({
      id: 'email-1',
      companyId: 'company-a',
      senderUserId: 'sales-a',
      deletedAt: null,
      status: { in: ['Failed', 'Bounced'] },
    });
    const output = JSON.stringify([
      ...loggerLog.mock.calls,
      ...loggerWarn.mock.calls,
    ]);
    expect(output).toContain('email.resend_queued');
    expect(output).toContain('email.resend_reservation_conflict');
    expect(output).not.toContain('email-1');
    expect(output).not.toContain('buyer@customer.example');
    expect(output).not.toContain('old-unsubscribe-token');
    expect(output).not.toContain('Packaging quotation follow-up');
    expect(output).not.toContain('Your packaging quotation is ready');
  });

  it('rolls back the exact resend reservation when enqueue definitively fails', async () => {
    const { prisma, service, validateQueue } = harness();
    const loggerWarn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const loggerError = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    const message = resendMessage();
    prisma.emailMessage.findFirst.mockResolvedValue(message);
    prisma.emailMessage.updateMany
      .mockResolvedValueOnce({ count: 1 })
      .mockResolvedValueOnce({ count: 1 });
    const providerError = 'redis-sentinel@example.com provider response https://redis.example/?token=secret';
    validateQueue.add.mockRejectedValue(new Error(providerError));
    validateQueue.getJob.mockResolvedValue(null);

    await expect(service.resend('email-1', salesUser))
      .rejects.toMatchObject({
        constructor: ServiceUnavailableException,
        response: expect.objectContaining({
          message: expect.stringMatching(/rolled back/i),
        }),
      });

    const rollback = prisma.emailMessage.updateMany.mock.calls[1][0];
    expect(rollback.where).toEqual({
      id: 'email-1',
      companyId: 'company-a',
      status: 'DraftReady',
      trackingId: expect.any(String),
    });
    expect(rollback.data).toEqual({
      trackingId: message.trackingId,
      unsubscribeToken: message.unsubscribeToken,
      renderedBody: message.renderedBody,
      bodyHtml: message.bodyHtml,
      status: message.status,
      retryCount: message.retryCount,
      failedAt: message.failedAt,
      failedReason: message.failedReason,
      errorMessage: message.errorMessage,
    });
    const output = JSON.stringify([
      ...loggerWarn.mock.calls,
      ...loggerError.mock.calls,
    ]);
    expect(output).toContain('email.resend_queue_write_failed');
    expect(output).toContain('email.resend_rolled_back');
    expect(output).not.toContain(providerError);
    expect(output).not.toContain('email-1');
    expect(output).not.toContain('buyer@customer.example');
  });

  it('recovers an ambiguous queue acknowledgement by deterministic job id without rollback', async () => {
    const { prisma, service, validateQueue } = harness();
    const loggerWarn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    prisma.emailMessage.findFirst.mockResolvedValue(resendMessage());
    prisma.emailMessage.updateMany.mockResolvedValue({ count: 1 });
    const providerError = 'queue-sentinel@example.com response https://queue.example/?token=secret';
    validateQueue.add.mockRejectedValue(new Error(providerError));
    validateQueue.getJob.mockResolvedValue({ id: 'accepted-job' });

    const result = await service.resend('email-1', salesUser);
    expect(result).toMatchObject({ success: true, messageRef: expect.stringMatching(/^sha256:email-message:/) });
    expect(result).not.toHaveProperty('emailMessageId');

    expect(validateQueue.getJob).toHaveBeenCalledWith(
      'email-resend-email-1-1',
    );
    expect(prisma.emailMessage.updateMany).toHaveBeenCalledTimes(1);
    const output = JSON.stringify(loggerWarn.mock.calls);
    expect(output).toContain('email.resend_queue_ack_recovered');
    expect(output).not.toContain(providerError);
    expect(output).not.toContain('email-1');
  });

  it('keeps an unknown queue outcome stable and redacts lookup errors', async () => {
    const { prisma, service, validateQueue } = harness();
    const loggerWarn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const loggerError = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    const providerError = 'lookup-sentinel@example.com response https://queue.example/?token=secret';
    prisma.emailMessage.findFirst.mockResolvedValue(resendMessage());
    prisma.emailMessage.updateMany.mockResolvedValue({ count: 1 });
    validateQueue.add.mockRejectedValue(new Error('queue write failed'));
    validateQueue.getJob.mockRejectedValue({
      message: providerError,
      response: { data: providerError },
      cause: providerError,
    });

    await expect(service.resend('email-1', salesUser))
      .rejects.toMatchObject({
        constructor: ServiceUnavailableException,
        response: expect.objectContaining({
          message: expect.stringMatching(/outcome is unknown/i),
        }),
      });
    expect(prisma.emailMessage.updateMany).toHaveBeenCalledTimes(1);
    const output = JSON.stringify([
      ...loggerWarn.mock.calls,
      ...loggerError.mock.calls,
    ]);
    expect(output).toContain('email.resend_queue_outcome_unknown');
    expect(output).not.toContain(providerError);
    expect(output).not.toContain('email-1');
  });
});
