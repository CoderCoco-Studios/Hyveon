import { useCallback, useEffect, useRef, useState } from 'react';
import type {
  HyveonStreamHandle,
  IacPlanAck,
  IacRunKind,
  IacRunChunk,
  IacRunRecord,
  IacStaleLockInfo,
  RunDetailStatus,
  RunLock,
} from '@hyveon/desktop-preload';
import { BRIDGE_UNAVAILABLE } from '@/lib/bridge.utils';

/**
 * Operation name a BUSY rejection reports as already holding the shared
 * workspace — the raw values `IacController`'s gates emit
 * (`PulumiOperationInFlightError.inFlight`/`RunLockHeldError`), which are the
 * Pulumi Automation API's own operation names (`preview`/`up`).
 */
export type Conflict = 'preview' | 'up' | 'destroy' | 'rollback';

/** Mirrors `WINDOW_SIZE` in `use-log-tail.hook.ts` — caps the in-memory chunk buffer so a long-running apply/destroy doesn't grow it unbounded. */
const CHUNK_WINDOW_SIZE = 300;

/** Live state of a single streamed iac run, backed by `hyveon.iac.runs.streamLogs`. */
export interface RunLogState {
  chunks: IacRunChunk[];
  /** True once the stream's `for await` loop has completed — the run reached a terminal status (or the run was never attached). */
  ended: boolean;
  /**
   * Set when the stream itself threw before completing — distinct from the
   * run's own failed/aborted terminal status, which is derived separately
   * (once `ended` flips true) via a follow-up `runs.get` call. A `null`
   * `IacRunChunk` stream failure (e.g. the local run artifacts
   * disappeared mid-tail) would otherwise vanish silently, leaving the
   * operator staring at a log that just stops with no explanation.
   */
  error: string | null;
}

/**
 * Attaches to `hyveon.iac.runs.streamLogs(runId)` for the lifetime of
 * `runId`, accumulating chunks in order. Mirrors `LogsPage`'s
 * `for await` + stream-handle-in-a-ref streaming idiom. Re-attaches
 * automatically if `runId` changes; tears the previous subscription down
 * first.
 *
 * @remarks
 * The accumulated log is tagged with the run it belongs to (rather than
 * cleared synchronously on every `runId` change, which `react-hooks/set-state-in-effect`
 * flags) so switching runs discards the previous output at render time, and
 * a stream failure on one run cannot bleed onto the next.
 */
function useIacRunLog(runId: string | null): RunLogState {
  const [log, setLog] = useState<{
    runId: string;
    chunks: IacRunChunk[];
    ended: boolean;
    error: string | null;
  } | null>(null);
  const streamRef = useRef<HyveonStreamHandle<IacRunChunk> | null>(null);

  const isCurrent = log !== null && log.runId === runId;
  const chunks = isCurrent ? log.chunks : [];
  const ended = isCurrent ? log.ended : false;
  const error = isCurrent ? log.error : null;

  useEffect(() => {
    streamRef.current?.cancel();

    if (!runId || !window.hyveon) return;

    const handle = window.hyveon.iac.runs.streamLogs(runId);
    streamRef.current = handle;
    let cancelled = false;

    /**
     * Fold an update into the log state, but only while it still describes
     * this run — a late chunk from a superseded stream must not resurrect
     * itself on top of the new run's output.
     */
    const update = (
      apply: (prev: { chunks: IacRunChunk[]; ended: boolean; error: string | null }) => {
        chunks: IacRunChunk[];
        ended: boolean;
        error: string | null;
      },
    ) =>
      setLog((prev) => {
        const base = prev && prev.runId === runId ? prev : { runId, chunks: [], ended: false, error: null };
        return { runId, ...apply(base) };
      });

    void (async () => {
      try {
        for await (const chunk of handle) {
          if (cancelled) break;
          update((prev) => ({ ...prev, chunks: [...prev.chunks, chunk].slice(-CHUNK_WINDOW_SIZE) }));
        }
      } catch (err) {
        // The run's own failure is already visible in the accumulated log
        // output and surfaced via the follow-up `runs.get` status check —
        // but a *stream* failure (as opposed to the run failing) would
        // otherwise vanish here silently, so still surface it.
        if (!cancelled) {
          const message = err instanceof Error ? err.message : String(err);
          update((prev) => ({ ...prev, error: message }));
        }
      } finally {
        if (!cancelled) update((prev) => ({ ...prev, ended: true }));
      }
    })();

    return () => {
      cancelled = true;
      // Optional chaining guards against a test double that stubbed
      // `iac.runs.streamLogs` without configuring a return value
      // (`undefined`) — the real bridge always returns a handle.
      handle?.cancel();
    };
  }, [runId]);

  return { chunks, ended, error };
}

/** Operator-facing label used in `useIacRun`'s generic default/not-found submission messages, keyed by {@link IacRunKind}. */
const RUN_KIND_LABELS: Record<IacRunKind, string> = {
  plan: 'Plan',
  apply: 'Apply',
  destroy: 'Destroy',
};

