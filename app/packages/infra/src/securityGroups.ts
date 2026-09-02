/**
 * Security-group resources: `game_servers`, `file_manager`, `efs`, a
 * conditional `efs_seeder` group for EFS-seeder Lambdas, and a conditional
 * `health-check` group for the health-check Lambda. See
 * `docs/docs/components/infra.md` for the full resource inventory.
 *
 * `game_servers`'s `ingress` draws from up to four sources: public game
 * ports ({@link dedupedDirectGamePorts}), internal-only ports scoped to the
 * VPC CIDR ({@link dedupedInternalGamePorts}), the HTTPS Caddy sidecar
 * (conditional on {@link hasHttpsGame}), and the health-check Lambda
 * (SG-sourced, conditional on a game declaring `healthCheck`).
 *
 * `efs_seeder`'s conditional ingress entry is folded directly into `efs`'s
 * own in-line `ingress` array (a second array entry, not a separate
 * resource) — see "Inline vs. standalone rules" below for why.
 * `lambdas.ts`'s EFS-seeder functions take the resulting group's id as a
 * plain input rather than constructing their own.
 *
 * ## Inline vs. standalone rules — do not mix on one group
 *
 * `@pulumi/aws` warns against combining a security group's in-line
 * `ingress`/`egress` arrays with standalone `aws.ec2.SecurityGroupRule`
 * resources targeting that same group — the combination produces rule
 * conflicts, perpetual diffs, and rules getting silently overwritten. `efs`
 * declares its ingress fully in-line, so its seeder entry must stay in-line
 * too. `efsSeederSg` and `healthCheckSg` instead carry NO inline `egress` at
 * all, so their egress needs are met entirely by standalone
 * `SecurityGroupRule`s declared once their target groups exist — with zero
 * inline rules on either group, there is nothing for a standalone rule to
 * conflict with. Every other site needing this reasoning collapses to
 * `// No inline egress — see this file's doc.`
 *
 * `efsSeederSg`'s `namePrefix` carries a `-v2-` suffix: Pulumi's
 * `ingress`/`egress` arguments are attributes-as-blocks, so omitting the old
 * `egress: [openEgress]` block does NOT revoke that all-protocol
 * `0.0.0.0/0` rule on an already-deployed group — only a forced replacement
 * does. **Keep `-v2-`** — removing it un-replaces the group and leaves the
 * open-egress rule live.
 */

