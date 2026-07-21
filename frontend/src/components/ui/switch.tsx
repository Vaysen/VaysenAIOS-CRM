import * as React from 'react';
import { cn } from '@/lib/utils';

export type SwitchProps = React.InputHTMLAttributes<HTMLInputElement>;

const Switch = React.forwardRef<HTMLInputElement, SwitchProps>(({ className, type, ...props }, ref) => (
  <input
    ref={ref}
    type="checkbox"
    role="switch"
    className={cn(
      'h-5 w-9 cursor-pointer appearance-none rounded-full bg-input transition-colors before:block before:h-4 before:w-4 before:translate-x-0.5 before:translate-y-0.5 before:rounded-full before:bg-background before:shadow before:transition-transform checked:bg-primary checked:before:translate-x-4 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40 disabled:cursor-not-allowed disabled:opacity-50',
      className,
    )}
    {...props}
  />
));
Switch.displayName = 'Switch';

export { Switch };
