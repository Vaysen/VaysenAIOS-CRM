'use client';

import * as React from 'react';
import { cn } from '@/lib/utils';

const DropdownMenu = ({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) => <div className={cn('relative inline-block', className)} {...props} />;
const DropdownMenuTrigger = React.forwardRef<HTMLButtonElement, React.ButtonHTMLAttributes<HTMLButtonElement>>((props, ref) => <button ref={ref} type="button" {...props} />);
DropdownMenuTrigger.displayName = 'DropdownMenuTrigger';
const DropdownMenuContent = ({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) => <div className={cn('absolute right-0 z-50 mt-2 min-w-40 rounded-lg border border-border bg-popover p-1 text-popover-foreground shadow-lg', className)} {...props} />;
const DropdownMenuItem = React.forwardRef<HTMLButtonElement, React.ButtonHTMLAttributes<HTMLButtonElement>>(({ className, ...props }, ref) => <button ref={ref} type="button" className={cn('flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm hover:bg-muted disabled:pointer-events-none disabled:opacity-50', className)} {...props} />);
DropdownMenuItem.displayName = 'DropdownMenuItem';
const DropdownMenuSeparator = ({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) => <div className={cn('-mx-1 my-1 h-px bg-border', className)} {...props} />;

export { DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator };
