/**
 * Shell for the first-run wizard (#184, epic #139): mirrors the add-game
 * wizard's step-flow pattern (shell owns step index + fetched state, one
 * component per step, pure helpers in `wizard.utils.ts`) but renders
 * full-page rather than in a `<Dialog>` — this wizard gates the entire app
 * before the dashboard is usable, so `app.component.tsx` renders it in place
 * of the normal routed layout while `wizardCompleted` is `false`.
 *
 * Four steps: pick-cloud, credentials, bootstrap, and stack-init (the last
 * of which initializes the Pulumi stack and finishes the wizard — task
 * 10.3's replacement for the pre-migration `terraform-init` step, which ran
 * `terraform init` and has been fully removed).
 */
import { useEffect, useRef, useState } from 'react';
import { CheckCircle2 } from 'lucide-react';
import type { AwsProfileSummary, IamCheckResult } from '@hyveon/desktop-preload';
import { Button } from '@/components/ui/button.component';
import { PickCloudStep, type CloudOption } from './pick-cloud-step.component.js';
import { CredentialsStep, type CredentialMode, type PasteField } from './credentials-step.component.js';
import { BootstrapStep } from './bootstrap-step.component.js';
import { StackInitializationStep } from './stack-init-step.component.js';
import {
  WIZARD_STEPS,
  defaultBootstrapResourceNames,
  type BootstrapResourceKey,
  type BootstrapResourceState,
  type WizardStep,
} from './wizard.utils.js';

/** Human-readable heading for each {@link WizardStep}. */
const STEP_LABELS: Record<WizardStep, string> = {
  'pick-cloud': 'Choose your cloud',
  credentials: 'AWS credentials',
  bootstrap: 'Bootstrap AWS resources',
  'stack-init': 'Finish setup',
};

/**
 * Steps in this list start collapsed to a completed summary (with an Edit
 * affordance) in `mode: 'reconfigure'`, since Settings only offers
 * Reconfigure once the wizard has already completed once — every one of
 * these already has a real answer on record. `stack-init` is excluded: it
 * has no standalone "answer" to summarize, and reaching it is itself the
 * explicit re-run the operator asked for by clicking through to it.
 */
const RECONFIGURE_PRE_COMPLETED_STEPS: WizardStep[] = ['pick-cloud', 'credentials', 'bootstrap'];

