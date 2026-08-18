jest.mock('./baileys-loader', () => ({ loadBaileys: jest.fn() }));
jest.mock('fs', () => ({
  ...jest.requireActual('fs'),
  existsSync: jest.fn(),
  rmSync: jest.fn(),
}));

import { Logger } from '@nestjs/common';
import { EventEmitter } from 'events';
import * as fs from 'fs';
import { loadBaileys } from './baileys-loader';
import {
  WhatsAppAdapter,
  forwardBaileysMessageBatch,
  forwardBaileysMessageUpdates,
  describeProxyEndpoint,
  normalizeBaileysMessageStatus,
} from './whatsapp-adapter';

function loggerOutput(...spies: Array<{ mock: { calls: unknown[][] } }>) {
  return spies.flatMap((spy) => spy.mock.calls)
    .flat()
    .map(String)
    .join('\n');
}

afterEach(() => {
  jest.restoreAllMocks();
  jest.useRealTimers();
});

describe('WhatsAppAdapter safe provider logging', () => {
  it('preserves connected/logout lifecycle while hiding session, phone, path, and provider details', async () => {
    const adapter = new WhatsAppAdapter();
    const sessionId = 'session-adapter-sentinel';
    const authStateDir = 'C:\\sensitive\\whatsapp\\auth-state-sentinel';
    const phoneNumber = '8613900099999';
    const providerError = 'provider raw error https://provider.invalid/token';
    const events: string[] = [];
    const emitter = adapter.ensureEmitter(sessionId);
    emitter.on('connected', () => events.push('connected'));
    emitter.on('disconnected', () => events.push('disconnected'));
    const socketEvents = new EventEmitter();
    const socket = {
      ev: socketEvents,
      user: { id: `${phoneNumber}:device` },
      end: jest.fn(),
    } as any;
    const makeWASocket = jest.fn().mockImplementation(() => {
      queueMicrotask(() => socketEvents.emit('connection.update', { connection: 'open' }));
      return socket;
    });
    (loadBaileys as jest.Mock).mockResolvedValue({
      makeWASocket,
      DisconnectReason: { loggedOut: 401 },
      useMultiFileAuthState: jest.fn().mockResolvedValue({ state: {}, saveCreds: jest.fn() }),
    });
    (fs.existsSync as jest.Mock).mockReturnValue(true);
    (fs.rmSync as jest.Mock).mockImplementation(() => {
      throw new Error(providerError);
    });
    const log = jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const error = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);

    const savedEnv = {
      whatsappProxy: process.env.WHATSAPP_PROXY,
      httpsProxy: process.env.HTTPS_PROXY,
      httpProxy: process.env.HTTP_PROXY,
      qrTimeout: process.env.WHATSAPP_QR_TIMEOUT_MS,
    };
    delete process.env.WHATSAPP_PROXY;
    delete process.env.HTTPS_PROXY;
    delete process.env.HTTP_PROXY;
    process.env.WHATSAPP_QR_TIMEOUT_MS = '100';
    try {
      await expect(adapter.initSession(sessionId, authStateDir)).resolves.toMatchObject({
        status: 'connected',
        qrCode: '',
      });
      socketEvents.emit('connection.update', {
        connection: 'close',
        lastDisconnect: { error: { output: { statusCode: 401 } } },
      });
      await new Promise<void>((resolve) => setImmediate(resolve));
    } finally {
      if (savedEnv.whatsappProxy === undefined) delete process.env.WHATSAPP_PROXY;
      else process.env.WHATSAPP_PROXY = savedEnv.whatsappProxy;
      if (savedEnv.httpsProxy === undefined) delete process.env.HTTPS_PROXY;
      else process.env.HTTPS_PROXY = savedEnv.httpsProxy;
      if (savedEnv.httpProxy === undefined) delete process.env.HTTP_PROXY;
      else process.env.HTTP_PROXY = savedEnv.httpProxy;
      if (savedEnv.qrTimeout === undefined) delete process.env.WHATSAPP_QR_TIMEOUT_MS;
      else process.env.WHATSAPP_QR_TIMEOUT_MS = savedEnv.qrTimeout;
    }

    expect(events).toEqual(['connected', 'disconnected']);
    const output = loggerOutput(log, warn, error);
    for (const value of [sessionId, authStateDir, phoneNumber, providerError]) {
      expect(output).not.toContain(value);
    }
    expect(output).toContain('whatsapp.adapter.connected');
    expect(output).toContain('whatsapp.adapter.session_logged_out');
    expect(output).toContain('whatsapp.adapter.auth_state_delete_failed');
  });

  it('keeps text/media UNKNOWN error identity while send and download logs omit provider text', async () => {
    jest.useFakeTimers();
    const adapter = new WhatsAppAdapter();
    const providerError = new Error('provider-error-sentinel@example.com /var/private/message.pdf token=secret');
    const textSocket = { sendMessage: jest.fn().mockRejectedValue(providerError) };
    const mediaSocket = { sendMessage: jest.fn().mockRejectedValue(providerError) };
    (adapter as any).sockets.set('session-text-sentinel', textSocket);
    (adapter as any).sockets.set('session-media-sentinel', mediaSocket);
    const downloadError = new Error('download provider response /absolute/path/secret.pdf');
    (loadBaileys as jest.Mock).mockResolvedValue({
      downloadMediaMessage: jest.fn().mockRejectedValue(downloadError),
    });
    const error = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);

    await expect(adapter.sendTextMessage(
      'session-text-sentinel',
      '8613900099999@s.whatsapp.net',
      'SENTINEL_MESSAGE_BODY',
    )).rejects.toBe(providerError);
    await expect(adapter.sendMediaMessage(
      'session-media-sentinel',
      '8613900099999@s.whatsapp.net',
      { type: 'document', buffer: Buffer.from('SENTINEL_FILE_BYTES'), filename: 'secret.pdf' },
    )).rejects.toBe(providerError);
    await expect(adapter.downloadMedia('session-media-sentinel', {
      message: { documentMessage: { mimetype: 'application/pdf' } },
    })).resolves.toBeNull();

    const output = loggerOutput(error);
    for (const value of [providerError.message, downloadError.message, 'SENTINEL_MESSAGE_BODY', 'secret.pdf']) {
      expect(output).not.toContain(value);
    }
    expect(output).toContain('whatsapp.adapter.send_text_failed');
    expect(output).toContain('whatsapp.adapter.send_media_failed');
    expect(output).toContain('whatsapp.adapter.media_download_failed');
    // Keep fake timers explicitly drained before restoring real timers.
    jest.runOnlyPendingTimers();
    jest.useRealTimers();
  });
});

