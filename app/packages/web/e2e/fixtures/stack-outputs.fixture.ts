import type { StackOutputs } from '@hyveon/shared';

/**
 * Scripted `PulumiService.getStackOutputs()` response for integration specs
 * exercising a deployed-stack scenario — passed to `createIpcHarness()` via
 * the `stackOutputs` fixture option. Values mirror the old tfstate-fixture
 * JSON this replaces.
 */
export const STACK_OUTPUTS_FIXTURE: StackOutputs = {
  awsRegion: 'us-east-1',
  ecsClusterName: 'test-cluster',
  ecsClusterArn: 'arn:aws:ecs:us-east-1:123456789012:cluster/test-cluster',
  subnetIds: ['subnet-test1234'],
  securityGroupId: 'sg-test1234',
  fileManagerSecurityGroupId: 'sg-fm-test1234',
  efsFileSystemId: 'fs-test1234',
  efsAccessPoints: { minecraft: 'fsap-mc1234', valheim: 'fsap-vh1234' },
  domainName: 'test.example.com',
  gameNames: ['minecraft', 'valheim'],
  discordTableName: 'test-discord-table',
  auditTableName: 'test-audit-table',
  runsTableName: 'test-runs-table',
  discordBotTokenSecretArn: 'arn:aws:secretsmanager:us-east-1:123456789012:secret/test/discord/bot-token',
  discordPublicKeySecretArn: 'arn:aws:secretsmanager:us-east-1:123456789012:secret/test/discord/public-key',
  interactionsInvokeUrl: null,
  discordInteractionsUrl: null,
  appliedGameServers: null,
};
