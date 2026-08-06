import { useCallback, useEffect, useState } from 'react';
import { CheckCircle2, Circle, Loader2, RotateCcw, XCircle } from 'lucide-react';
import type { StackInitPhase, StackInitPhaseEvent } from '@hyveon/desktop-preload';
import { Button } from '@/components/ui/button.component';

/** Per-phase status this step tracks, derived from the {@link StackInitPhaseEvent} stream. */
export type StackInitPhaseState = 'pending' | 'in-progress' | 'done' | 'failed';

/** Overall status of one `iac.stack.initialize()` attempt. */
export type StackInitStatus = 'running' | 'success' | 'failed';

/** Reported when the step is rendered outside Electron, where there is no IPC bridge to initialize the stack through. */
const BRIDGE_UNAVAILABLE = 'IPC bridge (window.hyveon) is not available in this context.';

/**
 * The three provisioning phases {@link StackInitializationStep} renders, in
 * display order — mirrors `PulumiProvisioningPhase`'s `'engine' | 'plugins' | 'operation'`
 * union, defined in `PulumiEngineService.ts` (desktop-main). Kept as a plain
 * ordered tuple (rather than deriving order from whichever events happen to
 * arrive first) so every phase renders as a pending row from the very first
 * paint, before any event has arrived.
 */
const PHASE_ORDER: readonly StackInitPhase[] = ['engine', 'plugins', 'operation'];

/**
 * Operator-facing label for each {@link StackInitPhase} — see
 * `PulumiService.initializeStack`'s own TSDoc for exactly what each phase
 * does under the hood (engine resolution, an explicit `@pulumi/aws` provider
 * plugin install, then a `pulumi refresh` against the new, empty stack).
 */
const PHASE_LABELS: Record<StackInitPhase, string> = {
  engine: 'Resolving the Pulumi engine',
  plugins: 'Installing provider plugins',
  operation: 'Creating the stack',
};

/** Props for {@link StackInitializationStep}. */
export interface StackInitializationStepProps {
  /** Invoked once stack initialization succeeds and `wizard.complete` has been persisted. */
  onFinished: () => void;
  /**
   * Awaited before `wizard.complete` runs, on the same "Finish" click. Used
   * by Settings' Reconfigure flow (#211) to commit its buffered
   * `wizard.state.save` call in one shot rather than persisting each step as
   * the operator advances — a rejection here surfaces via the same
   * `finishError` path as a `wizard.complete` failure, and `wizard.complete`
   * is never called if it rejects. Omitted (and skipped) during the regular
   * first-run flow, which already persists `pick-cloud`/`credentials` as it goes.
   */
  onBeforeFinish?: () => Promise<void>;
}

/**
 * A fresh, all-pending phase map — the starting state for every attempt.
 */
function pendingPhases(): Record<StackInitPhase, StackInitPhaseState> {
  return { engine: 'pending', plugins: 'pending', operation: 'pending' };
}

/**
 * Final step of the first-run wizard: initializes the one Pulumi stack this
 * app manages via `hyveon.iac.stack.initialize()`, rendering a
 * 3-step progress checklist (engine resolution → plugin install → stack
 * creation) as `StackInitPhaseEvent`s stream in, rather than the scrolling
 * ANSI log the deleted pre-migration `init` step rendered — there is no log
 * output to show here, only coarse start/end phase transitions (see
 * `PulumiService.initializeStack`'s own TSDoc for why the reporting is
 * necessarily coarse). The Finish button enables only once every phase
 * completes successfully; a failed phase shows an inline error plus a Retry
 * button, mirroring the deleted step's `RotateCcw` pattern.
 */
