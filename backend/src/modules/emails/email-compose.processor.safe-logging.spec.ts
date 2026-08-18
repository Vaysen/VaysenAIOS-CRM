jest.mock('@/common/ai/ai-client.util', () => ({
  createAiClient: jest.fn(() => ({
    chat: { completions: { create: mockAiCreate } },
  })),
  getAiModel: jest.fn(() => 'test-email-model'),
}));

import { Logger } from '@nestjs/common';
import { EmailComposeProcessor } from './email-compose.processor';

const mockAiCreate = jest.fn();

function loggerOutput(...spies: Array<{ mock: { calls: unknown[][] } }>) {
  return spies.flatMap((spy) => spy.mock.calls)
    .flat()
    .map(String)
    .join('\n');
}

function message(overrides: Record<string, unknown> = {}) {
  return {
    id: 'email-message-sentinel',
    companyId: 'company-sentinel',
    leadId: 'lead-sentinel',
    emailAccountId: 'email-account-sentinel',
    senderUserId: 'operator-sentinel',
    status: 'DraftPending',
    retryCount: 0,
    maxRetries: 3,
    deletedAt: null,
    templateId: null,
    trackingId: 'tracking-sentinel',
    unsubscribeToken: 'unsubscribe-sentinel',
    subject: 'Original subject customer@example.com',
    bodyHtml: '<p>Original body CUSTOMER_BODY_SENTINEL</p>',
    lead: {
      companyName: 'Customer Company Sentinel',
      contactName: 'Customer Name Sentinel',
      contactEmail: 'customer@example.com',
      country: 'United States',
      website: 'https://customer.invalid/private?token=customer-secret',
      productCategory: 'custom packaging',
      businessType: 'wholesale buyer',
      mainProducts: 'printed boxes',
      leadGrade: 'A',
      leadScore: 88,
      notes: 'CUSTOMER_NOTES_SENTINEL C:\\customer\\lead.txt',
    },
    company: {
      name: 'Vaysen Company Sentinel',
      website: 'https://company.invalid',
      description: 'COMPANY_DESCRIPTION_SENTINEL',
      settings: {},
    },
    emailAccount: {
      senderName: 'Operator Name Sentinel',
      senderEmail: 'operator@example.com',
      senderCompany: 'Sender Company Sentinel',
    },
    senderUser: { firstName: 'Operator First Name Sentinel' },
    ...overrides,
  };
}

function createHarness(currentMessage = message()) {
  const prisma: any = {
    emailMessage: {
      findUnique: jest.fn().mockResolvedValue(currentMessage),
      findMany: jest.fn().mockResolvedValue([]),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
    emailTemplate: { findUnique: jest.fn().mockResolvedValue(null) },
    product: { findMany: jest.fn().mockResolvedValue([]) },
  };
  const emailValidateQueue = { add: jest.fn().mockResolvedValue({ id: 'validate-job-sentinel' }) };
  const processor = new EmailComposeProcessor(prisma, emailValidateQueue as any);
  const log = jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
  const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  const error = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
  const debug = jest.spyOn(Logger.prototype, 'debug').mockImplementation(() => undefined);
  return { processor, prisma, emailValidateQueue, log, warn, error, debug };
}

describe('EmailComposeProcessor safe logging', () => {
  beforeEach(() => {
    mockAiCreate.mockReset();
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('saves the generated body and enqueues validation without logging AI or email content', async () => {
    const generatedSubject = 'AI SUBJECT SENTINEL customer@example.com';
    const generatedBody = 'AI BODY SENTINEL provider@example.com https://provider.invalid/token C:\\generated\\body.html';
    mockAiCreate.mockResolvedValue({
      choices: [{
        message: {
          content: JSON.stringify({
            subject: generatedSubject,
            bodyText: generatedBody,
            bodyHtml: `<p>${generatedBody}</p>`,
          }),
        },
      }],
    });
    const { processor, prisma, emailValidateQueue, log, warn, error, debug } = createHarness();

    await expect(processor.process({
      data: {
        emailMessageId: 'email-message-sentinel',
        productName: 'Product Sentinel',
        customVariables: { buyer: 'Customer Name Sentinel' },
        sendDelayMs: 1500,
        aiPersonalize: true,
      },
    } as any)).resolves.toEqual({
      success: true,
      emailMessageId: 'email-message-sentinel',
    });

    const saved = prisma.emailMessage.updateMany.mock.calls[1][0].data;
    expect(saved).toEqual(expect.objectContaining({
      subject: generatedSubject,
      status: 'DraftReady',
      trackingId: 'tracking-sentinel',
      unsubscribeToken: 'unsubscribe-sentinel',
    }));
    expect(saved.bodyHtml).toContain(generatedBody);
    expect(emailValidateQueue.add).toHaveBeenCalledWith(
      'validate-email',
      { emailMessageId: 'email-message-sentinel', aiPersonalize: true, sendDelayMs: 1500 },
      expect.objectContaining({ attempts: 3 }),
    );

    const output = loggerOutput(log, warn, error, debug);
    for (const value of [
      generatedSubject,
      generatedBody,
      'CUSTOMER_BODY_SENTINEL',
      'customer@example.com',
      'Vaysen Company Sentinel',
      'Customer Name Sentinel',
      'C:\\generated\\body.html',
      'email-message-sentinel',
    ]) {
      expect(output).not.toContain(value);
    }
    expect(output).toContain('email.compose.ai_response_received');
    expect(output).toContain('email.compose.delivery_body_prepared');
  });

  it.each([
    [0, 'DraftPending', null],
    [2, 'DraftFailed', 'date'],
  ])('persists stable failure data and rethrows the original provider error at retryCount %s', async (
    retryCount,
    expectedStatus,
    failedAtKind,
  ) => {
    const providerError = Object.assign(
      new Error('PROVIDER_RAW_ERROR customer@example.com https://provider.invalid/token /var/private/email.html'),
      { code: 'ETIMEDOUT' },
    );
    mockAiCreate.mockRejectedValue(providerError);
    const { processor, prisma, emailValidateQueue, log, warn, error, debug } = createHarness(
      message({ retryCount }),
    );

    await expect(processor.process({
      data: { emailMessageId: 'email-message-sentinel' },
    } as any)).rejects.toBe(providerError);

    const failure = prisma.emailMessage.updateMany.mock.calls[1][0].data;
    expect(failure).toEqual(expect.objectContaining({
      retryCount: retryCount + 1,
      status: expectedStatus,
      failedReason: 'AI draft generation failed',
      errorMessage: 'AI draft generation failed',
    }));
    expect(failure.failedAt).toEqual(failedAtKind === 'date' ? expect.any(Date) : null);
    expect(emailValidateQueue.add).not.toHaveBeenCalled();

    const output = loggerOutput(log, warn, error, debug);
    expect(output).not.toContain(providerError.message);
    expect(output).not.toContain('email-message-sentinel');
    expect(output).not.toContain('customer@example.com');
    expect(output).toContain('email.compose.draft_failed');
    expect(output).toContain('"errorCategory":"timeout"');
  });
});