/** Props for {@link FirstRunWizard}. */
export interface FirstRunWizardProps {
  /** Invoked once the stack-init step's `wizard.complete` call succeeds. */
  onComplete?: () => void;
  /**
   * `'first-run'` (default) gates the whole app and runs all four steps,
   * persisting `pick-cloud`/`credentials`/`bootstrap` answers immediately via
   * `wizard.state.save` as the operator advances. `'reconfigure'` (#211,
   * launched from Settings) pre-marks `pick-cloud`/`credentials`/`bootstrap`
   * as completed with a per-step Edit affordance, and buffers *edited*
   * answers locally — a single
   * `wizard.state.save` call, containing only the steps actually opened via
   * Edit, commits right before `wizard.complete` runs. A step left collapsed
   * is never included in that call, so Cancel never has anything to undo for
   * it. This covers the durable answer data only, not every side effect: the
   * credentials step's "paste keys instead" form and the bootstrap step's
   * "Run bootstrap"/"Check permissions" buttons already perform real,
   * idempotent IPC calls the moment they're clicked (same as `'first-run'`)
   * — Cancel doesn't undo those either, it just never points the *active*
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
  const [stepIndex, setStepIndex] = useState(0);
  const [selectedCloud, setSelectedCloud] = useState<CloudOption>('aws');
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  const [profiles, setProfiles] = useState<AwsProfileSummary[] | null>(null);
  const [profilesLoading, setProfilesLoading] = useState(false);
  const [profilesError, setProfilesError] = useState<string | null>(null);
  const [credentialMode, setCredentialMode] = useState<CredentialMode>('profile');
  const [selectedProfileName, setSelectedProfileName] = useState('');
  const [region, setRegion] = useState('');
  const [pasteAccessKeyId, setPasteAccessKeyId] = useState('');
  const [pasteSecretAccessKey, setPasteSecretAccessKey] = useState('');
  const [pasteRegion, setPasteRegion] = useState('');
  const [pasteSaving, setPasteSaving] = useState(false);
  const [pasteError, setPasteError] = useState<string | null>(null);
  const [pastedProfileName, setPastedProfileName] = useState<string | null>(null);

  const [resourceNames, setResourceNames] = useState(defaultBootstrapResourceNames());
  const [resourceStatuses, setResourceStatuses] = useState<Record<BootstrapResourceKey, BootstrapResourceState>>({
    stateBucket: 'pending',
    configurationBucket: 'pending',
  });
  const [resourceMessages, setResourceMessages] = useState<Partial<Record<BootstrapResourceKey, string>>>({});
  const [bootstrapping, setBootstrapping] = useState(false);
  const [iamCheck, setIamCheck] = useState<IamCheckResult | null>(null);
  const [iamChecking, setIamChecking] = useState(false);
  const [iamError, setIamError] = useState<string | null>(null);

  // Reconfigure-only: which pre-completed steps are collapsed to a summary
  // (present in the set) vs. expanded for editing (removed from it). Empty —
  // and unused — in `'first-run'` mode.
  const [completedSteps, setCompletedSteps] = useState<Set<WizardStep>>(
    () => new Set(mode === 'reconfigure' ? RECONFIGURE_PRE_COMPLETED_STEPS : []),
  );

  const step = steps[stepIndex];

  // Guards the save-progress effect below until the resume-on-mount effect
  // has settled (resolved or rejected) — otherwise the two effects race to
  // read/write the same file, and if the save ever won that race it would
  // clobber a real resumed step back down to `pick-cloud`. Also used to
  // clamp how far resume is allowed to jump (see the resume effect).
  const resumeSettledRef = useRef(false);

  // Resume-on-mount: jump straight to the last-recorded step instead of
  // always restarting at `pick-cloud`, so closing and reopening the app
  // mid-flow doesn't lose progress. Any failure (including a missing IPC
  // bridge) leaves `stepIndex` at its default of 0. Clamped to at most the
  // `bootstrap` step: none of this component's answer state (region,
  // selected profile, bootstrap resource names) is itself persisted or
  // rehydrated here, only which step the operator was on — jumping straight
  // into `stack-init` would fire a real `iac.stack.initialize()` call on
  // mount before the operator has seen or confirmed anything on this visit
  // (unlike every other step here, `StackInitializationStep` needs no
  // renderer-supplied config to run — `PulumiService.initializeStack`
  // resolves the state bucket/region it needs from already-persisted store
  // state — so there is no "blank defaults" failure mode to worry about
  // specifically, but auto-running a real write-side operation unattended is
  // still the wrong resume behavior). Resuming to `bootstrap` is safe by
  // comparison: its IPC calls read the region from the credentials step's
  // already-persisted `wizard.state.save` call, and worst case the operator
  // just has to re-click "Bootstrap AWS resources".
  //
  // Both this effect and the save-progress effect below are `'first-run'`-only:
  // `userData/wizard-state.json` tracks resumable progress through the
  // *gating* wizard, which is meaningless for Reconfigure (the app is already
  // past the gate, and Reconfigure has its own pre-completed-steps/Cancel
  // model instead of resume).
  useEffect(() => {
    if (mode !== 'first-run') return;
    if (!window.hyveon) {
      resumeSettledRef.current = true;
      return;
    }
    window.hyveon.wizard
      .getProgress()
      .then((progress) => {
        const index = WIZARD_STEPS.indexOf(progress.step);
        const maxResumableIndex = WIZARD_STEPS.indexOf('bootstrap');
        if (index > 0) setStepIndex(Math.min(index, maxResumableIndex));
        // Set in the same microtask as the `setStepIndex` call above (rather
        // than a subsequent `.finally()`), so this is guaranteed true before
        // React processes that batched update — the save effect's re-run
        // must never observe `resumeSettledRef.current` still `false`.
        resumeSettledRef.current = true;
      })
      .catch(() => {
        // Best-effort — starting over at step 1 is always a safe fallback.
        resumeSettledRef.current = true;
      });
  }, [mode]);

  // Persists the current step on every change (including the resume-on-mount
  // jump above) so `userData/wizard-state.json` stays in sync with what the
  // operator is actually looking at. Fire-and-forget: a failed write here
  // shouldn't block the wizard, only degrade resume on the next launch.
  // Gated on `resumeSettledRef` so this can never race the resume effect's
  // own read of the same file (see that effect's comment).
  useEffect(() => {
    if (mode !== 'first-run' || !window.hyveon || !resumeSettledRef.current) return;
    window.hyveon.wizard.saveProgress({ step }).catch(() => {});
  }, [mode, step]);

  // Guards the reconfigure-prefill effect below so it applies exactly once,
  // never re-running over an operator's in-progress edits once it has fired.
  const prefillAppliedRef = useRef(false);

  // Reconfigure-only: prefills the pick-cloud/credentials/bootstrap answers
  // from the durably-stored `wizard.state.get` so the collapsed step
  // summaries reflect what's actually configured, not the first-run
  // defaults. `StackInitializationStep` itself no longer depends on any of
  // this prefilled state (unlike the deleted `terraform-init` step's
  // `backendConfig`, which read `resourceNames` regardless of whether the
  // bootstrap step was ever opened) — `PulumiService.initializeStack`
  // resolves the state bucket/region it needs internally — but the collapsed
  // summaries themselves still need accurate prefilled values.
  //
  // Waits for the `listAwsProfiles` fetch below to settle (`profiles` or
  // `profilesError` set) before applying, rather than firing on mount: the
  // `knownProfile` check needs a real list to tell an existing `~/.aws`
  // profile apart from a `creds.aws.<profile>` pasted-key entry, and firing
  // early would misclassify every profile as "pasted" on the first pass.
  // `prefillAppliedRef` then ensures it only ever applies once — otherwise a
  // later re-run (e.g. if `profiles` changed for some other reason) could
  // clobber an edit the operator has already started making.
  useEffect(() => {
    if (mode !== 'reconfigure' || !window.hyveon || prefillAppliedRef.current) return;
    if (profiles === null && profilesError === null) return;
    prefillAppliedRef.current = true;
    window.hyveon.wizard
      .getState()
      .then((state) => {
        if (state.activeCloud) setSelectedCloud(state.activeCloud);
        if (state.aws?.profile) {
          const knownProfile = profiles?.some((p) => p.profileName === state.aws!.profile);
          if (knownProfile) {
            setCredentialMode('profile');
            setSelectedProfileName(state.aws.profile);
            setRegion(state.aws.region ?? '');
          } else {
            // Not in `~/.aws` — must be a `creds.aws.<profile>` pasted-key
            // entry from a prior paste-flow save (see `AwsProfileService`).
            setCredentialMode('paste');
            setPastedProfileName(state.aws.profile);
            setPasteRegion(state.aws.region ?? '');
          }
        }
        if (state.bootstrap) setResourceNames(state.bootstrap);
      })
      .catch(() => {
        // Best-effort — the steps just fall back to first-run defaults, and
        // `commitReconfigureAnswers` below never sends an unedited step's
        // (now-defaulted) values, so a failed prefill can't clobber what's
        // actually stored.
      });
  }, [mode, profiles, profilesError]);

  function handleFinished() {
    onComplete?.();
  }

  useEffect(() => {
    async function fetchProfiles() {
      if (!window.hyveon) {
        setProfilesError('IPC bridge (window.hyveon) is not available in this context.');
        return;
      }
      setProfilesLoading(true);
      setProfilesError(null);
      try {
        const result = await window.hyveon.wizard.listAwsProfiles();
        setProfiles(result);
      } catch (err) {
        setProfilesError(err instanceof Error ? err.message : 'Failed to list AWS profiles.');
      } finally {
        setProfilesLoading(false);
      }
    }
    void fetchProfiles();
  }, []);

  /** Selecting a profile defaults `region` from that profile's own configured region. */
  function selectProfile(profileName: string) {
    setSelectedProfileName(profileName);
    const region = profiles?.find((p) => p.profileName === profileName)?.region;
    setRegion(region ?? '');
  }

