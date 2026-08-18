import { completeAiJson } from '@/common/ai/ai-client.util';
import { Logger } from '@nestjs/common';
import {
  DataGathererService,
  RESEARCH_EVIDENCE_FAILURE_CODE,
  RESEARCH_EVIDENCE_FAILURE_MESSAGE,
} from './data-gatherer.service';

jest.mock('@/common/ai/ai-client.util', () => ({
  completeAiJson: jest.fn(),
}));

const completeAiJsonMock = completeAiJson as jest.MockedFunction<typeof completeAiJson>;
const originalFetch = global.fetch;

function jsonResponse(results: any[], init: ResponseInit = {}) {
  return new Response(JSON.stringify({ results }), {
    status: 200,
    ...init,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      ...(init.headers || {}),
    },
  });
}

describe('DataGathererService', () => {
  const originalSearxngUrl = process.env.SEARXNG_URL;
  const originalSearxngBaseUrl = process.env.SEARXNG_BASE_URL;
  let fetchMock: jest.MockedFunction<typeof fetch>;
  let service: DataGathererService;

  beforeEach(() => {
    process.env.SEARXNG_URL = 'http://searxng:8080';
    delete process.env.SEARXNG_BASE_URL;
    fetchMock = jest.fn();
    global.fetch = fetchMock;
    completeAiJsonMock.mockReset();
    completeAiJsonMock.mockResolvedValue({
      data: {
        summary: '<img src=x onerror=alert(1)>Evidence-backed summary',
        summarySources: ['https://registry.example/acme'],
        findings: [],
      },
      text: '{"summary":"Evidence-backed summary"}',
      provider: 'zhipu',
      model: 'glm-4.5',
    });
    service = new DataGathererService();
  });

  afterEach(() => {
    global.fetch = originalFetch;
    jest.restoreAllMocks();
  });

  afterAll(() => {
    if (originalSearxngUrl === undefined) delete process.env.SEARXNG_URL;
    else process.env.SEARXNG_URL = originalSearxngUrl;
    if (originalSearxngBaseUrl === undefined) delete process.env.SEARXNG_BASE_URL;
    else process.env.SEARXNG_BASE_URL = originalSearxngBaseUrl;
  });

  it('uses deterministic company, country and website-domain queries and returns an evidence report', async () => {
    completeAiJsonMock.mockResolvedValue({
      data: {
        summary: '<img src=x onerror=alert(1)>Evidence-backed summary',
        summarySources: ['https://registry.example/acme'],
        findings: [{
          category: 'registration',
          claim: 'The public search result describes an active registration.',
          supportingExcerpt: 'Public registration summary & status',
          sourceUrls: ['https://registry.example/acme'],
        }],
      },
      text: '{"summary":"Evidence-backed summary"}',
      provider: 'nvidia',
      model: 'meta/llama-3.1-70b-instruct',
    });
    fetchMock.mockImplementation(async () =>
      jsonResponse([
        {
          title: 'Acme public company profile',
          url: 'https://registry.example/acme',
          content: 'Public registration summary & status',
        },
      ]),
    );

    const result = await service.gatherAll('Acme Packaging', 'https://acme.example/about', 'Germany');

    expect(result.error).toBeUndefined();
    expect(result.json.evidenceSources).toEqual([
      {
        title: 'Acme public company profile',
        url: 'https://registry.example/acme',
        snippet: 'Public registration summary & status',
      },
    ]);
    expect(result.json.summarySources).toEqual(['https://registry.example/acme']);
    expect(result.json.findings[0].sourceUrls).toEqual(['https://registry.example/acme']);
    expect(result.json.findings[0].supportingExcerpt).toBe('Public registration summary & status');
    expect(result.json.provider).toBe('nvidia');
    expect(result.html).toContain('nvidia (meta/llama-3.1-70b-instruct)');
    expect(result.html).not.toContain('智谱 GLM');
    expect(result.html).toContain('https://registry.example/acme');
    expect(result.html).toContain('Public registration summary &amp; status');
    expect(result.html).toContain('&lt;img src=x onerror=alert(1)&gt;');
    expect(result.html).not.toContain('<img src=x onerror=alert(1)>');

    for (const [requestUrl] of fetchMock.mock.calls) {
      const query = new URL(String(requestUrl)).searchParams.get('q') || '';
      expect(query).toContain('Acme Packaging');
      expect(query).toContain('Germany');
      expect(query).toContain('acme.example');
    }
  });

  it('fails closed without calling GLM when SearXNG returns no results', async () => {
    fetchMock.mockImplementation(async () => jsonResponse([]));

    const result = await service.gatherAll('No Evidence Ltd', '', 'Canada');

    expect(result.raw).toBe('');
    expect(result.error).toBe(RESEARCH_EVIDENCE_FAILURE_MESSAGE);
    expect(result.errorCode).toBe('RESEARCH_EVIDENCE_COLLECTION_FAILED');
    expect(completeAiJsonMock).not.toHaveBeenCalled();
  });

  it('fails closed without calling GLM when SearXNG fails', async () => {
    fetchMock.mockRejectedValue(new Error('connection refused'));

    const result = await service.gatherAll('Offline Ltd', 'offline.example', 'USA');

    expect(result.error).toBe(RESEARCH_EVIDENCE_FAILURE_MESSAGE);
    expect(result.errorCode).toBe('RESEARCH_SEARCH_FAILED');
    expect(completeAiJsonMock).not.toHaveBeenCalled();
  });

  it('sanitizes Error and non-Error provider failures from logs and returned errors', async () => {
    const sentinel = 'provider-sentinel@example.com body https://provider.example/?token=secret';
    const loggerError = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    fetchMock.mockRejectedValueOnce(Object.assign(new Error(sentinel), {
      response: { data: sentinel, status: 502 },
      cause: new Error(sentinel),
    }));

    const errorResult = await service.gatherAll('Provider Sentinel Ltd', '', 'USA');
    const errorOutput = JSON.stringify(loggerError.mock.calls);
    expect(errorResult.error).toBe(RESEARCH_EVIDENCE_FAILURE_MESSAGE);
    expect(errorResult.errorCode).toBe('RESEARCH_SEARCH_FAILED');
    expect(errorOutput).not.toContain(sentinel);
    expect(JSON.stringify(errorResult)).not.toContain(sentinel);

    fetchMock.mockRejectedValueOnce({
      message: sentinel,
      response: { data: sentinel },
      cause: sentinel,
    });
    const objectResult = await service.gatherAll('Provider Sentinel Ltd', '', 'USA');
    expect(objectResult.error).toBe(RESEARCH_EVIDENCE_FAILURE_MESSAGE);
    expect(JSON.stringify(loggerError.mock.calls)).not.toContain(sentinel);
    expect(JSON.stringify(objectResult)).not.toContain(sentinel);
  });

  it('sanitizes an AI provider failure without changing the failed result shape', async () => {
    const sentinel = 'ai-provider-sentinel@example.com https://ai.example/?token=secret';
    const loggerError = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    fetchMock.mockImplementation(async () => jsonResponse([{
      title: 'Verified registry entry',
      url: 'https://registry.example/provider-sentinel',
      content: 'Public registration summary',
    }]));
    completeAiJsonMock.mockRejectedValueOnce(new Error(sentinel));

    const result = await service.gatherAll('Provider Sentinel Ltd', '', 'USA');

    expect(result).toEqual({
      raw: '',
      error: RESEARCH_EVIDENCE_FAILURE_MESSAGE,
      errorCode: RESEARCH_EVIDENCE_FAILURE_CODE,
    });
    expect(JSON.stringify(loggerError.mock.calls)).not.toContain(sentinel);
    expect(JSON.stringify(result)).not.toContain(sentinel);
  });

  it('filters private, non-http and duplicate URLs before passing evidence to GLM', async () => {
    completeAiJsonMock.mockResolvedValue({
      data: {
        summary: 'Public evidence summary',
        summarySources: ['https://public.example/company'],
        findings: [],
      },
      text: '{"summary":"Public evidence summary"}',
      provider: 'zhipu',
      model: 'glm-4.5',
    });
    fetchMock.mockImplementation(async () =>
      jsonResponse([
        {
          title: '<b>Verified</b> profile',
          url: 'https://Public.Example/company#overview',
          content: 'First public result',
        },
        {
          title: 'Duplicate profile',
          url: 'https://public.example/company',
          content: 'Duplicate result',
        },
        { title: 'Loopback', url: 'http://127.0.0.1/admin', content: 'secret' },
        { title: 'Private IPv4', url: 'http://192.168.1.8/status', content: 'secret' },
        { title: 'Local hostname', url: 'http://metadata.internal/', content: 'secret' },
        { title: 'File', url: 'file:///etc/passwd', content: 'secret' },
      ]),
    );

    const result = await service.gatherAll('Public Buyer', 'public-buyer.example', 'France');

    expect(result.error).toBeUndefined();
    const aiInput = completeAiJsonMock.mock.calls[0][0];
    const evidenceMessage = String(aiInput.messages[1].content);
    expect(evidenceMessage).toContain('https://public.example/company');
    expect(evidenceMessage).not.toContain('127.0.0.1');
    expect(evidenceMessage).not.toContain('192.168.1.8');
    expect(evidenceMessage).not.toContain('metadata.internal');
    expect(evidenceMessage).not.toContain('file:///');
    expect(result.json.evidenceSources).toHaveLength(1);
    expect(result.json.evidenceSources[0]).toEqual({
      title: 'Verified profile',
      url: 'https://public.example/company',
      snippet: 'First public result',
    });
  });

  it('fails closed when GLM cites only URLs outside the gathered evidence', async () => {
    fetchMock.mockImplementation(async () =>
      jsonResponse([{
        title: 'Verified registry entry',
        url: 'https://registry.example/buyer',
        content: 'Registered company record',
      }]),
    );
    completeAiJsonMock.mockResolvedValue({
      data: {
        summary: 'Unsupported model claim',
        summarySources: ['https://invented.example/'],
        findings: [],
      },
      text: '{"summary":"Unsupported model claim"}',
      provider: 'zhipu',
      model: 'glm-4.5',
    });

    const result = await service.gatherAll('Buyer Ltd', '', 'UK');

    expect(result.raw).toBe('');
    expect(result.error).toBe(RESEARCH_EVIDENCE_FAILURE_MESSAGE);
  });

  it('rejects an uncited finding even when the summary has a valid citation', async () => {
    fetchMock.mockImplementation(async () =>
      jsonResponse([{
        title: 'Verified registry entry',
        url: 'https://registry.example/buyer',
        content: 'Registered company record',
      }]),
    );
    completeAiJsonMock.mockResolvedValue({
      data: {
        summary: 'Registry evidence exists.',
        summarySources: ['https://registry.example/buyer'],
        findings: [{
          category: 'risk',
          claim: 'The buyer has a material credit risk.',
          supportingExcerpt: 'Registered company record',
          sourceUrls: [],
        }],
      },
      text: '{}',
      provider: 'zhipu',
      model: 'glm-4.5',
    });

    const result = await service.gatherAll('Buyer Ltd', '', 'UK');

    expect(result.error).toBe(RESEARCH_EVIDENCE_FAILURE_MESSAGE);
  });

  it('rejects a fabricated URL on any individual finding', async () => {
    fetchMock.mockImplementation(async () =>
      jsonResponse([{
        title: 'Verified registry entry',
        url: 'https://registry.example/buyer',
        content: 'Registered company record',
      }]),
    );
    completeAiJsonMock.mockResolvedValue({
      data: {
        summary: null,
        summarySources: [],
        findings: [{
          category: 'contact',
          claim: 'Jane Doe is the purchasing director.',
          supportingExcerpt: 'Registered company record',
          sourceUrls: ['https://invented.example/jane'],
        }],
      },
      text: '{}',
      provider: 'zhipu',
      model: 'glm-4.5',
    });

    const result = await service.gatherAll('Buyer Ltd', '', 'UK');

    expect(result.error).toBe(RESEARCH_EVIDENCE_FAILURE_MESSAGE);
  });

  it('rejects unknown fields instead of silently archiving unverified facts', async () => {
    fetchMock.mockImplementation(async () =>
      jsonResponse([{
        title: 'Verified registry entry',
        url: 'https://registry.example/buyer',
        content: 'Registered company record',
      }]),
    );
    completeAiJsonMock.mockResolvedValue({
      data: {
        summary: 'Registered company.',
        summarySources: ['https://registry.example/buyer'],
        findings: [],
        creditScore: 100,
      },
      text: '{}',
      provider: 'zhipu',
      model: 'glm-4.5',
    });

    const result = await service.gatherAll('Buyer Ltd', '', 'UK');

    expect(result.error).toBe(RESEARCH_EVIDENCE_FAILURE_MESSAGE);
  });

  it('rejects a model quote that has no conservative overlap with its cited SearXNG snippet', async () => {
    fetchMock.mockImplementation(async () =>
      jsonResponse([{
        title: 'Verified registry entry',
        url: 'https://registry.example/buyer',
        content: 'Registered company record with active status',
      }]),
    );
    completeAiJsonMock.mockResolvedValue({
      data: {
        summary: null,
        summarySources: [],
        findings: [{
          category: 'risk',
          claim: 'The buyer has a material credit risk.',
          supportingExcerpt: 'The buyer has unpaid court judgments',
          sourceUrls: ['https://registry.example/buyer'],
        }],
      },
      text: '{}',
      provider: 'zhipu',
      model: 'glm-4.5',
    });

    const result = await service.gatherAll('Buyer Ltd', '', 'UK');

    expect(result.error).toBe(RESEARCH_EVIDENCE_FAILURE_MESSAGE);
    expect(completeAiJsonMock).toHaveBeenCalledTimes(2);
  });

  it('never archives a model paraphrase when a cited evidence row has a usable exact snippet', async () => {
    fetchMock.mockImplementation(async () =>
      jsonResponse([{
        title: 'Verified registry entry',
        url: 'https://registry.example/buyer',
        content: 'Registered company record with active status',
      }]),
    );
    completeAiJsonMock.mockResolvedValueOnce({
      data: {
        summary: null,
        summarySources: [],
        findings: [{
          category: 'registration',
          claim: 'The registry describes an active company.',
          supportingExcerpt: 'The company is registered and active',
          sourceUrls: ['https://registry.example/buyer'],
        }],
      },
      text: '{}',
      provider: 'zhipu',
      model: 'glm-4.5',
    });

    const result = await service.gatherAll('Buyer Ltd', '', 'UK');

    expect(result.error).toBeUndefined();
    expect(result.json.findings[0].supportingExcerpt).toBe('Registered company record with active status');
    expect(completeAiJsonMock).toHaveBeenCalledTimes(1);
  });

  it('fails closed when a cited SearXNG row has no usable excerpt to materialize', async () => {
    fetchMock.mockImplementation(async () =>
      jsonResponse([{
        title: 'Registry entry without an extract',
        url: 'https://registry.example/buyer',
        content: '',
      }]),
    );
    completeAiJsonMock.mockResolvedValueOnce({
      data: {
        summary: null,
        summarySources: [],
        findings: [{
          category: 'registration',
          claim: 'The registry describes an active company.',
          supportingExcerpt: 'The company is registered and active',
          sourceUrls: ['https://registry.example/buyer'],
        }],
      },
      text: '{}',
      provider: 'zhipu',
      model: 'glm-4.5',
    });

    const result = await service.gatherAll('Buyer Ltd', '', 'UK');

    expect(result.error).toBe(RESEARCH_EVIDENCE_FAILURE_MESSAGE);
    expect(completeAiJsonMock).toHaveBeenCalledTimes(1);
  });

  it('retries one unsupported category without accepting a model-invented taxonomy', async () => {
    fetchMock.mockImplementation(async () =>
      jsonResponse([{
        title: 'Verified registry entry',
        url: 'https://registry.example/buyer',
        content: 'Registered company record with active status',
      }]),
    );
    completeAiJsonMock
      .mockResolvedValueOnce({
        data: {
          summary: null,
          summarySources: [],
          findings: [{
            category: 'business_status',
            claim: 'The registry describes an active company.',
            supportingExcerpt: 'Registered company record with active status',
            sourceUrls: ['https://registry.example/buyer'],
          }],
        },
        text: '{}',
        provider: 'zhipu',
        model: 'glm-4.5',
      })
      .mockResolvedValueOnce({
        data: {
          summary: null,
          summarySources: [],
          findings: [{
            category: 'registration',
            claim: 'The registry describes an active company.',
            supportingExcerpt: 'Registered company record with active status',
            sourceUrls: ['https://registry.example/buyer'],
          }],
        },
        text: '{}',
        provider: 'zhipu',
        model: 'glm-4.5',
      });

    const result = await service.gatherAll('Buyer Ltd', '', 'UK');

    expect(result.error).toBeUndefined();
    expect(result.json.findings[0].category).toBe('registration');
    expect(completeAiJsonMock).toHaveBeenCalledTimes(2);
    expect(String(completeAiJsonMock.mock.calls[1][0].messages[2].content))
      .toContain('category 只能逐字使用');
  });

  it('rejects invalid summary citation semantics and empty reports', async () => {
    fetchMock.mockImplementation(async () =>
      jsonResponse([{
        title: 'Verified registry entry',
        url: 'https://registry.example/buyer',
        content: 'Registered company record',
      }]),
    );
    completeAiJsonMock.mockResolvedValueOnce({
      data: {
        summary: 'Registered company.',
        summarySources: [],
        findings: [],
      },
      text: '{}',
      provider: 'zhipu',
      model: 'glm-4.5',
    });

    const noSummaryCitation = await service.gatherAll('Buyer Ltd', '', 'UK');
    expect(noSummaryCitation.error).toBe(RESEARCH_EVIDENCE_FAILURE_MESSAGE);

    completeAiJsonMock.mockResolvedValueOnce({
      data: { summary: null, summarySources: [], findings: [] },
      text: '{}',
      provider: 'zhipu',
      model: 'glm-4.5',
    });

    const empty = await service.gatherAll('Buyer Ltd', '', 'UK');
    expect(empty.error).toBe(RESEARCH_EVIDENCE_FAILURE_MESSAGE);
  });

  it('enforces finding category, text length and count bounds', async () => {
    fetchMock.mockImplementation(async () =>
      jsonResponse([{
        title: 'Verified registry entry',
        url: 'https://registry.example/buyer',
        content: 'Registered company record',
      }]),
    );
    completeAiJsonMock.mockResolvedValue({
      data: {
        summary: null,
        summarySources: [],
        findings: [{
          category: 'unsupported_category',
          claim: 'Unsupported categorization.',
          supportingExcerpt: 'Registered company record',
          sourceUrls: ['https://registry.example/buyer'],
        }],
      },
      text: '{}',
      provider: 'zhipu',
      model: 'glm-4.5',
    });

    const result = await service.gatherAll('Buyer Ltd', '', 'UK');

    expect(result.error).toBe(RESEARCH_EVIDENCE_FAILURE_MESSAGE);

    completeAiJsonMock.mockResolvedValueOnce({
      data: {
        summary: 'x'.repeat(1501),
        summarySources: ['https://registry.example/buyer'],
        findings: [],
      },
      text: '{}',
      provider: 'zhipu',
      model: 'glm-4.5',
    });
    const overlong = await service.gatherAll('Buyer Ltd', '', 'UK');
    expect(overlong.error).toBe(RESEARCH_EVIDENCE_FAILURE_MESSAGE);

    completeAiJsonMock.mockResolvedValueOnce({
      data: {
        summary: null,
        summarySources: [],
        findings: Array.from({ length: 25 }, (_, index) => ({
          category: 'market',
          claim: `Market claim ${index}`,
          supportingExcerpt: 'Registered company record',
          sourceUrls: ['https://registry.example/buyer'],
        })),
      },
      text: '{}',
      provider: 'zhipu',
      model: 'glm-4.5',
    });
    const tooMany = await service.gatherAll('Buyer Ltd', '', 'UK');
    expect(tooMany.error).toBe(RESEARCH_EVIDENCE_FAILURE_MESSAGE);
  });

  it('fails closed on malformed SearXNG JSON', async () => {
    fetchMock.mockResolvedValue(
      new Response('{not-json', {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );

    const result = await service.gatherAll('Malformed Ltd', '', 'UK');

    expect(result.error).toBe(RESEARCH_EVIDENCE_FAILURE_MESSAGE);
    expect(result.errorCode).toBe('RESEARCH_SEARCH_INVALID_RESPONSE');
    expect(completeAiJsonMock).not.toHaveBeenCalled();
  });

  it('rejects an oversized SearXNG response before invoking GLM', async () => {
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ results: [] }), {
        status: 200,
        headers: {
          'content-type': 'application/json',
          'content-length': String(512 * 1024 + 1),
        },
      }),
    );

    const result = await service.gatherAll('Oversized Ltd', '', 'UK');

    expect(result.error).toBe(RESEARCH_EVIDENCE_FAILURE_MESSAGE);
    expect(result.errorCode).toBe('RESEARCH_SEARCH_RESPONSE_TOO_LARGE');
    expect(completeAiJsonMock).not.toHaveBeenCalled();
  });
});
