import { useCallback, useEffect, useRef, useState } from 'react';
import type { HyveonStreamHandle, LogChunk, NewerLogsPage, OlderLogsPage } from '@hyveon/desktop-preload';

/**
 * Maximum number of lines kept loaded in the viewport at once, in either
 * `'live'` or `'historical'` mode. In `'live'` mode the oldest line is
 * evicted off the top as new lines arrive; in `'historical'` mode the
 * newest-loaded line is evicted off the bottom as older lines are
 * prepended by {@link UseLogTailResult.handleScroll}'s backfill (and the
 * oldest-loaded line is evicted off the top as newer lines are appended by
 * the forward paging that runs on scroll-down).
 */
const WINDOW_SIZE = 300;
const AGE_TICK_MS = 10_000;
/** Scroll distance (px) from the bottom within which the viewer still counts as "pinned to bottom". */
const BOTTOM_PIN_THRESHOLD_PX = 24;
/** Scroll distance (px) from the top within which a scroll-up is treated as "requesting older logs". */
const NEAR_TOP_THRESHOLD_PX = 50;

/** A single tailed log line, with its receipt timestamp. */
export interface LogLine {
  text: string;
  receivedAt: number;
}

/**
 * The `get`/`stream`/`getOlder`/`getNewer` set a caller wires to either
 * `window.hyveon.logs` (game logs) or `window.hyveon.logs.lambda` (Lambda logs).
 */
export interface LogTailApi {
  /** Recent snapshot fetch — see `GameLogs`/`LambdaLogs`'s `oldestTimestamp` field, used to seed {@link UseLogTailResult.handleScroll}'s first backward call without duplicating lines already in the snapshot. */
  get: (target: string, limit?: number) => Promise<{ lines: string[]; oldestTimestamp?: number }>;
  stream: (target: string) => HyveonStreamHandle<LogChunk>;
  /** Backward page of CloudWatch events strictly older than `beforeTimestamp` — backs {@link UseLogTailResult.handleScroll}'s scroll-up backfill. */
  getOlder: (target: string, beforeTimestamp: number, limit?: number) => Promise<OlderLogsPage>;
  /** Forward page of CloudWatch events strictly newer than `afterTimestamp` — backs the paged scroll-down-while-historical backfill. */
  getNewer: (
    target: string,
    afterTimestamp: number,
    limit?: number,
    excludeEventIds?: string[],
  ) => Promise<NewerLogsPage>;
}

/** The live-tail state and handlers a log-viewer page renders. */
export interface UseLogTailResult {
  lines: LogLine[];
  paused: boolean;
  autoscroll: boolean;
  setAutoscroll: (value: boolean) => void;
  search: string;
  setSearch: (value: string) => void;
  error: string | null;
  bufferedCount: number;
  ageLabel: string | null;
  boxRef: React.RefObject<HTMLDivElement | null>;
  handlePauseToggle: () => void;
  /** Wire to the log viewer container's `onScroll` — pins/unpins autoscroll based on distance from the bottom, and drives the historical-mode backfill/forward-paging flow. */
  handleScroll: () => void;
  /**
   * `'live'` (default) tails new lines straight into {@link lines};
   * `'historical'` means the viewport is showing a backfilled window and
   * live lines are being buffered instead (see {@link bufferedCount}).
   */
  mode: 'live' | 'historical';
  /** `true` once a backward fetch has reported nothing further back exists — render a "Beginning of log retention" marker instead of retrying. */
  atOldest: boolean;
  /** `true` while a backward backfill fetch is in flight — render a loading indicator near the top of the viewport. */
  loadingOlder: boolean;
  /** Equivalent to `mode === 'historical'` — whether a "Jump to latest" control should be shown. */
  hasNewer: boolean;
  /** `true` while {@link jumpToLatest}'s fresh re-fetch is in flight. */
  jumpingToLatest: boolean;
  /**
   * Discards everything currently loaded/buffered and re-fetches a fresh
   * recent snapshot via `api.get`, the same call the initial-mount effect
   * makes — then switches back to `'live'` mode with autoscroll re-enabled.
   * Deliberately does NOT flush buffered live lines into view; they are
   * discarded along with the rest of the historical window.
   */
  jumpToLatest: () => void;
}

