import { randomBytes } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Injectable } from '@nestjs/common';
// The explicit `/index.js` is required, not cosmetic — see `PulumiEngineService.ts`'s
// comment on this same import: the main bundle is ESM, `@pulumi/pulumi` is
// externalized, and `@pulumi/pulumi` is CommonJS with no `exports` map, so the
// bare directory specifier `@pulumi/pulumi/automation` fails with
// `ERR_UNSUPPORTED_DIR_IMPORT` in the packaged app.
import { LocalWorkspace } from '@pulumi/pulumi/automation/index.js';
import type { LocalWorkspaceOptions, PulumiFn, Stack } from '@pulumi/pulumi/automation/index.js';
import { PulumiEngineService } from './PulumiEngineService.js';
import { SafeStorageService } from './SafeStorageService.js';
import { ElectronStoreService } from './ElectronStoreService.js';

/**
 * Bare Pulumi project name — see {@link PULUMI_STACK_NAME}'s doc comment for
 * why this is pinned in one place rather than passed around as a string.
 */
export const PULUMI_PROJECT_NAME = 'hyveon';

/**
 * Bare Pulumi stack name. The app manages exactly one deployment target per
 * install (mirroring the single `terraform.tfstate` the Terraform composer
 * reads/writes today — there is no per-environment or per-game Pulumi stack),
 * so one fixed name is enough.
 *
 * Pinned as a single constant per design.md's "Stack naming is a trap": a
 * non-legacy DIY backend accepts either a bare stack name or
 * `organization/<project>/<stack>` where `org` must be the *literal string*
 * `organization` — getting that wrong silently creates the wrong stack rather
 * than erroring. Every call site in this file uses this bare constant; never
 * construct a qualified stack name anywhere else.
 */
export const PULUMI_STACK_NAME = 'production';

/** Number of cryptographically-random bytes used to generate a new secrets passphrase — see {@link PulumiWorkspaceService.generatePassphrase}'s doc comment for why 32 bytes was chosen. */
const PASSPHRASE_ENTROPY_BYTES = 32;

/**
 * Thrown by {@link PulumiWorkspaceService.getOrCreateStack} when the caller
 * has not confirmed the operator's self-managed S3 state bucket exists yet.
 * The seam never attempts to create the bucket itself — bootstrapping it is
 * `BootstrapService`'s job (Phase 5/6) — it only refuses to run an operation
 * against a backend that isn't there, per the "Backend is not yet
 * bootstrapped" scenario in the `pulumi-engine-runtime` delta spec.
 */
export class PulumiBackendNotBootstrappedError extends Error {
  constructor(public readonly stateBucket: string) {
    super(
      `Cannot run this Pulumi operation: the state bucket "${stateBucket}" has not been bootstrapped yet. ` +
        'Complete the bootstrap step (Settings → AWS Resources, or the first-run wizard) before running ' +
        'infrastructure operations.',
    );
    this.name = 'PulumiBackendNotBootstrappedError';
  }
}

/**
 * Why {@link PulumiPassphraseUnavailableError} was thrown — distinguishes the
 * three failure shapes so callers/logs can tell them apart without parsing
 * the message, while still surfacing through a single typed error class (the
 * `pulumi-engine-runtime` delta spec only names one scenario here — "Missing
 * passphrase for an existing stack fails loudly" — but the underlying
 * "never silently degrade" precedent from `AwsProfileService` applies equally
 * to the new-stack keychain-unavailable case, so that shares this class
 * rather than inventing a fourth typed error for a case the spec doesn't
 * separately name).
 */
export type PulumiPassphraseUnavailableReason =
  /** No passphrase has ever been stored for this stack, and the OS keychain is unavailable, so one cannot safely be generated and persisted. */
  | 'new-stack-keychain-unavailable'
  /** A passphrase is stored, but the OS keychain is currently unavailable, so it cannot be decrypted. */
  | 'existing-stack-keychain-unavailable'
  /** A passphrase is stored and the keychain is available, but decrypting it failed (corrupted blob, or encrypted under a different OS user/machine). */
  | 'existing-stack-decrypt-failed';

/**
 * Thrown by {@link PulumiWorkspaceService.getOrCreateStack} when a usable
 * secrets passphrase cannot be obtained. Mirrors `AwsProfileService`'s
 * `SafeStorageUnavailableError` "fail loudly, never degrade" precedent:
 * a stack that already exists is encrypted under its *original* passphrase,
 * so generating a replacement here — rather than throwing — would silently
 * produce a passphrase that can never decrypt that stack's existing secure
 * config/state again. Never thrown after a write; every throw site in
 * {@link PulumiWorkspaceService.resolvePassphrase} happens strictly before
 * any store mutation.
 */
