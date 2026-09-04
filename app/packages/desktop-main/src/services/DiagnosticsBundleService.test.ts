import 'reflect-metadata';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, existsSync, createReadStream, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import unzipper from 'unzipper';
import { DiagnosticsBundleService } from './DiagnosticsBundleService.js';
import type { DiagnosticsService } from './DiagnosticsService.js';
import type { DeploymentConfigService } from './DeploymentConfigService.js';
import type { ConfigService } from './ConfigService.js';
import type { EcsService } from './EcsService.js';
import type { ElectronStoreService } from './ElectronStoreService.js';
import type { StackOutputs } from '@hyveon/shared';
import { stackOutputs } from '../testing/stack-outputs.fixture.js';
import { configServiceStub } from '../testing/config-service.fixture.js';
import { deploymentConfigStub } from '../testing/deployment-config.fixture.js';

vi.mock('../logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

/** Reads every entry of the `.zip` at `path` into a `{ name: content }` map, decoding each entry as UTF-8 text. */
async function readZipEntries(path: string): Promise<Record<string, string>> {
  const entries: Record<string, string> = {};
  await new Promise<void>((resolve, reject) => {
    createReadStream(path)
      .pipe(unzipper.Parse())
      .on('entry', (entry: unzipper.Entry) => {
        const chunks: Buffer[] = [];
        entry.on('data', (chunk: Buffer) => chunks.push(chunk));
        entry.on('end', () => {
          entries[entry.path] = Buffer.concat(chunks).toString('utf-8');
        });
      })
      .on('close', resolve)
      .on('error', reject);
  });
  return entries;
}

function makeDiagnostics(lines: string[] = ['line one', 'line two']): DiagnosticsService {
  return { readTail: vi.fn().mockResolvedValue(lines) } as Partial<DiagnosticsService> as DiagnosticsService;
}

function makeDeploymentConfig(): DeploymentConfigService {
  return deploymentConfigStub(
    { declared: [] },
    {
      getTopLevelSettings: vi.fn().mockResolvedValue({
        settings: {
          projectName: 'hyveon',
          awsRegion: 'us-east-1',
          vpcCidr: '10.0.0.0/16',
          hostedZoneName: 'example.com',
          dnsTtl: 60,
          watchdogIntervalMinutes: 5,
          watchdogIdleChecks: 3,
          watchdogMinPackets: 10,
          auditTableName: 'hyveon-audit',
          runsTableName: 'hyveon-runs',
        },
      }),
    },
  );
}

function makeConfig(outputs: StackOutputs | null = null): ConfigService {
  return configServiceStub({ outputs });
}

function makeEcs(): EcsService {
  return { getStatus: vi.fn().mockResolvedValue({ game: 'minecraft', state: 'running' }) } as Partial<EcsService> as EcsService;
}

function makeStore(enableAutoUpdate: boolean | undefined = false): ElectronStoreService {
  return { get: vi.fn().mockReturnValue(enableAutoUpdate) } as Partial<ElectronStoreService> as ElectronStoreService;
}

let tempDir: string;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'diagnostics-bundle-'));
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

