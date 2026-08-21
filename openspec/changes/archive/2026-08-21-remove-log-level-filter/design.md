## Context

`/logs` (game logs), `/logs/infrastructure` (Lambda logs), and the Settings
Diagnostics panel each render live-tailed log lines with a per-line
INFO/WARN/ERROR/DEBUG badge and a "Levels (N/4)" filter dropdown. Detection
runs client-side (`log-level.utils.ts`'s `detectLogLevel`) against a regex
matched on raw line text, since Hyveon doesn't control the log format of
game server processes or its own Lambda output. The regex misclassifies or
fails to match often enough that the operator (Chris) reported the feature
as unreliable and asked for its removal rather than a fix, since there is no
format convention to reliably anchor a client-side regex against regardless
of which log source is being read.

This is documented required behavior, not just incidental code:
`openspec/specs/app-diagnostics-logging/spec.md` has a "Diagnostics panel
pause, level filter, search, and autoscroll" requirement with a "Filtering
by level" scenario, and a "Level detection ignores embedded ANSI codes"
scenario under the shared "ANSI-colored log line rendering" requirement — so
removal needs a delta spec, not just a code change.

## Goals / Non-Goals

**Goals:**
- Remove level detection, badges, and the level filter from all three log
  surfaces (`/logs`, `/logs/infrastructure`, Diagnostics panel).
- Keep pause/resume, autoscroll, in-buffer search-with-highlight, and ANSI
  SGR color/bold rendering fully intact and unchanged on all three surfaces.
- Delete the now-dead `log-level.utils.ts` module rather than leaving it
  unused.

**Non-Goals:**
- Server-side/structured logging changes (e.g. having Hyveon's own Lambdas
  emit a parseable level prefix) — out of scope; game-server log format is
  outside Hyveon's control regardless, so a partial fix wouldn't address the
  operator's actual complaint.
- Any change to what log content is fetched, streamed, or persisted — this
  is a display-layer removal only.

## Decisions

### D1: Remove entirely, not just the filter UI
- **Choice**: Delete detection, badges, and the filter dropdown together.
- **Rationale**: the badges themselves display wrong/missing classifications
  per line; keeping badges without the filter still surfaces misleading data.
- **Alternatives considered**: keep badges, drop only the hide-by-level
  filter — rejected, doesn't address the actual complaint (bad
  classification shown to the operator).

### D2: Remove from all three surfaces in one change
- **Choice**: `/logs`, `/logs/infrastructure`, and the Diagnostics panel are
  all touched together.
- **Rationale**: `/logs` and `/logs/infrastructure` share `useLogTail` and
  `LevelFilterMenu` directly; the Diagnostics panel duplicates the same
  pattern independently against the same shared `log-level.utils.ts` and
  `LevelFilterMenu`. Removing from only one surface leaves inconsistent UI
  and dead imports in the others.
- **Alternatives considered**: phase the removal per-surface — rejected as
  unnecessary churn for a change this small and mechanical.

### D3: Delete `log-level.utils.ts` rather than leave it unused
- **Choice**: Delete the module and its test file outright.
- **Rationale**: nothing will reference `detectLogLevel`, `LogLevel`,
  `ALL_LOG_LEVELS`, or `LOG_LEVEL_BADGE` after this change; keeping a dead,
  untested-by-usage module invites bit-rot.
- **Alternatives considered**: keep it for potential future reuse —
  rejected per repo convention against speculative code; can be resurrected
  from git history if ever needed.

## Risks / Trade-offs

- [Risk] An operator relied on the level filter to skim high-signal
  ERROR-only views, even with imperfect classification → Mitigation:
  in-buffer search still lets an operator filter by a literal term (e.g.
  searching "ERROR"); this is the explicit trade-off the operator requested.
- [Trade-off] Losing at-a-glance color-coding of severity → accepted;
  ANSI-derived coloring from the log source itself (where present) still
  renders, this only removes Hyveon's own unreliable classification layer.

## Migration Plan

N/A — this change involves no deployment, IPC contract, or persisted-state
changes. It is a pure UI/display-layer removal; ship as a normal PR.

## Open Questions

None.
