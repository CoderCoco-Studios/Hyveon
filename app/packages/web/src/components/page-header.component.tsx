import type { ReactNode } from 'react';
import { ArrowLeft } from 'lucide-react';
import { Link } from 'react-router-dom';
import { cn } from '@/lib/utils.utils';

/** Props for {@link PageHeader}. */
export interface PageHeaderProps {
  /** Page title, rendered as the page's `<h2>` — its accessible name is pinned by e2e page objects, keep it exact. */
  title: ReactNode;
  /** Optional one-line description shown under the title. */
  subtitle?: ReactNode;
  /** Extra classes for the title `<h2>` (e.g. `capitalize` for a page whose title is a raw entity name). */
  titleClassName?: string;
  /** Route for an optional "back" link rendered above the title. */
  backTo?: string;
  /** Link text for {@link backTo}; required when `backTo` is set. */
  backLabel?: string;
  /** Trailing content (status indicators, nav links, actions) rendered at the header's end. */
  children?: ReactNode;
}

/**
 * Standard page-chrome header: an optional back link, the page `<h2>` title, an optional subtitle, and trailing
 * actions — the shape duplicated across every top-level route page before this extraction.
 */
export function PageHeader({ title, subtitle, titleClassName, backTo, backLabel, children }: PageHeaderProps) {
  return (
    <header className="flex flex-wrap items-end justify-between gap-4">
      <div>
        {backTo && (
          <Link
            to={backTo}
            className="mb-1 inline-flex items-center gap-1 text-sm text-[var(--color-muted-foreground)] hover:text-[var(--color-foreground)]"
          >
            <ArrowLeft className="size-3.5" />
            {backLabel}
          </Link>
        )}
        <h2 className={cn('text-2xl font-semibold text-[var(--color-foreground)]', titleClassName)}>{title}</h2>
        {subtitle && <p className="mt-1 text-sm text-[var(--color-muted-foreground)]">{subtitle}</p>}
      </div>
      {children}
    </header>
  );
}
