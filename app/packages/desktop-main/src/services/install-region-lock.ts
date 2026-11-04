import type { ElectronStoreService } from './ElectronStoreService.js';
import { logger } from '../logger.js';

// @spec APP-WIZARD-REGLOCK-001
/**
 * Refuses a change of the install's AWS region once bootstrap has completed.
 *
 * The install's region is the wizard region (`aws.region`); the bootstrap buckets, the runs table
 * and the stack all live in it, so moving it means destroying the stack and the bootstrap resources
 * and resetting the app. Locked means a `bootstrap` record is stored. Shared by the wizard's
 * `wizard.state.save` and guided-IAM rotation, the two paths that write `aws.region`.
 *
 * @param store - The electron-store holding `aws.region` and `bootstrap`.
 * @param requestedRegion - The region the caller is about to store; `undefined` means no region change.
 * @throws `Error` when bootstrap has completed and `requestedRegion` differs from the stored region.
 */
export function assertInstallRegionUnlocked(store: ElectronStoreService, requestedRegion: string | undefined): void {
  if (requestedRegion === undefined) return;
  if (!store.get('bootstrap')) return;
  const storedRegion = store.get('aws')?.region;
  if (storedRegion === undefined || requestedRegion === storedRegion) return;
  logger.warn('Install region change refused: bootstrap has completed', { storedRegion, requestedRegion });
  throw new Error(
    `The AWS region is locked to ${storedRegion} because bootstrap has completed. ` +
      'Moving to another region means destroying the stack, deleting the bootstrap resources and resetting the app.',
  );
}
