import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock('@hyveon/shared/secrets/secretsStore', () => ({
  upsertHealthCheckAuthSecret: vi.fn(),
  deleteHealthCheckAuthSecret: vi.fn(),
}));

import type { GameServer, GameServerHealthCheck, GameServerWriteConfig, StackOutputs } from '@hyveon/shared';
import { OptimisticLockError } from '@hyveon/shared';
import { upsertHealthCheckAuthSecret, deleteHealthCheckAuthSecret } from '@hyveon/shared/secrets/secretsStore';
import { GamesWriteService } from './GamesWriteService.js';
import type { AuditService } from './AuditService.js';
import type { ConfigService } from './ConfigService.js';
import type { DeploymentConfigService } from './DeploymentConfigService.js';
import { ConfigurationNotConfiguredError, GameServerEntryError } from './DeploymentConfigService.js';
import { logger } from '../logger.js';

/** Minimal, valid `GameServer` fixture matching the Fargate cpu/memory pairing table. */
function buildGameServer(name: string, overrides: Partial<GameServer> = {}): GameServer {
  return {
    name,
    image: 'example/image:latest',
    cpu: 1024,
    memory: 2048,
    ports: [{ container: 25565, protocol: 'tcp' }],
    volumes: [{ name: 'saves', container_path: '/data' }],
    ...overrides,
  };
}

/** Structurally-valid config payload (everything but `name`) for a `CreateGamePayload`/`UpdateGamePayload`. */
function buildConfig(overrides: Partial<Omit<GameServer, 'name'>> = {}): Omit<GameServer, 'name'> {
  const { name: _name, ...config } = buildGameServer('unused', overrides);
  return config;
}

/** Build a ConfigService stub with `invalidateCache` and `getStackOutputs` pre-wired. */
function makeConfigService(options: { outputs?: Partial<StackOutputs> | null } = {}): ConfigService {
  const { outputs = { gameNames: [] } } = options;
  return {
    invalidateCache: vi.fn(),
    getStackOutputs: vi.fn().mockResolvedValue(outputs),
  } as Partial<ConfigService> as ConfigService;
}

/**
 * Build a DeploymentConfigService stub with every method `GamesWriteService` touches
 * pre-wired to succeed. The write methods (`addGameServer`/`updateGameServer`/
 * `removeGameServer`) resolve to `{ etag, versionId }` matching the real
 * service's return shape, defaulting `versionId` to `'v-new'` so audit
 * assertions have a concrete value to check against.
 */
function makeDeploymentConfig(declared: GameServer[] = [], versionId: string | undefined = 'v-new'): DeploymentConfigService {
  return {
    invalidateCache: vi.fn(),
    getGameServers: vi.fn().mockResolvedValue(declared),
    addGameServer: vi.fn().mockResolvedValue({ etag: 'etag-new', versionId }),
    updateGameServer: vi.fn().mockResolvedValue({ etag: 'etag-new', versionId }),
    removeGameServer: vi.fn().mockResolvedValue({ etag: 'etag-new', versionId }),
  } as Partial<DeploymentConfigService> as DeploymentConfigService;
}

/** Build an AuditService stub with `record()` pre-wired to a no-op `vi.fn()`. */
function makeAudit(): AuditService {
  return {
    record: vi.fn().mockResolvedValue(undefined),
  } as Partial<AuditService> as AuditService;
}

/**
 * Build a minimal, fully-valid healthCheck object targeting container port
 * 25565 (matching {@link buildGameServer}'s declared ports); override any
 * fields — including `auth`, which may be a write-input shape
 * (`{ type, username, password }`/`{ type, token }`/`{ secretArn }`) or a
 * persisted shape (`{ type, secretArn }`) depending on the caller — per test.
 */
function makeHealthCheck(overrides: Partial<GameServerHealthCheck> & Record<string, unknown> = {}): Partial<GameServerHealthCheck> {
  return {
    kind: 'http',
    scheme: 'http',
    port: 25565,
    path: '/status',
    method: 'GET',
    timeoutMs: 2000,
    activeWhen: { jsonPath: 'players.online', operator: 'greaterThan', value: 0 },
    ...overrides,
  };
}

