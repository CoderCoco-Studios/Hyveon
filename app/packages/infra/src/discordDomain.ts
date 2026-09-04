/**
 * The Discord custom domain — `discord.{hostedZoneName}`.
 *
 * Lambda Function URLs can't be Route 53 ALIAS targets, so the interactions
 * Lambda is fronted by a CloudFront distribution and the custom subdomain
 * points at *that*:
 *
 * ```text
 * discord.{hostedZoneName}
 *   → Route 53 ALIAS → CloudFront distribution
 *     → Lambda Function URL (HTTPS origin)
 * ```
 *
 * This resource set is unconditional — always declared, no `DeploymentConfig`
 * field disables it. The three Route 53 records it declares
 * ({@link DiscordDomainResources.certificateValidationRecord},
 * {@link DiscordDomainResources.aliasRecord}, {@link DiscordDomainResources.aliasRecordAaaa})
 * are static infrastructure for this one fixed domain — never per-game,
 * never written by any Lambda — so they do not violate `route53.ts`'s
 * "no DNS record resources" invariant (see that file's doc).
 *
 * ## us-east-1 provider — ACM certificate + its validation ONLY
 *
 * CloudFront requires its ACM certificate to exist in `us-east-1` regardless
 * of the stack's deployment region. {@link DefineDiscordDomainArgs} takes two
 * separate `aws.Provider` handles for exactly this reason:
 * {@link DefineDiscordDomainArgs.usEast1Provider} is threaded ONLY into
 * {@link DiscordDomainResources.certificate} and
 * {@link DiscordDomainResources.certificateValidation}; every other resource
 * below uses {@link DefineDiscordDomainArgs.provider} (the regional default).
 *
 * The certificate covers only `discord.{hostedZoneName}` — no subject
 * alternative names — so ACM's `domainValidationOptions` always has exactly
 * one entry; {@link DiscordDomainResources.certificateValidationRecord}
 * indexes it directly rather than mapping over the array.
 */

import * as aws from '@pulumi/aws';
import * as pulumi from '@pulumi/pulumi';
import { stripTrailingDots } from './hostedZoneName.js';

/** Managed CloudFront cache-policy ID for the AWS-managed `CachingDisabled` policy — every Discord interaction is unique, so caching must stay off. */
const CACHING_DISABLED_POLICY_ID = '4135ea2d-6df8-44a3-9df3-4b5a84be39ad';

/**
 * Managed CloudFront origin-request-policy ID for the AWS-managed
 * `AllViewerExceptHostHeader` policy — forwards `Content-Type`,
 * `X-Signature-Ed25519`, `X-Signature-Timestamp`, and every other viewer
 * header to the Lambda, while letting CloudFront set `Host` to the origin
 * hostname (the Lambda Function URL uses its own `Host` header for routing).
 */
const ALL_VIEWER_EXCEPT_HOST_HEADER_POLICY_ID = 'b689b0a8-53d0-40ab-baf2-68738e2966ac';

/** Every resource {@link defineDiscordDomain} declares. */
export interface DiscordDomainResources {
  /** The us-east-1 ACM certificate for `discord.{hostedZoneName}`. */
  certificate: aws.acm.Certificate;
  /** The DNS validation record for {@link certificate} — see this file's doc, "Certificate has a single domain, so validation needs only one record." */
  certificateValidationRecord: aws.route53.Record;
  /** Blocks on {@link certificateValidationRecord} until ACM confirms the certificate issued. */
  certificateValidation: aws.acm.CertificateValidation;
  /** The CloudFront distribution fronting the interactions Function URL. */
  distribution: aws.cloudfront.Distribution;
  /** The `A` ALIAS record pointing `discord.{hostedZoneName}` at {@link distribution}. */
  aliasRecord: aws.route53.Record;
  /** The `AAAA` ALIAS record, identical target to {@link aliasRecord}. */
  aliasRecordAaaa: aws.route53.Record;
}

/** Arguments {@link defineDiscordDomain} needs to declare the Discord custom domain. */
export interface DefineDiscordDomainArgs {
  /** Every resource's Pulumi logical name and `Name` tag below is `${projectName}-...`. */
  projectName: string;
  /** `discord.${hostedZoneName}` is the domain this whole file provisions. */
  hostedZoneName: string;
  /** The hosted zone's ID (`route53.ts`'s `Route53Resources.zoneId`) — every Route 53 record below is declared into it. */
  zoneId: pulumi.Input<string>;
  /**
   * The interactions Lambda's Function URL (`lambdas.ts`'s
   * `LambdaResources.interactionsFunctionUrl.functionUrl`) — CloudFront's
   * origin. This file strips the `https://` prefix and trailing `/` off it
   * internally to get the bare hostname CloudFront needs as its origin domain.
   */
  interactionsFunctionUrl: pulumi.Input<string>;
  /** The regional AWS provider — every resource EXCEPT {@link certificate}/{@link certificateValidation} is declared against this (region + default tags). See this file's doc, "us-east-1 provider — ACM certificate + its validation ONLY." */
  provider: aws.Provider;
  /** The us-east-1-pinned AWS provider, threaded ONLY into the ACM certificate and its validation — see this file's doc, "us-east-1 provider — ACM certificate + its validation ONLY." */
  usEast1Provider: aws.Provider;
}