/** Format a millisecond age as a compact "Xs ago" / "Xm ago" / "Xh ago" string. */
function formatAge(ms: number): string {
  if (ms < 1000) return 'just now';
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  return `${h}h ago`;
}

/**
 * Shared live-tail engine behind both `/logs` (game servers) and
 * `/logs/infrastructure` (Lambda functions) — see design.md D6. Owns the
 * initial-snapshot fetch and live IPC stream subscription for a single
 * `target`, the pause/buffer/resume model, the in-buffer search string,
 * autoscroll (including turning it off when the
 * caller scrolls away from the bottom and back on when they scroll back
 * near it — see {@link UseLogTailResult.handleScroll}), the "oldest line
 * age" footer clock, and the windowed `'live'`/`'historical'` viewport that
 * backs "load older logs on scroll-up": scrolling near the top of the
 * viewer switches into `'historical'` mode, backfills older CloudWatch
 * events via `api.getOlder`, and buffers (rather than drops) incoming live
 * lines until the caller calls {@link UseLogTailResult.jumpToLatest} — see
 * that field and {@link UseLogTailResult.handleScroll} for the full flow.
 * Fully resets and re-subscribes whenever `target` changes — callers do not
 * reset state themselves before switching targets.
 *
 * @param target - The game name or `LambdaFunctionKey` to tail. An empty
 *   string means "nothing selected yet" — no fetch/stream starts.
 * @param api - The `get`/`stream`/`getOlder`/`getNewer` set to call. Pass a
 *   stable reference (e.g. `window.hyveon.logs` or
 *   `window.hyveon.logs.lambda`) — an internal ref means a new object
 *   identity each render is tolerated, but a stable reference keeps the
 *   intent obvious.
 * @returns The live-tail state and handlers a log-viewer page renders.
 */
