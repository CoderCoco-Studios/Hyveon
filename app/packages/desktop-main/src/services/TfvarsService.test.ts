/**
 * Tests for `TfvarsService` — the local-vs-S3 deployment-config reader/parser.
 *
 * The config is plain JSON now (see the `migrate-iac-to-pulumi` change's
 * Phase 6), so fixtures are inline `DeploymentConfig`-shaped objects
 * `JSON.stringify`d — no fixture files needed, unlike the retired HCL
 * fixtures this file used to load from `__fixtures__/*.tfvars` (there's no
 * comment/heredoc complexity to fixture-test with JSON).
 */
import 'reflect-metadata';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { DeploymentConfig, RemoteFileStore } from '@hyveon/shared';

vi.mock('fs', () => ({
  readFileSync: vi.fn(),
  existsSync: vi.fn(),
}));

vi.mock('../logger.js', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

import { readFileSync, existsSync } from 'fs';
import { TfvarsService } from './TfvarsService.js';
import { ConfigService } from './ConfigService.js';
import { logger } from '../logger.js';

/** Strongly-typed mock handles for the `fs` module. */
const mockExists = vi.mocked(existsSync);
const mockRead = vi.mocked(readFileSync);

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

/** `FIXTURE_CONFIG` serialized exactly as `TfvarsService` would write/read it. */
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
 * `TfvarsService`'s protected `now()` via an `as unknown as { now }` cast.
 */
class TestableTfvarsService extends TfvarsService {
  /** Mock backing `now()`; call `nowMock.mockReturnValue(...)` to control the clock. */
  readonly nowMock = vi.fn<[], number>(() => Date.now());

  protected override now(): number {
    return this.nowMock();
  }
}

/**
 * Builds a `ConfigService` stub exposing just the methods `TfvarsService`
 * reads. `bucket: null` selects local mode; any non-null string selects S3
 * mode.
 */
function makeConfig(opts: {
  bucket?: string | null;
  path?: string;
  ttlMs?: number;
}): ConfigService {
  const stub: Partial<ConfigService> = {
    getTfvarsBucket: () => opts.bucket ?? null,
    getTfvarsPath: () => opts.path ?? '/repo/terraform/deployment-config.json',
    readEnvTfvarsCacheTtlMs: () => opts.ttlMs ?? 30000,
  };
  return stub as ConfigService;
}

describe('TfvarsService', () => {
  let remoteFileStore: RemoteFileStore & { get: ReturnType<typeof vi.fn> };

  beforeEach(() => {
    remoteFileStore = makeRemoteFileStore();
    vi.clearAllMocks();
  });

  describe('local mode', () => {
    it('should parse a fixture config file into a GameServer[] matching the DeploymentConfig.gameServers shape', async () => {
      mockExists.mockReturnValue(true);
      mockRead.mockReturnValue(FIXTURE_JSON);

      const service = new TfvarsService(makeConfig({ bucket: null }), remoteFileStore);
      const result = await service.getGameServers();

      expect(result).toEqual(EXPECTED_GAME_SERVERS);
      expect(remoteFileStore.get).not.toHaveBeenCalled();
    });

    it('should read from ConfigService.getTfvarsPath()', async () => {
      mockExists.mockReturnValue(true);
      mockRead.mockReturnValue(FIXTURE_JSON);

      const service = new TfvarsService(
        makeConfig({ bucket: null, path: '/custom/deployment-config.json' }),
        remoteFileStore,
      );
      await service.getGameServers();

      expect(mockExists).toHaveBeenCalledWith('/custom/deployment-config.json');
      expect(mockRead).toHaveBeenCalledWith('/custom/deployment-config.json', 'utf-8');
    });

    it('should return an empty array and log when the local config file does not exist', async () => {
      mockExists.mockReturnValue(false);

      const service = new TfvarsService(makeConfig({ bucket: null }), remoteFileStore);

      await expect(service.getGameServers()).resolves.toEqual([]);
      expect(logger.error).toHaveBeenCalled();
    });

    it('should return an empty array and log when the config JSON has no gameServers key', async () => {
      mockExists.mockReturnValue(true);
      mockRead.mockReturnValue(JSON.stringify({ awsRegion: 'us-east-1' }));

      const service = new TfvarsService(makeConfig({ bucket: null }), remoteFileStore);

      await expect(service.getGameServers()).resolves.toEqual([]);
      expect(logger.warn).toHaveBeenCalled();
    });
  });

  describe('getRawConfig', () => {
    it('should return the raw config text without an etag in local mode', async () => {
      mockExists.mockReturnValue(true);
      mockRead.mockReturnValue(FIXTURE_JSON);

      const service = new TfvarsService(makeConfig({ bucket: null }), remoteFileStore);
      const result = await service.getRawConfig();

      expect(result.config).toBe(FIXTURE_JSON);
      expect(result.etag).toBeUndefined();
    });

    it('should return the raw config text plus the RemoteFileStore etag in s3 mode', async () => {
      remoteFileStore.get.mockResolvedValue({
        body: new TextEncoder().encode(FIXTURE_JSON),
        etag: 'etag-1',
      });

      const service = new TfvarsService(makeConfig({ bucket: 'my-tfvars-bucket' }), remoteFileStore);
      const result = await service.getRawConfig();

      expect(result.config).toBe(FIXTURE_JSON);
      expect(result.etag).toBe('etag-1');
    });

    it('should reject when the config source is unreadable, unlike getGameServers', async () => {
      mockExists.mockReturnValue(false);

      const service = new TfvarsService(makeConfig({ bucket: null }), remoteFileStore);

      await expect(service.getRawConfig()).rejects.toThrow(/not found/);
    });
  });

  describe('s3 mode', () => {
    it('should parse config fetched from the stubbed RemoteFileStore into a GameServer[] matching the DeploymentConfig.gameServers shape', async () => {
      remoteFileStore.get.mockResolvedValue({
        body: new TextEncoder().encode(FIXTURE_JSON),
        etag: 'etag-1',
      });

      const service = new TfvarsService(makeConfig({ bucket: 'my-tfvars-bucket' }), remoteFileStore);
      const result = await service.getGameServers();

      expect(result).toEqual(EXPECTED_GAME_SERVERS);
      expect(mockRead).not.toHaveBeenCalled();
    });

    it('should fetch the object keyed by the config path basename', async () => {
      remoteFileStore.get.mockResolvedValue({
        body: new TextEncoder().encode(FIXTURE_JSON),
        etag: 'etag-1',
      });

      const service = new TfvarsService(
        makeConfig({ bucket: 'my-tfvars-bucket', path: '/repo/terraform/deployment-config.json' }),
        remoteFileStore,
      );
      await service.getGameServers();

      expect(remoteFileStore.get).toHaveBeenCalledWith('deployment-config.json');
    });

    it('should return an empty array and log when the remote config object does not exist', async () => {
      remoteFileStore.get.mockResolvedValue(undefined);

      const service = new TfvarsService(makeConfig({ bucket: 'my-tfvars-bucket' }), remoteFileStore);

      await expect(service.getGameServers()).resolves.toEqual([]);
      expect(logger.error).toHaveBeenCalled();
    });
  });

  describe('parse errors', () => {
    it('should return an empty array and log when the config text is malformed JSON', async () => {
      mockExists.mockReturnValue(true);
      mockRead.mockReturnValue('this is not { valid json @@@');

      const service = new TfvarsService(makeConfig({ bucket: null }), remoteFileStore);

      await expect(service.getGameServers()).resolves.toEqual([]);
      expect(logger.error).toHaveBeenCalled();
    });

    it('should return an empty array and log when the config JSON decodes to a non-object (e.g. an array)', async () => {
      mockExists.mockReturnValue(true);
      mockRead.mockReturnValue('[]');

      const service = new TfvarsService(makeConfig({ bucket: null }), remoteFileStore);

      await expect(service.getGameServers()).resolves.toEqual([]);
      expect(logger.error).toHaveBeenCalled();
    });

    it('should negatively cache a failed parse, so the next call within the TTL does not retry the source', async () => {
      mockExists.mockReturnValue(true);
      mockRead.mockReturnValue('this is not { valid json @@@');

      const service = new TestableTfvarsService(makeConfig({ bucket: null, ttlMs: 30000 }), remoteFileStore);
      service.nowMock.mockReturnValue(1_000_000);

      await expect(service.getGameServers()).resolves.toEqual([]);
      expect(mockRead).toHaveBeenCalledTimes(1);

      // Fix the underlying source, but stay within the TTL — the negatively
      // cached failure should still be served, not a fresh (now-valid) read.
      mockRead.mockReturnValue(FIXTURE_JSON);
      service.nowMock.mockReturnValue(1_010_000); // 10s later, well within a 30s TTL
      await expect(service.getGameServers()).resolves.toEqual([]);
      expect(mockRead).toHaveBeenCalledTimes(1);
    });

    it('should retry the source once the TTL has elapsed after a failed parse', async () => {
      mockExists.mockReturnValue(true);
      mockRead.mockReturnValue('this is not { valid json @@@');

      const service = new TestableTfvarsService(makeConfig({ bucket: null, ttlMs: 30000 }), remoteFileStore);
      service.nowMock.mockReturnValue(1_000_000);

      await expect(service.getGameServers()).resolves.toEqual([]);

      mockRead.mockReturnValue(FIXTURE_JSON);
      service.nowMock.mockReturnValue(1_000_000 + 30001); // just past the 30s TTL
      const result = await service.getGameServers();

      expect(result).toEqual(EXPECTED_GAME_SERVERS);
    });
  });

  describe('parsing breadth', () => {
    it('should parse multiple gameServers entries into a GameServer[] with one element per entry', async () => {
      mockExists.mockReturnValue(true);
      mockRead.mockReturnValue(FIXTURE_MULTIPLE_GAMES_JSON);

      const service = new TfvarsService(makeConfig({ bucket: null }), remoteFileStore);
      const result = await service.getGameServers();

      expect(result).toEqual(EXPECTED_MULTIPLE_GAME_SERVERS);
    });

    it('should parse an entry with every optional field omitted, leaving them undefined rather than throwing', async () => {
      mockExists.mockReturnValue(true);
      mockRead.mockReturnValue(FIXTURE_OMITTED_OPTIONALS_JSON);

      const service = new TfvarsService(makeConfig({ bucket: null }), remoteFileStore);
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
      mockExists.mockReturnValue(true);
      mockRead.mockReturnValue(FIXTURE_RICH_ENTRY_JSON);

      const service = new TfvarsService(makeConfig({ bucket: null }), remoteFileStore);
      const result = await service.getGameServers();

      expect(result).toEqual(EXPECTED_RICH_ENTRY_GAME_SERVERS);
      // Explicitly assert the values decoded to their real JS types, not
      // stringified equivalents — `toEqual` alone wouldn't catch e.g. a
      // numeric `cpu` surviving as the string `"2048"`.
      expect(typeof result[0]!.cpu).toBe('number');
      expect(typeof result[0]!.https).toBe('boolean');
    });

    it('should return an empty array and log an error when the config file is completely empty (not valid JSON)', async () => {
      mockExists.mockReturnValue(true);
      mockRead.mockReturnValue('');

      const service = new TfvarsService(makeConfig({ bucket: null }), remoteFileStore);

      await expect(service.getGameServers()).resolves.toEqual([]);
      expect(logger.error).toHaveBeenCalled();
    });
  });

  describe('caching', () => {
    it('should be a cache miss on the first call, reading the source once', async () => {
      mockExists.mockReturnValue(true);
      mockRead.mockReturnValue(FIXTURE_JSON);

      const service = new TfvarsService(makeConfig({ bucket: null }), remoteFileStore);
      await service.getGameServers();

      expect(mockRead).toHaveBeenCalledTimes(1);
    });

    it('should be a cache hit on a second call within the TTL, not re-reading the source', async () => {
      mockExists.mockReturnValue(true);
      mockRead.mockReturnValue(FIXTURE_JSON);

      const service = new TestableTfvarsService(makeConfig({ bucket: null, ttlMs: 30000 }), remoteFileStore);
      service.nowMock.mockReturnValue(1_000_000);

      const first = await service.getGameServers();
      service.nowMock.mockReturnValue(1_010_000); // 10s later, well within a 30s TTL
      const second = await service.getGameServers();

      expect(mockRead).toHaveBeenCalledTimes(1);
      expect(second).toEqual(first);
    });

    it('should re-read the source once the TTL has elapsed', async () => {
      mockExists.mockReturnValue(true);
      mockRead.mockReturnValue(FIXTURE_JSON);

      const service = new TestableTfvarsService(makeConfig({ bucket: null, ttlMs: 30000 }), remoteFileStore);
      service.nowMock.mockReturnValue(1_000_000);

      await service.getGameServers();
      service.nowMock.mockReturnValue(1_000_000 + 30001); // just past the 30s TTL
      await service.getGameServers();

      expect(mockRead).toHaveBeenCalledTimes(2);
    });

    it('should re-read the source immediately after invalidateCache', async () => {
      mockExists.mockReturnValue(true);
      mockRead.mockReturnValue(FIXTURE_JSON);

      const service = new TfvarsService(makeConfig({ bucket: null, ttlMs: 30000 }), remoteFileStore);

      await service.getGameServers();
      service.invalidateCache();
      await service.getGameServers();

      expect(mockRead).toHaveBeenCalledTimes(2);
    });
  });
});
