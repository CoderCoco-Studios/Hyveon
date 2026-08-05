/**
 * Shell for the first-run wizard (#184, epic #139): mirrors the add-game
 * wizard's step-flow pattern (shell owns step index + fetched state, one
 * component per step, pure helpers in `wizard.utils.ts`) but renders
 * full-page rather than in a `<Dialog>` — this wizard gates the entire app
 * before the dashboard is usable, so `app.component.tsx` renders it in place
 * of the normal routed layout while `wizardCompleted` is `false`.
 *
 * Five steps: pick-cloud, guided-iam (`add-one-click-aws-bootstrap`'s
 * one-click AWS access provisioning, inserted between pick-cloud and
 * credentials), credentials, bootstrap, and stack-init (the last of which
 * initializes the Pulumi stack and finishes the wizard — task 10.3's
 * replacement for the pre-migration `terraform-init` step, which ran
 * `terraform init` and has been fully removed).
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { CheckCircle2 } from 'lucide-react';
import { GUIDED_PROFILE_NAME, type AwsProfileSummary, type IamCheckResult, type WizardProgress } from '@hyveon/desktop-preload';
import { Button } from '@/components/ui/button.component';
import { PickCloudStep, type CloudOption } from './pick-cloud-step.component.js';
import { CredentialsStep, type CredentialMode, type PasteField } from './credentials-step.component.js';
import { BootstrapStep } from './bootstrap-step.component.js';
import { GuidedIamStep } from './guided-iam-step.component.js';
import { StackInitializationStep } from './stack-init-step.component.js';
import { WizardStepSidebar } from './wizard-step-sidebar.component.js';
import {
  STEP_LABELS,
  WIZARD_STEPS,
  defaultBootstrapResourceNames,
  type BootstrapResourceKey,
  type BootstrapResourceState,
  type WizardStep,
} from './wizard.utils.js';

/**
 * Steps in this list start collapsed to a completed summary (with an Edit
 * affordance) in `mode: 'reconfigure'`, since Settings only offers
 * Reconfigure once the wizard has already completed once — every one of
 * these already has a real answer on record. `stack-init` is excluded: it
 * has no standalone "answer" to summarize, and reaching it is itself the
 * explicit re-run the operator asked for by clicking through to it.
 */
const RECONFIGURE_PRE_COMPLETED_STEPS: WizardStep[] = ['pick-cloud', 'credentials', 'bootstrap'];

/**
 * True when `profile` is the exact profile name `GuidedIamService.rotate()`
 * stores once the guided-IAM step's mint-then-revoke rotation completes —
 * the sole signal (per the spec) that guided provisioning, rather than a
 * manually picked `~/.aws` profile or pasted key, produced the active AWS
 * credential. `guided-iam` is deliberately NOT added to
 * {@link RECONFIGURE_PRE_COMPLETED_STEPS} above: unlike its three
 * unconditional siblings, it only counts as pre-completed when this check
 * passes (see the reconfigure-prefill effect below). Also backs the
 * credentials step's `satisfiedByGuidedProvisioning` prop (see
 * `guidedCredentials` state below) — shared here so neither call site
 * duplicates the literal `'hyveon-guided'` comparison independently.
 */
function isGuidedProfile(profile: string | undefined): boolean {
  return profile === GUIDED_PROFILE_NAME;
}

