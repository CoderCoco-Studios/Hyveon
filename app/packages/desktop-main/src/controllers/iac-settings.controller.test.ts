import 'reflect-metadata';
import { describe, it, expect, vi } from 'vitest';
import type { TopLevelDeploymentSettings, UpdateDeploymentSettingsPayload } from '@hyveon/shared';
import { OptimisticLockError } from '@hyveon/shared';
import { IacSettingsController } from './iac-settings.controller.js';
import { ConfigurationNotConfiguredError, RunsTableRenameError, DeploymentConfigService } from '../services/DeploymentConfigService.js';
import type { PulumiEngineService } from '../services/PulumiEngineService.js';
import type { ElectronStoreService } from '../services/ElectronStoreService.js';

vi.mock('../logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

/** Default top-level settings fixture used by most tests. */
const SETTINGS: TopLevelDeploymentSettings = {
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
};

/** Build a `DeploymentConfigService` stub exposing just the methods `IacSettingsController` calls. */
function makeDeploymentConfig(): DeploymentConfigService {
  return {
    getTopLevelSettings: vi.fn().mockResolvedValue({ settings: SETTINGS, etag: 'etag-1' }),
    updateTopLevelSettings: vi.fn().mockResolvedValue({ etag: 'etag-2', versionId: 'v-2' }),
  } as Partial<DeploymentConfigService> as DeploymentConfigService;
}

/**
 * The metadata key NestJS stores on each method decorated with
 * `@MessagePattern`. Asserting this value guards against a typo in the
 * controller silently breaking IPC — calling the method directly (as every
 * other test does) would succeed regardless of what string is registered
 * with the transport.
 */
const PATTERN_METADATA_KEY = 'microservices:pattern';

describe('IacSettingsController', () => {
  describe('@MessagePattern channel names', () => {
    it('should register get on the "iac.settings.get" IPC channel', () => {
      const pattern = Reflect.getMetadata(PATTERN_METADATA_KEY, IacSettingsController.prototype.get);
      expect(pattern).toEqual(['iac.settings.get']);
    });

    it('should register update on the "iac.settings.update" IPC channel', () => {
      const pattern = Reflect.getMetadata(PATTERN_METADATA_KEY, IacSettingsController.prototype.update);
      expect(pattern).toEqual(['iac.settings.update']);
    });

    it('should register engineVersion on the "iac.settings.engineVersion" IPC channel', () => {
      const pattern = Reflect.getMetadata(PATTERN_METADATA_KEY, IacSettingsController.prototype.engineVersion);
      expect(pattern).toEqual(['iac.settings.engineVersion']);
    });

    it('should register getAutoUpdate on the "iac.settings.autoUpdate.get" IPC channel', () => {
      const pattern = Reflect.getMetadata(PATTERN_METADATA_KEY, IacSettingsController.prototype.getAutoUpdate);
      expect(pattern).toEqual(['iac.settings.autoUpdate.get']);
    });

    it('should register updateAutoUpdate on the "iac.settings.autoUpdate.update" IPC channel', () => {
      const pattern = Reflect.getMetadata(PATTERN_METADATA_KEY, IacSettingsController.prototype.updateAutoUpdate);
      expect(pattern).toEqual(['iac.settings.autoUpdate.update']);
    });
  });

  describe('get', () => {
    it('should return the top-level settings and etag from DeploymentConfigService.getTopLevelSettings', async () => {
      const deploymentConfig = makeDeploymentConfig();
      const result = await new IacSettingsController(deploymentConfig).get();
      expect(result).toEqual({ ok: true, settings: SETTINGS, etag: 'etag-1' });
    });

    it('should return code: "setup_incomplete" when no configuration bucket is configured', async () => {
      const deploymentConfig = makeDeploymentConfig();
      vi.mocked(deploymentConfig.getTopLevelSettings).mockRejectedValue(new ConfigurationNotConfiguredError());

      const result = await new IacSettingsController(deploymentConfig).get();

      expect(result).toEqual({ ok: false, code: 'setup_incomplete', message: expect.any(String) });
    });

    it('should return the catch-all code: "error" for any other failure', async () => {
      const deploymentConfig = makeDeploymentConfig();
      vi.mocked(deploymentConfig.getTopLevelSettings).mockRejectedValue(new Error('S3 unreachable'));

      const result = await new IacSettingsController(deploymentConfig).get();

      expect(result).toEqual({ ok: false, code: 'error', message: expect.any(String) });
    });
  });

  describe('update', () => {
    /** A minimal, always-valid update payload. */
    const PAYLOAD: UpdateDeploymentSettingsPayload = {
      patch: { dnsTtl: 60 },
      expectedVersionId: 'etag-1',
    };

    it('should delegate to DeploymentConfigService.updateTopLevelSettings with the patch and expectedVersionId', async () => {
      const deploymentConfig = makeDeploymentConfig();
      await new IacSettingsController(deploymentConfig).update(PAYLOAD);
      expect(deploymentConfig.updateTopLevelSettings).toHaveBeenCalledWith({ dnsTtl: 60 }, 'etag-1');
    });

    it('should return ok: true with the re-read settings and the write result etag/versionId on success', async () => {
      const deploymentConfig = makeDeploymentConfig();
      vi.mocked(deploymentConfig.getTopLevelSettings).mockResolvedValue({
        settings: { ...SETTINGS, dnsTtl: 60 },
        etag: 'etag-2',
      });

      const result = await new IacSettingsController(deploymentConfig).update(PAYLOAD);

      expect(result).toEqual({
        ok: true,
        settings: { ...SETTINGS, dnsTtl: 60 },
        etag: 'etag-2',
        versionId: 'v-2',
      });
    });

    it('should re-read the settings AFTER the write so the returned settings reflect the persisted document', async () => {
      const deploymentConfig = makeDeploymentConfig();
      const calls: string[] = [];
      vi.mocked(deploymentConfig.updateTopLevelSettings).mockImplementation(async () => {
        calls.push('update');
        return { etag: 'etag-2', versionId: 'v-2' };
      });
      vi.mocked(deploymentConfig.getTopLevelSettings).mockImplementation(async () => {
        calls.push('get');
        return { settings: SETTINGS, etag: 'etag-2' };
      });

      await new IacSettingsController(deploymentConfig).update(PAYLOAD);

      expect(calls).toEqual(['update', 'get']);
    });

    it('should never call DeploymentConfigService.updateTopLevelSettings when the patch fails validation', async () => {
      const deploymentConfig = makeDeploymentConfig();
      const result = await new IacSettingsController(deploymentConfig).update({ patch: { hostedZoneName: '' } });

      expect(result).toEqual({
        ok: false,
        code: 'validation',
        issues: [{ path: 'hostedZoneName', message: 'Must not be empty.' }],
      });
      expect(deploymentConfig.updateTopLevelSettings).not.toHaveBeenCalled();
    });

    it('should return code: "conflict" with both etags on OptimisticLockError', async () => {
      const deploymentConfig = makeDeploymentConfig();
      vi.mocked(deploymentConfig.updateTopLevelSettings).mockRejectedValue(new OptimisticLockError('etag-1', 'etag-current'));

      const result = await new IacSettingsController(deploymentConfig).update(PAYLOAD);

      expect(result).toEqual({
        ok: false,
        code: 'conflict',
        expectedVersionId: 'etag-1',
        currentVersionId: 'etag-current',
        message: expect.any(String),
      });
    });

    it('should return code: "setup_incomplete" when no configuration bucket is configured', async () => {
      const deploymentConfig = makeDeploymentConfig();
      vi.mocked(deploymentConfig.updateTopLevelSettings).mockRejectedValue(new ConfigurationNotConfiguredError());

      const result = await new IacSettingsController(deploymentConfig).update(PAYLOAD);

      expect(result).toEqual({ ok: false, code: 'setup_incomplete', message: expect.any(String) });
    });

    it('should return code: "validation" with one issue per affected field on RunsTableRenameError (final-review round 2, finding 2)', async () => {
      const deploymentConfig = makeDeploymentConfig();
      vi.mocked(deploymentConfig.updateTopLevelSettings).mockRejectedValue(
        new RunsTableRenameError('hyveon-runs', 'other-runs', ['projectName', 'runsTableName']),
      );

      const result = await new IacSettingsController(deploymentConfig).update({
        patch: { projectName: 'other', runsTableName: 'other-runs' },
        expectedVersionId: 'etag-1',
      });

      expect(result).toEqual({
        ok: false,
        code: 'validation',
        issues: [
          { path: 'projectName', message: expect.stringMatching(/hyveon-runs.*other-runs/) },
          { path: 'runsTableName', message: expect.stringMatching(/hyveon-runs.*other-runs/) },
        ],
      });
    });

    it('should return the catch-all code: "error" for any other failure', async () => {
      const deploymentConfig = makeDeploymentConfig();
      vi.mocked(deploymentConfig.updateTopLevelSettings).mockRejectedValue(new Error('malformed config JSON'));

      const result = await new IacSettingsController(deploymentConfig).update(PAYLOAD);

      expect(result).toEqual({ ok: false, code: 'error', message: expect.any(String) });
    });

    it('should return the catch-all code: "error" (never throw) for a malformed payload envelope', async () => {
      const deploymentConfig = makeDeploymentConfig();

      // `payload.patch` absent entirely — nothing upstream of this handler
      // guarantees the IPC envelope is well-formed. Cast through `unknown`
      // to simulate a caller that bypasses the renderer's typed
      // `UpdateDeploymentSettingsPayload` construction.
      const malformedPayload = {} as unknown as UpdateDeploymentSettingsPayload;

      await expect(new IacSettingsController(deploymentConfig).update(malformedPayload)).resolves.toEqual({
        ok: false,
        code: 'error',
        message: expect.any(String),
      });
      expect(deploymentConfig.updateTopLevelSettings).not.toHaveBeenCalled();
    });
  });

  describe('engineVersion', () => {
    /** Build a `PulumiEngineService` stub exposing just `getResolvedVersion`. */
    function makeEngine(resolvedVersion: string | null): PulumiEngineService {
      return {
        getResolvedVersion: vi.fn().mockReturnValue(resolvedVersion),
      } as Partial<PulumiEngineService> as PulumiEngineService;
    }

    it('should return the resolved version reported by PulumiEngineService.getResolvedVersion', () => {
      const engine = makeEngine('3.255.0');
      const result = new IacSettingsController(makeDeploymentConfig(), engine).engineVersion();
      expect(result).toEqual({ resolvedVersion: '3.255.0' });
    });

    it('should return resolvedVersion: null when the engine has not been provisioned yet', () => {
      const engine = makeEngine(null);
      const result = new IacSettingsController(makeDeploymentConfig(), engine).engineVersion();
      expect(result).toEqual({ resolvedVersion: null });
    });

    it('should return resolvedVersion: null without throwing when no engine was injected', () => {
      const result = new IacSettingsController(makeDeploymentConfig()).engineVersion();
      expect(result).toEqual({ resolvedVersion: null });
    });
  });

  describe('getAutoUpdate', () => {
    /** Build an `ElectronStoreService` stub backed by an in-memory map, mirroring the real Map-backed fallback. */
    function makeStore(initial: Record<string, unknown> = {}): ElectronStoreService {
      const map = new Map<string, unknown>(Object.entries(initial));
      return {
        get: vi.fn((key: string) => map.get(key)),
        set: vi.fn((key: string, value: unknown) => {
          map.set(key, value);
        }),
      } as Partial<ElectronStoreService> as ElectronStoreService;
    }

    it('should return false when enableAutoUpdate was never set', () => {
      const store = makeStore();
      const result = new IacSettingsController(makeDeploymentConfig(), undefined, store).getAutoUpdate();
      expect(result).toEqual({ ok: true, enableAutoUpdate: false });
    });

    it('should return true when enableAutoUpdate is stored as true', () => {
      const store = makeStore({ enableAutoUpdate: true });
      const result = new IacSettingsController(makeDeploymentConfig(), undefined, store).getAutoUpdate();
      expect(result).toEqual({ ok: true, enableAutoUpdate: true });
    });

    it('should return false without throwing when no store was injected', () => {
      const result = new IacSettingsController(makeDeploymentConfig()).getAutoUpdate();
      expect(result).toEqual({ ok: true, enableAutoUpdate: false });
    });
  });

  describe('updateAutoUpdate', () => {
    function makeStore(initial: Record<string, unknown> = {}): ElectronStoreService {
      const map = new Map<string, unknown>(Object.entries(initial));
      return {
        get: vi.fn((key: string) => map.get(key)),
        set: vi.fn((key: string, value: unknown) => {
          map.set(key, value);
        }),
      } as Partial<ElectronStoreService> as ElectronStoreService;
    }

    it('should persist true and round-trip through a subsequent get', () => {
      const store = makeStore();
      const controller = new IacSettingsController(makeDeploymentConfig(), undefined, store);
      const writeResult = controller.updateAutoUpdate({ enableAutoUpdate: true });
      expect(writeResult).toEqual({ ok: true, enableAutoUpdate: true });
      expect(controller.getAutoUpdate()).toEqual({ ok: true, enableAutoUpdate: true });
    });

    it('should persist false', () => {
      const store = makeStore({ enableAutoUpdate: true });
      const controller = new IacSettingsController(makeDeploymentConfig(), undefined, store);
      const writeResult = controller.updateAutoUpdate({ enableAutoUpdate: false });
      expect(writeResult).toEqual({ ok: true, enableAutoUpdate: false });
    });

    it('should return an error result without throwing when no store was injected', () => {
      const controller = new IacSettingsController(makeDeploymentConfig());
      const result = controller.updateAutoUpdate({ enableAutoUpdate: true });
      expect(result).toEqual({ ok: false, code: 'error', message: expect.any(String) });
    });

    it('should reject a non-boolean payload without writing to the store', () => {
      const store = makeStore();
      const controller = new IacSettingsController(makeDeploymentConfig(), undefined, store);
      // @ts-expect-error deliberately malformed payload — IPC boundary has no runtime type guarantee
      const result = controller.updateAutoUpdate({ enableAutoUpdate: 'true' });
      expect(result).toEqual({ ok: false, code: 'error', message: expect.any(String) });
      expect(store.set).not.toHaveBeenCalled();
    });
  });
});
