import { resolvePreApplyRunsTableName } from '@hyveon/shared';
import type { RemoteFileStore } from '@hyveon/shared';
import type { ConfigService } from './ConfigService.js';

/**
 * Resolves the run-history table's name: the deployed stack's `runsTableName` output first, then the name derived from
 * the persisted deployment config, so the first plan/apply cycle on a fresh install resolves it too.
 *
 * @param config - Source of the stack outputs.
 * @param remoteFileStore - Source of the persisted deployment config for the pre-apply fallback.
 * @returns The table name, or `undefined` when neither source has one yet.
 */
export async function resolveRunsTableName(
  config: Pick<ConfigService, 'getStackOutputs'>,
  remoteFileStore: RemoteFileStore,
): Promise<string | undefined> {
  const fromStack = (await config.getStackOutputs())?.runsTableName;
  if (fromStack) return fromStack;
  return resolvePreApplyRunsTableName(remoteFileStore);
}
