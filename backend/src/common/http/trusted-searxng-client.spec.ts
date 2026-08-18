import {
  DEFAULT_SEARXNG_BASE_URL,
  searchTrustedSearxng,
} from './trusted-searxng-client';

describe('trusted SearXNG provider client', () => {
  it('keeps the default local JSON provider working without weakening public egress', async () => {
    const fetchImpl = jest
      .fn<ReturnType<typeof fetch>, Parameters<typeof fetch>>()
      .mockResolvedValue(
      new Response(
        JSON.stringify({
          results: [
            {
              title: '<b>Public result</b>',
              url: 'https://public.example/page',
              content: 'Evidence snippet',
            },
          ],
        }),
        { status: 200, headers: { 'content-type': 'application/json; charset=utf-8' } },
      ),
      );
    const rows = await searchTrustedSearxng('industrial packaging', 5, { fetchImpl });
    expect(rows).toEqual([
      {
        title: '<b>Public result</b>',
        url: 'https://public.example/page',
        snippet: 'Evidence snippet',
      },
    ]);
    const requested = new URL(String(fetchImpl.mock.calls[0][0]));
    expect(requested.origin).toBe(DEFAULT_SEARXNG_BASE_URL);
    expect(requested.pathname).toBe('/search');
    expect(requested.searchParams.get('format')).toBe('json');
    expect(fetchImpl.mock.calls[0][1]).toMatchObject({ redirect: 'error' });
  });

  it('rejects credentials or non-HTTP provider configuration before fetch', async () => {
    const fetchImpl = jest.fn<ReturnType<typeof fetch>, Parameters<typeof fetch>>();
    await expect(
      searchTrustedSearxng('x', 1, { baseUrl: 'file:///etc/passwd', fetchImpl }),
    ).rejects.toThrow('SEARXNG_CONFIG_INVALID');
    await expect(
      searchTrustedSearxng('x', 1, { baseUrl: 'http://user:pass@127.0.0.1:8080', fetchImpl }),
    ).rejects.toThrow('SEARXNG_CONFIG_INVALID');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('rejects non-JSON and oversized provider responses', async () => {
    const wrongMime = jest
      .fn<ReturnType<typeof fetch>, Parameters<typeof fetch>>()
      .mockResolvedValue(new Response('{}', { headers: { 'content-type': 'text/html' } }));
    await expect(searchTrustedSearxng('x', 1, { fetchImpl: wrongMime })).rejects.toThrow(
      'SEARXNG_RESPONSE_MIME_INVALID',
    );

    const oversized = jest
      .fn<ReturnType<typeof fetch>, Parameters<typeof fetch>>()
      .mockResolvedValue(
        new Response('{}', {
          headers: { 'content-type': 'application/json', 'content-length': '3' },
        }),
      );
    await expect(
      searchTrustedSearxng('x', 1, { fetchImpl: oversized, maxResponseBytes: 2 }),
    ).rejects.toThrow('SEARXNG_RESPONSE_TOO_LARGE');
  });
});
