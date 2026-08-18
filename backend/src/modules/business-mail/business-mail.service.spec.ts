import { BadRequestException, ServiceUnavailableException } from '@nestjs/common';
import * as nodemailer from 'nodemailer';
import { encrypt } from '../../common/utils/crypto.util';
import { BusinessMailService } from './business-mail.service';

jest.mock('nodemailer', () => ({ createTransport: jest.fn() }));
jest.mock('../email-accounts/smtp-egress.policy', () => ({
  resolveSmtpEgress: jest.fn().mockResolvedValue({
    host: 'smtp.example.com',
    port: 465,
    secure: true,
  }),
}));

describe('BusinessMailService outbound safety', () => {
  const originalEnv = {
    EMAIL_ENCRYPTION_KEY: process.env.EMAIL_ENCRYPTION_KEY,
    EMAIL_SEND_ENABLED: process.env.EMAIL_SEND_ENABLED,
    EMAIL_SEND_DISABLED: process.env.EMAIL_SEND_DISABLED,
    PUBLIC_TRACKING_BASE_URL: process.env.PUBLIC_TRACKING_BASE_URL,
    PUBLIC_UNSUBSCRIBE_URL: process.env.PUBLIC_UNSUBSCRIBE_URL,
  };
  const transport = {
    verify: jest.fn().mockResolvedValue(true),
    sendMail: jest.fn().mockResolvedValue({ messageId: 'm-1', accepted: ['buyer@example.com'], response: 'ok' }),
    close: jest.fn(),
  };
  let prisma: any;
  let outbound: any;
  let service: BusinessMailService;

  beforeEach(() => {
    process.env.EMAIL_ENCRYPTION_KEY = 'unit-test-encryption-key';
    delete process.env.EMAIL_SEND_ENABLED;
    delete process.env.EMAIL_SEND_DISABLED;
    delete process.env.PUBLIC_TRACKING_BASE_URL;
    delete process.env.PUBLIC_UNSUBSCRIBE_URL;
    jest.clearAllMocks();
    transport.verify.mockReset().mockResolvedValue(true);
    transport.sendMail.mockReset().mockResolvedValue({
      messageId: 'm-1',
      accepted: ['buyer@example.com'],
      response: 'ok',
    });
    transport.close.mockReset();
    (nodemailer.createTransport as jest.Mock).mockReturnValue(transport);
    prisma = {
      emailAccount: {
        findFirst: jest.fn().mockResolvedValue({
          id: 'account-1',
          companyId: 'company-1',
          senderName: 'Vaysen Sales',
          senderEmail: 'sales@vaysen.com',
          replyToEmail: 'reply@reply.vaysen.com',
          smtpHost: 'smtp.example.com',
          smtpPort: 465,
          smtpSecure: true,
          smtpUsername: 'smtp-user',
          smtpPasswordEncrypted: encrypt('smtp-password'),
          company: { website: 'https://vaysen.com' },
        }),
      },
      lead: { findFirst: jest.fn().mockResolvedValue({ id: 'lead-1' }) },
      conversation: {
        findUnique: jest.fn(),
        findFirst: jest.fn(),
        create: jest.fn().mockResolvedValue({ id: 'conversation-1' }),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      communicationMessage: { upsert: jest.fn().mockResolvedValue({ id: 'message-1' }) },
      userCompanyRelation: {
        findFirst: jest.fn().mockResolvedValue({ role: { name: 'company_admin' } }),
      },
    };
    outbound = {
      execute: jest.fn(async (_request: any, provider: any) => ({
        outboxId: 'outbox-1',
        deduplicated: false,
        receipt: await provider(_request.artifacts || [], {
          targetAddress: _request.targetAddress.trim().toLowerCase(),
          subject: _request.subject.trim(),
          body: _request.body.trim(),
          contentType: _request.contentType,
          artifacts: _request.artifacts || [],
          signal: new AbortController().signal,
        }),
      })),
    };
    service = new BusinessMailService(prisma, outbound);
  });

  afterAll(() => {
    for (const [key, value] of Object.entries(originalEnv)) {
      if (value === undefined) delete process.env[key as keyof typeof originalEnv];
      else process.env[key as keyof typeof originalEnv] = value;
    }
  });

  const currentUser = {
    id: 'user-1',
    email: 'operator@vaysen.com',
    activeCompanyId: 'company-1',
    activeCompany: { id: 'company-1', name: 'Vaysen Packaging', role: 'company_admin' },
    companies: [{ id: 'company-1', name: 'Vaysen Packaging', role: 'company_admin' }],
  };

  const dto = (overrides: Record<string, unknown> = {}) => ({
    emailAccountId: 'account-1',
    to: 'buyer@example.com',
    subject: 'Custom packaging sample options',
    html: '<p>We can prepare custom packaging samples and a practical quotation for your team.</p>',
    leadId: 'lead-1',
    idempotencyKey: 'business-mail:test-1',
    ...overrides,
  } as any);

  it('rejects a private URL before opening SMTP', async () => {
    await expect(service.sendMail(dto({
      html: '<p>Review the private quotation at <a href="http://127.0.0.1/quote">this link</a>.</p>',
    }), currentUser)).rejects.toBeInstanceOf(BadRequestException);
    expect(nodemailer.createTransport).not.toHaveBeenCalled();
  });

  it('rejects retired branding in the subject, body, or sender envelope', async () => {
    await expect(service.sendMail(dto({ subject: 'Jingseyewear cooperation offer' }), currentUser))
      .rejects.toThrow(/retired brand or domain/i);

    prisma.emailAccount.findFirst.mockResolvedValue({
      ...(await prisma.emailAccount.findFirst()),
      senderEmail: 'sales@fastenernails.com',
    });
    await expect(service.sendMail(dto(), currentUser)).rejects.toThrow(/retired brand or domain/i);
    expect(nodemailer.createTransport).not.toHaveBeenCalled();
  });

  it('rejects client-controlled attachment filesystem paths', async () => {
    await expect(service.sendMail(dto({
      attachments: [{ filename: 'secret.txt', path: '/etc/passwd' }],
    }), currentUser)).rejects.toThrow(/filesystem paths are not accepted/i);
    expect(nodemailer.createTransport).not.toHaveBeenCalled();
  });

  it('recomputes attachment MIME from bytes and rejects caller metadata tampering', async () => {
    await expect(service.sendMail(dto({
      attachments: [{
        filename: 'quote.pdf',
        content: '%PDF-server-observed-bytes',
        mimeType: 'image/png',
      }],
    }), currentUser)).rejects.toThrow(/MIME does not match its bytes/i);
    expect(nodemailer.createTransport).not.toHaveBeenCalled();
  });

  it('honors the disabled switch before opening SMTP', async () => {
    process.env.EMAIL_SEND_DISABLED = 'true';
    await expect(service.sendMail(dto(), currentUser)).rejects.toMatchObject({
      constructor: ServiceUnavailableException,
      response: expect.objectContaining({
        status: 'BLOCKED',
        code: 'EMAIL_SEND_DISABLED',
      }),
    });
    expect(nodemailer.createTransport).not.toHaveBeenCalled();
  });

  it.each([
    ['another lead', { leadId: 'lead-2', channel: 'business_email', status: 'active' }],
    ['another channel', { leadId: 'lead-1', channel: 'whatsapp', status: 'active' }],
    ['an inactive thread', { leadId: 'lead-1', channel: 'business_email', status: 'closed' }],
  ])(
    'rejects a caller-supplied conversation bound to %s before reserving or opening SMTP',
    async (_label, mismatchedConversation) => {
      prisma.conversation.findFirst.mockImplementation(({ where }: any) => (
        where.id === 'conversation-supplied'
        && mismatchedConversation.leadId === where.leadId
        && mismatchedConversation.channel === where.channel
        && mismatchedConversation.status === where.status
          ? { id: 'conversation-supplied' }
          : null
      ));

      await expect(service.sendMail(dto({
        conversationId: 'conversation-supplied',
      }), currentUser)).rejects.toThrow(/active email thread for this lead/i);

      expect(prisma.conversation.findFirst).toHaveBeenCalledWith({
        where: {
          id: 'conversation-supplied',
          companyId: 'company-1',
          leadId: 'lead-1',
          channel: 'business_email',
          status: 'active',
        },
        select: { id: true },
      });
      expect(outbound.execute).not.toHaveBeenCalled();
      expect(nodemailer.createTransport).not.toHaveBeenCalled();
      expect(transport.verify).not.toHaveBeenCalled();
      expect(transport.sendMail).not.toHaveBeenCalled();
    },
  );

  it('reuses an exact pre-authorized conversation on an Outbox replay without another provider send', async () => {
    prisma.conversation.findFirst.mockResolvedValue({
      id: 'conversation-supplied',
    });
    const request = dto({ conversationId: 'conversation-supplied' });

    await service.sendMail(request, currentUser);
    outbound.execute.mockResolvedValueOnce({
      outboxId: 'outbox-1',
      deduplicated: true,
      receipt: { provider: 'smtp', receiptId: 'm-1', acceptedAt: new Date() },
    });

    await expect(service.sendMail(request, currentUser)).resolves.toMatchObject({
      deduplicated: true,
      outboxId: 'outbox-1',
    });
    expect(transport.sendMail).toHaveBeenCalledTimes(1);
    expect(prisma.conversation.create).not.toHaveBeenCalled();
    expect(prisma.communicationMessage.upsert).toHaveBeenLastCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({
          conversationId: 'conversation-supplied',
          externalMessageId: 'm-1',
        }),
      }),
    );
  });

  it('sends only the prepared and validated deliverable', async () => {
    await expect(service.sendMail(dto(), currentUser)).resolves.toMatchObject({ messageId: 'm-1' });
    const sent = transport.sendMail.mock.calls[0][0];
    expect(sent.html).toContain('https://vaysen.com');
    expect(sent.html).toContain('reply to this email');
    expect(sent.replyTo).toBe('reply@reply.vaysen.com');
    expect(sent.attachments).toBeUndefined();
    expect(transport.verify).toHaveBeenCalledTimes(1);
  });

  it('does not expose the SMTP provider error from sendMail verification', async () => {
    const sentinel = 'SMTP provider raw response sentinel.customer@example.com token=secret /srv/customer/mail.eml';
    transport.verify.mockRejectedValueOnce(new Error(sentinel));

    const error = await service.sendMail(dto(), currentUser).catch((failure) => failure);

    expect(error).toMatchObject({
      providerDeliveryOutcome: 'REJECTED',
      providerAccepted: false,
      response: {
        status: 'error',
        code: 'SMTP_VERIFY_FAILED',
        message: 'SMTP connection failed before message dispatch',
      },
    });
    expect(JSON.stringify(error.getResponse())).not.toContain(sentinel);
  });

  it('repairs the CRM projection on an idempotent Outbox replay without another provider send', async () => {
    await service.sendMail(dto(), currentUser);
    prisma.communicationMessage.upsert.mockClear();
    prisma.conversation.updateMany.mockClear();
    outbound.execute.mockResolvedValueOnce({
      outboxId: 'outbox-1',
      deduplicated: true,
      receipt: { provider: 'smtp', receiptId: 'm-1', acceptedAt: new Date() },
    });

    await expect(service.sendMail(dto(), currentUser)).resolves.toMatchObject({
      deduplicated: true,
      outboxId: 'outbox-1',
    });
    expect(transport.sendMail).toHaveBeenCalledTimes(1);
    expect(prisma.communicationMessage.upsert).toHaveBeenCalledWith(expect.objectContaining({
      where: { ingestionKey: expect.stringMatching(/^[a-f0-9]{64}$/) },
      create: expect.objectContaining({
        conversationId: 'conversation-1',
        externalMessageId: 'm-1',
        deliveryStatus: 'sent',
      }),
    }));
    expect(prisma.conversation.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({
        id: 'conversation-1',
        companyId: 'company-1',
        leadId: 'lead-1',
        channel: 'business_email',
        status: 'active',
      }),
    }));
  });

  it('treats a message id without the intended accepted recipient as an explicit rejection', async () => {
    transport.sendMail.mockResolvedValueOnce({
      messageId: 'm-rejected',
      accepted: ['other@example.com'],
      rejected: ['buyer@example.com'],
    });
    await expect(service.sendMail(dto(), currentUser)).rejects.toMatchObject({
      providerDeliveryOutcome: 'REJECTED',
      providerAccepted: false,
    });
  });

  it('does not probe SMTP for an account outside the explicit active company', async () => {
    prisma.emailAccount.findFirst.mockResolvedValueOnce(null);
    const foreignTenantUser = {
      ...currentUser,
      activeCompanyId: 'company-2',
      activeCompany: { id: 'company-2', role: 'super_admin' },
      companies: [
        ...currentUser.companies,
        { id: 'company-2', role: 'super_admin' },
      ],
    };

    await expect(service.testSmtp('account-1', foreignTenantUser))
      .rejects.toThrow('Email account not found');
    expect(prisma.emailAccount.findFirst).toHaveBeenCalledWith({
      where: {
        id: 'account-1',
        companyId: 'company-2',
      },
    });
    expect(nodemailer.createTransport).not.toHaveBeenCalled();
  });

  it('closes the bounded SMTP test transport after success and failure', async () => {
    await expect(service.testSmtp('account-1', currentUser)).resolves.toEqual({
      success: true,
      code: 'SMTP_CONNECTION_OK',
      message: 'SMTP connection successful',
    });
    expect(transport.close).toHaveBeenCalledTimes(1);

    transport.close.mockClear();
    transport.verify.mockRejectedValueOnce(new Error('relay rejected login'));
    await expect(service.testSmtp('account-1', currentUser)).resolves.toEqual({
      success: false,
      code: 'SMTP_CONNECTION_FAILED',
      message: 'SMTP connection failed',
    });
    expect(transport.close).toHaveBeenCalledTimes(1);
  });

  it('hard-aborts and closes a hung SMTP test at its deadline', async () => {
    jest.useFakeTimers();
    try {
      let rejectVerify!: (error: Error) => void;
      transport.verify.mockImplementationOnce(() => new Promise((_resolve, reject) => {
        rejectVerify = reject;
      }));
      transport.close.mockImplementation(() => {
        rejectVerify?.(new Error('SMTP transport closed after deadline'));
      });

      const result = service.testSmtp('account-1', currentUser);
      await jest.advanceTimersByTimeAsync(10_000);

      await expect(result).resolves.toEqual({
        success: false,
        code: 'SMTP_CONNECTION_FAILED',
        message: 'SMTP connection failed',
      });
      expect(transport.close).toHaveBeenCalled();
      expect(jest.getTimerCount()).toBe(0);
    } finally {
      jest.useRealTimers();
    }
  });

  it('denies global superadmin SMTP actions without a direct active target relation', async () => {
    prisma.userCompanyRelation.findFirst.mockResolvedValueOnce(null);
    const globalSuper = {
      ...currentUser,
      isSuperAdmin: true,
      activeCompany: {
        id: 'company-1',
        role: 'super_admin',
      },
    };

    await expect(service.testSmtp('account-1', globalSuper))
      .rejects.toThrow(/company administrator role is required/i);
    expect(nodemailer.createTransport).not.toHaveBeenCalled();
    expect(transport.verify).not.toHaveBeenCalled();
  });

  it('uses the same not-found boundary for a foreign account before outbound reservation', async () => {
    prisma.emailAccount.findFirst.mockResolvedValueOnce(null);
    const foreignTenantUser = {
      ...currentUser,
      activeCompanyId: 'company-2',
      activeCompany: { id: 'company-2', role: 'company_admin' },
      companies: [
        ...currentUser.companies,
        { id: 'company-2', role: 'company_admin' },
      ],
    };

    await expect(service.sendMail(dto(), foreignTenantUser))
      .rejects.toThrow('Email account not found');

    expect(prisma.emailAccount.findFirst).toHaveBeenCalledWith({
      where: {
        id: 'account-1',
        companyId: 'company-2',
      },
      include: { company: true },
    });
    expect(outbound.execute).not.toHaveBeenCalled();
    expect(nodemailer.createTransport).not.toHaveBeenCalled();
  });
});
