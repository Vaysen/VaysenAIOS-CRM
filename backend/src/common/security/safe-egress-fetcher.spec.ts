import {
  createNodeTransport,
  EgressResolver,
  EgressTransport,
  EgressTransportResponse,
  SafeEgressError,
  SafeEgressErrorCode,
  SafeEgressFetcher,
  isPublicEgressAddress,
  redactEgressUrl,
} from './safe-egress-fetcher';
import { EventEmitter } from 'events';
import { brotliCompressSync, deflateSync, gzipSync } from 'zlib';

function body(chunks: Array<string | Uint8Array>): AsyncIterable<Uint8Array> {
  return {
    async *[Symbol.asyncIterator]() {
      for (const chunk of chunks) yield typeof chunk === 'string' ? Buffer.from(chunk) : chunk;
    },
  };
}

function response(
  status = 200,
  headers: Record<string, string> = { 'content-type': 'text/html; charset=utf-8' },
  chunks: Array<string | Uint8Array> = ['public page'],
): EgressTransportResponse {
  return { status, headers, body: body(chunks), abort: jest.fn() };
}

function resolverFor(addresses: Record<string, Array<{ address: string; family: 4 | 6 }>>): EgressResolver {
  return async (hostname) => addresses[hostname] || [];
}

async function expectCode(promise: Promise<unknown>, code: SafeEgressErrorCode) {
  await expect(promise).rejects.toMatchObject<Partial<SafeEgressError>>({ code });
}

