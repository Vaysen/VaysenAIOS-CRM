/**
 * R111 批次D：analytics 数据看板端点单测。
 * 覆盖：engagement-trends 归日口径、mail-center-trends、sources groupBy、whatsapp-stats、
 * overview countryTop 扩展（不破坏现有结构）。
 */
import { AnalyticsService } from './analytics.service';

const USER = {
  id: 'user-1',
  activeCompanyId: 'comp-1',
  activeCompany: { id: 'comp-1', role: 'company_admin' },
  companies: [{ id: 'comp-1', role: 'company_admin' }],
};

function makePrisma(overrides: Record<string, any> = {}) {
  const prisma: any = {
    lead: {
      count: jest.fn().mockResolvedValue(0),
      aggregate: jest.fn().mockResolvedValue({ _avg: { leadScore: null } }),
      groupBy: jest.fn().mockResolvedValue([]),
      findMany: jest.fn().mockResolvedValue([]),
    },
    emailMessage: {
      findMany: jest.fn().mockResolvedValue([]),
      groupBy: jest.fn().mockResolvedValue([]),
    },
    emailAccount: { count: jest.fn().mockResolvedValue(0) },
    userCompanyRelation: { findMany: jest.fn().mockResolvedValue([]) },
    communicationMessage: {
      findMany: jest.fn().mockResolvedValue([]),
      groupBy: jest.fn().mockResolvedValue([]),
    },
    conversation: {
      findMany: jest.fn().mockResolvedValue([]),
      groupBy: jest.fn().mockResolvedValue([]),
    },
    ...overrides,
  };
  return prisma;
}

function serviceWith(prisma: any) {
  return new AnalyticsService(prisma);
}

describe('AnalyticsService engagement-trends (R111 批次D)', () => {
  it('buckets EmailMessage by sentAt||createdAt and counts sent/opened/clicked/replied with 1-decimal rates', async () => {
    const now = new Date();
    const yesterday = new Date(now.getTime() - 86400000);
    const prisma = makePrisma({
      emailMessage: {
        findMany: jest.fn().mockResolvedValue([
          // 今天：Sent
          { createdAt: now, sentAt: now, status: 'Sent', openedAt: null, clickedAt: null },
          // 今天：Opened（计入 sent + opened）
          { createdAt: now, sentAt: now, status: 'Opened', openedAt: now, clickedAt: null },
          // 今天：Clicked（计入 sent + clicked）
          { createdAt: now, sentAt: now, status: 'Clicked', openedAt: now, clickedAt: now },
          // 今天：Replied（计入 sent + replied）
          { createdAt: now, sentAt: now, status: 'Replied', openedAt: now, clickedAt: now },
          // 今天：Draft 未发出，不计 sent
          { createdAt: now, sentAt: null, status: 'Draft', openedAt: null, clickedAt: null },
          // 昨天：Opened
          { createdAt: yesterday, sentAt: yesterday, status: 'Opened', openedAt: yesterday, clickedAt: null },
        ]),
      },
    });
    const service = serviceWith(prisma);
    const { daily } = await service.getEngagementTrends(USER, { days: 5 });
    const today = daily.find((d: any) => d.date === now.toISOString().slice(0, 10))!;
    const yday = daily.find((d: any) => d.date === yesterday.toISOString().slice(0, 10))!;
    expect(today).toMatchObject({ sent: 4, opened: 3, clicked: 2, replied: 1 });
    expect(today.openRate).toBe(75); // 3/4
    expect(today.clickRate).toBe(50); // 2/4
    expect(today.replyRate).toBe(25); // 1/4
    expect(yday).toMatchObject({ sent: 1, opened: 1 });
    expect(yday.openRate).toBe(100);
    // 每天都有完整 7 个字段
    expect(Object.keys(today).sort()).toEqual(['clickRate', 'clicked', 'date', 'openRate', 'opened', 'replyRate', 'replied', 'sent'].sort());
  });
});

