import { ForbiddenException, Logger, ServiceUnavailableException } from '@nestjs/common';
import { BrevoInboundService } from './brevo-inbound.service';

function loggerOutput() {
  return [Logger.prototype.log, Logger.prototype.warn, Logger.prototype.error, Logger.prototype.debug]
    .flatMap((logger: any) => logger.mock?.calls || [])
    .flat()
    .map(String)
    .join('\n');
}

describe('BrevoInboundService', () => {
  const originalToken = process.env.BREVO_INBOUND_WEBHOOK_TOKEN;
  const originalDomain = process.env.BREVO_INBOUND_DOMAIN;
  const prisma = {
    emailAccount: { findMany: jest.fn() },
    communicationMessage: { update: jest.fn() },
  } as any;
  const identityAdapter = { ingest: jest.fn() } as any;
  const ownerNotificationService = { enqueueInbound: jest.fn() } as any;
  let service: BrevoInboundService;

  beforeEach(() => {
    jest.clearAllMocks();
    process.env.BREVO_INBOUND_WEBHOOK_TOKEN = 'a'.repeat(48);
    process.env.BREVO_INBOUND_DOMAIN = 'reply.vaysen.com';
    ownerNotificationService.enqueueInbound.mockResolvedValue({ created: true });
    service = new BrevoInboundService(prisma, identityAdapter, ownerNotificationService);
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'debug').mockImplementation(() => undefined);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  afterAll(() => {
    if (originalToken === undefined) delete process.env.BREVO_INBOUND_WEBHOOK_TOKEN;
    else process.env.BREVO_INBOUND_WEBHOOK_TOKEN = originalToken;
    if (originalDomain === undefined) delete process.env.BREVO_INBOUND_DOMAIN;
    else process.env.BREVO_INBOUND_DOMAIN = originalDomain;
  });

  it('reports enabled only when both a strong token and a real inbound domain exist', () => {
    expect(service.getStatus()).toMatchObject({
      enabled: true,
      webhookReady: true,
      inboundDomain: 'reply.vaysen.com',
    });

    process.env.BREVO_INBOUND_DOMAIN = 'reply.example.com';
    expect(service.getStatus()).toMatchObject({ enabled: false, inboundDomain: null });
  });

  it('fails closed when no strong webhook token is configured', () => {
    process.env.BREVO_INBOUND_WEBHOOK_TOKEN = 'short';
    expect(() => service.assertAuthorized('Bearer short')).toThrow(ServiceUnavailableException);
  });

  it('rejects an invalid bearer token', () => {
    expect(() => service.assertAuthorized(`Bearer ${'b'.repeat(48)}`)).toThrow(ForbiddenException);
  });

  it('accepts the configured bearer token', () => {
    expect(() => service.assertAuthorized(`Bearer ${'a'.repeat(48)}`)).not.toThrow();
  });

  it('ingests a parsed Brevo reply and links it through the email identity adapter', async () => {
    prisma.emailAccount.findMany.mockResolvedValue([{
      id: 'account-1',
      companyId: 'company-1',
      replyToEmail: 'sales@reply.example.com',
      senderEmail: 'sales@example.com',
    }]);
    identityAdapter.ingest.mockResolvedValue({
      leadId: 'lead-1',
      contactPointId: 'contact-point-1',
      contactId: 'contact-1',
      action: 'linked',
      emailMessageId: 'message-1',
    });
    prisma.communicationMessage.update.mockResolvedValue({
      id: 'message-1',
      conversationId: 'conversation-1',
    });

    const result = await service.ingest({
      items: [
        {
          MessageId: '<reply-1@example.net>',
          From: { Address: 'Buyer@Example.NET', Name: 'Buyer Name' },
          To: [{ Address: 'sales@reply.example.com' }],
          Subject: 'Re: quotation',
          ExtractedMarkdownMessage: 'Please send the revised quotation.',
          SentAtDate: '2026-07-13T05:00:00.000Z',
          Attachments: [
            {
              Name: 'requirements.pdf',
              ContentType: 'application/pdf',
              ContentLength: 1234,
              DownloadToken: 'download-token',
            },
          ],
        },
      ],
    });

    expect(prisma.emailAccount.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ status: 'active' }) }),
    );
    expect(identityAdapter.ingest).toHaveBeenCalledWith(
      expect.objectContaining({
        companyId: 'company-1',
        email: 'buyer@example.net',
        messageId: '<reply-1@example.net>',
        bodyText: 'Please send the revised quotation.',
      }),
    );
    expect(prisma.communicationMessage.update).toHaveBeenCalledWith({
      where: { id: 'message-1' },
      data: expect.objectContaining({
        toAddress: 'sales@reply.example.com',
        attachmentsMeta: [
          expect.objectContaining({ filename: 'requirements.pdf', provider: 'brevo' }),
        ],
      }),
    });
    expect(ownerNotificationService.enqueueInbound).toHaveBeenCalledWith({
      companyId: 'company-1',
      eventType: 'EMAIL_INBOUND',
      sourceMessageKey: '<reply-1@example.net>',
      sourceType: 'brevo_inbound_email',
      sourceId: 'message-1',
      conversationId: 'conversation-1',
      leadId: 'lead-1',
      subject: 'Re: quotation',
      preview: 'Please send the revised quotation.',
    });
    expect(result).toEqual({
      status: 'ok',
      received: 1,
      skipped: 0,
      results: [{
        status: 'received',
        messageRef: expect.stringMatching(/^sha256:brevo-message:/),
      }],
    });
  });

  it('persists a real inbound item while recipients, subject, body, and message ID stay out of logs', async () => {
    const recipient = 'brevo-recipient-sentinel@example.com';
    const messageId = '<brevo-message-sentinel@example.net>';
    const subject = 'BREVO_SUBJECT_SENTINEL';
    const body = 'BREVO_BODY_SENTINEL provider@example.com https://provider.invalid/?token=BREVO_TOKEN_SENTINEL';
    prisma.emailAccount.findMany.mockResolvedValue([{
      id: 'account-sentinel',
      companyId: 'company-sentinel',
      replyToEmail: recipient,
      senderEmail: 'sender@example.com',
    }]);
    identityAdapter.ingest.mockResolvedValue({
      leadId: 'lead-sentinel',
      emailMessageId: 'message-sentinel',
      action: 'linked',
    });
    prisma.communicationMessage.update.mockResolvedValue({
      id: 'message-sentinel',
      conversationId: 'conversation-sentinel',
    });

    const result = await service.ingest({
      MessageId: messageId,
      From: { Address: 'sender-sentinel@example.com', Name: 'Sender Name Sentinel' },
      To: [{ Address: recipient }],
      Subject: subject,
      RawTextBody: body,
    });

    expect(result).toMatchObject({ status: 'ok', received: 1, skipped: 0 });
    expect(result.results).toEqual([{
      status: 'received',
      messageRef: expect.stringMatching(/^sha256:brevo-message:/),
    }]);
    expect(JSON.stringify(result)).not.toContain(messageId);
    expect(JSON.stringify(result)).not.toContain('account-sentinel');
    expect(JSON.stringify(result)).not.toContain('lead-sentinel');
    expect(JSON.stringify(result)).not.toContain('message-sentinel');
    expect(identityAdapter.ingest).toHaveBeenCalledWith(expect.objectContaining({
      email: 'sender-sentinel@example.com',
      messageId,
      subject,
      bodyText: body,
    }));
    expect(prisma.communicationMessage.update).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ toAddress: recipient }),
    }));
    expect(ownerNotificationService.enqueueInbound).toHaveBeenCalledWith(expect.objectContaining({
      sourceMessageKey: messageId,
      subject,
      preview: body,
    }));

    const output = loggerOutput();
    for (const value of [recipient, messageId, subject, body, 'BREVO_TOKEN_SENTINEL']) {
      expect(output).not.toContain(value);
    }
  });

  it('keeps missing-identity skips at 200-compatible service status with only safe fields', async () => {
    const messageId = '<missing-identity-sentinel@example.net>';

    const result = await service.ingest({
      MessageId: messageId,
      From: { Address: 'not-an-email' },
      Subject: 'MISSING_SUBJECT_SENTINEL',
      RawTextBody: 'MISSING_BODY_SENTINEL https://provider.invalid/?token=MISSING_TOKEN_SENTINEL',
    });

    expect(result).toEqual({
      status: 'ok',
      received: 0,
      skipped: 1,
      results: [{
        status: 'skipped',
        reason: 'missing_identity',
        messageRef: expect.stringMatching(/^sha256:brevo-message:/),
      }],
    });
    expect(prisma.emailAccount.findMany).not.toHaveBeenCalled();
    expect(JSON.stringify(result)).not.toContain(messageId);
    expect(JSON.stringify(result)).not.toContain('MISSING_SUBJECT_SENTINEL');
    expect(JSON.stringify(result)).not.toContain('MISSING_BODY_SENTINEL');
    expect(JSON.stringify(result)).not.toContain('MISSING_TOKEN_SENTINEL');
  });

  it('skips mail for an address that is not mapped to an active account', async () => {
    const recipient = 'unknown-recipient-sentinel@example.com';
    const messageId = '<unknown-message-sentinel@example.net>';
    prisma.emailAccount.findMany.mockResolvedValue([]);

    const result = await service.ingest({
      MessageId: messageId,
      From: { Address: 'buyer@example.net' },
      Recipients: [recipient],
      RawTextBody: 'Hello',
    });

    expect(identityAdapter.ingest).not.toHaveBeenCalled();
    expect(result).toEqual({
      status: 'ok',
      received: 0,
      skipped: 1,
      results: [{
        status: 'skipped',
        reason: 'unknown_recipient',
        messageRef: expect.stringMatching(/^sha256:brevo-message:/),
      }],
    });
    expect(loggerOutput()).not.toContain(recipient);
    expect(loggerOutput()).not.toContain(messageId);
  });

  it('fails closed when a receiving address maps to multiple tenants', async () => {
    const recipient = 'ambiguous-recipient-sentinel@example.com';
    const messageId = '<ambiguous-message-sentinel@example.net>';
    prisma.emailAccount.findMany.mockResolvedValue([
      { id: 'account-1', companyId: 'company-1' },
      { id: 'account-2', companyId: 'company-2' },
    ]);

    const result = await service.ingest({
      MessageId: messageId,
      From: { Address: 'buyer@example.net' },
      Recipients: [recipient],
      RawTextBody: 'Hello',
    });

    expect(identityAdapter.ingest).not.toHaveBeenCalled();
    expect(result.results[0]).toMatchObject({
      status: 'skipped',
      reason: 'ambiguous_recipient',
    });
    expect(result.results[0]).toEqual({
      status: 'skipped',
      reason: 'ambiguous_recipient',
      messageRef: expect.stringMatching(/^sha256:brevo-message:/),
    });
    expect(loggerOutput()).not.toContain(recipient);
    expect(loggerOutput()).not.toContain(messageId);
  });

  it('rethrows provider failure without logging its raw error or stack', async () => {
    const providerError = Object.assign(
      new Error('BREVO_PROVIDER_ERROR recipient@example.com https://provider.invalid/?token=PROVIDER_TOKEN_SENTINEL'),
      { code: 'EBREVO_PROVIDER' },
    );
    prisma.emailAccount.findMany.mockResolvedValue([{
      id: 'account-provider-failure',
      companyId: 'company-provider-failure',
      replyToEmail: 'sales@reply.example.com',
      senderEmail: 'sales@example.com',
    }]);
    identityAdapter.ingest.mockRejectedValue(providerError);

    await expect(service.ingest({
      MessageId: '<provider-failure-sentinel@example.net>',
      From: { Address: 'recipient@example.com', Name: 'Provider Failure' },
      To: [{ Address: 'sales@reply.example.com' }],
      Subject: 'Provider failure subject',
      RawTextBody: 'Provider failure body',
    })).rejects.toBe(providerError);

    const output = loggerOutput();
    expect(output).not.toContain(providerError.message);
    expect(output).not.toContain('PROVIDER_TOKEN_SENTINEL');
    expect(output).not.toContain('recipient@example.com');
  });
});
