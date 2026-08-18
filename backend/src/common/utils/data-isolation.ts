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
import { ForbiddenException } from '@nestjs/common';

export interface CurrentUser {
  id: string;
  email?: string;
  activeCompanyId?: string | null;
  activeCompany?: {
    id: string;
    name?: string;
    role: string;
    roleId?: string;
    isDefault?: boolean;
    [key: string]: any;
  } | null;
  companies?: Array<{
    id: string;        // company ID
    name?: string;
    role: string;      // role name: super_admin | company_admin | sales_manager | sales_user | viewer
    roleId?: string;
    isDefault?: boolean;
    [key: string]: any;
  }>;
}

/**
 * Check whether the user has company-wide access for one explicit tenant.
 * A super administrator is the only global role. A company administrator is
 * elevated only inside the company where that membership is active.
 *
 * Omitting targetCompanyId intentionally recognizes only super_admin. This
 * prevents a caller that forgot tenant context from accidentally turning a
 * company_admin membership into a global bypass.
 */
export function hasFullAccess(
  currentUser: CurrentUser,
  targetCompanyId?: string | null,
): boolean {
  if (!targetCompanyId || currentUser.activeCompanyId !== targetCompanyId) {
    return false;
  }
  const companies = currentUser.companies || [];
  if (
    currentUser.activeCompany?.id === targetCompanyId
    && currentUser.activeCompany.role === 'super_admin'
    && companies.some((company) => company.role === 'super_admin')
  ) {
    return true;
  }
  return companies.some(
    (company) =>
      company.id === targetCompanyId && company.role === 'company_admin',
  );
}

/**
 * Check if the current user is isolated (sees only own data)
 */
export function isIsolatedUser(
  currentUser: CurrentUser,
  targetCompanyId?: string | null,
): boolean {
  return !hasFullAccess(currentUser, targetCompanyId);
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
  const companyId = extractSingleCompanyId(baseWhere.companyId);
  if (hasFullAccess(currentUser, companyId)) {
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
  if (
    currentUser.activeCompanyId
    && currentUser.activeCompany?.id === currentUser.activeCompanyId
  ) {
    return [currentUser.activeCompanyId];
  }
  return [];
}

/**
 * Resolve the authenticated request's active tenant. Multi-company users must
 * either select a validated company with X-Company-Id or have one unambiguous
 * default membership. Services should use this instead of companies[0].
 */
export function requireActiveCompany(currentUser: CurrentUser) {
  const activeCompanyId = currentUser.activeCompanyId;
  const activeCompany = currentUser.activeCompany;
  if (!activeCompanyId || !activeCompany || activeCompany.id !== activeCompanyId) {
    throw new ForbiddenException(
      'An active company is required; select one with X-Company-Id',
    );
  }
  return activeCompany;
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
  if (!resource.companyId) {
    return {
      allowed: false,
      reason: 'Resource has no company — access denied',
    };
  }

  if (currentUser.activeCompanyId !== resource.companyId) {
    return { allowed: false, reason: 'Resource is outside the active company' };
  }

  if (hasFullAccess(currentUser, resource.companyId)) {
    return { allowed: true };
  }

  if (!currentUser.companies?.some((company) => company.id === resource.companyId)) {
    return { allowed: false, reason: 'Resource belongs to another company' };
  }

  const resourceOwner = resource[ownerField as keyof typeof resource];
  if (!resourceOwner) {
    // Resources without owner are only accessible to full-access roles (admins)
    return { allowed: false, reason: 'Resource has no owner — admin only' };
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

  if (
    currentUser.activeCompanyId !== companyId
    || currentUser.activeCompany?.id !== companyId
  ) {
    throw new ForbiddenException(
      'Company is outside the active request context',
    );
  }

  // super_admin can operate any company after selecting it as active.
  if (
    currentUser.activeCompany.role === 'super_admin'
    && companies.some((company) => company.role === 'super_admin')
  ) {
    return;
  }

  // Must have at least one company membership
  if (companies.length === 0) {
    throw new ForbiddenException('User has no company membership');
  }

  // company_admin and other roles must be a member of the target company
  const isMember = companies.some((c) => c.id === companyId);
  if (!isMember) {
    throw new ForbiddenException('User does not belong to this company');
  }
}

function extractSingleCompanyId(companyFilter: unknown): string | undefined {
  if (typeof companyFilter === 'string') return companyFilter;
  if (
    companyFilter
    && typeof companyFilter === 'object'
    && 'equals' in companyFilter
    && typeof (companyFilter as { equals?: unknown }).equals === 'string'
  ) {
    return (companyFilter as { equals: string }).equals;
  }
  return undefined;
}
