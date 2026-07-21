'use client';

import * as React from 'react';
import { X } from 'lucide-react';
import { cn } from '@/lib/utils';

function Dialog({ open, children }: { open?: boolean; children: React.ReactNode }) {
  if (!open) return null;
  return <>{children}</>;
}

function DialogContent({ className, children, onClose, ...props }: React.HTMLAttributes<HTMLDivElement> & { onClose?: () => void }) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
      <div className={cn('relative w-full max-w-lg rounded-lg border border-border bg-background p-5 shadow-xl', className)} {...props}>
        {onClose && (
          <button onClick={onClose} className="absolute right-3 top-3 rounded-md p-1 text-muted-foreground hover:bg-muted hover:text-foreground" aria-label="关闭">
            <X className="h-4 w-4" />
          </button>
        )}
        {children}
      </div>
    </div>
  );
}

const DialogHeader = ({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) => <div className={cn('mb-4 space-y-1.5', className)} {...props} />;
const DialogTitle = ({ className, ...props }: React.HTMLAttributes<HTMLHeadingElement>) => <h2 className={cn('text-lg font-semibold', className)} {...props} />;
const DialogDescription = ({ className, ...props }: React.HTMLAttributes<HTMLParagraphElement>) => <p className={cn('text-sm text-muted-foreground', className)} {...props} />;
const DialogFooter = ({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) => <div className={cn('mt-5 flex justify-end gap-2', className)} {...props} />;

export { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter };
