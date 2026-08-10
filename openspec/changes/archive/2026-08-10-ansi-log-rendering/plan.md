# ANSI-Aware Log Rendering Implementation Plan

> **For agentic workers:** Use superpowers:subagent-driven-development
> to implement this plan task-by-task.

**Goal:** Make `/logs` and the Settings → Diagnostics panel render SGR ANSI
color codes as styled text and silently discard any other ANSI escape
sequence, instead of showing raw escape bytes.

**Architecture:** Extract the existing SGR parser out of
`ansi-log-viewer.component.tsx` into a shared `lib/ansi.utils.ts`, extend it
to consume any CSI escape sequence (not just SGR), add a `stripAnsi` helper,
and wire both into the `HighlightedLine` component and `detectLogLevel` that
`/logs` and the Diagnostics panel already share.

**Tech Stack:** React 19, TypeScript, Vitest + Testing Library (jsdom),
Tailwind CSS custom-property design tokens.

## Global Constraints

- No new npm dependency (design.md D2).
- `HighlightedLine`'s exported prop signature `{ text, query }` MUST NOT
  change (proposal.md, "Impact").
- Malformed/incomplete escape sequences MUST degrade to plain text, never
  throw (design.md D4).
- `ansi-log-viewer.component.tsx`'s existing behavior and its test file
  (`ansi-log-viewer.component.test.tsx`) MUST keep passing unchanged.
- Test files in this repo are co-located `*.test.tsx`/`*.test.ts` next to
  the source file (see `ansi-log-viewer.component.test.tsx`).
- TSDoc comments follow `.claude/rules/tsdoc-tags.md` (summary, then
  `@param`/`@returns` in order, hyphen-separated `@param name - desc`).

