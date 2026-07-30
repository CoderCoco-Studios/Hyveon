import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, renameSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { Injectable } from '@nestjs/common';
// The explicit `/index.js` is required, not cosmetic — see `spike/pulumiSpike.ts`'s
// comment on this same import: the main bundle is ESM, `@pulumi/pulumi` is
// externalized, and `@pulumi/pulumi` is CommonJS with no `exports` map, so the
// bare directory specifier `@pulumi/pulumi/automation` fails with
// `ERR_UNSUPPORTED_DIR_IMPORT` in the packaged app.
import { PulumiCommand } from '@pulumi/pulumi/automation/index.js';
import { PULUMI_ENGINE_VERSION } from '@hyveon/shared';
import { SemVer } from 'semver';
import { logger } from '../logger.js';

/**
 * Narrows an unknown thrown value to a human-readable message for the
 * provisioning error classes below — mirrors the `instanceof Error` message-
 * extraction idiom used throughout `TerraformService`.
 */
function describeCause(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

/**
 * Thrown by {@link PulumiEngineService.resolve} when the pinned engine
 * version can't be provisioned because `get.pulumi.com` (or the release
 * asset it redirects to) couldn't be reached — matched from the SDK's own
 * `download()` failure messages (`"Failed to download ..."` /
 * `"Timed out downloading ..."`) and from common DNS/connection errno codes
 * surfaced by the install script's own network calls. Distinct from
 * {@link PulumiEngineIntegrityError} (a download that completed but didn't
 * verify) and {@link PulumiEngineCacheWriteError} (the cache directory itself
 * can't be written to). Surfaced to the wizard and the Plan/Apply page per
 * the "Provisioning fails with no network" scenario, with a retry offered —
 * see {@link PulumiEngineService.resolve}'s TSDoc for why a failed attempt is
 * never memoized.
 */
export class PulumiEngineNetworkError extends Error {
  constructor(
    public readonly root: string,
    public readonly cause: unknown,
  ) {
    super(
      `Failed to reach get.pulumi.com while provisioning the Pulumi engine into "${root}": ` +
        describeCause(cause),
    );
    this.name = 'PulumiEngineNetworkError';
  }
}

/**
 * Thrown by {@link PulumiEngineService.resolve} when the pinned engine
 * downloaded but failed to install or verify — the install script exited
 * non-zero for a reason other than a recognised network failure, or the
 * resulting binary reports a version other than the exact pin (see
 * {@link PulumiEngineService.assertExactPin}, which guards against
 * `PulumiCommand`'s own version check being a minimum-version check rather
 * than an exact match — see the file-level TSDoc). Distinct from
 * {@link PulumiEngineNetworkError} (no connection was made at all) and
 * {@link PulumiEngineCacheWriteError} (the cache directory itself is
 * unwritable). A failed install never leaves anything at the final install
 * directory — see {@link PulumiEngineService.installFresh}'s TSDoc for the
 * staging-then-rename guarantee this relies on.
 */
export class PulumiEngineIntegrityError extends Error {
  constructor(
    public readonly root: string,
    public readonly cause: unknown,
  ) {
    super(
      `Pulumi engine download or verification failed while installing into "${root}": ` +
        describeCause(cause),
    );
    this.name = 'PulumiEngineIntegrityError';
  }
}

/**
 * Thrown by {@link PulumiEngineService.resolve} when the engine cache
 * directory under Electron `userData` (or its parent) can't be written to —
 * e.g. `EACCES`/`EPERM`/`EROFS`/`ENOSPC` raised while creating the cache
 * root or renaming a verified staging install into place. Distinct from
 * {@link PulumiEngineNetworkError} and {@link PulumiEngineIntegrityError},
 * which both assume the cache directory itself is writable.
 */
export class PulumiEngineCacheWriteError extends Error {
  constructor(
    public readonly root: string,
    public readonly cause: unknown,
  ) {
    super(`Pulumi engine cache directory "${root}" is not writable: ${describeCause(cause)}`);
    this.name = 'PulumiEngineCacheWriteError';
  }
}

/**
 * Matches the SDK's own `download()` failure messages
 * (`automation/download.js`: `"Failed to download <url>: ..."` /
 * `"Timed out downloading <url>"`, thrown when fetching the install script
 * itself before it ever runs) plus common DNS/connection errno strings a
 * network-unreachable install script's stderr tends to contain. Used by
 * {@link classifyProvisioningError} to distinguish
 * {@link PulumiEngineNetworkError} from {@link PulumiEngineIntegrityError}
 * for failures that aren't a recognised filesystem errno (see
 * {@link CACHE_WRITE_ERRNO_CODES}).
 */
const NETWORK_ERROR_PATTERN =
  /failed to download|timed out downloading|enotfound|econnrefused|etimedout|eai_again|enetunreach|econnreset|network/i;

/** `NodeJS.ErrnoException` codes treated as an unwritable cache directory. */
const CACHE_WRITE_ERRNO_CODES = new Set(['EACCES', 'EPERM', 'EROFS', 'ENOSPC']);

/**
 * Classifies a failure raised while installing the engine (either from
 * `PulumiCommand.install()` itself, or from the pre-flight `mkdirSync`/
 * `renameSync` calls around it) into one of the three typed provisioning
 * errors the spec requires distinct handling for. Filesystem errno codes are
 * checked first since they're unambiguous signals straight from Node — a
 * message-pattern match is only consulted for errors that don't carry one
 * (e.g. the SDK's own pre-script `download()` failure, or the install
 * script's own non-zero exit, whose `CommandError` carries stdout/stderr
 * text but no errno code). Anything that matches neither is treated as an
 * integrity failure — the conservative default, since silently mis-reporting
 * a real integrity failure as "no network" would send an operator chasing
 * their connection instead of retrying (which self-heals a rare
 * misclassification either way, since a failed attempt is never memoized).
 */
function classifyProvisioningError(err: unknown, root: string): Error {
  const errno = err && typeof err === 'object' && 'code' in err ? String((err as { code: unknown }).code) : undefined;
  if (errno && CACHE_WRITE_ERRNO_CODES.has(errno)) {
    return new PulumiEngineCacheWriteError(root, err);
  }
  const message = err instanceof Error ? err.message : String(err);
  if (NETWORK_ERROR_PATTERN.test(message)) {
    return new PulumiEngineNetworkError(root, err);
  }
  return new PulumiEngineIntegrityError(root, err);
}

/**
 * Removes a directory tree best-effort, logging (rather than throwing) if
 * cleanup itself fails — mirrors `ConfigService.seedTerraformWorkspace`'s
 * staging-directory cleanup. Used both to discard a failed/corrupt staging
 * install and to discard a cache entry that failed re-verification.
 *
 * Calls `rmSync` unconditionally with `force: true` rather than gating on an
 * `existsSync` check first — `force: true` already swallows a missing path,
 * so the extra check would only add a syscall (and a TOCTOU gap) without
 * changing the outcome: a failed install may or may not have left anything
 * on disk at `path`, and either way this call is a safe no-op or a real
 * cleanup.
 */
function removeDirBestEffort(path: string, context: string): void {
  try {
    rmSync(path, { recursive: true, force: true });
  } catch (err) {
    logger.error('Failed to clean up Pulumi engine directory', { path, context, err });
  }
}

/**
 * Resolves a usable Pulumi engine (`PulumiCommand`) without requiring the
 * operator to install anything, per the `pulumi-engine-runtime` delta spec's
 * "App-managed engine provisioning" and "Pinned engine version" requirements.
 * Installs {@link PULUMI_ENGINE_VERSION} into an app-owned directory under
 * Electron `userData` — never `~/.pulumi` — and never probes `PATH` for a
 * `pulumi` binary.
 *
 * Construction is synchronous and never throws — no filesystem or network
 * work happens until {@link resolve} is first called — mirroring
 * `TerraformService`'s "binary lookup and version resolution are deferred to
 * first use" pattern (see `terraform.module.ts`'s doc comment) so
 * `PulumiEngineModule` can be imported by `AppModule` unconditionally even on
 * a machine with no engine and no network, per the "Container builds without
 * an engine" scenario.
 *
 * ## Version-namespaced cache, not detect-and-clear
 *
 * `PulumiCommand.get()`/`PulumiCommand.install()` (see
 * `node_modules/@pulumi/pulumi/automation/cmd.js`) validate an existing
 * installation with a **minimum**-version check, not an exact-match check:
 * `install()` first tries `get({ root })`, and if the binary there already
 * satisfies `>= opts.version` (same major), it's accepted as-is — a *newer*
 * cached version at the same `root` would silently be reused instead of the
 * exact pin. Rather than detecting a stale version at a single fixed `root`
 * and clearing it before installing (which would also mean trusting the
 * install script downloaded from `get.pulumi.com` to overwrite cleanly, an
 * undocumented behaviour of a script this codebase doesn't control), each
 * pinned version gets its own install directory: `<cacheRoot>/versions/<pin>`.
 * A "stale version in the cache" can then never be *the same directory* as
 * the pin's directory, so there's nothing to detect or clear — the pinned
 * version's directory either holds exactly that version (verified below) or
 * doesn't exist yet. This mirrors the SDK's own default root layout
 * (`$HOME/.pulumi/versions/$VERSION`), just relocated under `userData`.
 * {@link assertExactPin} additionally guards against the minimum-check
 * behaviour above at both the cache-hit and fresh-install paths, in case a
 * directory is ever manually tampered with.
 *
 * ## No partial-install reuse
 *
 * {@link installFresh} never installs directly into the pin's final
 * directory. It installs into a sibling staging directory
 * (`<cacheRoot>/.staging-<uuid>`), and only `renameSync`s it into the final
 * `<cacheRoot>/versions/<pin>` path once `PulumiCommand.install()` has
 * resolved *and* {@link assertExactPin} has verified the installed binary
 * reports exactly the pinned version. An interrupted or corrupted install
 * (network drop mid-download, a script that exits non-zero, a binary that
 * fails to execute) therefore never touches the final directory at all — it
 * only ever leaves debris in the staging directory, which is removed via
 * {@link removeDirBestEffort}. A later call sees no directory at the pinned
 * path and reprovisions from scratch, satisfying the "Interrupted download
 * leaves no usable partial" scenario structurally rather than via an
 * `existsSync` staleness check that a partial write could fool.
 *
 * ## Memoization that survives a failed attempt
 *
 * {@link resolve} memoizes the in-flight *promise*, so concurrent callers
 * share exactly one provisioning attempt (verified in
 * `PulumiEngineService.test.ts` by asserting `PulumiCommand.install` is
 * called exactly once across concurrent `resolve()` calls) — mirroring
 * `TerraformService.resolve()`. Unlike `TerraformService.resolve()`,
 * though, a **rejected** attempt is deliberately not left memoized: the
 * field is reset to `null` the moment the shared promise rejects, so the
 * *next* `resolve()` call (after this one has settled) starts a fresh
 * provisioning attempt instead of replaying the same stale rejection
 * forever. `TerraformService` can afford to memoize a lookup failure
 * permanently because "no `terraform` on PATH" is a static fact about the
 * machine; engine provisioning failures (no network, a momentarily locked
 * cache directory) are often transient, and the "Provisioning fails with no
 * network" scenario explicitly requires "a retry is offered" — a retry that
 * only re-attempts anything if the failure wasn't memoized.
 */
@Injectable()
export class PulumiEngineService {
  /** In-flight or last-successful provisioning attempt; see the class TSDoc's memoization section. */
  private resolution: Promise<PulumiCommand> | null = null;

  /**
   * The resolved engine's version string, set once {@link resolve} has
   * successfully completed at least once. `null` before the first
   * successful resolution. Backs {@link getResolvedVersion} — the "Resolved
   * version is observable" scenario's accessor; wiring it to an actual
   * Settings IPC channel is Phase 9/10's job.
   */
  private resolvedVersion: string | null = null;

  /**
   * Resolves a `PulumiCommand` pointed at the pinned engine version,
   * provisioning it into the `userData`-rooted cache on first call and
   * memoizing the result for the lifetime of this instance — see the class
   * TSDoc for the full memoization, versioning, and atomicity guarantees.
   * Rejects with {@link PulumiEngineNetworkError}, {@link PulumiEngineIntegrityError},
   * or {@link PulumiEngineCacheWriteError} if provisioning fails; a rejected
   * attempt is not memoized, so the next call retries from scratch.
   */
  resolve(): Promise<PulumiCommand> {
    if (!this.resolution) {
      this.resolution = this.provision().catch((err: unknown) => {
        this.resolution = null;
        throw err;
      });
    }
    return this.resolution;
  }

  /**
   * The pinned engine version this service provisions — re-exported from
   * `@hyveon/shared` for convenience so callers only need `PulumiEngineService`.
   */
  getPinnedVersion(): string {
    return PULUMI_ENGINE_VERSION;
  }

  /**
   * The resolved engine's version string once {@link resolve} has completed
   * successfully at least once, or `null` before that (including while a
   * first resolution is still in flight). Always equal to
   * {@link getPinnedVersion} once set — {@link assertExactPin} guarantees
   * {@link resolve} never resolves to anything other than the pinned
   * version.
   */
  getResolvedVersion(): string | null {
    return this.resolvedVersion;
  }

  /**
   * Runs the actual provisioning attempt {@link resolve} memoizes: reuse a
   * verified cache entry at the pin's version-namespaced directory, or
   * install fresh into it. Records {@link resolvedVersion} only once a
   * `PulumiCommand` has been obtained and verified.
   */
  private async provision(): Promise<PulumiCommand> {
    const pin = new SemVer(PULUMI_ENGINE_VERSION);
    const root = this.getEngineInstallRoot(pin);

    const cached = await this.tryReuseCached(root, pin);
    const command = cached ?? (await this.installFresh(root, pin));

    this.resolvedVersion = command.version ? command.version.toString() : null;
    return command;
  }

  /**
   * Attempts to reuse an already-installed engine at `root`. Returns `null`
   * (never throws) when nothing is installed there yet, or when what's there
   * fails to execute or reports a version other than the exact pin — in
   * either failure case the directory is removed via
   * {@link removeDirBestEffort} so it can't be mistaken for a valid install
   * on a later call, and the caller falls through to {@link installFresh}.
   */
  private async tryReuseCached(root: string, pin: SemVer): Promise<PulumiCommand | null> {
    if (!existsSync(root)) return null;

    try {
      const command = await PulumiCommand.get({ root, version: pin, skipVersionCheck: false });
      this.assertExactPin(command, pin, root);
      return command;
    } catch (err) {
      logger.warn('Pulumi engine cache entry failed verification — discarding and reprovisioning', {
        root,
        err,
      });
      removeDirBestEffort(root, 'stale cache entry');
      return null;
    }
  }

  /**
   * Installs the pinned engine into a fresh staging directory, verifies it,
   * and only then renames it into `root` — see the class TSDoc's "No
   * partial-install reuse" section for why this order is what makes an
   * interrupted install structurally unable to leave a usable partial at
   * `root`. Throws {@link PulumiEngineNetworkError},
   * {@link PulumiEngineIntegrityError}, or {@link PulumiEngineCacheWriteError}
   * (via {@link classifyProvisioningError}) on any failure, after best-effort
   * staging-directory cleanup.
   */
  private async installFresh(root: string, pin: SemVer): Promise<PulumiCommand> {
    // Parent of the pin's own directory (`<engineCacheRoot>/versions`) — the
    // staging directory below is created as its sibling, not inside `root`
    // itself, so `root` is never observed to exist until the rename below
    // makes it appear atomically, fully installed.
    const versionsDir = dirname(root);
    try {
      mkdirSync(versionsDir, { recursive: true });
    } catch (err) {
      throw new PulumiEngineCacheWriteError(versionsDir, err);
    }

    const stagingDir = join(versionsDir, `.staging-${randomUUID()}`);
    let installed: PulumiCommand;
    try {
      installed = await PulumiCommand.install({ version: pin, root: stagingDir, skipVersionCheck: false });
      this.assertExactPin(installed, pin, stagingDir);
    } catch (err) {
      removeDirBestEffort(stagingDir, 'failed install');
      throw classifyProvisioningError(err, versionsDir);
    }

    try {
      renameSync(stagingDir, root);
    } catch (err) {
      removeDirBestEffort(stagingDir, 'failed rename into place');
      throw new PulumiEngineCacheWriteError(versionsDir, err);
    }

    // `installed.command` still points at the now-renamed-away staging path
    // — re-resolve a fresh `PulumiCommand` against the final `root` rather
    // than returning the stale one.
    return PulumiCommand.get({ root, version: pin, skipVersionCheck: false });
  }

  /**
   * Throws a plain `Error` (classified by the caller into one of the typed
   * provisioning errors) unless `command.version` is defined and exactly
   * equal to `pin` — guards against `PulumiCommand.get()`/`install()`'s own
   * check being a minimum-version check rather than an exact match, per the
   * class TSDoc's "Version-namespaced cache" section.
   */
  private assertExactPin(command: PulumiCommand, pin: SemVer, root: string): void {
    if (!command.version || command.version.compare(pin) !== 0) {
      throw new Error(
        `engine at "${root}" reports version "${String(command.version)}", expected exactly "${pin.toString()}"`,
      );
    }
  }

  /**
   * Resolves the version-namespaced install directory for `pin`:
   * `<cacheRoot>/versions/<pin>`. See {@link getEngineCacheRoot} for how
   * `cacheRoot` itself is resolved.
   */
  private getEngineInstallRoot(pin: SemVer): string {
    return join(this.getEngineCacheRoot(), 'versions', pin.toString());
  }

  /**
   * Resolves the root cache directory the engine (and, per-version, every
   * pin this service has ever provisioned) is installed under. Mirrors
   * `ConfigService.getRunsDir()`'s resolution order:
   *
   *  1. `PULUMI_ENGINE_DIR` env var — wins when set, resolved against
   *     `process.cwd()` so a relative override behaves predictably in dev/test.
   *  2. Electron `userData` directory (`<userData>/pulumi`) — the app-owned
   *     location the spec requires ("never `~/.pulumi`"), available whenever
   *     this process is running inside Electron (see {@link resolveUserDataPath}).
   *  3. OS temp directory (`<os.tmpdir()>/hyveon-pulumi-engine`) fallback —
   *     used in plain-Node/test contexts where no Electron `userData` path
   *     exists.
   */
  private getEngineCacheRoot(): string {
    const envOverride = process.env['PULUMI_ENGINE_DIR'];
    if (envOverride) return resolve(envOverride);

    const userData = this.resolveUserDataPath();
    if (userData) return join(userData, 'pulumi');

    return join(tmpdir(), 'hyveon-pulumi-engine');
  }

  /**
   * Returns the Electron `userData` directory when running inside an
   * Electron process, or `null` otherwise. Duplicates
   * `ConfigService.readUserDataPath()`'s exact seam (lazy `createRequire`,
   * guarded on `process.versions['electron']`, `try/catch → null`) rather
   * than injecting `ConfigService` to reuse it: that accessor is `protected`
   * on `ConfigService` today (widening it to `public` would broaden that
   * service's surface for a single caller outside its own concern —
   * Terraform workspace paths — and `PulumiEngineService` has no other
   * reason to depend on `ConfigService` at all), and duplicating ten lines
   * keeps this service's constructor dependency-free, which is what makes
   * "construction is synchronous and never throws" trivially true rather
   * than something that depends on `ConfigService`'s own constructor
   * behaviour. `protected` (not `private`) so a test subclass can override
   * it to `public`, mirroring `ConfigService.test.ts`'s `TestableConfigService`.
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
