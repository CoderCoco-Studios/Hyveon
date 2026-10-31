import 'reflect-metadata';
import { describe, it, expect, vi } from 'vitest';
import type { Task } from '@aws-sdk/client-ecs';
import type { SecretsStore } from '@hyveon/shared';

vi.mock('../logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { FileManagerService, UPLOAD_TAGS, BROWSE_RUN_ID, FILEBROWSER_AUTO_STOP_MS } from './FileManagerService.js';
import type { ConfigService } from './ConfigService.js';
import type { EcsService } from './EcsService.js';
import type { Ec2Service } from './Ec2Service.js';
import type { SchedulerService } from './SchedulerService.js';
import type { PublicIpService } from './PublicIpService.js';
import type { StackOutputs } from '@hyveon/shared';
import { stackOutputs } from '../testing/stack-outputs.fixture.js';
import { configServiceStub } from '../testing/config-service.fixture.js';
import { configAndSavesVolumes, deploymentConfigStub, gameServer } from '../testing/deployment-config.fixture.js';
import type { DeploymentConfigService } from './DeploymentConfigService.js';
import { buildHelperVolumeLayout, type HelperVolumeLayout } from './volumeFiles/helperVolumeLayout.js';

/**
 * A canonical set of stack outputs used by most tests. Individual tests
 * spread over this to tweak specific fields (e.g. clearing EFS access points).
 */
const DEFAULT_OUTPUTS: StackOutputs = stackOutputs({
  awsRegion: 'us-east-1',
  ecsClusterName: 'game-cluster',
  ecsClusterArn: 'arn:...',
  subnetIds: ['subnet-a', 'subnet-b'],
  securityGroupId: 'sg-game',
  fileManagerSecurityGroupId: 'sg-files',
  efsFileSystemId: 'fs-1',
  efsAccessPoints: { minecraft: 'fsap-mc' },
  efsVolumeAccessPoints: { minecraft: { data: 'fsap-mc' } },
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
});

/**
 * Subset of EcsService that FileManagerService actually calls. Tests create
 * instances of this shape and cast once to `EcsService`, which keeps the
 * `vi.fn()` return types intact for assertions like `.mock.calls[0]`.
 */
type EcsStub = Pick<
  EcsService,
  | 'listTasksByStartedBy'
  | 'describeStoppedReason'
  | 'extractEniId'
  | 'getTaskDefinition'
  | 'registerTaskDefinition'
  | 'runTask'
  | 'stopTask'
  | 'deregisterTaskDefinition'
  | 'listTasksByStartedByPrefix'
  | 'tagTask'
>;

/**
 * Build a minimal ConfigService stub. Pass `null` to simulate "the stack
 * hasn't been deployed yet".
 */
function makeConfig(outputs: StackOutputs | null = DEFAULT_OUTPUTS): ConfigService {
  return configServiceStub({ outputs });
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
    describeStoppedReason: vi.fn().mockResolvedValue(null),
    extractEniId: vi.fn().mockReturnValue(null),
    getTaskDefinition: vi.fn().mockResolvedValue({
      cpu: 1024,
      memory: 2048,
      executionRoleArn: 'arn:aws:iam::123:role/exec',
    }),
    registerTaskDefinition: vi.fn().mockResolvedValue('arn:aws:ecs:::task-definition/filebrowser-minecraft:1'),
    runTask: vi.fn().mockResolvedValue({ taskArn: 'arn-fm' }),
    stopTask: vi.fn().mockResolvedValue(undefined),
    deregisterTaskDefinition: vi.fn().mockResolvedValue(true),
    listTasksByStartedByPrefix: vi.fn().mockResolvedValue([]),
    tagTask: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
  return { stub, service: stub as EcsService };
}

/** Subset of Ec2Service that FileManagerService calls. */
type Ec2Stub = Pick<
  Ec2Service,
  'getPublicIp' | 'authorizeIngress' | 'listIngressRulesByDescriptionPrefix' | 'revokeIngressRules'
>;

/**
 * Build an Ec2Service stub whose `getPublicIp` resolves to the given value and whose security-group calls succeed.
 * Returns the stub alongside the typed service so tests can assert on the `vi.fn()` handles.
 */
function makeEc2(ip: string | null = '1.2.3.4', overrides: Partial<Ec2Stub> = {}): Ec2Service & Ec2Stub {
  const stub: Ec2Stub = {
    getPublicIp: vi.fn().mockResolvedValue(ip),
    authorizeIngress: vi.fn().mockResolvedValue(undefined),
    listIngressRulesByDescriptionPrefix: vi.fn().mockResolvedValue([]),
    revokeIngressRules: vi.fn().mockResolvedValue(true),
    ...overrides,
  };
  return stub as Ec2Service & Ec2Stub;
}

/** Build a PublicIpService stub resolving to the operator IP (or rejecting when `ip` is null). */
function makePublicIp(ip: string | null = '203.0.113.7'): PublicIpService {
  const stub: Partial<PublicIpService> = {
    detect: ip ? vi.fn().mockResolvedValue(ip) : vi.fn().mockRejectedValue(new Error('Could not detect your public IP address: offline')),
  };
  return stub as PublicIpService;
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
  publicIp?: PublicIpService;
  deploymentConfig?: DeploymentConfigService;
} = {}): FileManagerService {
  return new FileManagerService(
    options.config ?? makeConfig(),
    options.ecs ?? makeEcs().service,
    options.ec2 ?? makeEc2(),
    options.scheduler ?? makeScheduler().service,
    options.secrets ?? makeSecrets().service,
    options.publicIp ?? makePublicIp(),
    options.deploymentConfig ?? deploymentConfigStub(),
  );
}

/** A running helper task tagged with the operator IP it was launched for. */
function helperTask(game: string, operatorIp: string | null, extra: Partial<Task> = {}): Task {
  return {
    taskArn: `arn-${game}`,
    startedBy: `filemgr-${game}`,
    lastStatus: 'RUNNING',
    ...(operatorIp ? { tags: [{ key: 'OperatorIp', value: operatorIp }] } : {}),
    ...extra,
  };
}

/** An app-created security-group rule for `game` opened to `ip`. */
function sgRule(game: string, ip: string, runId = 'browse') {
  return { ruleId: `sgr-${game}-${ip}`, description: `hyveon-filemgr:${game}:${runId}`, cidr: `${ip}/32` };
}

/** A game's `config` and `saves` volumes, both applied in {@link TWO_VOLUME_OUTPUTS}. */
const TWO_VOLUMES = configAndSavesVolumes();
const TWO_VOLUME_OUTPUTS: StackOutputs = {
  ...DEFAULT_OUTPUTS,
  efsVolumeAccessPoints: { minecraft: { config: 'fsap-c', saves: 'fsap-s' } },
};