describe('AnalyticsService mail-center-trends (R111 批次D)', () => {
  it('buckets CommunicationMessage by receivedAt/sentAt per direction', async () => {
    const now = new Date();
    const yesterday = new Date(now.getTime() - 86400000);
    const prisma = makePrisma({
      communicationMessage: {
        findMany: jest.fn().mockResolvedValue([
          { direction: 'inbound', receivedAt: now, sentAt: null, createdAt: now },
          { direction: 'outbound', sentAt: now, receivedAt: null, createdAt: now },
          { direction: 'inbound', receivedAt: null, sentAt: null, createdAt: yesterday }, // 无时间戳 → createdAt 兜底
          { direction: 'outbound', sentAt: yesterday, receivedAt: null, createdAt: yesterday },
        ]),
      },
    });
    const service = serviceWith(prisma);
    const { daily } = await service.getMailCenterTrends(USER, { days: 5 });
    const today = daily.find((d: any) => d.date === now.toISOString().slice(0, 10))!;
    const yday = daily.find((d: any) => d.date === yesterday.toISOString().slice(0, 10))!;
    expect(today).toMatchObject({ inbound: 1, outbound: 1 });
    expect(yday).toMatchObject({ inbound: 1, outbound: 1 });
  });
});

describe('AnalyticsService sources (R111 批次D)', () => {
  it('groups Lead by sourceType, maps empty to unknown, sorts desc with pct', async () => {
    const prisma = makePrisma({
      lead: {
        count: jest.fn().mockResolvedValue(0),
        aggregate: jest.fn().mockResolvedValue({ _avg: { leadScore: null } }),
        groupBy: jest.fn().mockResolvedValue([
          { sourceType: 'facebook', _count: 4 },
          { sourceType: 'google', _count: 2 },
          { sourceType: null, _count: 1 },
        ]),
        findMany: jest.fn().mockResolvedValue([]),
      },
    });
    const service = serviceWith(prisma);
    const { sources } = await service.getSources(USER);
    expect(sources).toEqual([
      { source: 'facebook', count: 4, pct: 57.1 },
      { source: 'google', count: 2, pct: 28.6 },
      { source: 'unknown', count: 1, pct: 14.3 },
    ]);
  });
});

describe('AnalyticsService whatsapp-stats (R111 批次D)', () => {
  it('aggregates conversations/messages/read/unread with readRate', async () => {
    const prisma = makePrisma({
      conversation: {
        groupBy: jest.fn().mockResolvedValue([
          { status: 'active', _count: 5 },
          { status: 'archived', _count: 2 },
        ]),
        findMany: jest.fn().mockResolvedValue([{ unreadCount: 0 }, { unreadCount: 3 }]),
      },
      communicationMessage: {
        findMany: jest.fn().mockResolvedValue([{ id: 'm1' }, { id: 'm2' }]),
        groupBy: jest.fn().mockResolvedValue([
          { direction: 'inbound', _count: 10 },
          { direction: 'outbound', _count: 6 },
        ]),
      },
    });
    const service = serviceWith(prisma);
    const stats = await service.getWhatsappStats(USER);
    expect(stats).toMatchObject({
      conversations: 2,
      activeConversations: 5,
      messages: 16,
      inbound: 10,
      outbound: 6,
      read: 2,
      unreadConversations: 1,
    });
    expect(stats.readRate).toBe(12.5); // 2/16
  });
});

describe('AnalyticsService overview extension (R111 批次D)', () => {
  it('adds countryTop without breaking the existing response structure', async () => {
    const prisma = makePrisma({
      lead: {
        count: jest.fn().mockResolvedValue(0),
        aggregate: jest.fn().mockResolvedValue({ _avg: { leadScore: null } }),
        groupBy: jest.fn()
          .mockResolvedValueOnce([{ status: 'new', _count: 3 }]) // status 维度
          .mockResolvedValueOnce([ // country 维度
            { country: 'United States', _count: 5 },
            { country: 'Germany', _count: 2 },
          ]),
        findMany: jest.fn().mockResolvedValue([]),
      },
    });
    const service = serviceWith(prisma);
    const overview = await service.getOverview(USER, {});
    expect(overview.totalLeads).toBe(0);
    expect(Array.isArray(overview.countryTop)).toBe(true);
    expect(overview.countryTop[0]).toEqual({ country: 'United States', count: 5 });
    // 既有字段不受影响
    expect(overview.statusDistribution).toEqual({ new: 3 });
    expect(typeof overview.email.total).toBe('number');
  });
});
