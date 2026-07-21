import { Suspense } from 'react';
import { Shell } from '@/components/layout/shell';
import { ErrorBoundary } from '@/components/common/ErrorBoundary';

export default function DashboardLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <Shell>
      <ErrorBoundary>
        <Suspense fallback={<div className="flex items-center justify-center py-20"><p className="text-gray-400">Loading...</p></div>}>
          {children}
        </Suspense>
      </ErrorBoundary>
    </Shell>
  );
}
