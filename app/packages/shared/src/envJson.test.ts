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

  it('should return the fallback when the parsed value is valid JSON but not an object, given an object fallback', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    expect(parseJsonEnv('FOO', 'null', { default: true })).toEqual({ default: true });
    expect(parseJsonEnv('FOO', '42', { default: true })).toEqual({ default: true });
    expect(parseJsonEnv('FOO', '"a string"', { default: true })).toEqual({ default: true });

    expect(warn).toHaveBeenCalledTimes(3);
  });

  it('should accept a parsed array when the fallback is an object', () => {
    expect(parseJsonEnv('FOO', '[1,2,3]', {})).toEqual([1, 2, 3]);
  });
});
