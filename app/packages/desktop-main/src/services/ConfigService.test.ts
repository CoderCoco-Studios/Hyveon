import 'reflect-metadata';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import path from 'path';

vi.mock('fs', () => ({
  readFileSync: vi.fn(),
  writeFileSync: vi.fn(),
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

import { readFileSync, writeFileSync, existsSync } from 'fs';
import { ConfigService } from './ConfigService.js';
import { ElectronStoreService } from './ElectronStoreService.js';
import { SafeStorageService } from './SafeStorageService.js';
import type { PulumiService } from './PulumiService.js';
import type { StackOutputs } from '@hyveon/shared';

/**
 * Minimal `PulumiService` stub — `ConfigService`'s own tests never exercise
 * `getStackOutputs()`'s delegation to the real Pulumi stack-outputs read
 * (that's covered by `PulumiService`'s own tests), so this always resolves
 * `null`, matching "nothing deployed".
 */
function makePulumiService(): PulumiService {
  return { getStackOutputs: vi.fn().mockResolvedValue(null) } as unknown as PulumiService;
}

/** Strongly-typed mock handles for the `fs` module. */
const mockExists = vi.mocked(existsSync);
const mockRead = vi.mocked(readFileSync);
const mockWrite = vi.mocked(writeFileSync);

/**
 * Builds a real `ElectronStoreService` (outside Electron, so it's backed by
 * an in-memory `Map` rather than a real on-disk store — no mocking needed)
 * with `bootstrap.configurationBucket` pre-seeded when `configurationBucket`
 * is supplied, mirroring what the First-Run Wizard's bootstrap step would
 * have persisted. Used to construct `ConfigService`, which reads this value
 * via `getConfigurationBucket()`.
 */
function makeElectronStore(configurationBucket?: string): ElectronStoreService {
  const store = new ElectronStoreService(new SafeStorageService());
  if (configurationBucket !== undefined) {
    store.set('bootstrap', { stateBucket: '', configurationBucket });
  }
  return store;
}

/**
 * Test-only subclass that re-exposes `ConfigService`'s protected
 * environment-probing methods as public members so `vi.spyOn` can target
 * them directly, without resorting to `as unknown as` double assertions.
 */
class TestableConfigService extends ConfigService {
  public override readIsPackaged(): boolean {
    return super.readIsPackaged();
  }

  public override readResourcesPath(): string | undefined {
    return super.readResourcesPath();
  }

  public override readUserDataPath(): string | null {
    return super.readUserDataPath();
  }
}

describe('ConfigService', () => {
  /** Fresh instance per test; each has its own in-memory stack-outputs cache. */
  let service: ConfigService;

  beforeEach(() => {
    service = new ConfigService(makeElectronStore(), makePulumiService());
  });

  describe('getStackOutputs', () => {
    it('should delegate to PulumiService.getStackOutputs and return its resolved value', async () => {
      const pulumi = makePulumiService();
      const outputs = { awsRegion: 'us-west-2' } as StackOutputs;
      vi.mocked(pulumi.getStackOutputs).mockResolvedValue(outputs);
      const svc = new ConfigService(makeElectronStore(), pulumi);

      await expect(svc.getStackOutputs()).resolves.toBe(outputs);
    });

    it('should return null (never throw) when PulumiService reports nothing deployed', async () => {
      const pulumi = makePulumiService();
      vi.mocked(pulumi.getStackOutputs).mockResolvedValue(null);
      const svc = new ConfigService(makeElectronStore(), pulumi);

      await expect(svc.getStackOutputs()).resolves.toBeNull();
    });

    it('should only call PulumiService.getStackOutputs once across concurrent and repeated calls (cached)', async () => {
      const pulumi = makePulumiService();
      const outputs = { awsRegion: 'us-west-2' } as StackOutputs;
      vi.mocked(pulumi.getStackOutputs).mockResolvedValue(outputs);
      const svc = new ConfigService(makeElectronStore(), pulumi);

      const [a, b] = await Promise.all([svc.getStackOutputs(), svc.getStackOutputs()]);
      await svc.getStackOutputs();

      expect(a).toBe(outputs);
      expect(b).toBe(outputs);
      expect(pulumi.getStackOutputs).toHaveBeenCalledOnce();
    });

    it('should re-call PulumiService.getStackOutputs after invalidateCache', async () => {
      const pulumi = makePulumiService();
      vi.mocked(pulumi.getStackOutputs).mockResolvedValue(null);
      const svc = new ConfigService(makeElectronStore(), pulumi);

      await svc.getStackOutputs();
      svc.invalidateCache();
      await svc.getStackOutputs();

      expect(pulumi.getStackOutputs).toHaveBeenCalledTimes(2);
    });

    it('should not cache a rejected PulumiService.getStackOutputs call, so a subsequent call retries', async () => {
      const pulumi = makePulumiService();
      vi.mocked(pulumi.getStackOutputs)
        .mockRejectedValueOnce(new Error('transient AWS failure'))
        .mockResolvedValueOnce({ awsRegion: 'us-west-2' } as StackOutputs);
      const svc = new ConfigService(makeElectronStore(), pulumi);

      await expect(svc.getStackOutputs()).rejects.toThrow('transient AWS failure');
      await expect(svc.getStackOutputs()).resolves.toEqual({ awsRegion: 'us-west-2' });
      expect(pulumi.getStackOutputs).toHaveBeenCalledTimes(2);
    });

    describe('null-result TTL (self-healing after a transient failure degraded to null)', () => {
      afterEach(() => {
        vi.useRealTimers();
      });

      it('should serve a cached null without re-calling PulumiService before the TTL elapses', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-07-30T00:00:00.000Z'));
        const pulumi = makePulumiService();
        vi.mocked(pulumi.getStackOutputs).mockResolvedValue(null);
        const svc = new ConfigService(makeElectronStore(), pulumi);

        await svc.getStackOutputs();
        vi.setSystemTime(new Date('2026-07-30T00:00:19.999Z')); // just under the 20s TTL
        await expect(svc.getStackOutputs()).resolves.toBeNull();

        expect(pulumi.getStackOutputs).toHaveBeenCalledOnce();
      });

      it('should re-call PulumiService.getStackOutputs once a cached null has expired, without requiring invalidateCache', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-07-30T00:00:00.000Z'));
        const pulumi = makePulumiService();
        vi.mocked(pulumi.getStackOutputs).mockResolvedValue(null);
        const svc = new ConfigService(makeElectronStore(), pulumi);

        await svc.getStackOutputs();
        vi.setSystemTime(new Date('2026-07-30T00:00:20.001Z')); // just past the 20s TTL
        await svc.getStackOutputs();

        expect(pulumi.getStackOutputs).toHaveBeenCalledTimes(2);
      });

      it('should recover a real StackOutputs value once the transient failure that produced the cached null clears', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-07-30T00:00:00.000Z'));
        const pulumi = makePulumiService();
        const outputs = { awsRegion: 'us-west-2' } as StackOutputs;
        vi.mocked(pulumi.getStackOutputs).mockResolvedValueOnce(null).mockResolvedValueOnce(outputs);
        const svc = new ConfigService(makeElectronStore(), pulumi);

        await expect(svc.getStackOutputs()).resolves.toBeNull();
        vi.setSystemTime(new Date('2026-07-30T00:00:20.001Z'));
        await expect(svc.getStackOutputs()).resolves.toBe(outputs);
      });

      it('should NOT apply the null TTL to a resolved StackOutputs value — it stays cached indefinitely until invalidateCache', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-07-30T00:00:00.000Z'));
        const pulumi = makePulumiService();
        const outputs = { awsRegion: 'us-west-2' } as StackOutputs;
        vi.mocked(pulumi.getStackOutputs).mockResolvedValue(outputs);
        const svc = new ConfigService(makeElectronStore(), pulumi);

        await svc.getStackOutputs();
        vi.setSystemTime(new Date('2026-07-30T01:00:00.000Z')); // 1 hour later, well past the null TTL
        await expect(svc.getStackOutputs()).resolves.toBe(outputs);

        expect(pulumi.getStackOutputs).toHaveBeenCalledOnce();
      });

      it('should coalesce concurrent calls onto a single refetch when the cached null has just expired', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-07-30T00:00:00.000Z'));
        const pulumi = makePulumiService();
        vi.mocked(pulumi.getStackOutputs).mockResolvedValue(null);
        const svc = new ConfigService(makeElectronStore(), pulumi);

        await svc.getStackOutputs();
        vi.setSystemTime(new Date('2026-07-30T00:00:20.001Z'));

        // Both calls observe the same expired cache entry synchronously
        // (before either's refetch has a chance to settle and update the
        // null-TTL bookkeeping) — they must coalesce onto one underlying
        // call, not each kick off their own.
        await Promise.all([svc.getStackOutputs(), svc.getStackOutputs()]);

        expect(pulumi.getStackOutputs).toHaveBeenCalledTimes(2); // 1 initial + 1 coalesced refetch
      });
    });
  });

  describe('getRegion', () => {
    it('should use aws.region from the electron store when available', () => {
      const store = makeElectronStore();
      store.set('aws', { region: 'ap-south-1' });
      const svc = new ConfigService(store, makePulumiService());
      expect(svc.getRegion()).toBe('ap-south-1');
    });

    it('should fall back to readEnvRegion when no aws.region is stored', () => {
      vi.spyOn(service, 'readEnvRegion').mockReturnValue('eu-west-3');
      expect(service.getRegion()).toBe('eu-west-3');
    });

    it('should fall back to us-east-1 when no aws.region is stored and no env region', () => {
      vi.spyOn(service, 'readEnvRegion').mockReturnValue(undefined);
      expect(service.getRegion()).toBe('us-east-1');
    });
  });

  describe('getActiveCloud', () => {
    it('should return aws', () => {
      expect(service.getActiveCloud()).toBe('aws');
    });
  });

  describe('getConfig', () => {
    it('should return defaults when the config file is missing', () => {
      mockExists.mockReturnValue(false);
      expect(service.getConfig()).toEqual({
        watchdog_interval_minutes: 15,
        watchdog_idle_checks: 4,
        watchdog_min_packets: 100,
      });
    });

    it('should merge saved config over defaults', () => {
      mockExists.mockReturnValue(true);
      mockRead.mockReturnValue(
        JSON.stringify({ watchdog_idle_checks: 10, watchdog_min_packets: 250 }),
      );
      expect(service.getConfig()).toEqual({
        watchdog_interval_minutes: 15,
        watchdog_idle_checks: 10,
        watchdog_min_packets: 250,
      });
    });

    it('should return defaults when the config file is malformed', () => {
      mockExists.mockReturnValue(true);
      mockRead.mockReturnValue('{bad json');
      const config = service.getConfig();
      expect(config.watchdog_interval_minutes).toBe(15);
      expect(config.watchdog_idle_checks).toBe(4);
      expect(config.watchdog_min_packets).toBe(100);
    });
  });

  describe('saveConfig', () => {
    it('should write JSON-stringified config to disk', () => {
      const config = {
        watchdog_interval_minutes: 30,
        watchdog_idle_checks: 6,
        watchdog_min_packets: 500,
      };
      service.saveConfig(config);
      expect(mockWrite).toHaveBeenCalledTimes(1);
      const [, payload] = mockWrite.mock.calls[0]!;
      expect(JSON.parse(payload as string)).toEqual(config);
    });
  });

  describe('readEnvTfvarsCacheTtlMs', () => {
    afterEach(() => {
      delete process.env['TFVARS_CACHE_TTL_MS'];
    });

    it('should default to 30000 when TFVARS_CACHE_TTL_MS is unset', () => {
      delete process.env['TFVARS_CACHE_TTL_MS'];
      expect(service.readEnvTfvarsCacheTtlMs()).toBe(30000);
    });

    it('should default to 30000 when TFVARS_CACHE_TTL_MS is empty', () => {
      process.env['TFVARS_CACHE_TTL_MS'] = '';
      expect(service.readEnvTfvarsCacheTtlMs()).toBe(30000);
    });

    it('should parse a valid TFVARS_CACHE_TTL_MS value', () => {
      process.env['TFVARS_CACHE_TTL_MS'] = '60000';
      expect(service.readEnvTfvarsCacheTtlMs()).toBe(60000);
    });

    it('should default to 30000 and warn when TFVARS_CACHE_TTL_MS is not a number', () => {
      process.env['TFVARS_CACHE_TTL_MS'] = 'not-a-number';
      expect(service.readEnvTfvarsCacheTtlMs()).toBe(30000);
    });

    it('should default to 30000 when TFVARS_CACHE_TTL_MS is negative', () => {
      process.env['TFVARS_CACHE_TTL_MS'] = '-1';
      expect(service.readEnvTfvarsCacheTtlMs()).toBe(30000);
    });

    it('should default to 30000 when TFVARS_CACHE_TTL_MS is zero', () => {
      process.env['TFVARS_CACHE_TTL_MS'] = '0';
      expect(service.readEnvTfvarsCacheTtlMs()).toBe(30000);
    });
  });

  describe('path resolution', () => {
    /** Subclass instance exposing protected internals for direct `vi.spyOn` stubbing. */
    let testableService: TestableConfigService;

    beforeEach(() => {
      testableService = new TestableConfigService(makeElectronStore(), makePulumiService());
    });

    afterEach(() => {
      vi.restoreAllMocks();
      delete process.env['SERVER_CONFIG_PATH'];
      delete process.env['HYVEON_TFVARS_BUCKET'];
    });

    it('should return packaged server_config path when readIsPackaged returns true', () => {
      vi.spyOn(testableService, 'readIsPackaged').mockReturnValue(true);
      vi.spyOn(testableService, 'readUserDataPath').mockReturnValue('/fake/userData');
      expect(testableService.getServerConfigPath()).toBe(
        path.join('/fake/userData', 'server_config.json'),
      );
    });

    it('should return the repo-relative fallback when readIsPackaged returns false', () => {
      vi.spyOn(testableService, 'readIsPackaged').mockReturnValue(false);
      const result = testableService.getServerConfigPath();
      expect(result).toMatch(/server_config\.json$/);
      expect(path.isAbsolute(result)).toBe(true);
    });

    it('should return the SERVER_CONFIG_PATH env var verbatim when set, without consulting readIsPackaged', () => {
      process.env['SERVER_CONFIG_PATH'] = '/custom/server_config.json';
      const isPackagedSpy = vi.spyOn(testableService, 'readIsPackaged');
      expect(testableService.getServerConfigPath()).toBe('/custom/server_config.json');
      expect(isPackagedSpy).not.toHaveBeenCalled();
    });

    it('should return the repo-relative fallback when packaged but readUserDataPath returns null', () => {
      vi.spyOn(testableService, 'readIsPackaged').mockReturnValue(true);
      vi.spyOn(testableService, 'readUserDataPath').mockReturnValue(null);
      const result = testableService.getServerConfigPath();
      expect(result).toMatch(/server_config\.json$/);
      expect(result).not.toContain('userData');
    });

    describe('outside an Electron process', () => {
      it('should return false from readIsPackaged when process.versions.electron is unset', () => {
        expect(testableService.readIsPackaged()).toBe(false);
      });

      it('should return null from readUserDataPath when process.versions.electron is unset', () => {
        expect(testableService.readUserDataPath()).toBeNull();
      });
    });

    describe('with process.versions.electron set but the electron module unusable (matches a plain Node test process)', () => {
      afterEach(() => {
        delete (process.versions as Record<string, string | undefined>)['electron'];
      });

      it('should return false from readIsPackaged when requiring "electron" does not yield a usable app object', () => {
        (process.versions as Record<string, string | undefined>)['electron'] = '30.0.0';
        expect(testableService.readIsPackaged()).toBe(false);
      });

      it('should return null from readUserDataPath when requiring "electron" does not yield a usable app object', () => {
        (process.versions as Record<string, string | undefined>)['electron'] = '30.0.0';
        expect(testableService.readUserDataPath()).toBeNull();
      });
    });

    it('should return the HYVEON_TFVARS_BUCKET env var value when set, even when a configuration bucket is also stored', () => {
      process.env['HYVEON_TFVARS_BUCKET'] = 'my-project-tfvars';
      const configuredService = new ConfigService(makeElectronStore('stored-bucket'), makePulumiService());
      expect(configuredService.getConfigurationBucket()).toBe('my-project-tfvars');
    });

    it('should return the configured bootstrap.configurationBucket from ElectronStoreService when HYVEON_TFVARS_BUCKET is unset', () => {
      const configuredService = new ConfigService(makeElectronStore('operator-configured-bucket'), makePulumiService());
      expect(configuredService.getConfigurationBucket()).toBe('operator-configured-bucket');
    });

    it('should return null when neither the env var nor a stored bootstrap.configurationBucket resolve', () => {
      expect(service.getConfigurationBucket()).toBeNull();
    });

    it('should not touch the filesystem when resolving the configuration bucket', () => {
      const configuredService = new ConfigService(makeElectronStore('operator-configured-bucket'), makePulumiService());
      configuredService.getConfigurationBucket();
      service.getConfigurationBucket();

      expect(mockExists).not.toHaveBeenCalled();
      expect(mockRead).not.toHaveBeenCalled();
    });
  });
});
