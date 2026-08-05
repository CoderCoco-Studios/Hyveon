import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import { api, type GameStatus, type CostEstimates } from '../api.service.js';
import { usePoller } from './polling-provider.component.js';

/** Name under which the dashboard status poller is registered. */
export const GAME_STATUS_POLLER = 'status';

/**
 * Status poll cadence in milliseconds. Defaults to 20s and can be overridden
 * at build time via `VITE_STATUS_POLL_MS` so deployments that want to reduce
 * AWS API traffic (or testers running offline) can tune it without forking
 * the source.
 */
export const GAME_STATUS_INTERVAL_MS = (() => {
  const raw = import.meta.env?.VITE_STATUS_POLL_MS;
  if (typeof raw === 'string') {
    const parsed = parseInt(raw, 10);
    if (Number.isFinite(parsed) && parsed >= 1000) return parsed;
  }
  return 20_000;
})();

interface GameStatusContextValue {
  statuses: GameStatus[];
  estimates: CostEstimates | null;
  loading: boolean;
  /** Re-fetch every game (used after starts/stops if the caller wants the whole grid). */
  refresh: () => Promise<void>;
  /** Re-fetch a single game's status — used by `GameCard` after Start/Stop. */
  refreshGame: (game: string) => Promise<void>;
}

const GameStatusCtx = createContext<GameStatusContextValue | null>(null);

/**
 * Top-level provider for the dashboard's status + cost-estimate state. Lives
 * above the router so polling continues even when the user navigates to /logs
 * or /settings — that means the LIVE indicator and PollingIndicator stay
 * accurate on every primary route.
 *
 * Internally registers a `status` poller with the shared polling registry so
 * the top-bar Refresh button can trigger it alongside any other active poll.
 *
 * Cost estimates are fetched once on mount rather than on every poll —
 * `/api/costs/estimate` loops over every configured game and calls
 * `EcsService.getTaskDefinition()` per game, so polling it every 20s on every
 * route would add steady ECS API traffic for data that only changes on
 * a Pulumi apply.
 */
export function GameStatusProvider({ children }: { children: ReactNode }) {
  const [statuses, setStatuses] = useState<GameStatus[]>([]);
  const [estimates, setEstimates] = useState<CostEstimates | null>(null);
  const [loading, setLoading] = useState(true);

  const fetchStatuses = useCallback(async () => {
    const s = await api.status();
    setStatuses(s);
    setLoading(false);
  }, []);

  const { refresh } = usePoller(GAME_STATUS_POLLER, fetchStatuses, GAME_STATUS_INTERVAL_MS);

  useEffect(() => {
    void api.costsEstimate().then(setEstimates).catch(() => undefined);
  }, []);

  const refreshGame = useCallback(async (game: string) => {
    const s = await api.statusGame(game);
    setStatuses((prev) => prev.map((x) => (x.game === game ? s : x)));
  }, []);

  const value = useMemo<GameStatusContextValue>(
    () => ({ statuses, estimates, loading, refresh, refreshGame }),
    [statuses, estimates, loading, refresh, refreshGame],
  );

  return <GameStatusCtx.Provider value={value}>{children}</GameStatusCtx.Provider>;
}

/**
 * Read the shared dashboard status state. Drop-in replacement for the previous
 * `useGameStatus` hook — same return shape, but the polling lifecycle now lives
 * in `GameStatusProvider` so multiple routes can subscribe without duplicate
 * fetches.
 */
export function useGameStatus(): GameStatusContextValue {
  const v = useContext(GameStatusCtx);
  if (!v) throw new Error('useGameStatus must be used inside <GameStatusProvider>');
  return v;
}
