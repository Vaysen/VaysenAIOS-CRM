'use client';

import { useCallback } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { useAuthStore } from '@/store/authStore';
import { useT } from '@/i18n/use-translation';
import { RegistrationForm } from '@/features/auth/registration';
import type { RegistrationValues } from '@/features/auth/registration';

/**
 * 真实注册页 — adapter 层
 *
 * RegistrationForm 是纯组件（无 API/router/store 依赖），
 * 本页面负责将 authStore.register 适配为 onSubmit 回调。
 */
export default function RegisterPage() {
  const router = useRouter();
  const { register } = useAuthStore();
  const { t } = useT();

  const handleSubmit = useCallback(
    async (values: RegistrationValues, _signal: AbortSignal) => {
      await register(
        values.username,
        values.password,
        values.firstName,
        values.lastName,
        values.companyName || undefined,
      );
    },
    [register],
  );

  const handleSuccess = useCallback(() => {
    router.push('/');
  }, [router]);

  return (
    <div className="w-full max-w-md rounded-xl border border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-950 p-8 shadow-sm">
      <div className="mb-6 text-center">
        <h1 className="text-2xl font-bold text-gray-900 dark:text-white">
          Vaysen Trade OS
        </h1>
        <p className="mt-2 text-gray-500 dark:text-gray-400">
          {t('auth.registerTitle')}
        </p>
      </div>

      <RegistrationForm
        onSubmit={handleSubmit}
        onSuccess={handleSuccess}
        className="space-y-0"
      />

      <p className="mt-4 text-center text-sm text-gray-500 dark:text-gray-400">
        {t('auth.alreadyHaveAccount')}{' '}
        <Link href="/login" className="text-blue-600 hover:text-blue-700 font-medium">
          {t('auth.signIn')}
        </Link>
      </p>
    </div>
  );
}
