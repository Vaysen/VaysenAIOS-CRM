import * as dns from 'dns/promises';
import * as http from 'http';
import * as https from 'https';
import { isIP, type Socket } from 'net';
import { Readable } from 'stream';
import { createBrotliDecompress, createGunzip, createInflate } from 'zlib';

export type SafeEgressErrorCode =
  | 'EGRESS_INVALID_URL'
  | 'EGRESS_PROTOCOL_BLOCKED'
  | 'EGRESS_CREDENTIALS_BLOCKED'
  | 'EGRESS_PORT_BLOCKED'
  | 'EGRESS_DNS_FAILED'
  | 'EGRESS_ADDRESS_BLOCKED'
  | 'EGRESS_REDIRECT_LIMIT'
  | 'EGRESS_REDIRECT_INVALID'
  | 'EGRESS_CONNECT_TIMEOUT'
  | 'EGRESS_TOTAL_TIMEOUT'
  | 'EGRESS_WIRE_RESPONSE_TOO_LARGE'
  | 'EGRESS_RESPONSE_TOO_LARGE'
  | 'EGRESS_CONTENT_TYPE_BLOCKED'
  | 'EGRESS_CONTENT_ENCODING_BLOCKED'
  | 'EGRESS_TRANSPORT_ERROR';

export class SafeEgressError extends Error {
  constructor(
    readonly code: SafeEgressErrorCode,
    message: string,
    readonly cause?: unknown,
  ) {
    super(message);
    this.name = 'SafeEgressError';
  }
}

export interface ResolvedAddress {
  address: string;
  family: 4 | 6;
}

export type EgressResolver = (hostname: string) => Promise<ResolvedAddress[]>;

export interface EgressTransportRequest {
  url: URL;
  address: ResolvedAddress;
  headers: Readonly<Record<string, string>>;
  connectTimeoutMs: number;
  totalTimeoutMs: number;
}

export interface EgressTransportResponse {
  status: number;
  headers: Readonly<Record<string, string | string[] | undefined>>;
  body: AsyncIterable<Uint8Array>;
  abort: () => void;
}

export type EgressTransport = (request: EgressTransportRequest) => Promise<EgressTransportResponse>;

export interface SafeEgressFetchOptions {
  maxRedirects?: number;
  connectTimeoutMs?: number;
  totalTimeoutMs?: number;
  maxWireBytes?: number;
  maxResponseBytes?: number;
  allowedContentTypes?: readonly string[];
}

export interface SafeEgressResponse {
  url: URL;
  status: number;
  headers: Readonly<Record<string, string | string[] | undefined>>;
  body: Buffer;
  redirects: number;
  text: (encoding?: BufferEncoding) => string;
}

export interface SafeEgressMetricEvent {
  outcome: 'allowed' | 'blocked' | 'failed';
  code: 'EGRESS_OK' | SafeEgressErrorCode;
  destination: string;
}

const DEFAULT_MAX_REDIRECTS = 3;
const DEFAULT_CONNECT_TIMEOUT_MS = 3_000;
const DEFAULT_TOTAL_TIMEOUT_MS = 8_000;
const DEFAULT_MAX_WIRE_BYTES = 512 * 1024;
const DEFAULT_MAX_RESPONSE_BYTES = 512 * 1024;
const DEFAULT_ALLOWED_CONTENT_TYPES = ['text/html', 'text/plain', 'application/xhtml+xml'];
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

function ipv4ToNumber(address: string): number {
  return address.split('.').reduce((value, octet) => ((value << 8) | Number(octet)) >>> 0, 0);
}

function ipv4InCidr(address: string, base: string, prefix: number): boolean {
  const value = ipv4ToNumber(address);
  const network = ipv4ToNumber(base);
  const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
  return (value & mask) === (network & mask);
}

const BLOCKED_IPV4_CIDRS: ReadonlyArray<readonly [string, number]> = [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.31.196.0', 24],
  ['192.52.193.0', 24],
  ['192.88.99.0', 24],
  ['192.168.0.0', 16],
  ['192.175.48.0', 24],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
];

function expandIpv6(address: string): bigint {
  const normalized = address.toLowerCase();
  const halves = normalized.split('::');
  if (halves.length > 2) throw new Error('invalid IPv6');
  const left = halves[0] ? halves[0].split(':') : [];
  const right = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  const missing = 8 - left.length - right.length;
  if (missing < 0 || (halves.length === 1 && missing !== 0)) throw new Error('invalid IPv6');
  const groups = [...left, ...Array(missing).fill('0'), ...right];
  if (groups.length !== 8) throw new Error('invalid IPv6');
  return groups.reduce((value, group) => (value << 16n) | BigInt(`0x${group || '0'}`), 0n);
}

