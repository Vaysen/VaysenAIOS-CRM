'use client';

import { I18nProvider } from '@/i18n/i18n-context';
import { AuthGuard } from '@/components/auth/auth-guard';
import type { ReactNode } from 'react';

export function Providers({ children }: { children: ReactNode }) {
  return (
    <I18nProvider>
      <AuthGuard>{children}</AuthGuard>
    </I18nProvider>
  );
}
