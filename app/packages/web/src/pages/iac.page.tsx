import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { toast } from 'sonner';
import { CheckCircle2, Loader2, Play, RotateCcw, ShieldCheck } from 'lucide-react';
import type { IacPlanPayload } from '@hyveon/desktop-preload';
import { errMessage } from '@hyveon/shared';
import { Button } from '../components/ui/button.component.js';
import { AnsiLogViewer } from '../components/ansi-log-viewer.component.js';
import { ErrorBanner } from '../components/error-banner.component.js';
import { PageHeader } from '../components/page-header.component.js';
import { RolledBackFromLink } from '../components/rolled-back-from-link.component.js';
import { DestroySection } from '../components/iac-destroy-section.component.js';
import { SubmissionBanners } from '../components/submission-banners.component.js';
import { ChangeSummaryStatus } from '../components/change-summary-status.component.js';
import { useIacRun } from '../hooks/use-iac-run.hook.js';

/**
 * `location.state` shape the rollback flow navigates to `/iac`
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

  const planRun = useIacRun('plan');
  const applyRun = useIacRun('apply');

  const [approval, setApproval] = useState<{ approvedBy: string; approvedAt: string } | null>(null);
  const [approving, setApproving] = useState(false);
  const [approveError, setApproveError] = useState<string | null>(null);

  const [now, setNow] = useState(() => Date.now());

  // Tick every 30s so the approval-staleness hint stays roughly fresh.
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(id);
  }, []);

  const submitPlan = useCallback(
    (payload?: IacPlanPayload) => {
      planRun.submit(async () => {
        const ack = await window.hyveon!.iac.plan(payload);
        // A (re)plan invalidates whatever approval/apply happened against the
        // previous plan run — reset both so a stale "Apply" doesn't linger
        // under the freshly-submitted plan.
        if (ack.started && ack.runId) {
          setApproval(null);
          setApproveError(null);
          applyRun.reset();
        }
        return ack;
      });
    },
    [planRun.submit, applyRun.reset],
  );

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
    if (!window.hyveon || !planRun.runId) return;
    setApproving(true);
    setApproveError(null);
    void (async () => {
      try {
        const ack = await window.hyveon!.iac.approve({ planRunId: planRun.runId! });
        if (ack.approved && ack.approvedBy && ack.approvedAt) {
          setApproval({ approvedBy: ack.approvedBy, approvedAt: ack.approvedAt });
          toast.success('Plan approved');
        } else {
          setApproveError(ack.error ?? 'Approval failed.');
        }
      } catch (err) {
        setApproveError(errMessage(err));
      } finally {
        setApproving(false);
      }
    })();
  }, [planRun.runId]);

  const submitApply = useCallback(() => {
    if (!planRun.runId || !planRun.record?.planHash) return;
    const planRunId = planRun.runId;
    const planHash = planRun.record.planHash;
    applyRun.submit(() => window.hyveon!.iac.apply({ planRunId, planHash }));
  }, [planRun.runId, planRun.record, applyRun.submit]);

  const startOver = useCallback(() => {
    setApproval(null);
    setApproveError(null);
    planRun.reset();
    applyRun.reset();
  }, [planRun.reset, applyRun.reset]);

  useEffect(() => {
    if (applyRun.status === 'success') toast.success('Apply complete');
  }, [applyRun.status]);

  const awaitingApproval = planRun.status === 'awaiting_approval';
  const planFinished = planRun.status !== null;
  const planFailed = planRun.status === 'failed' || planRun.status === 'aborted';
  const approvalExpired = approval ? isApprovalExpired(approval.approvedAt, now) : false;
  const canApply = Boolean(approval) && !approvalExpired && Boolean(planRun.record?.planHash) && !applyRun.runId;
  const applyFinished = applyRun.status !== null;
  /**
   * Whether the apply run mutated resources before failing/aborting —
   * checked independently of which terminal status fired (`applyRun.status`
   * can be `'failed'` or `'aborted'` and still carry `partialApply: true`;
   * gating on `applyRun.status === 'failed'` alone would miss the
   * abort-mid-apply case).
   */
  const applyPartial = applyRun.record?.partialApply === true;

  return (
    <div className="mx-auto flex max-w-4xl flex-col gap-6">
      <PageHeader title="Infrastructure" subtitle="Plan, review, and apply infrastructure changes directly from the app.">
        <Link to="/iac/history" className="text-sm text-[var(--color-primary)] underline underline-offset-2">
          View history
        </Link>
      </PageHeader>

      {!planRun.runId && (
        <div className="flex flex-col gap-3">
          <Button onClick={() => submitPlan()} disabled={planRun.inFlight}>
            {planRun.inFlight ? <Loader2 className="animate-spin" /> : <Play />}
            Run plan
          </Button>
          <SubmissionBanners
            staleLock={planRun.staleLock}
            conflict={planRun.conflict}
            submitError={planRun.submitError}
            nowMs={now}
            onCleared={planRun.reset}
          />
        </div>
      )}

      {planRun.runId && (
        <section className="flex flex-col gap-3" aria-label="Plan run">
          <div className="flex items-center justify-between">
            <h3 className="text-lg font-semibold text-[var(--color-foreground)]">Plan</h3>
            {planFinished && <ChangeSummaryStatus summary={planRun.record?.changeSummary} />}
          </div>

          {planRun.record?.rolledBackFrom && <RolledBackFromLink applyRunId={planRun.record.rolledBackFrom} />}

          <AnsiLogViewer chunks={planRun.log.chunks} emptyMessage="Waiting for plan output…" />

          {planRun.log.error && <ErrorBanner>{`Log stream error: ${planRun.log.error}`}</ErrorBanner>}

          {planFailed && (
            <ErrorBanner>
              {`Plan ${planRun.status === 'aborted' ? 'was aborted' : 'failed'} — see the log above for details.`}
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

              {!applyRun.runId && (
                <div className="flex flex-col gap-2">
                  <Button onClick={submitApply} disabled={applyRun.inFlight || !canApply} className="self-start">
                    {applyRun.inFlight ? <Loader2 className="animate-spin" /> : <Play />}
                    Apply
                  </Button>
                  <SubmissionBanners
                    staleLock={applyRun.staleLock}
                    conflict={applyRun.conflict}
                    runLock={applyRun.runLock}
                    submitError={applyRun.submitError}
                    nowMs={now}
                    onCleared={applyRun.reset}
                  />
                </div>
              )}
            </div>
          )}

          {applyRun.runId && (
            <section className="flex flex-col gap-3" aria-label="Apply run">
              <div className="flex items-center justify-between">
                <h3 className="text-lg font-semibold text-[var(--color-foreground)]">Apply</h3>
                {applyFinished ? (
                  <ChangeSummaryStatus summary={applyRun.record?.changeSummary} />
                ) : (
                  <span role="status" className="flex items-center gap-1.5 text-sm text-[var(--color-muted-foreground)]">
                    <Loader2 className="size-4 animate-spin" aria-hidden="true" />
                    Applying…
                  </span>
                )}
              </div>

              <AnsiLogViewer chunks={applyRun.log.chunks} emptyMessage="Waiting for apply output…" />

              {applyRun.log.error && <ErrorBanner>{`Log stream error: ${applyRun.log.error}`}</ErrorBanner>}
              {!applyFinished && applyRun.submitError && <ErrorBanner>{applyRun.submitError}</ErrorBanner>}

              {applyPartial ? (
                <PartialApplyBanner onStartOver={startOver} />
              ) : (applyRun.status === 'failed' || applyRun.status === 'aborted') ? (
                <ErrorBanner>
                  {`Apply ${applyRun.status === 'aborted' ? 'was aborted' : 'failed'} — see the log above for details.`}
                </ErrorBanner>
              ) : null}

              {applyRun.status === 'success' && (
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
            (planFailed ||
              applyRun.status === 'success' ||
              applyRun.status === 'failed' ||
              applyRun.status === 'aborted') && (
              <Button onClick={startOver} variant="secondary" className="self-start">
                <RotateCcw />
                Start over
              </Button>
            )}
        </section>
      )}

      <DestroySection nowMs={now} />
    </div>
  );
}
