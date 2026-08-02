/**
 * Security-group resources: `game_servers`, `file_manager`, `efs`, and a
 * conditional `efs_seeder` group for EFS-seeder Lambdas
 * (`aws_security_group.efs_seeder` in the HCL equivalent).
 *
 * `efs_seeder` lives in THIS file, not `lambdas.ts`. Declaring the seeder
 * security group in `lambdas.ts` and attaching its ingress rule to `efs` as
 * a standalone `aws.ec2.SecurityGroupRule` would conflict with `@pulumi/aws`'s
 * own `SecurityGroupRule` docs, which warn explicitly against mixing a
 * security group's in-line `ingress`/`egress` rules with standalone
 * `SecurityGroupRule` resources targeting that same group — the combination
 * produces rule conflicts, perpetual diffs, and rules getting silently
 * overwritten. The `efs` group here already declares its NFS-from-game-
 * servers rule in-line, so that mix would be exactly the broken combination:
 * every `pulumi up`/refresh with a seeded game would see the seeder's
 * standalone rule as drift against `efs`'s own in-line state and fight over
 * it, flapping NFS port 2049 access.
 *
 * Instead, this mirrors what the HCL itself does: `aws_security_group.efs`'s
 * second ingress rule (`main.tf`'s second `dynamic "ingress"` block, gated on
 * `local.games_with_seeds` being non-empty) is a second IN-LINE entry in
 * the SAME resource's `ingress` array, not a separate resource. Reproducing
 * that in Pulumi means the seeder security group must exist BEFORE `efs`'s
 * `ingress` array is constructed — so {@link defineSecurityGroups} declares
 * `aws_security_group.efs_seeder` first (it needs only `projectName`/
 * `vpcId`/`gameServers` — see `iam.ts`'s `gamesWithFileSeeds`, reused here
 * to determine whether any game declares `file_seeds`) and folds its
 * conditional ingress entry directly into `efs`'s own `ingress` array —
 * exact HCL parity, no standalone rule resource at all.
 *
 * `lambdas.ts`'s EFS-seeder Lambda functions take the resulting security
 * group's id as a plain input (`DefineLambdasArgs.efsSeederSecurityGroupId`)
 * rather than constructing their own — see that file's doc.
 */

import * as aws from '@pulumi/aws';
import type * as pulumi from '@pulumi/pulumi';
import type { GameServerConfig } from '@hyveon/shared';
import { gamesWithFileSeeds } from './iam.js';

/** Every resource {@link defineSecurityGroups} declares, keyed by role. */
export interface SecurityGroupResources {
  /** Game server task security group (`aws_security_group.game_servers`). */
  gameServers: aws.ec2.SecurityGroup;
  /** FileBrowser file-manager task security group (`aws_security_group.file_manager`). */
  fileManager: aws.ec2.SecurityGroup;
  /**
   * EFS security group (`aws_security_group.efs`) — allows NFS (port 2049)
   * from {@link gameServers} and {@link fileManager}, plus a conditional
   * third ingress source, {@link efsSeeder}, when at least one configured
   * game declares `file_seeds`. See this file's doc for why that rule is a
   * second in-line `ingress` array entry, not a separate resource.
   */
  efs: aws.ec2.SecurityGroup;
  /**
   * Shared security group for every EFS-seeder Lambda
   * (`aws_security_group.efs_seeder`, `count = length(local.games_with_seeds) > 0 ? 1 : 0`).
   * `undefined` when no configured game declares `file_seeds` — mirrors the
   * HCL's `count` gate. `lambdas.ts`'s EFS-seeder functions take its `.id`
   * as a plain input rather than constructing their own security group.
   */
  efsSeeder: aws.ec2.SecurityGroup | undefined;
}

/** Arguments {@link defineSecurityGroups} needs to declare the security groups. */
export interface DefineSecurityGroupsArgs {
  /** Mirrors `var.project_name` — every resource name/tag below is `${projectName}-...`, matching the HCL exactly. */
  projectName: string;
  /** The configured game-server map (`DeploymentConfig.gameServers`) the per-game ingress rules are derived from by iteration. */
  gameServers: Record<string, GameServerConfig>;
  /** The VPC ID both security groups are created in. */
  vpcId: pulumi.Input<string>;
  /** The regional AWS provider every resource is declared against (region + default tags). */
  provider: aws.Provider;
}

