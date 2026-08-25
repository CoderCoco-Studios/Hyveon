import type { ReactNode } from 'react';
import { Pause, Play, Search } from 'lucide-react';
import { ErrorBanner } from './error-banner.component.js';
import { Button } from './ui/button.component.js';
import { Input } from './ui/input.component.js';
import { LogLineList } from './log-line-display.component.js';
import { JumpToLatestButton } from './jump-to-latest-button.component.js';
import { PageHeader } from './page-header.component.js';
import { LiveBadge } from './live-badge.component.js';
import { cn } from '../lib/utils.utils.js';
import { PollingIndicator } from '../polling/polling-indicator.component.js';
import type { UseLogTailResult } from '../hooks/use-log-tail.hook.js';

/** Props for {@link LogTailView}. */
export interface LogTailViewProps {
  /** Page title, rendered by {@link PageHeader}'s `<h2>` — its accessible name is pinned by e2e page objects, keep it exact. */
  title: string;
  /** Optional one-line description shown under the title. */
  subtitle?: string;
  /** `LogLineList`'s empty-buffer message — vary per caller (e.g. "Select a game to start tailing."). */
  emptyMessage: string;
  /** The `useLogTail` result driving this viewer. */
  tail: UseLogTailResult;
  /** Combined error to show in the banner — callers merge their own errors (e.g. a failed games-list fetch) with `tail.error` before passing this. */
  error: string | null;
  /** Extra content rendered above the controls row — e.g. `InfrastructureLogsPage`'s function picker. */
  beforeControls?: ReactNode;
  /** Extra content rendered as the first item in the controls row, before the search input — e.g. `LogsPage`'s game combobox and mobile "Filters" toggle button. */
  beforeSearch?: ReactNode;
  /**
   * When `true`, the search input and autoscroll toggle render twice: once
   * desktop-only (`hidden md:contents`) inline in the controls row, and
   * once in a collapsible mobile drawer shown while `filtersOpen` is `true`.
   * When `false` (the default), they render once, always visible, inline in
   * the controls row — `InfrastructureLogsPage`'s fixed 5-option picker
   * never needs to collapse for space.
   */
  mobileFilters?: boolean;
  /** Whether the mobile filter drawer is open. Only meaningful when `mobileFilters` is `true`; the caller owns this state (e.g. via a toggle button passed as `beforeSearch`). */
  filtersOpen?: boolean;
}

/** Search input paired with its leading icon — the one piece of the controls row duplicated (desktop inline vs. mobile drawer) when `mobileFilters` is set. */
function SearchInput({
  search,
  setSearch,
  full,
}: {
  search: string;
  setSearch: (value: string) => void;
  full: boolean;
}) {
  return (
    <div className={cn('relative', full ? 'w-full' : 'flex-1 min-w-[200px]')}>
      <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 opacity-50" />
      <Input
        type="search"
        value={search}
        onChange={(e) => setSearch(e.target.value)}
        placeholder="Search visible buffer…"
        className={cn('pl-8', full && 'w-full')}
      />
    </div>
  );
}

/** Autoscroll checkbox, wrapped in a `<label>` reading "Autoscroll" — identical in every rendering position. */
function AutoscrollToggle({
  autoscroll,
  setAutoscroll,
}: {
  autoscroll: boolean;
  setAutoscroll: (value: boolean) => void;
}) {
  return (
    <label className="flex items-center gap-2 rounded-[var(--radius-sm)] border border-[var(--color-border)] bg-[var(--color-surface-2)] px-3 py-1.5 text-sm text-[var(--color-foreground)]">
      <input
        type="checkbox"
        checked={autoscroll}
        onChange={(e) => setAutoscroll(e.target.checked)}
        className="h-3.5 w-3.5 accent-[var(--color-primary)]"
      />
      Autoscroll
    </label>
  );
}