  function pasteFieldChange(field: PasteField, value: string) {
    if (field === 'accessKeyId') setPasteAccessKeyId(value);
    else if (field === 'secretAccessKey') setPasteSecretAccessKey(value);
    else setPasteRegion(value);
    setPastedProfileName(null);
  }

  /** Runs the safeStorage paste-flow immediately (not deferred to Next), per the credentials-step spec. */
  async function submitPaste() {
    if (!window.hyveon) {
      setPasteError('IPC bridge (window.hyveon) is not available in this context.');
      return;
    }
    setPasteSaving(true);
    setPasteError(null);
    try {
      const result = await window.hyveon.wizard.saveCredentials({
        accessKeyId: pasteAccessKeyId,
        secretAccessKey: pasteSecretAccessKey,
        region: pasteRegion || undefined,
      });
      setPastedProfileName(result.profileName);
    } catch (err) {
      setPasteError(err instanceof Error ? err.message : 'Failed to save credentials.');
    } finally {
      setPasteSaving(false);
    }
  }

  function resourceNameChange(resource: BootstrapResourceKey, name: string) {
    setResourceNames((current) => ({ ...current, [resource]: name }));
  }

  /**
   * Runs the bootstrap IPC calls concurrently (state bucket, configuration
   * bucket), updating each resource's status as its call settles. A failure
   * on one resource doesn't stop the other from running, and each resource's
   * outcome (`created` / `exists` / `failed`) is reported independently —
   * neither call's result masks the other's.
   *
   * @remarks
   * Deliberately does not call `wizard.bootstrap.lockTable` — no such
   * channel exists anymore (task 5.1 removed the main-process handler
   * entirely: the DIY Pulumi S3 backend locks via objects in the state
   * bucket, not a DynamoDB table). `lockTable` no longer has a row in
   * {@link BootstrapStep} either (task 5.5), and (task 10.3) no longer
   * exists on {@link BootstrapResourceKey}/`resourceNames`/`resourceStatuses`
   * at all — its last remaining (non-bootstrap) use was the deleted
   * `terraform-init` step's `backendConfig`.
   */
  async function runBootstrap() {
    if (!window.hyveon) {
      const bridgeUnavailable = 'IPC bridge (window.hyveon) is not available in this context.';
      setResourceStatuses({ stateBucket: 'failed', configurationBucket: 'failed' });
      setResourceMessages({
        stateBucket: bridgeUnavailable,
        configurationBucket: bridgeUnavailable,
      });
      return;
    }
    setBootstrapping(true);
    setResourceStatuses((current) => ({ ...current, stateBucket: 'creating', configurationBucket: 'creating' }));
    setResourceMessages({});

    const calls: Array<[BootstrapResourceKey, () => Promise<{ status: string; message?: string }>]> = [
      ['stateBucket', () => window.hyveon!.wizard.bootstrapStateBucket({ bucketName: resourceNames.stateBucket })],
      [
        'configurationBucket',
        () =>
          window.hyveon!.wizard.bootstrapConfigurationBucket({ bucketName: resourceNames.configurationBucket }),
      ],
    ];

    await Promise.all(
      calls.map(async ([resource, call]) => {
        try {
          const result = await call();
          setResourceStatuses((current) => ({ ...current, [resource]: result.status as BootstrapResourceState }));
          if (result.message) {
            setResourceMessages((current) => ({ ...current, [resource]: result.message }));
          }
        } catch (err) {
          setResourceStatuses((current) => ({ ...current, [resource]: 'failed' }));
          setResourceMessages((current) => ({
            ...current,
            [resource]: err instanceof Error ? err.message : `Failed to bootstrap ${resource}.`,
          }));
        }
      }),
    );
    setBootstrapping(false);
  }

