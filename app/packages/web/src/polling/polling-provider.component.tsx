import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { useNowTick } from '../hooks/use-now-tick.hook.js';

/**
 * Per-poller state exposed through {@link PollingStateContext}. Times are
 * absolute ms epoch (`Date.now()`) so consumers can render "X seconds ago"
 * without juggling different clocks.
 */
export interface PollerState {
  intervalMs: number;
  /**
   * Timestamp of the very first attempt this poller made. Set once and never
   * reset — the never-succeeded staleness check needs a stable reference
   * point, since `lastAttemptAt` advances on every retry.
   */
  firstAttemptAt: number | null;
  lastSuccessAt: number | null;
  lastAttemptAt: number | null;
  loading: boolean;
  error: Error | null;
}

/**
 * Stable-identity slice of the polling registry. Held in a separate context
 * from the changing state so consumers that only need to register / refresh
 * don't re-render every heartbeat tick. `register` / `refresh` / `refreshAll`
 * are all wrapped in `useCallback` with a stable `runOne` dependency.
 */
interface PollingActionsContextValue {
  register: (name: string, fn: () => Promise<void>, intervalMs: number) => () => void;
  refresh: (name: string) => Promise<void>;
  refreshAll: () => Promise<void>;
}

/**
 * Live state slice. Re-renders subscribers whenever any poller's status
 * changes or the 1Hz heartbeat fires. Reserved for components that actually
 * render relative timestamps (the indicator, the LIVE badge); never read
 * from `usePoller`, which only needs the stable actions.
 */
interface PollingStateContextValue {
  pollers: Record<string, PollerState>;
  /**
   * `Date.now()` as of the last 1Hz heartbeat. Consumers rendering relative
   * timestamps read this instead of calling `Date.now()` themselves: the
   * heartbeat already re-renders them once a second, and a value passed down
   * through context keeps render pure (`react-hooks/purity` rejects clock
   * reads during render, since they make the same render return different
   * output on every call).
   */
  now: number;
}

const ActionsCtx = createContext<PollingActionsContextValue | null>(null);
const StateCtx = createContext<PollingStateContextValue | null>(null);

/** A poller is considered stale once it has missed two intervals without success. */
export const STALE_MULTIPLIER = 2;

/**
 * Provides a registry of named pollers so any route can subscribe to the same
 * polling state. Keeps timers in a ref keyed by name; `pollers` is React state
 * so the indicator and LIVE badge re-render on every result.
 *
 * Designed to live near the top of the tree (above the router) so polling
 * persists across route changes. Internally splits its value across two
 * contexts — stable actions vs. tick-driven state — so registering a poller
 * doesn't subscribe the caller to per-second re-renders.
 */
export function PollingProvider({ children }: { children: ReactNode }) {
  const [pollers, setPollers] = useState<Record<string, PollerState>>({});
  const fnsRef = useRef<
    Record<
      string,
      {
        fn: () => Promise<void>;
        intervalMs: number;
        timerId: ReturnType<typeof setInterval>;
        /** True while a fetch is in flight; guards against concurrent runs of the same poller. */
        inFlight: boolean;
        /**
         * Stable identifier set once per `register()` call and never touched by
         * `runOne()`. Used by the cleanup closure instead of `timerId` so the
         * cleanup remains correct even after `runOne` replaces the initial timer
         * with a rescheduled one before `register()` returns.
         */
        regId: symbol;
      }
    >
  >({});

  /**
   * Run a single poller by name and write the result back into state.
   * Skips silently if a previous call is still in flight — that prevents a
   * slow response + manual Refresh + auto-tick from stacking concurrent
   * fetches. Also resets the poller's interval timer so the next automatic
   * poll lands `intervalMs` after this attempt (whether triggered by the
   * timer or by a manual `refresh()` / `refreshAll()`), keeping the
   * indicator's "next refresh in X" tooltip accurate.
   *
   * Swallows errors into the per-poller `error` field so a thrown poller
   * doesn't crash the rest of the app.
   */
  const runOne = useCallback(async (name: string) => {
    const entry = fnsRef.current[name];
    if (!entry || entry.inFlight) return;
    entry.inFlight = true;
    clearInterval(entry.timerId);
    entry.timerId = setInterval(() => void runOne(name), entry.intervalMs);
    setPollers((p) => {
      const prev = p[name];
      if (!prev) return p;
      const now = Date.now();
      return {
        ...p,
        [name]: {
          ...prev,
          loading: true,
          lastAttemptAt: now,
          firstAttemptAt: prev.firstAttemptAt ?? now,
        },
      };
    });
    try {
      await entry.fn();
      setPollers((p) => {
        const prev = p[name];
        if (!prev) return p;
        return { ...p, [name]: { ...prev, loading: false, lastSuccessAt: Date.now(), error: null } };
      });
    } catch (err) {
      setPollers((p) => {
        const prev = p[name];
        if (!prev) return p;
        return { ...p, [name]: { ...prev, loading: false, error: err as Error } };
      });
    } finally {
      const cur = fnsRef.current[name];
      if (cur) cur.inFlight = false;
    }
  }, []);

  const register = useCallback(
    (name: string, fn: () => Promise<void>, intervalMs: number): (() => void) => {
      // Replace any prior registration under the same name (component remount or
      // interval change). Clear the old timer so we don't double-fire.
      const previous = fnsRef.current[name];
      if (previous) clearInterval(previous.timerId);

      // `regId` is set once here and never touched by `runOne()`. The cleanup
      // closure captures it so it can distinguish "I own this registration" from
      // "a newer call to register() has already taken over" — even after
      // `runOne()` replaces the initial `timerId` with a rescheduled one before
      // this call returns.
      const regId = Symbol();
      const timerId = setInterval(() => void runOne(name), intervalMs);
      fnsRef.current[name] = { fn, intervalMs, timerId, inFlight: false, regId };

      setPollers((p) => ({
        ...p,
        [name]: {
          intervalMs,
          firstAttemptAt: p[name]?.firstAttemptAt ?? null,
          lastSuccessAt: p[name]?.lastSuccessAt ?? null,
          lastAttemptAt: p[name]?.lastAttemptAt ?? null,
          loading: false,
          error: null,
        },
      }));

      void runOne(name);

      return () => {
        const cur = fnsRef.current[name];
        if (cur && cur.regId === regId) {
          clearInterval(cur.timerId);
          delete fnsRef.current[name];
          setPollers((p) => {
            if (!(name in p)) return p;
            const next = { ...p };
            delete next[name];
            return next;
          });
        }
      };
    },
    [runOne],
  );

  const refresh = useCallback(
    async (name: string) => {
      await runOne(name);
    },
    [runOne],
  );

  const refreshAll = useCallback(async () => {
    await Promise.all(Object.keys(fnsRef.current).map((n) => runOne(n)));
  }, [runOne]);

  // Heartbeat: forces re-render every second so "Updated 3s ago" labels and
  // the stale check stay current without each consumer running its own timer.
  // It carries the current wall-clock time rather than a bare counter so
  // consumers can read `now` from context instead of calling `Date.now()`
  // during their own render.
  const now = useNowTick(1000);

  // Clean up all timers on unmount (e.g. HMR or navigation away from the SPA root).
  useEffect(
    () => () => {
      for (const entry of Object.values(fnsRef.current)) {
        clearInterval(entry.timerId);
      }
      fnsRef.current = {};
    },
    [],
  );

  const actions = useMemo<PollingActionsContextValue>(
    () => ({ register, refresh, refreshAll }),
    [register, refresh, refreshAll],
  );
  const state = useMemo<PollingStateContextValue>(
    () => ({ pollers, now }),
    [pollers, now],
  );

  return (
    <ActionsCtx.Provider value={actions}>
      <StateCtx.Provider value={state}>{children}</StateCtx.Provider>
    </ActionsCtx.Provider>
  );
}