/**
 * Shared page shell for `/logs` (`LogsPage`) and `/logs/infrastructure`
 * (`InfrastructureLogsPage`) — the header, controls row (search, autoscroll,
 * Pause/Resume), error banner, log-stream block, and footer counts that were
 * previously byte-for-byte identical between the two pages. Each page still
 * owns its own game/function selection UI and passes it in via
 * `beforeControls`/`beforeSearch`; `LogsPage` additionally opts into the
 * mobile filter drawer via `mobileFilters`/`filtersOpen`.
 */
export function LogTailView({
  title,
  subtitle,
  emptyMessage,
  tail,
  error,
  beforeControls,
  beforeSearch,
  mobileFilters = false,
  filtersOpen = false,
}: LogTailViewProps) {
  const {
    lines,
    paused,
    autoscroll,
    setAutoscroll,
    search,
    setSearch,
    bufferedCount,
    ageLabel,
    boxRef,
    handlePauseToggle,
    handleScroll,
    atOldest,
    loadingOlder,
    hasNewer,
    jumpToLatest,
  } = tail;

  const pauseResumeButton = (
    <Button variant={paused ? 'default' : 'secondary'} size="sm" onClick={handlePauseToggle} className="ml-auto">
      {paused ? <Play className="h-3.5 w-3.5" /> : <Pause className="h-3.5 w-3.5" />}
      {paused ? 'Resume' : 'Pause'}
    </Button>
  );

  return (
    <div className="mx-auto flex h-full max-w-6xl flex-col gap-4">
      <PageHeader title={title} subtitle={subtitle}>
        <div className="flex items-center gap-3">
          <PollingIndicator />
          <LiveBadge paused={paused} />
        </div>
      </PageHeader>

      {beforeControls}

      {mobileFilters ? (
        <div className="space-y-2">
          <div className="flex flex-wrap items-center gap-2 rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--color-surface)] p-3">
            {beforeSearch}
            {/* Desktop: inline filter controls — hidden on mobile (hidden md:contents) */}
            <div className="hidden md:contents">
              <SearchInput search={search} setSearch={setSearch} full={false} />
              <AutoscrollToggle autoscroll={autoscroll} setAutoscroll={setAutoscroll} />
            </div>
            {pauseResumeButton}
          </div>

          {/* Mobile collapsible filter drawer */}
          {filtersOpen && (
            <div
              id="logs-filters"
              className="md:hidden flex flex-col gap-2 rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--color-surface)] p-3"
            >
              <SearchInput search={search} setSearch={setSearch} full />
              <AutoscrollToggle autoscroll={autoscroll} setAutoscroll={setAutoscroll} />
            </div>
          )}
        </div>
      ) : (
        <div className="flex flex-wrap items-center gap-2 rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--color-surface)] p-3">
          {beforeSearch}
          <SearchInput search={search} setSearch={setSearch} full={false} />
          <AutoscrollToggle autoscroll={autoscroll} setAutoscroll={setAutoscroll} />
          {pauseResumeButton}
        </div>
      )}

      {error && <ErrorBanner>{error}</ErrorBanner>}

      {/* Log stream */}
      <div className="relative flex min-h-[300px] flex-1 flex-col gap-1">
        {loadingOlder && (
          <div data-testid="loading-older" className="py-1 text-center text-xs text-[var(--color-muted-foreground)]">
            Loading older logs…
          </div>
        )}
        {atOldest && (
          <div data-testid="at-oldest-marker" className="py-1 text-center text-xs text-[var(--color-muted-foreground)]">
            — Beginning of log retention —
          </div>
        )}
        <LogLineList
          ref={boxRef}
          onScroll={handleScroll}
          data-testid="logs-viewer"
          className={cn(
            'flex-1 overflow-y-auto rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--color-bg)] p-3 font-[var(--font-mono)] text-xs leading-6 text-[var(--color-muted-foreground)]',
            hasNewer && 'pb-12',
          )}
          lines={lines.map((line) => line.text)}
          search={search}
          emptyMessage={emptyMessage}
        />
        <JumpToLatestButton hasNewer={hasNewer} onClick={jumpToLatest} />
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
