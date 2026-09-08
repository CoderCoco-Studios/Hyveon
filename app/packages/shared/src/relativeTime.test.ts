import { describe, it, expect } from 'vitest';
import { formatRelativeAge } from './relativeTime.js';

describe('formatRelativeAge', () => {
  it('should format under a minute as "less than a minute ago"', () => {
    expect(formatRelativeAge(30_000)).toBe('less than a minute ago');
  });

  it('should format singular minute', () => {
    expect(formatRelativeAge(60_000)).toBe('1 minute ago');
  });

  it('should format plural minutes', () => {
    expect(formatRelativeAge(5 * 60_000)).toBe('5 minutes ago');
  });

  it('should format singular hour', () => {
    expect(formatRelativeAge(60 * 60_000)).toBe('1 hour ago');
  });

  it('should format plural hours', () => {
    expect(formatRelativeAge(3 * 60 * 60_000)).toBe('3 hours ago');
  });

  it('should format singular day', () => {
    expect(formatRelativeAge(24 * 60 * 60_000)).toBe('1 day ago');
  });

  it('should format plural days', () => {
    expect(formatRelativeAge(5 * 24 * 60 * 60_000)).toBe('5 days ago');
  });

  it('should clamp negative deltas (clock skew) to "less than a minute ago"', () => {
    expect(formatRelativeAge(-1000)).toBe('less than a minute ago');
  });
});
