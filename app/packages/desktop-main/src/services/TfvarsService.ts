/**
 * Reads and parses the app's JSON deployment configuration into the
 * `GameServer[]` shape declared by `@hyveon/shared/tfvars.js` (which mirrors
 * `terraform/variables.tf`'s retired `game_servers` map — see the
 * `migrate-iac-to-pulumi` OpenSpec change).
 *
 * The operator's versioned S3 configuration bucket
 * (`ConfigService.getConfigurationBucket()`) is the ONLY configuration
 * source — see `openspec/specs/desktop-only-operator-surface`'s "No
 * operator-editable configuration files" requirement and
 * `pulumi-infra-program`'s "Configuration persisted as versioned JSON". There
 * is no local-file fallback: when no bucket is configured, every method on
 * this class reports "setup incomplete" rather than reading/writing a path
 * on disk — see {@link isConfigured}, {@link ConfigurationNotConfiguredError},
 * and {@link getGameServers}'s own doc for exactly what that means per
 * method.
 *
 * The raw text is `JSON.parse()`d directly into a `DeploymentConfig`
 * (`@hyveon/shared/deploymentConfig.js`) — no HCL parsing is involved any
 * more (see the `migrate-iac-to-pulumi` change's Phase 6, "Configuration
 * persisted as versioned JSON") — and its `gameServers` record is flattened
 * into a `GameServer[]` with the map key attached as `name`.
 *
 * Parsed results are cached in-memory for `ConfigService.readEnvTfvarsCacheTtlMs()`
 * milliseconds so frequent callers (e.g. polling endpoints) don't re-fetch
 * from S3 on every call. Call `invalidateCache()` to force a fresh read
 * before the TTL elapses (e.g. after a config edit). The cache mirrors
 * `ConfigService.tfCache`'s tri-state approach: `undefined` means "never
 * loaded" (always a miss), while a set `CachedGameServers` entry covers
 * *both* a successful parse and a negatively-cached failed load (the
 * `failed` flag distinguishes the two) — either way the entry's `cachedAt`
 * governs the TTL, so a broken source isn't re-hit on every call within the
 * TTL window.
 *
 * `getGameServers()` never rejects — a missing S3 object, an unconfigured
 * bucket, a missing `gameServers` key, or malformed JSON are all logged via
 * the shared Winston `logger` and resolve to `[]`, mirroring `ConfigService`'s
 * graceful degradation for polling callers.
 *
 * `addGameServer()`, `updateGameServer()`, and `removeGameServer()` (see
 * issue #96, updated for the JSON migration) are the write-side counterpart:
 * they read the current `DeploymentConfig` JSON, mutate the `gameServers`
 * record, and `JSON.stringify` the result back — a plain, lossless
 * serialize/deserialize round trip, unlike the byte-preserving HCL splice
 * this service used before the migration. The write is a conditional
 * `RemoteFileStore.put()` guarded by an `ifMatch` etag; a stale etag is
 * translated from the store's `RemoteFileConflictError` into an
 * `OptimisticLockError` so callers only ever need to handle one conflict type
 * regardless of cloud provider.
 */
import { Inject, Injectable } from '@nestjs/common';
import { CONFIGURATION_OBJECT_KEY, DEPLOYMENT_CONFIG_DEFAULTS } from '@hyveon/shared';
import type { DeploymentConfig, GameServer, GameServerConfig, RemoteFileStore } from '@hyveon/shared';
import {
  GAME_NAME_PATTERN,
  GAME_NAME_PATTERN_DESCRIPTION,
  OptimisticLockError,
  RemoteFileConflictError,
  resolveRunsTableName,
  withDeploymentConfigDefaults,
} from '@hyveon/shared';
import { logger } from '../logger.js';
import { ConfigService } from './ConfigService.js';
import { REMOTE_FILE_STORE } from '../modules/cloud-provider.tokens.js';

/**
 * Raw JSON-decoded shape of a single `gameServers` map entry, before the map
 * key is flattened onto it as `name`. Structurally identical to `GameServer`
 * minus the `name` field (the same shape `@hyveon/shared`'s
 * `GameServerConfig` alias already names) — kept as a local alias since it
 * also doubles as the write-side "config" parameter shape for
 * {@link TfvarsService.addGameServer} and {@link TfvarsService.updateGameServer},
 * since `name` is supplied separately as the `gameServers` map key in both
 * directions.
 */
type RawGameServerEntry = GameServerConfig;

/**
 * In-memory cache entry: the resolved value (empty on failure), the
 * timestamp it was resolved at, and whether that resolution was a failure
 * (negatively cached) rather than a genuine successful parse.
 */
interface CachedGameServers {
  value: GameServer[];
  cachedAt: number;
  failed: boolean;
}