export function StackInitializationStep({ onFinished, onBeforeFinish }: StackInitializationStepProps) {
  const [attempt, setAttempt] = useState(0);
  const [finishing, setFinishing] = useState(false);
  const [finishError, setFinishError] = useState<string | null>(null);

  /**
   * State of one `iac.stack.initialize()` attempt, tagged with the `attempt`
   * that produced it — mirrors the deleted pre-migration init step's identical
   * tagging so Retry presents a clean slate without the effect synchronously
   * clearing state on the way in (`react-hooks/set-state-in-effect`).
   */
  const [run, setRun] = useState<{
    attempt: number;
    phases: Record<StackInitPhase, StackInitPhaseState>;
    status: StackInitStatus;
    errorMessage: string | null;
  } | null>(null);

  const bridgeAvailable = Boolean(window.hyveon);
  const isCurrent = run !== null && run.attempt === attempt;
  const phases = isCurrent ? run.phases : pendingPhases();
  const status: StackInitStatus = !bridgeAvailable ? 'failed' : isCurrent ? run.status : 'running';
  const errorMessage = !bridgeAvailable ? BRIDGE_UNAVAILABLE : isCurrent ? run.errorMessage : null;

  useEffect(() => {
    if (!window.hyveon) return;
    const handle = window.hyveon.iac.stack.initialize();
    let cancelled = false;

    /** Fold an update into this attempt's run state, ignoring any superseded attempt. */
    const update = (
      apply: (prev: {
        phases: Record<StackInitPhase, StackInitPhaseState>;
        status: StackInitStatus;
        errorMessage: string | null;
      }) => {
        phases: Record<StackInitPhase, StackInitPhaseState>;
        status: StackInitStatus;
        errorMessage: string | null;
      },
    ) =>
      setRun((prev) => {
        const base =
          prev && prev.attempt === attempt
            ? prev
            : { attempt, phases: pendingPhases(), status: 'running' as StackInitStatus, errorMessage: null };
        return { attempt, ...apply(base) };
      });

    void (async () => {
      /** The phase whose `'start'` most recently fired without a matching `'end'` yet — the phase to blame if the stream throws. */
      let lastStartedPhase: StackInitPhase | null = null;
      try {
        for await (const event of handle) {
          if (cancelled) break;
          applyEvent(event);
        }
        if (!cancelled) update((prev) => ({ ...prev, status: 'success' }));
      } catch (err) {
        if (!cancelled) {
          update((prev) => ({
            ...prev,
            phases: lastStartedPhase ? { ...prev.phases, [lastStartedPhase]: 'failed' } : prev.phases,
            status: 'failed',
            errorMessage: err instanceof Error ? err.message : 'Stack initialization failed.',
          }));
        }
      }

      /** Applies one streamed phase event to this attempt's phase map, tracking {@link lastStartedPhase} for the catch block above. */
      function applyEvent(event: StackInitPhaseEvent) {
        if (event.status === 'start') lastStartedPhase = event.phase;
        update((prev) => ({
          ...prev,
          phases: { ...prev.phases, [event.phase]: event.status === 'start' ? 'in-progress' : 'done' },
        }));
      }
    })();

    return () => {
      cancelled = true;
      // Optional chaining guards against a test double that stubbed
      // `iac.stack.initialize` without configuring a return value
      // (`undefined`) — the real bridge's `initialize()` always returns a
      // handle.
      handle?.cancel();
    };
  }, [attempt]);

  const retry = useCallback(() => setAttempt((a) => a + 1), []);

  async function finish() {
    if (!window.hyveon) {
      setFinishError(BRIDGE_UNAVAILABLE);
      return;
    }
    setFinishing(true);
    setFinishError(null);
    try {
      await onBeforeFinish?.();
      await window.hyveon.wizard.complete();
      onFinished();
    } catch (err) {
      setFinishError(err instanceof Error ? err.message : 'Failed to finish setup.');
    } finally {
      setFinishing(false);
    }
  }

  return (
    <div className="space-y-4">
      <p className="text-sm text-muted-foreground">
        Initializing your Pulumi stack. This resolves the deployment engine, installs the required provider
        plugins, and creates the stack against your new backend.
      </p>

      <ul className="space-y-2" aria-label="Stack initialization progress">
        {PHASE_ORDER.map((phase) => (
          <PhaseRow key={phase} label={PHASE_LABELS[phase]} state={phases[phase]} />
        ))}
      </ul>

      {status === 'failed' && (
        <div className="space-y-2">
          <p role="alert" className="text-sm text-[var(--color-red)]">
            {errorMessage ?? 'Stack initialization failed — see above for which step failed.'}
          </p>
          <Button type="button" variant="outline" onClick={retry}>
            <RotateCcw className="size-4" />
            Retry
          </Button>
        </div>
      )}

      {status === 'success' && (
        <div className="flex items-center gap-2 text-sm text-[var(--color-green)]">
          <CheckCircle2 className="size-4" />
          Stack initialization complete.
        </div>
      )}

      {finishError && (
        <p role="alert" className="text-sm text-[var(--color-red)]">
          {finishError}
        </p>
      )}

      <Button type="button" onClick={() => void finish()} disabled={status !== 'success' || finishing}>
        {finishing && <Loader2 className="animate-spin" />}
        Finish setup
      </Button>
    </div>
  );
}

/** One row of the phase checklist: an icon reflecting {@link StackInitPhaseState}, plus the phase's operator-facing label. */
function PhaseRow({ label, state }: { label: string; state: StackInitPhaseState }) {
  return (
    <li className="flex items-center gap-2 text-sm">
      <PhaseIcon state={state} />
      <span className={state === 'pending' ? 'text-muted-foreground' : undefined}>{label}</span>
    </li>
  );
}

/** Icon for one {@link StackInitPhaseState} — pending circle → spinner → checkmark, or an X on failure. */
function PhaseIcon({ state }: { state: StackInitPhaseState }) {
  switch (state) {
    case 'pending':
      return <Circle className="size-4 text-muted-foreground" aria-hidden="true" />;
    case 'in-progress':
      return <Loader2 className="size-4 animate-spin text-[var(--color-primary)]" aria-hidden="true" />;
    case 'done':
      return <CheckCircle2 className="size-4 text-[var(--color-green)]" aria-hidden="true" />;
    case 'failed':
      return <XCircle className="size-4 text-[var(--color-red)]" aria-hidden="true" />;
  }
}
