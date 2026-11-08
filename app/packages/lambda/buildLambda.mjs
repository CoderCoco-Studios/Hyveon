import { build } from 'esbuild';
import { mkdirSync } from 'fs';
import { join } from 'path';

// @spec IAC-PROGRAM-RUNTIME-006
/**
 * Bundles a Lambda package's `src/handler.ts` into `dist/handler.cjs` with
 * the settings shared by every package under `app/packages/lambda/*`.
 *
 * @param options - `packageDir` is the package root the entry and output
 * paths resolve against (callers pass `import.meta.dirname`); it defaults to
 * the process cwd. `external` lists modules esbuild should leave unbundled
 * (passed through to esbuild's `external`); omit to bundle everything.
 */
export async function buildLambda({ packageDir = process.cwd(), external } = {}) {
  mkdirSync(join(packageDir, 'dist'), { recursive: true });

  await build({
    absWorkingDir: packageDir,
    entryPoints: [join(packageDir, 'src/handler.ts')],
    outfile: join(packageDir, 'dist/handler.cjs'),
    bundle: true,
    platform: 'node',
    target: 'node24',
    format: 'cjs',
    minify: true,
    ...(external ? { external } : {}),
    logLevel: 'info',
  });
}
