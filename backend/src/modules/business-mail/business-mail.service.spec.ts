import { BadRequestException, ServiceUnavailableException } from '@nestjs/common';
import * as nodemailer from 'nodemailer';
import { encrypt } from '../../common/utils/crypto.util';
import { BusinessMailService } from './business-mail.service';

jest.mock('nodemailer', () => ({ createTransport: jest.fn() }));

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
  };
  let prisma: any;
  let service: BusinessMailService;

  beforeEach(() => {
    process.env.EMAIL_ENCRYPTION_KEY = 'unit-test-encryption-key';
    delete process.env.EMAIL_SEND_ENABLED;
    delete process.env.EMAIL_SEND_DISABLED;
    delete process.env.PUBLIC_TRACKING_BASE_URL;
    delete process.env.PUBLIC_UNSUBSCRIBE_URL;
    jest.clearAllMocks();
    (nodemailer.createTransport as jest.Mock).mockReturnValue(transport);
    prisma = {
      emailAccount: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'account-1',
          companyId: 'company-1',
          senderName: 'Vaysen AI CRM Sales',
          senderEmail: 'sales@example.com',
          replyToEmail: 'reply@reply.example.com',
          smtpHost: 'smtp.example.com',
          smtpPort: 465,
          smtpSecure: true,
          smtpUsername: 'smtp-user',
          smtpPasswordEncrypted: encrypt('smtp-password'),
          company: { website: 'https://example.com' },
        }),
      },
      lead: { findUnique: jest.fn() },
      conversation: { findUnique: jest.fn(), create: jest.fn(), update: jest.fn() },
      communicationMessage: { create: jest.fn() },
    };
    service = new BusinessMailService(prisma);
  });

  afterAll(() => {
    for (const [key, value] of Object.entries(originalEnv)) {
      if (value === undefined) delete process.env[key as keyof typeof originalEnv];
      else process.env[key as keyof typeof originalEnv] = value;
    }
  });

  const currentUser = {
    id: 'user-1',
    email: 'operator@example.com',
    companies: [{ id: 'company-1', name: 'Example Trading Company', role: 'company_admin' }],
  };

  const dto = (overrides: Record<string, unknown> = {}) => ({
    emailAccountId: 'account-1',
    to: 'buyer@example.com',
    subject: 'Custom packaging sample options',
    html: '<p>We can prepare custom packaging samples and a practical quotation for your team.</p>',
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

    prisma.emailAccount.findUnique.mockResolvedValue({
      ...(await prisma.emailAccount.findUnique()),
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

  it('sends only the prepared and validated deliverable', async () => {
    await expect(service.sendMail(dto(), currentUser)).resolves.toMatchObject({ messageId: 'm-1' });
    const sent = transport.sendMail.mock.calls[0][0];
    expect(sent.html).toContain('https://example.com');
    expect(sent.html).toContain('reply to this email');
    expect(sent.replyTo).toBe('reply@reply.example.com');
    expect(sent.attachments).toBeUndefined();
    expect(transport.verify).toHaveBeenCalledTimes(1);
  });
});
