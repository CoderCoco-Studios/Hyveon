<!--
Raw capture of superpowers:brainstorming output.
-->

# Brainstorm: Wizard responsive layout

## Background

User request: the first-run setup wizard doesn't make use of a 4K monitor —
lacks a responsive UI.

## Project context (explored)

- Wizard components: `app/packages/web/src/components/first-run-wizard/`
  - `first-run-wizard.component.tsx` — shell (owns step index, state, footer nav)
  - `pick-cloud-step.component.tsx`, `guided-iam-step.component.tsx`,
    `credentials-step.component.tsx`, `bootstrap-step.component.tsx`,
    `stack-init-step.component.tsx` — one per step
  - `wizard.utils.ts` — pure helpers incl. `WIZARD_STEPS` order
  - Sibling pattern: `app/packages/web/src/components/add-game-wizard/` (same
    step-flow pattern but rendered inside a `<Dialog>` instead of full-page) —
    not in scope.
- Styling: Tailwind CSS v4, utility classes, no CSS Modules/styled-components/
  component library. CSS-first config in `src/index.css` `@theme` block
  (lines 5-36). Default Tailwind breakpoints in effect app-wide (`sm` 640,
  `md` 768, `lg` 1024, `xl` 1280, `2xl` 1536) — no `--breakpoint-*` overrides.
- Fixed-width problem confirmed, wizard-specific:
  `first-run-wizard.component.tsx:770-771` wraps all step content in
  `min-h-screen flex items-center justify-center p-6` >
  `w-full max-w-xl rounded-[var(--radius-lg)] border ... p-8 space-y-6`.
  `max-w-xl` = 576px, the only width constraint in the entire wizard tree.
  Grep across all 5 step components for `sm:`/`md:`/`lg:`/`xl:`/`2xl:`
  responsive prefixes returned zero matches — one static centered card
  regardless of viewport size.
- Rest of the app is comparatively responsive: `app-layout.component.tsx`
  (routed-page shell, which the wizard bypasses) uses real breakpoint logic —
  `hidden md:flex` sidebar vs. mobile drawer, `md:px-6`, `hidden sm:block`/
  `sm:inline` text. Pages then center content with a max-width cap that
  scales by content type: `dashboard.page.tsx:44` `max-w-7xl mx-auto` +
  responsive grid; `settings.page.tsx:79`/`games.page.tsx:68` `max-w-5xl`/
  `max-w-6xl`; `game-detail.page.tsx:81,145` `max-w-4xl` + `sm:grid-cols-4`;
  same convention on discord/costs/logs/iac pages.
- Wizard steps/content (5 total, `wizard.utils.ts` order): pick-cloud
  (radio-group cards), guided-iam (multi-phase form/status panels, largest
  step), credentials (mode toggle + profile picker/paste form), bootstrap
  (resource-name inputs + status cards + scrollable log list), stack-init
  (progress checklist + finish button). All single-column `space-y-*`
  stacks of forms/cards/status rows — no grids.
- Wizard navigation confirmed strictly linear: `setStepIndex` only advances/
  retreats by one via `goNext`/`goBack`
  (`first-run-wizard.component.tsx:721,725`); no jump-to-step exists. A
  resume-on-mount effect can restore a saved step index
  (`first-run-wizard.component.tsx:244-246`) but that's state restoration,
  not user-driven navigation.

## Decision chain

**Q1 — Scope: just the wizard, or app-wide responsive pass?**
A: Wizard only. Smaller, shippable, validates the approach before touching
other pages.

**Q2 — On a 4K monitor, is the app window maximized/full-screen, or resized
large?**
A: Maximized/full-screen — wizard content sits in a huge viewport but stays
small/centered.

**Q3 — What bugs you more: wasted space, or under-scaled text/controls?**
A: Both equally.

**Q4 — Any layout direction already preferred (centered-but-wider vs.
full-bleed vs. no preference)?**
A: No preference — recommend one.

**Q5 — Approach choice.** Three approaches proposed:

- **A — Just widen the cap (small).** Bump `max-w-xl` → `max-w-3xl`/`4xl`,
  add `sm:`/`md:` padding scaling. Matches app convention exactly. ~30 min.
  Doesn't meaningfully use 4K space — still a single column, most of the
  screen empty.
- **B — Two-column step layouts (medium).** Steps with both a form and a
  status/log panel (guided-iam, bootstrap, stack-init) split form-left/
  status-right at `lg:` and up, single column below. Pick-cloud and
  credentials stay single-column (nothing to split). ~2-3 hrs.
- **C — Persistent step sidebar + widened content (recommended).** Left
  step-list (all 5 steps, current position, completed state) visible at
  `md:` and up — same collapse pattern `app-layout.component.tsx` already
  uses for its main sidebar — plus content column widened to `max-w-2xl`/
  `3xl`. Uses extra horizontal space for wayfinding (wizard currently gives
  no sense of overall progress beyond a footer line), keeps text column
  readable, degrades to today's single-column below `md:`. Reuses an
  existing pattern instead of inventing one. ~3-4 hrs.

Decision: **C**, chosen because it addresses both space-usage and
under-scaling complaints and follows existing codebase precedent rather than
introducing a new layout idiom.

## Design (validated, presented in sections, approved)

**Architecture** — `first-run-wizard.component.tsx` wraps step content in a
flex row at `md:` and up: fixed-width sidebar (`w-64`) + content area.
Content column widens from `max-w-xl` (576px) to `max-w-2xl` (672px), still
centered within its flex space. Below `md:`, sidebar hidden, current
single-column layout unchanged.

**Components** — New `WizardStepSidebar` component: presentational only,
props `steps`, `currentIndex`. Renders all 5 steps with three visual states
— completed (check icon), current (highlighted), upcoming (dimmed).
**Not clickable** — wizard nav is linear only (confirmed above), so making
entries clickable would be misleading; it's a progress map, not a nav
control.

**Data flow** — No new state. `first-run-wizard.component.tsx` already owns
`stepIndex`/`steps` — passed down as props to the new sidebar alongside the
existing step content render.

**Error handling** — None needed — pure display component, no async/IO.

**Testing** — New jsdom component spec for `WizardStepSidebar` (renders 5
steps, correct state per step). Update existing wizard component/e2e specs
for the new layout wrapper (width/visibility assumptions).

## Non-goals (surfaced during design)

- No two-column reflow within individual step content (splitting guided-IAM
  or bootstrap steps' status panels into a second column) — separate, larger
  effort, not needed to close the space/scaling gap at the wizard-shell
  level.
- No changes to `add-game-wizard` or any routed page.

## Outcome

User approved the design (option C) and confirmed proceeding to a written
spec. Design promoted to OpenSpec change `wizard-responsive-layout` via
`/opsx:propose` per this repo's brainstorm→opsx routing rule (narrative
brainstorming must not write directly to `docs/superpowers/specs/`).
