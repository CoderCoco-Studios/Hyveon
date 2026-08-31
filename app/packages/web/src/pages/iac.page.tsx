import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { toast } from 'sonner';
import { AlertTriangle, CheckCircle2, Loader2, Play, RotateCcw, ShieldCheck, Trash2 } from 'lucide-react';
import type {
  ChangeSummary,
  HyveonStreamHandle,
  OpType,
  RunDetailStatus,
  IacPlanPayload,
  IacRunChunk,
  IacRunRecord,
  IacStaleLockInfo,
  RunLock,
} from '@hyveon/desktop-preload';
import { Button } from '../components/ui/button.component.js';
import { Badge } from '../components/ui/badge.component.js';
import { AnsiLogViewer } from '../components/ansi-log-viewer.component.js';
import { ConfirmDialog } from '../components/confirm-dialog.component.js';
import { ErrorBanner } from '../components/error-banner.component.js';
import { PageHeader } from '../components/page-header.component.js';

/**
 * `location.state` shape the rollback flow (#112) navigates to `/iac`
 * with, from a confirmed rollback in `/iac/history` — see
 * `RollbackAction`. `configVersionId` is the freshly-restored head version to
 * plan against; `rolledBackFrom` is the apply run it was restored from, sent
 * straight through to `hyveon.iac.plan` so the resulting plan's persisted
 * record carries the same tag.
 */
interface RollbackNavState {
  configVersionId: string;
  rolledBackFrom: string;
}

/** Type guard for {@link RollbackNavState} — `location.state` is `unknown` until narrowed. */
function isRollbackNavState(state: unknown): state is RollbackNavState {
  return (
    typeof state === 'object' &&
    state !== null &&
    typeof (state as Partial<RollbackNavState>).configVersionId === 'string' &&
    typeof (state as Partial<RollbackNavState>).rolledBackFrom === 'string'
  );
}

/**
 * Mirrors `APPROVAL_WINDOW_MS` in `@hyveon/shared/runs.ts` — that constant is
 * the source of truth for how long the backend honors an approval before
 * `iac.apply` rejects it. Duplicated here (rather than importing
 * `@hyveon/shared` into the renderer bundle) purely to drive the staleness
 * countdown; the backend's own check is what's actually authoritative.
 */
const APPROVAL_WINDOW_MS = 15 * 60 * 1000;

/** Mirrors `isApprovalExpired` in `@hyveon/shared/runs.ts` for the same reason as {@link APPROVAL_WINDOW_MS}. */
function isApprovalExpired(approvedAt: string, now: number): boolean {
  return now >= new Date(approvedAt).getTime() + APPROVAL_WINDOW_MS;
}

/**
 * Exact phrase an operator must type into the destroy confirmation dialog
 * before the destructive button enables (issue #307) — the UI's
 * defense-in-depth layer; the token minted on confirm is what the backend
 * actually trusts (see `PulumiService.assertFreshDestroyConfirmation`).
 */
const DESTROY_CONFIRM_PHRASE = 'destroy infrastructure';

