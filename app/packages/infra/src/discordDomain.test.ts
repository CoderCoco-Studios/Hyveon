import * as aws from '@pulumi/aws';
import { beforeEach, describe, expect, it } from 'vitest';
import { defineDiscordDomain } from './discordDomain.js';
import { installPulumiMocks, promiseOf } from './testing/pulumiMocks.js';

/**
 * No test in this file exercises a conditionality gate: unlike
 * `escapes.ts`'s two DynamoDB table items, `discord-domain.tf` has no
 * top-level `count`/`for_each` gate — every resource here is declared
 * unconditionally on every deploy (see `discordDomain.ts`'s file doc, "No
 * conditionality gate"). There is therefore no on/off permutation to assert
 * against `DeploymentConfig`.
 */
describe('defineDiscordDomain', () => {
  let mocks: ReturnType<typeof installPulumiMocks>;
  let provider: aws.Provider;
  let usEast1Provider: aws.Provider;

  beforeEach(() => {
    mocks = installPulumiMocks();
    provider = new aws.Provider('aws', { region: 'us-west-2' });
    usEast1Provider = new aws.Provider('aws-us-east-1', { region: 'us-east-1' });
  });

  /** Constructs a real (mocked) resource graph and settles it, returning the mock handle's live `resources`/`calls` arrays plus the constructed handles. */
  async function run(overrides: Partial<Parameters<typeof defineDiscordDomain>[0]> = {}) {
    const result = defineDiscordDomain({
      projectName: 'hyveon',
      hostedZoneName: 'example.com',
      zoneId: 'Z1234567890ABC',
      interactionsFunctionUrl: 'https://abc123.lambda-url.us-east-1.on.aws/',
      provider,
      usEast1Provider,
      ...overrides,
    });
    await Promise.all([
      promiseOf(result.aliasRecord.id),
      promiseOf(result.aliasRecordAaaa.id),
    ]);
    return result;
  }

  it('should declare the ACM certificate for discord.{hostedZoneName} with DNS validation', async () => {
    const result = await run();

    expect(await promiseOf(result.certificate.domainName)).toBe('discord.example.com');
    expect(await promiseOf(result.certificate.validationMethod)).toBe('DNS');

    const certResource = mocks.resources.find((resource) => resource.type === 'aws:acm/certificate:Certificate');
    expect(certResource?.inputs.tags).toEqual({ Name: 'hyveon-discord-tls' });
  });

  it('should register the ACM certificate and its validation against the us-east-1 provider, and every other resource against the regional provider', async () => {
    await run();

    const byName = (name: string) => mocks.resources.find((resource) => resource.name === name);

    const certificate = byName('hyveon-discord-cert');
    const certificateValidation = byName('hyveon-discord-cert-validation');
    const validationRecord = byName('hyveon-discord-acm-validation');
    const distribution = byName('hyveon-discord-cf');
    const aliasA = byName('hyveon-discord-alias-a');
    const aliasAaaa = byName('hyveon-discord-alias-aaaa');

    expect(certificate?.provider).toBeDefined();
    expect(certificateValidation?.provider).toBe(certificate?.provider);

    // Every other resource shares one provider identity, and it's NOT the
    // us-east-1 one the certificate/validation used.
    expect(validationRecord?.provider).toBeDefined();
    expect(validationRecord?.provider).not.toBe(certificate?.provider);
    expect(distribution?.provider).toBe(validationRecord?.provider);
    expect(aliasA?.provider).toBe(validationRecord?.provider);
    expect(aliasAaaa?.provider).toBe(validationRecord?.provider);
  });

  it('should derive the validation Route 53 record from the certificate domain validation options, into the configured zone', async () => {
    const result = await run();

    expect(await promiseOf(result.certificateValidationRecord.zoneId)).toBe('Z1234567890ABC');
    expect(await promiseOf(result.certificateValidationRecord.name)).toBe('_acme-challenge.discord.example.com.');
    expect(await promiseOf(result.certificateValidationRecord.type)).toBe('CNAME');
    expect(await promiseOf(result.certificateValidationRecord.records)).toEqual([
      '_acme-challenge-target.discord.example.com.acm-validations.aws.',
    ]);
    expect(await promiseOf(result.certificateValidationRecord.ttl)).toBe(300);
    expect(await promiseOf(result.certificateValidationRecord.allowOverwrite)).toBe(true);
  });

  it('should wait for validation using the validation record fqdn against the certificate arn', async () => {
    const result = await run();

    expect(await promiseOf(result.certificateValidation.certificateArn)).toBe(await promiseOf(result.certificate.arn));
    expect(await promiseOf(result.certificateValidation.validationRecordFqdns)).toEqual([
      await promiseOf(result.certificateValidationRecord.fqdn),
    ]);
  });

  it('should strip the https:// prefix and trailing slash from the interactions Function URL to build the CloudFront origin domain', async () => {
    await run({ interactionsFunctionUrl: 'https://xyz789.lambda-url.eu-west-1.on.aws/' });

    const distribution = mocks.resources.find((resource) => resource.name === 'hyveon-discord-cf');
    const origins = distribution?.inputs.origins as Array<Record<string, unknown>>;
    expect(origins).toHaveLength(1);
    expect(origins[0].domainName).toBe('xyz789.lambda-url.eu-west-1.on.aws');
    expect(origins[0].originId).toBe('interactions-lambda');
    expect(origins[0].customOriginConfig).toEqual({
      httpPort: 80,
      httpsPort: 443,
      originProtocolPolicy: 'https-only',
      originSslProtocols: ['TLSv1.2'],
    });
  });

  it('should declare the CloudFront distribution with the exact cache behavior, restrictions, and alias attributes from the HCL', async () => {
    await run();

    const distribution = mocks.resources.find((resource) => resource.name === 'hyveon-discord-cf');
    expect(distribution?.inputs.comment).toBe('hyveon Discord interactions proxy');
    expect(distribution?.inputs.enabled).toBe(true);
    expect(distribution?.inputs.isIpv6Enabled).toBe(true);
    expect(distribution?.inputs.priceClass).toBe('PriceClass_100');
    expect(distribution?.inputs.aliases).toEqual(['discord.example.com']);
    expect(distribution?.inputs.waitForDeployment).toBe(false);
    expect(distribution?.inputs.defaultCacheBehavior).toEqual({
      targetOriginId: 'interactions-lambda',
      viewerProtocolPolicy: 'redirect-to-https',
      allowedMethods: ['GET', 'HEAD', 'OPTIONS', 'PUT', 'POST', 'PATCH', 'DELETE'],
      cachedMethods: ['GET', 'HEAD'],
      cachePolicyId: '4135ea2d-6df8-44a3-9df3-4b5a84be39ad',
      originRequestPolicyId: 'b689b0a8-53d0-40ab-baf2-68738e2966ac',
    });
    expect(distribution?.inputs.restrictions).toEqual({ geoRestriction: { restrictionType: 'none' } });
    expect(distribution?.inputs.tags).toEqual({ Name: 'hyveon-discord-cf' });
  });

  it("should set the distribution's viewer certificate to the validated certificate's arn with sni-only and TLSv1.2_2021", async () => {
    const result = await run();

    const distribution = mocks.resources.find((resource) => resource.name === 'hyveon-discord-cf');
    expect(distribution?.inputs.viewerCertificate).toEqual({
      acmCertificateArn: await promiseOf(result.certificateValidation.certificateArn),
      sslSupportMethod: 'sni-only',
      minimumProtocolVersion: 'TLSv1.2_2021',
    });
  });

  it('should declare an A and an AAAA alias record for discord.{hostedZoneName}, both aliasing the CloudFront distribution', async () => {
    const result = await run();

    const expectedAlias = {
      name: await promiseOf(result.distribution.domainName),
      zoneId: await promiseOf(result.distribution.hostedZoneId),
      evaluateTargetHealth: false,
    };

    expect(await promiseOf(result.aliasRecord.zoneId)).toBe('Z1234567890ABC');
    expect(await promiseOf(result.aliasRecord.name)).toBe('discord.example.com');
    expect(await promiseOf(result.aliasRecord.type)).toBe('A');
    expect(await promiseOf(result.aliasRecord.aliases)).toEqual([expectedAlias]);

    expect(await promiseOf(result.aliasRecordAaaa.zoneId)).toBe('Z1234567890ABC');
    expect(await promiseOf(result.aliasRecordAaaa.name)).toBe('discord.example.com');
    expect(await promiseOf(result.aliasRecordAaaa.type)).toBe('AAAA');
    expect(await promiseOf(result.aliasRecordAaaa.aliases)).toEqual([expectedAlias]);
  });

  it('should declare exactly six resources: certificate, its validation record, its validation, the distribution, and two alias records', async () => {
    await run();

    const types = mocks.resources.map((resource) => resource.type).filter((type) => !type.startsWith('pulumi:providers:'));
    expect(types.sort()).toEqual(
      [
        'aws:acm/certificate:Certificate',
        'aws:acm/certificateValidation:CertificateValidation',
        'aws:cloudfront/distribution:Distribution',
        'aws:route53/record:Record',
        'aws:route53/record:Record',
        'aws:route53/record:Record',
      ].sort(),
    );
  });
});
