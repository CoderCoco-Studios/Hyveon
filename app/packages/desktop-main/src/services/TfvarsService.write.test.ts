/**
 * Write-path tests for `TfvarsService` (see issue #96, updated for the
 * `migrate-iac-to-pulumi` JSON migration) — `addGameServer`,
 * `updateGameServer`, and `removeGameServer`. Directly covers the JSON
 * equivalents of issue #96's original acceptance checkboxes:
 *
 *  1. Sibling preservation — adding/editing/removing one game leaves every
 *     other `gameServers` entry and every top-level field untouched.
 *  2. Concurrent writes — a second write that races a first (stale etag)
 *     fails with a clear error rather than silently overwriting.
 *  3. `OptimisticLockError` is structured (`expectedEtag` / `currentEtag`)
 *     so the UI can display "remote moved — refresh".
 *
 * Unlike the retired HCL write path (which spliced byte spans to preserve
 * comments/formatting outside the touched entry), the JSON write path reads
 * the whole document, mutates the in-memory object, and re-serializes it —
 * so "preservation" here means "unrelated fields/entries round-trip with the
 * same values," not "identical bytes."
 *
 * There is no local-file fallback any more (Phase 6's "no local
 * configuration fallback" requirement) — every write goes through the
 * `RemoteFileStore` stub. `fs` stays mocked purely so the
 * `ConfigurationNotConfiguredError` tests can assert it is never touched;
 * this module no longer imports `fs` in production code at all.
 */
import 'reflect-metadata';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { DeploymentConfig, RemoteFileStore } from '@hyveon/shared';
import { DEPLOYMENT_CONFIG_DEFAULTS, OptimisticLockError, RemoteFileConflictError } from '@hyveon/shared';

// Shared mock instances behind both the bare `'fs'` specifier and the
// `'node:fs'` specifier — Node treats these as distinct module ids, and
// TerraformService.ts imports the latter, so mocking only `'fs'` would let a
// reintroduced local-disk fallback via `node:fs` slip past this file's
// "no disk fallback reachable" assertions unnoticed.
const { mockExists, mockRead, mockWrite } = vi.hoisted(() => ({
  mockExists: vi.fn(),
  mockRead: vi.fn(),
  mockWrite: vi.fn(),
}));

vi.mock('fs', () => ({
  readFileSync: mockRead,
  existsSync: mockExists,
  writeFileSync: mockWrite,
}));
vi.mock('node:fs', () => ({
  readFileSync: mockRead,
  existsSync: mockExists,
  writeFileSync: mockWrite,
}));