/**
 * Categorizes why a {@link GameServerEntryError} was thrown, so callers
 * (e.g. `GamesWriteService`) can distinguish a name-specific failure from a
 * not-found or structural one instead of collapsing every error into the
 * same result shape:
 *  - `'invalid-name'` — the proposed entry key isn't a valid game name (see
 *    {@link assertValidGameName}).
 *  - `'duplicate-name'` — the proposed entry key already exists in
 *    `gameServers`.
 *  - `'not-found'` — the named entry doesn't exist in `gameServers` (the
 *    `updateGameServer`/`removeGameServer` case).
 *  - `'structural'` — the deployment config JSON itself is malformed or
 *    missing its `gameServers` map entirely.
 */
export type GameServerEntryErrorReason = 'invalid-name' | 'duplicate-name' | 'not-found' | 'structural';

/**
 * Thrown by {@link TfvarsService}'s write methods (`addGameServer`/
 * `updateGameServer`/`removeGameServer`) for any `gameServers`-entry-level
 * failure — invalid/duplicate/missing entry names as well as structural
 * config-document issues. Replaces the retired `hclSurgeon.ts`'s
 * `HclSurgeonError` one-for-one for `GamesWriteService`'s purposes — see
 * {@link GameServerEntryErrorReason} for the specific `reason` this carries.
 */
export class GameServerEntryError extends Error {
  /** Why this error was thrown — see {@link GameServerEntryErrorReason}. Defaults to `'structural'` for call sites that don't have a more specific reason to report. */
  readonly reason: GameServerEntryErrorReason;

  constructor(message: string, reason: GameServerEntryErrorReason = 'structural') {
    super(message);
    this.reason = reason;
  }
}

/**
 * Thrown by every {@link TfvarsService} method that reads or writes
 * configuration content — {@link TfvarsService.getRawConfig},
 * {@link TfvarsService.addGameServer}, {@link TfvarsService.updateGameServer},
 * {@link TfvarsService.removeGameServer}, and
 * {@link TfvarsService.restoreRawTfvars} — when no configuration bucket is
 * configured (`ConfigService.getConfigurationBucket()` returns `null`).
 *
 * A typed, recognizable error rather than letting `AwsRemoteFileStore`'s
 * generic "bucket not configured" `Error` (thrown deep inside the
 * `RemoteFileStore` implementation) surface verbatim — callers that need to
 * distinguish "setup incomplete" from an ordinary I/O failure can check
 * `instanceof ConfigurationNotConfiguredError` instead of pattern-matching an
 * error message. Thrown by `TfvarsService` itself, before ever calling into
 * `RemoteFileStore`, so no disk or network access is attempted for an
 * unconfigured bucket.
 *
 * {@link TfvarsService.getGameServers} does NOT throw this — its contract is
 * to never reject, so it catches this (like any other read failure) and
 * resolves to `[]` instead. Use {@link TfvarsService.isConfigured} to
 * distinguish "unconfigured" from "genuinely zero games" when that
 * distinction matters (e.g. wizard-routing UI).
 */
export class ConfigurationNotConfiguredError extends Error {
  constructor() {
    super(
      'No configuration bucket is configured — finish the First-Run Wizard before reading or writing ' +
        'deployment configuration. There is no local-file fallback.',
    );
    this.name = 'ConfigurationNotConfiguredError';
  }
}

/**
 * Thrown by {@link TfvarsService.updateTopLevelSettings} when a proposed
 * patch would change the deployment's EFFECTIVE (resolved) run-history table
 * name — i.e. `projectName` and/or `runsTableName` shift such that
 * `resolveRunsTableName(nextProjectName, nextRunsTableNameOverride)` no
 * longer equals the current document's resolved name.
 *
 * @remarks
 * `BootstrapService.ensureRunsTable` physically creates the run-history
 * DynamoDB table exactly once, at first-run-wizard bootstrap time, under
 * whatever name resolves from the config document's state at that moment —
 * today, always `resolveRunsTableName(DEPLOYMENT_CONFIG_DEFAULTS.projectName, '')`
 * (`WizardController.bootstrapRunsTable`'s own doc comment explains why: the
 * wizard collects no `projectName`/`runsTableName` override of its own).
 * Every `updateTopLevelSettings` call reachable from the Settings form is
 * therefore, by construction, a POST-bootstrap edit — Settings is only ever
 * reachable once setup has completed. Letting `projectName`/`runsTableName`
 * change after that point would silently point every runs-table resolver
 * (`resolveRunsTableName` itself, `resolvePreApplyRunsTableName`, the Pulumi
 * stack output) at a table that was never created under the new name,
 * leaving `RunRecordService`'s approve/apply gates to fail with a raw,
 * confusing DynamoDB `ResourceNotFoundException` instead of a clear,
 * actionable error — this class IS that clear error. `IacSettingsController.update`
 * catches it and maps it to a `code: 'validation'` result positioned against
 * exactly the field(s) the caller actually tried to change, so
 * `deployment-settings-form.component.tsx`'s existing per-field issue
 * rendering (`messagesForField`) displays it with no UI changes needed.
 */
export class RunsTableRenameError extends Error {
  /** Which patch field(s) actually contributed to the resolved-name change — `'projectName'`, `'runsTableName'`, or both. */
  readonly fields: Array<'projectName' | 'runsTableName'>;

