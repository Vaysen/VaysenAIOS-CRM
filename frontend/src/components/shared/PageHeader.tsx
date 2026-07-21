import * as React from 'react';
import { cn } from '@/lib/utils';

export function PageHeader({ title, description, actions, className }: { title: string; description?: string; actions?: React.ReactNode; className?: string }) {
  return (
    <div className={cn('mb-5 flex flex-col gap-3 border-b border-border pb-4 md:flex-row md:items-end md:justify-between', className)}>
      <div>
        <h1 className="text-2xl font-semibold tracking-normal text-foreground">{title}</h1>
        {description && <p className="mt-1 max-w-3xl text-sm text-muted-foreground">{description}</p>}
      </div>
      {actions && <div className="flex shrink-0 flex-wrap items-center gap-2">{actions}</div>}
    </div>
  );
}
