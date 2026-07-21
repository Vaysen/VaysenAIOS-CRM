import Link from 'next/link';
import { cn } from '@/lib/utils';

export function WorkspaceTabs({ items, activeHref, className }: { items: Array<{ href: string; label: string; count?: number }>; activeHref: string; className?: string }) {
  return (
    <div className={cn('mb-4 flex flex-wrap gap-1 border-b border-border', className)}>
      {items.map((item) => {
        const active = activeHref === item.href || activeHref.startsWith(`${item.href}/`);
        return (
          <Link
            key={item.href}
            href={item.href}
            className={cn('border-b-2 px-3 py-2 text-sm font-medium transition-colors', active ? 'border-primary text-foreground' : 'border-transparent text-muted-foreground hover:text-foreground')}
          >
            {item.label}
            {item.count !== undefined && <span className="ml-1 rounded bg-muted px-1.5 py-0.5 text-xs">{item.count}</span>}
          </Link>
        );
      })}
    </div>
  );
}