  constructor(currentTableName: string, nextTableName: string, fields: Array<'projectName' | 'runsTableName'>) {
    super(
      `This change would rename the run-history table from "${currentTableName}" to "${nextTableName}" — the ` +
        'physical DynamoDB table was already created under the original name during the bootstrap wizard step ' +
        "and can't be renamed automatically. Revert this field, or manually recreate/migrate the DynamoDB table " +
        'before changing it.',
    );
    this.name = 'RunsTableRenameError';
    this.fields = fields;
  }
}

/**
 * Throws {@link GameServerEntryError} (`reason: 'invalid-name'`) unless
 * `name` matches `@hyveon/shared`'s {@link GAME_NAME_PATTERN} — see that
 * constant's doc for the full DNS-safety rationale and why it's exported
 * from `gameServerValidator.ts` rather than duplicated here (this exact
 * duplication once caused the web wizard's client-side check to drift onto
 * the retired HCL-identifier pattern instead). Called before any parsing of
 * the current config document — this check needs only the proposed `name`
 * itself, so it stays cheap and fails fast regardless of the underlying
 * config's state.
 */
function assertValidGameName(name: string): void {
  if (!GAME_NAME_PATTERN.test(name)) {
    throw new GameServerEntryError(
      `Game name "${name}" is invalid — must be ${GAME_NAME_PATTERN_DESCRIPTION} so it can be used as both the ` +
        'config key and a DNS label / AWS resource-name component.',
      'invalid-name',
    );
  }
}

/** Narrows `value` to a plain, non-array object — used to validate both the top-level parsed JSON and its `gameServers` field. */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Local-vs-S3 deployment-config reader/parser — see the file-level doc
 * comment above for source resolution, parsing, and caching behaviour.
 */
@Injectable()
export class TfvarsService {
  private cache: CachedGameServers | null = null;

  /**
   * Monotonically incremented by {@link invalidateCache}. `getGameServers()`
   * snapshots this value before starting a fetch and only commits the result
   * to `this.cache` if the counter is unchanged when the fetch resolves —
   * this stops a late-resolving fetch that was already in flight when
   * `invalidateCache()` was called from resurrecting a stale, pre-invalidation
   * parse with a fresh `cachedAt` (which would otherwise serve stale data for
   * a full TTL window despite the explicit invalidation).
   */
  private cacheGeneration = 0;

  /**
   * `remoteFileStore` is typed against the cloud-agnostic `RemoteFileStore`
   * contract (not a concrete AWS class) so this service depends only on the
   * interface; `@Inject(REMOTE_FILE_STORE)` tells Nest which concrete
   * provider (bound by `CloudProviderModule` for whichever cloud is active)
   * to resolve for that parameter.
   */
  constructor(
    private readonly config: ConfigService,
    @Inject(REMOTE_FILE_STORE) private readonly remoteFileStore: RemoteFileStore,
  ) {}

  /**
   * Current time in milliseconds, extracted so tests can stub it via
   * `vi.spyOn` to simulate TTL expiry without real timers (mirrors
   * `ConfigService`'s protected `read*` accessors).
   */
  protected now(): number {
    return Date.now();
  }

  /**
   * Drop the in-memory cache so the next `getGameServers()` call re-reads
   * from disk/S3 instead of returning a stale parse. Called after a config
   * write (e.g. via `scripts/tfvars-sync.ts pull`) and by tests between
   * scenarios.
   */
  invalidateCache(): void {
    this.cache = null;
    this.cacheGeneration += 1;
  }

  /**
   * Reports whether a configuration bucket is currently configured
   * (`ConfigService.getConfigurationBucket()` resolves non-`null`) — i.e.
   * whether setup is complete enough for this service to read/write real
   * configuration content. Lets a caller distinguish "unconfigured" from
   * "configured but genuinely zero games" for wizard-routing purposes,
   * since {@link getGameServers} resolves to `[]` in both cases (its
   * never-reject contract means it can't surface that distinction itself).
   */
  isConfigured(): boolean {
    return this.config.getConfigurationBucket() !== null;
  }

