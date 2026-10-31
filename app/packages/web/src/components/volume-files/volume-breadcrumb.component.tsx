import { Fragment } from 'react';
import { ChevronRight } from 'lucide-react';

/** Props for {@link VolumeBreadcrumb}. */
export interface VolumeBreadcrumbProps {
  /** Label of the volume root. */
  rootLabel: string;
  /** Clean absolute directory path being shown. */
  path: string;
  onOpen(path: string): void;
}

// @spec HELPER-FB-024
/** Path trail from the volume root to the current directory; every ancestor is a button, the current folder is text. */
export function VolumeBreadcrumb({ rootLabel, path, onOpen }: VolumeBreadcrumbProps) {
  const segments = path.split('/').filter((segment) => segment !== '');
  const trail = segments.map((name, index) => ({ name, path: `/${segments.slice(0, index + 1).join('/')}` }));

  return (
    <nav aria-label="Breadcrumb" className="flex flex-wrap items-center gap-1 text-sm">
      {trail.length === 0 ? (
        <span className="font-medium">{rootLabel}</span>
      ) : (
        <button type="button" className="text-[var(--color-primary-light)] hover:underline" onClick={() => onOpen('/')}>
          {rootLabel}
        </button>
      )}
      {trail.map((segment, index) => (
        <Fragment key={segment.path}>
          <ChevronRight className="size-3.5 text-[var(--color-muted-foreground)]" aria-hidden="true" />
          {index === trail.length - 1 ? (
            <span className="font-medium">{segment.name}</span>
          ) : (
            <button type="button" className="text-[var(--color-primary-light)] hover:underline" onClick={() => onOpen(segment.path)}>
              {segment.name}
            </button>
          )}
        </Fragment>
      ))}
    </nav>
  );
}