describe('FileManagerService', () => {
  /** Launches a browse-run helper and asserts it succeeded. */
  const launchOk = async (svc: FileManagerService, runId = BROWSE_RUN_ID) => {
    const outcome = await svc.launchHelper('minecraft', { runId });
    if (!outcome.ok) throw new Error(`expected launch to succeed: ${outcome.message}`);
    return outcome;
  };

  /** Launches a browse-run helper and asserts it was refused or failed. */
  const launchFailed = async (svc: FileManagerService) => {
    const outcome = await svc.launchHelper('minecraft', { runId: BROWSE_RUN_ID });
    if (outcome.ok) throw new Error('expected launch to fail');
    return outcome;
  };

  describe('launchHelper preconditions and task definition', () => {
    it('should fail if stack outputs are missing', async () => {
      const { service: ecs } = makeEcs();
      const svc = buildService({ config: makeConfig(null), ecs });
      const result = await launchFailed(svc);
      expect(result.message).toMatch(/not deployed/i);
    });

    it('should fail when the game has no EFS access point', async () => {
      const outputs: StackOutputs = { ...DEFAULT_OUTPUTS, efsAccessPoints: {}, efsVolumeAccessPoints: {} };
      const { service: ecs } = makeEcs();
      const svc = buildService({ config: makeConfig(outputs), ecs });
      const result = await launchFailed(svc);
      expect(result.message).toMatch(/no efs access point/i);
    });

    it('should fail when file_manager_security_group_id is not set', async () => {
      const outputs: StackOutputs = { ...DEFAULT_OUTPUTS, fileManagerSecurityGroupId: '' };
      const { service: ecs } = makeEcs();
      const svc = buildService({ config: makeConfig(outputs), ecs });
      const result = await launchFailed(svc);
      expect(result.message).toMatch(/fileManagerSecurityGroupId/);
    });

    it('should fail when the file manager is already running', async () => {
      const { service: ecs } = makeEcs({
        listTasksByStartedBy: vi.fn().mockResolvedValue([{ taskArn: 'existing' }]),
      });
      const svc = buildService({ ecs });
      const result = await launchFailed(svc);
      expect(result.message).toMatch(/already running/i);
    });

    it('should fail when the game task definition has no execution role', async () => {
      const { service: ecs } = makeEcs({
        getTaskDefinition: vi.fn().mockResolvedValue(null),
      });
      const svc = buildService({ ecs });
      const result = await launchFailed(svc);
      expect(result.message).toMatch(/execution role/i);
    });

    it('should register one EFS volume and mount point per mounted volume', async () => {
      const { stub, service: ecs } = makeEcs();
      const deploymentConfig = deploymentConfigStub({ declared: [gameServer('minecraft', { volumes: TWO_VOLUMES })] });
      const svc = buildService({ config: makeConfig(TWO_VOLUME_OUTPUTS), ecs, deploymentConfig });
      await launchOk(svc);

      const regArgs = vi.mocked(stub.registerTaskDefinition).mock.calls[0]![0];
      expect(regArgs.volumes!.map((v) => v.efsVolumeConfiguration!.authorizationConfig!.accessPointId)).toEqual(['fsap-c', 'fsap-s']);
      expect(regArgs.volumes!.map((v) => v.name)).toEqual(['vol-0', 'vol-1']);
      for (const v of regArgs.volumes!) {
        expect(v.efsVolumeConfiguration).toMatchObject({ fileSystemId: 'fs-1', transitEncryption: 'ENABLED' });
        expect(v.efsVolumeConfiguration!.authorizationConfig!.iam).toBe('DISABLED');
      }
      const container = regArgs.containerDefinitions![0]!;
      expect(container.mountPoints!.map((m) => m.containerPath)).toEqual(['/srv/config', '/srv/saves']);
      expect(container.mountPoints!.map((m) => m.sourceVolume)).toEqual(['vol-0', 'vol-1']);
      expect(container.command).toContain('/srv');
    });

    it('should register a filebrowser task definition (auth flags, not --noauth) and then run it', async () => {
      const { stub, service: ecs } = makeEcs();
      const svc = buildService({ ecs });
      const result = await launchOk(svc);

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
      expect(container.mountPoints![0]!.containerPath).toBe('/srv/data');
      expect(container.mountPoints![0]!.sourceVolume).toBe(volume.name);
      expect(container.command).not.toContain('--noauth');
      expect(container.command).toContain('--username');
      expect(container.command).toContain('--password');
      // The password flag must carry a bcrypt hash, never the plaintext
      // returned in-process on `result.credentials.password`.
      const passwordIndex = container.command!.indexOf('--password') + 1;
      const passwordFlagValue = container.command![passwordIndex] as string;
      expect(passwordFlagValue).toMatch(/^\$2[aby]\$/);
      expect(passwordFlagValue).not.toBe(result.credentials.password);
      expect(container.logConfiguration!.options!['awslogs-group']).toBe('/ecs/filebrowser-minecraft');
      expect(container.logConfiguration!.options!['awslogs-region']).toBe('us-east-1');
      // The group is pre-created by infra; the execution role can't create it.
      expect(container.logConfiguration!.options).not.toHaveProperty('awslogs-create-group');

      const runArgs = vi.mocked(stub.runTask).mock.calls[0]![0];
      expect(runArgs.cluster).toBe('game-cluster');
      expect(runArgs.taskDefinition).toBe('filebrowser-minecraft');
      expect(runArgs.startedBy).toBe('filemgr-minecraft');
      expect(runArgs.networkConfiguration!.awsvpcConfiguration!.subnets).toEqual(['subnet-a', 'subnet-b']);
      expect(runArgs.networkConfiguration!.awsvpcConfiguration!.securityGroups).toEqual(['sg-files']);
      expect(runArgs.networkConfiguration!.awsvpcConfiguration!.assignPublicIp).toBe('ENABLED');
    });

    it('should launch the helper from an immutable image reference', async () => {
      const { stub, service: ecs } = makeEcs();
      const svc = buildService({ ecs });
      await launchOk(svc);

      const container = vi.mocked(stub.registerTaskDefinition).mock.calls[0]![0].containerDefinitions![0]!;
      expect(container.image).toMatch(/^filebrowser\/filebrowser:v?2\.63\.23@sha256:[0-9a-f]{64}$/);
    });

    it('should generate a fresh random username/password pair for every launch', async () => {
      const { service: ecs } = makeEcs();
      const svc = buildService({ ecs });

      const first = await launchOk(svc);
      const second = await launchOk(svc);

      expect(first.credentials.username).toBe('admin');
      expect(first.credentials.password).toEqual(expect.any(String));
      expect(first.credentials.password.length).toBeGreaterThan(0);
      expect(second.credentials.password).not.toBe(first.credentials.password);
    });

    it('should write the bcrypt hash to Secrets Manager via the shared SecretsStore', async () => {
      const { service: ecs } = makeEcs();
      const { stub: secretsStub, service: secrets } = makeSecrets();
      const svc = buildService({ ecs, secrets });

      const result = await launchOk(svc);

      expect(secretsStub.put).toHaveBeenCalledWith(
        'arn:aws:secretsmanager:us-east-1:123:secret:filebrowser-credential',
        expect.any(String),
      );
      const storedHash = vi.mocked(secretsStub.put).mock.calls[0]![1];
      expect(storedHash).not.toBe(result.credentials.password);
    });

    it('should not fail the launch when the Secrets Manager write throws', async () => {
      const { service: ecs } = makeEcs();
      const { service: secrets } = makeSecrets({ put: vi.fn().mockRejectedValue(new Error('AccessDenied')) });
      const svc = buildService({ ecs, secrets });

      const result = await launchOk(svc);

      expect(result.credentials).toBeDefined();
    });

    it('should create a one-time auto-stop schedule after a successful RunTask, targeting the new task and the deployed scheduler role', async () => {
      const { service: ecs } = makeEcs();
      const { stub: schedulerStub, service: scheduler } = makeScheduler();
      const svc = buildService({ ecs, scheduler });

      await launchOk(svc);

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

    it('should not create a schedule, but should still succeed and warn in the message, when fileBrowserSchedulerRoleArn is missing from stack outputs', async () => {
      const outputs: StackOutputs = { ...DEFAULT_OUTPUTS, fileBrowserSchedulerRoleArn: '' };
      const { service: ecs } = makeEcs();
      const { stub: schedulerStub, service: scheduler } = makeScheduler();
      const svc = buildService({ config: makeConfig(outputs), ecs, scheduler });

      const result = await launchOk(svc);

      expect(schedulerStub.createStopSchedule).not.toHaveBeenCalled();
      expect(result.scheduleWarning).toMatch(/warning/i);
    });

    it('should still succeed but warn in the message when schedule creation itself fails', async () => {
      const { service: ecs } = makeEcs();
      const { service: scheduler } = makeScheduler({ createStopSchedule: vi.fn().mockResolvedValue(false) });
      const svc = buildService({ ecs, scheduler });

      const result = await launchOk(svc);

      expect(result.scheduleWarning).toMatch(/warning/i);
    });

    it('should not warn in the message when the schedule is created successfully', async () => {
      const { service: ecs } = makeEcs();
      const { service: scheduler } = makeScheduler();
      const svc = buildService({ ecs, scheduler });

      const result = await launchOk(svc);

      expect(result.scheduleWarning).toBe('');
    });

    it('should fail when task-definition registration returns null', async () => {
      const { stub, service: ecs } = makeEcs({
        registerTaskDefinition: vi.fn().mockResolvedValue(null),
      });
      await launchFailed(buildService({ ecs }));
      expect(stub.runTask).not.toHaveBeenCalled();
    });

    it('should fail when runTask returns null', async () => {
      const { service: ecs } = makeEcs({
        runTask: vi.fn().mockResolvedValue(null),
      });
      await launchFailed(buildService({ ecs }));
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

    it('should keep a shared rule when stopping the game whose description it carries while another helper uses the same IP', async () => {
      const { service: ecs } = makeEcs({
        listTasksByStartedBy: vi.fn().mockResolvedValue([{ taskArn: 'arn-1' }]),
        listTasksByStartedByPrefix: vi.fn().mockResolvedValue([helperTask('minecraft', '1.1.1.1'), helperTask('palworld', '1.1.1.1')]),
      });
      const ec2 = makeEc2('1.2.3.4', { listIngressRulesByDescriptionPrefix: vi.fn().mockResolvedValue([sgRule('minecraft', '1.1.1.1')]) });
      await buildService({ ecs, ec2 }).stop('minecraft');
      expect(ec2.revokeIngressRules).toHaveBeenCalledWith('sg-files', []);
    });

    it('should revoke the shared rule once the last helper using it stops, even when it carries another game\'s description', async () => {
      const { service: ecs } = makeEcs({
        listTasksByStartedBy: vi.fn().mockResolvedValue([{ taskArn: 'arn-2' }]),
        listTasksByStartedByPrefix: vi.fn().mockResolvedValue([helperTask('palworld', '1.1.1.1')]),
      });
      const ec2 = makeEc2('1.2.3.4', { listIngressRulesByDescriptionPrefix: vi.fn().mockResolvedValue([sgRule('minecraft', '1.1.1.1')]) });
      await buildService({ ecs, ec2 }).stop('palworld');
      expect(ec2.revokeIngressRules).toHaveBeenCalledWith('sg-files', ['sgr-minecraft-1.1.1.1']);
    });

    it('should revoke the stopped game\'s old-IP rule while keeping the running helper\'s newer-IP rule', async () => {
      const { service: ecs } = makeEcs({
        listTasksByStartedBy: vi.fn().mockResolvedValue([{ taskArn: 'arn-1' }]),
        listTasksByStartedByPrefix: vi.fn().mockResolvedValue([helperTask('minecraft', '1.1.1.1'), helperTask('palworld', '2.2.2.2')]),
      });
      const ec2 = makeEc2('1.2.3.4', {
        listIngressRulesByDescriptionPrefix: vi.fn().mockResolvedValue([sgRule('minecraft', '1.1.1.1'), sgRule('palworld', '2.2.2.2')]),
      });
      await buildService({ ecs, ec2 }).stop('minecraft');
      expect(ec2.revokeIngressRules).toHaveBeenCalledWith('sg-files', ['sgr-minecraft-1.1.1.1']);
    });

    it('should revoke the rule when no other helper is running', async () => {
      const { service: ecs } = makeEcs({
        listTasksByStartedBy: vi.fn().mockResolvedValue([{ taskArn: 'arn-1' }]),
        listTasksByStartedByPrefix: vi.fn().mockResolvedValue([helperTask('minecraft', '1.1.1.1')]),
      });
      const ec2 = makeEc2('1.2.3.4', { listIngressRulesByDescriptionPrefix: vi.fn().mockResolvedValue([sgRule('minecraft', '1.1.1.1')]) });
      await buildService({ ecs, ec2 }).stop('minecraft');
      expect(ec2.revokeIngressRules).toHaveBeenCalledWith('sg-files', ['sgr-minecraft-1.1.1.1']);
    });

    it('should keep every rule when another helper has no recorded operator IP', async () => {
      const { service: ecs } = makeEcs({
        listTasksByStartedBy: vi.fn().mockResolvedValue([{ taskArn: 'arn-1' }]),
        listTasksByStartedByPrefix: vi.fn().mockResolvedValue([helperTask('palworld', null)]),
      });
      const ec2 = makeEc2('1.2.3.4', { listIngressRulesByDescriptionPrefix: vi.fn().mockResolvedValue([sgRule('minecraft', '1.1.1.1')]) });
      await buildService({ ecs, ec2 }).stop('minecraft');
      expect(ec2.revokeIngressRules).not.toHaveBeenCalled();
    });

    it('should keep the rule when the other-helpers lookup fails', async () => {
      const { service: ecs } = makeEcs({
        listTasksByStartedBy: vi.fn().mockResolvedValue([{ taskArn: 'arn-1' }]),
        listTasksByStartedByPrefix: vi.fn().mockRejectedValue(new Error('throttled')),
      });
      const ec2 = makeEc2('1.2.3.4', { listIngressRulesByDescriptionPrefix: vi.fn().mockResolvedValue([sgRule('minecraft', '1.1.1.1')]) });
      await buildService({ ecs, ec2 }).stop('minecraft');
      expect(ec2.revokeIngressRules).not.toHaveBeenCalled();
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

  describe('operator IP rule', () => {
    it('should authorize the detected public IP as a /32 on port 8080 with a description naming game and run', async () => {
      const ec2 = makeEc2();
      await launchOk(buildService({ ec2 }));
      expect(ec2.authorizeIngress).toHaveBeenCalledWith('sg-files', '203.0.113.7/32', 8080, 'hyveon-filemgr:minecraft:browse');
    });

    it('should fail before registering anything when the public IP cannot be detected', async () => {
      const { stub, service: ecs } = makeEcs();
      const result = await launchFailed(buildService({ ecs, publicIp: makePublicIp(null) }));
      expect(result.message).toMatch(/public IP/);
      expect(stub.registerTaskDefinition).not.toHaveBeenCalled();
    });

    it('should fail without launching when the rule cannot be authorized', async () => {
      const { stub, service: ecs } = makeEcs();
      const ec2 = makeEc2('1.2.3.4', { authorizeIngress: vi.fn().mockRejectedValue(new Error('denied')) });
      const result = await launchFailed(buildService({ ecs, ec2 }));
      expect(result.message).toContain('denied');
      expect(stub.runTask).not.toHaveBeenCalled();
    });

    it('should revoke the rule and deregister the task definition when RunTask fails', async () => {
      const { stub, service: ecs } = makeEcs({ runTask: vi.fn().mockResolvedValue(null) });
      const ec2 = makeEc2('1.2.3.4', {
        listIngressRulesByDescriptionPrefix: vi.fn().mockResolvedValue([{ ruleId: 'sgr-1', description: 'hyveon-filemgr:minecraft:browse', cidr: '203.0.113.7/32' }]),
      });
      await launchFailed(buildService({ ecs, ec2 }));
      expect(ec2.revokeIngressRules).toHaveBeenCalledWith('sg-files', ['sgr-1']);
      expect(stub.deregisterTaskDefinition).toHaveBeenCalledWith('arn:aws:ecs:::task-definition/filebrowser-minecraft:1');
    });

    it('should revoke the rule when task-definition registration fails', async () => {
      const { service: ecs } = makeEcs({ registerTaskDefinition: vi.fn().mockResolvedValue(null) });
      const ec2 = makeEc2('1.2.3.4', {
        listIngressRulesByDescriptionPrefix: vi.fn().mockResolvedValue([{ ruleId: 'sgr-1', description: 'hyveon-filemgr:minecraft:browse', cidr: 'x' }]),
      });
      await launchFailed(buildService({ ecs, ec2 }));
      expect(ec2.revokeIngressRules).toHaveBeenCalledWith('sg-files', ['sgr-1']);
    });

    it('should not touch the rule of a game whose helper refused to start because one is open', async () => {
      const { service: ecs } = makeEcs({ listTasksByStartedBy: vi.fn().mockResolvedValue([{ taskArn: 'existing' }]) });
      const ec2 = makeEc2();
      await launchFailed(buildService({ ecs, ec2 }));
      expect(ec2.authorizeIngress).not.toHaveBeenCalled();
      expect(ec2.revokeIngressRules).not.toHaveBeenCalled();
    });

    const ruleFor = (game: string) => ({ ruleId: `sgr-${game}`, description: `hyveon-filemgr:${game}:r1`, cidr: 'x' });

    it('should keep rules a still-running helper needs when another helper is stopped', async () => {
      const { service: ecs } = makeEcs({
        listTasksByStartedBy: vi.fn().mockResolvedValue([{ taskArn: 'arn-1' }]),
        listTasksByStartedByPrefix: vi.fn().mockResolvedValue([helperTask('palworld', '203.0.113.7')]),
      });
      const ec2 = makeEc2('1.2.3.4', {
        listIngressRulesByDescriptionPrefix: vi.fn().mockResolvedValue([sgRule('minecraft', '198.51.100.1'), sgRule('palworld', '203.0.113.7')]),
      });
      await buildService({ ecs, ec2 }).stop('minecraft');
      expect(ec2.revokeIngressRules).toHaveBeenCalledWith('sg-files', ['sgr-minecraft-198.51.100.1']);
    });

    it('should still revoke the rule when stopTask throws', async () => {
      const { service: ecs } = makeEcs({
        listTasksByStartedBy: vi.fn().mockResolvedValue([{ taskArn: 'arn-1' }]),
        stopTask: vi.fn().mockRejectedValue(new Error('nope')),
      });
      const ec2 = makeEc2('1.2.3.4', { listIngressRulesByDescriptionPrefix: vi.fn().mockResolvedValue([ruleFor('minecraft')]) });
      await buildService({ ecs, ec2 }).stop('minecraft');
      expect(ec2.revokeIngressRules).toHaveBeenCalledWith('sg-files', ['sgr-minecraft']);
    });

    it('should still revoke the rule when no helper task is found', async () => {
      const ec2 = makeEc2('1.2.3.4', { listIngressRulesByDescriptionPrefix: vi.fn().mockResolvedValue([ruleFor('minecraft')]) });
      const result = await buildService({ ec2 }).stop('minecraft');
      expect(result.success).toBe(false);
      expect(ec2.revokeIngressRules).toHaveBeenCalledWith('sg-files', ['sgr-minecraft']);
    });

    it('should deregister the helper\'s task definition on stop', async () => {
      const { stub, service: ecs } = makeEcs({
        listTasksByStartedBy: vi.fn().mockResolvedValue([{ taskArn: 'arn-1', taskDefinitionArn: 'arn:td/filebrowser-minecraft:3' }]),
      });
      await buildService({ ecs }).stop('minecraft');
      expect(stub.deregisterTaskDefinition).toHaveBeenCalledWith('arn:td/filebrowser-minecraft:3');
    });
  });

  describe('planHelperLayout', () => {
    it('should return null when the stack is not deployed', async () => {
      expect(await buildService({ config: makeConfig(null) }).planHelperLayout('minecraft')).toBeNull();
    });

    it('should plan from the game\'s declared volumes and the exported access points', async () => {
      const outputs = { ...DEFAULT_OUTPUTS, efsVolumeAccessPoints: { minecraft: { config: 'fsap-c' } } };
      const deploymentConfig = deploymentConfigStub({ declared: [gameServer('minecraft', { volumes: TWO_VOLUMES })] });
      const layout = await buildService({ config: makeConfig(outputs), deploymentConfig }).planHelperLayout('minecraft');
      expect(layout?.mounts.map((m) => m.volume)).toEqual(['config']);
      expect(layout?.unmounted).toEqual([{ volume: 'saves', containerPath: '/data/saves' }]);
    });
  });

  describe('launchHelper with upload tags', () => {
    /** Launches the way an upload run does: tagged as a seed-upload session. */
    const launchUpload = (svc: FileManagerService, layout?: HelperVolumeLayout) =>
      svc.launchHelper('minecraft', { runId: 'run-1', tags: UPLOAD_TAGS, layout });

    it('should return the credential and certificate in-process and tag the task as a seed-upload session', async () => {
      const { stub, service: ecs } = makeEcs();
      const result = await launchUpload(buildService({ ecs }));
      if (!result.ok) throw new Error('expected launch to succeed');
      expect(result.credentials.username).toBe('admin');
      expect(result.credentials.password.length).toBeGreaterThan(10);
      expect(result.cert.fingerprint256).toMatch(/^[0-9A-F:]+$/);
      const runArgs = vi.mocked(stub.runTask).mock.calls[0]![0];
      expect(runArgs.startedBy).toBe('filemgr-minecraft');
      expect(runArgs.tags).toEqual([
        { key: 'Purpose', value: 'seed-upload' },
        { key: 'Project', value: 'hyveon' },
        { key: 'OperatorIp', value: '203.0.113.7' },
      ]);
    });

    it('should serve over TLS through a sh -c wrapper that writes the env-provided certificate and key', async () => {
      const { stub, service: ecs } = makeEcs();
      const result = await launchUpload(buildService({ ecs }));
      if (!result.ok) throw new Error('expected launch to succeed');
      const container = vi.mocked(stub.registerTaskDefinition).mock.calls[0]![0].containerDefinitions![0]!;
      expect(container.entryPoint).toEqual(['sh', '-c']);
      expect(container.command![0]).toContain('exec filebrowser --cert /tmp/tls.crt --key /tmp/tls.key "$@"');
      const env = Object.fromEntries(container.environment!.map((e) => [e.name, e.value]));
      expect(Buffer.from(env['FB_TLS_CERT_B64']!, 'base64').toString()).toBe(result.cert.certPem);
      expect(Buffer.from(env['FB_TLS_KEY_B64']!, 'base64').toString()).toBe(result.cert.keyPem);
      expect(container.command).toContain('--username');
    });

    it('should mount a precomputed layout instead of planning its own', async () => {
      const { stub, service: ecs } = makeEcs();
      const deploymentConfig = deploymentConfigStub({ declared: [gameServer('minecraft', { volumes: TWO_VOLUMES })] });
      const layout = buildHelperVolumeLayout('minecraft', TWO_VOLUMES, {
        efsAccessPoints: {},
        efsVolumeAccessPoints: { minecraft: { saves: 'fsap-s' } },
      });
      const svc = buildService({ config: makeConfig(TWO_VOLUME_OUTPUTS), ecs, deploymentConfig });
      const result = await launchUpload(svc, layout);
      if (!result.ok) throw new Error('expected launch to succeed');

      expect(result.layout).toBe(layout);
      expect(deploymentConfig.getGameServers).not.toHaveBeenCalled();
      const regArgs = vi.mocked(stub.registerTaskDefinition).mock.calls[0]![0];
      expect(regArgs.volumes!.map((v) => v.efsVolumeConfiguration!.authorizationConfig!.accessPointId)).toEqual(['fsap-s']);
      expect(regArgs.containerDefinitions![0]!.mountPoints!.map((m) => m.containerPath)).toEqual(['/srv/saves']);
    });

    it('should return the layout it planned itself on the session', async () => {
      const result = await launchUpload(buildService());
      if (!result.ok) throw new Error('expected launch to succeed');
      expect(result.layout.mounts.map((m) => m.accessPointId)).toEqual(['fsap-mc']);
    });

    it('should fail a precomputed layout with no mounts without registering a task definition', async () => {
      const { stub, service: ecs } = makeEcs();
      const empty = buildHelperVolumeLayout('minecraft', TWO_VOLUMES, { efsAccessPoints: {}, efsVolumeAccessPoints: {} });
      const result = await launchUpload(buildService({ ecs }), empty);
      expect(result).toMatchObject({ ok: false, code: 'failed', message: "No EFS access point found for 'minecraft'." });
      expect(stub.registerTaskDefinition).not.toHaveBeenCalled();
    });

    it('should name the run in the security-group rule description', async () => {
      const ec2 = makeEc2();
      await launchUpload(buildService({ ec2 }));
      expect(ec2.authorizeIngress).toHaveBeenCalledWith('sg-files', '203.0.113.7/32', 8080, 'hyveon-filemgr:minecraft:run-1');
    });

    it('should refuse with helper-open when a session is already running, without launching', async () => {
      const { stub, service: ecs } = makeEcs({ listTasksByStartedBy: vi.fn().mockResolvedValue([{ taskArn: 'existing' }]) });
      const result = await launchUpload(buildService({ ecs }));
      expect(result).toMatchObject({ ok: false, code: 'helper-open' });
      expect(stub.runTask).not.toHaveBeenCalled();
    });

    it('should never put the plaintext password in the task definition', async () => {
      const { stub, service: ecs } = makeEcs();
      const result = await launchUpload(buildService({ ecs }));
      if (!result.ok) throw new Error('expected launch to succeed');
      expect(JSON.stringify(vi.mocked(stub.registerTaskDefinition).mock.calls[0]![0])).not.toContain(result.credentials.password);
    });

    it('should only record the operator IP when no tags are given', async () => {
      const { stub, service: ecs } = makeEcs();
      await launchOk(buildService({ ecs }));
      expect(vi.mocked(stub.runTask).mock.calls[0]![0].tags).toEqual([{ key: 'OperatorIp', value: '203.0.113.7' }]);
    });
  });

  describe('launchHelper', () => {
    it('should launch every helper with TLS container settings', async () => {
      const { stub, service: ecs } = makeEcs();
      const outcome = await launchOk(buildService({ ecs }), 'run-1');
      const container = vi.mocked(stub.registerTaskDefinition).mock.calls[0]![0].containerDefinitions![0]!;
      expect(container.entryPoint).toEqual(['sh', '-c']);
      expect(outcome.cert.fingerprint256).toMatch(/^[0-9A-F:]+$/);
    });

    it('should apply the given tags plus the operator IP tag', async () => {
      const { stub, service: ecs } = makeEcs();
      await buildService({ ecs }).launchHelper('minecraft', { runId: 'run-1', tags: UPLOAD_TAGS });
      expect(vi.mocked(stub.runTask).mock.calls[0]![0].tags).toEqual([
        { key: 'Purpose', value: 'seed-upload' },
        { key: 'Project', value: 'hyveon' },
        { key: 'OperatorIp', value: '203.0.113.7' },
      ]);
    });

    it('should report autoStopAt two hours after launch', async () => {
      vi.useFakeTimers();
      try {
        vi.setSystemTime(new Date('2026-10-28T12:00:00Z'));
        const outcome = await buildService().launchHelper('minecraft', { runId: BROWSE_RUN_ID });
        if (!outcome.ok) throw new Error('expected launch to succeed');
        expect(outcome.autoStopAt - outcome.startedAt).toBe(2 * 60 * 60 * 1000);
        expect(outcome.startedAt).toBe(Date.parse('2026-10-28T12:00:00Z'));
      } finally {
        vi.useRealTimers();
      }
    });

    it('should schedule the auto-stop for the reported autoStopAt', async () => {
      const { stub, service: scheduler } = makeScheduler();
      const outcome = await buildService({ scheduler }).launchHelper('minecraft', { runId: BROWSE_RUN_ID });
      if (!outcome.ok) throw new Error('expected launch to succeed');
      expect(vi.mocked(stub.createStopSchedule).mock.calls[0]![0].at.getTime()).toBe(outcome.autoStopAt);
      expect(FILEBROWSER_AUTO_STOP_MS).toBe(2 * 60 * 60 * 1000);
    });

    it('should return the credential, operator IP and planned layout', async () => {
      const outcome = await buildService().launchHelper('minecraft', { runId: BROWSE_RUN_ID });
      if (!outcome.ok) throw new Error('expected launch to succeed');
      expect(outcome).toMatchObject({ taskArn: 'arn-fm', operatorIp: '203.0.113.7', scheduleWarning: '' });
      expect(outcome.credentials.username).toBe('admin');
      expect(outcome.credentials.password.length).toBeGreaterThan(10);
      expect(outcome.layout.mounts.map((m) => m.accessPointId)).toEqual(['fsap-mc']);
    });

    it('should name the run in the security-group rule description', async () => {
      const ec2 = makeEc2();
      await buildService({ ec2 }).launchHelper('minecraft', { runId: 'sess-9' });
      expect(ec2.authorizeIngress).toHaveBeenCalledWith('sg-files', '203.0.113.7/32', 8080, 'hyveon-filemgr:minecraft:sess-9');
    });

    it('should refuse with helper-open when a helper is already running', async () => {
      const { stub, service: ecs } = makeEcs({ listTasksByStartedBy: vi.fn().mockResolvedValue([{ taskArn: 'existing' }]) });
      const outcome = await buildService({ ecs }).launchHelper('minecraft', { runId: BROWSE_RUN_ID });
      expect(outcome).toMatchObject({ ok: false, code: 'helper-open' });
      expect(stub.runTask).not.toHaveBeenCalled();
    });
  });

  describe('listHelperTask', () => {
    it('should return null when the stack is not deployed', async () => {
      expect(await buildService({ config: makeConfig(null) }).listHelperTask('minecraft')).toBeNull();
    });

    it('should return null when no helper is running', async () => {
      expect(await buildService().listHelperTask('minecraft')).toBeNull();
    });

    it('should return the first helper task looked up by the game startedBy key', async () => {
      const first = helperTask('minecraft', '198.51.100.1');
      const { stub, service: ecs } = makeEcs({ listTasksByStartedBy: vi.fn().mockResolvedValue([first, helperTask('other', null)]) });
      expect(await buildService({ ecs }).listHelperTask('minecraft')).toBe(first);
      expect(stub.listTasksByStartedBy).toHaveBeenCalledWith('game-cluster', 'filemgr-minecraft');
    });
  });

  describe('reauthorizeOperatorIp', () => {
    const OLD_IP = '198.51.100.1';
    const NEW_IP = '198.51.100.2';

    it('should authorize the new IP with the run rule description and re-tag the task', async () => {
      const ec2 = makeEc2();
      const { stub, service: ecs } = makeEcs();
      await buildService({ ec2, ecs }).reauthorizeOperatorIp('minecraft', BROWSE_RUN_ID, 'arn-minecraft', NEW_IP);
      expect(ec2.authorizeIngress).toHaveBeenCalledWith('sg-files', `${NEW_IP}/32`, 8080, 'hyveon-filemgr:minecraft:browse');
      expect(stub.tagTask).toHaveBeenCalledWith('game-cluster', 'arn-minecraft', [{ key: 'OperatorIp', value: NEW_IP }]);
    });

    it('should revoke the old rule when no other helper still carries the old IP', async () => {
      const ec2 = makeEc2('1.2.3.4', { listIngressRulesByDescriptionPrefix: vi.fn().mockResolvedValue([sgRule('minecraft', OLD_IP)]) });
      const { service: ecs } = makeEcs({ listTasksByStartedByPrefix: vi.fn().mockResolvedValue([helperTask('minecraft', NEW_IP)]) });
      await buildService({ ec2, ecs }).reauthorizeOperatorIp('minecraft', BROWSE_RUN_ID, 'arn-minecraft', NEW_IP);
      expect(ec2.revokeIngressRules).toHaveBeenCalledWith('sg-files', [`sgr-minecraft-${OLD_IP}`]);
    });

    it('should keep the old rule while another helper still carries the old IP', async () => {
      const ec2 = makeEc2('1.2.3.4', { listIngressRulesByDescriptionPrefix: vi.fn().mockResolvedValue([sgRule('minecraft', OLD_IP)]) });
      const { service: ecs } = makeEcs({
        listTasksByStartedByPrefix: vi.fn().mockResolvedValue([helperTask('minecraft', NEW_IP), helperTask('valheim', OLD_IP)]),
      });
      await buildService({ ec2, ecs }).reauthorizeOperatorIp('minecraft', BROWSE_RUN_ID, 'arn-minecraft', NEW_IP);
      expect(ec2.revokeIngressRules).toHaveBeenCalledWith('sg-files', []);
    });

    it('should keep the new IP rule even when the helper listing has not picked up the re-tag', async () => {
      const ec2 = makeEc2('1.2.3.4', {
        listIngressRulesByDescriptionPrefix: vi.fn().mockResolvedValue([sgRule('minecraft', OLD_IP), sgRule('minecraft', NEW_IP)]),
      });
      const { service: ecs } = makeEcs({ listTasksByStartedByPrefix: vi.fn().mockResolvedValue([helperTask('valheim', '198.51.100.9')]) });
      await buildService({ ec2, ecs }).reauthorizeOperatorIp('minecraft', BROWSE_RUN_ID, 'arn-minecraft', NEW_IP);
      expect(ec2.revokeIngressRules).toHaveBeenCalledWith('sg-files', [`sgr-minecraft-${OLD_IP}`]);
    });

    it('should keep every rule when the helper listing fails', async () => {
      const ec2 = makeEc2();
      const { service: ecs } = makeEcs({ listTasksByStartedByPrefix: vi.fn().mockRejectedValue(new Error('throttled')) });
      await buildService({ ec2, ecs }).reauthorizeOperatorIp('minecraft', BROWSE_RUN_ID, 'arn-minecraft', NEW_IP);
      expect(ec2.revokeIngressRules).not.toHaveBeenCalled();
    });

    it('should throw a plain Error and skip the re-tag when authorizing the new IP fails', async () => {
      const ec2 = makeEc2('1.2.3.4', { authorizeIngress: vi.fn().mockRejectedValue(new Error('rule limit')) });
      const { stub, service: ecs } = makeEcs();
      await expect(buildService({ ec2, ecs }).reauthorizeOperatorIp('minecraft', BROWSE_RUN_ID, 'arn-minecraft', NEW_IP)).rejects.toThrow('rule limit');
      expect(stub.tagTask).not.toHaveBeenCalled();
    });

    it('should throw a plain Error when re-tagging the task fails', async () => {
      const { service: ecs } = makeEcs({ tagTask: vi.fn().mockRejectedValue(new Error('tag denied')) });
      await expect(buildService({ ecs }).reauthorizeOperatorIp('minecraft', BROWSE_RUN_ID, 'arn-minecraft', NEW_IP)).rejects.toThrow('tag denied');
    });

    it('should throw when the stack is not deployed', async () => {
      await expect(
        buildService({ config: makeConfig(null) }).reauthorizeOperatorIp('minecraft', BROWSE_RUN_ID, 'arn-minecraft', NEW_IP),
      ).rejects.toThrow('Infrastructure not deployed.');
    });
  });

  describe('getHelperPublicIp', () => {
    it('should return the IP once the task is running', async () => {
      const { service: ecs } = makeEcs({
        listTasksByStartedBy: vi.fn().mockResolvedValue([{ taskArn: 'a', lastStatus: 'RUNNING' }]),
        extractEniId: vi.fn().mockReturnValue('eni-1'),
      });
      expect(await buildService({ ecs, ec2: makeEc2('5.6.7.8') }).getHelperPublicIp('minecraft')).toBe('5.6.7.8');
    });

    it('should return null while the task is still provisioning', async () => {
      const { service: ecs } = makeEcs({ listTasksByStartedBy: vi.fn().mockResolvedValue([{ taskArn: 'a', lastStatus: 'PROVISIONING' }]) });
      expect(await buildService({ ecs }).getHelperPublicIp('minecraft')).toBeNull();
    });

    it('should throw the ECS stop reason when the launched task stopped before it was reachable', async () => {
      const { service: ecs } = makeEcs({
        listTasksByStartedBy: vi.fn().mockResolvedValue([]),
        describeStoppedReason: vi.fn().mockResolvedValue('CannotPullContainerError: rate limit'),
      });
      await expect(buildService({ ecs }).getHelperPublicIp('minecraft', 'arn-1')).rejects.toThrow(
        'stopped before it was reachable: CannotPullContainerError: rate limit',
      );
    });

    it('should ignore a listed task that is not the launched one and surface the launched task stop reason', async () => {
      const { service: ecs } = makeEcs({
        listTasksByStartedBy: vi.fn().mockResolvedValue([{ taskArn: 'other', lastStatus: 'RUNNING' }]),
        describeStoppedReason: vi.fn().mockResolvedValue('boom'),
      });
      await expect(buildService({ ecs }).getHelperPublicIp('minecraft', 'arn-1')).rejects.toThrow('boom');
    });

    it('should return null when no task is listed and the launched task has not stopped', async () => {
      const { service: ecs } = makeEcs({
        listTasksByStartedBy: vi.fn().mockResolvedValue([]),
        describeStoppedReason: vi.fn().mockResolvedValue(null),
      });
      expect(await buildService({ ecs }).getHelperPublicIp('minecraft', 'arn-1')).toBeNull();
    });
  });

  describe('getHelperStopReason', () => {
    it('should return the ECS stop reason for the task', async () => {
      const { service: ecs } = makeEcs({ describeStoppedReason: vi.fn().mockResolvedValue('boom') });
      expect(await buildService({ ecs }).getHelperStopReason('arn-1')).toBe('boom');
    });
  });

  describe('sweepStrayHelpers', () => {
    const minutesAgo = (m: number) => new Date(Date.now() - m * 60_000);
    const task = (game: string, ageMin: number, extra: Partial<Task> = {}): Task => ({
      taskArn: `arn-${game}`,
      startedBy: `filemgr-${game}`,
      startedAt: minutesAgo(ageMin),
      taskDefinitionArn: `arn:td/filebrowser-${game}:1`,
      lastStatus: 'RUNNING',
      ...extra,
    });

    it('should stop old un-owned helpers, deregister their task definitions, and report them', async () => {
      const { stub, service: ecs } = makeEcs({ listTasksByStartedByPrefix: vi.fn().mockResolvedValue([task('minecraft', 30)]) });
      const report = await buildService({ ecs }).sweepStrayHelpers({ activeGames: new Set(), minAgeMs: 15 * 60_000 });
      expect(stub.stopTask).toHaveBeenCalledWith('game-cluster', 'arn-minecraft', expect.any(String));
      expect(stub.deregisterTaskDefinition).toHaveBeenCalledWith('arn:td/filebrowser-minecraft:1');
      expect(report.stopped).toEqual([{ game: 'minecraft', taskArn: 'arn-minecraft', ageMinutes: 30 }]);
      expect(stub.listTasksByStartedByPrefix).toHaveBeenCalledWith('game-cluster', 'filemgr-');
    });

    it('should leave helpers younger than the threshold and helpers owned by an active run', async () => {
      const { stub, service: ecs } = makeEcs({
        listTasksByStartedByPrefix: vi.fn().mockResolvedValue([task('minecraft', 5), task('palworld', 60)]),
      });
      const report = await buildService({ ecs }).sweepStrayHelpers({ activeGames: new Set(['palworld']), minAgeMs: 15 * 60_000 });
      expect(stub.stopTask).not.toHaveBeenCalled();
      expect(report).toMatchObject({ stopped: [], skipped: 2 });
    });

    it('should stop everything regardless of age on an explicit operator action (minAgeMs 0)', async () => {
      const { stub, service: ecs } = makeEcs({ listTasksByStartedByPrefix: vi.fn().mockResolvedValue([task('minecraft', 1)]) });
      const report = await buildService({ ecs }).sweepStrayHelpers({ activeGames: new Set(), minAgeMs: 0 });
      expect(stub.stopTask).toHaveBeenCalledTimes(1);
      expect(report.stopped).toHaveLength(1);
    });

    it('should revoke stale app rules but keep rules of active games when no helper remains', async () => {
      const rules = ['stale', 'active'].map((g) => sgRule(g, '9.9.9.9'));
      const { service: ecs } = makeEcs({ listTasksByStartedByPrefix: vi.fn().mockResolvedValue([]) });
      const ec2 = makeEc2('1.2.3.4', { listIngressRulesByDescriptionPrefix: vi.fn().mockResolvedValue(rules) });
      const report = await buildService({ ecs, ec2 }).sweepStrayHelpers({ activeGames: new Set(['active']), minAgeMs: 15 * 60_000 });
      expect(ec2.revokeIngressRules).toHaveBeenCalledWith('sg-files', ['sgr-stale-9.9.9.9']);
      expect(report.revokedRules).toBe(1);
    });

    it('should record a failed stop as an error and keep that game\'s rule', async () => {
      const rule = { ruleId: 'sgr-m', description: 'hyveon-filemgr:minecraft:r', cidr: 'x' };
      const { service: ecs } = makeEcs({
        listTasksByStartedByPrefix: vi.fn().mockResolvedValue([task('minecraft', 60)]),
        stopTask: vi.fn().mockRejectedValue(new Error('throttled')),
      });
      const ec2 = makeEc2('1.2.3.4', { listIngressRulesByDescriptionPrefix: vi.fn().mockResolvedValue([rule]) });
      const report = await buildService({ ecs, ec2 }).sweepStrayHelpers({ activeGames: new Set(), minAgeMs: 0 });
      expect(report.errors).toEqual(['minecraft: throttled']);
      expect(report.stopped).toEqual([]);
      expect(ec2.revokeIngressRules).not.toHaveBeenCalled();
    });

    it('should record the error and revoke nothing when the helper listing fails', async () => {
      const rules = [{ ruleId: 'sgr-g', description: 'hyveon-filemgr:minecraft:r', cidr: 'x' }];
      const { stub, service: ecs } = makeEcs({ listTasksByStartedByPrefix: vi.fn().mockRejectedValue(new Error('throttled')) });
      const ec2 = makeEc2('1.2.3.4', { listIngressRulesByDescriptionPrefix: vi.fn().mockResolvedValue(rules) });
      const report = await buildService({ ecs, ec2 }).sweepStrayHelpers({ activeGames: new Set(), minAgeMs: 0 });
      expect(report.errors).toEqual([expect.stringContaining('throttled')]);
      expect(report.revokedRules).toBe(0);
      expect(ec2.revokeIngressRules).not.toHaveBeenCalled();
      expect(stub.stopTask).not.toHaveBeenCalled();
    });

    it('should keep a shared rule described after a swept game while a remaining helper uses the same IP', async () => {
      const rules = [sgRule('minecraft', '1.1.1.1')];
      const { service: ecs } = makeEcs({
        listTasksByStartedByPrefix: vi.fn().mockResolvedValue([
          task('minecraft', 60, helperTask('minecraft', '1.1.1.1')),
          task('palworld', 1, helperTask('palworld', '1.1.1.1')),
        ]),
      });
      const ec2 = makeEc2('1.2.3.4', { listIngressRulesByDescriptionPrefix: vi.fn().mockResolvedValue(rules) });
      const report = await buildService({ ecs, ec2 }).sweepStrayHelpers({ activeGames: new Set(), minAgeMs: 15 * 60_000 });
      expect(report.stopped).toHaveLength(1);
      expect(ec2.revokeIngressRules).toHaveBeenCalledWith('sg-files', []);
      expect(report.revokedRules).toBe(0);
    });

    it('should revoke a swept game\'s old-IP rule while a remaining helper keeps its own IP rule', async () => {
      const rules = [sgRule('minecraft', '1.1.1.1'), sgRule('palworld', '2.2.2.2')];
      const { service: ecs } = makeEcs({
        listTasksByStartedByPrefix: vi.fn().mockResolvedValue([
          task('minecraft', 60, helperTask('minecraft', '1.1.1.1')),
          task('palworld', 1, helperTask('palworld', '2.2.2.2')),
        ]),
      });
      const ec2 = makeEc2('1.2.3.4', { listIngressRulesByDescriptionPrefix: vi.fn().mockResolvedValue(rules) });
      const report = await buildService({ ecs, ec2 }).sweepStrayHelpers({ activeGames: new Set(), minAgeMs: 15 * 60_000 });
      expect(ec2.revokeIngressRules).toHaveBeenCalledWith('sg-files', ['sgr-minecraft-1.1.1.1']);
      expect(report.revokedRules).toBe(1);
    });

    it('should revoke an orphaned rule carrying another game\'s description', async () => {
      const rules = [sgRule('ghost', '3.3.3.3'), sgRule('palworld', '2.2.2.2')];
      const { service: ecs } = makeEcs({
        listTasksByStartedByPrefix: vi.fn().mockResolvedValue([task('palworld', 1, helperTask('palworld', '2.2.2.2'))]),
      });
      const ec2 = makeEc2('1.2.3.4', { listIngressRulesByDescriptionPrefix: vi.fn().mockResolvedValue(rules) });
      await buildService({ ecs, ec2 }).sweepStrayHelpers({ activeGames: new Set(), minAgeMs: 15 * 60_000 });
      expect(ec2.revokeIngressRules).toHaveBeenCalledWith('sg-files', ['sgr-ghost-3.3.3.3']);
    });

    it('should return an empty report when nothing is deployed', async () => {
      const report = await buildService({ config: makeConfig(null) }).sweepStrayHelpers({ activeGames: new Set(), minAgeMs: 0 });
      expect(report).toEqual({ stopped: [], skipped: 0, revokedRules: 0, errors: [] });
    });
  });
});
