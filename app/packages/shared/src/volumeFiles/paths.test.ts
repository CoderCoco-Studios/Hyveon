import { describe, expect, it } from 'vitest';
import {
  VolumePathError,
  isCleanVolumePath,
  isValidEntryName,
  joinVolumePath,
  normalizeVolumePath,
  parentOfVolumePath,
} from './paths.js';

describe('volumeFiles paths', () => {
  // @spec HELPER-FB-031
  it('should accept the root and nested absolute paths', () => {
    expect(normalizeVolumePath('/')).toBe('/');
    expect(normalizeVolumePath('/Data/worlds/')).toBe('/Data/worlds');
  });

  // @spec HELPER-FB-031
  it.each(['', 'Data', '/a/../b', '/a/./b', '/a//b', '/a\\b', '/a\0b', '..'])('should reject %j', (p) => {
    expect(isCleanVolumePath(p)).toBe(false);
    expect(() => normalizeVolumePath(p)).toThrow(VolumePathError);
  });

  it.each(['a #1 ?%é.txt', 'options.json', '.hidden'])('should accept the entry name %j', (n) => {
    expect(isValidEntryName(n)).toBe(true);
  });

  // @spec HELPER-FB-032
  it.each(['', '.', '..', 'a/b', 'a\\b', 'a\0', 'x'.repeat(256)])('should reject the entry name %j', (n) => {
    expect(isValidEntryName(n)).toBe(false);
  });

  // @spec HELPER-FB-032
  it('should limit entry names by UTF-8 bytes rather than characters', () => {
    expect(isValidEntryName('é'.repeat(127))).toBe(true);
    expect(isValidEntryName('é'.repeat(128))).toBe(false);
  });

  it('should join under the root without a double slash', () => {
    expect(joinVolumePath('/', 'a')).toBe('/a');
  });

  it('should join under a nested directory and reject an invalid name', () => {
    expect(joinVolumePath('/a/b/', 'c.txt')).toBe('/a/b/c.txt');
    expect(() => joinVolumePath('/a', '../x')).toThrow(VolumePathError);
  });

  it('should return the parent of a nested path and root for a top-level one', () => {
    expect(parentOfVolumePath('/a/b')).toBe('/a');
    expect(parentOfVolumePath('/a')).toBe('/');
  });

  it('should name the error class VolumePathError', () => {
    expect(new VolumePathError('x').name).toBe('VolumePathError');
  });
});
