/**
 * Reconfigure-mode (#211) bookkeeping for the first-run wizard, extracted
 * from `FirstRunWizard` (finding D8): which pre-completed steps are
 * collapsed vs. being edited, the prefill effect that rehydrates collapsed
 * summaries from `wizard.state.get()`, and the buffered commit that sends
 * only the steps actually opened via Edit. Sequenced after D4/D7 in the
 * extraction order because it reaches into the bootstrap hook's `setNames`
 * and (once D9 lands) the credentials hook's state/setters — both must
 * already be hook-owned for this hook's params to have somewhere to point.
 * A no-op (empty `completedSteps`, `commitReconfigureAnswers` never called)
 * in `'first-run'` mode.
 */
import { useEffect, useRef, useState } from 'react';
import { GUIDED_PROFILE_NAME } from '@hyveon/desktop-preload';
import type { AwsProfileSummary } from '@hyveon/desktop-preload';
import type { CloudOption } from './pick-cloud-step.component.js';
import type { CredentialMode } from './credentials-step.component.js';
import type { BootstrapResourceKey, WizardStep } from './wizard.utils.js';

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
 * passes (see the prefill effect below).
 */
export function isGuidedProfile(profile: string | undefined): boolean {
  return profile === GUIDED_PROFILE_NAME;
}

/** The credentials-form slice this hook needs to read from and prefill into — currently the shell's own state, routed through `useAwsCredentialsForm` once D9 lands. */
export interface ReconfigureCredentialsParams {
  profiles: AwsProfileSummary[] | null;
  profilesError: string | null;
  credentialMode: CredentialMode;
  setCredentialMode: (mode: CredentialMode) => void;
  selectedProfileName: string;
  setSelectedProfileName: (name: string) => void;
  region: string;
  setRegion: (region: string) => void;
  pastedProfileName: string | null;
  setPastedProfileName: (name: string | null) => void;
  pasteRegion: string;
  setPasteRegion: (region: string) => void;
  /** Derives the `wizard.state.save({ aws })` payload from the current form state — see `useAwsCredentialsForm`'s own doc comment. */
  toStatePayload: () => { profile?: string; region?: string };
}

/** Options for {@link useReconfigureAnswers}. */
export interface UseReconfigureAnswersOptions {
  mode: 'first-run' | 'reconfigure';
  selectedCloud: CloudOption;
  setSelectedCloud: (cloud: CloudOption) => void;
  credentials: ReconfigureCredentialsParams;
  resourceNames: Record<BootstrapResourceKey, string>;
  setResourceNames: (names: Record<BootstrapResourceKey, string>) => void;
}

/** Return value of {@link useReconfigureAnswers}. */
export interface UseReconfigureAnswersResult {
  /** Which pre-completed steps are collapsed to a summary (present in the set) vs. expanded for editing (removed from it). Empty — and unused — in `'first-run'` mode. */
  completedSteps: Set<WizardStep>;
  /** Marks `target` as pre-completed (collapsed) — used only by the prefill effect for `guided-iam`'s conditional pre-completion. */
  markCompleted: (target: WizardStep) => void;
  /** Expands a pre-completed step's summary into its normal editable form. */
  startEdit: (target: WizardStep) => void;
  /**
   * Commits whichever answers were actually opened via Edit in one
   * `wizard.state.save` call — see this function's own doc comment for the
   * collapsed-step-omission invariant it exists to uphold.
   */
  commitReconfigureAnswers: () => Promise<void>;
}

/**
 * Owns Reconfigure mode's pre-completed-steps bookkeeping: which steps start
 * collapsed, the prefill effect that rehydrates their summaries from
 * `wizard.state.get()`, and the buffered `commitReconfigureAnswers` call
 * that sends only the steps actually opened via Edit.
 */
export function useReconfigureAnswers({
  mode,
  selectedCloud,
  setSelectedCloud,
  credentials,
  resourceNames,
  setResourceNames,
}: UseReconfigureAnswersOptions): UseReconfigureAnswersResult {
  const { profiles, profilesError } = credentials;

  // Reconfigure-only: which pre-completed steps are collapsed to a summary
  // (present in the set) vs. expanded for editing (removed from it). Empty —
  // and unused — in `'first-run'` mode.
  const [completedSteps, setCompletedSteps] = useState<Set<WizardStep>>(
    () => new Set(mode === 'reconfigure' ? RECONFIGURE_PRE_COMPLETED_STEPS : []),
  );

  // Guards the prefill effect below so it applies exactly once, never
  // re-running over an operator's in-progress edits once it has fired.
  const prefillAppliedRef = useRef(false);

  // Reconfigure-only: prefills the pick-cloud/credentials/bootstrap answers
  // from the durably-stored `wizard.state.get` so the collapsed step
  // summaries reflect what's actually configured, not the first-run
  // defaults. `StackInitializationStep` itself no longer depends on any of
  // this prefilled state (unlike the deleted pre-migration `init` step's
  // `backendConfig`, which read `resourceNames` regardless of whether the
  // bootstrap step was ever opened) — `PulumiService.initializeStack`
  // resolves the state bucket/region it needs internally — but the collapsed
  // summaries themselves still need accurate prefilled values.
  //
  // Waits for the `listAwsProfiles` fetch to settle (`profiles` or
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
            credentials.setCredentialMode('profile');
            credentials.setSelectedProfileName(state.aws.profile);
            credentials.setRegion(state.aws.region ?? '');
          } else {
            // Not in `~/.aws` — must be a `creds.aws.<profile>` pasted-key
            // entry from a prior paste-flow save (see `AwsProfileService`).
            credentials.setCredentialMode('paste');
            credentials.setPastedProfileName(state.aws.profile);
            credentials.setPasteRegion(state.aws.region ?? '');
          }
          // Conditional pre-completion (unlike `pick-cloud`/`credentials`/
          // `bootstrap`'s unconditional entries in
          // `RECONFIGURE_PRE_COMPLETED_STEPS`): guided-iam only renders
          // pre-completed when this exact profile name is real evidence
          // guided provisioning actually ran — see `isGuidedProfile`'s own
          // doc comment.
          if (isGuidedProfile(state.aws.profile)) {
            markCompleted('guided-iam');
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
    // `setResourceNames`/`setSelectedCloud` are stable across renders (raw
    // `useState` setters). `credentials` itself is a fresh object every
    // render (from `useAwsCredentialsForm`), but every `credentials.*` call
    // in this effect is one of its raw setters, which are individually
    // stable — so omitting `credentials` is safe only as long as that stays
    // true. If a future edit routes a call through a non-setter member of
    // `credentials` here, add it to the deps explicitly instead of relying
    // on this blanket suppression.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, profiles, profilesError]);

  function markCompleted(target: WizardStep) {
    setCompletedSteps((current) => {
      const next = new Set(current);
      next.add(target);
      return next;
    });
  }

  /** Expands a pre-completed step's summary into its normal editable form. */
  function startEdit(target: WizardStep) {
    setCompletedSteps((current) => {
      const next = new Set(current);
      next.delete(target);
      return next;
    });
  }

  /**
   * Commits whichever answers were actually opened via Edit in one
   * `wizard.state.save` call, passed to `StackInitializationStep` as
   * `onBeforeFinish` so it runs right before `wizard.complete` on the
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
      payload.aws = credentials.toStatePayload();
    }
    if (!completedSteps.has('bootstrap')) {
      payload.bootstrap = resourceNames;
    }
    if (Object.keys(payload).length === 0) return;
    await window.hyveon.wizard.saveState(payload);
  }

  return { completedSteps, markCompleted, startEdit, commitReconfigureAnswers };
}