/**
 * Read the stable polling actions (register / refresh / refreshAll). Does not
 * subscribe to per-second tick updates, so it's safe to call from providers
 * that sit above the router without cascading re-renders.
 */
export function usePollingActions(): PollingActionsContextValue {
  const v = useContext(ActionsCtx);
  if (!v) throw new Error('usePollingActions must be used inside <PollingProvider>');
  return v;
}

/**
 * Read the live polling state slice (`pollers` + `tick`). Re-renders the
 * caller every second; only use it from indicators / badges that actually
 * render relative timestamps.
 */
export function usePollingState(): PollingStateContextValue {
  const v = useContext(StateCtx);
  if (!v) throw new Error('usePollingState must be used inside <PollingProvider>');
  return v;
}

/**
 * Subscribe a function to the shared polling registry. Only subscribes to the
 * actions context — registering or refreshing a poller does **not** trigger
 * per-second re-renders. The latest `fn` is captured via a ref so consumers
 * can pass closures without thrashing the registration. Re-registers when
 * `name` or `intervalMs` change.
 */
export function usePoller(
  name: string,
  fn: () => Promise<void>,
  intervalMs: number,
  enabled = true,
): { refresh: () => Promise<void> } {
  const { register, refresh: refreshCtx } = usePollingActions();
  const fnRef = useRef(fn);

  // Keep the ref pointing at the latest `fn` without writing to it during
  // render (`react-hooks/refs`): a render-phase mutation is visible to any
  // concurrent render that React later discards, so the ref can end up
  // holding a callback from a render that never committed. Assigning in an
  // unconditional effect runs after commit instead. Nothing reads
  // `fnRef.current` synchronously during render — `register` only invokes it
  // from an interval — so the one-commit delay is unobservable.
  useEffect(() => {
    fnRef.current = fn;
  });

  useEffect(() => {
    if (!enabled) return;
    return register(name, () => fnRef.current(), intervalMs);
  }, [register, name, intervalMs, enabled]);

  const refresh = useCallback(() => refreshCtx(name), [refreshCtx, name]);

  return { refresh };
}

/** True iff `state` has gone longer than `STALE_MULTIPLIER × intervalMs` without a successful poll. */
export function isStale(state: PollerState | undefined, now: number = Date.now()): boolean {
  if (!state) return false;
  if (state.lastSuccessAt === null) {
    // Never succeeded — measure staleness from the FIRST attempt, not the
    // most recent retry. Otherwise a poller that fails every interval would
    // keep its `lastAttemptAt` recent and never flip to stale, which would
    // hide a totally-down API from the LIVE indicator on first load.
    if (state.firstAttemptAt === null) return false;
    return now - state.firstAttemptAt > STALE_MULTIPLIER * state.intervalMs;
  }
  return now - state.lastSuccessAt > STALE_MULTIPLIER * state.intervalMs;
}
