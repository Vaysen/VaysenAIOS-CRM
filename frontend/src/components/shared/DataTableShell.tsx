import * as React from 'react';
import { cn } from '@/lib/utils';

export function DataTableShell({ children, footer, className }: { children: React.ReactNode; footer?: React.ReactNode; className?: string }) {
  return (
    <div className={cn('overflow-hidden rounded-lg border border-border bg-card', className)}>
      <div className="overflow-auto">{children}</div>
      {footer && <div className="border-t border-border px-4 py-3 text-sm text-muted-foreground">{footer}</div>}
    </div>
  );
}