function ipv6InCidr(address: string, base: string, prefix: number): boolean {
  const value = expandIpv6(address);
  const network = expandIpv6(base);
  const shift = BigInt(128 - prefix);
  return (value >> shift) === (network >> shift);
}

export function isPublicEgressAddress(address: string): boolean {
  try {
    const family = isIP(address);
    if (family === 4) {
      return !BLOCKED_IPV4_CIDRS.some(([base, prefix]) => ipv4InCidr(address, base, prefix));
    }
    if (family !== 6) return false;
    if (address.includes('.') || address.includes('%')) return false;

    // Only globally routed unicast is eligible. Translation, mapped, documentation,
    // transition, local, multicast and IETF special-purpose blocks are fail-closed.
    if (!ipv6InCidr(address, '2000::', 3)) return false;
    const blocked = [
      ['2001::', 23],
      ['2001:db8::', 32],
      ['2002::', 16],
    ] as const;
    return !blocked.some(([base, prefix]) => ipv6InCidr(address, base, prefix));
  } catch {
    return false;
  }
}

function normalizeResolvedAddress(value: ResolvedAddress): ResolvedAddress {
  const family = isIP(value.address);
  if (family !== value.family || (family !== 4 && family !== 6)) {
    throw new SafeEgressError('EGRESS_DNS_FAILED', 'Resolver returned an invalid address');
  }
  return { address: value.address.toLowerCase(), family };
}

function headerValue(
  headers: Readonly<Record<string, string | string[] | undefined>>,
  name: string,
): string | undefined {
  const value = headers[name] ?? headers[name.toLowerCase()];
  return Array.isArray(value) ? value[0] : value;
}

function validateUrl(rawUrl: string | URL): URL {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch (error) {
    throw new SafeEgressError('EGRESS_INVALID_URL', 'Destination URL is invalid', error);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new SafeEgressError('EGRESS_PROTOCOL_BLOCKED', 'Only HTTP and HTTPS are allowed');
  }
  if (url.username || url.password) {
    throw new SafeEgressError('EGRESS_CREDENTIALS_BLOCKED', 'URL credentials are not allowed');
  }
  if (!url.hostname || url.hostname.endsWith('.local')) {
    throw new SafeEgressError('EGRESS_INVALID_URL', 'Destination hostname is invalid');
  }
  const effectivePort = url.port || (url.protocol === 'https:' ? '443' : '80');
  if (
    (url.protocol === 'https:' && effectivePort !== '443') ||
    (url.protocol === 'http:' && effectivePort !== '80')
  ) {
    throw new SafeEgressError('EGRESS_PORT_BLOCKED', 'Only the default HTTP(S) port is allowed');
  }
  url.hash = '';
  return url;
}

async function* wireLimitedBody(
  response: EgressTransportResponse,
  maxWireBytes: number,
  abort: () => void,
): AsyncIterable<Uint8Array> {
  let wireBytes = 0;
  for await (const chunk of response.body) {
    const buffer = Buffer.from(chunk);
    wireBytes += buffer.length;
    if (wireBytes > maxWireBytes) {
      abort();
      throw new SafeEgressError('EGRESS_WIRE_RESPONSE_TOO_LARGE', 'Wire response is too large');
    }
    yield buffer;
  }
}

function decodedBody(
  response: EgressTransportResponse,
  maxWireBytes: number,
  abort: () => void,
): AsyncIterable<Uint8Array> {
  const encoding = (headerValue(response.headers, 'content-encoding') || 'identity').trim().toLowerCase();
  const decoder =
    encoding === 'gzip' || encoding === 'x-gzip'
      ? createGunzip()
      : encoding === 'deflate'
        ? createInflate()
        : encoding === 'br'
          ? createBrotliDecompress()
          : null;
  if (encoding !== '' && encoding !== 'identity' && !decoder) {
    throw new SafeEgressError('EGRESS_CONTENT_ENCODING_BLOCKED', 'Response content encoding is not allowed');
  }
  const source = Readable.from(wireLimitedBody(response, maxWireBytes, abort));
  if (encoding === '' || encoding === 'identity') return source;
  if (decoder) {
    source.on('error', (error) => decoder.destroy(error));
    return source.pipe(decoder);
  }
  return source;
}

