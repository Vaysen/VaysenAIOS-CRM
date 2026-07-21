import * as nodemailer from 'nodemailer';
import { encrypt } from '../../common/utils/crypto.util';
import { EmailSendProcessor } from './email-send.processor';

jest.mock('nodemailer', () => ({ createTransport: jest.fn() }));

describe('EmailSendProcessor delivery semantics', () => {
  const originalEnv = {
    EMAIL_SEND_DISABLED: process.env.EMAIL_SEND_DISABLED,
    EMAIL_SEND_ENABLED: process.env.EMAIL_SEND_ENABLED,
    EMAIL_ENCRYPTION_KEY: process.env.EMAIL_ENCRYPTION_KEY,
  };
  let prisma: any;
  let processor: EmailSendProcessor;
  let transport: any;

  const message = () => ({
    id: 'email-1',
    companyId: 'company-1',
    leadId: 'lead-1',
    emailAccountId: 'account-1',
    status: 'QueuedToSend',
    subject: 'Custom packaging quotation update',
    bodyHtml: '<p>Please review our updated custom packaging quotation at https://example.com.</p>',
    retryCount: 0,
    maxRetries: 3,
    toEmail: 'buyer@example.net',
    lead: { id: 'lead-1', contactEmail: 'buyer@example.net' },
    company: { website: 'https://example.com' },
    emailAccount: {
      id: 'account-1',
      senderName: 'Vaysen AI CRM Sales',
      senderEmail: 'sales@example.com',
      replyToEmail: 'sales@reply.example.com',
      smtpHost: 'smtp.example.net',
      smtpPort: 587,
      smtpSecure: false,
      smtpUsername: 'smtp-user',
      smtpPasswordEncrypted: encrypt('smtp-password'),
    },
  });

  beforeEach(() => {
    process.env.EMAIL_ENCRYPTION_KEY = 'unit-test-encryption-key';
    delete process.env.EMAIL_SEND_DISABLED;
    delete process.env.EMAIL_SEND_ENABLED;
    transport = {
      sendMail: jest.fn().mockResolvedValue({ messageId: 'smtp-message-1' }),
    };
    (nodemailer.createTransport as jest.Mock).mockReturnValue(transport);
    prisma = {
      emailMessage: {
        findUnique: jest.fn().mockResolvedValue(message()),
        update: jest.fn().mockResolvedValue({}),
      },
      emailAccount: { update: jest.fn().mockResolvedValue({}) },
    };
    processor = new EmailSendProcessor(
      prisma,
      { generateForEmail: jest.fn().mockResolvedValue(undefined) } as any,
      { logActivity: jest.fn().mockResolvedValue(undefined) } as any,
      { add: jest.fn().mockResolvedValue(undefined) } as any,
      { add: jest.fn().mockResolvedValue(undefined) } as any,
    );
    jest.spyOn(processor as any, 'checkSendEligibility').mockResolvedValue({ canSend: true });
  });

  afterAll(() => {
    for (const [key, value] of Object.entries(originalEnv)) {
      if (value === undefined) delete process.env[key as keyof typeof originalEnv];
      else process.env[key as keyof typeof originalEnv] = value;
    }
  });

  it('persists Blocked and returns success=false when the safety switch is active', async () => {
    process.env.EMAIL_SEND_DISABLED = 'true';

    await expect((processor as any).processLocked({
      data: { emailMessageId: 'email-1' },
    })).resolves.toEqual({
      success: false,
      status: 'BLOCKED',
      reason: 'EMAIL_SEND_DISABLED',
    });
    expect(prisma.emailMessage.update).toHaveBeenCalledWith({
      where: { id: 'email-1' },
      data: {
        status: 'Blocked',
        failedReason: 'EMAIL_SEND_DISABLED: Email sending blocked by server safety switch',
        errorMessage: 'EMAIL_SEND_DISABLED',
      },
    });
    expect(nodemailer.createTransport).not.toHaveBeenCalled();
  });

  it('adds the configured Reply-To to a real queued SMTP send', async () => {
    await expect((processor as any).processLocked({
      data: { emailMessageId: 'email-1' },
    })).resolves.toMatchObject({ success: true, messageId: 'smtp-message-1' });

    expect(transport.sendMail).toHaveBeenCalledWith(expect.objectContaining({
      from: '"Vaysen AI CRM Sales" <sales@example.com>',
      replyTo: 'sales@reply.example.com',
      to: 'buyer@example.net',
    }));
  });
});
