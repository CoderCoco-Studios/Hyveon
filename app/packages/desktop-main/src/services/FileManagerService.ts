import { Inject, Injectable } from '@nestjs/common';
import { randomBytes } from 'node:crypto';
import { hash as bcryptHash } from 'bcryptjs';
import { type Task } from '@aws-sdk/client-ecs';
import { errMessage, type SecretsStore, type StackOutputs } from '@hyveon/shared';
import type { StrayHelperReport } from '@hyveon/shared/folderUpload';
import { logger } from '../logger.js';
import { ConfigService } from './ConfigService.js';
import { EcsService } from './EcsService.js';
import { Ec2Service } from './Ec2Service.js';
import { SchedulerService } from './SchedulerService.js';
import { PublicIpService } from './PublicIpService.js';
import { generateEphemeralCert, type EphemeralCert } from './folderUpload/ephemeralCert.js';
import { buildTlsContainerSettings } from './folderUpload/tlsLaunch.js';
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
/** Prefix of the description on every security-group rule the app adds for a helper, so cleanup can find them. */
const SG_RULE_DESCRIPTION_PREFIX = 'hyveon-filemgr:';
/** Run id used in the rule description for ordinary (dashboard) browse sessions. */
const BROWSE_RUN_ID = 'browse';
/** Tags applied to upload helpers so they are identifiable as upload sessions. */
const UPLOAD_TAGS = [
  { key: 'Purpose', value: 'seed-upload' },
  { key: 'Project', value: 'hyveon' },
];

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

/**
 * A launched upload helper. Carries the plaintext credential, so it exists only in main-process memory: never return
 * it over IPC and never log it.
 */
export interface UploadHelperSession {
  taskArn: string;
  runId: string;
  credentials: FileMgrCredentials;
  cert: EphemeralCert;
}

/** Outcome of {@link FileManagerService.startForUpload}. */
export type UploadHelperLaunch =
  | { ok: true; session: UploadHelperSession }
  | { ok: false; code: 'helper-open' | 'failed'; message: string };

