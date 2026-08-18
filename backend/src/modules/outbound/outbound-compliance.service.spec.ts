import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ExternalActionChannel, ExternalActionStatus } from '@prisma/client';
import { OutboundComplianceService } from './outbound-compliance.service';
import { emailAddressEvidenceHash } from './email-verification-evidence';

const companyId = 'company-1';
const admin = {
  id: 'admin-1',
  activeCompanyId: companyId,
  companies: [{ id: companyId, role: 'company_admin' }],
};
const viewer = {
  id: 'viewer-1',
  activeCompanyId: companyId,
  companies: [{ id: companyId, role: 'viewer' }],
};

function createService() {
  const prisma: any = {
    $transaction: jest.fn((operation: any) => operation(prisma)),
    externalActionOutbox: {
      findFirst: jest.fn(),
      findMany: jest.fn(),
      findUnique: jest.fn(),
      findUniqueOrThrow: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
      updateMany: jest.fn(),
      count: jest.fn().mockResolvedValue(0),
    },
    lead: { findFirst: jest.fn() },
    emailMessage: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
    communicationMessage: {
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      upsert: jest.fn(),
    },
    emailAccount: { findFirst: jest.fn() },
    unsubscribeRecord: { findFirst: jest.fn() },
    blacklistRecord: { findFirst: jest.fn() },
    externalSuppression: { findFirst: jest.fn() },
    conversation: { findFirst: jest.fn() },
    externalIdentity: { findFirst: jest.fn().mockResolvedValue({ id: 'external-identity-1' }) },
    whatsAppSession: { findFirst: jest.fn() },
    userCompanyRelation: {
      findFirst: jest.fn().mockImplementation(({ where }: any) => Promise.resolve({
        userId: where.userId,
        companyId: where.companyId,
        isActive: true,
        role: { name: where.userId === viewer.id ? 'viewer' : 'company_admin' },
      })),
    },
  };
  const permissions = {
    evaluate: jest.fn().mockResolvedValue({
      decision: 'ALLOW',
      reason: 'PROFILE_POLICY',
      scopeDigest: 'scope',
    }),
  };
  return {
    prisma,
    permissions,
    service: new OutboundComplianceService(prisma, permissions as any),
  };
}

function emailRequest(overrides: Record<string, unknown> = {}) {
  return {
    companyId,
    operatorUser: admin,
    actorType: 'HUMAN' as const,
    channel: 'EMAIL' as const,
    actionType: 'RAW_SMTP',
    idempotencyKey: 'email:test-0001',
    leadId: 'lead-1',
    targetAddress: 'buyer@example.com',
    emailAccountId: 'account-1',
    subject: 'Approved follow-up',
    body: '<p>Hello buyer</p>',
    requireAdmin: true,
    ...overrides,
  };
}

