import { Injectable } from '@nestjs/common';
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';
import type { StackOutputs } from '@hyveon/shared';
import { logger } from '../logger.js';
import { ElectronStoreService } from './ElectronStoreService.js';
import { PulumiService } from './PulumiService.js';

/** Absolute path to the `dist/services/` directory at runtime. */
const _dirname = dirname(fileURLToPath(import.meta.url));

/**
 * Absolute path to the app root (`app/` in the repo, `/workspace/app/` in Docker).
 * Derived by walking 4 levels up from `dist/services/`.
 * Used only as a private dev-mode fallback inside instance methods — callers
 * should use `getServerConfigPath()` instead.
 */
const _APP_ROOT = join(_dirname, '..', '..', '..', '..');

/**
 * User-editable watchdog tuning knobs persisted to `server_config.json`.
 * Consumed by the watchdog Lambda via Terraform variables; the UI only
 * displays/edits them — changes require `terraform apply` to take effect.
 */
export interface WatchdogConfig {
  watchdog_interval_minutes: number;
  watchdog_idle_checks: number;
  watchdog_min_packets: number;
}

const DEFAULT_CONFIG: WatchdogConfig = {
  watchdog_interval_minutes: 15,
  watchdog_idle_checks: 4,
  watchdog_min_packets: 100,
};

/**
 * Default in-memory cache TTL (milliseconds) `TfvarsService` uses for the
 * parsed tfvars payload when `TFVARS_CACHE_TTL_MS` is unset or invalid.
 */
const DEFAULT_TFVARS_CACHE_TTL_MS = 30000;

/**
 * Identifier for the cloud provider the app is currently driving. A union
 * type (rather than a bare string) so additional providers can be added
 * without widening every consumer's type to `string`.
 */
export type ActiveCloud = 'aws';

/**
 * Owns every runtime configuration source the management app reads:
 *  - `server_config.json` — user-editable watchdog tunables. Path resolved
 *    by {@link ConfigService.getServerConfigPath}.
 *  - The deployed Pulumi stack's outputs — read via {@link getStackOutputs},
 *    a memoised delegate to {@link PulumiService.getStackOutputs}. This is
 *    the modern replacement for the old `terraform.tfstate`-parsing path
 *    (`getTfOutputs()`/`projectTfOutputs()`/`getTfStatePath()`), removed as
 *    dead code by task 7.10 — nothing reads a local tfstate file under the
 *    Pulumi engine.
 *  - A handful of process env vars (`AWS_DEFAULT_REGION`).
 *
 * `getServerConfigPath()` follows a three-tier priority:
 *  1. Env var override (`SERVER_CONFIG_PATH`) — always wins.
 *  2. Electron packaged build (`electron.app.isPackaged`) — `userData` for
 *     server config.
 *  3. Dev/test fallback — repo-relative path when not in a packaged build.
 *
 * Every other service injects this one instead of touching `process.env` or
 * reading files directly, so tests can stub env/file access cleanly.
 */
@Injectable()
export class ConfigService {
  /**
   * `electronStore` is the source of truth for the configured configuration
   * bucket name (`bootstrap.configurationBucket`, written by the First-Run
   * Wizard's bootstrap step — see {@link getConfigurationBucket}) and, since
   * task 7.4, the wizard-configured AWS region (`aws.region`) {@link getRegion}
   * now reads directly rather than through a deployed stack's outputs (see
   * that method's doc comment for why). `pulumiService` backs
   * {@link getStackOutputs} — see that method's doc comment for why the read
   * is exposed here rather than requiring every caller to depend on
   * `PulumiService` directly.
   */
  constructor(
    private readonly electronStore: ElectronStoreService,
    private readonly pulumiService: PulumiService,
  ) {}

