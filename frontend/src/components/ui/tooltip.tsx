'use client';

import * as React from 'react';
import { cn } from '@/lib/utils';

function Tooltip({ label, children, className }: { label: React.ReactNode; children: React.ReactNode; className?: string }) {
  return (
    <span className="group relative inline-flex">
      {children}
      <span className={cn('pointer-events-none absolute bottom-full left-1/2 z-50 mb-2 hidden -translate-x-1/2 whitespace-nowrap rounded-md bg-foreground px-2 py-1 text-xs text-background shadow group-hover:block', className)}>
        {label}
      </span>
    </span>
  );
}

export { Tooltip };