describe('SafeEgressFetcher', () => {
  it.each([
    '127.0.0.1',
    '10.0.0.1',
    '100.64.0.1',
    '169.254.169.254',
    '172.16.0.1',
    '192.168.1.1',
    '198.18.0.1',
    '224.0.0.1',
    '0.0.0.0',
    '::',
    '::1',
    '::ffff:127.0.0.1',
    'fc00::1',
    'fe80::1',
    'ff02::1',
    '2001:db8::1',
    '2002:7f00:1::',
  ])('rejects non-public address %s', (address) => {
    expect(isPublicEgressAddress(address)).toBe(false);
  });

  it.each(['8.8.8.8', '1.1.1.1', '2606:4700:4700::1111', '2001:4860:4860::8888'])(
    'accepts public address %s',
    (address) => {
      expect(isPublicEgressAddress(address)).toBe(true);
    },
  );

  it.each([
    'http://127.1/',
    'http://2130706433/',
    'http://0177.0.0.1/',
    'http://0x7f.0.0.1/',
    'http://127.0.1/',
    'http://[::ffff:127.0.0.1]/',
    'http://169.254.169.254/latest/meta-data/',
  ])('blocks alternate localhost/metadata spelling %s', async (url) => {
    const fetcher = new SafeEgressFetcher(async (hostname) => [
      { address: hostname.replace(/^\[|\]$/g, ''), family: hostname.includes(':') ? 6 : 4 },
    ]);
    await expectCode(fetcher.fetch(url), 'EGRESS_ADDRESS_BLOCKED');
  });

  it('rejects userinfo and non-default ports without invoking DNS', async () => {
    const resolver = jest.fn<ReturnType<EgressResolver>, Parameters<EgressResolver>>();
    const fetcher = new SafeEgressFetcher(resolver);
    await expectCode(fetcher.fetch('https://user:secret@example.com/path'), 'EGRESS_CREDENTIALS_BLOCKED');
    await expectCode(fetcher.fetch('https://example.com:8443/path'), 'EGRESS_PORT_BLOCKED');
    expect(resolver).not.toHaveBeenCalled();
  });

  it('re-resolves and blocks a redirect to a private destination', async () => {
    const transport = jest
      .fn<ReturnType<EgressTransport>, Parameters<EgressTransport>>()
      .mockResolvedValueOnce(response(302, { location: 'http://internal.test/admin' }, []));
    const fetcher = new SafeEgressFetcher(
      resolverFor({
        'public.test': [{ address: '8.8.8.8', family: 4 }],
        'internal.test': [{ address: '10.0.0.9', family: 4 }],
      }),
      transport,
    );
    await expectCode(fetcher.fetch('https://public.test/start'), 'EGRESS_ADDRESS_BLOCKED');
    expect(transport).toHaveBeenCalledTimes(1);
  });

  it('stops deterministic redirect loops at the configured limit', async () => {
    const transport = jest
      .fn<ReturnType<EgressTransport>, Parameters<EgressTransport>>()
      .mockResolvedValue(response(302, { location: '/again' }, []));
    const fetcher = new SafeEgressFetcher(
      resolverFor({ 'public.test': [{ address: '8.8.8.8', family: 4 }] }),
      transport,
    );
    await expectCode(
      fetcher.fetch('https://public.test/start', { maxRedirects: 2 }),
      'EGRESS_REDIRECT_LIMIT',
    );
    expect(transport).toHaveBeenCalledTimes(3);
  });

  it('rejects a DNS answer set containing any private rebinding address', async () => {
    const transport = jest.fn<ReturnType<EgressTransport>, Parameters<EgressTransport>>();
    const fetcher = new SafeEgressFetcher(
      resolverFor({
        'rebinding.test': [
          { address: '8.8.8.8', family: 4 },
          { address: '127.0.0.1', family: 4 },
        ],
      }),
      transport,
    );
    await expectCode(fetcher.fetch('https://rebinding.test/'), 'EGRESS_ADDRESS_BLOCKED');
    expect(transport).not.toHaveBeenCalled();
  });

  it('bounds DNS resolution by the remaining total timeout and handles a late rejection', async () => {
    let rejectLate: (reason: Error) => void = () => undefined;
    const resolver: EgressResolver = () =>
      new Promise((_, reject) => {
        rejectLate = reject;
      });
    const events: string[] = [];
    const fetcher = new SafeEgressFetcher(resolver, undefined, (event) => {
      events.push(`${event.code}:${event.destination}`);
    });
    await expectCode(
      fetcher.fetch('https://dns-timeout.test/path?token=hidden', { totalTimeoutMs: 10 }),
      'EGRESS_TOTAL_TIMEOUT',
    );
    rejectLate(new Error('late resolver failure'));
    await new Promise((resolve) => setImmediate(resolve));
    expect(events).toEqual(['EGRESS_TOTAL_TIMEOUT:https://dns-timeout.test']);
  });

  it('normalizes scoped or malformed IPv6 resolver output to a safe, redacted failure', async () => {
    const events: string[] = [];
    const fetcher = new SafeEgressFetcher(
      async () => [{ address: 'fe80::1%eth0', family: 6 }],
      undefined,
      (event) => events.push(`${event.code}:${event.destination}`),
    );
    await expectCode(
      fetcher.fetch('https://scoped.test/path?api_key=hidden'),
      'EGRESS_ADDRESS_BLOCKED',
    );
    expect(events).toEqual(['EGRESS_ADDRESS_BLOCKED:https://scoped.test']);
  });

  it('pins transport to the validated DNS address instead of resolving again', async () => {
    const resolver = jest
      .fn<ReturnType<EgressResolver>, Parameters<EgressResolver>>()
      .mockResolvedValueOnce([{ address: '8.8.8.8', family: 4 }])
      .mockResolvedValueOnce([{ address: '127.0.0.1', family: 4 }]);
    const transport = jest
      .fn<ReturnType<EgressTransport>, Parameters<EgressTransport>>()
      .mockResolvedValue(response());
    const fetcher = new SafeEgressFetcher(resolver, transport);
    await expect(fetcher.fetch('https://changing.test/')).resolves.toMatchObject({ status: 200 });
    expect(resolver).toHaveBeenCalledTimes(1);
    expect(transport.mock.calls[0][0].address).toEqual({ address: '8.8.8.8', family: 4 });
    expect(transport.mock.calls[0][0].url.hostname).toBe('changing.test');
  });

  it('enforces the response limit while streaming', async () => {
    const transport = jest
      .fn<ReturnType<EgressTransport>, Parameters<EgressTransport>>()
      .mockResolvedValue(response(200, { 'content-type': 'text/html' }, ['1234', '5678']));
    const fetcher = new SafeEgressFetcher(
      resolverFor({ 'public.test': [{ address: '8.8.8.8', family: 4 }] }),
      transport,
    );
    await expectCode(fetcher.fetch('https://public.test/', { maxResponseBytes: 6 }), 'EGRESS_RESPONSE_TOO_LARGE');
  });

  it('enforces the response limit after decompression', async () => {
    const compressed = gzipSync(Buffer.alloc(64 * 1024, 65));
    const transport = jest
      .fn<ReturnType<EgressTransport>, Parameters<EgressTransport>>()
      .mockResolvedValue(
        response(
          200,
          { 'content-type': 'text/html', 'content-encoding': 'gzip' },
          [compressed],
        ),
      );
    const fetcher = new SafeEgressFetcher(
      resolverFor({ 'public.test': [{ address: '8.8.8.8', family: 4 }] }),
      transport,
    );
    await expectCode(
      fetcher.fetch('https://public.test/', { maxResponseBytes: 1024 }),
      'EGRESS_RESPONSE_TOO_LARGE',
    );
  });

  it('limits compressed wire bytes independently from decoded bytes', async () => {
    const compressed = gzipSync(Buffer.from(Array.from({ length: 4096 }, (_, i) => i % 251)));
    const transport = jest
      .fn<ReturnType<EgressTransport>, Parameters<EgressTransport>>()
      .mockResolvedValue(
        response(
          200,
          { 'content-type': 'text/html', 'content-encoding': 'gzip' },
          [compressed],
        ),
      );
    const fetcher = new SafeEgressFetcher(
      resolverFor({ 'public.test': [{ address: '8.8.8.8', family: 4 }] }),
      transport,
    );
    await expectCode(
      fetcher.fetch('https://public.test/', {
        maxWireBytes: 128,
        maxResponseBytes: 8192,
      }),
      'EGRESS_WIRE_RESPONSE_TOO_LARGE',
    );
  });

  it('aborts exactly once when content encoding is unsupported before body iteration', async () => {
    const abort = jest.fn();
    const stream = body(['must not be consumed']);
    const iterator = jest.spyOn(stream, Symbol.asyncIterator);
    const fetcher = new SafeEgressFetcher(
      resolverFor({ 'public.test': [{ address: '8.8.8.8', family: 4 }] }),
      async () => ({
        status: 200,
        headers: { 'content-type': 'text/html', 'content-encoding': 'compress' },
        body: stream,
        abort,
      }),
    );

    await expectCode(fetcher.fetch('https://public.test/'), 'EGRESS_CONTENT_ENCODING_BLOCKED');
    expect(abort).toHaveBeenCalledTimes(1);
    expect(iterator).not.toHaveBeenCalled();
  });

  it.each([
    ['gzip', Buffer.from('corrupt-gzip'), gzipSync(Buffer.from('valid')).subarray(0, 5)],
    ['deflate', Buffer.from('corrupt-deflate'), deflateSync(Buffer.from('valid')).subarray(0, 3)],
    ['br', Buffer.from('corrupt-brotli'), brotliCompressSync(Buffer.from('valid')).subarray(0, 2)],
  ])('aborts exactly once for corrupt or truncated %s streams', async (encoding, corrupt, truncated) => {
    for (const payload of [corrupt, truncated]) {
      const abort = jest.fn();
      const fetcher = new SafeEgressFetcher(
        resolverFor({ 'public.test': [{ address: '8.8.8.8', family: 4 }] }),
        async () => ({
          status: 200,
          headers: { 'content-type': 'text/html', 'content-encoding': encoding },
          body: body([payload]),
          abort,
        }),
      );

      await expectCode(fetcher.fetch('https://public.test/'), 'EGRESS_TRANSPORT_ERROR');
      expect(abort).toHaveBeenCalledTimes(1);
    }
  });

  it('aborts exactly once when the source stream fails', async () => {
    const abort = jest.fn();
    const failedBody: AsyncIterable<Uint8Array> = {
      async *[Symbol.asyncIterator]() {
        yield Buffer.from('prefix');
        throw new Error('fixture stream failure');
      },
    };
    const fetcher = new SafeEgressFetcher(
      resolverFor({ 'public.test': [{ address: '8.8.8.8', family: 4 }] }),
      async () => ({
        status: 200,
        headers: { 'content-type': 'text/html' },
        body: failedBody,
        abort,
      }),
    );

    await expectCode(fetcher.fetch('https://public.test/'), 'EGRESS_TRANSPORT_ERROR');
    expect(abort).toHaveBeenCalledTimes(1);
  });

  it('aborts exactly once and clears the stream timeout during a stall/error race', async () => {
    jest.useFakeTimers();
    let rejectLate: (error: Error) => void = () => undefined;
    const abort = jest.fn(() => rejectLate(new Error('transport aborted stalled stream')));
    const stalledBody: AsyncIterable<Uint8Array> = {
      [Symbol.asyncIterator]() {
        return {
          next: () =>
            new Promise<IteratorResult<Uint8Array>>((_, reject) => {
              rejectLate = reject;
            }),
        };
      },
    };
    const fetcher = new SafeEgressFetcher(
      resolverFor({ 'public.test': [{ address: '8.8.8.8', family: 4 }] }),
      async () => ({
        status: 200,
        headers: { 'content-type': 'text/html' },
        body: stalledBody,
        abort,
      }),
    );

    try {
      const request = fetcher.fetch('https://public.test/', { totalTimeoutMs: 100 });
      const rejection = expect(request).rejects.toMatchObject<Partial<SafeEgressError>>({
        code: 'EGRESS_TOTAL_TIMEOUT',
      });
      await Promise.resolve();
      await Promise.resolve();
      await jest.advanceTimersByTimeAsync(100);
      await rejection;
      await Promise.resolve();
      expect(abort).toHaveBeenCalledTimes(1);
      expect(jest.getTimerCount()).toBe(0);
    } finally {
      jest.useRealTimers();
    }
  });

  it('node transport abort destroys once and removes timer/response listeners exactly once', async () => {
    jest.useFakeTimers();
    const responseStream = Object.assign(new EventEmitter(), {
      statusCode: 200,
      headers: { 'content-type': 'text/html' },
    });
    const socket = new EventEmitter();
    const request = Object.assign(new EventEmitter(), {
      destroy: jest.fn(),
      end: jest.fn(),
    });
    const fakeRequest = ((_options: unknown, callback: unknown) => {
      const onResponse = callback as (response: unknown) => void;
      request.end.mockImplementation(() => {
        request.emit('socket', socket);
        socket.emit('connect');
        onResponse(responseStream);
      });
      return request as never;
    }) as never;

    try {
      const pending = createNodeTransport({ httpRequest: fakeRequest })({
        url: new URL('http://public.test/'),
        address: { address: '8.8.8.8', family: 4 },
        headers: {},
        connectTimeoutMs: 50,
        totalTimeoutMs: 100,
      });
      const response = await pending;
      expect(responseStream.listenerCount('end')).toBe(1);
      expect(responseStream.listenerCount('close')).toBe(1);
      expect(responseStream.listenerCount('error')).toBe(1);

      response.abort();
      response.abort();

      expect(request.destroy).toHaveBeenCalledTimes(1);
      expect(responseStream.listenerCount('end')).toBe(0);
      expect(responseStream.listenerCount('close')).toBe(0);
      expect(responseStream.listenerCount('error')).toBe(0);
      expect(request.listenerCount('socket')).toBe(0);
      expect(request.listenerCount('error')).toBe(0);
      expect(socket.listenerCount('connect')).toBe(0);
      expect(jest.getTimerCount()).toBe(0);
    } finally {
      jest.useRealTimers();
    }
  });

  it('destroys a late response after total timeout and removes request/socket listeners', async () => {
    jest.useFakeTimers();
    let onResponse: (response: unknown) => void = () => undefined;
    const socket = new EventEmitter();
    const request = Object.assign(new EventEmitter(), {
      destroy: jest.fn(),
      end: jest.fn(),
    });
    const fakeRequest = ((_options: unknown, callback: unknown) => {
      onResponse = callback as (response: unknown) => void;
      request.end.mockImplementation(() => request.emit('socket', socket));
      return request as never;
    }) as never;
    const lateResponse = Object.assign(new EventEmitter(), {
      statusCode: 200,
      headers: { 'content-type': 'text/html' },
      destroy: jest.fn(),
    });

    try {
      const pending = createNodeTransport({ httpRequest: fakeRequest })({
        url: new URL('http://public.test/'),
        address: { address: '8.8.8.8', family: 4 },
        headers: {},
        connectTimeoutMs: 200,
        totalTimeoutMs: 100,
      });
      const rejection = expect(pending).rejects.toMatchObject<Partial<SafeEgressError>>({
        code: 'EGRESS_TOTAL_TIMEOUT',
      });
      await jest.advanceTimersByTimeAsync(100);
      await rejection;

      expect(request.destroy).toHaveBeenCalledTimes(1);
      expect(request.listenerCount('socket')).toBe(0);
      expect(request.listenerCount('error')).toBe(0);
      expect(socket.listenerCount('connect')).toBe(0);
      expect(jest.getTimerCount()).toBe(0);

      onResponse(lateResponse);
      expect(lateResponse.destroy).toHaveBeenCalledTimes(1);
      expect(lateResponse.listenerCount('end')).toBe(0);
      expect(lateResponse.listenerCount('close')).toBe(0);
      expect(lateResponse.listenerCount('error')).toBe(0);
      expect(request.destroy).toHaveBeenCalledTimes(1);
    } finally {
      jest.useRealTimers();
    }
  });

  it('keeps abort/error races idempotent and leaves no transport listeners', async () => {
    jest.useFakeTimers();
    const responseStream = Object.assign(new EventEmitter(), {
      statusCode: 200,
      headers: { 'content-type': 'text/html' },
    });
    const socket = new EventEmitter();
    const request = Object.assign(new EventEmitter(), {
      destroy: jest.fn(),
      end: jest.fn(),
    });
    let capturedErrorHandler: ((error: Error) => void) | undefined;
    const fakeRequest = ((_options: unknown, callback: unknown) => {
      const onResponse = callback as (response: unknown) => void;
      request.end.mockImplementation(() => {
        request.emit('socket', socket);
        capturedErrorHandler = request.listeners('error')[0] as (error: Error) => void;
        onResponse(responseStream);
      });
      return request as never;
    }) as never;

    try {
      const response = await createNodeTransport({ httpRequest: fakeRequest })({
        url: new URL('http://public.test/'),
        address: { address: '8.8.8.8', family: 4 },
        headers: {},
        connectTimeoutMs: 50,
        totalTimeoutMs: 100,
      });
      response.abort();
      capturedErrorHandler?.(new Error('late request error'));
      response.abort();

      expect(request.destroy).toHaveBeenCalledTimes(1);
      expect(request.listenerCount('socket')).toBe(0);
      expect(request.listenerCount('error')).toBe(0);
      expect(socket.listenerCount('connect')).toBe(0);
      expect(responseStream.listenerCount('end')).toBe(0);
      expect(responseStream.listenerCount('close')).toBe(0);
      expect(responseStream.listenerCount('error')).toBe(0);
      expect(jest.getTimerCount()).toBe(0);
    } finally {
      jest.useRealTimers();
    }
  });

  it('blocks an unexpected MIME type before consuming the body', async () => {
    const stream = body(['secret binary']);
    const iterator = jest.spyOn(stream, Symbol.asyncIterator);
    const transport = jest
      .fn<ReturnType<EgressTransport>, Parameters<EgressTransport>>()
      .mockResolvedValue({
      status: 200,
      headers: { 'content-type': 'application/octet-stream' },
      body: stream,
      abort: jest.fn(),
      });
    const fetcher = new SafeEgressFetcher(
      resolverFor({ 'public.test': [{ address: '8.8.8.8', family: 4 }] }),
      transport,
    );
    await expectCode(fetcher.fetch('https://public.test/'), 'EGRESS_CONTENT_TYPE_BLOCKED');
    expect(iterator).not.toHaveBeenCalled();
  });

  it('keeps private HTML and public JSON candidate pages outside the public-page contract', async () => {
    const resolver = resolverFor({
      'private.test': [{ address: '10.0.0.8', family: 4 }],
      'public.test': [{ address: '8.8.8.8', family: 4 }],
    });
    const transport = jest
      .fn<ReturnType<EgressTransport>, Parameters<EgressTransport>>()
      .mockResolvedValue(response(200, { 'content-type': 'application/json' }, ['{"ok":true}']));
    const fetcher = new SafeEgressFetcher(resolver, transport);
    await expectCode(fetcher.fetch('https://private.test/page'), 'EGRESS_ADDRESS_BLOCKED');
    await expectCode(fetcher.fetch('https://public.test/provider-json'), 'EGRESS_CONTENT_TYPE_BLOCKED');
  });

  it('fails a slow response against the total timeout', async () => {
    const abort = jest.fn();
    const slowBody: AsyncIterable<Uint8Array> = {
      async *[Symbol.asyncIterator]() {
        yield Buffer.from('first');
        await new Promise((resolve) => setTimeout(resolve, 25));
        yield Buffer.from('late');
      },
    };
    const fetcher = new SafeEgressFetcher(
      resolverFor({ 'public.test': [{ address: '8.8.8.8', family: 4 }] }),
      async () => ({
        status: 200,
        headers: { 'content-type': 'text/html' },
        body: slowBody,
        abort,
      }),
    );
    await expectCode(fetcher.fetch('https://public.test/', { totalTimeoutMs: 10 }), 'EGRESS_TOTAL_TIMEOUT');
    expect(abort).toHaveBeenCalledTimes(1);
  });

  it('returns a bounded normal public page and records an allowed metric', async () => {
    const events: string[] = [];
    const fetcher = new SafeEgressFetcher(
      resolverFor({ 'public.test': [{ address: '8.8.8.8', family: 4 }] }),
      async () => response(200, { 'content-type': 'text/html' }, ['hello ', 'world']),
      (event) => events.push(`${event.code}:${event.destination}`),
    );
    const result = await fetcher.fetch('https://public.test/page?api_key=do-not-log');
    expect(result.text()).toBe('hello world');
    expect(events).toEqual(['EGRESS_OK:https://public.test']);
    expect(redactEgressUrl('https://public.test/page?api_key=do-not-log')).toBe('https://public.test');
  });
});