export function useLogTail(target: string, api: LogTailApi): UseLogTailResult {
  // Latest `api` used inside effect/callback closures below. Synced in an
  // effect rather than assigned during render: a render-phase ref write is
  // visible to renders React may discard (`react-hooks/refs`), mirroring
  // `useFileManager`'s `gameRef` sync. Declared before the effects that read
  // it so it is up to date before they run on the same commit.
  const apiRef = useRef(api);
  useEffect(() => {
    apiRef.current = api;
  });

  const [lines, setLines] = useState<LogLine[]>([]);
  const [paused, setPaused] = useState(false);
  const [autoscroll, setAutoscroll] = useState(true);
  const [search, setSearch] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [bufferedCount, setBufferedCount] = useState(0);
  const [mode, setMode] = useState<'live' | 'historical'>('live');
  const [atOldest, setAtOldest] = useState(false);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [jumpingToLatest, setJumpingToLatest] = useState(false);

  const boxRef = useRef<HTMLDivElement>(null);
  const streamRef = useRef<HyveonStreamHandle<LogChunk> | null>(null);
  const pausedRef = useRef(false);
  const bufferRef = useRef<LogLine[]>([]);
  // Tracks whether the user has scrolled away from the bottom since autoscroll
  // was last on, so handleScroll only re-enables it on a genuine return-to-bottom
  // rather than re-flipping a manual off while already parked near the bottom.
  const scrolledAwayRef = useRef(false);
  // Synchronously-readable mirror of `mode` — `handleScroll`/`appendLine` run
  // outside React's render cycle and need the current mode immediately, not
  // after the next render commits.
  const modeRef = useRef<'live' | 'historical'>('live');
  const atOldestRef = useRef(false);
  const loadingOlderRef = useRef(false);
  const loadingNewerRef = useRef(false);
  /** Epoch-ms boundary for the next backward `getOlder` call — the oldest event timestamp seen so far in the historical window. */
  const oldestTimestampRef = useRef<number | null>(null);
  /** Epoch-ms boundary for the next forward `getNewer` call — the newest event timestamp seen so far in the historical window. */
  const newestTimestampRef = useRef<number | null>(null);
  /** `eventId`s already delivered at {@link newestTimestampRef}'s exact timestamp — passed as `getNewer`'s `excludeEventIds` so its inclusive `afterTimestamp` bound doesn't re-deliver them. */
  const newestEventIdsRef = useRef<string[]>([]);
  /**
   * Monotonically-increasing counter bumped on every target switch and on
   * {@link jumpToLatest} — `loadOlder`/`loadNewer` capture it at the start
   * of their async call and discard the result (no `setLines`/`setError`/ref
   * update) if it has moved on by the time the call resolves, closing the
   * race where a slow historical fetch resolves after the viewer already
   * switched targets or jumped back to live.
   */
  const windowGenerationRef = useRef(0);

  const appendLine = useCallback((text: string) => {
    const entry: LogLine = { text, receivedAt: Date.now() };
    if (pausedRef.current || modeRef.current === 'historical') {
      bufferRef.current.push(entry);
      if (bufferRef.current.length > WINDOW_SIZE) {
        bufferRef.current.splice(0, bufferRef.current.length - WINDOW_SIZE);
      }
      setBufferedCount(bufferRef.current.length);
      return;
    }
    setLines((prev) => {
      const next = [...prev, entry];
      return next.length > WINDOW_SIZE ? next.slice(-WINDOW_SIZE) : next;
    });
  }, []);

  const stopStream = useCallback(() => {
    streamRef.current?.cancel();
    streamRef.current = null;
  }, []);

  const startStream = useCallback(
    (t: string) => {
      if (!window.hyveon) {
        setError('IPC bridge (window.hyveon) is not available in this context.');
        return;
      }
      stopStream();
      const handle = apiRef.current.stream(t);
      streamRef.current = handle;

      void (async () => {
        try {
          for await (const chunk of handle) {
            appendLine(chunk);
          }
        } catch (err: unknown) {
          if (streamRef.current !== handle) return;
          const message = err instanceof Error ? err.message : String(err);
          setError(`Stream ended with error: ${message}`);
        }
      })();
    },
    [stopStream, appendLine],
  );

  /** Resets every piece of state a target switch or {@link jumpToLatest} needs to clear. */
  const resetWindowState = useCallback(() => {
    modeRef.current = 'live';
    setMode('live');
    atOldestRef.current = false;
    setAtOldest(false);
    loadingOlderRef.current = false;
    setLoadingOlder(false);
    loadingNewerRef.current = false;
    oldestTimestampRef.current = null;
    newestTimestampRef.current = null;
    newestEventIdsRef.current = [];
  }, []);

  // Reset everything that described the previous target, then fetch the
  // new target's snapshot and (re)subscribe. Runs on mount and on every
  // `target` change — callers only change `target`, they don't reset
  // state first (that responsibility moved here from `LogsPage.selectGame`).
  useEffect(() => {
    let cancelled = false;
    windowGenerationRef.current += 1;
    void (async () => {
      setLines([]);
      bufferRef.current = [];
      setBufferedCount(0);
      pausedRef.current = false;
      setPaused(false);
      setError(null);
      resetWindowState();

      if (!target) return;

      if (!window.hyveon) {
        if (!cancelled) setError('IPC bridge (window.hyveon) is not available in this context.');
        return;
      }
      try {
        const data = await apiRef.current.get(target);
        if (cancelled) return;
        setLines(data.lines.slice(-WINDOW_SIZE).map((text) => ({ text, receivedAt: Date.now() })));
        oldestTimestampRef.current = data.oldestTimestamp ?? null;
        startStream(target);
      } catch {
        if (!cancelled) {
          setError('Could not load initial logs; trying live stream.');
          startStream(target);
        }
      }
    })();

    return () => {
      cancelled = true;
      stopStream();
    };
  }, [target, startStream, stopStream, resetWindowState]);

  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), AGE_TICK_MS);
    return () => clearInterval(id);
  }, []);

  useEffect(() => {
    if (autoscroll && !paused && mode === 'live' && boxRef.current) {
      boxRef.current.scrollTop = boxRef.current.scrollHeight;
    }
  }, [lines, autoscroll, paused, mode]);

  const oldest = lines[0];
  const ageLabel = oldest ? formatAge(now - oldest.receivedAt) : null;

  /**
   * Fetches one older page via `api.getOlder`, entering `'historical'` mode
   * first if this is the first backward fetch for the current target. The
   * boundary passed to `getOlder` is {@link oldestTimestampRef} — seeded
   * from the initial snapshot's oldest line on mount/target-switch (falling
   * back to `Date.now()` only when the snapshot carried no timestamp, e.g.
   * an empty log) — each returned page's `oldestTimestamp` becomes the
   * boundary for the next call. An empty page (`atOldest: true`) stops
   * further backward calls until the target changes or
   * {@link jumpToLatest} resets the window. Discards its result if
   * {@link windowGenerationRef} moved on while the call was in flight (a
   * target switch or `jumpToLatest` happened mid-fetch).
   */
  const loadOlder = useCallback(async () => {
    if (!target || loadingOlderRef.current || atOldestRef.current) return;
    const generation = windowGenerationRef.current;
    loadingOlderRef.current = true;
    setLoadingOlder(true);
    if (modeRef.current === 'live') {
      modeRef.current = 'historical';
      setMode('historical');
      // Seed the forward boundary *now*, at the moment live tailing is
      // interrupted — not lazily inside loadNewer at whatever later moment
      // the operator happens to scroll back down. Seeding lazily would use
      // Date.now() at call time, which has already moved past this point,
      // silently skipping everything that arrived while browsing history.
      newestTimestampRef.current = Date.now();
      newestEventIdsRef.current = [];
    }
    const before = oldestTimestampRef.current ?? Date.now();
    try {
      const page = await apiRef.current.getOlder(target, before, WINDOW_SIZE);
      if (windowGenerationRef.current !== generation) return;
      if (page.atOldest || page.lines.length === 0) {
        atOldestRef.current = true;
        setAtOldest(true);
      } else {
        oldestTimestampRef.current = page.oldestTimestamp ?? before;
        const older: LogLine[] = page.lines.map((text) => ({
          text,
          receivedAt: Date.now(),
        }));
        setLines((prev) => {
          const merged = [...older, ...prev];
          return merged.length > WINDOW_SIZE ? merged.slice(0, WINDOW_SIZE) : merged;
        });
      }
    } catch (err) {
      if (windowGenerationRef.current !== generation) return;
      const message = err instanceof Error ? err.message : String(err);
      setError(`Could not load older logs: ${message}`);
    } finally {
      if (windowGenerationRef.current === generation) {
        loadingOlderRef.current = false;
        setLoadingOlder(false);
      }
    }
  }, [target]);

  /**
   * Fetches one forward page via `api.getNewer`, appending it to the end of
   * `lines` and evicting from the front to stay within {@link WINDOW_SIZE} —
   * the paged mirror of {@link loadOlder}. The boundary passed to `getNewer`
   * is {@link newestTimestampRef}, seeded by {@link loadOlder} at the moment
   * historical mode is entered (not lazily here — see that seeding site's
   * comment for why). `getNewer`'s `afterTimestamp` bound is inclusive, so
   * {@link newestEventIdsRef} (the previous page's boundary-event ids) is
   * passed back as `excludeEventIds` to keep the boundary event(s) from
   * being re-delivered. Runs when the operator scrolls back down past the
   * bottom of a historical window — deliberately does not switch back to
   * `'live'` mode itself; only {@link jumpToLatest} does that. Discards its
   * result if {@link windowGenerationRef} moved on while the call was in
   * flight.
   */
  const loadNewer = useCallback(async () => {
    if (!target || loadingNewerRef.current) return;
    const generation = windowGenerationRef.current;
    const after = newestTimestampRef.current ?? Date.now();
    const excludeEventIds = newestEventIdsRef.current;
    loadingNewerRef.current = true;
    try {
      const page = await apiRef.current.getNewer(target, after, WINDOW_SIZE, excludeEventIds);
      if (windowGenerationRef.current !== generation) return;
      newestTimestampRef.current = page.newestTimestamp ?? after;
      newestEventIdsRef.current = page.newestTimestamp !== undefined ? page.newestEventIds : excludeEventIds;
      if (page.lines.length > 0) {
        const newer: LogLine[] = page.lines.map((text) => ({
          text,
          receivedAt: Date.now(),
        }));
        setLines((prev) => {
          const merged = [...prev, ...newer];
          return merged.length > WINDOW_SIZE ? merged.slice(-WINDOW_SIZE) : merged;
        });
      }
    } catch (err) {
      if (windowGenerationRef.current !== generation) return;
      const message = err instanceof Error ? err.message : String(err);
      setError(`Could not load newer logs: ${message}`);
    } finally {
      if (windowGenerationRef.current === generation) {
        loadingNewerRef.current = false;
      }
    }
  }, [target]);

  /**
   * Scrolling away from the bottom turns autoscroll off so incoming lines
   * don't yank the view back down while reading; scrolling back within
   * {@link BOTTOM_PIN_THRESHOLD_PX} of the bottom afterward turns it back on.
   * Merely staying near the bottom does not re-enable it, so unchecking the
   * autoscroll toggle while already pinned to the bottom sticks.
   *
   * Also drives the windowed backfill: scrolling within
   * {@link NEAR_TOP_THRESHOLD_PX} of the top triggers {@link loadOlder}
   * (entering `'historical'` mode on the first call), and scrolling back
   * within {@link BOTTOM_PIN_THRESHOLD_PX} of the bottom while already in
   * `'historical'` mode triggers {@link loadNewer}.
   */
  const handleScroll = useCallback(() => {
    const el = boxRef.current;
    if (!el) return;
    const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    const isNearBottom = distanceFromBottom <= BOTTOM_PIN_THRESHOLD_PX;
    const isNearTop = el.scrollTop < NEAR_TOP_THRESHOLD_PX;

    if (isNearBottom) {
      if (scrolledAwayRef.current) setAutoscroll(true);
      scrolledAwayRef.current = false;
    } else {
      setAutoscroll(false);
      scrolledAwayRef.current = true;
    }

    if (isNearTop) {
      void loadOlder();
    } else if (isNearBottom && modeRef.current === 'historical') {
      void loadNewer();
    }
  }, [loadOlder, loadNewer]);

  /**
   * Discards everything currently loaded/buffered — `lines`, the live
   * buffer, and every window-tracking ref — and re-fetches a fresh recent
   * snapshot via `api.get(target)` (the same call the initial-mount effect
   * makes), then resets back to `'live'` mode with autoscroll re-enabled.
   * Bumps {@link windowGenerationRef} first so any backward/forward fetch
   * already in flight is discarded when it resolves rather than clobbering
   * this fresh snapshot. Buffered live lines are deliberately discarded, not
   * flushed — "Jump to latest" means a fresh look at the present, not a
   * splice of whatever accumulated while historical.
   */
  const jumpToLatest = useCallback(() => {
    windowGenerationRef.current += 1;
    const generation = windowGenerationRef.current;
    bufferRef.current = [];
    setBufferedCount(0);
    resetWindowState();
    setAutoscroll(true);
    scrolledAwayRef.current = false;

    if (!target || !window.hyveon) {
      setLines([]);
      return;
    }

    setJumpingToLatest(true);
    void (async () => {
      try {
        const data = await apiRef.current.get(target);
        if (windowGenerationRef.current !== generation) return;
        setLines(
          data.lines.slice(-WINDOW_SIZE).map((text) => ({ text, receivedAt: Date.now() })),
        );
        oldestTimestampRef.current = data.oldestTimestamp ?? null;
      } catch (err) {
        if (windowGenerationRef.current !== generation) return;
        const message = err instanceof Error ? err.message : String(err);
        setError(`Could not load latest logs: ${message}`);
      } finally {
        if (windowGenerationRef.current === generation) setJumpingToLatest(false);
      }
    })();
  }, [target, resetWindowState]);

  const handlePauseToggle = useCallback(() => {
    const nowPaused = !pausedRef.current;
    pausedRef.current = nowPaused;
    setPaused(nowPaused);
    // Only flush the buffer into `lines` on resume while still in 'live'
    // mode — resuming from pause during a historical scroll-back must not
    // splice live lines into the middle of the backfilled window; they stay
    // buffered until `jumpToLatest` is called.
    if (!nowPaused && modeRef.current === 'live' && bufferRef.current.length > 0) {
      const buffered = bufferRef.current;
      bufferRef.current = [];
      setBufferedCount(0);
      setLines((prev) => {
        const next = [...prev, ...buffered];
        return next.length > WINDOW_SIZE ? next.slice(-WINDOW_SIZE) : next;
      });
    }
  }, []);

  return {
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
    mode,
    atOldest,
    loadingOlder,
    hasNewer: mode === 'historical',
    jumpingToLatest,
    jumpToLatest,
  };
}
