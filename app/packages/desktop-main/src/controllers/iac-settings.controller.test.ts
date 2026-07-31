import 'reflect-metadata';
import { describe, it, expect, vi } from 'vitest';
import type { TopLevelDeploymentSettings, UpdateDeploymentSettingsPayload } from '@hyveon/shared';
import { OptimisticLockError } from '@hyveon/shared';
import { IacSettingsController } from './iac-settings.controller.js';
import { ConfigurationNotConfiguredError, TfvarsService } from '../services/TfvarsService.js';

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

/** Build a `TfvarsService` stub exposing just the methods `IacSettingsController` calls. */
function makeTfvars(): TfvarsService {
  return {
    getTopLevelSettings: vi.fn().mockResolvedValue({ settings: SETTINGS, etag: 'etag-1' }),
    updateTopLevelSettings: vi.fn().mockResolvedValue({ etag: 'etag-2', versionId: 'v-2' }),
  } as Partial<TfvarsService> as TfvarsService;
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
  });

  describe('get', () => {
    it('should return the top-level settings and etag from TfvarsService.getTopLevelSettings', async () => {
      const tfvars = makeTfvars();
      const result = await new IacSettingsController(tfvars).get();
      expect(result).toEqual({ ok: true, settings: SETTINGS, etag: 'etag-1' });
    });

    it('should return code: "setup_incomplete" when no configuration bucket is configured', async () => {
      const tfvars = makeTfvars();
      vi.mocked(tfvars.getTopLevelSettings).mockRejectedValue(new ConfigurationNotConfiguredError());

      const result = await new IacSettingsController(tfvars).get();

      expect(result).toEqual({ ok: false, code: 'setup_incomplete', message: expect.any(String) });
    });

    it('should return the catch-all code: "error" for any other failure', async () => {
      const tfvars = makeTfvars();
      vi.mocked(tfvars.getTopLevelSettings).mockRejectedValue(new Error('S3 unreachable'));

      const result = await new IacSettingsController(tfvars).get();

      expect(result).toEqual({ ok: false, code: 'error', message: expect.any(String) });
    });
  });

  describe('update', () => {
    /** A minimal, always-valid update payload. */
    const PAYLOAD: UpdateDeploymentSettingsPayload = {
      patch: { dnsTtl: 60 },
      expectedVersionId: 'etag-1',
    };

    it('should delegate to TfvarsService.updateTopLevelSettings with the patch and expectedVersionId', async () => {
      const tfvars = makeTfvars();
      await new IacSettingsController(tfvars).update(PAYLOAD);
      expect(tfvars.updateTopLevelSettings).toHaveBeenCalledWith({ dnsTtl: 60 }, 'etag-1');
    });

    it('should return ok: true with the re-read settings and the write result etag/versionId on success', async () => {
      const tfvars = makeTfvars();
      vi.mocked(tfvars.getTopLevelSettings).mockResolvedValue({
        settings: { ...SETTINGS, dnsTtl: 60 },
        etag: 'etag-2',
      });

      const result = await new IacSettingsController(tfvars).update(PAYLOAD);

      expect(result).toEqual({
        ok: true,
        settings: { ...SETTINGS, dnsTtl: 60 },
        etag: 'etag-2',
        versionId: 'v-2',
      });
    });

    it('should re-read the settings AFTER the write so the returned settings reflect the persisted document', async () => {
      const tfvars = makeTfvars();
      const calls: string[] = [];
      vi.mocked(tfvars.updateTopLevelSettings).mockImplementation(async () => {
        calls.push('update');
        return { etag: 'etag-2', versionId: 'v-2' };
      });
      vi.mocked(tfvars.getTopLevelSettings).mockImplementation(async () => {
        calls.push('get');
        return { settings: SETTINGS, etag: 'etag-2' };
      });

      await new IacSettingsController(tfvars).update(PAYLOAD);

      expect(calls).toEqual(['update', 'get']);
    });

    it('should never call TfvarsService.updateTopLevelSettings when the patch fails validation', async () => {
      const tfvars = makeTfvars();
      const result = await new IacSettingsController(tfvars).update({ patch: { hostedZoneName: '' } });

      expect(result).toEqual({
        ok: false,
        code: 'validation',
        issues: [{ path: 'hostedZoneName', message: 'Must not be empty.' }],
      });
      expect(tfvars.updateTopLevelSettings).not.toHaveBeenCalled();
    });

    it('should return code: "conflict" with both etags on OptimisticLockError', async () => {
      const tfvars = makeTfvars();
      vi.mocked(tfvars.updateTopLevelSettings).mockRejectedValue(new OptimisticLockError('etag-1', 'etag-current'));

      const result = await new IacSettingsController(tfvars).update(PAYLOAD);

      expect(result).toEqual({
        ok: false,
        code: 'conflict',
        expectedVersionId: 'etag-1',
        currentVersionId: 'etag-current',
        message: expect.any(String),
      });
    });

    it('should return code: "setup_incomplete" when no configuration bucket is configured', async () => {
      const tfvars = makeTfvars();
      vi.mocked(tfvars.updateTopLevelSettings).mockRejectedValue(new ConfigurationNotConfiguredError());

      const result = await new IacSettingsController(tfvars).update(PAYLOAD);

      expect(result).toEqual({ ok: false, code: 'setup_incomplete', message: expect.any(String) });
    });

    it('should return the catch-all code: "error" for any other failure', async () => {
      const tfvars = makeTfvars();
      vi.mocked(tfvars.updateTopLevelSettings).mockRejectedValue(new Error('malformed config JSON'));

      const result = await new IacSettingsController(tfvars).update(PAYLOAD);

      expect(result).toEqual({ ok: false, code: 'error', message: expect.any(String) });
    });
  });
});
