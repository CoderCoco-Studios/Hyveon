/**
 * ECS cluster, per-game CloudWatch log groups, and per-game task definitions.
 *
 * | Resource | This file |
 * | --- | --- |
 * | `aws_cloudwatch_log_group.game` (one per game) | {@link EcsResources.logGroups} |
 * | `aws_ecs_cluster.main` | {@link EcsResources.cluster} |
 * | `aws_ecs_task_definition.game` (one per game) | {@link EcsResources.taskDefinitions} |
 *
 * ## Log-group ownership
 *
 * Every reader of a game's log group is a container in that game's task
 * definition — each contributes its own
 * `logConfiguration.options."awslogs-group"` reference (one for the game
 * container, plus one more for the `caddy` sidecar on HTTPS games) — no
 * Lambda or other resource reads a game's log group.
 * It is declared here, alongside the task definitions that are its only
 * consumer.
 *
 * ## No persistent ECS Service
 *
 * CLAUDE.md invariant: tasks are launched on demand via `RunTask`/`StopTask`
 * (the followup Lambda), never through an `aws.ecs.Service`. This file
 * declares `aws.ecs.TaskDefinition` only — see {@link defineEcs}'s doc.
 */

import * as aws from '@pulumi/aws';
import * as pulumi from '@pulumi/pulumi';
import type { GameServerConfig } from '@hyveon/shared';
import type { EfsResources } from './efs.js';
import { stripTrailingDots } from './hostedZoneName.js';

/** Every resource {@link defineEcs} declares, keyed by role. */
export interface EcsResources {
  /** The ECS cluster every task definition below runs against (`aws_ecs_cluster.main`). */
  cluster: aws.ecs.Cluster;
  /** One CloudWatch log group per game, keyed by game name (`aws_cloudwatch_log_group.game`). */
  logGroups: Record<string, aws.cloudwatch.LogGroup>;
  /** One task definition per game, keyed by game name (`aws_ecs_task_definition.game`). */
  taskDefinitions: Record<string, aws.ecs.TaskDefinition>;
}

/** Arguments {@link defineEcs} needs to declare the cluster, log groups, and task definitions. */
export interface DefineEcsArgs {
  /** Mirrors `var.project_name` — the cluster's name below is `${projectName}-cluster`, matching the HCL exactly. */
  projectName: string;
  /** Mirrors `var.aws_region` — embedded in every container's `logConfiguration.options."awslogs-region"`. */
  awsRegion: string;
  /** Mirrors `var.hosted_zone_name` — the Caddy sidecar's `--from` domain for each `https: true` game (`"${game}.${hostedZoneName}"`). */
  hostedZoneName: string;
  /** The configured game-server map (`DeploymentConfig.gameServers`) the log groups and task definitions are derived from by iteration. */
  gameServers: Record<string, GameServerConfig>;
  /**
   * The EFS resources {@link defineEfs} declares — `fileSystem.id` and both
   * access-point maps are threaded into each task definition's `volumes`
   * block (`efs_volume_configuration`).
   */
  efs: EfsResources;
  /** The ECS task-execution role's ARN (`defineIamRoles`'s `IamRoleResources.ecsTaskExecutionRole.arn`) — every task definition's `execution_role_arn`. */
  executionRoleArn: pulumi.Input<string>;
  /** The regional AWS provider every resource is declared against (region + default tags). */
  provider: aws.Provider;
}

/**
 * Builds the `logConfiguration` block shared by a game's container and its
 * Caddy sidecar, differing only in `awslogs-stream-prefix` between them.
 *
 * @param logGroupName - The container's log group name (`aws_cloudwatch_log_group.game[each.key].name`).
 * @param awsRegion - The region embedded in `awslogs-region`.
 * @param streamPrefix - `"ecs"` for a game's own container, `"caddy"` for its sidecar.
 * @returns The `logConfiguration` object, ready to embed in a container definition.
 */
function logConfiguration(
  logGroupName: pulumi.Input<string>,
  awsRegion: string,
  streamPrefix: 'ecs' | 'caddy',
): Record<string, unknown> {
  return {
    logDriver: 'awslogs',
    options: {
      'awslogs-group': logGroupName,
      'awslogs-region': awsRegion,
      'awslogs-stream-prefix': streamPrefix,
    },
  };
}