/** Live state of a single streamed iac run, backed by `hyveon.iac.runs.streamLogs`. */
interface RunLogState {
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
 */
function useIacRunLog(runId: string | null): RunLogState {
  // The accumulated log is tagged with the run it belongs to, so switching
  // runs discards the previous output at render time. Previously the effect
  // cleared `chunks`/`ended` synchronously on every `runId` change, which is
  // what `react-hooks/set-state-in-effect` flags. `error` is tagged the same
  // way so a stream failure on one run cannot bleed onto the next.
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
          update((prev) => ({ ...prev, chunks: [...prev.chunks, chunk] }));
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

/**
 * Operation name a BUSY rejection reports as already holding the shared
 * workspace — the raw values `IacController`'s gates emit
 * (`PulumiOperationInFlightError.inFlight`/`RunLockHeldError`), which are the
 * Pulumi Automation API's own operation names (`preview`/`up`) rather than
 * the pre-migration IaC CLI's subcommand names this type used to carry.
 * See {@link CONFLICT_LABELS} for the operator-facing label each maps to.
 */
type Conflict = 'preview' | 'up' | 'destroy' | 'rollback';

/**
 * Operator-facing label for each {@link Conflict} value — maps the raw
 * Pulumi operation name to the term this page's own buttons use ("plan"/
 * "apply"), so the busy banner reads naturally instead of surfacing
 * `preview`/`up` verbatim.
 */
const CONFLICT_LABELS: Record<Conflict, string> = {
  preview: 'plan',
  up: 'apply',
  destroy: 'destroy',
  rollback: 'rollback',
};

/**
 * Shared mint-then-confirm lock-clear flow, extracted from `BusyBanner` and
 * `StaleLockBanner` — their `handleConfirmClear` bodies were otherwise
 * near-identical (mint a fresh confirmation token, clear the lock, toast a
 * success message, then notify the caller), differing only in which
 * `hyveon.iac.*` channels they called and what they toasted/reported.
 *
 * Every failure path (missing IPC bridge, `mintToken`/`clear` rejecting, or
 * `clear` resolving `{ cleared: false }`) surfaces via {@link clearError}
 * and leaves {@link confirmOpen} untouched — the caller's banner/dialog stay
 * on screen for another attempt, matching both callers' original behavior.
 *
 * @param options - `mintToken` mints a fresh confirmation token, bound to
 *   whichever specific lock instance the caller is confirming against (see
 *   each call site's own binding); `clear` clears the lock using the token
 *   `mintToken` returned; `successMessage` is toasted via `sonner`'s
 *   `toast.success` once `clear` resolves `{ cleared: true }`; `onCleared`
 *   is called after that success toast, so the caller can reset whatever
 *   banner/error state returns the page to its ready-to-submit state.
 * @returns `confirmOpen`/`setConfirmOpen` to drive the `ConfirmDialog`,
 *   `clearing`/`clearError` to render loading/error state, and
 *   `handleConfirmClear` to wire to the dialog's `onConfirm`.
 */
function useLockClearConfirmation(options: {
  mintToken: () => Promise<{ token: string }>;
  clear: (payload: { confirmationToken: string }) => Promise<{ cleared: boolean; error?: string }>;
  successMessage: string;
  onCleared: () => void;
}) {
  const { mintToken, clear, successMessage, onCleared } = options;
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [clearing, setClearing] = useState(false);
  const [clearError, setClearError] = useState<string | null>(null);

  const handleConfirmClear = useCallback(() => {
    if (!window.hyveon) {
      setClearError('IPC bridge (window.hyveon) is not available in this context.');
      return;
    }
    setClearing(true);
    setClearError(null);
    void (async () => {
      try {
        const { token } = await mintToken();
        const ack = await clear({ confirmationToken: token });
        if (ack.cleared) {
          setConfirmOpen(false);
          toast.success(successMessage);
          onCleared();
        } else {
          setClearError(ack.error ?? 'Could not clear the lock.');
        }
      } catch (err) {
        setClearError(err instanceof Error ? err.message : String(err));
      } finally {
        setClearing(false);
      }
    })();
  }, [mintToken, clear, successMessage, onCleared]);

  return { confirmOpen, setConfirmOpen, clearing, clearError, handleConfirmClear };
}

/**
 * Lock banner shown when a plan/apply/destroy submission was rejected
 * because the shared Pulumi workspace is busy (`PulumiOperationInFlightError`).
 *
 * `runLock` is set instead of undefined specifically when the rejection was
 * a durable `RunLockHeldError` (`apply`/`destroy` only — `plan` never
 * acquires the durable lock, see {@link IacPlanAck.runLock}'s doc comment in
 * `hyveon-api.ts`) — in that case an inline "Clear lock and retry" action is
 * offered, gated behind a {@link ConfirmDialog}, mirroring
 * {@link StaleLockBanner}'s mint-then-confirm clear flow but against the
 * `iac.runs.lock.*` channels rather than `iac.lock.*`. A plain workspace-busy
 * refusal (no durable lock, e.g. `plan`'s `preview` conflict) has nothing to
 * clear — those refusals resolve themselves once the in-flight operation
 * finishes, so no action is offered.
 *
 * On a confirmed clear, mints a fresh confirmation token via
 * `hyveon.iac.runs.lock.mintToken()`, clears via
 * `hyveon.iac.runs.lock.clear({ confirmationToken })`, toasts a
 * confirmation, and calls {@link onCleared} — which the caller wires to
 * return the page to its ready-to-submit state (clearing both this banner's
 * `conflict`/`runLock` and the original submission's `error` state). Like
 * `StaleLockBanner`, this never resubmits automatically — the operator
 * retries via the ordinary plan/apply/destroy button.
 */
function BusyBanner({
  conflict,
  runLock,
  nowMs,
  onCleared,
}: {
  conflict: Conflict;
  /** Present only when the refusal was a durable {@link RunLockHeldError} — offers the inline clear action. */
  runLock?: RunLock;
  /** Current time in ms (the page's own 30s-ticking clock) — drives {@link formatLockAge}'s "ago" display in the clear-confirmation dialog. */
  nowMs: number;
  /** Called once `hyveon.iac.runs.lock.clear()` reports `cleared: true`. */
  onCleared: () => void;
}) {
  const label = CONFLICT_LABELS[conflict];
  const article = /^[aeiou]/i.test(label) ? 'an' : 'a';

  const { confirmOpen, setConfirmOpen, clearing, clearError, handleConfirmClear } = useLockClearConfirmation({
    // Bound to THIS specific runLock instance (by runId), not just "a lock
    // exists" — the server refuses to mint if the currently held lock's
    // runId no longer matches, closing the TOCTOU gap where the lock shown
    // here was released and replaced by a different, legitimate lock before
    // the operator confirmed the clear (see `RunLockChangedError`'s doc
    // comment in `RunService.ts`).
    mintToken: () => {
      if (!runLock) return Promise.reject(new Error('No run lock to clear.'));
      return window.hyveon!.iac.runs.lock.mintToken({ expectedRunId: runLock.runId });
    },
    clear: (payload) => window.hyveon!.iac.runs.lock.clear(payload),
    successMessage: 'Run lock cleared — resubmit to retry.',
    onCleared,
  });

  return (
    <div
      role="alert"
      className="flex flex-col gap-2 rounded-[var(--radius-sm)] border border-[var(--color-amber)]/40 bg-[var(--color-amber)]/10 px-3 py-2 text-sm text-[var(--color-amber)]"
    >
      <p>
        Workspace busy — {article} <code className="font-[var(--font-mono)]">{label}</code> run
        is already in progress. Try again once it finishes.
      </p>
      {runLock && (
        <>
          <Button
            onClick={() => setConfirmOpen(true)}
            variant="secondary"
            size="sm"
            className="self-start"
            disabled={clearing}
          >
            {clearing ? <Loader2 className="animate-spin" /> : null}
            Clear lock and retry
          </Button>
          {clearError && <ErrorBanner>{clearError}</ErrorBanner>}
          <ConfirmDialog
            open={confirmOpen}
            onOpenChange={setConfirmOpen}
            title="Clear this run lock?"
            description={
              `This releases the durable apply lock held by "${runLock.initiator}" (${runLock.kind}, ` +
              `started ${formatLockAge(runLock.acquiredAt, nowMs)}). Only confirm if you are CONFIDENT ` +
              "this is not a real, currently-running plan/apply/destroy elsewhere — clearing a genuinely " +
              "active run's lock lets two Pulumi updates run concurrently, which can corrupt the deployed " +
              'infrastructure state. This does not retry your operation for you; resubmit it manually once ' +
              'the lock is cleared.'
            }
            onConfirm={handleConfirmClear}
            confirmLabel={clearing ? 'Clearing…' : 'Clear lock'}
          />
        </>
      )}
    </div>
  );
}

/**
 * Formats how long ago `lockedAt` was, for the stale-lock banner's "age"
 * display — mirrors `PulumiLockRecovery.formatLockAge` (desktop-main) field
 * for field. Duplicated here rather than imported (same reasoning as
 * {@link APPROVAL_WINDOW_MS}'s duplication above): the renderer bundle has no
 * reason to depend on `desktop-main`'s source, and this is a small, stable,
 * purely-cosmetic formatting rule. Deliberately coarse (minutes/hours/days)
 * — an operator deciding whether a lock is stale cares whether it's "5
 * minutes old" (plausibly still in progress) vs. "3 days old" (plausibly
 * abandoned), not second-level precision.
 */
function formatLockAge(lockedAt: string, nowMs: number): string {
  const ms = Math.max(0, nowMs - new Date(lockedAt).getTime());
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 1) return 'less than a minute ago';
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? '' : 's'} ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? '' : 's'} ago`;
  const days = Math.floor(hours / 24);
  return `${days} day${days === 1 ? '' : 's'} ago`;
}

/**
 * Shown INSTEAD OF {@link BusyBanner}/{@link ErrorBanner} when a
 * plan/apply/destroy submission was rejected because the Pulumi backend is
 * locked by something this installation cannot prove is its own crashed run
 * (`ack.staleLock` — see `IacPlanAck.staleLock`'s doc comment in
 * `hyveon-api.ts`). `iac.controller.ts`'s own error-handling never populates
 * both `conflict` and `staleLock` on the same rejection (each catch branch
 * `return`s independently), so this banner and `BusyBanner` are always
 * mutually exclusive for a given submission — this component does not need
 * to coordinate with `BusyBanner` itself.
 *
 * Names the stack and lists every lock holder (username, hostname, pid, and
 * a human-readable age via {@link formatLockAge}), then offers an explicit
 * "Clear lock and retry" action gated behind a {@link ConfirmDialog} —
 * reusing the same shared component the destroy- and rollback-confirmation
 * flows use. The dialog's copy is deliberately cautionary: clearing a lock that turns out to be a
 * genuinely active operation elsewhere (not actually stale) risks two Pulumi
 * updates racing against the same state, which can corrupt it — so the
 * operator is asked to confirm they recognize (or don't recognize) the
 * listed hostname/pid as a real in-progress run before proceeding.
 *
 * On a confirmed clear, mints a fresh confirmation token via
 * `hyveon.iac.lock.mintToken()` and passes it to
 * `hyveon.iac.lock.clear({ confirmationToken })` — mirroring the destroy
 * flow's mint-then-confirm pattern. Success clears the
 * parent's `staleLock` state via {@link StaleLockBannerProps.onCleared}
 * (returning the page to its normal "ready to submit" state) and toasts a
 * confirmation; the operator then retries by clicking the ordinary plan/
 * apply/destroy button again — this component never resubmits automatically,
 * matching `PulumiService.clearStaleLock`'s own "does not retry" design.
 * Failure surfaces the error inline via {@link ErrorBanner} without clearing
 * the parent's `staleLock` state, so the banner (and its evidence) stays put
 * for another attempt.
 */
interface StaleLockBannerProps {
  staleLock: IacStaleLockInfo;
  /** Current time in ms (the page's own 30s-ticking clock) — drives {@link formatLockAge}'s "ago" display. */
  nowMs: number;
  /** Called once `hyveon.iac.lock.clear()` reports `cleared: true`. */
  onCleared: () => void;
}

function StaleLockBanner({ staleLock, nowMs, onCleared }: StaleLockBannerProps) {
  const { confirmOpen, setConfirmOpen, clearing, clearError, handleConfirmClear } = useLockClearConfirmation({
    mintToken: () => window.hyveon!.iac.lock.mintToken(),
    clear: (payload) => window.hyveon!.iac.lock.clear(payload),
    successMessage: 'Pulumi backend lock cleared — resubmit to retry.',
    onCleared,
  });

  return (
    <div
      role="alert"
      className="flex flex-col gap-2 rounded-[var(--radius-sm)] border border-[var(--color-amber)]/40 bg-[var(--color-amber)]/10 px-3 py-2 text-sm text-[var(--color-amber)]"
    >
      <p>
        <strong>Backend lock in the way.</strong> The Pulumi stack{' '}
        <code className="font-[var(--font-mono)]">{staleLock.stackName}</code> is locked by something this
        installation cannot confirm is its own crashed run:
      </p>
      {staleLock.locks.length > 0 ? (
        <ul className="list-disc pl-5">
          {staleLock.locks.map((lock) => (
            <li key={lock.lockUrl}>
              <code className="font-[var(--font-mono)]">
                {lock.username}@{lock.hostname}
              </code>{' '}
              (pid {lock.pid}) — started {formatLockAge(lock.lockedAt, nowMs)}
            </li>
          ))}
        </ul>
      ) : (
        <p>No holder/age evidence was available for this lock.</p>
      )}
      <Button
        onClick={() => setConfirmOpen(true)}
        variant="secondary"
        size="sm"
        className="self-start"
        disabled={clearing}
      >
        {clearing ? <Loader2 className="animate-spin" /> : null}
        Clear lock and retry
      </Button>
      {clearError && <ErrorBanner>{clearError}</ErrorBanner>}
      <ConfirmDialog
        open={confirmOpen}
        onOpenChange={setConfirmOpen}
        title="Clear this Pulumi backend lock?"
        description={
          `This runs the equivalent of "pulumi cancel" against the "${staleLock.stackName}" stack, removing ` +
          'the lock(s) listed above. Only confirm if you are CONFIDENT the listed holder (hostname/pid) is not ' +
          "a real, currently-running plan/apply/destroy elsewhere — clearing a genuinely active operation's " +
          'lock lets two Pulumi updates run concurrently, which can corrupt the deployed infrastructure state. ' +
          'This does not retry your operation for you; resubmit it manually once the lock is cleared.'
        }
        onConfirm={handleConfirmClear}
        confirmLabel={clearing ? 'Clearing…' : 'Clear lock'}
      />
    </div>
  );
}

/**
 * {@link OpType} keys bucketed for display. Each bucket sums to a
 * single badge rather than rendering one badge per raw `OpType` — most runs
 * only ever populate a handful of the 15 possible keys, and the replacement
 * pair (`create-replacement`/`delete-replaced`) plus `import`/
 * `import-replacement` all read as "a resource came into existence" to an
 * operator skimming the summary, same for the two delete variants.
 */
const CREATE_OPS: readonly OpType[] = ['create', 'create-replacement', 'import', 'import-replacement'];
const DELETE_OPS: readonly OpType[] = ['delete', 'delete-replaced'];
/**
 * The rare, mostly-internal engine ops (refresh bookkeeping, discarded steps,
 * pending-replace cancellations, plain reads) — summed into a single "other"
 * badge rather than given their own bucket. Omitted entirely from the
 * summary when none of them fired.
 */
const OTHER_OPS: readonly OpType[] = [
  'read',
  'read-replacement',
  'refresh',
  'discard',
  'discard-replaced',
  'remove-pending-replace',
];

/** Sums `summary`'s counts across the given {@link OpType} keys, treating an absent key as 0. */
function sumOps(summary: ChangeSummary, ops: readonly OpType[]): number {
  return ops.reduce((total, op) => total + (summary[op] ?? 0), 0);
}

/**
 * True when `summary` is absent, or present but every {@link OpType} key on
 * it is absent/zero. Per `ChangeSummary`'s own TSDoc
 * (`@hyveon/shared/src/changeSummary.ts`) this means the engine's structured
 * summary event was never observed for the run (e.g. the process was killed
 * before it fired) — it must never be read as "no changes happened". A
 * genuine no-op reports `{ same: N }` for N ≥ 1, which fails this check.
 *
 * A stack with zero resources total is the one legitimately ambiguous edge
 * case: Pulumi would also report `{}` for it, indistinguishable from a
 * summary that was never observed. This function deliberately treats that
 * case as "unavailable" too rather than guessing "no changes" — an operator
 * seeing "summary unavailable" on a genuinely empty stack loses nothing (the
 * log above still shows the run completed successfully), whereas guessing
 * "no changes" on a run that actually failed to report anything would be a
 * false reassurance.
 */
function isSummaryUnavailable(summary: ChangeSummary | undefined): boolean {
  if (!summary) return true;
  return Object.values(summary).every((count) => !count);
}

/** True when `summary` reports changes via `same` only — a genuine no-op run, distinct from "unavailable" (see {@link isSummaryUnavailable}). */
function isNoOpSummary(summary: ChangeSummary): boolean {
  const { same, ...rest } = summary;
  return (same ?? 0) > 0 && Object.values(rest).every((count) => !count);
}

/**
 * Resource-change summary display shared by the plan, apply, and destroy
 * sections — reads the structured {@link ChangeSummary} the Pulumi engine
 * reports directly off the persisted run record. Renders one of three
 * states: "summary unavailable" when the structured event was never
 * observed, a dedicated no-op message when the run only reports `same`, or
 * grouped badges for the ops that actually changed something.
 *
 * Exported so the read-only run-history table and detail view can reuse
 * this exact three-way distinction instead of reimplementing it.
 */
export function ChangeSummaryStatus({ summary }: { summary: ChangeSummary | undefined }) {
  if (isSummaryUnavailable(summary)) {
    return <span className="text-sm italic text-[var(--color-muted-foreground)]">Change summary unavailable</span>;
  }

  // Non-null: isSummaryUnavailable(summary) === false only when summary is present.
  const s = summary!;

  if (isNoOpSummary(s)) {
    return <Badge variant="secondary">No changes — {s.same} unchanged</Badge>;
  }

  const creates = sumOps(s, CREATE_OPS);
  const updates = s.update ?? 0;
  const replaces = s.replace ?? 0;
  const deletes = sumOps(s, DELETE_OPS);
  const other = sumOps(s, OTHER_OPS);
  const unchanged = s.same ?? 0;

  return (
    <div className="flex flex-wrap items-center gap-2 text-sm">
      {creates > 0 && <Badge variant="cyan">{creates} to create</Badge>}
      {updates > 0 && <Badge variant="warning">{updates} to update</Badge>}
      {replaces > 0 && <Badge variant="outline">{replaces} to replace</Badge>}
      {deletes > 0 && <Badge variant="destructive">{deletes} to delete</Badge>}
      {other > 0 && <Badge variant="default">{other} other</Badge>}
      {unchanged > 0 && <Badge variant="secondary">{unchanged} unchanged</Badge>}
    </div>
  );
}

/**
 * Shown instead of the generic apply-failure/-abort banner when
 * `applyRecord.partialApply` is `true` — the Pulumi engine
 * mutated some resources before the apply run failed or was aborted, so the
 * deployed infrastructure no longer matches the plan that was approved.
 * Retrying the same apply blindly is unsafe: `planHash` only proves the plan
 * artifact and configuration are unchanged since approval, not that
 * resources weren't already mutated by this attempt. The correct recovery
 * is a fresh plan against current state. Bundles the "Start over" action
 * directly into the banner (rather than relying on the generic control
 * further down the page) so it reads as the guided next step.
 */
function PartialApplyBanner({ onStartOver }: { onStartOver: () => void }) {
  return (
    <ErrorBanner className="flex flex-col gap-2">
      <p>
        <strong>Apply stopped partway through.</strong> Some resources were already changed before this run
        failed or was aborted, so the deployed infrastructure no longer matches the plan you approved.
        Don&apos;t retry this apply — run a fresh plan against the current state, review it, and apply that
        new plan instead.
      </p>
      <Button onClick={onStartOver} variant="secondary" size="sm" className="self-start">
        <RotateCcw />
        Start over
      </Button>
    </ErrorBanner>
  );
}

/**
 * Infrastructure plan/apply route (`/iac`) — lets an operator trigger a
 * Pulumi plan (preview), watch its live ANSI output, review the
 * resource-change summary, approve the plan, and run the plan-hash-gated
 * apply, all over the `hyveon.iac.*` IPC surface. Surfaces BUSY
 * (shared-workspace conflict) and non-conflict submission errors inline
 * rather than failing silently.
 */
export function IacPage() {
  const location = useLocation();
  const navigate = useNavigate();
  const rollbackState = isRollbackNavState(location.state) ? location.state : null;
  /** Guards against re-submitting the rollback plan if this component re-renders while the same `location.state` is still present. */
  const rollbackConsumedRef = useRef(false);

  const [planRunId, setPlanRunId] = useState<string | null>(null);
  const [planConflict, setPlanConflict] = useState<Conflict | null>(null);
  const [planStaleLock, setPlanStaleLock] = useState<IacStaleLockInfo | null>(null);
  const [planSubmitError, setPlanSubmitError] = useState<string | null>(null);
  const [planning, setPlanning] = useState(false);

  const [planStatus, setPlanStatus] = useState<RunDetailStatus | null>(null);
  const [planRecord, setPlanRecord] = useState<IacRunRecord | null>(null);

  const [approval, setApproval] = useState<{ approvedBy: string; approvedAt: string } | null>(null);
  const [approving, setApproving] = useState(false);
  const [approveError, setApproveError] = useState<string | null>(null);

  const [applyRunId, setApplyRunId] = useState<string | null>(null);
  const [applyConflict, setApplyConflict] = useState<Conflict | null>(null);
  const [applyStaleLock, setApplyStaleLock] = useState<IacStaleLockInfo | null>(null);
  const [applyRunLock, setApplyRunLock] = useState<RunLock | null>(null);
  const [applySubmitError, setApplySubmitError] = useState<string | null>(null);
  const [applying, setApplying] = useState(false);

  const [applyStatus, setApplyStatus] = useState<RunDetailStatus | null>(null);
  const [applyRecord, setApplyRecord] = useState<IacRunRecord | null>(null);

  const [destroyConfirmOpen, setDestroyConfirmOpen] = useState(false);
  const [destroyRunId, setDestroyRunId] = useState<string | null>(null);
  const [destroyConflict, setDestroyConflict] = useState<Conflict | null>(null);
  const [destroyStaleLock, setDestroyStaleLock] = useState<IacStaleLockInfo | null>(null);
  const [destroyRunLock, setDestroyRunLock] = useState<RunLock | null>(null);
  const [destroySubmitError, setDestroySubmitError] = useState<string | null>(null);
  const [destroying, setDestroying] = useState(false);
  const [destroyStatus, setDestroyStatus] = useState<RunDetailStatus | null>(null);
  const [destroyRecord, setDestroyRecord] = useState<IacRunRecord | null>(null);

  const [now, setNow] = useState(() => Date.now());

  const planLog = useIacRunLog(planRunId);
  const applyLog = useIacRunLog(applyRunId);
  const destroyLog = useIacRunLog(destroyRunId);

  // Tick every 30s so the approval-staleness hint stays roughly fresh.
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(id);
  }, []);

  // Once the plan's log stream ends, fetch its terminal status/record —
  // `awaiting_approval` is only derivable once the process has closed.
  useEffect(() => {
    if (!planRunId || !planLog.ended || !window.hyveon) return;
    let cancelled = false;
    void (async () => {
      const result = await window.hyveon!.iac.runs.get(planRunId);
      if (cancelled) return;
      if (result.found) {
        setPlanStatus(result.status);
        setPlanRecord(result.record ?? null);
      } else {
        setPlanSubmitError(`Plan run "${planRunId}" could not be found after it finished.`);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [planRunId, planLog.ended]);

  useEffect(() => {
    if (!applyRunId || !applyLog.ended || !window.hyveon) return;
    let cancelled = false;
    void (async () => {
      const result = await window.hyveon!.iac.runs.get(applyRunId);
      if (cancelled) return;
      if (result.found) {
        setApplyStatus(result.status);
        setApplyRecord(result.record ?? null);
      } else {
        setApplySubmitError(`Apply run "${applyRunId}" could not be found after it finished.`);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [applyRunId, applyLog.ended]);

  useEffect(() => {
    if (!destroyRunId || !destroyLog.ended || !window.hyveon) return;
    let cancelled = false;
    void (async () => {
      const result = await window.hyveon!.iac.runs.get(destroyRunId);
      if (cancelled) return;
      if (result.found) {
        setDestroyStatus(result.status);
        setDestroyRecord(result.record ?? null);
      } else {
        setDestroySubmitError(`Destroy run "${destroyRunId}" could not be found after it finished.`);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [destroyRunId, destroyLog.ended]);

  const submitPlan = useCallback((payload?: IacPlanPayload) => {
    if (!window.hyveon) {
      setPlanSubmitError('IPC bridge (window.hyveon) is not available in this context.');
      return;
    }
    setPlanning(true);
    setPlanConflict(null);
    setPlanStaleLock(null);
    setPlanSubmitError(null);
    void (async () => {
      try {
        const ack = await window.hyveon!.iac.plan(payload);
        if (ack.started && ack.runId) {
          setPlanRunId(ack.runId);
          setPlanStatus(null);
          setPlanRecord(null);
          setApproval(null);
          setApproveError(null);
          setApplyRunId(null);
          setApplyStatus(null);
          setApplyRecord(null);
        } else {
          if (ack.conflict) setPlanConflict(ack.conflict);
          if (ack.staleLock) setPlanStaleLock(ack.staleLock);
          // ack.runLock is never set for `plan` — see IacPlanAck.runLock's
          // doc comment (plan never acquires the durable RunLock, only
          // apply/destroy do) — so there is nothing to store here.
          setPlanSubmitError(ack.error ?? 'Plan could not be started.');
        }
      } catch (err) {
        setPlanSubmitError(err instanceof Error ? err.message : String(err));
      } finally {
        setPlanning(false);
      }
    })();
  }, []);

  // Auto-submits the tagged rollback plan once, when arriving from a
  // confirmed rollback in history (see RollbackNavState) — the restore write
  // already happened before this navigation, so the plan just needs to run
  // against the new head with `rolledBackFrom` set for provenance.
  useEffect(() => {
    if (!rollbackState || rollbackConsumedRef.current) return;
    rollbackConsumedRef.current = true;
    navigate('/iac', { replace: true, state: null });
    submitPlan({ configVersionId: rollbackState.configVersionId, rolledBackFrom: rollbackState.rolledBackFrom });
  }, [navigate, rollbackState, submitPlan]);

  const submitApprove = useCallback(() => {
    if (!window.hyveon || !planRunId) return;
    setApproving(true);
    setApproveError(null);
    void (async () => {
      try {
        const ack = await window.hyveon!.iac.approve({ planRunId });
        if (ack.approved && ack.approvedBy && ack.approvedAt) {
          setApproval({ approvedBy: ack.approvedBy, approvedAt: ack.approvedAt });
          toast.success('Plan approved');
        } else {
          setApproveError(ack.error ?? 'Approval failed.');
        }
      } catch (err) {
        setApproveError(err instanceof Error ? err.message : String(err));
      } finally {
        setApproving(false);
      }
    })();
  }, [planRunId]);

  const submitApply = useCallback(() => {
    if (!window.hyveon || !planRunId || !planRecord?.planHash) return;
    setApplying(true);
    setApplyConflict(null);
    setApplyStaleLock(null);
    setApplyRunLock(null);
    setApplySubmitError(null);
    void (async () => {
      try {
        const ack = await window.hyveon!.iac.apply({ planRunId, planHash: planRecord.planHash! });
        if (ack.started && ack.runId) {
          setApplyRunId(ack.runId);
          setApplyStatus(null);
          setApplyRecord(null);
        } else {
          if (ack.conflict) setApplyConflict(ack.conflict);
          if (ack.staleLock) setApplyStaleLock(ack.staleLock);
          if (ack.runLock) setApplyRunLock(ack.runLock);
          setApplySubmitError(ack.error ?? 'Apply could not be started.');
        }
      } catch (err) {
        setApplySubmitError(err instanceof Error ? err.message : String(err));
      } finally {
        setApplying(false);
      }
    })();
  }, [planRunId, planRecord]);

  const submitDestroy = useCallback(() => {
    if (!window.hyveon) {
      setDestroySubmitError('IPC bridge (window.hyveon) is not available in this context.');
      return;
    }
    setDestroying(true);
    setDestroyConflict(null);
    setDestroyStaleLock(null);
    setDestroyRunLock(null);
    setDestroySubmitError(null);
    void (async () => {
      try {
        const mintAck = await window.hyveon!.iac.mintDestroyToken();
        const ack = await window.hyveon!.iac.destroy({ confirmationToken: mintAck.token });
        if (ack.started && ack.runId) {
          setDestroyConfirmOpen(false);
          setDestroyRunId(ack.runId);
          setDestroyStatus(null);
          setDestroyRecord(null);
        } else {
          if (ack.conflict) setDestroyConflict(ack.conflict);
          if (ack.staleLock) setDestroyStaleLock(ack.staleLock);
          if (ack.runLock) setDestroyRunLock(ack.runLock);
          setDestroySubmitError(ack.error ?? 'Destroy could not be started.');
        }
      } catch (err) {
        setDestroySubmitError(err instanceof Error ? err.message : String(err));
      } finally {
        setDestroying(false);
      }
    })();
  }, []);

  const startOver = useCallback(() => {
    setPlanRunId(null);
    setPlanStatus(null);
    setPlanRecord(null);
    setApproval(null);
    setApproveError(null);
    setApplyRunId(null);
    setApplyStatus(null);
    setApplyRecord(null);
    setApplySubmitError(null);
    setPlanSubmitError(null);
  }, []);

  useEffect(() => {
    if (applyStatus === 'success') toast.success('Apply complete');
  }, [applyStatus]);

  useEffect(() => {
    if (destroyStatus === 'success') toast.success('Destroy complete');
  }, [destroyStatus]);

  const awaitingApproval = planStatus === 'awaiting_approval';
  const planFinished = planStatus !== null;
  const planFailed = planStatus === 'failed' || planStatus === 'aborted';
  const approvalExpired = approval ? isApprovalExpired(approval.approvedAt, now) : false;
  const canApply = Boolean(approval) && !approvalExpired && Boolean(planRecord?.planHash) && !applyRunId;
  const applyFinished = applyStatus !== null;
  const destroyFinished = destroyStatus !== null;
  /**
   * Whether the apply run mutated resources before failing/aborting —
   * checked independently of which terminal status fired (`applyStatus` can
   * be `'failed'` or `'aborted'` and still carry `partialApply: true`;
   * gating on `applyStatus === 'failed'` alone would miss the
   * abort-mid-apply case).
   */
  const applyPartial = applyRecord?.partialApply === true;

  return (
    <div className="mx-auto flex max-w-4xl flex-col gap-6">
      <PageHeader title="Infrastructure" subtitle="Plan, review, and apply infrastructure changes directly from the app.">
        <Link to="/iac/history" className="text-sm text-[var(--color-primary)] underline underline-offset-2">
          View history
        </Link>
      </PageHeader>

      {!planRunId && (
        <div className="flex flex-col gap-3">
          <Button onClick={() => submitPlan()} disabled={planning}>
            {planning ? <Loader2 className="animate-spin" /> : <Play />}
            Run plan
          </Button>
          {planStaleLock ? (
            <StaleLockBanner
              staleLock={planStaleLock}
              nowMs={now}
              onCleared={() => {
                setPlanStaleLock(null);
                // Otherwise the stale rejection's error text (still sitting
                // in planSubmitError, never touched by a successful clear)
                // would reappear the instant the ternary above falls through
                // to the BusyBanner/ErrorBanner branch — a red "error" banner
                // for an action that just succeeded.
                setPlanSubmitError(null);
              }}
            />
          ) : (
            <>
              {planConflict && (
                <BusyBanner
                  conflict={planConflict}
                  // plan never acquires the durable RunLock (see the
                  // "ack.runLock is never set for `plan`" comment in
                  // submitPlan above), so there is never a runLock to pass
                  // here — this instance's "Clear lock and retry" action
                  // never renders.
                  nowMs={now}
                  onCleared={() => {
                    setPlanConflict(null);
                    // See the identical comment on the stale-lock banner's onCleared above.
                    setPlanSubmitError(null);
                  }}
                />
              )}
              {planSubmitError && <ErrorBanner>{planSubmitError}</ErrorBanner>}
            </>
          )}
        </div>
      )}

      {planRunId && (
        <section className="flex flex-col gap-3" aria-label="Plan run">
          <div className="flex items-center justify-between">
            <h3 className="text-lg font-semibold text-[var(--color-foreground)]">Plan</h3>
            {planFinished && <ChangeSummaryStatus summary={planRecord?.changeSummary} />}
          </div>

          {planRecord?.rolledBackFrom && (
            <p className="text-sm text-[var(--color-muted-foreground)]">
              Rollback of{' '}
              <Link
                to={`/iac/history/${planRecord.rolledBackFrom}`}
                className="text-[var(--color-primary)] underline underline-offset-2"
              >
                apply run {planRecord.rolledBackFrom}
              </Link>
            </p>
          )}

          <AnsiLogViewer chunks={planLog.chunks} emptyMessage="Waiting for plan output…" />

          {planLog.error && <ErrorBanner>{`Log stream error: ${planLog.error}`}</ErrorBanner>}

          {planFailed && (
            <ErrorBanner>
              {`Plan ${planStatus === 'aborted' ? 'was aborted' : 'failed'} — see the log above for details.`}
            </ErrorBanner>
          )}

          {planFinished && !planFailed && !approval && (
            <div className="flex flex-col gap-2">
              <Button onClick={submitApprove} disabled={approving || !awaitingApproval}>
                {approving ? <Loader2 className="animate-spin" /> : <ShieldCheck />}
                Approve plan
              </Button>
              {approveError && <ErrorBanner>{approveError}</ErrorBanner>}
            </div>
          )}

          {approval && (
            <div className="flex flex-col gap-3 rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--color-surface)] p-3">
              <p className="text-sm text-[var(--color-foreground)]">
                Approved by <strong>{approval.approvedBy}</strong> at{' '}
                {new Date(approval.approvedAt).toLocaleString()}
                {approvalExpired ? (
                  <span className="ml-2 text-[var(--color-amber)]">— approval expired, re-approve to apply</span>
                ) : (
                  <span className="ml-2 text-[var(--color-muted-foreground)]">
                    — expires {new Date(new Date(approval.approvedAt).getTime() + APPROVAL_WINDOW_MS).toLocaleTimeString()}
                  </span>
                )}
              </p>

              {approvalExpired && (
                <Button onClick={submitApprove} disabled={approving} variant="secondary" className="self-start">
                  {approving ? <Loader2 className="animate-spin" /> : <ShieldCheck />}
                  Re-approve
                </Button>
              )}

              {!applyRunId && (
                <div className="flex flex-col gap-2">
                  <Button onClick={submitApply} disabled={applying || !canApply} className="self-start">
                    {applying ? <Loader2 className="animate-spin" /> : <Play />}
                    Apply
                  </Button>
                  {applyStaleLock ? (
                    <StaleLockBanner
                      staleLock={applyStaleLock}
                      nowMs={now}
                      onCleared={() => {
                        setApplyStaleLock(null);
                        // See the identical comment on the plan banner above.
                        setApplySubmitError(null);
                      }}
                    />
                  ) : (
                    <>
                      {applyConflict && (
                        <BusyBanner
                          conflict={applyConflict}
                          runLock={applyRunLock ?? undefined}
                          nowMs={now}
                          onCleared={() => {
                            setApplyConflict(null);
                            setApplyRunLock(null);
                            // See the identical comment on the stale-lock banner's onCleared above.
                            setApplySubmitError(null);
                          }}
                        />
                      )}
                      {applySubmitError && <ErrorBanner>{applySubmitError}</ErrorBanner>}
                    </>
                  )}
                </div>
              )}
            </div>
          )}

          {applyRunId && (
            <section className="flex flex-col gap-3" aria-label="Apply run">
              <div className="flex items-center justify-between">
                <h3 className="text-lg font-semibold text-[var(--color-foreground)]">Apply</h3>
                {applyFinished ? (
                  <ChangeSummaryStatus summary={applyRecord?.changeSummary} />
                ) : (
                  <span role="status" className="flex items-center gap-1.5 text-sm text-[var(--color-muted-foreground)]">
                    <Loader2 className="size-4 animate-spin" aria-hidden="true" />
                    Applying…
                  </span>
                )}
              </div>

              <AnsiLogViewer chunks={applyLog.chunks} emptyMessage="Waiting for apply output…" />

              {applyLog.error && <ErrorBanner>{`Log stream error: ${applyLog.error}`}</ErrorBanner>}
              {!applyFinished && applySubmitError && <ErrorBanner>{applySubmitError}</ErrorBanner>}

              {applyPartial ? (
                <PartialApplyBanner onStartOver={startOver} />
              ) : (applyStatus === 'failed' || applyStatus === 'aborted') ? (
                <ErrorBanner>
                  {`Apply ${applyStatus === 'aborted' ? 'was aborted' : 'failed'} — see the log above for details.`}
                </ErrorBanner>
              ) : null}

              {applyStatus === 'success' && (
                <div
                  role="status"
                  className="flex items-center gap-2 rounded-[var(--radius-sm)] border border-[var(--color-green)]/40 bg-[var(--color-green)]/10 px-3 py-2 text-sm text-[var(--color-green)]"
                >
                  <CheckCircle2 className="size-4 shrink-0" aria-hidden="true" />
                  Apply complete.
                  <Link to="/" className="ml-1 underline underline-offset-2">
                    View dashboard
                  </Link>
                </div>
              )}
            </section>
          )}

          {/*
            The partial-apply banner above already embeds its own "Start
            over" button — suppress this generic one in that case so the
            guided next step isn't duplicated on screen.
          */}
          {!applyPartial &&
            (planFailed || applyStatus === 'success' || applyStatus === 'failed' || applyStatus === 'aborted') && (
              <Button onClick={startOver} variant="secondary" className="self-start">
                <RotateCcw />
                Start over
              </Button>
            )}
        </section>
      )}

      <section
        className="flex flex-col gap-3 rounded-[var(--radius-md)] border border-[var(--color-red)]/40 bg-[var(--color-red)]/5 p-4"
        aria-label="Destroy infrastructure"
      >
        <div className="flex items-center gap-2">
          <AlertTriangle className="size-5 shrink-0 text-[var(--color-red)]" aria-hidden="true" />
          <h3 className="text-lg font-semibold text-[var(--color-foreground)]">Destroy infrastructure</h3>
        </div>
        <p className="text-sm text-[var(--color-muted-foreground)]">
          Runs a Pulumi destroy, tearing down every resource this app manages. This cannot be undone from
          here — game servers, storage, and networking are all removed.
        </p>

        {!destroyRunId && (
          <div className="flex flex-col gap-3">
            <Button
              variant="destructive"
              onClick={() => setDestroyConfirmOpen(true)}
              disabled={destroying}
              className="self-start"
            >
              {destroying ? <Loader2 className="animate-spin" /> : <Trash2 />}
              Destroy infrastructure
            </Button>
            {destroyStaleLock ? (
              <StaleLockBanner
                staleLock={destroyStaleLock}
                nowMs={now}
                onCleared={() => {
                  setDestroyStaleLock(null);
                  // See the identical comment on the plan banner above.
                  setDestroySubmitError(null);
                }}
              />
            ) : (
              <>
                {destroyConflict && (
                  <BusyBanner
                    conflict={destroyConflict}
                    runLock={destroyRunLock ?? undefined}
                    nowMs={now}
                    onCleared={() => {
                      setDestroyConflict(null);
                      setDestroyRunLock(null);
                      // See the identical comment on the stale-lock banner's onCleared above.
                      setDestroySubmitError(null);
                    }}
                  />
                )}
                {destroySubmitError && <ErrorBanner>{destroySubmitError}</ErrorBanner>}
              </>
            )}
          </div>
        )}

        <ConfirmDialog
          open={destroyConfirmOpen}
          onOpenChange={setDestroyConfirmOpen}
          title="Destroy all managed infrastructure?"
          description={
            `This runs a Pulumi destroy and tears down every resource this app manages — game servers, ` +
            `storage, and networking. It cannot be undone from here. Type "${DESTROY_CONFIRM_PHRASE}" to confirm.`
          }
          onConfirm={submitDestroy}
          confirmLabel={destroying ? 'Destroying…' : 'Destroy'}
          typeToConfirm={DESTROY_CONFIRM_PHRASE}
        />

        {destroyRunId && (
          <div className="flex flex-col gap-3">
            <div className="flex items-center justify-between">
              <h4 className="text-sm font-semibold text-[var(--color-foreground)]">Destroy run</h4>
              {destroyFinished && <ChangeSummaryStatus summary={destroyRecord?.changeSummary} />}
            </div>

            <AnsiLogViewer chunks={destroyLog.chunks} emptyMessage="Waiting for destroy output…" />

            {destroyLog.error && <ErrorBanner>{`Log stream error: ${destroyLog.error}`}</ErrorBanner>}
            {!destroyFinished && destroySubmitError && <ErrorBanner>{destroySubmitError}</ErrorBanner>}

            {destroyStatus === 'failed' || destroyStatus === 'aborted' ? (
              <ErrorBanner>
                {`Destroy ${destroyStatus === 'aborted' ? 'was aborted' : 'failed'} — see the log above for details.`}
              </ErrorBanner>
            ) : null}

            {destroyStatus === 'success' && (
              <div
                role="status"
                className="flex items-center gap-2 rounded-[var(--radius-sm)] border border-[var(--color-green)]/40 bg-[var(--color-green)]/10 px-3 py-2 text-sm text-[var(--color-green)]"
              >
                <CheckCircle2 className="size-4 shrink-0" aria-hidden="true" />
                Destroy complete.
              </div>
            )}
          </div>
        )}
      </section>
    </div>
  );
}
