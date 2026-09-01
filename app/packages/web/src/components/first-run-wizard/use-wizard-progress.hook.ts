/**
 * Step-index + resume/save-progress machinery for the first-run wizard,
 * extracted from `FirstRunWizard` (finding D5). `'first-run'`-only:
 * `userData/wizard-state.json` tracks resumable progress through the
 * *gating* wizard, which is meaningless for Reconfigure (the app is already
 * past the gate, and Reconfigure has its own pre-completed-steps/Cancel
 * model instead of resume) — both effects below no-op when `mode !== 'first-run'`.
 */
import { useEffect, useRef, useState } from 'react';
import type { WizardProgress } from '@hyveon/desktop-preload';
import { WIZARD_STEPS, type WizardStep } from './wizard.utils.js';

/** Return value of {@link useWizardProgress}. */
export interface UseWizardProgressResult {
  /** Index into `WIZARD_STEPS` of the step currently being shown. */
  stepIndex: number;
  setStepIndex: (updater: number | ((index: number) => number)) => void;
  /**
   * The shell's own `getProgress()` result's `guidedIam` sub-state, captured
   * only when `progress.step === 'guided-iam'` — passed straight through as
   * `GuidedIamStep`'s `initialProgress` prop.
   */
  guidedIamInitialProgress: WizardProgress['guidedIam'];
  /**
   * Clears {@link guidedIamInitialProgress} — call once the guided-iam step
   * itself advances past this step (via `onComplete`/`onSkipToManual`), so a
   * later `Back` navigation back onto `guided-iam` doesn't re-fire the
   * save-progress effect with this mount's now-stale value, overwriting
   * whatever `GuidedIamStep` itself persisted since.
   */
  clearGuidedIamProgress: () => void;
}

/**
 * Owns the first-run wizard's step index plus the resume-on-mount and
 * save-on-change effects that keep `userData/wizard-state.json` in sync with
 * it.
 *
 * @param mode - `'first-run'` runs both effects; `'reconfigure'` starts at
 * step 0 and never reads/writes progress.
 */
export function useWizardProgress(mode: 'first-run' | 'reconfigure'): UseWizardProgressResult {
  const [stepIndex, setStepIndex] = useState(0);

  // The shell's own `getProgress()` result's `guidedIam` sub-state, captured
  // only when `progress.step === 'guided-iam'` (see the resume-on-mount
  // effect below) — passed straight through as `GuidedIamStep`'s
  // `initialProgress` prop. `'first-run'`-only, like the resume effect
  // itself; stays `undefined` in `'reconfigure'` mode, so an Edit on a
  // pre-completed guided-iam summary always starts the step fresh from the
  // region screen.
  const [guidedIamInitialProgress, setGuidedIamInitialProgress] = useState<WizardProgress['guidedIam']>(undefined);

  const step = WIZARD_STEPS[stepIndex];

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
  // `getProgress()` returned on THIS mount — it is never updated as
  // `GuidedIamStep` advances internally, so it can go stale relative to
  // `GuidedIamStep`'s own `persistProgress` calls (which fire at real
  // transition moments with fresh values and are authoritative). That
  // staleness is harmless here: `step` itself doesn't change while the
  // operator moves between `GuidedIamStep`'s internal phases, so this effect
  // does not re-run and does not re-fire a stale write over a fresher one —
  // it only fires once on entry to (or exit from) the `guided-iam` step,
  // which is exactly the resume-preserving write this fix needs.
  useEffect(() => {
    if (mode !== 'first-run' || !window.hyveon || !resumeSettledRef.current) return;
    const payload =
      step === 'guided-iam' && guidedIamInitialProgress ? { step, guidedIam: guidedIamInitialProgress } : { step };
    window.hyveon.wizard.saveProgress(payload).catch(() => {});
  }, [mode, step, guidedIamInitialProgress]);

  return {
    stepIndex,
    setStepIndex,
    guidedIamInitialProgress,
    clearGuidedIamProgress: () => setGuidedIamInitialProgress(undefined),
  };
}

export type { WizardStep };
