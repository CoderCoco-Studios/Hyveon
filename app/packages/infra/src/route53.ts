/**
 * Route 53 hosted-zone lookup — ported from `terraform/aws/route53.tf`'s
 * `data "aws_route53_zone" "main"` block ONLY (task 3.9 of
 * `migrate-iac-to-pulumi`). Every other resource declared in that file —
 * the DNS-updater Lambda, its IAM role/policy, its CloudWatch log group, the
 * ECS-task-state-change EventBridge rule/target, and its EventBridge
 * permission — was already ported by tasks 3.5–3.7: `iam.ts`'s
 * `IamRoleResources.dnsUpdaterLambdaRole`/`IamPolicyResources.dnsUpdaterLambdaPolicy`,
 * and `lambdas.ts`'s `LambdaResources.dnsUpdaterFunction`/`dnsUpdaterLogGroup`/
 * `ecsTaskChangeRule`/`dnsUpdaterEventTarget`/`dnsUpdaterEventBridgePermission`.
 * This file's only job is the hosted-zone data source those already-ported
 * resources reference by ID (`data.aws_route53_zone.main.zone_id`,
 * threaded as the deferred `hostedZoneId` parameter both of those files'
 * docs describe).
 *
 * | HCL address | This file |
 * | --- | --- |
 * | `data "aws_route53_zone" "main"` | {@link Route53Resources.zone} / {@link Route53Resources.zoneId} |
 *
 * ## INVARIANT: no DNS record resources
 *
 * This file declares NO `aws.route53.Record` resource, matching
 * `pulumi-infra-program`'s "No DNS records are declared" scenario and the
 * CLAUDE.md invariant "DNS records are Lambda-managed, never
 * Terraform-managed." Per-game DNS records are written exclusively by the
 * already-ported update-dns Lambda at runtime — `UPSERT` on `RUNNING`,
 * `DELETE` on `STOPPED` — and a Pulumi-owned record for the same name would
 * fight those writes on every `pulumi up`/refresh, exactly as the HCL's own
 * file doc already warns. See `route53.test.ts`'s negative assertion
 * (`aws:route53/record:Record` never appears in the resources this module's
 * `defineRoute53` constructs).
 *
 * ## Explicitly out of scope: `terraform/aws/discord-domain.tf`
 *
 * That file's six resources (`aws_acm_certificate.discord`,
 * `aws_route53_record.discord_acm_validation` (`for_each`),
 * `aws_acm_certificate_validation.discord`, `aws_cloudfront_distribution.discord`,
 * `aws_route53_record.discord`, `aws_route53_record.discord_aaaa`) build a
 * CloudFront-fronted custom domain (`discord.<hosted_zone_name>`) for the
 * interactions Function URL. They are NOT ported by this task — this task's
 * brief scopes 3.9 to "hosted-zone lookup and the updater Lambda only," and
 * none of the six are part of task 3.10's imperative-escapes list either.
 * Unlike the per-game records this file's doc excludes on architectural
 * grounds, `discord-domain.tf`'s records are static (not Lambda-managed) and
 * have no invariant forbidding a Pulumi port — they are simply unassigned to
 * any task in `tasks.md`'s current list (3.1–3.12). See the
 * task-3.8-3.10 report's "Remaining unported HCL inventory" for this gap,
 * flagged for whoever picks up task 3.12's audit (or a new task, if the
 * `discordInteractionsUrl` stack output this leaves unresolvable is judged
 * to need one).
 */

import * as aws from '@pulumi/aws';
import type * as pulumi from '@pulumi/pulumi';

/** The resource {@link defineRoute53} declares — see this file's doc for the HCL→Pulumi address table. */
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
  /** The regional AWS provider the lookup is invoked against (region + default tags) — matches the HCL's implicit default-region provider, since `data.aws_route53_zone.main` carries no explicit `provider = aws.us_east_1` (that alias is only used by `discord-domain.tf`, out of scope here). */
  provider: aws.Provider;
}

/**
 * Looks up the pre-existing Route 53 hosted zone by name (task 3.9 of
 * `migrate-iac-to-pulumi`) — see this file's doc for the full HCL→Pulumi
 * mapping and the no-DNS-records invariant. Must be called from inside the
 * Pulumi inline-program closure, never at module scope (matches every other
 * `defineX` in this package, even though a data-source lookup has no
 * resource lifecycle of its own to scope).
 *
 * `privateZone: false` is passed explicitly, matching the HCL's own
 * `private_zone = false` — the hosted zone this program manages DNS through
 * is always public.
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
