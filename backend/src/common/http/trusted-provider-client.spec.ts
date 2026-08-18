import {
  requestTrustedProviderJson,
  TrustedProviderError,
} from './trusted-provider-client';

function response(body: string, headers: Record<string, string> = { 'content-type': 'application/json' }) {
  return new Response(body, { status: 200, headers });
}

describe('trusted provider client', () => {
  it.each([
    'ftp://reacher.internal/check',
    'http://user:secret@reacher.internal/check',
    'http://reacher.internal/check#fragment',
  ])('rejects invalid deployer configuration: %s', async (url) => {
    await expect(requestTrustedProviderJson(url, {
      provider: 'reacher',
      fetchImpl: jest.fn() as any,
    })).rejects.toMatchObject({ code: 'PROVIDER_CONFIG_INVALID' });
  });

  it('does not follow redirects and accepts private service names', async () => {
    const fetchImpl = jest.fn(async (_url: URL, init: RequestInit) => {
      expect(init.redirect).toBe('error');
      return response('{"is_reachable":"safe"}');
    }) as any;
    const result = await requestTrustedProviderJson('http://reacher:8080/v0/check_email', {
      provider: 'reacher',
      fetchImpl,
    });
    expect(result.data).toEqual({ is_reachable: 'safe' });
  });

  it('rejects non-JSON and streamed oversized responses', async () => {
    await expect(requestTrustedProviderJson('http://reacher:8080/check', {
      provider: 'reacher',
      fetchImpl: jest.fn(async () => response('<html/>', { 'content-type': 'text/html' })) as any,
    })).rejects.toMatchObject({ code: 'PROVIDER_RESPONSE_MIME_INVALID' });

    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(new Uint8Array(8));
        controller.enqueue(new Uint8Array(8));
        controller.close();
      },
    });
    await expect(requestTrustedProviderJson('http://reacher:8080/check', {
      provider: 'reacher',
      maxResponseBytes: 12,
      fetchImpl: jest.fn(async () => new Response(stream, {
        headers: { 'content-type': 'application/json' },
      })) as any,
    })).rejects.toMatchObject({ code: 'PROVIDER_RESPONSE_TOO_LARGE' });
  });

  it('normalizes provider timeout errors without exposing the URL', async () => {
    const timeout = Object.assign(new Error('http://secret.internal/?token=hidden'), { name: 'TimeoutError' });
    await expect(requestTrustedProviderJson('http://reacher:8080/check?tenant=private', {
      provider: 'reacher',
      fetchImpl: jest.fn(async () => { throw timeout; }) as any,
    })).rejects.toEqual(expect.objectContaining<Partial<TrustedProviderError>>({
      code: 'PROVIDER_TIMEOUT',
      message: 'reacher:PROVIDER_TIMEOUT',
    }));
  });
});