/**
 * Declares the ECS cluster, one CloudWatch log group per game, and one task
 * definition per game. Must be called from inside the Pulumi inline-program
 * closure, never at module scope, and after {@link defineEfs} (its access
 * points are required inputs).
 *
 * Declares `aws.ecs.TaskDefinition` only — never `aws.ecs.Service`. Tasks are
 * started on demand via `RunTask`/`StopTask` (the followup Lambda) against
 * the family names this function declares; a persistent Service would keep a
 * task running (and billing) at all times, breaking the on-demand cost model
 * CLAUDE.md documents as an invariant.
 *
 * @param args - Naming, config, EFS, IAM, and provider inputs — see
 *   {@link DefineEcsArgs}.
 * @returns The declared resources — see {@link EcsResources}.
 */
export function defineEcs(args: DefineEcsArgs): EcsResources {
  const { projectName, awsRegion, hostedZoneName, gameServers, efs, executionRoleArn, provider } = args;
  const opts: pulumi.CustomResourceOptions = { provider };

  // Caddy's ACME client rejects a `--from` domain ending in a period, so
  // strip any trailing dot before building the per-game FQDN — see
  // `hostedZoneName.ts`.
  const strippedHostedZoneName = stripTrailingDots(hostedZoneName);

  const cluster = new aws.ecs.Cluster(
    `${projectName}-cluster`,
    {
      name: `${projectName}-cluster`,
      settings: [{ name: 'containerInsights', value: 'disabled' }],
      tags: { Name: `${projectName}-cluster` },
    },
    opts,
  );

  const logGroups: Record<string, aws.cloudwatch.LogGroup> = {};
  for (const game of Object.keys(gameServers)) {
    logGroups[game] = new aws.cloudwatch.LogGroup(
      `${game}-server-logs`,
      {
        name: `/ecs/${game}-server`,
        retentionInDays: 7,
        tags: { Name: `${game}-logs`, Game: game },
      },
      opts,
    );
  }

  const taskDefinitions: Record<string, aws.ecs.TaskDefinition> = {};
  for (const [game, config] of Object.entries(gameServers)) {
    const isHttps = config.https === true;
    const logGroupName = logGroups[game].name;

    const volumes: pulumi.Input<aws.types.input.ecs.TaskDefinitionVolume>[] = config.volumes.map((volume) => ({
      name: `${game}-${volume.name}`,
      efsVolumeConfiguration: {
        fileSystemId: efs.fileSystem.id,
        transitEncryption: 'ENABLED',
        authorizationConfig: {
          accessPointId: efs.gameAccessPoints[`${game}-${volume.name}`].id,
          iam: 'DISABLED',
        },
      },
    }));

    if (isHttps) {
      volumes.push({
        name: `${game}-caddy-data`,
        efsVolumeConfiguration: {
          fileSystemId: efs.fileSystem.id,
          transitEncryption: 'ENABLED',
          authorizationConfig: {
            accessPointId: efs.caddyDataAccessPoints[game].id,
            iam: 'DISABLED',
          },
        },
      });
    }

    const gameContainer: Record<string, unknown> = {
      name: game,
      image: config.image,
      essential: true,
      portMappings: config.ports.map((port) => ({
        containerPort: port.container,
        hostPort: port.container,
        protocol: port.protocol,
      })),
      environment: config.environment ?? [],
      mountPoints: config.volumes.map((volume) => ({
        sourceVolume: `${game}-${volume.name}`,
        containerPath: volume.container_path,
        readOnly: false,
      })),
      logConfiguration: logConfiguration(logGroupName, awsRegion, 'ecs'),
    };

    const containerDefs: Record<string, unknown>[] = [gameContainer];

    if (isHttps) {
      containerDefs.push({
        name: 'caddy',
        image: 'caddy:2-alpine',
        essential: true,
        portMappings: [
          { containerPort: 443, hostPort: 443, protocol: 'tcp' },
          { containerPort: 80, hostPort: 80, protocol: 'tcp' },
        ],
        command: ['caddy', 'reverse-proxy', '--from', `${game}.${strippedHostedZoneName}`, '--to', `localhost:${config.ports[0].container}`],
        mountPoints: [
          {
            sourceVolume: `${game}-caddy-data`,
            containerPath: '/data',
            readOnly: false,
          },
        ],
        logConfiguration: logConfiguration(logGroupName, awsRegion, 'caddy'),
      });
    }

    taskDefinitions[game] = new aws.ecs.TaskDefinition(
      `${game}-server`,
      {
        family: `${game}-server`,
        networkMode: 'awsvpc',
        requiresCompatibilities: ['FARGATE'],
        cpu: String(config.cpu),
        memory: String(config.memory),
        executionRoleArn,
        volumes,
        containerDefinitions: pulumi.jsonStringify(containerDefs),
        tags: { Name: `${game}-server`, Game: game },
      },
      opts,
    );
  }

  return { cluster, logGroups, taskDefinitions };
}