  /** Runs the best-effort IAM permission dry-run. Never blocks wizard progression. */
  async function runIamCheck() {
    if (!window.hyveon) {
      setIamError('IPC bridge (window.hyveon) is not available in this context.');
      return;
    }
    setIamChecking(true);
    setIamError(null);
    try {
      const result = await window.hyveon.wizard.simulateIamPermissions();
      setIamCheck(result);
    } catch (err) {
      setIamError(err instanceof Error ? err.message : 'Failed to run the IAM permission check.');
    } finally {
      setIamChecking(false);
    }
  }

  const bootstrapComplete = (['stateBucket', 'configurationBucket'] as BootstrapResourceKey[]).every(
    (resource) => resourceStatuses[resource] === 'created' || resourceStatuses[resource] === 'exists',
  );

  // Requires a non-empty region in both modes — this is persisted verbatim
  // (via `wizard.state.save({ aws: { profile, region } })` in `goNext`
  // below) into the same `ElectronStoreService.aws.region` field every
  // `PulumiService` operation — including `initializeStack`, the stack-init
  // step's own IPC call — reads at call time, so an empty region here would
  // otherwise silently reach that method as a missing region.
  const credentialsChosen =
    credentialMode === 'profile'
      ? selectedProfileName !== '' && region !== ''
      : pastedProfileName !== null && pasteRegion !== '';

