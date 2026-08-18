interface CompanyMembership {
  id: string;
  role: string;
}
interface UserWithCompanyMemberships {
  companies?: CompanyMembership[];
}

/**
 * Resolve the active membership only when the selected company is present in
 * the authenticated user's membership list. Never infer tenant permissions
 * from array order or from a role held in another company.
 */
export function findActiveCompanyMembership(
  user: UserWithCompanyMemberships | null | undefined,
  activeCompanyId: string | null | undefined,
): CompanyMembership | null {
  if (!user || !activeCompanyId) return null;
  return user.companies?.find((company) => company.id === activeCompanyId) ?? null;
}

export function canWriteActiveCompany(
  user: UserWithCompanyMemberships | null | undefined,
  activeCompanyId: string | null | undefined,
): boolean {
  const membership = findActiveCompanyMembership(user, activeCompanyId);
  if (!membership) return false;

  const isGlobalSuperAdmin =
    user?.companies?.some((company) => company.role === 'super_admin') ?? false;
  return isGlobalSuperAdmin || membership.role !== 'viewer';
}
