/**
 * Security-group resources — ported from `terraform/aws/main.tf`'s
 * `## Security Groups` block: `game_servers`, `file_manager`, and `efs`.
 *
 * The `efs` group's HCL declares a second, conditional ingress rule sourced
 * from `aws_security_group.efs_seeder[0]` (`local.games_with_seeds`-gated),
 * as a `dynamic "ingress"` block inline on `aws_security_group.efs` itself
 * (`terraform/aws/main.tf:170-179`) — HCL can do this because its evaluation
 * is declarative; `aws_security_group.efs_seeder` lives textually later, in
 * `efs-seeder.tf`, and Terraform's graph doesn't care about file order.
 * {@link defineSecurityGroups} (this function) does NOT port that second
 * rule inline for exactly the reason task 3.4 originally deferred it: by the
 * time this function runs (early in `defineAll`, before IAM/EFS/ECS/Lambdas),
 * no seeder security group exists yet to reference, and Pulumi's `ingress`
 * array is a plain input captured once at construction — it cannot be
 * appended to after the fact the way Terraform's declarative graph allows.
 *
 * Task 3.6 ports `aws_security_group.efs_seeder` itself into `lambdas.ts`
 * (grouped with the EFS-seeder Lambda functions it secures, mirroring
 * `efs-seeder.tf`'s own file grouping) and adds the second ingress rule here,
 * as a **separate** {@link defineEfsSeederIngress} function/resource
 * (`aws.ec2.SecurityGroupRule`, not a second inline `ingress` entry on the
 * `efs` `SecurityGroup` itself) — the standard Pulumi pattern for attaching a
 * rule to a security group after some other, later-constructed resource's id
 * becomes available. Same real-world AWS effect as the HCL's inline dynamic
 * block (one more ingress rule on the same security group); different Pulumi
 * resource type, because Pulumi's resource model has no equivalent of
 * "reopen an already-constructed resource's array input." See
 * {@link defineEfsSeederIngress}'s own doc for its conditionality and current
 * (unwired) status.
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
  /**
   * EFS security group (`aws_security_group.efs`) — allows NFS (port 2049)
   * from {@link gameServers} and {@link fileManager}. See this file's doc for
   * why the HCL's second, seeder-sourced ingress rule is not included here.
   */
  efs: aws.ec2.SecurityGroup;
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
 * Declares the `game_servers`, `file_manager`, and `efs` security groups
 * (task 3.4 of `migrate-iac-to-pulumi`). Must be called from inside the
 * Pulumi inline-program closure (see `program.ts`'s
 * {@link createInfraProgram}/`defineAll`), never at module scope.
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

  const efsSg = new aws.ec2.SecurityGroup(
    `${projectName}-efs-sg`,
    {
      namePrefix: `${projectName}-efs-sg-`,
      description: 'Allow NFS from game server tasks',
      vpcId,
      ingress: [
        {
          description: 'NFS from game servers',
          fromPort: 2049,
          toPort: 2049,
          protocol: 'tcp',
          securityGroups: [gameServersSg.id, fileManagerSg.id],
        },
        // The HCL's second ingress rule here (NFS from the EFS-seeder
        // Lambdas, sourced from `aws_security_group.efs_seeder[0]` and
        // gated on `local.games_with_seeds`) cannot be embedded inline in
        // this array — see this file's doc. {@link defineEfsSeederIngress}
        // below declares it as a separate resource once task 3.6's seeder
        // security group exists.
      ],
      egress: [openEgress],
      tags: { Name: `${projectName}-efs-sg` },
    },
    opts,
  );

  return { gameServers: gameServersSg, fileManager: fileManagerSg, efs: efsSg };
}

/** Arguments {@link defineEfsSeederIngress} needs to declare the seeder-sourced ingress rule. */
export interface DefineEfsSeederIngressArgs {
  /** The `efs` security group's id (`SecurityGroupResources.efs.id`) — the rule attaches to this group. */
  efsSecurityGroupId: pulumi.Input<string>;
  /**
   * The EFS-seeder security group's id (`lambdas.ts`'s
   * `LambdaResources.efsSeederSecurityGroup.id`) — the rule's traffic
   * source. Always defined when this function is called; conditionality
   * (`local.games_with_seeds` non-empty) is expressed by the caller simply
   * not calling this function at all when no seeder security group exists,
   * not by an internal branch here — the same "absence of a call/loop
   * iteration is the conditionality" idiom `defineIamPolicies`'s
   * `efsSeederPolicies` loop already uses.
   */
  efsSeederSecurityGroupId: pulumi.Input<string>;
  /** The regional AWS provider every resource is declared against (region + default tags). */
  provider: aws.Provider;
}

/**
 * Declares the seeder-sourced NFS ingress rule the HCL attaches inline to
 * `aws_security_group.efs` — the second dynamic ingress block in
 * `terraform/aws/main.tf`, gated on `local.games_with_seeds` being non-empty
 * — ported here, as task 3.6 of `migrate-iac-to-pulumi`, as a standalone
 * `aws.ec2.SecurityGroupRule` rather than a second entry in
 * {@link defineSecurityGroups}'s `efs` `ingress` array; see this file's doc
 * for why. Same port/protocol/description as the HCL's inline block.
 *
 * NOT called from `program.ts`'s `defineAll` yet — see that file's
 * `TODO(task 3.6)` comment: it needs `lambdas.efsSeederSecurityGroup`, which
 * only exists once `defineLambdas` (also implemented, also not yet wired —
 * same TODO) has run.
 *
 * @param args - The two security-group ids and provider — see
 *   {@link DefineEfsSeederIngressArgs}.
 * @returns The declared `aws.ec2.SecurityGroupRule`.
 */
export function defineEfsSeederIngress(args: DefineEfsSeederIngressArgs): aws.ec2.SecurityGroupRule {
  const { efsSecurityGroupId, efsSeederSecurityGroupId, provider } = args;

  return new aws.ec2.SecurityGroupRule(
    'efs-seeder-ingress',
    {
      type: 'ingress',
      description: 'NFS from EFS seeder Lambdas',
      fromPort: 2049,
      toPort: 2049,
      protocol: 'tcp',
      securityGroupId: efsSecurityGroupId,
      sourceSecurityGroupId: efsSeederSecurityGroupId,
    },
    { provider },
  );
}