  // A collapsed (completed, not being edited) Reconfigure step already has a
  // real answer on record — Next should never be gated on this render's
  // local form state, which for an unopened step may not even be prefilled yet.
  const stepCollapsed = mode === 'reconfigure' && completedSteps.has(step);

  const advanceDisabled = stepCollapsed
    ? false
    : step === 'credentials'
      ? !credentialsChosen
      : step === 'bootstrap'
        ? !bootstrapComplete
        : false;

  /**
   * Advances past the current step. In `'first-run'` mode, leaving
   * `pick-cloud`, `credentials`, or `bootstrap` persists the choice via
   * `wizard.state.save` immediately and stays put if that fails (the
   * `bootstrap` save is fire-and-forget, matching how `resourceNames` itself
   * has no failure UI — the resource-creation calls it feeds are what
   * actually gate progression). In `'reconfigure'` mode these answers are
   * buffered in local state instead — see {@link commitReconfigureAnswers},
   * called once from the stack-init step's Finish button — so a mid-flow
   * Cancel never has anything to undo.
   */
  async function goNext() {
    if (mode === 'first-run' && step === 'pick-cloud') {
      if (!window.hyveon) {
        setSaveError('IPC bridge (window.hyveon) is not available in this context.');
        return;
      }
      setSaving(true);
      setSaveError(null);
      try {
        await window.hyveon.wizard.saveState({ activeCloud: selectedCloud });
      } catch (err) {
        setSaveError(err instanceof Error ? err.message : 'Failed to save your cloud choice.');
        setSaving(false);
        return;
      }
      setSaving(false);
    }
    if (mode === 'first-run' && step === 'credentials') {
      if (!window.hyveon) {
        setSaveError('IPC bridge (window.hyveon) is not available in this context.');
        return;
      }
      const profile = credentialMode === 'profile' ? selectedProfileName : (pastedProfileName ?? undefined);
      const chosenRegion = credentialMode === 'profile' ? region : pasteRegion;
      setSaving(true);
      setSaveError(null);
      try {
        await window.hyveon.wizard.saveState({ aws: { profile, region: chosenRegion || undefined } });
      } catch (err) {
        setSaveError(err instanceof Error ? err.message : 'Failed to save your AWS credentials choice.');
        setSaving(false);
        return;
      }
      setSaving(false);
    }
    if (mode === 'first-run' && step === 'bootstrap' && window.hyveon) {
      // Durably records the (possibly operator-renamed) resource names so a
      // later Reconfigure can rehydrate them instead of falling back to
      // `defaultBootstrapResourceNames()`. Best-effort: nothing in this step
      // depends on the save succeeding, so a failure here doesn't block
      // progression the way the pick-cloud/credentials saves above do.
      window.hyveon.wizard.saveState({ bootstrap: resourceNames }).catch(() => {});
    }
    setStepIndex((index) => Math.min(index + 1, steps.length - 1));
  }

  function goBack() {
    setStepIndex((index) => Math.max(index - 1, 0));
  }

