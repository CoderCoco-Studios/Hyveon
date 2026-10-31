import { afterEach, describe, expect, it, vi } from 'vitest';
import { readAppVersion } from './app-version.js';

/** Controls what `createRequire(...)('electron')` returns; `null` restores the real `createRequire`. */
let fakeElectron: unknown = null;

vi.mock('node:module', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:module')>();
  return {
    ...actual,
    createRequire: (url: string | URL) => {
      if (fakeElectron === null) return actual.createRequire(url);
      return ((id: string) => {
        if (id === 'electron') return fakeElectron;
        throw new Error(`unexpected require: ${id}`);
      }) as NodeJS.Require;
    },
  };
});

describe('readAppVersion', () => {
  const original = process.versions['electron'];

  afterEach(() => {
    fakeElectron = null;
    if (original === undefined) delete (process.versions as Record<string, string>)['electron'];
    else (process.versions as Record<string, string>)['electron'] = original;
  });

  // @spec APP-DIAG-BNDL-010
  it("should return 'unknown' outside Electron", () => {
    delete (process.versions as Record<string, string>)['electron'];
    expect(readAppVersion()).toBe('unknown');
  });

  it("should return 'unknown' when requiring electron fails under a fake Electron runtime", () => {
    // Plain Node: `require('electron')` resolves to a path string (no `app`), so getVersion throws.
    (process.versions as Record<string, string>)['electron'] = '0.0.0';
    expect(readAppVersion()).toBe('unknown');
  });

  // @spec APP-DIAG-BNDL-010
  it("should return app.getVersion()'s value under Electron", () => {
    (process.versions as Record<string, string>)['electron'] = '0.0.0';
    fakeElectron = { app: { getVersion: () => '0.8.0' } };
    expect(readAppVersion()).toBe('0.8.0');
  });
});
