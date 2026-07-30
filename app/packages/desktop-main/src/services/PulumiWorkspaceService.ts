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
import { logger } from '../logger.js';
import { PulumiEngineService, type PulumiPhaseCallback } from './PulumiEngineService.js';
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
 * has not confirmed the operator's self-managed S3 state bucket exists yet,
 * or (see {@link BUCKET_MISSING_PATTERN}) as a best-effort backstop when the
 * SDK call itself fails in a way that looks like a missing bucket. The seam
 * never attempts to create the bucket itself — bootstrapping it is
 * `BootstrapService`'s job (Phase 5/6) — it only refuses to run an operation
 * against a backend that isn't there, per the "Backend is not yet
 * bootstrapped" scenario in the `pulumi-engine-runtime` delta spec.
 */
export class PulumiBackendNotBootstrappedError extends Error {
  constructor(
    public readonly stateBucket: string,
    public readonly cause?: unknown,
  ) {
    super(
      `Cannot run this Pulumi operation: the state bucket "${stateBucket}" has not been bootstrapped yet. ` +
        'Complete the bootstrap step (Settings → AWS Resources, or the first-run wizard) before running ' +
        'infrastructure operations.',
    );
    this.name = 'PulumiBackendNotBootstrappedError';
  }
}

/**
 * Best-effort pattern for classifying a `LocalWorkspace.createOrSelectStack`
 * failure as "the S3 bucket doesn't exist" — used only as a backstop (see
 * {@link PulumiWorkspaceService.getOrCreateStack}) for when `backendReady`
 * was wrong (a caller bug, or the bucket was deleted between the caller's
 * check and this call). Unlike {@link PulumiEngineService}'s error-message
 * patterns, this one is **not** verified against a real S3 backend —
 * design.md's spike only exercised a `file://` backend, and the S3-specific
 * gocloud/AWS SDK error surface this DIY backend driver actually produces
 * was explicitly left unverified there. Covers the AWS SDK's own error code
 * (`NoSuchBucket`) and the common English phrasings blob-storage drivers
 * tend to use, on a best-effort basis — a failure that doesn't match this
 * falls through to the raw SDK error rather than being misclassified.
 */
const BUCKET_MISSING_PATTERN = /nosuchbucket|no such bucket|bucket does not exist|specified bucket does not exist/i;

/**
 * True when `err`'s message looks like a missing-S3-bucket failure — see
 * {@link BUCKET_MISSING_PATTERN}'s doc comment for why this is best-effort,
 * not a verified classification.
 */
function looksLikeMissingBucket(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return BUCKET_MISSING_PATTERN.test(message);
}

/**
 * Why {@link PulumiPassphraseUnavailableError} was thrown — distinguishes the
 * failure shapes so callers/logs can tell them apart without parsing the
 * message, while still surfacing through a single typed error class (the
 * `pulumi-engine-runtime` delta spec only names one scenario here — "Missing
 * passphrase for an existing stack fails loudly" — but the underlying
 * "never silently degrade" precedent from `AwsProfileService` applies equally
 * to the other cases below, so they share this class rather than each
 * inventing a separate typed error for a case the spec doesn't separately
 * name).
 */
