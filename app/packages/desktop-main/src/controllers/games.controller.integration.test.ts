/**
 * Integration test for `GamesController.listGames()` — exercises a *real*
 * `DeploymentConfigService` (parsing real JSON, exactly as `DeploymentConfigService.test.ts`
 * does) wired into a real `GamesController`, with only the `RemoteFileStore`
 * and `ConfigService` stubbed. This complements `games.controller.test.ts`
 * (which stubs `DeploymentConfigService` entirely) by proving the merged
 * `GameListEntry[]` shape produced by `mergeGameLists` (see issue #92) holds
 * up end-to-end when the declared view comes from genuine config parsing
 * rather than a canned fixture array.
 *
 * Covers all three merge states surfaced by `mergeGameLists`:
 *  - declared-only (config has an entry with no matching tfstate game name)
 *  - deployed-only (tfstate has a game name with no matching config entry)
 *  - both (a game name present in both the parsed config and tfstate outputs)
 *
 * There is no local-file fallback any more — every scenario below configures
 * a bucket and drives reads/writes through a stubbed `RemoteFileStore`. `fs`
 * stays mocked purely to prove it is never touched (see the
 * `expect(mockRead/mockWrite/mockExists).not.toHaveBeenCalled()` assertions
 * threaded through the specs below) — this module's production code no
 * longer imports `fs` at all.
 */
import 'reflect-metadata';
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('fs', () => ({
  readFileSync: vi.fn(),
  existsSync: vi.fn(),
  writeFileSync: vi.fn(),
}));

vi.mock('../logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { readFileSync, existsSync, writeFileSync } from 'fs';
import type { DeploymentConfig, RemoteFileStore, StackOutputs } from '@hyveon/shared';
import { RemoteFileConflictError } from '@hyveon/shared';
import { GamesController } from './games.controller.js';
import { DeploymentConfigService } from '../services/DeploymentConfigService.js';
import { GamesWriteService } from '../services/GamesWriteService.js';
import type { ConfigService } from '../services/ConfigService.js';
import type { EcsService } from '../services/EcsService.js';
import type { AuditService } from '../services/AuditService.js';

/** Strongly-typed mock handles for the `fs` module — asserted as NEVER called in every spec below. */
const mockExists = vi.mocked(existsSync);
const mockRead = vi.mocked(readFileSync);
const mockWrite = vi.mocked(writeFileSync);

/**
 * Real deployment config JSON declaring a single game, `ark`. Reused across
 * scenarios; each scenario controls which tfstate `game_names` overlap with
 * it to drive the merge state under test.
 */
const CONFIG_DECLARING_ARK: DeploymentConfig = {
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
    ark: {
      image: 'example/ark-server:latest',
      cpu: 2048,
      memory: 8192,
      ports: [{ container: 7777, protocol: 'udp' }],
      volumes: [{ name: 'saves', container_path: '/ark' }],
    },
  },
};

/** {@link CONFIG_DECLARING_ARK} serialized exactly as `DeploymentConfigService` would write/read it. */
const CONFIG_JSON_DECLARING_ARK = JSON.stringify(CONFIG_DECLARING_ARK, null, 2) + '\n';

/** Expected `GameServer` shape parsed out of {@link CONFIG_JSON_DECLARING_ARK}. */
const EXPECTED_ARK_CONFIG = {
  name: 'ark',
  image: 'example/ark-server:latest',
  cpu: 2048,
  memory: 8192,
  ports: [{ container: 7777, protocol: 'udp' }],
  volumes: [{ name: 'saves', container_path: '/ark' }],
};

/** Fake `RemoteFileStore` whose `get()` resolves a fixed config JSON — used by the read-only `listGames()` specs below. */
function makeRemoteFileStore(configJson: string): RemoteFileStore {
  const store: Partial<RemoteFileStore> = {
    get: vi.fn().mockResolvedValue({ body: new TextEncoder().encode(configJson), etag: 'etag-1' }),
    put: vi.fn(),
    listVersions: vi.fn(),
  };
  return store as RemoteFileStore;
}

