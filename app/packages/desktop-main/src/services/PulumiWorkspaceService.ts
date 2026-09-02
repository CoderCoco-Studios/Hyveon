import { spawn } from 'node:child_process';
import { createHmac } from 'node:crypto';
import { existsSync, mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Injectable } from '@nestjs/common';
import { STSClient, GetCallerIdentityCommand } from '@aws-sdk/client-sts';
// The explicit `/index.js` is required, not cosmetic — see `PulumiEngineService.ts`'s
// comment on this same import: the main bundle is ESM, `@pulumi/pulumi` is
// externalized, and `@pulumi/pulumi` is CommonJS with no `exports` map, so the
// bare directory specifier `@pulumi/pulumi/automation` fails with
// `ERR_UNSUPPORTED_DIR_IMPORT` in the packaged app.
// `Stack` is imported as a value (not type-only) because `Stack.createOrSelect`
// is called directly rather than through `LocalWorkspace.createOrSelectStack`'s
// convenience wrapper (see `resolveInlineProjectSettings` for why the lower-level
// `LocalWorkspace.create` is used instead of that wrapper).
import { LocalWorkspace, Stack } from '@pulumi/pulumi/automation/index.js';
import type { LocalWorkspaceOptions, ProjectSettings, PulumiCommand, PulumiFn } from '@pulumi/pulumi/automation/index.js';
import { logger } from '../logger.js';
import { PulumiEngineService, type PulumiPhaseCallback } from './PulumiEngineService.js';
import { ElectronStoreService } from './ElectronStoreService.js';
import { resolveCredentialEnvVars } from './PulumiCredentialResolver.js';
import { resolveAwsClientCredentials, type AwsClientCredentials } from './awsCredentialSource.js';

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

/**
 * Fixed HMAC key {@link deriveStackPassphrase} uses to turn an AWS account ID
 * and stack name into a reproducible secrets passphrase. FROZEN once
 * shipped — see {@link deriveStackPassphrase}'s doc comment for why changing
 * this value later is equivalent to a breaking migration and must be treated
 * as one (every already-migrated install's stack is encrypted under a
 * passphrase derived using this exact string).
 */
export const PULUMI_PASSPHRASE_DERIVATION_SALT = 'hyveon:pulumi-stack-passphrase:v1';

/**
 * Bound on how long {@link PulumiWorkspaceService.runChangeSecretsProviderCli}
 * waits for the `pulumi stack change-secrets-provider` child process before
 * force-killing it and rejecting — without this, a wedged CLI invocation
 * would hang the awaiting {@link PulumiWorkspaceService.migrateLegacyPassphrase}
 * call (and therefore every Pulumi operation for the session) indefinitely.
 */
const CHANGE_SECRETS_PROVIDER_TIMEOUT_MS = 30_000;

/**
 * Deterministically derives this install's Pulumi secrets passphrase from
 * the AWS account ID the current operation is authenticated against and the
 * (always-fixed) stack name, so any machine holding valid credentials for
 * the same AWS account derives the identical value — the portability
 * mechanism the `pulumi-engine-runtime` delta spec's "A second machine
 * operates on an existing stack" scenario requires. Computed fresh on every
 * `getOrCreateStack` call; the result is never written to
 * `ElectronStoreService` or anywhere else on disk.
 *
 * @remarks
 * This is HMAC-SHA256, not a general-purpose KDF (scrypt/argon2/bcrypt) —
 * deliberately, because {@link PULUMI_PASSPHRASE_DERIVATION_SALT} is not a
 * confidentiality boundary and the input space (`accountId` + `stackName`)
 * is not attacker-guessable low-entropy secret material the way a
 * user-chosen password would be; it is two identifiers already visible to
 * anyone with read access to the AWS account. Per the delta spec: "The
 * passphrase MUST NOT be treated as a confidentiality boundary — the
 * infrastructure program does not mark any Pulumi stack config or output as
 * secret." HMAC-SHA256 buys determinism and collision resistance, which is
 * all this needs.
 *
 * @param accountId - The 12-digit AWS account ID from
 *   `sts:GetCallerIdentity`'s `Account` field (see {@link resolveAwsAccountId}).
 * @param stackName - The Pulumi stack name (always {@link PULUMI_STACK_NAME}
 *   in production; parameterized here only so unit tests can assert
 *   different-input/different-output without a real STS call).
 * @returns A 64-character lowercase hex string (the raw HMAC-SHA256 digest).
 */
export function deriveStackPassphrase(accountId: string, stackName: string): string {
  return createHmac('sha256', PULUMI_PASSPHRASE_DERIVATION_SALT)
    .update(accountId + stackName)
    .digest('hex');
}

/**
 * Resolves the AWS account ID the currently-configured credential source
 * (the same one {@link resolveCredentialEnvVars} resolves for the Pulumi
 * engine's own child-process environment — see
 * {@link PulumiWorkspaceService.getOrCreateStack}) authenticates against, via
 * `sts:GetCallerIdentity`. Feeds {@link deriveStackPassphrase}'s `accountId`
 * parameter.
 *
 * @remarks
 * Deliberately does not itself throw a typed "no credential source
 * configured" error — {@link PulumiWorkspaceService.getOrCreateStack} already
 * calls `resolveCredentialEnvVars(this.store)` earlier in the same method for
 * the exact same store, which throws `PulumiCredentialsNotConfiguredError`
 * first if nothing is selected. This function is only ever reached once that
 * call has already succeeded, so `resolveAwsClientCredentials` is
 * guaranteed not to return the `undefined` ("no profile stored") case here
 * in practice — the type still allows it (this function's own `store`
 * argument doesn't know what the caller already checked), so a defensive
 * throw is kept for that branch rather than silently constructing an
 * `STSClient` with no credentials and letting the SDK's own default
 * provider-chain fallback obscure the real cause.
 *
 * @param store - Resolves the active AWS credential source (same store
 *   `getOrCreateStack` already has).
 * @param region - Region for the `STSClient` — `GetCallerIdentity` is a
 *   global/region-agnostic STS action, but the SDK still requires a region
 *   to construct the client; `input.stateBucketRegion` is reused rather than
 *   introducing a second region concept.
 * @param stsClientFactory - Test seam — defaults to constructing a plain
 *   `new STSClient(config)`; tests inject a stub that returns a client whose
 *   `send` is `vi.fn()`.
 * @returns The 12-digit AWS account ID from `GetCallerIdentity`'s `Account` field.
 * @throws `Error` if no credential source is configured (defensive only —
 *   see remarks above) or if the `GetCallerIdentity` response has no
 *   `Account` field.
 * @throws Raw AWS SDK errors from `sts:GetCallerIdentity` propagate
 *   unchanged out of this function — {@link PulumiWorkspaceService.getOrCreateStack}
 *   is the one that catches and normalizes them (its own dedicated try/catch
 *   around this call, per `.claude/rules/logging.md`'s "never let a raw
 *   SDK/Node error object escape uncaught" rule), not this function itself.
 */
