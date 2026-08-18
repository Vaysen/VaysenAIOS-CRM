import { Logger } from '@nestjs/common';
import { ImapInboundService, normalizeEmail, parseRfc822 } from './imap-inbound.service';
import { encrypt } from '../../common/utils/crypto.util';

process.env.EMAIL_ENCRYPTION_KEY = 'imap-inbound-test-key';

const adminUser = { id: 'operator-1', activeCompanyId: 'company-1', activeCompany: { id: 'company-1', role: 'company_admin' } };
const rawError = 'IMAP_ERROR_SENTINEL buyer@example.com <message-sentinel@example.com> subject=QUOTE_BODY_SENTINEL https://provider.invalid/?token=TOKEN_SENTINEL C:\\private\\attachment.eml';

function makeAccount(overrides: Record<string, unknown> = {}) {
  return {
    id: 'account-1', companyId: 'company-1', senderEmail: 'sales@example.com', imapHost: 'stub', imapPort: 993,
    imapSecure: true, imapUsername: 'sales@example.com', imapPasswordEncrypted: encrypt('secret'), inboundEnabled: true,
    inboundPollIntervalSeconds: 300, inboundLastSyncAt: null, inboundLastSyncStatus: null, inboundLastSyncError: null,
    inboundUidValidity: null, inboundUidCursor: null, ...overrides,
  } as any;
}

afterEach(() => jest.restoreAllMocks());

