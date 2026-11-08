import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
// @ts-expect-error - plain ESM build script with no type declarations
import { buildLambda } from './buildLambda.mjs';

describe('buildLambda', () => {
  let packageDir: string | undefined;

  afterEach(() => {
    if (packageDir) rmSync(packageDir, { recursive: true, force: true });
    packageDir = undefined;
  });

  // @spec IAC-PROGRAM-RUNTIME-006
  it('should bundle relative to the given package directory, not the cwd, and emit no sourcemap', async () => {
    packageDir = mkdtempSync(path.join(tmpdir(), 'build-lambda-'));
    mkdirSync(path.join(packageDir, 'src'));
    writeFileSync(path.join(packageDir, 'src', 'handler.ts'), 'export const handler = async () => 1;\n');

    await buildLambda({ packageDir });

    expect(existsSync(path.join(packageDir, 'dist', 'handler.cjs'))).toBe(true);
    expect(existsSync(path.join(packageDir, 'dist', 'handler.cjs.map'))).toBe(false);
    expect(existsSync(path.resolve('dist', 'handler.cjs'))).toBe(false);
  });
});
