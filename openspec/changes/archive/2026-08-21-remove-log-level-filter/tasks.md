## 1. Delete the level-detection module

- [x] 1.1 Delete `app/packages/web/src/lib/log-level.utils.ts`
- [x] 1.2 Delete `app/packages/web/src/lib/log-level.utils.test.ts`

## 2. Strip the shared filter UI

- [x] 2.1 Remove `LevelFilterMenu` and its now-unused imports (`Badge`,
  `Filter`, dropdown-menu components, `ALL_LOG_LEVELS`, `LOG_LEVEL_BADGE`,
  `LogLevel`) from
  `app/packages/web/src/components/log-line-display.component.tsx`, keeping
  `HighlightedLine` and its helpers unchanged
- [x] 2.2 Update `log-line-display.component.test.tsx` to remove
  `LevelFilterMenu` test cases

## 3. Strip level state from the shared tail hook

- [x] 3.1 In `app/packages/web/src/hooks/use-log-tail.hook.ts`: drop
  `level` from `LogLine`, drop `hiddenLevels`/`toggleLevel` from
  `UseLogTailResult` and their implementations, stop calling
  `detectLogLevel` in `appendLine` and the initial-snapshot map, remove the
  `detectLogLevel`/`LogLevel` import, and simplify `visibleLines`
  accordingly
- [x] 3.2 Update `use-log-tail.hook.test.ts` to remove level-detection and
  hiddenLevels/toggleLevel test cases

## 4. Strip the level UI from both log-tail pages

- [x] 4.1 In `app/packages/web/src/pages/logs.page.tsx`: remove the
  `LOG_LEVEL_BADGE` import, `LevelFilterMenu` usage, per-line badge/gutter
  branch, `hiddenLevels`/`toggleLevel` destructuring and handler, the
  mobile "Filters" hidden-count badge, and the footer's "N levels hidden"
  segment
- [x] 4.2 Apply the same removals to
  `app/packages/web/src/pages/infrastructure-logs.page.tsx`
- [x] 4.3 Update `logs.page.test.tsx` and `infrastructure-logs.page.test.tsx`
  to remove level-related assertions

## 5. Strip the level UI from the Diagnostics panel

- [x] 5.1 In `app/packages/web/src/components/DiagnosticsPanel.tsx`: remove
  `DiagnosticsLine`/`level`, the `LOG_LEVEL_BADGE`/`detectLogLevel`/
  `LogLevel` imports, `hiddenLevels`/`toggleLevel` state, `LevelFilterMenu`
  usage, `classifiedLines`, the badge/gutter branch, and the "N levels
  hidden" footer segment; collapse `visibleLines` to `lines` directly and
  drop the now-unreachable "All lines hidden by the level filter"
  empty-state copy
- [x] 5.2 Update `DiagnosticsPanel.test.tsx` to remove level-related
  assertions

## 6. Docs

- [x] 6.1 Update `docs/docs/app/logs.md` to drop level-filter/badge mentions
- [x] 6.2 Update `docs/docs/app/settings.md` to drop level-filter/badge
  mentions

## 7. Verify

- [x] 7.1 `grep -rn "LogLevel\|log-level.utils\|LevelFilterMenu\|hiddenLevels" app/packages docs/docs` returns nothing
- [x] 7.2 `npm run app:lint`
- [x] 7.3 `npm run app:typecheck` — blocked by a pre-existing, unrelated
  environment gap (`archiver`/`@types/archiver` missing from `node_modules`
  in `DiagnosticsBundleService.ts`, reproduces identically on `main`); no
  errors in any file this change touches
- [x] 7.4 `npm run app:test`
