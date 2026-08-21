<!--
Raw capture of superpowers:brainstorming output.
-->

# Brainstorm: remove log-level detection/filtering

## Background

Chris (operator/maintainer) flagged, via a screenshot of the `/logs` page,
that the server logs viewer shows a "Levels (4/4)" filter and per-line
INFO/WARN/ERROR/DEBUG badges, but the classification is unreliable: Hyveon
does not control the format of game-server or Lambda log output, so the
regex in `log-level.utils.ts` (`/\b(INFO|WARN(?:ING)?|ERROR|ERR|DEBUG|DBG)\b/i`)
frequently fails to match real lines, or misclassifies (e.g. arbitrary text
containing the substring "ERR" inside HTTP dump output, per the screenshot's
`x-sentry-error` header line getting tagged `ERROR`).

## Decision chain

**Q1: Harden the regex, or remove the feature?**
Considered narrowing the regex (anchor to line start, require a bracket/log
prefix convention) vs. removing it outright. Rejected hardening: there is no
consistent convention across game-server engines and Lambda log formats to
anchor against — any regex is guessing at a format Hyveon doesn't own, so a
tighter regex trades false positives for false negatives (silently hiding
lines under a level filter) without fixing the root cause. Chris's own framing
("isn't really working," "would be simplest to just remove this feature
entirely") confirms removal over repair.

**Q2: Remove client-side only, or also from what's speced as required
behavior?**
`openspec/specs/app-diagnostics-logging/spec.md` documents this as required
behavior: the "Diagnostics panel pause, level filter, search, and autoscroll"
requirement (with a "Filtering by level" scenario) and a "Level detection
ignores embedded ANSI codes" scenario under the shared "ANSI-colored log line
rendering" requirement. Since this is documented required behavior, not just
incidental code, the removal needs a delta spec (this change) rather than a
direct PR — per repo convention ("Anything that changes required behaviour
goes through a change, not straight into openspec/specs/").

**Q3: Scope — game logs (`/logs`), infra logs (`/logs/infrastructure`), and
Settings Diagnostics panel, or just one surface?**
All three share the same level-detection/filter machinery: `log-level.utils.ts`
(detection + badge metadata), `LevelFilterMenu` (shared dropdown component in
`log-line-display.component.tsx`), and `useLogTail` (shared hook backing both
`/logs` and `/logs/infrastructure`; `DiagnosticsPanel.tsx` duplicates the
same pattern independently). Removing it from only one surface would leave
inconsistent UI and dead code in the others. Decision: remove from all three
in one change.

**Q4: What stays?**
Pause/resume, autoscroll, in-buffer search with highlighting, and ANSI
SGR color/bold rendering are independent behaviors (not level-dependent) and
stay untouched on all three surfaces.

## Design trade-offs

- **Alternative considered**: keep level detection but drop only the *filter*
  UI (still show badges, just not hide-by-level). Rejected — the badges
  themselves are the unreliable/misleading part (wrong or missing
  classification shown per line), not just the filter; keeping badges alone
  still surfaces bad data to the operator.
- **Alternative considered**: server-side/structured logging fix (have
  Hyveon's own Lambda code emit a parseable level prefix) so client-side
  detection becomes reliable for at least Lambda logs. Out of scope — game
  server log format is fundamentally outside Hyveon's control regardless, and
  Chris asked for removal, not a partial fix.

## Validated design (summary)

Delete `log-level.utils.ts` and its test. Remove `LevelFilterMenu` from the
shared line-display component. Strip level state/detection from `useLogTail`
(the hook shared by `/logs` and `/logs/infrastructure`) and from
`DiagnosticsPanel.tsx`'s parallel implementation. Remove the per-line badge
column and "N levels hidden" footer text from all three surfaces. Update
`docs/docs/app/logs.md` and `docs/docs/app/settings.md`. Update the
`app-diagnostics-logging` delta spec to remove the level-filter requirement
scenario and the ANSI level-detection scenario, keeping the rest of both
requirements intact.
