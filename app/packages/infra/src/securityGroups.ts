/**
 * Security-group resources: `game_servers`, `file_manager`, `efs`, a
 * conditional `efs_seeder` group for EFS-seeder Lambdas, and a conditional
 * `health-check` group (added post-migration, no legacy equivalent) for the
 * health-check Lambda. The health-check group follows the exact same
 * "no inline egress, standalone rule(s) instead" shape as `efs_seeder`, one
 * standalone egress rule per distinct declared health-check port rather than
 * one fixed NFS port — see "`efsSeederSg`'s egress" below, which the
 * health-check group's egress rules mirror.
 *
 * `game_servers`'s `ingress` array draws from up to four sources: ports with
 * `visibility` omitted or `'public'` ({@link dedupedDirectGamePorts},
 * `0.0.0.0/0`), ports with `visibility: 'internal'`
 * ({@link dedupedInternalGamePorts}, scoped to the VPC's own CIDR block via
 * `aws.ec2.getVpcOutput`), the HTTPS Caddy sidecar (`0.0.0.0/0`, conditional
 * on {@link hasHttpsGame}), and the health-check Lambda (SG-sourced,
 * conditional on a game declaring `healthCheck`).
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
 * Instead, `efs`'s conditional seeder-sourced ingress rule (gated on at
 * least one configured game declaring `file_seeds`) is declared as a second
 * IN-LINE entry in the SAME resource's `ingress` array, not a separate
 * resource. That means the seeder security group must exist BEFORE `efs`'s
 * `ingress` array is constructed — so {@link defineSecurityGroups} declares
 * the seeder group first (it needs only `projectName`/`vpcId`/`gameServers`
 * — see `iam.ts`'s `gamesWithFileSeeds`, reused here to determine whether
 * any game declares `file_seeds`) and folds its conditional ingress entry
 * directly into `efs`'s own `ingress` array — no standalone rule resource
 * at all.
 *
 * `lambdas.ts`'s EFS-seeder Lambda functions take the resulting security
 * group's id as a plain input (`DefineLambdasArgs.efsSeederSecurityGroupId`)
 * rather than constructing their own — see that file's doc.
 *
 * ## `efsSeederSg`'s egress — standalone rule, not inline (issue #349)
 *
 * `efsSeederSg` itself carries NO inline `egress` array — unlike every other
 * group in this file, which declares `egress: [openEgress]` inline. Its one
 * egress need (outbound NFS to {@link efsSg}) is instead a standalone
 * `aws.ec2.SecurityGroupRule`, declared AFTER `efsSg` is constructed further
 * down (it needs `efsSg.id` as its `sourceSecurityGroupId`). This does NOT
 * trip the inline/standalone-mixing hazard described above: that hazard is
 * specifically about `efsSg`'s own rules (which stay 100% inline — its
 * ingress array is never touched by a standalone rule), not `efsSeederSg`'s.
 * A security group with zero inline rules of its own has nothing for a
 * standalone rule on that same group to conflict with. Previously
 * `efsSeederSg` carried `egress: [openEgress]` — all protocols/ports to
 * `0.0.0.0/0` — even though the seeder Lambda only ever needs outbound NFS to
 * mount and write to EFS.
 *
 * `namePrefix` carries a `-v2-` suffix for the same reason: Pulumi's
 * `ingress`/`egress` arguments are attributes-as-blocks, so simply omitting
 * the old `egress: [openEgress]` block from this resource's args does NOT
 * revoke that rule on a security group deployed before this fix — only an
 * explicit `egress: []` does, and adding that here would reintroduce the
 * exact inline/standalone conflict described above against the standalone
 * NFS-egress rule. Bumping `namePrefix` instead forces Pulumi to replace the
 * whole security group — the old one (open-egress rule included) is
 * destroyed and a clean one takes its place, with only the NFS-scoped
 * standalone rule ever applied to it.
 */

import * as aws from '@pulumi/aws';
import type * as pulumi from '@pulumi/pulumi';
import type { GameServerConfig } from '@hyveon/shared';
import { gamesWithFileSeeds, gamesWithHealthChecks } from './iam.js';

