import { BackgroundCheckAgent } from './background-check.agent';
import { ContactDiscoveryAgent } from './contact-discovery.agent';
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
    const { prisma, gatherer } = createDependencies({ raw: '', error: 'SearXNG unavailable' });

    await expect(run(prisma, gatherer)).rejects.toThrow('SearXNG unavailable');
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

    await expect(run(prisma, gatherer)).rejects.toThrow('未获得可核验的公开证据');
    expect(prisma.deepResearchReport.create).not.toHaveBeenCalled();
    expect(prisma.deepResearchReport.upsert).not.toHaveBeenCalled();
  });
});
