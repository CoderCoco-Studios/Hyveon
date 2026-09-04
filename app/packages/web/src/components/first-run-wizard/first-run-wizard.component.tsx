/**
 * Shell for the first-run wizard: mirrors the add-game
 * wizard's step-flow pattern (shell owns step index + fetched state, one
 * component per step, pure helpers in `wizard.utils.ts`) but renders
 * full-page rather than in a `<Dialog>` — this wizard gates the entire app
 * before the dashboard is usable, so `app.component.tsx` renders it in place
 * of the normal routed layout while `wizardCompleted` is `false`.
 *
 * Five steps: pick-cloud, guided-iam (`add-one-click-aws-bootstrap`'s
 * one-click AWS access provisioning, inserted between pick-cloud and
 * credentials), credentials, bootstrap, and stack-init (the last of which
 * initializes the Pulumi stack and finishes the wizard).
 */
import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { CheckCircle2 } from 'lucide-react';
import { InlineAlert } from '@/components/inline-alert.component';
import { Button } from '@/components/ui/button.component';
import { ConfirmDialog } from '../confirm-dialog.component.js';
import { PickCloudStep, type CloudOption } from './pick-cloud-step.component.js';
import { CredentialsStep } from './credentials-step.component.js';
import { BootstrapStep } from './bootstrap-step.component.js';
import { GuidedIamStep } from './guided-iam-step.component.js';
import { StackInitializationStep } from './stack-init-step.component.js';
import { WizardStepSidebar } from './wizard-step-sidebar.component.js';
import { useBootstrapResources } from './use-bootstrap-resources.hook.js';
import { useWizardProgress } from './use-wizard-progress.hook.js';
import { useReconfigureAnswers, isGuidedProfile } from './use-reconfigure-answers.hook.js';
import { useAwsCredentialsForm } from './use-aws-credentials-form.hook.js';
import { STEP_LABELS, WIZARD_STEPS, type WizardStep } from './wizard.utils.js';
import { BRIDGE_UNAVAILABLE } from '@/lib/bridge.utils';

/** Props for {@link FirstRunWizard}. */
export interface FirstRunWizardProps {
  /** Invoked once the stack-init step's `wizard.complete` call succeeds. */
  onComplete?: () => void;
  /**
   * `'first-run'` (default) gates the whole app and runs all five steps
   * (including `guided-iam`, `add-one-click-aws-bootstrap`'s one-click AWS
   * access provisioning step), persisting `pick-cloud`/`credentials`/`bootstrap`
   * answers immediately via `wizard.state.save` as the operator advances.
   * `'reconfigure'` (launched from Settings) pre-marks
   * `pick-cloud`/`credentials`/`bootstrap` as completed with a per-step Edit
   * affordance, and buffers *edited* answers locally — a single
   * `wizard.state.save` call, containing only the steps actually opened via
   * Edit, commits right before `wizard.complete` runs. A step left collapsed
   * is never included in that call, so Cancel never has anything to undo for
   * it. `guided-iam` is pre-marked too, but conditionally, not unconditionally
   * like its three siblings above: only when `wizard.state.get()`'s
   * `aws?.profile` is the exact guided-provisioning profile name (see
   * `isGuidedProfile` below) — a manually picked profile or pasted key never
   * pre-completes it, and it renders as a live step in that case. This covers
   * the durable answer data only, not every side effect: the credentials
   * step's "paste keys instead" form and the bootstrap step's "Run
   * bootstrap"/"Check permissions" buttons already perform real, idempotent
   * IPC calls the moment they're clicked (same as `'first-run'`) — Cancel
   * doesn't undo those either, it just never points the *active*
   * `aws`/`bootstrap` config at their result.
   */
  mode?: 'first-run' | 'reconfigure';
  /** `'reconfigure'`-only: invoked when the operator cancels without finishing. Never called in `'first-run'` mode. */
  onCancel?: () => void;
}

/**
 * Self-contained first-run wizard: owns its own step index, the pick-cloud
 * selection, and the credentials-step state (profile list, mode, selection,
 * paste form). Fetches an initial AWS profile list on mount.
 */
