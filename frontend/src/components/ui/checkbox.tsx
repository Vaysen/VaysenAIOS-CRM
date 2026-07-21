import * as React from 'react';
import { cn } from '@/lib/utils';

export type CheckboxProps = React.InputHTMLAttributes<HTMLInputElement>;

const Checkbox = React.forwardRef<HTMLInputElement, CheckboxProps>(({ className, type, ...props }, ref) => (
  <input
    ref={ref}
    type="checkbox"
    className={cn('h-4 w-4 rounded border-input text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40 disabled:cursor-not-allowed disabled:opacity-50', className)}
    {...props}
  />
));
Checkbox.displayName = 'Checkbox';

export { Checkbox };