  /**
   * Returns the `gameServers` map from the deployment config JSON, parsed
   * into a `GameServer[]` (the map key is flattened onto each entry as
   * `name`).
   *
   * Returns a cached result when the last resolution (success *or* failure)
   * is younger than `ConfigService.readEnvTfvarsCacheTtlMs()`; otherwise
   * reads/parses fresh and re-caches. Never rejects: an unconfigured bucket
   * (see {@link isConfigured}), a missing S3 object, a missing `gameServers`
   * key, or malformed JSON are logged and resolved to `[]` (and negatively
   * cached for the TTL window) rather than thrown, so polling callers
   * degrade gracefully instead of crashing.
   */
  async getGameServers(): Promise<GameServer[]> {
    const ttl = this.config.readEnvTfvarsCacheTtlMs();
    if (this.cache && this.now() - this.cache.cachedAt < ttl) {
      logger.debug('tfvars cache hit', { failed: this.cache.failed, cachedAt: this.cache.cachedAt });
      return this.cache.value;
    }

    logger.debug('tfvars cache miss — loading deployment config', {});

    const generation = this.cacheGeneration;

    try {
      const { config: raw } = await this.fetchRawConfig();
      const value = this.flattenGameServers(this.parseConfigContents(raw));
      if (generation === this.cacheGeneration) {
        this.cache = { value, cachedAt: this.now(), failed: false };
      }
      logger.info('Loaded deployment config gameServers', { count: value.length });
      return value;
    } catch (err) {
      if (err instanceof ConfigurationNotConfiguredError) {
        // Expected pre-wizard-completion state, not a failure — logged at
        // `warn` rather than `error` so a routine "setup incomplete" poll
        // doesn't read as a genuine incident.
        logger.warn('No configuration bucket configured — returning empty gameServers list', {});
      } else {
        logger.error('Failed to load deployment config gameServers — returning empty list', { err });
      }
      if (generation === this.cacheGeneration) {
        this.cache = { value: [], cachedAt: this.now(), failed: true };
      }
      return [];
    }
  }

  /**
   * Returns the raw, unparsed deployment config JSON text plus a source
   * integrity marker: the `RemoteFileStore.get()` etag (as `etag`) — the same
   * value `RemoteFileStore.put()` expects as its `ifMatch` guard, so callers
   * can round-trip a conditional write. This is distinct from
   * `RemoteFileStore.listVersions()`'s `versionId`, which identifies a
   * specific S3 object version rather than an etag — the two are not
   * comparable. Unlike {@link getGameServers}, this bypasses the in-memory
   * cache and rejects (rather than swallowing) a missing object or an
   * unconfigured bucket — callers that need the raw text (e.g. an editor)
   * want to know immediately if the source is unreadable/unconfigured rather
   * than silently getting stale/empty data.
   *
   * @throws {@link ConfigurationNotConfiguredError} when no configuration
   *   bucket is configured.
   */
  async getRawConfig(): Promise<{ config: string; etag?: string }> {
    return this.fetchRawConfig();
  }

  /**
   * Restores `rawConfig` as the config source's new head version verbatim —
   * used by the rollback flow (#112) to write a prior version's exact bytes
   * back as a fresh S3 version (history is append-only; this never deletes
   * or reverts an existing version) rather than applying a
   * `gameServers`-specific mutation like {@link addGameServer}/
   * {@link updateGameServer}/{@link removeGameServer} do. Always an
   * unconditional write (no `expectedVersionId` guard) — rollback is
   * explicitly restoring known historic content, not editing the current
   * head against an expected prior state. Invalidates the in-memory
   * {@link getGameServers} cache afterward so the next read reflects the
   * restored content, mirroring {@link writeConfig}.
   *
   * @param rawConfig - The exact historic config content to restore.
   * @returns The write's `{ etag, versionId }` — see {@link putRawConfig}.
   * @throws {@link ConfigurationNotConfiguredError} when no configuration
   *   bucket is configured.
   */
  async restoreRawTfvars(rawConfig: string): Promise<{ etag: string; versionId?: string }> {
    const result = await this.putRawConfig(rawConfig);
    this.invalidateCache();
    return result;
  }

  /**
   * Returns every top-level {@link DeploymentConfig} field EXCEPT
   * `gameServers` (see {@link TopLevelDeploymentSettings}), plus the
   * `RemoteFileStore` etag to round-trip as {@link updateTopLevelSettings}'s
   * `expectedVersionId` — mirrors {@link getRawConfig}'s own `{ config, etag }`
   * shape. Bypasses the in-memory `getGameServers()` cache (like
   * {@link getRawConfig}) and rejects (rather than swallowing) a missing
   * object or an unconfigured bucket — task 9.7's Settings form wants to know
   * immediately if the source is unreadable/unconfigured rather than
   * silently rendering stale/empty fields.
   *
   * Runs the parsed document through {@link withDeploymentConfigDefaults}
   * before stripping `gameServers` off, so the returned `settings` object
   * genuinely satisfies its `Omit<DeploymentConfig, 'gameServers'>` type at
   * RUNTIME, not just at the type-checker level. This matters because
   * `parseConfigContents()` only validates that the parsed JSON is *an
   * object* (see its own doc comment) — a stored document that predates a
   * field (e.g. `baseAllowedGuilds` added after that document was last
   * written by an older app version) parses successfully with that field
   * simply absent, and every field the type declares as required
   * (`string[]`, `number`, ...) would otherwise reach the renderer as
   * `undefined` — which crashed the Settings form's `.map()` over the
   * three Discord-ID arrays (task 9.7 review round 1, finding I2) before
   * this defaulting was added. `withDeploymentConfigDefaults` is a safe,
   * idempotent no-op on an already-complete document (review round 1
   * confirmed it has zero other production call sites in this repo before
   * this fix), and never touches `gameServers` itself — it passes that
   * field through verbatim (no default value), which is immediately
   * discarded below anyway.
   *
   * @throws {@link ConfigurationNotConfiguredError} when no configuration
   *   bucket is configured.
   */
  async getTopLevelSettings(): Promise<{ settings: Omit<DeploymentConfig, 'gameServers'>; etag?: string }> {
    const { config: raw, etag } = await this.fetchRawConfig();
    const defaulted = withDeploymentConfigDefaults(this.parseConfigContents(raw));
    const { gameServers: _gameServers, ...settings } = defaulted;
    return { settings, etag };
  }