describe('OutboundComplianceService target and suppression checks', () => {
  it('fails closed for unverified, unsubscribed, blacklisted and cross-tenant email targets', async () => {
    const { service, prisma } = createService();
    const baseLead = {
      id: 'lead-1',
      companyId,
      contactEmail: 'buyer@example.com',
      emailVerificationStatus: 'unverified',
      status: 'contacted',
      reviewStatus: 'approved',
    };
    prisma.lead.findFirst.mockResolvedValue(baseLead);
    prisma.emailAccount.findFirst.mockResolvedValue({
      id: 'account-1',
      companyId,
      userId: null,
      senderEmail: 'sales@example.org',
      dailySendLimit: 50,
      hourlySendLimit: 10,
    });
    prisma.unsubscribeRecord.findFirst.mockResolvedValue(null);
    prisma.blacklistRecord.findFirst.mockResolvedValue(null);
    prisma.externalSuppression.findFirst.mockResolvedValue(null);

    await expect((service as any).validateEmailTarget(prisma, emailRequest()))
      .rejects.toThrow(/not verified/i);

    prisma.lead.findFirst.mockResolvedValue({
      ...baseLead,
      emailVerificationStatus: 'smtp_verified',
      emailVerifiedAddressHash: emailAddressEvidenceHash('buyer@example.com'),
    });
    prisma.unsubscribeRecord.findFirst.mockResolvedValue({ id: 'unsub-1' });
    await expect((service as any).validateEmailTarget(prisma, emailRequest()))
      .rejects.toThrow(/unsubscribed/i);

    prisma.unsubscribeRecord.findFirst.mockResolvedValue(null);
    prisma.blacklistRecord.findFirst.mockResolvedValue({ id: 'blacklist-1' });
    await expect((service as any).validateEmailTarget(prisma, emailRequest()))
      .rejects.toThrow(/blacklisted/i);

    prisma.blacklistRecord.findFirst.mockResolvedValue(null);
    prisma.lead.findFirst.mockResolvedValue(null);
    await expect((service as any).validateEmailTarget(prisma, emailRequest()))
      .rejects.toThrow(/outside the tenant/i);
  });

  it.each([
    [{ reviewStatus: 'pending' }, 'not approved'],
    [{ reviewStatus: 'needs_enrichment' }, 'not approved'],
    [{ status: 'paused' }, 'contactable'],
  ])('rejects email delivery after lead lifecycle drift: %j', async (override, expected) => {
    const { service, prisma } = createService();
    prisma.emailAccount.findFirst.mockResolvedValue({
      id: 'account-1',
      companyId,
      userId: null,
      senderEmail: 'sales@example.org',
      dailySendLimit: 50,
      hourlySendLimit: 10,
    });
    prisma.lead.findFirst.mockResolvedValue({
      id: 'lead-1',
      companyId,
      contactEmail: 'buyer@example.com',
      emailVerificationStatus: 'smtp_verified',
      emailVerifiedAddressHash: emailAddressEvidenceHash('buyer@example.com'),
      status: 'contacted',
      reviewStatus: 'approved',
      ownerUserId: admin.id,
      ...override,
    });

    await expect((service as any).validateEmailTarget(prisma, emailRequest()))
      .rejects.toThrow(new RegExp(expected, 'i'));
    expect(prisma.unsubscribeRecord.findFirst).not.toHaveBeenCalled();
  });

  it('requires a verified WhatsApp contact point and honors lead/phone suppression', async () => {
    const { service, prisma } = createService();
    const request = {
      ...emailRequest(),
      channel: 'WHATSAPP',
      actionType: 'WHATSAPP_TEXT',
      targetAddress: '+12025550123',
      whatsappSessionId: 'wa-1',
      conversationId: 'conversation-1',
      body: 'Hello',
    };
    prisma.whatsAppSession.findFirst.mockResolvedValue({ id: 'wa-1', sessionId: 'provider-session' });
    prisma.conversation.findFirst.mockResolvedValue({
      id: 'conversation-1',
      threadKey: 'whatsapp:wa-1:12025550123@s.whatsapp.net',
      externalThreadId: '12025550123@s.whatsapp.net',
      contactPoint: null,
      lead: {
        id: 'lead-1', status: 'contacted', reviewStatus: 'approved',
        deletedAt: null, isMerged: false, mergedToId: null,
        whatsapp: '+12025550123', contactPhone: null,
      },
    });
    await expect((service as any).validateWhatsappTarget(prisma, request))
      .rejects.toThrow(/verified contact point/i);

    prisma.conversation.findFirst.mockResolvedValue({
      id: 'conversation-1',
      threadKey: 'whatsapp:wa-1:12025550123@s.whatsapp.net',
      externalThreadId: '12025550123@s.whatsapp.net',
      contactPoint: {
        id: 'point-1',
        leadId: 'lead-1',
        normalizedValue: '+12025550999',
        isVerified: true,
        verificationMethod: 'baileys_inbound',
        type: 'whatsapp',
      },
      lead: {
        id: 'lead-1', status: 'contacted', reviewStatus: 'approved',
        deletedAt: null, isMerged: false, mergedToId: null,
        whatsapp: '+12025550123', contactPhone: null,
      },
    });
    await expect((service as any).validateWhatsappTarget(prisma, request))
      .rejects.toThrow(/verified contact point/i);

    prisma.conversation.findFirst.mockResolvedValue({
      id: 'conversation-1',
      threadKey: 'whatsapp:wa-1:12025550123@s.whatsapp.net',
      externalThreadId: '12025550123@s.whatsapp.net',
      contactPoint: {
        id: 'point-1',
        leadId: 'lead-1',
        normalizedValue: '+12025550123',
        isVerified: true,
        verificationMethod: 'baileys_inbound',
        type: 'whatsapp',
      },
      lead: {
        id: 'lead-1', status: 'contacted', reviewStatus: 'approved',
        deletedAt: null, isMerged: false, mergedToId: null,
        whatsapp: '+12025550123', contactPhone: null,
      },
    });
    prisma.unsubscribeRecord.findFirst.mockResolvedValue({ id: 'unsubscribed-lead-1' });
    await expect((service as any).validateWhatsappTarget(prisma, request))
      .rejects.toThrow(/unsubscribed/i);

    prisma.unsubscribeRecord.findFirst.mockResolvedValue(null);
    prisma.externalSuppression.findFirst.mockResolvedValue({ id: 'suppression-1' });
    await expect((service as any).validateWhatsappTarget(prisma, request))
      .rejects.toThrow(/suppressed/i);
  });

  it.each([
    [{ deletedAt: new Date() }, 'deleted'],
    [{ reviewStatus: 'manual_review' }, 'not approved'],
    [{ reviewStatus: 'rejected' }, 'not approved'],
    [{ isMerged: true, mergedToId: 'lead-primary' }, 'merged'],
    [{ status: 'lost' }, 'suppressed'],
  ])('rejects WhatsApp delivery when the bound lead is %j', async (leadOverride, expected) => {
    const { service, prisma } = createService();
    prisma.whatsAppSession.findFirst.mockResolvedValue({ id: 'wa-1', sessionId: 'provider-session' });
    prisma.conversation.findFirst.mockResolvedValue({
      id: 'conversation-1',
      threadKey: 'whatsapp:wa-1:12025550123@s.whatsapp.net',
      externalThreadId: '12025550123@s.whatsapp.net',
      contactPoint: {
        id: 'point-1',
        leadId: 'lead-1',
        normalizedValue: '+12025550123',
        isVerified: true,
        verificationMethod: 'baileys_inbound',
        type: 'whatsapp',
      },
      lead: {
        id: 'lead-1',
        status: 'contacted',
        reviewStatus: 'approved',
        deletedAt: null,
        isMerged: false,
        mergedToId: null,
        whatsapp: '+12025550123',
        contactPhone: null,
        ...leadOverride,
      },
    });
    await expect((service as any).validateWhatsappTarget(prisma, {
      ...emailRequest(),
      channel: 'WHATSAPP',
      actionType: 'WHATSAPP_TEXT',
      targetAddress: '+12025550123',
      whatsappSessionId: 'wa-1',
      conversationId: 'conversation-1',
      body: 'Hello',
    })).rejects.toThrow(new RegExp(expected, 'i'));
  });

  it.each([
    ['forged manual verification', { verificationMethod: 'whatsapp_jid' }, {}, /verified contact point/i],
    ['missing provider identity', {}, { externalIdentity: null }, /consistently bound/i],
    ['session-thread mismatch', {}, { threadKey: 'whatsapp:other-session:12025550123@s.whatsapp.net' }, /consistently bound/i],
  ])('rejects a WhatsApp target with %s', async (_label, pointOverride, bindingOverride, expected) => {
    const { service, prisma } = createService();
    const binding: any = bindingOverride;
    prisma.whatsAppSession.findFirst.mockResolvedValue({ id: 'wa-1', sessionId: 'provider-session' });
    if ('externalIdentity' in binding) {
      prisma.externalIdentity.findFirst.mockResolvedValue(binding.externalIdentity);
    }
    prisma.conversation.findFirst.mockResolvedValue({
      id: 'conversation-1',
      threadKey: binding.threadKey
        || 'whatsapp:wa-1:12025550123@s.whatsapp.net',
      externalThreadId: '12025550123@s.whatsapp.net',
      contactPoint: {
        id: 'point-1',
        leadId: 'lead-1',
        normalizedValue: '+12025550123',
        isVerified: true,
        verificationMethod: 'baileys_inbound',
        type: 'whatsapp',
        ...pointOverride,
      },
      lead: {
        id: 'lead-1',
        status: 'contacted',
        reviewStatus: 'approved',
        deletedAt: null,
        isMerged: false,
        mergedToId: null,
        whatsapp: '+12025550123',
        contactPhone: null,
      },
    });

    await expect((service as any).validateWhatsappTarget(prisma, {
      ...emailRequest(),
      channel: 'WHATSAPP',
      actionType: 'WHATSAPP_TEXT',
      targetAddress: '+12025550123',
      whatsappSessionId: 'wa-1',
      conversationId: 'conversation-1',
      body: 'Hello',
    })).rejects.toThrow(expected);
  });

  it('enforces assigned, shared and manager/admin email-account ownership centrally', async () => {
    const { service, prisma } = createService();
    const salesUser = {
      id: 'sales-1',
      activeCompanyId: companyId,
      companies: [{ id: companyId, role: 'sales_user' }],
    };
    const salesManager = {
      id: 'manager-1',
      activeCompanyId: companyId,
      companies: [{ id: companyId, role: 'sales_manager' }],
    };
    prisma.userCompanyRelation.findFirst.mockImplementation(({ where }: any) => Promise.resolve({
      role: {
        name: where.userId === salesUser.id
          ? 'sales_user'
          : where.userId === salesManager.id
            ? 'sales_manager'
            : 'company_admin',
      },
    }));
    prisma.emailAccount.findFirst.mockResolvedValue({
      id: 'account-1',
      companyId,
      userId: 'other-sales-user',
      senderEmail: 'assigned@example.org',
      dailySendLimit: 50,
      hourlySendLimit: 10,
    });
    await expect(service.assertEmailAccountAccess(
      companyId,
      'account-1',
      salesUser,
    )).rejects.toThrow(/assigned to another/i);
    await expect(service.assertEmailAccountAccess(
      companyId,
      'account-1',
      salesManager,
    )).rejects.toThrow(/assigned to another/i);

    await expect(service.assertEmailAccountAccess(
      companyId,
      'account-1',
      admin,
    )).resolves.toMatchObject({ userId: 'other-sales-user' });

    prisma.emailAccount.findFirst.mockResolvedValue({
      id: 'account-1',
      companyId,
      userId: null,
      senderEmail: 'shared@example.org',
      dailySendLimit: 50,
      hourlySendLimit: 10,
    });
    await expect(service.assertEmailAccountAccess(
      companyId,
      'account-1',
      salesUser,
    )).resolves.toMatchObject({ userId: null });
  });

  it('denies cross-sales lead and conversation dispatch within the same tenant', async () => {
    const { service, prisma } = createService();
    const salesA = {
      id: 'sales-a',
      activeCompanyId: companyId,
      companies: [{ id: companyId, role: 'sales_user' }],
    };
    prisma.userCompanyRelation.findFirst.mockResolvedValue({
      role: { name: 'sales_user' },
    });
    prisma.emailAccount.findFirst.mockResolvedValue({
      id: 'account-1', companyId, userId: null, senderEmail: 'shared@example.org',
      dailySendLimit: 50, hourlySendLimit: 10,
    });
    prisma.lead.findFirst.mockResolvedValue({
      id: 'lead-1',
      companyId,
      ownerUserId: 'sales-b',
      contactEmail: 'buyer@example.com',
      emailVerificationStatus: 'smtp_verified',
      emailVerifiedAddressHash: emailAddressEvidenceHash('buyer@example.com'),
      status: 'contacted',
      reviewStatus: 'approved',
    });
    await expect((service as any).validateEmailTarget(prisma, emailRequest({
      operatorUser: salesA,
      requireAdmin: false,
    }))).rejects.toThrow(/assigned to another/i);
    const emailProvider = jest.fn();
    await expect(service.execute(emailRequest({
      operatorUser: salesA,
      requireAdmin: false,
      actionType: 'MARKETING_EMAIL',
    }), emailProvider)).rejects.toThrow(/assigned to another/i);
    expect(emailProvider).not.toHaveBeenCalled();

    prisma.whatsAppSession.findFirst.mockResolvedValue({ id: 'wa-1', sessionId: 'provider-session' });
    prisma.conversation.findFirst.mockResolvedValue({
      id: 'conversation-1',
      assignedUserId: 'sales-b',
      threadKey: 'whatsapp:wa-1:12025550123@s.whatsapp.net',
      externalThreadId: '12025550123@s.whatsapp.net',
      contactPoint: {
        id: 'point-1', leadId: 'lead-1', normalizedValue: '+12025550123',
        isVerified: true, verificationMethod: 'baileys_inbound', type: 'whatsapp',
      },
      lead: {
        id: 'lead-1', ownerUserId: 'sales-b', status: 'contacted', reviewStatus: 'approved',
        deletedAt: null, isMerged: false, mergedToId: null,
        whatsapp: '+12025550123', contactPhone: null,
      },
    });
    await expect((service as any).validateWhatsappTarget(prisma, {
      ...emailRequest({ operatorUser: salesA, requireAdmin: false }),
      channel: 'WHATSAPP',
      actionType: 'WHATSAPP_TEXT',
      targetAddress: '+12025550123',
      whatsappSessionId: 'wa-1',
      conversationId: 'conversation-1',
    })).rejects.toThrow(/assigned to another/i);
    const whatsappProvider = jest.fn();
    await expect(service.execute({
      ...emailRequest({
        operatorUser: salesA,
        requireAdmin: false,
      }),
      channel: 'WHATSAPP',
      actionType: 'WHATSAPP_TEXT',
      targetAddress: '+12025550123',
      whatsappSessionId: 'wa-1',
      conversationId: 'conversation-1',
    }, whatsappProvider)).rejects.toThrow(/assigned to another/i);
    expect(whatsappProvider).not.toHaveBeenCalled();
  });

  it('rejects viewer raw sends at the service layer', async () => {
    const { service } = createService();
    await expect(service.execute(emailRequest({ operatorUser: viewer }), jest.fn()))
      .rejects.toBeInstanceOf(ForbiddenException);
  });

  it('requires the explicit authenticated active company even for a global administrator', async () => {
    const { service } = createService();
    const globalAdmin = {
      id: 'global-admin-1',
      activeCompanyId: 'company-2',
      activeCompany: { id: 'company-2', role: 'super_admin' },
      companies: [
        { id: companyId, role: 'super_admin' },
        { id: 'company-2', role: 'super_admin' },
      ],
    };
    await expect(service.execute(emailRequest({ operatorUser: globalAdmin }), jest.fn()))
      .rejects.toThrow(/authenticated active company/i);
  });

  it('requires a direct active target-company relation for global superadmin provider I/O', async () => {
    const { service, prisma } = createService();
    const provider = jest.fn();
    prisma.userCompanyRelation.findFirst.mockResolvedValue(null);
    const globalAdmin = {
      id: 'global-admin-1',
      isSuperAdmin: true,
      activeCompanyId: companyId,
      activeCompany: { id: companyId, role: 'super_admin' },
      companies: [],
    };

    await expect(service.execute(emailRequest({
      operatorUser: globalAdmin,
    }), provider)).rejects.toThrow(/membership or role is no longer active/i);
    expect(provider).not.toHaveBeenCalled();
    expect(prisma.emailAccount.findFirst).not.toHaveBeenCalled();
  });

  it('does not reveal same-tenant account existence before membership authorization', async () => {
    const { service, prisma } = createService();
    prisma.userCompanyRelation.findFirst.mockResolvedValue(null);
    const staleUser = {
      id: 'stale-user',
      activeCompanyId: companyId,
      activeCompany: { id: companyId, role: 'sales_user' },
      companies: [{ id: companyId, role: 'sales_user' }],
    };

    for (const accountId of ['existing-account', 'missing-account']) {
      await expect(service.assertEmailAccountAccess(
        companyId,
        accountId,
        staleUser,
      )).rejects.toThrow(/membership or role is no longer active/i);
    }
    expect(prisma.emailAccount.findFirst).not.toHaveBeenCalled();
  });

  it('never falls back to companies[0] when activeCompanyId is absent', async () => {
    const { service } = createService();
    await expect(service.execute(emailRequest({
      operatorUser: {
        id: admin.id,
        companies: [{ id: companyId, role: 'company_admin' }],
      },
    }), jest.fn())).rejects.toThrow(/authenticated active company/i);
  });
});

