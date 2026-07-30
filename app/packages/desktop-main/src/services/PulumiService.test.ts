/**
 * Unit tests for `PulumiService` (tasks 7.4/7.8/7.9 of `migrate-iac-to-pulumi`):
 * the ported/reshaped error classes, and `getStackOutputs()`'s "never
 * deployed yet degrades to null, never throws" contract.
 *
 * `PulumiWorkspaceService` is stubbed directly (not the underlying Pulumi
 * SDK) — `getStackOutputs()`'s own logic (the three pre-flight short-circuits
 * plus the outputs projection) is what's under test here, not
 * `getOrCreateStack`'s own workspace-construction behaviour, which has its
 * own dedicated test file (`PulumiWorkspaceService.test.ts`).
 */
import 'reflect-metadata';
import { describe, it, expect, vi } from 'vitest';
import type { OutputMap, Stack } from '@pulumi/pulumi/automation/index.js';
import {
  PulumiService,
  PulumiPreviewError,
  PulumiUpError,
  PulumiDestroyError,
  PulumiPartialApplyError,
  StalePlanError,
  TerraformPlanHashError,
  PulumiRunPersistError,
  DestroyNotConfirmedError,
  RollbackTargetNotFoundError,
  RollbackNotApplyRunError,
  RollbackNoConfigVersionError,
  RollbackVersionMissingError,
} from './PulumiService.js';
import { PulumiBackendNotBootstrappedError, type PulumiWorkspaceService } from './PulumiWorkspaceService.js';
import { ElectronStoreService } from './ElectronStoreService.js';
import { SafeStorageService } from './SafeStorageService.js';

/** Builds a real `ElectronStoreService` (in-memory Map outside Electron) with the given fields pre-seeded. */
function makeStore(opts: {
  stateBucket?: string;
  passphrase?: string;
  awsRegion?: string;
} = {}): ElectronStoreService {
  const store = new ElectronStoreService(new SafeStorageService());
  if (opts.stateBucket !== undefined) {
    store.set('bootstrap', { stateBucket: opts.stateBucket, lockTable: '', configurationBucket: '' });
  }
  if (opts.passphrase !== undefined) {
    // Bypass the encrypted accessor pair — presence is checked via the raw
    // `get('pulumi')?.passphrase !== undefined` idiom this dispatch's
    // `getStackOutputs` uses, so a plaintext placeholder is enough; nothing
    // in this file ever calls `getPulumiPassphrase()` to decrypt it.
    store.set('pulumi', { passphrase: opts.passphrase });
  }
  if (opts.awsRegion !== undefined) {
    store.set('aws', { region: opts.awsRegion });
  }
  return store;
}

/** Every field {@link makeStore} needs set for `getStackOutputs()` to reach the Pulumi call. */
const FULLY_CONFIGURED = { stateBucket: 'my-state-bucket', passphrase: 'enc-secret', awsRegion: 'us-east-1' };

/** Builds a `PulumiWorkspaceService` stub whose `getOrCreateStack` resolves to a stack stub wrapping `outputs`. */
function makeWorkspace(outputs: OutputMap | Error): PulumiWorkspaceService {
  const getOrCreateStack = vi.fn().mockImplementation(async () => {
    if (outputs instanceof Error) throw outputs;
    const stack: Partial<Stack> = { outputs: vi.fn().mockResolvedValue(outputs) };
    return stack as Stack;
  });
  return { getOrCreateStack } as unknown as PulumiWorkspaceService;
}

/** Wraps a plain value as a Pulumi `OutputValue`. */
function out(value: unknown) {
  return { value };
}

/** A minimal `OutputMap` covering every `StackOutputs` field, for the happy-path projection test. */
const FULL_OUTPUT_MAP: OutputMap = {
  awsRegion: out('us-west-2'),
  ecsClusterName: out('game-cluster'),
  ecsClusterArn: out('arn:aws:ecs:us-west-2:123:cluster/game-cluster'),
  subnetIds: out(['subnet-a', 'subnet-b']),
  securityGroupId: out('sg-game'),
  fileManagerSecurityGroupId: out('sg-files'),
  efsFileSystemId: out('fs-1'),
  efsAccessPoints: out({ minecraft: 'fsap-1' }),
  domainName: out('example.com'),
  gameNames: out(['minecraft']),
  discordTableName: out('discord-table'),
  auditTableName: out('audit-table'),
  runsTableName: out('runs-table'),
  discordBotTokenSecretArn: out('arn:bot-token'),
  discordPublicKeySecretArn: out('arn:public-key'),
  interactionsInvokeUrl: out('https://invoke.example.com/'),
  discordInteractionsUrl: out('https://discord.example.com/'),
  appliedGameServers: out({ minecraft: { image: 'x', cpu: 1024, memory: 2048, ports: [], volumes: [] } }),
};

