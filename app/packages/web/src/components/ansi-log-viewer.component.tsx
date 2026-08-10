import { useEffect, useRef, useState } from 'react';
import { cn } from '../lib/utils.utils.js';
import { parseAnsiLine, type AnsiSegment } from '../lib/ansi.utils.js';

export { parseAnsiLine, type AnsiSegment };

/** A single line of output from a streamed Pulumi plan/apply/destroy run. Mirrors `IacRunChunk`. */
export interface AnsiLogChunk {
  stream: 'stdout' | 'stderr';
  line: string;
}

/** Props for {@link AnsiLogViewer}. */
export interface AnsiLogViewerProps {
  /** Ordered log chunks to render — appending to this array renders new lines below the existing ones. */
  chunks: AnsiLogChunk[];
  className?: string;
  /** Message shown in place of the log box while `chunks` is empty. */
  emptyMessage?: string;
}

/** Scroll distance (px) from the bottom within which the viewer still counts as "pinned to bottom". */
const BOTTOM_PIN_THRESHOLD_PX = 24;

/**
 * Renders streamed Pulumi output chunks as ANSI-colored HTML, in order,
 * inside a scrollable box.
 *
 * Auto-scrolls to the bottom as new chunks arrive. Scrolling away from the
 * bottom pauses auto-scroll until the user scrolls back down themselves —
 * genuine scroll-position detection (distinct from `LogsPage`'s explicit
 * Pause/Resume toggle), matching how a terminal typically behaves: stick to
 * the bottom unless the operator has manually scrolled up to read something.
 */
export function AnsiLogViewer({ chunks, className, emptyMessage = 'Waiting for output…' }: AnsiLogViewerProps) {
  const boxRef = useRef<HTMLDivElement>(null);
  const [pinnedToBottom, setPinnedToBottom] = useState(true);

  useEffect(() => {
    const el = boxRef.current;
    if (pinnedToBottom && el) {
      el.scrollTop = el.scrollHeight;
    }
  }, [chunks, pinnedToBottom]);

  function handleScroll() {
    const el = boxRef.current;
    if (!el) return;
    const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    setPinnedToBottom(distanceFromBottom <= BOTTOM_PIN_THRESHOLD_PX);
  }

  return (
    <div
      ref={boxRef}
      onScroll={handleScroll}
      data-testid="ansi-log-viewer"
      className={cn(
        'min-h-[200px] max-h-[480px] overflow-y-auto rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--color-bg)] p-3 font-[var(--font-mono)] text-xs leading-6 text-[var(--color-muted-foreground)]',
        className,
      )}
    >
      {chunks.length === 0 ? (
        <div className="text-[var(--color-muted-foreground)]">{emptyMessage}</div>
      ) : (
        chunks.map((chunk, i) => (
          <div key={i} className="whitespace-pre-wrap break-all">
            {parseAnsiLine(chunk.line).map((seg, j) => (
              <span key={j} className={cn(seg.colorClass, seg.bold && 'font-bold')}>
                {seg.text}
              </span>
            ))}
          </div>
        ))
      )}
    </div>
  );
}
