import 'reflect-metadata';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import path from 'path';
import os from 'os';

vi.mock('fs', () => ({
  readFileSync: vi.fn(),
  writeFileSync: vi.fn(),
  existsSync: vi.fn(),
  cpSync: vi.fn(),
  renameSync: vi.fn(),
  rmSync: vi.fn(),
}));

vi.mock('../logger.js', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

import { readFileSync, writeFileSync, existsSync, cpSync, renameSync, rmSync } from 'fs';
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
const mockCp = vi.mocked(cpSync);
const mockRename = vi.mocked(renameSync);
const mockRm = vi.mocked(rmSync);

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
    store.set('bootstrap', { stateBucket: '', lockTable: '', configurationBucket });
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

/**
 * Build a Terraform state file payload from an `outputs` map.
 * Mirrors the shape that `terraform.tfstate` uses on disk.
 */
function makeState(outputs: Record<string, { value: unknown }>): string {
  return JSON.stringify({ outputs });
}

describe('ConfigService', () => {
  /** Fresh instance per test; each has its own in-memory tfstate cache. */
  let service: ConfigService;

  beforeEach(() => {
    service = new ConfigService(makeElectronStore(), makePulumiService());
  });

  describe('getTfOutputs', () => {
    it('should return null when the state file is absent', () => {
      mockExists.mockReturnValue(false);
      expect(service.getTfOutputs()).toBeNull();
    });

    it('should return null when the state file contains the literal null', () => {
      mockExists.mockReturnValue(true);
      mockRead.mockReturnValue('null');
      expect(service.getTfOutputs()).toBeNull();
    });

    it('should return null when the state file has no outputs key', () => {
      mockExists.mockReturnValue(true);
      mockRead.mockReturnValue('{}');
      expect(service.getTfOutputs()).toBeNull();
    });

    it('should parse outputs and fill defaults for missing keys', () => {
      mockExists.mockReturnValue(true);
      mockRead.mockReturnValue(
        makeState({
          aws_region: { value: 'us-west-2' },
          ecs_cluster_name: { value: 'my-cluster' },
          game_names: { value: ['minecraft', 'factorio'] },
        }),
      );

      const outputs = service.getTfOutputs();
      expect(outputs).not.toBeNull();
      expect(outputs!.aws_region).toBe('us-west-2');
      expect(outputs!.ecs_cluster_name).toBe('my-cluster');
      expect(outputs!.game_names).toEqual(['minecraft', 'factorio']);
      expect(outputs!.subnet_ids).toBe('');
      expect(outputs!.efs_access_points).toEqual({});
      expect(outputs!.applied_game_servers).toBeNull();
    });

    it('should parse applied_game_servers when the output is present', () => {
      mockExists.mockReturnValue(true);
      const appliedGameServers = {
        minecraft: {
          image: 'itzg/minecraft-server',
          cpu: 1024,
          memory: 2048,
          ports: [{ container: 25565, protocol: 'tcp' }],
          volumes: [{ name: 'data', container_path: '/data' }],
        },
      };
      mockRead.mockReturnValue(
        makeState({
          applied_game_servers: { value: appliedGameServers },
        }),
      );

      const outputs = service.getTfOutputs();
      expect(outputs!.applied_game_servers).toEqual(appliedGameServers);
    });

    it('should default applied_game_servers to null when the output is missing', () => {
      mockExists.mockReturnValue(true);
      mockRead.mockReturnValue(makeState({ aws_region: { value: 'us-west-2' } }));

      expect(service.getTfOutputs()!.applied_game_servers).toBeNull();
    });

    it('should apply the fallback aws_region when outputs omit it', () => {
      mockExists.mockReturnValue(true);
      // A non-empty outputs map that simply doesn't include `aws_region` —
      // distinct from an *empty* `{}` map, which is now treated as "infra
      // not yet deployed" and short-circuits to `null` before defaults are
      // ever filled in.
      mockRead.mockReturnValue(makeState({ ecs_cluster_name: { value: 'my-cluster' } }));
      expect(service.getTfOutputs()!.aws_region).toBe('us-east-1');
    });

    it('should cache parsed outputs across calls', () => {
      mockExists.mockReturnValue(true);
      mockRead.mockReturnValue(makeState({ aws_region: { value: 'eu-central-1' } }));

      service.getTfOutputs();
      service.getTfOutputs();

      expect(mockRead).toHaveBeenCalledTimes(1);
    });

    it('should cache a null result so an undeployed stack is not re-read on every call', () => {
      mockExists.mockReturnValue(false);

      expect(service.getTfOutputs()).toBeNull();
      expect(service.getTfOutputs()).toBeNull();

      expect(mockExists).toHaveBeenCalledTimes(1);
    });

    it('should re-read after invalidateCache when the previous result was null', () => {
      mockExists.mockReturnValue(false);
      expect(service.getTfOutputs()).toBeNull();

      service.invalidateCache();
      mockExists.mockReturnValue(true);
      mockRead.mockReturnValue(makeState({ aws_region: { value: 'eu-west-1' } }));

      expect(service.getTfOutputs()!.aws_region).toBe('eu-west-1');
    });

    it('should force a re-read after invalidateCache', () => {
      mockExists.mockReturnValue(true);
      mockRead.mockReturnValue(makeState({ aws_region: { value: 'a' } }));

      service.getTfOutputs();
      service.invalidateCache();
      mockRead.mockReturnValue(makeState({ aws_region: { value: 'b' } }));

      expect(service.getTfOutputs()!.aws_region).toBe('b');
      expect(mockRead).toHaveBeenCalledTimes(2);
    });

    it('should return null when the state file contains invalid JSON', () => {
      mockExists.mockReturnValue(true);
      mockRead.mockReturnValue('not-json{');
      expect(service.getTfOutputs()).toBeNull();
    });

    it('should parse audit_table_name when the output is present', () => {
      mockExists.mockReturnValue(true);
      mockRead.mockReturnValue(
        makeState({
          audit_table_name: { value: 'hyveon-audit' },
        }),
      );

      expect(service.getTfOutputs()!.audit_table_name).toBe('hyveon-audit');
    });

    it('should default audit_table_name to an empty string when the output is missing', () => {
      mockExists.mockReturnValue(true);
      mockRead.mockReturnValue(makeState({ aws_region: { value: 'us-west-2' } }));

      expect(service.getTfOutputs()!.audit_table_name).toBe('');
    });

    it('should parse runs_table_name when the output is present', () => {
      mockExists.mockReturnValue(true);
      mockRead.mockReturnValue(
        makeState({
          runs_table_name: { value: 'hyveon-runs' },
        }),
      );

      expect(service.getTfOutputs()!.runs_table_name).toBe('hyveon-runs');
    });

    it('should default runs_table_name to an empty string when the output is missing', () => {
      mockExists.mockReturnValue(true);
      mockRead.mockReturnValue(makeState({ aws_region: { value: 'us-west-2' } }));

      expect(service.getTfOutputs()!.runs_table_name).toBe('');
    });
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
      testableService = new TestableConfigService(makeElectronStore());
    });

    afterEach(() => {
      vi.restoreAllMocks();
      delete process.env['TF_STATE_PATH'];
      delete process.env['SERVER_CONFIG_PATH'];
      delete process.env['HYVEON_TFVARS_BUCKET'];
      delete process.env['TF_DIR'];
      delete process.env['RUNS_DIR_PATH'];
    });

    it('should return packaged tfstate path when readIsPackaged returns true', () => {
      vi.spyOn(testableService, 'readIsPackaged').mockReturnValue(true);
      vi.spyOn(testableService, 'readResourcesPath').mockReturnValue('/fake/resources');
      expect(testableService.getTfStatePath()).toBe(
        path.join('/fake/resources', 'terraform', 'aws', 'terraform.tfstate'),
      );
    });

    it('should return the repo-relative fallback when readIsPackaged returns false', () => {
      vi.spyOn(testableService, 'readIsPackaged').mockReturnValue(false);
      const result = testableService.getTfStatePath();
      expect(result).toMatch(/terraform[/\\]terraform\.tfstate$/);
      expect(path.isAbsolute(result)).toBe(true);
    });

    it('should return the TF_STATE_PATH env var value when set', () => {
      process.env['TF_STATE_PATH'] = '/custom/state/terraform.tfstate';
      expect(service.getTfStatePath()).toBe('/custom/state/terraform.tfstate');
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

    it('should return the TF_DIR env var value when set', () => {
      process.env['TF_DIR'] = '/custom/terraform';
      expect(service.getTerraformDir()).toBe('/custom/terraform');
    });

    it('should seed and return the writable userData terraform dir when packaged and userData is available', () => {
      vi.spyOn(testableService, 'readIsPackaged').mockReturnValue(true);
      vi.spyOn(testableService, 'readResourcesPath').mockReturnValue('/fake/resources');
      vi.spyOn(testableService, 'readUserDataPath').mockReturnValue('/fake/userData');
      mockExists.mockReturnValue(false);

      const result = testableService.getTerraformDir();
      const writableDir = path.join('/fake/userData', 'terraform');

      expect(result).toBe(writableDir);
      // Seeding stages the copy into a sibling directory and renames it into
      // place, so `writableDir` never exists in a partially-copied state.
      expect(mockCp).toHaveBeenCalledTimes(1);
      const [cpFrom, cpTo] = mockCp.mock.calls[0];
      expect(cpFrom).toBe(path.join('/fake/resources', 'terraform'));
      expect(String(cpTo).startsWith(`${writableDir}.staging-`)).toBe(true);
      expect(mockRename).toHaveBeenCalledWith(cpTo, writableDir);
    });

    it('should fall back to the packaged resourcesPath terraform dir and not treat writableDir as seeded when cpSync fails', () => {
      vi.spyOn(testableService, 'readIsPackaged').mockReturnValue(true);
      vi.spyOn(testableService, 'readResourcesPath').mockReturnValue('/fake/resources');
      vi.spyOn(testableService, 'readUserDataPath').mockReturnValue('/fake/userData');
      const writableDir = path.join('/fake/userData', 'terraform');
      // Only the final writableDir check should report "exists" as false —
      // the staging dir cleanup check runs after the throw, so report it as
      // present so we can assert the cleanup path (rmSync) runs too.
      mockExists.mockImplementation((p) => p !== writableDir);
      mockCp.mockImplementation(() => {
        throw new Error('ENOSPC: no space left on device');
      });

      const result = testableService.getTerraformDir();

      expect(result).toBe(path.join('/fake/resources', 'terraform'));
      expect(mockRename).not.toHaveBeenCalled();
      expect(mockRm).toHaveBeenCalledTimes(1);
      const [rmPath] = mockRm.mock.calls[0];
      expect(String(rmPath).startsWith(`${writableDir}.staging-`)).toBe(true);

      // A subsequent call must retry seeding rather than treating the failed
      // attempt as "already seeded" — `writableDir` was never created.
      mockCp.mockClear();
      testableService.getTerraformDir();
      expect(mockCp).toHaveBeenCalledTimes(1);
    });

    it('should not re-seed the writable userData terraform dir when it already exists', () => {
      vi.spyOn(testableService, 'readIsPackaged').mockReturnValue(true);
      vi.spyOn(testableService, 'readResourcesPath').mockReturnValue('/fake/resources');
      vi.spyOn(testableService, 'readUserDataPath').mockReturnValue('/fake/userData');
      mockExists.mockReturnValue(true);

      const result = testableService.getTerraformDir();

      expect(result).toBe(path.join('/fake/userData', 'terraform'));
      expect(mockCp).not.toHaveBeenCalled();
    });

    it('should fall back to the packaged resourcesPath terraform dir when userData is unavailable', () => {
      vi.spyOn(testableService, 'readIsPackaged').mockReturnValue(true);
      vi.spyOn(testableService, 'readResourcesPath').mockReturnValue('/fake/resources');
      vi.spyOn(testableService, 'readUserDataPath').mockReturnValue(null);

      expect(testableService.getTerraformDir()).toBe(path.join('/fake/resources', 'terraform'));
      expect(mockCp).not.toHaveBeenCalled();
    });

    it('should return the repo-root terraform dir fallback when readIsPackaged returns false', () => {
      vi.spyOn(testableService, 'readIsPackaged').mockReturnValue(false);
      const result = testableService.getTerraformDir();
      expect(result).toMatch(/terraform$/);
      expect(path.isAbsolute(result)).toBe(true);
    });

    describe('getRunsDir', () => {
      it('should return the RUNS_DIR_PATH env var value when set', () => {
        process.env['RUNS_DIR_PATH'] = '/custom/runs';
        expect(service.getRunsDir()).toBe('/custom/runs');
      });

      it('should resolve a relative RUNS_DIR_PATH env var against process.cwd() rather than getTerraformDir()', () => {
        process.env['RUNS_DIR_PATH'] = 'relative/runs';
        const result = service.getRunsDir();
        expect(result).toBe(path.resolve('relative/runs'));
        expect(path.isAbsolute(result)).toBe(true);
      });

      it('should return <userData>/runs when the env var is unset and userData is available', () => {
        vi.spyOn(testableService, 'readUserDataPath').mockReturnValue('/fake/userData');
        expect(testableService.getRunsDir()).toBe(path.join('/fake/userData', 'runs'));
      });

      it('should return the OS tmpdir fallback when the env var is unset and userData is unavailable', () => {
        vi.spyOn(testableService, 'readUserDataPath').mockReturnValue(null);
        const result = testableService.getRunsDir();
        expect(result).toBe(path.join(os.tmpdir(), 'hyveon-runs'));
        expect(path.isAbsolute(result)).toBe(true);
      });
    });
  });
});
