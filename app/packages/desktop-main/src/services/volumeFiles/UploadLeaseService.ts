import { Inject, Injectable } from '@nestjs/common';
import { errMessage, type CloudProvider } from '@hyveon/shared';
import {
  UPLOAD_LEASE_HEARTBEAT_MS,
  acquireUploadLease,
  releaseUploadLease,
  renewUploadLease,
  startInProgressMessage,
  type UploadLeaseOptions,
} from '@hyveon/shared/aws/startLease';
import { logger } from '../../logger.js';
import { CLOUD_PROVIDER } from '../../modules/cloud-provider.tokens.js';

/** Consecutive failed renewals after which the lease is treated as lost, well inside the 120 s TTL. */
const MAX_FAILED_RENEWALS = 2;

/** Outcome of {@link UploadLeaseService.hold}. */
export type UploadLeaseHoldResult = { ok: true } | { ok: false; message: string };

/** Per-game lease bookkeeping. */
interface GameLease {
  holders: Set<string>;
  /** Settles once the DynamoDB acquisition finishes; concurrent holders share it. */
  acquiring: Promise<UploadLeaseHoldResult>;
  opts?: UploadLeaseOptions;
  leaseId?: string;
  timer?: NodeJS.Timeout;
  failedRenewals: number;
}

// @spec HELPER-FB-042, HELPER-FB-043, HELPER-FB-044, HELPER-FB-045, HELPER-FB-046
/**
 * Holds each game's cross-process launch lease (`LAUNCH#{game}/LOCK`, holder `upload`) for as long as any upload holds
 * the game's helper session, so a start from the app or from Discord is refused while files are being written.
 *
 * @remarks
 * Reference-counted per game: the first holder acquires the lease and starts a heartbeat, later holders share it, and
 * the last drop releases it. A refused acquisition, a lost lease, or {@link MAX_FAILED_RENEWALS} failed renewals in a
 * row reports through {@link UploadLeaseService.onLost} so the owner can abort the upload. A crashed process leaves the
 * lease to lapse within the TTL.
 */
@Injectable()
export class UploadLeaseService {
  /** Overridable by tests. */
  heartbeatMs = UPLOAD_LEASE_HEARTBEAT_MS;

  private readonly leases = new Map<string, GameLease>();
  private readonly lostListeners = new Set<(game: string, message: string) => void>();

  constructor(@Inject(CLOUD_PROVIDER) private readonly provider: CloudProvider) {}

  /**
   * Subscribes to a held lease being lost; a throwing listener is logged and skipped.
   *
   * @param listener - Receives the game and an operator-facing reason.
   * @returns The unsubscribe function.
   */
  onLost(listener: (game: string, message: string) => void): () => void {
    this.lostListeners.add(listener);
    return () => this.lostListeners.delete(listener);
  }

  /**
   * Registers `holderId` against `game`'s lease, acquiring it when this is the first holder.
   *
   * @remarks
   * With no deployed stack there is nothing to start, so no lease is taken and the call succeeds; the session launch
   * reports the missing deployment itself. A refusal or an acquisition error leaves `holderId` unregistered.
   *
   * @param game - Game whose volume the holder writes.
   * @param holderId - Identifies the upload.
   * @returns `ok`, or a refusal message naming why the upload must not proceed.
   */
  async hold(game: string, holderId: string): Promise<UploadLeaseHoldResult> {
    let lease = this.leases.get(game);
    if (!lease) {
      lease = { holders: new Set(), failedRenewals: 0, acquiring: Promise.resolve({ ok: true }) };
      this.leases.set(game, lease);
      lease.acquiring = this.acquire(game, lease);
    }
    lease.holders.add(holderId);
    const result = await lease.acquiring;
    if (!result.ok) lease.holders.delete(holderId);
    return result;
  }

  /**
   * Unregisters `holderId`; the last drop for a game stops its heartbeat and releases the lease.
   *
   * @param game - Game the holder wrote to.
   * @param holderId - Identifies the upload.
   * @returns Settles once a final release has been attempted; never rejects.
   */
  async drop(game: string, holderId: string): Promise<void> {
    const lease = this.leases.get(game);
    if (!lease || !lease.holders.delete(holderId) || lease.holders.size > 0) return;
    this.leases.delete(game);
    await lease.acquiring;
    this.stopHeartbeat(lease);
    if (lease.opts && lease.leaseId) await releaseUploadLease(lease.opts, lease.leaseId);
  }

  /** Resolves the lease writer and table for the deployed stack; `null` when nothing is deployed or the provider has none. */
  private async resolveOptions(game: string): Promise<UploadLeaseOptions | null> {
    const access = await this.provider.getStartLeaseAccess?.();
    return access ? { put: access.put, tableName: access.tableName, game } : null;
  }

  /** First-holder acquisition: takes the lease and arms the heartbeat; fails closed on any error. */
  private async acquire(game: string, lease: GameLease): Promise<UploadLeaseHoldResult> {
    try {
      const opts = await this.resolveOptions(game);
      if (!opts) return { ok: true };
      const outcome = await acquireUploadLease(opts);
      if (outcome.status === 'busy') {
        logger.info('UploadLeaseService: upload refused, the start lease is held', { game, holder: outcome.holder });
        this.leases.delete(game);
        return {
          ok: false,
          message:
            outcome.holder === 'upload'
              ? `Another upload into '${game}' is in progress from another app. Wait for it to finish, then upload.`
              : `${startInProgressMessage(game)} Wait for it to finish, then upload.`,
        };
      }
      lease.opts = opts;
      lease.leaseId = outcome.leaseId;
      lease.timer = setInterval(() => void this.heartbeat(game, lease), this.heartbeatMs);
      lease.timer.unref();
      return { ok: true };
    } catch (err) {
      const message = errMessage(err);
      logger.warn('UploadLeaseService: could not take the start lease', { game, error: message });
      this.leases.delete(game);
      return { ok: false, message: `The upload was not started because the start lease could not be taken: ${message}` };
    }
  }

  /** One renewal; a lost lease or repeated failures abandon the lease and tell the listeners. */
  private async heartbeat(game: string, lease: GameLease): Promise<void> {
    if (!lease.opts || !lease.leaseId || this.leases.get(game) !== lease) return;
    try {
      if ((await renewUploadLease(lease.opts, lease.leaseId)) === 'renewed') {
        lease.failedRenewals = 0;
        return;
      }
      this.lose(game, lease, 'The upload lost its hold on the game, so it was stopped.');
    } catch (err) {
      lease.failedRenewals += 1;
      logger.warn('UploadLeaseService: lease renewal failed', { game, failed: lease.failedRenewals, error: errMessage(err) });
      if (lease.failedRenewals >= MAX_FAILED_RENEWALS) {
        this.lose(game, lease, 'The upload could not keep its hold on the game, so it was stopped.');
      }
    }
  }

  /** Forgets the lease without releasing it (it is gone or unreachable) and notifies the listeners. */
  private lose(game: string, lease: GameLease, message: string): void {
    if (this.leases.get(game) !== lease) return;
    logger.warn('UploadLeaseService: upload lease lost', { game });
    this.leases.delete(game);
    this.stopHeartbeat(lease);
    for (const listener of [...this.lostListeners]) {
      try {
        listener(game, message);
      } catch (err) {
        logger.warn('UploadLeaseService: lost listener failed', { game, error: errMessage(err) });
      }
    }
  }

  private stopHeartbeat(lease: GameLease): void {
    if (lease.timer) clearInterval(lease.timer);
    lease.timer = undefined;
  }
}