vi.mock('../logger.js', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

import { TfvarsService, GameServerEntryError, ConfigurationNotConfiguredError } from './TfvarsService.js';
import { ConfigService } from './ConfigService.js';

/**
 * A deployment config fixture with non-`gameServers` top-level fields and
 * two `gameServers` entries — enough surrounding content to meaningfully
 * assert that a write only touches the entry it targets.
 */
const FIXTURE_CONFIG: DeploymentConfig = {
  projectName: 'hyveon',
  awsRegion: 'us-east-1',
  vpcCidr: '10.0.0.0/16',
  hostedZoneName: 'example.com',
  dnsTtl: 30,
  watchdogIntervalMinutes: 15,
  watchdogIdleChecks: 4,
  watchdogMinPackets: 100,
  baseAllowedGuilds: [],
  baseAdminUserIds: [],
  baseAdminRoleIds: [],
  discordApplicationId: '',
  auditTableName: '',
  runsTableName: '',
  gameServers: {
    palworld: {
      image: 'thijsvanloef/palworld-server-docker:latest',
      cpu: 2048,
      memory: 8192,
      ports: [{ container: 8211, protocol: 'udp' }],
      volumes: [{ name: 'saves', container_path: '/palworld' }],
    },
    valheim: {
      image: 'lloesche/valheim-server',
      cpu: 1024,
      memory: 4096,
      ports: [{ container: 2456, protocol: 'udp' }],
      volumes: [{ name: 'saves', container_path: '/config' }],
    },
  },
};

/** {@link FIXTURE_CONFIG} serialized exactly as `TfvarsService` would write/read it. */
const FIXTURE_JSON = JSON.stringify(FIXTURE_CONFIG, null, 2) + '\n';

/** A new entry's config used by the `addGameServer` tests. */
const NEW_ENTRY_CONFIG = {
  image: 'ryshe/terraria',
  cpu: 512,
  memory: 1024,
  ports: [{ container: 7777, protocol: 'tcp' }],
  volumes: [{ name: 'world', container_path: '/config' }],
};

/** A replacement entry's config used by the `updateGameServer` tests. */
const UPDATED_ENTRY_CONFIG = {
  image: 'thijsvanloef/palworld-server-docker:v2',
  cpu: 4096,
  memory: 16384,
  ports: [{ container: 8211, protocol: 'udp' }],
  volumes: [{ name: 'saves', container_path: '/palworld' }],
};

/** Fake `RemoteFileStore` whose `get`/`put` are directly-controllable mocks. */
function makeRemoteFileStore(): RemoteFileStore & {
  get: ReturnType<typeof vi.fn>;
  put: ReturnType<typeof vi.fn>;
} {
  const store: Partial<RemoteFileStore> = {
    get: vi.fn(),
    put: vi.fn(),
    listVersions: vi.fn(),
  };
  return store as RemoteFileStore & { get: ReturnType<typeof vi.fn>; put: ReturnType<typeof vi.fn> };
}

/**
 * Builds a `ConfigService` stub exposing just the methods `TfvarsService`
 * reads. `bucket: null` (the default) selects the "unconfigured" state; any
 * non-null string selects the configured (S3) state.
 */
function makeConfig(opts: { bucket?: string | null } = {}): ConfigService {
  const stub: Partial<ConfigService> = {
    getConfigurationBucket: () => opts.bucket ?? null,
    readEnvTfvarsCacheTtlMs: () => 30000,
  };
  return stub as ConfigService;
}

/** Configures `remoteFileStore.get()` to resolve {@link FIXTURE_JSON} at the given etag — the read every write path starts from. */
function stubCurrentConfig(
  remoteFileStore: ReturnType<typeof makeRemoteFileStore>,
  json: string = FIXTURE_JSON,
  etag = 'etag-1',
): void {
  remoteFileStore.get.mockResolvedValue({ body: new TextEncoder().encode(json), etag });
}

describe('TfvarsService write path', () => {
  let remoteFileStore: RemoteFileStore & { get: ReturnType<typeof vi.fn>; put: ReturnType<typeof vi.fn> };

  beforeEach(() => {
    remoteFileStore = makeRemoteFileStore();
    vi.clearAllMocks();
  });

  describe('unconfigured (no disk fallback reachable)', () => {
    it('should reject every write method with ConfigurationNotConfiguredError without touching fs or the RemoteFileStore', async () => {
      const service = new TfvarsService(makeConfig({ bucket: null }), remoteFileStore);

      await expect(service.addGameServer('terraria', NEW_ENTRY_CONFIG)).rejects.toBeInstanceOf(
        ConfigurationNotConfiguredError,
      );
      await expect(service.updateGameServer('palworld', UPDATED_ENTRY_CONFIG)).rejects.toBeInstanceOf(
        ConfigurationNotConfiguredError,
      );
      await expect(service.removeGameServer('palworld')).rejects.toBeInstanceOf(ConfigurationNotConfiguredError);

      expect(mockExists).not.toHaveBeenCalled();
      expect(mockRead).not.toHaveBeenCalled();
      expect(mockWrite).not.toHaveBeenCalled();
      expect(remoteFileStore.get).not.toHaveBeenCalled();
      expect(remoteFileStore.put).not.toHaveBeenCalled();
    });
  });

  describe('sibling preservation', () => {
    it('should leave every existing gameServers entry and every top-level field intact when addGameServer splices in a new entry', async () => {
      stubCurrentConfig(remoteFileStore);
      remoteFileStore.put.mockResolvedValue({ etag: 'etag-2' });

      const service = new TfvarsService(makeConfig({ bucket: 'my-tfvars-bucket' }), remoteFileStore);
      const result = await service.addGameServer('terraria', NEW_ENTRY_CONFIG);
      expect(result).toEqual({ etag: 'etag-2', versionId: undefined });

      expect(remoteFileStore.put).toHaveBeenCalledTimes(1);
      const [, body] = remoteFileStore.put.mock.calls[0] as [string, Uint8Array];
      const written = JSON.parse(new TextDecoder().decode(body)) as DeploymentConfig;

      expect(written.projectName).toBe(FIXTURE_CONFIG.projectName);
      expect(written.awsRegion).toBe(FIXTURE_CONFIG.awsRegion);
      expect(written.gameServers.palworld).toEqual(FIXTURE_CONFIG.gameServers.palworld);
      expect(written.gameServers.valheim).toEqual(FIXTURE_CONFIG.gameServers.valheim);
      expect(written.gameServers.terraria).toEqual(NEW_ENTRY_CONFIG);
    });

    it('should leave every other gameServers entry and every top-level field intact when updateGameServer replaces an existing entry', async () => {
      stubCurrentConfig(remoteFileStore);
      remoteFileStore.put.mockResolvedValue({ etag: 'etag-2' });

      const service = new TfvarsService(makeConfig({ bucket: 'my-tfvars-bucket' }), remoteFileStore);
      await service.updateGameServer('palworld', UPDATED_ENTRY_CONFIG);

      expect(remoteFileStore.put).toHaveBeenCalledTimes(1);
      const [, body] = remoteFileStore.put.mock.calls[0] as [string, Uint8Array];
      const written = JSON.parse(new TextDecoder().decode(body)) as DeploymentConfig;

      expect(written.projectName).toBe(FIXTURE_CONFIG.projectName);
      expect(written.gameServers.palworld).toEqual(UPDATED_ENTRY_CONFIG);
      // The untouched valheim entry survives unchanged.
      expect(written.gameServers.valheim).toEqual(FIXTURE_CONFIG.gameServers.valheim);
    });

    it('should leave every other gameServers entry and every top-level field intact when removeGameServer cuts an entry', async () => {
      stubCurrentConfig(remoteFileStore);
      remoteFileStore.put.mockResolvedValue({ etag: 'etag-2' });

      const service = new TfvarsService(makeConfig({ bucket: 'my-tfvars-bucket' }), remoteFileStore);
      await service.removeGameServer('palworld');

      expect(remoteFileStore.put).toHaveBeenCalledTimes(1);
      const [, body] = remoteFileStore.put.mock.calls[0] as [string, Uint8Array];
      const written = JSON.parse(new TextDecoder().decode(body)) as DeploymentConfig;

      expect(written.gameServers.palworld).toBeUndefined();
      expect(written.gameServers.valheim).toEqual(FIXTURE_CONFIG.gameServers.valheim);
      expect(written.awsRegion).toBe(FIXTURE_CONFIG.awsRegion);
    });
  });

  describe('boolean round-trip', () => {
    it('should serialize https: true as a real JSON boolean (not the string "true") when enabling HTTPS on an entry that omits the field entirely', async () => {
      stubCurrentConfig(remoteFileStore);
      remoteFileStore.put.mockResolvedValue({ etag: 'etag-2' });

      const service = new TfvarsService(makeConfig({ bucket: 'my-tfvars-bucket' }), remoteFileStore);
      await service.updateGameServer('palworld', { ...UPDATED_ENTRY_CONFIG, https: true });

      const [, body] = remoteFileStore.put.mock.calls[0] as [string, Uint8Array];
      const written = JSON.parse(new TextDecoder().decode(body)) as DeploymentConfig;
      expect(written.gameServers.palworld!.https).toBe(true);
    });

    it('should serialize https: false explicitly (not omit the field) when flipping an entry from https = true to false', async () => {
      const fixtureWithHttpsTrue: DeploymentConfig = {
        ...FIXTURE_CONFIG,
        gameServers: {
          ...FIXTURE_CONFIG.gameServers,
          palworld: { ...FIXTURE_CONFIG.gameServers.palworld!, https: true },
        },
      };
      stubCurrentConfig(remoteFileStore, JSON.stringify(fixtureWithHttpsTrue));
      remoteFileStore.put.mockResolvedValue({ etag: 'etag-2' });

      const service = new TfvarsService(makeConfig({ bucket: 'my-tfvars-bucket' }), remoteFileStore);
      await service.updateGameServer('palworld', { ...UPDATED_ENTRY_CONFIG, https: false });

      const [, body] = remoteFileStore.put.mock.calls[0] as [string, Uint8Array];
      const written = JSON.parse(new TextDecoder().decode(body)) as DeploymentConfig;
      expect(written.gameServers.palworld!.https).toBe(false);
    });

    it('should leave https: true and the surrounding gameServers entries intact when an unrelated field is updated', async () => {
      const fixtureWithHttpsTrue: DeploymentConfig = {
        ...FIXTURE_CONFIG,
        gameServers: {
          ...FIXTURE_CONFIG.gameServers,
          palworld: { ...FIXTURE_CONFIG.gameServers.palworld!, https: true },
        },
      };
      stubCurrentConfig(remoteFileStore, JSON.stringify(fixtureWithHttpsTrue));
      remoteFileStore.put.mockResolvedValue({ etag: 'etag-2' });

      const service = new TfvarsService(makeConfig({ bucket: 'my-tfvars-bucket' }), remoteFileStore);
      await service.updateGameServer('palworld', { ...UPDATED_ENTRY_CONFIG, memory: 32768, https: true });

      const [, body] = remoteFileStore.put.mock.calls[0] as [string, Uint8Array];
      const written = JSON.parse(new TextDecoder().decode(body)) as DeploymentConfig;
      expect(written.gameServers.palworld!.https).toBe(true);
      expect(written.gameServers.palworld!.memory).toBe(32768);
      expect(written.gameServers.palworld!.image).toBe('thijsvanloef/palworld-server-docker:v2');
      expect(written.gameServers.valheim).toEqual(fixtureWithHttpsTrue.gameServers.valheim);
    });
  });

  describe('addGameServer name validation', () => {
    it('should reject a name containing uppercase letters instead of writing a corrupt DNS label', async () => {
      stubCurrentConfig(remoteFileStore);

      const service = new TfvarsService(makeConfig({ bucket: 'my-tfvars-bucket' }), remoteFileStore);

      await expect(service.addGameServer('Terraria', NEW_ENTRY_CONFIG)).rejects.toThrow(/is invalid/);
      expect(remoteFileStore.put).not.toHaveBeenCalled();
    });

    it('should reject a name containing an underscore, since underscores are not valid in a DNS label', async () => {
      stubCurrentConfig(remoteFileStore);

      const service = new TfvarsService(makeConfig({ bucket: 'my-tfvars-bucket' }), remoteFileStore);

      await expect(service.addGameServer('my_server', NEW_ENTRY_CONFIG)).rejects.toThrow(/is invalid/);
      expect(remoteFileStore.put).not.toHaveBeenCalled();
    });

    it('should reject a name with a leading hyphen', async () => {
      stubCurrentConfig(remoteFileStore);

      const service = new TfvarsService(makeConfig({ bucket: 'my-tfvars-bucket' }), remoteFileStore);

      await expect(service.addGameServer('-terraria', NEW_ENTRY_CONFIG)).rejects.toThrow(/is invalid/);
      expect(remoteFileStore.put).not.toHaveBeenCalled();
    });

    it('should reject an empty name', async () => {
      stubCurrentConfig(remoteFileStore);

      const service = new TfvarsService(makeConfig({ bucket: 'my-tfvars-bucket' }), remoteFileStore);

      await expect(service.addGameServer('', NEW_ENTRY_CONFIG)).rejects.toThrow(/is invalid/);
      expect(remoteFileStore.put).not.toHaveBeenCalled();
    });

    it('should accept a name containing internal hyphens, since those are valid within a DNS label', async () => {
      stubCurrentConfig(remoteFileStore);
      remoteFileStore.put.mockResolvedValue({ etag: 'etag-2' });

      const service = new TfvarsService(makeConfig({ bucket: 'my-tfvars-bucket' }), remoteFileStore);

      await expect(service.addGameServer('my-server-2', NEW_ENTRY_CONFIG)).resolves.toEqual({
        etag: 'etag-2',
        versionId: undefined,
      });
      expect(remoteFileStore.put).toHaveBeenCalledTimes(1);
    });

    it('should reject adding a name that already exists in gameServers, with reason: \'duplicate-name\' pinned for GamesWriteService\'s coupling', async () => {
      stubCurrentConfig(remoteFileStore);

      const service = new TfvarsService(makeConfig({ bucket: 'my-tfvars-bucket' }), remoteFileStore);

      // `GamesWriteService.createGame()`'s catch block narrows on
      // `err.reason === 'duplicate-name'` (not just the error's message) to
      // decide whether to surface `{ code: 'validation', path: 'name' }` —
      // pinning the literal `reason` value here, not just a message regex,
      // is what actually guards that coupling against silent drift.
      await expect(service.addGameServer('palworld', NEW_ENTRY_CONFIG)).rejects.toMatchObject({
        reason: 'duplicate-name',
      });
      await expect(service.addGameServer('palworld', NEW_ENTRY_CONFIG)).rejects.toBeInstanceOf(GameServerEntryError);
      expect(remoteFileStore.put).not.toHaveBeenCalled();
    });
  });

  describe('updateGameServer / removeGameServer not-found', () => {
    it('should reject updateGameServer when the name does not exist in gameServers, with reason: \'not-found\' pinned for GamesWriteService\'s coupling', async () => {
      stubCurrentConfig(remoteFileStore);

      const service = new TfvarsService(makeConfig({ bucket: 'my-tfvars-bucket' }), remoteFileStore);

      await expect(service.updateGameServer('does-not-exist', UPDATED_ENTRY_CONFIG)).rejects.toMatchObject({
        reason: 'not-found',
      });
      expect(remoteFileStore.put).not.toHaveBeenCalled();
    });

    it('should reject removeGameServer when the name does not exist in gameServers, with reason: \'not-found\' pinned for GamesWriteService\'s coupling', async () => {
      stubCurrentConfig(remoteFileStore);

      const service = new TfvarsService(makeConfig({ bucket: 'my-tfvars-bucket' }), remoteFileStore);

      await expect(service.removeGameServer('does-not-exist')).rejects.toMatchObject({ reason: 'not-found' });
      expect(remoteFileStore.put).not.toHaveBeenCalled();
    });
  });

  describe('create-only name validation (legacy names)', () => {
    /**
     * `assertValidGameName()` is only ever called from `insertGameServerEntry()`
     * (the `addGameServer` path) — `updateGameServer`/`removeGameServer` never
     * re-validate an existing key against the current DNS-safe pattern. This
     * guarantee is what lets a legacy, pre-migration name that predates
     * {@link GAME_NAME_PATTERN} (declared back when the source was HCL and the
     * old `HCL_IDENTIFIER_PATTERN` allowed underscores) keep working
     * indefinitely. These specs pin that guarantee with a test, so a future
     * "let's validate consistently on every write" refactor can't silently
     * break it.
     */
    const LEGACY_NAME = 'My_Server';
    const FIXTURE_WITH_LEGACY_NAME: DeploymentConfig = {
      ...FIXTURE_CONFIG,
      gameServers: {
        ...FIXTURE_CONFIG.gameServers,
        [LEGACY_NAME]: {
          image: 'example/legacy-server:latest',
          cpu: 1024,
          memory: 2048,
          ports: [{ container: 9000, protocol: 'tcp' }],
          volumes: [{ name: 'data', container_path: '/data' }],
        },
      },
    };

    it('should let updateGameServer succeed on a legacy non-DNS-safe key (never re-validates an existing name)', async () => {
      stubCurrentConfig(remoteFileStore, JSON.stringify(FIXTURE_WITH_LEGACY_NAME));
      remoteFileStore.put.mockResolvedValue({ etag: 'etag-2' });

      const service = new TfvarsService(makeConfig({ bucket: 'my-tfvars-bucket' }), remoteFileStore);

      await expect(service.updateGameServer(LEGACY_NAME, UPDATED_ENTRY_CONFIG)).resolves.toEqual({
        etag: 'etag-2',
        versionId: undefined,
      });
      const [, body] = remoteFileStore.put.mock.calls[0] as [string, Uint8Array];
      const written = JSON.parse(new TextDecoder().decode(body)) as DeploymentConfig;
      expect(written.gameServers[LEGACY_NAME]).toEqual(UPDATED_ENTRY_CONFIG);
    });

    it('should let removeGameServer succeed on a legacy non-DNS-safe key (never re-validates an existing name)', async () => {
      stubCurrentConfig(remoteFileStore, JSON.stringify(FIXTURE_WITH_LEGACY_NAME));
      remoteFileStore.put.mockResolvedValue({ etag: 'etag-2' });

      const service = new TfvarsService(makeConfig({ bucket: 'my-tfvars-bucket' }), remoteFileStore);

      await expect(service.removeGameServer(LEGACY_NAME)).resolves.toEqual({ etag: 'etag-2', versionId: undefined });
      const [, body] = remoteFileStore.put.mock.calls[0] as [string, Uint8Array];
      const written = JSON.parse(new TextDecoder().decode(body)) as DeploymentConfig;
      expect(written.gameServers[LEGACY_NAME]).toBeUndefined();
    });
  });

  describe('restoreRawTfvars (rollback flow, #112)', () => {
    it('should write the supplied config unconditionally (no ifMatch) and return the store put() result', async () => {
      remoteFileStore.put.mockResolvedValueOnce({ etag: 'etag-restored', versionId: 'v-restored' });

      const service = new TfvarsService(makeConfig({ bucket: 'my-tfvars-bucket' }), remoteFileStore);

      await expect(service.restoreRawTfvars(FIXTURE_JSON)).resolves.toEqual({
        etag: 'etag-restored',
        versionId: 'v-restored',
      });
      expect(remoteFileStore.put).toHaveBeenCalledWith(
        'deployment-config.json',
        new TextEncoder().encode(FIXTURE_JSON),
        undefined,
      );
    });

    it('should invalidate the in-memory cache so the next getGameServers() re-reads the restored content', async () => {
      stubCurrentConfig(remoteFileStore);
      remoteFileStore.put.mockResolvedValueOnce({ etag: 'etag-restored', versionId: 'v-restored' });

      const service = new TfvarsService(makeConfig({ bucket: 'my-tfvars-bucket' }), remoteFileStore);
      await service.getGameServers();
      expect(remoteFileStore.get).toHaveBeenCalledTimes(1);

      await service.restoreRawTfvars(FIXTURE_JSON);
      await service.getGameServers();

      expect(remoteFileStore.get).toHaveBeenCalledTimes(2);
    });
  });

  describe('concurrent writes', () => {
    it('should fail the second of two concurrent writes with a clear OptimisticLockError, not silently overwrite the first', async () => {
      // Both writers read the same starting etag...
      stubCurrentConfig(remoteFileStore);
      const service = new TfvarsService(makeConfig({ bucket: 'my-tfvars-bucket' }), remoteFileStore);

      // ...the first writer's conditional put succeeds and moves the remote
      // etag forward...
      remoteFileStore.put.mockResolvedValueOnce({ etag: 'etag-2' });
      await service.updateGameServer('palworld', UPDATED_ENTRY_CONFIG, 'etag-1');
      expect(remoteFileStore.put).toHaveBeenCalledWith('deployment-config.json', expect.any(Uint8Array), {
        ifMatch: 'etag-1',
      });

      // ...so the second writer's conditional put — still guarded by the
      // now-stale `etag-1` it read before the first write landed — is
      // rejected by the store rather than clobbering the first writer's change.
      remoteFileStore.put.mockRejectedValueOnce(
        new RemoteFileConflictError('deployment-config.json', 'Conflicting write detected.', 'etag-1'),
      );
      remoteFileStore.get.mockResolvedValueOnce({
        body: new TextEncoder().encode(FIXTURE_JSON),
        etag: 'etag-2',
      });

      await expect(
        service.removeGameServer('valheim', 'etag-1'),
      ).rejects.toThrow(OptimisticLockError);
    });

    it('should propagate the store put()\'s versionId through to the caller on a successful write', async () => {
      stubCurrentConfig(remoteFileStore);
      remoteFileStore.put.mockResolvedValueOnce({ etag: 'etag-2', versionId: 'v-123' });

      const service = new TfvarsService(makeConfig({ bucket: 'my-tfvars-bucket' }), remoteFileStore);

      await expect(
        service.updateGameServer('palworld', UPDATED_ENTRY_CONFIG, 'etag-1'),
      ).resolves.toEqual({ etag: 'etag-2', versionId: 'v-123' });
    });

    it('should throw OptimisticLockError (not a raw RemoteFileConflictError) when the store rejects a conditional put', async () => {
      stubCurrentConfig(remoteFileStore);
      remoteFileStore.put.mockRejectedValue(
        new RemoteFileConflictError('deployment-config.json', 'Conflicting write detected.', 'etag-stale'),
      );

      const service = new TfvarsService(makeConfig({ bucket: 'my-tfvars-bucket' }), remoteFileStore);

      await expect(
        service.addGameServer('terraria', NEW_ENTRY_CONFIG, 'etag-stale'),
      ).rejects.toBeInstanceOf(OptimisticLockError);
    });
  });

  describe('structured lock error', () => {
    it('should carry the expected and current etags so callers can display "remote moved — refresh"', async () => {
      remoteFileStore.get
        .mockResolvedValueOnce({
          body: new TextEncoder().encode(FIXTURE_JSON),
          etag: 'etag-stale',
        })
        // Follow-up get() TfvarsService issues after the conflict, to report
        // the current etag on the thrown error.
        .mockResolvedValueOnce({
          body: new TextEncoder().encode(FIXTURE_JSON),
          etag: 'etag-current',
        });
      remoteFileStore.put.mockRejectedValue(
        new RemoteFileConflictError('deployment-config.json', 'Conflicting write detected.', 'etag-stale'),
      );

      const service = new TfvarsService(makeConfig({ bucket: 'my-tfvars-bucket' }), remoteFileStore);

      let caught: unknown;
      try {
        await service.updateGameServer('palworld', UPDATED_ENTRY_CONFIG, 'etag-stale');
      } catch (err) {
        caught = err;
      }

      expect(caught).toBeInstanceOf(OptimisticLockError);
      const lockError = caught as OptimisticLockError;
      expect(lockError.expectedEtag).toBe('etag-stale');
      expect(lockError.currentEtag).toBe('etag-current');
      expect(lockError.message).toMatch(/etag-stale/);
    });

    it('should still populate expectedEtag (with currentEtag undefined) when the follow-up get() itself fails', async () => {
      remoteFileStore.get.mockResolvedValueOnce({
        body: new TextEncoder().encode(FIXTURE_JSON),
        etag: 'etag-stale',
      });
      remoteFileStore.put.mockRejectedValue(
        new RemoteFileConflictError('deployment-config.json', 'Conflicting write detected.', 'etag-stale'),
      );
      // Follow-up get() (to resolve the current etag for the error) fails too.
      remoteFileStore.get.mockRejectedValueOnce(new Error('network error'));

      const service = new TfvarsService(makeConfig({ bucket: 'my-tfvars-bucket' }), remoteFileStore);

      let caught: unknown;
      try {
        await service.removeGameServer('valheim', 'etag-stale');
      } catch (err) {
        caught = err;
      }

      expect(caught).toBeInstanceOf(OptimisticLockError);
      const lockError = caught as OptimisticLockError;
      expect(lockError.expectedEtag).toBe('etag-stale');
      expect(lockError.currentEtag).toBeUndefined();
    });
  });

  describe('getTopLevelSettings / updateTopLevelSettings (task 9.7)', () => {
    it('should return every top-level field except gameServers, plus the read etag', async () => {
      stubCurrentConfig(remoteFileStore);
      const service = new TfvarsService(makeConfig({ bucket: 'my-tfvars-bucket' }), remoteFileStore);

      const { settings, etag } = await service.getTopLevelSettings();

      const { gameServers: _gameServers, ...expectedSettings } = FIXTURE_CONFIG;
      expect(settings).toEqual(expectedSettings);
      expect(settings).not.toHaveProperty('gameServers');
      expect(etag).toBe('etag-1');
    });

    it('should reject getTopLevelSettings with ConfigurationNotConfiguredError when no bucket is configured', async () => {
      const service = new TfvarsService(makeConfig({ bucket: null }), remoteFileStore);
      await expect(service.getTopLevelSettings()).rejects.toBeInstanceOf(ConfigurationNotConfiguredError);
      expect(remoteFileStore.get).not.toHaveBeenCalled();
    });

    describe('defaulting a document missing fields (review round 1, finding I2)', () => {
      /**
       * A stored document that predates the three base-allowlist array
       * fields and the numeric watchdog/dnsTtl fields entirely — simulates a
       * `deployment-config.json` written by an older app version, before
       * those fields existed. `JSON.stringify` naturally omits `undefined`
       * properties, so building this fixture as a plain object with those
       * keys never set (rather than explicitly `undefined`) reproduces
       * exactly what an old on-disk document looks like.
       */
      const CONFIG_MISSING_FIELDS = {
        projectName: 'hyveon',
        awsRegion: 'us-east-1',
        vpcCidr: '10.0.0.0/16',
        hostedZoneName: 'example.com',
        discordApplicationId: '',
        auditTableName: '',
        runsTableName: '',
        gameServers: {},
      };
      const CONFIG_MISSING_FIELDS_JSON = JSON.stringify(CONFIG_MISSING_FIELDS);

      it('should default the three base-allowlist arrays to [] rather than returning them as undefined', async () => {
        stubCurrentConfig(remoteFileStore, CONFIG_MISSING_FIELDS_JSON);
        const service = new TfvarsService(makeConfig({ bucket: 'my-tfvars-bucket' }), remoteFileStore);

        const { settings } = await service.getTopLevelSettings();

        expect(settings.baseAllowedGuilds).toEqual([]);
        expect(settings.baseAdminUserIds).toEqual([]);
        expect(settings.baseAdminRoleIds).toEqual([]);
      });

      it('should default the missing numeric fields to their Terraform defaults rather than returning them as undefined', async () => {
        stubCurrentConfig(remoteFileStore, CONFIG_MISSING_FIELDS_JSON);
        const service = new TfvarsService(makeConfig({ bucket: 'my-tfvars-bucket' }), remoteFileStore);

        const { settings } = await service.getTopLevelSettings();

        expect(settings.dnsTtl).toBe(DEPLOYMENT_CONFIG_DEFAULTS.dnsTtl);
        expect(settings.watchdogIntervalMinutes).toBe(DEPLOYMENT_CONFIG_DEFAULTS.watchdogIntervalMinutes);
        expect(settings.watchdogIdleChecks).toBe(DEPLOYMENT_CONFIG_DEFAULTS.watchdogIdleChecks);
        expect(settings.watchdogMinPackets).toBe(DEPLOYMENT_CONFIG_DEFAULTS.watchdogMinPackets);
      });

      it('should give each call a fresh array reference for the three base-allowlist fields (never a shared mutable default)', async () => {
        stubCurrentConfig(remoteFileStore, CONFIG_MISSING_FIELDS_JSON);
        const service = new TfvarsService(makeConfig({ bucket: 'my-tfvars-bucket' }), remoteFileStore);

        const first = await service.getTopLevelSettings();
        const second = await service.getTopLevelSettings();

        expect(first.settings.baseAllowedGuilds).not.toBe(second.settings.baseAllowedGuilds);
      });

      it('should leave an already-complete document\'s values untouched (defaulting is a no-op, not a silent overwrite)', async () => {
        stubCurrentConfig(remoteFileStore);
        const service = new TfvarsService(makeConfig({ bucket: 'my-tfvars-bucket' }), remoteFileStore);

        const { settings } = await service.getTopLevelSettings();

        expect(settings.baseAllowedGuilds).toEqual(FIXTURE_CONFIG.baseAllowedGuilds);
        expect(settings.dnsTtl).toBe(FIXTURE_CONFIG.dnsTtl);
        expect(settings.awsRegion).toBe(FIXTURE_CONFIG.awsRegion);
      });
    });

    it('should merge a patch onto the current top-level fields, leaving every gameServers entry intact', async () => {
      stubCurrentConfig(remoteFileStore);
      remoteFileStore.put.mockResolvedValue({ etag: 'etag-2' });

      const service = new TfvarsService(makeConfig({ bucket: 'my-tfvars-bucket' }), remoteFileStore);
      const result = await service.updateTopLevelSettings({ dnsTtl: 60, awsRegion: 'eu-west-1' });
      expect(result).toEqual({ etag: 'etag-2', versionId: undefined });

      expect(remoteFileStore.put).toHaveBeenCalledTimes(1);
      const [, body] = remoteFileStore.put.mock.calls[0] as [string, Uint8Array];
      const written = JSON.parse(new TextDecoder().decode(body)) as DeploymentConfig;

      expect(written.dnsTtl).toBe(60);
      expect(written.awsRegion).toBe('eu-west-1');
      // Every other top-level field round-trips unchanged.
      expect(written.projectName).toBe(FIXTURE_CONFIG.projectName);
      expect(written.hostedZoneName).toBe(FIXTURE_CONFIG.hostedZoneName);
      // gameServers survives completely untouched.
      expect(written.gameServers).toEqual(FIXTURE_CONFIG.gameServers);
    });

    it('should leave gameServers untouched even when a caller sneaks a "gameServers" key into the patch at runtime', async () => {
      stubCurrentConfig(remoteFileStore);
      remoteFileStore.put.mockResolvedValue({ etag: 'etag-2' });

      const service = new TfvarsService(makeConfig({ bucket: 'my-tfvars-bucket' }), remoteFileStore);
      // `updateTopLevelSettings`'s parameter type excludes `gameServers`, but
      // that's only a compile-time guarantee — this payload simulates what a
      // buggy/malicious IPC caller could still send at runtime (the IPC
      // boundary carries plain JSON, not enforced TypeScript types), proving
      // the service-level defense (not just the type system) is what
      // actually protects the map.
      const maliciousPatch = {
        dnsTtl: 90,
        gameServers: { palworld: { image: 'evil/corrupted-image', cpu: 1, memory: 1, ports: [], volumes: [] } },
      } as unknown as Partial<DeploymentConfig>;

      await service.updateTopLevelSettings(maliciousPatch);

      const [, body] = remoteFileStore.put.mock.calls[0] as [string, Uint8Array];
      const written = JSON.parse(new TextDecoder().decode(body)) as DeploymentConfig;

      expect(written.dnsTtl).toBe(90);
      expect(written.gameServers).toEqual(FIXTURE_CONFIG.gameServers);
      expect(written.gameServers.palworld).not.toEqual(
        expect.objectContaining({ image: 'evil/corrupted-image' }),
      );
    });

    it('should honour expectedVersionId as the conditional-put ifMatch guard', async () => {
      stubCurrentConfig(remoteFileStore);
      remoteFileStore.put.mockResolvedValue({ etag: 'etag-2' });

      const service = new TfvarsService(makeConfig({ bucket: 'my-tfvars-bucket' }), remoteFileStore);
      await service.updateTopLevelSettings({ dnsTtl: 60 }, 'etag-1');

      expect(remoteFileStore.put).toHaveBeenCalledWith('deployment-config.json', expect.any(Uint8Array), {
        ifMatch: 'etag-1',
      });
    });

    it('should throw OptimisticLockError (not a raw RemoteFileConflictError) when the store rejects a conditional put', async () => {
      stubCurrentConfig(remoteFileStore);
      remoteFileStore.put.mockRejectedValue(
        new RemoteFileConflictError('deployment-config.json', 'Conflicting write detected.', 'etag-stale'),
      );

      const service = new TfvarsService(makeConfig({ bucket: 'my-tfvars-bucket' }), remoteFileStore);

      await expect(service.updateTopLevelSettings({ dnsTtl: 60 }, 'etag-stale')).rejects.toBeInstanceOf(
        OptimisticLockError,
      );
    });

    it('should reject updateTopLevelSettings with ConfigurationNotConfiguredError when no bucket is configured', async () => {
      const service = new TfvarsService(makeConfig({ bucket: null }), remoteFileStore);
      await expect(service.updateTopLevelSettings({ dnsTtl: 60 })).rejects.toBeInstanceOf(
        ConfigurationNotConfiguredError,
      );
      expect(remoteFileStore.put).not.toHaveBeenCalled();
    });

    it('should invalidate the in-memory cache so the next getGameServers() re-reads the written content', async () => {
      stubCurrentConfig(remoteFileStore);
      remoteFileStore.put.mockResolvedValue({ etag: 'etag-2' });

      const service = new TfvarsService(makeConfig({ bucket: 'my-tfvars-bucket' }), remoteFileStore);
      await service.getGameServers();
      expect(remoteFileStore.get).toHaveBeenCalledTimes(1);

      // updateTopLevelSettings's own writeConfig() reads the current config
      // before mutating it (an extra `get`, unlike restoreRawTfvars's
      // unconditional-overwrite path above), then the post-write
      // getGameServers() re-read below issues a third.
      await service.updateTopLevelSettings({ dnsTtl: 60 });
      await service.getGameServers();

      expect(remoteFileStore.get).toHaveBeenCalledTimes(3);
    });
  });

  /**
   * Task 6.5 (`migrate-iac-to-pulumi` Phase 6) / `pulumi-infra-program`'s
   * "Configuration round-trips losslessly" scenario: a `DeploymentConfig`
   * with EVERY field populated — every top-level field with a non-default,
   * non-empty value, and a `gameServers` entry with every optional
   * `GameServerConfig` field populated (not omitted) — must survive a
   * write-then-read cycle through `TfvarsService`'s real write/read methods
   * deeply equal to what went in, including booleans and numerics.
   *
   * Exercises the *actual* service methods rather than a bare
   * `JSON.stringify`/`parse` round trip: `addGameServer()` (which reads,
   * mutates via the real `insertGameServerEntry`/`serializeConfig` internals,
   * and writes) followed by a fresh `getGameServers()` and `getRawConfig()`
   * (both driven by `fetchRawConfig()`). The stubbed `RemoteFileStore` is
   * backed by a single mutable "object" (mirroring
   * `games.controller.integration.test.ts`'s `makeMutableRemoteFileStore`),
   * so the read-back genuinely reflects what the write produced rather than
   * a canned fixture.
   */
  describe('comprehensive round-trip (every field, top-level and per-game)', () => {
    it('should survive a write-then-read cycle through addGameServer/getGameServers/getRawConfig deeply equal to the original, including booleans and numerics', async () => {
      const startingConfig: DeploymentConfig = {
        projectName: 'full-round-trip-project',
        awsRegion: 'eu-west-1',
        vpcCidr: '172.16.0.0/16',
        hostedZoneName: 'full-round-trip.example.com',
        dnsTtl: 60,
        watchdogIntervalMinutes: 20,
        watchdogIdleChecks: 6,
        watchdogMinPackets: 250,
        baseAllowedGuilds: ['guild-a', 'guild-b'],
        baseAdminUserIds: ['user-a'],
        baseAdminRoleIds: ['role-a', 'role-b'],
        discordApplicationId: 'discord-app-123',
        auditTableName: 'custom-audit-table',
        runsTableName: 'custom-runs-table',
        gameServers: {
          existing: {
            image: 'example/existing-server:latest',
            cpu: 1024,
            memory: 2048,
            ports: [{ container: 9000, protocol: 'tcp' }],
            volumes: [{ name: 'data', container_path: '/data' }],
          },
        },
      };
      const startingJson = JSON.stringify(startingConfig, null, 2) + '\n';

      /** Every optional `GameServerConfig` field populated — nothing omitted. */
      const NEW_GAME_ALL_FIELDS = {
        image: 'thijsvanloef/palworld-server-docker:latest',
        cpu: 2048,
        memory: 8192,
        ports: [
          { container: 8211, protocol: 'udp' },
          { container: 27015, protocol: 'udp' },
        ],
        environment: [
          { name: 'PLAYERS', value: '16' },
          { name: 'SERVER_NAME', value: 'Full Round-Trip Server' },
        ],
        volumes: [
          { name: 'saves', container_path: '/palworld' },
          { name: 'mods', container_path: '/palworld/mods' },
        ],
        https: true,
        connect_message: 'Connect to {host}:{port}',
        file_seeds: [
          {
            path: '/palworld/Pal/Saved/Config/LinuxServer/PalWorldSettings.ini',
            content: '[/Script/Pal.PalGameWorldSettings]\nOptionSettings=(Difficulty=None)\n',
            mode: '0644',
          },
          {
            path: '/palworld/Pal/Content/Paks/MyMod.pak',
            content_base64: 'UEsDBBQAAAAIAAAAIQAAAAAAAAAAAAAAAAAA',
            mode: '0600',
          },
        ],
      };

      // A single mutable "S3 object" backs both get() and put() — the write
      // this test performs is genuinely what the subsequent read observes,
      // not a separately-stubbed fixture.
      let currentJson = startingJson;
      let etagCounter = 1;
      const remoteFileStore: RemoteFileStore = {
        get: vi.fn().mockImplementation(async () => ({
          body: new TextEncoder().encode(currentJson),
          etag: `etag-${etagCounter}`,
        })),
        put: vi.fn().mockImplementation(async (_key: string, body: Uint8Array) => {
          currentJson = new TextDecoder().decode(body);
          etagCounter += 1;
          return { etag: `etag-${etagCounter}` };
        }),
        getVersion: vi.fn(),
        listVersions: vi.fn(),
      };

      const service = new TfvarsService(makeConfig({ bucket: 'my-tfvars-bucket' }), remoteFileStore);

      const writeResult = await service.addGameServer('full-round-trip-game', NEW_GAME_ALL_FIELDS);
      expect(writeResult.etag).toBe('etag-2');

      // Read back through getRawConfig() (bypasses the in-memory cache) and
      // confirm the WHOLE document — every top-level field plus both
      // gameServers entries — is deeply equal to what should have resulted,
      // not just a subset.
      const { config: rawConfig } = await service.getRawConfig();
      const parsed = JSON.parse(rawConfig) as DeploymentConfig;

      const expectedConfig: DeploymentConfig = {
        ...startingConfig,
        gameServers: {
          ...startingConfig.gameServers,
          'full-round-trip-game': NEW_GAME_ALL_FIELDS,
        },
      };
      expect(parsed).toEqual(expectedConfig);

      // Explicitly assert booleans/numerics decoded to their real JS types —
      // `toEqual` alone wouldn't catch e.g. `https` surviving as the string
      // `"true"` or `cpu` as `"2048"`.
      expect(typeof parsed.dnsTtl).toBe('number');
      expect(typeof parsed.watchdogIntervalMinutes).toBe('number');
      expect(typeof parsed.gameServers['full-round-trip-game']!.cpu).toBe('number');
      expect(typeof parsed.gameServers['full-round-trip-game']!.https).toBe('boolean');
      expect(parsed.gameServers['full-round-trip-game']!.https).toBe(true);

      // getGameServers() (the flattened, cached read path) must agree.
      service.invalidateCache();
      const gameServers = await service.getGameServers();
      expect(gameServers).toEqual([
        { name: 'existing', ...startingConfig.gameServers.existing },
        { name: 'full-round-trip-game', ...NEW_GAME_ALL_FIELDS },
      ]);
    });
  });
});
