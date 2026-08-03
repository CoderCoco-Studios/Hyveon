import { Injectable } from '@nestjs/common';
import { readFileSync, writeFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';
import { generateHyveonDeployAllPolicy, generateHyveonSelfRotatePolicy } from '@hyveon/shared';
import { resolveCloudFormationTemplatePath } from '../cloudformationTemplate.js';

/** Absolute path to the `dist/services/` directory at runtime. */
const _dirname = dirname(fileURLToPath(import.meta.url));

/**
 * Absolute path to the app root (`app/` in the repo, `/workspace/app/` in Docker).
 * Derived by walking 4 levels up from `dist/services/`, mirroring
 * `ConfigService`'s own `_APP_ROOT` — this file lives at the same depth
 * (`src/services/`, compiled to `dist/services/`).
 * Used only as a private dev-mode fallback inside {@link GuidedIamService.getRenderedTemplatePath}.
 */
const _APP_ROOT = join(_dirname, '..', '..', '..', '..');

/** Result of {@link GuidedIamService.renderTemplate}. */
export interface RenderedTemplateResult {
  /** Absolute path to the rendered `iam-bootstrap.yaml` copy on disk. */
  path: string;
}

/**
 * Drives the first-run guided IAM bootstrap flow: renders the
 * `iam-bootstrap.yaml` CloudFormation template shell (Group 1) with the
 * `HyveonDeployAll`/`HyveonSelfRotate` policy documents substituted in,
 * opens the operator's browser at the CloudFormation console, intakes the
 * resulting bootstrap access key, and performs the mandatory
 * mint-then-revoke rotation onto a freshly-minted key. This service does
 * **not** read `ElectronStoreService.get('aws')` for its own credentials or
 * region — it runs *before* that credential source exists, so every method
 * that talks to AWS takes credentials/region as explicit parameters from
 * its caller.
 */
@Injectable()
export class GuidedIamService {
  /**
   * Renders `iam-bootstrap.yaml` (located via
   * {@link resolveCloudFormationTemplatePath}) by substituting its two
   * literal placeholder tokens with single-line `JSON.stringify()` output
   * from {@link generateHyveonDeployAllPolicy} and
   * {@link generateHyveonSelfRotatePolicy} — deliberately **not**
   * pretty-printed (`null, 2`), since a multi-line JSON string at that YAML
   * position (inline after `PolicyDocument: `) would not parse as valid
   * YAML. The template's `Parameters.UserName` is left untouched: it stays
   * a real CloudFormation stack parameter the operator can override in the
   * console, never a value this service bakes in.
   *
   * Writes the rendered result to disk via
   * {@link getRenderedTemplatePath} and returns the path written.
   *
   * Throws when {@link resolveCloudFormationTemplatePath} finds neither a
   * packaged nor a dev copy of the template — a loud failure rather than
   * silently producing a broken (un-rendered) file.
   */
  renderTemplate(): RenderedTemplateResult {
    const templatePath = resolveCloudFormationTemplatePath();
    if (!templatePath) {
      throw new Error(
        'Cannot render the IAM bootstrap CloudFormation template: iam-bootstrap.yaml was not found ' +
          'under the packaged resources or the dev source tree. Reinstall the app or check out a ' +
          'complete working tree.',
      );
    }

    const rendered = readFileSync(templatePath, 'utf-8')
      .replace('__HYVEON_DEPLOY_ALL_POLICY_DOCUMENT__', JSON.stringify(generateHyveonDeployAllPolicy()))
      .replace('__HYVEON_SELF_ROTATE_POLICY_DOCUMENT__', JSON.stringify(generateHyveonSelfRotatePolicy()));

    const outputPath = this.getRenderedTemplatePath();
    writeFileSync(outputPath, rendered);
    return { path: outputPath };
  }

  /**
   * Return `process.resourcesPath` when running inside an Electron packaged app,
   * or `undefined` otherwise. Extracted as a protected method so tests can stub
   * it via `vi.spyOn` without touching `process.resourcesPath` directly.
   *
   * Mirrors `ConfigService.readIsPackaged`'s implementation exactly (see that
   * method's doc comment for why `process.resourcesPath` alone cannot be used
   * as the packaged-build guard).
   */
  protected readIsPackaged(): boolean {
    if (!process.versions['electron']) return false;
    try {
      const _require = createRequire(import.meta.url);
      const electron = _require('electron') as { app: { isPackaged: boolean } };
      return electron.app.isPackaged;
    } catch {
      return false;
    }
  }

  /**
   * Return the Electron `userData` directory when running inside an Electron
   * process, or `null` otherwise. The `electron` module is required lazily at
   * call-time (keyed on `process.versions['electron']` being truthy) so that
   * importing this module in a plain Node/test context never triggers an
   * unresolved-module error. Extracted as a protected method so tests can stub
   * it via `vi.spyOn`. Mirrors `ConfigService.readUserDataPath` exactly.
   */
  protected readUserDataPath(): string | null {
    if (!process.versions['electron']) return null;
    try {
      const _require = createRequire(import.meta.url);
      const electron = _require('electron') as { app: { getPath(name: string): string } };
      return electron.app.getPath('userData');
    } catch {
      return null;
    }
  }

  /**
   * Resolve the absolute path {@link renderTemplate} writes the rendered
   * template to, following `ConfigService.getServerConfigPath()`'s exact
   * packaged/dev-fallback resolution order (no env-var override here, since
   * this is a scratch render output rather than an operator-configured
   * path):
   *  1. Electron packaged app (`readIsPackaged()`) —
   *     `<userData>/iam-bootstrap-rendered.yaml` (a user-writable location
   *     that survives app updates).
   *  2. Dev/test fallback — `<APP_ROOT>/.iam-bootstrap-dev` (git-ignored; a
   *     scratch file, not a committed asset — deliberately outside
   *     `resources/`, which holds the source template Group 1 shipped).
   */
  protected getRenderedTemplatePath(): string {
    if (this.readIsPackaged()) {
      const userData = this.readUserDataPath();
      if (userData) {
        return join(userData, 'iam-bootstrap-rendered.yaml');
      }
    }

    return join(_APP_ROOT, '.iam-bootstrap-dev');
  }
}
