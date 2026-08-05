import { Inject, Injectable } from '@nestjs/common';
import { randomBytes } from 'node:crypto';
import { hash as bcryptHash } from 'bcryptjs';
import { type Task } from '@aws-sdk/client-ecs';
import { type SecretsStore } from '@hyveon/shared';
import { logger } from '../logger.js';
import { ConfigService } from './ConfigService.js';
import { EcsService } from './EcsService.js';
import { Ec2Service } from './Ec2Service.js';
import { SchedulerService } from './SchedulerService.js';
import { SECRETS_STORE } from '../modules/cloud-provider.tokens.js';

const FILEBROWSER_IMAGE = 'filebrowser/filebrowser:latest';
const FILEBROWSER_PORT = 8080;
const STARTED_BY_PREFIX = 'filemgr-';
/** Fixed admin username the per-launch credential is created under — only the password is randomized/rotated. */
const FILEBROWSER_USERNAME = 'admin';
/** Entropy (bytes, before base64url encoding) for the per-launch FileBrowser password. */
const FILEBROWSER_PASSWORD_BYTES = 18;
/** `bcrypt` cost factor for hashing the per-launch password before it's handed to FileBrowser's `--password` flag. */
const FILEBROWSER_BCRYPT_ROUNDS = 10;
/**
 * How long a launched FileBrowser task is allowed to run before it is
 * auto-stopped via an EventBridge Scheduler one-time schedule — the fix for
 * "no auto-shutdown, a forgotten session runs (and bills) indefinitely"
 * (issue #350, folding in #346's watchdog-coverage gap: the watchdog Lambda
 * only ever looks at `{game}-server` tasks, never `filemgr-*` ones). Two
 * hours is generous for an interactive file-browsing session while still
 * bounding the worst case if an operator forgets to click Stop.
 */
const FILEBROWSER_AUTO_STOP_MS = 2 * 60 * 60 * 1000;
/** Prefix for the auto-stop schedule's name — combined with the game name, so `stop()` can recompute it without persisting extra state (see this file's "one file manager per game at a time" invariant). */
const AUTO_STOP_SCHEDULE_PREFIX = 'filemgr-stop-';

/**
 * Snapshot of the FileBrowser helper's state for a single game.
 * `url` is only set once the task is RUNNING and its ENI has resolved a
 * public IP — otherwise the UI shows the provisioning message.
 *
 * Deliberately carries no credential field: this is the shape `getStatus()`
 * returns, polled repeatedly for as long as the modal is open, and the
 * per-launch credential must be shown to the operator exactly once (in
 * {@link FileMgrResult}, `start()`'s own return value) — never resurfaced by
 * a later poll.
 */
export interface FileMgrStatus {
  game: string;
  state: 'running' | 'starting' | 'stopped' | 'not_deployed';
  url?: string;
  taskArn?: string;
}

/** The plaintext credential a FileBrowser launch was just seeded with — shown to the operator exactly once, in {@link FileMgrResult.credentials}. */
export interface FileMgrCredentials {
  username: string;
  password: string;
}

/** Start/stop result shape — mirrors {@link EcsService}'s `StartResult`. */
export interface FileMgrResult {
  success: boolean;
  message: string;
  taskArn?: string;
  /** Only present on a successful `start()` — the one-time plaintext credential for this launch. Never returned by `getStatus()`/`stop()`. */
  credentials?: FileMgrCredentials;
}

/**
 * Launches an on-demand FileBrowser container per game so operators can
 * browse/edit that game's save data over HTTP without SSH. Uses the game's
 * own EFS access point (for isolation), registers a throwaway task
 * definition each time, and tags tasks with `startedBy: filemgr-{game}` so
 * we can find and stop them later.
 *
 * Two hardening measures beyond the base launch/stop flow (issue #350,
 * folding in #346):
 *
 *  - **Authentication.** Every launch generates a random password, bcrypt-
 *    hashes it, and passes the hash straight to FileBrowser's `--password`
 *    flag (which — per FileBrowser's own CLI docs — expects an already-hashed
 *    value, not plaintext) alongside `--username`, replacing the previous
 *    `--noauth` flag. Command-line flags are used rather than the
 *    container's `FB_PASSWORD` env var for the same reason `start()`'s
 *    existing comment prefers flags generally: FileBrowser's own issue
 *    tracker documents `FB_PASSWORD`-via-env sometimes failing to take effect
 *    on first-run database init, where the `--password` flag is reliable.
 *    The hash is also written to Secrets Manager (via the same
 *    {@link SecretsStore} contract `DiscordConfigService` uses for its bot
 *    token) purely as an audit record of the most recent launch's
 *    credential — the container itself never reads it back from there.
 *  - **Auto-stop.** Right after `RunTask` succeeds, a one-time EventBridge
 *    Scheduler schedule is created that calls `ecs:StopTask` on the new task
 *    directly (a "universal target" — no Lambda) after
 *    {@link FILEBROWSER_AUTO_STOP_MS}. `stop()` deletes that schedule again
 *    so a manual stop doesn't leave a stale one behind.
 */
