/**
 * Shared `StackOutputs` test fixture for `@hyveon/desktop-main` specs — mirrors
 * `@hyveon/infra`'s `testing/fixtures.ts` and `@hyveon/web`'s
 * `e2e/fixtures/stack-outputs.fixture.ts`. `StackOutputs` has no optional fields, so
 * every spec previously hand-maintained its own 13-18-field object literal; a new
 * required field broke all of them at once (issue #557 finding 60). Centralizing the
 * literal here means it's updated in one place instead.
 */

import type { StackOutputs } from '@hyveon/shared';

const DEFAULT_STACK_OUTPUTS: StackOutputs = {
  awsRegion: 'us-east-1',
  ecsClusterName: 'game-cluster',
  ecsClusterArn: 'arn:aws:ecs:us-east-1:123456789012:cluster/game-cluster',
  subnetIds: ['subnet-a', 'subnet-b'],
  securityGroupId: 'sg-game',
  fileManagerSecurityGroupId: 'sg-files',
  efsFileSystemId: 'fs-1',
  efsAccessPoints: { minecraft: 'fsap-1' },
  domainName: 'example.com',
  gameNames: ['minecraft'],
  discordTableName: 'discord-table',
  auditTableName: 'audit-table',
  runsTableName: 'runs-table',
  discordBotTokenSecretArn: 'arn:aws:secretsmanager:us-east-1:123456789012:secret:bot-token',
  discordPublicKeySecretArn: 'arn:aws:secretsmanager:us-east-1:123456789012:secret:public-key',
  fileBrowserCredentialSecretArn: 'arn:aws:secretsmanager:us-east-1:123456789012:secret:filebrowser-credential',
  fileBrowserSchedulerRoleArn: 'arn:aws:iam::123456789012:role/filebrowser-scheduler',
  interactionsInvokeUrl: null,
  discordInteractionsUrl: null,
  appliedGameServers: null,
};

/**
 * Builds a fully-populated {@link StackOutputs} value for desktop-main specs.
 *
 * @param overrides - Fields to override on top of a representative default deployment.
 * @returns A complete {@link StackOutputs}.
 */
export function stackOutputs(overrides: Partial<StackOutputs> = {}): StackOutputs {
  return { ...DEFAULT_STACK_OUTPUTS, ...overrides };
}
