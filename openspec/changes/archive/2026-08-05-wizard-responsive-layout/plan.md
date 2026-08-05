# Wizard Responsive Layout Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a step-progress sidebar and a wider content column to the first-run wizard shell so it uses available width on large/4K viewports instead of rendering as one small fixed-width (576px) card.

**Architecture:** A new presentational `WizardStepSidebar` component renders all five `WIZARD_STEPS` with completed/current/upcoming state, shown at the `md:` breakpoint and above alongside the existing step content. `first-run-wizard.component.tsx`'s render wraps both in a flex row; the content column's max-width grows from `max-w-xl` (576px) to `max-w-2xl` (672px) at `md:` and above, unchanged below it. `STEP_LABELS` moves from the shell component into `wizard.utils.ts` so both the shell and the new sidebar can import it without a circular dependency.

**Tech Stack:** React + TypeScript, Tailwind CSS v4 (utility classes, `@theme`-defined CSS custom properties), `lucide-react` icons, Vitest + `@testing-library/react` (jsdom project).

## Global Constraints

- TSDoc only (per `.claude/rules/tsdoc-tags.md`): summary → `@remarks` → `@param`/`@returns` order; no invented tags.
- No `as unknown as T` in tests; `Partial<T>` + a single `as T` for stubs.
- Test names read as sentences starting with "should".
- `npm run app:lint`, `npm run app:typecheck`, `npm run app:test` must all pass clean before this change is done.

---

### Task 1: `WizardStepSidebar` component

**Files:**
- Create: `app/packages/web/src/components/first-run-wizard/wizard-step-sidebar.component.tsx`
- Test: `app/packages/web/src/components/first-run-wizard/wizard-step-sidebar.component.test.tsx`

