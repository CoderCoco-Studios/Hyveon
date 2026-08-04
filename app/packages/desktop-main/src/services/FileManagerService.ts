import { Injectable } from '@nestjs/common';
import { type Task } from '@aws-sdk/client-ecs';
import { logger } from '../logger.js';
import { ConfigService } from './ConfigService.js';
import { EcsService } from './EcsService.js';
import { Ec2Service } from './Ec2Service.js';

const FILEBROWSER_IMAGE = 'filebrowser/filebrowser:latest';
const FILEBROWSER_PORT = 8080;
const STARTED_BY_PREFIX = 'filemgr-';

/**
 * Snapshot of the FileBrowser helper's state for a single game.
 * `url` is only set once the task is RUNNING and its ENI has resolved a
 * public IP — otherwise the UI shows the provisioning message.
 */
export interface FileMgrStatus {
  game: string;
  state: 'running' | 'starting' | 'stopped' | 'not_deployed';
  url?: string;
  taskArn?: string;
}

/** Start/stop result shape — mirrors {@link EcsService}'s `StartResult`. */
export interface FileMgrResult {
  success: boolean;
  message: string;
  taskArn?: string;
}

/**
 * Launches an on-demand FileBrowser container per game so operators can
 * browse/edit that game's save data over HTTP without SSH. Uses the game's
 * own EFS access point (for isolation), registers a throwaway task
 * definition each time, and tags tasks with `startedBy: filemgr-{game}` so
 * we can find and stop them later.
 */
@Injectable()
export class FileManagerService {
  constructor(
    private readonly config: ConfigService,
    private readonly ecs: EcsService,
    private readonly ec2: Ec2Service,
  ) {}

  private startedByKey(game: string): string {
    return `${STARTED_BY_PREFIX}${game}`;
  }

  /**
   * Look up the FileBrowser task for `game` (via its `startedBy` tag) and
   * resolve the public URL if it's running.
   */
  async getStatus(game: string): Promise<FileMgrStatus> {
    const outputs = await this.config.getStackOutputs();
    if (!outputs) return { game, state: 'not_deployed' };

    const tasks = await this.ecs.listTasksByStartedBy(
      outputs.ecsClusterName,
      this.startedByKey(game),
    );

    if (!tasks.length) return { game, state: 'stopped' };

    const task = tasks[0]!;
    if (task.lastStatus === 'RUNNING') {
      const eniId = this.ecs.extractEniId(task);
      const publicIp = eniId ? await this.ec2.getPublicIp(eniId) : null;
      const url = publicIp ? `http://${publicIp}:${FILEBROWSER_PORT}` : undefined;
      logger.debug('File manager status', { game, publicIp, url });
      return { game, state: 'running', url, taskArn: task.taskArn };
    }

    return { game, state: 'starting', taskArn: task.taskArn };
  }