describe('PulumiService.getStackOutputs', () => {
  it('should return null without calling PulumiWorkspaceService when no state bucket is bootstrapped', async () => {
    const workspace = makeWorkspace(FULL_OUTPUT_MAP);
    const service = new PulumiService(workspace, makeStore());

    await expect(service.getStackOutputs()).resolves.toBeNull();
    expect(workspace.getOrCreateStack).not.toHaveBeenCalled();
  });

  it('should return null without calling PulumiWorkspaceService when no passphrase is stored (never deployed)', async () => {
    const workspace = makeWorkspace(FULL_OUTPUT_MAP);
    const service = new PulumiService(workspace, makeStore({ stateBucket: 'my-state-bucket', awsRegion: 'us-east-1' }));

    await expect(service.getStackOutputs()).resolves.toBeNull();
    expect(workspace.getOrCreateStack).not.toHaveBeenCalled();
  });

  it('should return null without calling PulumiWorkspaceService when no aws region is stored', async () => {
    const workspace = makeWorkspace(FULL_OUTPUT_MAP);
    const service = new PulumiService(
      workspace,
      makeStore({ stateBucket: 'my-state-bucket', passphrase: 'enc-secret' }),
    );

    await expect(service.getStackOutputs()).resolves.toBeNull();
    expect(workspace.getOrCreateStack).not.toHaveBeenCalled();
  });

  it('should call getOrCreateStack with stackExists/backendReady true and the stored bucket/region once fully configured', async () => {
    const workspace = makeWorkspace(FULL_OUTPUT_MAP);
    const service = new PulumiService(workspace, makeStore(FULLY_CONFIGURED));

    await service.getStackOutputs();

    expect(workspace.getOrCreateStack).toHaveBeenCalledWith(
      expect.objectContaining({
        stateBucket: 'my-state-bucket',
        stateBucketRegion: 'us-east-1',
        backendReady: true,
        stackExists: true,
      }),
    );
  });

  it('should project every StackOutputs field from the resolved OutputMap', async () => {
    const workspace = makeWorkspace(FULL_OUTPUT_MAP);
    const service = new PulumiService(workspace, makeStore(FULLY_CONFIGURED));

    const result = await service.getStackOutputs();

    expect(result).toEqual({
      awsRegion: 'us-west-2',
      ecsClusterName: 'game-cluster',
      ecsClusterArn: 'arn:aws:ecs:us-west-2:123:cluster/game-cluster',
      subnetIds: ['subnet-a', 'subnet-b'],
      securityGroupId: 'sg-game',
      fileManagerSecurityGroupId: 'sg-files',
      efsFileSystemId: 'fs-1',
      efsAccessPoints: { minecraft: 'fsap-1' },
      domainName: 'example.com',
      gameNames: ['minecraft'],
      discordTableName: 'discord-table',
      auditTableName: 'audit-table',
      runsTableName: 'runs-table',
      discordBotTokenSecretArn: 'arn:bot-token',
      discordPublicKeySecretArn: 'arn:public-key',
      interactionsInvokeUrl: 'https://invoke.example.com/',
      discordInteractionsUrl: 'https://discord.example.com/',
      appliedGameServers: { minecraft: { image: 'x', cpu: 1024, memory: 2048, ports: [], volumes: [] } },
    });
  });

  it('should fill per-field defaults for keys absent from the OutputMap', async () => {
    const workspace = makeWorkspace({ gameNames: out(['minecraft']) });
    const service = new PulumiService(workspace, makeStore(FULLY_CONFIGURED));

    const result = await service.getStackOutputs();

    expect(result).toMatchObject({
      awsRegion: 'us-east-1',
      ecsClusterName: '',
      subnetIds: [],
      efsAccessPoints: {},
      interactionsInvokeUrl: null,
      appliedGameServers: null,
      gameNames: ['minecraft'],
    });
  });

  it('should return null when the resolved OutputMap is empty (stack exists but nothing applied yet)', async () => {
    const workspace = makeWorkspace({});
    const service = new PulumiService(workspace, makeStore(FULLY_CONFIGURED));

    await expect(service.getStackOutputs()).resolves.toBeNull();
  });

  it('should return null (not throw) when getOrCreateStack throws PulumiBackendNotBootstrappedError', async () => {
    const workspace = makeWorkspace(new PulumiBackendNotBootstrappedError('my-state-bucket'));
    const service = new PulumiService(workspace, makeStore(FULLY_CONFIGURED));

    await expect(service.getStackOutputs()).resolves.toBeNull();
  });

  it('should propagate any other error thrown by getOrCreateStack unchanged', async () => {
    const workspace = makeWorkspace(new Error('transient AWS failure'));
    const service = new PulumiService(workspace, makeStore(FULLY_CONFIGURED));

    await expect(service.getStackOutputs()).rejects.toThrow('transient AWS failure');
  });

  it('should propagate an error thrown by stack.outputs() itself unchanged', async () => {
    const getOrCreateStack = vi.fn().mockResolvedValue({
      outputs: vi.fn().mockRejectedValue(new Error('S3 read failed')),
    } as unknown as Stack);
    const workspace = { getOrCreateStack } as unknown as PulumiWorkspaceService;
    const service = new PulumiService(workspace, makeStore(FULLY_CONFIGURED));

    await expect(service.getStackOutputs()).rejects.toThrow('S3 read failed');
  });
});

