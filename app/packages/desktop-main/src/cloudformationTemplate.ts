import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// electron-vite injects __dirname for main-process entries, but we also
// compute it explicitly via import.meta.url so the file is valid plain ESM
// (same approach as electron-entry.ts).
const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * Resolves the on-disk path to `iam-bootstrap.yaml`, the CloudFormation
 * template shell a later group's `GuidedIamService` reads and renders (token
 * substitution, then submits as a stack) during first-run IAM bootstrap.
 *
 * Mirrors `electron-entry.ts`'s `resolveWindowIcon()` candidate-list
 * resolution pattern: packaged builds find it under `process.resourcesPath`
 * (electron-builder copies it there via `extraResources`); a dev Electron run
 * falls back to the repo-relative source location. `electron-vite` bundles
 * every main-process module (this one included) into a single `out/main`
 * chunk, so `__dirname` here resolves to `out/main` just like it does in
 * `electron-entry.ts` — two levels up is the repo root, from which the path
 * descends back into `desktop-main`'s own `resources/` directory (unlike
 * `build/icon.png`, this asset lives inside the package, not at the repo
 * root).
 *
 * A third candidate covers a *different* compiled layout: this module is
 * also loaded directly from `@hyveon/desktop-main`'s plain `tsc` output
 * (`dist/cloudformationTemplate.js`, one level under the package root) by
 * workspace consumers outside the Electron bundle — e.g. the tier-2
 * integration-test harness (`e2e/integration-specs`), which imports
 * `AppModule` straight from `dist/`. `__dirname` there is one level shallower
 * than the `out/main` case above, so the second candidate's two-`..` walk
 * overshoots; this candidate walks up just one level (`dist/` → the package
 * root) instead.
 *
 * Returns `undefined` when none of the three copies is present rather than
 * throwing — callers decide how to surface a missing template.
 */
export function resolveCloudFormationTemplatePath(): string | undefined {
  const candidates = [
    process.resourcesPath
      ? path.join(process.resourcesPath, 'cloudformation', 'iam-bootstrap.yaml')
      : undefined,
    path.join(
      __dirname,
      '..',
      '..',
      'app',
      'packages',
      'desktop-main',
      'resources',
      'cloudformation',
      'iam-bootstrap.yaml',
    ),
    path.join(__dirname, '..', 'resources', 'cloudformation', 'iam-bootstrap.yaml'),
  ];

  return candidates.find((candidate) => candidate !== undefined && existsSync(candidate));
}