describe('OutboundComplianceService provider state machine', () => {
  const pending = {
    id: 'outbox-1',
    companyId,
    status: ExternalActionStatus.PENDING,
    maxAttempts: 3,
    attemptCount: 0,
    provider: null,
    providerReceiptId: null,
    operatorUserId: admin.id,
    actorType: 'HUMAN',
    operatorRole: 'company_admin',
    attemptVersion: 0,
    expiresAt: new Date(Date.now() + 60_000),
  };

  function allowClaimValidation(service: OutboundComplianceService) {
    jest.spyOn(service as any, 'validateEmailTarget').mockResolvedValue({
      targetType: 'lead',
      targetId: 'lead-1',
      targetAddressHash: 'target-hash',
      targetDomain: 'example.com',
      snapshot: {},
      checks: [],
      limits: { hourly: 10, daily: 50, contactDaily: 5, domainDaily: 100 },
    });
    jest.spyOn(service as any, 'enforceRateLimits').mockResolvedValue(undefined);
  }

  function sensitiveAdminRow(overrides: Record<string, unknown> = {}) {
    return {
      ...pending,
      id: 'action-row-1',
      idempotencyKey: 'email-message:message-sentinel',
      channel: ExternalActionChannel.EMAIL,
      actionType: 'MARKETING_EMAIL',
      status: ExternalActionStatus.UNKNOWN,
      targetType: 'lead',
      targetId: 'target-row-1',
      targetAddressHash: 'target-address-hash',
      targetDomain: 'sentinel.example',
      targetSnapshot: {
        normalizedTarget: 'sentinel-recipient@example.com',
        leadId: 'lead-row-1',
      },
      payloadDigest: 'payload-row-1',
      contentSnapshot: {
        subject: 'SENTINEL_SUBJECT',
        body: 'SENTINEL_BODY',
        artifacts: [{
          size: 12,
          mimeType: 'application/pdf',
          filename: 'C:\\sentinel\\attachment.pdf',
        }],
      },
      policySnapshot: { operatorUserId: 'SENTINEL_OPERATOR', target: 'SENTINEL_POLICY' },
      approvalId: 'approval-row-1',
      provider: 'smtp',
      providerReceiptId: 'receipt-row-1',
      providerReceipt: {
        metadata: {
          raw: 'SENTINEL_PROVIDER_RESPONSE',
          url: 'https://provider.example/?token=SENTINEL_TOKEN',
        },
      },
      lastErrorCode: 'PROVIDER_ERROR',
      lastError: 'SENTINEL_PROVIDER_RAW sentinel-recipient@example.com',
      createdAt: new Date('2026-07-28T12:00:00.000Z'),
      updatedAt: new Date('2026-07-28T12:01:00.000Z'),
      ...overrides,
    };
  }

  function expectSafeAdminProjection(
    value: any,
    expectedStatus: ExternalActionStatus = ExternalActionStatus.UNKNOWN,
  ) {
    const serialized = JSON.stringify(value);
    for (const sentinel of [
      'SENTINEL_SUBJECT',
      'SENTINEL_BODY',
      'SENTINEL_OPERATOR',
      'SENTINEL_POLICY',
      'SENTINEL_PROVIDER_RESPONSE',
      'SENTINEL_PROVIDER_RAW',
      'SENTINEL_TOKEN',
      'sentinel-recipient@example.com',
      'C:\\sentinel\\attachment.pdf',
    ]) {
      expect(serialized).not.toContain(sentinel);
    }
    expect(value).toEqual(expect.objectContaining({
      id: 'action-row-1',
      actionIdDigest: expect.stringMatching(/^sha256:outbound-action:/),
      idempotencyKeyDigest: expect.stringMatching(/^sha256:outbound-idempotency:/),
      targetIdDigest: expect.stringMatching(/^sha256:outbound-target:/),
      providerReceiptPresent: true,
      providerReceiptIdDigest: expect.stringMatching(/^sha256:outbound-provider-receipt:/),
      approvalPresent: true,
      status: expectedStatus,
      channel: ExternalActionChannel.EMAIL,
      actionType: 'MARKETING_EMAIL',
      lastErrorCode: 'PROVIDER_ERROR',
      lastErrorCategory: expect.any(String),
      artifactCount: 1,
      artifactBytes: 12,
    }));
    for (const forbiddenKey of [
      'targetSnapshot',
      'contentSnapshot',
      'policySnapshot',
      'providerReceipt',
      'lastError',
      'leaseToken',
      'operatorUserId',
      'idempotencyKey',
      'normalizedTarget',
    ]) {
      expect(value).not.toHaveProperty(forbiddenKey);
    }
  }

  it('records a provider receipt only after success and replays it without another call', async () => {
    const { service, prisma } = createService();
    allowClaimValidation(service);
    jest.spyOn(service as any, 'reserve').mockResolvedValue(pending);
    prisma.externalActionOutbox.updateMany
      .mockResolvedValueOnce({ count: 1 })
      .mockResolvedValueOnce({ count: 1 });
    const provider = jest.fn().mockResolvedValue({
      provider: 'smtp',
      receiptId: 'provider-message-1',
      acceptedAt: new Date(),
    });
    await expect(service.execute(emailRequest(), provider)).resolves.toMatchObject({
      outboxId: 'outbox-1',
      deduplicated: false,
      receipt: { receiptId: 'provider-message-1' },
    });
    expect(provider).toHaveBeenCalledTimes(1);
    const claimWrite = prisma.externalActionOutbox.updateMany.mock.calls[0][0];
    const receiptWrite = prisma.externalActionOutbox.updateMany.mock.calls[1][0];
    expect(claimWrite.data).toMatchObject({
      leaseToken: expect.stringMatching(/^[0-9a-f-]{36}$/),
      attemptVersion: 1,
    });
    expect(receiptWrite.where).toMatchObject({
      leaseToken: claimWrite.data.leaseToken,
      attemptVersion: 1,
    });

    (service as any).reserve.mockResolvedValue({
      ...pending,
      status: ExternalActionStatus.SUCCEEDED,
      provider: 'smtp',
      providerReceiptId: 'provider-message-1',
      acceptedAt: new Date(),
    });
    await service.execute(emailRequest(), provider);
    expect(provider).toHaveBeenCalledTimes(1);
  });

  it('copies artifacts once and dispatches the exact bytes object used for reservation', async () => {
    const { service, prisma } = createService();
    allowClaimValidation(service);
    const original = Buffer.from('%PDF-original');
    let reservedBytes: Buffer | undefined;
    jest.spyOn(service as any, 'reserve').mockImplementation(async (request: any) => {
      reservedBytes = request.artifacts[0].bytes;
      original.fill(0);
      return pending;
    });
    prisma.externalActionOutbox.updateMany.mockResolvedValue({ count: 1 });
    let dispatchedBytes: Buffer | undefined;

    await service.execute(emailRequest({
      artifacts: [{
        sourceId: 'quote:quote-1',
        bytes: original,
        mimeType: 'application/pdf',
        filename: 'quote.pdf',
      }],
    }), async (artifacts) => {
      dispatchedBytes = artifacts[0].bytes;
      return { provider: 'smtp', receiptId: 'artifact-message-1' };
    });

    expect(reservedBytes).toBe(dispatchedBytes);
    expect(dispatchedBytes).not.toBe(original);
    expect(dispatchedBytes?.toString()).toBe('%PDF-original');
  });

  it('dispatches only the canonical envelope that was reserved and digested', async () => {
    const { service, prisma } = createService();
    allowClaimValidation(service);
    let reserved: any;
    jest.spyOn(service as any, 'reserve').mockImplementation(async (request: any) => {
      reserved = request;
      return pending;
    });
    prisma.externalActionOutbox.updateMany.mockResolvedValue({ count: 1 });
    const provider = jest.fn(async (_artifacts, envelope) => ({
      provider: 'smtp',
      receiptId: 'canonical-message-1',
      metadata: {
        target: envelope.targetAddress,
        subject: envelope.subject,
        body: envelope.body,
      },
    }));

    await service.execute(emailRequest({
      targetAddress: ' Buyer@Example.COM ',
      subject: '  Canonical subject  ',
      body: '  Canonical body  ',
    }), provider);

    expect(reserved).toMatchObject({
      targetAddress: 'buyer@example.com',
      subject: 'Canonical subject',
      body: 'Canonical body',
    });
    expect(provider).toHaveBeenCalledWith(expect.any(Array), expect.objectContaining({
      targetAddress: 'buyer@example.com',
      subject: 'Canonical subject',
      body: 'Canonical body',
      signal: expect.any(AbortSignal),
    }));
  });

  it('bounds a slow provider dispatch and fences it as UNKNOWN', async () => {
    jest.useFakeTimers();
    try {
      const { service, prisma } = createService();
      allowClaimValidation(service);
      jest.spyOn(service as any, 'reserve').mockResolvedValue(pending);
      prisma.externalActionOutbox.updateMany.mockResolvedValue({ count: 1 });
      let observedSignal: AbortSignal | undefined;
      const provider = jest.fn((_artifacts, envelope): Promise<any> => {
        observedSignal = envelope.signal;
        return new Promise(() => undefined);
      });

      const execution = service.execute(emailRequest(), provider);
      const rejection = expect(execution).rejects.toThrow(/bounded execution window/i);
      await jest.advanceTimersByTimeAsync(45_000);
      await rejection;
      expect(observedSignal?.aborted).toBe(true);
      expect(prisma.externalActionOutbox.updateMany.mock.calls.at(-1)[0].data.status)
        .toBe(ExternalActionStatus.UNKNOWN);
    } finally {
      jest.useRealTimers();
    }
  });

  it('separates explicit failure from ambiguous timeout and blocks UNKNOWN retry', async () => {
    const { service, prisma } = createService();
    allowClaimValidation(service);
    jest.spyOn(service as any, 'reserve').mockResolvedValue(pending);
    prisma.externalActionOutbox.updateMany.mockResolvedValue({ count: 1 });

    await expect(service.execute(emailRequest(), async () => {
      const error: any = new ServiceUnavailableException('provider rejected');
      error.providerDeliveryOutcome = 'REJECTED';
      error.providerAccepted = false;
      throw error;
    })).rejects.toBeInstanceOf(ServiceUnavailableException);
    expect(prisma.externalActionOutbox.updateMany.mock.calls.at(-1)[0].data.status)
      .toBe(ExternalActionStatus.FAILED);

    await expect(service.execute(emailRequest(), async () => {
      const error: any = new Error('socket timed out');
      error.code = 'ETIMEDOUT';
      throw error;
    })).rejects.toThrow(/timed out/i);
    expect(prisma.externalActionOutbox.updateMany.mock.calls.at(-1)[0].data.status)
      .toBe(ExternalActionStatus.UNKNOWN);

    await expect(service.execute(emailRequest(), async () => {
      throw new BadRequestException('provider response parser rejected the response');
    })).rejects.toBeInstanceOf(BadRequestException);
    expect(prisma.externalActionOutbox.updateMany.mock.calls.at(-1)[0].data.status)
      .toBe(ExternalActionStatus.UNKNOWN);

    (service as any).reserve.mockResolvedValue({ ...pending, status: ExternalActionStatus.UNKNOWN });
    await expect(service.execute(emailRequest(), jest.fn()))
      .rejects.toBeInstanceOf(ConflictException);
  });

  it('does not claim FAILED work before nextAttemptAt and terminalizes exhausted attempts', async () => {
    const { service, prisma } = createService();
    allowClaimValidation(service);
    const provider = jest.fn();
    jest.spyOn(service as any, 'reserve').mockResolvedValue({
      ...pending,
      status: ExternalActionStatus.FAILED,
      attemptCount: 1,
      nextAttemptAt: new Date(Date.now() + 60_000),
    });
    await expect(service.execute(emailRequest(), provider)).rejects.toThrow(/not due yet/i);
    expect(provider).not.toHaveBeenCalled();

    (service as any).reserve.mockResolvedValue({
      ...pending,
      status: ExternalActionStatus.FAILED,
      attemptCount: 3,
      maxAttempts: 3,
      nextAttemptAt: new Date(Date.now() - 1_000),
    });
    prisma.externalActionOutbox.updateMany.mockResolvedValue({ count: 1 });
    await expect(service.execute(emailRequest(), provider)).rejects.toThrow(/exhausted/i);
    expect(prisma.externalActionOutbox.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        nextAttemptAt: null,
        lastErrorCode: 'MAX_ATTEMPTS_EXHAUSTED',
      }),
    }));
    expect(provider).not.toHaveBeenCalled();
  });

  it('treats a duplicate provider receipt as UNKNOWN so it cannot trigger another send', async () => {
    const { service, prisma } = createService();
    allowClaimValidation(service);
    jest.spyOn(service as any, 'reserve').mockResolvedValue(pending);
    const uniqueError: any = new Error('duplicate receipt');
    uniqueError.code = 'P2002';
    prisma.externalActionOutbox.updateMany
      .mockResolvedValueOnce({ count: 1 })
      .mockRejectedValueOnce(uniqueError)
      .mockResolvedValueOnce({ count: 1 });
    await expect(service.execute(emailRequest(), async () => ({
      provider: 'smtp',
      receiptId: 'already-recorded',
    }))).rejects.toMatchObject({ code: 'P2002' });
    expect(prisma.externalActionOutbox.updateMany.mock.calls.at(-1)[0].data.status)
      .toBe(ExternalActionStatus.UNKNOWN);
  });

  it('revalidates suppression immediately before retrying an existing FAILED action', async () => {
    const { service, prisma } = createService();
    prisma.externalActionOutbox.findUnique.mockResolvedValue({
      ...pending,
      status: ExternalActionStatus.FAILED,
      payloadDigest: (service as any).digest({
        channel: 'EMAIL',
        actionType: 'RAW_SMTP',
        leadId: 'lead-1',
        targetAddress: 'buyer@example.com',
        emailAccountId: 'account-1',
        whatsappSessionId: null,
        conversationId: null,
        subject: 'Approved follow-up',
        body: '<p>Hello buyer</p>',
        contentType: 'text',
        artifacts: [],
      }),
      channel: 'EMAIL',
      actionType: 'RAW_SMTP',
    });
    jest.spyOn(service as any, 'validateEmailTarget')
      .mockRejectedValue(new ForbiddenException('Target has unsubscribed'));
    await expect((service as any).reserve(emailRequest()))
      .rejects.toThrow(/unsubscribed/i);
  });

  it('moves expired execution leases to UNKNOWN and requires an admin receipt to reconcile success', async () => {
    const { service, prisma } = createService();
    prisma.externalActionOutbox.updateMany.mockResolvedValue({ count: 2 });
    await expect(service.recoverStaleExecuting(companyId, admin))
      .resolves.toEqual({ recoveredToUnknown: 2 });
    expect(prisma.externalActionOutbox.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({
        companyId,
        status: ExternalActionStatus.EXECUTING,
        leaseExpiresAt: expect.objectContaining({ lt: expect.any(Date) }),
      }),
      data: expect.objectContaining({
        status: ExternalActionStatus.UNKNOWN,
        lastErrorCode: 'EXECUTION_LEASE_EXPIRED',
        leaseExpiresAt: null,
      }),
    }));

    prisma.externalActionOutbox.findFirst.mockResolvedValue({
      ...pending,
      companyId,
      status: ExternalActionStatus.UNKNOWN,
    });
    await expect(service.reconcileUnknown(
      companyId,
      'outbox-1',
      'SUCCEEDED',
      admin,
      { reason: 'Provider console review' },
    ))
      .rejects.toThrow(/provider receipt is required/i);

    const duplicateReceipt: any = new Error('duplicate scoped receipt');
    duplicateReceipt.code = 'P2002';
    prisma.externalActionOutbox.updateMany.mockRejectedValueOnce(duplicateReceipt);
    await expect(service.reconcileUnknown(
      companyId,
      'outbox-1',
      'SUCCEEDED',
      admin,
      { reason: 'Provider console review' },
      {
        provider: 'SMTP',
        receiptId: 'already-bound-in-account-scope',
      },
    )).rejects.toThrow(/already bound within this sender scope/i);

    prisma.externalActionOutbox.updateMany.mockResolvedValue({ count: 1 });
    prisma.externalActionOutbox.findUniqueOrThrow.mockResolvedValue({
      ...pending,
      status: ExternalActionStatus.SUCCEEDED,
      provider: 'smtp',
      providerReceiptId: 'reconciled-message-1',
    });
    await service.reconcileUnknown(
      companyId,
      'outbox-1',
      'SUCCEEDED',
      admin,
      { reason: 'Confirmed in SMTP console', evidenceReference: 'ticket:SEC-123' },
      {
        provider: 'SMTP',
        receiptId: 'reconciled-message-1',
      },
    );
    expect(prisma.externalActionOutbox.updateMany).toHaveBeenLastCalledWith(expect.objectContaining({
      where: { id: 'outbox-1', companyId, status: ExternalActionStatus.UNKNOWN },
      data: expect.objectContaining({
        status: ExternalActionStatus.SUCCEEDED,
        provider: 'smtp',
        providerReceiptId: 'reconciled-message-1',
      }),
    }));
  });

  it('projects UNKNOWN email reconciliation idempotently without another provider call', async () => {
    const { service, prisma } = createService();
    const action = {
      ...pending,
      id: 'outbox-email-reconcile',
      companyId,
      idempotencyKey: 'email-message:email-queued-1',
      channel: ExternalActionChannel.EMAIL,
      actionType: 'MARKETING_EMAIL',
      status: ExternalActionStatus.UNKNOWN,
    };
    prisma.externalActionOutbox.findFirst.mockResolvedValue(action);
    prisma.externalActionOutbox.updateMany.mockResolvedValue({ count: 1 });
    prisma.externalActionOutbox.findUniqueOrThrow.mockResolvedValue({
      ...action,
      status: ExternalActionStatus.SUCCEEDED,
      provider: 'smtp',
      providerReceiptId: 'smtp-reconciled-1',
      acceptedAt: new Date('2026-07-29T00:00:00.000Z'),
    });

    await service.reconcileUnknown(
      companyId,
      action.id,
      'SUCCEEDED',
      admin,
      { reason: 'Confirmed in provider console' },
      { provider: 'smtp', receiptId: 'smtp-reconciled-1' },
    );
    await service.reconcileUnknown(
      companyId,
      action.id,
      'SUCCEEDED',
      admin,
      { reason: 'Confirmed in provider console' },
      { provider: 'smtp', receiptId: 'smtp-reconciled-1' },
    ).catch(() => undefined);

    expect(prisma.emailMessage.updateMany).toHaveBeenCalledWith({
      where: { id: 'email-queued-1', companyId },
      data: expect.objectContaining({
        status: 'Sent',
        messageId: 'smtp-reconciled-1',
      }),
    });
  });

  it('rolls back reconciliation when the queued email projection target is missing or cross-tenant', async () => {
    const { service, prisma } = createService();
    const action = {
      ...pending,
      id: 'outbox-email-missing',
      companyId,
      idempotencyKey: 'email-message:email-other-tenant',
      channel: ExternalActionChannel.EMAIL,
      actionType: 'MARKETING_EMAIL',
      status: ExternalActionStatus.UNKNOWN,
    };
    prisma.externalActionOutbox.findFirst.mockResolvedValue(action);
    prisma.externalActionOutbox.updateMany.mockResolvedValue({ count: 1 });
    prisma.externalActionOutbox.findUniqueOrThrow.mockResolvedValue({
      ...action,
      status: ExternalActionStatus.SUCCEEDED,
      provider: 'smtp',
      providerReceiptId: 'smtp-reconciled-missing',
    });
    prisma.emailMessage.updateMany.mockResolvedValue({ count: 0 });

    await expect(service.reconcileUnknown(
      companyId,
      action.id,
      'SUCCEEDED',
      admin,
      { reason: 'Provider console evidence' },
      { provider: 'smtp', receiptId: 'smtp-reconciled-missing' },
    )).rejects.toThrow(/missing or outside the tenant/i);
    expect(prisma.emailMessage.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: 'email-other-tenant', companyId },
    }));
  });

  it('normalizes a cancellation key for both the update and canonical replay lookup', async () => {
    const { service, prisma } = createService();
    prisma.externalActionOutbox.updateMany.mockResolvedValue({ count: 1 });
    prisma.externalActionOutbox.findUniqueOrThrow.mockResolvedValue({
      ...pending,
      status: ExternalActionStatus.CANCELLED,
    });
    await service.cancel(companyId, '  email:test-0001  ', admin);
    expect(prisma.externalActionOutbox.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ companyId, idempotencyKey: 'email:test-0001' }),
    }));
    expect(prisma.externalActionOutbox.findUniqueOrThrow).toHaveBeenCalledWith({
      where: {
        companyId_idempotencyKey: {
          companyId,
          idempotencyKey: 'email:test-0001',
        },
      },
    });
  });

  it('projects every row-returning admin path without exposing snapshots or provider errors', async () => {
    const { service, prisma } = createService();
    const row = sensitiveAdminRow();

    prisma.externalActionOutbox.findMany.mockResolvedValue([row]);
    prisma.externalActionOutbox.count.mockResolvedValue(1);
    const listed = await service.listActions(companyId, admin, { limit: 1 });
    expectSafeAdminProjection(listed.data[0]);

    prisma.externalActionOutbox.findFirst.mockResolvedValue(row);
    expectSafeAdminProjection(await service.getAction(companyId, row.id, admin));

    prisma.externalActionOutbox.findUnique.mockResolvedValue(row);
    expectSafeAdminProjection(await service.getActionByKey(companyId, row.idempotencyKey, admin));

    prisma.externalActionOutbox.updateMany.mockResolvedValue({ count: 1 });
    prisma.externalActionOutbox.findUniqueOrThrow.mockResolvedValue({
      ...row,
      status: ExternalActionStatus.CANCELLED,
    });
    const cancelled = await service.cancel(companyId, row.idempotencyKey, admin);
    expectSafeAdminProjection(cancelled, ExternalActionStatus.CANCELLED);

    prisma.externalActionOutbox.findFirst.mockResolvedValue(row);
    prisma.externalActionOutbox.findUniqueOrThrow.mockResolvedValue({
      ...row,
      status: ExternalActionStatus.SUCCEEDED,
    });
    const reconciled = await service.reconcileUnknown(
      companyId,
      row.id,
      'SUCCEEDED',
      admin,
      { reason: 'Provider console confirmation' },
      { provider: 'smtp', receiptId: 'receipt-row-1' },
    );
    expectSafeAdminProjection(reconciled, ExternalActionStatus.SUCCEEDED);
  });

  it('paginates UNKNOWN actions with a stable createdAt plus id cursor', async () => {
    const { service, prisma } = createService();
    const createdAt = new Date('2026-07-28T12:00:00.000Z');
    prisma.externalActionOutbox.findMany.mockResolvedValue([
      { id: 'outbox-c', createdAt },
      { id: 'outbox-b', createdAt },
      { id: 'outbox-a', createdAt },
    ]);
    prisma.externalActionOutbox.count.mockResolvedValue(151);

    const first = await service.listActions(companyId, admin, {
      status: ExternalActionStatus.UNKNOWN,
      limit: 2,
    });
    expect(first).toMatchObject({
      data: [{ id: 'outbox-c' }, { id: 'outbox-b' }],
      hasMore: true,
      nextCursor: expect.any(String),
      unknownTotal: 151,
    });
    expect(first.data[1].id).toBe('outbox-b');

    prisma.externalActionOutbox.findMany.mockResolvedValue([]);
    await service.listActions(companyId, admin, {
      status: ExternalActionStatus.UNKNOWN,
      limit: 2,
      cursor: first.nextCursor!,
    });
    expect(prisma.externalActionOutbox.findMany).toHaveBeenLastCalledWith(expect.objectContaining({
      where: expect.objectContaining({
        companyId,
        OR: [
          { createdAt: { lt: createdAt } },
          { createdAt, id: { lt: 'outbox-b' } },
        ],
      }),
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: 3,
    }));
  });

  it('rejects blank manual reconciliation reason and receipt values', async () => {
    const { service, prisma } = createService();
    prisma.externalActionOutbox.findFirst.mockResolvedValue({
      ...pending,
      companyId,
      status: ExternalActionStatus.UNKNOWN,
    });
    await expect(service.reconcileUnknown(
      companyId,
      'outbox-1',
      'FAILED',
      admin,
      { reason: '   ' },
    )).rejects.toThrow(/non-blank reconciliation reason/i);
    await expect(service.reconcileUnknown(
      companyId,
      'outbox-1',
      'SUCCEEDED',
      admin,
      { reason: 'Checked provider console' },
      { provider: '   ', receiptId: '   ' },
    )).rejects.toThrow(/non-blank provider receipt/i);
    expect(prisma.externalActionOutbox.updateMany).not.toHaveBeenCalled();
  });

  it('replays the canonical outbox row after a concurrent unique-key reservation race', async () => {
    const { service, prisma } = createService();
    const uniqueError: any = new Error('concurrent unique key');
    uniqueError.code = 'P2002';
    prisma.$transaction.mockRejectedValue(uniqueError);
    const request = emailRequest();
    const replay = {
      ...pending,
      idempotencyKey: request.idempotencyKey,
      channel: ExternalActionChannel.EMAIL,
      actionType: 'RAW_SMTP',
      payloadDigest: (service as any).digest({
        channel: 'EMAIL',
        actionType: 'RAW_SMTP',
        leadId: 'lead-1',
        targetAddress: 'buyer@example.com',
        emailAccountId: 'account-1',
        whatsappSessionId: null,
        conversationId: null,
        subject: 'Approved follow-up',
        body: '<p>Hello buyer</p>',
        contentType: 'text',
        artifacts: [],
      }),
    };
    prisma.externalActionOutbox.findUnique.mockResolvedValue(replay);
    await expect((service as any).reserve(request)).resolves.toBe(replay);
  });

  it('marks an expired pending action terminal before any provider call', async () => {
    const { service, prisma } = createService();
    allowClaimValidation(service);
    jest.spyOn(service as any, 'reserve').mockResolvedValue({
      ...pending,
      expiresAt: new Date(Date.now() - 1_000),
    });
    prisma.externalActionOutbox.updateMany
      .mockResolvedValueOnce({ count: 0 })
      .mockResolvedValueOnce({ count: 1 });
    prisma.externalActionOutbox.findUniqueOrThrow.mockResolvedValue({
      ...pending,
      expiresAt: new Date(Date.now() - 1_000),
    });
    const provider = jest.fn();
    await expect(service.execute(emailRequest(), provider)).rejects.toThrow(/terminal: EXPIRED/i);
    expect(provider).not.toHaveBeenCalled();
    expect(prisma.externalActionOutbox.updateMany).toHaveBeenLastCalledWith(expect.objectContaining({
      data: expect.objectContaining({ status: ExternalActionStatus.EXPIRED }),
    }));
  });
});

