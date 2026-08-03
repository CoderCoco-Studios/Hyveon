import path from 'node:path';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { resolveCloudFormationTemplatePath } from './cloudformationTemplate.js';

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
});