**Interfaces:**
- Consumes: `WizardStep` type from `./wizard.utils.js`; `cn` from `@/lib/utils.utils`; `CheckCircle2` from `lucide-react` (already used elsewhere in this directory, e.g. `first-run-wizard.component.tsx:17`).
- Produces: `WizardStepSidebar({ steps: readonly WizardStep[]; currentIndex: number; labels: Record<WizardStep, string> })` — a named export. Task 2 imports and renders this with `steps={steps}` (the shell's existing `WIZARD_STEPS`), `currentIndex={stepIndex}`, and `labels={STEP_LABELS}` (moved to `wizard.utils.ts` in Task 2). Each rendered `<li>` carries `data-state="completed" | "current" | "upcoming"` and, on the current item only, `aria-current="step"` — Task 3's test audit and any future test relies on these attributes, not on Tailwind classes, to assert step state.

- [ ] **Step 1: Write the failing test**

Create `app/packages/web/src/components/first-run-wizard/wizard-step-sidebar.component.test.tsx`:

```tsx
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { WizardStepSidebar } from './wizard-step-sidebar.component.js';
import type { WizardStep } from './wizard.utils.js';

const STEPS: readonly WizardStep[] = ['pick-cloud', 'guided-iam', 'credentials', 'bootstrap', 'stack-init'];
const LABELS: Record<WizardStep, string> = {
  'pick-cloud': 'Pick cloud label',
  'guided-iam': 'Guided IAM label',
  credentials: 'Credentials label',
  bootstrap: 'Bootstrap label',
  'stack-init': 'Stack init label',
};

describe('WizardStepSidebar', () => {
  it('should render all five step labels', () => {
    render(<WizardStepSidebar steps={STEPS} currentIndex={2} labels={LABELS} />);

    for (const label of Object.values(LABELS)) {
      expect(screen.getByText(label)).toBeInTheDocument();
    }
  });

  it('should mark steps before currentIndex as completed', () => {
    render(<WizardStepSidebar steps={STEPS} currentIndex={2} labels={LABELS} />);

    expect(screen.getByText(LABELS['pick-cloud']).closest('li')).toHaveAttribute('data-state', 'completed');
    expect(screen.getByText(LABELS['guided-iam']).closest('li')).toHaveAttribute('data-state', 'completed');
  });

  it('should mark the step at currentIndex as current with aria-current', () => {
    render(<WizardStepSidebar steps={STEPS} currentIndex={2} labels={LABELS} />);

    const currentItem = screen.getByText(LABELS['credentials']).closest('li');
    expect(currentItem).toHaveAttribute('data-state', 'current');
    expect(currentItem).toHaveAttribute('aria-current', 'step');
  });

  it('should mark steps after currentIndex as upcoming', () => {
    render(<WizardStepSidebar steps={STEPS} currentIndex={2} labels={LABELS} />);

    expect(screen.getByText(LABELS['bootstrap']).closest('li')).toHaveAttribute('data-state', 'upcoming');
    expect(screen.getByText(LABELS['stack-init']).closest('li')).toHaveAttribute('data-state', 'upcoming');
  });

  it('should render no interactive step entries', () => {
    render(<WizardStepSidebar steps={STEPS} currentIndex={2} labels={LABELS} />);

    expect(screen.queryAllByRole('button')).toHaveLength(0);
    expect(screen.queryAllByRole('link')).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm run app:test -- wizard-step-sidebar`
Expected: FAIL — `wizard-step-sidebar.component.tsx` does not exist yet (module not found).

- [ ] **Step 3: Write the component**

Create `app/packages/web/src/components/first-run-wizard/wizard-step-sidebar.component.tsx`:

```tsx
import { CheckCircle2 } from 'lucide-react';
import { cn } from '@/lib/utils.utils';
import type { WizardStep } from './wizard.utils.js';

/** Props for {@link WizardStepSidebar}. */
export interface WizardStepSidebarProps {
  /** Steps in display order, e.g. {@link WIZARD_STEPS}. */
  steps: readonly WizardStep[];
  /** Index into `steps` of the step currently shown. */
  currentIndex: number;
  /** Human-readable label per step id. */
  labels: Record<WizardStep, string>;
}

/**
 * Non-interactive progress list for the first-run wizard shell.
 *
 * @remarks
 * Shown alongside step content at the `md:` breakpoint and above. Has no
 * click handlers or interactive roles: wizard navigation is strictly
 * linear (`goNext`/`goBack` only), so this communicates progress — it is
 * not a navigation control.
 *
 * @param props - {@link WizardStepSidebarProps}
 */
export function WizardStepSidebar({ steps, currentIndex, labels }: WizardStepSidebarProps) {
  return (
    <nav aria-label="Wizard progress" className="hidden md:block w-64 shrink-0">
      <ol className="space-y-1">
        {steps.map((stepId, index) => {
          const state = index < currentIndex ? 'completed' : index === currentIndex ? 'current' : 'upcoming';
          return (
            <li
              key={stepId}
              data-state={state}
              aria-current={state === 'current' ? 'step' : undefined}
              className={cn(
                'flex items-center gap-2 rounded-[var(--radius-md)] px-3 py-2 text-sm',
                state === 'current' && 'bg-[var(--color-surface-2)] font-medium text-foreground',
                state === 'completed' && 'text-muted-foreground',
                state === 'upcoming' && 'text-muted-foreground/50',
              )}
            >
              {state === 'completed' ? (
                <CheckCircle2 className="size-4 shrink-0 text-[var(--color-green)]" />
              ) : (
                <span className="flex size-4 shrink-0 items-center justify-center rounded-full border border-[var(--color-border)] text-[10px]">
                  {index + 1}
                </span>
              )}
              {labels[stepId]}
            </li>
          );
        })}
      </ol>
    </nav>
  );
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm run app:test -- wizard-step-sidebar`
Expected: PASS (5 tests).

- [ ] **Step 5: Lint and typecheck**

Run: `npm run app:lint -- app/packages/web/src/components/first-run-wizard` then `npm run app:typecheck`
Expected: both clean. `tsdoc/syntax` must accept the comment (summary, `@remarks`, `@param`, in order — see Global Constraints).

- [ ] **Step 6: Commit**

```bash
git add app/packages/web/src/components/first-run-wizard/wizard-step-sidebar.component.tsx app/packages/web/src/components/first-run-wizard/wizard-step-sidebar.component.test.tsx
git commit -m "feat(web): add WizardStepSidebar progress component"
```

---

### Task 2: Wire the sidebar into the wizard shell

**Files:**
- Modify: `app/packages/web/src/components/first-run-wizard/wizard.utils.ts` (move `STEP_LABELS` here, exported)
- Modify: `app/packages/web/src/components/first-run-wizard/first-run-wizard.component.tsx:16-40,769-771,883-886`

**Interfaces:**
- Consumes: `WizardStepSidebar` from Task 1 (`{ steps, currentIndex, labels }`).
- Produces: `STEP_LABELS` becomes a named export of `wizard.utils.ts` (`Record<WizardStep, string>`), importable by both the shell and any future consumer without a circular import (previously it was a private `const` inside `first-run-wizard.component.tsx`, which imports `wizard-step-sidebar.component.tsx` — keeping the labels there would force the sidebar to import them back from the file importing it).

- [ ] **Step 1: Move `STEP_LABELS` into `wizard.utils.ts`**

In `app/packages/web/src/components/first-run-wizard/wizard.utils.ts`, after the existing `export { WIZARD_STEPS, type WizardStep };` line, add:

```ts
/** Human-readable heading for each {@link WizardStep}. */
export const STEP_LABELS: Record<WizardStep, string> = {
  'pick-cloud': 'Choose your cloud',
  'guided-iam': 'Provision AWS access',
  credentials: 'AWS credentials',
  bootstrap: 'Bootstrap AWS resources',
  'stack-init': 'Finish setup',
};
```

- [ ] **Step 2: Remove the old `STEP_LABELS` const from the shell**

In `first-run-wizard.component.tsx`, delete lines 33-40 (the `/** Human-readable heading... */` comment and the `const STEP_LABELS = {...}` block) — this content now lives in `wizard.utils.ts`.

- [ ] **Step 3: Update the shell's imports**

Replace the import block at `first-run-wizard.component.tsx:16-31`:

```tsx
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
```

(Only two changes from the original: added the `WizardStepSidebar` import line, and added `STEP_LABELS` to the `wizard.utils.js` import list. `CheckCircle2` stays — it's still used by `CompletedStepSummary` later in the same file.)

- [ ] **Step 4: Wrap the render in the sidebar + wider content layout**

Replace `first-run-wizard.component.tsx:769-771`:

```tsx
  return (
    <div className="min-h-screen flex items-center justify-center p-6">
      <div className="w-full max-w-xl rounded-[var(--radius-lg)] border border-[var(--color-border)] bg-[var(--color-surface-1)] p-8 space-y-6">
```

with:

```tsx
  return (
    <div className="min-h-screen flex items-center justify-center p-6">
      <div className="flex w-full max-w-5xl justify-center gap-6">
        <WizardStepSidebar steps={steps} currentIndex={stepIndex} labels={STEP_LABELS} />
        <div className="w-full max-w-xl md:max-w-2xl rounded-[var(--radius-lg)] border border-[var(--color-border)] bg-[var(--color-surface-1)] p-8 space-y-6">
```

Everything between the old line 771 and line 883 (the header, all five step blocks, the footer nav) is unchanged content — it is now nested one level deeper inside the new wrapping `<div className="flex w-full max-w-5xl justify-center gap-6">`, but no line of it needs editing.

- [ ] **Step 5: Close the new wrapper**

The original `first-run-wizard.component.tsx:883-886` has three closing tags:

```tsx
        </div>
      </div>
    </div>
  );
}
```

(883 closes the footer-nav flex div, 884 closes the card, 885 closes `min-h-screen`.) Step 4 added a fourth opened element — the `<div className="flex w-full max-w-5xl justify-center gap-6">` wrapper — so it needs a fourth closing tag. Insert one additional `</div>` immediately after the card-closing `</div>` (originally line 884) and before the `min-h-screen`-closing `</div>` (originally line 885):

```tsx
        </div>
        </div>
      </div>
    </div>
  );
}
```

- [ ] **Step 6: Run the existing wizard test suite**

Run: `npm run app:test -- first-run-wizard.component`
Expected: PASS, unchanged — none of the existing test queries (`getByRole('button', ...)`, the `/choose the cloud provider/i`, `/provision aws access/i`, `/choose the aws credentials/i` text queries) collide with the new sidebar's rendered labels ("Choose your cloud", "Provision AWS access", "AWS credentials", "Bootstrap AWS resources", "Finish setup") — verified by grep against the test file: no `getByText`/`findByText` query in `first-run-wizard.component.test.tsx` matches any `STEP_LABELS` value, and the sidebar renders plain `<li>` text (no `button`/`link` role), so the many `getByRole('button', { name: /bootstrap aws resources/i })` etc. queries (which match the real submit button in `bootstrap-step.component.tsx`) are unaffected. If this run surfaces an unexpected "multiple elements" failure, it means a test added since this plan was written now queries plain text matching a `STEP_LABELS` value — scope that query with `within(screen.getByRole('main'))` once `main` region is added in a future task, or make the query role-specific.

- [ ] **Step 7: Manual visual check**

Run `npm run desktop:dev`, resize the window across the `768px` boundary, confirm: below 768px the wizard looks identical to before this change (single centered card); at/above 768px a step list appears on the left with the current step highlighted and content noticeably wider.

- [ ] **Step 8: Lint and typecheck**

Run: `npm run app:lint` then `npm run app:typecheck`
Expected: both clean.

- [ ] **Step 9: Commit**

```bash
git add app/packages/web/src/components/first-run-wizard/wizard.utils.ts app/packages/web/src/components/first-run-wizard/first-run-wizard.component.tsx
git commit -m "feat(web): show wizard step progress and widen content at md+"
```

---

### Task 3: Full test suite + e2e audit

**Files:**
- Read only: `app/packages/web/e2e/pages/GuidedIamWizardPage.ts`
- Read only (full suite): everything under `app/packages/web`

**Interfaces:**
- Consumes: the completed Task 1 + Task 2 changes.
- Produces: a passing full test run; no new files expected unless a real break is found.

- [ ] **Step 1: Run the full unit/component suite**

Run: `npm run app:test`
Expected: PASS. (If this surfaces a failure not covered by Task 2 Step 6's collision analysis, diagnose the specific failing assertion and fix it in the affected spec file before continuing — do not proceed with a red suite.)

- [ ] **Step 2: Confirm the e2e wizard page object needs no change**

`app/packages/web/e2e/pages/GuidedIamWizardPage.ts` is the only existing wizard-related e2e page object; it is scoped to the guided-IAM step and does not assume anything about the shell's outer layout. Its `stepProgressText(label)` locator matches the regex `Step \d+ of \d+: <label>` — that text and its DOM position are unchanged by this plan (Task 2 Step 4-5 only added a wrapping sidebar and widened a max-width; the "Step N of 5: ..." paragraph itself was untouched). No page object edits are required. Confirm by reading the file once more after Task 2 lands and checking no locator references `max-w-xl`, card structure, or anything else this change touched.

- [ ] **Step 3: Run e2e**

Run: `npm run app:test:e2e`
Expected: PASS.

- [ ] **Step 4: Commit (only if Step 1 required a fix)**

```bash
git add <changed spec files>
git commit -m "test(web): fix wizard spec after step sidebar layout change"
```

If no fix was needed, skip this commit — Task 2's commit already covers the change.

---

### Task 4: Docs

**Files:**
- Modify: `docs/docs/app/first-run-wizard.md`

**Interfaces:**
- Consumes: nothing code-level.
- Produces: an accurate doc matching the new layout.

- [ ] **Step 1: Add a short layout note**

`docs/docs/app/first-run-wizard.md` currently describes the wizard's steps and flow but never its visual/DOM structure (no mention of card width or breakpoints) — confirmed by reading the file in full during planning. Near the top of the doc, after its existing header-text/subtitle description (around its line 13-14 area describing `Step N of 5: <step title>`), add a short paragraph:

```md
On screens 768px wide or larger, a step-progress list is shown to the left of
the wizard card, indicating which steps are completed, which is current, and
which are upcoming. Below that width, the wizard renders as a single centered
card, unchanged from narrower layouts.
```

Match the surrounding doc's existing heading level and tone rather than inventing a new section — insert this as a paragraph under whatever heading already covers the header/subtitle description.

- [ ] **Step 2: Run the docs style/accuracy check**

Since this is a small factual addition rather than a new page, a full `write-docs` skill pass is unnecessary — instead, re-read the edited section once and confirm: (a) the sentence is true of the shipped Task 2 behavior (768px = `md:` breakpoint, matches Tailwind's default), (b) no other part of the doc contradicts it.

- [ ] **Step 3: Commit**

```bash
git add docs/docs/app/first-run-wizard.md
git commit -m "docs: describe wizard step-progress sidebar layout"
```

---

## Self-Review Notes

- **Spec coverage:** `specs/wizard-flow/spec.md`'s "Responsive wizard shell layout" requirement → Task 2. "Step progress sidebar" requirement (states + non-interactive) → Task 1 (component + its state/no-interactive tests) and Task 2 (wiring). Both scenarios per requirement have a directly corresponding test in Task 1 or an existing/verified-unaffected test in Task 2/3.
- **Placeholder scan:** no TBD/TODO; the one open-ended step (Task 3 Step 1's "if a failure surfaces, fix it") is bounded by the collision analysis already done in Task 2 Step 6, which found zero query collisions — it is a safety net, not unresolved work.
- **Type consistency:** `WizardStepSidebarProps` (`steps`, `currentIndex`, `labels`) is used identically in Task 1's test, Task 1's implementation, and Task 2 Step 4's call site (`steps={steps} currentIndex={stepIndex} labels={STEP_LABELS}`) — `steps`/`stepIndex` already exist on the shell (`first-run-wizard.component.tsx:107-108`), `STEP_LABELS` is defined with the exact same shape (`Record<WizardStep, string>`) in both its old (shell-local) and new (`wizard.utils.ts`) locations.
