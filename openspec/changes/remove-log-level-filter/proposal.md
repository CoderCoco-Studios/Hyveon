## Why

Hyveon's log viewers (game logs, infra logs, Settings Diagnostics panel)
classify each line into INFO/WARN/ERROR/DEBUG via a client-side regex, since
Hyveon does not control the log line format emitted by game servers or its
own Lambdas. The regex frequently fails to match or misclassifies lines
(e.g. tagging an unrelated header line `ERROR` because it contains the
substring "err"), making the level badges and filter unreliable rather than
useful. Removing it eliminates a source of operator confusion and simplifies
three near-duplicate UI implementations.

## What Changes

**Log level detection and filtering**
- From: Every log line rendered on `/logs`, `/logs/infrastructure`, and the
  Settings Diagnostics panel is classified via regex into an
  INFO/WARN/ERROR/DEBUG badge, with a "Levels (N/4)" dropdown to hide lines
  by level.
- To: Log lines render with no level badge and no level filter; only
  pause/resume, autoscroll, and in-buffer search-with-highlight remain.
- Reason: the classification is unreliable given Hyveon doesn't own the log
  format, and the operator explicitly asked for removal over hardening.
- Impact: non-breaking UI simplification. No persisted state, IPC contract,
  or API surface changes.

## Capabilities

### Modified Capabilities
- `app-diagnostics-logging`: removes the level-filter behavior from the
  "Diagnostics panel pause, level filter, search, and autoscroll"
  requirement (renamed to drop "level filter"), and removes the "Level
  detection ignores embedded ANSI codes" scenario from the "ANSI-colored log
  line rendering" requirement. Pause, search, autoscroll, and ANSI rendering
  requirements are otherwise unchanged.

## Impact

- `app/packages/web/src/lib/log-level.utils.ts` and its test — deleted.
- `app/packages/web/src/components/log-line-display.component.tsx` — drops
  the `LevelFilterMenu` export.
- `app/packages/web/src/hooks/use-log-tail.hook.ts` — drops level
  detection/state (shared by `logs.page.tsx` and
  `infrastructure-logs.page.tsx`).
- `app/packages/web/src/pages/logs.page.tsx`,
  `app/packages/web/src/pages/infrastructure-logs.page.tsx`,
  `app/packages/web/src/components/DiagnosticsPanel.tsx` — drop the level
  badge column, filter control, and "N levels hidden" footer text.
- Associated test files updated to match.
- `docs/docs/app/logs.md`, `docs/docs/app/settings.md` — drop level-filter
  mentions.
