import * as React from 'react';
import { cn } from '@/lib/utils.utils';

/** Props for the NativeSelect component — all standard HTML select attributes. */
export type NativeSelectProps = React.SelectHTMLAttributes<HTMLSelectElement>;

/**
 * Thin wrapper over a raw `<select>` sharing `ui/input.component.tsx`'s class
 * string, so it gets the same shadow/transition/focus-visible ring as `Input`.
 * Deliberately not built on the Radix `ui/select.component.tsx` — that
 * renders a button+portal, which would break `fireEvent.change` in existing
 * specs that target a raw `<select>`.
 */
const NativeSelect = React.forwardRef<HTMLSelectElement, NativeSelectProps>(
  ({ className, children, ...props }, ref) => (
    <select
      className={cn(
        'flex h-9 w-full rounded-[var(--radius-sm)] border border-[var(--color-border)] bg-[var(--color-surface-2)] px-3 py-1 text-sm text-[var(--color-foreground)] font-[var(--font-mono)] shadow-sm transition-colors placeholder:text-[var(--color-muted-foreground)] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[var(--color-primary)] disabled:cursor-not-allowed disabled:opacity-50',
        className,
      )}
      ref={ref}
      {...props}
    >
      {children}
    </select>
  ),
);
NativeSelect.displayName = 'NativeSelect';

export { NativeSelect };