  /**
   * Merges `patch` onto every top-level {@link DeploymentConfig} field
   * EXCEPT `gameServers` (see {@link TopLevelDeploymentSettings}) and writes
   * the result back via {@link writeConfig} — see that method's doc for the
   * conditional-put / `OptimisticLockError` contract. Follows
   * {@link addGameServer}'s exact shape (read current raw config, apply a
   * mutation, delegate to {@link writeConfig}) rather than a different
   * pattern.
   *
   * `gameServers` is guaranteed to survive completely untouched: the merge
   * always takes `gameServers` from the freshly-parsed current document,
   * never from `patch`, regardless of what `patch` contains at runtime — see
   * {@link applyTopLevelSettingsPatch}'s doc comment for why this is a
   * runtime guarantee, not just a compile-time one (`patch` arrives over the
   * IPC boundary as plain JSON, where TypeScript's `Omit` offers no
   * protection).
   *
   * @param patch - Fields to merge onto the current settings; an omitted
   *   field keeps its current stored value.
   * @param expectedVersionId - The etag last read (e.g. via
   *   {@link getTopLevelSettings}), used as the conditional-put guard; omit
   *   to write unconditionally. Every real caller (the renderer's settings
   *   form) always supplies it — see {@link getTopLevelSettings}'s doc
   *   comment — omission is only supported for parity with
   *   {@link addGameServer}/{@link updateGameServer}'s own convention.
   * @returns The written object's new `etag` plus an optional `versionId`
   *   when the underlying store supports object versioning — see
   *   {@link writeConfig}/{@link putRawConfig}.
   * @throws {@link ConfigurationNotConfiguredError} when no configuration
   *   bucket is configured.
   */
  async updateTopLevelSettings(
    patch: Partial<Omit<DeploymentConfig, 'gameServers'>>,
    expectedVersionId?: string,
  ): Promise<{ etag: string; versionId?: string }> {
    return this.writeConfig(expectedVersionId, (raw) => this.applyTopLevelSettingsPatch(raw, patch));
  }

  /**
   * Adds a brand-new entry to the `gameServers` map (see issue #96). Reads
   * the current raw config JSON, splices `name` in as a new `gameServers`
   * key, and writes the result back via {@link writeConfig} — see that
   * method's doc for the conditional-put / `OptimisticLockError`
   * contract. Throws {@link GameServerEntryError} if `name` fails
   * {@link assertValidGameName}, if `name` already exists in `gameServers`,
   * or if the config document parses but its `gameServers` map is missing/
   * not an object. A malformed-JSON parse failure also propagates from here,
   * but as a plain `Error` (from {@link parseConfigContents}), not a
   * {@link GameServerEntryError}.
   *
   * @param name - The `gameServers` map key to add.
   * @param config - The new entry's fields (everything but `name`, which is
   *   the map key rather than an object attribute).
   * @param expectedVersionId - The etag last read (e.g. via {@link getRawConfig}),
   *   used as the conditional-put guard; omit to write unconditionally.
   * @returns The written object's new `etag` plus an optional `versionId`
   *   when the underlying store supports object versioning — see
   *   {@link writeConfig}/{@link putRawConfig}.
   * @throws {@link ConfigurationNotConfiguredError} when no configuration
   *   bucket is configured.
   */
  async addGameServer(
    name: string,
    config: RawGameServerEntry,
    expectedVersionId?: string,
  ): Promise<{ etag: string; versionId?: string }> {
    return this.writeConfig(expectedVersionId, (raw) => this.insertGameServerEntry(raw, name, config));
  }

  /**
   * Replaces an existing `gameServers` entry's value in place (see issue
   * #96). Reads the current raw config JSON, replaces `name`'s value, and
   * writes the result back via {@link writeConfig} — see that method's doc
   * for the conditional-put / `OptimisticLockError` contract. Throws
   * {@link GameServerEntryError} (`reason: 'not-found'`) if `name` doesn't
   * already exist in `gameServers`, or (`reason: 'structural'`) if the
   * config document parses but its `gameServers` map is missing/not an
   * object. A malformed-JSON parse failure also propagates from here, but as
   * a plain `Error` (from {@link parseConfigContents}), not a
   * {@link GameServerEntryError}.
   *
   * @param name - The `gameServers` map key to update.
   * @param config - The entry's new fields (everything but `name`).
   * @param expectedVersionId - The etag last read (e.g. via {@link getRawConfig}),
   *   used as the conditional-put guard; omit to write unconditionally.
   * @returns The written object's new `etag` plus an optional `versionId`
   *   when the underlying store supports object versioning — see
   *   {@link writeConfig}/{@link putRawConfig}.
   * @throws {@link ConfigurationNotConfiguredError} when no configuration
   *   bucket is configured.
   */
  async updateGameServer(
    name: string,
    config: RawGameServerEntry,
    expectedVersionId?: string,
  ): Promise<{ etag: string; versionId?: string }> {
    return this.writeConfig(expectedVersionId, (raw) => this.replaceGameServerEntry(raw, name, config));
  }

