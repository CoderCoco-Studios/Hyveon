## Context

`/logs` (CloudWatch tail) and the Settings → Diagnostics panel
(`DiagnosticsPanel.tsx`, in-app log tail) both render log lines through the
shared `HighlightedLine` component in
`app/packages/web/src/components/log-line-display.component.tsx`, and both
classify line severity via `detectLogLevel` in
`app/packages/web/src/lib/log-level.utils.ts`. Neither path interprets ANSI
escape sequences, so game-server tooling output (steamcmd, install scripts)
that includes SGR color codes renders the raw escape bytes on screen.

A working SGR parser already exists — `parseAnsiLine`/`AnsiSegment`/
`FG_COLOR_CLASS` in `ansi-log-viewer.component.tsx` — built for the
Pulumi/IaC run viewer (`AnsiLogViewer`), mapping the 16 standard SGR
foreground codes and bold to this app's Tailwind CSS custom-property color
tokens. It is not currently reachable from `HighlightedLine`.

## Goals / Non-Goals

**Goals:**
- Render SGR color/bold ANSI codes as styled text on both `/logs` and the
  Diagnostics panel.
- Never show a raw ANSI escape sequence on screen, even for sequences the
  parser doesn't style (cursor moves, clear-line, etc.).
- Keep search-match highlighting (`<mark>`) working correctly on
  ANSI-colored lines.
- Keep log-level badge classification (`detectLogLevel`) correct on
  ANSI-colored lines.
- No new runtime dependency; no behavior change to the existing
  Pulumi/IaC `AnsiLogViewer`.

**Non-Goals:**
- Full terminal emulation (cursor positioning, alternate screen buffer,
  256-color/24-bit color, background colors). Only what's needed to stop
  raw escape bytes from leaking into the DOM and to preserve today's SGR
  color support.
- Changes to `logs.page.tsx` or `DiagnosticsPanel.tsx` themselves — the fix
  is centralized in the shared lib/component layer they already both call.

## Decisions

### D1: Extract the existing parser into a shared lib module rather than duplicating or importing component-to-component

- **Choice**: Move `parseAnsiLine`, `AnsiSegment`, `FG_COLOR_CLASS` from
  `ansi-log-viewer.component.tsx` into a new
  `app/packages/web/src/lib/ansi.utils.ts`. `ansi-log-viewer.component.tsx`
  imports them back from the new module.
- **Rationale**: `HighlightedLine` lives in `components/`, not
  `components/ansi-log-viewer.component.tsx`; importing parser internals
  from one component file into another creates an awkward, non-obvious
  dependency. This repo's existing convention (`log-level.utils.ts`,
  `utils.utils.ts`) is to keep pure logic in `lib/`.
- **Alternatives considered**: leave the parser in
  `ansi-log-viewer.component.tsx` and import it directly into
  `log-line-display.component.tsx` — rejected as a component-to-component
  import of non-component logic, and it would make `ansi-log-viewer`
  responsible for an API surface it doesn't own.

### D2: Reuse and extend the hand-rolled parser instead of adopting a third-party ANSI-to-HTML library

- **Choice**: Extend `parseAnsiLine`'s regex to match and discard any CSI
  escape sequence (`\x1b[...<final-byte>`), not only SGR (`m`-terminated)
  ones. SGR sequences still produce color/bold segments; every other
  matched sequence is dropped from the output with no styling effect.
- **Rationale**: the existing parser already maps SGR codes onto this
  app's exact Tailwind design tokens, and the search-highlight logic in
  `HighlightedLine` needs to compose with per-segment styling — that
  composition is far simpler on top of a parser this app already controls
  than on top of a third-party library's own DOM/HTML output.
- **Alternatives considered**: `ansi-to-html`/`anser`. Rejected — new
  dependency, ships its own default palette that would need remapping to
  this app's tokens, and produces HTML strings (or its own node tree) that
  don't natively compose with `HighlightedLine`'s `<mark>`-wrapping for
  search matches without extra glue code anyway. The hand-rolled extension
  gets the same outcome (no raw escape bytes ever shown) with less
  integration risk.

### D3: `stripAnsi` as a small standalone helper, used by `detectLogLevel`

- **Choice**: Add `stripAnsi(text: string): string` to `lib/ansi.utils.ts`,
  built on the same escape-sequence regex as `parseAnsiLine`. Call it from
  `detectLogLevel` before running the level-keyword regex.
- **Rationale**: `detectLogLevel` only needs plain text, not styled
  segments — reusing `parseAnsiLine` there would mean discarding segment
  structure immediately after building it. A single regex-based strip is
  simpler and cheaper for that call site.
- **Alternatives considered**: derive level detection from
  `parseAnsiLine`'s segments (concatenate segment text) — rejected as
  unnecessary indirection for a plain-text-in, plain-text-out need.

### D4: Malformed/incomplete escape sequences degrade to plain text, never throw

- **Choice**: Any ANSI-like byte sequence the regex doesn't fully match
  (e.g. a truncated `\x1b[` at a line/chunk boundary) is left as-is in the
  segment text rather than causing a parse error.
- **Rationale**: matches the existing `parseAnsiLine` philosophy
  ("unrecognized SGR sub-code is ignored... degrades to plain, unstyled
  text instead of throwing"); log rendering must never crash the page on
  unexpected input from an external process.
- **Alternatives considered**: throwing/logging a parse warning — rejected,
  log lines are untrusted external input by nature and a parse failure
  there must be inert, not disruptive.

## Risks / Trade-offs

- [Risk] A CSI-sequence regex broad enough to catch cursor-move/clear-line
  codes could, in theory, over-match and swallow legitimate `\x1b[`
  characters that aren't actually escape sequences → Mitigation: CSI
  sequences have a well-defined grammar (`ESC [` + parameter bytes `0-9;`
  + a single final byte in a fixed range); the regex only matches that
  exact shape, so it cannot consume arbitrary following text.
- [Trade-off] Stripping unknown escape sequences silently (vs. rendering
  some visible placeholder) means an operator can't tell a sequence was
  removed → accepted: the goal is parity with how a real terminal displays
  such output (interpreted or invisible, never raw bytes), and this
  matches user-approved design intent from brainstorming.
- [Trade-off] No support for 256-color/24-bit/background SGR codes →
  accepted as a Non-Goal; matches the existing `AnsiLogViewer` behavior
  today (16-color foreground + bold only), so no regression, and covers
  what steamcmd/game-server tooling actually emits.

## Migration Plan

N/A — this change involves no deployment, API, IPC, or data changes. It's a
pure frontend rendering fix behind existing component boundaries; ships as
a normal PR.

## Open Questions

None — all forks were resolved during brainstorming (see `brainstorm.md`).