@Injectable()
export class FileManagerService {
  constructor(
    private readonly config: ConfigService,
    private readonly ecs: EcsService,
    private readonly ec2: Ec2Service,
    private readonly scheduler: SchedulerService,
    @Inject(SECRETS_STORE) private readonly secrets: SecretsStore,
  ) {}

  /** The auto-stop schedule's name for `game` — deterministic so `stop()` can recompute it without persisting extra state. */
  private scheduleName(game: string): string {
    return `${AUTO_STOP_SCHEDULE_PREFIX}${game}`;
  }

  /** Generates a random per-launch password. URL-safe base64 so it's never mangled if displayed inline in a link or copy-pasted from the UI. */
  private static generatePassword(): string {
    return randomBytes(FILEBROWSER_PASSWORD_BYTES).toString('base64url');
  }

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
        message: `Could not get execution role for '${game}'. Ensure the game's task definition exists — run plan and apply on the Infrastructure page to deploy it.`,
      };
    }

    const region = this.config.getRegion();
    const logGroup = `/ecs/filebrowser-${game}`;
    const family = `filebrowser-${game}`;

    // Generate a fresh credential for this launch and hash it — the hash
    // (never the plaintext) is what's passed to FileBrowser's `--password`
    // flag below and what's recorded in Secrets Manager. The plaintext is
    // returned to the caller exactly once, at the end of this method.
    const password = FileManagerService.generatePassword();
    const passwordHash = await bcryptHash(password, FILEBROWSER_BCRYPT_ROUNDS);

    if (outputs.fileBrowserCredentialSecretArn) {
      try {
        await this.secrets.put(outputs.fileBrowserCredentialSecretArn, passwordHash);
      } catch (err) {
        // Best-effort audit record only — the container itself gets the hash
        // directly via the command flags below, so a Secrets Manager write
        // failure must not block the launch.
        logger.error('Failed to record FileBrowser credential hash in Secrets Manager', { err, game });
      }
    }

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
          // Use command flags instead of env vars — more reliable across image
          // versions, and FileBrowser's own `--password` flag docs confirm it
          // takes an already-hashed value, so the bcrypt hash computed above
          // goes straight in with no extra plaintext-handling step.
          command: [
            '--username', FILEBROWSER_USERNAME,
            '--password', passwordHash,
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
      if (outputs.fileBrowserSchedulerRoleArn) {
        // Best-effort: a failed auto-stop schedule must not fail the launch
        // itself (the operator can still stop the task manually) — see
        // `SchedulerService.createStopSchedule`'s doc.
        await this.scheduler.createStopSchedule({
          name: this.scheduleName(game),
          cluster: outputs.ecsClusterName,
          taskArn: result.taskArn,
          roleArn: outputs.fileBrowserSchedulerRoleArn,
          at: new Date(Date.now() + FILEBROWSER_AUTO_STOP_MS),
        });
      } else {
        logger.warn('fileBrowserSchedulerRoleArn not in the deployed stack outputs — FileBrowser task will not auto-stop', { game });
      }

      return {
        success: true,
        message: `File manager for '${game}' is starting. It will be ready in ~30 seconds.`,
        taskArn: result.taskArn,
        credentials: { username: FILEBROWSER_USERNAME, password },
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
      // Best-effort: the task is already stopping either way; a schedule
      // that fails to delete just fires a no-op StopTask against an already-
      // stopped task later (or, if it already fired/self-deleted, does
      // nothing at all).
      await this.scheduler.deleteSchedule(this.scheduleName(game));
      return { success: true, message: `File manager for '${game}' is stopping.` };
    } catch (err) {
      logger.error('Failed to stop file manager', { err, game });
      return { success: false, message: String(err) };
    }
  }
}