describe('WhatsAppAdapter bounded provider timeouts', () => {
  it('clears the profile timer after provider resolve and reject', async () => {
    jest.useFakeTimers();
    const adapter = new WhatsAppAdapter();
    const profilePictureUrl = jest.fn();
    (adapter as any).sockets.set('profile-session', { profilePictureUrl });

    profilePictureUrl.mockResolvedValue('https://avatar.invalid/safe.jpg');
    await expect(adapter.getProfilePictureUrl('profile-session', 'jid-resolve'))
      .resolves.toBe('https://avatar.invalid/safe.jpg');
    expect(jest.getTimerCount()).toBe(0);

    profilePictureUrl.mockRejectedValue(new Error('provider profile failure'));
    await expect(adapter.getProfilePictureUrl('profile-session', 'jid-reject'))
      .resolves.toBeNull();
    expect(jest.getTimerCount()).toBe(0);
  });

  it('keeps the profile timeout pending until expiry, then clears it and returns null', async () => {
    jest.useFakeTimers();
    const adapter = new WhatsAppAdapter();
    const profilePictureUrl = jest.fn().mockImplementation(() => new Promise(() => {}));
    (adapter as any).sockets.set('profile-timeout-session', { profilePictureUrl });

    const result = adapter.getProfilePictureUrl('profile-timeout-session', 'jid-timeout');
    expect(jest.getTimerCount()).toBe(1);
    jest.advanceTimersByTime(8000);
    await expect(result).resolves.toBeNull();
    expect(jest.getTimerCount()).toBe(0);
  });

  it('clears the media timer after provider resolve and reject', async () => {
    jest.useFakeTimers();
    const adapter = new WhatsAppAdapter();
    (adapter as any).sockets.set('media-session', {});
    const downloadMediaMessage = jest.fn();
    (loadBaileys as jest.Mock).mockResolvedValue({ downloadMediaMessage });
    const message = { message: { documentMessage: { mimetype: 'application/pdf' } } };

    const bytes = Buffer.from('media-bytes');
    downloadMediaMessage.mockResolvedValue(bytes);
    await expect(adapter.downloadMedia('media-session', message)).resolves.toEqual({
      data: bytes,
      mimeType: 'application/pdf',
      ext: '.pdf',
    });
    expect(jest.getTimerCount()).toBe(0);

    downloadMediaMessage.mockRejectedValue(new Error('provider media failure'));
    await expect(adapter.downloadMedia('media-session', message)).resolves.toBeNull();
    expect(jest.getTimerCount()).toBe(0);
  });

  it('keeps the media timeout pending until expiry, then clears it and returns null', async () => {
    jest.useFakeTimers();
    const adapter = new WhatsAppAdapter();
    const error = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    (adapter as any).sockets.set('media-timeout-session', {});
    (loadBaileys as jest.Mock).mockResolvedValue({
      downloadMediaMessage: jest.fn().mockImplementation(() => new Promise(() => {})),
    });

    const result = adapter.downloadMedia('media-timeout-session', {
      message: { imageMessage: { mimetype: 'image/jpeg' } },
    });
    await Promise.resolve();
    expect(jest.getTimerCount()).toBe(1);
    jest.advanceTimersByTime(30000);
    await expect(result).resolves.toBeNull();
    expect(jest.getTimerCount()).toBe(0);
    expect(loggerOutput(error)).toContain('whatsapp.adapter.media_download_failed');
    expect(loggerOutput(error)).toContain('"errorCategory":"timeout"');
  });
});

