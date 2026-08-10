## ADDED Requirements

### Requirement: ANSI-colored log line rendering

The shared log-line rendering used by the `/logs` page and the Settings →
Diagnostics panel SHALL interpret SGR ("Select Graphic Rendition") ANSI
escape sequences in log line text and render the corresponding foreground
color and bold styling, instead of displaying the raw escape bytes. Any
other ANSI escape sequence (e.g. cursor movement, clear-line) that is not
an SGR sequence SHALL be silently removed from the rendered output rather
than displayed as literal characters. Search-match highlighting SHALL
continue to work correctly on lines containing ANSI escape sequences,
highlighting matches within the colorized text. Log-level classification
(the INFO/WARN/ERROR/DEBUG badge shown next to each line) SHALL ignore
ANSI escape sequences when determining a line's level, so a level keyword
wrapped in color codes is still classified correctly. A malformed or
incomplete escape sequence SHALL degrade to being displayed as plain text
rather than causing a rendering error.

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

#### Scenario: Level detection ignores embedded ANSI codes

- **WHEN** a log line contains a level keyword (e.g. `ERROR`) wrapped in
  ANSI color codes
- **THEN** the line is classified with the same level badge it would
  receive if the ANSI codes were absent

#### Scenario: A malformed escape sequence does not break rendering

- **WHEN** a log line contains a truncated or malformed ANSI escape byte
  sequence (e.g. cut off at a chunk boundary)
- **THEN** the line still renders, with the malformed sequence shown as
  plain text rather than causing an error
