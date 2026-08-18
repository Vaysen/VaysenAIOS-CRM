'use client';

import { I18nProvider } from '@/i18n/i18n-context';
import { AuthGuard } from '@/components/auth/auth-guard';
import type { ReactNode } from 'react';
import { RuntimeConnectionGate } from '@/components/runtime/lan-connection-settings';

export function Providers({ children }: { children: ReactNode }) {
  return (
    <I18nProvider>
      <RuntimeConnectionGate><AuthGuard>{children}</AuthGuard></RuntimeConnectionGate>
    </I18nProvider>
  );
}
