import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { resolveCloudFormationTemplatePath } from './cloudformationTemplate.js';

/**
 * This test file sits in the same directory as `cloudformationTemplate.ts`
 * (`src/`), so `import.meta.url` here resolves to the same directory the
 * source module's own `__dirname` does — used below to compute the exact
 * expected value of the package-relative (plain-`tsc`-`dist/`-layout)
 * candidate independently of the module under test.
 */
const moduleDir = path.dirname(fileURLToPath(import.meta.url));

/** Spy for `existsSync`, driving which candidate path "exists" per test. */
const mockExistsSync = vi.hoisted(() => vi.fn().mockReturnValue(false));

vi.mock('node:fs', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:fs')>()),
  existsSync: mockExistsSync,
}));

/** Sets `process.resourcesPath`, which only Electron defines at runtime. */
function stubResourcesPath(value: string | undefined): void {
  Object.defineProperty(process, 'resourcesPath', { value, configurable: true });
}

describe('resolveCloudFormationTemplatePath', () => {
  const originalResourcesPathDescriptor = Object.getOwnPropertyDescriptor(process, 'resourcesPath');

  beforeEach(() => {
    mockExistsSync.mockReset().mockReturnValue(false);
  });

  afterEach(() => {
    if (originalResourcesPathDescriptor) {
      Object.defineProperty(process, 'resourcesPath', originalResourcesPathDescriptor);
    } else {
      delete (process as { resourcesPath?: string }).resourcesPath;
    }
  });

  it('should use the packaged template under resourcesPath when it exists', () => {
    stubResourcesPath(path.join('/opt', 'Hyveon', 'resources'));
    mockExistsSync.mockImplementation(
      (candidate: string) =>
        candidate ===
        path.join('/opt', 'Hyveon', 'resources', 'cloudformation', 'iam-bootstrap.yaml'),
    );

    expect(resolveCloudFormationTemplatePath()).toBe(
      path.join('/opt', 'Hyveon', 'resources', 'cloudformation', 'iam-bootstrap.yaml'),
    );
  });

  it('should fall back to the repo-relative path when running unpackaged', () => {
    stubResourcesPath(path.join('/opt', 'Hyveon', 'resources'));
    mockExistsSync.mockImplementation(
      (candidate: string) =>
        candidate.endsWith(path.join('cloudformation', 'iam-bootstrap.yaml')) &&
        candidate.includes('desktop-main'),
    );

    expect(resolveCloudFormationTemplatePath()).toMatch(
      /cloudformation[/\\]iam-bootstrap\.yaml$/,
    );
  });

  it('should return undefined when neither the packaged nor dev copy is present', () => {
    mockExistsSync.mockReturnValue(false);

    expect(resolveCloudFormationTemplatePath()).toBeUndefined();
  });

  it('should resolve via the package-relative candidate when only the plain-tsc dist layout matches', () => {
    // Isolates the third candidate this fix added (one level up from this
    // module's own directory — the plain-`tsc` `dist/` layout, as opposed
    // to the second candidate's two-levels-up `out/main` bundle layout).
    // `process.resourcesPath` is left unset (not packaged), so the first
    // array entry is `undefined` and `existsSync` is never invoked for it —
    // see the `candidate !== undefined &&` guard in
    // `resolveCloudFormationTemplatePath`. That makes the first mocked
    // `existsSync` call below answer for the second (out/main-depth)
    // candidate, and the second mocked call answer for the third
    // (dist-depth) candidate this test targets.
    mockExistsSync.mockImplementationOnce(() => false).mockImplementationOnce(() => true);

    const result = resolveCloudFormationTemplatePath();

    const expectedThirdCandidate = path.join(moduleDir, '..', 'resources', 'cloudformation', 'iam-bootstrap.yaml');
    expect(result).toBe(expectedThirdCandidate);
    // Distinct from the second candidate's shape, which re-descends through
    // the hardcoded 'app/packages/desktop-main' segments after walking up
    // two levels — deleting the third candidate (or reverting to only two
    // entries) would leave this second mocked `true` unconsumed and
    // `resolveCloudFormationTemplatePath` would return `undefined` instead,
    // failing this assertion.
    expect(mockExistsSync).toHaveBeenCalledTimes(2);
  });
});
