import { useState } from 'react';
import { Pause, Play, Search } from 'lucide-react';
import type { HyveonLambdaLogsApi, HyveonStreamHandle, LogChunk } from '@hyveon/desktop-preload';
import { LAMBDA_FUNCTION_KEYS, type LambdaFunctionKey } from '@hyveon/shared';
import { Button } from '../components/ui/button.component.js';
import { Input } from '../components/ui/input.component.js';
import { HighlightedLine } from '../components/log-line-display.component.js';
import { cn } from '../lib/utils.utils.js';
import { PollingIndicator } from '../polling/polling-indicator.component.js';
import { useLogTail, type LogTailApi } from '../hooks/use-log-tail.hook.js';

const NO_HYVEON_STREAM_HANDLE: HyveonStreamHandle<LogChunk> = {
  next: () => Promise.resolve({ done: true }),
  cancel: () => {},
  [Symbol.asyncIterator]: () => NO_HYVEON_STREAM_HANDLE,
};

/** Used only when `window.hyveon` is absent (non-Electron context); `useLogTail`'s own guard means neither method here actually runs. */
const NO_HYVEON_LOG_TAIL_API: LogTailApi = {
  get: () => Promise.resolve({ lines: [] }),
  stream: () => NO_HYVEON_STREAM_HANDLE,
};

/**
 * Narrows `window.hyveon.logs.lambda`'s `LambdaFunctionKey`-typed methods
 * down to {@link LogTailApi}'s generic `string`-typed shape. `useLogTail` is
 * shared with the game-logs page and so is written against a plain
 * `target: string`; the cast back to `LambdaFunctionKey` here is safe
 * because this page only ever passes values drawn from
 * {@link LAMBDA_FUNCTION_KEYS} as `target`.
 *
 * @param api - The real `window.hyveon.logs.lambda` bridge.
 * @returns A {@link LogTailApi}-shaped adaptor over `api`.
 */
function toLogTailApi(api: HyveonLambdaLogsApi): LogTailApi {
  return {
    // `useLogTail` always calls `get(target)` with no `limit` — forwarding
    // `limit` unconditionally would pass an explicit `undefined` second
    // argument to `api.get`, which is observably different from omitting
    // it (e.g. to a `toHaveBeenCalledWith('watchdog')` assertion in tests).
    get: (target, limit) =>
      limit === undefined ? api.get(target as LambdaFunctionKey) : api.get(target as LambdaFunctionKey, limit),
    stream: (target) => api.stream(target as LambdaFunctionKey),
  };
}

/**
 * Infrastructure Logs route (`/logs/infrastructure`) — live-tails CloudWatch
 * logs for a picked Lambda function. The tail engine itself is
 * {@link useLogTail} (design.md D6), the same hook `LogsPage` (`/logs`)
 * consumes; this page owns only the fixed 5-option
 * {@link LambdaFunctionKey} picker and `window.hyveon.logs.lambda` wiring.
 */
export function InfrastructureLogsPage() {
  const [selectedFunction, setSelectedFunction] = useState<LambdaFunctionKey>('watchdog');

  const {
    lines,
    paused,
    autoscroll,
    setAutoscroll,
    search,
    setSearch,
    error,
    bufferedCount,
    ageLabel,
    boxRef,
    handlePauseToggle,
    handleScroll,
  } = useLogTail(
    selectedFunction,
    window.hyveon ? toLogTailApi(window.hyveon.logs.lambda) : NO_HYVEON_LOG_TAIL_API,
  );

  return (
    <div className="mx-auto flex h-full max-w-6xl flex-col gap-4">
      {/* Header — title + LIVE/PAUSED badge */}
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-2xl font-semibold text-[var(--color-foreground)]">Infrastructure Logs</h2>
          <p className="text-sm text-[var(--color-muted-foreground)]">
            CloudWatch tail for the selected Lambda function.
          </p>
        </div>
        <div className="flex items-center gap-3">
          <PollingIndicator />
          <LiveBadge paused={paused} />
        </div>
      </div>

      {/* Function picker — fixed 5-option set, never needs to collapse for space */}
      <div className="flex flex-wrap gap-2">
        {LAMBDA_FUNCTION_KEYS.map((fn) => (
          <Button
            key={fn}
            variant={selectedFunction === fn ? 'default' : 'secondary'}
            size="sm"
            onClick={() => setSelectedFunction(fn)}
            aria-pressed={selectedFunction === fn}
          >
            {fn}
          </Button>
        ))}
      </div>

      {/* Controls row */}
      <div className="flex flex-wrap items-center gap-2 rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--color-surface)] p-3">
        <div className="relative flex-1 min-w-[200px]">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 opacity-50" />
          <Input
            type="search"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search visible buffer…"
            className="pl-8"
          />
        </div>
        <label className="flex items-center gap-2 rounded-[var(--radius-sm)] border border-[var(--color-border)] bg-[var(--color-surface-2)] px-3 py-1.5 text-sm text-[var(--color-foreground)]">
          <input
            type="checkbox"
            checked={autoscroll}
            onChange={(e) => setAutoscroll(e.target.checked)}
            className="h-3.5 w-3.5 accent-[var(--color-primary)]"
          />
          Autoscroll
        </label>

        {/* Pause/Resume — always visible, pushed to the right */}
        <Button
          variant={paused ? 'default' : 'secondary'}
          size="sm"
          onClick={handlePauseToggle}
          className="ml-auto"
        >
          {paused ? <Play className="h-3.5 w-3.5" /> : <Pause className="h-3.5 w-3.5" />}
          {paused ? 'Resume' : 'Pause'}
        </Button>
      </div>

      {error && (
        <div className="rounded-[var(--radius-sm)] border border-[var(--color-red)]/40 bg-[var(--color-red)]/10 px-3 py-2 text-sm text-[var(--color-red)]">
          {error}
        </div>
      )}

      {/* Log stream */}
      <div
        ref={boxRef}
        onScroll={handleScroll}
        data-testid="logs-viewer"
        className="min-h-[300px] flex-1 overflow-y-auto rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--color-bg)] p-3 font-[var(--font-mono)] text-xs leading-6 text-[var(--color-muted-foreground)]"
      >
        {lines.length === 0 ? (
          <div className="text-[var(--color-muted-foreground)]">Waiting for log lines…</div>
        ) : (
          lines.map((line, i) => (
            <div key={i} className="flex gap-2 whitespace-pre-wrap break-all">
              <span className="flex-1">
                <HighlightedLine text={line.text} query={search} />
              </span>
            </div>
          ))
        )}
      </div>

      {/* Footer */}
      <div className="flex items-center justify-between text-xs text-[var(--color-muted-foreground)]">
        <span>
          {lines.length} line{lines.length === 1 ? '' : 's'}
          {ageLabel ? ` · oldest ${ageLabel}` : ''}
        </span>
        <span className="font-[var(--font-mono)]">
          {paused && bufferedCount > 0 ? `buffered ${bufferedCount}` : ''}
        </span>
      </div>
    </div>
  );
}

/** Pill that flips between pulsing-cyan LIVE and muted-slate PAUSED. */
function LiveBadge({ paused }: { paused: boolean }) {
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
