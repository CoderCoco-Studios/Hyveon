# Remove log-level detection/filtering — Implementation Plan

> **For agentic workers:** Use superpowers:subagent-driven-development
> to implement this plan task-by-task.

**Goal:** Delete the unreliable client-side INFO/WARN/ERROR/DEBUG
classification and its filter UI from `/logs`, `/logs/infrastructure`, and
the Settings Diagnostics panel, keeping pause/search/autoscroll/ANSI
rendering intact.

**Architecture:** Pure deletion along existing seams — one shared util
(`log-level.utils.ts`), one shared filter component (`LevelFilterMenu`), one
shared hook (`useLogTail`), and one independent implementation
(`DiagnosticsPanel.tsx`) that mirrors the same pattern. No new abstractions.

**Tech Stack:** React/TypeScript (`@hyveon/web`), Vitest.

---

## Task 1: Delete the level-detection module

- [ ] **Step 1:** `rm app/packages/web/src/lib/log-level.utils.ts app/packages/web/src/lib/log-level.utils.test.ts`

## Task 2: Strip the shared filter UI

- [ ] **Step 1:** Remove the `LevelFilterMenu` function and its dedicated
  imports (`Badge`, `Filter`, `DropdownMenu*`, `ALL_LOG_LEVELS`,
  `LOG_LEVEL_BADGE`, `LogLevel`) from `log-line-display.component.tsx`,
  leaving `HighlightedLine`/`findMatches`/`sliceSegment` untouched
- [ ] **Step 2:** Update `log-line-display.component.test.tsx` — remove
  `describe`/`it` blocks exercising `LevelFilterMenu`
- [ ] **Step 3:** `npx vitest run log-line-display.component.test.tsx` (from
  `app/packages/web`) to confirm the trimmed file still passes

## Task 3: Strip level state from `useLogTail`

- [ ] **Step 1:** Edit `use-log-tail.hook.ts`: drop the `detectLogLevel`/
  `LogLevel` import; `LogLine` loses `level`; `appendLine` and the initial
  snapshot map build `{ text, receivedAt: Date.now() }` only
- [ ] **Step 2:** Drop `hiddenLevels` state, `toggleLevel` callback, and
  both from `UseLogTailResult`'s type and returned object
- [ ] **Step 3:** Simplify `visibleLines` — since there's no level filter
  left, it becomes `lines` (or drop the memo entirely if nothing else feeds
  it filtering logic; check for a `search`-based filter still needed here —
  currently search filtering happens in `HighlightedLine`, not `useLogTail`,
  so `visibleLines` likely collapses to returning `lines` directly)
- [ ] **Step 4:** Update `use-log-tail.hook.test.ts` — remove level-
  detection assertions and `toggleLevel`/`hiddenLevels` test cases
- [ ] **Step 5:** `npx vitest run use-log-tail.hook.test.ts` (from
  `app/packages/web`)

## Task 4: Strip the level UI from both log-tail pages

- [ ] **Step 1:** In `logs.page.tsx`: drop the `LOG_LEVEL_BADGE` import,
  `LevelFilterMenu` usage (both desktop and mobile-drawer instances),
  `hiddenLevels`/`toggleLevel` destructuring, `toggleLevelHandler`, the
  mobile "Filters" hidden-count span, the per-line `<Badge>`/gutter branch
  (render `<HighlightedLine>` directly with no leading column), and the
  footer's "N levels hidden" segment
- [ ] **Step 2:** Apply the identical set of removals to
  `infrastructure-logs.page.tsx`
- [ ] **Step 3:** Update `logs.page.test.tsx` and
  `infrastructure-logs.page.test.tsx` to drop level-badge/filter assertions
- [ ] **Step 4:** `npx vitest run logs.page.test.tsx infrastructure-logs.page.test.tsx`
  (from `app/packages/web`)

## Task 5: Strip the level UI from the Diagnostics panel

- [ ] **Step 1:** In `DiagnosticsPanel.tsx`: drop `DiagnosticsLine`'s
  `level` field, the `LOG_LEVEL_BADGE`/`detectLogLevel`/`LogLevel` imports,
  `hiddenLevels` state and `toggleLevel` callback, `LevelFilterMenu` usage,
  `classifiedLines`, the per-line badge/gutter branch, and the "N levels
  hidden" footer segment
- [ ] **Step 2:** Collapse `visibleLines` to reference `lines` directly;
  replace the now-unreachable "All lines hidden by the level filter" empty
  state with the plain "No log lines available." message (the only
  remaining empty case)
- [ ] **Step 3:** Update `DiagnosticsPanel.test.tsx` to drop level-related
  assertions
- [ ] **Step 4:** `npx vitest run DiagnosticsPanel.test.tsx` (from
  `app/packages/web`)

## Task 6: Docs

- [ ] **Step 1:** Update `docs/docs/app/logs.md` to remove level-badge/
  filter mentions from the `/logs` and `/logs/infrastructure` descriptions
- [ ] **Step 2:** Update `docs/docs/app/settings.md` to remove the
  Diagnostics panel's level-filter mention

## Task 7: Full verification

- [ ] **Step 1:** `grep -rn "LogLevel\|log-level.utils\|LevelFilterMenu\|hiddenLevels" app/packages docs/docs` — must return nothing
- [ ] **Step 2:** `npm run app:lint`
- [ ] **Step 3:** `npm run app:typecheck`
- [ ] **Step 4:** `npm run app:test`
- [ ] **Step 5:** `openspec validate remove-log-level-filter --strict`
