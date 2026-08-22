import { describe, it, expect, vi, afterEach } from 'vitest';
import { parseJsonEnv } from './envJson.js';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('parseJsonEnv', () => {
  it('should parse valid JSON', () => {
    expect(parseJsonEnv('FOO', '{"a":1}', {})).toEqual({ a: 1 });
  });

  it('should return the fallback when the env var is undefined', () => {
    expect(parseJsonEnv('FOO', undefined, { default: true })).toEqual({ default: true });
  });

  it('should return the fallback when the env var is an empty string', () => {
    expect(parseJsonEnv('FOO', '', { default: true })).toEqual({ default: true });
  });

  it('should return the fallback and log a warning, not throw, when the env var is malformed JSON', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    expect(parseJsonEnv('FOO', '{not json', { default: true })).toEqual({ default: true });

    expect(warn).toHaveBeenCalledWith('Malformed FOO env var — falling back to default', expect.any(Object));
  });
});