/**
 * Builds a `RemoteFileStore` stub whose `get`/`put` remain directly-controllable
 * `vi.fn()` spies (unlike {@link makeRemoteFileStore}, which erases the mock
 * type) — used by the conflict spec below to queue per-call responses,
 * mirroring `DeploymentConfigService.write.test.ts`'s `makeRemoteFileStore()`.
 */
function makeSpyableRemoteFileStore(): RemoteFileStore & {
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
 * Builds a `RemoteFileStore` stub backed by a single mutable `currentConfigJson`
 * string: `put()` overwrites it (and returns a fresh etag) and `get()` always
 * resolves whatever it currently holds, so `GamesWriteService`'s own
 * post-write `tfvars.getGameServers()` call (inside `successResult()`) sees
 * the mutation immediately — matching how the real S3 object behaves —
 * without requiring a manual `get.mockResolvedValue(...)` reset after the fact.
 */
function makeMutableRemoteFileStore(initialJson: string): RemoteFileStore & { currentJson(): string } {
  let currentConfigJson = initialJson;
  let etagCounter = 1;
  const store: Partial<RemoteFileStore> & { currentJson(): string } = {
    get: vi.fn().mockImplementation(async () => ({
      body: new TextEncoder().encode(currentConfigJson),
      etag: `etag-${etagCounter}`,
    })),
    put: vi.fn().mockImplementation(async (_key: string, body: Uint8Array) => {
      currentConfigJson = new TextDecoder().decode(body);
      etagCounter += 1;
      return { etag: `etag-${etagCounter}` };
    }),
    listVersions: vi.fn(),
    currentJson: () => currentConfigJson,
  };
  return store as RemoteFileStore & { currentJson(): string };
}

/**
 * Builds a `ConfigService` stub exposing just what `DeploymentConfigService`/`GamesController`
 * read. A configuration bucket is always configured — there is no local-file
 * mode any more.
 */
function makeConfig(gameNames: string[]): ConfigService {
  const outputs: Partial<StackOutputs> = { gameNames };
  const config: Partial<ConfigService> = {
    invalidateCache: vi.fn(),
    getStackOutputs: vi.fn().mockResolvedValue(outputs),
    getConfigurationBucket: () => 'my-config-bucket',
    readEnvConfigCacheTtlMs: () => 30000,
  };
  return config as ConfigService;
}

/** Minimal `EcsService` stub — none of the specs in this file call it, but the constructor requires it. */
function makeEcs(): EcsService {
  return {} as EcsService;
}

/** Minimal `AuditService` stub — none of the specs in this file assert on it, but `GamesWriteService`'s constructor requires it. */
function makeAudit(): AuditService {
  return { record: vi.fn().mockResolvedValue(undefined) } as Partial<AuditService> as AuditService;
}

/** Valid, structurally-distinct config used by the `games.create` specs below (a different game from `ark`). */
const VALID_MINECRAFT_CONFIG = {
  image: 'example/minecraft-server:latest',
  cpu: 1024,
  memory: 2048,
  ports: [{ container: 25565, protocol: 'tcp' }],
  volumes: [{ name: 'saves', container_path: '/data' }],
};

/** Replacement fields for the `ark` entry used by the `games.update` spec below — deliberately different from {@link EXPECTED_ARK_CONFIG}. */
const UPDATED_ARK_CONFIG = {
  image: 'example/ark-server:v2',
  cpu: 4096,
  memory: 16384,
  ports: [{ container: 7777, protocol: 'udp' }],
  volumes: [{ name: 'saves', container_path: '/ark' }],
};

describe('GamesController + DeploymentConfigService integration', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should report a game as declared-only when it exists in the config but not in tfstate', async () => {
    const config = makeConfig([]); // nothing deployed yet
    const tfvars = new DeploymentConfigService(config, makeRemoteFileStore(CONFIG_JSON_DECLARING_ARK));
    const controller = new GamesController(config, makeEcs(), tfvars);

    const result = await controller.listGames();

    expect(result).toEqual({
      games: [{ name: 'ark', declared: true, deployed: false, config: EXPECTED_ARK_CONFIG }],
    });
    expect(mockExists).not.toHaveBeenCalled();
    expect(mockRead).not.toHaveBeenCalled();
  });

  it('should report a game as deployed-only when it exists in tfstate but not in the config', async () => {
    const config = makeConfig(['minecraft']); // deployed game name unrelated to the config
    const tfvars = new DeploymentConfigService(config, makeRemoteFileStore(CONFIG_JSON_DECLARING_ARK));
    const controller = new GamesController(config, makeEcs(), tfvars);

    const result = await controller.listGames();

    expect(result).toEqual({
      games: [
        { name: 'ark', declared: true, deployed: false, config: EXPECTED_ARK_CONFIG },
        { name: 'minecraft', declared: false, deployed: true },
      ],
    });
  });

  it('should report a game as both declared and deployed when its name is present in the config and tfstate', async () => {
    const config = makeConfig(['ark']); // same name as the declared config entry
    const tfvars = new DeploymentConfigService(config, makeRemoteFileStore(CONFIG_JSON_DECLARING_ARK));
    const controller = new GamesController(config, makeEcs(), tfvars);

    const result = await controller.listGames();

    expect(result).toEqual({
      games: [{ name: 'ark', declared: true, deployed: true, config: EXPECTED_ARK_CONFIG }],
    });
  });
});

