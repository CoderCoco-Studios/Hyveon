import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';

/** Absolute path to the repo root (two directories above `app/test/`). */
const repoRoot = fileURLToPath(new URL('../../', import.meta.url));

/** Reads a repo file as text. */
function read(relativePath: string): string {
  return readFileSync(`${repoRoot}${relativePath}`, 'utf8');
}

/** Returns the `strategy.matrix` block (from `matrix:` to the job's `runs-on:`) of a workflow's package job. */
function packageMatrix(workflow: string): string {
  const start = workflow.indexOf('      matrix:');
  const end = workflow.indexOf('    runs-on: ${{ matrix.os }}', start);
  return workflow.slice(start, end).trim();
}

describe('build-package action', () => {
  // @spec APP-UPDATE-PKG-006
  it('should reinstall @tailwindcss/oxide at the version the lockfile resolves, not a hard-coded one', () => {
    const action = read('.github/actions/build-package/action.yml');
    const install = /npm install --no-save .*@tailwindcss\/oxide.*/.exec(action)?.[0] ?? '';

    expect(install).not.toMatch(/oxide@\d/);
    expect(install).toContain('package-lock.json');
  });

  // @spec APP-UPDATE-PKG-006
  it('should read a version out of the lockfile that is a plain semver', () => {
    const lock = JSON.parse(read('package-lock.json')) as { packages: Record<string, { version?: string }> };

    expect(lock.packages['node_modules/@tailwindcss/oxide']?.version).toMatch(/^\d+\.\d+\.\d+$/);
  });
});

describe('publish-release action', () => {
  // @spec APP-UPDATE-DRAFT-004
  it('should delete the draft by release id when the run fails after creating it', () => {
    const action = read('.github/actions/publish-release/action.yml');
    const verifyAt = action.indexOf('name: Verify feed and installer assets');
    const cleanup = action.slice(action.indexOf('name: Delete incomplete draft'));

    expect(verifyAt).toBeGreaterThan(-1);
    expect(action.indexOf('name: Delete incomplete draft')).toBeGreaterThan(verifyAt);
    expect(cleanup).toContain("if: ${{ failure() && steps.release.outputs.id != '' }}");
    expect(cleanup).toContain('-X DELETE "repos/${GITHUB_REPOSITORY}/releases/${RELEASE_ID}"');
  });
});

describe('package workflows', () => {
  // @spec APP-UPDATE-PKG-005
  it('should build the same platform matrix in the PR and release package jobs', () => {
    const pr = packageMatrix(read('.github/workflows/package.yml'));
    const release = packageMatrix(read('.github/workflows/release.yml'));

    expect(pr).toContain('artifact_glob');
    expect(release).toBe(pr);
  });
});
