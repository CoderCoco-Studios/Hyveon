/** One SGR-styled run of text within a single log line. */
export interface AnsiSegment {
  text: string;
  bold: boolean;
  /** Tailwind text-color class for this run's foreground color, or `null` for the default. */
  colorClass: string | null;
}

/**
 * Matches any ANSI escape sequence, across the three families terminal
 * tooling actually emits:
 *
 * 1. CSI ("Control Sequence Introducer") — `\x1b[` followed by parameter
 *    bytes (the full 0x30-0x3F range: digits, `:`, `;`, `<`, `=`, `>`, `?`,
 *    which also covers DEC private-mode sequences like `\x1b[?25l`),
 *    optional intermediate bytes, and a single final byte, e.g. `\x1b[1;32m`
 *    (SGR) or `\x1b[2K` (clear-line). The final byte distinguishes SGR
 *    (`m`) sequences, which this module styles, from every other CSI
 *    sequence, which is matched only so it can be discarded from rendered
 *    output.
 * 2. OSC ("Operating System Command") — `\x1b]` up to a BEL or ST
 *    terminator, e.g. `\x1b]0;window title\x07`. Never carries SGR styling;
 *    matched only so it can be discarded.
 * 3. A generic escape fallback covering every other short escape sequence
 *    that is neither CSI nor OSC: either one or more intermediate bytes
 *    (0x20-0x2F) followed by a final byte (0x30-0x7E) — the two-byte nF
 *    charset-designation form, e.g. `\x1b(B` — or a single Fp/Fe/Fs byte
 *    with no intermediates (e.g. `\x1b7`/`\x1b8` save/restore cursor),
 *    excluding `[` and `]` from that single-byte form so an incomplete CSI
 *    or OSC sequence (missing its final byte / terminator) is left as plain
 *    text rather than misread as a complete one-byte escape.
 */
// eslint-disable-next-line no-control-regex -- \x1b (ESC) is the literal byte every ANSI escape sequence starts with.
const ANSI_PATTERN = /\x1b(?:\[([0-?]*)[ -/]*([@-~])|\][^\x07\x1b]*(?:\x07|\x1b\\)|[ -/]+[0-~]|[0-Z\\^-~])/g;

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

  const pattern = new RegExp(ANSI_PATTERN);
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(line)) !== null) {
    const text = line.slice(lastIndex, match.index);
    if (text) segments.push({ text, bold, colorClass });

    const [, params, finalByte] = match;
    if (finalByte === 'm') {
      const codes = params === '' ? [0] : params!.split(';').map(Number);
      for (let idx = 0; idx < codes.length; idx++) {
        const code = codes[idx];
        if (code === 38 || code === 48) {
          // Extended (256-color or truecolor) foreground/background —
          // consume its parameters but apply no styling; this app only
          // supports the 16 standard colors.
          if (codes[idx + 1] === 5) idx += 2; // 38;5;N or 48;5;N
          else if (codes[idx + 1] === 2) idx += 4; // 38;2;R;G;B or 48;2;R;G;B
          continue;
        }
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
    // Any non-SGR escape sequence (finalByte !== 'm', including OSC and Fe
    // sequences where finalByte is undefined) is consumed above and
    // produces no segment text — it is silently discarded.

    lastIndex = pattern.lastIndex;
  }

  const rest = line.slice(lastIndex);
  if (rest || segments.length === 0) segments.push({ text: rest, bold, colorClass });

  const coalesced: AnsiSegment[] = [];
  for (const seg of segments) {
    const prev = coalesced[coalesced.length - 1];
    if (prev && prev.bold === seg.bold && prev.colorClass === seg.colorClass) {
      prev.text += seg.text;
    } else {
      coalesced.push({ ...seg });
    }
  }
  return coalesced;
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
  return text.replace(ANSI_PATTERN, '');
}
