import * as aws from '@pulumi/aws';
import { describe, expect, it } from 'vitest';
import { defineRoute53 } from './route53.js';
import { installPulumiMocks, promiseOf } from './testing/pulumiMocks.js';

describe('defineRoute53', () => {
  it('should look up the hosted zone by the configured name with privateZone false', async () => {
    const mocks = installPulumiMocks();
    const provider = new aws.Provider('aws', { region: 'us-east-1' });

    const { zone } = defineRoute53({ hostedZoneName: 'example.com', provider });
    await promiseOf(zone);

    const call = mocks.calls.find((recorded) => recorded.token === 'aws:route53/getZone:getZone');
    expect(call?.inputs).toEqual({ name: 'example.com', privateZone: false });
  });

  it('should resolve zoneId from the mocked lookup result', async () => {
    installPulumiMocks();
    const provider = new aws.Provider('aws', { region: 'us-east-1' });

    const { zoneId } = defineRoute53({ hostedZoneName: 'example.com', provider });
    expect(await promiseOf(zoneId)).toBe('Z1234567890ABC');
  });

  it('should expose zoneId as zone.zoneId resolved to the same value', async () => {
    installPulumiMocks();
    const provider = new aws.Provider('aws', { region: 'us-east-1' });

    const { zone, zoneId } = defineRoute53({ hostedZoneName: 'example.com', provider });
    const [resolvedZone, resolvedZoneId] = await Promise.all([promiseOf(zone), promiseOf(zoneId)]);
    expect(resolvedZone.zoneId).toBe(resolvedZoneId);
  });

  it('should declare no aws.route53.Record resource — DNS records are Lambda-managed, never Pulumi-managed', async () => {
    const mocks = installPulumiMocks();
    const provider = new aws.Provider('aws', { region: 'us-east-1' });

    const { zone } = defineRoute53({ hostedZoneName: 'example.com', provider });
    await promiseOf(zone);

    const types = mocks.resources.map((resource) => resource.type);
    expect(types).not.toContain('aws:route53/record:Record');
    // `defineRoute53` is a pure data-source lookup — it should construct no
    // CUSTOM resource of its own at all (the only recorded resource here is
    // the test's own `pulumi:providers:aws` provider, which every `defineX`
    // spec in this package also records as a side effect of constructing it).
    expect(mocks.resources.filter((resource) => resource.type !== 'pulumi:providers:aws')).toEqual([]);
  });
});
