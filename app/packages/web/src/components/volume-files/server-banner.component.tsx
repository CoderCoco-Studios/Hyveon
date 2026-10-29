import { Button } from '@/components/ui/button.component';

/** Banner text while the game server is running. */
export const SERVER_RUNNING_MESSAGE = 'The server is running. Stop it to change files.';

/** Banner text while the server state could not be confirmed. */
export const SERVER_UNCONFIRMED_MESSAGE = "Couldn't confirm the server is stopped.";

/** Disabled-reason title while the first server-status load is in flight (no banner is shown). */
export const SERVER_CHECKING_MESSAGE = 'Checking whether the server is stopped…';

/** Props for {@link ServerBanner}. */
export interface ServerBannerProps {
  block: 'running' | 'unconfirmed';
  onRetry(): void;
}

/** Explains why file changes are disabled; the unconfirmed state also offers Retry. */
export function ServerBanner({ block, onRetry }: ServerBannerProps) {
  return (
    <div role="status" className="flex items-center justify-between gap-3 rounded-[var(--radius-sm)] border border-[var(--color-amber)]/40 bg-[var(--color-amber)]/10 px-3 py-2 text-sm">
      <span>{block === 'running' ? SERVER_RUNNING_MESSAGE : SERVER_UNCONFIRMED_MESSAGE}</span>
      {block === 'unconfirmed' && (
        <Button size="sm" variant="outline" onClick={onRetry}>
          Retry
        </Button>
      )}
    </div>
  );
}