/**
 * Build a `GameServerWriteConfig` payload (everything but `name`) for a
 * `createGame`/`updateGame` call, mirroring {@link buildConfig} but typed for
 * the write path so `healthCheck.auth` can carry a write-input credential
 * instead of a pre-resolved `secretArn`.
 */
function makeConfig(overrides: { healthCheck?: unknown } & Partial<Omit<GameServer, 'name' | 'healthCheck'>> = {}): GameServerWriteConfig {
  const { healthCheck, ...rest } = overrides;
  return {
    ...buildConfig(rest),
    ...(healthCheck !== undefined ? { healthCheck } : {}),
  } as GameServerWriteConfig;
}

/** Build a minimal existing `GameServer` entry (as returned by `DeploymentConfigService.getGameServers()`); override any fields, including a persisted `healthCheck`, per test. */
function makeExistingGame(overrides: Partial<GameServer> = {}): GameServer {
  return buildGameServer(overrides.name ?? 'minecraft', overrides);
}

/**
 * Build a `GamesWriteService` wired to stubbed collaborators, returning both
 * the service and the `DeploymentConfigService` stub so a test can assert on
 * the config-write calls it received. `existingGameServers` seeds
 * `getGameServers()` — the sibling list `updateGame`/`deleteGame` search for
 * the target's prior state.
 */
function makeService(options: { existingGameServers?: GameServer[] } = {}): {
  service: GamesWriteService;
  deploymentConfig: DeploymentConfigService;
} {
  const deploymentConfig = makeDeploymentConfig(options.existingGameServers ?? []);
  const service = new GamesWriteService(makeConfigService(), deploymentConfig, makeAudit());
  return { service, deploymentConfig };
}

