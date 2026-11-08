import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';

/**
 * Packages `electron.vite.config.ts` keeps `external` from the main bundle (and `electron-builder.yml` therefore
 * ships from `node_modules`), plus `semver`, which is external for its own reason.
 */
const EXTERNALIZED_ROOTS = [
  '@pulumi/pulumi',
  '@pulumi/aws',
  'class-validator',
  'class-transformer',
  'electron-updater',
];

/** Closure members that are declaration-only and never loaded at runtime, so shipping them is wasted size. */
const TYPES_ONLY = new Set(['@types/node']);

/** Absolute path to the repo root (two directories above `app/test/`). */
const repoRoot = fileURLToPath(new URL('../../', import.meta.url));

/** Minimal shape of the manifest fields the closure walk reads. */
interface Manifest {
  dependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
}

/** Reads a manifest from `dir`, or `null` when the package is not installed there. */
function readManifest(dir: string): Manifest | null {
  const file = join(dir, 'package.json');
  return existsSync(file) ? (JSON.parse(readFileSync(file, 'utf8')) as Manifest) : null;
}

/** Resolves `name` as Node does from `fromDir`: each ancestor's `node_modules` up to the root's. */
function resolvePackageDir(name: string, fromDir: string): string {
  for (let dir = fromDir; dir.startsWith(repoRoot); dir = dirname(dir)) {
    const candidate = join(dir, 'node_modules', name);
    if (existsSync(join(candidate, 'package.json'))) return candidate;
  }
  return join(repoRoot, 'node_modules', name);
}

/**
 * Collects the hoisted runtime-dependency closure (`dependencies` and `optionalDependencies`) of `roots`.
 * A dependency is resolved the way Node does: the requiring package's own nested `node_modules` first, then the
 * root. Nested copies are walked (their dependencies may be hoisted) but not returned, because the parent's glob
 * covers them; optional dependencies absent on this platform are skipped.
 */
export function runtimeClosure(roots: readonly string[]): Set<string> {
  const rootModules = join(repoRoot, 'node_modules');
  const hoisted = new Set<string>();
  const walkedDirs = new Set<string>();
  const queue: { name: string; fromDir: string }[] = roots.map((name) => ({ name, fromDir: repoRoot }));
  while (queue.length > 0) {
    const { name, fromDir } = queue.pop() as { name: string; fromDir: string };
    const dir = resolvePackageDir(name, fromDir);
    if (walkedDirs.has(dir)) continue;
    const manifest = readManifest(dir);
    if (!manifest) continue;
    walkedDirs.add(dir);
    if (dir === join(rootModules, name)) hoisted.add(name);
    for (const dep of [...Object.keys(manifest.dependencies ?? {}), ...Object.keys(manifest.optionalDependencies ?? {})]) {
      queue.push({ name: dep, fromDir: dir });
    }
  }
  return hoisted;
}

/** The `node_modules/...` globs under `electron-builder.yml`'s top-level `files:` list. */
function packagedNodeModuleGlobs(): string[] {
  const lines = readFileSync(join(repoRoot, 'electron-builder.yml'), 'utf8').split('\n');
  const start = lines.findIndex((l) => l === 'files:');
  const globs: string[] = [];
  for (const line of lines.slice(start + 1)) {
    if (line !== '' && !line.startsWith(' ')) break;
    const match = /^ {2}- (node_modules\/\S+)$/.exec(line);
    if (match?.[1]) globs.push(match[1]);
  }
  return globs;
}

/** True when some `files` glob (`node_modules/<name>/**` or `node_modules/@scope/**`) covers package `name`. */
function isCovered(name: string, globs: readonly string[]): boolean {
  const scope = name.startsWith('@') ? name.split('/')[0] : null;
  return globs.includes(`node_modules/${name}/**`) || (scope !== null && globs.includes(`node_modules/${scope}/**`));
}

// @spec APP-UPDATE-PKG-008
describe('electron-builder files closure', () => {
  it('should list every hoisted runtime dependency of the externalized packages', () => {
    const globs = packagedNodeModuleGlobs();
    const closure = runtimeClosure(EXTERNALIZED_ROOTS);

    const missing = [...closure].filter((name) => !TYPES_ONLY.has(name) && !isCovered(name, globs)).sort();

    expect(
      missing,
      'externalized packages load from node_modules at runtime; add each missing package to electron-builder.yml `files`',
    ).toEqual([]);
  });

  it('should walk a non-trivial closure so an empty walk cannot pass vacuously', () => {
    const closure = runtimeClosure(EXTERNALIZED_ROOTS);

    expect(closure.has('@pulumi/pulumi')).toBe(true);
    expect(closure.has('@grpc/grpc-js')).toBe(true);
    expect(closure.size).toBeGreaterThan(50);
  });

  it('should report a package missing from a files list that omits it', () => {
    const closure = runtimeClosure(['electron-updater']);

    expect([...closure].filter((name) => !isCovered(name, ['node_modules/electron-updater/**']))).not.toEqual([]);
  });
});
