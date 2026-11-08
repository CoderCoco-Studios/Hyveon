import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const packageDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

describe('@hyveon/infra build output', () => {
  // @spec IAC-PROGRAM-WS-006
  it('should exclude test-only helpers under src/testing from the compiled files', () => {
    const tsc = path.join(path.dirname(createRequire(import.meta.url).resolve('typescript/package.json')), 'lib', 'tsc.js');
    const listed = execFileSync(process.execPath, [tsc, '-p', path.join(packageDir, 'tsconfig.json'), '--listFilesOnly'], {
      encoding: 'utf8',
    })
      .split('\n')
      .map((file) => file.replaceAll('\\', '/'));
    const inPackage = listed.filter((file) => file.startsWith(`${packageDir.replaceAll('\\', '/')}/src/`));

    expect(inPackage.length).toBeGreaterThan(0);
    expect(inPackage.filter((file) => file.includes('/src/testing/'))).toEqual([]);
    expect(inPackage.filter((file) => file.endsWith('.test.ts'))).toEqual([]);
  });
});