export async function resolveAwsAccountId(
  store: ElectronStoreService,
  region: string,
  stsClientFactory: (config: { region: string; credentials: AwsClientCredentials }) => STSClient = (config) =>
    new STSClient(config),
): Promise<string> {
  const credentials = resolveAwsClientCredentials(store);
  if (credentials === undefined) {
    throw new Error(
      'No AWS credential source is configured — cannot resolve the AWS account ID to derive the Pulumi passphrase.',
    );
  }
  const client = stsClientFactory({ region, credentials });
  const response = await client.send(new GetCallerIdentityCommand({}));
  if (!response.Account) {
    throw new Error('sts:GetCallerIdentity did not return an AWS account ID.');
  }
  return response.Account;
}

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
 *  - A secrets passphrase derived deterministically from the currently
 *    authenticated AWS account ID and {@link PULUMI_STACK_NAME} (see
 *    {@link deriveStackPassphrase}/{@link resolveAwsAccountId}) — never
 *    stored, never read from disk, and identical on any machine
 *    authenticated against the same AWS account, so a second machine can
 *    resume an existing stack with no local passphrase record at all.
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
    private readonly store: ElectronStoreService,
  ) {}

  /**
   * Resolves the engine, ensures the stable `pulumiHome`/`workDir`
   * directories exist, derives the secrets passphrase from the currently
   * authenticated AWS account (see {@link deriveStackPassphrase}/
   * {@link resolveAwsAccountId} — never stored, never read from disk), and
   * selects or creates {@link PULUMI_STACK_NAME} on it. Throws
   * {@link PulumiBackendNotBootstrappedError} if `input.backendReady` is
   * `false` (checked before anything else). Also throws
   * `PulumiCredentialsNotConfiguredError` (from `PulumiCredentialResolver.ts`,
   * via {@link resolveCredentialEnvVars}) when `input.credentialEnvVars` is
   * omitted and the store has no credential source selected at all — see
   * {@link PulumiWorkspaceInput.credentialEnvVars}'s doc comment for why
   * resolution happens here unconditionally rather than trusting every
   * future caller to remember to pass it.
   *
   * Because the passphrase is derived, not stored, the same AWS account
   * always reproduces the identical value on any machine — there is no more
   * "stored vs. generate vs. probe the real backend" branching, and no more
   * `workspace.listStacks()` round-trip to disambiguate a second machine
   * from a genuinely new stack (the `pulumi-engine-runtime` delta spec's "A
   * second machine operates on an existing stack" scenario). Installs that
   * pre-date this derivation still hold a legacy stored passphrase — a
   * one-time migration step reconciling that legacy value with the newly
   * derived one runs here too (see {@link migrateLegacyPassphrase}), inserted
   * right after the new passphrase is derived and before it is ever used to
   * construct the real workspace — NOT before credential resolution, since
   * the migration's own CLI invocation needs the already-resolved
   * credential/backend env vars to reach the same S3-backed state.
   *
   * `LocalWorkspace.create` and `Stack.createOrSelect` are wrapped in a
   * single try/catch: a failure that looks like a missing bucket (see
   * {@link BUCKET_MISSING_PATTERN}) is re-classified into
   * {@link PulumiBackendNotBootstrappedError} as a backstop for when
   * `backendReady` was wrong, rather than surfacing raw Pulumi/gocloud
   * stderr to the operator. `resolveAwsAccountId`'s STS call happens BEFORE
   * this try/catch, in its own small dedicated try/catch (see
   * {@link resolveAwsAccountId}'s own doc comment) — a credentials/network
   * failure there is a distinct failure surface from "backend not
   * bootstrapped" and is never reclassified as
   * {@link PulumiBackendNotBootstrappedError}; it is only normalized
   * (`err instanceof Error ? err.message : String(err)`, logged via
   * `logger.warn`) and rethrown as a plain `Error` with just that message,
   * per `.claude/rules/logging.md`.
   *
   * @throws {@link PulumiBackendNotBootstrappedError} if `input.backendReady`
   *   is `false`, or (reclassified) if `LocalWorkspace.create`/
   *   `Stack.createOrSelect` fail in a way that looks like a missing bucket.
   * @throws `PulumiCredentialsNotConfiguredError` if no credential source is
   *   selected (see {@link resolveCredentialEnvVars}).
   * @throws `Error` (normalized `.message` only) if `resolveAwsAccountId`'s
   *   `sts:GetCallerIdentity` call fails.
   * @throws `Error` with a keychain-unlock message if a legacy `pulumi.passphrase`
   *   is stored but the OS keychain is currently unavailable to decrypt it —
   *   checked before migration is attempted, never left to surface as a
   *   confusing `pulumi` CLI "incorrect passphrase" error instead.
   */
  async getOrCreateStack(input: PulumiWorkspaceInput): Promise<Stack> {
    if (!input.backendReady) {
      throw new PulumiBackendNotBootstrappedError(input.stateBucket);
    }

    // Credential resolution is unconditional: `input.credentialEnvVars` is
    // normally unset, so this seam resolves the wizard's selected AWS
    // credential source itself rather than trusting the caller to remember
    // to pass it — see PulumiWorkspaceInput.credentialEnvVars's doc comment.
    // Throws PulumiCredentialsNotConfiguredError if the store has no
    // credential source selected at all, rather than silently proceeding
    // with no credential vars (which would let the engine fall back to its
    // own default AWS credential chain, exactly what spec.md:100 forbids).
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

    let accountId: string;
    try {
      accountId = await resolveAwsAccountId(this.store, input.stateBucketRegion);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.warn('PulumiWorkspaceService.getOrCreateStack: sts:GetCallerIdentity failed while deriving the secrets passphrase', {
        error: message,
      });
      throw new Error(message);
    }
    const passphrase = deriveStackPassphrase(accountId, PULUMI_STACK_NAME);

    // Legacy migration: an install that pre-dates the derivation scheme
    // still holds a randomly-generated passphrase in `pulumi.passphrase`.
    // Presence alone does NOT mean it is safe to decrypt: `SafeStorageService.decrypt`
    // does not throw when the OS keychain is merely unavailable/locked — it
    // silently returns the raw ciphertext blob unchanged (see that method's
    // own remarks). So keychain availability is checked explicitly, BEFORE
    // ever calling `getPulumiPassphrase()`, to avoid handing that garbage
    // blob to the `pulumi` CLI as if it were the real passphrase (which would
    // fail with a confusing "incorrect passphrase"-style CLI error, giving
    // the operator no indication that unlocking their OS keychain is the fix).
    const hasLegacyPassphrase = this.store.get('pulumi')?.passphrase !== undefined;
    if (hasLegacyPassphrase && !this.store.isSafeStorageAvailable()) {
      logger.error(
        'PulumiWorkspaceService: cannot migrate the legacy Pulumi passphrase because the OS keychain is unavailable',
        { stackName: PULUMI_STACK_NAME },
      );
      throw new Error(
        'Cannot access this stack: a legacy Pulumi secrets passphrase is stored but the OS keychain is ' +
          'currently unavailable, so it cannot be decrypted. Unlock your OS keychain (Keychain Access, ' +
          'libsecret, or Windows Credential Manager) and try again.',
      );
    }
    const legacyPassphrase = hasLegacyPassphrase ? this.store.getPulumiPassphrase() : undefined;
    if (legacyPassphrase !== undefined) {
      await this.migrateLegacyPassphrase(legacyPassphrase, passphrase, {
        pulumiCommand,
        pulumiHome,
        workDir,
        envVars: { ...credentialEnvVars, PULUMI_BACKEND_URL: backendUrl, AWS_REGION: input.stateBucketRegion },
      });
      const current = this.store.get('pulumi') ?? {};
      const { passphrase: _removed, ...rest } = current;
      this.store.set('pulumi', rest);
      logger.debug('PulumiWorkspaceService: migrated legacy passphrase to derived value', {
        stackName: PULUMI_STACK_NAME,
      });
    }

    const envVars: LocalWorkspaceOptions['envVars'] = {
      // Resolved credential vars first — see PulumiWorkspaceInput's
      // `credentialEnvVars` doc comment — so a credential source (whether
      // caller-supplied or resolved above) can never accidentally clobber
      // the backend vars this seam is responsible for below.
      ...credentialEnvVars,
      PULUMI_BACKEND_URL: backendUrl,
      PULUMI_SKIP_UPDATE_CHECK: 'true',
      AWS_REGION: input.stateBucketRegion,
      PULUMI_CONFIG_PASSPHRASE: passphrase,
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
      const stackStartedAt = Date.now();
      const stack = await Stack.createOrSelect(PULUMI_STACK_NAME, ws);
      logger.debug('PulumiWorkspaceService: stack created/selected', {
        elapsedMs: Date.now() - stackStartedAt,
      });
      this.store.set('pulumi', { ...(this.store.get('pulumi') ?? {}), stackInitialized: true });
      return stack;
    } catch (err) {
      if (looksLikeMissingBucket(err)) {
        throw new PulumiBackendNotBootstrappedError(input.stateBucket, err);
      }
      throw err;
    }
  }

  /**
   * One-time, automatic migration for an install that still holds a legacy
   * randomly-generated passphrase in `pulumi.passphrase` (pre-dates this
   * derivation scheme). Re-encrypts the stack's secrets provider from the
   * legacy value to `newPassphrase` via the `pulumi` CLI's own
   * `stack change-secrets-provider` command, spawned directly as a child
   * process — {@link PulumiWorkspaceService} has no public Automation API
   * method for this. `Stack.exportStack`/`importStack` do not rewrite the
   * checkpoint's `secrets_providers` block, and `Stack.changeSecretsProvider`
   * does not exist on the `@pulumi/pulumi@3.255.0` SDK this repo pins.
   *
   * MUST be called with the same `pulumiCommand`/`pulumiHome`/`workDir`/
   * `envVars` (backend URL, region, credentials) `getOrCreateStack` is about
   * to use for the real operation, so re-encryption targets the same S3
   * state — a mismatched backend/region would silently re-key a different
   * (or nonexistent) stack.
   *
   * Deletes the legacy `pulumi.passphrase` store entry ONLY after
   * re-encryption succeeds — see {@link getOrCreateStack}'s own call site.
   * Any failure (network, malformed CLI output, non-zero exit) is normalized
   * and rethrown as a plain `Error`, leaving the legacy entry untouched, so
   * the NEXT `getOrCreateStack` call retries this same migration with the
   * same still-valid legacy passphrase, per the delta spec's "Legacy
   * migration is retried after a failed re-encryption" scenario.
   *
   * @remarks
   * The command is `pulumi stack change-secrets-provider passphrase --stack <name> --non-interactive`,
   * run with `cwd: workDir` (equivalent to `--cwd`). The two passphrases go
   * through two DIFFERENT channels, not both via `PULUMI_CONFIG_PASSPHRASE`:
   * the OLD (legacy) passphrase, which decrypts the current secrets provider,
   * is read from the `PULUMI_CONFIG_PASSPHRASE` env var; the NEW passphrase is
   * written as `${newPassphrase}\n` to the child's stdin and the stream
   * closed — exactly one line, no confirmation re-prompt (the CLI's
   * interactive "enter twice" flow only applies to a TTY, and a spawned
   * child's piped stdio never is one). `PULUMI_HOME` is set explicitly on the
   * child env, matching the Automation API's own `pulumiHome` option.
   *
   * This CLI invocation runs with `cwd: workDir` BEFORE `LocalWorkspace.create`
   * has had any chance to (re)write `Pulumi.yaml`/`Pulumi.<stack>.yaml` in
   * that directory — `getOrCreateStack` calls this method first. It therefore
   * depends on a project file already existing in `workDir` from a prior run
   * under the old (pre-derivation) code. Edge case: an install whose `workDir`
   * was wiped (reinstall, cache clear) while the store's legacy
   * `pulumi.passphrase` survived fails this migration with a "no Pulumi
   * project found"-style CLI error — that install needs a full manual reset
   * (clear the legacy store entry) rather than an automatic retry.
   *
   * @param legacyPassphrase - Decrypted legacy passphrase, read by the caller
   *   via {@link ElectronStoreService.getPulumiPassphrase} before this is
   *   called — this function never touches `SafeStorageService` itself.
   * @param newPassphrase - The freshly {@link deriveStackPassphrase}-derived
   *   value the caller is about to use for the real operation.
   * @param ctx - `pulumiCommand`/`pulumiHome`/`workDir`/`envVars` (sans
   *   `PULUMI_CONFIG_PASSPHRASE`, which this function sets itself to
   *   `legacyPassphrase` — the new value is supplied via stdin instead, per
   *   the spike finding above).
   * @throws A plain `Error` (never a raw child-process error — normalized
   *   per `.claude/rules/logging.md`) if the CLI invocation fails. The legacy
   *   store entry is left in place in every throw case — see
   *   {@link getOrCreateStack}'s call site.
   */
  private async migrateLegacyPassphrase(
    legacyPassphrase: string,
    newPassphrase: string,
    ctx: { pulumiCommand: PulumiCommand; pulumiHome: string; workDir: string; envVars: Record<string, string> },
  ): Promise<void> {
    const args = ['stack', 'change-secrets-provider', 'passphrase', '--stack', PULUMI_STACK_NAME, '--non-interactive'];
    // `child_process.spawn`'s `env` option REPLACES the child's environment
    // rather than merging with `process.env` (unlike `execa`, which the SDK's
    // own internal `PulumiCommand.run` uses with its default `extendEnv`
    // behaviour) — `process.env` is spread first so PATH/HOME/etc. are still
    // inherited, exactly as every other invocation of this binary in this
    // service relies on.
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      ...ctx.envVars,
      PULUMI_HOME: ctx.pulumiHome,
      PULUMI_SKIP_UPDATE_CHECK: 'true',
      PULUMI_CONFIG_PASSPHRASE: legacyPassphrase,
    };

    try {
      await this.runChangeSecretsProviderCli(ctx.pulumiCommand.command, args, ctx.workDir, env, newPassphrase);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error('PulumiWorkspaceService: failed to re-encrypt the legacy Pulumi passphrase', { error: message });
      throw new Error(`Failed to migrate the legacy Pulumi secrets passphrase: ${message}`);
    }
  }

  /**
   * Spawns `pulumi stack change-secrets-provider passphrase` and drives it
   * to completion per {@link migrateLegacyPassphrase}'s spike-finding
   * doc comment: writes `${newPassphrase}\n` to stdin (the only input the
   * non-interactive rotate path reads) and resolves on a zero exit code.
   * Rejects with a plain `Error` carrying the process's stderr on a non-zero
   * exit, or the raw spawn error (e.g. `ENOENT`) if the binary itself
   * couldn't be started — both cases are caught and re-normalized by
   * {@link migrateLegacyPassphrase}, never escaping this method as a raw
   * child-process error.
   *
   * @remarks
   * Listens on `'close'`, not `'exit'` — Node's own docs call out that
   * `'exit'` can fire before all stdout/stderr data events have been
   * flushed/read, which could truncate the `stderr` this method accumulates
   * for the failure message; `'close'` guarantees every stdio stream has
   * finished before the event fires.
   *
   * @param command - Absolute path to the resolved `pulumi` binary
   *   (`PulumiCommand.command`).
   * @param args - CLI arguments (see {@link migrateLegacyPassphrase}).
   * @param cwd - Working directory for the child process — `ctx.workDir`,
   *   equivalent to passing `--cwd` explicitly.
   * @param env - Full child environment, already merged with `process.env`
   *   by the caller.
   * @param newPassphrase - Written to the child's stdin, followed by a
   *   newline, then the stream is closed.
   * @returns Resolves with no value on a zero exit code.
   * @throws A plain `Error` describing a non-zero exit (stderr included), a
   *   timeout (see {@link CHANGE_SECRETS_PROVIDER_TIMEOUT_MS}), or the raw
   *   spawn/stdin failure.
   */
  private runChangeSecretsProviderCli(
    command: string,
    args: string[],
    cwd: string,
    env: NodeJS.ProcessEnv,
    newPassphrase: string,
  ): Promise<void> {
    return new Promise((resolvePromise, rejectPromise) => {
      const child = spawn(command, args, { cwd, env });
      let stderr = '';
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        child.kill('SIGTERM');
        rejectPromise(new Error('pulumi stack change-secrets-provider timed out'));
      }, CHANGE_SECRETS_PROVIDER_TIMEOUT_MS);
      child.stderr?.on('data', (chunk: Buffer) => {
        stderr += chunk.toString();
      });
      // An unhandled 'error' on child.stdin (e.g. EPIPE if the process exits
      // before reading the write below) would otherwise crash the Electron
      // main process — Node only guarantees a stream's 'error' is non-fatal
      // once something is actually listening for it.
      child.stdin?.on('error', (err) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        rejectPromise(err);
      });
      child.once('error', (err) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        rejectPromise(err);
      });
      child.once('close', (code) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (code === 0) {
          resolvePromise();
        } else {
          rejectPromise(new Error(`pulumi stack change-secrets-provider exited with code ${String(code)}: ${stderr.trim()}`));
        }
      });
      child.stdin?.write(`${newPassphrase}\n`);
      child.stdin?.end();
    });
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