function metricDestination(url: URL): string {
  const port = url.port ? `:${url.port}` : '';
  return `${url.protocol}//${url.hostname}${port}`;
}

export function redactEgressUrl(rawUrl: string | URL): string {
  try {
    return metricDestination(validateUrl(rawUrl));
  } catch {
    return '[invalid-egress-url]';
  }
}

const defaultResolver: EgressResolver = async (hostname) => {
  const literalFamily = isIP(hostname);
  if (literalFamily === 4 || literalFamily === 6) {
    return [{ address: hostname, family: literalFamily }];
  }
  const rows = await dns.lookup(hostname, { all: true, verbatim: true });
  return rows.map((row) => ({ address: row.address, family: row.family as 4 | 6 }));
};

export function createNodeTransport(
  requesters: {
    httpRequest?: typeof http.request;
    httpsRequest?: typeof https.request;
  } = {},
): EgressTransport {
  return ({ url, address, headers, connectTimeoutMs, totalTimeoutMs }) =>
    new Promise<EgressTransportResponse>((resolve, reject) => {
      const requestFn =
        url.protocol === 'https:'
          ? requesters.httpsRequest ?? https.request
          : requesters.httpRequest ?? http.request;
      const defaultPort = url.protocol === 'https:' ? 443 : 80;
      const hostHeader = url.port ? `${url.hostname}:${url.port}` : url.hostname;
      const identityHostname = url.hostname.replace(/^\[|\]$/g, '');
      let connected = false;
      let settled = false;
      let cleaned = false;
      let destroyed = false;
      let responseStream: http.IncomingMessage | undefined;
      let requestSocket: Socket | undefined;
      let socketConnectEvent: 'connect' | 'secureConnect' | undefined;
      let connectTimer: NodeJS.Timeout | undefined;
      let totalTimer: NodeJS.Timeout | undefined;
      function onSocketConnected() {
        connected = true;
        if (connectTimer) clearTimeout(connectTimer);
      }
      function onResponseFinished() {
        cleanupRequest();
      }
      function onSocket(socket: Socket) {
        requestSocket = socket;
        socketConnectEvent = url.protocol === 'https:' ? 'secureConnect' : 'connect';
        socket.once(socketConnectEvent, onSocketConnected);
      }
      function onRequestError(error: Error) {
        if (settled) {
          cleanupRequest();
          return;
        }
        const code = connected ? 'EGRESS_TRANSPORT_ERROR' : 'EGRESS_CONNECT_TIMEOUT';
        fail(new SafeEgressError(code, 'Transport failed', error));
      }
      function cleanupRequest() {
        if (cleaned) return;
        cleaned = true;
        if (connectTimer) clearTimeout(connectTimer);
        if (totalTimer) clearTimeout(totalTimer);
        request.removeListener('socket', onSocket);
        request.removeListener('error', onRequestError);
        if (requestSocket && socketConnectEvent) {
          requestSocket.removeListener(socketConnectEvent, onSocketConnected);
        }
        responseStream?.removeListener('end', onResponseFinished);
        responseStream?.removeListener('close', onResponseFinished);
        responseStream?.removeListener('error', onResponseFinished);
      }
      function destroyRequest() {
        cleanupRequest();
        if (destroyed) return;
        destroyed = true;
        request.destroy();
      }

      function onResponse(response: http.IncomingMessage) {
        if (settled || destroyed) {
          response.destroy();
          return;
        }
        settled = true;
        if (connectTimer) clearTimeout(connectTimer);
        responseStream = response;
        response.once('end', onResponseFinished);
        response.once('close', onResponseFinished);
        response.once('error', onResponseFinished);
        resolve({
          status: response.statusCode || 0,
          headers: response.headers,
          body: response,
          abort: destroyRequest,
        });
      }

      const request = requestFn(
        {
          protocol: url.protocol,
          hostname: address.address,
          family: address.family,
          port: Number(url.port || defaultPort),
          method: 'GET',
          path: `${url.pathname}${url.search}`,
          headers: { ...headers, host: hostHeader },
          servername: isIP(identityHostname) ? undefined : identityHostname,
          rejectUnauthorized: true,
          agent: false,
        },
        onResponse,
      );

      function fail(error: SafeEgressError) {
        if (settled) return;
        settled = true;
        destroyRequest();
        reject(error);
      }

      connectTimer = setTimeout(
        () => fail(new SafeEgressError('EGRESS_CONNECT_TIMEOUT', 'Connection timed out')),
        connectTimeoutMs,
      );
      totalTimer = setTimeout(() => {
        const error = new SafeEgressError('EGRESS_TOTAL_TIMEOUT', 'Request timed out');
        if (settled) destroyRequest();
        else fail(error);
      }, totalTimeoutMs);

      request.on('socket', onSocket);
      request.on('error', onRequestError);
      request.end();

      totalTimer.unref();
    });
}

