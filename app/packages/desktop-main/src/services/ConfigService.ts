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
 *    a memoised delegate to {@link PulumiService.getStackOutputs}.
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
   * Wizard's bootstrap step — see {@link getConfigurationBucket}) and the
   * wizard-configured AWS region (`aws.region`), which {@link getRegion}
   * reads directly rather than through a deployed stack's outputs (see that
   * method's doc comment for why). `pulumiService` backs
   * {@link getStackOutputs} — exposed here rather than requiring every
   * caller to depend on `PulumiService` directly.
   */
  constructor(
    private readonly electronStore: ElectronStoreService,
    private readonly pulumiService: PulumiService,
  ) {}

  /**
   * Memoised {@link getStackOutputs} result. Several callers (e.g.
   * `DiscordConfigService.getRedacted()`) read more than one field off the
   * deployed config via more than one call into this class, and
   * `getOrCreateStack()` + `stack.outputs()` is a genuinely expensive
   * round-trip (engine resolution, passphrase, S3 backend) to pay twice for
   * what should be one read. Stores the in-flight/settled `Promise` itself
   * (not just its resolved value) so concurrent callers during the first
   * read coalesce onto the same request rather than each kicking off their
   * own. A *rejected* promise is deliberately NOT cached (see
   * {@link getStackOutputs}) — only a settled `null` ("not deployed") or a
   * real {@link StackOutputs} value are memoised.
   *
   * **Why a settled `null` still needs its own bounded TTL, not indefinite
   * caching:** `PulumiService.getStackOutputs()` degrades EVERY failure to a
   * resolved `null` — a transient S3 blip, an expired credential, a
   * keychain hiccup all look identical to "genuinely not deployed" from
   * here. That's the right contract for callers, but it means a resolved
   * `null` is not proof of "not deployed". Caching it indefinitely would let
   * one transient blip wedge the dashboard on "not deployed" forever —
   * especially since the hot poll paths (`GamesController.listGames`/
   * `listStatus`, `DriftService.getDrift`) no longer call
   * {@link invalidateCache} on every tick. See
   * {@link STACK_OUTPUTS_NULL_TTL_MS} and {@link getStackOutputs} for the
   * TTL mechanics. A resolved {@link StackOutputs} value has no such
   * problem — a successful read really did observe a deployed stack — so it
   * stays cached with no TTL, cleared only by an explicit
   * {@link invalidateCache} call.
   */
  private stackOutputsCache: Promise<StackOutputs | null> | undefined;

  /** `true` when {@link stackOutputsCache} last settled to `null` — read by {@link getStackOutputs} to decide whether {@link STACK_OUTPUTS_NULL_TTL_MS} applies. */
  private stackOutputsCacheIsNull = false;

  /** `Date.now()` at the moment {@link stackOutputsCache} last settled to `null` — the TTL clock {@link getStackOutputs} checks against {@link STACK_OUTPUTS_NULL_TTL_MS}. Meaningless while {@link stackOutputsCacheIsNull} is `false`. */
  private stackOutputsNullCachedAt = 0;

  /**
   * How long a resolved `null` from {@link getStackOutputs} stays cached
   * before the next call re-checks, rather than serving the stale `null`
   * indefinitely — see {@link stackOutputsCache} for why this exists. 20
   * seconds: short enough that a transient failure self-heals within
   * roughly one dashboard status-poll cycle (`GAME_STATUS_INTERVAL_MS`,
   * `@hyveon/web`), long enough that it doesn't reintroduce an expensive
   * round-trip on every poll tick. Deliberately asymmetric with a genuine
   * {@link StackOutputs} value, which has no TTL at all — a deployed stack
   * doesn't need frequent re-verification, but a "not deployed" reading
   * (which may just be "the last check happened to fail") should keep
   * retrying.
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
   * Reads every value the app cares about off the deployed Pulumi stack. A
   * memoised delegate to {@link PulumiService.getStackOutputs} — see that
   * method's doc comment for the full "never deployed yet degrades to
   * `null`, never throws" contract. Exposed here (rather than requiring
   * every caller to take a `PulumiService` constructor dependency) so
   * callers only need `ConfigService`, mirroring how `ConfigService` also
   * re-exposes `ElectronStoreService.get('bootstrap')?.configurationBucket`
   * as {@link getConfigurationBucket}.
   *
   * Cached via {@link stackOutputsCache} — see that field's doc comment for
   * the caching/coalescing behavior and for why a resolved `null`
   * additionally expires after {@link STACK_OUTPUTS_NULL_TTL_MS} rather than
   * staying cached forever. Cleared unconditionally (both the value and the
   * null-TTL clock) by {@link invalidateCache}.
   */
  async getStackOutputs(): Promise<StackOutputs | null> {
    const cacheIsStale =
      this.stackOutputsCacheIsNull &&
      Date.now() - this.stackOutputsNullCachedAt >= ConfigService.STACK_OUTPUTS_NULL_TTL_MS;

    if (this.stackOutputsCache === undefined || cacheIsStale) {
      // Clear the stale-null flag BEFORE kicking off the refetch, not after:
      // otherwise a second concurrent call arriving mid-refetch would see
      // the old flag/timestamp, compute `cacheIsStale` as `true` again, and
      // kick off a redundant second refetch instead of coalescing onto this
      // one. The `.then()` below sets it back to the real value once this
      // refetch settles.
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
          // is worth memoising. In practice `PulumiService.getStackOutputs()`
          // never rejects (see its own doc comment), so this branch is
          // defensive.
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
   * `TfvarsService`'s configuration JSON. Returns `null` when no bucket is
   * configured, which callers MUST treat as "setup incomplete" — there is no
   * local-file fallback (see `TfvarsService.isConfigured()`).
   *
   * Resolution order:
   *  1. `HYVEON_TFVARS_BUCKET` env var — wins when set. A dev/CI convenience
   *     override (mirrors `scripts/tfvars-sync.ts`'s own independent env-var
   *     read for that CLI), not how the packaged app resolves the bucket in
   *     normal operator use.
   *  2. `ElectronStoreService`'s `bootstrap.configurationBucket` — the actual
   *     operator-configured value, submitted by the First-Run Wizard's
   *     bootstrap step (`WizardController.saveState`) and read back via
   *     `WizardController.getState`. This is the real source of truth.
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
   * Prefers the wizard-configured region (`ElectronStoreService`'s
   * `aws.region`, set by the credentials step and used by `BootstrapService`
   * to create the state bucket itself) over the deployed stack's own output,
   * since this method has many synchronous callers across the app (SDK
   * client construction, `cloud-provider.module.ts`'s DI factories) and
   * {@link getStackOutputs} is async-only. This is also the better source
   * for this purpose: it's known before anything is ever deployed, and for a
   * single-region-per-install app the two values can never legitimately
   * disagree. Falls back to `AWS_DEFAULT_REGION`, then to `us-east-1`.
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
