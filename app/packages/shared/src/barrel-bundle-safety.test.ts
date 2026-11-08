import { existsSync, readFileSync } from 'node:fs';
import { builtinModules } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const SRC_DIR = dirname(fileURLToPath(import.meta.url));
const BARREL = resolve(SRC_DIR, 'index.ts');
const NODE_BUILTINS = new Set(builtinModules.filter((name) => !name.startsWith('_')));
const SPECIFIER = /(?:^|\n)\s*(?:import|export)\b[^'"`;]*?\bfrom\s+['"]([^'"]+)['"]|(?:^|\n)\s*import\s+['"]([^'"]+)['"]/g;

/** Existing barrel-reachable files allowed to import a Node built-in, as `relative/path.ts`. */
const ALLOWLIST: ReadonlySet<string> = new Set<string>([]);

/**
 * Whether `specifier` names a Node built-in (`node:*` or a bare core module such as `net` or `fs/promises`).
 *
 * @param specifier - The module specifier as written in the import.
 * @returns `true` for Node built-ins.
 */
function isNodeBuiltin(specifier: string): boolean {
  return specifier.startsWith('node:') || NODE_BUILTINS.has(specifier);
}

/**
 * Resolves a relative `.js`/`.ts` specifier from `fromFile` to an existing TypeScript source file.
 *
 * @param fromFile - Absolute path of the importing file.
 * @param specifier - Relative specifier as written.
 * @returns The absolute source path, or `null` when no source file matches.
 */
function resolveRelative(fromFile: string, specifier: string): string | null {
  const base = resolve(dirname(fromFile), specifier);
  const stem = base.replace(/\.(?:js|ts)$/, '');
  const candidates = [`${stem}.ts`, `${stem}.tsx`, resolve(base, 'index.ts'), resolve(stem, 'index.ts')];
  return candidates.find((candidate) => existsSync(candidate)) ?? null;
}

/**
 * Walks every module reachable from the barrel through relative imports and collects Node built-in imports.
 *
 * @returns Offenders as `relative/path.ts -> specifier` strings, sorted.
 */
function findBuiltinImportsReachableFromBarrel(): string[] {
  const seen = new Set<string>();
  const offenders = new Set<string>();
  const queue = [BARREL];
  while (queue.length > 0) {
    const file = queue.pop() as string;
    if (seen.has(file)) continue;
    seen.add(file);
    const source = readFileSync(file, 'utf8');
    for (const match of source.matchAll(SPECIFIER)) {
      const specifier = (match[1] ?? match[2]) as string;
      if (specifier.startsWith('.')) {
        const target = resolveRelative(file, specifier);
        if (target !== null) queue.push(target);
      } else if (isNodeBuiltin(specifier)) {
        offenders.add(`${file.slice(SRC_DIR.length + 1)} -> ${specifier}`);
      }
    }
  }
  return [...offenders].sort();
}

describe('shared barrel bundle safety', () => {
  it('should not reach any Node built-in import from the barrel beyond the allowlist', () => {
    const unexpected = findBuiltinImportsReachableFromBarrel().filter(
      (entry) => !ALLOWLIST.has(entry.split(' -> ')[0] as string),
    );
    expect(unexpected).toEqual([]);
  });

  it('should detect a Node built-in import', () => {
    expect(isNodeBuiltin('node:net')).toBe(true);
    expect(isNodeBuiltin('net')).toBe(true);
    expect(isNodeBuiltin('fs/promises')).toBe(true);
    expect(isNodeBuiltin('@aws-sdk/client-dynamodb')).toBe(false);
    expect(isNodeBuiltin('./net.js')).toBe(false);
  });

  it('should match import and export-from specifiers', () => {
    const specs = [...`import { a } from 'node:net';\nexport * from './x.js';\nimport 'fs';`.matchAll(SPECIFIER)].map(
      (m) => m[1] ?? m[2],
    );
    expect(specs).toEqual(['node:net', './x.js', 'fs']);
  });
});