describe('DiagnosticsBundleService.writeBundle', () => {
  it('should write all four sections plus an empty errors.json on full success', async () => {
    const destinationPath = join(tempDir, 'bundle.zip');
    const service = new DiagnosticsBundleService(
      makeDiagnostics(['hello world']),
      makeDeploymentConfig(),
      makeConfig(null),
      makeEcs(),
      makeStore(),
    );

    const result = await service.writeBundle(destinationPath);

    expect(result).toEqual({ path: destinationPath });
    expect(existsSync(destinationPath)).toBe(true);

    const entries = await readZipEntries(destinationPath);
    expect(Object.keys(entries).sort()).toEqual(['aws-snapshot.json', 'config-summary.json', 'errors.json', 'logs.txt', 'metadata.json']);
    expect(entries['logs.txt']).toBe('hello world');
    expect(JSON.parse(entries['errors.json']!)).toEqual([]);
    expect(JSON.parse(entries['config-summary.json']!)).toMatchObject({ projectName: 'hyveon' });
    expect(JSON.parse(entries['metadata.json']!)).toMatchObject({ autoUpdateEnabled: false });
    expect(JSON.parse(entries['aws-snapshot.json']!)).toEqual({ stackOutputs: null, games: [] });
  });

  it('should still write a bundle with the other three sections when the AWS snapshot section fails', async () => {
    const destinationPath = join(tempDir, 'bundle.zip');
    const failingConfig = { getStackOutputs: vi.fn().mockRejectedValue(new Error('no AWS credentials configured')) } as Partial<ConfigService> as ConfigService;
    const service = new DiagnosticsBundleService(makeDiagnostics(), makeDeploymentConfig(), failingConfig, makeEcs(), makeStore());

    const result = await service.writeBundle(destinationPath);

    expect(result).toEqual({ path: destinationPath });
    const entries = await readZipEntries(destinationPath);
    expect(entries['logs.txt']).toBeDefined();
    expect(entries['config-summary.json']).toBeDefined();
    expect(entries['metadata.json']).toBeDefined();
    expect(entries['aws-snapshot.json']).toBeUndefined();

    const errors = JSON.parse(entries['errors.json']!) as Array<{ section: string; message: string }>;
    expect(errors).toEqual([{ section: 'aws', message: 'no AWS credentials configured' }]);
  });

  it('should write a bundle containing only errors.json when every section fails', async () => {
    const destinationPath = join(tempDir, 'bundle.zip');
    const failingDiagnostics = { readTail: vi.fn().mockRejectedValue(new Error('log read failed')) } as Partial<DiagnosticsService> as DiagnosticsService;
    const failingDeploymentConfig = deploymentConfigStub(
      { declared: [] },
      { getTopLevelSettings: vi.fn().mockRejectedValue(new Error('config read failed')) },
    );
    const failingConfig = { getStackOutputs: vi.fn().mockRejectedValue(new Error('aws call failed')) } as Partial<ConfigService> as ConfigService;
    const failingStore = {
      get: vi.fn().mockImplementation(() => {
        throw new Error('metadata failed');
      }),
    } as Partial<ElectronStoreService> as ElectronStoreService;

    const service = new DiagnosticsBundleService(failingDiagnostics, failingDeploymentConfig, failingConfig, makeEcs(), failingStore);

    const result = await service.writeBundle(destinationPath);

    expect(result).toEqual({ path: destinationPath });
    const entries = await readZipEntries(destinationPath);
    expect(Object.keys(entries)).toEqual(['errors.json']);

    const errors = JSON.parse(entries['errors.json']!) as Array<{ section: string; message: string }>;
    expect(errors.map((e) => e.section).sort()).toEqual(['aws', 'config', 'logs', 'metadata']);
    expect(errors.every((e) => typeof e.message === 'string' && e.message.length > 0)).toBe(true);
  });

  it('should scrub secret-shaped log content before writing it into logs.txt', async () => {
    const destinationPath = join(tempDir, 'bundle.zip');
    const service = new DiagnosticsBundleService(
      makeDiagnostics(['using key AKIAABCDEFGHIJKLMNOP today']),
      makeDeploymentConfig(),
      makeConfig(null),
      makeEcs(),
      makeStore(),
    );

    await service.writeBundle(destinationPath);

    const entries = await readZipEntries(destinationPath);
    expect(entries['logs.txt']).not.toContain('AKIAABCDEFGHIJKLMNOP');
  });

  it('should gather a per-game AWS snapshot when stack outputs are present', async () => {
    const destinationPath = join(tempDir, 'bundle.zip');
    const outputs = stackOutputs({
      awsRegion: 'us-east-1',
      ecsClusterName: 'hyveon-cluster',
      domainName: 'example.com',
      gameNames: ['minecraft'],
    });
    const service = new DiagnosticsBundleService(makeDiagnostics(), makeDeploymentConfig(), makeConfig(outputs), makeEcs(), makeStore());

    await service.writeBundle(destinationPath);

    const entries = await readZipEntries(destinationPath);
    const aws = JSON.parse(entries['aws-snapshot.json']!);
    expect(aws.stackOutputs).toEqual({
      awsRegion: outputs.awsRegion,
      ecsClusterName: outputs.ecsClusterName,
      domainName: outputs.domainName,
      gameNames: outputs.gameNames,
    });
    expect(aws.games).toEqual([{ game: 'minecraft', state: 'running' }]);
  });

  it('should not leave a partial file at the destination path when the write fails', async () => {
    // A destination inside a nonexistent directory makes the underlying write fail.
    const destinationPath = join(tempDir, 'nonexistent-subdir', 'bundle.zip');
    const service = new DiagnosticsBundleService(makeDiagnostics(), makeDeploymentConfig(), makeConfig(null), makeEcs(), makeStore());

    await expect(service.writeBundle(destinationPath)).rejects.toThrow();

    expect(existsSync(destinationPath)).toBe(false);
    expect(readdirSync(tempDir)).toEqual([]);
  });

  it('should keep the other game statuses and stackOutputs when one game status lookup rejects', async () => {
    const destinationPath = join(tempDir, 'bundle.zip');
    const outputs = stackOutputs({
      awsRegion: 'us-east-1',
      ecsClusterName: 'hyveon-cluster',
      domainName: 'example.com',
      gameNames: ['minecraft', 'valheim'],
    });
    const partiallyFailingEcs = {
      getStatus: vi.fn().mockImplementation((game: string) =>
        game === 'valheim'
          ? Promise.reject(new Error('ECS DescribeTasks failed'))
          : Promise.resolve({ game, state: 'running' }),
      ),
    } as Partial<EcsService> as EcsService;
    const service = new DiagnosticsBundleService(
      makeDiagnostics(),
      makeDeploymentConfig(),
      makeConfig(outputs),
      partiallyFailingEcs,
      makeStore(),
    );

    const result = await service.writeBundle(destinationPath);

    expect(result).toEqual({ path: destinationPath });
    const entries = await readZipEntries(destinationPath);
    const aws = JSON.parse(entries['aws-snapshot.json']!);
    expect(aws.stackOutputs).toEqual({
      awsRegion: outputs.awsRegion,
      ecsClusterName: outputs.ecsClusterName,
      domainName: outputs.domainName,
      gameNames: outputs.gameNames,
    });
    expect(aws.games).toEqual([
      { game: 'minecraft', state: 'running' },
      { game: 'valheim', state: 'error', message: 'ECS DescribeTasks failed' },
    ]);
    // The AWS section as a whole still succeeds — errors.json stays empty, since the
    // per-game failure is captured inline in aws-snapshot.json instead.
    expect(JSON.parse(entries['errors.json']!)).toEqual([]);
  });
});
