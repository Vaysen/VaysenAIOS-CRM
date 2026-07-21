'use client';

import * as React from 'react';
import { cn } from '@/lib/utils';

const Popover = ({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) => <div className={cn('relative inline-block', className)} {...props} />;
const PopoverTrigger = React.forwardRef<HTMLButtonElement, React.ButtonHTMLAttributes<HTMLButtonElement>>((props, ref) => <button ref={ref} type="button" {...props} />);
PopoverTrigger.displayName = 'PopoverTrigger';
const PopoverContent = ({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) => <div className={cn('absolute right-0 z-50 mt-2 w-72 rounded-lg border border-border bg-popover p-4 text-sm text-popover-foreground shadow-lg', className)} {...props} />;

export { Popover, PopoverTrigger, PopoverContent };
