import { OpenClawMaintenanceService } from './openclaw-maintenance.service';

describe('OpenClawMaintenanceService', () => {
  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  it('deletes expired security state while retaining durable receipts and audit', async () => {
    const prisma: any = {
      openClawRequestNonce: { deleteMany: jest.fn().mockResolvedValue({ count: 3 }) },
      openClawCrmSession: { deleteMany: jest.fn().mockResolvedValue({ count: 2 }) },
      openClawSelectionToken: { deleteMany: jest.fn().mockResolvedValue({ count: 4 }) },
      openClawToolReceipt: { deleteMany: jest.fn() },
      agentAuditLog: { deleteMany: jest.fn() },
    };
    const service = new OpenClawMaintenanceService(prisma);
    const now = new Date('2026-07-14T16:00:00.000Z');

    await expect(service.cleanupExpiredNonces(now)).resolves.toEqual({
      nonces: 3,
      sessions: 2,
      selectionTokens: 4,
    });
    expect(prisma.openClawRequestNonce.deleteMany).toHaveBeenCalledWith({
      where: { expiresAt: { lt: now } },
    });
    expect(prisma.openClawCrmSession.deleteMany).toHaveBeenCalledWith({
      where: { expiresAt: { lt: now } },
    });
    expect(prisma.openClawSelectionToken.deleteMany).toHaveBeenCalledWith({
      where: { expiresAt: { lt: new Date('2026-07-13T16:00:00.000Z') } },
    });
    expect(prisma.openClawToolReceipt.deleteMany).not.toHaveBeenCalled();
    expect(prisma.agentAuditLog.deleteMany).not.toHaveBeenCalled();
  });

  it('deletes consumed and unconsumed selection tokens only after the 24-hour expiry retention', async () => {
    const rows = [
      {
        id: 'old-consumed',
        expiresAt: new Date('2026-07-13T15:00:00.000Z'),
        consumedAt: new Date('2026-07-13T14:59:00.000Z'),
      },
      {
        id: 'old-unconsumed',
        expiresAt: new Date('2026-07-13T15:30:00.000Z'),
        consumedAt: null,
      },
      {
        id: 'recent-expired',
        expiresAt: new Date('2026-07-14T15:30:00.000Z'),
        consumedAt: null,
      },
      {
        id: 'unexpired',
        expiresAt: new Date('2026-07-14T17:00:00.000Z'),
        consumedAt: null,
      },
    ];
    const prisma: any = {
      openClawRequestNonce: { deleteMany: jest.fn().mockResolvedValue({ count: 0 }) },
      openClawCrmSession: { deleteMany: jest.fn().mockResolvedValue({ count: 0 }) },
      openClawSelectionToken: {
        deleteMany: jest.fn(async ({ where }: any) => {
          const cutoff = where.expiresAt.lt as Date;
          const deleted = rows.filter((row) => row.expiresAt < cutoff);
          for (const row of deleted) rows.splice(rows.indexOf(row), 1);
          return { count: deleted.length };
        }),
      },
    };
    const service = new OpenClawMaintenanceService(prisma);

    await expect(service.cleanupExpiredNonces(new Date('2026-07-14T16:00:00.000Z')))
      .resolves.toEqual({ nonces: 0, sessions: 0, selectionTokens: 2 });
    expect(rows.map((row) => row.id)).toEqual(['recent-expired', 'unexpired']);
  });

  it('runs at worker startup and then only on the hourly maintenance interval', async () => {
    jest.useFakeTimers();
    const prisma: any = {
      openClawRequestNonce: { deleteMany: jest.fn().mockResolvedValue({ count: 0 }) },
      openClawCrmSession: { deleteMany: jest.fn().mockResolvedValue({ count: 0 }) },
      openClawSelectionToken: { deleteMany: jest.fn().mockResolvedValue({ count: 0 }) },
    };
    const service = new OpenClawMaintenanceService(prisma);

    await service.onApplicationBootstrap();
    expect(prisma.openClawRequestNonce.deleteMany).toHaveBeenCalledTimes(1);
    jest.advanceTimersByTime(59 * 60_000);
    await Promise.resolve();
    expect(prisma.openClawRequestNonce.deleteMany).toHaveBeenCalledTimes(1);
    jest.advanceTimersByTime(60_000);
    await Promise.resolve();
    expect(prisma.openClawRequestNonce.deleteMany).toHaveBeenCalledTimes(2);
    expect(prisma.openClawCrmSession.deleteMany).toHaveBeenCalledTimes(2);
    expect(prisma.openClawSelectionToken.deleteMany).toHaveBeenCalledTimes(2);

    service.onApplicationShutdown();
  });
});
