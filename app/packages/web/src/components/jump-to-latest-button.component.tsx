import { Button } from './ui/button.component.js';

/** Props for {@link JumpToLatestButton}. */
export interface JumpToLatestButtonProps {
  /** Whether the log viewer is currently in historical mode — controls visibility. */
  hasNewer: boolean;
  /** Handler for the click — typically `useLogTail`'s `jumpToLatest`. */
  onClick: () => void;
}

/**
 * Floating "Jump to latest" control shown over a log viewer's scroll
 * container while `useLogTail`'s `mode` is `'historical'` — shared between
 * `/logs` (`LogsPage`) and `/logs/infrastructure` (`InfrastructureLogsPage`),
 * which previously each rendered this block inline, byte-for-byte identical.
 *
 * Renders nothing when `hasNewer` is `false`, so callers can render it
 * unconditionally.
 */
export function JumpToLatestButton({ hasNewer, onClick }: JumpToLatestButtonProps) {
  if (!hasNewer) return null;
  return (
    <Button
      size="sm"
      onClick={onClick}
      className="absolute bottom-3 left-1/2 -translate-x-1/2 shadow-[var(--shadow-md)]"
    >
      Jump to latest
    </Button>
  );
}
