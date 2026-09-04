/**
 * EFS (persistent game saves) resources: one shared EFS filesystem, its
 * mount targets (one per public subnet), one access point per
 * `(game, volume)` pair, and one certificate-storage access point per
 * `https: true` game.
 *
 * | Resource | This file |
 * | --- | --- |
 * | Shared filesystem | {@link EfsResources.fileSystem} |
 * | Mount targets (one per public subnet) | {@link EfsResources.mountTargets} |
 * | Access points (one per `(game, volume)` pair) | {@link EfsResources.gameAccessPoints} |
 * | Cert-storage access points (one per `https: true` game) | {@link EfsResources.caddyDataAccessPoints} |
 *
 * The `efs` security group is declared in `securityGroups.ts` and threaded in
 * here by ID only, as {@link DefineEfsArgs.efsSecurityGroupId}. The
 * seeder-sourced ingress rule on that security group and the seeder security
 * group itself are declared elsewhere; this file does not touch either.
 */

import * as aws from '@pulumi/aws';
import type * as pulumi from '@pulumi/pulumi';
import type { GameServerConfig } from '@hyveon/shared';

/** Every resource {@link defineEfs} declares, keyed by role. */
export interface EfsResources {
  /** The shared EFS filesystem. */
  fileSystem: aws.efs.FileSystem;
  /**
   * One mount target per public subnet, same order as the subnets passed in
   * (one per public subnet — always two, since `defineNetwork` always
   * returns exactly two).
   */
  mountTargets: aws.efs.MountTarget[];
  /**
   * One access point per `(game, volume)` pair, keyed `"${game}-${volume.name}"`
   * — the same key `ecs.ts`'s task definitions re-derive to look up the
   * matching access point per volume.
   */
  gameAccessPoints: Record<string, aws.efs.AccessPoint>;
  /**
   * One certificate-storage access point per `https: true` game, keyed by
   * game name. Absent for a game with
   * `https` omitted or `false` — same `undefined ≡ false` contract as
   * `securityGroups.ts`'s `hasHttpsGame`.
   */
  caddyDataAccessPoints: Record<string, aws.efs.AccessPoint>;
}

/** Arguments {@link defineEfs} needs to declare every EFS resource. */
export interface DefineEfsArgs {
  /** The filesystem's name/creation-token below is `${projectName}-saves`. */
  projectName: string;
  /** The configured game-server map (`DeploymentConfig.gameServers`) the access points are derived from by iteration. */
  gameServers: Record<string, GameServerConfig>;
  /**
   * The public subnet IDs to mount into, same set `network.ts`'s
   * {@link NetworkResources.publicSubnets} yields (mapped to `.id`) —
   * iterating this array (rather than a hardcoded count) always yields
   * exactly two mount targets, since `defineNetwork` always returns
   * exactly two subnets.
   */
  publicSubnets: pulumi.Input<string>[];
  /** The `efs` security group's ID (`securityGroups.ts`'s `SecurityGroupResources.efs.id`) — every mount target's `security_groups`. */
  efsSecurityGroupId: pulumi.Input<string>;
  /** The regional AWS provider every resource is declared against (region + default tags). */
  provider: aws.Provider;
}

/**
 * Filters a game-server map down to `[game, config]` entries with
 * `https: true`. Follows the same `undefined ≡ false` contract as
 * `securityGroups.ts`'s `hasHttpsGame` (`config.https === true` excludes
 * both `false` and `undefined`).
 *
 * @param gameServers - The configured game-server map to filter.
 * @returns The `https: true` entries, in `Object.entries` order.
 */
function httpsGameEntries(gameServers: Record<string, GameServerConfig>): Array<[string, GameServerConfig]> {
  return Object.entries(gameServers).filter(([, config]) => config.https === true);
}

/** POSIX uid/gid every access point's `posixUser` and `rootDirectory.creationInfo` use — a literal `1000` repeated four times per access point, factored out once here. */
const ACCESS_POINT_POSIX_ID = 1000;

/**
 * Declares the shared EFS filesystem, its mount targets, and every
 * per-game/per-HTTPS-game access point. Must be called from inside the
 * Pulumi inline-program closure, never at module scope.
 *
 * @param args - Naming, config, and provider inputs — see {@link DefineEfsArgs}.
 * @returns The declared resources — see {@link EfsResources}.
 */
export function defineEfs(args: DefineEfsArgs): EfsResources {
  const { projectName, gameServers, publicSubnets, efsSecurityGroupId, provider } = args;
  const opts: pulumi.CustomResourceOptions = { provider };

  const fileSystem = new aws.efs.FileSystem(
    `${projectName}-saves`,
    {
      creationToken: `${projectName}-saves`,
      encrypted: true,
      tags: { Name: `${projectName}-saves` },
    },
    opts,
  );

  const mountTargets = publicSubnets.map(
    (subnetId, index) =>
      new aws.efs.MountTarget(
        `${projectName}-saves-mount-${index}`,
        {
          fileSystemId: fileSystem.id,
          subnetId,
          securityGroups: [efsSecurityGroupId],
        },
        opts,
      ),
  );

  // One access point per (game, volume) pair, keyed "${game}-${volume.name}".
  const gameAccessPoints: Record<string, aws.efs.AccessPoint> = {};
  for (const [game, config] of Object.entries(gameServers)) {
    for (const volume of config.volumes) {
      const key = `${game}-${volume.name}`;
      gameAccessPoints[key] = new aws.efs.AccessPoint(
        key,
        {
          fileSystemId: fileSystem.id,
          posixUser: { uid: ACCESS_POINT_POSIX_ID, gid: ACCESS_POINT_POSIX_ID },
          rootDirectory: {
            path: `/${game}/${volume.name}`,
            creationInfo: {
              ownerUid: ACCESS_POINT_POSIX_ID,
              ownerGid: ACCESS_POINT_POSIX_ID,
              permissions: '0755',
            },
          },
          tags: { Name: key },
        },
        opts,
      );
    }
  }

  // One certificate-storage access point per https: true game.
  const caddyDataAccessPoints: Record<string, aws.efs.AccessPoint> = {};
  for (const [game] of httpsGameEntries(gameServers)) {
    caddyDataAccessPoints[game] = new aws.efs.AccessPoint(
      `${game}-caddy-data`,
      {
        fileSystemId: fileSystem.id,
        posixUser: { uid: ACCESS_POINT_POSIX_ID, gid: ACCESS_POINT_POSIX_ID },
        rootDirectory: {
          path: `/${game}/caddy-data`,
          creationInfo: {
            ownerUid: ACCESS_POINT_POSIX_ID,
            ownerGid: ACCESS_POINT_POSIX_ID,
            permissions: '0755',
          },
        },
        tags: { Name: `${game}-certs` },
      },
      opts,
    );
  }

  return { fileSystem, mountTargets, gameAccessPoints, caddyDataAccessPoints };
}
