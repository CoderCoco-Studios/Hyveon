/**
 * The Discord custom domain — `discord.{hostedZoneName}` — ported from
 * `terraform/aws/discord-domain.tf` (task 3.x, a plan-gap dispatch: the file
 * was discovered during 3.8–3.10 to be unassigned to any task in
 * `tasks.md`'s list; see `route53.ts`'s file doc, "Explicitly out of scope:
 * `terraform/aws/discord-domain.tf`," for that gap's original write-up).
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
 * | HCL address | This file |
 * | --- | --- |
 * | `aws_acm_certificate.discord` | {@link DiscordDomainResources.certificate} |
 * | `aws_route53_record.discord_acm_validation` (`for_each`) | {@link DiscordDomainResources.certificateValidationRecord} |
 * | `aws_acm_certificate_validation.discord` | {@link DiscordDomainResources.certificateValidation} |
 * | `aws_cloudfront_distribution.discord` | {@link DiscordDomainResources.distribution} |
 * | `aws_route53_record.discord` | {@link DiscordDomainResources.aliasRecord} |
 * | `aws_route53_record.discord_aaaa` | {@link DiscordDomainResources.aliasRecordAaaa} |
 *
 * ## No conditionality gate
 *
 * Unlike `escapes.ts`'s two DynamoDB table items, this file's whole resource
 * set is UNCONDITIONAL: `discord-domain.tf` has no top-level `count`/
 * `for_each` gate and no HCL variable controls whether any of its six
 * resources exist — they are declared every deploy, mirrored here the same
 * way. There is therefore no `DeploymentConfig` gate field to thread through
 * (checked: no `enable_discord_domain`-shaped variable exists anywhere in
 * `terraform/variables.tf` or `terraform/aws/variables.tf`).
 *
 * ## `for_each` over `domain_validation_options` → a single Route 53 record
 *
 * The HCL's `aws_route53_record.discord_acm_validation` uses `for_each` over
 * `aws_acm_certificate.discord.domain_validation_options` — a map keyed by
 * domain name, so it declares one validation record per domain the
 * certificate covers. `aws_acm_certificate.discord` has no
 * `subject_alternative_names` — only `domain_name = local.discord_domain` —
 * so that map is ALWAYS exactly one entry; `for_each` never actually
 * iterates more than once for this specific certificate. This file mirrors
 * that concretely: {@link DiscordDomainResources.certificateValidationRecord}
 * indexes `certificate.domainValidationOptions[0]` directly (the standard
 * Pulumi pattern for a single-domain ACM DNS-validated certificate — see the
 * AWS provider's own `CertificateValidation` example) rather than mapping
 * over a dynamically-sized array inside an `.apply` (a technique Pulumi
 * supports but that produces resources outside the engine's own dependency
 * graph, undesirable for a single-cardinality case that gains nothing from
 * it). If this certificate ever gained `subjectAlternativeNames`, this
 * function would need revisiting — it deliberately does not attempt to
 * generalize past what the retired HCL ever actually needed.
 *
 * ## us-east-1 provider alias — ACM certificate + its validation ONLY
 *
 * CloudFront requires its ACM certificate to exist in `us-east-1` regardless
 * of the stack's deployment region — `terraform/main.tf`'s aliased provider
 * block (`provider "aws" { alias = "us_east_1" ... }`) comment says so
 * explicitly, and `discord-domain.tf` pins exactly two resources to it:
 * `aws_acm_certificate.discord` and
 * `aws_acm_certificate_validation.discord` (`provider = aws.us_east_1` on
 * both). Every other resource in the HCL file — the validation Route 53
 * record, the CloudFront distribution itself (a global-edge service; its
 * *control-plane* API call can be made from any region), and the two alias
 * Route 53 records — carries no `provider =` line, i.e. the HCL's default
 * (regional) provider. This file's {@link DefineDiscordDomainArgs} takes two
 * separate `aws.Provider` handles for exactly this reason —
 * {@link DefineDiscordDomainArgs.usEast1Provider} is threaded ONLY into
 * {@link DiscordDomainResources.certificate} and
 * {@link DiscordDomainResources.certificateValidation}'s resource options;
 * every other resource below uses {@link DefineDiscordDomainArgs.provider}
 * (the regional default), exactly matching the HCL's per-resource provider
 * pinning. `program.ts`'s `defineAll` constructs the us-east-1 provider once
 * and passes it here — see that file's doc.
 *
 * ## `create_before_destroy` needs no explicit Pulumi option
 *
 * The HCL's `aws_acm_certificate.discord` carries
 * `lifecycle { create_before_destroy = true }`. Terraform's own default is
 * destroy-before-create on replacement, so that block opts INTO
 * create-before-destroy. Pulumi's default replacement behavior is the
 * opposite: `deleteBeforeReplace` defaults to `false`, i.e. Pulumi already
 * creates the replacement before deleting the original unless told
 * otherwise. No `CustomResourceOptions` entry is needed to reproduce this
 * HCL block — Pulumi's default already matches it.
 *
 * ## IMPORTANT NUANCE — these three Route 53 records do NOT violate the
 * "no per-game DNS records" invariant
 *
 * CLAUDE.md's invariant ("DNS records are Lambda-managed, never
 * Terraform-managed") and `route53.ts`'s own no-DNS-records assertion are
 * about *per-game* records (`{game}.{hostedZoneName}`), written exclusively
 * by the already-ported update-dns Lambda at runtime (`UPSERT` on `RUNNING`,
 * `DELETE` on `STOPPED`) — a Pulumi-owned record for the same name would
 * fight those writes on every `pulumi up`/refresh. The three records this
 * file declares ({@link DiscordDomainResources.certificateValidationRecord},
 * {@link DiscordDomainResources.aliasRecord},
 * {@link DiscordDomainResources.aliasRecordAaaa}) are static infrastructure
 * for the Discord interactions custom domain — fixed at
 * `discord.{hostedZoneName}`, never per-game, never written by any Lambda —
 * so there is no invariant forbidding Pulumi from owning them, and the HCL
 * itself already declared them as plain (non-Lambda-managed) Terraform
 * resources. `program.test.ts`'s `defineAll` spec asserts the FULL expected
 * three-record set by name so a stray per-game record slipping in still
 * fails that test, rather than merely weakening the old "no records at all"
 * assertion.
 *
 * ## Note for task 3.11 (stack outputs)
 *
 * `terraform/aws/outputs.tf`'s `interactions_invoke_url` AND
 * `discord_interactions_url` outputs BOTH resolve to the custom domain
 * (`"https://discord.${var.hosted_zone_name}/"` / the equivalent `local`
 * value) — NEITHER one outputs the raw Lambda Function URL. Whichever stack
 * output(s) task 3.11 declares for these must reference
 * {@link DiscordDomainResources.aliasRecord}'s `name` (or simply the fixed
 * `discord.{hostedZoneName}` string this file already computes) — not
 * `lambdas.ts`'s `LambdaResources.interactionsFunctionUrl.functionUrl`.
 */