/** Props for {@link FirstRunWizard}. */
export interface FirstRunWizardProps {
  /** Invoked once the stack-init step's `wizard.complete` call succeeds. */
  onComplete?: () => void;
  /**
   * `'first-run'` (default) gates the whole app and runs all five steps
   * (including `guided-iam`, `add-one-click-aws-bootstrap`'s one-click AWS
   * access provisioning step), persisting `pick-cloud`/`credentials`/`bootstrap`
   * answers immediately via `wizard.state.save` as the operator advances.
   * `'reconfigure'` (#211, launched from Settings) pre-marks
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
  // The run-history table (bootstrap-deadlock fix): tracked separately from
  // `resourceNames`/`resourceStatuses` above rather than folded into
  // `BootstrapResourceKey` — unlike the two S3 buckets, its name is not
  // operator-editable at this point in the wizard (no `DeploymentConfig`
  // exists yet to hold a `runsTableName` override; see
  // `WizardController.bootstrapRunsTable`'s own doc comment), so it has no
  // matching entry in `resourceNames`. Never gates `bootstrapComplete` below
  // — it runs alongside the two bucket calls, not as a blocking prerequisite.
  const [runsTableStatus, setRunsTableStatus] = useState<BootstrapResourceState>('pending');
  const [runsTableMessage, setRunsTableMessage] = useState<string | undefined>(undefined);
  // The initial `deployment-config.json` seed (the fresh-install-bricking
  // fix): also tracked separately from `resourceNames`/`resourceStatuses`,
  // mirroring `runsTableStatus` above — it has no editable name field of its
  // own (it's seeded into whatever `resourceNames.configurationBucket`
  // names). Unlike the run-history table, it can only run AFTER the
  // configuration bucket itself has been created/confirmed — see
  // `runBootstrap`'s configuration-bucket branch below, which chains this
  // call rather than firing it in the same top-level `Promise.all` entry as
  // the run-history table.
  const [deploymentConfigStatus, setDeploymentConfigStatus] = useState<BootstrapResourceState>('pending');
  const [deploymentConfigMessage, setDeploymentConfigMessage] = useState<string | undefined>(undefined);
  const [bootstrapping, setBootstrapping] = useState(false);
  const [iamCheck, setIamCheck] = useState<IamCheckResult | null>(null);
  const [iamChecking, setIamChecking] = useState(false);
  const [iamError, setIamError] = useState<string | null>(null);

  // The shell's own `getProgress()` result's `guidedIam` sub-state, captured
  // only when `progress.step === 'guided-iam'` (see the resume-on-mount
  // effect below) — passed straight through as `GuidedIamStep`'s
  // `initialProgress` prop. `'first-run'`-only, like the resume effect
  // itself; stays `undefined` in `'reconfigure'` mode, so an Edit on a
  // pre-completed guided-iam summary always starts the step fresh from the
  // region screen.
  const [guidedIamInitialProgress, setGuidedIamInitialProgress] = useState<WizardProgress['guidedIam']>(undefined);

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
    void refreshGuidedCredentials();
  }, [refreshGuidedCredentials]);

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
        // Only meaningful when resuming directly onto the guided-iam step
        // itself — `GuidedIamStep` treats a `progress.guidedIam` it never
        // asked for (e.g. resuming onto a later step) as irrelevant, but
        // this still guards against passing a stale sub-state down for no
        // reason.
        if (progress.step === 'guided-iam') setGuidedIamInitialProgress(progress.guidedIam);
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
  //
  // Includes `guidedIamInitialProgress` in the payload whenever `step` is
  // `'guided-iam'`, rather than omitting `guidedIam` entirely: this effect
  // fires the moment the resume-on-mount effect jumps `stepIndex` onto
  // `guided-iam`, which happens *before* `GuidedIamStep` itself has had a
  // chance to re-persist anything. Without this, that first save would
  // rewrite `wizard-state.json` as bare `{ step: 'guided-iam' }`, silently
  // dropping whatever sub-state (e.g. `rotation-pending`) the operator
  // resumed with — the CURRENT session still resumes correctly (this
  // component already received the real value via the `initialProgress`
  // prop before this effect ran), but a second relaunch with no further
  // action taken would then land back on a fresh region screen instead of
  // resuming again. `guidedIamInitialProgress` only ever reflects what
  // `getProgress()` returned on THIS mount (see that state's own doc
  // comment) — it is never updated as `GuidedIamStep` advances internally,
  // so it can go stale relative to `GuidedIamStep`'s own `persistProgress`
  // calls (which fire at real transition moments with fresh values and are
  // authoritative). That staleness is harmless here: `step` itself doesn't
  // change while the operator moves between `GuidedIamStep`'s internal
  // phases, so this effect does not re-run and does not re-fire a stale
  // write over a fresher one — it only fires once on entry to (or exit
  // from) the `guided-iam` step, which is exactly the resume-preserving
  // write this fix needs.
  useEffect(() => {
    if (mode !== 'first-run' || !window.hyveon || !resumeSettledRef.current) return;
    const payload =
      step === 'guided-iam' && guidedIamInitialProgress
        ? { step, guidedIam: guidedIamInitialProgress }
        : { step };
    window.hyveon.wizard.saveProgress(payload).catch(() => {});
  }, [mode, step, guidedIamInitialProgress]);

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
          // Conditional pre-completion (unlike `pick-cloud`/`credentials`/
          // `bootstrap`'s unconditional entries in
          // `RECONFIGURE_PRE_COMPLETED_STEPS`): guided-iam only renders
          // pre-completed when this exact profile name is real evidence
          // guided provisioning actually ran — see `isGuidedProfile`'s own
          // doc comment.
          if (isGuidedProfile(state.aws.profile)) {
            setCompletedSteps((current) => {
              const next = new Set(current);
              next.add('guided-iam');
              return next;
            });
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
    setGuidedIamInitialProgress(undefined);
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
    setGuidedIamInitialProgress(undefined);
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
   * bucket, run-history table), updating each resource's status as its call
   * settles. A failure on one resource doesn't stop the others from running,
   * and each resource's outcome (`created` / `exists` / `failed`) is
   * reported independently — no call's result masks another's.
   *
   * @remarks
   * Deliberately does not call `wizard.bootstrap.lockTable` — no such
   * channel exists: the DIY Pulumi S3 backend locks via objects in the
   * state bucket, not a DynamoDB table. `lockTable` has no row in
   * {@link BootstrapStep} and no longer exists on
   * {@link BootstrapResourceKey}/`resourceNames`/`resourceStatuses` at all.
   *
   * The run-history table (`wizard.bootstrap.runsTable`) runs alongside the
   * two bucket calls in the same `Promise.all`, but is tracked via
   * {@link runsTableStatus}/{@link runsTableMessage} rather than
   * {@link resourceStatuses} — see those states' own doc comments for why it
   * isn't a {@link BootstrapResourceKey}.
   *
   * The initial `deployment-config.json` seed
   * (`wizard.bootstrap.deploymentConfig`) is NOT run alongside the
   * run-history table as an independent `Promise.all` entry — it must be
   * seeded into the configuration bucket, so it only fires once
   * {@link bootstrapConfigurationBucket} itself reports `created`/`exists`,
   * chained onto the same async branch that call runs in below. A
   * configuration-bucket failure (or the bridge being unavailable) reports
   * the seed as `failed` too, with a message explaining why, rather than
   * leaving it stuck at `pending` forever.
   */
  async function runBootstrap() {
    if (!window.hyveon) {
      const bridgeUnavailable = 'IPC bridge (window.hyveon) is not available in this context.';
      setResourceStatuses({ stateBucket: 'failed', configurationBucket: 'failed' });
      setResourceMessages({
        stateBucket: bridgeUnavailable,
        configurationBucket: bridgeUnavailable,
      });
      setRunsTableStatus('failed');
      setRunsTableMessage(bridgeUnavailable);
      setDeploymentConfigStatus('failed');
      setDeploymentConfigMessage(bridgeUnavailable);
      return;
    }
    setBootstrapping(true);
    setResourceStatuses((current) => ({ ...current, stateBucket: 'creating', configurationBucket: 'creating' }));
    setResourceMessages({});
    setRunsTableStatus('creating');
    setRunsTableMessage(undefined);
    setDeploymentConfigStatus('creating');
    setDeploymentConfigMessage(undefined);

    const stateBucketCall = (async () => {
      try {
        const result = await window.hyveon!.wizard.bootstrapStateBucket({ bucketName: resourceNames.stateBucket });
        setResourceStatuses((current) => ({ ...current, stateBucket: result.status as BootstrapResourceState }));
        if (result.message) {
          setResourceMessages((current) => ({ ...current, stateBucket: result.message }));
        }
      } catch (err) {
        setResourceStatuses((current) => ({ ...current, stateBucket: 'failed' }));
        setResourceMessages((current) => ({
          ...current,
          stateBucket: err instanceof Error ? err.message : 'Failed to bootstrap stateBucket.',
        }));
      }
    })();

    const configurationBucketCall = (async () => {
      try {
        const result = await window.hyveon!.wizard.bootstrapConfigurationBucket({
          bucketName: resourceNames.configurationBucket,
        });
        setResourceStatuses((current) => ({ ...current, configurationBucket: result.status as BootstrapResourceState }));
        if (result.message) {
          setResourceMessages((current) => ({ ...current, configurationBucket: result.message }));
        }
        if (result.status !== 'created' && result.status !== 'exists') {
          setDeploymentConfigStatus('failed');
          setDeploymentConfigMessage('The configuration bucket must be created before its initial configuration can be seeded.');
          return;
        }
        try {
          const seedResult = await window.hyveon!.wizard.bootstrapDeploymentConfig({
            bucketName: resourceNames.configurationBucket,
          });
          setDeploymentConfigStatus(seedResult.status as BootstrapResourceState);
          setDeploymentConfigMessage(seedResult.message);
        } catch (err) {
          setDeploymentConfigStatus('failed');
          setDeploymentConfigMessage(
            err instanceof Error ? err.message : 'Failed to seed the initial deployment configuration.',
          );
        }
      } catch (err) {
        setResourceStatuses((current) => ({ ...current, configurationBucket: 'failed' }));
        setResourceMessages((current) => ({
          ...current,
          configurationBucket: err instanceof Error ? err.message : 'Failed to bootstrap configurationBucket.',
        }));
        setDeploymentConfigStatus('failed');
        setDeploymentConfigMessage('The configuration bucket failed to bootstrap, so its initial configuration was not seeded.');
      }
    })();

    const runsTableCall = (async () => {
      try {
        const result = await window.hyveon!.wizard.bootstrapRunsTable();
        setRunsTableStatus(result.status as BootstrapResourceState);
        setRunsTableMessage(result.message);
      } catch (err) {
        setRunsTableStatus('failed');
        setRunsTableMessage(err instanceof Error ? err.message : 'Failed to bootstrap the run-history table.');
      }
    })();

    await Promise.all([stateBucketCall, configurationBucketCall, runsTableCall]);
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
      <div className="flex w-full max-w-[min(92vw,2000px)] justify-center gap-6">
        {mode === 'first-run' && <WizardStepSidebar steps={steps} currentIndex={stepIndex} labels={STEP_LABELS} />}
        <div className="w-full max-w-xl md:max-w-[clamp(672px,55vw,1500px)] rounded-[var(--radius-lg)] border border-[var(--color-border)] bg-[var(--color-surface-1)] p-8 space-y-6">
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
        {step === 'guided-iam' &&
          (stepCollapsed ? (
            <CompletedStepSummary label={STEP_LABELS['guided-iam']} onEdit={() => startEdit('guided-iam')} />
          ) : (
            <GuidedIamStep
              onComplete={handleGuidedIamComplete}
              onSkipToManual={handleGuidedIamSkipToManual}
              initialProgress={guidedIamInitialProgress}
            />
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
                satisfiedByGuidedProvisioning={
                  guidedCredentials
                    ? { principal: 'AWS account (guided setup)', region: guidedCredentials.region }
                    : undefined
                }
                onSwitchSource={handleSwitchCredentialSource}
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
              runsTableStatus={runsTableStatus}
              runsTableMessage={runsTableMessage}
              deploymentConfigStatus={deploymentConfigStatus}
              deploymentConfigMessage={deploymentConfigMessage}
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
          {!hideNextButton && (
            <Button type="button" onClick={goNext} disabled={advanceDisabled || saving}>
              Next
            </Button>
          )}
        </div>
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