describe('GamesWriteService', () => {
  beforeEach(() => {
    vi.mocked(logger.info).mockClear();
    vi.mocked(upsertHealthCheckAuthSecret).mockReset();
    vi.mocked(deleteHealthCheckAuthSecret).mockReset();
  });

  describe('createGame', () => {
    it('should write the new entry and return the updated game plus the refreshed games list on success', async () => {
      const deploymentConfig = makeDeploymentConfig();
      const config = makeConfigService({ outputs: { gameNames: ['minecraft'] } });
      const audit = makeAudit();
      const service = new GamesWriteService(config, deploymentConfig, audit);

      const result = await service.createGame({ name: 'ark', config: buildConfig(), expectedVersionId: 'v1' });

      expect(deploymentConfig.addGameServer).toHaveBeenCalledWith('ark', buildConfig(), 'v1');
      expect(deploymentConfig.invalidateCache).toHaveBeenCalledOnce();
      expect(config.invalidateCache).toHaveBeenCalledOnce();
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.game).toEqual(buildGameServer('ark'));
        expect(result.games).toEqual(expect.arrayContaining([expect.objectContaining({ name: 'minecraft' })]));
      }
    });

    it("should redact the returned game's health-check credential to secretSet, never the ARN", async () => {
      const secretArn = 'arn:aws:secretsmanager:us-east-1:123456789012:secret:ark-token-AbCdEf';
      const deploymentConfig = makeDeploymentConfig();
      const audit = makeAudit();
      const service = new GamesWriteService(makeConfigService(), deploymentConfig, audit);
      const config = buildConfig({
        healthCheck: {
          kind: 'http',
          scheme: 'http',
          port: 25565,
          path: '/status',
          method: 'GET',
          timeoutMs: 2000,
          auth: { secretArn },
          activeWhen: { jsonPath: 'players.online', operator: 'greaterThan', value: 0 },
        },
      });

      const result = await service.createGame({ name: 'ark', config });

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.game?.healthCheck).toMatchObject({ secretSet: true });
        expect(result.game?.healthCheck).not.toHaveProperty('auth');
      }
      expect(JSON.stringify(result)).not.toContain(secretArn);
    });

    it('should record an audit entry exactly once with a null before, the validated after, and the write versionId', async () => {
      const deploymentConfig = makeDeploymentConfig();
      const audit = makeAudit();
      const service = new GamesWriteService(makeConfigService(), deploymentConfig, audit);

      await service.createGame({ name: 'ark', config: buildConfig(), expectedVersionId: 'v1' });

      expect(audit.record).toHaveBeenCalledOnce();
      expect(audit.record).toHaveBeenCalledWith({
        action: 'add',
        game: 'ark',
        before: null,
        after: buildGameServer('ark'),
        versionId: 'v-new',
      });
    });

    it('should emit a structured audit log entry noting s3 mode (the only mode; there is no local-file fallback)', async () => {
      const service = new GamesWriteService(makeConfigService(), makeDeploymentConfig(), makeAudit());

      await service.createGame({ name: 'ark', config: buildConfig() });

      expect(logger.info).toHaveBeenCalledWith('Game server write', { action: 'create', game: 'ark', mode: 's3' });
    });

    it('should log a debug entry line naming the game being created', async () => {
      const service = new GamesWriteService(makeConfigService(), makeDeploymentConfig(), makeAudit());
      const loggerDebugSpy = vi.spyOn(logger, 'debug');

      await service.createGame({ name: 'ark', config: buildConfig() });

      expect(loggerDebugSpy).toHaveBeenCalledWith('GamesWriteService.createGame: creating game server entry', {
        game: 'ark',
      });
    });

    it('should return a validation failure without writing or recording an audit entry when the proposed config fails business-rule validation', async () => {
      const deploymentConfig = makeDeploymentConfig();
      const audit = makeAudit();
      const service = new GamesWriteService(makeConfigService(), deploymentConfig, audit);

      const result = await service.createGame({ name: 'ark', config: buildConfig({ cpu: 256, memory: 4096 }) });

      expect(result).toEqual({
        ok: false,
        code: 'validation',
        issues: expect.arrayContaining([expect.objectContaining({ path: 'memory' })]),
      });
      expect(deploymentConfig.addGameServer).not.toHaveBeenCalled();
      expect(audit.record).not.toHaveBeenCalled();
    });

    it('should return a conflict result without recording an audit entry when the write raises OptimisticLockError', async () => {
      const deploymentConfig = makeDeploymentConfig();
      deploymentConfig.addGameServer = vi.fn().mockRejectedValue(new OptimisticLockError('old-etag', 'new-etag'));
      const audit = makeAudit();
      const service = new GamesWriteService(makeConfigService(), deploymentConfig, audit);

      const result = await service.createGame({ name: 'ark', config: buildConfig(), expectedVersionId: 'old-etag' });

      expect(result).toMatchObject({
        ok: false,
        code: 'conflict',
        expectedVersionId: 'old-etag',
        currentVersionId: 'new-etag',
      });
      expect(audit.record).not.toHaveBeenCalled();
    });

    it('should log a warning with both etags when the write raises OptimisticLockError', async () => {
      const deploymentConfig = makeDeploymentConfig();
      deploymentConfig.addGameServer = vi.fn().mockRejectedValue(new OptimisticLockError('old-etag', 'new-etag'));
      const service = new GamesWriteService(makeConfigService(), deploymentConfig, makeAudit());
      const loggerWarnSpy = vi.spyOn(logger, 'warn');

      await service.createGame({ name: 'ark', config: buildConfig(), expectedVersionId: 'old-etag' });

      expect(loggerWarnSpy).toHaveBeenCalledWith('Game server write rejected — stale expectedVersionId', {
        message: expect.any(String),
        expectedVersionId: 'old-etag',
        currentVersionId: 'new-etag',
      });
    });

    it('should return a validation failure with a name-path issue without recording an audit entry when the entry name already exists', async () => {
      const deploymentConfig = makeDeploymentConfig();
      deploymentConfig.addGameServer = vi
        .fn()
        .mockRejectedValue(
          new GameServerEntryError(
            'Entry "ark" already exists in "gameServers" — use updateGameServer() instead.',
            'duplicate-name',
          ),
        );
      const audit = makeAudit();
      const service = new GamesWriteService(makeConfigService(), deploymentConfig, audit);

      const result = await service.createGame({ name: 'ark', config: buildConfig() });

      expect(result).toEqual({
        ok: false,
        code: 'validation',
        issues: [{ path: 'name', message: expect.stringContaining('already exists') }],
      });
      expect(audit.record).not.toHaveBeenCalled();
    });

    it('should return a catch-all error result without recording an audit entry when the write raises an unexpected error', async () => {
      const deploymentConfig = makeDeploymentConfig();
      const originalError = new Error('disk full');
      deploymentConfig.addGameServer = vi.fn().mockRejectedValue(originalError);
      const audit = makeAudit();
      const service = new GamesWriteService(makeConfigService(), deploymentConfig, audit);
      const loggerErrorSpy = vi.spyOn(logger, 'error');

      const result = await service.createGame({ name: 'ark', config: buildConfig() });

      expect(result).toEqual({
        ok: false,
        code: 'error',
        message: 'An unexpected error occurred while writing the game server configuration',
      });
      expect(loggerErrorSpy).toHaveBeenCalledWith('Game server write failed', { err: originalError });
      expect(audit.record).not.toHaveBeenCalled();
    });

    it('should return a catch-all error result (not a name-validation issue) without recording an audit entry when addGameServer() throws a structural GameServerEntryError', async () => {
      const deploymentConfig = makeDeploymentConfig();
      const structuralError = new GameServerEntryError('"gameServers" map not found in the deployment config JSON.', 'structural');
      deploymentConfig.addGameServer = vi.fn().mockRejectedValue(structuralError);
      const audit = makeAudit();
      const service = new GamesWriteService(makeConfigService(), deploymentConfig, audit);
      const loggerErrorSpy = vi.spyOn(logger, 'error');

      const result = await service.createGame({ name: 'ark', config: buildConfig() });

      expect(result).toEqual({
        ok: false,
        code: 'error',
        message: 'An unexpected error occurred while writing the game server configuration',
      });
      expect(loggerErrorSpy).toHaveBeenCalledWith('Game server write failed', { err: structuralError });
      expect(audit.record).not.toHaveBeenCalled();
    });

    it('should surface a distinct setup_incomplete code (not the generic error code) without recording an audit entry when addGameServer() throws ConfigurationNotConfiguredError', async () => {
      const deploymentConfig = makeDeploymentConfig();
      const notConfiguredError = new ConfigurationNotConfiguredError();
      deploymentConfig.addGameServer = vi.fn().mockRejectedValue(notConfiguredError);
      const audit = makeAudit();
      const service = new GamesWriteService(makeConfigService(), deploymentConfig, audit);

      const result = await service.createGame({ name: 'ark', config: buildConfig() });

      expect(result).toEqual({
        ok: false,
        code: 'setup_incomplete',
        message: notConfiguredError.message,
      });
      // Pinned distinctly from the generic catch-all so a caller can tell
      // "setup incomplete" apart from an ordinary unexpected failure.
      expect(result).not.toMatchObject({ code: 'error' });
      expect(audit.record).not.toHaveBeenCalled();
    });
  });

  describe('updateGame', () => {
    it('should write the updated entry and return the updated game plus the refreshed games list on success', async () => {
      const deploymentConfig = makeDeploymentConfig([buildGameServer('minecraft')]);
      const config = makeConfigService({ outputs: { gameNames: ['minecraft'] } });
      const service = new GamesWriteService(config, deploymentConfig, makeAudit());
      const newConfig = buildConfig({ cpu: 2048, memory: 4096 });

      const result = await service.updateGame({ name: 'minecraft', config: newConfig, expectedVersionId: 'v1' });

      expect(deploymentConfig.updateGameServer).toHaveBeenCalledWith('minecraft', newConfig, 'v1');
      expect(deploymentConfig.invalidateCache).toHaveBeenCalledOnce();
      expect(config.invalidateCache).toHaveBeenCalledOnce();
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.game).toEqual(buildGameServer('minecraft', { cpu: 2048, memory: 4096 }));
      }
    });

    it('should record an audit entry exactly once with the pre-mutation sibling entry as before, the validated after, and the write versionId', async () => {
      const deploymentConfig = makeDeploymentConfig([buildGameServer('minecraft')]);
      const audit = makeAudit();
      const service = new GamesWriteService(makeConfigService(), deploymentConfig, audit);
      const newConfig = buildConfig({ cpu: 2048, memory: 4096 });

      await service.updateGame({ name: 'minecraft', config: newConfig, expectedVersionId: 'v1' });

      expect(audit.record).toHaveBeenCalledOnce();
      expect(audit.record).toHaveBeenCalledWith({
        action: 'edit',
        game: 'minecraft',
        before: buildGameServer('minecraft'),
        after: buildGameServer('minecraft', { cpu: 2048, memory: 4096 }),
        versionId: 'v-new',
      });
    });

    it('should return a validation failure without writing or recording an audit entry when the proposed config fails business-rule validation', async () => {
      const deploymentConfig = makeDeploymentConfig([buildGameServer('minecraft')]);
      const audit = makeAudit();
      const service = new GamesWriteService(makeConfigService(), deploymentConfig, audit);

      const result = await service.updateGame({
        name: 'minecraft',
        config: buildConfig({ cpu: 256, memory: 4096 }),
      });

      expect(result).toMatchObject({ ok: false, code: 'validation' });
      expect(deploymentConfig.updateGameServer).not.toHaveBeenCalled();
      expect(audit.record).not.toHaveBeenCalled();
    });

    it('should return a conflict result without recording an audit entry when the write raises OptimisticLockError', async () => {
      const deploymentConfig = makeDeploymentConfig([buildGameServer('minecraft')]);
      deploymentConfig.updateGameServer = vi.fn().mockRejectedValue(new OptimisticLockError('old-etag', 'new-etag'));
      const audit = makeAudit();
      const service = new GamesWriteService(makeConfigService(), deploymentConfig, audit);

      const result = await service.updateGame({
        name: 'minecraft',
        config: buildConfig(),
        expectedVersionId: 'old-etag',
      });

      expect(result).toMatchObject({
        ok: false,
        code: 'conflict',
        expectedVersionId: 'old-etag',
        currentVersionId: 'new-etag',
      });
      expect(audit.record).not.toHaveBeenCalled();
    });

    it('should return a not_found result without recording an audit entry when the target game does not exist in gameServers', async () => {
      const deploymentConfig = makeDeploymentConfig([buildGameServer('minecraft')]);
      deploymentConfig.updateGameServer = vi.fn().mockRejectedValue(new GameServerEntryError('Entry "ark" not found in "gameServers".', 'not-found'));
      const audit = makeAudit();
      const service = new GamesWriteService(makeConfigService(), deploymentConfig, audit);

      const result = await service.updateGame({
        name: 'ark',
        config: buildConfig({ ports: [{ container: 7777, protocol: 'udp' }] }),
      });

      expect(result).toEqual({ ok: false, code: 'not_found', message: expect.stringContaining('not found') });
      expect(audit.record).not.toHaveBeenCalled();
    });

    it('should surface a distinct setup_incomplete code (not the generic error code) without recording an audit entry when updateGameServer() throws ConfigurationNotConfiguredError', async () => {
      const deploymentConfig = makeDeploymentConfig([buildGameServer('minecraft')]);
      const notConfiguredError = new ConfigurationNotConfiguredError();
      deploymentConfig.updateGameServer = vi.fn().mockRejectedValue(notConfiguredError);
      const audit = makeAudit();
      const service = new GamesWriteService(makeConfigService(), deploymentConfig, audit);

      const result = await service.updateGame({ name: 'minecraft', config: buildConfig() });

      expect(result).toEqual({ ok: false, code: 'setup_incomplete', message: notConfiguredError.message });
      expect(result).not.toMatchObject({ code: 'error' });
      expect(audit.record).not.toHaveBeenCalled();
    });

    it('should log a debug entry line naming the game being updated', async () => {
      const deploymentConfig = makeDeploymentConfig([buildGameServer('minecraft')]);
      const service = new GamesWriteService(makeConfigService(), deploymentConfig, makeAudit());
      const loggerDebugSpy = vi.spyOn(logger, 'debug');

      await service.updateGame({ name: 'minecraft', config: buildConfig() });

      expect(loggerDebugSpy).toHaveBeenCalledWith('GamesWriteService.updateGame: updating game server entry', {
        game: 'minecraft',
      });
    });
  });

  describe('deleteGame', () => {
    it('should remove the entry and return the refreshed games list without a game field on success', async () => {
      const deploymentConfig = makeDeploymentConfig([buildGameServer('minecraft')]);
      const config = makeConfigService({ outputs: { gameNames: [] } });
      const service = new GamesWriteService(config, deploymentConfig, makeAudit());

      const result = await service.deleteGame({ name: 'minecraft', expectedVersionId: 'v1' });

      expect(deploymentConfig.removeGameServer).toHaveBeenCalledWith('minecraft', 'v1');
      expect(deploymentConfig.invalidateCache).toHaveBeenCalledOnce();
      expect(config.invalidateCache).toHaveBeenCalledOnce();
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.game).toBeUndefined();
      }
    });

    it('should record an audit entry exactly once with the pre-mutation sibling entry as before, a null after, and the write versionId', async () => {
      const deploymentConfig = makeDeploymentConfig([buildGameServer('minecraft')]);
      const audit = makeAudit();
      const service = new GamesWriteService(makeConfigService(), deploymentConfig, audit);

      await service.deleteGame({ name: 'minecraft', expectedVersionId: 'v1' });

      expect(audit.record).toHaveBeenCalledOnce();
      expect(audit.record).toHaveBeenCalledWith({
        action: 'remove',
        game: 'minecraft',
        before: buildGameServer('minecraft'),
        after: null,
        versionId: 'v-new',
      });
    });

    it('should emit a structured audit log entry with the game name even though no game object is returned', async () => {
      const deploymentConfig = makeDeploymentConfig([buildGameServer('minecraft')]);
      const service = new GamesWriteService(makeConfigService(), deploymentConfig, makeAudit());

      await service.deleteGame({ name: 'minecraft' });

      expect(logger.info).toHaveBeenCalledWith('Game server write', { action: 'delete', game: 'minecraft', mode: 's3' });
    });

    it('should log a debug entry line naming the game being deleted', async () => {
      const deploymentConfig = makeDeploymentConfig([buildGameServer('minecraft')]);
      const service = new GamesWriteService(makeConfigService(), deploymentConfig, makeAudit());
      const loggerDebugSpy = vi.spyOn(logger, 'debug');

      await service.deleteGame({ name: 'minecraft' });

      expect(loggerDebugSpy).toHaveBeenCalledWith('GamesWriteService.deleteGame: deleting game server entry', {
        game: 'minecraft',
      });
    });

    it('should return a conflict result without recording an audit entry when the write raises OptimisticLockError', async () => {
      const deploymentConfig = makeDeploymentConfig([buildGameServer('minecraft')]);
      deploymentConfig.removeGameServer = vi.fn().mockRejectedValue(new OptimisticLockError('old-etag', 'new-etag'));
      const audit = makeAudit();
      const service = new GamesWriteService(makeConfigService(), deploymentConfig, audit);

      const result = await service.deleteGame({ name: 'minecraft', expectedVersionId: 'old-etag' });

      expect(result).toMatchObject({
        ok: false,
        code: 'conflict',
        expectedVersionId: 'old-etag',
        currentVersionId: 'new-etag',
      });
      expect(audit.record).not.toHaveBeenCalled();
    });

    it('should return a not_found result without recording an audit entry when the target game does not exist in gameServers', async () => {
      const deploymentConfig = makeDeploymentConfig([]);
      deploymentConfig.removeGameServer = vi.fn().mockRejectedValue(new GameServerEntryError('Entry "ark" not found in "gameServers".', 'not-found'));
      const audit = makeAudit();
      const service = new GamesWriteService(makeConfigService(), deploymentConfig, audit);

      const result = await service.deleteGame({ name: 'ark' });

      expect(result).toEqual({ ok: false, code: 'not_found', message: expect.stringContaining('not found') });
      expect(audit.record).not.toHaveBeenCalled();
    });

    it('should surface a distinct setup_incomplete code (not the generic error code) without recording an audit entry when removeGameServer() throws ConfigurationNotConfiguredError', async () => {
      const deploymentConfig = makeDeploymentConfig([buildGameServer('minecraft')]);
      const notConfiguredError = new ConfigurationNotConfiguredError();
      deploymentConfig.removeGameServer = vi.fn().mockRejectedValue(notConfiguredError);
      const audit = makeAudit();
      const service = new GamesWriteService(makeConfigService(), deploymentConfig, audit);

      const result = await service.deleteGame({ name: 'minecraft' });

      expect(result).toEqual({ ok: false, code: 'setup_incomplete', message: notConfiguredError.message });
      expect(result).not.toMatchObject({ code: 'error' });
      expect(audit.record).not.toHaveBeenCalled();
    });
  });

  describe('health-check credential lifecycle', () => {
    it('should create an app-owned secret on first save of a basic credential and persist only its secretArn', async () => {
      vi.mocked(upsertHealthCheckAuthSecret).mockResolvedValue(
        'arn:aws:secretsmanager:us-east-1:123456789012:secret:hyveon-minecraft-healthcheck-auth-AbCdEf',
      );
      const { service, deploymentConfig } = makeService({ existingGameServers: [] });

      const result = await service.createGame({
        name: 'minecraft',
        config: makeConfig({
          healthCheck: makeHealthCheck({ auth: { type: 'basic', username: 'admin', password: 'hunter2' } }),
        }),
      });

      expect(upsertHealthCheckAuthSecret).toHaveBeenCalledWith('minecraft', JSON.stringify({ username: 'admin', password: 'hunter2' }));
      expect(result.ok).toBe(true);
      const written = vi.mocked(deploymentConfig.addGameServer).mock.calls[0]?.[1] as GameServer;
      expect(written.healthCheck?.auth).toEqual({
        type: 'basic',
        secretArn: 'arn:aws:secretsmanager:us-east-1:123456789012:secret:hyveon-minecraft-healthcheck-auth-AbCdEf',
      });
    });

    it('should update the existing app-owned secret in place when a bearer token changes, not create a new one', async () => {
      vi.mocked(upsertHealthCheckAuthSecret).mockResolvedValue(
        'arn:aws:secretsmanager:us-east-1:123456789012:secret:hyveon-minecraft-healthcheck-auth-AbCdEf',
      );
      const before = makeExistingGame({
        name: 'minecraft',
        healthCheck: makeHealthCheck({
          auth: {
            type: 'bearer',
            secretArn: 'arn:aws:secretsmanager:us-east-1:123456789012:secret:hyveon-minecraft-healthcheck-auth-AbCdEf',
          },
        }) as GameServerHealthCheck,
      });
      const { service } = makeService({ existingGameServers: [before] });

      await service.updateGame({
        name: 'minecraft',
        config: makeConfig({ healthCheck: makeHealthCheck({ auth: { type: 'bearer', token: 'new-token' } }) }),
      });

      expect(upsertHealthCheckAuthSecret).toHaveBeenCalledWith('minecraft', 'new-token');
    });

    it('should delete the app-owned secret when a basic credential is removed', async () => {
      const before = makeExistingGame({
        name: 'minecraft',
        healthCheck: makeHealthCheck({
          auth: {
            type: 'basic',
            secretArn: 'arn:aws:secretsmanager:us-east-1:123456789012:secret:hyveon-minecraft-healthcheck-auth-AbCdEf',
          },
        }) as GameServerHealthCheck,
      });
      const { service } = makeService({ existingGameServers: [before] });

      await service.updateGame({
        name: 'minecraft',
        config: makeConfig({ healthCheck: { ...makeHealthCheck(), auth: null } }),
      });

      expect(deleteHealthCheckAuthSecret).toHaveBeenCalledWith('minecraft');
    });

    it('should delete the app-owned secret when a game with an app-owned credential is deleted', async () => {
      const before = makeExistingGame({
        name: 'minecraft',
        healthCheck: makeHealthCheck({
          auth: {
            type: 'basic',
            secretArn: 'arn:aws:secretsmanager:us-east-1:123456789012:secret:hyveon-minecraft-healthcheck-auth-AbCdEf',
          },
        }) as GameServerHealthCheck,
      });
      const { service } = makeService({ existingGameServers: [before] });

      await service.deleteGame({ name: 'minecraft' });

      expect(deleteHealthCheckAuthSecret).toHaveBeenCalledWith('minecraft');
    });

    it('should never call upsertHealthCheckAuthSecret or deleteHealthCheckAuthSecret for a raw credential', async () => {
      const before = makeExistingGame({
        name: 'minecraft',
        healthCheck: makeHealthCheck({
          auth: { type: 'raw', secretArn: 'arn:aws:secretsmanager:us-east-1:123456789012:secret:operator-owned-AbCdEf' },
        }) as GameServerHealthCheck,
      });
      const { service } = makeService({ existingGameServers: [before] });

      await service.deleteGame({ name: 'minecraft' });

      expect(upsertHealthCheckAuthSecret).not.toHaveBeenCalled();
      expect(deleteHealthCheckAuthSecret).not.toHaveBeenCalled();
    });

    it('should return a validation failure without calling Secrets Manager when a basic credential is missing a password', async () => {
      const { service } = makeService({ existingGameServers: [] });

      const result = await service.createGame({
        name: 'minecraft',
        config: makeConfig({ healthCheck: makeHealthCheck({ auth: { type: 'basic', username: 'admin' } }) }),
      });

      expect(result).toMatchObject({ ok: false, code: 'validation' });
      expect(upsertHealthCheckAuthSecret).not.toHaveBeenCalled();
    });

    it('should return a validation failure without calling Secrets Manager when a valid basic credential accompanies an unrelated cpu/memory pairing failure', async () => {
      // auth.type is a valid, otherwise-savable 'basic' credential — the
      // only thing wrong with this entry is the Fargate cpu/memory pairing
      // (256 cpu only pairs with 512-1024 memory), a structural rule that
      // has nothing to do with `auth`. Regression coverage for the
      // ordering bug: `resolveHealthCheckAuthSecret`'s Secrets Manager
      // write must never run before this kind of unrelated failure is
      // known, or a rejected save still leaves a live secret mutated.
      const { service } = makeService({ existingGameServers: [] });

      const result = await service.createGame({
        name: 'minecraft',
        config: makeConfig({
          cpu: 256,
          memory: 4096,
          healthCheck: makeHealthCheck({ auth: { type: 'basic', username: 'admin', password: 'hunter2' } }),
        }),
      });

      expect(result).toMatchObject({ ok: false, code: 'validation' });
      expect(upsertHealthCheckAuthSecret).not.toHaveBeenCalled();
      expect(deleteHealthCheckAuthSecret).not.toHaveBeenCalled();
    });

    it('should return a validation failure without calling Secrets Manager on updateGame when a valid bearer credential accompanies an unrelated cpu/memory pairing failure', async () => {
      const before = makeExistingGame({ name: 'minecraft' });
      const { service } = makeService({ existingGameServers: [before] });

      const result = await service.updateGame({
        name: 'minecraft',
        config: makeConfig({
          cpu: 256,
          memory: 4096,
          healthCheck: makeHealthCheck({ auth: { type: 'bearer', token: 'new-token' } }),
        }),
      });

      expect(result).toMatchObject({ ok: false, code: 'validation' });
      expect(upsertHealthCheckAuthSecret).not.toHaveBeenCalled();
      expect(deleteHealthCheckAuthSecret).not.toHaveBeenCalled();
    });
  });
});