  /**
   * Memoised {@link getStackOutputs} result, mirroring the old `tfCache`
   * field's tri-state shape and rationale — added because several callers (e.g.
   * `DiscordConfigService.getRedacted()`) read more than one field off a
   * single logical "the deployed config" via more than one call into this
   * class, and `getOrCreateStack()` + `stack.outputs()` is a genuinely
   * expensive round-trip (engine resolution, passphrase, S3 backend) to pay
   * twice for what should be one read. Stores the in-flight/settled
   * `Promise` itself (not just its resolved value) so concurrent callers
   * during the first read coalesce onto the same request rather than each
   * kicking off their own — mirrors `DiscordConfigService.inflight`'s
   * coalescing pattern. A *rejected* promise is deliberately NOT cached (see
   * {@link getStackOutputs}) — only a settled `null` ("not deployed") or a
   * real {@link StackOutputs} value are memoised.
   *
   * **Why a settled `null` still needs its own bounded TTL, not indefinite
   * caching:** `PulumiService.getStackOutputs()` (task 7.4's post-review fix)
   * degrades EVERY failure to a resolved `null` — a transient S3 blip, an
   * expired credential, a keychain hiccup all look identical to "genuinely
   * not deployed" from here. That's the right contract for callers (restores
   * the old `getTfOutputs()`'s never-throw guarantee), but it means a resolved
   * `null` is no longer proof of "not deployed" the way it was for `tfCache`
   * (which only ever cached `null` for an actually-missing/malformed file).
   * Caching it indefinitely would let one transient blip during, e.g., the
   * very first real deploy wedge the dashboard on "not deployed" forever —
   * especially now that the hot poll paths (`GamesController.listGames`/
   * `listStatus`, `DriftService.getDrift`) no longer call
   * {@link invalidateCache} on every tick (see those methods' own doc
   * comments for why that eager invalidation was removed). See
   * {@link STACK_OUTPUTS_NULL_TTL_MS} and {@link getStackOutputs} for the
   * TTL mechanics. A resolved {@link StackOutputs} value has no such
   * problem — a successful read really did observe a deployed stack — so it
   * stays cached with no TTL, cleared only by an explicit
   * {@link invalidateCache} call (expected from a future `up()`-completion
   * hook, per task 7.4's dispatch notes for whichever dispatch adds it).
   */
  private stackOutputsCache: Promise<StackOutputs | null> | undefined;

  /** `true` when {@link stackOutputsCache} last settled to `null` — read by {@link getStackOutputs} to decide whether {@link STACK_OUTPUTS_NULL_TTL_MS} applies. */
  private stackOutputsCacheIsNull = false;

  /** `Date.now()` at the moment {@link stackOutputsCache} last settled to `null` — the TTL clock {@link getStackOutputs} checks against {@link STACK_OUTPUTS_NULL_TTL_MS}. Meaningless while {@link stackOutputsCacheIsNull} is `false`. */
  private stackOutputsNullCachedAt = 0;

  /**
   * How long a resolved `null` from {@link getStackOutputs} stays cached
   * before the next call re-checks, rather than serving the stale `null`
   * indefinitely — see {@link stackOutputsCache}'s doc comment for why this
   * exists. 20 seconds: short enough that a transient failure self-heals
   * within roughly one dashboard status-poll cycle
   * (`GAME_STATUS_INTERVAL_MS`, `@hyveon/web`), long enough that it doesn't
   * reintroduce the "expensive round-trip on every poll tick" cost the
   * removal of eager `invalidateCache()` calls on the hot paths was meant to
   * avoid. Deliberately asymmetric with a genuine {@link StackOutputs}
   * value, which has no TTL at all (see that field's doc comment) — a
   * deployed stack doesn't need frequent re-verification, but a "not
   * deployed" reading (which may just be "the last check happened to fail")
   * should keep retrying.
   */
  private static readonly STACK_OUTPUTS_NULL_TTL_MS = 20_000;

  /**
   * Drop the cached {@link getStackOutputs} result. Called from the
   * `/api/games` and `/api/status` handlers so a fresh deploy is picked up
   * without a server restart; tests also call it between scenarios.
   */
  invalidateCache(): void {
    this.stackOutputsCache = undefined;
    this.stackOutputsCacheIsNull = false;
  }

