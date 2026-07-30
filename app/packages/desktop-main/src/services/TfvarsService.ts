/**
 * Reads and parses the app's JSON deployment configuration into the
 * `GameServer[]` shape declared by `@hyveon/shared/tfvars.js` (which mirrors
 * `terraform/variables.tf`'s retired `game_servers` map — see the
 * `migrate-iac-to-pulumi` OpenSpec change).
 *
 * Source resolution mirrors the local-vs-S3 tradeoff documented in
 * `docs/docs/guides/s3-tfvars.md`:
 *  - When `ConfigService.getTfvarsBucket()` resolves to a bucket name, the
 *    raw JSON text is fetched from that bucket via the injected
 *    `RemoteFileStore` ("S3 mode").
 *  - Otherwise the local file at `ConfigService.getTfvarsPath()` is read
 *    directly ("local mode").
 *
 * The raw text is `JSON.parse()`d directly into a `DeploymentConfig`
 * (`@hyveon/shared/deploymentConfig.js`) — no HCL parsing is involved any
 * more (see the `migrate-iac-to-pulumi` change's Phase 6, "Configuration
 * persisted as versioned JSON") — and its `gameServers` record is flattened
 * into a `GameServer[]` with the map key attached as `name`.
 *
 * Parsed results are cached in-memory for `ConfigService.readEnvTfvarsCacheTtlMs()`
 * milliseconds so frequent callers (e.g. polling endpoints) don't re-parse the
 * file/re-fetch from S3 on every call. Call `invalidateCache()` to force a
 * fresh read before the TTL elapses (e.g. after a config edit). The cache
 * mirrors `ConfigService.tfCache`'s tri-state approach: `undefined` means
 * "never loaded" (always a miss), while a set `CachedGameServers` entry
 * covers *both* a successful parse and a negatively-cached failed load (the
 * `failed` flag distinguishes the two) — either way the entry's `cachedAt`
 * governs the TTL, so a broken source isn't re-hit on every call within the
 * TTL window.
 *
 * `getGameServers()` never rejects — a missing file/object, a missing
 * `gameServers` key, or malformed JSON are all logged via the shared Winston
 * `logger` and resolve to `[]`, mirroring `ConfigService`'s graceful
 * degradation for polling callers.
 *
 * `addGameServer()`, `updateGameServer()`, and `removeGameServer()` (see
 * issue #96, updated for the JSON migration) are the write-side counterpart:
 * they read the current `DeploymentConfig` JSON, mutate the `gameServers`
 * record, and `JSON.stringify` the result back — a plain, lossless
 * serialize/deserialize round trip, unlike the byte-preserving HCL splice
 * this service used before the migration. In S3 mode, the write is a
 * conditional `RemoteFileStore.put()` guarded by an `ifMatch` etag; a stale
 * etag is translated from the store's `RemoteFileConflictError` into an
 * `OptimisticLockError` so callers only ever need to handle one conflict
 * type regardless of cloud provider. Local mode writes the file directly
 * with no conditional guard.
 */
