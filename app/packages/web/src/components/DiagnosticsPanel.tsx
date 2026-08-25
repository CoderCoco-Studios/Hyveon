import { useEffect, useRef, useState } from 'react';
import { Pause, Play, Search } from 'lucide-react';
import { ErrorBanner } from './error-banner.component.js';
import { ExportBundleButton } from './export-bundle-button.component.js';
import { Button } from './ui/button.component.js';
import { Input } from './ui/input.component.js';
import { LogLineList } from './log-line-display.component.js';
import { useDiagnosticsTail } from '../hooks/use-diagnostics-tail.hook.js';

/**
 * DiagnosticsPanel — shows the last 500 lines of the app's own local log
 * file (`main-*.log`), polling every 5 seconds via {@link useDiagnosticsTail}.
 * Brings the same interaction affordances the `/logs` page already has for
 * CloudWatch output: pause/resume, search-highlight, and autoscroll. The
 * "Export diagnostics bundle" action is owned by {@link ExportBundleButton}.
 */
export function DiagnosticsPanel() {
  const { lines, logPath, loading, error, paused, togglePause } = useDiagnosticsTail();
  const [search, setSearch] = useState('');
  const scrollRef = useRef<HTMLDivElement>(null);

  // Autoscroll to the bottom whenever lines change — but only while not paused, so a paused view
  // never gets scrolled out from under an operator reading it (lines don't change while paused
  // anyway, but the `paused` guard keeps the intent explicit rather than relying on that side effect).
  useEffect(() => {
    if (!paused && scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [lines, paused]);

  if (loading) {
    return (
      <div
        className="flex items-center justify-center rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--color-surface)] p-6 text-sm text-[var(--color-muted-foreground)]"
        aria-busy="true"
      >
        Loading diagnostics…
      </div>
    );
  }

  if (error) {
    return (
      <ErrorBanner>{error}</ErrorBanner>
    );
  }

  return (
    <div className="flex flex-col gap-2">
      {logPath && (
        <p className="text-xs text-[var(--color-muted-foreground)]">
          Log file: <span className="font-[var(--font-mono)]">{logPath}</span>
        </p>
      )}

      <div className="flex flex-wrap items-center gap-2 rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--color-surface)] p-3">
        <div className="relative flex-1 min-w-[200px]">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 opacity-50" />
          <Input
            type="search"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search visible lines…"
            className="pl-8"
          />
        </div>
        <Button variant={paused ? 'default' : 'secondary'} size="sm" onClick={togglePause} className="ml-auto">
          {paused ? <Play className="h-3.5 w-3.5" /> : <Pause className="h-3.5 w-3.5" />}
          {paused ? 'Resume' : 'Pause'}
        </Button>
      </div>

      <ExportBundleButton />

      <LogLineList
        ref={scrollRef}
        data-testid="diagnostics-log-box"
        className="h-96 overflow-y-auto rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--color-bg)] p-3 font-[var(--font-mono)] text-xs leading-6 text-[var(--color-muted-foreground)]"
        lines={lines}
        search={search}
        emptyMessage="No log lines available."
      />

      <div className="text-xs text-[var(--color-muted-foreground)]">
        {lines.length} line{lines.length === 1 ? '' : 's'}
        {paused ? ' · paused' : ''}
      </div>
    </div>
  );
}