/** A single deduplicated container port/protocol pair, ready to become one ingress rule. */
export interface GamePort {
  /** Container port number. */
  port: number;
  /** Transport protocol (`"tcp"` or `"udp"`). */
  protocol: string;
}

/**
 * Deduplicated set of container port/protocol pairs across every
 * non-HTTPS game server, mirroring `terraform/aws/main.tf`'s
 * `local.direct_game_ports` local — a `distinct(flatten(...))` over every
 * game's `ports`, filtered to entries where `https` is falsy. Two games
 * declaring the same port and protocol yield exactly one entry here,
 * reproducing the HCL's `distinct()` dedup via a `Map` keyed on the
 * port/protocol pair.
 *
 * `https` follows the `undefined ≡ false` contract documented on
 * `GameServerConfig.https` (`@hyveon/shared`'s `tfvars.ts`) — a config entry
 * with `https` omitted is treated as non-HTTPS and contributes its ports,
 * matching Terraform's `optional(bool, false)` default and the HCL's
 * `!cfg.https` filter.
 *
 * @param gameServers - The configured game-server map to derive ports from.
 * @returns The deduplicated port/protocol pairs, in first-seen order.
 */
export function dedupedDirectGamePorts(gameServers: Record<string, GameServerConfig>): GamePort[] {
  const seen = new Map<string, GamePort>();
  for (const config of Object.values(gameServers)) {
    if (config.https) {
      continue;
    }
    for (const port of config.ports) {
      const key = `${port.container}-${port.protocol}`;
      if (!seen.has(key)) {
        seen.set(key, { port: port.container, protocol: port.protocol });
      }
    }
  }
  return [...seen.values()];
}

/**
 * True when at least one configured game server has `https: true`, mirroring
 * `terraform/aws/main.tf`'s `length(local.https_games) > 0` gate that
 * controls whether the 443/80 Caddy-sidecar ingress rules are declared at
 * all. Follows the same `undefined ≡ false` contract as
 * {@link dedupedDirectGamePorts} (`config.https === true` excludes both
 * `false` and `undefined`).
 *
 * @param gameServers - The configured game-server map to inspect.
 * @returns Whether any entry has `https: true`.
 */
export function hasHttpsGame(gameServers: Record<string, GameServerConfig>): boolean {
  return Object.values(gameServers).some((config) => config.https === true);
}

/**
 * Declares the `game_servers`, `file_manager`, and `efs` security groups.
 * Must be called from inside the Pulumi inline-program closure (see
 * `program.ts`'s {@link createInfraProgram}/`defineAll`), never at module
 * scope.
 *
 * Terraform's `lifecycle { create_before_destroy = true }` on `game_servers`
 * and `file_manager` (NOT present on `efs` — the HCL omits it there) is not
 * replicated as an explicit Pulumi option: Pulumi's own default replacement
 * behaviour already creates a group's replacement before deleting the old
 * one (`pulumi.CustomResourceOptions.deleteBeforeReplace` defaults to
 * `false`), so the default already matches the HCL's intent for all three
 * groups regardless.
 *
 * @param args - Naming, config, and provider inputs — see
 *   {@link DefineSecurityGroupsArgs}.
 * @returns The declared resources — see {@link SecurityGroupResources}.
 */
