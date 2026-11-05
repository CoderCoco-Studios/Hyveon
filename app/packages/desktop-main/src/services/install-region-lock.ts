import type { ElectronStoreService } from './ElectronStoreService.js';
import { logger } from '../logger.js';

/**
 * Returns the region the install is locked to, or `undefined` while it is still unlocked.
 *
 * The lock is the `installRegionLock` marker, recorded by {@link lockInstallRegion} before the first
 * bootstrap call. A stored `bootstrap` record also locks (to `aws.region`) so installs that completed
 * bootstrap before the marker existed stay locked.
 */
function lockedInstallRegion(store: ElectronStoreService): string | undefined {
  const marker = store.get('installRegionLock');
  if (marker) return marker;
  return store.get('bootstrap') ? store.get('aws')?.region : undefined;
}

// @spec APP-WIZARD-REGLOCK-001
/**
 * Engages the install-region lock before bootstrap creates anything.
 *
 * Persists the wizard region (`aws.region`) as `installRegionLock` unless a lock already exists, so a
 * region change is refused from the first bootstrap call onward, even if bootstrap later fails
 * part-way and no `bootstrap` record is ever stored. The wizard's start-over action clears the lock.
 * Does nothing when no region is stored: bootstrap cannot create anything without one.
 *
 * @param store - The electron-store holding `aws.region` and `installRegionLock`.
 * @throws `Error` when the lock cannot be persisted; the caller must not create any resources then.
 */
export function lockInstallRegion(store: ElectronStoreService): void {
  if (lockedInstallRegion(store) !== undefined) return;
  const region = store.get('aws')?.region;
  if (!region) return;
  try {
    store.set('installRegionLock', region);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error('Failed to persist the install region lock before bootstrap', { region, error: message });
    throw new Error(`Could not record the install region lock, so bootstrap was not started and no resources were created: ${message}`);
  }
  logger.info('Install region locked before bootstrap', { region });
}

// @spec APP-WIZARD-REGLOCK-001
/**
 * Refuses a change of the install's AWS region once the lock has engaged.
 *
 * The install's region is the wizard region (`aws.region`); the bootstrap buckets, the runs table
 * and the stack all live in it, so moving it means destroying the stack and the bootstrap resources
 * and resetting the app. The lock engages at the first bootstrap call ({@link lockInstallRegion});
 * see `lockedInstallRegion` for the legacy `bootstrap`-record fallback. Shared by the wizard's
 * `wizard.state.save`, the guided-IAM console/intake/rotation entries, which write or hand off
 * `aws.region`.
 *
 * @param store - The electron-store holding `aws.region`, `installRegionLock` and `bootstrap`.
 * @param requestedRegion - The region the caller is about to store or use; `undefined` means no region change.
 * @throws `Error` when the lock has engaged and `requestedRegion` differs from the locked region.
 */
export function assertInstallRegionUnlocked(store: ElectronStoreService, requestedRegion: string | undefined): void {
  if (requestedRegion === undefined) return;
  const lockedRegion = lockedInstallRegion(store);
  if (lockedRegion === undefined || requestedRegion === lockedRegion) return;
  logger.warn('Install region change refused: bootstrap has started', { lockedRegion, requestedRegion });
  throw new Error(
    `The AWS region is locked to ${lockedRegion} because bootstrap has started. ` +
      'Moving to another region means destroying the stack, deleting the bootstrap resources and resetting the app. ' +
      'If bootstrap never created anything, use Start over in the setup wizard to clear the lock.',
  );
}
