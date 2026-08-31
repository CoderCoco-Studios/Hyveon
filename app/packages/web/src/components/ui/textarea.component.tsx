import * as React from 'react';
import { cn } from '@/lib/utils.utils';

/** Props for the Textarea component — all standard HTML textarea attributes. */
export type TextareaProps = React.TextareaHTMLAttributes<HTMLTextAreaElement>;

/** Thin `forwardRef` wrapper over a raw `<textarea>`, mirroring `ui/input.component.tsx`'s shape. */
const Textarea = React.forwardRef<HTMLTextAreaElement, TextareaProps>(({ className, ...props }, ref) => (
  <textarea
    className={cn(
      'flex min-h-16 w-full rounded-[var(--radius-sm)] border border-[var(--color-border)] bg-[var(--color-surface-2)] px-3 py-1 text-sm text-[var(--color-foreground)] font-[var(--font-mono)] shadow-sm transition-colors placeholder:text-[var(--color-muted-foreground)] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[var(--color-primary)] disabled:cursor-not-allowed disabled:opacity-50',
      className,
    )}
    ref={ref}
    {...props}
  />
));
Textarea.displayName = 'Textarea';

export { Textarea };
