import { afterEach, describe, expect, it } from 'vitest';
import { readAppVersion } from './app-version.js';

describe('readAppVersion', () => {
  const original = process.versions['electron'];

  afterEach(() => {
    if (original === undefined) delete (process.versions as Record<string, string>)['electron'];
    else (process.versions as Record<string, string>)['electron'] = original;
  });

  it("should return 'unknown' outside Electron", () => {
    delete (process.versions as Record<string, string>)['electron'];
    expect(readAppVersion()).toBe('unknown');
  });

  it("should return 'unknown' when requiring electron fails under a fake Electron runtime", () => {
    // Plain Node: `require('electron')` resolves to a path string (no `app`), so getVersion throws.
    (process.versions as Record<string, string>)['electron'] = '0.0.0';
    expect(readAppVersion()).toBe('unknown');
  });
});
