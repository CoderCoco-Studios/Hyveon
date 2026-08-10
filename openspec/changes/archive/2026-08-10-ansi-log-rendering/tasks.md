## 1. Shared ANSI utilities

- [x] 1.1 Create `app/packages/web/src/lib/ansi.utils.ts` containing
      `AnsiSegment`, `FG_COLOR_CLASS`, and `parseAnsiLine`, moved verbatim
      from `ansi-log-viewer.component.tsx`.
- [x] 1.2 Extend the escape-sequence matching in `ansi.utils.ts` to
      recognize any CSI sequence (`\x1b[...<final-byte>`), not only
      SGR (`m`-terminated) ones — non-SGR matches are consumed and
      produce no output/styling.
- [x] 1.3 Add `stripAnsi(text: string): string` to `ansi.utils.ts`,
      removing all ANSI escape sequences from a string.
- [x] 1.4 Update `ansi-log-viewer.component.tsx` to import
      `AnsiSegment`/`FG_COLOR_CLASS`/`parseAnsiLine` from
      `lib/ansi.utils.ts` instead of defining them locally; remove the
      now-duplicate local definitions.

## 2. Wire ANSI rendering into shared log display

- [x] 2.1 Update `log-line-display.component.tsx`'s `HighlightedLine` to
      parse `text` into `AnsiSegment[]` via `parseAnsiLine`, then run the
      existing case-insensitive search-highlight split within each
      segment's text, rendering each resulting run as a `<span>` carrying
      both the segment's color/bold class and (for matches) a nested
      `<mark>`. Keep the exported `{ text, query }` prop signature
      unchanged.
- [x] 2.2 Update `log-level.utils.ts`'s `detectLogLevel` to call
      `stripAnsi` on the input line before running its level-keyword
      regex.

## 3. Tests

- [x] 3.1 Unit tests for `parseAnsiLine`/`stripAnsi` in
      `ansi.utils.spec.ts`: SGR color + bold segments, non-SGR CSI
      sequences (cursor move, clear-line) dropped with no visible
      artifact, and a malformed/incomplete escape sequence degrading to
      plain text without throwing.
- [x] 3.2 Component test for `HighlightedLine` asserting: (a) an
      SGR-colored line renders styled spans with no raw escape text, (b) a
      search match inside a colored run is still highlighted with
      `<mark>`, (c) plain text with no ANSI codes renders unchanged from
      current behavior.
- [x] 3.3 Unit test for `detectLogLevel` confirming a level keyword
      wrapped in ANSI color codes still classifies correctly.
- [x] 3.4 Run existing `ansi-log-viewer.component.spec` (Pulumi/IaC
      viewer) tests and confirm they still pass unchanged after the
      extraction in Task 1.4.

## 4. Verification

- [x] 4.1 `npm run app:lint` clean.
- [x] 4.2 `npm run app:typecheck` clean.
- [x] 4.3 `npm run app:test` full unit suite green.
- [~] 4.4 Manually confirm in the running app: paste/observe a
      steamcmd-style install log on `/logs` (or Diagnostics panel) and
      confirm colored output with no raw `␛[...]` bytes visible.
