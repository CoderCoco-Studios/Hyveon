import { useEffect, useRef, useState } from 'react';
import { useLocation } from 'react-router-dom';
import { Filter } from 'lucide-react';
import { api } from '../api.service.js';
import { Button } from '../components/ui/button.component.js';
import { GameCombobox } from '../components/game-combobox.component.js';
import { LogTailView } from '../components/log-tail-view.component.js';
import { useLogTail, NO_HYVEON_LOG_TAIL_API } from '../hooks/use-log-tail.hook.js';

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

/**
 * Logs route (`/logs`) — full-page tailing of CloudWatch logs for a single
 * game. Owns game selection (list load, `GameCombobox`, navigation-state
 * preselection) and the mobile filter drawer; the fetch/stream/pause/autoscroll
 * engine itself is {@link useLogTail} (design.md D6), and the shared header/
 * controls/log-stream/footer shell is {@link LogTailView}, both shared with
 * `/logs/infrastructure`.
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

  const tail = useLogTail(selectedGame, window.hyveon ? window.hyveon.logs : NO_HYVEON_LOG_TAIL_API);

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

  const error = loadGamesError ?? tail.error;

  return (
    <LogTailView
      title="Server Logs"
      subtitle="CloudWatch tail for the selected game. Pause to inspect; resume to flush the buffer."
      emptyMessage={selectedGame ? 'Waiting for log lines…' : 'Select a game to start tailing.'}
      tail={tail}
      error={error}
      mobileFilters
      filtersOpen={filtersOpen}
      beforeSearch={
        <>
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
          </Button>
        </>
      }
    />
  );
}