  /**
   * Reads every value the app cares about off the deployed Pulumi stack —
   * task 7.4's async replacement for the old synchronous `getTfOutputs()`,
   * which every caller was migrated to as part of that dispatch.
   * `getTfOutputs()` itself, along with its `projectTfOutputs()`/
   * `getTfStatePath()`/`TfOutputs` support, was removed by task 7.10 once
   * nothing but `TerraformService.output()` still called it and
   * `TerraformService.ts` itself (and the `terraform.controller.ts` handler
   * that used to type its return value against `TfOutputs`) were deleted —
   * nothing reads a local `terraform.tfstate` file under the Pulumi engine
   * any more.
   *
   * A memoised delegate to {@link PulumiService.getStackOutputs} — see that
   * method's doc comment for the full "never deployed yet degrades to
   * `null`, never throws, period" contract and how it's implemented. Exposed
   * here (rather than requiring every one of the old `getTfOutputs()`'s ~14
   * call sites to take a new `PulumiService` constructor dependency) so that
   * migration's diff at each call site is the minimal `getTfOutputs()` →
   * `await getStackOutputs()` swap, mirroring how `ConfigService` already
   * re-exposes `ElectronStoreService.get('bootstrap')?.configurationBucket`
   * as {@link getConfigurationBucket} instead of making every
   * configuration-bucket reader depend on `ElectronStoreService` directly.
   *
   * Cached via {@link stackOutputsCache} — see that field's doc comment for
   * why (mirrors the old `getTfOutputs()`'s `tfCache`, plus in-flight
   * coalescing) and for why a resolved `null` additionally expires after
   * {@link STACK_OUTPUTS_NULL_TTL_MS} rather than staying cached forever.
   * Cleared unconditionally (both the value and the null-TTL clock) by
   * {@link invalidateCache}.
   */
  async getStackOutputs(): Promise<StackOutputs | null> {
    const cacheIsStale =
      this.stackOutputsCacheIsNull &&
      Date.now() - this.stackOutputsNullCachedAt >= ConfigService.STACK_OUTPUTS_NULL_TTL_MS;

    if (this.stackOutputsCache === undefined || cacheIsStale) {
      // Clear the stale-null flag BEFORE kicking off the refetch (not just
      // after it settles): otherwise a second concurrent call arriving while
      // this refetch is still in flight would see `stackOutputsCacheIsNull`
      // still `true` with its old (expired) timestamp, compute `cacheIsStale`
      // as `true` again, and kick off a REDUNDANT second refetch instead of
      // coalescing onto this one — defeating the whole point of caching the
      // in-flight promise. The `.then()` below sets it back to the real
      // value once this refetch actually settles.
      this.stackOutputsCacheIsNull = false;
      const pending = this.pulumiService.getStackOutputs().then(
        (result) => {
          this.stackOutputsCacheIsNull = result === null;
          this.stackOutputsNullCachedAt = Date.now();
          return result;
        },
        (err: unknown) => {
          // Don't let a transient failure wedge every subsequent call behind
          // a cached rejection — only a settled `null`/`StackOutputs` value
          // is worth memoising. (In practice `PulumiService.getStackOutputs()`
          // itself never rejects — see its own doc comment — so this branch
          // is defensive: it still holds if a future change to that
          // contract, or a bug, ever lets a rejection through here.)
          if (this.stackOutputsCache === pending) {
            this.stackOutputsCache = undefined;
          }
          throw err;
        },
      );
      this.stackOutputsCache = pending;
    }
    return this.stackOutputsCache;
  }

  /**
   * Read the AWS region hint from the process environment.
   * Extracted so tests can stub env access via `vi.spyOn` instead of
   * mutating `process.env` directly (which is flaky across tests).
   */
  readEnvRegion(): string | undefined {
    return process.env['AWS_DEFAULT_REGION'];
  }

  /**
   * Read the tfvars in-memory cache TTL override (milliseconds) from
   * `TFVARS_CACHE_TTL_MS`. Extracted for test-stubbing, mirroring
   * {@link readEnvRegion}.
   *
   * Defaults to {@link DEFAULT_TFVARS_CACHE_TTL_MS} (30s) when the env var is
   * unset, empty, not a finite number, or non-positive (zero included) — the
   * default is applied here rather than pushed onto callers.
   */
  readEnvTfvarsCacheTtlMs(): number {
    const raw = process.env['TFVARS_CACHE_TTL_MS'];
    if (raw === undefined || raw.length === 0) return DEFAULT_TFVARS_CACHE_TTL_MS;

    const parsed = Number(raw);
    if (!Number.isFinite(parsed) || parsed <= 0) {
      logger.warn('Invalid TFVARS_CACHE_TTL_MS value, using default', { raw });
      return DEFAULT_TFVARS_CACHE_TTL_MS;
    }
    return parsed;
  }