describe('WhatsAppAdapter provider outcome classification', () => {
  it('marks a missing local socket as a proven non-send rejection', async () => {
    const adapter = new WhatsAppAdapter();

    await expect(adapter.sendTextMessage('missing-session', '12025550123@s.whatsapp.net', 'hello'))
      .resolves.toMatchObject({
        success: false,
        deliveryOutcome: 'REJECTED',
        providerAccepted: false,
      });
  });

  it.each([
    ['text', 'sendTextMessage', ['session-1', '12025550123@s.whatsapp.net', 'hello']],
    ['media', 'sendMediaMessage', [
      'session-1',
      '12025550123@s.whatsapp.net',
      { type: 'document', buffer: Buffer.from('%PDF-quote'), mimeType: 'application/pdf' },
    ]],
  ])('preserves an uncertain Baileys %s network failure instead of returning a retryable rejection', async (
    _label,
    method,
    args,
  ) => {
    const adapter = new WhatsAppAdapter();
    const reset = Object.assign(new Error('connection reset after dispatch'), { code: 'ECONNRESET' });
    (adapter as any).sockets.set('session-1', {
      sendMessage: jest.fn().mockRejectedValue(reset),
    });

    await expect((adapter as any)[method](...args)).rejects.toBe(reset);
  });

  it('quarantines a shared Baileys session after abort until the real send settles', async () => {
    const adapter = new WhatsAppAdapter();
    let settleProvider: ((value: any) => void) | undefined;
    const sendMessage = jest.fn().mockImplementation(() => new Promise((resolve) => {
      settleProvider = resolve;
    }));
    (adapter as any).sockets.set('session-1', { sendMessage });
    const controller = new AbortController();

    const first = adapter.sendTextMessage(
      'session-1',
      '12025550123@s.whatsapp.net',
      'first',
      controller.signal,
    );
    await Promise.resolve();
    controller.abort();
    await expect(first).rejects.toThrow(/bounded window/i);

    await expect(adapter.sendTextMessage(
      'session-1',
      '12025550123@s.whatsapp.net',
      'must not start',
    )).rejects.toMatchObject({
      providerDeliveryOutcome: 'REJECTED',
      providerAccepted: false,
    });
    expect(sendMessage).toHaveBeenCalledTimes(1);

    settleProvider?.({ key: { id: 'provider-first' } });
    await new Promise<void>((resolve) => setImmediate(resolve));
    sendMessage.mockResolvedValueOnce({ key: { id: 'provider-second' } });
    await expect(adapter.sendTextMessage(
      'session-1',
      '12025550123@s.whatsapp.net',
      'after quarantine',
    )).resolves.toMatchObject({ messageId: 'provider-second' });
    expect(sendMessage).toHaveBeenCalledTimes(2);
  });
});

describe('WhatsAppAdapter proxy diagnostics', () => {
  it('redacts proxy credentials while retaining the endpoint', () => {
    expect(describeProxyEndpoint('socks5://user:secret@proxy.internal:1080'))
      .toBe('socks5://proxy.internal:1080');
  });

  it('does not echo malformed proxy input', () => {
    expect(describeProxyEndpoint('not a proxy secret-value')).toBe('invalid-proxy-url');
  });
});

describe('WhatsAppAdapter Baileys event forwarding', () => {
  it('forwards every usable batch item and preserves fromMe direction', () => {
    const emitter = new EventEmitter();
    const received: any[] = [];
    emitter.on('message', (event) => received.push(event));

    const count = forwardBaileysMessageBatch(emitter, 'session-1', {
      messages: [
        { key: { id: 'in-1', fromMe: false }, message: { conversation: 'one' } },
        { key: { id: 'out-1', fromMe: true }, message: { conversation: 'two' } },
        { key: { id: 'empty' }, message: null },
        { key: { id: 'in-2', fromMe: false }, message: { conversation: 'three' } },
      ],
    });

    expect(count).toBe(3);
    expect(received.map((event) => [event.msg.key.id, event.direction])).toEqual([
      ['in-1', 'inbound'],
      ['out-1', 'outbound'],
      ['in-2', 'inbound'],
    ]);
  });

  it.each([
    [0, 'failed'],
    [1, 'pending'],
    [2, 'sent'],
    [3, 'delivered'],
    [4, 'read'],
    [5, 'read'],
    [99, null],
  ])('maps Baileys status %s to %s', (input, expected) => {
    expect(normalizeBaileysMessageStatus(input)).toBe(expected);
  });

  it('forwards each valid message status and ignores unusable entries', () => {
    const emitter = new EventEmitter();
    const received: any[] = [];
    emitter.on('message-status', (event) => received.push(event));

    const count = forwardBaileysMessageUpdates(emitter, 'session-1', [
      { key: { id: 'm-1' }, update: { status: 2 } },
      { key: { id: 'm-2' }, update: { status: 3 } },
      { key: {}, update: { status: 4 } },
      { key: { id: 'm-3' }, update: { status: 99 } },
    ]);

    expect(count).toBe(2);
    expect(received).toEqual([
      { sessionId: 'session-1', messageId: 'm-1', status: 'sent' },
      { sessionId: 'session-1', messageId: 'm-2', status: 'delivered' },
    ]);
  });
});
