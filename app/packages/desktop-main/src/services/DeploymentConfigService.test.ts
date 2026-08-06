/**
 * Tests for `DeploymentConfigService` — the S3-backed deployment-config reader/parser.
 *
 * The config is plain JSON, so fixtures are inline `DeploymentConfig`-shaped
 * objects `JSON.stringify`d — no fixture files needed (there's no
 * comment/heredoc complexity to fixture-test with JSON).
 *
 * There is no local-file fallback — every test that used to select "local mode" via a
 * `null` bucket now exercises the "unconfigured" behaviour instead (see the
 * `unconfigured` describe block below), which asserts `fs` is never touched.
 * `fs` stays mocked here purely so that assertion is meaningful — this
 * module no longer imports `fs` in production code at all.
 */
import 'reflect-metadata';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { DeploymentConfig, RemoteFileStore } from '@hyveon/shared';

// Shared mock instances behind both the bare `'fs'` specifier and the
// `'node:fs'` specifier — Node treats these as distinct module ids, so
// mocking only `'fs'` would let a reintroduced local-disk fallback via
// `node:fs` slip past this file's "no disk fallback reachable" assertions
// unnoticed.
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

import { DeploymentConfigService, ConfigurationNotConfiguredError, GameServerEntryError } from './DeploymentConfigService.js';
import { ConfigService } from './ConfigService.js';
import { logger } from '../logger.js';

/** A minimal, valid deployment config defining a single game server. */
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
      ports: [
        { container: 8211, protocol: 'udp' },
        { container: 27015, protocol: 'udp' },
      ],
      environment: [{ name: 'PLAYERS', value: '16' }],
      volumes: [{ name: 'saves', container_path: '/palworld' }],
      https: false,
      connect_message: 'Connect to {host}:{port}',
    },
  },
};

/** `FIXTURE_CONFIG` serialized exactly as `DeploymentConfigService` would write/read it. */
const FIXTURE_JSON = JSON.stringify(FIXTURE_CONFIG, null, 2) + '\n';

/** Expected `GameServer[]` produced by parsing {@link FIXTURE_JSON}. */
const EXPECTED_GAME_SERVERS = [
  {
    name: 'palworld',
    image: 'thijsvanloef/palworld-server-docker:latest',
    cpu: 2048,
    memory: 8192,
    ports: [
      { container: 8211, protocol: 'udp' },
      { container: 27015, protocol: 'udp' },
    ],
    environment: [{ name: 'PLAYERS', value: '16' }],
    volumes: [{ name: 'saves', container_path: '/palworld' }],
    https: false,
    connect_message: 'Connect to {host}:{port}',
  },
];

/** A deployment config defining two entries in `gameServers`. */
const FIXTURE_MULTIPLE_GAMES_JSON = JSON.stringify(
  {
    ...FIXTURE_CONFIG,
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
  },
  null,
  2,
);

/** Expected `GameServer[]` produced by parsing {@link FIXTURE_MULTIPLE_GAMES_JSON}. */
const EXPECTED_MULTIPLE_GAME_SERVERS = [
  {
    name: 'palworld',
    image: 'thijsvanloef/palworld-server-docker:latest',
    cpu: 2048,
    memory: 8192,
    ports: [{ container: 8211, protocol: 'udp' }],
    volumes: [{ name: 'saves', container_path: '/palworld' }],
  },
  {
    name: 'valheim',
    image: 'lloesche/valheim-server',
    cpu: 1024,
    memory: 4096,
    ports: [{ container: 2456, protocol: 'udp' }],
    volumes: [{ name: 'saves', container_path: '/config' }],
  },
];

/**
 * Deployment config defining two entries (`minecraft`, `terraria`) with only
 * the required `GameServer` fields (`image`, `cpu`, `memory`, `ports`,
 * `volumes`) — every optional field (`environment`, `https`,
 * `connect_message`, `file_seeds`) is omitted entirely, rather than written
 * as an explicit `null`/`undefined`.
 */
const FIXTURE_OMITTED_OPTIONALS_JSON = JSON.stringify(
  {
    ...FIXTURE_CONFIG,
    gameServers: {
      minecraft: {
        image: 'itzg/minecraft-server',
        cpu: 1024,
        memory: 2048,
        ports: [{ container: 25565, protocol: 'tcp' }],
        volumes: [{ name: 'world', container_path: '/data' }],
      },
      terraria: {
        image: 'ryshe/terraria',
        cpu: 512,
        memory: 1024,
        ports: [{ container: 7777, protocol: 'tcp' }],
        volumes: [{ name: 'world', container_path: '/config' }],
      },
    },
  },
  null,
  2,
);