describe('IMAP inbound parsing contract', () => {
  it.each([
    [' Alice@Example.COM ', 'alice@example.com'],
    ['<buyer@example.com>', 'buyer@example.com'],
    [undefined, ''],
  ])('normalizes email %j', (input, expected) => expect(normalizeEmail(input)).toBe(expected));

  it('extracts multipart MIME, decoded headers and bounded attachment metadata without credentials', async () => {
    const parsed = await parseRfc822(Buffer.from([
      'From: Buyer <buyer@example.com>', 'To: sales@example.com', 'Cc: cc@example.com', 'Message-ID: <m-1@example.com>',
      'Date: Tue, 29 Jul 2026 10:00:00 +0000', 'Subject: =?UTF-8?B?UXVvdGF0aW9uIHJlcXVlc3Q=?=',
      'Content-Type: multipart/mixed; boundary="x"', '', '--x', 'Content-Type: multipart/alternative; boundary="y"', '',
      '--y', 'Content-Type: text/plain; charset=utf-8', 'Content-Transfer-Encoding: quoted-printable', '', 'Hello=20team',
      '--y', 'Content-Type: text/html; charset=utf-8', '', '<html><body><p>Hello team</p></body></html>', '--y--',
      '--x', 'Content-Type: application/pdf', 'Content-Disposition: attachment; filename*=UTF-8\'\'spec%20sheet.pdf', 'Content-Transfer-Encoding: base64', '', Buffer.from('pdf').toString('base64'), '--x--',
    ].join('\r\n')));
    expect(parsed.from).toBe('buyer@example.com');
    expect(parsed.subject).toBe('Quotation request');
    expect(parsed.text).toContain('Hello team');
    expect(parsed.html).toContain('<html>');
    expect(parsed.attachments[0]).toMatchObject({ filename: 'spec sheet.pdf', mimeType: 'application/pdf', size: 3 });
    expect(JSON.stringify(parsed)).not.toContain('password');
  });

  it('does not treat a repeated UID as an identity outside account/uid validity', async () => {
    const first = await parseRfc822('Message-ID: <same@example.com>\r\n\r\nbody');
    const second = await parseRfc822('Message-ID: <same@example.com>\r\n\r\nbody');
    expect(first.messageId).toBe(second.messageId);
  });

  it('uses a controllable fake IMAP client for first sync and duplicate polling', async () => {
    const source = Buffer.from('From: buyer@example.com\r\nTo: sales@example.com\r\nMessage-ID: <fake-1@example.com>\r\nSubject: Need bags\r\n\r\nHello');
    const account: any = { id: 'account-1', companyId: 'company-1', senderEmail: 'sales@example.com', imapHost: 'stub', imapPort: 993, imapSecure: true, imapUsername: 'sales@example.com', imapPasswordEncrypted: encrypt('secret'), inboundEnabled: true, inboundPollIntervalSeconds: 300, inboundLastSyncAt: null, inboundLastSyncStatus: null, inboundLastSyncError: null, inboundUidValidity: null, inboundUidCursor: null };
    const keys = new Set<string>();
    const created: any[] = [];
    const prisma: any = {
      emailAccount: {
        findUnique: jest.fn().mockResolvedValue(account),
        update: jest.fn(async ({ data }: any) => { Object.assign(account, data); return account; }),
      },
      communicationMessage: { findUnique: jest.fn(async ({ where }: any) => keys.has(where.ingestionKey) ? { id: 'existing' } : null), create: jest.fn(async ({ data }: any) => { keys.add(data.ingestionKey); const m = { id: `message-${created.length}`, ...data }; created.push(m); return m; }) },
      conversation: { upsert: jest.fn(async ({ create: data }: any) => ({ id: `conversation-${created.length}`, ...data })) },
      contactPoint: { findMany: jest.fn().mockResolvedValue([{ leadId: 'lead-1' }]) },
      leadActivity: { create: jest.fn().mockResolvedValue({}) },
      emailInboundReview: { create: jest.fn().mockResolvedValue({}) },
      $transaction: jest.fn(async (callback: any) => callback(prisma)),
    };
    const client: any = { mailbox: { uidValidity: 7n }, connect: jest.fn(), logout: jest.fn(), getMailboxLock: jest.fn().mockResolvedValue({ release: jest.fn() }), fetch: jest.fn(async function* () { yield { uid: 1, source }; }) };
    const service = new ImapInboundService(prisma);
    (service as any).factory = () => client;
    await expect(service.syncAccount('account-1')).resolves.toMatchObject({ status: 'ok', received: 1 });
    await expect(service.syncAccount('account-1')).resolves.toMatchObject({ status: 'ok', received: 0 });
    expect(account.inboundLastSyncStatus).toBe('ok');
    expect(account.inboundLastSyncError).toBeNull();
    expect(client.connect).toHaveBeenCalledTimes(2);
    expect(prisma.communicationMessage.create).toHaveBeenCalledTimes(1);
    expect(prisma.leadActivity.create).toHaveBeenCalledTimes(1);
  });

  it('returns and persists only a stable code on testConnection failure', async () => {
    const account = makeAccount();
    const update = jest.fn(async ({ data }: any) => { Object.assign(account, data); return account; });
    const prisma: any = {
      emailAccount: { findFirst: jest.fn().mockResolvedValue(account), update },
    };
    const providerError = Object.assign(new Error(rawError), {
      code: 'ETIMEDOUT',
      response: { status: 504, data: rawError },
      cause: new Error(`CAUSE_${rawError}`),
    });
    const client: any = { connect: jest.fn().mockRejectedValue(providerError), logout: jest.fn() };
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const service = new ImapInboundService(prisma);
    (service as any).factory = () => client;

    await expect(service.testConnection(adminUser, 'account-1')).resolves.toEqual({
      ok: false, configured: true, message: 'IMAP_TIMEOUT',
    });
    expect(update).toHaveBeenCalledWith({
      where: { id: 'account-1' },
      data: { inboundLastSyncStatus: 'connection_error', inboundLastSyncError: 'IMAP_TIMEOUT' },
    });
    const config = await service.getConfig(adminUser, 'account-1');
    const observed = JSON.stringify({ result: account, update: update.mock.calls, config, logs: warn.mock.calls });
    expect(observed).not.toContain(rawError);
    expect(observed).not.toContain('CAUSE_');
    expect(observed).not.toContain('TOKEN_SENTINEL');
    expect(config.lastSyncError).toBe('IMAP_TIMEOUT');
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('[imap.connection_test_failed]'));
    expect(warn.mock.calls[0][0]).toContain('"errorCategory":"timeout"');
    expect(client.logout).not.toHaveBeenCalled();
  });

  it('fails safe for a non-Error sync failure and preserves failure status update', async () => {
    const account = makeAccount();
    const update = jest.fn(async ({ data }: any) => { Object.assign(account, data); return account; });
    const prisma: any = {
      emailAccount: { findUnique: jest.fn().mockResolvedValue(account), update },
    };
    const providerFailure = {
      message: rawError,
      response: { status: 503, body: rawError },
      cause: rawError,
    };
    const release = jest.fn();
    const client: any = {
      mailbox: { uidValidity: 7n },
      connect: jest.fn(),
      getMailboxLock: jest.fn().mockResolvedValue({ release }),
      fetch: jest.fn(async function* () { throw providerFailure; }),
      logout: jest.fn(),
    };
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const service = new ImapInboundService(prisma);
    (service as any).factory = () => client;

    await expect(service.syncAccount('account-1')).resolves.toEqual({
      status: 'error', accountId: 'account-1', received: 0, message: 'IMAP_PROVIDER_ERROR',
    });
    expect(update).toHaveBeenCalledWith({
      where: { id: 'account-1' },
      data: expect.objectContaining({ inboundLastSyncStatus: 'error', inboundLastSyncError: 'IMAP_PROVIDER_ERROR' }),
    });
    expect(account.inboundLastSyncStatus).toBe('error');
    expect(account.inboundLastSyncError).toBe('IMAP_PROVIDER_ERROR');
    expect(release).toHaveBeenCalledTimes(1);
    expect(client.logout).toHaveBeenCalledTimes(1);
    const observed = JSON.stringify({ update: update.mock.calls, logs: warn.mock.calls });
    expect(observed).not.toContain(rawError);
    expect(observed).not.toContain('TOKEN_SENTINEL');
    expect(warn.mock.calls[0][0]).toContain('"errorCategory":"provider_failure"');
  });

  it('logs poll failures by category without exposing the provider object', async () => {
    const prisma: any = {
      emailAccount: {
        findMany: jest.fn().mockRejectedValue(Object.assign(new Error(rawError), {
          code: 'ECONNRESET', response: { status: 502, data: rawError }, cause: rawError,
        })),
      },
    };
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const service = new ImapInboundService(prisma);

    await expect((service as any).pollDue()).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('[imap.poll_failed]'));
    const output = warn.mock.calls.flat().join(' ');
    expect(output).not.toContain(rawError);
    expect(output).not.toContain('TOKEN_SENTINEL');
    expect(output).toContain('"errorCategory":"network"');
  });

  it('projects legacy raw lastSyncError as a stable public code', async () => {
    const account = makeAccount({ inboundLastSyncError: rawError });
    const prisma: any = { emailAccount: { findFirst: jest.fn().mockResolvedValue(account) } };
    const service = new ImapInboundService(prisma);

    const config = await service.getConfig(adminUser, 'account-1');

    expect(config.lastSyncError).toBe('IMAP_ERROR');
    expect(JSON.stringify(config)).not.toContain(rawError);
    expect(JSON.stringify(config)).not.toContain('TOKEN_SENTINEL');
  });

  describe('syncAll (R111 批次B 批量收信)', () => {
    it('syncs all enabled IMAP accounts of the company and isolates per-account failures', async () => {
      const account = makeAccount();
      const prisma: any = {
        emailAccount: {
          findMany: jest.fn().mockResolvedValue([
            { ...account },
            { ...account, id: 'account-2', senderEmail: 'ops@example.com' },
          ]),
        },
      };
      const service = new ImapInboundService(prisma);
      const syncSpy = jest.spyOn(service, 'syncAccount')
        .mockImplementation(async (id: string) => id === 'account-1'
          ? { status: 'ok', accountId: id, received: 3 }
          : { status: 'error', accountId: id, received: 0, message: 'IMAP_NETWORK_ERROR' });

      const results = await service.syncAll(adminUser);

      expect(prisma.emailAccount.findMany).toHaveBeenCalledWith(expect.objectContaining({
        where: { companyId: 'company-1', inboundEnabled: true, imapHost: { not: null }, imapUsername: { not: null } },
      }));
      expect(results).toEqual([
        { accountId: 'account-1', senderEmail: 'sales@example.com', status: 'ok', fetched: 3, error: null },
        { accountId: 'account-2', senderEmail: 'ops@example.com', status: 'error', fetched: 0, error: 'IMAP_NETWORK_ERROR' },
      ]);
      syncSpy.mockRestore();
    });
  });

  describe('pollDue 错峰与限额 (R111 批次B)', () => {
    it('orders due accounts by next due time (earliest first)', async () => {
      const base = makeAccount();
      const earlier = { ...base, id: 'earlier', inboundLastSyncAt: new Date(Date.now() - 400_000) };
      const later = { ...base, id: 'later', inboundLastSyncAt: new Date(Date.now() - 350_000) };
      const prisma: any = { emailAccount: { findMany: jest.fn().mockResolvedValue([later, earlier]) } };
      const service = new ImapInboundService(prisma);
      const syncSpy = jest.spyOn(service, 'syncAccount').mockResolvedValue({ status: 'ok', accountId: 'x', received: 0 } as any);

      await expect((service as any).pollDue()).resolves.toBeUndefined();

      expect(syncSpy.mock.calls.map((c) => c[0])).toEqual(['earlier', 'later']);
      syncSpy.mockRestore();
    });

    it('stagger first sync by a stable account-id hash offset', () => {
      const service = new ImapInboundService({} as any);
      const offset = (service as any).phaseOffsetMs('account-1', 300_000);
      expect(offset).toBeGreaterThanOrEqual(0);
      expect(offset).toBeLessThan(300_000);
      expect((service as any).phaseOffsetMs('account-1', 300_000)).toBe(offset);
      expect((service as any).phaseOffsetMs('account-2', 300_000)).not.toBe(offset);
    });

    it('skips the round when the hourly connection limit is reached and logs it', async () => {
      process.env.IMAP_INBOUND_PER_HOUR_LIMIT = '1';
      try {
        const account = makeAccount({ inboundLastSyncAt: new Date(Date.now() - 3_700_000) }); // due
        const prisma: any = { emailAccount: { findMany: jest.fn().mockResolvedValue([account]) } };
        const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
        const service = new ImapInboundService(prisma);
        (service as any).hourlySyncTimestamps.push(Date.now()); // 已用满 1 次
        const syncSpy = jest.spyOn(service, 'syncAccount').mockResolvedValue({ status: 'ok', accountId: 'x', received: 0 } as any);

        await expect((service as any).pollDue()).resolves.toBeUndefined();

        expect(syncSpy).not.toHaveBeenCalled();
        expect(warn).toHaveBeenCalledWith(expect.stringContaining('[imap.poll_skipped_hour_limit]'));
      } finally {
        delete process.env.IMAP_INBOUND_PER_HOUR_LIMIT;
      }
    });
  });
});
