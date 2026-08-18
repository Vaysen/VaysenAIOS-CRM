import { ForbiddenException } from '@nestjs/common';
import * as nodemailer from 'nodemailer';
import { EmailAccountsService } from './email-accounts.service';

jest.mock('nodemailer', () => ({ createTransport: jest.fn() }));
jest.mock('../../common/utils/crypto.util', () => ({
  encrypt: jest.fn((value: string) => value),
  decrypt: jest.fn((value: string) => value),
}));
jest.mock('./smtp-egress.policy', () => ({
  resolveSmtpEgress: jest.fn(async (account: any) => {
    if (account.smtpHost === 'attacker.example') {
      const { BadRequestException } = jest.requireActual('@nestjs/common');
      throw new BadRequestException('SMTP relay is not permitted by the server egress allowlist');
    }
    return { host: account.smtpHost, port: account.smtpPort, secure: account.smtpSecure };
  }),
}));

describe('EmailAccountsService outbound safety', () => {
  const companyId = 'company-1';
  const account = {
    id: 'account-1',
    companyId,
    userId: null,
    senderName: 'Vaysen Packaging CRM',
    senderEmail: 'sales@example.org',
    replyToEmail: null,
    smtpHost: 'smtp.example.org',
    smtpPort: 465,
    smtpSecure: true,
    smtpUsername: 'sender',
    smtpPasswordEncrypted: 'not-read-by-this-test',
  };

  function createHarness() {
    const prisma: any = {
      emailAccount: {
        findFirst: jest.fn().mockResolvedValue(account),
        findUnique: jest.fn().mockResolvedValue(account),
        findMany: jest.fn().mockResolvedValue([account]),
        count: jest.fn().mockResolvedValue(1),
        update: jest.fn().mockResolvedValue(account),
      },
      userCompanyRelation: {
        findFirst: jest.fn(({ where }: any) => Promise.resolve({
          role: {
            name: where.userId === 'viewer-1'
              ? 'viewer'
              : where.userId === 'manager-1'
                ? 'sales_manager'
                : 'company_admin',
          },
        })),
      },
    };
    const outbound = {
      execute: jest.fn().mockResolvedValue({
        outboxId: 'outbox-1',
        deduplicated: false,
        receipt: { provider: 'smtp', receiptId: 'provider-message-1' },
      }),
    };
    return {
      prisma,
      outbound,
      service: new EmailAccountsService(prisma, outbound as any),
    };
  }

  it('routes test SMTP through the unified guard with a bound lead and canonical key', async () => {
    const { service, outbound } = createHarness();
    const admin = {
      id: 'admin-1',
      activeCompanyId: companyId,
      companies: [{ id: companyId, role: 'company_admin' }],
    };
    await expect(service.sendTest('account-1', {
      recipientEmail: 'buyer@example.net',
      leadId: '11111111-1111-4111-8111-111111111111',
      idempotencyKey: 'email-account:test-1',
    }, admin)).resolves.toMatchObject({
      success: true,
      outboxId: 'outbox-1',
      providerReceiptId: 'provider-message-1',
    });
    expect(outbound.execute).toHaveBeenCalledWith(expect.objectContaining({
      companyId,
      actionType: 'RAW_SMTP_TEST',
      requireAdmin: true,
      leadId: '11111111-1111-4111-8111-111111111111',
      targetAddress: 'buyer@example.net',
      idempotencyKey: 'email-account:test-1',
    }), expect.any(Function));
  });

  it('denies a viewer test SMTP send in the service layer', async () => {
    const { service, outbound } = createHarness();
    const viewer = {
      id: 'viewer-1',
      activeCompanyId: companyId,
      companies: [{ id: companyId, role: 'viewer' }],
    };
    await expect(service.sendTest('account-1', {
      recipientEmail: 'buyer@example.net',
      leadId: '11111111-1111-4111-8111-111111111111',
      idempotencyKey: 'email-account:test-2',
    }, viewer)).rejects.toBeInstanceOf(ForbiddenException);
    expect(outbound.execute).not.toHaveBeenCalled();
  });

  it('denies sender account deletion and status disconnect to a non-admin manager', async () => {
    const { service } = createHarness();
    const manager = {
      id: 'manager-1',
      activeCompanyId: companyId,
      companies: [{ id: companyId, role: 'sales_manager' }],
    };
    await expect(service.remove('account-1', manager))
      .rejects.toBeInstanceOf(ForbiddenException);
    await expect(service.updateStatus('account-1', { status: 'inactive' } as any, manager))
      .rejects.toBeInstanceOf(ForbiddenException);
  });

  it('denies an admin membership when the account company is not the authenticated active company', async () => {
    const { service } = createHarness();
    const multiTenantAdmin = {
      id: 'admin-1',
      activeCompanyId: 'company-2',
      companies: [
        { id: companyId, role: 'company_admin' },
        { id: 'company-2', role: 'company_admin' },
      ],
    };
    await expect(service.remove('account-1', multiTenantAdmin))
      .rejects.toThrow(/authenticated active company/i);
  });

  it('does not fall back to the first membership when activeCompanyId is missing', async () => {
    const { service } = createHarness();
    await expect(service.findAll({
      id: 'admin-1',
      companies: [{ id: companyId, role: 'company_admin' }],
    }, {})).rejects.toThrow(/active company/i);
  });

  it('scopes admin account enumeration to the explicit active company', async () => {
    const { service, prisma } = createHarness();
    await service.findAll({
      id: 'admin-1',
      activeCompanyId: companyId,
      activeCompany: { id: companyId, role: 'company_admin' },
      companies: [
        { id: companyId, role: 'company_admin' },
        { id: 'company-2', role: 'company_admin' },
      ],
    }, {});
    expect(prisma.emailAccount.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { companyId },
    }));
  });

  it('rejects an update that points SMTP credentials at an untrusted host', async () => {
    const { service } = createHarness();
    await expect(service.update('account-1', {
      smtpHost: 'attacker.example',
    } as any, {
      id: 'admin-1',
      activeCompanyId: companyId,
      activeCompany: { id: companyId, role: 'company_admin' },
      companies: [{ id: companyId, role: 'company_admin' }],
    })).rejects.toThrow(/egress allowlist/i);
  });

  it('rejects sendTest when the message id exists but the intended recipient was not accepted', async () => {
    const { service, outbound } = createHarness();
    const transport = {
      sendMail: jest.fn().mockResolvedValue({
        messageId: 'smtp-message-1',
        accepted: ['other@example.net'],
        rejected: ['buyer@example.net'],
      }),
    };
    (nodemailer.createTransport as jest.Mock).mockReturnValue(transport);
    outbound.execute.mockImplementation(async (_request: any, provider: any) => provider([], {
      targetAddress: _request.targetAddress.trim().toLowerCase(),
      subject: _request.subject.trim(),
      body: _request.body.trim(),
      contentType: 'html',
      artifacts: [],
      signal: new AbortController().signal,
    }));
    await expect(service.sendTest('account-1', {
      recipientEmail: 'buyer@example.net',
      leadId: '11111111-1111-4111-8111-111111111111',
      idempotencyKey: 'email-account:test-reject',
    }, {
      id: 'admin-1',
      activeCompanyId: companyId,
      activeCompany: { id: companyId, role: 'company_admin' },
      companies: [{ id: companyId, role: 'company_admin' }],
    })).rejects.toMatchObject({
      providerDeliveryOutcome: 'REJECTED',
      providerAccepted: false,
    });
  });

  it('returns a stable SMTP connection error without provider text', async () => {
    const { service } = createHarness();
    const transport = { verify: jest.fn().mockRejectedValue(new Error('SMTP raw response sentinel host=mail.example token=secret')) };
    (nodemailer.createTransport as jest.Mock).mockReturnValue(transport);

    await expect(service.testConnection('account-1', {
      id: 'admin-1',
      activeCompanyId: companyId,
      activeCompany: { id: companyId, role: 'company_admin' },
      companies: [{ id: companyId, role: 'company_admin' }],
    })).resolves.toEqual({
      success: false,
      code: 'SMTP_CONNECTION_FAILED',
      message: 'SMTP connection failed',
    });
  });

  it('returns a stable send-test error without provider text or recipient', async () => {
    const { service, outbound } = createHarness();
    const sentinel = 'provider response sentinel.customer@example.com token=secret /srv/customer/mail.eml';
    outbound.execute.mockRejectedValueOnce(new Error(sentinel));

    const result = await service.sendTest('account-1', {
      recipientEmail: 'buyer@example.net',
      leadId: '11111111-1111-4111-8111-111111111111',
      idempotencyKey: 'email-account:test-error',
    }, {
      id: 'admin-1',
      activeCompanyId: companyId,
      activeCompany: { id: companyId, role: 'company_admin' },
      companies: [{ id: companyId, role: 'company_admin' }],
    });

    expect(result).toEqual({
      success: false,
      code: 'SMTP_TEST_SEND_FAILED',
      message: 'Failed to send test email',
    });
    expect(JSON.stringify(result)).not.toContain(sentinel);
    expect(JSON.stringify(result)).not.toContain('buyer@example.net');
  });
});
