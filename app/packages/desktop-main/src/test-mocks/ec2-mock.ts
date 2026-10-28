import { mockClient, type AwsClientStub } from 'aws-sdk-client-mock';
import {
  EC2Client,
  DescribeNetworkInterfacesCommand,
  AuthorizeSecurityGroupIngressCommand,
  DescribeSecurityGroupRulesCommand,
  RevokeSecurityGroupIngressCommand,
} from '@aws-sdk/client-ec2';
import { mockStore } from './mock-store.js';

/**
 * Installs `aws-sdk-client-mock` interceptors on the `EC2Client` prototype for the commands the file-manager helper
 * issues. `DescribeNetworkInterfaces` reads the shared {@link mockStore} FIFO queue (empty queue: an ENI list with no
 * public IP); the security-group commands succeed with no rules present.
 *
 * `Ec2Service` creates its `EC2Client` lazily, so patching the prototype once before the first `send()` suffices.
 *
 * @returns the `aws-sdk-client-mock` stub.
 */
export function installEc2Mock(): AwsClientStub<EC2Client> {
  const ec2Mock = mockClient(EC2Client);

  ec2Mock.on(DescribeNetworkInterfacesCommand).callsFake(async () => {
    const next = mockStore.dequeueDescribeNetworkInterfaces();
    if (next?.type === 'error') {
      throw Object.assign(new Error(next.message ?? 'Mock DescribeNetworkInterfaces error'), {
        name: next.code ?? 'ServiceException',
      });
    }
    return (next?.data as object | undefined) ?? { NetworkInterfaces: [] };
  });
  ec2Mock.on(AuthorizeSecurityGroupIngressCommand).resolves({});
  ec2Mock.on(DescribeSecurityGroupRulesCommand).resolves({ SecurityGroupRules: [] });
  ec2Mock.on(RevokeSecurityGroupIngressCommand).resolves({});

  return ec2Mock;
}
