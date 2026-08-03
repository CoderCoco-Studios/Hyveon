import { Injectable } from '@nestjs/common';
import { readFileSync, writeFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';
import { STSClient, GetCallerIdentityCommand } from '@aws-sdk/client-sts';
import { IAMClient, CreateAccessKeyCommand, DeleteAccessKeyCommand } from '@aws-sdk/client-iam';
import { generateHyveonDeployAllPolicy, generateHyveonSelfRotatePolicy } from '@hyveon/shared';
import { resolveCloudFormationTemplatePath } from '../cloudformationTemplate.js';
import { logger } from '../logger.js';
import { ElectronStoreService } from './ElectronStoreService.js';
import { SafeStorageService } from './SafeStorageService.js';
import { SafeStorageUnavailableError } from './AwsProfileService.js';

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

/** Result of {@link GuidedIamService.openConsole}. */
export interface OpenConsoleResult {
  /**
   * `true` when the operator's default browser was launched successfully.
   * `false` on any failure (Electron unavailable, or `shell.openExternal`
   * threw/rejected) — the caller is expected to fall back to displaying the
   * URL as plain text for the operator to open manually.
   */
  opened: boolean;
}

/** Input to {@link GuidedIamService.intakeBootstrapKey}. */
export interface BootstrapKeyIntakeInput {
  /** Access key ID the operator pasted from the CloudFormation stack outputs. */
  accessKeyId: string;
  /** Secret access key the operator pasted from the CloudFormation stack outputs. */
  secretAccessKey: string;
  /** Region to validate the key pair against. */
  region: string;
}

/** Result of {@link GuidedIamService.intakeBootstrapKey}. */
export interface BootstrapKeyIntakeResult {
  /** AWS account ID resolved from `sts:GetCallerIdentity`. */
  accountId: string;
}

/**
 * Pasted-credentials profile name {@link GuidedIamService.rotate} stages the
 * freshly-minted key pair under (`creds.aws.<profileName>` via
 * {@link ElectronStoreService.setPastedCredentials}), and later activates as
 * `aws.profile`. Deliberately distinct from `AwsProfileService`'s
 * `DEFAULT_PASTED_PROFILE_NAME` (`'hyveon-pasted'`) so a later group can tell
 * guided-sourced credentials apart from manually-pasted ones purely by
 * profile name.
 */
export const GUIDED_PROFILE_NAME = 'hyveon-guided';

/** Input to {@link GuidedIamService.rotate}. */
export interface RotationInput {
  /** Access key ID of the validated bootstrap key (from {@link GuidedIamService.intakeBootstrapKey}). */
  bootstrapAccessKeyId: string;
  /** Secret access key of the validated bootstrap key. */
  bootstrapSecretAccessKey: string;
  /** Region to build every AWS client used during rotation against. */
  region: string;
}

/**
 * Outcome of {@link GuidedIamService.rotate}, modeled as a discriminated
 * union rather than throwing for its two failure branches — both
 * `verification-failed` and `delete-failed` are expected, recoverable states
 * the caller needs to render distinctly, not exceptional control flow. See
 * {@link GuidedIamService.rotate}'s doc comment for exactly which store state
 * each branch leaves behind.
 */
export type RotationResult =
  /** The new key pair is active and the bootstrap key has been revoked. */
  | { status: 'complete' }
  /**
   * `sts:GetCallerIdentity` failed for the newly minted key. Nothing became
   * active (`ElectronStoreService.set('aws', ...)` was never called) and the
   * bootstrap key was never deleted — retrying calls {@link GuidedIamService.rotate}
   * again from the top, which is safe (step 2 just overwrites the same
   * staging entry).
   */
  | { status: 'verification-failed'; error: string }
  /**
   * `iam:DeleteAccessKey` failed for the bootstrap key. The new key pair IS
   * already active — app functionality is fine going forward — but the
   * bootstrap key is still live and must be revoked manually via `consoleUrl`.
   */
  | { status: 'delete-failed'; consoleUrl: string };

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
   * @param store - Used only by {@link rotate}, to stage the freshly-minted
   *   key pair (`setPastedCredentials`) and, once verified, activate it
   *   (`set('aws', ...)`). Never read for this service's *own* AWS
   *   credentials — see the class doc comment.
   * @param safeStorage - Used only by {@link rotate}'s keychain gate
   *   (`isAvailable()`), checked before any credential is staged. Not used
   *   directly for encryption — `ElectronStoreService.setPastedCredentials`
   *   already gates and applies that internally.
   */
  constructor(
    private readonly store: ElectronStoreService,
    private readonly safeStorage: SafeStorageService,
  ) {}

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
   * Build the AWS CloudFormation console URL scoped to the given region,
   * pointing to the "Create stack" page with no pre-filled template URL
   * (the operator uploads the local rendered template file manually via the
   * console's "Upload a template file" option, per the spec's rejection of
   * hosted-template quick-create links).
   *
   * Returns the exact URL shape:
   * `https://<region>.console.aws.amazon.com/cloudformation/home?region=<region>#/stacks/create`
   *
   * This method is pure (no side effects, no IO, no external state
   * dependencies) and is extracted as a separate method so it can be
   * pinned by tests to reject shape regressions.
   */
  buildCloudFormationConsoleUrl(region: string): string {
    return `https://${region}.console.aws.amazon.com/cloudformation/home?region=${region}#/stacks/create`;
  }

  /**
   * Launch the operator's default browser at `url` (the CloudFormation
   * console page from {@link buildCloudFormationConsoleUrl}) via Electron's
   * `shell.openExternal`. This is the first use of `shell.openExternal` in
   * this codebase, so it follows the same lazy-require Electron-touching
   * seam every other main-process service uses (see
   * {@link SafeStorageService}'s `readIsElectron`/`encryptString` pair):
   * a `process.versions['electron']` guard in {@link readIsElectron}, and
   * the actual `createRequire` + typed destructure call in
   * {@link openExternalUrl}, each a separate `protected` method so tests can
   * stub them without importing the real `electron` module.
   *
   * Never throws: `shell.openExternal` returns a `Promise` in real Electron,
   * so a rejection is awaited inside a `try`/`catch` here rather than left
   * to reject uncaught. On any failure — Electron unavailable, or
   * `openExternalUrl` throwing/rejecting for any reason (permissions, no
   * registered browser handler, etc.) — this resolves to `{ opened: false }`
   * so the caller (a later group's wizard UI) can fall back to displaying
   * `url` as plain text for the operator to open manually, per the spec's
   * "Browser cannot be opened" scenario.
   *
   * @param url - The URL to open, typically the result of
   *   {@link buildCloudFormationConsoleUrl}.
   */
  async openConsole(url: string): Promise<OpenConsoleResult> {
    if (!this.readIsElectron()) {
      return { opened: false };
    }
    try {
      await this.openExternalUrl(url);
      return { opened: true };
    } catch {
      return { opened: false };
    }
  }

  /**
   * Validate an operator-submitted bootstrap access key pair by calling
   * `sts:GetCallerIdentity` with it, returning the resolved AWS account ID
   * on success.
   *
   * Unlike {@link IamCheckService} or `BootstrapService`, which build their
   * AWS clients from the wizard's already-established credential source
   * (`ElectronStoreService.get('aws')`, resolved via
   * `resolveAwsCredentialSource`), this method builds the `STSClient`
   * directly from `input` — this service runs *before* any credential
   * source exists; `input` is the operator's just-pasted bootstrap key, not
   * yet stored anywhere. See {@link createStsClient}.
   *
   * On success, returns `{ accountId }` taken directly from the response's
   * `Account` field — simpler than `IamCheckService`'s ARN-parsing, which
   * exists only because `SimulatePrincipalPolicy`'s `PolicySourceArn`
   * parameter accepts an ARN and nothing else; that need doesn't apply
   * here. Throws a clear error if `Account` is unexpectedly absent from an
   * otherwise-successful response.
   *
   * On failure, the underlying AWS SDK error propagates unchanged (never
   * wrapped in a generic "invalid credentials" message) — the caller needs
   * the real error to explain the failure to the operator.
   *
   * Persists nothing: this method's only job is validation.
   *
   * @param input - The pasted bootstrap key pair and the region to validate
   *   it against.
   */
  async intakeBootstrapKey(input: BootstrapKeyIntakeInput): Promise<BootstrapKeyIntakeResult> {
    const client = this.createStsClient(input);
    const response = await client.send(new GetCallerIdentityCommand({}));
    if (!response.Account) {
      throw new Error('sts:GetCallerIdentity did not return an Account for the submitted bootstrap key.');
    }
    return { accountId: response.Account };
  }

  /**
   * Performs the mandatory mint-then-revoke rotation of the validated
   * bootstrap key, in this exact sequence (load-bearing — do not reorder):
   *
   * 0. **Keychain gate.** If {@link SafeStorageService.isAvailable} is
   *    `false`, throws {@link SafeStorageUnavailableError} before making any
   *    AWS call or storing anything — pasted-style credentials are never
   *    persisted in plaintext, so this flow has no fallback.
   * 1. `iam:CreateAccessKey` using an IAM client built from the *bootstrap*
   *    key — mints a new key pair for the same IAM user.
   * 2. Stages the new key pair via
   *    {@link ElectronStoreService.setPastedCredentials} under
   *    {@link GUIDED_PROFILE_NAME}. This alone does **not** make the new key
   *    active — `aws.profile` is untouched at this point.
   * 3. Verifies the new key pair with `sts:GetCallerIdentity`, using an STS
   *    client built from the *new* key. On failure, returns
   *    `{ status: 'verification-failed', error }` without touching
   *    `aws.profile` and without deleting the bootstrap key — retrying is
   *    safe, since step 2 just overwrites the same staging entry.
   * 4. Only once verification succeeds: `ElectronStoreService.set('aws', ...)`
   *    with `profile` set to {@link GUIDED_PROFILE_NAME} — the moment the new
   *    key becomes the active credential source (picked up automatically by
   *    `resolveAwsCredentialSource`, since a stored `profile` that resolves
   *    via `getPastedCredentials` is treated as `kind: 'pasted'`).
   * 5. `iam:DeleteAccessKey` on the *bootstrap* key's `AccessKeyId`, using an
   *    IAM client built from the *new, now-active* key (both keys belong to
   *    the same IAM user, and `HyveonSelfRotate` is attached to the user, not
   *    to a specific key). On failure, returns
   *    `{ status: 'delete-failed', consoleUrl }` — the new key is already
   *    active from step 4 and that is **not** rolled back; the operator must
   *    revoke the still-live bootstrap key manually via `consoleUrl`.
   * 6. On success, returns `{ status: 'complete' }`.
   *
   * Never logs `secretAccessKey` (bootstrap or newly minted) — only
   * non-secret access key IDs and step-progress messages.
   *
   * @param input - The validated bootstrap key pair (from
   *   {@link intakeBootstrapKey}) and the region to build every client
   *   against.
   * @throws {@link SafeStorageUnavailableError} if the OS keychain is
   *   unavailable — nothing is attempted in that case.
   */
  async rotate(input: RotationInput): Promise<RotationResult> {
    if (!this.safeStorage.isAvailable()) {
      throw new SafeStorageUnavailableError();
    }

    // Step 1: mint a new key pair using the bootstrap key.
    const bootstrapClient = this.createIamClient({
      accessKeyId: input.bootstrapAccessKeyId,
      secretAccessKey: input.bootstrapSecretAccessKey,
      region: input.region,
    });
    const createResponse = await bootstrapClient.send(new CreateAccessKeyCommand({}));
    const newKey = createResponse.AccessKey;
    if (!newKey?.AccessKeyId || !newKey.SecretAccessKey) {
      throw new Error('iam:CreateAccessKey did not return a new access key pair for the bootstrap key.');
    }
    logger.info('GuidedIamService.rotate: minted new access key', { accessKeyId: newKey.AccessKeyId });

    // Step 2: stage the new key pair — does not yet activate it.
    this.store.setPastedCredentials(GUIDED_PROFILE_NAME, {
      accessKeyId: newKey.AccessKeyId,
      secretAccessKey: newKey.SecretAccessKey,
      region: input.region,
    });

    const newCreds = { accessKeyId: newKey.AccessKeyId, secretAccessKey: newKey.SecretAccessKey, region: input.region };

    // Step 3: verify the new key pair works before relying on it.
    try {
      const verifyClient = this.createStsClient(newCreds);
      await verifyClient.send(new GetCallerIdentityCommand({}));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.warn('GuidedIamService.rotate: verification failed for newly minted key', {
        accessKeyId: newKey.AccessKeyId,
        error: message,
      });
      return { status: 'verification-failed', error: message };
    }

    // Step 4: verification succeeded — activate the new key.
    const currentAws = this.store.get('aws') ?? {};
    this.store.set('aws', { ...currentAws, profile: GUIDED_PROFILE_NAME, region: input.region });
    logger.info('GuidedIamService.rotate: activated rotated key as the credential source', {
      profile: GUIDED_PROFILE_NAME,
    });

    // Step 5: revoke the bootstrap key using the new, now-active key.
    try {
      const newIamClient = this.createIamClient(newCreds);
      await newIamClient.send(new DeleteAccessKeyCommand({ AccessKeyId: input.bootstrapAccessKeyId }));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.warn('GuidedIamService.rotate: failed to delete bootstrap access key — still active, revoke manually', {
        bootstrapAccessKeyId: input.bootstrapAccessKeyId,
        error: message,
      });
      return { status: 'delete-failed', consoleUrl: this.buildIamSecurityCredentialsConsoleUrl() };
    }

    // Step 6: rotation complete.
    logger.info('GuidedIamService.rotate: rotation complete, bootstrap key revoked', {
      bootstrapAccessKeyId: input.bootstrapAccessKeyId,
    });
    return { status: 'complete' };
  }

  /**
   * Build an `STSClient` directly from an explicit credential/region tuple.
   * Deliberately does **not** read `ElectronStoreService` or use
   * `fromIni`/`resolveAwsCredentialSource` — those resolve the wizard's
   * already-established credential source, which does not exist yet at the
   * point this service runs. Extracted as a protected seam so tests can
   * stub it with `aws-sdk-client-mock`.
   *
   * @param creds - Explicit access key ID, secret access key, and region.
   */
  protected createStsClient(creds: { accessKeyId: string; secretAccessKey: string; region: string }): STSClient {
    return new STSClient({
      region: creds.region,
      credentials: { accessKeyId: creds.accessKeyId, secretAccessKey: creds.secretAccessKey },
    });
  }

  /**
   * Build an `IAMClient` directly from an explicit credential/region tuple.
   * Used only by {@link rotate} — mirrors {@link createStsClient} exactly,
   * see that method's doc comment for why this never reads
   * `ElectronStoreService`/`resolveAwsCredentialSource`. Extracted as a
   * protected seam so tests can stub it with `aws-sdk-client-mock`.
   *
   * @param creds - Explicit access key ID, secret access key, and region.
   */
  protected createIamClient(creds: { accessKeyId: string; secretAccessKey: string; region: string }): IAMClient {
    return new IAMClient({
      region: creds.region,
      credentials: { accessKeyId: creds.accessKeyId, secretAccessKey: creds.secretAccessKey },
    });
  }

  /**
   * Direct link to the IAM console's "My security credentials" page, handed
   * back as `consoleUrl` in {@link rotate}'s `delete-failed` outcome so the
   * operator can revoke the still-live bootstrap key manually. Deliberately
   * account/user-agnostic (no path segment naming a specific IAM user) —
   * cheaper to construct correctly than a user-scoped deep link, and the
   * console redirects to the right place for whichever principal is signed
   * in.
   */
  protected buildIamSecurityCredentialsConsoleUrl(): string {
    return 'https://console.aws.amazon.com/iam/home#/security_credentials';
  }

  /**
   * Returns `true` when `process.versions['electron']` is set, indicating
   * the service is running inside an Electron process. Extracted as a
   * protected method so tests can stub it via `vi.spyOn` without touching
   * `process.versions` directly. Mirrors `SafeStorageService.readIsElectron`
   * exactly.
   */
  protected readIsElectron(): boolean {
    return !!process.versions['electron'];
  }

  /**
   * Calls `shell.openExternal(url)` and awaits its result. Only called after
   * {@link readIsElectron} returns `true`. Extracted as a protected method,
   * lazily requiring `electron` at call-time, so tests can stub it via
   * `vi.spyOn` without importing the native `electron` module and so that
   * importing this file in a plain Node/test context never triggers an
   * unresolved-module error.
   *
   * @param url - The URL to hand to the OS's default browser.
   */
  protected async openExternalUrl(url: string): Promise<void> {
    const _require = createRequire(import.meta.url);
    const { shell } = _require('electron') as { shell: { openExternal(url: string): Promise<void> } };
    await shell.openExternal(url);
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
