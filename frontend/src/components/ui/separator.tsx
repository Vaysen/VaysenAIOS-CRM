import * as React from 'react';
import { cn } from '@/lib/utils';

function Separator({ className, orientation = 'horizontal', ...props }: React.HTMLAttributes<HTMLDivElement> & { orientation?: 'horizontal' | 'vertical' }) {
  return (
    <div
      role="separator"
      aria-orientation={orientation}
      className={cn(orientation === 'horizontal' ? 'h-px w-full' : 'h-full w-px', 'bg-border', className)}
      {...props}
    />
  );
}

export { Separator };
