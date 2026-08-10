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
