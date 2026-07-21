/**
 * Data Isolation Utility
 *
 * Usage: Every service that queries company-scoped data must call
 * applyDataIsolation() to enforce sub-account data separation.
 *
 * Rules:
 *   super_admin  → sees ALL data across all companies
 *   company_admin → sees ALL data within their company
 *   everyone else → sees ONLY their own data (ownerUserId/createdBy)
 *
 * Usage example:
 *   const where = applyDataIsolation(currentUser, { deletedAt: null, companyId });
 */

export interface CurrentUser {
  id: string;
  email: string;
  companies: Array<{
    id: string;        // company ID
    name: string;
    role: string;      // role name: super_admin | company_admin | sales_manager | sales_user | viewer
    roleId?: string;
    isDefault?: boolean;
  }>;
}

/** Roles with full company-wide visibility */
const FULL_ACCESS_ROLES = ['super_admin', 'company_admin'];

/** Roles restricted to own data only */
const ISOLATED_ROLES = ['sales_manager', 'sales_user', 'viewer'];

/**
 * Check if the current user has full access (sees all company data)
 */
export function hasFullAccess(currentUser: CurrentUser): boolean {
  return currentUser.companies?.some((c) => FULL_ACCESS_ROLES.includes(c.role)) ?? false;
}

/**
 * Check if the current user is isolated (sees only own data)
 */
export function isIsolatedUser(currentUser: CurrentUser): boolean {
  return !hasFullAccess(currentUser);
}

/**
 * Apply data isolation to a Prisma where clause.
 *
 * @param currentUser - The authenticated user from JWT
 * @param baseWhere - The base where clause (must include companyId filter)
 * @param ownerField - The field name for the owner/user ID (default: 'ownerUserId')
 * @returns The modified where clause with isolation applied
 */
export function applyDataIsolation(
  currentUser: CurrentUser,
  baseWhere: Record<string, any>,
  ownerField: string = 'ownerUserId',
): Record<string, any> {
  if (hasFullAccess(currentUser)) {
    return baseWhere;
  }

  // Isolated user: only see their own data
  return {
    ...baseWhere,
    [ownerField]: currentUser.id,
  };
}

/**
 * Apply data isolation for jobs/tasks created by the user (search tasks, imports, etc.)
 * Uses 'createdBy' as the owner field.
 */
export function applyCreatorIsolation(
  currentUser: CurrentUser,
  baseWhere: Record<string, any>,
): Record<string, any> {
  return applyDataIsolation(currentUser, baseWhere, 'createdBy');
}

/**
 * Get the company IDs the user has access to.
 * Isolated users only get their own company.
 */
export function getAccessibleCompanyIds(currentUser: CurrentUser): string[] {
  return currentUser.companies?.map((c) => c.id).filter(Boolean) ?? [];
}

/**
 * Check if user can access a specific resource.
 * Throws ForbiddenException if not.
 */
export function checkResourceAccess(
  currentUser: CurrentUser,
  resource: { ownerUserId?: string | null; createdBy?: string | null; companyId?: string | null },
  ownerField: string = 'ownerUserId',
): { allowed: boolean; reason?: string } {
  if (hasFullAccess(currentUser)) {
    return { allowed: true };
  }

  const resourceOwner = resource[ownerField as keyof typeof resource];
  if (!resourceOwner) {
    // Resources without owner are only accessible to full-access roles (admins)
    return { allowed: hasFullAccess(currentUser), reason: 'Resource has no owner — admin only' };
  }

  if (resourceOwner !== currentUser.id) {
    return {
      allowed: false,
      reason: `Resource belongs to another user (${resourceOwner})`,
    };
  }

  return { allowed: true };
}

/**
 * Check if a user can access resources belonging to a specific company.
 *
 * Rules:
 *   super_admin   → allowed (global)
 *   company_admin → allowed ONLY if companyId matches their company
 *   other roles   → allowed ONLY if companyId is in their companies list
 *   NO companies  → REJECTED (must have at least one company membership)
 *
 * Throws a descriptive error if access is denied.
 * Import ForbiddenException from @nestjs/common in the caller.
 */
export function ensureCompanyAccess(currentUser: CurrentUser, companyId: string): void {
  const companies = currentUser.companies || [];

  // super_admin can access any company
  if (companies.some((c) => c.role === 'super_admin')) {
    return;
  }

  // Must have at least one company membership
  if (companies.length === 0) {
    throw new Error('FORBIDDEN: User has no company membership');
  }

  // company_admin and other roles must be a member of the target company
  const isMember = companies.some((c) => c.id === companyId);
  if (!isMember) {
    throw new Error('FORBIDDEN: User does not belong to this company');
  }
}
