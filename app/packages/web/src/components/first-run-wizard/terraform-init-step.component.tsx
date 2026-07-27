import { useCallback, useEffect, useState } from 'react';
import { CheckCircle2, Loader2, RotateCcw } from 'lucide-react';
import type { TerraformInitConfig, TerraformRunChunk } from '@hyveon/desktop-preload';
import { Button } from '@/components/ui/button.component';
import { AnsiLogViewer } from '../ansi-log-viewer.component.js';

/** Terminal state of a single `terraform init` attempt. */
export type TerraformInitStatus = 'running' | 'success' | 'failed';

/** Reported when the step is rendered outside Electron, where there is no IPC bridge to run `terraform init` through. */
const BRIDGE_UNAVAILABLE = 'IPC bridge (window.hyveon) is not available in this context.';

/** Props for {@link TerraformInitStep}. */
export interface TerraformInitStepProps {
  /**
   * Backend bucket/region/lock-table config, derived from the bootstrap
   * step's resource names and the credentials step's region. Callers should
   * memoize this so its identity is stable across renders — a new object
   * reference on every render would re-trigger the streaming effect below.
   */
  backendConfig: TerraformInitConfig;
  /** Invoked once `terraform init` succeeds and `wizard.complete` has been persisted. */
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
 * Fifth and final step of the first-run wizard (#210): runs `terraform init`
 * against the backend resources bootstrapped in the previous step, streaming
 * its ANSI-colored output live via the already-shipped `hyveon.terraform.init`
 * async iterable (reusing `AnsiLogViewer` rather than adding a second
 * streaming side-channel, per design.md decision 2). The Finish button
 * enables only once the run exits successfully (the iterable completes
 * without throwing); a failed run shows the captured log plus a Retry
 * button rather than silently blocking wizard progression.
 */
export function TerraformInitStep({ backendConfig, onFinished, onBeforeFinish }: TerraformInitStepProps) {
  const [attempt, setAttempt] = useState(0);
  const [finishing, setFinishing] = useState(false);
  const [finishError, setFinishError] = useState<string | null>(null);

  /**
   * Output of one `terraform init` invocation, tagged with the `attempt` that
   * produced it. Tagging is what lets Retry present a clean slate without the
   * effect synchronously clearing `chunks`/`status`/`errorMessage` on the way
   * in (`react-hooks/set-state-in-effect`) — a bumped `attempt` no longer
   * matches, so the previous run's output stops being rendered immediately.
   */
  const [run, setRun] = useState<{
    attempt: number;
    chunks: TerraformRunChunk[];
    status: TerraformInitStatus;
    errorMessage: string | null;
  } | null>(null);

  const bridgeAvailable = Boolean(window.hyveon);
  const isCurrent = run !== null && run.attempt === attempt;
  const chunks = isCurrent ? run.chunks : [];
  const status: TerraformInitStatus = !bridgeAvailable ? 'failed' : isCurrent ? run.status : 'running';
  const errorMessage = !bridgeAvailable ? BRIDGE_UNAVAILABLE : isCurrent ? run.errorMessage : null;

  useEffect(() => {
    if (!window.hyveon) return;
    const controller = new AbortController();
    let cancelled = false;

    /** Fold an update into this attempt's run state, ignoring any superseded attempt. */
    const update = (
      apply: (prev: { chunks: TerraformRunChunk[]; status: TerraformInitStatus; errorMessage: string | null }) => {
        chunks: TerraformRunChunk[];
        status: TerraformInitStatus;
        errorMessage: string | null;
      },
    ) =>
      setRun((prev) => {
        const base =
          prev && prev.attempt === attempt
            ? prev
            : { attempt, chunks: [], status: 'running' as TerraformInitStatus, errorMessage: null };
        return { attempt, ...apply(base) };
      });

    void (async () => {
      try {
        for await (const chunk of window.hyveon!.terraform.init(backendConfig, controller.signal)) {
          if (cancelled) break;
          update((prev) => ({ ...prev, chunks: [...prev.chunks, chunk] }));
        }
        if (!cancelled) update((prev) => ({ ...prev, status: 'success' }));
      } catch (err) {
        if (!cancelled) {
          update((prev) => ({
            ...prev,
            status: 'failed',
            errorMessage: err instanceof Error ? err.message : 'terraform init failed.',
          }));
        }
      }
    })();

    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [backendConfig, attempt]);

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
        Running <code>terraform init</code> against your new backend. This wires Terraform up to the state bucket
        and lock table from the previous step.
      </p>

      <AnsiLogViewer chunks={chunks} emptyMessage="Waiting for terraform init output…" />

      {status === 'running' && (
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="size-4 animate-spin" />
          Running…
        </div>
      )}

      {status === 'failed' && (
        <div className="space-y-2">
          <p role="alert" className="text-sm text-[var(--color-red)]">
            {errorMessage ?? 'terraform init failed — see the log above for details.'}
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
          terraform init complete.
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
