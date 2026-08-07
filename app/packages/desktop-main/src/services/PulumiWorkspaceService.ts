import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Injectable } from '@nestjs/common';
// The explicit `/index.js` is required, not cosmetic — see `PulumiEngineService.ts`'s
// comment on this same import: the main bundle is ESM, `@pulumi/pulumi` is
// externalized, and `@pulumi/pulumi` is CommonJS with no `exports` map, so the
// bare directory specifier `@pulumi/pulumi/automation` fails with
// `ERR_UNSUPPORTED_DIR_IMPORT` in the packaged app.
// `Stack` is imported as a VALUE (not type-only) since `resolveNewPassphrase`
// (see its doc comment) calls `Stack.createOrSelect` directly
// rather than going through `LocalWorkspace.createOrSelectStack`'s convenience
// wrapper, so it can query `listStacks()` on the same workspace first.
import { LocalWorkspace, Stack } from '@pulumi/pulumi/automation/index.js';
import type { LocalWorkspaceOptions, ProjectSettings, PulumiFn } from '@pulumi/pulumi/automation/index.js';
import { logger } from '../logger.js';
import { PulumiEngineService, type PulumiPhaseCallback } from './PulumiEngineService.js';
import { SafeStorageService } from './SafeStorageService.js';
import { ElectronStoreService } from './ElectronStoreService.js';
import { resolveCredentialEnvVars } from './PulumiCredentialResolver.js';

/**
 * Bare Pulumi project name — see {@link PULUMI_STACK_NAME}'s doc comment for
 * why this is pinned in one place rather than passed around as a string.
 */
export const PULUMI_PROJECT_NAME = 'hyveon';