/** Every resource {@link defineSecurityGroups} declares, keyed by role. */
export interface SecurityGroupResources {
  /** Game server task security group. */
  gameServers: aws.ec2.SecurityGroup;
  /** FileBrowser file-manager task security group. */
  fileManager: aws.ec2.SecurityGroup;
  /**
   * EFS security group — allows NFS (port 2049) from {@link gameServers} and
   * {@link fileManager}, plus a conditional third ingress source,
   * {@link efsSeeder}, when at least one configured game declares
   * `file_seeds`. See this file's doc for why that rule is a second in-line
   * `ingress` array entry, not a separate resource.
   */
  efs: aws.ec2.SecurityGroup;
  /**
   * Shared security group for every EFS-seeder Lambda. `undefined` when no
   * configured game declares `file_seeds`. `lambdas.ts`'s EFS-seeder
   * functions take its `.id` as a plain input rather than constructing their
   * own security group.
   */
  efsSeeder: aws.ec2.SecurityGroup | undefined;
  /**
   * Standalone egress rule scoping {@link efsSeeder}'s outbound NFS traffic
   * to {@link efs} only (port 2049/tcp) — see this file's doc, "`efsSeederSg`'s
   * egress — standalone rule, not inline (issue #349)". `undefined` exactly
   * when {@link efsSeeder} is `undefined` (no game declares `file_seeds`).
   */
  efsSeederEgressRule: aws.ec2.SecurityGroupRule | undefined;
  /**
   * Shared security group for the health-check Lambda, conditional on at
   * least one configured game declaring a `healthCheck` (see `iam.ts`'s
   * `gamesWithHealthChecks`). `undefined` when no game opts in, mirroring
   * {@link efsSeeder}'s gate. Carries no inline egress — its outbound
   * reach is granted exclusively via {@link healthCheckEgressRules}, one
   * standalone rule per distinct declared health-check port, following the
   * same "no inline rules to conflict with" reasoning as `efsSeederSg`'s
   * egress (see this file's doc).
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
  /** Project name — every resource name/tag below is `${projectName}-...`. */
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
  /** Container port number, or the ICMP type when `protocol` is `"icmp"`. */
  port: number;
  /** Transport protocol (`"tcp"` or `"udp"`), or `"icmp"`. */
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
 * Builds one inline `ingress` entry for a {@link GamePort}, shared by both the
 * public (`0.0.0.0/0`) and internal (VPC CIDR) loops in
 * {@link defineSecurityGroups}. An `icmp` entry has no meaningful "host port"
 * — `port.port` is the ICMP type, not a transport port — so it maps to
 * `toPort: -1` (ICMP wildcard code) instead of repeating `fromPort`, per the
 * spec's "ICMP port declarations" requirement.
 *
 * @param port - The port/protocol pair to build a rule for.
 * @param cidrBlocks - The source CIDR block(s) — `['0.0.0.0/0']` for a public
 *   entry, the VPC's CIDR for an internal one.
 * @param suffix - Appended to the description (`' (internal)'` for internal
 *   entries, `''` for public ones), matching the existing description text exactly.
 * @returns The ingress rule, ready to push onto `gamePortIngress`.
 */
function ingressRule(
  port: GamePort,
  cidrBlocks: pulumi.Input<string>[],
  suffix = '',
): pulumi.Input<aws.types.input.ec2.SecurityGroupIngress> {
  return port.protocol === 'icmp'
    ? { description: `ICMP type ${port.port}${suffix}`, fromPort: port.port, toPort: -1, protocol: 'icmp', cidrBlocks }
    : { description: `Game port ${port.port}/${port.protocol}${suffix}`, fromPort: port.port, toPort: port.port, protocol: port.protocol, cidrBlocks };
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
  ).map((port) => ingressRule(port, ['0.0.0.0/0']));

  // Internal-visibility game ports — VPC CIDR only, resolved via a plain
  // data lookup (no resource declared) only when at least one such port
  // exists, so a deployment with none (every deployment predating this
  // field) doesn't pay for an extra AWS API round trip on every
  // preview/apply. Mirrors the `hasHttpsGame` guard below.
  const internalPorts = dedupedInternalGamePorts(gameServers);
  if (internalPorts.length > 0) {
    const vpcCidrBlock = aws.ec2.getVpcOutput({ id: vpcId }, opts).cidrBlock;
    for (const port of internalPorts) {
      gamePortIngress.push(ingressRule(port, [vpcCidrBlock], ' (internal)'));
    }
  }

  // HTTPS games — public 443/80 for the in-task Caddy sidecar, only declared
  // when at least one HTTPS game exists. Order (443 then 80) is deliberate,
  // not incidental.
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
            // No inline egress — its egress rules are standalone
            // `aws.ec2.SecurityGroupRule`s declared below, once `gameServers`
            // exists. See this file's doc, "`efsSeederSg`'s egress —
            // standalone rule, not inline (issue #349)", for why.
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
          // `-v2-`: forces replacement of any `efsSeederSg` deployed before
          // issue #349's fix. Pulumi's `ingress`/`egress` arguments are
          // attributes-as-blocks — simply omitting the old `egress:
          // [openEgress]` block below does NOT revoke that all-protocol
          // 0.0.0.0/0 rule on an already-deployed security group, so a
          // forced replacement (old group destroyed, new one created with
          // only the NFS-scoped standalone rule) is the only way to
          // actually remove it. See this file's doc, "`efsSeederSg`'s
          // egress — standalone rule, not inline (issue #349)".
          namePrefix: `${projectName}-efs-seeder-sg-v2-`,
          description: 'EFS seeder Lambdas — outbound NFS to EFS only',
          vpcId,
          // No inline `egress` here — its one egress rule (NFS to `efsSg`) is
          // a standalone `aws.ec2.SecurityGroupRule` declared below, once
          // `efsSg` exists. See this file's doc, "`efsSeederSg`'s egress —
          // standalone rule, not inline (issue #349)".
          tags: { Name: `${projectName}-efs-seeder-sg` },
        },
        opts,
      )
    : undefined;

  // `efs`'s NFS-from-game-servers ingress entry, plus a conditional second
  // entry sourced from `efsSeederSg` — both IN-LINE in this one array. See
  // this file's doc for why a standalone `SecurityGroupRule` for the second
  // entry is NOT used.
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

  // Standalone egress rule for `efsSeederSg` — declared here, after `efsSg`
  // exists, since it needs `efsSg.id` as its `sourceSecurityGroupId`. Safe as
  // a standalone rule (unlike a hypothetical standalone rule on `efsSg`
  // itself) because `efsSeederSg` carries no inline rules of its own for this
  // one to conflict with — see this file's doc, "`efsSeederSg`'s egress —
  // standalone rule, not inline (issue #349)".
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
