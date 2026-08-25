import { cn } from '../lib/utils.utils.js';

/** Props for {@link LiveBadge}. */
export interface LiveBadgeProps {
  /** Whether the tail is currently paused — flips the badge between "Live" and "Paused". */
  paused: boolean;
}

/**
 * Pill that flips between pulsing-cyan "Live" and muted-slate "Paused" —
 * shared between `/logs` (`LogsPage`) and `/logs/infrastructure`
 * (`InfrastructureLogsPage`), which previously each rendered this block
 * inline, byte-for-byte identical.
 *
 * @remarks
 * The rendered text is asserted verbatim (exact match, `Live`/`Paused`) by
 * `e2e/pages/LogsPage.ts`'s `liveBadge()`/`pausedBadge()` locators — keep it exact.
 */
export function LiveBadge({ paused }: LiveBadgeProps) {
  return (
    <div
      className={cn(
        'inline-flex items-center gap-2 rounded-full border px-3 py-1 text-xs font-semibold uppercase tracking-wider',
        paused
          ? 'border-[var(--color-border)] bg-[var(--color-surface-2)] text-[var(--color-muted-foreground)]'
          : 'border-[var(--color-cyan)]/40 bg-[var(--color-cyan)]/10 text-[var(--color-cyan)]',
      )}
    >
      <span
        className={cn(
          'h-2 w-2 rounded-full',
          paused ? 'bg-[var(--color-muted-foreground)]' : 'bg-[var(--color-cyan)] animate-pulse',
        )}
      />
      {paused ? 'Paused' : 'Live'}
    </div>
  );
}