  /**
   * Reconfigure-only: commits whichever answers were actually opened via
   * Edit in one `wizard.state.save` call, passed to {@link StackInitializationStep}
   * as `onBeforeFinish` so it runs right before `wizard.complete` on the
   * Finish click. A step left collapsed (never opened) is omitted from the
   * payload entirely, not sent with its current — possibly still-default,
   * possibly prefill-failed-and-empty — local state: `saveState` only
   * touches the fields it's given, so this is what actually makes "Cancel
   * never has anything to undo" and "editing one field preserves the rest"
   * true, rather than merely re-submitting a (hopefully unchanged) copy of
   * everything on every Finish.
   */
  async function commitReconfigureAnswers() {
    if (!window.hyveon) {
      throw new Error('IPC bridge (window.hyveon) is not available in this context.');
    }
    const payload: { activeCloud?: CloudOption; aws?: { profile?: string; region?: string }; bootstrap?: typeof resourceNames } = {};
    if (!completedSteps.has('pick-cloud')) {
      payload.activeCloud = selectedCloud;
    }
    if (!completedSteps.has('credentials')) {
      const profile = credentialMode === 'profile' ? selectedProfileName : (pastedProfileName ?? undefined);
      const chosenRegion = credentialMode === 'profile' ? region : pasteRegion;
      payload.aws = { profile, region: chosenRegion || undefined };
    }
    if (!completedSteps.has('bootstrap')) {
      payload.bootstrap = resourceNames;
    }
    if (Object.keys(payload).length === 0) return;
    await window.hyveon.wizard.saveState(payload);
  }

  /** Reconfigure-only: expands a pre-completed step's summary into its normal editable form. */
  function startEdit(target: WizardStep) {
    setCompletedSteps((current) => {
      const next = new Set(current);
      next.delete(target);
      return next;
    });
  }

  return (
    <div className="min-h-screen flex items-center justify-center p-6">
      <div className="w-full max-w-xl rounded-[var(--radius-lg)] border border-[var(--color-border)] bg-[var(--color-surface-1)] p-8 space-y-6">
        <div>
          <h1 className="text-xl font-semibold">{mode === 'reconfigure' ? 'Reconfigure Hyveon' : 'Welcome to Hyveon'}</h1>
          <p className="text-sm text-muted-foreground">
            Step {stepIndex + 1} of {steps.length}: {STEP_LABELS[step]}
          </p>
        </div>

        {step === 'pick-cloud' &&
          (stepCollapsed ? (
            <CompletedStepSummary label={STEP_LABELS['pick-cloud']} onEdit={() => startEdit('pick-cloud')} />
          ) : (
            <>
              <PickCloudStep selectedCloud={selectedCloud} onSelect={setSelectedCloud} />
              {saveError && (
                <p role="alert" className="text-sm text-[var(--color-red)]">
                  {saveError}
                </p>
              )}
            </>
          ))}
        {step === 'credentials' &&
          (stepCollapsed ? (
            <CompletedStepSummary label={STEP_LABELS['credentials']} onEdit={() => startEdit('credentials')} />
          ) : (
            <>
              <CredentialsStep
                mode={credentialMode}
                onModeChange={setCredentialMode}
                profiles={profiles}
                profilesLoading={profilesLoading}
                profilesError={profilesError}
                selectedProfileName={selectedProfileName}
                onSelectProfile={selectProfile}
                region={region}
                onRegionChange={setRegion}
                pasteAccessKeyId={pasteAccessKeyId}
                pasteSecretAccessKey={pasteSecretAccessKey}
                pasteRegion={pasteRegion}
                onPasteFieldChange={pasteFieldChange}
                onSubmitPaste={submitPaste}
                pasteSaving={pasteSaving}
                pasteError={pasteError}
                pastedProfileName={pastedProfileName}
              />
              {saveError && (
                <p role="alert" className="text-sm text-[var(--color-red)]">
                  {saveError}
                </p>
              )}
            </>
          ))}
        {step === 'bootstrap' &&
          (stepCollapsed ? (
            <CompletedStepSummary label={STEP_LABELS['bootstrap']} onEdit={() => startEdit('bootstrap')} />
          ) : (
            <BootstrapStep
              names={resourceNames}
              statuses={resourceStatuses}
              messages={resourceMessages}
              onNameChange={resourceNameChange}
              onRunBootstrap={runBootstrap}
              bootstrapping={bootstrapping}
              iamCheck={iamCheck}
              iamChecking={iamChecking}
              iamError={iamError}
              onRunIamCheck={runIamCheck}
            />
          ))}
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
          </div>
          {step !== 'stack-init' && (
            <Button type="button" onClick={goNext} disabled={advanceDisabled || saving}>
              Next
            </Button>
          )}
        </div>
      </div>
    </div>
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
