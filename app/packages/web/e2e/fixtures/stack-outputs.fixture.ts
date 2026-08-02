import type { StackOutputs } from '@hyveon/shared';

/**
 * A synthetic, fully-deployed {@link StackOutputs} value for integration
 * specs to script onto `harness.mocks.pulumi` via `scriptStackOutputs()`.
 *
 * Replaces the deleted `tfstate.fixture.json` (a synthetic
 * `terraform.tfstate`, injected via the now-inert `TF_STATE_PATH` mechanism
 * — see `ipc-harness.ts`'s doc comment) as the source of truth for these
 * values — same region/domain/game names/table names so every spec that
 * asserted against the old fixture's values keeps asserting the same
 * values, just read through `PulumiService.getStackOutputs()`'s stubbed
 * return instead of a parsed tfstate file. Field-for-field mapping notes
 * where the two shapes genuinely differ (not just renamed):
 *  - `subnet_ids` was a single comma-joined string (`"subnet-test1234"`);
 *    {@link StackOutputs.subnetIds} is a real array — one element here,
 *    matching the old fixture's only subnet.
 *  - `interactions_invoke_url` was `null` in the old fixture;
 *    {@link StackOutputs.interactionsInvokeUrl} keeps that same `null`.
 *  - `discord_interactions_url` and `applied_game_servers` have no analogue
 *    in the old tfstate fixture (both post-date it) — set to `null` here,
 *    `StackOutputs`'s own documented "absent" value for each.
 */
export const DEFAULT_STACK_OUTPUTS: StackOutputs = {
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