All file paths below are relative to
`/home/chris/GitHub/Hyveon/.claude/worktrees/add-ansi-log-rendering`
(this change's worktree). Run test commands from `app/`.

---

## Task 1: Shared `ansi.utils.ts` module with SGR + non-SGR CSI stripping

**Files:**
- Create: `app/packages/web/src/lib/ansi.utils.ts`
- Test: `app/packages/web/src/lib/ansi.utils.test.ts`

**Interfaces:**
- Produces: `export interface AnsiSegment { text: string; bold: boolean; colorClass: string | null }`, `export const FG_COLOR_CLASS: Record<number, string>`, `export function parseAnsiLine(line: string): AnsiSegment[]`, `export function stripAnsi(text: string): string`.

- [ ] **Step 1: Write the failing tests for `parseAnsiLine`**

Create `app/packages/web/src/lib/ansi.utils.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { parseAnsiLine, stripAnsi } from './ansi.utils.js';

describe('parseAnsiLine', () => {
  it('should return a single unstyled segment for plain text', () => {
    expect(parseAnsiLine('hello world')).toEqual([{ text: 'hello world', bold: false, colorClass: null }]);
  });

  it('should apply a foreground color for a basic SGR color code', () => {
    const segments = parseAnsiLine('\x1b[32mgreen text\x1b[0m');
    expect(segments).toEqual([{ text: 'green text', bold: false, colorClass: 'text-[var(--color-green)]' }]);
  });

  it('should mark a segment bold for SGR code 1 and clear it on reset', () => {
    const segments = parseAnsiLine('\x1b[1mbold\x1b[0m normal');
    expect(segments[0]).toEqual({ text: 'bold', bold: true, colorClass: null });
    expect(segments[1]).toEqual({ text: ' normal', bold: false, colorClass: null });
  });

  it('should combine bold and color from a single semicolon-joined SGR code', () => {
    const segments = parseAnsiLine('\x1b[1;31mdestroy\x1b[0m');
    expect(segments).toEqual([{ text: 'destroy', bold: true, colorClass: 'text-[var(--color-red)]' }]);
  });

  it('should ignore unrecognized SGR sub-codes instead of throwing', () => {
    expect(() => parseAnsiLine('\x1b[48;5;200munsupported bg\x1b[0m')).not.toThrow();
    expect(parseAnsiLine('\x1b[999mplain\x1b[0m')[0]!.text).toBe('plain');
  });

  it('should silently drop a non-SGR CSI sequence (cursor move)', () => {
    const segments = parseAnsiLine('\x1b[2Ahello');
    expect(segments).toEqual([{ text: 'hello', bold: false, colorClass: null }]);
  });

  it('should silently drop a clear-line sequence between two colored runs', () => {
    const segments = parseAnsiLine('\x1b[1;36m****EXECUTING USERMOD****\x1b[0m\x1b[2Kusermod: no changes');
    expect(segments).toEqual([
      { text: '****EXECUTING USERMOD****', bold: true, colorClass: 'text-[var(--color-cyan)]' },
      { text: 'usermod: no changes', bold: false, colorClass: null },
    ]);
  });

  it('should leave a truncated escape sequence as plain text instead of throwing', () => {
    expect(() => parseAnsiLine('abc\x1b[1;3')).not.toThrow();
    expect(parseAnsiLine('abc\x1b[1;3')).toEqual([{ text: 'abc\x1b[1;3', bold: false, colorClass: null }]);
  });
});

describe('stripAnsi', () => {
  it('should remove SGR color codes, leaving the enclosed text', () => {
    expect(stripAnsi('\x1b[1;36m****EXECUTING USERMOD****\x1b[0m')).toBe('****EXECUTING USERMOD****');
  });

  it('should remove non-SGR CSI sequences', () => {
    expect(stripAnsi('\x1b[2Khello\x1b[2Aworld')).toBe('helloworld');
  });

  it('should return plain text unchanged', () => {
    expect(stripAnsi('plain text, no codes')).toBe('plain text, no codes');
  });

  it('should leave a truncated escape sequence in place', () => {
    expect(stripAnsi('abc\x1b[1;3')).toBe('abc\x1b[1;3');
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
cd app && npx vitest run packages/web/src/lib/ansi.utils.test.ts
```

Expected: FAIL — `ansi.utils.ts` does not exist yet (module not found).

- [ ] **Step 3: Write `ansi.utils.ts`**

Create `app/packages/web/src/lib/ansi.utils.ts`:

```ts
/** One SGR-styled run of text within a single log line. */
export interface AnsiSegment {
  text: string;
  bold: boolean;
  /** Tailwind text-color class for this run's foreground color, or `null` for the default. */
  colorClass: string | null;
}

/**
 * Matches a CSI ("Control Sequence Introducer") ANSI escape sequence —
 * `\x1b[` followed by parameter bytes (digits/semicolons) and a single
 * final letter, e.g. `\x1b[1;32m` (SGR) or `\x1b[2K` (clear-line). The
 * final letter distinguishes SGR (`m`) sequences, which this module styles,
 * from every other CSI sequence, which is matched only so it can be
 * discarded from rendered output.
 */
// eslint-disable-next-line no-control-regex -- \x1b (ESC) is the literal byte every CSI sequence starts with.
const CSI_PATTERN = /\x1b\[([0-9;]*)([A-Za-z])/g;

/**
 * Maps the 16 standard SGR foreground color codes (30-37 normal, 90-97
 * bright) onto this app's existing `--color-*` design tokens — the closest
 * available token per hue, since the palette has no dedicated blue/yellow.
 */
export const FG_COLOR_CLASS: Record<number, string> = {
  30: 'text-[var(--color-muted-foreground)]',
  31: 'text-[var(--color-red)]',
  32: 'text-[var(--color-green)]',
  33: 'text-[var(--color-amber)]',
  34: 'text-[var(--color-primary-light)]',
  35: 'text-[var(--color-pink)]',
  36: 'text-[var(--color-cyan)]',
  37: 'text-[var(--color-foreground)]',
  90: 'text-[var(--color-muted-foreground)]',
  91: 'text-[var(--color-red)]',
  92: 'text-[var(--color-green)]',
  93: 'text-[var(--color-amber)]',
  94: 'text-[var(--color-primary-light)]',
  95: 'text-[var(--color-pink)]',
  96: 'text-[var(--color-cyan-light)]',
  97: 'text-[var(--color-foreground)]',
};

/**
 * Parses a single line of terminal-style output into an ordered list of
 * styled segments.
 *
 * @remarks
 * Supports the subset of SGR codes Pulumi's and game-server tooling's
 * colorized output actually emits: the 16 standard foreground colors, bold
 * (`1`) / normal-intensity (`22`), and reset (`0`/`39`). Unrecognized SGR
 * sub-codes are ignored rather than rejected. Every non-SGR CSI sequence
 * (cursor movement, clear-line, etc.) is matched and discarded from the
 * output entirely — it never appears in a returned segment's text. A
 * malformed or incomplete escape sequence (e.g. truncated at a chunk
 * boundary) does not match the pattern at all, so it is left in place as
 * plain text rather than throwing.
 *
 * @param line - A single line of output, potentially containing ANSI escape sequences.
 * @returns An ordered list of styled text segments with escape sequences removed.
 */
export function parseAnsiLine(line: string): AnsiSegment[] {
  const segments: AnsiSegment[] = [];
  let bold = false;
  let colorClass: string | null = null;
  let lastIndex = 0;

  const pattern = new RegExp(CSI_PATTERN);
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(line)) !== null) {
    const text = line.slice(lastIndex, match.index);
    if (text) segments.push({ text, bold, colorClass });

    const [, params, finalByte] = match;
    if (finalByte === 'm') {
      const codes = params === '' ? [0] : params!.split(';').map(Number);
      for (const code of codes) {
        if (code === 0) {
          bold = false;
          colorClass = null;
        } else if (code === 1) {
          bold = true;
        } else if (code === 22) {
          bold = false;
        } else if (code === 39) {
          colorClass = null;
        } else if (code in FG_COLOR_CLASS) {
          colorClass = FG_COLOR_CLASS[code]!;
        }
      }
    }
    // Any non-SGR CSI sequence (finalByte !== 'm') is consumed above and
    // produces no segment text — it is silently discarded.

    lastIndex = pattern.lastIndex;
  }

  const rest = line.slice(lastIndex);
  if (rest || segments.length === 0) segments.push({ text: rest, bold, colorClass });
  return segments;
}

/**
 * Removes every ANSI escape sequence from a string, leaving only the plain
 * text — used ahead of level-keyword detection so an escape sequence can
 * never interfere with matching.
 *
 * @param text - Text potentially containing ANSI escape sequences.
 * @returns The same text with all ANSI escape sequences removed.
 */
export function stripAnsi(text: string): string {
  return text.replace(CSI_PATTERN, '');
}
```

- [ ] **Step 4: Run the tests to verify they pass**

```bash
cd app && npx vitest run packages/web/src/lib/ansi.utils.test.ts
```

Expected: PASS (13 tests).

- [ ] **Step 5: Commit**

```bash
git add app/packages/web/src/lib/ansi.utils.ts app/packages/web/src/lib/ansi.utils.test.ts
git commit -m "feat(web): add shared ansi.utils with SGR parsing and stripAnsi"
```

---

## Task 2: Point `ansi-log-viewer.component.tsx` at the shared module

**Files:**
- Modify: `app/packages/web/src/components/ansi-log-viewer.component.tsx`
- Test (no changes expected, must still pass): `app/packages/web/src/components/ansi-log-viewer.component.test.tsx`

**Interfaces:**
- Consumes: `AnsiSegment`, `FG_COLOR_CLASS`, `parseAnsiLine` from `../lib/ansi.utils.js` (Task 1).
- Produces: `AnsiLogChunk`, `AnsiLogViewer`, `AnsiLogViewerProps` (unchanged); re-exports `AnsiSegment`, `parseAnsiLine` so the existing test file's `import { AnsiLogViewer, parseAnsiLine, type AnsiLogChunk } from './ansi-log-viewer.component.js'` keeps resolving.

- [ ] **Step 1: Replace the local SGR parser with an import from `ansi.utils.ts`**

In `app/packages/web/src/components/ansi-log-viewer.component.tsx`, replace lines 1-87 (the imports through the end of `parseAnsiLine`) with:

```ts
import { useEffect, useRef, useState } from 'react';
import { cn } from '../lib/utils.utils.js';
import { parseAnsiLine, type AnsiSegment } from '../lib/ansi.utils.js';

export { parseAnsiLine, type AnsiSegment };

/** A single line of output from a streamed Pulumi plan/apply/destroy run. Mirrors `IacRunChunk`. */
export interface AnsiLogChunk {
  stream: 'stdout' | 'stderr';
  line: string;
}
```

Leave everything from `/** Props for {@link AnsiLogViewer}. */` (the original line 89) onward unchanged — `AnsiLogViewerProps`, `BOTTOM_PIN_THRESHOLD_PX`, and the `AnsiLogViewer` component body all stay exactly as they are today; they already reference `parseAnsiLine` by name, which now resolves to the imported/re-exported one.

- [ ] **Step 2: Run the existing viewer test file to confirm no regression**

```bash
cd app && npx vitest run packages/web/src/components/ansi-log-viewer.component.test.tsx
```

Expected: PASS — all pre-existing tests (including the `parseAnsiLine` describe block, which imports from `./ansi-log-viewer.component.js`) still pass unchanged, since that import now resolves to the re-export.

- [ ] **Step 3: Typecheck**

```bash
cd app && npx tsc -p packages/web/tsconfig.json --noEmit
```

Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add app/packages/web/src/components/ansi-log-viewer.component.tsx
git commit -m "refactor(web): source ansi-log-viewer's SGR parser from lib/ansi.utils"
```

---

## Task 3: ANSI-aware `HighlightedLine`

**Files:**
- Modify: `app/packages/web/src/components/log-line-display.component.tsx`
- Test: create `app/packages/web/src/components/log-line-display.component.test.tsx`

**Interfaces:**
- Consumes: `parseAnsiLine(line: string): AnsiSegment[]` from `../lib/ansi.utils.js` (Task 1).
- Produces: `HighlightedLine({ text, query }: { text: string; query: string })` — same exported signature as before.

- [ ] **Step 1: Write the failing tests**

Create `app/packages/web/src/components/log-line-display.component.test.tsx`:

```tsx
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { HighlightedLine } from './log-line-display.component.js';

describe('HighlightedLine', () => {
  it('should render plain text unchanged when there is no query and no ANSI codes', () => {
    render(<HighlightedLine text="Connection refused from 10.0.0.5" query="" />);
    expect(screen.getByText('Connection refused from 10.0.0.5')).toBeInTheDocument();
  });

  it('should render an SGR-colored run as styled text with no raw escape bytes visible', () => {
    render(<HighlightedLine text={'\x1b[1;36m****EXECUTING USERMOD****\x1b[0m'} query="" />);
    const el = screen.getByText('****EXECUTING USERMOD****');
    expect(el.className).toContain('text-[var(--color-cyan)]');
    expect(el.className).toContain('font-bold');
    expect(document.body.textContent).not.toContain('\x1b');
  });

  it('should discard a non-SGR CSI sequence and show none of its bytes', () => {
    render(<HighlightedLine text={'\x1b[2Kusermod: no changes'} query="" />);
    expect(screen.getByText('usermod: no changes')).toBeInTheDocument();
    expect(document.body.textContent).not.toContain('\x1b');
  });

  it('should highlight a search match inside plain text with <mark>', () => {
    const { container } = render(<HighlightedLine text="Connection refused from 10.0.0.5" query="refused" />);
    const marks = container.querySelectorAll('mark');
    expect(marks).toHaveLength(1);
    expect(marks[0]).toHaveTextContent('refused');
  });

  it('should highlight a search match inside an SGR-colored run, keeping the color on the rest', () => {
    const { container } = render(<HighlightedLine text={'\x1b[31merror: disk full\x1b[0m'} query="disk" />);
    const marks = container.querySelectorAll('mark');
    expect(marks).toHaveLength(1);
    expect(marks[0]).toHaveTextContent('disk');
    const coloredSpan = container.querySelector('.text-\\[var\\(--color-red\\)\\]');
    expect(coloredSpan).not.toBeNull();
    expect(coloredSpan).toHaveTextContent('error: disk full');
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
cd app && npx vitest run packages/web/src/components/log-line-display.component.test.tsx
```

Expected: FAIL — current `HighlightedLine` renders raw escape bytes as literal text, so the "no raw escape bytes visible" and color-class assertions fail.

- [ ] **Step 3: Rewrite `HighlightedLine`**

In `app/packages/web/src/components/log-line-display.component.tsx`, add the import and replace the existing `HighlightedLine` function (current lines 15-44) with:

```tsx
import { Fragment } from 'react';
import { Filter } from 'lucide-react';
import { Badge } from './ui/badge.component.js';
import { Button } from './ui/button.component.js';
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuCheckboxItem,
} from './ui/dropdown-menu.component.js';
import { ALL_LOG_LEVELS, LOG_LEVEL_BADGE, type LogLevel } from '../lib/log-level.utils.js';
import { parseAnsiLine } from '../lib/ansi.utils.js';
import { cn } from '../lib/utils.utils.js';

/** One run of `text` from splitting against a case-insensitive search `query`. */
interface QueryPart {
  text: string;
  match: boolean;
}

/** Splits `text` into non-matching/matching runs against a case-insensitive `query`. Returns a single non-matching run when `query` is empty. */
function splitByQuery(text: string, query: string): QueryPart[] {
  if (!query) return [{ text, match: false }];
  const q = query.toLowerCase();
  const parts: QueryPart[] = [];
  let i = 0;
  const lower = text.toLowerCase();
  while (i < text.length) {
    const idx = lower.indexOf(q, i);
    if (idx === -1) {
      parts.push({ text: text.slice(i), match: false });
      break;
    }
    if (idx > i) parts.push({ text: text.slice(i, idx), match: false });
    parts.push({ text: text.slice(idx, idx + q.length), match: true });
    i = idx + q.length;
  }
  return parts;
}

/** Render a single line, applying ANSI color/bold styling and splitting on case-insensitive search matches. Shared by `/logs` and the Diagnostics panel. */
export function HighlightedLine({ text, query }: { text: string; query: string }) {
  return (
    <>
      {parseAnsiLine(text).map((seg, i) => {
        const parts = splitByQuery(seg.text, query).map((p, j) =>
          p.match ? (
            <mark key={j} className="rounded-[2px] bg-[var(--color-amber)]/40 px-[1px] text-[var(--color-foreground)]">
              {p.text}
            </mark>
          ) : (
            p.text
          ),
        );
        if (!seg.colorClass && !seg.bold) return <Fragment key={i}>{parts}</Fragment>;
        return (
          <span key={i} className={cn(seg.colorClass, seg.bold && 'font-bold')}>
            {parts}
          </span>
        );
      })}
    </>
  );
}
```

Note: non-matching text runs are now returned as plain strings (`p.text`)
rather than wrapped in a `<span>` — this avoids nesting a same-text `<span>`
inside the new per-segment `<span>`, which would otherwise make
`screen.getByText(fullLineText)` match two elements instead of one and break
every existing `getByText(exact full line)` assertion in `logs.page.test.tsx`
and `DiagnosticsPanel.test.tsx`. Unstyled segments (no color, not bold) skip
the wrapping `<span>` entirely via `Fragment`, for the same reason — this is
what keeps the "no query, no ANSI" case producing exactly the same DOM shape
as before (a bare text node).

- [ ] **Step 4: Run the tests to verify they pass**

```bash
cd app && npx vitest run packages/web/src/components/log-line-display.component.test.tsx
```

Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add app/packages/web/src/components/log-line-display.component.tsx app/packages/web/src/components/log-line-display.component.test.tsx
git commit -m "feat(web): render ANSI color codes in HighlightedLine"
```

---

## Task 4: ANSI-blind `detectLogLevel`

**Files:**
- Modify: `app/packages/web/src/lib/log-level.utils.ts`
- Test: create `app/packages/web/src/lib/log-level.utils.test.ts`

**Interfaces:**
- Consumes: `stripAnsi(text: string): string` from `./ansi.utils.js` (Task 1).
- Produces: `detectLogLevel(line: string): LogLevel | null` — same signature as before.

- [ ] **Step 1: Write the failing test**

Create `app/packages/web/src/lib/log-level.utils.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { detectLogLevel } from './log-level.utils.js';

describe('detectLogLevel', () => {
  it('should detect ERROR in plain text', () => {
    expect(detectLogLevel('2026-08-09 ERROR disk full')).toBe('ERROR');
  });

  it('should return null when no level token is present', () => {
    expect(detectLogLevel('just some text')).toBeNull();
  });

  it('should detect a level keyword wrapped in ANSI color codes', () => {
    expect(detectLogLevel('\x1b[31mERROR\x1b[0m: disk full')).toBe('ERROR');
  });

  it('should detect INFO wrapped in ANSI codes surrounding the whole line', () => {
    expect(detectLogLevel('\x1b[1;36m****EXECUTING USERMOD****\x1b[0m')).toBeNull();
    expect(detectLogLevel('\x1b[0;37mINFO Server installation not detected.\x1b[0m')).toBe('INFO');
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
cd app && npx vitest run packages/web/src/lib/log-level.utils.test.ts
```

Expected: the ANSI-wrapped-keyword cases FAIL today only if the escape
bytes happen to break word-boundary matching around the keyword — verify
this is in fact the current behavior before proceeding; if a case already
passes without the fix (the regex's `\b` still matches around escape
bytes), keep the test as a regression guard and move on, it's still a
correctness improvement to strip proactively per design.md D3.

- [ ] **Step 3: Update `detectLogLevel`**

In `app/packages/web/src/lib/log-level.utils.ts`, add the import and update the function body:

```ts
import { stripAnsi } from './ansi.utils.js';

/** A detected log severity level, shared between the `/logs` page and the Settings Diagnostics panel. */
export type LogLevel = 'INFO' | 'WARN' | 'ERROR' | 'DEBUG';

/** Every {@link LogLevel}, in display order. Frozen — shared by both `/logs` and the Diagnostics panel. */
export const ALL_LOG_LEVELS: readonly LogLevel[] = Object.freeze(['INFO', 'WARN', 'ERROR', 'DEBUG']);

/** Matches a level token bounded by word boundaries, e.g. `INFO`, `WARNING`, `ERR`, `DBG`. */
const LEVEL_PATTERN = /\b(INFO|WARN(?:ING)?|ERROR|ERR|DEBUG|DBG)\b/i;

/** Detect a {@link LogLevel} from a single log line, or `null` if no level token is present. */
export function detectLogLevel(line: string): LogLevel | null {
  const m = LEVEL_PATTERN.exec(stripAnsi(line));
  if (!m) return null;
  const tok = m[1]!.toUpperCase();
  if (tok === 'WARNING' || tok === 'WARN') return 'WARN';
  if (tok === 'ERR' || tok === 'ERROR') return 'ERROR';
  if (tok === 'DBG' || tok === 'DEBUG') return 'DEBUG';
  if (tok === 'INFO') return 'INFO';
  return null;
}
```

(Only the `import` line and the first line inside `detectLogLevel` change —
`LEVEL_PATTERN.exec(line)` becomes `LEVEL_PATTERN.exec(stripAnsi(line))`.
`LOG_LEVEL_BADGE` at the bottom of the file is untouched.)

- [ ] **Step 4: Run the test to verify it passes**

```bash
cd app && npx vitest run packages/web/src/lib/log-level.utils.test.ts
```

Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add app/packages/web/src/lib/log-level.utils.ts app/packages/web/src/lib/log-level.utils.test.ts
git commit -m "feat(web): strip ANSI codes before detecting log level"
```

---

## Task 5: Full verification pass

**Files:** none (verification only).

- [ ] **Step 1: Full unit suite**

```bash
npm run app:test
```

Expected: all tests pass, including
`app/packages/web/src/components/ansi-log-viewer.component.test.tsx`,
`app/packages/web/src/pages/logs.page.test.tsx`, and
`app/packages/web/src/components/DiagnosticsPanel.test.tsx` (unchanged
behavior for lines with no ANSI codes).

- [ ] **Step 2: Lint**

```bash
npm run app:lint
```

Expected: clean.

- [ ] **Step 3: Typecheck**

```bash
npm run app:typecheck
```

Expected: clean.

- [ ] **Step 4: Manual smoke check** *(deferred to `- [~]`, see verify.md)*

Run `npm run desktop:run`, open `/logs` for a game with recent steamcmd
install output (or paste the sample log from this change's originating
conversation into a local test harness), and confirm colored output with
no raw `␛[...]`/`\x1b[...]` bytes visible on screen. Repeat on Settings →
Diagnostics.

- [ ] **Step 5: Final commit** (if Steps 1-3 required any fixups)

```bash
git add -A
git commit -m "chore(web): verification fixups for ANSI log rendering"
```