export class SafeEgressFetcher {
  private readonly metrics = new Map<string, number>();

  constructor(
    private readonly resolver: EgressResolver = defaultResolver,
    private readonly transport: EgressTransport = createNodeTransport(),
    private readonly onMetric?: (event: SafeEgressMetricEvent) => void,
  ) {}

  getMetricSnapshot(): Readonly<Record<string, number>> {
    return Object.fromEntries(this.metrics);
  }

  async fetch(rawUrl: string | URL, options: SafeEgressFetchOptions = {}): Promise<SafeEgressResponse> {
    const maxRedirects = options.maxRedirects ?? DEFAULT_MAX_REDIRECTS;
    const connectTimeoutMs = options.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS;
    const totalTimeoutMs = options.totalTimeoutMs ?? DEFAULT_TOTAL_TIMEOUT_MS;
    const maxWireBytes = options.maxWireBytes ?? DEFAULT_MAX_WIRE_BYTES;
    const maxResponseBytes = options.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES;
    const allowedContentTypes = options.allowedContentTypes ?? DEFAULT_ALLOWED_CONTENT_TYPES;
    const startedAt = Date.now();
    let current: URL;
    try {
      current = validateUrl(rawUrl);
    } catch (error) {
      this.recordError(error, rawUrl);
      throw error;
    }

    for (let redirects = 0; ; redirects += 1) {
      const remainingMs = totalTimeoutMs - (Date.now() - startedAt);
      if (remainingMs <= 0) {
        const error = new SafeEgressError('EGRESS_TOTAL_TIMEOUT', 'Request timed out');
        this.recordError(error, current);
        throw error;
      }

      let addresses: ResolvedAddress[];
      try {
        const resolutionHostname = current.hostname.replace(/^\[|\]$/g, '');
        let dnsTimer: NodeJS.Timeout | undefined;
        const resolution = Promise.resolve().then(() => this.resolver(resolutionHostname));
        addresses = (
          await Promise.race([
            resolution,
            new Promise<never>((_, reject) => {
              dnsTimer = setTimeout(
                () => reject(new SafeEgressError('EGRESS_TOTAL_TIMEOUT', 'DNS lookup timed out')),
                remainingMs,
              );
            }),
          ]).finally(() => {
            if (dnsTimer) clearTimeout(dnsTimer);
          })
        ).map(normalizeResolvedAddress);
      } catch (error) {
        const normalized =
          error instanceof SafeEgressError
            ? error
            : new SafeEgressError('EGRESS_DNS_FAILED', 'Destination DNS lookup failed', error);
        this.recordError(normalized, current);
        throw normalized;
      }
      if (!addresses.length) {
        const error = new SafeEgressError('EGRESS_DNS_FAILED', 'Destination has no addresses');
        this.recordError(error, current);
        throw error;
      }
      if (addresses.some(({ address }) => !isPublicEgressAddress(address))) {
        const error = new SafeEgressError('EGRESS_ADDRESS_BLOCKED', 'Destination address is not public');
        this.recordError(error, current);
        throw error;
      }

      let response: EgressTransportResponse;
      try {
        response = await this.transport({
          url: current,
          address: addresses[0],
          headers: {
            accept: allowedContentTypes.join(', '),
            'accept-encoding': 'gzip, deflate, br',
            'user-agent': 'Vaysen Vaysen CRM/2.0 safe-egress',
          },
          connectTimeoutMs: Math.min(connectTimeoutMs, remainingMs),
          totalTimeoutMs: remainingMs,
        });
      } catch (error) {
        const normalized =
          error instanceof SafeEgressError
            ? error
            : new SafeEgressError('EGRESS_TRANSPORT_ERROR', 'Transport failed', error);
        this.recordError(normalized, current);
        throw normalized;
      }
      let responseAborted = false;
      const abortResponse = () => {
        if (responseAborted) return;
        responseAborted = true;
        response.abort();
      };

      if (REDIRECT_STATUSES.has(response.status)) {
        abortResponse();
        if (redirects >= maxRedirects) {
          const error = new SafeEgressError('EGRESS_REDIRECT_LIMIT', 'Redirect limit exceeded');
          this.recordError(error, current);
          throw error;
        }
        const location = headerValue(response.headers, 'location');
        if (!location) {
          const error = new SafeEgressError('EGRESS_REDIRECT_INVALID', 'Redirect location is missing');
          this.recordError(error, current);
          throw error;
        }
        try {
          current = validateUrl(new URL(location, current));
        } catch (cause) {
          const error =
            cause instanceof SafeEgressError
              ? cause
              : new SafeEgressError('EGRESS_REDIRECT_INVALID', 'Redirect location is invalid', cause);
          this.recordError(error, current);
          throw error;
        }
        continue;
      }

      const contentType = (headerValue(response.headers, 'content-type') || '')
        .split(';', 1)[0]
        .trim()
        .toLowerCase();
      if (!contentType || !allowedContentTypes.some((allowed) => contentType === allowed.toLowerCase())) {
        abortResponse();
        const error = new SafeEgressError('EGRESS_CONTENT_TYPE_BLOCKED', 'Response content type is not allowed');
        this.recordError(error, current);
        throw error;
      }

      const declaredLength = Number(headerValue(response.headers, 'content-length') || 0);
      if (Number.isFinite(declaredLength) && declaredLength > maxWireBytes) {
        abortResponse();
        const error = new SafeEgressError('EGRESS_WIRE_RESPONSE_TOO_LARGE', 'Wire response is too large');
        this.recordError(error, current);
        throw error;
      }

      const chunks: Buffer[] = [];
      let received = 0;
      let iterator: AsyncIterator<Uint8Array> | undefined;
      try {
        iterator = decodedBody(response, maxWireBytes, abortResponse)[Symbol.asyncIterator]();
        for (;;) {
          const streamRemainingMs = totalTimeoutMs - (Date.now() - startedAt);
          if (streamRemainingMs <= 0) {
            abortResponse();
            throw new SafeEgressError('EGRESS_TOTAL_TIMEOUT', 'Request timed out');
          }
          let timeout: NodeJS.Timeout | undefined;
          const next = await Promise.race([
            iterator.next(),
            new Promise<never>((_, reject) => {
              timeout = setTimeout(() => {
                abortResponse();
                reject(new SafeEgressError('EGRESS_TOTAL_TIMEOUT', 'Request timed out'));
              }, streamRemainingMs);
            }),
          ]).finally(() => {
            if (timeout) clearTimeout(timeout);
          });
          if (next.done) break;
          const chunk = next.value;
          const buffer = Buffer.from(chunk);
          received += buffer.length;
          if (received > maxResponseBytes) {
            abortResponse();
            throw new SafeEgressError('EGRESS_RESPONSE_TOO_LARGE', 'Response is too large');
          }
          if (Date.now() - startedAt >= totalTimeoutMs) {
            abortResponse();
            throw new SafeEgressError('EGRESS_TOTAL_TIMEOUT', 'Request timed out');
          }
          chunks.push(buffer);
        }
      } catch (error) {
        abortResponse();
        try {
          const cleanup = iterator?.return?.();
          if (cleanup) void Promise.resolve(cleanup).catch(() => undefined);
        } catch {
          // The transport abort is authoritative; iterator cleanup errors stay redacted.
        }
        const normalized =
          error instanceof SafeEgressError
            ? error
            : new SafeEgressError('EGRESS_TRANSPORT_ERROR', 'Response stream failed', error);
        this.recordError(normalized, current);
        throw normalized;
      }

      const body = Buffer.concat(chunks, received);
      this.record({
        outcome: 'allowed',
        code: 'EGRESS_OK',
        destination: metricDestination(current),
      });
      return {
        url: current,
        status: response.status,
        headers: response.headers,
        body,
        redirects,
        text: (encoding: BufferEncoding = 'utf8') => body.toString(encoding),
      };
    }
  }

  private recordError(error: unknown, rawUrl: string | URL) {
    const normalized =
      error instanceof SafeEgressError
        ? error
        : new SafeEgressError('EGRESS_TRANSPORT_ERROR', 'Egress request failed', error);
    this.record({
      outcome:
        normalized.code.includes('BLOCKED') ||
        normalized.code.includes('INVALID') ||
        normalized.code === 'EGRESS_REDIRECT_LIMIT'
          ? 'blocked'
          : 'failed',
      code: normalized.code,
      destination: redactEgressUrl(rawUrl),
    });
  }

  private record(event: SafeEgressMetricEvent) {
    this.metrics.set(event.code, (this.metrics.get(event.code) || 0) + 1);
    this.onMetric?.(event);
  }
}

export const safeInternetFetcher = new SafeEgressFetcher();