export function FirstRunWizard({ onComplete, mode = 'first-run', onCancel }: FirstRunWizardProps = {}) {
  const steps = WIZARD_STEPS;
  const { stepIndex, setStepIndex, guidedIamInitialProgress, clearGuidedIamProgress } = useWizardProgress(mode);
  const [selectedCloud, setSelectedCloud] = useState<CloudOption>('aws');
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  /** First-run-only "Start over" affordance — see {@link handleReset}. */
  const [resetConfirmOpen, setResetConfirmOpen] = useState(false);
  const [resetting, setResetting] = useState(false);
  /** True while {@link GuidedIamStep} has an AWS-mutating IPC call in flight — see its `onBusyChange` prop's doc comment. Gates "Start over" so a reset can't race guided-IAM rotation's key mint/delete calls. */
  const [guidedIamBusy, setGuidedIamBusy] = useState(false);

  const credentials = useAwsCredentialsForm();

  const bootstrap = useBootstrapResources();

  // Whether the durably-stored AWS credential source is the guided-IAM
  // step's rotated profile (see `isGuidedProfile`) — drives the credentials
  // step's `satisfiedByGuidedProvisioning` prop. Re-derived on mount (so a
  // relaunch that resumes directly onto/past the credentials step, or a
  // reconfigure Edit on an already-guided profile, still renders the
  // satisfied summary) and again right after `GuidedIamStep`'s `onComplete`
  // fires (so completing it in the current session reflects immediately,
  // without waiting for a relaunch). Cleared locally by the credentials
  // step's "Switch to a different source" escape hatch — see
  // `handleSwitchCredentialSource` below.
  const [guidedCredentials, setGuidedCredentials] = useState<{ profile: string; region: string } | null>(null);

  /** Re-derives {@link guidedCredentials} from `wizard.state.get()` — see that state's own doc comment for when this runs. */
  const refreshGuidedCredentials = useCallback(async () => {
    if (!window.hyveon) return;
    try {
      const state = await window.hyveon.wizard.getState();
      const profile = state.aws?.profile;
      setGuidedCredentials(isGuidedProfile(profile) ? { profile: profile!, region: state.aws?.region ?? '' } : null);
    } catch {
      // Best-effort — falls back to the normal credentials form.
    }
  }, []);

  useEffect(() => {
    void (async () => {
      await refreshGuidedCredentials();
    })();
  }, [refreshGuidedCredentials]);

  const step = steps[stepIndex];

  const { completedSteps, startEdit, commitReconfigureAnswers } = useReconfigureAnswers({
    mode,
    selectedCloud,
    setSelectedCloud,
    credentials,
    resourceNames: bootstrap.names,
    setResourceNames: bootstrap.setNames,
  });

  function handleFinished() {
    onComplete?.();
  }

  /**
   * First-run-only "Start over" affordance — the operator-facing escape
   * hatch for a wizard stuck in a bad state, with no other route to recover
   * short of manually deleting files on disk. Not offered in `'reconfigure'`
   * mode, which already has its own Cancel action and operates on an
   * already-completed wizard.
   *
   * Reloads the window afterward rather than resetting this component's own
   * local state field-by-field: this component owns ~20 pieces of local
   * state across five steps, and `window.hyveon.wizard.getState()` /
   * `getProgress()` are the single source of truth a fresh mount already
   * re-derives everything from on load.
   */
  async function handleReset() {
    if (!window.hyveon) {
      setResetConfirmOpen(false);
      setSaveError(BRIDGE_UNAVAILABLE);
      return;
    }
    setResetting(true);
    try {
      await window.hyveon.wizard.reset();
      window.location.reload();
    } catch {
      setResetting(false);
      setResetConfirmOpen(false);
      setSaveError('Failed to reset the wizard. Try again.');
    }
  }

  /**
   * `GuidedIamStep`'s `onComplete` — guided provisioning finished and the
   * rotated key is now the active AWS credential. Re-derives
   * {@link guidedCredentials} immediately (rather than waiting for the next
   * mount) so the credentials step it advances into already renders the
   * satisfied summary, then advances past this step via {@link goNext}.
   * Awaits {@link refreshGuidedCredentials} before calling {@link goNext} —
   * firing them concurrently let `goNext` flip `stepIndex` to `credentials`
   * before `guidedCredentials` had re-derived, so the credentials step
   * briefly mounted its normal picker/paste form for one frame before
   * flipping to the satisfied summary. Sequencing them removes that flicker.
   * Like `stack-init-step.component.tsx`'s `onFinished`, this bypasses the
   * shared footer's Next button entirely — see the footer's `hideNextButton`
   * computation below for why Next is hidden for this step.
   *
   * Clears {@link guidedIamInitialProgress} before advancing — see that
   * state's own doc comment for why: leaving it set would let a later `Back`
   * navigation back onto `guided-iam` re-fire the save effect above with this
   * mount's now-stale value, overwriting whatever `GuidedIamStep` itself
   * persisted since.
   */
  async function handleGuidedIamComplete() {
    clearGuidedIamProgress();
    await refreshGuidedCredentials();
    void goNext();
  }

  /**
   * `GuidedIamStep`'s `onSkipToManual` — the operator chose "I already have
   * credentials" instead of guided provisioning. Advances past this step the
   * same way {@link handleGuidedIamComplete} does; no sub-state was
   * persisted for this path (see `GuidedIamStepProps.onSkipToManual`'s own
   * doc comment), so there is nothing to re-derive here. Clears
   * {@link guidedIamInitialProgress} for the same reason
   * {@link handleGuidedIamComplete} does.
   */
  function handleGuidedIamSkipToManual() {
    clearGuidedIamProgress();
    void goNext();
  }

  /**
   * Credentials step's "Switch to a different source" escape hatch off the
   * satisfied-by-guided-provisioning summary — clears the shell's own
   * {@link guidedCredentials} state so `CredentialsStep` falls through to
   * its normal picker/paste form. Deliberately does not touch the
   * underlying persisted `aws.profile`: the normal form's own Next-time
   * `wizard.state.save` call (see {@link goNext}) overwrites it once the
   * operator picks something else, exactly as it would for any other
   * credentials-step edit.
   */
  function handleSwitchCredentialSource() {
    setGuidedCredentials(null);
  }

  // Requires a non-empty region in both modes — this is persisted verbatim
  // (via `wizard.state.save({ aws: { profile, region } })` in `goNext`
  // below) into the same `ElectronStoreService.aws.region` field every
  // `PulumiService` operation — including `initializeStack`, the stack-init
  // step's own IPC call — reads at call time, so an empty region here would
  // otherwise silently reach that method as a missing region. A non-null
  // `guidedCredentials` short-circuits the form-field check: guided-IAM
  // completion never populates the credentials form's fields (it persists
  // `aws.profile`/`aws.region` directly via `GuidedIamService.rotate`), so
  // without this term Next stayed disabled on the satisfied-summary render.
  const credentialsChosen = guidedCredentials !== null || credentials.isFormComplete;

  // A collapsed (completed, not being edited) Reconfigure step already has a
  // real answer on record — Next should never be gated on this render's
  // local form state, which for an unopened step may not even be prefilled yet.
  const stepCollapsed = mode === 'reconfigure' && completedSteps.has(step);

  const advanceDisabled = stepCollapsed
    ? false
    : step === 'credentials'
      ? !credentialsChosen
      : step === 'bootstrap'
        ? !bootstrap.complete
        : false;

  // The shared footer's Next button is hidden for `stack-init` (it drives
  // its own completion via `onFinished`/Finish setup) and, the same way,
  // for `guided-iam` whenever it is NOT collapsed to a Reconfigure summary
  // — `GuidedIamStep` drives its own advancement via `onComplete`/
  // `onSkipToManual` (see those handlers above), so a shared Next button
  // would either duplicate that advancement or let the operator skip past
  // an incomplete guided flow. A COLLAPSED guided-iam summary (Reconfigure,
  // real evidence of prior guided provisioning already on record) is the
  // one case Next stays visible for this step, matching every other
  // pre-completed Reconfigure summary's "just click Next past it" behavior.
  const hideNextButton = step === 'stack-init' || (step === 'guided-iam' && !stepCollapsed);

  /**
   * Saves one step's answer via `wizard.state.save`, centralizing the
   * bridge-availability check, `saving`/`saveError` bookkeeping, and
   * fallback error message shared by every `goNext` save branch below.
   *
   * @param payload - Passed straight through to `wizard.state.save`.
   * @param fallbackErrorMessage - Shown when the rejection isn't an `Error`.
   * @returns Whether the save succeeded — `goNext` early-returns on `false`
   * so a failed save leaves the operator on the current step.
   */
  async function saveWizardState(
    payload: Parameters<NonNullable<typeof window.hyveon>['wizard']['saveState']>[0],
    fallbackErrorMessage: string,
  ): Promise<boolean> {
    if (!window.hyveon) {
      setSaveError(BRIDGE_UNAVAILABLE);
      return false;
    }
    setSaving(true);
    setSaveError(null);
    try {
      await window.hyveon.wizard.saveState(payload);
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : fallbackErrorMessage);
      setSaving(false);
      return false;
    }
    setSaving(false);
    return true;
  }

  /**
   * Advances past the current step. In `'first-run'` mode, leaving
   * `pick-cloud`, `credentials`, or `bootstrap` persists the choice via
   * {@link saveWizardState} immediately and stays put if that fails (the
   * `bootstrap` save is fire-and-forget, matching how `resourceNames` itself
   * has no failure UI — the resource-creation calls it feeds are what
   * actually gate progression). In `'reconfigure'` mode these answers are
   * buffered in local state instead — see {@link commitReconfigureAnswers},
   * called once from the stack-init step's Finish button — so a mid-flow
   * Cancel never has anything to undo.
   */
  async function goNext() {
    if (mode === 'first-run' && step === 'pick-cloud') {
      const saved = await saveWizardState({ activeCloud: selectedCloud }, 'Failed to save your cloud choice.');
      if (!saved) return;
    }
    // Skipped when `guidedCredentials` is still set: the satisfied-by-guided-
    // provisioning summary has no local form state to save — the credentials
    // form's fields are still untouched defaults — and `GuidedIamService.rotate`
    // already persisted `aws.profile`/`aws.region` directly. Saving here
    // would overwrite that with `{ profile: '', region: undefined }`.
    // "Switch to a different source" clears `guidedCredentials` first, so
    // this branch still runs normally once the operator picks something else.
    if (mode === 'first-run' && step === 'credentials' && !guidedCredentials) {
      const saved = await saveWizardState(
        { aws: credentials.toStatePayload() },
        'Failed to save your AWS credentials choice.',
      );
      if (!saved) return;
    }
    if (mode === 'first-run' && step === 'bootstrap' && window.hyveon) {
      // Durably records the (possibly operator-renamed) resource names so a
      // later Reconfigure can rehydrate them instead of falling back to
      // `defaultBootstrapResourceNames()`. Best-effort: nothing in this step
      // depends on the save succeeding, so a failure here doesn't block
      // progression the way the pick-cloud/credentials saves above do.
      window.hyveon.wizard.saveState({ bootstrap: bootstrap.names }).catch(() => {});
    }
    setStepIndex((index) => Math.min(index + 1, steps.length - 1));
  }

  function goBack() {
    setStepIndex((index) => Math.max(index - 1, 0));
  }

  return (
    <div className="min-h-screen flex items-center justify-center p-6">
      <div className="flex w-full max-w-[min(92vw,2000px)] justify-center gap-6">
        {mode === 'first-run' && <WizardStepSidebar steps={steps} currentIndex={stepIndex} labels={STEP_LABELS} />}
        <div className="w-full max-w-xl md:max-w-[clamp(672px,55vw,1500px)] rounded-[var(--radius-lg)] border border-[var(--color-border)] bg-[var(--color-surface-1)] p-8 space-y-6">
        <div>
          <h1 className="text-xl font-semibold">{mode === 'reconfigure' ? 'Reconfigure Hyveon' : 'Welcome to Hyveon'}</h1>
          <p className="text-sm text-muted-foreground">
            Step {stepIndex + 1} of {steps.length}: {STEP_LABELS[step]}
          </p>
        </div>

        <WizardStepPanel
          step="pick-cloud"
          activeStep={step}
          collapsed={stepCollapsed}
          label={STEP_LABELS['pick-cloud']}
          onEdit={() => startEdit('pick-cloud')}
          error={saveError}
        >
          <PickCloudStep selectedCloud={selectedCloud} onSelect={setSelectedCloud} />
        </WizardStepPanel>
        <WizardStepPanel
          step="guided-iam"
          activeStep={step}
          collapsed={stepCollapsed}
          label={STEP_LABELS['guided-iam']}
          onEdit={() => startEdit('guided-iam')}
        >
          <GuidedIamStep
            onComplete={handleGuidedIamComplete}
            onSkipToManual={handleGuidedIamSkipToManual}
            initialProgress={guidedIamInitialProgress}
            onBusyChange={setGuidedIamBusy}
          />
        </WizardStepPanel>
        <WizardStepPanel
          step="credentials"
          activeStep={step}
          collapsed={stepCollapsed}
          label={STEP_LABELS['credentials']}
          onEdit={() => startEdit('credentials')}
          error={saveError}
        >
          <CredentialsStep
            mode={credentials.credentialMode}
            onModeChange={credentials.setCredentialMode}
            profiles={credentials.profiles}
            profilesLoading={credentials.profilesLoading}
            profilesError={credentials.profilesError}
            selectedProfileName={credentials.selectedProfileName}
            onSelectProfile={credentials.selectProfile}
            region={credentials.region}
            onRegionChange={credentials.setRegion}
            pasteAccessKeyId={credentials.pasteAccessKeyId}
            pasteSecretAccessKey={credentials.pasteSecretAccessKey}
            pasteRegion={credentials.pasteRegion}
            onPasteFieldChange={credentials.onPasteFieldChange}
            onSubmitPaste={credentials.submitPaste}
            pasteSaving={credentials.pasteSaving}
            pasteError={credentials.pasteError}
            pastedProfileName={credentials.pastedProfileName}
            satisfiedByGuidedProvisioning={
              guidedCredentials
                ? { principal: 'AWS account (guided setup)', region: guidedCredentials.region }
                : undefined
            }
            onSwitchSource={handleSwitchCredentialSource}
          />
        </WizardStepPanel>
        <WizardStepPanel
          step="bootstrap"
          activeStep={step}
          collapsed={stepCollapsed}
          label={STEP_LABELS['bootstrap']}
          onEdit={() => startEdit('bootstrap')}
        >
          <BootstrapStep
            names={bootstrap.names}
            statuses={bootstrap.statuses}
            messages={bootstrap.messages}
            onNameChange={bootstrap.onNameChange}
            onRunBootstrap={bootstrap.runBootstrap}
            bootstrapping={bootstrap.bootstrapping}
            runsTableStatus={bootstrap.runsTable.status}
            runsTableMessage={bootstrap.runsTable.message}
            deploymentConfigStatus={bootstrap.deploymentConfig.status}
            deploymentConfigMessage={bootstrap.deploymentConfig.message}
            iamCheck={bootstrap.iam.check}
            iamChecking={bootstrap.iam.checking}
            iamError={bootstrap.iam.error}
            onRunIamCheck={bootstrap.runIamCheck}
          />
        </WizardStepPanel>
        {step === 'stack-init' && (
          <StackInitializationStep
            onFinished={handleFinished}
            onBeforeFinish={mode === 'reconfigure' ? commitReconfigureAnswers : undefined}
          />
        )}

        <div className="flex justify-between">
          <div className="flex gap-2">
            <Button type="button" variant="outline" onClick={goBack} disabled={stepIndex === 0 || saving}>
              Back
            </Button>
            {mode === 'reconfigure' && onCancel && (
              <Button type="button" variant="ghost" onClick={onCancel}>
                Cancel
              </Button>
            )}
            {mode === 'first-run' && (
              <Button
                type="button"
                variant="ghost"
                onClick={() => setResetConfirmOpen(true)}
                disabled={guidedIamBusy}
              >
                Start over
              </Button>
            )}
          </div>
          {!hideNextButton && (
            <Button type="button" onClick={goNext} disabled={advanceDisabled || saving}>
              Next
            </Button>
          )}
        </div>
        </div>
        <ConfirmDialog
          open={resetConfirmOpen}
          onOpenChange={setResetConfirmOpen}
          title="Start over?"
          description="Clears everything entered so far in this wizard — the chosen cloud, credentials, and bootstrap resource names — and returns to the first step. This does not touch any AWS resources already created."
          confirmLabel={resetting ? 'Resetting…' : 'Start over'}
          onConfirm={handleReset}
        />
      </div>
    </div>
  );
}

