import type { ReactNode } from 'react';
import { Loader2 } from 'lucide-react';
import { cn } from '@/lib/utils.utils';

/** Props for {@link AsyncContent}. */
export interface AsyncContentProps {
  /** True while the initial fetch is in flight. Takes priority over `error`/`isEmpty`. */
  loading: boolean;
  /** Error message from the fetch, or `null`/`undefined` when there is none. Only shown while `isEmpty`. */
  error?: string | null;
  /** Whether there is no data to render — drives the error vs. empty-state branch once `loading` is false. */
  isEmpty: boolean;
  /** Rendered in place of `children` when `isEmpty` is true and there is no `error`. */
  emptyMessage: ReactNode;
  /** Rendered in place of `emptyMessage` when `isEmpty` is true and `error` is set. Defaults to `error` itself. */
  errorMessage?: ReactNode;
  /** Rendered once `loading` is false and `isEmpty` is false, regardless of a stale `error` from a failed refresh. */
  children: ReactNode;
  /** Extra classes merged onto the loading/error/empty state wrapper — e.g. `col-span-full` when placed directly inside a CSS grid rather than a `SectionCard`. */
  className?: string;
}

/**
 * Loading → error → empty → content ternary shared by every list/table page
 * section (audit log, declared games, run history, cost estimates, dashboard
 * game grid). A truthy `error` only pre-empts `children` while `isEmpty` is
 * true — a failed "load more"/refresh with data already on screen is left to
 * the caller to surface (e.g. a trailing error line below the table), so
 * stale content never disappears out from under the operator.
 */
export function AsyncContent({
  loading,
  error,
  isEmpty,
  emptyMessage,
  errorMessage,
  children,
  className,
}: AsyncContentProps) {
  if (loading) {
    return (
      <div className={cn('flex min-h-32 items-center justify-center gap-2 text-sm text-[var(--color-muted-foreground)]', className)}>
        <Loader2 className="size-4 animate-spin" aria-hidden="true" />
        Loading…
      </div>
    );
  }

  if (error && isEmpty) {
    return (
      <div className={cn('flex min-h-32 items-center justify-center text-sm text-[var(--color-red)]', className)}>
        {errorMessage ?? error}
      </div>
    );
  }

  if (isEmpty) {
    return (
      <div className={cn('flex min-h-32 items-center justify-center text-sm text-[var(--color-muted-foreground)]', className)}>
        {emptyMessage}
      </div>
    );
  }

  return <>{children}</>;
}
