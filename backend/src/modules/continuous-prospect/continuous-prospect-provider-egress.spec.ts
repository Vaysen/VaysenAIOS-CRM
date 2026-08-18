import { DEFAULT_SEARXNG_BASE_URL } from '@/common/http/trusted-searxng-client';
import { ContinuousProspectService } from './continuous-prospect.service';

describe('ContinuousProspectService trusted search provider boundary', () => {
  const originalUrl = process.env.SEARXNG_URL;
  const originalBaseUrl = process.env.SEARXNG_BASE_URL;

  afterEach(() => {
    jest.restoreAllMocks();
    if (originalUrl === undefined) delete process.env.SEARXNG_URL;
    else process.env.SEARXNG_URL = originalUrl;
    if (originalBaseUrl === undefined) delete process.env.SEARXNG_BASE_URL;
    else process.env.SEARXNG_BASE_URL = originalBaseUrl;
  });

  it('routes both provider search paths through bounded local JSON requests', async () => {
    delete process.env.SEARXNG_URL;
    delete process.env.SEARXNG_BASE_URL;
    const fetchMock = jest.spyOn(global, 'fetch').mockImplementation(async () =>
      new Response(
        JSON.stringify({
          results: [
            {
              title: '<b>Packaging buyer</b>',
              url: 'https://public.example/contact',
              content: '<p>Public evidence</p>',
            },
            {
              title: 'Second result',
              url: 'https://second.example/',
              content: 'Second snippet',
            },
            {
              title: 'Third result',
              url: 'https://third.example/',
              content: 'Third snippet',
            },
          ],
        }),
        { headers: { 'content-type': 'application/json' } },
      ),
    );
    const service = new ContinuousProspectService({} as any);

    const broad = await (service as any).searchWeb(
      { keywords: ['packaging'], targetCountry: '', maxResults: 1 },
      1,
    );
    const fallback = await (service as any).duckDuckGoSearch('packaging buyer', 1);

    expect(broad).toHaveLength(3);
    expect(broad[0].title).toBe('Packaging buyer');
    expect(fallback).toEqual([
      {
        title: 'Packaging buyer',
        url: 'https://public.example/contact',
        snippet: 'Public evidence',
      },
    ]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    for (const [input, init] of fetchMock.mock.calls) {
      const requested = new URL(String(input));
      expect(requested.origin).toBe(DEFAULT_SEARXNG_BASE_URL);
      expect(requested.searchParams.get('format')).toBe('json');
      expect(init).toMatchObject({ redirect: 'error' });
    }
  });

  it('fails closed in both paths when the provider returns non-JSON content', async () => {
    jest
      .spyOn(global, 'fetch')
      .mockImplementation(async () =>
        new Response('<html>not provider JSON</html>', {
          headers: { 'content-type': 'text/html' },
        }),
      );
    const service = new ContinuousProspectService({} as any);

    await expect(
      (service as any).searchWeb(
        { keywords: ['packaging'], targetCountry: '', maxResults: 1 },
        1,
      ),
    ).resolves.toEqual([]);
    await expect((service as any).duckDuckGoSearch('packaging buyer', 1)).resolves.toEqual([]);
  });
});