export type PulumiPassphraseUnavailableReason =
  /** No passphrase has ever been stored for this stack, and the OS keychain is unavailable, so one cannot safely be generated and persisted. */
  | 'new-stack-keychain-unavailable'
  /** A passphrase is stored, but the OS keychain is currently unavailable, so it cannot be decrypted. */
  | 'existing-stack-keychain-unavailable'
  /** A passphrase is stored and the keychain is available, but decrypting it failed (corrupted blob, or encrypted under a different OS user/machine). */
  | 'existing-stack-decrypt-failed'
  /**
   * The caller reports the remote stack already exists (`stackExists: true`),
   * but this install has no locally stored passphrase for it at all — e.g.
   * after a reinstall, a wiped `userData`, or a second machine pointed at the
   * same state bucket. Generating one here would reach the exact catastrophic
   * outcome the "never regenerate" rule exists to prevent, just via a
   * different route than a corrupted/inaccessible local entry: `createOrSelectStack`
   * would *select* (not create) the existing remote stack — `secretsProvider`
   * is a no-op on the select path per design.md — so nothing would object
   * before the freshly-generated, unrelated passphrase silently replaced the
   * local record of a passphrase that can never again decrypt that stack's
   * state.
   */
  | 'existing-stack-no-local-record';

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
    case 'existing-stack-no-local-record':
      return (
        'This stack already exists, but this install has no locally stored passphrase for it (e.g. after ' +
        'a reinstall, a wiped app data directory, or on a second machine). Refusing to generate a ' +
        "replacement — a new passphrase cannot decrypt the existing stack's state. Restore the original " +
        "passphrase from a backup of this app's data, or reset the stack's secrets manually before continuing."
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
   * builds `s3://<stateBucket>` from this — bucket creation belongs to the
   * bootstrap flow (Phase 5/6), not here.
   */
  stateBucket: string;
  /**
   * The AWS region `stateBucket` was created in (`BootstrapService` records
   * this — see its `region`-aware `CreateBucketCommand` handling, which
   * special-cases `us-east-1` since S3 rejects an explicit
   * `LocationConstraint` there). The self-managed backend's underlying
   * gocloud `s3blob` driver does not infer region from the bucket name or
   * from AWS profile config alone, so this is supplied on the backend URL as
   * a `?region=` query parameter (the documented gocloud mechanism) *and* as
   * the `AWS_REGION` engine env var (belt-and-suspenders — see
   * {@link PulumiWorkspaceService.getOrCreateStack}'s inline comment; this
   * SDK version's own spike never exercised the S3-specific backend path, so
   * redundancy costs nothing here and removes one more unverified
   * assumption).
   */
  stateBucketRegion: string;
  /**
   * Whether the caller has already confirmed `stateBucket` exists — e.g. via
   * a `HeadBucket` check, mirroring `BootstrapService`'s own `bucketExists`
   * helper. `false` makes this throw {@link PulumiBackendNotBootstrappedError}
   * immediately, without invoking Pulumi at all. The seam deliberately does
   * not perform this check itself: it has no AWS SDK client of its own, and
   * Phase 5/6 already own bucket existence as part of the bootstrap flow —
   * duplicating that check here would mean either giving this seam an AWS
   * dependency it otherwise has no reason for, or trusting an unverified
   * Pulumi/CLI error string that this SDK version's spike never empirically
   * exercised against a real S3 backend (see design.md's "DIY S3 backend"
   * section). This is the *primary* signal; {@link getOrCreateStack} also
   * applies a best-effort backstop (see {@link BUCKET_MISSING_PATTERN}) for
   * when this flag is wrong or the bucket is deleted between the caller's
   * check and this call, but that backstop is not a substitute for passing
   * an accurate value here.
   */
  backendReady: boolean;
  /**
   * Whether the caller believes {@link PULUMI_STACK_NAME} already exists in
   * the remote backend — independent of whether *this install* has a local
   * passphrase record for it. Required so {@link resolvePassphrase} can
   * distinguish "genuinely new stack, safe to generate a passphrase" from
   * "stack exists remotely, but this install has no local passphrase record
   * for it" (reinstall, wiped `userData`, a second machine against the same
   * bucket) — the latter must throw {@link PulumiPassphraseUnavailableError}
   * with reason `'existing-stack-no-local-record'` rather than silently
   * generating a passphrase that could never decrypt
   * the real stack's state. The seam has no verified, spike-tested way to
   * determine this itself (querying the backend requires the same workspace
   * construction this method exists to perform), so it is the caller's
   * responsibility — e.g. via local run-history bookkeeping, or a
   * `workspace.listStacks()` probe that doesn't require the passphrase.
   */
  stackExists: boolean;
  /**
   * Extension point for Task 4.5 (credential `envVars` propagation — named
   * profile via `AWS_PROFILE`, or decrypted pasted keys). Merged into the
   * engine environment alongside the backend/passphrase vars this seam
   * always sets. Empty/omitted today; 4.5 is the first real caller. 4.5's
   * spec also requires *clearing* inherited credential variables belonging
   * to the unselected source (e.g. `AWS_PROFILE` when pasted keys were
   * chosen), not merely omitting them: `PulumiCommand.run()` (`cmd.js`)
   * spawns via `execa` with the default `extendEnv` behaviour, so the child
   * process inherits the *entire* Electron process environment and this
   * seam's `envVars` only override individual keys on top of that — an
   * ambient `AWS_PROFILE` an operator's shell happens to have set would
   * otherwise leak through untouched. Since a key omitted from this map is
   * therefore not the same as a key cleared, the mechanism for "clear" is
   * supplying an explicit empty string for the variable to unset — the
   * override still applies key-by-key regardless of the value, it just
   * needs to actually be present in this map. This seam does not need its
   * own separate clearing API for that.
   */
  credentialEnvVars?: Record<string, string>;
  /**
   * Task 4.6's phase-reporting extension point — forwarded verbatim to
   * {@link PulumiEngineService.resolve}, so `('engine', 'start' | 'end')` is
   * reported around this call's own engine-resolution step. See that
   * method's TSDoc for exactly what 4.6 could and could not wire up yet —
   * `'plugins'`/`'operation'` are never reported by anything in this file,
   * since neither has any observable event in the code Phase 4 builds
   * (plugin download and the operation itself both belong to Phase 7's
   * `PulumiService`).
   */
  onPhase?: PulumiPhaseCallback;
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
 *  - The self-managed `s3://<bucket>?region=<region>` backend URL (plus
 *    `AWS_REGION`) and the `passphrase` secrets provider — no Pulumi Cloud
 *    account or access token, ever.
 *  - The bare {@link PULUMI_STACK_NAME} — never a qualified
 *    `organization/<project>/<stack>` name.
 *  - Passphrase generation, storage (via {@link ElectronStoreService}'s
 *    accessor pair — this service never calls {@link SafeStorageService}'s
 *    `encrypt`/`decrypt` directly), and "fail loudly, never regenerate for
 *    an existing stack" semantics — covering both a locally-stored-but-
 *    unreadable passphrase and, via the caller-supplied `stackExists` flag,
 *    an existing remote stack with no local record at all (see
 *    {@link resolvePassphrase}).
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
   * directories exist, resolves (generating if this is genuinely the first
   * time, per `input.stackExists`) the secrets passphrase, and calls
   * `LocalWorkspace.createOrSelectStack` with the bare
   * {@link PULUMI_STACK_NAME}. Throws {@link PulumiBackendNotBootstrappedError}
   * if `input.backendReady` is `false` (checked before anything else), or
   * {@link PulumiPassphraseUnavailableError} if a usable passphrase cannot be
   * obtained — both happen before any Pulumi invocation. The SDK call itself
   * is also wrapped: a failure that looks like a missing bucket (see
   * {@link BUCKET_MISSING_PATTERN}) is re-classified into
   * {@link PulumiBackendNotBootstrappedError} as a backstop for when
   * `backendReady` was wrong, rather than surfacing raw Pulumi/gocloud
   * stderr to the operator; every other failure propagates unchanged.
   */
  async getOrCreateStack(input: PulumiWorkspaceInput): Promise<Stack> {
    if (!input.backendReady) {
      throw new PulumiBackendNotBootstrappedError(input.stateBucket);
    }

    // Passphrase resolution happens before the engine is even resolved: per
    // design.md, `stack init` under `--non-interactive` is a hard exit-1
    // without `PULUMI_CONFIG_PASSPHRASE` already set, so there is no
    // reasonable order in which the passphrase can be an afterthought.
    const passphrase = this.resolvePassphrase(input.stackExists);

    const pulumiCommand = await this.engine.resolve(input.onPhase);
    const pulumiHome = this.ensureDir(this.getPulumiHomeDir());
    const workDir = this.ensureDir(this.getWorkDir());
    logger.debug('PulumiWorkspaceService: resolved workspace paths', { pulumiHome, workDir });

    // The self-managed backend's gocloud `s3blob` driver needs the bucket's
    // region from somewhere other than the bucket name — supplied both ways
    // (query param and env var) since the S3-specific backend path is
    // unverified against a real bucket (see PulumiWorkspaceInput.stateBucketRegion's
    // doc comment for why redundancy was chosen over picking one).
    const backendUrl = `s3://${input.stateBucket}?region=${encodeURIComponent(input.stateBucketRegion)}`;

    const envVars: LocalWorkspaceOptions['envVars'] = {
      // Extension point for Task 4.5 first — see PulumiWorkspaceInput's
      // `credentialEnvVars` doc comment — so a future credential source can
      // never accidentally clobber the backend/passphrase vars this seam is
      // responsible for below.
      ...input.credentialEnvVars,
      PULUMI_BACKEND_URL: backendUrl,
      PULUMI_CONFIG_PASSPHRASE: passphrase,
      PULUMI_SKIP_UPDATE_CHECK: 'true',
      AWS_REGION: input.stateBucketRegion,
    };

    const opts: LocalWorkspaceOptions = {
      pulumiCommand,
      pulumiHome,
      workDir,
      secretsProvider: 'passphrase',
      envVars,
    };

    try {
      return await LocalWorkspace.createOrSelectStack(
        { stackName: PULUMI_STACK_NAME, projectName: PULUMI_PROJECT_NAME, program: input.program },
        opts,
      );
    } catch (err) {
      if (looksLikeMissingBucket(err)) {
        throw new PulumiBackendNotBootstrappedError(input.stateBucket, err);
      }
      throw err;
    }
  }

  /**
   * Resolves the secrets passphrase for {@link PULUMI_STACK_NAME}: reuses the
   * stored one if present, generating and persisting a new one only when
   * none has ever been stored **and** the caller confirms
   * (`stackExists: false`) this is a genuinely new stack. Never generates a
   * replacement once a stored entry exists, even if that entry can't
   * currently be read, and never generates one for a stack the caller says
   * already exists
   * remotely even if nothing is stored locally — see
   * {@link PulumiPassphraseUnavailableError}'s doc comment and the
   * `'existing-stack-no-local-record'` reason.
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
   *
   * @param stackExists - `input.stackExists` from {@link getOrCreateStack} —
   *   see {@link PulumiWorkspaceInput.stackExists}'s doc comment for why this
   *   must come from the caller rather than being inferred from local state
   *   alone.
   */
  private resolvePassphrase(stackExists: boolean): string {
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

    // No passphrase is stored locally. If the caller says the stack already
    // exists remotely, generating one here would reach the exact outcome
    // the "never regenerate" rule exists to prevent, just via a route that
    // doesn't involve a corrupted local entry — see
    // PulumiPassphraseUnavailableReason's 'existing-stack-no-local-record'
    // doc comment for the full sequence this refuses to let happen.
    if (stackExists) {
      throw new PulumiPassphraseUnavailableError('existing-stack-no-local-record');
    }

    // Genuinely new stack. Mirrors AwsProfileService.savePastedCredentials's
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
   * Not a seeded program directory (the program is inline, per design.md) —
   * but it is **not** disposable scratch space either: `Pulumi.<stack>.yaml`
   * carries the stack's `encryptionsalt` (derived from the secrets
   * passphrase) and other per-stack settings the CLI expects to find again
   * on the next operation, so this directory holds durable state, not just
   * bookkeeping that can be safely wiped between runs. Namespaced by stack
   * name so a future second stack (if one is ever added) gets its own
   * directory rather than colliding, though today there is exactly one.
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
