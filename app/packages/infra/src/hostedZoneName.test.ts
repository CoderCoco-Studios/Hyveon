import { describe, expect, it } from 'vitest';
import { stripTrailingDots } from './hostedZoneName.js';

describe('stripTrailingDots', () => {
  it('should return the input unchanged when there is no trailing dot', () => {
    expect(stripTrailingDots('example.com')).toBe('example.com');
  });

  it('should strip a single trailing dot', () => {
    expect(stripTrailingDots('example.com.')).toBe('example.com');
  });

  it('should strip multiple trailing dots', () => {
    expect(stripTrailingDots('example.com...')).toBe('example.com');
  });

  it('should not strip interior dots', () => {
    expect(stripTrailingDots('sub.example.com.')).toBe('sub.example.com');
  });

  it('should return an empty string when the input is all dots', () => {
    expect(stripTrailingDots('...')).toBe('');
  });

  it('should return an empty string when the input is empty', () => {
    expect(stripTrailingDots('')).toBe('');
  });
});
