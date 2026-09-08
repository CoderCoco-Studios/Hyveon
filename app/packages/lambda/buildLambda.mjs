import { build } from 'esbuild';
import { mkdirSync } from 'fs';

/**
 * Bundles a Lambda package's `src/handler.ts` into `dist/handler.cjs` with
 * the settings shared by every package under `app/packages/lambda/*`.
 *
 * @param options - Per-package overrides. `external` lists modules esbuild
 * should leave unbundled (passed through to esbuild's `external`); omit to
 * bundle everything.
 */
export async function buildLambda({ external } = {}) {
  mkdirSync('dist', { recursive: true });

  await build({
    entryPoints: ['src/handler.ts'],
    outfile: 'dist/handler.cjs',
    bundle: true,
    platform: 'node',
    target: 'node24',
    format: 'cjs',
    minify: true,
    sourcemap: true,
    ...(external ? { external } : {}),
    logLevel: 'info',
  });
}