export class PulumiPassphraseUnavailableError extends Error {
  constructor(
    public readonly reason: PulumiPassphraseUnavailableReason,
    public readonly cause?: unknown,
  ) {
    super(describePassphraseUnavailableReason(reason));
    this.name = 'PulumiPassphraseUnavailableError';
  }
}

function describePassphraseUnavailableReason(reason: PulumiPassphraseUnavailableReason): string {
  switch (reason) {
    case 'new-stack-keychain-unavailable':
      return (
        'Cannot create the Pulumi stack: a secrets passphrase must be generated and stored before the ' +
        'first stack creation, but the OS keychain (safeStorage) is unavailable. Pulumi has no interactive ' +
        'fallback in non-interactive mode — unlock the OS keychain and try again.'
      );
    case 'existing-stack-keychain-unavailable':
      return (
        "This stack's secrets passphrase is stored but cannot be read right now because the OS keychain " +
        '(safeStorage) is unavailable. Refusing to generate a replacement — a new passphrase cannot decrypt ' +
        'this stack\'s existing state. Unlock the OS keychain and try again.'
      );
    case 'existing-stack-decrypt-failed':
      return (
        "This stack's secrets passphrase is stored but could not be decrypted (it may have been encrypted " +
        "on a different machine or OS user account). Refusing to generate a replacement — a new passphrase " +
        "cannot decrypt this stack's existing state."
      );
  }
}

/**
 * Typed input to {@link PulumiWorkspaceService.getOrCreateStack}.
 */
export interface PulumiWorkspaceInput {
  /** The inline (in-process) Pulumi program to run for preview/update operations. */
  program: PulumiFn;
  /**
   * Name of the operator's own S3 bucket the self-managed backend reads and
   * writes state into (provisioned by `BootstrapService`). The seam only
   * builds `s3://<stateBucket>` from this — bucket creation/region selection
   * belongs to the bootstrap flow (Phase 5/6), not here.
   */
  stateBucket: string;
  /**
   * Whether the caller has already confirmed `stateBucket` exists — e.g. via
   * a `HeadBucket` check, mirroring `BootstrapService`'s own `bucketExists`
   * helper. `false` (or omitted) makes this throw
   * {@link PulumiBackendNotBootstrappedError} immediately, without invoking
   * Pulumi at all. The seam deliberately does not perform this check itself:
   * it has no AWS SDK client of its own, and Phase 5/6 already own bucket
   * existence as part of the bootstrap flow — duplicating that check here
   * would mean either giving this seam an AWS dependency it otherwise has no
   * reason for, or trusting an unverified Pulumi/CLI error string that this
   * SDK version's spike never empirically exercised against a real S3
   * backend (see design.md's "DIY S3 backend" section).
   */
  backendReady: boolean;
  /**
   * Extension point for Task 4.5 (credential `envVars` propagation — named
   * profile via `AWS_PROFILE`, or decrypted pasted keys). Merged into the
   * engine environment alongside the backend/passphrase vars this seam
   * always sets. Empty/omitted today; 4.5 is the first real caller.
   */
  credentialEnvVars?: Record<string, string>;
}

/**
 * Constructs the Automation API workspace/stack seam every infrastructure
 * operation goes through, per the `pulumi-engine-runtime` delta spec's
 * "Automation API workspace seam" requirement. Builds on
 * {@link PulumiEngineService}'s resolved `PulumiCommand` (never duplicates
 * engine resolution) and adds:
 *
 *  - A stable, reused `pulumiHome` and per-stack `workDir` under Electron
 *    `userData` — never a tmpdir, never created fresh per operation (see
 *    {@link getWorkspaceRoot}).
 *  - The self-managed `s3://` backend URL and the `passphrase` secrets
 *    provider — no Pulumi Cloud account or access token, ever.
 *  - The bare {@link PULUMI_STACK_NAME} — never a qualified
 *    `organization/<project>/<stack>` name.
 *  - Passphrase generation, storage (via {@link ElectronStoreService}'s
 *    accessor pair — this service never calls {@link SafeStorageService}'s
 *    `encrypt`/`decrypt` directly), and "fail loudly, never regenerate for
 *    an existing stack" semantics (see {@link resolvePassphrase}).
 *
 * Deliberately does **not** implement `preview`/`up`/`destroy` — those are
 * Phase 7's `PulumiService`, which will call {@link getOrCreateStack} and
 * then drive the returned `Stack`. Cancellation (`AbortSignal` plus a bounded
 * forceful-termination escalation, Task 4.7) threads through those
 * *operation* calls on the returned `Stack`, not through workspace
 * construction — this seam has nothing to cancel, since it never awaits a
 * long-running engine invocation itself.
 */
@Injectable()
export class PulumiWorkspaceService {
  constructor(
    private readonly engine: PulumiEngineService,
    private readonly safeStorage: SafeStorageService,
    private readonly store: ElectronStoreService,
  ) {}

