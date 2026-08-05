## 1. WizardStepSidebar component

- [x] 1.1 Create `wizard-step-sidebar.component.tsx` in
      `app/packages/web/src/components/first-run-wizard/`: props
      `steps: WizardStep[]`, `currentIndex: number`; renders each step with
      completed/current/upcoming visual state per D2 (non-interactive, no
      click handlers).
- [x] 1.2 Write jsdom component spec covering: renders all 5 steps; correct
      state (completed/current/upcoming) at `currentIndex = 0`, a middle
      index, and the last index; entries have no interactive role/handler.

## 2. Wizard shell layout

- [x] 2.1 Update `first-run-wizard.component.tsx`'s render (around
      lines 770-771) to a `md:`-breakpoint flex row: `WizardStepSidebar`
      (`w-64`) + existing step content, matching
      `app-layout.component.tsx`'s sidebar-collapse breakpoint (D3).
- [x] 2.2 Widen the step content container from `max-w-xl` to `max-w-2xl`.
- [~] 2.3 Verify below-`md:` behavior is visually unchanged from
      pre-change (single centered column, sidebar not rendered/hidden).
      Not run — no display access in this session; JSX nesting
      independently verified balanced by task review instead. Needs a
      human visual check at the md: (768px) boundary.

## 3. Test updates

- [x] 3.1 Audit `first-run-wizard.component.tsx`'s existing component spec
      for assumptions about the wrapping DOM structure (e.g. queries
      assuming the card is the outermost element) and update for the new
      layout wrapper. Fixed 2 collisions in this file plus 1 more found in
      `settings.page.test.tsx` (Reconfigure flow renders the same
      component/sidebar) — all via `{ selector: 'p' }` scoping.
- [x] 3.2 Audit e2e wizard page object(s) for the same width/visibility
      assumptions; update locators if they break under the new layout.
      Confirmed no change needed: `GuidedIamWizardPage.stepProgressText()`
      matches the full "Step N of Y: <label>" prefix, which the sidebar's
      bare label text doesn't contain.
- [x] 3.3 Run `npm run app:test`, `npm run app:typecheck`, `npm run app:lint`
      and confirm all pass. 2678/2678 tests, lint/typecheck clean.
- [x] 3.4 Run `npm run app:test:e2e` (wizard specs) and confirm pass.
      96/96 passing (chromium + electron projects).

## 4. Documentation

- [x] 4.1 Update `docs/docs/app/` (or the relevant wizard page) to mention
      the responsive shell layout, if that doc currently describes the
      wizard's visual structure.
