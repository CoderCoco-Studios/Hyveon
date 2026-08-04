/**
 * Ordered first-run wizard steps — the single source of truth for step
 * ordering, shared between the renderer (`@hyveon/web`'s `wizard.utils.ts`,
 * which needs the runtime array for step-index navigation) and the main
 * process (`FirstRunWizardService`, which needs it to validate a step name
 * resumed from `userData/wizard-state.json`). Keeping one copy here avoids
 * the two packages drifting out of sync.
 */
export const WIZARD_STEPS = ['pick-cloud', 'guided-iam', 'credentials', 'bootstrap', 'stack-init'] as const;

/** A single step in {@link WIZARD_STEPS}. */
export type WizardStep = (typeof WIZARD_STEPS)[number];
