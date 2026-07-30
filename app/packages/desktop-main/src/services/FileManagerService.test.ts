import 'reflect-metadata';
import { describe, it, expect, vi } from 'vitest';
import type { Task } from '@aws-sdk/client-ecs';

vi.mock('../logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { FileManagerService } from './FileManagerService.js';
import type { ConfigService } from './ConfigService.js';
import type { EcsService } from './EcsService.js';
import type { Ec2Service } from './Ec2Service.js';
import type { StackOutputs } from '@hyveon/shared';

/**
 * A canonical set of stack outputs used by most tests. Individual tests
 * spread over this to tweak specific fields (e.g. clearing EFS access points).
 */
const DEFAULT_OUTPUTS: StackOutputs = {
  awsRegion: 'us-east-1',
  ecsClusterName: 'game-cluster',
  ecsClusterArn: 'arn:...',
  subnetIds: ['subnet-a', 'subnet-b'],
  securityGroupId: 'sg-game',
  fileManagerSecurityGroupId: 'sg-files',
  efsFileSystemId: 'fs-1',
  efsAccessPoints: { minecraft: 'fsap-mc' },
  domainName: 'example.com',
  gameNames: ['minecraft'],
  discordTableName: 'discord-table',
  auditTableName: 'audit-table',
  runsTableName: 'runs-table',
  discordBotTokenSecretArn: 'arn:aws:secretsmanager:us-east-1:123:secret:bot-token',
  discordPublicKeySecretArn: 'arn:aws:secretsmanager:us-east-1:123:secret:public-key',
  interactionsInvokeUrl: null,
  discordInteractionsUrl: null,
  appliedGameServers: null,
};

/**
 * Subset of EcsService that FileManagerService actually calls. Tests create
 * instances of this shape and cast once to `EcsService`, which keeps the
 * `vi.fn()` return types intact for assertions like `.mock.calls[0]`.
 */
type EcsStub = Pick<
  EcsService,
  | 'listTasksByStartedBy'
  | 'extractEniId'
  | 'getTaskDefinition'
  | 'registerTaskDefinition'
  | 'runTask'
  | 'stopTask'
>;

/**
 * Build a minimal ConfigService stub. Pass `null` to simulate "terraform
 * apply hasn't been run yet".
 */
function makeConfig(outputs: StackOutputs | null = DEFAULT_OUTPUTS): ConfigService {
  const stub: Partial<ConfigService> = {
    getStackOutputs: async () => outputs,
    getRegion: () => 'us-east-1',
  };
  return stub as ConfigService;
}

/**
 * Build an EcsService stub with sensible "happy path" defaults, plus the
 * ability to override specific methods per test. Returns both the stub and
 * an EcsService-typed alias so we can hand the alias to the SUT while still
 * making assertions against the stub's `vi.fn()` handles.
 */
function makeEcs(overrides: Partial<EcsStub> = {}): { stub: EcsStub; service: EcsService } {
  const stub: EcsStub = {
    listTasksByStartedBy: vi.fn().mockResolvedValue([]),
    extractEniId: vi.fn().mockReturnValue(null),
    getTaskDefinition: vi.fn().mockResolvedValue({
      cpu: 1024,
      memory: 2048,
      executionRoleArn: 'arn:aws:iam::123:role/exec',
    }),
    registerTaskDefinition: vi.fn().mockResolvedValue('arn:aws:ecs:::task-definition/filebrowser-minecraft:1'),
    runTask: vi.fn().mockResolvedValue({ taskArn: 'arn-fm' }),
    stopTask: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
  return { stub, service: stub as EcsService };
}

/**
 * Build an Ec2Service stub whose `getPublicIp` resolves to the given value.
 */
function makeEc2(ip: string | null = '1.2.3.4'): Ec2Service {
  const stub: Partial<Ec2Service> = {
    getPublicIp: vi.fn().mockResolvedValue(ip),
  };
  return stub as Ec2Service;
}

describe('FileManagerService', () => {
  describe('getStatus', () => {
    it('should return not_deployed when terraform outputs are missing', async () => {
      const { service: ecs } = makeEcs();
      const svc = new FileManagerService(makeConfig(null), ecs, makeEc2());
      expect((await svc.getStatus('minecraft')).state).toBe('not_deployed');
    });

    it('should return stopped when no tasks exist', async () => {
      const { stub, service: ecs } = makeEcs({ listTasksByStartedBy: vi.fn().mockResolvedValue([]) });
      const svc = new FileManagerService(makeConfig(), ecs, makeEc2());
      expect((await svc.getStatus('minecraft')).state).toBe('stopped');
      expect(stub.listTasksByStartedBy).toHaveBeenCalledWith('game-cluster', 'filemgr-minecraft');
    });

    it('should return running with a URL built from the public IP on port 8080', async () => {
      const task: Task = { taskArn: 'arn-fm', lastStatus: 'RUNNING' };
      const { service: ecs } = makeEcs({
        listTasksByStartedBy: vi.fn().mockResolvedValue([task]),
        extractEniId: vi.fn().mockReturnValue('eni-1'),
      });
      const svc = new FileManagerService(makeConfig(), ecs, makeEc2('5.6.7.8'));
      const status = await svc.getStatus('minecraft');
      expect(status.state).toBe('running');
      expect(status.url).toBe('http://5.6.7.8:8080');
      expect(status.taskArn).toBe('arn-fm');
    });

    it('should return running without a URL when the public IP cannot be resolved', async () => {
      const { service: ecs } = makeEcs({
        listTasksByStartedBy: vi.fn().mockResolvedValue([{ lastStatus: 'RUNNING' }]),
        extractEniId: vi.fn().mockReturnValue('eni-1'),
      });
      const svc = new FileManagerService(makeConfig(), ecs, makeEc2(null));
      const status = await svc.getStatus('minecraft');
      expect(status.state).toBe('running');
      expect(status.url).toBeUndefined();
    });

    it('should return starting when the task is not yet running', async () => {
      const { service: ecs } = makeEcs({
        listTasksByStartedBy: vi.fn().mockResolvedValue([{ taskArn: 'arn-fm', lastStatus: 'PROVISIONING' }]),
      });
      const svc = new FileManagerService(makeConfig(), ecs, makeEc2());
      const status = await svc.getStatus('minecraft');
      expect(status.state).toBe('starting');
      expect(status.taskArn).toBe('arn-fm');
    });
  });

  describe('start', () => {
    it('should fail if terraform outputs are missing', async () => {
      const { service: ecs } = makeEcs();
      const svc = new FileManagerService(makeConfig(null), ecs, makeEc2());
      const result = await svc.start('minecraft');
      expect(result.success).toBe(false);
      expect(result.message).toMatch(/not deployed/i);
    });

    it('should fail when the game has no EFS access point', async () => {
      const outputs: StackOutputs = { ...DEFAULT_OUTPUTS, efsAccessPoints: {} };
      const { service: ecs } = makeEcs();
      const svc = new FileManagerService(makeConfig(outputs), ecs, makeEc2());
      const result = await svc.start('minecraft');
      expect(result.success).toBe(false);
      expect(result.message).toMatch(/no efs access point/i);
    });

    it('should fail when file_manager_security_group_id is not set', async () => {
      const outputs: StackOutputs = { ...DEFAULT_OUTPUTS, fileManagerSecurityGroupId: '' };
      const { service: ecs } = makeEcs();
      const svc = new FileManagerService(makeConfig(outputs), ecs, makeEc2());
      const result = await svc.start('minecraft');
      expect(result.success).toBe(false);
      expect(result.message).toMatch(/fileManagerSecurityGroupId/);
    });

    it('should fail when the file manager is already running', async () => {
      const { service: ecs } = makeEcs({
        listTasksByStartedBy: vi.fn().mockResolvedValue([{ taskArn: 'existing' }]),
      });
      const svc = new FileManagerService(makeConfig(), ecs, makeEc2());
      const result = await svc.start('minecraft');
      expect(result.success).toBe(false);
      expect(result.message).toMatch(/already running/i);
    });

    it('should fail when the game task definition has no execution role', async () => {
      const { service: ecs } = makeEcs({
        getTaskDefinition: vi.fn().mockResolvedValue(null),
      });
      const svc = new FileManagerService(makeConfig(), ecs, makeEc2());
      const result = await svc.start('minecraft');
      expect(result.success).toBe(false);
      expect(result.message).toMatch(/execution role/i);
    });

    it('should register a filebrowser task definition and then run it', async () => {
      const { stub, service: ecs } = makeEcs();
      const svc = new FileManagerService(makeConfig(), ecs, makeEc2());
      const result = await svc.start('minecraft');

      expect(result.success).toBe(true);
      expect(result.taskArn).toBe('arn-fm');

      const regArgs = vi.mocked(stub.registerTaskDefinition).mock.calls[0]![0];
      expect(regArgs.family).toBe('filebrowser-minecraft');
      expect(regArgs.networkMode).toBe('awsvpc');
      expect(regArgs.requiresCompatibilities).toEqual(['FARGATE']);
      expect(regArgs.cpu).toBe('256');
      expect(regArgs.memory).toBe('512');
      expect(regArgs.executionRoleArn).toBe('arn:aws:iam::123:role/exec');

      const volume = regArgs.volumes![0]!;
      expect(volume.efsVolumeConfiguration!.fileSystemId).toBe('fs-1');
      expect(volume.efsVolumeConfiguration!.authorizationConfig!.accessPointId).toBe('fsap-mc');
      expect(volume.efsVolumeConfiguration!.transitEncryption).toBe('ENABLED');

      const container = regArgs.containerDefinitions![0]!;
      expect(container.image).toContain('filebrowser');
      expect(container.portMappings![0]!.containerPort).toBe(8080);
      expect(container.mountPoints![0]!.containerPath).toBe('/srv');
      expect(container.command).toContain('--noauth');
      expect(container.logConfiguration!.options!['awslogs-group']).toBe('/ecs/filebrowser-minecraft');
      expect(container.logConfiguration!.options!['awslogs-region']).toBe('us-east-1');

      const runArgs = vi.mocked(stub.runTask).mock.calls[0]![0];
      expect(runArgs.cluster).toBe('game-cluster');
      expect(runArgs.taskDefinition).toBe('filebrowser-minecraft');
      expect(runArgs.startedBy).toBe('filemgr-minecraft');
      expect(runArgs.networkConfiguration!.awsvpcConfiguration!.subnets).toEqual(['subnet-a', 'subnet-b']);
      expect(runArgs.networkConfiguration!.awsvpcConfiguration!.securityGroups).toEqual(['sg-files']);
      expect(runArgs.networkConfiguration!.awsvpcConfiguration!.assignPublicIp).toBe('ENABLED');
    });

    it('should fail when task-definition registration returns null', async () => {
      const { stub, service: ecs } = makeEcs({
        registerTaskDefinition: vi.fn().mockResolvedValue(null),
      });
      const svc = new FileManagerService(makeConfig(), ecs, makeEc2());
      const result = await svc.start('minecraft');
      expect(result.success).toBe(false);
      expect(stub.runTask).not.toHaveBeenCalled();
    });

    it('should fail when runTask returns null', async () => {
      const { service: ecs } = makeEcs({
        runTask: vi.fn().mockResolvedValue(null),
      });
      const svc = new FileManagerService(makeConfig(), ecs, makeEc2());
      const result = await svc.start('minecraft');
      expect(result.success).toBe(false);
    });
  });

  describe('stop', () => {
    it('should fail when outputs are missing', async () => {
      const { service: ecs } = makeEcs();
      const svc = new FileManagerService(makeConfig(null), ecs, makeEc2());
      expect((await svc.stop('minecraft')).success).toBe(false);
    });

    it('should fail when no file manager is running', async () => {
      const { service: ecs } = makeEcs({ listTasksByStartedBy: vi.fn().mockResolvedValue([]) });
      const svc = new FileManagerService(makeConfig(), ecs, makeEc2());
      const result = await svc.stop('minecraft');
      expect(result.success).toBe(false);
      expect(result.message).toMatch(/no file manager running/i);
    });

    it('should stop the first task when running', async () => {
      const { stub, service: ecs } = makeEcs({
        listTasksByStartedBy: vi.fn().mockResolvedValue([{ taskArn: 'arn-1' }]),
      });
      const svc = new FileManagerService(makeConfig(), ecs, makeEc2());
      const result = await svc.stop('minecraft');
      expect(result.success).toBe(true);
      expect(stub.stopTask).toHaveBeenCalledWith('game-cluster', 'arn-1', expect.any(String));
    });

    it('should return failure when stopTask throws', async () => {
      const { service: ecs } = makeEcs({
        listTasksByStartedBy: vi.fn().mockResolvedValue([{ taskArn: 'arn-1' }]),
        stopTask: vi.fn().mockRejectedValue(new Error('nope')),
      });
      const svc = new FileManagerService(makeConfig(), ecs, makeEc2());
      const result = await svc.stop('minecraft');
      expect(result.success).toBe(false);
      expect(result.message).toContain('nope');
    });
  });
});
