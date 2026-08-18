import { DashboardService } from '../modules/dashboard/dashboard.service';
import { OrdersService } from '../modules/orders/orders.service';
import { QuotesService } from '../modules/quotes/quotes.service';

const viewer = {
  id: 'viewer-b',
  activeCompanyId: 'B',
  activeCompany: { id: 'B', role: 'viewer' },
  companies: [
    { id: 'A', role: 'company_admin' },
    { id: 'B', role: 'viewer' },
  ],
};

describe('active-tenant owner isolation for sensitive summaries', () => {
  it('limits dashboard counts and lists to the active viewer owner', async () => {
    const prisma: any = {
      lead: {
        count: jest.fn().mockResolvedValue(0),
        findMany: jest.fn().mockResolvedValue([]),
      },
      followUpReminder: {
        count: jest.fn().mockResolvedValue(0),
        findMany: jest.fn().mockResolvedValue([]),
      },
      conversation: { count: jest.fn().mockResolvedValue(0) },
      aiArtifact: { count: jest.fn().mockResolvedValue(0) },
    };

    await new DashboardService(prisma).getOverview(viewer);

    expect(prisma.lead.count).toHaveBeenCalledWith({
      where: { companyId: 'B', deletedAt: null, ownerUserId: 'viewer-b' },
    });
    expect(prisma.conversation.count).toHaveBeenCalledWith({
      where: {
        companyId: 'B',
        OR: [
          { assignedUserId: 'viewer-b' },
          { lead: { ownerUserId: 'viewer-b' } },
        ],
      },
    });
  });

  it('limits order and quote amount listings to the active assignee', async () => {
    const orderPrisma: any = {
      order: {
        findMany: jest.fn().mockResolvedValue([]),
        count: jest.fn().mockResolvedValue(0),
      },
    };
    const quotePrisma: any = {
      quote: {
        findMany: jest.fn().mockResolvedValue([]),
        count: jest.fn().mockResolvedValue(0),
      },
    };

    await new OrdersService(orderPrisma).findAll(viewer);
    await new QuotesService(quotePrisma).findAll(viewer);

    const expected = { companyId: 'B', assignedUserId: 'viewer-b' };
    expect(orderPrisma.order.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expected }),
    );
    expect(quotePrisma.quote.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expected }),
    );
  });
});
