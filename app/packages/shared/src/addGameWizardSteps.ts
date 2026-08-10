/**
 * Ordered add-game wizard steps — the single source of truth for step
 * ordering, shared between the renderer (`@hyveon/web`'s
 * `add-game-wizard/wizard-form.utils.ts`, which needs the runtime array for
 * step-index navigation) and the main process (`GameWizardDraftService`,
 * which needs the step count to validate a `stepIndex` resumed from a stored
 * draft). Keeping one copy here avoids the two packages drifting out of
 * sync, matching the same pattern {@link WIZARD_STEPS} in `wizardSteps.ts`
 * already uses for the first-run wizard.
 */
export const ADD_GAME_WIZARD_STEPS = [
  'identity',
  'resources',
  'networking',
  'storage',
  'environment',
  'review',
] as const;

/** A single step in {@link ADD_GAME_WIZARD_STEPS}. */
export type AddGameWizardStep = (typeof ADD_GAME_WIZARD_STEPS)[number];