/**
 * Write-then-read round trip specs (see issue #98): a real `GamesWriteService`
 * (wired to the same real `DeploymentConfigService` + a mutable `RemoteFileStore` stub
 * used above) performs the `games.create` / `games.update` / `games.delete`
 * mutation, and a subsequent `listGames()` call — re-reading through the same
 * stubbed store, seeded with the JSON the write actually produced — proves
 * the mutation is visible in the merged games list end-to-end, not just
 * asserted against the `GameWriteResult` return value in isolation.
 */
describe('GamesController + GamesWriteService write-then-list round trip', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should rewrite the config JSON and show the new game as declared on a subsequent games.list when games.create writes a valid entry', async () => {
    const remoteFileStore = makeMutableRemoteFileStore(CONFIG_JSON_DECLARING_ARK);

    const config = makeConfig([]);
    const tfvars = new DeploymentConfigService(config, remoteFileStore);
    const gamesWrite = new GamesWriteService(config, tfvars, makeAudit());
    const controller = new GamesController(config, makeEcs(), tfvars, gamesWrite);

    const createResult = await controller.createGame({ name: 'minecraft', config: VALID_MINECRAFT_CONFIG });

    expect(createResult.ok).toBe(true);
    expect(remoteFileStore.put).toHaveBeenCalledTimes(1);
    expect(JSON.parse(remoteFileStore.currentJson()).gameServers.minecraft).toEqual(VALID_MINECRAFT_CONFIG);
    expect(mockWrite).not.toHaveBeenCalled();
    if (createResult.ok) {
      expect(createResult.game).toEqual({ name: 'minecraft', ...VALID_MINECRAFT_CONFIG });
      expect(createResult.games).toHaveLength(2);
      expect(createResult.games).toEqual(
        expect.arrayContaining([
          { name: 'ark', declared: true, deployed: false, config: EXPECTED_ARK_CONFIG },
          {
            name: 'minecraft',
            declared: true,
            deployed: false,
            config: { name: 'minecraft', ...VALID_MINECRAFT_CONFIG },
          },
        ]),
      );
    }

    const listResult = await controller.listGames();

    expect(listResult.games).toHaveLength(2);
    expect(listResult.games).toEqual(
      expect.arrayContaining([
        { name: 'ark', declared: true, deployed: false, config: EXPECTED_ARK_CONFIG },
        {
          name: 'minecraft',
          declared: true,
          deployed: false,
          config: { name: 'minecraft', ...VALID_MINECRAFT_CONFIG },
        },
      ]),
    );
  });

  it("should replace the entry's fields in the written JSON and show them updated on a subsequent games.list when games.update writes a valid config", async () => {
    const remoteFileStore = makeMutableRemoteFileStore(CONFIG_JSON_DECLARING_ARK);

    const config = makeConfig([]);
    const tfvars = new DeploymentConfigService(config, remoteFileStore);
    const gamesWrite = new GamesWriteService(config, tfvars, makeAudit());
    const controller = new GamesController(config, makeEcs(), tfvars, gamesWrite);

    const updateResult = await controller.updateGame({ name: 'ark', config: UPDATED_ARK_CONFIG });

    expect(updateResult.ok).toBe(true);
    expect(remoteFileStore.put).toHaveBeenCalledTimes(1);
    expect(JSON.parse(remoteFileStore.currentJson()).gameServers.ark.image).toBe('example/ark-server:v2');
    if (updateResult.ok) {
      expect(updateResult.game).toEqual({ name: 'ark', ...UPDATED_ARK_CONFIG });
      expect(updateResult.games).toEqual([
        { name: 'ark', declared: true, deployed: false, config: { name: 'ark', ...UPDATED_ARK_CONFIG } },
      ]);
    }

    const listResult = await controller.listGames();

    expect(listResult).toEqual({
      games: [{ name: 'ark', declared: true, deployed: false, config: { name: 'ark', ...UPDATED_ARK_CONFIG } }],
    });
  });

  it('should remove the entry so it no longer appears on a subsequent games.list when games.delete succeeds', async () => {
    const remoteFileStore = makeMutableRemoteFileStore(CONFIG_JSON_DECLARING_ARK);

    const config = makeConfig([]);
    const tfvars = new DeploymentConfigService(config, remoteFileStore);
    const gamesWrite = new GamesWriteService(config, tfvars, makeAudit());
    const controller = new GamesController(config, makeEcs(), tfvars, gamesWrite);

    const deleteResult = await controller.deleteGame({ name: 'ark' });

    expect(deleteResult.ok).toBe(true);
    expect(remoteFileStore.put).toHaveBeenCalledTimes(1);
    expect(JSON.parse(remoteFileStore.currentJson()).gameServers.ark).toBeUndefined();
    if (deleteResult.ok) {
      expect(deleteResult.game).toBeUndefined();
      expect(deleteResult.games).toEqual([]);
    }

    const listResult = await controller.listGames();

    expect(listResult).toEqual({ games: [] });
  });
});

