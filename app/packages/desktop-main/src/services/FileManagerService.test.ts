import 'reflect-metadata';
import { describe, it, expect, vi } from 'vitest';
import type { Task } from '@aws-sdk/client-ecs';
import type { SecretsStore } from '@hyveon/shared';

vi.mock('../logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { FileManagerService } from './FileManagerService.js';
import type { ConfigService } from './ConfigService.js';
import type { EcsService } from './EcsService.js';
import type { Ec2Service } from './Ec2Service.js';
import type { SchedulerService } from './SchedulerService.js';
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
  fileBrowserCredentialSecretArn: 'arn:aws:secretsmanager:us-east-1:123:secret:filebrowser-credential',
  fileBrowserSchedulerRoleArn: 'arn:aws:iam::123:role/filebrowser-scheduler',
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
 * Build a minimal ConfigService stub. Pass `null` to simulate "the stack
 * hasn't been deployed yet".
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

/**
 * Subset of SchedulerService that FileManagerService actually calls. Both
 * methods default to succeeding — individual tests override to exercise the
 * best-effort failure paths.
 */
type SchedulerStub = Pick<SchedulerService, 'createStopSchedule' | 'deleteSchedule'>;

/** Build a SchedulerService stub with happy-path defaults, overridable per test. */
function makeScheduler(overrides: Partial<SchedulerStub> = {}): { stub: SchedulerStub; service: SchedulerService } {
  const stub: SchedulerStub = {
    createStopSchedule: vi.fn().mockResolvedValue(true),
    deleteSchedule: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
  return { stub, service: stub as SchedulerService };
}

/** Build a SecretsStore stub whose `put` resolves by default; override to simulate a Secrets Manager write failure. */
function makeSecrets(overrides: Partial<SecretsStore> = {}): { stub: SecretsStore; service: SecretsStore } {
  const stub: SecretsStore = {
    get: vi.fn().mockResolvedValue(undefined),
    put: vi.fn().mockResolvedValue(undefined),
    exists: vi.fn().mockResolvedValue(false),
    ...overrides,
  };
  return { stub, service: stub };
}

/**
 * Constructs the SUT with happy-path `EcsService`/`Ec2Service`/`SchedulerService`/
 * `SecretsStore` collaborators unless overridden — the standard "arrange" step
 * every test below uses, so adding a new constructor dependency only needs a
 * new optional field here rather than touching every call site.
 */
function buildService(options: {
  config?: ConfigService;
  ecs?: EcsService;
  ec2?: Ec2Service;
  scheduler?: SchedulerService;
  secrets?: SecretsStore;
} = {}): FileManagerService {
  return new FileManagerService(
    options.config ?? makeConfig(),
    options.ecs ?? makeEcs().service,
    options.ec2 ?? makeEc2(),
    options.scheduler ?? makeScheduler().service,
    options.secrets ?? makeSecrets().service,
  );
}

describe('FileManagerService', () => {
  describe('getStatus', () => {
    it('should return not_deployed when stack outputs are missing', async () => {
      const { service: ecs } = makeEcs();
      const svc = buildService({ config: makeConfig(null), ecs });
      expect((await svc.getStatus('minecraft')).state).toBe('not_deployed');
    });

    it('should return stopped when no tasks exist', async () => {
      const { stub, service: ecs } = makeEcs({ listTasksByStartedBy: vi.fn().mockResolvedValue([]) });
      const svc = buildService({ ecs });
      expect((await svc.getStatus('minecraft')).state).toBe('stopped');
      expect(stub.listTasksByStartedBy).toHaveBeenCalledWith('game-cluster', 'filemgr-minecraft');
    });

    it('should return running with a URL built from the public IP on port 8080', async () => {
      const task: Task = { taskArn: 'arn-fm', lastStatus: 'RUNNING' };
      const { service: ecs } = makeEcs({
        listTasksByStartedBy: vi.fn().mockResolvedValue([task]),
        extractEniId: vi.fn().mockReturnValue('eni-1'),
      });
      const svc = buildService({ ecs, ec2: makeEc2('5.6.7.8') });
      const status = await svc.getStatus('minecraft');
      expect(status.state).toBe('running');
      expect(status.url).toBe('http://5.6.7.8:8080');
      expect(status.taskArn).toBe('arn-fm');
      expect(status).not.toHaveProperty('credentials');
    });

    it('should return running without a URL when the public IP cannot be resolved', async () => {
      const { service: ecs } = makeEcs({
        listTasksByStartedBy: vi.fn().mockResolvedValue([{ lastStatus: 'RUNNING' }]),
        extractEniId: vi.fn().mockReturnValue('eni-1'),
      });
      const svc = buildService({ ecs, ec2: makeEc2(null) });
      const status = await svc.getStatus('minecraft');
      expect(status.state).toBe('running');
      expect(status.url).toBeUndefined();
    });

    it('should return starting when the task is not yet running', async () => {
      const { service: ecs } = makeEcs({
        listTasksByStartedBy: vi.fn().mockResolvedValue([{ taskArn: 'arn-fm', lastStatus: 'PROVISIONING' }]),
      });
      const svc = buildService({ ecs });
      const status = await svc.getStatus('minecraft');
      expect(status.state).toBe('starting');
      expect(status.taskArn).toBe('arn-fm');
    });
  });

  describe('start', () => {
    it('should fail if stack outputs are missing', async () => {
      const { service: ecs } = makeEcs();
      const svc = buildService({ config: makeConfig(null), ecs });
      const result = await svc.start('minecraft');
      expect(result.success).toBe(false);
      expect(result.message).toMatch(/not deployed/i);
    });

    it('should fail when the game has no EFS access point', async () => {
      const outputs: StackOutputs = { ...DEFAULT_OUTPUTS, efsAccessPoints: {} };
      const { service: ecs } = makeEcs();
      const svc = buildService({ config: makeConfig(outputs), ecs });
      const result = await svc.start('minecraft');
      expect(result.success).toBe(false);
      expect(result.message).toMatch(/no efs access point/i);
    });

    it('should fail when file_manager_security_group_id is not set', async () => {
      const outputs: StackOutputs = { ...DEFAULT_OUTPUTS, fileManagerSecurityGroupId: '' };
      const { service: ecs } = makeEcs();
      const svc = buildService({ config: makeConfig(outputs), ecs });
      const result = await svc.start('minecraft');
      expect(result.success).toBe(false);
      expect(result.message).toMatch(/fileManagerSecurityGroupId/);
    });

    it('should fail when the file manager is already running', async () => {
      const { service: ecs } = makeEcs({
        listTasksByStartedBy: vi.fn().mockResolvedValue([{ taskArn: 'existing' }]),
      });
      const svc = buildService({ ecs });
      const result = await svc.start('minecraft');
      expect(result.success).toBe(false);
      expect(result.message).toMatch(/already running/i);
    });

    it('should fail when the game task definition has no execution role', async () => {
      const { service: ecs } = makeEcs({
        getTaskDefinition: vi.fn().mockResolvedValue(null),
      });
      const svc = buildService({ ecs });
      const result = await svc.start('minecraft');
      expect(result.success).toBe(false);
      expect(result.message).toMatch(/execution role/i);
    });

    it('should register a filebrowser task definition (auth flags, not --noauth) and then run it', async () => {
      const { stub, service: ecs } = makeEcs();
      const svc = buildService({ ecs });
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
      expect(container.command).not.toContain('--noauth');
      expect(container.command).toContain('--username');
      expect(container.command).toContain('--password');
      // The password flag must carry a bcrypt hash, never the plaintext
      // returned to the caller in `result.credentials.password`.
      const passwordIndex = container.command!.indexOf('--password') + 1;
      const passwordFlagValue = container.command![passwordIndex] as string;
      expect(passwordFlagValue).toMatch(/^\$2[aby]\$/);
      expect(passwordFlagValue).not.toBe(result.credentials?.password);
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

    it('should return a random plaintext username/password pair once, in credentials', async () => {
      const { service: ecs } = makeEcs();
      const svc = buildService({ ecs });

      const first = await svc.start('minecraft');
      const second = await svc.start('minecraft');

      expect(first.credentials?.username).toBe('admin');
      expect(first.credentials?.password).toEqual(expect.any(String));
      expect(first.credentials?.password.length).toBeGreaterThan(0);
      // Every launch generates a fresh password.
      expect(second.credentials?.password).not.toBe(first.credentials?.password);
    });

    it('should write the bcrypt hash to Secrets Manager via the shared SecretsStore', async () => {
      const { service: ecs } = makeEcs();
      const { stub: secretsStub, service: secrets } = makeSecrets();
      const svc = buildService({ ecs, secrets });

      const result = await svc.start('minecraft');

      expect(secretsStub.put).toHaveBeenCalledWith(
        'arn:aws:secretsmanager:us-east-1:123:secret:filebrowser-credential',
        expect.any(String),
      );
      const storedHash = vi.mocked(secretsStub.put).mock.calls[0]![1];
      expect(storedHash).not.toBe(result.credentials?.password);
    });

    it('should not fail the launch when the Secrets Manager write throws', async () => {
      const { service: ecs } = makeEcs();
      const { service: secrets } = makeSecrets({ put: vi.fn().mockRejectedValue(new Error('AccessDenied')) });
      const svc = buildService({ ecs, secrets });

      const result = await svc.start('minecraft');

      expect(result.success).toBe(true);
      expect(result.credentials).toBeDefined();
    });

    it('should create a one-time auto-stop schedule after a successful RunTask, targeting the new task and the deployed scheduler role', async () => {
      const { service: ecs } = makeEcs();
      const { stub: schedulerStub, service: scheduler } = makeScheduler();
      const svc = buildService({ ecs, scheduler });

      await svc.start('minecraft');

      expect(schedulerStub.createStopSchedule).toHaveBeenCalledWith(
        expect.objectContaining({
          name: 'filemgr-stop-minecraft',
          cluster: 'game-cluster',
          taskArn: 'arn-fm',
          roleArn: 'arn:aws:iam::123:role/filebrowser-scheduler',
          at: expect.any(Date),
        }),
      );
      const at = vi.mocked(schedulerStub.createStopSchedule).mock.calls[0]![0].at;
      expect(at.getTime()).toBeGreaterThan(Date.now());
    });

    it('should not create a schedule (and should still succeed) when fileBrowserSchedulerRoleArn is missing from stack outputs', async () => {
      const outputs: StackOutputs = { ...DEFAULT_OUTPUTS, fileBrowserSchedulerRoleArn: '' };
      const { service: ecs } = makeEcs();
      const { stub: schedulerStub, service: scheduler } = makeScheduler();
      const svc = buildService({ config: makeConfig(outputs), ecs, scheduler });

      const result = await svc.start('minecraft');

      expect(result.success).toBe(true);
      expect(schedulerStub.createStopSchedule).not.toHaveBeenCalled();
    });

    it('should still succeed when schedule creation itself fails', async () => {
      const { service: ecs } = makeEcs();
      const { service: scheduler } = makeScheduler({ createStopSchedule: vi.fn().mockResolvedValue(false) });
      const svc = buildService({ ecs, scheduler });

      const result = await svc.start('minecraft');

      expect(result.success).toBe(true);
    });

    it('should fail when task-definition registration returns null', async () => {
      const { stub, service: ecs } = makeEcs({
        registerTaskDefinition: vi.fn().mockResolvedValue(null),
      });
      const svc = buildService({ ecs });
      const result = await svc.start('minecraft');
      expect(result.success).toBe(false);
      expect(stub.runTask).not.toHaveBeenCalled();
    });

    it('should fail when runTask returns null', async () => {
      const { service: ecs } = makeEcs({
        runTask: vi.fn().mockResolvedValue(null),
      });
      const svc = buildService({ ecs });
      const result = await svc.start('minecraft');
      expect(result.success).toBe(false);
    });
  });

  describe('stop', () => {
    it('should fail when outputs are missing', async () => {
      const { service: ecs } = makeEcs();
      const svc = buildService({ config: makeConfig(null), ecs });
      expect((await svc.stop('minecraft')).success).toBe(false);
    });

    it('should fail when no file manager is running', async () => {
      const { service: ecs } = makeEcs({ listTasksByStartedBy: vi.fn().mockResolvedValue([]) });
      const svc = buildService({ ecs });
      const result = await svc.stop('minecraft');
      expect(result.success).toBe(false);
      expect(result.message).toMatch(/no file manager running/i);
    });

    it('should stop the first task when running', async () => {
      const { stub, service: ecs } = makeEcs({
        listTasksByStartedBy: vi.fn().mockResolvedValue([{ taskArn: 'arn-1' }]),
      });
      const svc = buildService({ ecs });
      const result = await svc.stop('minecraft');
      expect(result.success).toBe(true);
      expect(stub.stopTask).toHaveBeenCalledWith('game-cluster', 'arn-1', expect.any(String));
    });

    it('should delete the game auto-stop schedule after stopping the task', async () => {
      const { service: ecs } = makeEcs({
        listTasksByStartedBy: vi.fn().mockResolvedValue([{ taskArn: 'arn-1' }]),
      });
      const { stub: schedulerStub, service: scheduler } = makeScheduler();
      const svc = buildService({ ecs, scheduler });

      await svc.stop('minecraft');

      expect(schedulerStub.deleteSchedule).toHaveBeenCalledWith('filemgr-stop-minecraft');
    });

    it('should return failure when stopTask throws', async () => {
      const { service: ecs } = makeEcs({
        listTasksByStartedBy: vi.fn().mockResolvedValue([{ taskArn: 'arn-1' }]),
        stopTask: vi.fn().mockRejectedValue(new Error('nope')),
      });
      const svc = buildService({ ecs });
      const result = await svc.stop('minecraft');
      expect(result.success).toBe(false);
      expect(result.message).toContain('nope');
    });
  });
});