  /**
   * Resolves the engine, ensures the stable `pulumiHome`/`workDir`
   * directories exist, resolves (generating if this is the first time) the
   * secrets passphrase, and calls `LocalWorkspace.createOrSelectStack` with
   * the bare {@link PULUMI_STACK_NAME}. Throws
   * {@link PulumiBackendNotBootstrappedError} if `input.backendReady` is
   * `false`, or {@link PulumiPassphraseUnavailableError} if a usable
   * passphrase cannot be obtained — in both cases before any Pulumi
   * invocation happens.
   */
  async getOrCreateStack(input: PulumiWorkspaceInput): Promise<Stack> {
    if (!input.backendReady) {
      throw new PulumiBackendNotBootstrappedError(input.stateBucket);
    }

    // Passphrase resolution happens before the engine is even resolved: per
    // design.md, `stack init` under `--non-interactive` is a hard exit-1
    // without `PULUMI_CONFIG_PASSPHRASE` already set, so there is no
    // reasonable order in which the passphrase can be an afterthought.
    const passphrase = this.resolvePassphrase();

    const pulumiCommand = await this.engine.resolve();
    const pulumiHome = this.ensureDir(this.getPulumiHomeDir());
    const workDir = this.ensureDir(this.getWorkDir());

    const envVars: LocalWorkspaceOptions['envVars'] = {
      // Extension point for Task 4.5 first — see PulumiWorkspaceInput's
      // `credentialEnvVars` doc comment — so a future credential source can
      // never accidentally clobber the backend/passphrase vars this seam is
      // responsible for below.
      ...input.credentialEnvVars,
      PULUMI_BACKEND_URL: `s3://${input.stateBucket}`,
      PULUMI_CONFIG_PASSPHRASE: passphrase,
      PULUMI_SKIP_UPDATE_CHECK: 'true',
    };

    const opts: LocalWorkspaceOptions = {
      pulumiCommand,
      pulumiHome,
      workDir,
      secretsProvider: 'passphrase',
      envVars,
    };

    return LocalWorkspace.createOrSelectStack(
      { stackName: PULUMI_STACK_NAME, projectName: PULUMI_PROJECT_NAME, program: input.program },
      opts,
    );
  }

  /**
   * Resolves the secrets passphrase for {@link PULUMI_STACK_NAME}: reuses the
   * stored one if present, generating and persisting a new one only when
   * none has ever been stored (a genuinely new stack). Never generates a
   * replacement once a stored entry exists, even if that entry can't
   * currently be read — see {@link PulumiPassphraseUnavailableError}'s doc
   * comment.
   *
   * Presence is checked via the raw {@link ElectronStoreService.get} (no
   * decryption attempted) rather than by calling
   * {@link ElectronStoreService.getPulumiPassphrase} and checking for
   * `undefined`, because {@link SafeStorageService.decrypt} does not throw
   * when the keychain is merely *unavailable* at read time — it silently
   * returns the raw ciphertext blob unchanged (see that method's own remarks
   * on write/read-time availability mismatches). Treating that garbage
   * string as a real passphrase would hand Pulumi a value that cannot
   * decrypt the stack's actual state, which is exactly the failure this
   * method exists to prevent. So the keychain's current availability is
   * checked explicitly before ever attempting the decrypt.
   */
  private resolvePassphrase(): string {
    const hasStoredPassphrase = this.store.get('pulumi')?.passphrase !== undefined;

    if (hasStoredPassphrase) {
      if (!this.safeStorage.isAvailable()) {
        throw new PulumiPassphraseUnavailableError('existing-stack-keychain-unavailable');
      }
      let passphrase: string | undefined;
      try {
        passphrase = this.store.getPulumiPassphrase();
      } catch (err) {
        throw new PulumiPassphraseUnavailableError('existing-stack-decrypt-failed', err);
      }
      if (passphrase === undefined) {
        // Defensive: presence was just confirmed above. Treat as
        // unavailable rather than falling through to the generate-a-new-one
        // path below, which exists only for the genuinely-new-stack case.
        throw new PulumiPassphraseUnavailableError(
          'existing-stack-decrypt-failed',
          new Error('stored passphrase entry disappeared between presence check and read'),
        );
      }
      return passphrase;
    }

    // No passphrase has ever been stored — this is the first time this
    // stack is being created. Mirrors AwsProfileService.savePastedCredentials's
    // "fail loudly before any write" precedent: check availability
    // explicitly rather than relying on ElectronStoreService.setPulumiPassphrase's
    // own transparent degrade-to-plaintext (fine for AWS keys' test/CI
    // convenience, wrong for a secret that must actually be recoverable).
    if (!this.safeStorage.isAvailable()) {
      throw new PulumiPassphraseUnavailableError('new-stack-keychain-unavailable');
    }
    const generated = this.generatePassphrase();
    this.store.setPulumiPassphrase(generated);
    return generated;
  }

