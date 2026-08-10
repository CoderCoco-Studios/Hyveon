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

  it('should silently drop a DEC private-mode sequence (cursor hide)', () => {
    expect(parseAnsiLine('\x1b[?25lhello')).toEqual([{ text: 'hello', bold: false, colorClass: null }]);
  });

  it('should silently drop an OSC window-title sequence', () => {
    expect(parseAnsiLine('\x1b]0;my title\x07hello')).toEqual([{ text: 'hello', bold: false, colorClass: null }]);
  });

  it('should coalesce adjacent segments split by a non-SGR sequence when their styling is identical', () => {
    expect(parseAnsiLine('abc\x1b[2Kdef')).toEqual([{ text: 'abcdef', bold: false, colorClass: null }]);
  });

  it('should silently ignore a 256-color extended SGR code instead of applying it as standard colors', () => {
    expect(parseAnsiLine('\x1b[38;5;31mtext\x1b[0m')).toEqual([{ text: 'text', bold: false, colorClass: null }]);
  });

  it('should silently ignore a 24-bit truecolor extended SGR code instead of applying it as standard colors', () => {
    expect(parseAnsiLine('\x1b[38;2;30;90;36mtext\x1b[0m')).toEqual([{ text: 'text', bold: false, colorClass: null }]);
  });

  it('should silently drop a two-byte nF charset-designation sequence', () => {
    expect(parseAnsiLine('before\x1b(Bafter')).toEqual([{ text: 'beforeafter', bold: false, colorClass: null }]);
  });

  it('should silently drop a single-byte Fp save/restore-cursor sequence', () => {
    expect(parseAnsiLine('before\x1b7after')).toEqual([{ text: 'beforeafter', bold: false, colorClass: null }]);
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

  it('should remove a DEC private-mode sequence (cursor hide)', () => {
    expect(stripAnsi('\x1b[?25lhello')).toBe('hello');
  });

  it('should remove an OSC window-title sequence', () => {
    expect(stripAnsi('\x1b]0;my title\x07hello')).toBe('hello');
  });

  it('should remove a two-byte nF charset-designation sequence', () => {
    expect(stripAnsi('usermod: no changes\x1b(B\x1b[m')).toBe('usermod: no changes');
  });
});