import * as aws from '@pulumi/aws';
import * as pulumi from '@pulumi/pulumi';

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

/** Every resource {@link defineDiscordDomain} declares — see this file's doc for the full HCL→Pulumi address table. */
export interface DiscordDomainResources {
  /** The us-east-1 ACM certificate for `discord.{hostedZoneName}` (`aws_acm_certificate.discord`). */
  certificate: aws.acm.Certificate;
  /** The DNS validation record for {@link certificate} (`aws_route53_record.discord_acm_validation`) — see this file's doc, "`for_each` over `domain_validation_options` → a single Route 53 record." */
  certificateValidationRecord: aws.route53.Record;
  /** Blocks on {@link certificateValidationRecord} until ACM confirms the certificate issued (`aws_acm_certificate_validation.discord`). */
  certificateValidation: aws.acm.CertificateValidation;
  /** The CloudFront distribution fronting the interactions Function URL (`aws_cloudfront_distribution.discord`). */
  distribution: aws.cloudfront.Distribution;
  /** The `A` ALIAS record pointing `discord.{hostedZoneName}` at {@link distribution} (`aws_route53_record.discord`). */
  aliasRecord: aws.route53.Record;
  /** The `AAAA` ALIAS record, identical target to {@link aliasRecord} (`aws_route53_record.discord_aaaa`). */
  aliasRecordAaaa: aws.route53.Record;
}

/** Arguments {@link defineDiscordDomain} needs to declare the Discord custom domain. */
export interface DefineDiscordDomainArgs {
  /** Mirrors `var.project_name` — every resource's Pulumi logical name and `Name` tag below is `${projectName}-...`. */
  projectName: string;
  /** Mirrors `var.hosted_zone_name` — `discord.${hostedZoneName}` is the domain this whole file provisions. */
  hostedZoneName: string;
  /** The hosted zone's ID (`route53.ts`'s `Route53Resources.zoneId`) — every Route 53 record below is declared into it. */
  zoneId: pulumi.Input<string>;
  /**
   * The interactions Lambda's Function URL (`lambdas.ts`'s
   * `LambdaResources.interactionsFunctionUrl.functionUrl`) — CloudFront's
   * origin. Mirrors the HCL's
   * `local.interactions_lambda_domain = trimsuffix(replace(aws_lambda_function_url.interactions.function_url, "https://", ""), "/")`;
   * this file strips the same `https://` prefix and trailing `/` internally.
   */
  interactionsFunctionUrl: pulumi.Input<string>;
  /** The regional AWS provider — every resource EXCEPT {@link certificate}/{@link certificateValidation} is declared against this (region + default tags). See this file's doc, "us-east-1 provider alias." */
  provider: aws.Provider;
  /** The us-east-1-pinned AWS provider, threaded ONLY into the ACM certificate and its validation — see this file's doc, "us-east-1 provider alias." */
  usEast1Provider: aws.Provider;
}

/**
 * Declares the Discord custom-domain resource set (task 3.x of
 * `migrate-iac-to-pulumi`) — see this file's doc for the full HCL→Pulumi
 * mapping, the `for_each`-collapse rationale, and the us-east-1 provider
 * split. Must be called from inside the Pulumi inline-program closure, never
 * at module scope, and after `lambdas.ts`'s `defineLambdas` (its
 * `interactionsFunctionUrl.functionUrl` is a required input here) and
 * `route53.ts`'s `defineRoute53` (its `zoneId`).
 *
 * @param args - Naming, config, and the upstream resource references this
 *   file threads through — see {@link DefineDiscordDomainArgs}.
 * @returns Every declared resource — see {@link DiscordDomainResources}.
 */
export function defineDiscordDomain(args: DefineDiscordDomainArgs): DiscordDomainResources {
  const { projectName, hostedZoneName, zoneId, interactionsFunctionUrl, provider, usEast1Provider } = args;

  const discordDomainName = `discord.${hostedZoneName}`;

  // Strips "https://" and a trailing "/" from the Lambda Function URL to get
  // the bare hostname CloudFront needs as its origin domain — mirrors the
  // HCL's `local.interactions_lambda_domain`.
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

  // Exactly one entry — see this file's doc, "`for_each` over
  // `domain_validation_options` → a single Route 53 record."
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
        // matches the HCL's `aws_acm_certificate_validation.discord.certificate_arn`
        // (the distribution must not be created against a not-yet-issued cert).
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