import * as aws from '@pulumi/aws';
import type * as pulumi from '@pulumi/pulumi';
import type { GameServerConfig } from '@hyveon/shared';
import { gamesWithFileSeeds, gamesWithHealthChecks } from './iam.js';

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
  /**
   * Standalone egress rule scoping {@link efsSeeder}'s outbound NFS traffic
   * to {@link efs} only (port 2049/tcp) — see this file's doc. `undefined`
   * exactly when {@link efsSeeder} is `undefined` (no game declares `file_seeds`).
   */
  efsSeederEgressRule: aws.ec2.SecurityGroupRule | undefined;
  /**
   * Shared security group for the health-check Lambda, conditional on at
   * least one configured game declaring a `healthCheck` (see `iam.ts`'s
   * `gamesWithHealthChecks`). `undefined` when no game opts in, mirroring
   * {@link efsSeeder}'s gate. Carries no inline egress — see this file's
   * doc. Its outbound reach is granted exclusively via
   * {@link healthCheckEgressRules}, one standalone rule per distinct
   * declared health-check port.
   */
  healthCheck: aws.ec2.SecurityGroup | undefined;
  /**
   * Standalone egress rules scoping {@link healthCheck}'s outbound traffic to
   * {@link gameServers}, one per distinct port declared across every opted-in
   * game's `healthCheck.port` — never a blanket rule. Empty when
   * {@link healthCheck} is `undefined`.
   */
  healthCheckEgressRules: aws.ec2.SecurityGroupRule[];
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
 * non-HTTPS game server whose {@link GameServerPort.visibility} is
 * `'public'` or omitted, mirroring the legacy tool's `local.direct_game_ports`
 * local — a `distinct(flatten(...))` over every game's `ports`, filtered to
 * entries where `https` is falsy. Two games declaring the same port and
 * protocol yield exactly one entry here, reproducing the HCL's `distinct()`
 * dedup via a `Map` keyed on the port/protocol pair. A port declared
 * `visibility: 'internal'` is excluded — see {@link dedupedInternalGamePorts}
 * for its counterpart.
 *
 * `https` follows the `undefined ≡ false` contract documented on
 * `GameServerConfig.https` (`@hyveon/shared`'s `gameServerConfig.ts`) — a config entry
 * with `https` omitted is treated as non-HTTPS and contributes its ports,
 * matching the legacy tool's `optional(bool, false)` default and the HCL's
 * `!cfg.https` filter.
 *
 * Classifies via an explicit allowlist (`undefined` or `'public'`), not a
 * negative `!== 'internal'` test — `deployment-config.json` is read without
 * re-validation (see {@link dedupedInternalGamePorts}'s doc), so an
 * unrecognized `visibility` value (a typo, or a future third state written
 * by a newer app build) must fail CLOSED, landing in neither this function's
 * result nor {@link dedupedInternalGamePorts}'s, rather than defaulting to
 * the open internet.
 *
 * @param gameServers - The configured game-server map to derive ports from.
 * @returns The deduplicated public port/protocol pairs, in first-seen order.
 */
export function dedupedDirectGamePorts(gameServers: Record<string, GameServerConfig>): GamePort[] {
  return dedupedGamePortsByVisibility(gameServers, (visibility) => visibility === undefined || visibility === 'public');
}

/**
 * Deduplicated set of container port/protocol pairs across every
 * non-HTTPS game server whose {@link GameServerPort.visibility} is exactly
 * `'internal'` — the counterpart to {@link dedupedDirectGamePorts}. Ports
 * cannot appear in both functions' results on the validated write path:
 * `checkPortCollisions` (`@hyveon/shared`'s `gameServerValidator.ts`) already
 * rejects two games, or two ports within one game, declaring the same
 * `(port, protocol)` pair, so a given key can only ever carry one
 * `visibility` value there — but a hand-edited `deployment-config.json` is
 * not re-validated on read, so that file could in principle declare the same
 * `(port, protocol)` pair twice with different `visibility` values; this
 * function's `Map`-based dedup then keeps whichever entry it sees first.
 *
 * @param gameServers - The configured game-server map to derive ports from.
 * @returns The deduplicated internal port/protocol pairs, in first-seen order.
 */
export function dedupedInternalGamePorts(gameServers: Record<string, GameServerConfig>): GamePort[] {
  return dedupedGamePortsByVisibility(gameServers, (visibility) => visibility === 'internal');
}

/** Shared dedup walk behind {@link dedupedDirectGamePorts}/{@link dedupedInternalGamePorts}, differing only in which `visibility` values `include` accepts. */
function dedupedGamePortsByVisibility(
  gameServers: Record<string, GameServerConfig>,
  include: (visibility: 'public' | 'internal' | undefined) => boolean,
): GamePort[] {
  const seen = new Map<string, GamePort>();
  for (const config of Object.values(gameServers)) {
    if (config.https) {
      continue;
    }
    for (const port of config.ports) {
      if (!include(port.visibility)) {
        continue;
      }
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
 * the legacy tool's `length(local.https_games) > 0` gate that
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
 * Declares the `game_servers`, `file_manager`, `efs`, and conditional
 * `efs_seeder` security groups. Must be called from inside the Pulumi inline-program closure (see
 * `program.ts`'s {@link createInfraProgram}/`defineAll`), never at module
 * scope.
 *
 * The legacy tool's `lifecycle { create_before_destroy = true }` on `game_servers`
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
  const gamePortIngress: pulumi.Input<aws.types.input.ec2.SecurityGroupIngress>[] = dedupedDirectGamePorts(
    gameServers,
  ).map((port) => ({
    description: `Game port ${port.port}/${port.protocol}`,
    fromPort: port.port,
    toPort: port.port,
    protocol: port.protocol,
    cidrBlocks: ['0.0.0.0/0'],
  }));

  // Internal-visibility game ports — VPC CIDR only, resolved via a plain
  // data lookup (no resource declared) only when at least one such port
  // exists, so a deployment with none (every deployment predating this
  // field) doesn't pay for an extra AWS API round trip on every
  // preview/apply. Mirrors the `hasHttpsGame` guard below.
  const internalPorts = dedupedInternalGamePorts(gameServers);
  if (internalPorts.length > 0) {
    const vpcCidrBlock = aws.ec2.getVpcOutput({ id: vpcId }, opts).cidrBlock;
    for (const port of internalPorts) {
      gamePortIngress.push({
        description: `Game port ${port.port}/${port.protocol} (internal)`,
        fromPort: port.port,
        toPort: port.port,
        protocol: port.protocol,
        cidrBlocks: [vpcCidrBlock],
      });
    }
  }

  // HTTPS games — public 443/80 for the in-task Caddy sidecar, only declared
  // when at least one HTTPS game exists. Order (443 then 80) mirrors
  // the legacy tool's `for_each` over `{ "443" = 443, "80" = 80 }`, which
  // iterates map keys in sorted order ("443" < "80" lexicographically).
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

  // ── Health-check Lambda security group — declared BEFORE `gameServers`
  // below so its id is in scope for `gameServers`'s own conditional ingress
  // entries (one per distinct declared health-check port, sourced from this
  // group rather than the open internet). Same "no inline egress, standalone
  // rule instead" shape as `efsSeederSg` — see this file's doc.
  const healthCheckGames = gamesWithHealthChecks(gameServers);
  const healthCheckPorts = [...new Set(Object.values(healthCheckGames).map((config) => config.healthCheck!.port))];

  const healthCheckSg =
    healthCheckPorts.length > 0
      ? new aws.ec2.SecurityGroup(
          `${projectName}-health-check-sg`,
          {
            namePrefix: `${projectName}-health-check-sg-`,
            description: 'Health-check Lambda — outbound to game-server tasks on declared health-check ports only',
            vpcId,
            // No inline egress — see this file's doc.
            tags: { Name: `${projectName}-health-check-sg` },
          },
          opts,
        )
      : undefined;

  if (healthCheckSg) {
    for (const port of healthCheckPorts) {
      gamePortIngress.push({
        description: `Health-check Lambda — port ${port}/tcp`,
        fromPort: port,
        toPort: port,
        protocol: 'tcp',
        securityGroups: [healthCheckSg.id],
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

  // ── EFS-seeder security group — declared BEFORE `efs`
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
          // `-v2-`: keep this suffix — see this file's doc.
          namePrefix: `${projectName}-efs-seeder-sg-v2-`,
          description: 'EFS seeder Lambdas — outbound NFS to EFS only',
          vpcId,
          // No inline egress — see this file's doc.
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

  // No inline egress — see this file's doc; declared here since it needs `efsSg.id`.
  const efsSeederEgressRule = efsSeederSg
    ? new aws.ec2.SecurityGroupRule(
        `${projectName}-efs-seeder-egress`,
        {
          type: 'egress',
          fromPort: 2049,
          toPort: 2049,
          protocol: 'tcp',
          securityGroupId: efsSeederSg.id,
          sourceSecurityGroupId: efsSg.id,
        },
        opts,
      )
    : undefined;

  // Standalone egress rules for `healthCheckSg` — declared here, after
  // `gameServersSg` exists, since each needs its `.id` as
  // `sourceSecurityGroupId`. One rule per distinct declared health-check
  // port (never a blanket rule), safe as standalone rules for the same
  // "no inline rules to conflict with" reason as `efsSeederEgressRule`.
  const healthCheckEgressRules = healthCheckSg
    ? healthCheckPorts.map(
        (port) =>
          new aws.ec2.SecurityGroupRule(
            `${projectName}-health-check-egress-${port}`,
            {
              type: 'egress',
              fromPort: port,
              toPort: port,
              protocol: 'tcp',
              securityGroupId: healthCheckSg.id,
              sourceSecurityGroupId: gameServersSg.id,
            },
            opts,
          ),
      )
    : [];

  return {
    gameServers: gameServersSg,
    fileManager: fileManagerSg,
    efs: efsSg,
    efsSeeder: efsSeederSg,
    efsSeederEgressRule,
    healthCheck: healthCheckSg,
    healthCheckEgressRules,
  };
}