  /**
   * Generates a fresh secrets passphrase from {@link PASSPHRASE_ENTROPY_BYTES}
   * (32) cryptographically-random bytes, base64-encoded. Pulumi's own
   * `passphrase` secrets provider imposes no minimum length or complexity —
   * it is fed through a KDF (scrypt) to derive an AES key, so the only
   * property that matters is that the input itself is unpredictable. 32
   * bytes is 256 bits of entropy from `crypto.randomBytes` (the platform
   * CSPRNG) — far in excess of any interactive-passphrase strength standard,
   * and it never needs to be operator-memorable since it is generated,
   * encrypted, and stored by the app, never typed or displayed.
   */
  private generatePassphrase(): string {
    return randomBytes(PASSPHRASE_ENTROPY_BYTES).toString('base64');
  }

  /**
   * Creates `dir` (and any missing parents) if it doesn't already exist and
   * returns it unchanged. `mkdirSync` with `recursive: true` is idempotent —
   * safe to call on every {@link getOrCreateStack} invocation without
   * growing anything or needing its own "already exists" tracking.
   */
  private ensureDir(dir: string): string {
    mkdirSync(dir, { recursive: true });
    return dir;
  }

  /**
   * The stable, app-owned directory `PULUMI_HOME` points at for every
   * operation — distinct from {@link PulumiEngineService}'s engine-install
   * cache root (`<userData>/pulumi/versions/<pin>`), per the spec's
   * requirement that `pulumiHome` be a separate location for
   * plugins/credentials/workspace metadata. Reused across every operation —
   * never recreated, never a tmpdir.
   */
  private getPulumiHomeDir(): string {
    return join(this.getWorkspaceRoot(), 'home');
  }

  /**
   * The stable, app-owned directory `LocalWorkspaceOptions.workDir` points
   * at for {@link PULUMI_STACK_NAME} — where the Automation API's
   * `Pulumi.yaml`/`Pulumi.<stack>.yaml` bookkeeping lives for this stack.
   * Not a seeded program directory (the program is inline, per design.md);
   * it only needs to exist and be writable. Namespaced by stack name so a
   * future second stack (if one is ever added) gets its own directory rather
   * than colliding, though today there is exactly one.
   *
   * Reused across every operation — this is the literal fix for the tmpdir
   * leak `LocalWorkspaceOptions` defaults to when `workDir` is omitted (see
   * that field's own doc comment: "unless a `workDir` option is specified,
   * the working directory will default to a new temporary directory
   * provided by the OS").
   */
  private getWorkDir(): string {
    return join(this.getWorkspaceRoot(), 'workspace', PULUMI_STACK_NAME);
  }

  /**
   * Resolves the root directory `pulumiHome`/`workDir` are namespaced under.
   * Mirrors `PulumiEngineService.getEngineCacheRoot()`'s resolution order and
   * rationale (env override → Electron `userData` → OS tmpdir fallback for
   * plain-Node/test contexts), but at a distinct path
   * (`<userData>/pulumi-workspace`, not `<userData>/pulumi`) so this seam's
   * directories can never collide with the engine's own install cache.
   *
   * `HYVEON_PULUMI_WORKSPACE_DIR` (rather than a bare `PULUMI_*` name) so it
   * can't collide with a variable Pulumi's own CLI or SDK might introduce.
   */
  private getWorkspaceRoot(): string {
    const envOverride = process.env['HYVEON_PULUMI_WORKSPACE_DIR'];
    if (envOverride) return resolve(envOverride);

    const userData = this.resolveUserDataPath();
    if (userData) return join(userData, 'pulumi-workspace');

    return join(tmpdir(), 'hyveon-pulumi-workspace');
  }

  /**
   * Returns the Electron `userData` directory when running inside an
   * Electron process, or `null` otherwise. Duplicates
   * `PulumiEngineService.resolveUserDataPath()`'s exact seam (itself a
   * duplicate of `ConfigService.readUserDataPath()`) rather than injecting
   * `ConfigService` — see that method's doc comment for why: the accessor is
   * `protected` there, and this service already has three constructor
   * dependencies of its own with no other reason to add a fourth. `protected`
   * (not `private`) so a test subclass can override it, mirroring
   * `PulumiEngineService.test.ts`'s `TestablePulumiEngineService`.
   */
  protected resolveUserDataPath(): string | null {
    if (!process.versions['electron']) return null;
    try {
      const _require = createRequire(import.meta.url);
      const electron = _require('electron') as { app: { getPath(name: string): string } };
      return electron.app.getPath('userData');
    } catch {
      return null;
    }
  }
}
