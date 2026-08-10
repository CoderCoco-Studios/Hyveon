## Why

The `/logs` page and the Settings → Diagnostics panel render CloudWatch and
in-app log lines as plain text. Lines containing SGR ANSI color codes —
emitted by steamcmd and game-server install scripts, e.g.
`\x1b[1;36m****EXECUTING USERMOD****\x1b[0m` — show the raw escape bytes
(`␛[1;36m****EXECUTING USERMOD****␛[0m`) instead of being colorized or
stripped, making install/update output hard to read. A hand-rolled SGR
parser already exists for the Pulumi/IaC run viewer
(`ansi-log-viewer.component.tsx`) but isn't wired to the shared
`HighlightedLine` component both pages actually use.

## What Changes

**ANSI rendering in the shared log-line component**
- From: `HighlightedLine` renders raw line text with search-match
  highlighting only; any ANSI escape sequence prints as literal characters.
- To: `HighlightedLine` parses each line into ANSI-styled segments first
  (reusing and extending the existing SGR parser), rendering SGR color/bold
  as Tailwind design-token classes and silently discarding every other
  escape sequence (cursor moves, clear-line, etc.), then applies
  search-match highlighting within each segment.
- Reason: `/logs` and the Diagnostics panel share this component, so
  fixing it once fixes both surfaces; the existing parser already targets
  this app's design tokens.
- Impact: Non-breaking. `HighlightedLine`'s public signature (`{ text,
  query }`) is unchanged; only its internal rendering changes. No new npm
  dependency.

**Log-level detection ignores ANSI noise**
- From: `detectLogLevel` matches its INFO/WARN/ERROR/DEBUG keyword regex
  against the raw line, including any embedded escape bytes.
- To: `detectLogLevel` strips ANSI escape sequences before matching.
- Reason: prevents an escape sequence from ever interfering with
  level-badge classification.
- Impact: Non-breaking; behavior is identical for lines with no ANSI
  codes, and now correctly classifies previously-unaffected ANSI-wrapped
  lines the same way.

**Shared ANSI utilities extracted**
- `parseAnsiLine`, `AnsiSegment`, and `FG_COLOR_CLASS` move from
  `ansi-log-viewer.component.tsx` into a new `lib/ansi.utils.ts`, alongside
  a new `stripAnsi` helper. `ansi-log-viewer.component.tsx` re-imports from
  there with no behavior change to the existing Pulumi/IaC run viewer.

## Capabilities

### Modified Capabilities
- `app-diagnostics-logging`: the Diagnostics panel (and, by way of the
  shared `HighlightedLine` component, the `/logs` page) must render SGR
  ANSI color codes as styled text and silently discard other ANSI escape
  sequences, instead of showing raw escape bytes; log-level detection must
  ignore ANSI codes when classifying a line.

## Impact

- Affected code: `app/packages/web/src/components/log-line-display.component.tsx`,
  `app/packages/web/src/components/ansi-log-viewer.component.tsx`,
  `app/packages/web/src/lib/log-level.utils.ts`, new
  `app/packages/web/src/lib/ansi.utils.ts`.
- Affected surfaces: `/logs` page, Settings → Diagnostics panel (both
  consume `HighlightedLine`/`detectLogLevel`). No changes required to
  `logs.page.tsx` or `DiagnosticsPanel.tsx` themselves.
- Dependencies: none added or removed.
- No API, IPC, or infra changes.