import { Inject, Injectable } from '@nestjs/common';
import { existsSync, readFileSync, writeFileSync } from 'fs';
import { basename } from 'path';
import type { DeploymentConfig, GameServer, GameServerConfig, RemoteFileStore } from '@hyveon/shared';
import {
  GAME_NAME_PATTERN,
  GAME_NAME_PATTERN_DESCRIPTION,
  OptimisticLockError,
  RemoteFileConflictError,
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
   * Returns the `gameServers` map from the deployment config JSON, parsed
   * into a `GameServer[]` (the map key is flattened onto each entry as
   * `name`).
   *
   * Returns a cached result when the last resolution (success *or* failure)
   * is younger than `ConfigService.readEnvTfvarsCacheTtlMs()`; otherwise
   * reads/parses fresh (see the class doc for local-vs-S3 source resolution)
   * and re-caches. Never rejects: a missing file/object, a missing
   * `gameServers` key, or malformed JSON are logged and resolved to `[]`
   * (and negatively cached for the TTL window) rather than thrown, so
   * polling callers degrade gracefully instead of crashing.
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
      logger.error('Failed to load deployment config gameServers — returning empty list', { err });
      if (generation === this.cacheGeneration) {
        this.cache = { value: [], cachedAt: this.now(), failed: true };
      }
      return [];
    }
  }

  /**
   * Returns the raw, unparsed deployment config JSON text plus a source
   * integrity marker: in S3 mode, the `RemoteFileStore.get()` etag (as
   * `etag`) — the same value `RemoteFileStore.put()` expects as its
   * `ifMatch` guard, so callers can round-trip a conditional write; in local
   * mode, `etag` is omitted since the local filesystem has no equivalent
   * concept. This is distinct from `RemoteFileStore.listVersions()`'s
   * `versionId`, which identifies a specific S3 object version rather than
   * an etag — the two are not comparable. Unlike {@link getGameServers},
   * this bypasses the in-memory cache and rejects (rather than swallowing) a
   * missing file/object — callers that need the raw text (e.g. an editor)
   * want to know immediately if the source is unreadable rather than
   * silently getting stale/empty data.
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
   */
  async restoreRawTfvars(rawConfig: string): Promise<{ etag: string; versionId?: string }> {
    const result = await this.putRawConfig(rawConfig);
    this.invalidateCache();
    return result;
  }

  /**
   * Adds a brand-new entry to the `gameServers` map (see issue #96). Reads
   * the current raw config JSON, splices `name` in as a new `gameServers`
   * key, and writes the result back via {@link writeConfig} — see that
   * method's doc for the S3-mode conditional-put / `OptimisticLockError`
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
   *   used as the S3-mode conditional-put guard; omit to write unconditionally.
   * @returns The written file's new `etag` (S3 mode) plus an optional
   *   `versionId` when the underlying store supports object versioning — see
   *   {@link writeConfig}/{@link putRawConfig}. Local mode returns
   *   `versionId: undefined` since the filesystem has no equivalent concept.
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
   * for the S3-mode conditional-put / `OptimisticLockError` contract. Throws
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
   *   used as the S3-mode conditional-put guard; omit to write unconditionally.
   * @returns The written file's new `etag` (S3 mode) plus an optional
   *   `versionId` when the underlying store supports object versioning — see
   *   {@link writeConfig}/{@link putRawConfig}. Local mode returns
   *   `versionId: undefined` since the filesystem has no equivalent concept.
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
   * back via {@link writeConfig} — see that method's doc for the S3-mode
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
   *   used as the S3-mode conditional-put guard; omit to write unconditionally.
   * @returns The written file's new `etag` (S3 mode) plus an optional
   *   `versionId` when the underlying store supports object versioning — see
   *   {@link writeConfig}/{@link putRawConfig}. Local mode returns
   *   `versionId: undefined` since the filesystem has no equivalent concept.
   */
  async removeGameServer(
    name: string,
    expectedVersionId?: string,
  ): Promise<{ etag: string; versionId?: string }> {
    return this.writeConfig(expectedVersionId, (raw) => this.removeGameServerEntry(raw, name));
  }

  /**
   * Reads the raw config JSON text, preferring the S3 backend
   * (`ConfigService.getTfvarsBucket()`) when configured, otherwise falling
   * back to the local file at `ConfigService.getTfvarsPath()`. Throws a clear
   * error when the source is configured but the file/object doesn't exist.
   * Shared by {@link getGameServers} (which catches and swallows the error)
   * and {@link getRawConfig} (which lets it propagate).
   */
  private async fetchRawConfig(): Promise<{ config: string; etag?: string }> {
    const bucket = this.config.getTfvarsBucket();
    const path = this.config.getTfvarsPath();

    if (bucket) {
      const key = basename(path);
      const obj = await this.remoteFileStore.get(key);
      if (!obj) {
        throw new Error(`Deployment config object "${key}" not found in S3 bucket "${bucket}".`);
      }
      return { config: new TextDecoder().decode(obj.body), etag: obj.etag };
    }

    if (!existsSync(path)) {
      throw new Error(`Deployment config file not found at "${path}".`);
    }
    return { config: readFileSync(path, 'utf-8') };
  }

  /**
   * Shared write path for {@link addGameServer}, {@link updateGameServer},
   * and {@link removeGameServer}: reads the current raw config JSON via
   * {@link fetchRawConfig}, applies `mutate` to it, writes the mutated text
   * back via {@link putRawConfig} (S3-mode conditional put / local-mode
   * direct write), and invalidates the in-memory `getGameServers()` cache so
   * the next read reflects the write. `mutate` running before the write
   * (rather than concurrently) keeps the S3-mode conditional-put guard
   * meaningful — `expectedVersionId` is checked against the store's
   * current etag at write time, so a conflicting write since `fetchRawConfig`
   * ran is still caught even though `mutate` itself is synchronous.
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
   * Writes `raw` back to whichever config source is active, mirroring
   * {@link fetchRawConfig}'s local-vs-S3 source resolution. In S3 mode,
   * issues a conditional `RemoteFileStore.put()` — passing `expectedVersionId`
   * as `ifMatch` when provided — so a write that raced a concurrent change
   * since the caller's last read is rejected rather than silently
   * overwriting it; the store's cloud-agnostic `RemoteFileConflictError` is
   * caught and re-thrown as an {@link OptimisticLockError} (best-effort
   * populating `currentEtag` from a follow-up `get()`), so every conflict —
   * regardless of the underlying cloud provider — surfaces to callers
   * exclusively as `OptimisticLockError`. In local mode the file is written
   * directly with no conditional guard, since the local filesystem has no
   * etag/versioning concept to condition on (mirroring
   * {@link fetchRawConfig}'s local-mode `etag`-less read).
   *
   * @returns The underlying `RemoteFileStore.put()`'s `{ etag, versionId }`
   *   in S3 mode. Local mode has no etag/versioning concept, so `etag` is the
   *   empty string and `versionId` is `undefined`.
   */
  private async putRawConfig(
    raw: string,
    expectedVersionId?: string,
  ): Promise<{ etag: string; versionId?: string }> {
    const bucket = this.config.getTfvarsBucket();
    const path = this.config.getTfvarsPath();

    if (bucket) {
      const key = basename(path);
      const body = new TextEncoder().encode(raw);
      try {
        return await this.remoteFileStore.put(key, body, expectedVersionId ? { ifMatch: expectedVersionId } : undefined);
      } catch (err) {
        if (err instanceof RemoteFileConflictError) {
          const current = await this.remoteFileStore.get(key).catch(() => undefined);
          throw new OptimisticLockError(expectedVersionId ?? '', current?.etag);
        }
        throw err;
      }
    }

    writeFileSync(path, raw, 'utf-8');
    return { etag: '', versionId: undefined };
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