  /**
   * Removes an entry from the `gameServers` map (see issue #96). Reads the
   * current raw config JSON, deletes `name`'s key, and writes the result
   * back via {@link writeConfig} — see that method's doc for the
   * conditional-put / `OptimisticLockError` contract. Throws
   * {@link GameServerEntryError} (`reason: 'not-found'`) if `name` doesn't
   * exist in `gameServers`, or (`reason: 'structural'`) if the config
   * document parses but its `gameServers` map is missing/not an object. A
   * malformed-JSON parse failure also propagates from here, but as a plain
   * `Error` (from {@link parseConfigContents}), not a
   * {@link GameServerEntryError}.
   *
   * @param name - The `gameServers` map key to remove.
   * @param expectedVersionId - The etag last read (e.g. via {@link getRawConfig}),
   *   used as the conditional-put guard; omit to write unconditionally.
   * @returns The written object's new `etag` plus an optional `versionId`
   *   when the underlying store supports object versioning — see
   *   {@link writeConfig}/{@link putRawConfig}.
   * @throws {@link ConfigurationNotConfiguredError} when no configuration
   *   bucket is configured.
   */
  async removeGameServer(
    name: string,
    expectedVersionId?: string,
  ): Promise<{ etag: string; versionId?: string }> {
    return this.writeConfig(expectedVersionId, (raw) => this.removeGameServerEntry(raw, name));
  }

  /**
   * Reads the raw config JSON text from the configured S3 configuration
   * bucket (`ConfigService.getConfigurationBucket()`). Throws
   * {@link ConfigurationNotConfiguredError} when no bucket is configured —
   * BEFORE touching `RemoteFileStore` at all, so an unconfigured setup never
   * issues a network call (let alone a disk read; there is no local-file
   * fallback) — or a plain `Error` when the object doesn't exist in an
   * otherwise-configured bucket. Shared by {@link getGameServers} (which
   * catches and swallows both) and {@link getRawConfig} (which lets both
   * propagate).
   */
  private async fetchRawConfig(): Promise<{ config: string; etag?: string }> {
    const bucket = this.config.getConfigurationBucket();
    if (!bucket) {
      throw new ConfigurationNotConfiguredError();
    }

    const obj = await this.remoteFileStore.get(CONFIGURATION_OBJECT_KEY);
    if (!obj) {
      throw new Error(`Deployment config object "${CONFIGURATION_OBJECT_KEY}" not found in S3 bucket "${bucket}".`);
    }
    return { config: new TextDecoder().decode(obj.body), etag: obj.etag };
  }

  /**
   * Shared write path for {@link addGameServer}, {@link updateGameServer},
   * and {@link removeGameServer}: reads the current raw config JSON via
   * {@link fetchRawConfig}, applies `mutate` to it, writes the mutated text
   * back via {@link putRawConfig} (a conditional `RemoteFileStore.put()`),
   * and invalidates the in-memory `getGameServers()` cache so the next read
   * reflects the write. `mutate` running before the write (rather than
   * concurrently) keeps the conditional-put guard meaningful —
   * `expectedVersionId` is checked against the store's current etag at write
   * time, so a conflicting write since `fetchRawConfig` ran is still caught
   * even though `mutate` itself is synchronous.
   *
   * @returns The write's `{ etag, versionId }` — see {@link putRawConfig}.
   */
  private async writeConfig(
    expectedVersionId: string | undefined,
    mutate: (raw: string) => string,
  ): Promise<{ etag: string; versionId?: string }> {
    const { config: raw } = await this.fetchRawConfig();
    const mutated = mutate(raw);
    const result = await this.putRawConfig(mutated, expectedVersionId);
    this.invalidateCache();
    return result;
  }

