import { Loader2 } from 'lucide-react';
import { cn } from '@/lib/utils.utils';

/** Props for {@link LoadingState}. */
export interface LoadingStateProps {
  /** Text shown next to the spinner. */
  label?: string;
  /** Extra classes merged onto the root, for layout tweaks (e.g. a different height). */
  className?: string;
}

/** Centered block spinner + label, for a card/section body waiting on its initial fetch. */
export function LoadingState({ label = 'Loading…', className }: LoadingStateProps) {
  return (
    <div
      className={cn(
        'flex h-32 items-center justify-center gap-2 text-sm text-[var(--color-muted-foreground)]',
        className,
      )}
    >
      <Loader2 className="size-4 animate-spin" aria-hidden="true" />
      {label}
    </div>
  );
}

/** Bare spinner icon sized for inline use next to button/label text — pair with your own loading text. */
export function InlineSpinner({ className }: { className?: string }) {
  return <Loader2 className={cn('size-3.5 animate-spin', className)} aria-hidden="true" />;
}
