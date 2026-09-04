/**
 * Route 53 hosted-zone lookup — the pre-existing hosted zone's ID, looked up
 * by name and exposed for other resources to reference. The DNS-updater
 * Lambda and its wiring are declared elsewhere (`iam.ts`/`lambdas.ts`); this
 * file's only job is the hosted-zone data source those resources reference
 * by ID, threaded as the `hostedZoneId` parameter.
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
 * `discordDomain.ts` declares three static Route 53 records for the fixed
 * Discord custom domain — see that file's doc for why those do NOT violate
 * this invariant.
 */

import * as aws from '@pulumi/aws';
import type * as pulumi from '@pulumi/pulumi';

/** The resource {@link defineRoute53} declares. */
export interface Route53Resources {
  /** The full hosted-zone lookup result. */
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
  /** The domain name of the pre-existing hosted zone to look up (`DeploymentConfig.hostedZoneName`). */
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
