export type TrustedProviderErrorCode =
  | 'PROVIDER_CONFIG_INVALID'
  | 'PROVIDER_TIMEOUT'
  | 'PROVIDER_RESPONSE_MIME_INVALID'
  | 'PROVIDER_RESPONSE_TOO_LARGE'
  | 'PROVIDER_RESPONSE_EMPTY'
  | 'PROVIDER_RESPONSE_JSON_INVALID';

export class TrustedProviderError extends Error {
  constructor(
    readonly code: TrustedProviderErrorCode,
    readonly provider: string,
  ) {
    super(`${provider}:${code}`);
    this.name = 'TrustedProviderError';
  }
}

export interface TrustedJsonRequestOptions {
  provider: string;
  method?: 'GET' | 'POST';
  headers?: Record<string, string>;
  body?: string;
  timeoutMs?: number;
  maxResponseBytes?: number;
  fetchImpl?: typeof fetch;
}

function configuredProviderUrl(rawUrl: string, provider: string): URL {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new TrustedProviderError('PROVIDER_CONFIG_INVALID', provider);
  }
  if (!['http:', 'https:'].includes(url.protocol)
    || url.username
    || url.password
    || url.hash) {
    throw new TrustedProviderError('PROVIDER_CONFIG_INVALID', provider);
  }
  return url;
}

async function readBoundedJson(
  response: Response,
  provider: string,
  maxResponseBytes: number,
): Promise<unknown> {
  const contentType = response.headers.get('content-type') || '';
  if (!/^application\/(?:[a-z0-9.+-]+\+)?json(?:\s*;|$)/i.test(contentType)) {
    throw new TrustedProviderError('PROVIDER_RESPONSE_MIME_INVALID', provider);
  }
  const declaredLength = Number(response.headers.get('content-length') || 0);
  if (Number.isFinite(declaredLength) && declaredLength > maxResponseBytes) {
    throw new TrustedProviderError('PROVIDER_RESPONSE_TOO_LARGE', provider);
  }
  if (!response.body) throw new TrustedProviderError('PROVIDER_RESPONSE_EMPTY', provider);

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let received = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    received += value.byteLength;
    if (received > maxResponseBytes) {
      await reader.cancel();
      throw new TrustedProviderError('PROVIDER_RESPONSE_TOO_LARGE', provider);
    }
    chunks.push(value);
  }
  try {
    return JSON.parse(Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)), received).toString('utf8'));
  } catch {
    throw new TrustedProviderError('PROVIDER_RESPONSE_JSON_INVALID', provider);
  }
}

export async function requestTrustedProviderJson(
  rawUrl: string,
  options: TrustedJsonRequestOptions,
): Promise<{ status: number; ok: boolean; data: unknown }> {
  const url = configuredProviderUrl(rawUrl, options.provider);
  const timeoutMs = options.timeoutMs ?? 10_000;
  const maxResponseBytes = options.maxResponseBytes ?? 256 * 1024;
  const fetchImpl = options.fetchImpl ?? fetch;
  try {
    const response = await fetchImpl(url, {
      method: options.method ?? 'GET',
      headers: {
        accept: 'application/json',
        'user-agent': 'Vaysen Vaysen CRM/2.0 trusted-provider',
        ...options.headers,
      },
      body: options.body,
      redirect: 'error',
      signal: AbortSignal.timeout(timeoutMs),
    });
    const data = await readBoundedJson(response, options.provider, maxResponseBytes);
    return { status: response.status, ok: response.ok, data };
  } catch (error: any) {
    if (error instanceof TrustedProviderError) throw error;
    if (error?.name === 'TimeoutError' || error?.name === 'AbortError') {
      throw new TrustedProviderError('PROVIDER_TIMEOUT', options.provider);
    }
    throw error;
  }
}