/** Live state and actions for one plan/apply/destroy run, returned by {@link useIacRun}. */
export interface UseIacRunResult {
  runId: string | null;
  status: RunDetailStatus | null;
  record: IacRunRecord | null;
  log: RunLogState;
  conflict: Conflict | null;
  staleLock: IacStaleLockInfo | null;
  /** Present only when the refusal was a durable `RunLockHeldError` — `plan` never sets this (see {@link IacPlanAck.runLock}'s doc comment in `hyveon-api.ts`). */
  runLock: RunLock | null;
  submitError: string | null;
  inFlight: boolean;
  /**
   * Submits a plan/apply/destroy run. Bails out with a friendly `submitError` if `window.hyveon` (the IPC
   * bridge) is unavailable; otherwise resets `conflict`/`staleLock`/`runLock`/`submitError`/`record`, calls
   * `fn`, and on `{ started: true, runId }` attaches `runId` for streaming — otherwise stores whichever of
   * `conflict`/`staleLock`/`runLock` the ack carried plus a default `submitError` naming the run kind (e.g.
   * "Apply could not be started."). A `fn` rejection is caught and stored in `submitError` the same way.
   *
   * Preconditions specific to one operation (e.g. apply requiring an approved `planHash`) are the caller's
   * responsibility to check before invoking `submit` — this method has no opinion on when it's valid to
   * submit, only on what happens once it's called.
   */
  submit: (fn: () => Promise<IacPlanAck>) => void;
  /** Resets every field back to its initial (no run submitted) state. */
  reset: () => void;
}

/**
 * Owns the plan/apply/destroy run-submission state machine shared by all three operations on `IacPage`:
 * the submitted run's id/terminal status/record, its live log (via `useIacRunLog`), and the
 * conflict/staleLock/runLock/submitError banners a rejected submission surfaces. Call once per operation
 * kind — `IacPage` calls this three times (plan, apply, destroy), each with its own independent state.
 *
 * Unifies two behaviors that used to be duplicated once per operation (plan/apply/destroy) and had drifted
 * out of sync between copies:
 * - {@link UseIacRunResult.submit} always resets `record` to `null` on every submission (success or
 *   rejection), not just `status`/`conflict`/etc — otherwise a stale `record` from a previous run of the
 *   same kind (e.g. `record.partialApply`) can flash on screen before the new run's terminal status loads.
 * - The terminal-status effect (fired once the log stream ends) always treats `runs.get` resolving
 *   `{ found: false }` as an error (`"<Kind> run "<runId>" could not be found after it finished."`), for
 *   every kind — not just the one that happened to check for it.
 *
 * @param kind - Which run this instance tracks — `'plan'` | `'apply'` | `'destroy'` — used only to label
 *   {@link UseIacRunResult.submit}'s generic default/not-found submission error text.
 * @returns The run's live state and its `submit`/`reset` actions.
 */
export function useIacRun(kind: IacRunKind): UseIacRunResult {
  const label = RUN_KIND_LABELS[kind];

  const [runId, setRunId] = useState<string | null>(null);
  const [status, setStatus] = useState<RunDetailStatus | null>(null);
  const [record, setRecord] = useState<IacRunRecord | null>(null);
  const [conflict, setConflict] = useState<Conflict | null>(null);
  const [staleLock, setStaleLock] = useState<IacStaleLockInfo | null>(null);
  const [runLock, setRunLock] = useState<RunLock | null>(null);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [inFlight, setInFlight] = useState(false);

  const log = useIacRunLog(runId);

  // Once the log stream ends, fetch the run's terminal status/record —
  // `awaiting_approval`/`success`/`failed`/`aborted` are only derivable
  // once the underlying process has closed.
  useEffect(() => {
    if (!runId || !log.ended || !window.hyveon) return;
    let cancelled = false;
    void (async () => {
      try {
        const result = await window.hyveon!.iac.runs.get(runId);
        if (cancelled) return;
        if (result.found) {
          setStatus(result.status);
          setRecord(result.record ?? null);
        } else {
          setSubmitError(`${label} run "${runId}" could not be found after it finished.`);
        }
      } catch (err) {
        if (cancelled) return;
        const message = err instanceof Error ? err.message : String(err);
        setSubmitError(`${label} run "${runId}" status could not be fetched: ${message}`);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [runId, log.ended, label]);

  const submit = useCallback(
    (fn: () => Promise<IacPlanAck>) => {
      if (!window.hyveon) {
        setSubmitError(BRIDGE_UNAVAILABLE);
        return;
      }
      setInFlight(true);
      setConflict(null);
      setStaleLock(null);
      setRunLock(null);
      setSubmitError(null);
      setRecord(null);
      void (async () => {
        try {
          const ack = await fn();
          if (ack.started && ack.runId) {
            setRunId(ack.runId);
            setStatus(null);
          } else {
            if (ack.conflict) setConflict(ack.conflict);
            if (ack.staleLock) setStaleLock(ack.staleLock);
            if (ack.runLock) setRunLock(ack.runLock);
            setSubmitError(ack.error ?? `${label} could not be started.`);
          }
        } catch (err) {
          setSubmitError(err instanceof Error ? err.message : String(err));
        } finally {
          setInFlight(false);
        }
      })();
    },
    [label],
  );

  const reset = useCallback(() => {
    setRunId(null);
    setStatus(null);
    setRecord(null);
    setConflict(null);
    setStaleLock(null);
    setRunLock(null);
    setSubmitError(null);
  }, []);

  return { runId, status, record, log, conflict, staleLock, runLock, submitError, inFlight, submit, reset };
}
