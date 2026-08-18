import { describe, expect, it } from 'vitest';
import { canWriteActiveCompany, findActiveCompanyMembership } from '../active-company-membership';

const user = {
  companies: [
    { id: 'company-a', role: 'super_admin' },
    { id: 'company-b', role: 'viewer' },
    { id: 'company-c', role: 'sales_user' },
  ],
};

const scopedAdminUser = {
  companies: [
    { id: 'company-a', role: 'company_admin' },
    { id: 'company-b', role: 'viewer' },
    { id: 'company-c', role: 'sales_user' },
  ],
};

describe('active company membership', () => {
  it('selects the membership matching activeCompanyId instead of array order', () => {
    expect(findActiveCompanyMembership(user, 'company-c')).toEqual({
      id: 'company-c',
      role: 'sales_user',
    });
  });

  it('preserves global super-admin writes for any verified active membership', () => {
    expect(canWriteActiveCompany(user, 'company-b')).toBe(true);
    expect(canWriteActiveCompany(user, 'company-c')).toBe(true);
  });

  it('does not inherit a non-global write role held in another tenant', () => {
    expect(canWriteActiveCompany(scopedAdminUser, 'company-b')).toBe(false);
    expect(canWriteActiveCompany(scopedAdminUser, 'company-c')).toBe(true);
  });

  it('fails closed when activeCompanyId is absent or not a verified membership', () => {
    expect(canWriteActiveCompany(user, null)).toBe(false);
    expect(canWriteActiveCompany(user, 'company-foreign')).toBe(false);
  });
});
