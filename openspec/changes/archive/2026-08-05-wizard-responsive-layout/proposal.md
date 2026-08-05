## Why

The first-run wizard renders as a single fixed-width card (`max-w-xl`,
576px) with zero responsive classes across all five step components, so on
large/high-resolution displays it sits small and centered in a mostly empty
window while its own progress is invisible beyond a footer line. Every other
page in the app already follows a `max-w-4xl`–`7xl` + `sm:`/`md:`/`lg:`
responsive convention; the wizard is the outlier. Fixing this closes a
visible UX gap on the app's most important first-impression screen without
touching wizard logic, validation, or state.

## What Changes

**Wizard shell layout**
- From: `first-run-wizard.component.tsx` centers a single `max-w-xl` card
  regardless of viewport size; no responsive classes anywhere in the wizard
  tree.
- To: at `md:` breakpoint and above, the wizard renders a fixed-width
  (`w-64`) step sidebar alongside a content area whose max-width increases
  to `max-w-2xl`. Below `md:`, the layout is unchanged (single centered
  column).
- Reason: uses the available viewport width for wayfinding instead of
  leaving it empty, while keeping the content column narrow enough to stay
  readable.
- Impact: non-breaking, presentation-only. No change to step content,
  validation, or navigation behavior.

**Step progress visibility**
- From: the only indication of wizard progress is a "Step N of 5: <label>"
  text line in the footer area.
- To: a persistent, non-interactive step list (all 5 `WIZARD_STEPS`) is
  visible at `md:` and above, showing completed/current/upcoming state per
  step.
- Reason: gives the operator a map of the whole flow, not just the current
  position.
- Impact: non-breaking, additive. The existing "Step N of 5" text is
  unaffected (kept for the `md:`-collapsed case and as an accessible text
  equivalent).

## Capabilities

### New Capabilities

(none)

### Modified Capabilities

- `wizard-flow`: adds a requirement for the wizard shell's responsive
  layout — a step-progress sidebar at `md:` and above, plus a wider content
  column — on top of the existing flow/state/step requirements already
  specified. No existing requirement's behavior changes; this is additive.

## Impact

- Code: `app/packages/web/src/components/first-run-wizard/`
  (`first-run-wizard.component.tsx`; new `wizard-step-sidebar.component.tsx`).
- Tests: new jsdom component spec for the sidebar; existing
  `first-run-wizard` component/e2e specs and page objects updated for the
  new layout wrapper.
- No API, IPC, schema, or dependency changes.