/** Expected `GameServer[]` produced by parsing {@link FIXTURE_OMITTED_OPTIONALS_JSON}. */
const EXPECTED_OMITTED_OPTIONALS_GAME_SERVERS = [
  {
    name: 'minecraft',
    image: 'itzg/minecraft-server',
    cpu: 1024,
    memory: 2048,
    ports: [{ container: 25565, protocol: 'tcp' }],
    volumes: [{ name: 'world', container_path: '/data' }],
  },
  {
    name: 'terraria',
    image: 'ryshe/terraria',
    cpu: 512,
    memory: 1024,
    ports: [{ container: 7777, protocol: 'tcp' }],
    volumes: [{ name: 'world', container_path: '/config' }],
  },
];

/**
 * Deployment config exercising a lossless round trip of every JSON scalar
 * type `GameServer` can carry: numeric `cpu`/`memory`/port `container`,
 * boolean `https`, a `file_seeds` entry with embedded newlines (via
 * `content`) and base64 binary content (via `content_base64`), and a
 * `connect_message` containing the `{host}`/`{port}` placeholders — asserts
 * `JSON.parse` hands every one of these back as the same typed value it was
 * serialized from, per the governing spec's "lossless round-trip including
 * booleans/numerics" requirement.
 */
const FIXTURE_RICH_ENTRY_JSON = JSON.stringify(
  {
    ...FIXTURE_CONFIG,
    gameServers: {
      palworld: {
        image: 'thijsvanloef/palworld-server-docker:latest',
        cpu: 2048,
        memory: 8192,
        ports: [
          { container: 8211, protocol: 'udp' },
          { container: 27015, protocol: 'udp' },
        ],
        environment: [
          { name: 'PLAYERS', value: '16' },
          { name: 'SERVER_NAME', value: 'My Palworld Server' },
        ],
        volumes: [
          { name: 'saves', container_path: '/palworld' },
          { name: 'mods', container_path: '/palworld/mods' },
        ],
        https: false,
        connect_message: 'Connect to {host}:{port}',
        file_seeds: [
          {
            path: '/palworld/Pal/Saved/Config/LinuxServer/PalWorldSettings.ini',
            content:
              '[/Script/Pal.PalGameWorldSettings]\nOptionSettings=(Difficulty=None,DayTimeSpeedRate=1.0,NightTimeSpeedRate=1.0)\n',
          },
          {
            path: '/palworld/Pal/Content/Paks/MyMod.pak',
            content_base64: 'UEsDBBQAAAAIAAAAIQAAAAAAAAAAAAAAAAAA',
            mode: '0644',
          },
        ],
      },
    },
  },
  null,
  2,
);

/** Expected `GameServer[]` produced by parsing {@link FIXTURE_RICH_ENTRY_JSON}. */
const EXPECTED_RICH_ENTRY_GAME_SERVERS = [
  {
    name: 'palworld',
    image: 'thijsvanloef/palworld-server-docker:latest',
    cpu: 2048,
    memory: 8192,
    ports: [
      { container: 8211, protocol: 'udp' },
      { container: 27015, protocol: 'udp' },
    ],
    environment: [
      { name: 'PLAYERS', value: '16' },
      { name: 'SERVER_NAME', value: 'My Palworld Server' },
    ],
    volumes: [
      { name: 'saves', container_path: '/palworld' },
      { name: 'mods', container_path: '/palworld/mods' },
    ],
    https: false,
    connect_message: 'Connect to {host}:{port}',
    file_seeds: [
      {
        path: '/palworld/Pal/Saved/Config/LinuxServer/PalWorldSettings.ini',
        content:
          '[/Script/Pal.PalGameWorldSettings]\nOptionSettings=(Difficulty=None,DayTimeSpeedRate=1.0,NightTimeSpeedRate=1.0)\n',
      },
      {
        path: '/palworld/Pal/Content/Paks/MyMod.pak',
        content_base64: 'UEsDBBQAAAAIAAAAIQAAAAAAAAAAAAAAAAAA',
        mode: '0644',
      },
    ],
  },
];

