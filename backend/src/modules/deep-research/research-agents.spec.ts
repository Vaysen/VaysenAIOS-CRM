import { BackgroundCheckAgent } from './background-check.agent';
import { ContactDiscoveryAgent } from './contact-discovery.agent';
import {
  RESEARCH_EVIDENCE_FAILURE_MESSAGE,
  RESEARCH_EVIDENCE_FAILURE_CODE,
} from './data-gatherer.service';
import { MarketAnalysisAgent } from './market-analysis.agent';

describe('deep research agents fail-closed retry contract', () => {
  const lead = {
    id: 'lead-1',
    companyId: 'company-1',
    companyName: 'Acme Packaging',
    website: 'https://acme.example',
    country: 'DE',
  };

  function createDependencies(gathered: Record<string, unknown>) {
    const prisma = {
      deepResearchReport: {
        create: jest.fn(),
        upsert: jest.fn(),
      },
    };
    const gatherer = { gatherAll: jest.fn().mockResolvedValue(gathered) };
    return { prisma, gatherer };
  }

  it.each([
    {
      label: 'background check',
      run: (prisma: any, gatherer: any) =>
        new BackgroundCheckAgent(prisma, gatherer).research(lead, 'user-1', { agentRunId: 'run-1' }),
    },
    {
      label: 'contact discovery',
      run: (prisma: any, gatherer: any) =>
        new ContactDiscoveryAgent(prisma, gatherer).discover(lead, 'user-1', { agentRunId: 'run-1' }),
    },
    {
      label: 'market analysis',
      run: (prisma: any, gatherer: any) =>
        new MarketAnalysisAgent(prisma, gatherer).analyze(lead, 'user-1', { agentRunId: 'run-1' }),
    },
  ])('$label throws on evidence failure and does not archive a fake report', async ({ run }) => {
    const sentinel = 'provider-sentinel@example.com body https://provider.example/?token=secret';
    const { prisma, gatherer } = createDependencies({
      raw: '',
      error: sentinel,
      errorCode: 'RESEARCH_SEARCH_FAILED',
    });

    const thrown = await run(prisma, gatherer).catch((error) => error);
    expect(thrown).toMatchObject({
      message: RESEARCH_EVIDENCE_FAILURE_MESSAGE,
      code: RESEARCH_EVIDENCE_FAILURE_CODE,
    });
    expect(thrown.message).not.toContain(sentinel);
    expect(prisma.deepResearchReport.create).not.toHaveBeenCalled();
    expect(prisma.deepResearchReport.upsert).not.toHaveBeenCalled();
  });

  it.each([
    {
      label: 'background check',
      run: (prisma: any, gatherer: any) =>
        new BackgroundCheckAgent(prisma, gatherer).research(lead, 'user-1'),
    },
    {
      label: 'contact discovery',
      run: (prisma: any, gatherer: any) =>
        new ContactDiscoveryAgent(prisma, gatherer).discover(lead, 'user-1'),
    },
    {
      label: 'market analysis',
      run: (prisma: any, gatherer: any) =>
        new MarketAnalysisAgent(prisma, gatherer).analyze(lead, 'user-1'),
    },
  ])('$label throws when the gatherer returns no usable result', async ({ run }) => {
    const { prisma, gatherer } = createDependencies({ raw: '' });

    await expect(run(prisma, gatherer)).rejects.toThrow(RESEARCH_EVIDENCE_FAILURE_MESSAGE);
    expect(prisma.deepResearchReport.create).not.toHaveBeenCalled();
    expect(prisma.deepResearchReport.upsert).not.toHaveBeenCalled();
  });

  it.each([
    {
      label: 'background check',
      run: (prisma: any, gatherer: any) =>
        new BackgroundCheckAgent(prisma, gatherer).research(lead, 'user-1'),
    },
    {
      label: 'contact discovery',
      run: (prisma: any, gatherer: any) =>
        new ContactDiscoveryAgent(prisma, gatherer).discover(lead, 'user-1'),
    },
    {
      label: 'market analysis',
      run: (prisma: any, gatherer: any) =>
        new MarketAnalysisAgent(prisma, gatherer).analyze(lead, 'user-1'),
    },
  ])('$label preserves the successful report result and archive contract', async ({ run }) => {
    const { prisma, gatherer } = createDependencies({
      raw: '{"summary":"ok"}',
      html: '<p>ok</p>',
      json: { summary: 'ok' },
    });
    prisma.deepResearchReport.create.mockResolvedValue({ id: 'report-1' });

    const result = await run(prisma, gatherer);

    expect(result).toEqual(expect.objectContaining({
      reportId: 'report-1',
      html: '<p>ok</p>',
      json: { summary: 'ok' },
    }));
    expect(prisma.deepResearchReport.create).toHaveBeenCalledTimes(1);
    expect(prisma.deepResearchReport.upsert).not.toHaveBeenCalled();
  });
});
