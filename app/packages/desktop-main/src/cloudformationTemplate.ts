import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// electron-vite injects __dirname for main-process entries, but we also
// compute it explicitly via import.meta.url so the file is valid plain ESM
// (same approach as electron-entry.ts).
const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * Resolves the on-disk path to `iam-bootstrap.yaml`, the CloudFormation
 * template shell rendered (token substitution, then submitted as a stack)
 * during first-run IAM bootstrap.
 *
 * @remarks
 * Mirrors `electron-entry.ts`'s `resolveWindowIcon()` candidate-list pattern.
 * The first candidate covers packaged builds (electron-builder's
 * `extraResources`); the second covers a dev Electron run, where
 * `electron-vite` bundles this module into `out/main`, two levels below the
 * repo root; the third covers plain `tsc` output (`dist/`) used by
 * non-Electron consumers such as the tier-2 integration-test harness, where
 * `__dirname` is one level shallower so the walk-up is one `..` instead of
 * two. Returns `undefined` when none of the three copies is present rather
 * than throwing — callers decide how to surface a missing template.
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
