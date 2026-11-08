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
    expect(action).toContain("require('./package-lock.json')");
  });

  // @spec APP-UPDATE-PKG-006
  it('should read the version on its own line and refuse a non-semver result before installing', () => {
    const action = read('.github/actions/build-package/action.yml');
    const versionRead = action.indexOf('v=$(node -p');
    const guard = action.indexOf('[[ "$v" =~ ^[0-9]+\\.[0-9]+\\.[0-9]+$ ]]');
    const install = action.indexOf('npm install --no-save "@tailwindcss/oxide@${v}"');

    expect(versionRead).toBeGreaterThan(-1);
    expect(guard).toBeGreaterThan(versionRead);
    expect(install).toBeGreaterThan(guard);
    expect(action.slice(guard, install)).toContain('exit 1');
    expect(action).not.toMatch(/oxide@\$\(/);
  });

  // @spec APP-UPDATE-PKG-006
  it('should read a version out of the lockfile that is a plain semver', () => {
    const lock = JSON.parse(read('package-lock.json')) as { packages: Record<string, { version?: string }> };

    expect(lock.packages['node_modules/@tailwindcss/oxide']?.version).toMatch(/^\d+\.\d+\.\d+$/);
  });
});

describe('publish-release action', () => {
  /** The `Delete incomplete draft` step's text. */
  function cleanupStep(): string {
    const action = read('.github/actions/publish-release/action.yml');
    return action.slice(action.indexOf('name: Delete incomplete draft'));
  }

  // @spec APP-UPDATE-DRAFT-004
  it('should run its cleanup after verification on any failure, not only when the release id was output', () => {
    const action = read('.github/actions/publish-release/action.yml');

    expect(action.indexOf('name: Delete incomplete draft')).toBeGreaterThan(
      action.indexOf('name: Verify feed and installer assets'),
    );
    expect(cleanupStep()).toContain('if: ${{ failure() }}');
  });

  // @spec APP-UPDATE-DRAFT-004
  it('should find the draft by tag via env when the upload failed before the id was output', () => {
    const cleanup = cleanupStep();

    expect(cleanup).toContain('TAG: ${{ inputs.tag }}');
    expect(cleanup).toContain('select(.draft and .tag_name == env.TAG)');
  });

  // @spec APP-UPDATE-DRAFT-004
  it('should delete only a release that is still a draft', () => {
    const cleanup = cleanupStep();
    const draftCheck = cleanup.indexOf('--jq .draft)" = true');
    const del = cleanup.indexOf('-X DELETE "repos/${GITHUB_REPOSITORY}/releases/${RELEASE_ID}"');

    expect(draftCheck).toBeGreaterThan(-1);
    expect(del).toBeGreaterThan(draftCheck);
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
