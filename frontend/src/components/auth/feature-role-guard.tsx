'use client';

import { useAuthStore } from '@/store/authStore';
import { RELEASE_FEATURES } from '@/config/release-features';

export type ProtectedModule = 'customerFactsReview' | 'salesSequencesManagement';

const MANAGER_ROLES = new Set(['sales_manager', 'company_admin', 'super_admin']);

type ProtectedModuleFeatures = Record<ProtectedModule, boolean>;

export function canAccessProtectedModule(
  module: ProtectedModule,
  role: string | undefined,
  features: ProtectedModuleFeatures = RELEASE_FEATURES,
): boolean {
  return features[module] && !!role && MANAGER_ROLES.has(role);
}

export function FeatureRoleGuard({ module, children }: { module: ProtectedModule; children: React.ReactNode }) {
  const { user, activeCompanyId } = useAuthStore();
  const membership = user?.companies?.find((company) => company.id === activeCompanyId) || user?.companies?.[0];
  if (!canAccessProtectedModule(module, membership?.role)) {
    return <div className="mx-auto max-w-lg rounded-xl border border-amber-200 bg-amber-50 p-6 text-center text-sm text-amber-900" role="alert"><h1 className="font-semibold">当前账号无权访问</h1><p className="mt-2">此功能仅对经理和管理员开放，或当前功能开关尚未启用。</p></div>;
  }
  return <>{children}</>;
}