/** Fake `RemoteFileStore` whose `get()` is a directly-controllable mock. */
function makeRemoteFileStore(): RemoteFileStore & {
  get: ReturnType<typeof vi.fn>;
} {
  const store: Partial<RemoteFileStore> = {
    get: vi.fn(),
    put: vi.fn(),
    listVersions: vi.fn(),
  };
  return store as RemoteFileStore & { get: ReturnType<typeof vi.fn> };
}

/**
 * Test-only subclass exposing a directly-controllable `now()` mock, so tests
 * can simulate TTL expiry without real timers. Avoids reaching into
 * `DeploymentConfigService`'s protected `now()` via an `as unknown as { now }` cast.
 */
class TestableDeploymentConfigService extends DeploymentConfigService {
  /** Mock backing `now()`; call `nowMock.mockReturnValue(...)` to control the clock. */
  readonly nowMock = vi.fn<[], number>(() => Date.now());

  protected override now(): number {
    return this.nowMock();
  }
}

/**
 * Builds a `ConfigService` stub exposing just the methods `DeploymentConfigService`
 * reads. `bucket: null` (the default) selects the "unconfigured" state; any
 * non-null string selects the configured (S3) state.
 */
function makeConfig(opts: { bucket?: string | null; ttlMs?: number } = {}): ConfigService {
  const stub: Partial<ConfigService> = {
    getConfigurationBucket: () => opts.bucket ?? null,
    readEnvConfigCacheTtlMs: () => opts.ttlMs ?? 30000,
  };
  return stub as ConfigService;
}

