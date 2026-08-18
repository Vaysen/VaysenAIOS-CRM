/**
 * R111 批次D：营销看板端点单测。
 * 覆盖：delivery-runs 列表 + 状态分布（全量非分页）、campaigns/engagement 活动级互动合表。
 */
import { MarketingExecutionService } from './marketing-execution.service';
import { MarketingCampaignsService } from './marketing-campaigns.service';

const USER = {
  id: 'user-1',
  activeCompanyId: 'comp-1',
  activeCompany: { id: 'comp-1', role: 'company_admin' },
  companies: [{ id: 'comp-1', role: 'company_admin' }],
};

describe('MarketingExecutionService delivery-runs (R111 批次D)', () => {
  function makePrisma() {
    return {
      marketingDeliveryRun: {
        findMany: jest.fn(),
        groupBy: jest.fn(),
      },
    };
  }

  it('returns runs joined with campaign name and full status distribution', async () => {
    const prisma = makePrisma();
    prisma.marketingDeliveryRun.findMany.mockResolvedValue([
      {
        id: 'run-1',
        campaignId: 'camp-1',
        channel: 'whatsapp',
        status: 'SUCCEEDED',
        totalCount: 100,
        processedCount: 100,
        lastError: null,
        executedAt: new Date('2026-08-18T02:00:00.000Z'),
        createdAt: new Date('2026-08-18T01:00:00.000Z'),
        campaign: { name: '八月 WhatsApp 促销' },
      },
      {
        id: 'run-2',
        campaignId: 'camp-2',
        channel: 'email',
        status: 'FAILED',
        totalCount: 50,
        processedCount: 10,
        lastError: 'account not ready',
        executedAt: null,
        createdAt: new Date('2026-08-17T01:00:00.000Z'),
        campaign: { name: '新品邮件' },
      },
    ]);
    prisma.marketingDeliveryRun.groupBy.mockResolvedValue([
      { status: 'SUCCEEDED', _count: 5 },
      { status: 'FAILED', _count: 2 },
      { status: 'PENDING', _count: 3 },
    ]);
    const service = new MarketingExecutionService(prisma as any, {} as any);
    const result = await service.getDeliveryRuns(USER, { limit: 20, campaignId: 'camp-1' });

    expect(result.runs).toHaveLength(2);
    expect(result.runs[0]).toMatchObject({
      id: 'run-1',
      campaignId: 'camp-1',
      campaignName: '八月 WhatsApp 促销',
      channel: 'whatsapp',
      status: 'SUCCEEDED',
      totalCount: 100,
      processedCount: 100,
    });
    expect(result.runs[1].campaignName).toBe('新品邮件');
    expect(result.statusDistribution).toEqual([
      { status: 'SUCCEEDED', count: 5 },
      { status: 'FAILED', count: 2 },
      { status: 'PENDING', count: 3 },
    ]);
    // 过滤条件透传
    expect(prisma.marketingDeliveryRun.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { companyId: 'comp-1', campaignId: 'camp-1' } }),
    );
    // 状态分布全量（无 companyId 过滤外的分页条件）
    expect(prisma.marketingDeliveryRun.groupBy).toHaveBeenCalledWith(
      expect.objectContaining({ where: { companyId: 'comp-1' }, by: ['status'] }),
    );
  });

  it('applies optional status filter', async () => {
    const prisma = makePrisma();
    prisma.marketingDeliveryRun.findMany.mockResolvedValue([]);
    prisma.marketingDeliveryRun.groupBy.mockResolvedValue([]);
    const service = new MarketingExecutionService(prisma as any, {} as any);
    await service.getDeliveryRuns(USER, { status: 'FAILED' });
    expect(prisma.marketingDeliveryRun.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { companyId: 'comp-1', status: 'FAILED' } }),
    );
  });
});

describe('MarketingCampaignsService engagement (R111 批次D)', () => {
  function makePrisma() {
    return {
      marketingCampaign: {
        findMany: jest.fn(),
      },
      emailMessage: {
        findMany: jest.fn(),
      },
    };
  }

  function makeService(prisma: any) {
    // MarketingCampaignsService(prisma, ai, emailAccounts, marketingDeliveryQueue)
    return new MarketingCampaignsService(
      prisma,
      {} as any,
      {} as any,
      {} as any,
    );
  }

  it('aggregates EmailMessage by campaignId with memberCount and rates', async () => {
    const prisma = makePrisma();
    prisma.marketingCampaign.findMany.mockResolvedValue([
      { id: 'camp-1', name: '八月促销', channel: 'whatsapp', status: 'APPROVED_PLAN', audienceSnapshot: { memberCount: 120 } },
      { id: 'camp-2', name: '新品邮件', channel: 'email', status: 'DRAFT', audienceSnapshot: null },
    ]);
    prisma.emailMessage.findMany.mockResolvedValue([
      { campaignId: 'camp-1', status: 'Sent', deliveredAt: null, openedAt: null, clickedAt: null },
      { campaignId: 'camp-1', status: 'Opened', deliveredAt: new Date(), openedAt: new Date(), clickedAt: null },
      { campaignId: 'camp-1', status: 'Clicked', deliveredAt: new Date(), openedAt: new Date(), clickedAt: new Date() },
      { campaignId: 'camp-1', status: 'Replied', deliveredAt: new Date(), openedAt: new Date(), clickedAt: new Date() },
      { campaignId: 'camp-1', status: 'Draft', deliveredAt: null, openedAt: null, clickedAt: null },
      { campaignId: 'camp-1', status: 'Failed', deliveredAt: null, openedAt: null, clickedAt: null },
    ]);
    const service = makeService(prisma);
    const { campaigns } = await service.getEngagement(USER, { limit: 20 });

    expect(campaigns).toHaveLength(2);
    // camp-1：Sent/Opened/Clicked/Replied 4 封发出，Draft/Failed 不计
    expect(campaigns[0]).toMatchObject({
      id: 'camp-1',
      name: '八月促销',
      channel: 'whatsapp',
      status: 'APPROVED_PLAN',
      memberCount: 120,
      sent: 4,
      delivered: 3,
      opened: 3,
      clicked: 2,
      replied: 1,
      openRate: 75,
      clickRate: 50,
      replyRate: 25,
    });
    // camp-2 无 EmailMessage → sent=0 正常返回
    expect(campaigns[1]).toMatchObject({
      id: 'camp-2',
      memberCount: 0,
      sent: 0,
      delivered: 0,
      opened: 0,
      clicked: 0,
      replied: 0,
      openRate: 0,
      clickRate: 0,
      replyRate: 0,
    });
  });
});
