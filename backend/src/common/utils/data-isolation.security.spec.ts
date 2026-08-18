import { ForbiddenException } from '@nestjs/common';
import {
  applyDataIsolation,
  checkResourceAccess,
  ensureCompanyAccess,
  getAccessibleCompanyIds,
  hasFullAccess,
  requireActiveCompany,
} from './data-isolation';

function user(
  activeCompanyId: string | null,
  companies: Array<{ id: string; role: string }>,
) {
  const active = companies.find((company) => company.id === activeCompanyId);
  return {
    id: 'operator',
    activeCompanyId,
    activeCompany: active ? { ...active, name: active.id } : null,
    companies: companies.map((company) => ({ ...company, name: company.id })),
  };
}

describe('tenant data isolation security boundary', () => {
  it('does not let an A administrator override B viewer isolation', () => {
    const operator = user('B', [
      { id: 'A', role: 'company_admin' },
      { id: 'B', role: 'viewer' },
    ]);

    expect(hasFullAccess(operator, 'B')).toBe(false);
    expect(applyDataIsolation(operator, { companyId: 'B' })).toEqual({
      companyId: 'B',
      ownerUserId: 'operator',
    });
  });

  it('does not let a B administrator cross the active A request boundary', () => {
    const operator = user('A', [
      { id: 'A', role: 'sales_user' },
      { id: 'B', role: 'company_admin' },
    ]);

    expect(hasFullAccess(operator, 'B')).toBe(false);
    expect(checkResourceAccess(operator, {
      companyId: 'B',
      ownerUserId: 'operator',
    })).toEqual({
      allowed: false,
      reason: 'Resource is outside the active company',
    });
    expect(() => ensureCompanyAccess(operator, 'B')).toThrow(ForbiddenException);
  });

  it('fails closed when the active tenant is missing or ambiguous', () => {
    const operator = user(null, [
      { id: 'A', role: 'company_admin' },
      { id: 'B', role: 'company_admin' },
    ]);

    expect(getAccessibleCompanyIds(operator)).toEqual([]);
    expect(() => requireActiveCompany(operator)).toThrow(ForbiddenException);
    expect(hasFullAccess(operator, 'A')).toBe(false);
  });

  it('permits a super administrator only after the target is explicitly active', () => {
    const operator = user('B', [
      { id: 'A', role: 'super_admin' },
      { id: 'B', role: 'super_admin' },
    ]);

    expect(hasFullAccess(operator, 'B')).toBe(true);
    expect(hasFullAccess(operator, 'A')).toBe(false);
    expect(() => ensureCompanyAccess(operator, 'B')).not.toThrow();
  });

  it('rejects a forged synthetic super role without a valid global membership', () => {
    const operator = user('B', [{ id: 'B', role: 'viewer' }]);
    operator.activeCompany = { id: 'B', name: 'B', role: 'super_admin' };

    expect(hasFullAccess(operator, 'B')).toBe(false);
    expect(() => ensureCompanyAccess(operator, 'B')).not.toThrow();
    expect(applyDataIsolation(operator, { companyId: 'B' })).toEqual({
      companyId: 'B',
      ownerUserId: 'operator',
    });
  });
});
