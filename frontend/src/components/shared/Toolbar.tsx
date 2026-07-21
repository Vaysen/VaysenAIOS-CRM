import * as React from 'react';
import { cn } from '@/lib/utils';

export function Toolbar({ children, className }: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cn('mb-4 flex flex-wrap items-center gap-2 rounded-lg border border-border bg-card p-3', className)}>{children}</div>;
}
