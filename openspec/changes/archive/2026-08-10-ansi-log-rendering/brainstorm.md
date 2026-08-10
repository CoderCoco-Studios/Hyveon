<!--
Raw capture of superpowers:brainstorming output.
-->

## Background

The operator asked what it would take to make the Logs page render special
characters — pasted a real game-server console log (steamcmd/usermod install
output) containing literal raw ANSI escape bytes rendered as `␛[1;36m`,
`␛[0;37m`, `␛[1;33m`, `␛[0m` instead of being interpreted as color codes.

Initial investigation (Explore agent + direct grep) found:

- `app/packages/web/src/pages/logs.page.tsx` (the `/logs` page) renders each
  line via `<HighlightedLine text={line.text} query={search} />`
  (`log-line-display.component.tsx`) — plain JSX text nodes, no ANSI
  handling, no `dangerouslySetInnerHTML`.
- `app/packages/web/src/components/ansi-log-viewer.component.tsx` already
  has a hand-rolled SGR ANSI parser (`parseAnsiLine`, `AnsiSegment`,
  `FG_COLOR_CLASS`) used only by the Pulumi/IaC run viewer (`AnsiLogViewer`)
  — maps SGR foreground color codes (30-37, 90-97) and bold to this app's
  Tailwind CSS custom-property color tokens. Not wired to `/logs`.
- No `ansi-to-html`/`anser`/etc. dependency exists in the repo; only
  transitive `ansi-styles`/`ansi-regex` from CLI tooling (chalk), unused by
  the web app.
- `docs/docs/app/logs.md` documents level-badge coloring via regex
  (`detectLogLevel`, `log-level.utils.ts`), search highlighting (not
  filtering), Levels filter, autoscroll/pause-resume, 1000-line buffer — no
  mention of ANSI handling.
- `HighlightedLine`/`LevelFilterMenu` (`log-line-display.component.tsx`) are
  shared by two consumers: `logs.page.tsx` and `DiagnosticsPanel.tsx`.

## Decision chain

**Q1. Should ANSI color rendering apply to both consumers of the shared
log-line component, or just the /logs page?**
→ **Both /logs and Diagnostics panel.** Same `HighlightedLine` component is
shared by both — fixing it there fixes both for free; Diagnostics would
otherwise keep showing the same raw-escape-code garbage.

**Q2. Game server tools sometimes emit non-color ANSI codes too (cursor
moves, clear-line, etc.), not just SGR color codes. Should the parser strip
those silently as well, or only handle SGR color/bold?**
→ **Strip all ANSI escape sequences; only render SGR ones as color.** Any
escape sequence the parser doesn't recognize is removed rather than left as
visible garbage — guarantees no raw `␛[...]` bytes ever reach the screen,
matching what a real terminal does (interpret or discard, never show raw).

**Approaches considered for the parsing mechanism:**

- **A — Extract & extend the existing hand-rolled parser (chosen).** Move
  `parseAnsiLine`/`FG_COLOR_CLASS` into a shared `lib/ansi.utils.ts`, extend
  the regex to strip non-SGR CSI sequences too, wire into `HighlightedLine`
  so segments carry both ANSI color and search-match highlighting. Zero new
  dependencies, consistent styling with the existing Pulumi log viewer,
  small diff.
- **B — Adopt a third-party ANSI-to-HTML library** (`ansi-to-html`/`anser`).
  Broader escape-sequence coverage out of the box (24-bit color, background
  colors), but a new dependency, its own palette to reconcile with this
  app's Tailwind design tokens, and doesn't compose out-of-the-box with the
  existing search-highlight/level-badge logic.

**Recommendation: A.** The repo already invested in a hand-rolled parser
mapped to its exact design tokens; extending it is lower risk than
reconciling a third-party library's output with `HighlightedLine`'s `<mark>`
wrapping and `detectLogLevel`'s regex.

**Q3. `detectLogLevel` scans raw line text for INFO/WARN/ERROR keywords.
Should it strip ANSI codes before matching?**
→ **Yes, strip before detecting level.** Prevents an escape sequence from
ever interfering with keyword matching; consistent with already
stripping/parsing ANSI for rendering.

## Approved design

1. Extract `parseAnsiLine`/`AnsiSegment`/`FG_COLOR_CLASS` out of
   `ansi-log-viewer.component.tsx` into a new shared module
   `app/packages/web/src/lib/ansi.utils.ts`. `ansi-log-viewer.component.tsx`
   re-imports from there — no behavior change to the existing Pulumi/IaC log
   viewer.
2. Extend the parser to match and silently strip ANY CSI escape sequence
   (`\x1b[...<final-byte>`), not just SGR (`m`-terminated) ones. Only SGR
   sequences produce color/bold styling; everything else is consumed and
   discarded.
3. Add a `stripAnsi(text)` helper (same module) that removes all ANSI
   escape sequences from a string, for use in level detection.
4. `log-level.utils.ts`'s `detectLogLevel`: strip ANSI codes from the line
   (via `stripAnsi`) before running its INFO/WARN/ERROR/DEBUG keyword regex.
5. `log-line-display.component.tsx`'s `HighlightedLine`: change from
   splitting raw text on search-query matches only, to first parsing the
   line into `AnsiSegment[]` via `parseAnsiLine`, then running the existing
   case-insensitive search-highlight splitting logic within each segment's
   text — so each rendered `<span>` carries both the segment's ANSI
   color/bold class AND a nested `<mark>` for any search match. No
   prop/API changes to `HighlightedLine`'s exported signature
   (`{ text, query }`).
6. No changes needed to `logs.page.tsx` or `DiagnosticsPanel.tsx` — both
   already call `HighlightedLine`/`detectLogLevel`; the fix is centralized
   in the shared lib/component.
7. No new npm dependencies.
8. Error handling: malformed/incomplete escape sequences degrade to plain
   text for that fragment rather than throwing, matching the existing
   "unrecognized SGR sub-code is ignored" philosophy already in
   `parseAnsiLine`.

**Testing:** unit tests for `parseAnsiLine`/`stripAnsi` covering SGR
color+bold, non-SGR CSI sequences (cursor move, clear-line) being dropped,
and malformed/incomplete sequences; a `detectLogLevel` test confirming
ANSI-wrapped level keywords still classify correctly; a `HighlightedLine`
component test asserting combined ANSI-color + search-highlight rendering;
confirm existing `AnsiLogViewer`/Pulumi-viewer tests still pass unchanged
after the extraction.

**Scope:** single cohesive frontend change (~4-5 files: new
`lib/ansi.utils.ts`, edits to `ansi-log-viewer.component.tsx`,
`log-line-display.component.tsx`, `log-level.utils.ts`, plus new/updated
tests) — ships as one PR, not a stack, per this repo's pr-stacking rule
(doesn't naturally decompose into independent groups).

User approved this design ("yes") before promotion to `/opsx:propose`.