export function defineSecurityGroups(args: DefineSecurityGroupsArgs): SecurityGroupResources {
  const { projectName, gameServers, vpcId, provider } = args;
  const opts: pulumi.CustomResourceOptions = { provider };

  // Non-HTTPS game ports — open directly to the internet.
  const gamePortIngress = dedupedDirectGamePorts(gameServers).map((port) => ({
    description: `Game port ${port.port}/${port.protocol}`,
    fromPort: port.port,
    toPort: port.port,
    protocol: port.protocol,
    cidrBlocks: ['0.0.0.0/0'],
  }));

  // HTTPS games — public 443/80 for the in-task Caddy sidecar, only declared
  // when at least one HTTPS game exists. Order (443 then 80) mirrors
  // Terraform's `for_each` over `{ "443" = 443, "80" = 80 }`, which iterates
  // map keys in sorted order ("443" < "80" lexicographically).
  if (hasHttpsGame(gameServers)) {
    for (const httpsPort of [443, 80]) {
      gamePortIngress.push({
        description: `Caddy sidecar (HTTPS/ACME) port ${httpsPort}/tcp`,
        fromPort: httpsPort,
        toPort: httpsPort,
        protocol: 'tcp',
        cidrBlocks: ['0.0.0.0/0'],
      });
    }
  }

  const openEgress = {
    fromPort: 0,
    toPort: 0,
    protocol: '-1',
    cidrBlocks: ['0.0.0.0/0'],
  };

  const gameServersSg = new aws.ec2.SecurityGroup(
    `${projectName}-sg`,
    {
      namePrefix: `${projectName}-sg-`,
      description: 'Game server tasks - allows all configured game ports inbound',
      vpcId,
      ingress: gamePortIngress,
      egress: [openEgress],
      tags: { Name: `${projectName}-sg` },
    },
    opts,
  );

  const fileManagerSg = new aws.ec2.SecurityGroup(
    `${projectName}-filemgr-sg`,
    {
      namePrefix: `${projectName}-filemgr-sg-`,
      description: 'FileBrowser tasks - allows port 8080 inbound',
      vpcId,
      ingress: [
        {
          description: 'FileBrowser web UI',
          fromPort: 8080,
          toPort: 8080,
          protocol: 'tcp',
          cidrBlocks: ['0.0.0.0/0'],
        },
      ],
      egress: [openEgress],
      tags: { Name: `${projectName}-filemgr-sg` },
    },
    opts,
  );

  // ── EFS-seeder security group (efs-seeder.tf) — declared BEFORE `efs`
  // below so its id is in scope for `efs`'s own conditional ingress entry.
  // Same "create_before_destroy" non-replication rationale as the other two
  // groups above (Pulumi's default replacement behaviour already matches
  // the HCL's `lifecycle` block's intent).
  const seederGames = gamesWithFileSeeds(gameServers);
  const hasSeeders = Object.keys(seederGames).length > 0;

  const efsSeederSg = hasSeeders
    ? new aws.ec2.SecurityGroup(
        `${projectName}-efs-seeder-sg`,
        {
          namePrefix: `${projectName}-efs-seeder-sg-`,
          description: 'EFS seeder Lambdas — outbound NFS to EFS only',
          vpcId,
          egress: [openEgress],
          tags: { Name: `${projectName}-efs-seeder-sg` },
        },
        opts,
      )
    : undefined;

  // Same rule the HCL declares as `aws_security_group.efs`'s NFS-from-
  // game-servers ingress entry, plus a conditional second entry sourced
  // from `efsSeederSg` — both IN-LINE in this one array, exactly like the
  // HCL's two `ingress`/`dynamic "ingress"` blocks on the same resource.
  // See this file's doc for why a standalone `SecurityGroupRule` for the
  // second entry is NOT used.
  const efsIngress: pulumi.Input<aws.types.input.ec2.SecurityGroupIngress>[] = [
    {
      description: 'NFS from game servers',
      fromPort: 2049,
      toPort: 2049,
      protocol: 'tcp',
      securityGroups: [gameServersSg.id, fileManagerSg.id],
    },
  ];
  if (efsSeederSg) {
    efsIngress.push({
      description: 'NFS from EFS seeder Lambdas',
      fromPort: 2049,
      toPort: 2049,
      protocol: 'tcp',
      securityGroups: [efsSeederSg.id],
    });
  }

  const efsSg = new aws.ec2.SecurityGroup(
    `${projectName}-efs-sg`,
    {
      namePrefix: `${projectName}-efs-sg-`,
      description: 'Allow NFS from game server tasks',
      vpcId,
      ingress: efsIngress,
      egress: [openEgress],
      tags: { Name: `${projectName}-efs-sg` },
    },
    opts,
  );

  return { gameServers: gameServersSg, fileManager: fileManagerSg, efs: efsSg, efsSeeder: efsSeederSg };
}
