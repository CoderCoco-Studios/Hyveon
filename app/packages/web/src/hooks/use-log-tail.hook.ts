import { useCallback, useEffect, useRef, useState } from 'react';
import type { HyveonStreamHandle, LogChunk } from '@hyveon/desktop-preload';

const MAX_LINES = 1000;
const AGE_TICK_MS = 10_000;
/** Scroll distance (px) from the bottom within which the viewer still counts as "pinned to bottom". */
const BOTTOM_PIN_THRESHOLD_PX = 24;

/** A single tailed log line, with its receipt timestamp. */
export interface LogLine {
  text: string;
  receivedAt: number;
}

/** The `get`/`stream` pair a caller wires to either `window.hyveon.logs` (game logs) or `window.hyveon.logs.lambda` (Lambda logs). */
export interface LogTailApi {
  get: (target: string, limit?: number) => Promise<{ lines: string[] }>;
  stream: (target: string) => HyveonStreamHandle<LogChunk>;
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
  /** Wire to the log viewer container's `onScroll` — pins/unpins autoscroll based on distance from the bottom. */
  handleScroll: () => void;
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
 * near it — see {@link UseLogTailResult.handleScroll}), and the "oldest
 * line age" footer clock. Fully resets and re-subscribes whenever `target`
 * changes — callers do not reset state themselves before switching targets.
 *
 * @param target - The game name or `LambdaFunctionKey` to tail. An empty
 *   string means "nothing selected yet" — no fetch/stream starts.
 * @param api - The `get`/`stream` pair to call. Pass a stable reference
 *   (e.g. `window.hyveon.logs` or `window.hyveon.logs.lambda`) — an
 *   internal ref means a new object identity each render is tolerated,
 *   but a stable reference keeps the intent obvious.
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

  const boxRef = useRef<HTMLDivElement>(null);
  const streamRef = useRef<HyveonStreamHandle<LogChunk> | null>(null);
  const pausedRef = useRef(false);
  const bufferRef = useRef<LogLine[]>([]);
  // Tracks whether the user has scrolled away from the bottom since autoscroll
  // was last on, so handleScroll only re-enables it on a genuine return-to-bottom
  // rather than re-flipping a manual off while already parked near the bottom.
  const scrolledAwayRef = useRef(false);

  const appendLine = useCallback((text: string) => {
    const entry: LogLine = { text, receivedAt: Date.now() };
    if (pausedRef.current) {
      bufferRef.current.push(entry);
      if (bufferRef.current.length > MAX_LINES) {
        bufferRef.current.splice(0, bufferRef.current.length - MAX_LINES);
      }
      setBufferedCount(bufferRef.current.length);
      return;
    }
    setLines((prev) => {
      const next = [...prev, entry];
      return next.length > MAX_LINES ? next.slice(-MAX_LINES) : next;
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

  // Reset everything that described the previous target, then fetch the
  // new target's snapshot and (re)subscribe. Runs on mount and on every
  // `target` change — callers only change `target`, they don't reset
  // state first (that responsibility moved here from `LogsPage.selectGame`).
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      setLines([]);
      bufferRef.current = [];
      setBufferedCount(0);
      pausedRef.current = false;
      setPaused(false);
      setError(null);

      if (!target) return;

      if (!window.hyveon) {
        if (!cancelled) setError('IPC bridge (window.hyveon) is not available in this context.');
        return;
      }
      try {
        const data = await apiRef.current.get(target);
        if (cancelled) return;
        setLines(data.lines.slice(-MAX_LINES).map((text) => ({ text, receivedAt: Date.now() })));
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
  }, [target, startStream, stopStream]);

  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), AGE_TICK_MS);
    return () => clearInterval(id);
  }, []);

  useEffect(() => {
    if (autoscroll && !paused && boxRef.current) {
      boxRef.current.scrollTop = boxRef.current.scrollHeight;
    }
  }, [lines, autoscroll, paused]);

  const oldest = lines[0];
  const ageLabel = oldest ? formatAge(now - oldest.receivedAt) : null;

  /**
   * Scrolling away from the bottom turns autoscroll off so incoming lines
   * don't yank the view back down while reading; scrolling back within
   * {@link BOTTOM_PIN_THRESHOLD_PX} of the bottom afterward turns it back on.
   * Merely staying near the bottom does not re-enable it, so unchecking the
   * autoscroll toggle while already pinned to the bottom sticks.
   */
  const handleScroll = useCallback(() => {
    const el = boxRef.current;
    if (!el) return;
    const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    const isNearBottom = distanceFromBottom <= BOTTOM_PIN_THRESHOLD_PX;
    if (isNearBottom) {
      if (scrolledAwayRef.current) setAutoscroll(true);
      scrolledAwayRef.current = false;
    } else {
      setAutoscroll(false);
      scrolledAwayRef.current = true;
    }
  }, []);

  const handlePauseToggle = useCallback(() => {
    const nowPaused = !pausedRef.current;
    pausedRef.current = nowPaused;
    setPaused(nowPaused);
    if (!nowPaused && bufferRef.current.length > 0) {
      const buffered = bufferRef.current;
      bufferRef.current = [];
      setBufferedCount(0);
      setLines((prev) => {
        const next = [...prev, ...buffered];
        return next.length > MAX_LINES ? next.slice(-MAX_LINES) : next;
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
  };
}