describe('OutboundComplianceService real reservation core', () => {
  function prepareEmailCore() {
    const harness = createService();
    const { prisma } = harness;
    prisma.lead.findFirst.mockResolvedValue({
      id: 'lead-1',
      companyId,
      contactEmail: 'buyer@example.com',
      emailVerificationStatus: 'smtp_verified',
      emailVerifiedAddressHash: emailAddressEvidenceHash('buyer@example.com'),
      status: 'contacted',
      reviewStatus: 'approved',
      ownerUserId: admin.id,
    });
    prisma.emailAccount.findFirst.mockResolvedValue({
      id: 'account-1',
      companyId,
      userId: admin.id,
      senderEmail: 'sales@example.org',
      dailySendLimit: 50,
      hourlySendLimit: 10,
    });
    prisma.unsubscribeRecord.findFirst.mockResolvedValue(null);
    prisma.blacklistRecord.findFirst.mockResolvedValue(null);
    prisma.externalSuppression.findFirst.mockResolvedValue(null);
    let stored: any = null;
    prisma.externalActionOutbox.findUnique.mockImplementation(async ({ where }: any) => (
      stored?.idempotencyKey === where?.companyId_idempotencyKey?.idempotencyKey
        ? stored
        : null
    ));
    prisma.externalActionOutbox.create.mockImplementation(async ({ data }: any) => {
      stored = {
        id: 'outbox-core-1',
        status: ExternalActionStatus.PENDING,
        attemptCount: 0,
        attemptVersion: 0,
        maxAttempts: data.maxAttempts,
        createdAt: new Date(),
        updatedAt: new Date(),
        provider: null,
        providerReceiptId: null,
        acceptedAt: null,
        completedAt: null,
        leaseExpiresAt: null,
        ...data,
      };
      return stored;
    });
    return { ...harness, getStored: () => stored };
  }

  it('binds a canonical replay to the original operator, actor type and active role', async () => {
    const { service, prisma, getStored } = prepareEmailCore();
    const request = emailRequest();
    await (service as any).reserve(request);
    expect(getStored()).toMatchObject({
      operatorUserId: admin.id,
      actorType: 'HUMAN',
      operatorRole: 'company_admin',
      providerScope: 'email:account-1',
    });

    const provider = jest.fn();
    await expect(service.execute(emailRequest({ operatorUser: viewer }), provider))
      .rejects.toThrow(/another actor or role/i);
    expect(provider).not.toHaveBeenCalled();
    expect(prisma.externalActionOutbox.updateMany).not.toHaveBeenCalled();
  });

  it('rejects a target membership that is not the explicit authenticated active company', async () => {
    const { service, prisma } = prepareEmailCore();
    const otherCompany = 'company-other';
    const multiTenantAdmin = {
      id: admin.id,
      activeCompanyId: otherCompany,
      companies: [
        { id: companyId, role: 'company_admin' },
        { id: otherCompany, role: 'company_admin' },
      ],
    };
    prisma.userCompanyRelation.findFirst.mockResolvedValue({
      userId: admin.id,
      companyId,
      isActive: true,
      role: { name: 'company_admin' },
    });
    await expect((service as any).reserve(emailRequest({
      operatorUser: multiTenantAdmin,
    }))).rejects.toThrow(/authenticated active company/i);
    expect(prisma.externalActionOutbox.create).not.toHaveBeenCalled();
  });

  it.each([
    'deactivated user',
    'soft-deleted user',
    'deactivated company',
  ])('requires active user, non-deleted user and active company in the authoritative membership query: %s', async () => {
    const { service, prisma } = createService();
    prisma.userCompanyRelation.findFirst.mockImplementation(({ where }: any) => {
      expect(where).toMatchObject({
        userId: admin.id,
        companyId,
        isActive: true,
        user: { is: { isActive: true, deletedAt: null } },
        company: { is: { isActive: true } },
      });
      return Promise.resolve(null);
    });
    const provider = jest.fn();

    await expect(service.execute(emailRequest(), provider))
      .rejects.toThrow(/membership or role is no longer active/i);
    expect(provider).not.toHaveBeenCalled();
    expect(prisma.externalActionOutbox.create).not.toHaveBeenCalled();
  });

  it('includes exact artifact bytes metadata in the payload digest and rejects replacement', async () => {
    const { service, getStored } = prepareEmailCore();
    const firstArtifact = {
      sourceId: 'quote:quote-1',
      bytes: Buffer.from('%PDF-original quote'),
      mimeType: 'application/pdf',
      filename: 'quote.pdf',
    };
    await (service as any).reserve(emailRequest({ artifacts: [firstArtifact] }));
    expect(getStored().contentSnapshot).toMatchObject({
      artifacts: [{
        sourceId: firstArtifact.sourceId,
        sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
        size: firstArtifact.bytes.length,
        mimeType: 'application/pdf',
        filename: 'quote.pdf',
      }],
    });

    await expect((service as any).reserve(emailRequest({
      artifacts: [{ ...firstArtifact, bytes: Buffer.from('%PDF-tampered quote') }],
    }))).rejects.toThrow(/reused for another external action/i);
  });

  it.each([
    ExternalActionStatus.PENDING,
    ExternalActionStatus.UNKNOWN,
  ])('rejects a different key for an equivalent unresolved %s action and identifies the original', async (status) => {
    const { service, prisma, getStored } = prepareEmailCore();
    await (service as any).reserve(emailRequest({ idempotencyKey: 'email:semantic-original' }));
    const original = getStored();
    original.status = status;
    prisma.externalActionOutbox.findFirst.mockResolvedValue(original);

    await expect((service as any).reserve(emailRequest({
      idempotencyKey: 'email:semantic-replacement',
    }))).rejects.toMatchObject({
      response: expect.objectContaining({
        code: 'UNRESOLVED_EQUIVALENT_ACTION',
        outboxId: original.id,
      }),
    });
    expect(prisma.externalActionOutbox.create).toHaveBeenCalledTimes(1);
  });

  it('serializes different-key equivalent PENDING reservations so only one action is created', async () => {
    const { service, prisma } = prepareEmailCore();
    const rows: any[] = [];
    let transactionChain = Promise.resolve();
    prisma.$transaction.mockImplementation((operation: any) => {
      const result = transactionChain.then(() => operation(prisma));
      transactionChain = result.then(() => undefined, () => undefined);
      return result;
    });
    prisma.externalActionOutbox.findUnique.mockImplementation(async ({ where }: any) => (
      rows.find((row) => row.idempotencyKey === where.companyId_idempotencyKey.idempotencyKey) || null
    ));
    prisma.externalActionOutbox.findFirst.mockImplementation(async ({ where }: any) => (
      rows.find((row) => (
        row.companyId === where.companyId
        && row.channel === where.channel
        && row.actionType === where.actionType
        && row.targetAddressHash === where.targetAddressHash
        && row.providerScope === where.providerScope
        && row.payloadDigest === where.payloadDigest
        && where.status.in.includes(row.status)
      )) || null
    ));
    prisma.externalActionOutbox.create.mockImplementation(async ({ data }: any) => {
      const row = {
        id: `outbox-semantic-${rows.length + 1}`,
        status: ExternalActionStatus.PENDING,
        createdAt: new Date(),
        ...data,
      };
      rows.push(row);
      return row;
    });

    const results = await Promise.allSettled([
      (service as any).reserve(emailRequest({ idempotencyKey: 'email:semantic-race-a' })),
      (service as any).reserve(emailRequest({ idempotencyKey: 'email:semantic-race-b' })),
    ]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1);
    expect(rows).toHaveLength(1);
    expect((results.find((result) => result.status === 'rejected') as PromiseRejectedResult).reason)
      .toMatchObject({
        response: expect.objectContaining({
          code: 'UNRESOLVED_EQUIVALENT_ACTION',
          outboxId: rows[0].id,
        }),
      });
  });

  it('rejects group, broadcast and non-canonical WhatsApp targets before database lookup', () => {
    const { service } = prepareEmailCore();
    expect(() => (service as any).normalizeOutboundPhone('12025550123@g.us'))
      .toThrow(/direct WhatsApp JID/i);
    expect(() => (service as any).normalizeOutboundPhone('status@broadcast'))
      .toThrow(/direct WhatsApp JID/i);
    expect(() => (service as any).normalizeOutboundPhone('12025550123@evil.example'))
      .toThrow(/direct WhatsApp JID/i);
    expect(() => (service as any).normalizeOutboundPhone('12025550123'))
      .toThrow(/canonical E.164/i);
    expect((service as any).normalizeOutboundPhone('+12025550123')).toBe('12025550123');
    expect((service as any).normalizeOutboundPhone('12025550123@s.whatsapp.net'))
      .toBe('12025550123');
  });

  it('binds an agent quote to conjunctive quote and message capabilities in one reservation transaction', async () => {
    const { service, prisma, permissions } = prepareEmailCore();
    jest.spyOn(service as any, 'validateWhatsappTarget').mockResolvedValue({
      targetType: 'conversation',
      targetId: 'conversation-1',
      targetAddressHash: 'target-hash',
      targetDomain: null,
      snapshot: { leadId: 'lead-1' },
      checks: [],
      limits: { hourly: 30, daily: 100, contactDaily: 10, domainDaily: null },
    });
    jest.spyOn(service as any, 'enforceRateLimits').mockResolvedValue(undefined);
    permissions.evaluate
      .mockResolvedValueOnce({
        decision: 'ALLOW',
        reason: 'TEMPORARY_GRANT',
        scopeDigest: 'quote-scope',
        grantConsumptionId: 'quote-consumption',
      })
      .mockResolvedValueOnce({
        decision: 'ALLOW',
        reason: 'TEMPORARY_GRANT',
        scopeDigest: 'message-scope',
        grantConsumptionId: 'message-consumption',
      });

    await (service as any).reserve({
      ...emailRequest(),
      actorType: 'AGENT',
      channel: 'WHATSAPP',
      actionType: 'OPENCLAW_WHATSAPP_QUOTE',
      idempotencyKey: 'openclaw:quote-0001',
      targetAddress: '+12025550123',
      whatsappSessionId: 'wa-1',
      conversationId: 'conversation-1',
      body: 'Quotation attached',
      artifacts: [{
        sourceId: 'quote:quote-1',
        bytes: Buffer.from('%PDF-quote'),
        mimeType: 'application/pdf',
        filename: 'quote.pdf',
      }],
    });

    expect(permissions.evaluate).toHaveBeenCalledTimes(2);
    expect(permissions.evaluate.mock.calls.map((call: any[]) => call[2]))
      .toEqual(['crm.quote.send', 'crm.message.send']);
    for (const call of permissions.evaluate.mock.calls) {
      expect(call[3]).toEqual({ customerId: 'lead-1' });
      expect(call[4]).toMatchObject({ consumeGrant: true, tx: prisma });
    }
  });

  it('serializes concurrent Agent reservations so only the daily threshold fits', async () => {
    const { service, prisma, permissions } = prepareEmailCore();
    const rows = new Map<string, any>();
    let transactionChain = Promise.resolve();
    prisma.$transaction.mockImplementation((operation: any) => {
      const result = transactionChain.then(() => operation(prisma));
      transactionChain = result.then(() => undefined, () => undefined);
      return result;
    });
    prisma.externalActionOutbox.findUnique.mockImplementation(({ where }: any) => (
      rows.get(where.companyId_idempotencyKey.idempotencyKey) || null
    ));
    prisma.externalActionOutbox.count.mockImplementation(async ({ where }: any) => (
      where.actorType === 'AGENT' ? rows.size : 0
    ));
    prisma.externalActionOutbox.create.mockImplementation(async ({ data }: any) => {
      const row = {
        id: `outbox-${rows.size + 1}`,
        status: ExternalActionStatus.PENDING,
        attemptCount: 0,
        attemptVersion: 0,
        createdAt: new Date(),
        ...data,
      };
      rows.set(data.idempotencyKey, row);
      return row;
    });
    permissions.evaluate.mockImplementation(async (
      _company: string,
      _user: any,
      _capability: string,
      _scope: any,
      options: any,
    ) => options.dailyExternalSendCount >= 1
      ? { decision: 'DENY', reason: 'DAILY_EXTERNAL_SEND_LIMIT', scopeDigest: 'scope' }
      : { decision: 'ALLOW', reason: 'PROFILE_POLICY', scopeDigest: 'scope' });

    const requests = ['agent:daily-0001', 'agent:daily-0002'].map((idempotencyKey, index) => (
      (service as any).reserve(emailRequest({
        actorType: 'AGENT',
        actionType: 'OPENCLAW_EMAIL_SEND',
        idempotencyKey,
        body: `<p>Distinct authorized message ${index + 1}</p>`,
        requireAdmin: false,
      }))
    ));
    const results = await Promise.allSettled(requests);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1);
    expect((results.find((result) => result.status === 'rejected') as PromiseRejectedResult).reason)
      .toMatchObject({ message: expect.stringMatching(/DAILY_EXTERNAL_SEND_LIMIT/) });
    expect(rows.size).toBe(1);
    expect(prisma.$transaction).toHaveBeenCalledWith(
      expect.any(Function),
      { isolationLevel: 'Serializable' },
    );
  });
});
