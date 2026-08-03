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
 * Mirrors `electron-entry.ts`'s `resolveWindowIcon()` two-candidate
 * resolution pattern: packaged builds find it under `process.resourcesPath`
 * (electron-builder copies it there via `extraResources`); a dev run falls
 * back to the repo-relative source location. `electron-vite` bundles every
 * main-process module (this one included) into a single `out/main` chunk, so
 * `__dirname` here resolves to `out/main` just like it does in
 * `electron-entry.ts` — two levels up is the repo root, from which the path
 * descends back into `desktop-main`'s own `resources/` directory (unlike
 * `build/icon.png`, this asset lives inside the package, not at the repo
 * root).
 *
 * Returns `undefined` when neither copy is present rather than throwing —
 * callers decide how to surface a missing template.
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
  ];

  return candidates.find((candidate) => candidate !== undefined && existsSync(candidate));
}
