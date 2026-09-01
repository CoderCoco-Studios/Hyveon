import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../api.service.js';

const POLL_INTERVAL_MS = 5_000;

/** A `diagnostics.tail`/`diagnostics.path` snapshot fetched while paused, awaiting the operator's resume. */
interface PendingSnapshot {
  lines: string[];
  path: string;
}

/** The tailed lines, log path, and pause state {@link useDiagnosticsTail} exposes. */
export interface UseDiagnosticsTailResult {
  lines: string[];
  logPath: string;
  loading: boolean;
  error: string | null;
  paused: boolean;
  togglePause: () => void;
}

/**
 * Polls `diagnostics.tail`/`diagnostics.path` every 5 seconds for the last
 * 500 lines of the app's own local log file (`main-*.log`), with the same
 * pause/resume affordance the `/logs` page has for CloudWatch output.
 *
 * @remarks
 * `diagnostics.tail` returns the current cumulative tail on every call, not
 * an incremental delta — unlike `/logs`'s streamed chunks, there is no line
 * identity to key an append on. Pausing therefore does not stop polling; it
 * stops the poll response from being *rendered*. Each poll while paused
 * updates only an internal "latest fetched" ref. Resuming replaces the view
 * with that latest snapshot in one step — never by appending successive
 * poll responses to each other, which would duplicate or misorder lines
 * given the snapshot (not delta) shape of the response.
 *
 * @returns The tailed lines, log path, and pause state.
 */
export function useDiagnosticsTail(): UseDiagnosticsTailResult {
  const [lines, setLines] = useState<string[]>([]);
  const [logPath, setLogPath] = useState<string>('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [paused, setPaused] = useState(false);

  const pausedRef = useRef(false);
  /** The most recently fetched snapshot while paused, applied on resume. Not rendered until then. */
  const pendingSnapshotRef = useRef<PendingSnapshot | null>(null);
  /** Sequence number of the most recently *issued* poll, used to discard a stale response that resolves after a newer one. */
  const pollSeqRef = useRef(0);

  /** Fetch tail lines and log path, skipping state updates if cancelled or superseded by a later poll. */
  const fetchData = useCallback(async (isCancelled: () => boolean) => {
    const seq = ++pollSeqRef.current;
    try {
      const [tailResult, pathResult] = await Promise.all([api.diagnosticsTail(), api.diagnosticsLogPath()]);
      if (isCancelled() || seq !== pollSeqRef.current) return;
      if (pausedRef.current) {
        pendingSnapshotRef.current = { lines: tailResult.lines, path: pathResult.path };
      } else {
        setLines(tailResult.lines);
        setLogPath(pathResult.path);
      }
      setError(null);
    } catch (err) {
      if (isCancelled() || seq !== pollSeqRef.current) return;
      // A transient poll failure shouldn't blow away a frozen paused view — only surface it when live.
      if (!pausedRef.current) {
        setError(err instanceof Error ? err.message : 'Failed to load diagnostics');
      }
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    let intervalId: ReturnType<typeof setInterval> | null = null;

    void (async () => {
      await fetchData(() => cancelled);
      if (cancelled) return;
      setLoading(false);

      intervalId = setInterval(() => {
        if (!cancelled) void fetchData(() => cancelled);
      }, POLL_INTERVAL_MS);
    })();

    return () => {
      cancelled = true;
      if (intervalId !== null) clearInterval(intervalId);
    };
  }, [fetchData]);

  /** Toggle pause; resuming applies whatever snapshot was fetched most recently while paused, in one step. */
  const togglePause = useCallback(() => {
    const nowPaused = !pausedRef.current;
    pausedRef.current = nowPaused;
    setPaused(nowPaused);
    if (!nowPaused && pendingSnapshotRef.current) {
      setLines(pendingSnapshotRef.current.lines);
      setLogPath(pendingSnapshotRef.current.path);
      pendingSnapshotRef.current = null;
    }
  }, []);

  return { lines, logPath, loading, error, paused, togglePause };
}
