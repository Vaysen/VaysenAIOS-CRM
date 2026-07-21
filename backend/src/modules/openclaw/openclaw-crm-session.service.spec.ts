import { ConflictException, ForbiddenException } from '@nestjs/common';
import { OpenClawCrmExecutionStatus } from '@prisma/client';
import { OpenClawCrmSessionService } from './openclaw-crm-session.service';

const COMPANY_ID = '11111111-1111-4111-8111-111111111111';
const DIGEST = 'a'.repeat(64);

function advisoryLockKeyAt(mock: jest.Mock, index: number): string {
  const [query, ...parameters] = mock.mock.calls[index];
  const parameterizedSql = Array.from(query as readonly string[]).join('?');
  expect(parameterizedSql).toMatch(
    /pg_advisory_xact_lock\(hashtextextended\(\?, 0\)\)::text AS locked/,
  );
  expect(parameters).toHaveLength(1);
  expect(parameterizedSql).not.toContain(String(parameters[0]));
  return parameters[0] as string;
}

describe('OpenClawCrmSessionService', () => {
  let prisma: any;
  let service: OpenClawCrmSessionService;

  beforeEach(() => {
    prisma = {
      userCompanyRelation: {
        findFirst: jest.fn().mockResolvedValue({
          role: { name: 'company_admin' },
          user: { email: 'admin@example.com' },
        }),
      },
      openClawCrmSession: {
        findUnique: jest.fn().mockResolvedValue(null),
        upsert: jest.fn().mockResolvedValue({ id: 'session-1' }),
        update: jest.fn().mockResolvedValue({ id: 'session-1' }),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      openClawToolReceipt: {
        count: jest.fn().mockResolvedValue(0),
      },
      $queryRaw: jest.fn().mockResolvedValue([{ locked: '' }]),
    };
    prisma.$transaction = jest.fn(async (callback: any) => callback(prisma));
    service = new OpenClawCrmSessionService(prisma);
  });

  it('registers only the irreversible digest for an active company administrator', async () => {
    await service.register(DIGEST, COMPANY_ID, {
      id: 'admin-1',
      companies: [{ id: COMPANY_ID, role: 'company_admin' }],
    });
    expect(prisma.openClawCrmSession.upsert).toHaveBeenCalledWith(expect.objectContaining({
      where: { sessionDigest: DIGEST },
      create: expect.objectContaining({
        sessionDigest: DIGEST,
        companyId: COMPANY_ID,
        operatorUserId: 'admin-1',
      }),
    }));
  });

  it('rejects a normal member even if a stale JWT claimed an admin role', async () => {
    prisma.userCompanyRelation.findFirst.mockResolvedValue({ role: { name: 'sales_user' } });
    await expect(service.register(DIGEST, COMPANY_ID, {
      id: 'sales-1',
      companies: [{ id: COMPANY_ID, role: 'company_admin' }],
    })).rejects.toBeInstanceOf(ForbiddenException);
    expect(prisma.openClawCrmSession.upsert).not.toHaveBeenCalled();
  });

  it('fails closed if a digest is already bound to another company or operator', async () => {
    prisma.openClawCrmSession.findUnique.mockResolvedValue({
      companyId: '22222222-2222-4222-8222-222222222222',
      operatorUserId: 'other-admin',
    });
    await expect(service.register(DIGEST, COMPANY_ID, { id: 'admin-1' }))
      .rejects.toBeInstanceOf(ConflictException);
  });

  it('revalidates role and expiry when resolving a CRM plugin callback', async () => {
    prisma.openClawCrmSession.findUnique.mockResolvedValue({
      id: 'session-1',
      sessionDigest: DIGEST,
      companyId: COMPANY_ID,
      operatorUserId: 'admin-1',
      expiresAt: new Date(Date.now() + 60_000),
      executionStatus: OpenClawCrmExecutionStatus.RUNNING,
      executionLeaseToken: 'lease-live',
      executionLeaseExpiresAt: new Date(Date.now() + 30_000),
    });
    const result = await service.resolve(`vaysen-crm:${DIGEST}`);
    expect(result).toEqual({
      companyId: COMPANY_ID,
      operatorUserId: 'admin-1',
      user: {
        id: 'admin-1',
        email: 'admin@example.com',
        companies: [{ id: COMPANY_ID, role: 'company_admin' }],
      },
      executionLeaseToken: 'lease-live',
    });

    prisma.openClawCrmSession.findUnique.mockResolvedValue({
      id: 'session-1',
      expiresAt: new Date(Date.now() - 1),
    });
    await expect(service.resolve(`vaysen-crm:${DIGEST}`)).rejects.toBeInstanceOf(ForbiddenException);
  });

  it.each([
    {
      label: 'READY',
      executionStatus: OpenClawCrmExecutionStatus.READY,
      executionLeaseToken: null,
      executionLeaseExpiresAt: null,
    },
    {
      label: 'DRAINING',
      executionStatus: OpenClawCrmExecutionStatus.DRAINING,
      executionLeaseToken: 'draining-lease',
      executionLeaseExpiresAt: new Date(Date.now() + 30_000),
    },
    {
      label: 'SETTLED',
      executionStatus: OpenClawCrmExecutionStatus.SETTLED,
      executionLeaseToken: null,
      executionLeaseExpiresAt: null,
    },
    {
      label: 'expired RUNNING lease',
      executionStatus: OpenClawCrmExecutionStatus.RUNNING,
      executionLeaseToken: 'expired-lease',
      executionLeaseExpiresAt: new Date(Date.now() - 1),
    },
  ])('rejects a late CRM tool callback for a $label execution', async (state) => {
    prisma.openClawCrmSession.findUnique.mockResolvedValue({
      id: 'session-1',
      sessionDigest: DIGEST,
      companyId: COMPANY_ID,
      operatorUserId: 'admin-1',
      expiresAt: new Date(Date.now() + 60_000),
      ...state,
    });

    await expect(service.resolve(`vaysen-crm:${DIGEST}`))
      .rejects.toThrow(/execution lease is not active/i);
    expect(prisma.userCompanyRelation.findFirst).not.toHaveBeenCalled();
  });

  it('allows only one concurrent Gateway execution claim for a request-scoped session', async () => {
    prisma.openClawCrmSession.findUnique.mockResolvedValue({
      id: 'session-1',
      sessionDigest: DIGEST,
      companyId: COMPANY_ID,
      operatorUserId: 'admin-1',
      expiresAt: new Date(Date.now() + 60_000),
      executionStatus: OpenClawCrmExecutionStatus.RUNNING,
    });
    prisma.openClawCrmSession.updateMany
      .mockResolvedValueOnce({ count: 1 })
      .mockResolvedValueOnce({ count: 0 });

    const user = { id: 'admin-1', companies: [{ id: COMPANY_ID, role: 'company_admin' }] };
    const first = await service.claimExecution(DIGEST, COMPANY_ID, user);
    const second = await service.claimExecution(DIGEST, COMPANY_ID, user);

    expect(first).toMatch(/^[0-9a-f-]{36}$/i);
    expect(second).toBeNull();
    expect(prisma.openClawCrmSession.updateMany.mock.calls[0][0].where).toEqual(
      expect.objectContaining({
        sessionDigest: DIGEST,
        OR: expect.arrayContaining([
          { executionStatus: OpenClawCrmExecutionStatus.READY },
        ]),
      }),
    );
    expect(prisma.openClawCrmSession.updateMany.mock.calls[0][0].where.OR).not.toContainEqual(
      { executionStatus: OpenClawCrmExecutionStatus.DRAINING },
    );
  });

  it('settles or releases only the matching live execution lease', async () => {
    prisma.openClawCrmSession.updateMany
      .mockResolvedValueOnce({ count: 1 })
      .mockResolvedValueOnce({ count: 0 });

    await expect(service.settleExecution(DIGEST, 'lease-a')).resolves.toBe(true);
    await expect(service.releaseExecution(DIGEST, 'lease-b')).resolves.toBe(false);
    expect(prisma.openClawCrmSession.updateMany.mock.calls[0][0]).toEqual(expect.objectContaining({
      where: expect.objectContaining({
        sessionDigest: DIGEST,
        executionStatus: OpenClawCrmExecutionStatus.RUNNING,
        executionLeaseToken: 'lease-a',
      }),
      data: expect.objectContaining({ executionStatus: OpenClawCrmExecutionStatus.SETTLED }),
    }));
  });

  it('seals RUNNING as DRAINING while a callback has a PROCESSING receipt and retains its exact token', async () => {
    prisma.openClawToolReceipt.count.mockResolvedValue(1);

    await expect(service.settleExecution(DIGEST, 'lease-a')).resolves.toBe(true);

    expect(prisma.openClawCrmSession.updateMany).toHaveBeenCalledWith({
      where: {
        sessionDigest: DIGEST,
        executionStatus: OpenClawCrmExecutionStatus.RUNNING,
        executionLeaseToken: 'lease-a',
      },
      data: {
        executionStatus: OpenClawCrmExecutionStatus.DRAINING,
        executionCompletedAt: null,
      },
    });
    const drainingData = prisma.openClawCrmSession.updateMany.mock.calls[0][0].data;
    expect(drainingData).not.toHaveProperty('executionLeaseToken');
    expect(drainingData).not.toHaveProperty('executionLeaseExpiresAt');
    expect(prisma.openClawToolReceipt.count).toHaveBeenCalledWith({
      where: {
        sessionDigest: expect.stringMatching(/^[a-f0-9]{64}$/),
        status: 'PROCESSING',
      },
    });
    expect(prisma.$queryRaw).toHaveBeenCalledTimes(1);
    expect(advisoryLockKeyAt(prisma.$queryRaw, 0)).toBe(
      `openclaw-crm-execution:${DIGEST}`,
    );
  });

  it('keeps DRAINING until the last PROCESSING receipt ends and an old callback cannot close a new lease', async () => {
    let processingReceipts = 2;
    const state: any = {
      id: 'session-1',
      sessionDigest: DIGEST,
      companyId: COMPANY_ID,
      operatorUserId: 'admin-1',
      expiresAt: new Date(Date.now() + 60_000),
      executionStatus: OpenClawCrmExecutionStatus.RUNNING,
      executionLeaseToken: 'lease-a',
      executionLeaseExpiresAt: new Date(Date.now() + 30_000),
      executionCompletedAt: null,
    };
    prisma.openClawCrmSession.findUnique.mockImplementation(async () => ({ ...state }));
    prisma.openClawToolReceipt.count.mockImplementation(async () => processingReceipts);
    prisma.openClawCrmSession.updateMany.mockImplementation(async ({ where, data }: any) => {
      if (where.OR) return { count: 0 };
      const statusMatches = typeof where.executionStatus === 'string'
        ? state.executionStatus === where.executionStatus
        : where.executionStatus?.in?.includes(state.executionStatus);
      const matches = state.sessionDigest === where.sessionDigest
        && statusMatches
        && (!where.executionLeaseToken || state.executionLeaseToken === where.executionLeaseToken);
      if (!matches) return { count: 0 };
      Object.assign(state, data);
      return { count: 1 };
    });

    await expect(service.settleExecution(DIGEST, 'lease-a')).resolves.toBe(true);
    expect(state).toEqual(expect.objectContaining({
      executionStatus: OpenClawCrmExecutionStatus.DRAINING,
      executionLeaseToken: 'lease-a',
    }));
    await expect(service.resolve(`vaysen-crm:${DIGEST}`))
      .rejects.toThrow(/execution lease is not active/i);
    await expect(service.claimExecution(DIGEST, COMPANY_ID, {
      id: 'admin-1',
      companies: [{ id: COMPANY_ID, role: 'company_admin' }],
    })).resolves.toBeNull();

    await service.runToolTerminalTransaction(DIGEST, 'lease-a', async () => {
      processingReceipts = 1;
      return { claimed: true, receipt: 'first' };
    });
    expect(state.executionStatus).toBe(OpenClawCrmExecutionStatus.DRAINING);
    expect(state.executionLeaseToken).toBe('lease-a');

    await service.runToolTerminalTransaction(DIGEST, 'lease-a', async () => {
      processingReceipts = 0;
      return { claimed: true, receipt: 'second' };
    });
    expect(state).toEqual(expect.objectContaining({
      executionStatus: OpenClawCrmExecutionStatus.SETTLED,
      executionLeaseToken: null,
      executionLeaseExpiresAt: null,
      executionCompletedAt: expect.any(Date),
    }));

    Object.assign(state, {
      executionStatus: OpenClawCrmExecutionStatus.RUNNING,
      executionLeaseToken: 'lease-b',
      executionLeaseExpiresAt: new Date(Date.now() + 30_000),
      executionCompletedAt: null,
    });
    await expect(service.runToolTerminalTransaction(DIGEST, 'lease-a', async () => ({
      claimed: true,
    }))).rejects.toBeInstanceOf(ConflictException);
    expect(state).toEqual(expect.objectContaining({
      executionStatus: OpenClawCrmExecutionStatus.RUNNING,
      executionLeaseToken: 'lease-b',
    }));
  });

  it('keeps RUNNING after a tool terminal so the same Gateway turn may reserve another tool', async () => {
    prisma.openClawCrmSession.findUnique.mockResolvedValue({
      sessionDigest: DIGEST,
      executionStatus: OpenClawCrmExecutionStatus.RUNNING,
      executionLeaseToken: 'lease-a',
    });

    await expect(service.runToolTerminalTransaction(DIGEST, 'lease-a', async () => ({
      claimed: true,
    }))).resolves.toEqual({ claimed: true });

    expect(prisma.openClawCrmSession.updateMany).not.toHaveBeenCalled();
    expect(prisma.openClawToolReceipt.count).not.toHaveBeenCalled();
  });

  it('does not touch any execution when a late raw callback loses the terminal receipt CAS', async () => {
    await expect(service.runToolTerminalTransaction(DIGEST, 'lease-old', async () => ({
      claimed: false,
      receipt: 'already-terminal',
    }))).resolves.toEqual({ claimed: false, receipt: 'already-terminal' });

    expect(prisma.openClawCrmSession.findUnique).not.toHaveBeenCalled();
    expect(prisma.openClawCrmSession.updateMany).not.toHaveBeenCalled();
  });
});
