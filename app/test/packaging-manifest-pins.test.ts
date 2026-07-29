import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';

/**
 * Guards the one dependency invariant in this repo that nothing else can catch.
 *
 * A handful of packages are marked `external` in `electron.vite.config.ts`
 * (`@pulumi/pulumi`, `@pulumi/aws`, `@cdktf/hcl2json`) so they are loaded from
 * `node_modules` at runtime instead of being bundled into `out/main`. That makes
 * them runtime dependencies of the *packaged app*, and electron-builder only
 * copies `node_modules` belonging to the app manifest's production dependency
 * tree — the app manifest being the root `package.json`, per
 * `directories.app: "."` in `electron-builder.yml`. The `files` whitelist there
 * can narrow that set but never add to it.
 *
 * So the same packages are pinned in two manifests, for two different reasons:
 *
 *  - `app/packages/desktop-main/package.json` — what the workspace compiles and
 *    typechecks against.
 *  - the root `package.json` — what electron-builder collects and ships.
 *
 * If the two drift, the packaged app runs a different version of the SDK than
 * the one the code was typechecked against, and nothing else in the toolchain
 * notices: lint, typecheck, the unit suite and the e2e suite all resolve the
 * hoisted copy and stay green.
 */

/** Absolute path to the repo root (two directories above `app/test/`). */
const repoRoot = fileURLToPath(new URL('../../', import.meta.url));

/** Minimal shape of the manifest fields this spec reads. */
interface Manifest {
  dependencies?: Record<string, string>;
}

/** Reads and parses a package.json relative to the repo root. */
function manifest(relativePath: string): Manifest {
  return JSON.parse(readFileSync(`${repoRoot}${relativePath}`, 'utf8')) as Manifest;
}

describe('packaging manifest pins', () => {
  const root = manifest('package.json');
  const desktopMain = manifest('app/packages/desktop-main/package.json');

  it('should declare at least one runtime dependency in the root app manifest', () => {
    // A root manifest with no `dependencies` is the failure mode that made every
    // `node_modules/**` glob in electron-builder.yml inert and shipped an
    // app.asar containing nothing but `out/**`.
    expect(Object.keys(root.dependencies ?? {}).length).toBeGreaterThan(0);
  });

  it('should pin every root runtime dependency identically in @hyveon/desktop-main', () => {
    const drift = Object.entries(root.dependencies ?? {})
      .filter(([name, spec]) => desktopMain.dependencies?.[name] !== spec)
      .map(([name, spec]) => ({
        package: name,
        root: spec,
        desktopMain: desktopMain.dependencies?.[name] ?? '<missing>',
      }));

    expect(
      drift,
      'the root manifest is what electron-builder ships; @hyveon/desktop-main is what the code typechecks against — they must agree',
    ).toEqual([]);
  });
});
