import { DEFAULT_SEARXNG_BASE_URL } from '@/common/http/trusted-searxng-client';
import {
  SafeEgressError,
  safeInternetFetcher,
} from '@/common/security/safe-egress-fetcher';
import { SearchService } from './search.service';

describe('SearchService provider and candidate egress boundaries', () => {
  const originalUrl = process.env.SEARXNG_URL;
  const originalBaseUrl = process.env.SEARXNG_BASE_URL;

  afterEach(() => {
    jest.restoreAllMocks();
    if (originalUrl === undefined) delete process.env.SEARXNG_URL;
    else process.env.SEARXNG_URL = originalUrl;
    if (originalBaseUrl === undefined) delete process.env.SEARXNG_BASE_URL;
    else process.env.SEARXNG_BASE_URL = originalBaseUrl;
  });

  function service() {
    const instance = Object.create(SearchService.prototype) as SearchService;
    (instance as any).logger = { warn: jest.fn() };
    return instance;
  }

  it('keeps the default private SearXNG JSON provider operational', async () => {
    delete process.env.SEARXNG_URL;
    delete process.env.SEARXNG_BASE_URL;
    const fetchMock = jest.spyOn(global, 'fetch').mockImplementation(async () =>
      new Response(JSON.stringify({
        results: [{
          title: '<b>Vaysen buyer</b>',
          url: 'https://public.example/contact',
          content: '<p>Evidence excerpt</p>',
        }],
      }), { headers: { 'content-type': 'application/json' } }),
    );

    await expect((service() as any).searxngSearch('packaging buyer', 1)).resolves.toEqual([{
      title: 'Vaysen buyer',
      url: 'https://public.example/contact',
      snippet: 'Evidence excerpt',
    }]);
    const [input, init] = fetchMock.mock.calls[0];
    expect(new URL(String(input)).origin).toBe(DEFAULT_SEARXNG_BASE_URL);
    expect(init).toMatchObject({ redirect: 'error' });
  });

  it('fails closed for private or JSON candidate pages without weakening provider access', async () => {
    const fetchSpy = jest.spyOn(safeInternetFetcher, 'fetch');
    fetchSpy
      .mockRejectedValueOnce(new SafeEgressError('EGRESS_ADDRESS_BLOCKED', 'blocked'))
      .mockRejectedValueOnce(new SafeEgressError('EGRESS_CONTENT_TYPE_BLOCKED', 'blocked'));
    const instance = service();

    await expect((instance as any).fetchText('http://127.0.0.1/private')).resolves.toBe('');
    await expect((instance as any).fetchText('https://public.example/provider.json')).resolves.toBe('');
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect((instance as any).logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('code=EGRESS_ADDRESS_BLOCKED'),
    );
    expect((instance as any).logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('code=EGRESS_CONTENT_TYPE_BLOCKED'),
    );
  });
});