  /**
   * Writes `raw` back to the configured S3 configuration bucket. Throws
   * {@link ConfigurationNotConfiguredError} when no bucket is configured —
   * before ever calling into `RemoteFileStore` — otherwise issues a
   * conditional `RemoteFileStore.put()`, passing `expectedVersionId` as
   * `ifMatch` when provided, so a write that raced a concurrent change since
   * the caller's last read is rejected rather than silently overwriting it;
   * the store's cloud-agnostic `RemoteFileConflictError` is caught and
   * re-thrown as an {@link OptimisticLockError} (best-effort populating
   * `currentEtag` from a follow-up `get()`), so every conflict — regardless
   * of the underlying cloud provider — surfaces to callers exclusively as
   * `OptimisticLockError`.
   *
   * @returns The underlying `RemoteFileStore.put()`'s `{ etag, versionId }`.
   */
  private async putRawConfig(
    raw: string,
    expectedVersionId?: string,
  ): Promise<{ etag: string; versionId?: string }> {
    const bucket = this.config.getConfigurationBucket();
    if (!bucket) {
      throw new ConfigurationNotConfiguredError();
    }

    const body = new TextEncoder().encode(raw);
    try {
      return await this.remoteFileStore.put(
        CONFIGURATION_OBJECT_KEY,
        body,
        expectedVersionId ? { ifMatch: expectedVersionId } : undefined,
      );
    } catch (err) {
      if (err instanceof RemoteFileConflictError) {
        const current = await this.remoteFileStore.get(CONFIGURATION_OBJECT_KEY).catch(() => undefined);
        throw new OptimisticLockError(expectedVersionId ?? '', current?.etag);
      }
      throw err;
    }
  }

  /**
   * Parses `raw` as a {@link DeploymentConfig} and returns its `gameServers`
   * record (throwing {@link GameServerEntryError}, `reason: 'structural'`,
   * if `gameServers` is missing or not a plain object) — the shared
   * "load the current document and get at its `gameServers` map, or fail
   * structurally" step every write mutation below starts from.
   */
  private parseGameServersRecord(raw: string): { config: DeploymentConfig; gameServers: Record<string, RawGameServerEntry> } {
    const config = this.parseConfigContents(raw);
    if (!isPlainObject(config.gameServers)) {
      throw new GameServerEntryError('"gameServers" map not found in the deployment config JSON.', 'structural');
    }
    return { config, gameServers: config.gameServers as Record<string, RawGameServerEntry> };
  }

  /**
   * Splices `name` into `raw`'s `gameServers` map as a new entry. Throws
   * {@link GameServerEntryError} if `name` isn't a valid game name (see
   * {@link assertValidGameName} — checked *before* parsing `raw` at all,
   * since it needs only the proposed name), if `name` is already present in
   * `gameServers` (use {@link updateGameServer} instead), or if
   * {@link parseGameServersRecord} can't find a `gameServers` map in `raw`.
   */
  private insertGameServerEntry(raw: string, name: string, config: RawGameServerEntry): string {
    assertValidGameName(name);

    const { config: parsedConfig, gameServers } = this.parseGameServersRecord(raw);
    if (Object.prototype.hasOwnProperty.call(gameServers, name)) {
      throw new GameServerEntryError(
        `Entry "${name}" already exists in "gameServers" — use updateGameServer() instead.`,
        'duplicate-name',
      );
    }

    return this.serializeConfig({ ...parsedConfig, gameServers: { ...gameServers, [name]: config } });
  }

  /**
   * Replaces `name`'s value inside `raw`'s `gameServers` map. Throws
   * {@link GameServerEntryError} (`reason: 'not-found'`) if `name` doesn't
   * already exist in `gameServers`.
   */
  private replaceGameServerEntry(raw: string, name: string, config: RawGameServerEntry): string {
    const { config: parsedConfig, gameServers } = this.parseGameServersRecord(raw);
    if (!Object.prototype.hasOwnProperty.call(gameServers, name)) {
      throw new GameServerEntryError(`Entry "${name}" not found in "gameServers".`, 'not-found');
    }

    return this.serializeConfig({ ...parsedConfig, gameServers: { ...gameServers, [name]: config } });
  }

  /**
   * Removes `name`'s entry from `raw`'s `gameServers` map. Throws
   * {@link GameServerEntryError} (`reason: 'not-found'`) if `name` doesn't
   * exist in `gameServers`.
   */
  private removeGameServerEntry(raw: string, name: string): string {
    const { config: parsedConfig, gameServers } = this.parseGameServersRecord(raw);
    if (!Object.prototype.hasOwnProperty.call(gameServers, name)) {
      throw new GameServerEntryError(`Entry "${name}" not found in "gameServers".`, 'not-found');
    }

    const rest = { ...gameServers };
    delete rest[name];
    return this.serializeConfig({ ...parsedConfig, gameServers: rest });
  }

