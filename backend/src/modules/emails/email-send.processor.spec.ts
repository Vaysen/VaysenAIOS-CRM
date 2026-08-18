import * as nodemailer from 'nodemailer';
import { encrypt } from '../../common/utils/crypto.util';
import { EmailSendProcessor } from './email-send.processor';

jest.mock('nodemailer', () => ({ createTransport: jest.fn() }));
jest.mock('../email-accounts/smtp-egress.policy', () => ({
  resolveSmtpEgress: jest.fn().mockResolvedValue({
    host: 'smtp.example.net',
    port: 587,
    secure: false,
  }),
}));

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
    senderUserId: 'user-1',
    status: 'QueuedToSend',
    subject: 'Custom packaging quotation update',
    bodyHtml: '<p>Please review our updated custom packaging quotation at https://vaysen.com.</p>',
    retryCount: 0,
    maxRetries: 3,
    toEmail: 'buyer@example.net',
    lead: { id: 'lead-1', contactEmail: 'buyer@example.net' },
    company: { website: 'https://vaysen.com' },
    emailAccount: {
      id: 'account-1',
      senderName: 'Vaysen Sales',
      senderEmail: 'sales@vaysen.com',
      replyToEmail: 'sales@reply.vaysen.com',
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
      sendMail: jest.fn().mockResolvedValue({
        messageId: 'smtp-message-1',
        accepted: ['buyer@example.net'],
      }),
    };
    (nodemailer.createTransport as jest.Mock).mockReturnValue(transport);
    prisma = {
      emailMessage: {
        findUnique: jest.fn().mockResolvedValue(message()),
        update: jest.fn().mockResolvedValue({}),
      },
      emailAccount: { update: jest.fn().mockResolvedValue({}) },
      externalActionOutbox: {
        findUnique: jest.fn().mockResolvedValue(null),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      userCompanyRelation: {
        findFirst: jest.fn().mockResolvedValue({ role: { name: 'company_admin' } }),
      },
    };
    processor = new EmailSendProcessor(
      prisma,
      { generateForEmail: jest.fn().mockResolvedValue(undefined) } as any,
      { logActivity: jest.fn().mockResolvedValue(undefined) } as any,
      { add: jest.fn().mockResolvedValue(undefined) } as any,
      { add: jest.fn().mockResolvedValue(undefined) } as any,
      {
        execute: jest.fn(async (_request: any, provider: any) => ({
          outboxId: 'outbox-1',
          deduplicated: false,
          receipt: await provider([], {
            targetAddress: _request.targetAddress.trim().toLowerCase(),
            subject: _request.subject.trim(),
            body: _request.body.trim(),
            contentType: _request.contentType || 'html',
            artifacts: [],
            signal: new AbortController().signal,
          }),
        })),
      } as any,
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
      from: '"Vaysen Sales" <sales@vaysen.com>',
      replyTo: 'sales@reply.vaysen.com',
      to: 'buyer@example.net',
    }));
  });

  it.each([
    'sender user deactivated',
    'sender user soft-deleted',
    'company deactivated',
  ])('blocks queued SMTP before provider I/O when %s', async () => {
    prisma.userCompanyRelation.findFirst.mockImplementation(({ where }: any) => {
      expect(where).toMatchObject({
        userId: 'user-1',
        companyId: 'company-1',
        isActive: true,
        user: { is: { isActive: true, deletedAt: null } },
        company: { is: { isActive: true } },
      });
      return Promise.resolve(null);
    });

    await expect((processor as any).processLocked({
      data: { emailMessageId: 'email-1' },
    })).rejects.toThrow(/no longer an active tenant member/i);
    expect(transport.sendMail).not.toHaveBeenCalled();
    expect((processor as any).outbound.execute).not.toHaveBeenCalled();
  });

  it('does not mark a message Sent when SMTP accepted a different recipient', async () => {
    transport.sendMail.mockResolvedValueOnce({
      messageId: 'smtp-message-rejected',
      accepted: ['other@example.net'],
      rejected: ['buyer@example.net'],
    });
    await expect((processor as any).processLocked({
      data: { emailMessageId: 'email-1' },
    })).rejects.toMatchObject({
      providerDeliveryOutcome: 'REJECTED',
      providerAccepted: false,
    });
    expect(prisma.emailMessage.update).not.toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ status: 'Sent' }),
    }));
  });

  it('reconciles a succeeded outbox receipt after a worker crash without resending', async () => {
    prisma.externalActionOutbox.findUnique.mockResolvedValue({
      id: 'outbox-1',
      status: 'SUCCEEDED',
      provider: 'smtp',
      providerReceiptId: 'smtp-message-committed',
      acceptedAt: new Date('2026-07-28T10:00:00.000Z'),
    });

    await expect((processor as any).processLocked({
      data: { emailMessageId: 'email-1' },
    })).resolves.toMatchObject({
      success: true,
      reconciledFromOutbox: true,
      messageId: 'smtp-message-committed',
    });
    expect(transport.sendMail).not.toHaveBeenCalled();
    expect(prisma.emailMessage.update).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        status: 'Sent',
        messageId: 'smtp-message-committed',
      }),
    }));
  });

  it('blocks an unknown provider outcome without incrementing retry state', async () => {
    const error: any = new Error('provider response could not be parsed');
    error.outboundActionStatus = 'UNKNOWN';
    error.outboxId = 'outbox-unknown';
    (processor as any).outbound.execute.mockRejectedValue(error);

    await expect((processor as any).processLocked({
      data: { emailMessageId: 'email-1' },
    })).resolves.toEqual({
      success: false,
      status: 'UNKNOWN',
      reason: 'Provider outcome requires reconciliation before retry',
      outboxId: 'outbox-unknown',
    });
    expect(prisma.emailMessage.update).toHaveBeenLastCalledWith({
      where: { id: 'email-1' },
      data: {
        status: 'Blocked',
        failedReason: 'OUTBOUND_UNKNOWN_RECONCILIATION_REQUIRED',
        errorMessage: 'OUTBOUND_UNKNOWN_RECONCILIATION_REQUIRED',
      },
    });
  });

  it.each([
    ['manual FAILED', {
      status: 'FAILED',
      attemptCount: 1,
      maxAttempts: 3,
      nextAttemptAt: null,
    }, 'FAILED_MANUAL_RECONCILIATION_REQUIRED'],
    ['missing EXECUTING lease', {
      status: 'EXECUTING',
      attemptCount: 1,
      maxAttempts: 3,
      leaseExpiresAt: null,
    }, 'UNKNOWN'],
    ['expired EXECUTING lease', {
      status: 'EXECUTING',
      attemptCount: 1,
      maxAttempts: 3,
      leaseExpiresAt: new Date(Date.now() - 1_000),
    }, 'UNKNOWN'],
  ])('projects %s to a safe local terminal state without provider dispatch', async (
    _label,
    durable,
    expectedStatus,
  ) => {
    prisma.emailMessage.findUnique.mockResolvedValue(message());
    prisma.externalActionOutbox.findUnique.mockResolvedValue({
      id: 'outbox-state-1',
      companyId: 'company-1',
      ...durable,
    });

    await expect((processor as any).processLocked({
      data: { emailMessageId: 'email-1', aiPersonalize: false },
    })).resolves.toMatchObject({ success: false, status: expectedStatus });
    expect(transport.sendMail).not.toHaveBeenCalled();
    expect(prisma.emailMessage.update).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ status: 'Blocked' }),
    }));
    if (expectedStatus === 'UNKNOWN') {
      expect(prisma.externalActionOutbox.updateMany).toHaveBeenCalledWith(expect.objectContaining({
        data: expect.objectContaining({ status: 'UNKNOWN' }),
      }));
    }
  });

  it('waits for an active EXECUTING lease without dispatching another provider call', async () => {
    prisma.externalActionOutbox.findUnique.mockResolvedValue({
      id: 'outbox-active-lease',
      companyId: 'company-1',
      status: 'EXECUTING',
      attemptCount: 1,
      maxAttempts: 3,
      leaseExpiresAt: new Date(Date.now() + 30_000),
    });

    await expect((processor as any).processLocked({
      data: { emailMessageId: 'email-1', aiPersonalize: false },
    })).resolves.toMatchObject({ success: false, status: 'WAITING' });
    expect(transport.sendMail).not.toHaveBeenCalled();
    expect((processor as any).emailSendQueue.add).toHaveBeenCalledWith(
      'send-email',
      { emailMessageId: 'email-1', aiPersonalize: false },
      expect.objectContaining({ delay: expect.any(Number) }),
    );
  });

  it('resumes a due retryable FAILED action with the same durable idempotency key', async () => {
    prisma.externalActionOutbox.findUnique.mockResolvedValue({
      id: 'outbox-due-retry',
      companyId: 'company-1',
      status: 'FAILED',
      attemptCount: 1,
      maxAttempts: 3,
      nextAttemptAt: new Date(Date.now() - 1_000),
    });

    await expect((processor as any).processLocked({
      data: { emailMessageId: 'email-1', aiPersonalize: false },
    })).resolves.toMatchObject({ success: true, messageId: 'smtp-message-1' });
    expect((processor as any).outbound.execute).toHaveBeenCalledWith(
      expect.objectContaining({ idempotencyKey: 'email-message:email-1' }),
      expect.any(Function),
    );
    expect(transport.sendMail).toHaveBeenCalledTimes(1);
  });
});
