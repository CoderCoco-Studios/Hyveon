import 'reflect-metadata';
import { describe, it, expect, vi } from 'vitest';
import { expectChannels } from '../testing/message-pattern.test-utils.js';
import { GamesController } from './games.controller.js';
import type { ConfigService } from '../services/ConfigService.js';
import type { EcsService } from '../services/EcsService.js';
import type { GamesWriteService } from '../services/GamesWriteService.js';
import type { DeploymentConfigService } from '../services/DeploymentConfigService.js';
import type { GameServer, GameWriteResult, StackOutputs } from '@hyveon/shared';
import type { GameWizardDraftService } from '../services/GameWizardDraftService.js';
import type { StoredGameWizardDraft } from '../services/ElectronStoreService.js';

vi.mock('../logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

/** Minimal StackOutputs for games-controller tests. */
const DEFAULT_OUTPUTS: Partial<StackOutputs> = {
  gameNames: ['minecraft', 'palworld'],
};

/**
 * Build a ConfigService stub. Pass `null` to simulate a pre-deploy state
 * where `getStackOutputs()` resolves to null.
 */
function makeConfig(outputs: Partial<StackOutputs> | null = DEFAULT_OUTPUTS): ConfigService {
  const stub: Partial<ConfigService> = {
    invalidateCache: vi.fn(),
    getStackOutputs: vi.fn().mockResolvedValue(outputs),
  };
  return stub as ConfigService;
}

/** Build an EcsService stub with all mutation methods pre-wired to succeed. */
function makeEcs(): EcsService {
  return {
    getStatus: vi.fn().mockResolvedValue({ game: 'minecraft', state: 'stopped' }),
    start: vi.fn().mockResolvedValue({ success: true, message: 'Task launched' }),
    stop: vi.fn().mockResolvedValue({ success: true, message: 'Task stopped' }),
  } as unknown as EcsService;
}

/** Minimal, valid `GameServer` fixture for a single declared game. */
function buildGameServer(name: string): GameServer {
  return {
    name,
    image: 'example/image:latest',
    cpu: 1024,
    memory: 2048,
    ports: [{ container: 25565, protocol: 'tcp' }],
    volumes: [{ name: 'saves', container_path: '/data' }],
  };
}

/**
 * Build a DeploymentConfigService stub with `invalidateCache` and `getGameServers`
 * pre-wired. Defaults `getGameServers()` to an empty declared list so
 * existing specs that only care about the deployed (tfstate) view don't have
 * to know about the declared merge.
 */
function makeDeploymentConfig(declared: GameServer[] = []): DeploymentConfigService {
  return {
    invalidateCache: vi.fn(),
    getGameServers: vi.fn().mockResolvedValue(declared),
  } as Partial<DeploymentConfigService> as DeploymentConfigService;
}

/** A representative successful `GameWriteResult` used as the default stub return value. */
const DEFAULT_WRITE_RESULT: GameWriteResult = { ok: true, games: [] };

/**
 * Build a `GamesWriteService` stub with all three write methods pre-wired
 * to resolve with {@link DEFAULT_WRITE_RESULT}. Individual tests override
 * the relevant method's resolved value to assert the controller forwards it
 * verbatim.
 */
function makeGamesWrite(): GamesWriteService {
  return {
    createGame: vi.fn().mockResolvedValue(DEFAULT_WRITE_RESULT),
    updateGame: vi.fn().mockResolvedValue(DEFAULT_WRITE_RESULT),
    deleteGame: vi.fn().mockResolvedValue(DEFAULT_WRITE_RESULT),
  } as Partial<GamesWriteService> as GamesWriteService;
}

/** Build a `GameWizardDraftService` stub with all three methods pre-wired. */
function makeGameWizardDraft(): GameWizardDraftService {
  return {
    get: vi.fn().mockReturnValue(null),
    save: vi.fn(),
    clear: vi.fn(),
  } as Partial<GameWizardDraftService> as GameWizardDraftService;
}

describe('GamesController', () => {
  describe('@MessagePattern channel names', () => {
    it('should register every channel', () => {
      expectChannels(GamesController.prototype, [
        ['listGames', 'games.list'],
        ['listStatus', 'games.status'],
        ['getStatus', 'games.getStatus'],
        ['start', 'games.start'],
        ['stop', 'games.stop'],
        ['createGame', 'games.create'],
        ['updateGame', 'games.update'],
        ['deleteGame', 'games.delete'],
      ] as const);
    });
  });

  describe('listGames', () => {
    it('should NOT invalidate the stack-outputs cache — this channel is called on every games-list page visit, and eagerly invalidating a cache fronting an expensive Pulumi round-trip would pay that cost far more often than a fresh deploy could plausibly have happened', async () => {
      const config = makeConfig();
      await new GamesController(config, makeEcs(), makeDeploymentConfig(), makeGamesWrite(), makeGameWizardDraft()).listGames();
      expect(config.invalidateCache).not.toHaveBeenCalled();
    });

    it('should invalidate the DeploymentConfigService cache before reading game names', async () => {
      const deploymentConfig = makeDeploymentConfig();
      await new GamesController(makeConfig(), makeEcs(), deploymentConfig, makeGamesWrite(), makeGameWizardDraft()).listGames();
      expect(deploymentConfig.invalidateCache).toHaveBeenCalledOnce();
    });

    it('should return the deployed game names from stack outputs when nothing is declared in the deployment config, flagged as pending_delete drift since nothing declares them', async () => {
      const result = await new GamesController(makeConfig(), makeEcs(), makeDeploymentConfig(), makeGamesWrite(), makeGameWizardDraft()).listGames();
      expect(result).toEqual({
        games: [
          { name: 'minecraft', declared: false, deployed: true, drift: { kind: 'pending_delete' } },
          { name: 'palworld', declared: false, deployed: true, drift: { kind: 'pending_delete' } },
        ],
      });
    });

    it('should return an empty games array when stack outputs are missing and nothing is declared', async () => {
      const result = await new GamesController(makeConfig(null), makeEcs(), makeDeploymentConfig(), makeGamesWrite(), makeGameWizardDraft()).listGames();
      expect(result).toEqual({ games: [] });
    });

    it('should return a game that exists only in the deployment config (declared but not yet applied), flagged as pending_create drift', async () => {
      const ark = buildGameServer('ark');
      const result = await new GamesController(makeConfig(null), makeEcs(), makeDeploymentConfig([ark]), makeGamesWrite(), makeGameWizardDraft()).listGames();
      expect(result).toEqual({
        games: [{ name: 'ark', declared: true, deployed: false, config: ark, drift: { kind: 'pending_create' } }],
      });
    });

    it('should merge declared deployment-config games with deployed tfstate games', async () => {
      const palworld = buildGameServer('palworld');
      const result = await new GamesController(makeConfig(), makeEcs(), makeDeploymentConfig([palworld]), makeGamesWrite(), makeGameWizardDraft()).listGames();
      expect(result).toEqual({
        games: [
          { name: 'palworld', declared: true, deployed: true, config: palworld },
          { name: 'minecraft', declared: false, deployed: true, drift: { kind: 'pending_delete' } },
        ],
      });
    });

    it('should attach a config_drift finding computed from declared vs. applied config to the matching declared+deployed game', async () => {
      const palworld = buildGameServer('palworld');
      const { name: _palworldName, ...palworldConfig } = palworld;
      const config = makeConfig({
        gameNames: ['minecraft', 'palworld'],
        appliedGameServers: { palworld: { ...palworldConfig, image: 'example/image:old' } },
      });
      const result = await new GamesController(config, makeEcs(), makeDeploymentConfig([palworld]), makeGamesWrite(), makeGameWizardDraft()).listGames();
      expect(result).toEqual({
        games: [
          {
            name: 'palworld',
            declared: true,
            deployed: true,
            config: palworld,
            drift: { kind: 'config_drift', changedFields: ['image'] },
          },
          { name: 'minecraft', declared: false, deployed: true },
        ],
      });
    });
  });

  describe('listStatus', () => {
    it('should NOT invalidate the stack-outputs cache — this channel backs the dashboard 20-second status poller, and eagerly invalidating a cache fronting an expensive Pulumi round-trip would turn an idle dashboard into a steady stream of engine-resolution + S3 calls', async () => {
      const config = makeConfig();
      await new GamesController(config, makeEcs(), makeDeploymentConfig(), makeGamesWrite(), makeGameWizardDraft()).listStatus();
      expect(config.invalidateCache).not.toHaveBeenCalled();
    });

    it('should invalidate the DeploymentConfigService cache before querying ECS', async () => {
      const deploymentConfig = makeDeploymentConfig();
      await new GamesController(makeConfig(), makeEcs(), deploymentConfig, makeGamesWrite(), makeGameWizardDraft()).listStatus();
      expect(deploymentConfig.invalidateCache).toHaveBeenCalledOnce();
    });

    it('should query ECS status for every game in the stack outputs', async () => {
      const ecs = makeEcs();
      await new GamesController(makeConfig(), ecs, makeDeploymentConfig(), makeGamesWrite(), makeGameWizardDraft()).listStatus();
      expect(ecs.getStatus).toHaveBeenCalledWith('minecraft');
      expect(ecs.getStatus).toHaveBeenCalledWith('palworld');
    });

    it('should return an empty array when tfstate is absent', async () => {
      const result = await new GamesController(makeConfig(null), makeEcs(), makeDeploymentConfig(), makeGamesWrite(), makeGameWizardDraft()).listStatus();
      expect(result).toEqual([]);
    });

    it('should return status entries in the same order as game_names', async () => {
      const ecs = makeEcs();
      vi.mocked(ecs.getStatus).mockImplementation(async (g) => ({ game: g, state: 'stopped' as const }));
      const result = await new GamesController(makeConfig(), ecs, makeDeploymentConfig(), makeGamesWrite(), makeGameWizardDraft()).listStatus();
      expect(result.map((s) => s.game)).toEqual(['minecraft', 'palworld']);
    });
  });

  describe('getStatus', () => {
    it('should delegate to EcsService without invalidating the tfstate cache via the IPC transport', async () => {
      const config = makeConfig();
      const ecs = makeEcs();
      // Simulates ElectronIPCTransport: @Payload() delivers the game name as the sole argument.
      await new GamesController(config, ecs, makeDeploymentConfig(), makeGamesWrite(), makeGameWizardDraft()).getStatus('minecraft');
      expect(config.invalidateCache).not.toHaveBeenCalled();
      expect(ecs.getStatus).toHaveBeenCalledWith('minecraft');
    });

    it('should return whatever EcsService returns via the IPC transport', async () => {
      const ecs = makeEcs();
      vi.mocked(ecs.getStatus).mockResolvedValue({ game: 'minecraft', state: 'running' });
      // Simulates ElectronIPCTransport: @Payload() delivers the game name as the sole argument.
      const result = await new GamesController(makeConfig(), ecs, makeDeploymentConfig(), makeGamesWrite(), makeGameWizardDraft()).getStatus('minecraft');
      expect(result).toEqual({ game: 'minecraft', state: 'running' });
    });
  });

  describe('start', () => {
    it('should delegate to EcsService.start with the game name received via the IPC payload', async () => {
      const ecs = makeEcs();
      // Simulates ElectronIPCTransport: @Payload() delivers the game name as the sole argument.
      await new GamesController(makeConfig(), ecs, makeDeploymentConfig(), makeGamesWrite(), makeGameWizardDraft()).start('palworld');
      expect(ecs.start).toHaveBeenCalledWith('palworld');
    });

    it('should return the result from EcsService.start via the IPC transport', async () => {
      const ecs = makeEcs();
      vi.mocked(ecs.start).mockResolvedValue({ success: true, message: 'running', taskArn: 'arn:task' });
      // Simulates ElectronIPCTransport: @Payload() delivers the game name as the sole argument.
      const result = await new GamesController(makeConfig(), ecs, makeDeploymentConfig(), makeGamesWrite(), makeGameWizardDraft()).start('minecraft');
      expect(result).toMatchObject({ success: true, taskArn: 'arn:task' });
    });
  });

  describe('stop', () => {
    it('should delegate to EcsService.stop with the game name received via the IPC payload', async () => {
      const ecs = makeEcs();
      // Simulates ElectronIPCTransport: @Payload() delivers the game name as the sole argument.
      await new GamesController(makeConfig(), ecs, makeDeploymentConfig(), makeGamesWrite(), makeGameWizardDraft()).stop('minecraft');
      expect(ecs.stop).toHaveBeenCalledWith('minecraft');
    });

    it('should return the result from EcsService.stop via the IPC transport', async () => {
      const ecs = makeEcs();
      vi.mocked(ecs.stop).mockResolvedValue({ success: true, message: 'stopped' });
      // Simulates ElectronIPCTransport: @Payload() delivers the game name as the sole argument.
      const result = await new GamesController(makeConfig(), ecs, makeDeploymentConfig(), makeGamesWrite(), makeGameWizardDraft()).stop('minecraft');
      expect(result).toMatchObject({ success: true, message: 'stopped' });
    });
  });

  describe('createGame', () => {
    it('should forward the payload verbatim to GamesWriteService.createGame via the IPC transport', async () => {
      const gamesWrite = makeGamesWrite();
      const config = { name: 'ark', image: 'ark/server:latest', cpu: 1024, memory: 2048, ports: [], volumes: [] };
      const payload = { name: 'ark', config, expectedVersionId: 'etag-1' };
      // Simulates ElectronIPCTransport: @Payload() delivers the single-object payload as the sole argument.
      await new GamesController(makeConfig(), makeEcs(), makeDeploymentConfig(), gamesWrite, makeGameWizardDraft()).createGame(payload);
      expect(gamesWrite.createGame).toHaveBeenCalledWith(payload);
    });

    it('should return whatever GamesWriteService.createGame returns via the IPC transport', async () => {
      const gamesWrite = makeGamesWrite();
      const failure: GameWriteResult = { ok: false, code: 'validation', issues: [{ path: 'name', message: 'required' }] };
      vi.mocked(gamesWrite.createGame).mockResolvedValue(failure);
      const config = { name: 'ark', image: 'ark/server:latest', cpu: 1024, memory: 2048, ports: [], volumes: [] };
      const result = await new GamesController(makeConfig(), makeEcs(), makeDeploymentConfig(), gamesWrite, makeGameWizardDraft()).createGame({ name: 'ark', config });
      expect(result).toEqual(failure);
    });
  });

  describe('updateGame', () => {
    it('should forward the payload verbatim to GamesWriteService.updateGame via the IPC transport', async () => {
      const gamesWrite = makeGamesWrite();
      const config = { name: 'ark', image: 'ark/server:latest', cpu: 1024, memory: 2048, ports: [], volumes: [] };
      const payload = { name: 'ark', config, expectedVersionId: 'etag-1' };
      // Simulates ElectronIPCTransport: @Payload() delivers the single-object payload as the sole argument.
      await new GamesController(makeConfig(), makeEcs(), makeDeploymentConfig(), gamesWrite, makeGameWizardDraft()).updateGame(payload);
      expect(gamesWrite.updateGame).toHaveBeenCalledWith(payload);
    });

    it('should return whatever GamesWriteService.updateGame returns via the IPC transport', async () => {
      const gamesWrite = makeGamesWrite();
      const conflict: GameWriteResult = {
        ok: false,
        code: 'conflict',
        expectedVersionId: 'etag-1',
        currentVersionId: 'etag-2',
        message: 'stale version',
      };
      vi.mocked(gamesWrite.updateGame).mockResolvedValue(conflict);
      const config = { name: 'ark', image: 'ark/server:latest', cpu: 1024, memory: 2048, ports: [], volumes: [] };
      const result = await new GamesController(makeConfig(), makeEcs(), makeDeploymentConfig(), gamesWrite, makeGameWizardDraft()).updateGame({ name: 'ark', config });
      expect(result).toEqual(conflict);
    });
  });

  describe('deleteGame', () => {
    it('should forward the payload verbatim to GamesWriteService.deleteGame via the IPC transport', async () => {
      const gamesWrite = makeGamesWrite();
      const payload = { name: 'ark', expectedVersionId: 'etag-1' };
      // Simulates ElectronIPCTransport: @Payload() delivers the single-object payload as the sole argument.
      await new GamesController(makeConfig(), makeEcs(), makeDeploymentConfig(), gamesWrite, makeGameWizardDraft()).deleteGame(payload);
      expect(gamesWrite.deleteGame).toHaveBeenCalledWith(payload);
    });

    it('should return whatever GamesWriteService.deleteGame returns via the IPC transport', async () => {
      const gamesWrite = makeGamesWrite();
      const notFound: GameWriteResult = { ok: false, code: 'not_found', message: 'no such game' };
      vi.mocked(gamesWrite.deleteGame).mockResolvedValue(notFound);
      const result = await new GamesController(makeConfig(), makeEcs(), makeDeploymentConfig(), gamesWrite, makeGameWizardDraft()).deleteGame({ name: 'ark' });
      expect(result).toEqual(notFound);
    });
  });
});

describe('games.draft.* handlers', () => {
  it('should register games.draft.get, games.draft.save, and games.draft.clear as MessagePatterns', () => {
    expectChannels(GamesController.prototype, [
      ['getDraft', 'games.draft.get'],
      ['saveDraft', 'games.draft.save'],
      ['clearDraft', 'games.draft.clear'],
    ] as const);
  });

  it('should return the draft service result verbatim from games.draft.get', () => {
    const draftService = makeGameWizardDraft();
    const stored: StoredGameWizardDraft = {
      draft: {
        name: 'mygame', image: 'some/image', connect_message: '', cpu: 256, memory: 512,
        ports: [], volumes: [], file_seeds: [], environment: [], https: false,
      },
      stepIndex: 1,
      savedAt: '2026-08-09T00:00:00.000Z',
    };
    vi.mocked(draftService.get).mockReturnValue(stored);
    const controller = new GamesController(makeConfig(), makeEcs(), makeDeploymentConfig(), makeGamesWrite(), draftService);

    expect(controller.getDraft()).toEqual(stored);
  });

  it('should forward the payload to GameWizardDraftService.save from games.draft.save', () => {
    const draftService = makeGameWizardDraft();
    const controller = new GamesController(makeConfig(), makeEcs(), makeDeploymentConfig(), makeGamesWrite(), draftService);
    const draft = {
      name: 'mygame', image: 'some/image', connect_message: '', cpu: 256, memory: 512,
      ports: [], volumes: [], file_seeds: [], environment: [], https: false,
    };

    controller.saveDraft({ draft, stepIndex: 2 });

    expect(draftService.save).toHaveBeenCalledWith(draft, 2);
  });

  it('should call GameWizardDraftService.clear from games.draft.clear', () => {
    const draftService = makeGameWizardDraft();
    const controller = new GamesController(makeConfig(), makeEcs(), makeDeploymentConfig(), makeGamesWrite(), draftService);

    controller.clearDraft();

    expect(draftService.clear).toHaveBeenCalled();
  });
});
