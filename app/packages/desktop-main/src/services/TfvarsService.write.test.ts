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
 */
import 'reflect-metadata';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { DeploymentConfig, RemoteFileStore } from '@hyveon/shared';
import { OptimisticLockError, RemoteFileConflictError } from '@hyveon/shared';

vi.mock('fs', () => ({
  readFileSync: vi.fn(),
  existsSync: vi.fn(),
  writeFileSync: vi.fn(),
}));

vi.mock('../logger.js', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

import { readFileSync, existsSync, writeFileSync } from 'fs';
import { TfvarsService, GameServerEntryError } from './TfvarsService.js';
import { ConfigService } from './ConfigService.js';

/** Strongly-typed mock handles for the `fs` module. */
const mockExists = vi.mocked(existsSync);
const mockRead = vi.mocked(readFileSync);
const mockWrite = vi.mocked(writeFileSync);

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
 * reads. `bucket: null` selects local mode; any non-null string selects S3
 * mode.
 */
function makeConfig(opts: { bucket?: string | null; path?: string }): ConfigService {
  const stub: Partial<ConfigService> = {
    getTfvarsBucket: () => opts.bucket ?? null,
    getTfvarsPath: () => opts.path ?? '/repo/terraform/deployment-config.json',
    readEnvTfvarsCacheTtlMs: () => 30000,
  };
  return stub as ConfigService;
}

describe('TfvarsService write path', () => {
  let remoteFileStore: RemoteFileStore & { get: ReturnType<typeof vi.fn>; put: ReturnType<typeof vi.fn> };

  beforeEach(() => {
    remoteFileStore = makeRemoteFileStore();
    vi.clearAllMocks();
  });

  describe('sibling preservation (local mode)', () => {
    it('should leave every existing gameServers entry and every top-level field intact when addGameServer splices in a new entry', async () => {
      mockExists.mockReturnValue(true);
      mockRead.mockReturnValue(FIXTURE_JSON);

      const service = new TfvarsService(makeConfig({ bucket: null }), remoteFileStore);
      const result = await service.addGameServer('terraria', NEW_ENTRY_CONFIG);
      expect(result).toEqual({ etag: '', versionId: undefined });

      expect(mockWrite).toHaveBeenCalledTimes(1);
      const written = JSON.parse(mockWrite.mock.calls[0]![1] as string) as DeploymentConfig;

      expect(written.projectName).toBe(FIXTURE_CONFIG.projectName);
      expect(written.awsRegion).toBe(FIXTURE_CONFIG.awsRegion);
      expect(written.gameServers.palworld).toEqual(FIXTURE_CONFIG.gameServers.palworld);
      expect(written.gameServers.valheim).toEqual(FIXTURE_CONFIG.gameServers.valheim);
      expect(written.gameServers.terraria).toEqual(NEW_ENTRY_CONFIG);
    });

    it('should leave every other gameServers entry and every top-level field intact when updateGameServer replaces an existing entry', async () => {
      mockExists.mockReturnValue(true);
      mockRead.mockReturnValue(FIXTURE_JSON);

      const service = new TfvarsService(makeConfig({ bucket: null }), remoteFileStore);
      await service.updateGameServer('palworld', UPDATED_ENTRY_CONFIG);

      expect(mockWrite).toHaveBeenCalledTimes(1);
      const written = JSON.parse(mockWrite.mock.calls[0]![1] as string) as DeploymentConfig;

      expect(written.projectName).toBe(FIXTURE_CONFIG.projectName);
      expect(written.gameServers.palworld).toEqual(UPDATED_ENTRY_CONFIG);
      // The untouched valheim entry survives unchanged.
      expect(written.gameServers.valheim).toEqual(FIXTURE_CONFIG.gameServers.valheim);
    });

    it('should leave every other gameServers entry and every top-level field intact when removeGameServer cuts an entry', async () => {
      mockExists.mockReturnValue(true);
      mockRead.mockReturnValue(FIXTURE_JSON);

      const service = new TfvarsService(makeConfig({ bucket: null }), remoteFileStore);
      await service.removeGameServer('palworld');

      expect(mockWrite).toHaveBeenCalledTimes(1);
      const written = JSON.parse(mockWrite.mock.calls[0]![1] as string) as DeploymentConfig;

      expect(written.gameServers.palworld).toBeUndefined();
      expect(written.gameServers.valheim).toEqual(FIXTURE_CONFIG.gameServers.valheim);
      expect(written.awsRegion).toBe(FIXTURE_CONFIG.awsRegion);
    });
  });

  describe('boolean round-trip', () => {
    it('should serialize https: true as a real JSON boolean (not the string "true") when enabling HTTPS on an entry that omits the field entirely', async () => {
      mockExists.mockReturnValue(true);
      mockRead.mockReturnValue(FIXTURE_JSON);

      const service = new TfvarsService(makeConfig({ bucket: null }), remoteFileStore);
      await service.updateGameServer('palworld', { ...UPDATED_ENTRY_CONFIG, https: true });

      const written = JSON.parse(mockWrite.mock.calls[0]![1] as string) as DeploymentConfig;
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
      mockExists.mockReturnValue(true);
      mockRead.mockReturnValue(JSON.stringify(fixtureWithHttpsTrue));

      const service = new TfvarsService(makeConfig({ bucket: null }), remoteFileStore);
      await service.updateGameServer('palworld', { ...UPDATED_ENTRY_CONFIG, https: false });

      const written = JSON.parse(mockWrite.mock.calls[0]![1] as string) as DeploymentConfig;
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
      mockExists.mockReturnValue(true);
      mockRead.mockReturnValue(JSON.stringify(fixtureWithHttpsTrue));

      const service = new TfvarsService(makeConfig({ bucket: null }), remoteFileStore);
      await service.updateGameServer('palworld', { ...UPDATED_ENTRY_CONFIG, memory: 32768, https: true });

      const written = JSON.parse(mockWrite.mock.calls[0]![1] as string) as DeploymentConfig;
      expect(written.gameServers.palworld!.https).toBe(true);
      expect(written.gameServers.palworld!.memory).toBe(32768);
      expect(written.gameServers.palworld!.image).toBe('thijsvanloef/palworld-server-docker:v2');
      expect(written.gameServers.valheim).toEqual(fixtureWithHttpsTrue.gameServers.valheim);
    });
  });

  describe('local-mode write return value', () => {
    it('should resolve with versionId: undefined since the local filesystem has no versioning concept', async () => {
      mockExists.mockReturnValue(true);
      mockRead.mockReturnValue(FIXTURE_JSON);

      const service = new TfvarsService(makeConfig({ bucket: null }), remoteFileStore);

      await expect(service.updateGameServer('palworld', UPDATED_ENTRY_CONFIG)).resolves.toEqual({
        etag: '',
        versionId: undefined,
      });
      await expect(service.removeGameServer('valheim')).resolves.toEqual({
        etag: '',
        versionId: undefined,
      });
    });
  });

  describe('addGameServer name validation', () => {
    it('should reject a name containing uppercase letters instead of writing a corrupt DNS label', async () => {
      mockExists.mockReturnValue(true);
      mockRead.mockReturnValue(FIXTURE_JSON);

      const service = new TfvarsService(makeConfig({ bucket: null }), remoteFileStore);

      await expect(service.addGameServer('Terraria', NEW_ENTRY_CONFIG)).rejects.toThrow(/is invalid/);
      expect(mockWrite).not.toHaveBeenCalled();
    });

    it('should reject a name containing an underscore, since underscores are not valid in a DNS label', async () => {
      mockExists.mockReturnValue(true);
      mockRead.mockReturnValue(FIXTURE_JSON);

      const service = new TfvarsService(makeConfig({ bucket: null }), remoteFileStore);

      await expect(service.addGameServer('my_server', NEW_ENTRY_CONFIG)).rejects.toThrow(/is invalid/);
      expect(mockWrite).not.toHaveBeenCalled();
    });

    it('should reject a name with a leading hyphen', async () => {
      mockExists.mockReturnValue(true);
      mockRead.mockReturnValue(FIXTURE_JSON);

      const service = new TfvarsService(makeConfig({ bucket: null }), remoteFileStore);

      await expect(service.addGameServer('-terraria', NEW_ENTRY_CONFIG)).rejects.toThrow(/is invalid/);
      expect(mockWrite).not.toHaveBeenCalled();
    });

    it('should reject an empty name', async () => {
      mockExists.mockReturnValue(true);
      mockRead.mockReturnValue(FIXTURE_JSON);

      const service = new TfvarsService(makeConfig({ bucket: null }), remoteFileStore);

      await expect(service.addGameServer('', NEW_ENTRY_CONFIG)).rejects.toThrow(/is invalid/);
      expect(mockWrite).not.toHaveBeenCalled();
    });

    it('should accept a name containing internal hyphens, since those are valid within a DNS label', async () => {
      mockExists.mockReturnValue(true);
      mockRead.mockReturnValue(FIXTURE_JSON);

      const service = new TfvarsService(makeConfig({ bucket: null }), remoteFileStore);

      await expect(service.addGameServer('my-server-2', NEW_ENTRY_CONFIG)).resolves.toEqual({
        etag: '',
        versionId: undefined,
      });
      expect(mockWrite).toHaveBeenCalledTimes(1);
    });

    it('should reject adding a name that already exists in gameServers, with reason: \'duplicate-name\' pinned for GamesWriteService\'s coupling', async () => {
      mockExists.mockReturnValue(true);
      mockRead.mockReturnValue(FIXTURE_JSON);

      const service = new TfvarsService(makeConfig({ bucket: null }), remoteFileStore);

      // `GamesWriteService.createGame()`'s catch block narrows on
      // `err.reason === 'duplicate-name'` (not just the error's message) to
      // decide whether to surface `{ code: 'validation', path: 'name' }` —
      // pinning the literal `reason` value here, not just a message regex,
      // is what actually guards that coupling against silent drift.
      await expect(service.addGameServer('palworld', NEW_ENTRY_CONFIG)).rejects.toMatchObject({
        reason: 'duplicate-name',
      });
      await expect(service.addGameServer('palworld', NEW_ENTRY_CONFIG)).rejects.toBeInstanceOf(GameServerEntryError);
      expect(mockWrite).not.toHaveBeenCalled();
    });
  });

  describe('updateGameServer / removeGameServer not-found', () => {
    it('should reject updateGameServer when the name does not exist in gameServers, with reason: \'not-found\' pinned for GamesWriteService\'s coupling', async () => {
      mockExists.mockReturnValue(true);
      mockRead.mockReturnValue(FIXTURE_JSON);

      const service = new TfvarsService(makeConfig({ bucket: null }), remoteFileStore);

      await expect(service.updateGameServer('does-not-exist', UPDATED_ENTRY_CONFIG)).rejects.toMatchObject({
        reason: 'not-found',
      });
      expect(mockWrite).not.toHaveBeenCalled();
    });

    it('should reject removeGameServer when the name does not exist in gameServers, with reason: \'not-found\' pinned for GamesWriteService\'s coupling', async () => {
      mockExists.mockReturnValue(true);
      mockRead.mockReturnValue(FIXTURE_JSON);

      const service = new TfvarsService(makeConfig({ bucket: null }), remoteFileStore);

      await expect(service.removeGameServer('does-not-exist')).rejects.toMatchObject({ reason: 'not-found' });
      expect(mockWrite).not.toHaveBeenCalled();
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
      mockExists.mockReturnValue(true);
      mockRead.mockReturnValue(JSON.stringify(FIXTURE_WITH_LEGACY_NAME));

      const service = new TfvarsService(makeConfig({ bucket: null }), remoteFileStore);

      await expect(service.updateGameServer(LEGACY_NAME, UPDATED_ENTRY_CONFIG)).resolves.toEqual({
        etag: '',
        versionId: undefined,
      });
      const written = JSON.parse(mockWrite.mock.calls[0]![1] as string) as DeploymentConfig;
      expect(written.gameServers[LEGACY_NAME]).toEqual(UPDATED_ENTRY_CONFIG);
    });

    it('should let removeGameServer succeed on a legacy non-DNS-safe key (never re-validates an existing name)', async () => {
      mockExists.mockReturnValue(true);
      mockRead.mockReturnValue(JSON.stringify(FIXTURE_WITH_LEGACY_NAME));

      const service = new TfvarsService(makeConfig({ bucket: null }), remoteFileStore);

      await expect(service.removeGameServer(LEGACY_NAME)).resolves.toEqual({ etag: '', versionId: undefined });
      const written = JSON.parse(mockWrite.mock.calls[0]![1] as string) as DeploymentConfig;
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

    it('should write the file directly in local mode, mirroring the other write paths', async () => {
      mockExists.mockReturnValue(true);

      const service = new TfvarsService(makeConfig({ bucket: null }), remoteFileStore);

      await expect(service.restoreRawTfvars(FIXTURE_JSON)).resolves.toEqual({
        etag: '',
        versionId: undefined,
      });
      expect(mockWrite).toHaveBeenCalledWith(expect.any(String), FIXTURE_JSON, 'utf-8');
    });

    it('should invalidate the in-memory cache so the next getGameServers() re-reads the restored content', async () => {
      remoteFileStore.get.mockResolvedValue({
        body: new TextEncoder().encode(FIXTURE_JSON),
        etag: 'etag-1',
      });
      remoteFileStore.put.mockResolvedValueOnce({ etag: 'etag-restored', versionId: 'v-restored' });

      const service = new TfvarsService(makeConfig({ bucket: 'my-tfvars-bucket' }), remoteFileStore);
      await service.getGameServers();
      expect(remoteFileStore.get).toHaveBeenCalledTimes(1);

      await service.restoreRawTfvars(FIXTURE_JSON);
      await service.getGameServers();

      expect(remoteFileStore.get).toHaveBeenCalledTimes(2);
    });
  });

  describe('concurrent writes (S3 mode)', () => {
    it('should fail the second of two concurrent writes with a clear OptimisticLockError, not silently overwrite the first', async () => {
      // Both writers read the same starting etag...
      remoteFileStore.get.mockResolvedValue({
        body: new TextEncoder().encode(FIXTURE_JSON),
        etag: 'etag-1',
      });
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
      remoteFileStore.get.mockResolvedValue({
        body: new TextEncoder().encode(FIXTURE_JSON),
        etag: 'etag-1',
      });
      remoteFileStore.put.mockResolvedValueOnce({ etag: 'etag-2', versionId: 'v-123' });

      const service = new TfvarsService(makeConfig({ bucket: 'my-tfvars-bucket' }), remoteFileStore);

      await expect(
        service.updateGameServer('palworld', UPDATED_ENTRY_CONFIG, 'etag-1'),
      ).resolves.toEqual({ etag: 'etag-2', versionId: 'v-123' });
    });

    it('should throw OptimisticLockError (not a raw RemoteFileConflictError) when the store rejects a conditional put', async () => {
      remoteFileStore.get.mockResolvedValue({
        body: new TextEncoder().encode(FIXTURE_JSON),
        etag: 'etag-1',
      });
      remoteFileStore.put.mockRejectedValue(
        new RemoteFileConflictError('deployment-config.json', 'Conflicting write detected.', 'etag-stale'),
      );

      const service = new TfvarsService(makeConfig({ bucket: 'my-tfvars-bucket' }), remoteFileStore);

      await expect(
        service.addGameServer('terraria', NEW_ENTRY_CONFIG, 'etag-stale'),
      ).rejects.toBeInstanceOf(OptimisticLockError);
      await expect(mockWrite).not.toHaveBeenCalled();
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
});
