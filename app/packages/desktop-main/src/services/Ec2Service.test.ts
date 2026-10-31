import 'reflect-metadata';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import {
  EC2Client,
  DescribeNetworkInterfacesCommand,
  AuthorizeSecurityGroupIngressCommand,
  DescribeSecurityGroupRulesCommand,
  RevokeSecurityGroupIngressCommand,
} from '@aws-sdk/client-ec2';

vi.mock('../logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { Ec2Service } from './Ec2Service.js';
import type { ElectronStoreService } from './ElectronStoreService.js';
import { configServiceStub } from '../testing/config-service.fixture.js';

/** Typed stand-in for the AWS EC2 SDK client. */
const ec2Mock = mockClient(EC2Client);

/**
 * Build a minimal `ElectronStoreService` stub reporting no wizard-configured
 * AWS profile — `resolveAwsClientCredentials` resolves this to `undefined`
 * credentials, letting the globally-patched `ec2Mock` client intercept calls
 * regardless of what `credentials` the client was constructed with.
 */
function makeStore(): ElectronStoreService {
  const stub: Partial<ElectronStoreService> = { get: vi.fn().mockReturnValue(undefined) };
  return stub as ElectronStoreService;
}

describe('Ec2Service', () => {
  /** Service under test, freshly constructed per test. */
  let service: Ec2Service;

  beforeEach(() => {
    ec2Mock.reset();
    service = new Ec2Service(configServiceStub(), makeStore());
  });

  describe('getPublicIp', () => {
    it('should return the public IP when attached', async () => {
      ec2Mock.on(DescribeNetworkInterfacesCommand).resolves({
        NetworkInterfaces: [{ Association: { PublicIp: '54.1.2.3' } }],
      });
      expect(await service.getPublicIp('eni-abc')).toBe('54.1.2.3');
    });

    it('should return null when there is no association or public IP', async () => {
      ec2Mock.on(DescribeNetworkInterfacesCommand).resolves({
        NetworkInterfaces: [{}],
      });
      expect(await service.getPublicIp('eni-abc')).toBeNull();
    });

    it('should return null when no interfaces are returned', async () => {
      ec2Mock.on(DescribeNetworkInterfacesCommand).resolves({ NetworkInterfaces: [] });
      expect(await service.getPublicIp('eni-abc')).toBeNull();
    });

    it('should return null on API error', async () => {
      ec2Mock.on(DescribeNetworkInterfacesCommand).rejects(new Error('boom'));
      expect(await service.getPublicIp('eni-abc')).toBeNull();
    });

    it('should pass the ENI id through to the SDK command', async () => {
      ec2Mock.on(DescribeNetworkInterfacesCommand).resolves({ NetworkInterfaces: [] });
      await service.getPublicIp('eni-123');
      const input = ec2Mock.commandCalls(DescribeNetworkInterfacesCommand)[0]!.args[0].input;
      expect(input.NetworkInterfaceIds).toEqual(['eni-123']);
    });
  });

  describe('getPrivateIp', () => {
    it('should return the private IP when present', async () => {
      ec2Mock.on(DescribeNetworkInterfacesCommand).resolves({
        NetworkInterfaces: [{ PrivateIpAddress: '10.0.1.5' }],
      });
      expect(await service.getPrivateIp('eni-abc')).toBe('10.0.1.5');
    });

    it('should return null when the private IP is absent', async () => {
      ec2Mock.on(DescribeNetworkInterfacesCommand).resolves({ NetworkInterfaces: [{}] });
      expect(await service.getPrivateIp('eni-abc')).toBeNull();
    });

    it('should return null on API error', async () => {
      ec2Mock.on(DescribeNetworkInterfacesCommand).rejects(new Error('nope'));
      expect(await service.getPrivateIp('eni-abc')).toBeNull();
    });
  });

  describe('credentials resolution', () => {
    it('should build the EC2 client with the credentials resolveAwsClientCredentials(store) resolves', async () => {
      const store: Partial<ElectronStoreService> = {
        get: vi.fn().mockReturnValue({ profile: 'my-profile' }),
        getPastedCredentials: vi.fn().mockReturnValue({ accessKeyId: 'AKIA-test', secretAccessKey: 'secret-test' }),
      };
      const credentialedService = new Ec2Service(configServiceStub(), store as ElectronStoreService);

      let observedCredentials: unknown;
      ec2Mock.on(DescribeNetworkInterfacesCommand).callsFake(async (_input, getClient) => {
        observedCredentials = await getClient().config.credentials();
        return { NetworkInterfaces: [] };
      });
      await credentialedService.getPublicIp('eni-abc');

      expect(observedCredentials).toMatchObject({ accessKeyId: 'AKIA-test', secretAccessKey: 'secret-test' });
    });
  });

  describe('authorizeIngress', () => {
    // @spec HELPER-REACH-001
    it('should open the cidr on the tcp port with the description', async () => {
      ec2Mock.on(AuthorizeSecurityGroupIngressCommand).resolves({});
      await service.authorizeIngress('sg-1', '1.2.3.4/32', 8080, 'hyveon-filemgr:g:r');
      const input = ec2Mock.commandCalls(AuthorizeSecurityGroupIngressCommand)[0]!.args[0].input;
      expect(input.GroupId).toBe('sg-1');
      expect(input.IpPermissions).toEqual([
        { IpProtocol: 'tcp', FromPort: 8080, ToPort: 8080, IpRanges: [{ CidrIp: '1.2.3.4/32', Description: 'hyveon-filemgr:g:r' }] },
      ]);
    });

    it('should treat a duplicate rule as success', async () => {
      const dup = Object.assign(new Error('exists'), { name: 'InvalidPermission.Duplicate' });
      ec2Mock.on(AuthorizeSecurityGroupIngressCommand).rejects(dup);
      await expect(service.authorizeIngress('sg-1', '1.2.3.4/32', 8080, 'd')).resolves.toBeUndefined();
    });

    it('should throw a plain Error with the normalized message on other failures', async () => {
      ec2Mock.on(AuthorizeSecurityGroupIngressCommand).rejects(new Error('UnauthorizedOperation'));
      await expect(service.authorizeIngress('sg-1', '1.2.3.4/32', 8080, 'd')).rejects.toThrow('UnauthorizedOperation');
    });
  });

  describe('listIngressRulesByDescriptionPrefix', () => {
    // @spec HELPER-REACH-005
    it('should return only ingress rules whose description has the prefix', async () => {
      ec2Mock.on(DescribeSecurityGroupRulesCommand).resolves({
        SecurityGroupRules: [
          { SecurityGroupRuleId: 'sgr-1', Description: 'hyveon-filemgr:g:r', CidrIpv4: '1.2.3.4/32', IsEgress: false },
          { SecurityGroupRuleId: 'sgr-2', Description: 'other', IsEgress: false },
          { SecurityGroupRuleId: 'sgr-3', Description: 'hyveon-filemgr:g:r', IsEgress: true },
        ],
      });
      expect(await service.listIngressRulesByDescriptionPrefix('sg-1', 'hyveon-filemgr:')).toEqual([
        { ruleId: 'sgr-1', description: 'hyveon-filemgr:g:r', cidr: '1.2.3.4/32' },
      ]);
    });

    it('should return [] on API error', async () => {
      ec2Mock.on(DescribeSecurityGroupRulesCommand).rejects(new Error('boom'));
      expect(await service.listIngressRulesByDescriptionPrefix('sg-1', 'p')).toEqual([]);
    });
  });

  describe('revokeIngressRules', () => {
    // @spec HELPER-REACH-005
    it('should revoke by rule id', async () => {
      ec2Mock.on(RevokeSecurityGroupIngressCommand).resolves({});
      expect(await service.revokeIngressRules('sg-1', ['sgr-1'])).toBe(true);
      expect(ec2Mock.commandCalls(RevokeSecurityGroupIngressCommand)[0]!.args[0].input.SecurityGroupRuleIds).toEqual(['sgr-1']);
    });

    it('should make no call for an empty list', async () => {
      expect(await service.revokeIngressRules('sg-1', [])).toBe(true);
      expect(ec2Mock.commandCalls(RevokeSecurityGroupIngressCommand)).toHaveLength(0);
    });

    it('should return false on API error', async () => {
      ec2Mock.on(RevokeSecurityGroupIngressCommand).rejects(new Error('nope'));
      expect(await service.revokeIngressRules('sg-1', ['sgr-1'])).toBe(false);
    });
  });
});
