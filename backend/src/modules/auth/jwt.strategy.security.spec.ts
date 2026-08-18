import { ForbiddenException } from '@nestjs/common';
import { JwtStrategy } from './jwt.strategy';

const relation = (
  companyId: string,
  role: string,
  isDefault = false,
) => ({
  isActive: true,
  isDefault,
  company: { id: companyId, name: companyId, isActive: true },
  role: { id: `role-${role}`, name: role },
});

describe('JwtStrategy active tenant selection', () => {
  beforeEach(() => {
    process.env.JWT_SECRET = 'test-only-jwt-secret-with-at-least-32-bytes';
  });

  it('does not silently select one of multiple default memberships', async () => {
    const prisma: any = {
      user: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'u1',
          email: 'u@example.test',
          isActive: true,
          deletedAt: null,
          companies: [
            relation('A', 'company_admin', true),
            relation('B', 'viewer', true),
          ],
        }),
      },
    };

    await expect(new JwtStrategy(prisma).validate(
      { headers: {} },
      { sub: 'u1', email: 'u@example.test' },
    )).rejects.toThrow(
      'Active company is ambiguous',
    );
    expect(prisma.user.findUnique).toHaveBeenCalledWith(expect.objectContaining({
      include: {
        companies: {
          where: { isActive: true, company: { isActive: true } },
          include: { company: true, role: true },
        },
      },
    }));
  });

  it('rejects a requested company without an active membership', async () => {
    const prisma: any = {
      user: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'u1',
          email: 'u@example.test',
          isActive: true,
          deletedAt: null,
          companies: [relation('A', 'company_admin')],
        }),
      },
    };

    await expect(new JwtStrategy(prisma).validate(
      { headers: { 'x-company-id': 'B' } },
      { sub: 'u1', email: 'u@example.test' },
    )).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('lets a global super administrator explicitly select an active target', async () => {
    const prisma: any = {
      user: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'u1',
          email: 'u@example.test',
          isActive: true,
          deletedAt: null,
          companies: [
            relation('A', 'super_admin'),
            relation('B', 'viewer'),
          ],
        }),
      },
      company: { findFirst: jest.fn() },
    };

    const result = await new JwtStrategy(prisma).validate(
      { headers: { 'x-company-id': 'B' } },
      { sub: 'u1', email: 'u@example.test' },
    );

    expect(result.activeCompanyId).toBe('B');
    expect(result.activeCompany!.role).toBe('super_admin');
    expect(prisma.company.findFirst).not.toHaveBeenCalled();
  });
});
