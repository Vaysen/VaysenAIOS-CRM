import { ForbiddenException } from '@nestjs/common';
import { EmailsService } from './emails.service';

describe('EmailsService outbound sender-account gate', () => {
  function harness() {
    const prisma: any = {
      lead: {
        findFirst: jest.fn().mockResolvedValue({
          id: 'lead-1',
          companyId: 'company-1',
          ownerUserId: 'sales-1',
          deletedAt: null,
        }),
        findUnique: jest.fn().mockResolvedValue({
          id: 'lead-1',
          companyId: 'company-1',
          ownerUserId: 'sales-1',
          deletedAt: null,
        }),
      },
      emailAccount: {
        findFirst: jest.fn().mockResolvedValue({
          id: 'account-1',
          companyId: 'company-1',
          userId: 'sales-2',
        }),
        findUnique: jest.fn().mockResolvedValue({
          id: 'account-1',
          companyId: 'company-1',
          userId: 'sales-2',
        }),
      },
      emailTemplate: {
        findFirst: jest.fn().mockResolvedValue({
          id: 'template-1',
          companyId: 'company-1',
          createdBy: 'sales-1',
          variables: [],
        }),
        findUnique: jest.fn().mockResolvedValue({
          id: 'template-1',
          companyId: 'company-1',
          createdBy: 'sales-1',
          variables: [],
        }),
      },
      emailDispatchRequest: {
        findUnique: jest.fn().mockResolvedValue(null),
      },
    };
    const composeQueue = { add: jest.fn() };
    const validateQueue = { add: jest.fn() };
    const outbound = {
      assertEmailAccountAccess: jest.fn().mockRejectedValue(
        new ForbiddenException('Email sender account is assigned to another tenant member'),
      ),
    };
    const service = new EmailsService(
      prisma,
      { ingest: jest.fn() } as any,
      composeQueue as any,
      validateQueue as any,
      outbound as any,
      { assertMarketingRole: jest.fn() } as any,
    );
    const user = {
      id: 'sales-1',
      activeCompanyId: 'company-1',
      activeCompany: { id: 'company-1', role: 'sales_user' },
      companies: [{ id: 'company-1', role: 'sales_user' }],
    };
    return { service, outbound, composeQueue, validateQueue, user };
  }

  it.each([
    ['single', (service: EmailsService, user: any) => service.sendSingle({
      leadId: 'lead-1',
      emailAccountId: 'account-1',
      emailTemplateId: 'template-1',
    } as any, user, 'outbound-access-single-key')],
    ['batch', (service: EmailsService, user: any) => service.sendBatch({
      leadIds: ['lead-1'],
      emailAccountId: 'account-1',
      emailTemplateId: 'template-1',
    } as any, user, 'outbound-access-batch-key')],
  ])('blocks %s queue creation before any email job when the central account gate rejects', async (
    _label,
    invoke,
  ) => {
    const { service, outbound, composeQueue, validateQueue, user } = harness();
    await expect(invoke(service, user)).rejects.toThrow(/assigned to another/i);
    expect(outbound.assertEmailAccountAccess).toHaveBeenCalledWith(
      'company-1',
      'account-1',
      user,
    );
    expect(composeQueue.add).not.toHaveBeenCalled();
    expect(validateQueue.add).not.toHaveBeenCalled();
  });
});