  /**
   * Register a fresh FileBrowser task definition for `game`, mounting its
   * EFS access point, then launch it in the file-manager security group
   * (which exposes port 8080, whereas the game SG exposes game ports only).
   * Refuses to start a second task if one is already running.
   */
  async start(game: string): Promise<FileMgrResult> {
    const outputs = await this.config.getStackOutputs();
    if (!outputs) {
      return { success: false, message: "Infrastructure not deployed. Deploy first." };
    }

    const apId = outputs.efsAccessPoints[game];
    if (!apId) {
      logger.error('No EFS access point for game', { game, available: outputs.efsAccessPoints });
      return { success: false, message: `No EFS access point found for '${game}'.` };
    }

    const filemgrSg = outputs.fileManagerSecurityGroupId;
    if (!filemgrSg) {
      return { success: false, message: 'fileManagerSecurityGroupId not in the deployed stack outputs. Deploy first.' };
    }

    // Guard: don't start if already running
    const existing = await this.ecs.listTasksByStartedBy(outputs.ecsClusterName, this.startedByKey(game));
    if (existing.length) {
      return { success: false, message: `File manager for '${game}' is already running.` };
    }

    // Get execution role from the game's own task definition
    const taskDef = await this.ecs.getTaskDefinition(game);
    if (!taskDef?.executionRoleArn) {
      logger.error('Could not get execution role ARN', { game, taskDef });
      return {
        success: false,
        message: `Could not get execution role for '${game}'. Ensure the game's task definition exists (run terraform apply).`,
      };
    }

    const region = this.config.getRegion();
    const logGroup = `/ecs/filebrowser-${game}`;
    const family = `filebrowser-${game}`;

    logger.info('Registering FileBrowser task definition', { game, family, apId, logGroup });

    const registered = await this.ecs.registerTaskDefinition({
      family,
      networkMode: 'awsvpc',
      requiresCompatibilities: ['FARGATE'],
      cpu: '256',
      memory: '512',
      executionRoleArn: taskDef.executionRoleArn,
      volumes: [
        {
          name: 'game-data',
          efsVolumeConfiguration: {
            fileSystemId: outputs.efsFileSystemId,
            transitEncryption: 'ENABLED',
            authorizationConfig: { accessPointId: apId, iam: 'DISABLED' },
          },
        },
      ],
      containerDefinitions: [
        {
          name: 'filebrowser',
          image: FILEBROWSER_IMAGE,
          essential: true,
          // Use command flags instead of env vars — more reliable across image versions
          command: [
            '--noauth',
            '--root', '/srv',
            '--port', String(FILEBROWSER_PORT),
            '--address', '0.0.0.0',
            '--database', '/tmp/filebrowser.db',
          ],
          portMappings: [
            { containerPort: FILEBROWSER_PORT, hostPort: FILEBROWSER_PORT, protocol: 'tcp' },
          ],
          mountPoints: [{ sourceVolume: 'game-data', containerPath: '/srv', readOnly: false }],
          logConfiguration: {
            logDriver: 'awslogs',
            options: {
              'awslogs-group': logGroup,
              'awslogs-region': region,
              'awslogs-stream-prefix': 'ecs',
              'awslogs-create-group': 'true',
            },
          },
        },
      ],
    });

    if (!registered) {
      return { success: false, message: `Failed to register FileBrowser task definition for '${game}'. Check server logs.` };
    }

    const subnets = outputs.subnetIds;
    logger.info('Launching FileBrowser task', { game, subnets, sg: filemgrSg });

    const result = await this.ecs.runTask({
      cluster: outputs.ecsClusterName,
      taskDefinition: family,
      count: 1,
      launchType: 'FARGATE',
      startedBy: this.startedByKey(game),
      networkConfiguration: {
        awsvpcConfiguration: {
          subnets,
          securityGroups: [filemgrSg],
          assignPublicIp: 'ENABLED',
        },
      },
    });

    if (result) {
      return {
        success: true,
        message: `File manager for '${game}' is starting. It will be ready in ~30 seconds.`,
        taskArn: result.taskArn,
      };
    }
    return { success: false, message: `Failed to launch file manager for '${game}'. Check server logs for details.` };
  }

  /**
   * Stop the FileBrowser task for `game`. Locates it by `startedBy` tag
   * rather than task-def family since multiple revisions may have been
   * registered across restarts.
   */
  async stop(game: string): Promise<FileMgrResult> {
    const outputs = await this.config.getStackOutputs();
    if (!outputs) return { success: false, message: 'Infrastructure not deployed.' };

    const tasks = await this.ecs.listTasksByStartedBy(
      outputs.ecsClusterName,
      this.startedByKey(game),
    );

    if (!tasks.length) {
      return { success: false, message: `No file manager running for '${game}'.` };
    }

    const task = tasks[0] as Task;
    logger.info('Stopping file manager', { game, taskArn: task.taskArn });
    try {
      await this.ecs.stopTask(outputs.ecsClusterName, task.taskArn!, 'Stopped via management app');
      return { success: true, message: `File manager for '${game}' is stopping.` };
    } catch (err) {
      logger.error('Failed to stop file manager', { err, game });
      return { success: false, message: String(err) };
    }
  }
}
