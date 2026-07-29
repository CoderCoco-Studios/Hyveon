/**
 * Security-group resources — ported from `terraform/aws/main.tf`'s
 * `## Security Groups` block. This dispatch (task 3.4) ports the
 * `game_servers` and `file_manager` groups only; `aws_security_group.efs`
 * is deliberately deferred — it ingresses from `aws_security_group.efs_seeder`,
 * which belongs to `efs-seeder.tf` (Lambda/EFS territory, out of scope per
 * the task brief's "no EFS, ECS, IAM, Lambdas yet"), so porting it now would
 * either dangle a reference to a resource that doesn't exist yet or silently
 * drop that ingress rule. It ships alongside EFS (task 3.2).
 */

import * as aws from '@pulumi/aws';
import type * as pulumi from '@pulumi/pulumi';
import type { GameServerConfig } from '@hyveon/shared';

/** Every resource {@link defineSecurityGroups} declares, keyed by role. */
export interface SecurityGroupResources {
  /** Game server task security group (`aws_security_group.game_servers`). */
  gameServers: aws.ec2.SecurityGroup;
  /** FileBrowser file-manager task security group (`aws_security_group.file_manager`). */
  fileManager: aws.ec2.SecurityGroup;
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
 * Declares the `game_servers` and `file_manager` security groups (task 3.4
 * of `migrate-iac-to-pulumi`). Must be called from inside the Pulumi
 * inline-program closure (see `program.ts`'s {@link createInfraProgram}),
 * never at module scope.
 *
 * Terraform's `lifecycle { create_before_destroy = true }` on both groups is
 * not replicated as an explicit Pulumi option: Pulumi's own default
 * replacement behaviour already creates a group's replacement before
 * deleting the old one (`pulumi.CustomResourceOptions.deleteBeforeReplace`
 * defaults to `false`), so the default already matches the HCL's intent.
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

  return { gameServers: gameServersSg, fileManager: fileManagerSg };
}