/** Internal outcome of a launch, before it is shaped into a public result. */
type LaunchOutcome =
  | { ok: true; taskArn: string; password: string; scheduleWarning: string; cert?: EphemeralCert }
  | { ok: false; code: 'helper-open' | 'failed'; message: string };

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
    private readonly publicIp: PublicIpService,
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

  /** Description stamped on the operator-IP rule for `game`'s `runId`, so cleanup can map a rule back to a run. */
  private ruleDescription(game: string, runId: string): string {
    return `${SG_RULE_DESCRIPTION_PREFIX}${game}:${runId}`;
  }

  /** The game encoded in an app-created rule description, or `null` when it is not one of ours. */
  private static gameOfRule(description: string): string | null {
    if (!description.startsWith(SG_RULE_DESCRIPTION_PREFIX)) return null;
    return description.slice(SG_RULE_DESCRIPTION_PREFIX.length).split(':')[0] ?? null;
  }

  /**
   * Revokes the app-created ingress rules on `securityGroupId` that `shouldRevoke` accepts (by game).
   *
   * @returns How many rules were revoked.
   */
  private async revokeAppRules(securityGroupId: string, shouldRevoke: (game: string) => boolean): Promise<number> {
    const rules = await this.ec2.listIngressRulesByDescriptionPrefix(securityGroupId, SG_RULE_DESCRIPTION_PREFIX);
    const ids = rules
      .filter((r) => {
        const game = FileManagerService.gameOfRule(r.description);
        return game !== null && shouldRevoke(game);
      })
      .map((r) => r.ruleId);
    const ok = await this.ec2.revokeIngressRules(securityGroupId, ids);
    return ok ? ids.length : 0;
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
      const publicIp = await this.publicIpOf(task);
      const url = publicIp ? `http://${publicIp}:${FILEBROWSER_PORT}` : undefined;
      logger.debug('File manager status', { game, publicIp, url });
      return { game, state: 'running', url, taskArn: task.taskArn };
    }

    return { game, state: 'starting', taskArn: task.taskArn };
  }

  /** Resolves the public IPv4 of a running helper task, or `null` while its ENI has no public address yet. */
  private async publicIpOf(task: Task): Promise<string | null> {
    const eniId = this.ecs.extractEniId(task);
    return eniId ? this.ec2.getPublicIp(eniId) : null;
  }

  /**
   * The helper's public IP once its task is RUNNING and its ENI has an address; `null` before that (or when no helper
   * exists). Used by the upload service to wait for the helper without going through the HTTP-flavoured status URL.
   */
  async getHelperPublicIp(game: string): Promise<string | null> {
    const outputs = await this.config.getStackOutputs();
    if (!outputs) return null;
    const tasks = await this.ecs.listTasksByStartedBy(outputs.ecsClusterName, this.startedByKey(game));
    const task = tasks[0];
    return task && task.lastStatus === 'RUNNING' ? this.publicIpOf(task) : null;
  }

  /**
   * Register a fresh FileBrowser task definition for `game`, mounting its
   * EFS access point, then launch it in the file-manager security group
   * (which exposes port 8080 only to the operator's IP, via an app-added
   * `/32` rule). Refuses to start a second task if one is already running.
   */
  async start(game: string): Promise<FileMgrResult> {
    const outcome = await this.launch(game, null);
    if (!outcome.ok) return { success: false, message: outcome.message };
    return {
      success: true,
      message: `File manager for '${game}' is starting. It will be ready in ~30 seconds.${outcome.scheduleWarning}`,
      taskArn: outcome.taskArn,
      credentials: { username: FILEBROWSER_USERNAME, password: outcome.password },
    };
  }

  /**
   * Launches an upload helper for `game`: tagged `Purpose=seed-upload`/`Project=hyveon`, served over HTTPS with a
   * per-launch certificate the caller pins. The credential is returned in-process only.
   *
   * @remarks
   * If a helper for `game` is already open the launch is refused with `code: 'helper-open'`, because the credential of
   * that session is unknown here. The caller is responsible for {@link FileManagerService.stop}, which also revokes the
   * IP rule and deregisters the task definition.
   *
   * @param runId - Identifies the upload run; embedded in the security-group rule description.
   */
  async startForUpload(game: string, runId: string): Promise<UploadHelperLaunch> {
    const outcome = await this.launch(game, { runId });
    if (!outcome.ok) return outcome;
    return {
      ok: true,
      session: {
        taskArn: outcome.taskArn,
        runId,
        credentials: { username: FILEBROWSER_USERNAME, password: outcome.password },
        cert: outcome.cert!,
      },
    };
  }

  /** Shared launch body for browse (`upload === null`) and upload sessions. */
  private async launch(game: string, upload: { runId: string } | null): Promise<LaunchOutcome> {
    const fail = (message: string, code: 'helper-open' | 'failed' = 'failed'): LaunchOutcome => ({ ok: false, code, message });

    const outputs = await this.config.getStackOutputs();
    if (!outputs) return fail('Infrastructure not deployed. Deploy first.');

    const apId = outputs.efsAccessPoints[game];
    if (!apId) {
      logger.error('No EFS access point for game', { game, available: outputs.efsAccessPoints });
      return fail(`No EFS access point found for '${game}'.`);
    }

    const filemgrSg = outputs.fileManagerSecurityGroupId;
    if (!filemgrSg) {
      return fail('fileManagerSecurityGroupId not in the deployed stack outputs. Deploy first.');
    }

    // Guard: don't start if already running
    const existing = await this.ecs.listTasksByStartedBy(outputs.ecsClusterName, this.startedByKey(game));
    if (existing.length) {
      return fail(
        upload
          ? `A file manager session is already open for '${game}'. Stop it first, then retry the upload.`
          : `File manager for '${game}' is already running.`,
        'helper-open',
      );
    }

    // Get execution role from the game's own task definition
    const taskDef = await this.ecs.getTaskDefinition(game);
    if (!taskDef?.executionRoleArn) {
      logger.error('Could not get execution role ARN', { game, taskDef });
      return fail(
        `Could not get execution role for '${game}'. Ensure the game's task definition exists — run plan and apply on the Infrastructure page to deploy it.`,
      );
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

    // The helper's SG declares no ingress, so the operator's /32 must be opened before the task can be reached.
    let operatorIp: string;
    try {
      operatorIp = await this.publicIp.detect();
    } catch (err) {
      return fail(errMessage(err));
    }
    const runId = upload?.runId ?? BROWSE_RUN_ID;
    try {
      await this.ec2.authorizeIngress(filemgrSg, `${operatorIp}/32`, FILEBROWSER_PORT, this.ruleDescription(game, runId));
    } catch (err) {
      return fail(`Could not open the file manager port to your IP: ${errMessage(err)}`);
    }

    let registeredArn: string | null = null;
    const cleanupAfterFailure = async (): Promise<void> => {
      await this.revokeAppRules(filemgrSg, (g) => g === game);
      if (registeredArn) await this.ecs.deregisterTaskDefinition(registeredArn);
    };

    const filebrowserArgs = [
      '--username', FILEBROWSER_USERNAME,
      '--password', passwordHash,
      '--root', '/srv',
      '--port', String(FILEBROWSER_PORT),
      '--address', '0.0.0.0',
      '--database', '/tmp/filebrowser.db',
    ];
    const cert = upload ? await generateEphemeralCert() : undefined;
    const tls = cert ? buildTlsContainerSettings(filebrowserArgs, cert) : undefined;

    logger.info('Registering FileBrowser task definition', { game, family, apId, logGroup, upload: !!upload });

    registeredArn = await this.ecs.registerTaskDefinition({
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
          ...(tls ?? { command: filebrowserArgs }),
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

    if (!registeredArn) {
      await cleanupAfterFailure();
      return fail(`Failed to register FileBrowser task definition for '${game}'. Check server logs.`);
    }

    const subnets = outputs.subnetIds;
    logger.info('Launching FileBrowser task', { game, subnets, sg: filemgrSg });

    const result = await this.ecs.runTask({
      cluster: outputs.ecsClusterName,
      taskDefinition: family,
      count: 1,
      launchType: 'FARGATE',
      startedBy: this.startedByKey(game),
      ...(upload ? { tags: UPLOAD_TAGS } : {}),
      networkConfiguration: {
        awsvpcConfiguration: {
          subnets,
          securityGroups: [filemgrSg],
          assignPublicIp: 'ENABLED',
        },
      },
    });

    if (!result) {
      await cleanupAfterFailure();
      return fail(`Failed to launch file manager for '${game}'. Check server logs for details.`);
    }

    return { ok: true, taskArn: result.taskArn, password, cert, scheduleWarning: await this.scheduleAutoStop(outputs, game, result.taskArn) };
  }

  /**
   * Creates the one-time auto-stop schedule for a freshly launched task.
   *
   * @returns A warning suffix for the operator-facing message, or `''` when the schedule exists.
   */
  private async scheduleAutoStop(outputs: StackOutputs, game: string, taskArn: string): Promise<string> {
    if (!outputs.fileBrowserSchedulerRoleArn) {
      logger.warn('fileBrowserSchedulerRoleArn not in the deployed stack outputs — FileBrowser task will not auto-stop', { game });
      return ' Warning: auto-stop is not configured for this deployment — remember to stop it manually.';
    }
    // Best-effort: a failed auto-stop schedule must not fail the launch
    // itself (the operator can still stop the task manually) — see
    // `SchedulerService.createStopSchedule`'s doc. The failure is still
    // surfaced in the returned message so it isn't silently log-only.
    const scheduled = await this.scheduler.createStopSchedule({
      name: this.scheduleName(game),
      cluster: outputs.ecsClusterName,
      taskArn,
      roleArn: outputs.fileBrowserSchedulerRoleArn,
      at: new Date(Date.now() + FILEBROWSER_AUTO_STOP_MS),
    });
    return scheduled ? '' : ' Warning: failed to schedule auto-stop — remember to stop it manually.';
  }

  /**
   * Stops `task`, drops `game`'s auto-stop schedule, and deregisters the throwaway task definition.
   *
   * @throws Error when the `StopTask` call itself fails; the follow-ups are best-effort.
   */
  private async teardownTask(outputs: StackOutputs, game: string, task: Task): Promise<void> {
    await this.ecs.stopTask(outputs.ecsClusterName, task.taskArn!, 'Stopped via management app');
    // Best-effort: the task is already stopping either way; a schedule
    // that fails to delete just fires a no-op StopTask against an already-
    // stopped task later (or, if it already fired/self-deleted, does
    // nothing at all).
    await this.scheduler.deleteSchedule(this.scheduleName(game));
    if (task.taskDefinitionArn) await this.ecs.deregisterTaskDefinition(task.taskDefinitionArn);
  }

  /**
   * Stop the FileBrowser task for `game`. Locates it by `startedBy` tag
   * rather than task-def family since multiple revisions may have been
   * registered across restarts. Always revokes the app-added operator-IP rules for `game`, even
   * when no task is found, so a rule can never outlive its helper.
   */
  async stop(game: string): Promise<FileMgrResult> {
    const outputs = await this.config.getStackOutputs();
    if (!outputs) return { success: false, message: 'Infrastructure not deployed.' };

    const tasks = await this.ecs.listTasksByStartedBy(
      outputs.ecsClusterName,
      this.startedByKey(game),
    );

    try {
      if (!tasks.length) {
        return { success: false, message: `No file manager running for '${game}'.` };
      }

      const task = tasks[0] as Task;
      logger.info('Stopping file manager', { game, taskArn: task.taskArn });
      try {
        await this.teardownTask(outputs, game, task);
        return { success: true, message: `File manager for '${game}' is stopping.` };
      } catch (err) {
        logger.error('Failed to stop file manager', { err, game });
        return { success: false, message: String(err) };
      }
    } finally {
      await this.revokeAppRules(outputs.fileManagerSecurityGroupId, (g) => g === game);
    }
  }

  /**
   * Stops stray file-manager helpers: running `filemgr-*` tasks with no active run here that are at least
   * `minAgeMs` old. Deregisters their task definitions, then revokes app-created security-group rules whose game
   * has no remaining helper and no active run.
   *
   * @param options - `activeGames` are games with an upload run in this process (their helpers and rules are left
   * alone); `minAgeMs` is the minimum task age to stop, `0` for an explicit operator-requested cleanup.
   */
  async sweepStrayHelpers(options: { activeGames: ReadonlySet<string>; minAgeMs: number }): Promise<StrayHelperReport> {
    const report: StrayHelperReport = { stopped: [], skipped: 0, revokedRules: 0, errors: [] };
    const outputs = await this.config.getStackOutputs();
    if (!outputs) return report;

    const tasks = await this.ecs.listTasksByStartedByPrefix(outputs.ecsClusterName, STARTED_BY_PREFIX);
    const remaining = new Set<string>();
    for (const task of tasks) {
      const game = (task.startedBy ?? '').slice(STARTED_BY_PREFIX.length);
      const startedAt = task.startedAt ?? task.createdAt;
      const ageMs = startedAt ? Date.now() - startedAt.getTime() : Number.POSITIVE_INFINITY;
      if (options.activeGames.has(game) || ageMs < options.minAgeMs) {
        report.skipped += 1;
        remaining.add(game);
        continue;
      }
      try {
        await this.teardownTask(outputs, game, task);
        report.stopped.push({ game, taskArn: task.taskArn ?? '', ageMinutes: Math.floor(ageMs / 60000) });
      } catch (err) {
        const message = errMessage(err);
        logger.warn('Failed to stop stray file manager helper', { game, taskArn: task.taskArn, error: message });
        report.errors.push(`${game}: ${message}`);
        remaining.add(game);
      }
    }

    report.revokedRules = await this.revokeAppRules(
      outputs.fileManagerSecurityGroupId,
      (game) => !options.activeGames.has(game) && !remaining.has(game),
    );
    logger.info('Stray helper sweep finished', {
      stopped: report.stopped.length,
      skipped: report.skipped,
      revokedRules: report.revokedRules,
      errors: report.errors.length,
    });
    return report;
  }
}