/**
 * Failure-path specs for `games.create` (see issue #98): a business-rule
 * validation failure (Fargate cpu/memory mismatch) must write nothing, and a
 * stale etag must surface as a `'conflict'` result carrying the store's
 * current version id — exercised against a real `GamesWriteService` +
 * `DeploymentConfigService`, with only the `RemoteFileStore` stubbed to simulate the
 * conflicting write (mirroring `DeploymentConfigService.write.test.ts`'s specs).
 */
describe('GamesController + GamesWriteService games.create failure paths', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("should surface code 'validation' with a per-field issue and write nothing when the proposed config has a Fargate cpu/memory mismatch", async () => {
    const remoteFileStore = makeSpyableRemoteFileStore();
    remoteFileStore.get.mockResolvedValue({
      body: new TextEncoder().encode(CONFIG_JSON_DECLARING_ARK),
      etag: 'etag-1',
    });

    const config = makeConfig([]);
    const tfvars = new DeploymentConfigService(config, remoteFileStore);
    const gamesWrite = new GamesWriteService(config, tfvars, makeAudit());
    const controller = new GamesController(config, makeEcs(), tfvars, gamesWrite);

    const result = await controller.createGame({
      name: 'invalid-pairing',
      // cpu=256 only pairs with memory 512/1024/2048 MiB — 4096 is not a valid pairing.
      config: { ...VALID_MINECRAFT_CONFIG, cpu: 256, memory: 4096 },
    });

    expect(result).toEqual({
      ok: false,
      code: 'validation',
      issues: expect.arrayContaining([expect.objectContaining({ path: 'memory' })]),
    });
    expect(remoteFileStore.put).not.toHaveBeenCalled();
    expect(mockWrite).not.toHaveBeenCalled();
  });

  it("should surface code 'validation' with a name-path issue and write nothing when creating a game with an already-declared name", async () => {
    // `validateGameServer()`'s own port-collision check skips a sibling
    // whose `name` matches the proposed entry (it's designed for the
    // update-in-place self-exclusion case), so a same-name duplicate on
    // create passes structural/business-rule validation cleanly — the
    // actual duplicate-name rejection only happens inside
    // `DeploymentConfigService.insertGameServerEntry()`. This spec exercises the real
    // `DeploymentConfigService` + `GamesWriteService` pair (no mocks) to pin that the
    // `GameServerEntryError('...', 'duplicate-name')` it throws is
    // genuinely caught and translated by `GamesWriteService.createGame()`,
    // not just asserted against a hand-constructed error in
    // `GamesWriteService.test.ts`.
    const remoteFileStore = makeSpyableRemoteFileStore();
    remoteFileStore.get.mockResolvedValue({
      body: new TextEncoder().encode(CONFIG_JSON_DECLARING_ARK),
      etag: 'etag-1',
    });

    const config = makeConfig([]);
    const tfvars = new DeploymentConfigService(config, remoteFileStore);
    const gamesWrite = new GamesWriteService(config, tfvars, makeAudit());
    const controller = new GamesController(config, makeEcs(), tfvars, gamesWrite);

    const result = await controller.createGame({ name: 'ark', config: VALID_MINECRAFT_CONFIG });

    expect(result).toEqual({
      ok: false,
      code: 'validation',
      issues: [{ path: 'name', message: expect.stringContaining('already exists') }],
    });
    expect(remoteFileStore.put).not.toHaveBeenCalled();
    expect(mockWrite).not.toHaveBeenCalled();
  });

  it("should surface code 'conflict' with the current version id when a write hits a stale etag", async () => {
    const remoteFileStore = makeSpyableRemoteFileStore();
    remoteFileStore.get
      // 1st get(): GamesWriteService.createGame()'s sibling lookup (getGameServers()).
      .mockResolvedValueOnce({ body: new TextEncoder().encode(CONFIG_JSON_DECLARING_ARK), etag: 'etag-1' })
      // 2nd get(): DeploymentConfigService.writeConfig()'s fetchRawConfig() before mutating.
      .mockResolvedValueOnce({ body: new TextEncoder().encode(CONFIG_JSON_DECLARING_ARK), etag: 'etag-1' })
      // 3rd+ get(): the follow-up read DeploymentConfigService issues after the conflict, to report the current etag.
      .mockResolvedValue({ body: new TextEncoder().encode(CONFIG_JSON_DECLARING_ARK), etag: 'etag-2' });
    remoteFileStore.put.mockRejectedValue(
      new RemoteFileConflictError('deployment-config.json', 'Conflicting write detected.', 'etag-1'),
    );

    const config = makeConfig([]);
    const tfvars = new DeploymentConfigService(config, remoteFileStore);
    const gamesWrite = new GamesWriteService(config, tfvars, makeAudit());
    const controller = new GamesController(config, makeEcs(), tfvars, gamesWrite);

    const result = await controller.createGame({
      name: 'minecraft',
      config: VALID_MINECRAFT_CONFIG,
      expectedVersionId: 'etag-1',
    });

    expect(result).toMatchObject({
      ok: false,
      code: 'conflict',
      expectedVersionId: 'etag-1',
      currentVersionId: 'etag-2',
    });
  });
});
