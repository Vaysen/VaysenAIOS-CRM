export const DEFAULT_SEARXNG_BASE_URL = 'http://127.0.0.1:8080';

export interface SearxngResult {
  title: string;
  url: string;
  snippet: string;
}
export interface TrustedSearxngOptions {
  baseUrl?: string;
  timeoutMs?: number;
  maxResponseBytes?: number;
  fetchImpl?: typeof fetch;
}

function buildSearchUrl(rawBaseUrl: string, query: string): URL {
  let url: URL;
  try {
    url = new URL(rawBaseUrl);
  } catch {
    throw new Error('SEARXNG_CONFIG_INVALID');
  }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
    throw new Error('SEARXNG_CONFIG_INVALID');
  }
  url.pathname = `${url.pathname.replace(/\/$/, '')}/search`;
  url.search = '';
  url.hash = '';
  url.searchParams.set('q', query);
  url.searchParams.set('format', 'json');
  url.searchParams.set('language', 'en');
  return url;
}

async function readBoundedJson(response: Response, maxResponseBytes: number): Promise<unknown> {
  const contentType = response.headers.get('content-type') || '';
  if (!/^application\/json(?:\s*;|$)/i.test(contentType)) {
    throw new Error('SEARXNG_RESPONSE_MIME_INVALID');
  }
  const declaredLength = Number(response.headers.get('content-length') || 0);
  if (Number.isFinite(declaredLength) && declaredLength > maxResponseBytes) {
    throw new Error('SEARXNG_RESPONSE_TOO_LARGE');
  }
  if (!response.body) throw new Error('SEARXNG_RESPONSE_EMPTY');

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let received = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    received += value.byteLength;
    if (received > maxResponseBytes) {
      await reader.cancel();
      throw new Error('SEARXNG_RESPONSE_TOO_LARGE');
    }
    chunks.push(value);
  }
  const text = Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)), received).toString('utf8');
  try {
    return JSON.parse(text);
  } catch {
    throw new Error('SEARXNG_RESPONSE_JSON_INVALID');
  }
}

export async function searchTrustedSearxng(
  query: string,
  limit: number,
  options: TrustedSearxngOptions = {},
): Promise<SearxngResult[]> {
  const timeoutMs = options.timeoutMs ?? 10_000;
  const maxResponseBytes = options.maxResponseBytes ?? 1024 * 1024;
  const fetchImpl = options.fetchImpl ?? fetch;
  const url = buildSearchUrl(options.baseUrl ?? DEFAULT_SEARXNG_BASE_URL, query);
  const response = await fetchImpl(url, {
    headers: {
      accept: 'application/json',
      'user-agent': 'Vaysen Vaysen CRM/2.0 trusted-searxng',
    },
    redirect: 'error',
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) throw new Error(`SEARXNG_HTTP_${response.status}`);
  const payload: any = await readBoundedJson(response, maxResponseBytes);
  if (!payload || !Array.isArray(payload.results)) throw new Error('SEARXNG_RESULTS_INVALID');

  return payload.results
    .slice(0, Math.max(0, limit))
    .map((item: any) => ({
      title: String(item?.title || ''),
      url: String(item?.url || ''),
      snippet: String(item?.content ?? item?.snippet ?? ''),
    }))
    .filter((item: SearxngResult) => /^https?:\/\//i.test(item.url));
}