  /**
   * Return `process.resourcesPath` when running inside an Electron packaged app,
   * or `undefined` otherwise. Extracted as a protected method so tests can stub
   * it via `vi.spyOn` without touching `process.resourcesPath` directly.
   */
  protected readResourcesPath(): string | undefined {
    return (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath;
  }

  /**
   * Return whether the app is running as a packaged Electron build
   * (`electron.app.isPackaged`). `process.resourcesPath` is set in both dev
   * and packaged Electron processes, so it cannot be used as a packaged-build
   * guard — this method is the reliable alternative. Extracted as a protected
   * method so tests can stub it via `vi.spyOn`.
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
   * it via `vi.spyOn`.
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
   * Resolve the absolute path to `server_config.json`.
   *
   * Resolution order:
   *  1. `SERVER_CONFIG_PATH` env var — wins when set.
   *  2. Electron packaged app (`app.isPackaged`) — `<userData>/server_config.json`
   *     (user-writable location that survives app updates).
   *  3. Dev/test fallback — `<APP_ROOT>/server_config.json`.
   */
  getServerConfigPath(): string {
    const envOverride = process.env['SERVER_CONFIG_PATH'];
    if (envOverride) return envOverride;

    if (this.readIsPackaged()) {
      const userData = this.readUserDataPath();
      if (userData) {
        return join(userData, 'server_config.json');
      }
    }

    return join(_APP_ROOT, 'server_config.json');
  }

  /**
   * Resolve the configured S3 configuration bucket name — the sole source of
   * `TfvarsService`'s configuration JSON as of the `migrate-iac-to-pulumi`
   * change's Phase 6 ("Configuration persisted as versioned JSON"). Returns
   * `null` when no bucket is configured, which callers MUST treat as "setup
   * incomplete" — there is no local-file fallback any more (see
   * `TfvarsService.isConfigured()`).
   *
   * Resolution order:
   *  1. `HYVEON_TFVARS_BUCKET` env var — wins when set. A dev/CI convenience
   *     override (mirrors `scripts/tfvars-sync.ts`'s own independent env-var
   *     read for that CLI), not how the packaged app resolves the bucket in
   *     normal operator use.
   *  2. `ElectronStoreService`'s `bootstrap.configurationBucket` — the actual
   *     operator-configured value, submitted by the First-Run Wizard's
   *     bootstrap step (`WizardController.saveState`) and read back via
   *     `WizardController.getState`. This is the real post-Phase-5 source of
   *     truth, replacing the `.hyveon`/`.gsd` `tfvars-bucket` marker-file
   *     walk-up this method used to perform — that marker file existed only
   *     to support the CLI and the now-removed local-file mode; it never
   *     reflected what the desktop app itself had configured.
   *  3. `null` — no backend configured.
   */
  getConfigurationBucket(): string | null {
    const envOverride = this.readEnvTfvarsBucket();
    if (envOverride) return envOverride;

    return this.electronStore.get('bootstrap')?.configurationBucket ?? null;
  }

  /**
   * Read the `HYVEON_TFVARS_BUCKET` override from the process environment.
   * Extracted for test-stubbing, mirroring {@link readEnvRegion}.
   */
  readEnvTfvarsBucket(): string | undefined {
    return process.env['HYVEON_TFVARS_BUCKET'];
  }

  /**
   * Resolve the AWS region for SDK clients.
   *
   * Prior to task 7.4, this preferred the region the deployed stack's
   * outputs reported (`getTfOutputs()?.aws_region`). That source is now
   * async-only ({@link getStackOutputs}), and this method has many
   * synchronous callers across the app (SDK client construction,
   * `cloud-provider.module.ts`'s DI factories) that task 7.4's brief
   * explicitly did not ask to convert to async — so this method stays
   * synchronous by switching its preferred source to the wizard-configured
   * region (`ElectronStoreService`'s `aws.region`, set by the credentials
   * step and used by `BootstrapService` to create the state bucket itself —
   * see that service's own region resolution). This is a strictly better
   * source for this purpose anyway: it's known before anything is ever
   * deployed (unlike the old tfstate-derived value, which only existed
   * post-apply), and for a single-region-per-install app the two can never
   * legitimately disagree. Falls back to `AWS_DEFAULT_REGION`, then to
   * `us-east-1`, unchanged from before.
   */
  getRegion(): string {
    return (
      this.electronStore.get('aws')?.region ??
      this.readEnvRegion() ??
      'us-east-1'
    );
  }

  /**
   * Resolve the cloud provider the app is currently driving. Hardcoded to
   * `'aws'` for now — a config-driven value read from the future
   * electron-store-backed cloud profile will replace this constant once
   * multi-cloud support lands.
   */
  getActiveCloud(): ActiveCloud {
    return 'aws';
  }

  /**
   * Load the watchdog tunables from `server_config.json`, merged over the
   * built-in defaults so partially-populated files still work. Returns a
   * fresh object on every call — safe for callers to mutate.
   */
  getConfig(): WatchdogConfig {
    const serverConfigPath = this.getServerConfigPath();
    if (!existsSync(serverConfigPath)) return { ...DEFAULT_CONFIG };
    try {
      const saved = JSON.parse(readFileSync(serverConfigPath, 'utf-8')) as Partial<WatchdogConfig>;
      return { ...DEFAULT_CONFIG, ...saved };
    } catch (err) {
      logger.warn('Could not read config file, using defaults', { err });
      return { ...DEFAULT_CONFIG };
    }
  }

  /**
   * Persist the full watchdog config to `server_config.json`. Note: the
   * watchdog Lambda only reads these values via Terraform variables, so a
   * save here is not effective until the next `terraform apply`.
   */
  saveConfig(config: WatchdogConfig): void {
    writeFileSync(this.getServerConfigPath(), JSON.stringify(config, null, 2));
    logger.info('Config saved', config);
  }
}