describe('DeploymentConfigService', () => {
  let remoteFileStore: RemoteFileStore & { get: ReturnType<typeof vi.fn> };

  beforeEach(() => {
    remoteFileStore = makeRemoteFileStore();
    vi.clearAllMocks();
  });

  describe('isConfigured', () => {
    it('should return false when no configuration bucket is configured', () => {
      const service = new DeploymentConfigService(makeConfig({ bucket: null }), remoteFileStore);
      expect(service.isConfigured()).toBe(false);
    });

    it('should return true when a configuration bucket is configured', () => {
      const service = new DeploymentConfigService(makeConfig({ bucket: 'my-config-bucket' }), remoteFileStore);
      expect(service.isConfigured()).toBe(true);
    });

    it('should return false when the configuration bucket resolves to an empty string, matching fetchRawConfig/putRawConfig\'s truthiness check', () => {
      const service = new DeploymentConfigService(makeConfig({ bucket: '' }), remoteFileStore);
      expect(service.isConfigured()).toBe(false);
    });
  });

  describe('unconfigured (no disk fallback reachable)', () => {
    it('should resolve getGameServers() to [] without ever touching fs or the RemoteFileStore', async () => {
      const service = new DeploymentConfigService(makeConfig({ bucket: null }), remoteFileStore);

      await expect(service.getGameServers()).resolves.toEqual([]);

      expect(mockExists).not.toHaveBeenCalled();
      expect(mockRead).not.toHaveBeenCalled();
      expect(mockWrite).not.toHaveBeenCalled();
      expect(remoteFileStore.get).not.toHaveBeenCalled();
      expect(logger.error).not.toHaveBeenCalled();
    });

    it('should reject getRawConfig() with ConfigurationNotConfiguredError without ever touching fs or the RemoteFileStore', async () => {
      const service = new DeploymentConfigService(makeConfig({ bucket: null }), remoteFileStore);

      await expect(service.getRawConfig()).rejects.toBeInstanceOf(ConfigurationNotConfiguredError);

      expect(mockExists).not.toHaveBeenCalled();
      expect(mockRead).not.toHaveBeenCalled();
      expect(remoteFileStore.get).not.toHaveBeenCalled();
    });

    it('should reject addGameServer() with ConfigurationNotConfiguredError without ever touching fs or the RemoteFileStore', async () => {
      const service = new DeploymentConfigService(makeConfig({ bucket: null }), remoteFileStore);

      await expect(
        service.addGameServer('terraria', {
          image: 'ryshe/terraria',
          cpu: 512,
          memory: 1024,
          ports: [{ container: 7777, protocol: 'tcp' }],
          volumes: [{ name: 'world', container_path: '/config' }],
        }),
      ).rejects.toBeInstanceOf(ConfigurationNotConfiguredError);

      expect(mockExists).not.toHaveBeenCalled();
      expect(mockRead).not.toHaveBeenCalled();
      expect(mockWrite).not.toHaveBeenCalled();
      expect(remoteFileStore.get).not.toHaveBeenCalled();
      expect(remoteFileStore.put).not.toHaveBeenCalled();
    });

    it('should reject updateGameServer() with ConfigurationNotConfiguredError without ever touching fs or the RemoteFileStore', async () => {
      const service = new DeploymentConfigService(makeConfig({ bucket: null }), remoteFileStore);

      await expect(
        service.updateGameServer('palworld', {
          image: 'thijsvanloef/palworld-server-docker:v2',
          cpu: 4096,
          memory: 16384,
          ports: [{ container: 8211, protocol: 'udp' }],
          volumes: [{ name: 'saves', container_path: '/palworld' }],
        }),
      ).rejects.toBeInstanceOf(ConfigurationNotConfiguredError);

      expect(mockWrite).not.toHaveBeenCalled();
      expect(remoteFileStore.put).not.toHaveBeenCalled();
    });

    it('should reject removeGameServer() with ConfigurationNotConfiguredError without ever touching fs or the RemoteFileStore', async () => {
      const service = new DeploymentConfigService(makeConfig({ bucket: null }), remoteFileStore);

      await expect(service.removeGameServer('palworld')).rejects.toBeInstanceOf(ConfigurationNotConfiguredError);

      expect(mockWrite).not.toHaveBeenCalled();
      expect(remoteFileStore.put).not.toHaveBeenCalled();
    });

    it('should reject restoreRawConfig() with ConfigurationNotConfiguredError without ever touching fs or the RemoteFileStore', async () => {
      const service = new DeploymentConfigService(makeConfig({ bucket: null }), remoteFileStore);

      await expect(service.restoreRawConfig(FIXTURE_JSON)).rejects.toBeInstanceOf(ConfigurationNotConfiguredError);

      expect(mockWrite).not.toHaveBeenCalled();
      expect(remoteFileStore.put).not.toHaveBeenCalled();
    });
  });

  describe('getRawConfig', () => {
    it('should return the raw config text plus the RemoteFileStore etag', async () => {
      remoteFileStore.get.mockResolvedValue({
        body: new TextEncoder().encode(FIXTURE_JSON),
        etag: 'etag-1',
      });

      const service = new DeploymentConfigService(makeConfig({ bucket: 'my-config-bucket' }), remoteFileStore);
      const result = await service.getRawConfig();

      expect(result.config).toBe(FIXTURE_JSON);
      expect(result.etag).toBe('etag-1');
    });

    it('should reject when the S3 object does not exist', async () => {
      remoteFileStore.get.mockResolvedValue(undefined);

      const service = new DeploymentConfigService(makeConfig({ bucket: 'my-config-bucket' }), remoteFileStore);

      await expect(service.getRawConfig()).rejects.toThrow(/not found/);
    });
  });

  describe('reading from the configured bucket', () => {
    it('should parse config fetched from the stubbed RemoteFileStore into a GameServer[] matching the DeploymentConfig.gameServers shape', async () => {
      remoteFileStore.get.mockResolvedValue({
        body: new TextEncoder().encode(FIXTURE_JSON),
        etag: 'etag-1',
      });

      const service = new DeploymentConfigService(makeConfig({ bucket: 'my-config-bucket' }), remoteFileStore);
      const result = await service.getGameServers();

      expect(result).toEqual(EXPECTED_GAME_SERVERS);
      expect(mockRead).not.toHaveBeenCalled();
    });

    it('should fetch the object keyed by the fixed CONFIGURATION_OBJECT_KEY constant, not a filesystem-path-derived key', async () => {
      remoteFileStore.get.mockResolvedValue({
        body: new TextEncoder().encode(FIXTURE_JSON),
        etag: 'etag-1',
      });

      const service = new DeploymentConfigService(makeConfig({ bucket: 'my-config-bucket' }), remoteFileStore);
      await service.getGameServers();

      expect(remoteFileStore.get).toHaveBeenCalledWith('deployment-config.json');
    });

    it('should return an empty array and log when the remote config object does not exist', async () => {
      remoteFileStore.get.mockResolvedValue(undefined);

      const service = new DeploymentConfigService(makeConfig({ bucket: 'my-config-bucket' }), remoteFileStore);

      await expect(service.getGameServers()).resolves.toEqual([]);
      expect(logger.error).toHaveBeenCalled();
    });
  });

  describe('parse errors', () => {
    it('should return an empty array and log when the config text is malformed JSON', async () => {
      remoteFileStore.get.mockResolvedValue({
        body: new TextEncoder().encode('this is not { valid json @@@'),
        etag: 'etag-1',
      });

      const service = new DeploymentConfigService(makeConfig({ bucket: 'my-config-bucket' }), remoteFileStore);

      await expect(service.getGameServers()).resolves.toEqual([]);
      expect(logger.error).toHaveBeenCalled();
    });

    it('should return an empty array and log when the config JSON decodes to a non-object (e.g. an array)', async () => {
      remoteFileStore.get.mockResolvedValue({
        body: new TextEncoder().encode('[]'),
        etag: 'etag-1',
      });

      const service = new DeploymentConfigService(makeConfig({ bucket: 'my-config-bucket' }), remoteFileStore);

      await expect(service.getGameServers()).resolves.toEqual([]);
      expect(logger.error).toHaveBeenCalled();
    });

    it('should negatively cache a failed parse, so the next call within the TTL does not retry the source', async () => {
      remoteFileStore.get.mockResolvedValue({
        body: new TextEncoder().encode('this is not { valid json @@@'),
        etag: 'etag-1',
      });

      const service = new TestableDeploymentConfigService(makeConfig({ bucket: 'my-config-bucket', ttlMs: 30000 }), remoteFileStore);
      service.nowMock.mockReturnValue(1_000_000);

      await expect(service.getGameServers()).resolves.toEqual([]);
      expect(remoteFileStore.get).toHaveBeenCalledTimes(1);

      // Fix the underlying source, but stay within the TTL — the negatively
      // cached failure should still be served, not a fresh (now-valid) read.
      remoteFileStore.get.mockResolvedValue({
        body: new TextEncoder().encode(FIXTURE_JSON),
        etag: 'etag-2',
      });
      service.nowMock.mockReturnValue(1_010_000); // 10s later, well within a 30s TTL
      await expect(service.getGameServers()).resolves.toEqual([]);
      expect(remoteFileStore.get).toHaveBeenCalledTimes(1);
    });

    it('should throw a structural GameServerEntryError from addGameServer when the config JSON has no gameServers map', async () => {
      remoteFileStore.get.mockResolvedValue({
        body: new TextEncoder().encode('{"awsRegion":"us-east-1"}'),
        etag: 'etag-1',
      });

      const service = new DeploymentConfigService(makeConfig({ bucket: 'my-config-bucket' }), remoteFileStore);
      const entry = {
        image: 'ryshe/terraria',
        cpu: 512,
        memory: 1024,
        ports: [{ container: 7777, protocol: 'tcp' as const }],
        volumes: [{ name: 'world', container_path: '/config' }],
      };

      await expect(service.addGameServer('terraria', entry)).rejects.toMatchObject({
        reason: 'structural',
      });
      await expect(service.addGameServer('terraria', entry)).rejects.toBeInstanceOf(GameServerEntryError);
    });

    it('should retry the source once the TTL has elapsed after a failed parse', async () => {
      remoteFileStore.get.mockResolvedValue({
        body: new TextEncoder().encode('this is not { valid json @@@'),
        etag: 'etag-1',
      });

      const service = new TestableDeploymentConfigService(makeConfig({ bucket: 'my-config-bucket', ttlMs: 30000 }), remoteFileStore);
      service.nowMock.mockReturnValue(1_000_000);

      await expect(service.getGameServers()).resolves.toEqual([]);

      remoteFileStore.get.mockResolvedValue({
        body: new TextEncoder().encode(FIXTURE_JSON),
        etag: 'etag-2',
      });
      service.nowMock.mockReturnValue(1_000_000 + 30001); // just past the 30s TTL
      const result = await service.getGameServers();

      expect(result).toEqual(EXPECTED_GAME_SERVERS);
    });
  });

  describe('parsing breadth', () => {
    it('should parse multiple gameServers entries into a GameServer[] with one element per entry', async () => {
      remoteFileStore.get.mockResolvedValue({
        body: new TextEncoder().encode(FIXTURE_MULTIPLE_GAMES_JSON),
        etag: 'etag-1',
      });

      const service = new DeploymentConfigService(makeConfig({ bucket: 'my-config-bucket' }), remoteFileStore);
      const result = await service.getGameServers();

      expect(result).toEqual(EXPECTED_MULTIPLE_GAME_SERVERS);
    });

    it('should parse an entry with every optional field omitted, leaving them undefined rather than throwing', async () => {
      remoteFileStore.get.mockResolvedValue({
        body: new TextEncoder().encode(FIXTURE_OMITTED_OPTIONALS_JSON),
        etag: 'etag-1',
      });

      const service = new DeploymentConfigService(makeConfig({ bucket: 'my-config-bucket' }), remoteFileStore);
      const result = await service.getGameServers();

      expect(result).toEqual(EXPECTED_OMITTED_OPTIONALS_GAME_SERVERS);
      for (const entry of result) {
        expect(entry.environment).toBeUndefined();
        expect(entry.https).toBeUndefined();
        expect(entry.connect_message).toBeUndefined();
        expect(entry.file_seeds).toBeUndefined();
      }
    });

    it('should losslessly round-trip every scalar type (numbers, booleans, embedded newlines, base64 content) through JSON.parse', async () => {
      remoteFileStore.get.mockResolvedValue({
        body: new TextEncoder().encode(FIXTURE_RICH_ENTRY_JSON),
        etag: 'etag-1',
      });

      const service = new DeploymentConfigService(makeConfig({ bucket: 'my-config-bucket' }), remoteFileStore);
      const result = await service.getGameServers();

      expect(result).toEqual(EXPECTED_RICH_ENTRY_GAME_SERVERS);
      // Explicitly assert the values decoded to their real JS types, not
      // stringified equivalents — `toEqual` alone wouldn't catch e.g. a
      // numeric `cpu` surviving as the string `"2048"`.
      expect(typeof result[0]!.cpu).toBe('number');
      expect(typeof result[0]!.https).toBe('boolean');
    });

    it('should return an empty array and log an error when the config object is completely empty (not valid JSON)', async () => {
      remoteFileStore.get.mockResolvedValue({
        body: new TextEncoder().encode(''),
        etag: 'etag-1',
      });

      const service = new DeploymentConfigService(makeConfig({ bucket: 'my-config-bucket' }), remoteFileStore);

      await expect(service.getGameServers()).resolves.toEqual([]);
      expect(logger.error).toHaveBeenCalled();
    });
  });

  describe('caching', () => {
    it('should be a cache miss on the first call, reading the source once', async () => {
      remoteFileStore.get.mockResolvedValue({
        body: new TextEncoder().encode(FIXTURE_JSON),
        etag: 'etag-1',
      });

      const service = new DeploymentConfigService(makeConfig({ bucket: 'my-config-bucket' }), remoteFileStore);
      await service.getGameServers();

      expect(remoteFileStore.get).toHaveBeenCalledTimes(1);
    });

    it('should be a cache hit on a second call within the TTL, not re-reading the source', async () => {
      remoteFileStore.get.mockResolvedValue({
        body: new TextEncoder().encode(FIXTURE_JSON),
        etag: 'etag-1',
      });

      const service = new TestableDeploymentConfigService(makeConfig({ bucket: 'my-config-bucket', ttlMs: 30000 }), remoteFileStore);
      service.nowMock.mockReturnValue(1_000_000);

      const first = await service.getGameServers();
      service.nowMock.mockReturnValue(1_010_000); // 10s later, well within a 30s TTL
      const second = await service.getGameServers();

      expect(remoteFileStore.get).toHaveBeenCalledTimes(1);
      expect(second).toEqual(first);
    });

    it('should re-read the source once the TTL has elapsed', async () => {
      remoteFileStore.get.mockResolvedValue({
        body: new TextEncoder().encode(FIXTURE_JSON),
        etag: 'etag-1',
      });

      const service = new TestableDeploymentConfigService(makeConfig({ bucket: 'my-config-bucket', ttlMs: 30000 }), remoteFileStore);
      service.nowMock.mockReturnValue(1_000_000);

      await service.getGameServers();
      service.nowMock.mockReturnValue(1_000_000 + 30001); // just past the 30s TTL
      await service.getGameServers();

      expect(remoteFileStore.get).toHaveBeenCalledTimes(2);
    });

    it('should re-read the source immediately after invalidateCache', async () => {
      remoteFileStore.get.mockResolvedValue({
        body: new TextEncoder().encode(FIXTURE_JSON),
        etag: 'etag-1',
      });

      const service = new DeploymentConfigService(makeConfig({ bucket: 'my-config-bucket', ttlMs: 30000 }), remoteFileStore);

      await service.getGameServers();
      service.invalidateCache();
      await service.getGameServers();

      expect(remoteFileStore.get).toHaveBeenCalledTimes(2);
    });
  });
});
