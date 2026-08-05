/**
 * Route 53 hosted-zone lookup — the pre-existing hosted zone's ID, looked up
 * by name and exposed for other resources to reference.
 *
 * The DNS-updater Lambda, its IAM role/policy, its CloudWatch log group, the
 * ECS-task-state-change EventBridge rule/target, and its EventBridge
 * permission are declared elsewhere: `iam.ts`'s
 * `IamRoleResources.dnsUpdaterLambdaRole`/`IamPolicyResources.dnsUpdaterLambdaPolicy`,
 * and `lambdas.ts`'s `LambdaResources.dnsUpdaterFunction`/`dnsUpdaterLogGroup`/
 * `ecsTaskChangeRule`/`dnsUpdaterEventTarget`/`dnsUpdaterEventBridgePermission`.
 * This file's only job is the hosted-zone data source those resources
 * reference by ID, threaded as the `hostedZoneId` parameter both of those
 * files' docs describe.
 *
 * ## INVARIANT: no DNS record resources
 *
 * This file declares NO `aws.route53.Record` resource, matching the
 * CLAUDE.md invariant "DNS records are Lambda-managed, never
 * infra-program-managed." Per-game DNS records are written exclusively by the
 * update-dns Lambda at runtime — `UPSERT` on `RUNNING`, `DELETE` on
 * `STOPPED` — and a Pulumi-owned record for the same name would fight those
 * writes on every `pulumi up`/refresh. See `route53.test.ts`'s negative
 * assertion (`aws:route53/record:Record` never appears in the resources this
 * module's `defineRoute53` constructs).
 *
 * ## The Discord custom domain is declared in `discordDomain.ts`
 *
 * `discordDomain.ts`'s `defineDiscordDomain` declares a CloudFront-fronted
 * custom domain (`discord.<hosted_zone_name>`) for the interactions Function
 * URL, including its own three Route 53 records — wired into `program.ts`'s
 * `defineAll` as a separate `discordDomain` resource area, not through this
 * file. This file's `defineRoute53` still declares no `aws.route53.Record` of
 * any kind (see the INVARIANT section above); those three records are
 * declared by a different function entirely. See `discordDomain.ts`'s file
 * doc for why they do NOT violate this file's "no DNS records" invariant
 * despite living in the same `defineAll` resource graph.
 */

import * as aws from '@pulumi/aws';
import type * as pulumi from '@pulumi/pulumi';

/** The resource {@link defineRoute53} declares. */
export interface Route53Resources {
  /** The full hosted-zone lookup result (`data.aws_route53_zone.main`). */
  zone: pulumi.Output<aws.route53.GetZoneResult>;
  /**
   * Convenience accessor for `zone.zoneId` — the deferred `hostedZoneId`
   * input `iam.ts`'s `defineIamPolicies` and `lambdas.ts`'s `defineLambdas`
   * both declare (see either file's doc). Equivalent to
   * `zone.apply((z) => z.zoneId)`, exposed directly so `program.ts`'s
   * `defineAll` wiring doesn't need to re-derive it at every call site.
   */
  zoneId: pulumi.Output<string>;
}

/** Arguments {@link defineRoute53} needs to look up the hosted zone. */
export interface DefineRoute53Args {
  /** Mirrors `var.hosted_zone_name` — the domain name of the pre-existing hosted zone to look up (`DeploymentConfig.hostedZoneName`). */
  hostedZoneName: string;
  /** The regional AWS provider the lookup is invoked against (region + default tags) — the us-east-1-pinned provider used by `discordDomain.ts` is not relevant here. */
  provider: aws.Provider;
}

/**
 * Looks up the pre-existing Route 53 hosted zone by name — see this file's
 * doc for the no-DNS-records invariant. Must be called from inside the
 * Pulumi inline-program closure, never at module scope (matches every other
 * `defineX` in this package, even though a data-source lookup has no
 * resource lifecycle of its own to scope).
 *
 * `privateZone: false` is passed explicitly — the hosted zone this program
 * manages DNS through is always public.
 *
 * @param args - The hosted-zone name and provider — see {@link DefineRoute53Args}.
 * @returns The lookup result — see {@link Route53Resources}.
 */
export function defineRoute53(args: DefineRoute53Args): Route53Resources {
  const { hostedZoneName, provider } = args;

  const zone = aws.route53.getZoneOutput({ name: hostedZoneName, privateZone: false }, { provider });
  const zoneId = zone.apply((result) => result.zoneId);

  return { zone, zoneId };
}
