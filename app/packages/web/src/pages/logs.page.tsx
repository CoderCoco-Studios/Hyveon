import { useEffect, useRef, useState } from 'react';
import { useLocation } from 'react-router-dom';
import { Filter, Pause, Play, Search } from 'lucide-react';
import type { HyveonStreamHandle, LogChunk } from '@hyveon/desktop-preload';
import { api } from '../api.service.js';
import { Badge } from '../components/ui/badge.component.js';
import { Button } from '../components/ui/button.component.js';
import { Input } from '../components/ui/input.component.js';
import { HighlightedLine, LevelFilterMenu } from '../components/log-line-display.component.js';
import { GameCombobox } from '../components/game-combobox.component.js';
import { cn } from '../lib/utils.utils.js';
import { PollingIndicator } from '../polling/polling-indicator.component.js';
import { LOG_LEVEL_BADGE } from '../lib/log-level.utils.js';
import { useLogTail, type LogTailApi } from '../hooks/use-log-tail.hook.js';

/** Shape of the react-router navigation state `GameCard` passes via `<Link to="/logs" state={{ game }}>`. */
interface LogsNavState {
  game?: string;
}

/**
 * Reads the `game` field off a react-router `location.state` value, if
 * present and a string. `location.state` is typed `unknown` by react-router,
 * so this narrows it defensively rather than trusting an unchecked cast.
 */
function gameFromLocationState(state: unknown): string | null {
  if (!state || typeof state !== 'object') return null;
  const game = (state as LogsNavState).game;
  return typeof game === 'string' ? game : null;
}

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
 * Logs route (`/logs`) — full-page tailing of CloudWatch logs for a single
 * game. Owns game selection (list load, `GameCombobox`, navigation-state
 * preselection); the fetch/stream/pause/filter/autoscroll engine itself is
 * {@link useLogTail} (design.md D6), shared with `/logs/infrastructure`.
 */
export function LogsPage() {
  const location = useLocation();
  // Captured once on mount — the game named in the incoming navigation state
  // (e.g. a GameCard's "Logs" link), used only to pick the *initial* selected
  // game once the list resolves. Kept in a ref (not a dependency) so later
  // location changes on this same route instance never re-trigger the
  // preselection logic and fight a selection the user has since made.
  const preselectedGameRef = useRef(gameFromLocationState(location.state));
  const [games, setGames] = useState<string[]>([]);
  const [selectedGame, setSelectedGame] = useState<string>('');
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [loadGamesError, setLoadGamesError] = useState<string | null>(null);

  const {
    visibleLines,
    paused,
    autoscroll,
    setAutoscroll,
    search,
    setSearch,
    hiddenLevels,
    toggleLevel,
    error: tailError,
    bufferedCount,
    ageLabel,
    boxRef,
    handlePauseToggle,
    handleScroll,
  } = useLogTail(selectedGame, window.hyveon ? window.hyveon.logs : NO_HYVEON_LOG_TAIL_API);

  // Load the games list once (this page is reachable independently of the dashboard).
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const res = await api.games();
        if (cancelled) return;
        const names = res.games.map((g) => g.name);
        setGames(names);
        if (names.length > 0) {
          const preselected = preselectedGameRef.current;
          const initial = preselected && names.includes(preselected) ? preselected : names[0]!;
          setSelectedGame((cur) => cur || initial);
        }
      } catch {
        if (!cancelled) setLoadGamesError('Could not load games.');
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const error = loadGamesError ?? tailError;

  const toggleLevelHandler = (lvl: Parameters<typeof toggleLevel>[0]) => toggleLevel(lvl);

  return (
    <div className="mx-auto flex h-full max-w-6xl flex-col gap-4">
      {/* Header — title + LIVE/PAUSED badge */}
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-2xl font-semibold text-[var(--color-foreground)]">Server Logs</h2>
          <p className="text-sm text-[var(--color-muted-foreground)]">
            CloudWatch tail for the selected game. Pause to inspect; resume to flush the buffer.
          </p>
        </div>
        <div className="flex items-center gap-3">
          <PollingIndicator />
          <LiveBadge paused={paused} />
        </div>
      </div>

      {/* Controls row */}
      <div className="space-y-2">
        <div className="flex flex-wrap items-center gap-2 rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--color-surface)] p-3">
          {/* Game selector — always visible */}
          <GameCombobox games={games} value={selectedGame} onChange={setSelectedGame} />

          {/* Filter toggle — only on mobile (md:hidden) */}
          <Button
            variant="secondary"
            size="sm"
            className="md:hidden min-h-11"
            onClick={() => setFiltersOpen((o) => !o)}
            aria-expanded={filtersOpen}
          >
            <Filter className="h-3.5 w-3.5" />
            Filters
            {hiddenLevels.size > 0 && (
              <span className="ml-1 text-[var(--color-primary-light)]">({hiddenLevels.size} hidden)</span>
            )}
          </Button>

          {/* Desktop: inline filter controls — hidden on mobile (hidden md:contents) */}
          <div className="hidden md:contents">
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
            <LevelFilterMenu hidden={hiddenLevels} onToggle={toggleLevelHandler} />
            <label className="flex items-center gap-2 rounded-[var(--radius-sm)] border border-[var(--color-border)] bg-[var(--color-surface-2)] px-3 py-1.5 text-sm text-[var(--color-foreground)]">
              <input
                type="checkbox"
                checked={autoscroll}
                onChange={(e) => setAutoscroll(e.target.checked)}
                className="h-3.5 w-3.5 accent-[var(--color-primary)]"
              />
              Autoscroll
            </label>
          </div>

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

        {/* Mobile collapsible filter drawer */}
        {filtersOpen && (
          <div
            id="logs-filters"
            className="md:hidden flex flex-col gap-2 rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--color-surface)] p-3"
          >
            <div className="relative">
              <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 opacity-50" />
              <Input
                type="search"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search visible buffer…"
                className="pl-8 w-full"
              />
            </div>
            <LevelFilterMenu hidden={hiddenLevels} onToggle={toggleLevelHandler} />
            <label className="flex items-center gap-2 rounded-[var(--radius-sm)] border border-[var(--color-border)] bg-[var(--color-surface-2)] px-3 py-1.5 text-sm text-[var(--color-foreground)]">
              <input
                type="checkbox"
                checked={autoscroll}
                onChange={(e) => setAutoscroll(e.target.checked)}
                className="h-3.5 w-3.5 accent-[var(--color-primary)]"
              />
              Autoscroll
            </label>
          </div>
        )}
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
        {visibleLines.length === 0 ? (
          <div className="text-[var(--color-muted-foreground)]">
            {selectedGame ? 'Waiting for log lines…' : 'Select a game to start tailing.'}
          </div>
        ) : (
          visibleLines.map((line, i) => (
            <div key={i} className="flex gap-2 whitespace-pre-wrap break-all">
              {line.level ? (
                <Badge
                  variant={LOG_LEVEL_BADGE[line.level].variant}
                  className="h-4 shrink-0 px-1.5 py-0 text-[10px] leading-4"
                >
                  {LOG_LEVEL_BADGE[line.level].label}
                </Badge>
              ) : (
                <span className="inline-block w-12 shrink-0" aria-hidden />
              )}
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
          {visibleLines.length} line{visibleLines.length === 1 ? '' : 's'}
          {ageLabel ? ` · oldest ${ageLabel}` : ''}
          {hiddenLevels.size > 0 ? ` · ${hiddenLevels.size} level${hiddenLevels.size === 1 ? '' : 's'} hidden` : ''}
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
