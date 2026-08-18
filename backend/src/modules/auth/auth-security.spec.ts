import {
  ConflictException,
  ForbiddenException,
  UnauthorizedException,
} from '@nestjs/common';
import { AuthService } from './auth.service';

describe('AuthService security controls', () => {
  const jwt = { sign: jest.fn().mockReturnValue('access-token') };

  beforeEach(() => {
    jest.clearAllMocks();
    process.env.ALLOW_PUBLIC_REGISTRATION = 'false';
    process.env.INITIAL_ADMIN_SETUP_KEY =
      'test-only-initialization-key-1234567890';
  });

  it('keeps public registration fail-closed', async () => {
    const service = new AuthService({} as any, jwt as any);
    await expect(service.register({
      email: 'admin@example.test',
      password: 'long-test-password',
      firstName: 'Test',
      lastName: 'Admin',
      companyName: 'Example',
    })).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('stores only a SHA-256 refresh-token hash', async () => {
    const create = jest.fn().mockResolvedValue({ id: 'rt1' });
    const service = new AuthService({
      refreshToken: { create },
    } as any, jwt as any);

    const pair = await (service as any).generateTokens('u1', 'u@example.test');
    const data = create.mock.calls[0][0].data;

    expect(pair.refreshToken).toEqual(expect.any(String));
    expect(pair.refreshToken.length).toBeGreaterThan(32);
    expect(data.tokenHash).toMatch(/^[a-f0-9]{64}$/);
    expect(data.tokenHash).not.toBe(pair.refreshToken);
    expect(data).not.toHaveProperty('token');
  });

  it('revokes the complete token family when an old token is replayed', async () => {
    const updateMany = jest.fn().mockResolvedValue({ count: 2 });
    const tx = {
      refreshToken: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'old',
          userId: 'u1',
          familyId: 'family-1',
          consumedAt: new Date(),
          revokedAt: null,
          expiresAt: new Date(Date.now() + 60_000),
        }),
        updateMany,
      },
    };
    const service = new AuthService({
      $transaction: jest.fn((callback: any) => callback(tx)),
    } as any, jwt as any);

    await expect(service.refresh('replayed-token'))
      .rejects.toBeInstanceOf(UnauthorizedException);
    expect(updateMany).toHaveBeenCalledWith({
      where: { familyId: 'family-1', revokedAt: null },
      data: { revokedAt: expect.any(Date) },
    });
  });

  it('maps a concurrent serialization conflict to replay detection and family revocation', async () => {
    const updateMany = jest.fn().mockResolvedValue({ count: 2 });
    const tx = {
      refreshToken: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'old',
          userId: 'u1',
          familyId: 'family-concurrent',
          consumedAt: new Date(),
          revokedAt: null,
          expiresAt: new Date(Date.now() + 60_000),
        }),
        updateMany,
      },
    };
    const transaction = jest.fn()
      .mockRejectedValueOnce(Object.assign(new Error('write conflict'), { code: 'P2034' }))
      .mockImplementationOnce((callback: any) => callback(tx));
    const service = new AuthService({
      $transaction: transaction,
    } as any, jwt as any);

    await expect(service.refresh('concurrent-old-token'))
      .rejects.toBeInstanceOf(UnauthorizedException);
    expect(transaction).toHaveBeenCalledTimes(2);
    expect(updateMany).toHaveBeenCalledWith({
      where: { familyId: 'family-concurrent', revokedAt: null },
      data: { revokedAt: expect.any(Date) },
    });
  });

  it('fails repeated initialization without exposing the setup key', async () => {
    const prisma = {
      $transaction: jest.fn().mockRejectedValue(
        Object.assign(new Error('unique'), { code: 'P2002' }),
      ),
    };
    const service = new AuthService(prisma as any, jwt as any);
    const dto = {
      setupKey: process.env.INITIAL_ADMIN_SETUP_KEY!,
      email: 'admin@example.test',
      password: 'long-test-password',
      firstName: 'Test',
      lastName: 'Admin',
      companyName: 'Example',
    };

    let error: unknown;
    try {
      await service.initialize(dto);
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(ConflictException);
    expect(String((error as Error).message)).not.toContain(
      process.env.INITIAL_ADMIN_SETUP_KEY,
    );
  });
});
