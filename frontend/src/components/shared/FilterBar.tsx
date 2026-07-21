import * as React from 'react';
import { cn } from '@/lib/utils';

export function FilterBar({ children, className }: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cn('grid gap-2 rounded-lg border border-border bg-card p-3 sm:grid-cols-2 lg:grid-cols-4 xl:grid-cols-6', className)}>{children}</div>;
}
