import { Logger } from '@nestjs/common';
import { EmailTrackService } from './email-track.service';

function loggerOutput(...spies: Array<{ mock: { calls: unknown[][] } }>) {
  return spies.flatMap((spy) => spy.mock.calls)
    .flat()
    .map(String)
    .join('\n');
}

function trackedMessage(overrides: Record<string, unknown> = {}) {
  return {
    id: 'email-message-sentinel',
    leadId: 'lead-sentinel',
    companyId: 'company-sentinel',
    campaignId: 'campaign-sentinel',
    subject: 'Subject CUSTOMER_NAME_SENTINEL',
    openedAt: null,
    clickedAt: null,
    lead: {
      id: 'lead-sentinel',
      status: 'prospect_pool',
      companyName: 'Customer Company Sentinel',
      contactEmail: 'customer@example.com',
    },
    ...overrides,
  };
}

function createHarness() {
  const prisma: any = {
    emailMessage: { findUnique: jest.fn(), update: jest.fn() },
    emailOpenEvent: { create: jest.fn().mockResolvedValue({}) },
    emailClickEvent: { create: jest.fn().mockResolvedValue({}) },
    lead: { update: jest.fn().mockResolvedValue({}) },
    tag: { findFirst: jest.fn().mockResolvedValue(null) },
    leadTag: { create: jest.fn().mockResolvedValue({}), deleteMany: jest.fn().mockResolvedValue({}) },
  };
  const followUpRemindersService = { generateForLead: jest.fn().mockResolvedValue(undefined) } as any;
  const timelineService = { logActivity: jest.fn().mockResolvedValue(undefined) } as any;
  const service = new EmailTrackService(prisma, followUpRemindersService, timelineService);
  const log = jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
  const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  const error = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
  const debug = jest.spyOn(Logger.prototype, 'debug').mockImplementation(() => undefined);
  return { service, prisma, followUpRemindersService, timelineService, log, warn, error, debug };
}

describe('EmailTrackService safe logging', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('preserves unknown open/click contracts while tracking IDs stay out of logs', async () => {
    const { service, prisma, log, warn, error, debug } = createHarness();
    const trackingId = 'TRACKING_ID_SENTINEL';
    const clickUrl = 'https://customer.invalid/quote?token=QUERY_TOKEN_SENTINEL#FRAGMENT_SENTINEL';
    prisma.emailMessage.findUnique.mockResolvedValue(null);

    const pixel = await service.trackOpen(trackingId);
    const redirected = await service.trackClick(trackingId, clickUrl);

    expect(pixel).toBeInstanceOf(Buffer);
    expect(redirected).toBe(clickUrl);
    expect(prisma.emailOpenEvent.create).not.toHaveBeenCalled();
    expect(prisma.emailClickEvent.create).not.toHaveBeenCalled();

    const output = loggerOutput(log, warn, error, debug);
    expect(output).not.toContain(trackingId);
    expect(output).not.toContain(clickUrl);
    expect(output).not.toContain('QUERY_TOKEN_SENTINEL');
    expect(output).toContain('email.track.open_unknown');
    expect(output).toContain('email.track.click_unknown');
  });

  it('preserves legal click recording, LeadActivity, and exact redirect URL without logging URL data', async () => {
    const { service, prisma, timelineService, log, warn, error, debug } = createHarness();
    const trackingId = 'TRACKING_CLICK_SENTINEL';
    const legalUrl = 'https://example.invalid/catalog/path?token=CLICK_TOKEN_SENTINEL&email=buyer@example.com#CLICK_FRAGMENT_SENTINEL';
    prisma.emailMessage.findUnique.mockResolvedValue(trackedMessage());

    await expect(service.trackClick(trackingId, legalUrl, '127.0.0.1', 'sentinel-agent'))
      .resolves.toBe(legalUrl);

    expect(prisma.emailClickEvent.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        emailId: 'email-message-sentinel',
        leadId: 'lead-sentinel',
        originalUrl: legalUrl,
        ipAddress: '127.0.0.1',
        userAgent: 'sentinel-agent',
      }),
    });
    expect(prisma.emailMessage.update).toHaveBeenCalledWith({
      where: { id: 'email-message-sentinel' },
      data: { clickedAt: expect.any(Date), status: 'Clicked' },
    });
    expect(prisma.lead.update).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: 'lead-sentinel' },
      data: expect.objectContaining({ status: 'interested' }),
    }));
    expect(timelineService.logActivity).toHaveBeenCalledWith(expect.objectContaining({
      activityType: 'email_clicked',
      referenceId: 'email-message-sentinel',
    }));

    const output = loggerOutput(log, warn, error, debug);
    for (const value of [trackingId, legalUrl, 'CLICK_TOKEN_SENTINEL', 'CLICK_FRAGMENT_SENTINEL', 'buyer@example.com']) {
      expect(output).not.toContain(value);
    }
  });

  it('returns the existing root behavior for malformed and non-http URLs without logging URL/query data', async () => {
    const { service, prisma, log, warn, error, debug } = createHarness();
    const malformedUrl = 'not-a-url?token=MALFORMED_TOKEN_SENTINEL#fragment';
    const nonHttpUrl = 'javascript:alert("JAVASCRIPT_TOKEN_SENTINEL")';

    await expect(service.trackClick('TRACKING_INVALID_SENTINEL', malformedUrl)).resolves.toBe('/');
    await expect(service.trackClick('TRACKING_INVALID_SENTINEL', nonHttpUrl)).resolves.toBe('/');
    expect(prisma.emailMessage.findUnique).not.toHaveBeenCalled();

    const output = loggerOutput(log, warn, error, debug);
    for (const value of [malformedUrl, nonHttpUrl, 'MALFORMED_TOKEN_SENTINEL', 'JAVASCRIPT_TOKEN_SENTINEL']) {
      expect(output).not.toContain(value);
    }
    expect(output).toContain('email.track.click_invalid_url');
    expect(output).toContain('email.track.click_invalid_protocol');
  });

  it('preserves pixel/redirect exception swallowing while Prisma errors stay categorized', async () => {
    const { service, prisma, log, warn, error, debug } = createHarness();
    const openError = Object.assign(
      new Error('PRISMA_OPEN_ERROR customer@example.com /var/private/open.log'),
      { code: 'ETIMEDOUT' },
    );
    const clickError = new Error('PRISMA_CLICK_ERROR https://provider.invalid/?token=DB_TOKEN_SENTINEL');
    prisma.emailMessage.findUnique
      .mockRejectedValueOnce(openError)
      .mockRejectedValueOnce(clickError);
    const clickUrl = 'https://example.invalid/keep?token=REDIRECT_TOKEN_SENTINEL#fragment';

    await expect(service.trackOpen('TRACKING_OPEN_DB_SENTINEL')).resolves.toBeInstanceOf(Buffer);
    await expect(service.trackClick('TRACKING_CLICK_DB_SENTINEL', clickUrl)).resolves.toBe(clickUrl);

    const output = loggerOutput(log, warn, error, debug);
    for (const value of [
      openError.message,
      clickError.message,
      'TRACKING_OPEN_DB_SENTINEL',
      'TRACKING_CLICK_DB_SENTINEL',
      'DB_TOKEN_SENTINEL',
      'REDIRECT_TOKEN_SENTINEL',
    ]) {
      expect(output).not.toContain(value);
    }
    expect(output).toContain('email.track.open_failed');
    expect(output).toContain('email.track.click_failed');
    expect(output).toContain('"errorCategory":"timeout"');
  });
});
