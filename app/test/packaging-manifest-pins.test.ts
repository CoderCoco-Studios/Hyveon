import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';
import { PULUMI_ENGINE_VERSION } from '@hyveon/shared';

/**
 * Guards the one dependency invariant in this repo that nothing else can catch.
 *
 * `@pulumi/pulumi` and `@pulumi/aws` are marked `external` in
 * `electron.vite.config.ts` so they are loaded from `node_modules` at runtime
 * instead of being bundled into `out/main`. That makes them runtime
 * dependencies of the *packaged app*, and electron-builder only copies
 * `node_modules` belonging to the app manifest's production dependency
 * tree — the app manifest being the root `package.json`, per
 * `directories.app: "."` in `electron-builder.yml`. The `files` whitelist there
 * can narrow that set but never add to it.
 *
 * (`@cdktf/hcl2json` was externalized here too, for the same reason, before
 * the `migrate-iac-to-pulumi` change removed it from the dependency tree
 * entirely — see `DeploymentConfigService.ts`'s JSON-only configuration model.)
 *
 * So the same packages are pinned in multiple manifests, for different reasons:
 *
 *  - `app/packages/desktop-main/package.json` — what the main-process workspace
 *    compiles and typechecks against. It declares every package the root ships.
 *  - `app/packages/infra/package.json` — what the Pulumi program workspace
 *    (bundled into the main process, same as `@hyveon/shared`) compiles and
 *    typechecks against. It only needs the `@pulumi/*` subset.
 *  - the root `package.json` — what electron-builder collects and ships.
 *
 * If any of these drift, some part of the toolchain typechecks against a
 * different SDK version than the one that ships in the packaged app, and
 * nothing else notices: lint, typecheck, the unit suite and the e2e suite all
 * resolve the hoisted copy and stay green.
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

/**
 * Compares a dependent manifest's pins against the root's, restricted to
 * `depNames` (the packages the dependent is expected to declare). Returns one
 * drift entry per package whose pin doesn't match the root exactly.
 */
function findPinDrift(root: Manifest, dependent: Manifest, depNames: string[]) {
  return depNames
    .filter((name) => dependent.dependencies?.[name] !== root.dependencies?.[name])
    .map((name) => ({
      package: name,
      root: root.dependencies?.[name] ?? '<missing>',
      dependent: dependent.dependencies?.[name] ?? '<missing>',
    }));
}

describe('packaging manifest pins', () => {
  const root = manifest('package.json');
  const desktopMain = manifest('app/packages/desktop-main/package.json');
  const infra = manifest('app/packages/infra/package.json');

  it('should declare at least one runtime dependency in the root app manifest', () => {
    // A root manifest with no `dependencies` is the failure mode that made every
    // `node_modules/**` glob in electron-builder.yml inert and shipped an
    // app.asar containing nothing but `out/**`.
    expect(Object.keys(root.dependencies ?? {}).length).toBeGreaterThan(0);
  });

  it('should pin every root runtime dependency identically in @hyveon/desktop-main', () => {
    const drift = findPinDrift(root, desktopMain, Object.keys(root.dependencies ?? {}));

    expect(
      drift,
      'the root manifest is what electron-builder ships; @hyveon/desktop-main is what the code typechecks against — they must agree',
    ).toEqual([]);
  });

  it('should pin the root Pulumi packages identically in @hyveon/infra', () => {
    const pulumiPackages = Object.keys(root.dependencies ?? {}).filter((name) => name.startsWith('@pulumi/'));
    const drift = findPinDrift(root, infra, pulumiPackages);

    expect(
      drift,
      'the root manifest is what electron-builder ships; @hyveon/infra is what the Pulumi program typechecks against — they must agree',
    ).toEqual([]);
  });

  it('should match the @hyveon/shared PULUMI_ENGINE_VERSION constant to the root @pulumi/pulumi pin', () => {
    // PulumiEngineService.resolve() installs PULUMI_ENGINE_VERSION via
    // `PulumiCommand.install({ version })`. If it drifts from the SDK pin the
    // manifests above are already guarded to agree on, the app would
    // typecheck against one Automation API version while provisioning and
    // running a different engine binary at runtime.
    expect(PULUMI_ENGINE_VERSION).toBe(root.dependencies?.['@pulumi/pulumi']);
  });
});
