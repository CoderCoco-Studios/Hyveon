import type { ReactNode } from 'react';
import { cn } from '@/lib/utils.utils';

/** Props for {@link ErrorBanner}. */
export interface ErrorBannerProps {
  /** Banner content — usually an error message string, sometimes richer markup (e.g. a retry action). */
  children: ReactNode;
  /** Extra classes merged onto the banner's root, for layout tweaks (e.g. `flex flex-col gap-2`). */
  className?: string;
}

/** Bordered, tinted inline error banner with `role="alert"` baked in. */
export function ErrorBanner({ children, className }: ErrorBannerProps) {
  return (
    <div
      role="alert"
      className={cn(
        'rounded-[var(--radius-sm)] border border-[var(--color-red)]/40 bg-[var(--color-red)]/10 px-3 py-2 text-sm text-[var(--color-red)]',
        className,
      )}
    >
      {children}
    </div>
  );
}