/**
 * Declares the Discord custom-domain resource set — see this file's doc for
 * the certificate/validation rationale and the us-east-1 provider split.
 * Must be called from inside the Pulumi inline-program closure, never at
 * module scope, and after `lambdas.ts`'s `defineLambdas` (its
 * `interactionsFunctionUrl.functionUrl` is a required input here) and
 * `route53.ts`'s `defineRoute53` (its `zoneId`).
 *
 * @param args - Naming, config, and the upstream resource references this
 *   file threads through — see {@link DefineDiscordDomainArgs}.
 * @returns Every declared resource — see {@link DiscordDomainResources}.
 */
export function defineDiscordDomain(args: DefineDiscordDomainArgs): DiscordDomainResources {
  const { projectName, hostedZoneName, zoneId, interactionsFunctionUrl, provider, usEast1Provider } = args;

  // ACM's `domain_name` rejects any value ending in a period, so strip
  // any trailing dot before building the FQDN — see `hostedZoneName.ts`.
  const discordDomainName = `discord.${stripTrailingDots(hostedZoneName)}`;

  // Strips "https://" and a trailing "/" from the Lambda Function URL to get
  // the bare hostname CloudFront needs as its origin domain.
  const interactionsLambdaDomain = pulumi
    .output(interactionsFunctionUrl)
    .apply((url) => url.replace(/^https:\/\//, '').replace(/\/$/, ''));

  // ── ACM Certificate (us-east-1 only) ─────────────────────────────────────
  const certificate = new aws.acm.Certificate(
    `${projectName}-discord-cert`,
    {
      domainName: discordDomainName,
      validationMethod: 'DNS',
      tags: { Name: `${projectName}-discord-tls` },
    },
    { provider: usEast1Provider },
  );

  // Exactly one entry — see this file's doc, "Certificate has a single
  // domain, so validation needs only one record."
  const domainValidationOption = certificate.domainValidationOptions[0];

  const certificateValidationRecord = new aws.route53.Record(
    `${projectName}-discord-acm-validation`,
    {
      zoneId,
      name: domainValidationOption.resourceRecordName,
      type: domainValidationOption.resourceRecordType,
      records: [domainValidationOption.resourceRecordValue],
      ttl: 300,
      allowOverwrite: true,
    },
    { provider },
  );

  const certificateValidation = new aws.acm.CertificateValidation(
    `${projectName}-discord-cert-validation`,
    {
      certificateArn: certificate.arn,
      validationRecordFqdns: [certificateValidationRecord.fqdn],
    },
    { provider: usEast1Provider },
  );

  // ── CloudFront Distribution ──────────────────────────────────────────────
  const distribution = new aws.cloudfront.Distribution(
    `${projectName}-discord-cf`,
    {
      comment: `${projectName} Discord interactions proxy`,
      enabled: true,
      isIpv6Enabled: true,
      priceClass: 'PriceClass_100', // US, Canada, Europe — cheapest tier
      aliases: [discordDomainName],
      waitForDeployment: false,
      origins: [
        {
          domainName: interactionsLambdaDomain,
          originId: 'interactions-lambda',
          customOriginConfig: {
            httpPort: 80,
            httpsPort: 443,
            originProtocolPolicy: 'https-only',
            originSslProtocols: ['TLSv1.2'],
          },
        },
      ],
      defaultCacheBehavior: {
        targetOriginId: 'interactions-lambda',
        viewerProtocolPolicy: 'redirect-to-https',
        allowedMethods: ['GET', 'HEAD', 'OPTIONS', 'PUT', 'POST', 'PATCH', 'DELETE'],
        cachedMethods: ['GET', 'HEAD'],
        cachePolicyId: CACHING_DISABLED_POLICY_ID,
        originRequestPolicyId: ALL_VIEWER_EXCEPT_HOST_HEADER_POLICY_ID,
      },
      restrictions: {
        geoRestriction: { restrictionType: 'none' },
      },
      viewerCertificate: {
        // References `certificateValidation`, not `certificate` directly —
        // the distribution must not be created against a not-yet-issued cert.
        acmCertificateArn: certificateValidation.certificateArn,
        sslSupportMethod: 'sni-only',
        minimumProtocolVersion: 'TLSv1.2_2021',
      },
      tags: { Name: `${projectName}-discord-cf` },
    },
    { provider },
  );

  // ── Route 53 ALIAS records ────────────────────────────────────────────────
  const aliasRecord = new aws.route53.Record(
    `${projectName}-discord-alias-a`,
    {
      zoneId,
      name: discordDomainName,
      type: 'A',
      aliases: [{ name: distribution.domainName, zoneId: distribution.hostedZoneId, evaluateTargetHealth: false }],
    },
    { provider },
  );

  const aliasRecordAaaa = new aws.route53.Record(
    `${projectName}-discord-alias-aaaa`,
    {
      zoneId,
      name: discordDomainName,
      type: 'AAAA',
      aliases: [{ name: distribution.domainName, zoneId: distribution.hostedZoneId, evaluateTargetHealth: false }],
    },
    { provider },
  );

  return { certificate, certificateValidationRecord, certificateValidation, distribution, aliasRecord, aliasRecordAaaa };
}