/**
 * Renders one wizard step's slot in {@link FirstRunWizard}'s body: nothing when `step` isn't the currently active
 * one, the Reconfigure {@link CompletedStepSummary} when `collapsed`, otherwise `children` followed by an
 * {@link InlineAlert} for `error` (omitted entirely when the step has no save-error alert of its own, e.g.
 * `guided-iam` and `bootstrap`, which already render their own error UI internally).
 *
 * @remarks
 * Replaces four near-identical `{step === 'X' && (collapsed ? <CompletedStepSummary /> : <XStep />)}` blocks that
 * previously lived inline in {@link FirstRunWizard}, two of which also repeated the same `saveError` alert
 * fragment — collapsing them here keeps that logic in one place instead of four.
 */
function WizardStepPanel({
  step,
  activeStep,
  collapsed,
  label,
  onEdit,
  error,
  children,
}: {
  step: WizardStep;
  activeStep: WizardStep;
  collapsed: boolean;
  label: string;
  onEdit: () => void;
  error?: string | null;
  children: ReactNode;
}) {
  if (step !== activeStep) return null;
  if (collapsed) return <CompletedStepSummary label={label} onEdit={onEdit} />;
  return (
    <>
      {children}
      {error !== undefined && <InlineAlert message={error} />}
    </>
  );
}

/** Reconfigure-only: collapsed view of a step that already has a stored answer, with an Edit affordance. */
function CompletedStepSummary({ label, onEdit }: { label: string; onEdit: () => void }) {
  return (
    <div className="flex items-center justify-between rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--color-surface-2)] p-4">
      <span className="flex items-center gap-2 text-sm">
        <CheckCircle2 className="size-4 text-[var(--color-green)]" />
        {label} is already configured.
      </span>
      <Button type="button" variant="outline" size="sm" onClick={onEdit}>
        Edit
      </Button>
    </div>
  );
}
