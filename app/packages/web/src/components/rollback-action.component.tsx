import { useState } from 'react';
import { Loader2 } from 'lucide-react';
import type { DeploymentConfigDiff } from '@hyveon/shared';
import { Button } from './ui/button.component.js';
import { ConfirmDialog } from './confirm-dialog.component.js';
import { formatTimestamp } from '@/lib/format.utils';
import { formatDiffSummary } from '@/lib/rollback-diff.utils';

/** Result of a confirmed rollback, handed to {@link RollbackActionProps.onRolledBack}. */
export interface RollbackResult {
  /** The freshly-restored configuration version, to plan against. */
  versionId: string;
  /** The apply run the restored version was resolved from — tags the resulting plan. */
  rolledBackFrom: string;
}

interface RollbackActionProps {
  /** The `runId` of the apply run to roll back. */
  applyRunId: string;
  /** Called once the rollback is confirmed and the historic configuration version has been restored as the new head. */
  onRolledBack: (result: RollbackResult) => void;
}

/**
 * "Rollback" action for an apply row in `/iac/history`.
 * Two-step flow, mirroring the backend's resolve-then-confirm split so
 * nothing is written until the operator has seen the target version:
 *
 * 1. Clicking the button calls `hyveon.iac.rollback.resolve` (read-only)
 *    to identify the configuration version that was live before this apply run, and
 *    opens a {@link ConfirmDialog} naming it.
 * 2. Confirming calls `hyveon.iac.rollback.confirm`, which restores that
 *    version's content as a new head. On success, {@link onRolledBack} fires
 *    with the new version id so the caller can route into the plan/apply
 *    run view with it (see `IacPage`'s `RollbackNavState`).
 *
 * A failure at either step — including "no earlier version exists" / "the
 * historic version has expired" — is surfaced inline via `role="alert"` and
 * never triggers `onRolledBack`; nothing is written on a resolve failure,
 * and the confirm step's own backend re-resolution means nothing is written
 * on a confirm failure either.
 *
 * ## Diff summary
 *
 * `iac.rollback.resolve`'s ack may also carry a `diff` — a best-effort
 * `DeploymentConfigDiff` summarizing how the target version differs from
 * the current configuration head (`PulumiService.computeRollbackDiff`).
 * When present, {@link formatDiffSummary} renders it as an extra sentence
 * appended to the confirmation dialog's description. When absent — the
 * diff computation degraded for any reason (network error, unparseable
 * configuration, etc.) — the dialog renders identify-target-only, no diff
 * line, never a broken/empty diff section. This graceful degradation is
 * deliberate per the `iac-rollback` spec: "identify the target version" is
 * a MUST; the diff summary is only a SHOULD-level enhancement layered on
 * top.
 */
export function RollbackAction({ applyRunId, onRolledBack }: RollbackActionProps) {
  const [resolving, setResolving] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [target, setTarget] = useState<{
    versionId: string;
    lastModified: string;
    diff?: DeploymentConfigDiff;
  } | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function handleClick() {
    if (!window.hyveon) {
      setError('IPC bridge (window.hyveon) is not available in this context.');
      return;
    }
    setError(null);
    setResolving(true);
    void (async () => {
      try {
        const ack = await window.hyveon!.iac.rollback.resolve({ applyRunId });
        if (ack.resolved && ack.versionId && ack.lastModified) {
          setTarget({ versionId: ack.versionId, lastModified: ack.lastModified, diff: ack.diff });
          setDialogOpen(true);
        } else {
          setError(ack.error ?? 'Could not resolve a rollback target.');
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setResolving(false);
      }
    })();
  }

  function handleConfirm() {
    if (!window.hyveon) return;
    setConfirming(true);
    void (async () => {
      try {
        const ack = await window.hyveon!.iac.rollback.confirm({ applyRunId });
        if (ack.confirmed && ack.versionId) {
          setDialogOpen(false);
          onRolledBack({ versionId: ack.versionId, rolledBackFrom: applyRunId });
        } else {
          setError(ack.error ?? 'Could not restore the historic configuration version.');
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setConfirming(false);
      }
    })();
  }

  return (
    <div className="flex flex-col items-end gap-1">
      <Button variant="secondary" size="sm" onClick={handleClick} disabled={resolving}>
        {resolving ? <Loader2 className="size-3.5 animate-spin" aria-hidden="true" /> : 'Rollback'}
      </Button>

      {error && (
        <p role="alert" className="text-xs text-[var(--color-red)]">
          {error}
        </p>
      )}

      {target && (
        <ConfirmDialog
          open={dialogOpen}
          onOpenChange={setDialogOpen}
          title="Roll back configuration?"
          description={
            `This restores configuration version ${target.versionId} (last modified ${formatTimestamp(target.lastModified)}) ` +
            'as the new head, then queues a plan against it. The current head is not deleted — history is append-only.' +
            (target.diff ? ` ${formatDiffSummary(target.diff)}` : '')
          }
          onConfirm={handleConfirm}
          confirmLabel={confirming ? 'Rolling back…' : 'Roll back'}
        />
      )}
    </div>
  );
}
