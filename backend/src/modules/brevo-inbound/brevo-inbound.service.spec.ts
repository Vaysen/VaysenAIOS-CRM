import { ForbiddenException, ServiceUnavailableException } from '@nestjs/common';
import { BrevoInboundService } from './brevo-inbound.service';

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
    process.env.BREVO_INBOUND_DOMAIN = 'reply.acme.test';
    ownerNotificationService.enqueueInbound.mockResolvedValue({ created: true });
    service = new BrevoInboundService(prisma, identityAdapter, ownerNotificationService);
  });

  afterAll(() => {
    if (originalToken === undefined) delete process.env.BREVO_INBOUND_WEBHOOK_TOKEN;
    else process.env.BREVO_INBOUND_WEBHOOK_TOKEN = originalToken;
    if (originalDomain === undefined) delete process.env.BREVO_INBOUND_DOMAIN;
    else process.env.BREVO_INBOUND_DOMAIN = originalDomain;
  });

  it('reports enabled only when both a strong token and a non-placeholder inbound domain exist', () => {
    expect(service.getStatus()).toMatchObject({
      enabled: true,
      webhookReady: true,
      inboundDomain: 'reply.acme.test',
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
    expect(result).toMatchObject({ status: 'ok', received: 1, skipped: 0 });
  });

  it('skips mail for an address that is not mapped to an active account', async () => {
    prisma.emailAccount.findMany.mockResolvedValue([]);

    const result = await service.ingest({
      MessageId: '<unknown@example.net>',
      From: { Address: 'buyer@example.net' },
      Recipients: ['unknown@reply.example.com'],
      RawTextBody: 'Hello',
    });

    expect(identityAdapter.ingest).not.toHaveBeenCalled();
    expect(result).toMatchObject({ received: 0, skipped: 1 });
  });

  it('fails closed when a receiving address maps to multiple tenants', async () => {
    prisma.emailAccount.findMany.mockResolvedValue([
      { id: 'account-1', companyId: 'company-1' },
      { id: 'account-2', companyId: 'company-2' },
    ]);

    const result = await service.ingest({
      MessageId: '<ambiguous@example.net>',
      From: { Address: 'buyer@example.net' },
      Recipients: ['sales@reply.example.com'],
      RawTextBody: 'Hello',
    });

    expect(identityAdapter.ingest).not.toHaveBeenCalled();
    expect(result.results[0]).toMatchObject({
      status: 'skipped',
      reason: 'ambiguous_recipient',
    });
  });
});
