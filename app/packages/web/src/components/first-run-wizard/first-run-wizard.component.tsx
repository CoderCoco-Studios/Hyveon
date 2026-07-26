/**
 * Shell for the first-run wizard (#184, epic #139): mirrors the add-game
 * wizard's step-flow pattern (shell owns step index + fetched state, one
 * component per step, pure helpers in `wizard.utils.ts`) but renders
 * full-page rather than in a `<Dialog>` — this wizard gates the entire app
 * before the dashboard is usable, so `app.component.tsx` renders it in place
 * of the normal routed layout while `wizardCompleted` is `false`.
 *
 * Only prerequisites and pick-cloud exist so far; later PRs in this epic
 * append more steps to `WIZARD_STEPS` and this shell's render body.
 */
import { useCallback, useEffect, useState } from 'react';
import type { PrerequisitesReport } from '@hyveon/desktop-preload';
import { Button } from '@/components/ui/button.component';
import { PrerequisitesStep } from './prerequisites-step.component.js';
import { PickCloudStep, type CloudOption } from './pick-cloud-step.component.js';
import { WIZARD_STEPS, arePrerequisitesSatisfied, type WizardStep } from './wizard.utils.js';

/** Human-readable heading for each {@link WizardStep}. */
const STEP_LABELS: Record<WizardStep, string> = {
  prerequisites: 'Install prerequisites',
  'pick-cloud': 'Choose your cloud',
};

/**
 * Self-contained first-run wizard: owns its own step index, the
 * prerequisites-check state (report/checking/error), and the pick-cloud
 * selection. Fetches an initial prerequisites check on mount.
 */
export function FirstRunWizard() {
  const [stepIndex, setStepIndex] = useState(0);
  const [report, setReport] = useState<PrerequisitesReport | null>(null);
  const [checking, setChecking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selectedCloud, setSelectedCloud] = useState<CloudOption>('aws');
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  const step = WIZARD_STEPS[stepIndex];

  const checkPrereqs = useCallback(async () => {
    if (!window.gsd) {
      setError('IPC bridge (window.gsd) is not available in this context.');
      return;
    }
    setChecking(true);
    setError(null);
    try {
      const result = await window.gsd.wizard.checkPrereqs();
      setReport(result);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to check prerequisites.');
    } finally {
      setChecking(false);
    }
  }, []);

  useEffect(() => {
    void checkPrereqs();
  }, [checkPrereqs]);

  const advanceDisabled = step === 'prerequisites' ? !arePrerequisitesSatisfied(report) : false;

  /**
   * Advances past the current step. When leaving `pick-cloud`, persists the
   * selection via `wizard.state.save` first and stays put if that fails —
   * every other step advances immediately (nothing to persist yet).
   */
  async function goNext() {
    if (step === 'pick-cloud') {
      if (!window.gsd) {
        setSaveError('IPC bridge (window.gsd) is not available in this context.');
        return;
      }
      setSaving(true);
      setSaveError(null);
      try {
        await window.gsd.wizard.saveState({ activeCloud: selectedCloud });
      } catch (err) {
        setSaveError(err instanceof Error ? err.message : 'Failed to save your cloud choice.');
        setSaving(false);
        return;
      }
      setSaving(false);
    }
    setStepIndex((index) => Math.min(index + 1, WIZARD_STEPS.length - 1));
  }

  function goBack() {
    setStepIndex((index) => Math.max(index - 1, 0));
  }

  return (
    <div className="min-h-screen flex items-center justify-center p-6">
      <div className="w-full max-w-xl rounded-[var(--radius-lg)] border border-[var(--color-border)] bg-[var(--color-surface-1)] p-8 space-y-6">
        <div>
          <h1 className="text-xl font-semibold">Welcome to Hyveon</h1>
          <p className="text-sm text-muted-foreground">
            Step {stepIndex + 1} of {WIZARD_STEPS.length}: {STEP_LABELS[step]}
          </p>
        </div>

        {step === 'prerequisites' && (
          <PrerequisitesStep report={report} checking={checking} error={error} onRecheck={checkPrereqs} />
        )}
        {step === 'pick-cloud' && (
          <>
            <PickCloudStep selectedCloud={selectedCloud} onSelect={setSelectedCloud} />
            {saveError && (
              <p role="alert" className="text-sm text-[var(--color-red)]">
                {saveError}
              </p>
            )}
          </>
        )}

        <div className="flex justify-between">
          <Button type="button" variant="outline" onClick={goBack} disabled={stepIndex === 0}>
            Back
          </Button>
          <Button type="button" onClick={goNext} disabled={advanceDisabled || saving}>
            Next
          </Button>
        </div>
      </div>
    </div>
  );
}
