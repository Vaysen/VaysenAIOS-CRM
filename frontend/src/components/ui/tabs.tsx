'use client';

import * as React from 'react';
import { cn } from '@/lib/utils';

const Tabs = ({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) => <div className={cn('w-full', className)} {...props} />;
const TabsList = ({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) => <div className={cn('inline-flex h-9 items-center rounded-lg bg-muted p-1 text-muted-foreground', className)} {...props} />;
const TabsTrigger = React.forwardRef<HTMLButtonElement, React.ButtonHTMLAttributes<HTMLButtonElement> & { active?: boolean }>(({ className, active, ...props }, ref) => (
  <button ref={ref} className={cn('inline-flex items-center justify-center whitespace-nowrap rounded-md px-3 py-1 text-sm font-medium transition-colors hover:text-foreground disabled:pointer-events-none disabled:opacity-50', active && 'bg-background text-foreground shadow-xs', className)} {...props} />
));
TabsTrigger.displayName = 'TabsTrigger';
const TabsContent = ({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) => <div className={cn('mt-3', className)} {...props} />;

export { Tabs, TabsList, TabsTrigger, TabsContent };
