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
