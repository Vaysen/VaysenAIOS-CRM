import { ReactNode } from 'react';
import { cn } from '@/lib/utils';

interface MetricCard {
  label: string;
  value: string;
  sub?: string;
  trend?: 'up' | 'down' | 'neutral';
}

interface QuickAction {
  label: string;
  href?: string;
  onClick?: () => void;
  variant?: 'primary' | 'outline';
}

interface Props {
  title: string;
  description?: string;
  metrics?: MetricCard[];
  children?: ReactNode;
  quickActions?: QuickAction[];
  emptyState?: ReactNode;
  futureNote?: string;
  isEmpty?: boolean;
}

export function ModulePage({
  title, description, metrics, children, quickActions, emptyState, futureNote, isEmpty,
}: Props) {
  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between">
        <div>
          <h1 className="text-xl font-bold text-gray-900">{title}</h1>
          {description && <p className="mt-1 text-sm text-gray-500">{description}</p>}
        </div>
        {quickActions && quickActions.length > 0 && (
          <div className="flex gap-2">
            {quickActions.map((action, i) => (
              action.href ? (
                <a key={i} href={action.href} className={cn(
                  'inline-flex items-center rounded-md px-3 py-1.5 text-sm font-medium transition-colors',
                  action.variant === 'primary' ? 'bg-primary text-primary-foreground hover:opacity-90' : 'border border-gray-200 text-gray-700 hover:bg-gray-50',
                )}>{action.label}</a>
              ) : (
                <button key={i} onClick={action.onClick} className={cn(
                  'inline-flex items-center rounded-md px-3 py-1.5 text-sm font-medium transition-colors',
                  action.variant === 'primary' ? 'bg-primary text-primary-foreground hover:opacity-90' : 'border border-gray-200 text-gray-700 hover:bg-gray-50',
                )}>{action.label}</button>
              )
            ))}
          </div>
        )}
      </div>

      {metrics && metrics.length > 0 && (
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
          {metrics.map((m, i) => (
            <div key={i} className="bg-white border rounded-lg p-4">
              <p className="text-xs text-gray-500">{m.label}</p>
              <p className="text-2xl font-bold mt-1">{m.value}</p>
              {m.sub && <p className="text-xs text-gray-400 mt-0.5">{m.sub}</p>}
            </div>
          ))}
        </div>
      )}

      <div className="bg-white border rounded-lg">
        {isEmpty && emptyState ? (
          <div className="flex items-center justify-center py-16 px-4">
            <div className="text-center max-w-sm">{emptyState}</div>
          </div>
        ) : (
          <div className="p-6">{children}</div>
        )}
      </div>

      {futureNote && (
        <div className="bg-amber-50 border border-amber-200 rounded-lg p-4">
          <p className="text-xs font-semibold text-amber-800 uppercase tracking-wide">规划中</p>
          <p className="text-sm text-amber-700 mt-1">{futureNote}</p>
        </div>
      )}
    </div>
  );
}
