import { useCallback, useState } from 'react';
import { toast } from 'sonner';
import { Loader2 } from 'lucide-react';
import type { IacStaleLockInfo, RunLock } from '@hyveon/desktop-preload';
import { Button } from './ui/button.component.js';
import { ConfirmDialog } from './confirm-dialog.component.js';
import { ErrorBanner } from './error-banner.component.js';
import type { Conflict } from '../hooks/use-iac-run.hook.js';
import { BRIDGE_UNAVAILABLE } from '@/lib/bridge.utils';

/**
 * Operator-facing label for each {@link Conflict} value — maps the raw
 * Pulumi operation name to the term the plan/apply/destroy buttons use
 * ("plan"/"apply"), so the busy banner reads naturally instead of surfacing
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
      setClearError(BRIDGE_UNAVAILABLE);
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
 * for field. Duplicated here rather than imported (the renderer bundle has
 * no reason to depend on `desktop-main`'s source, and this is a small,
 * stable, purely-cosmetic formatting rule). Deliberately coarse
 * (minutes/hours/days) — an operator deciding whether a lock is stale cares
 * whether it's "5 minutes old" (plausibly still in progress) vs. "3 days
 * old" (plausibly abandoned), not second-level precision.
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
 * Stale-lock/busy/submission-error banner shown under a plan/apply/destroy submission button —
 * collapses the identical `staleLock ? StaleLockBanner : (conflict && BusyBanner) + submitError`
 * ternary that used to be written out once per operation (plan/apply/destroy).
 *
 * Precedence matches the original per-operation logic: a stale backend lock ({@link StaleLockBanner})
 * is shown alone when present; otherwise a workspace-busy conflict ({@link BusyBanner}) and a plain
 * submission error render together, since the submit handlers always set `submitError` alongside
 * `conflict`.
 *
 * `onCleared` is expected to reset every one of the caller's `staleLock`/`conflict`/`runLock`/
 * `submitError` state slices for this operation — otherwise a stale error banner would reappear the
 * instant a successful clear falls through to the conflict/error branch.
 */
export function SubmissionBanners({
  staleLock,
  conflict,
  runLock,
  submitError,
  nowMs,
  onCleared,
}: {
  staleLock: IacStaleLockInfo | null;
  conflict: Conflict | null;
  /** Present only when the refusal was a durable {@link RunLockHeldError} — passed through to {@link BusyBanner}. */
  runLock?: RunLock | null;
  submitError: string | null;
  nowMs: number;
  onCleared: () => void;
}) {
  if (staleLock) {
    return <StaleLockBanner staleLock={staleLock} nowMs={nowMs} onCleared={onCleared} />;
  }
  return (
    <>
      {conflict && (
        <BusyBanner conflict={conflict} runLock={runLock ?? undefined} nowMs={nowMs} onCleared={onCleared} />
      )}
      {submitError && <ErrorBanner>{submitError}</ErrorBanner>}
    </>
  );
}
