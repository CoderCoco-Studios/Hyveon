## Context

The first-run wizard (`app/packages/web/src/components/first-run-wizard/`)
is the app's mandatory first-launch experience. Its shell,
`first-run-wizard.component.tsx`, wraps every step in a single centered
`max-w-xl` (576px) card with no responsive classes anywhere in the wizard
tree (confirmed by grepping all five step components for `sm:`/`md:`/`lg:`/
`xl:`/`2xl:` — zero matches). This is inconsistent with the rest of the app:
`app-layout.component.tsx` and every routed page already use a `max-w-4xl`–
`7xl` + `sm:`/`md:`/`lg:` responsive convention, including a sidebar that
collapses to a mobile drawer below `md:`.

Wizard navigation is strictly linear: `goNext`/`goBack` are the only ways to
change `stepIndex` (`first-run-wizard.component.tsx:721,725`); there is no
jump-to-step. A resume-on-mount effect can set `stepIndex` from persisted
progress on launch, but that's state restoration, not a user-facing
navigation control.

Stakeholders: operators running the wizard on any display size, most
acutely on large/high-resolution monitors where the current fixed-width
card leaves most of the window empty.

## Goals / Non-Goals

**Goals:**
- Use the extra horizontal space available on large viewports for something
  useful (wizard-progress wayfinding) instead of leaving it empty.
- Widen the content column modestly so it doesn't feel cramped, without
  making text lines unreadably long.
- Match the app's existing responsive convention and breakpoint collapse
  pattern rather than introducing a new one.
- Keep the change presentation-only: no changes to wizard state, step
  validation, or navigation logic.

**Non-Goals:**
- No two-column reflow inside individual step content (e.g. splitting the
  guided-IAM or bootstrap steps' status/log panels into a second column).
  The sidebar alone addresses the space/scaling complaint at the
  wizard-shell level; per-step content reflow is a separate, larger effort.
- No changes to `add-game-wizard` (dialog-based, different constraints) or
  any routed page — this change is wizard-shell-only.
- No click-to-jump step navigation. The wizard's step validation and
  prerequisite checks are not designed for out-of-order entry, and adding
  that is out of scope here.

## Decisions

### D1: Step sidebar + widened content column, not just a wider cap

- **Choice**: Add a new `WizardStepSidebar` component (fixed `w-64`) shown
  at `md:` and above, alongside the existing step content whose max-width
  grows from `max-w-xl` (576px) to `max-w-2xl` (672px).
- **Rationale**: Addresses both the "wasted space" and "under-scaled
  content" complaints raised during brainstorming, and gives the wizard a
  progress overview it currently lacks (today: a single "Step N of 5" text
  line). Reuses the exact collapse pattern already established by
  `app-layout.component.tsx`'s own sidebar, so it's consistent with the
  rest of the app rather than a one-off.
- **Alternatives considered**:
  - *Just widen the max-width cap* (e.g. to `max-w-4xl`) — simplest, but
    leaves a single long-line column with most of a 4K viewport still
    empty; doesn't use the space for anything.
  - *Two-column per-step layouts* (form left / status-log right for steps
    that have both) — better per-step space usage, but only applies to 3 of
    5 steps, requires touching every step component's internal layout, and
    doesn't address wayfinding. Larger effort for a narrower win.

### D2: Sidebar is non-interactive

- **Choice**: `WizardStepSidebar` renders step state (completed/current/
  upcoming) but its entries are not clickable.
- **Rationale**: Wizard navigation is strictly linear today (D1's context);
  making sidebar entries clickable would imply jump-to-step navigation that
  the step components' validation/prerequisite logic isn't built for.
  Building that out is a separate, larger change.
- **Alternatives considered**: Clickable entries restricted to
  already-completed steps only — rejected for this change because it still
  requires auditing every step's re-entry behavior (e.g. does re-visiting
  `bootstrap` after `stack-init` re-trigger side effects?) which is outside
  this change's presentation-only scope.

### D3: Breakpoint choice (`md:`, not `lg:`)

- **Choice**: Sidebar appears at `md:` (768px) and above, matching
  `app-layout.component.tsx`'s own sidebar-collapse breakpoint.
- **Rationale**: Consistency — using a different breakpoint for the wizard
  than the rest of the app would be an unexplained divergence with no
  functional benefit.
- **Alternatives considered**: `lg:` (1024px) — rejected, no reason found
  in the existing codebase to diverge from the app-wide precedent.

## Risks / Trade-offs

- [Risk] New layout wrapper could break existing component/e2e specs that
  query the wizard card by structure (e.g. assuming it's the only wrapping
  element) → Mitigation: audit and update `first-run-wizard.component.tsx`'s
  existing spec and any e2e wizard page object as part of this change (see
  tasks.md), before considering the change done.
- [Trade-off] `max-w-2xl` still leaves visible empty space beside the
  content column on very large (4K) viewports even with the sidebar present
  → accepted: per Goals, the target is "not wasted/cramped", not "fill the
  whole screen" — a full-bleed content column would produce unreadably long
  text lines in wizard forms.
- [Trade-off] Below `md:`, none of this change is visible (sidebar hidden,
  content stays at today's width) → accepted: brainstorming confirmed the
  problem is specifically large/4K displays; small-viewport behavior is
  already acceptable and out of scope.

## Migration Plan

N/A — this change involves no deployment, data, or IPC changes. It's a
renderer-only layout change gated entirely by CSS breakpoints; no rollout
sequencing or rollback strategy beyond normal PR revert is needed.

## Open Questions

None outstanding — scope, approach, and breakpoint choice were resolved
during brainstorming (see brainstorm.md Q1-Q5) and confirmed against the
actual codebase (linear-only navigation, existing sidebar collapse pattern)
before this design was written.
