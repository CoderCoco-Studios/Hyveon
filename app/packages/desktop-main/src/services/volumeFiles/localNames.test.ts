import { describe, expect, it } from 'vitest';
import { sanitizeLocalFileName } from './localNames.js';

// @spec HELPER-XFER-003
describe('sanitizeLocalFileName', () => {
  it('should replace characters reserved on Windows', () => {
    expect(sanitizeLocalFileName('a:b?.txt', 'win32')).toBe('a_b_.txt');
    expect(sanitizeLocalFileName('a<b>c"d|e*f\\g.txt', 'win32')).toBe('a_b_c_d_e_f_g.txt');
    expect(sanitizeLocalFileName('tab\there\u0001.txt', 'win32')).toBe('tab_here_.txt');
  });

  it('should strip trailing dots and spaces on Windows', () => {
    expect(sanitizeLocalFileName('notes. . ', 'win32')).toBe('notes');
  });

  it('should prefix reserved device names', () => {
    expect(sanitizeLocalFileName('con.txt', 'win32')).toBe('_con.txt');
    expect(sanitizeLocalFileName('NUL', 'win32')).toBe('_NUL');
    expect(sanitizeLocalFileName('Com1.tar.gz', 'win32')).toBe('_Com1.tar.gz');
    expect(sanitizeLocalFileName('lpt9', 'win32')).toBe('_lpt9');
  });

  it('should not prefix names that merely start with a reserved stem', () => {
    expect(sanitizeLocalFileName('console.log', 'win32')).toBe('console.log');
    expect(sanitizeLocalFileName('COM10', 'win32')).toBe('COM10');
  });

  it('should leave names alone on Linux and macOS', () => {
    expect(sanitizeLocalFileName('a:b?.txt', 'linux')).toBe('a:b?.txt');
    expect(sanitizeLocalFileName('a:b?.txt', 'darwin')).toBe('a:b?.txt');
    expect(sanitizeLocalFileName('con.txt', 'linux')).toBe('con.txt');
  });

  it('should replace only the slash and NUL elsewhere', () => {
    expect(sanitizeLocalFileName('a/b\u0000c', 'linux')).toBe('a_b_c');
  });

  it('should fall back to a default name when nothing is left', () => {
    expect(sanitizeLocalFileName('', 'linux')).toBe('download');
    expect(sanitizeLocalFileName('...', 'win32')).toBe('download');
  });
});
