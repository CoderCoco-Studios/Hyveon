---
paths:
  - "**/*.{ts,tsx}"
---

# TypeScript Coding Conventions

## Doc coverage and env access are non-negotiable, not code-review nits

1. **TSDoc on every non-trivial function, class, interface, and notable
   constant.** Format and tag rules live in `tsdoc-tags.md` — this rule is the
   "must have one," that rule is the "must be shaped correctly." Trivial
   getters/setters/wrappers still need a one-line summary; see
   `comment-conciseness.md` for how much detail scales with what the function
   actually does.
2. **No raw `process.env` in business logic.** Wrap env access behind a
   service method so tests can stub it with `vi.spyOn` instead of mutating
   `process.env` directly.

**Why:** wrapping env access is what makes rule 2 testable without global
mutation — a service method is stubbable per test, `process.env` is shared
global state that leaks between tests and hides which config a piece of logic
actually depends on.

## Component size and extraction

A component function body over ~200 lines, or holding more than ~8
`useState`/`useEffect` calls, must be split before the PR opens. Two cuts, in
this order: (a) move the data/IPC orchestration into a `use-*.hook.ts` beside
the component, leaving a presentational body; (b) extract any `.map()`
callback whose JSX body exceeds ~15 lines into a named child component. A
file may hold several small related components, but the *file* should be
split into a directory once it passes ~400 lines.

**Why:** `first-run-wizard.component.tsx`, `guided-iam-step.component.tsx`,
`iac.page.tsx`, and `networking-step.component.tsx` each grew to a single
450–900-line function fusing a state machine with its markup; the cost is
that every one of them needed a multi-day extraction with a real regression
risk (see the `tech-debt-01` PR stack, issue #555), where an incremental
split would have been free.

## Reach for a primitive before pasting markup

Before hand-writing a label+input+error group, a `role="alert"` paragraph, a
page header, a status pill, an empty state, or a spinner, check
`app/packages/web/src/components/ui/` and `app/packages/web/src/components/`
for an existing primitive. If none exists and this would be the **third**
copy of the shape, extract the primitive in the same PR rather than pasting.
Never copy a Tailwind class string longer than one line between files —
extract it.

**Why:** the third-copy rule is exactly where drift starts. Seven raw
`<select>` elements in `networking-step.component.tsx` copied a class string
that had diverged from `ui/input.component.tsx` (no focus ring); a
`role="alert"` red paragraph existed 15 times identically; `formatTimestamp`
was byte-identical in 4 files; and `deployment-settings-form.component.tsx`
once *documented* its duplication of `SnowflakeChipsInput` instead of
resolving it — with the copy having silently lost snowflake validation (all
fixed in the `tech-debt-01` PR stack, issue #555).
