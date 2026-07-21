import * as React from 'react';
import { CheckCircle2, Info, TriangleAlert, XCircle } from 'lucide-react';
import { cn } from '@/lib/utils';

const icons = {
  default: Info,
  success: CheckCircle2,
  warning: TriangleAlert,
  destructive: XCircle,
};

export function Toast({ title, description, variant = 'default', className }: { title: string; description?: string; variant?: keyof typeof icons; className?: string }) {
  const Icon = icons[variant];
  return (
    <div className={cn('flex w-full max-w-sm gap-3 rounded-lg border border-border bg-background p-4 shadow-lg', className)}>
      <Icon className={cn('mt-0.5 h-4 w-4', variant === 'success' && 'text-emerald-600', variant === 'warning' && 'text-amber-600', variant === 'destructive' && 'text-destructive')} />
      <div>
        <p className="text-sm font-medium">{title}</p>
        {description && <p className="mt-1 text-sm text-muted-foreground">{description}</p>}
      </div>
    </div>
  );
}