describe('PulumiService error classes', () => {
  it('should construct PulumiPreviewError carrying cause and a descriptive message', () => {
    const cause = new Error('preview command failed');
    const err = new PulumiPreviewError(cause);
    expect(err.name).toBe('PulumiPreviewError');
    expect(err.cause).toBe(cause);
    expect(err.message).toContain('preview command failed');
  });

  it('should construct PulumiUpError carrying cause and a descriptive message', () => {
    const cause = new Error('up command failed');
    const err = new PulumiUpError(cause);
    expect(err.name).toBe('PulumiUpError');
    expect(err.cause).toBe(cause);
    expect(err.message).toContain('up command failed');
  });

  it('should construct PulumiDestroyError carrying cause and a descriptive message', () => {
    const cause = new Error('destroy command failed');
    const err = new PulumiDestroyError(cause);
    expect(err.name).toBe('PulumiDestroyError');
    expect(err.cause).toBe(cause);
    expect(err.message).toContain('destroy command failed');
  });

  it('should construct PulumiPartialApplyError carrying completedSteps and cause', () => {
    const cause = new Error('divergence mid-apply');
    const steps = [{ urn: 'urn:pulumi:...::aws:ecs/cluster:Cluster::main', type: 'aws:ecs/cluster:Cluster', op: 'create' as const }];
    const err = new PulumiPartialApplyError(steps, cause);
    expect(err.name).toBe('PulumiPartialApplyError');
    expect(err.completedSteps).toEqual(steps);
    expect(err.cause).toBe(cause);
    expect(err.message).toContain('1 resource step(s)');
  });

  it('should construct StalePlanError with key/bucket/expected/actual in the message', () => {
    const err = new StalePlanError('config.json', 'my-bucket', 'v1', 'v2');
    expect(err.name).toBe('StalePlanError');
    expect(err.message).toContain('config.json');
    expect(err.message).toContain('my-bucket');
    expect(err.message).toContain('v1');
    expect(err.message).toContain('v2');
  });

  it('should describe a missing actualVersionId in StalePlanError as "missing"', () => {
    const err = new StalePlanError('config.json', 'my-bucket', 'v1', undefined);
    expect(err.message).toContain('missing');
  });

  it('should construct TerraformPlanHashError carrying runId/artifactPath/cause', () => {
    const cause = new Error('ENOENT');
    const err = new TerraformPlanHashError('run-1', '/tmp/plan.json', cause);
    expect(err.name).toBe('TerraformPlanHashError');
    expect(err.runId).toBe('run-1');
    expect(err.artifactPath).toBe('/tmp/plan.json');
    expect(err.cause).toBe(cause);
  });

  it('should construct PulumiRunPersistError describing a successful outcome', () => {
    const cause = new Error('disk full');
    const err = new PulumiRunPersistError('run-1', { kind: 'success' }, cause);
    expect(err.name).toBe('PulumiRunPersistError');
    expect(err.runId).toBe('run-1');
    expect(err.outcome).toEqual({ kind: 'success' });
    expect(err.message).toContain('succeeded');
  });

  it('should construct PulumiRunPersistError describing an aborted outcome', () => {
    const err = new PulumiRunPersistError('run-1', { kind: 'aborted' }, new Error('x'));
    expect(err.message).toContain('aborted');
  });

  it('should construct PulumiRunPersistError describing a failed outcome by its error message', () => {
    const err = new PulumiRunPersistError(
      'run-1',
      { kind: 'failed', error: new Error('pulumi up failed') },
      new Error('disk full'),
    );
    expect(err.message).toContain('pulumi up failed');
  });

  it('should construct DestroyNotConfirmedError with no arguments', () => {
    const err = new DestroyNotConfirmedError();
    expect(err.name).toBe('DestroyNotConfirmedError');
    expect(err.message).toContain('confirmation token');
  });

  it('should construct RollbackTargetNotFoundError carrying applyRunId', () => {
    const err = new RollbackTargetNotFoundError('run-1');
    expect(err.name).toBe('RollbackTargetNotFoundError');
    expect(err.applyRunId).toBe('run-1');
  });

  it('should construct RollbackNotApplyRunError carrying applyRunId and kind', () => {
    const err = new RollbackNotApplyRunError('run-1', 'plan');
    expect(err.name).toBe('RollbackNotApplyRunError');
    expect(err.applyRunId).toBe('run-1');
    expect(err.kind).toBe('plan');
  });

  it('should construct RollbackNoConfigVersionError carrying applyRunId', () => {
    const err = new RollbackNoConfigVersionError('run-1');
    expect(err.name).toBe('RollbackNoConfigVersionError');
    expect(err.applyRunId).toBe('run-1');
  });

  it('should construct RollbackVersionMissingError carrying versionId', () => {
    const err = new RollbackVersionMissingError('v-42');
    expect(err.name).toBe('RollbackVersionMissingError');
    expect(err.versionId).toBe('v-42');
  });
});