  /**
   * Merges `patch` onto `raw`'s top-level fields, with `gameServers` sourced
   * EXCLUSIVELY from the freshly-parsed current document — never from
   * `patch` — so the map survives untouched no matter what `patch` contains.
   *
   * This is a runtime guarantee, not just a compile-time one:
   * `updateTopLevelSettings`'s `patch` parameter is typed
   * `Partial<Omit<DeploymentConfig, 'gameServers'>>`, but that type only
   * constrains code written against it — `patch` actually arrives from
   * {@link updateTopLevelSettings}'s caller (ultimately the
   * `iac.settings.update` IPC handler, fed by a plain-JSON payload crossing
   * the Electron IPC boundary) with no runtime enforcement that a
   * `gameServers` key isn't present. Destructuring `gameServers` off `patch`
   * before spreading it (discarding whatever value was there) and building
   * the final object's `gameServers` from `config.gameServers` (the current
   * document) instead makes this impossible to get wrong regardless of what
   * a misbehaving/future caller sends.
   *
   * Also runs {@link assertRunsTableNameStable} against the patch before
   * applying it — see that method's own doc, and {@link RunsTableRenameError}'s,
   * for why `projectName`/`runsTableName` are effectively immutable
   * post-bootstrap identifiers.
   */
  private applyTopLevelSettingsPatch(raw: string, patch: Partial<Omit<DeploymentConfig, 'gameServers'>>): string {
    const config = this.parseConfigContents(raw);
    const { gameServers, ...currentSettings } = config;
    const { gameServers: _ignoredPatchGameServers, ...safePatch } = patch as Partial<DeploymentConfig>;

    this.assertRunsTableNameStable(currentSettings, safePatch);

    return this.serializeConfig({ ...currentSettings, ...safePatch, gameServers });
  }

  /**
   * Guards against a Settings-form patch orphaning the already-bootstrapped
   * run-history DynamoDB table — see {@link RunsTableRenameError}'s doc
   * comment for the full rationale. Compares the resolved run-history table
   * name (`resolveRunsTableName`, `@hyveon/shared`) before and after applying
   * `safePatch`'s `projectName`/`runsTableName` fields (falling back to each
   * field's {@link DEPLOYMENT_CONFIG_DEFAULTS} value when the CURRENT
   * document predates that field entirely, mirroring
   * {@link getTopLevelSettings}'s own `withDeploymentConfigDefaults`
   * defensive-defaulting rationale) and throws {@link RunsTableRenameError}
   * when the two diverge. A no-op when neither field is present on the
   * patch, or when the patch happens to resolve to the SAME effective table
   * name it already had (e.g. explicitly setting `runsTableName` to the
   * value it would already compute to).
   */
  private assertRunsTableNameStable(
    currentSettings: Omit<DeploymentConfig, 'gameServers'>,
    safePatch: Partial<DeploymentConfig>,
  ): void {
    const currentProjectName = currentSettings.projectName ?? DEPLOYMENT_CONFIG_DEFAULTS.projectName;
    const currentRunsTableNameOverride = currentSettings.runsTableName ?? DEPLOYMENT_CONFIG_DEFAULTS.runsTableName;

    const changedFields: Array<'projectName' | 'runsTableName'> = [];
    if (safePatch.projectName !== undefined && safePatch.projectName !== currentSettings.projectName) {
      changedFields.push('projectName');
    }
    if (safePatch.runsTableName !== undefined && safePatch.runsTableName !== currentSettings.runsTableName) {
      changedFields.push('runsTableName');
    }
    if (changedFields.length === 0) return;

    const currentTableName = resolveRunsTableName(currentProjectName, currentRunsTableNameOverride);
    const nextProjectName = safePatch.projectName ?? currentProjectName;
    const nextRunsTableNameOverride = safePatch.runsTableName ?? currentRunsTableNameOverride;
    const nextTableName = resolveRunsTableName(nextProjectName, nextRunsTableNameOverride);
    if (nextTableName === currentTableName) return;

    throw new RunsTableRenameError(currentTableName, nextTableName, changedFields);
  }

  /**
   * Serializes `config` back to the JSON text persisted to disk/S3 — pretty
   * printed (two-space indent, trailing newline) so a hand-opened config
   * file/object stays readable, mirroring the retired HCL format's own
   * indentation convention.
   */
  private serializeConfig(config: DeploymentConfig): string {
    return JSON.stringify(config, null, 2) + '\n';
  }

  /**
   * Parses raw deployment-config JSON text into a {@link DeploymentConfig}.
   * Wraps parse failures (malformed JSON, or a non-object top level) in a
   * clear, contextualized error rather than letting `JSON.parse`'s raw
   * `SyntaxError` (or a silently-accepted non-object value) surface
   * directly.
   */
  private parseConfigContents(raw: string): DeploymentConfig {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      logger.error('Failed to parse deployment config JSON', { err });
      throw new Error(`Failed to parse deployment config JSON: ${err instanceof Error ? err.message : String(err)}`);
    }

    if (!isPlainObject(parsed)) {
      logger.error('Deployment config JSON did not decode to an object', {});
      throw new Error('Deployment config JSON did not decode to an object.');
    }

    return parsed as unknown as DeploymentConfig;
  }

  /**
   * Flattens the `gameServers` map (if present) from the parsed
   * {@link DeploymentConfig} into a `GameServer[]`. Returns `[]` (after
   * logging a warning) when the key is absent or not an object, e.g. an
   * empty/placeholder config document.
   */
  private flattenGameServers(config: DeploymentConfig): GameServer[] {
    const gameServers = config.gameServers;
    if (!isPlainObject(gameServers)) {
      logger.warn('deployment config has no gameServers map', {});
      return [];
    }

    return Object.entries(gameServers as unknown as Record<string, RawGameServerEntry>).map(([name, entry]) => ({
      name,
      ...entry,
    }));
  }
}