/**
 * Bare Pulumi stack name. The app manages exactly one deployment target per
 * install — there is no per-environment or per-game Pulumi stack — so one
 * fixed name is enough.
 *
 * Pinned as a single constant because stack naming is a trap: a
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
 * `BootstrapService`'s job — it only refuses to run an operation
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
 * the original spike only exercised a `file://` backend, so the S3-specific
 * gocloud/AWS SDK error surface this DIY backend driver actually produces
 * has not been directly verified. Covers the AWS SDK's own error code
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
   * A `workspace.listStacks()` probe (see
   * {@link PulumiWorkspaceService.resolveNewPassphrase}'s doc comment) found
   * {@link PULUMI_STACK_NAME} already present in the REAL backend, but this
   * install has no locally stored passphrase for it at all — e.g. after a
   * reinstall, a wiped `userData`, or a second machine pointed at the same
   * state bucket. Generating one here would reach the exact catastrophic
   * outcome the "never regenerate" rule exists to prevent, just via a
   * different route than a corrupted/inaccessible local entry: `createOrSelectStack`
   * would *select* (not create) the existing remote stack — `secretsProvider`
   * is a no-op on the select path — so nothing would object
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
 * {@link PulumiWorkspaceService.resolveStoredPassphrase}/
 * {@link PulumiWorkspaceService.resolveNewPassphrase} happens strictly before
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
   * bootstrap flow, not here.
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
   * `BootstrapService` already owns bucket existence as part of the bootstrap
   * flow — duplicating that check here would mean either giving this seam an
   * AWS dependency it otherwise has no reason for, or trusting an unverified
   * Pulumi/CLI error string this SDK's DIY S3 backend path has never been
   * empirically exercised against. This is the *primary* signal; {@link getOrCreateStack} also
   * applies a best-effort backstop (see {@link BUCKET_MISSING_PATTERN}) for
   * when this flag is wrong or the bucket is deleted between the caller's
   * check and this call, but that backstop is not a substitute for passing
   * an accurate value here.
   */
  backendReady: boolean;
  /**
   * Override for the credential `envVars` this seam merges into the engine
   * environment (named profile via `AWS_PROFILE`, or decrypted pasted keys),
   * normally left **unset**.
   *
   * When omitted (the expected case for every real caller, including
   * `PulumiService`), {@link getOrCreateStack} resolves this itself via
   * {@link resolveCredentialEnvVars} against the injected
   * {@link ElectronStoreService} — every operation gets a sanitized
   * credential environment unconditionally, per the `pulumi-engine-runtime`
   * delta spec's "Every operation SHALL start from a sanitized environment"
   * (spec.md:102). This exists as an explicit field at all only so tests
   * (and this file's own "credentialEnvVars extension point" describe block)
   * can inject arbitrary env values directly without going through the
   * store — a caller that supplies it is opting out of the automatic
   * resolution and is responsible for its correctness (including the
   * exclusivity clear below), which is why real callers should leave it unset
   * rather than resolve credentials themselves and pass them through here.
   *
   * The spec also requires *clearing* inherited credential variables
   * belonging to the unselected source (e.g. `AWS_PROFILE` when pasted keys
   * were chosen), not merely omitting them: `PulumiCommand.run()` (`cmd.js`)
   * spawns via `execa` with the default `extendEnv` behaviour, so the child
   * process inherits the *entire* Electron process environment and this
   * seam's `envVars` only override individual keys on top of that — an
   * ambient `AWS_PROFILE` an operator's shell happens to have set would
   * otherwise leak through untouched. Since a key omitted from this map is
   * therefore not the same as a key cleared, the mechanism for "clear" is
   * supplying an explicit empty string for the variable to unset — the
   * override still applies key-by-key regardless of the value, it just
   * needs to actually be present in this map. This seam does not need its
   * own separate clearing API for that. {@link resolveCredentialEnvVars}
   * already implements this correctly for both paths.
   */
  credentialEnvVars?: Record<string, string>;
  /**
   * Phase-reporting extension point — forwarded verbatim to
   * {@link PulumiEngineService.resolve}, so `('engine', 'start' | 'end')` is
   * reported around this call's own engine-resolution step.
   * `'plugins'`/`'operation'` are never reported by anything in this file —
   * plugin download and the operation itself are both `PulumiService`'s
   * responsibility to report, not this workspace seam's.
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
 *    unreadable passphrase and an existing remote stack with no local
 *    record at all, the latter detected via a genuine `workspace.listStacks()`
 *    probe against the real backend rather than trusted from the caller (see
 *    {@link resolveStoredPassphrase}/{@link resolveNewPassphrase}).
 *
 * Deliberately does **not** implement `preview`/`up`/`destroy` — those are
 * `PulumiService`'s, which calls {@link getOrCreateStack} and then drives the
 * returned `Stack`. Cancellation (`AbortSignal` plus a bounded
 * forceful-termination escalation) threads through those *operation* calls on
 * the returned `Stack`, not through workspace construction — this seam has
 * nothing to cancel, since it never awaits a long-running engine invocation
 * itself.
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
   * directories exist, constructs the Automation API workspace, resolves
   * (generating if this is genuinely the first time — see
   * {@link resolveNewPassphrase}) the secrets passphrase, and selects or
   * creates {@link PULUMI_STACK_NAME} on it. Throws
   * {@link PulumiBackendNotBootstrappedError} if `input.backendReady` is
   * `false` (checked before anything else), or
   * {@link PulumiPassphraseUnavailableError} if a usable passphrase cannot be
   * obtained. Also throws `PulumiCredentialsNotConfiguredError` (from
   * `PulumiCredentialResolver.ts`, via {@link resolveCredentialEnvVars}) when
   * `input.credentialEnvVars` is omitted and the store has no credential
   * source selected at all — see
   * {@link PulumiWorkspaceInput.credentialEnvVars}'s doc comment for why
   * resolution happens here unconditionally rather than trusting every
   * future caller to remember to pass it.
   *
   * ## Call order
   *
   * `stack init` under `--non-interactive` is a hard exit-1 without
   * `PULUMI_CONFIG_PASSPHRASE` already set, so the passphrase question is
   * resolved before the engine wherever it can be answered locally. If a
   * passphrase is already stored, {@link resolveStoredPassphrase} resolves it
   * immediately, ahead of credentials/engine/backend — the common case for
   * every operation after this install's stack already exists. If nothing is
   * stored, `safeStorage.isAvailable()` is still checked immediately (a
   * purely local precondition), and only the ONE remaining question — does
   * {@link PULUMI_STACK_NAME} already exist in the REAL backend — is deferred
   * to {@link resolveNewPassphrase}, since that genuinely needs a constructed
   * `LocalWorkspace` (built after the engine resolves, since a
   * `pulumiCommand` is required) to query `listStacks()` against it. This
   * adds one extra read-only `pulumi stack ls` round-trip, but ONLY on the
   * "no local passphrase, keychain available" path (first-ever stack
   * creation, or a reinstall/second-machine pointed at the same state
   * bucket) — the "this install already created the stack" path never
   * reaches {@link resolveNewPassphrase} at all, and reuses the SAME
   * workspace instance for `Stack.createOrSelect`.
   *
   * The SDK calls this method makes (`LocalWorkspace.create`,
   * `workspace.listStacks()`, `Stack.createOrSelect`) are wrapped in a single
   * try/catch: a failure that looks like a missing bucket (see
   * {@link BUCKET_MISSING_PATTERN}) is re-classified into
   * {@link PulumiBackendNotBootstrappedError} as a backstop for when
   * `backendReady` was wrong, rather than surfacing raw Pulumi/gocloud
   * stderr to the operator; every other failure (including
   * {@link PulumiPassphraseUnavailableError}, whose message never matches
   * that pattern) propagates unchanged.
   */
  async getOrCreateStack(input: PulumiWorkspaceInput): Promise<Stack> {
    if (!input.backendReady) {
      throw new PulumiBackendNotBootstrappedError(input.stateBucket);
    }

    // Fast path: a passphrase is already stored locally — resolve (or throw
    // trying to) BEFORE touching credentials, the engine, or the backend at
    // all, exactly mirroring this method's pre-Finding-1 ordering/behavior
    // for what is by far the most common call (every operation after this
    // install's stack already exists).
    const hasStoredPassphrase = this.store.get('pulumi')?.passphrase !== undefined;
    let passphrase: string | undefined;
    if (hasStoredPassphrase) {
      passphrase = this.resolveStoredPassphrase();
    } else if (!this.safeStorage.isAvailable()) {
      // Also checked here, before credentials/engine/backend, rather than
      // deferred into `resolveNewPassphrase` below: unlike "does the remote
      // stack already exist" (which genuinely needs a real workspace to ask
      // the backend), "is the keychain available at all" is a purely local
      // precondition this seam can check for free — failing fast on it
      // avoids an unnecessary `listStacks()` round-trip for an operation that
      // was never going to be able to generate/store a passphrase anyway.
      throw new PulumiPassphraseUnavailableError('new-stack-keychain-unavailable');
    }

    // Credential resolution is unconditional: `input.credentialEnvVars` is
    // normally unset, so this seam resolves the wizard's selected AWS
    // credential source itself rather than trusting the caller to remember
    // to pass it — see PulumiWorkspaceInput.credentialEnvVars's doc comment.
    // Throws PulumiCredentialsNotConfiguredError if the store has no
    // credential source selected at all, rather than silently proceeding
    // with no credential vars (which would let the engine fall back to its
    // own default AWS credential chain, exactly what spec.md:100 forbids).
    // Independent of passphrase resolution, so kept ahead of engine
    // resolution exactly as before — cheap, and never touches Pulumi itself.
    const credentialEnvVars = input.credentialEnvVars ?? resolveCredentialEnvVars(this.store);

    const engineStartedAt = Date.now();
    const pulumiCommand = await this.engine.resolve(input.onPhase);
    logger.debug('PulumiWorkspaceService: engine resolved', { elapsedMs: Date.now() - engineStartedAt });
    const pulumiHome = this.ensureDir(this.getPulumiHomeDir());
    const workDir = this.ensureDir(this.getWorkDir());
    logger.debug('PulumiWorkspaceService: resolved workspace paths', { pulumiHome, workDir });

    // The self-managed backend's gocloud `s3blob` driver needs the bucket's
    // region from somewhere other than the bucket name — supplied both ways
    // (query param and env var) since the S3-specific backend path is
    // unverified against a real bucket (see PulumiWorkspaceInput.stateBucketRegion's
    // doc comment for why redundancy was chosen over picking one).
    const backendUrl = `s3://${input.stateBucket}?region=${encodeURIComponent(input.stateBucketRegion)}`;

    // Deliberately NO `PULUMI_CONFIG_PASSPHRASE` yet unless the fast path
    // above already resolved one — see this method's own "Call order" doc
    // section for why a genuinely new passphrase can only be added once
    // {@link resolveNewPassphrase} (below) has had a chance to query this
    // same workspace's `listStacks()`.
    const envVars: LocalWorkspaceOptions['envVars'] = {
      // Resolved credential vars first — see PulumiWorkspaceInput's
      // `credentialEnvVars` doc comment — so a credential source (whether
      // caller-supplied or resolved above) can never accidentally clobber
      // the backend vars this seam is responsible for below.
      ...credentialEnvVars,
      PULUMI_BACKEND_URL: backendUrl,
      PULUMI_SKIP_UPDATE_CHECK: 'true',
      AWS_REGION: input.stateBucketRegion,
    };

    const opts: LocalWorkspaceOptions = {
      pulumiCommand,
      pulumiHome,
      workDir,
      secretsProvider: 'passphrase',
      envVars,
      program: input.program,
      // `LocalWorkspace.createOrSelectStack`'s convenience wrapper used to
      // default a bare `{ name, runtime: 'nodejs', main: process.cwd() }`
      // project whenever no `Pulumi.yaml` was found yet (its own internal,
      // unexported `inlineSourceStackHelper`) — replicated explicitly here
      // since this method now builds the workspace itself via the lower-level
      // `LocalWorkspace.create` (see {@link resolveInlineProjectSettings}).
      projectSettings: this.resolveInlineProjectSettings(workDir),
    };

    try {
      const createStartedAt = Date.now();
      const ws = await LocalWorkspace.create(opts);
      logger.debug('PulumiWorkspaceService: LocalWorkspace created', { elapsedMs: Date.now() - createStartedAt });
      passphrase ??= await this.resolveNewPassphrase(ws);
      ws.envVars['PULUMI_CONFIG_PASSPHRASE'] = passphrase;
      const stackStartedAt = Date.now();
      const stack = await Stack.createOrSelect(PULUMI_STACK_NAME, ws);
      logger.debug('PulumiWorkspaceService: stack created/selected', {
        elapsedMs: Date.now() - stackStartedAt,
      });
      return stack;
    } catch (err) {
      if (looksLikeMissingBucket(err)) {
        throw new PulumiBackendNotBootstrappedError(input.stateBucket, err);
      }
      throw err;
    }
  }

  /**
   * Replicates the Automation API's own `inlineSourceStackHelper`'s
   * "default the project if `workDir` has no `Pulumi.{yaml,yml,json}` yet"
   * fallback (that helper is a module-private implementation detail of
   * `LocalWorkspace.createOrSelectStack`, not exported — see
   * `@pulumi/pulumi/automation/localWorkspace.js`) — needed because Finding
   * 1's fix builds the workspace via the lower-level `LocalWorkspace.create`
   * instead of that convenience wrapper (see {@link getOrCreateStack}'s "Call
   * order" doc section). Returns `undefined` (leave any existing project
   * settings file untouched) once `workDir` already has one from a prior
   * `getOrCreateStack` call against this same stack — `LocalWorkspace`'s
   * constructor would otherwise unconditionally overwrite it with a fresh
   * `main: process.cwd()`, which is not guaranteed stable across runs of the
   * packaged app.
   */
  private resolveInlineProjectSettings(workDir: string): ProjectSettings | undefined {
    const hasProjectSettingsFile = ['.yaml', '.yml', '.json'].some((ext) =>
      existsSync(join(workDir, `Pulumi${ext}`)),
    );
    if (hasProjectSettingsFile) {
      return undefined;
    }
    return { name: PULUMI_PROJECT_NAME, runtime: 'nodejs', main: process.cwd() };
  }

  /**
   * Reads and decrypts the ALREADY-STORED secrets passphrase for
   * {@link PULUMI_STACK_NAME} — the fast path {@link getOrCreateStack} takes
   * whenever `this.store.get('pulumi')?.passphrase !== undefined`, entirely
   * before credentials/engine/backend are ever touched. Never
   * generates a replacement: a stored entry that can't currently be read
   * (keychain unavailable, or a decrypt failure) fails loudly instead, per
   * {@link PulumiPassphraseUnavailableError}'s doc comment — the passphrase
   * this method returns is the ONLY one that can ever decrypt this stack's
   * existing secure config/state.
   *
   * Presence is checked by the CALLER via the raw
   * {@link ElectronStoreService.get} (no decryption attempted) rather than by
   * this method calling {@link ElectronStoreService.getPulumiPassphrase} and
   * checking for `undefined`, because {@link SafeStorageService.decrypt} does
   * not throw when the keychain is merely *unavailable* at read time — it
   * silently returns the raw ciphertext blob unchanged (see that method's own
   * remarks on write/read-time availability mismatches). Treating that
   * garbage string as a real passphrase would hand Pulumi a value that
   * cannot decrypt the stack's actual state, which is exactly the failure
   * this method exists to prevent. So the keychain's current availability is
   * checked explicitly before ever attempting the decrypt. Only ever called
   * when presence has already been confirmed by the caller.
   */
  private resolveStoredPassphrase(): string {
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
      // Defensive: the caller already confirmed presence via the raw
      // ElectronStoreService.get(). Treat as unavailable rather than falling
      // through to a generate-a-new-one path this method has no access to
      // (that path exists only for the genuinely-new-stack case — see
      // {@link resolveNewPassphrase}).
      throw new PulumiPassphraseUnavailableError(
        'existing-stack-decrypt-failed',
        new Error('stored passphrase entry disappeared between presence check and read'),
      );
    }
    return passphrase;
  }

  /**
   * Generates and persists a FRESH secrets passphrase for
   * {@link PULUMI_STACK_NAME} — only ever called by {@link getOrCreateStack}
   * when `this.store.get('pulumi')?.passphrase === undefined` (no local
   * record at all) AND the keychain has already been confirmed available
   * (that purely-local check is made by the caller before this method is
   * ever reached — see {@link getOrCreateStack}'s own body — since it needs
   * no workspace/backend round-trip at all). Before generating anything,
   * queries `ws.listStacks()` against the REAL backend to confirm the stack
   * doesn't already exist there, and throws
   * {@link PulumiPassphraseUnavailableError} (reason
   * `'existing-stack-no-local-record'`) instead of generating if it does.
   *
   * ## Why a real backend probe, not a local belief
   *
   * Local state (does this install have a stored passphrase?) can never
   * answer "does the remote stack already exist?" once the local store has
   * been wiped — a reinstall, or a second machine pointed at the same state
   * bucket, makes both questions come out the same way even when the remote
   * stack is real. Generating a fresh passphrase in that situation would
   * silently overwrite the local record of a passphrase that already
   * encrypts real remote state, permanently wedging that install (every
   * subsequent `refresh`/`up` then fails with a raw "incorrect passphrase"
   * error, and the "never regenerate once stored" policy means the wrong
   * value is never replaced). `ws` (built by {@link getOrCreateStack} with
   * the backend URL and credentials already configured, but deliberately no
   * `PULUMI_CONFIG_PASSPHRASE` yet — `stack ls` never needs to decrypt
   * anything) is queried via `listStacks()`, which "queries the underlying
   * backend and may return stacks not present in the workspace as
   * `Pulumi.<stack>.yaml` files" (the Automation API's own doc comment on
   * that method) — exactly the ground truth needed here. This adds one
   * extra read-only round-trip, but ONLY on this "no local passphrase" path
   * — see {@link getOrCreateStack}'s "Call order" doc section for why the
   * common (already-has-a-local-passphrase) path never reaches this method
   * at all.
   *
   * @param ws - The `LocalWorkspace` {@link getOrCreateStack} already
   *   constructed for this call (backend URL, credentials, and
   *   `secretsProvider` already configured, passphrase not yet set) — reused
   *   here for the `listStacks()` probe so no second workspace needs to be
   *   built, and reused again by the caller for `Stack.createOrSelect` once
   *   this method returns.
   */
  private async resolveNewPassphrase(ws: LocalWorkspace): Promise<string> {
    const startedAt = Date.now();
    const summaries = await ws.listStacks();
    logger.debug('PulumiWorkspaceService: listStacks resolved', {
      elapsedMs: Date.now() - startedAt,
      stackCount: summaries.length,
    });
    const remoteStackExists = summaries.some((summary) => summary.name === PULUMI_STACK_NAME);
    if (remoteStackExists) {
      throw new PulumiPassphraseUnavailableError('existing-stack-no-local-record');
    }

    // Genuinely new stack, and the keychain is already confirmed available
    // (checked by the caller before this method was ever reached).
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
   * Not a seeded program directory (the program is inline) —
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
