## REMOVED Requirements

### Requirement: Diagnostics panel pause, level filter, search, and autoscroll

**Reason**: the client-side INFO/WARN/ERROR/DEBUG classification the level
filter depends on is unreliable — Hyveon doesn't control the log line format
emitted by game servers or its own Lambdas, so the detection regex
frequently misclassifies or fails to match real lines. Replaced by
"Diagnostics panel pause, search, and autoscroll" below, which keeps every
other behavior of this requirement and drops only the level-filter scenario.

**Migration**: no operator action required. The **Levels** control and
per-line level badge are removed from the Settings → Diagnostics panel;
pause/resume, search-highlight, and autoscroll behave exactly as before.

### Requirement: ANSI-colored log line rendering

**Reason**: this requirement's "Level detection ignores embedded ANSI
codes" scenario depends on the level-detection logic being removed
(see above). Replaced by "ANSI escape sequence rendering for log lines"
below, which keeps every other scenario verbatim and drops only that one.

**Migration**: no operator action required. ANSI SGR color/bold rendering,
non-SGR escape stripping, search-highlighting inside colored text, and
graceful handling of malformed escape sequences are all unchanged.

---

## ADDED Requirements

### Requirement: Diagnostics panel pause, search, and autoscroll

The Settings → Diagnostics panel (`DiagnosticsPanel.tsx`) SHALL support
pausing the displayed log view while polling continues in the background,
searching displayed lines by substring with match highlighting, and
autoscrolling to the bottom on update — matching the interaction patterns
already available on the `/logs` page's `ansi-log-viewer.component.tsx`, and
preserving the autoscroll-on-update behavior `DiagnosticsPanel.tsx` already
has today.

`diagnostics.tail` returns the current cumulative tail (the last N lines as
of that call), not an incremental delta — unlike `/logs`'s CloudWatch-backed
stream, there is no line-identity or sequence number to key an append on.
Pausing therefore MUST NOT stop the underlying poll, but MUST stop the
*displayed* lines from changing: each poll response while paused SHALL
update only an internal "latest fetched" reference, not the rendered view.
On resume, the view SHALL be replaced with that latest fetched snapshot in
one step — never by appending successive poll responses to each other,
which would duplicate or misorder lines given the snapshot (not delta)
shape of `diagnostics.tail`'s response. Autoscroll-to-bottom applies only
when the view is not paused; a paused view MUST NOT autoscroll out from
under an operator reading it.

#### Scenario: Pausing freezes the view

- **WHEN** the operator pauses the Diagnostics panel while new log lines
  are being written
- **THEN** the displayed lines do not change until the operator resumes,
  even though polling continues in the background

#### Scenario: Resuming shows the latest snapshot

- **WHEN** the operator resumes after pausing through several poll cycles
- **THEN** the view updates once to the most recently fetched
  `diagnostics.tail` snapshot, with no duplicated or reordered lines from
  the intermediate polls that occurred while paused

#### Scenario: Searching highlights matches

- **WHEN** the operator types a search term
- **THEN** matching substrings are highlighted in the visible lines,
  without removing non-matching lines from view

#### Scenario: Autoscroll follows new lines while not paused

- **WHEN** the panel is not paused and a poll returns a newer snapshot
- **THEN** the view scrolls to the bottom, matching today's
  `DiagnosticsPanel.tsx` behavior

#### Scenario: Autoscroll does not fight a paused view

- **WHEN** the panel is paused
- **THEN** the view does not scroll, even though polling continues in the
  background

### Requirement: ANSI escape sequence rendering for log lines

The shared log-line rendering used by the `/logs` page and the Settings →
Diagnostics panel SHALL interpret SGR ("Select Graphic Rendition") ANSI
escape sequences in log line text and render the corresponding foreground
color and bold styling, instead of displaying the raw escape bytes. Any
other ANSI escape sequence (e.g. cursor movement, clear-line) that is not
an SGR sequence SHALL be silently removed from the rendered output rather
than displayed as literal characters. Search-match highlighting SHALL
continue to work correctly on lines containing ANSI escape sequences,
highlighting matches within the colorized text. A malformed or incomplete
escape sequence SHALL degrade to being displayed as plain text rather than
causing a rendering error.

#### Scenario: SGR color codes render as styled text

- **WHEN** a log line contains an SGR color escape sequence, e.g.
  `\x1b[1;36m****EXECUTING USERMOD****\x1b[0m`
- **THEN** the enclosed text renders in the corresponding color (and bold,
  where indicated) with no raw escape bytes visible on screen

#### Scenario: Non-SGR escape sequences are discarded, not shown

- **WHEN** a log line contains a non-SGR ANSI escape sequence, such as a
  cursor-move or clear-line code
- **THEN** the sequence does not appear in the rendered output and no raw
  escape bytes are visible

#### Scenario: Search highlighting still matches inside colored text

- **WHEN** the operator searches for a term that appears inside an
  SGR-colored run of text on `/logs` or the Diagnostics panel
- **THEN** the matching substring is highlighted, and the surrounding text
  retains its ANSI-derived color

#### Scenario: A malformed escape sequence does not break rendering

- **WHEN** a log line contains a truncated or malformed ANSI escape byte
  sequence (e.g. cut off at a chunk boundary)
- **THEN** the line still renders, with the malformed sequence shown as
  plain text rather than causing an error
