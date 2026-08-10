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
