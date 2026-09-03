import { useCallback, useEffect, useState } from 'react';
import { toast } from 'sonner';
import { AlertTriangle, CheckCircle2, Loader2, Trash2 } from 'lucide-react';
import { Button } from './ui/button.component.js';
import { AnsiLogViewer } from './ansi-log-viewer.component.js';
import { ConfirmDialog } from './confirm-dialog.component.js';
import { ErrorBanner } from './error-banner.component.js';
import { useIacRun } from '../hooks/use-iac-run.hook.js';
import { ChangeSummaryStatus } from './change-summary-status.component.js';
import { SubmissionBanners } from './submission-banners.component.js';

/**
 * Exact phrase an operator must type into the destroy confirmation dialog
 * before the destructive button enables — the UI's
 * defense-in-depth layer; the token minted on confirm is what the backend
 * actually trusts (see `PulumiService.assertFreshDestroyConfirmation`).
 */
const DESTROY_CONFIRM_PHRASE = 'destroy infrastructure';

/**
 * "Destroy infrastructure" section of the Plan/Apply page (`/iac`) — its own heading, warning copy,
 * type-to-confirm dialog, and run/log/status block, all driven by an independent `useIacRun('destroy')`
 * call. Shares no state with the plan-approve-apply flow rendered above it on `IacPage`: a destroy can be
 * submitted regardless of whatever plan/apply is in progress, since it is the *shared Pulumi workspace* (via
 * `PulumiOperationInFlightError`/`RunLockHeldError`, surfaced here through the same `SubmissionBanners`)
 * that actually serializes them, not any renderer-side state.
 *
 * @param nowMs - Current time in ms (`IacPage`'s own 30s-ticking clock) — threaded through to
 *   `SubmissionBanners`' stale/busy-lock banners for their "ago" display.
 */
export function DestroySection({ nowMs }: { nowMs: number }) {
  const [destroyConfirmOpen, setDestroyConfirmOpen] = useState(false);
  const destroyRun = useIacRun('destroy');

  // Mint-then-confirm happens as one submission: a mint failure is just as
  // much a failed destroy attempt as the destroy call itself rejecting, so
  // both are caught by useIacRun's submit() the same way. The confirmation
  // dialog only closes once the destroy actually starts — a rejected
  // submission's banner renders behind the still-open dialog so the
  // operator sees why before retrying.
  const submitDestroy = useCallback(() => {
    destroyRun.submit(async () => {
      const mintAck = await window.hyveon!.iac.mintDestroyToken();
      const ack = await window.hyveon!.iac.destroy({ confirmationToken: mintAck.token });
      if (ack.started && ack.runId) setDestroyConfirmOpen(false);
      return ack;
    });
  }, [destroyRun]);

  useEffect(() => {
    if (destroyRun.status === 'success') toast.success('Destroy complete');
  }, [destroyRun.status]);

  const destroyFinished = destroyRun.status !== null;

  return (
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

      {!destroyRun.runId && (
        <div className="flex flex-col gap-3">
          <Button
            variant="destructive"
            onClick={() => setDestroyConfirmOpen(true)}
            disabled={destroyRun.inFlight}
            className="self-start"
          >
            {destroyRun.inFlight ? <Loader2 className="animate-spin" /> : <Trash2 />}
            Destroy infrastructure
          </Button>
          <SubmissionBanners
            staleLock={destroyRun.staleLock}
            conflict={destroyRun.conflict}
            runLock={destroyRun.runLock}
            submitError={destroyRun.submitError}
            nowMs={nowMs}
            onCleared={destroyRun.reset}
          />
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
        confirmLabel={destroyRun.inFlight ? 'Destroying…' : 'Destroy'}
        typeToConfirm={DESTROY_CONFIRM_PHRASE}
      />

      {destroyRun.runId && (
        <div className="flex flex-col gap-3">
          <div className="flex items-center justify-between">
            <h4 className="text-sm font-semibold text-[var(--color-foreground)]">Destroy run</h4>
            {destroyFinished && <ChangeSummaryStatus summary={destroyRun.record?.changeSummary} />}
          </div>

          <AnsiLogViewer chunks={destroyRun.log.chunks} emptyMessage="Waiting for destroy output…" />

          {destroyRun.log.error && <ErrorBanner>{`Log stream error: ${destroyRun.log.error}`}</ErrorBanner>}
          {!destroyFinished && destroyRun.submitError && <ErrorBanner>{destroyRun.submitError}</ErrorBanner>}

          {destroyRun.status === 'failed' || destroyRun.status === 'aborted' ? (
            <ErrorBanner>
              {`Destroy ${destroyRun.status === 'aborted' ? 'was aborted' : 'failed'} — see the log above for details.`}
            </ErrorBanner>
          ) : null}

          {destroyRun.status === 'success' && (
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
  );
}
